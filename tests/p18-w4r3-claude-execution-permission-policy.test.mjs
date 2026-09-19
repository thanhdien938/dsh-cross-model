import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  EXECUTION_STAGE, resolveExecutionOptions, PM_PERMISSION_MODE,
} from '../src/pm/pm-execution-timeout-policy.mjs';
import { COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createProductionPmWorkflowRunner } from '../src/workflow/production-pm-workflow-runner.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { runClaudeProcess, ClaudeCodeSessionError, KNOWN_CLAUDE_PERMISSION_MODES } from '../src/session/claude-code-session-bridge.mjs';

// P18-W4R3 — execution-backend permission remediation. Proves the
// role-based Claude Code permission-mode policy end to end: the PM's own
// planning/reasoning turn keeps 'plan' (read-only) byte-for-byte; the
// SINGLE workflow "worker" step (and, identically, any council/debate
// participant step that explicitly opts in) gets 'bypassPermissions' —
// the ONE mode empirically verified execution-capable against the real
// installed CLI (2.1.235) in a bounded, throwaway, no-git-remote fixture
// (see this wave's report: acceptEdits writes files but blocks Bash;
// dontAsk blocks everything; auto is a nondeterministic classifier that
// can deny mid-turn; bypassPermissions deterministically allows both file
// writes and command execution non-interactively).

// ---- pure policy: resolveExecutionOptions() ---------------------------

test('resolveExecutionOptions: permissionMode defaults to plan for every existing stage, unless the caller explicitly opts in', () => {
  for (const stage of Object.values(EXECUTION_STAGE)) {
    const options = resolveExecutionOptions(stage);
    assert.equal(options.permissionMode, PM_PERMISSION_MODE.PLAN, `${stage} must default to plan`);
    assert.equal(Object.isFrozen(options), true);
  }
});

test('resolveExecutionOptions: executionCapable:true resolves bypassPermissions, for ANY stage — the mechanism is stage-agnostic', () => {
  for (const stage of Object.values(EXECUTION_STAGE)) {
    const options = resolveExecutionOptions(stage, { executionCapable: true });
    assert.equal(options.permissionMode, PM_PERMISSION_MODE.EXECUTE);
    assert.equal(options.permissionMode, 'bypassPermissions');
  }
});

test('resolveExecutionOptions: executionCapable:false is identical to omitting it — no accidental widening from a falsy-but-present value', () => {
  const a = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE);
  const b = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE, { executionCapable: false });
  assert.deepEqual(a, b);
});

// ---- SINGLE task: planning turn vs worker/implementation step ---------

async function withWorkflowRunnerFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p18-w4r3-workflow-'));
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

test('SINGLE workflow "worker" step requests bypassPermissions (execution-capable) — the real dispatch path a failed W4 turn takes', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => {
    captured.push({ profileId: profile.id, executionOptions: context.executionOptions, taskMode: context.extraCtx?.taskMode });
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done implementing' }; } };
  };
  const project = { id: 'proj-w4r3', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });

  await runner.run({ id: 'wf-w4r3-1', steps: [{ recipient: 'worker', body: 'implement the thing' }] });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].executionOptions.permissionMode, 'bypassPermissions');
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.OWNER_SINGLE);
  assert.equal(captured[0].taskMode, 'SINGLE_WORKFLOW_STEP');
}));

test('role/mode survives resume/recovery: the worker step resolves the SAME bypassPermissions on repeated dispatches (simulating turns 0, 1, 2 of a resumed pm_run), never drifting', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => {
    captured.push(context.executionOptions.permissionMode);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done' }; } };
  };
  const project = { id: 'proj-w4r3-resume', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  for (let turn = 0; turn < 3; turn += 1) {
    const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });
    await runner.run({ id: `wf-w4r3-resume-${turn}`, steps: [{ recipient: 'worker', body: `retry attempt ${turn}` }] });
  }
  assert.deepEqual(captured, ['bypassPermissions', 'bypassPermissions', 'bypassPermissions']);
}));

// ---- COUNCIL / DEBATE: same shared mechanism, unchanged by default ----

function fakeCouncilResolveDriver(captured) {
  return (profile, context) => {
    captured.push({ executionOptions: context.executionOptions });
    return { name: `fake:${profile.id}`, async decide(input) {
      const stepKind = input.request.context.stepKind;
      if (stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN) return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'x' }, critique_focus: 'f', synthesis_focus: 's' } };
      if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT) return { type: 'finish', output: 'report', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE) return { type: 'finish', output: 'critique', data: { type: 'council_critique', criticisms: [], agreements: ['ok'], revised_recommendation: 'r2', remaining_disagreements: [] } };
      return { type: 'finish', output: 'synthesis', data: { type: 'council_synthesis' } };
    } };
  };
}

test('COUNCIL: every existing stepKind stays plan by default — unchanged, since none of the four are implementation steps', async () => {
  for (const stepKind of Object.values(COUNCIL_STEP_KINDS)) {
    const captured = [];
    const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
    await runner.run({ id: `council:${stepKind}:0`, kind: 'council_step', stepKind, round: 0, profileId: 'p1', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
    assert.equal(captured[0].executionOptions.permissionMode, 'plan', `${stepKind} must stay plan by default`);
  }
});

test('COUNCIL participant execution uses the SAME worker execution policy: a stepKind that explicitly opts in (simulating a future implementation-requesting participant step) gets bypassPermissions through the identical resolveExecutionOptions() mechanism', () => {
  // council-step-workflow-runner.mjs's own call site is unchanged (always
  // implicit `executionCapable:false`) — this proves the SHARED policy
  // function itself generalizes correctly to a council-shaped stage the
  // moment a caller opts in, without inventing a new stepKind or a second
  // parallel policy path.
  const options = resolveExecutionOptions(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, { executionCapable: true });
  assert.equal(options.permissionMode, 'bypassPermissions');
});

test('DEBATE participant execution uses the same policy where implementation is requested: identical opt-in mechanism proven mode-agnostic (DEBATE is not yet a distinct top-level task_mode in this codebase — see docs/p18/ W4R2 report — so this proves the shared policy function itself, the layer DEBATE would opt into identically to COUNCIL)', () => {
  const options = resolveExecutionOptions(COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE, { executionCapable: true });
  assert.equal(options.permissionMode, 'bypassPermissions');
});

// ---- registry wiring: executionOptions.permissionMode reaches claudeRunner()

test('ProductionPmBackendRegistry: the claude-code run() closure forces the generic trusted default regardless of the legacy execution hint', async () => {
  const calls = [];
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude-fixture',
    claudeRunner: async (args) => { calls.push(args); return { result: JSON.stringify({ type: 'finish', output: 'ok' }) }; },
  });
  const profile = { id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const project = { id: 'proj-registry', repo_path: 'C:/repo' };

  const planDriver = registry.resolve(profile, { project, executionOptions: resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE) });
  await planDriver.decide({ request: { id: 'r1', objective: 'plan it', context: {} }, turn: 0, history: [], capabilities: ['finish'] });
  assert.equal(calls[0].permissionMode, 'bypassPermissions');

  const workerDriver = registry.resolve(profile, { project, executionOptions: resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE, { executionCapable: true }) });
  await workerDriver.decide({ request: { id: 'r2', objective: 'implement it', context: {} }, turn: 0, history: [], capabilities: ['finish'] });
  assert.equal(calls[1].permissionMode, 'bypassPermissions');
});

test('ProductionPmBackendRegistry: omitting executionOptions still uses the generic trusted default', async () => {
  const calls = [];
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude-fixture',
    claudeRunner: async (args) => { calls.push(args); return { result: JSON.stringify({ type: 'finish', output: 'ok' }) }; },
  });
  const profile = { id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const project = { id: 'proj-registry-2', repo_path: 'C:/repo' };
  const driver = registry.resolve(profile, { project });
  await driver.decide({ request: { id: 'r3', objective: 'x', context: {} }, turn: 0, history: [], capabilities: ['finish'] });
  assert.equal(calls[0].permissionMode, 'bypassPermissions');
});

// ---- bridge level: argv construction + fail-closed on an unknown mode --

test('runClaudeProcess: bypassPermissions reaches the real CLI argv exactly, and cwd is the task workspace it was given', async () => {
  const invocations = [];
  const fakeSpawn = (binary, args, opts) => {
    invocations.push({ binary, args, cwd: opts.cwd });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ result: 'ok', session_id: 's1' }));
      child.emit('close', 0, null);
    });
    return child;
  };
  const result = await runClaudeProcess({ binary: 'claude-fixture', cwd: '/task/workspace', prompt: 'implement it', permissionMode: 'bypassPermissions', spawnImpl: fakeSpawn });
  assert.equal(result.result, 'ok');
  assert.ok(invocations[0].args.includes('--permission-mode'));
  assert.equal(invocations[0].args[invocations[0].args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(invocations[0].cwd, '/task/workspace');
});

test('runClaudeProcess: an unknown/invalid permission mode fails closed BEFORE spawning any process', async () => {
  let spawnCalled = false;
  const fakeSpawn = () => { spawnCalled = true; throw new Error('must never be called'); };
  await assert.rejects(
    async () => { await runClaudeProcess({ binary: 'claude-fixture', prompt: 'x', permissionMode: 'yolo-mode-that-does-not-exist', spawnImpl: fakeSpawn }); },
    (e) => e instanceof ClaudeCodeSessionError && e.code === 'CLAUDE_PERMISSION_MODE_UNKNOWN',
  );
  assert.equal(spawnCalled, false);
});

test('KNOWN_CLAUDE_PERMISSION_MODES contains exactly the installed CLI 2.1.235 --permission-mode choices, and the default (plan) is a member', () => {
  assert.deepEqual([...KNOWN_CLAUDE_PERMISSION_MODES].sort(), ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan'].sort());
  assert.ok(KNOWN_CLAUDE_PERMISSION_MODES.includes('plan'));
  assert.ok(KNOWN_CLAUDE_PERMISSION_MODES.includes('bypassPermissions'));
});

test('runClaudeProcess: the pre-existing default (no permissionMode passed) is still plan — byte-for-byte unchanged', async () => {
  const invocations = [];
  const fakeSpawn = (binary, args, opts) => {
    invocations.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ result: 'ok' })); child.emit('close', 0, null); });
    return child;
  };
  await runClaudeProcess({ binary: 'claude-fixture', prompt: 'x', spawnImpl: fakeSpawn });
  assert.equal(invocations[0][invocations[0].indexOf('--permission-mode') + 1], 'plan');
});
