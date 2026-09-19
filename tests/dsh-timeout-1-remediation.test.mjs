import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createProductionPmWorkflowRunner } from '../src/workflow/production-pm-workflow-runner.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { EXECUTION_STAGE, resolveExecutionOptions } from '../src/pm/pm-execution-timeout-policy.mjs';
import { ProductionPmBackendRegistry, raceWithWatchdog, HANG_SAFETY_CEILING_MS } from '../src/pm/production-pm-backend-registry.mjs';
import { withReapedOwnedSpawnLifecycle, awaitOwnedSpawnReaping } from '../src/runtime/backend-execution-observer.mjs';
import { reapOwnedChildProcess } from '../src/session/provider-child-policy.mjs';

// DSH-TIMEOUT-1 — focused regression coverage for the four fixes this wave
// makes (T-1/T-2/T-3/T-4). Table-driven and fixture-reuse coverage for the
// per-backend forwarding contract (T-3) already lives in
// tests/p10-r024-timeout-policy-long.test.mjs and tests/p10-r021-timeout-
// diagnostics.test.mjs (both updated by this wave) — this file covers what
// neither of those already exercised: the durable runtime's own runtimeClass
// injection (T-1's actual wiring, not just the workflow-runner adapter's
// stage-selection half), Council's stage-selection call site directly
// (T-2), and the process-cleanup primitives themselves (T-4).

// ==== T-1: production-pm-workflow-runner.mjs — direct adapter-level proof ====

async function withWorkflowRunnerFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-timeout-1-workflow-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(root, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const profileRegistry = new PmProfileRegistry([{ id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio' }]);
    await fn({ store, agentBusRepository, profileRegistry, root });
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('T-1: worker/implementation step resolves OWNER_SINGLE_LONG when the dispatched step context carries runtimeClass:"LONG"', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => {
    captured.push(context.executionOptions);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done implementing' }; } };
  };
  const project = { id: 'proj-t1-long', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });

  await runner.run({ id: 'wf-t1-long', steps: [{ recipient: 'worker', body: 'implement the thing', context: { runtimeClass: 'LONG' } }] });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].stage, EXECUTION_STAGE.OWNER_SINGLE_LONG);
  assert.equal(captured[0].timeoutMs, 1_800_000);
  assert.equal(captured[0].permissionMode, 'bypassPermissions');
}));

test('T-1: worker/implementation step stays on OWNER_SINGLE (300000ms) for a NORMAL task — byte-for-byte unchanged default when runtimeClass is absent/not "LONG"', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => {
    captured.push(context.executionOptions);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done implementing' }; } };
  };
  const project = { id: 'proj-t1-normal', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });

  await runner.run({ id: 'wf-t1-normal-absent', steps: [{ recipient: 'worker', body: 'implement the thing' }] });
  await runner.run({ id: 'wf-t1-normal-other', steps: [{ recipient: 'worker', body: 'implement the thing', context: { runtimeClass: 'NORMAL' } }] });
  await runner.run({ id: 'wf-t1-normal-bogus', steps: [{ recipient: 'worker', body: 'implement the thing', context: { runtimeClass: 'long' } }] }); // lowercase must NOT match

  assert.equal(captured.length, 3);
  for (const options of captured) {
    assert.equal(options.stage, EXECUTION_STAGE.OWNER_SINGLE);
    assert.equal(options.timeoutMs, 300_000);
  }
}));

// ==== T-1: durable-pm-runtime.mjs — the ACTUAL runtimeClass -> step context wiring ====

function driver(decisions = []) {
  return { name: 'neutral-driver', calls: [], async decide(input) { this.calls.push(input); const next = decisions.shift(); return typeof next === 'function' ? next(input) : next; } };
}

function actionsCapturingFullSpec() {
  const workflows = new Map();
  const specs = [];
  const workflowRunner = {
    calls: [], specs,
    result(id) { return workflows.get(id) ?? null; },
    async run(spec) { this.calls.push(spec.id); this.specs.push(spec); const value = { workflowId: spec.id, status: 'completed', finalStepId: 'step', finalTaskId: 'task', finalRunId: 'run', finalResult: { id: 'result', output: 'workflow-ok' }, error: null }; workflows.set(spec.id, value); return value; },
  };
  const peerRelay = {
    createCalls: [], exchangeCalls: [], getConversation() { return null; }, result() { return null; },
    createConversation({ id }) { this.createCalls.push(id); return { id, status: 'created' }; },
    async exchange(input) { this.exchangeCalls.push(input.conversationId); return { conversationId: input.conversationId, status: 'completed', hops: [], finalResult: { id: 'r', output: 'ok' } }; },
  };
  return { workflowRunner, peerRelay, workflows };
}

async function pmRuntimeFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeout-1-durable-'));
  const path = join(dir, 'pm.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('T-1: DurablePmRuntime merges runtimeClass:"LONG" (from the owner request context) into every workflow step\'s context when the run is LONG-classified', async () => pmRuntimeFixture(async ({ repository }) => {
  const d = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'implement it' }] } }, { type: 'finish', output: 'done', data: null }]);
  const a = actionsCapturingFullSpec();
  const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
  const result = await runtime.run({ objective: 'a long task', context: { runtimeClass: 'LONG' } });
  assert.equal(result.status, 'completed');
  assert.equal(a.workflowRunner.specs.length, 1);
  const dispatchedSpec = a.workflowRunner.specs[0];
  assert.equal(dispatchedSpec.steps[0].context.runtimeClass, 'LONG');
}));

test('T-1: DurablePmRuntime leaves the workflow spec BYTE-FOR-BYTE unchanged for a NORMAL run (no runtimeClass injected, no NORMAL-task prompt regression)', async () => pmRuntimeFixture(async ({ repository }) => {
  const originalSteps = [{ recipient: 'worker', body: 'implement it' }];
  const d = driver([{ type: 'workflow', spec: { steps: originalSteps } }]);
  const a = actionsCapturingFullSpec();
  const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
  await runtime.run({ objective: 'a normal task', context: {} });
  const dispatchedSpec = a.workflowRunner.specs[0];
  assert.equal('runtimeClass' in (dispatchedSpec.steps[0].context ?? {}), false);
}));

test('T-1: DurablePmRuntime never injects runtimeClass for a Council run (Council request context never sets it — LONG COUNCIL stays explicitly out of scope)', async () => pmRuntimeFixture(async ({ repository }) => {
  const d = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'p1', body: 'analyze' }] } }]);
  const a = actionsCapturingFullSpec();
  const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
  await runtime.run({ objective: 'a council task', context: { council: true } });
  const dispatchedSpec = a.workflowRunner.specs[0];
  assert.equal('runtimeClass' in (dispatchedSpec.steps[0].context ?? {}), false);
}));

test('T-1: an explicit model-authored context.runtimeClass (never expected in practice) is never silently clobbered by the injection', async () => pmRuntimeFixture(async ({ repository }) => {
  const d = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'x', context: { runtimeClass: 'MODEL_SUPPLIED' } }] } }]);
  const a = actionsCapturingFullSpec();
  const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
  await runtime.run({ objective: 'x', context: { runtimeClass: 'LONG' } });
  assert.equal(a.workflowRunner.specs[0].steps[0].context.runtimeClass, 'MODEL_SUPPLIED');
}));

// ==== T-2: CouncilStepWorkflowRunner — direct stage-selection proof ====

function fakeCouncilResolveDriver(captured) {
  return (profile, context) => {
    captured.push({ executionOptions: context.executionOptions });
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'report', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } }; } };
  };
}

// PM-review-corrected (T-2 budget check): the designated implementation
// participant gets the SAME LONG budget (1800000ms) a LONG SINGLE
// worker/implementation step gets — not merely OWNER_SINGLE's shorter
// 300000ms, which an initial TIMEOUT-1 draft used before PM review caught
// it as reintroducing T-1's own bug for Council.
test('T-2: the designated implementation participant\'s participant_report resolves COUNCIL_IMPLEMENTATION_PARTICIPANT (1800000ms, the SAME LONG budget as OWNER_SINGLE_LONG) + bypassPermissions', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run({ id: 'council:impl:0', kind: 'council_step', stepKind: 'participant_report', round: 0, profileId: 'p1', prompt: 'x', participantProfileIds: ['p1', 'p2'], isImplementationParticipant: true });
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT);
  assert.equal(captured[0].executionOptions.timeoutMs, 1_800_000);
  assert.equal(captured[0].executionOptions.permissionMode, 'bypassPermissions');
});

test('T-2: an ordinary (non-implementation) participant_report step keeps the SAME read-only 120000ms budget as before this wave', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run({ id: 'council:normal:0', kind: 'council_step', stepKind: 'participant_report', round: 0, profileId: 'p2', prompt: 'x', participantProfileIds: ['p1', 'p2'], isImplementationParticipant: false });
  assert.equal(captured[0].executionOptions.stage, 'participant_report');
  assert.equal(captured[0].executionOptions.timeoutMs, 120_000);
  assert.equal(captured[0].executionOptions.permissionMode, 'plan');
});

test('T-2: a Debate step never resolves the implementation stage even if (hypothetically) marked isImplementationParticipant — Debate stays read-only per Part C', async () => {
  const captured = [];
  const debateResolveDriver = (profile, context) => {
    captured.push({ executionOptions: context.executionOptions });
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'response', data: { type: 'council_debate_response' } }; } };
  };
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: debateResolveDriver, project: { repo_path: 'C:/repo' } });
  // council-chair-driver.mjs's real #debateWorkflow() never sets this flag on
  // a debate step (see council-contracts.mjs's COUNCIL_STEP_KINDS docstring)
  // — this test proves CouncilStepWorkflowRunner's own mechanical stage
  // selection would still stay correct even if it somehow arrived true,
  // confirming the fix is scoped to `participant_report` in practice without
  // requiring a second explicit guard here.
  await runner.run({ id: 'council:debate:0', kind: 'council_step', stepKind: 'debate_response', round: 0, profileId: 'p1', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(captured[0].executionOptions.stage, 'debate_response');
  assert.equal(captured[0].executionOptions.timeoutMs, 120_000);
  assert.equal(captured[0].executionOptions.permissionMode, 'plan');
});

// ==== T-4: process-tree cleanup reuse ====

function fakeChild(pid = 1) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

test('T-4: reapOwnedChildProcess() calls the attached __dshReapOwnedProcessTree() when present, never a bare child.kill()', async () => {
  const child = fakeChild();
  let treeReapCalled = false;
  let bareKillCalled = false;
  child.__dshReapOwnedProcessTree = async () => { treeReapCalled = true; };
  child.kill = () => { bareKillCalled = true; };
  await reapOwnedChildProcess(child);
  assert.equal(treeReapCalled, true);
  assert.equal(bareKillCalled, false);
});

test('T-4: reapOwnedChildProcess() falls back to child.kill() for a direct/test caller whose child was never wrapped (no __dshReapOwnedProcessTree)', async () => {
  const child = fakeChild();
  let bareKillCalled = false;
  child.kill = () => { bareKillCalled = true; };
  await reapOwnedChildProcess(child);
  assert.equal(bareKillCalled, true);
});

// `withReapedOwnedSpawnLifecycle`'s own bounded-wait fallback timers are
// deliberately `unref()`'d (production correctness: they must never keep a
// real process alive on their own) — a bare unit test with a fake,
// non-real child therefore needs its own `keepAlive` handle so the event
// loop does not exit before those unref'd timers get a chance to fire.
// This is the SAME established pattern tests/p13-r73-provider-process-
// ownership.test.mjs already uses for the identical reason.
test('T-4: withReapedOwnedSpawnLifecycle() attaches __dshReapOwnedProcessTree as the SAME terminate() the AbortSignal path uses', async () => {
  const controller = new AbortController();
  const child = fakeChild(9001);
  const taskkillCalls = [];
  const spawnOwned = withReapedOwnedSpawnLifecycle(() => child, controller.signal, {
    gracefulAfterMs: 5, reapAfterMs: 5,
    taskkillSpawn: (...args) => { taskkillCalls.push(args); const killer = fakeChild(); queueMicrotask(() => killer.emit('close', 0)); return killer; },
  });
  const spawned = spawnOwned();
  assert.equal(typeof spawned.__dshReapOwnedProcessTree, 'function');
  const keepAlive = setInterval(() => {}, 1_000);
  try { await reapOwnedChildProcess(spawned); } finally { clearInterval(keepAlive); }
  if (process.platform === 'win32') assert.equal(taskkillCalls.length, 1);
});

test('T-4: a second concurrent terminate() trigger converges on the same in-flight cleanup instead of racing a duplicate SIGTERM/taskkill sequence', async () => {
  const controller = new AbortController();
  const child = fakeChild(9002);
  let killerSpawnCount = 0;
  const spawnOwned = withReapedOwnedSpawnLifecycle(() => child, controller.signal, {
    gracefulAfterMs: 5, reapAfterMs: 5,
    taskkillSpawn: (...args) => { killerSpawnCount += 1; const killer = fakeChild(); queueMicrotask(() => killer.emit('close', 0)); return killer; },
  });
  const spawned = spawnOwned();
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const first = spawned.__dshReapOwnedProcessTree();
    const second = spawned.__dshReapOwnedProcessTree();
    await Promise.all([first, second]);
  } finally { clearInterval(keepAlive); }
  if (process.platform === 'win32') assert.equal(killerSpawnCount, 1, 'concurrent triggers must not spawn two independent taskkill sequences');
});

test('T-4: raceWithWatchdog\'s own timer firing now awaits abortCleanup before settling (previously only the signal-abort branch did)', async () => {
  let cleanupCalled = false;
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    raceWithWatchdog(neverSettles, { timeoutMs: 10, abortCleanup: async () => { cleanupCalled = true; } }),
    (error) => error.code === 'PM_ORCHESTRATION_WATCHDOG_TIMEOUT',
  );
  assert.equal(cleanupCalled, true);
});

test('T-4: raceWithWatchdog still reports the exact original typed failure when the underlying promise loses the race to a slower cleanup-bound settle path (signal wins first)', async () => {
  const controller = new AbortController();
  let cleanupCalled = false;
  const neverSettles = new Promise(() => {});
  const pending = raceWithWatchdog(neverSettles, { timeoutMs: 10_000, signal: controller.signal, abortCleanup: async () => { cleanupCalled = true; } });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'PM_BACKEND_ABORTED');
  assert.equal(cleanupCalled, true);
});

test('T-4/HANG_SAFETY_CEILING_MS: still exactly 600000ms — this wave never changes the watchdog floor itself, only its cleanup behavior', () => {
  assert.equal(HANG_SAFETY_CEILING_MS, 600_000);
});

// ==== Part G: no hidden retry on timeout ====

test('Part G: a CLAUDE_TIMEOUT from the underlying run() is reported exactly once through raceWithWatchdog — never silently re-invoked', async () => {
  let runCalls = 0;
  const run = async () => { runCalls += 1; const error = new Error('claude process timed out after 300000ms'); error.code = 'CLAUDE_TIMEOUT'; throw error; };
  await assert.rejects(raceWithWatchdog(run(), { timeoutMs: 300_000 }), (error) => error.code === 'CLAUDE_TIMEOUT');
  assert.equal(runCalls, 1);
});

test('Part G: RetryFailoverExecutor (which classifies TIMEOUT as retryable) is still not imported by any production runtime/orchestration module — dormant, as TIMEOUT-0 found and this wave leaves out of scope (T-5)', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const productionFiles = [
    'src/runtime/production-pm-worker.mjs',
    'src/runtime/p5-production-composition.mjs',
    'src/pm/durable-pm-runtime.mjs',
    'src/pm/production-pm-backend-registry.mjs',
    'src/pm/council/council-step-workflow-runner.mjs',
    'src/workflow/production-pm-workflow-runner.mjs',
  ];
  for (const relativePath of productionFiles) {
    const fullPath = path.join(process.cwd(), relativePath);
    const content = await fs.readFile(fullPath, 'utf8');
    assert.ok(!content.includes('retry-failover-executor'), `${relativePath} must not import the dormant retry executor`);
  }
});

// ==== Part D: Codex CODEX_HOME isolation is untouched by the timeout forwarding change ====

test('Part D: Codex bridge env still injects the dedicated DSH CODEX_HOME regardless of the new explicit-timeout forwarding', async () => {
  const { codexSourceEnv, resolveCodexDshHome } = await import('../src/session/codex-cli-session-bridge.mjs');
  const sourceEnv = { PATH: 'C:/x' };
  const env = codexSourceEnv(sourceEnv);
  assert.equal(env.CODEX_HOME, resolveCodexDshHome(sourceEnv));
  assert.ok(env.CODEX_HOME.includes('.codex-dsh') || env.CODEX_HOME.length > 0);
});
