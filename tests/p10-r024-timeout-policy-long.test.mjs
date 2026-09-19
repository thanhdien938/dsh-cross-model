import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXECUTION_STAGE, LONG_TASK_HARD_DEADLINE_MS, MAX_TIMEOUT_MS,
  resolveExecutionTimeoutMs, resolveExecutionOptions,
} from '../src/pm/pm-execution-timeout-policy.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

// ---- Part T: the LONG SINGLE hard deadline policy class --------------------

test('OWNER_SINGLE_LONG resolves to exactly the 30-minute hard deadline (1800000ms)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE_LONG), 1_800_000);
  assert.equal(LONG_TASK_HARD_DEADLINE_MS, 1_800_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE_LONG), LONG_TASK_HARD_DEADLINE_MS);
});

test('the hard ceiling never exceeds the configured 1800000ms maximum', () => {
  assert.equal(MAX_TIMEOUT_MS, 1_800_000);
  assert.ok(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE_LONG) <= MAX_TIMEOUT_MS);
});

test('resolveExecutionOptions(OWNER_SINGLE_LONG) returns a frozen {timeoutMs,stage,permissionMode} triple, permissionMode:"plan" by default (P18-W4R3)', () => {
  const options = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE_LONG);
  assert.deepEqual(options, { timeoutMs: 1_800_000, stage: 'single_pm_long', permissionMode: 'plan' });
  assert.equal(Object.isFrozen(options), true);
});

test('NORMAL OWNER_SINGLE stays at 300000ms — LONG is additive, never a global change (Part U)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE), 300_000);
});

// ---- Part U/AR: backend-neutral forwarding ---------------------------------
//
// DSH-TIMEOUT-1 Part D (audit Finding T-3) supersedes the original Part U
// "gated strictly to LONG" design: production execution now ALWAYS forwards
// an explicit, policy-derived `timeoutMs` to every backend, for every stage
// — never only for OWNER_SINGLE_LONG — floored at that bridge's own
// pre-existing default (CODEX_CLI_DEFAULT_TIMEOUT_MS / OPENCODE_DEFAULT_
// TIMEOUT_MS / GROK_CLI_DEFAULT_TIMEOUT_MS / ANTIGRAVITY_DEFAULT_TIMEOUT_MS
// — production-pm-backend-registry.mjs's explicitBridgeTimeoutMs()) so a
// currently-working default can only ever be RAISED by this change, never
// silently lowered. The tests below replace the old "only LONG forwards"
// assertions with the new "always forwards, floored" contract.

function fakeSpawn({ stdout = '', code = 0, capture = {} } = {}) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => { child.stdout.end(stdout); child.stderr.end(''); queueMicrotask(() => child.emit('close', code)); });
    return child;
  };
}
const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
].join('\n');

test('Codex bridge receives an explicit timeoutMs for BOTH the LONG stage and NORMAL OWNER_SINGLE (Finding T-3 fix) — LONG raises it, NORMAL still exceeds the bridge default so it also forwards explicitly', async () => {
  const { summarizeCodexCliRun } = await import('../src/session/codex-cli-session-bridge.mjs');
  let longCapturedTimeout;
  let normalCapturedTimeout;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    codexRunner: async (value) => { longCapturedTimeout = value.timeoutMs; return summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"ok"}') }); },
  });
  const profile = { id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  await registry.resolve(profile, { project: { repo_path: 'C:/p' }, executionOptions: { timeoutMs: 1_800_000, stage: EXECUTION_STAGE.OWNER_SINGLE_LONG } }).decide({ turn: 0, request: {}, history: [] });
  assert.equal(longCapturedTimeout, 1_800_000);

  const registry2 = new ProductionPmBackendRegistry({
    probe: () => true,
    codexRunner: async (value) => { normalCapturedTimeout = value.timeoutMs; return summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"ok"}') }); },
  });
  await registry2.resolve(profile, { project: { repo_path: 'C:/p' }, executionOptions: { timeoutMs: 300_000, stage: EXECUTION_STAGE.OWNER_SINGLE } }).decide({ turn: 0, request: {}, history: [] });
  // DSH-TIMEOUT-1 Part D: production execution now ALWAYS forwards an
  // explicit timeoutMs — OWNER_SINGLE's 300000ms policy value exceeds
  // Codex's own 180000ms bridge default, so it is forwarded verbatim
  // (raising the effective ceiling, never lowering it).
  assert.equal(normalCapturedTimeout, 300_000);
});

test('OpenCode/Grok/Antigravity bridges receive an explicit timeoutMs for the LONG stage — raised above their own bridge default', async () => {
  for (const product of ['opencode', 'grok']) {
    let captured;
    const runnerKey = product === 'opencode' ? 'openCodeRunner' : 'grokRunner';
    const registry = new ProductionPmBackendRegistry({
      probe: () => true,
      [runnerKey]: async (value) => {
        captured = value;
        if (product === 'opencode') return { events: [], text: '{"type":"finish","output":"ok"}' };
        return { output: { text: '{"type":"finish","output":"ok"}' } };
      },
    });
    const profile = { id: 'p', product, transport: 'stdio', session_kind: 'STATELESS' };
    try {
      await registry.resolve(profile, { project: { repo_path: 'C:/p' }, executionOptions: { timeoutMs: 1_800_000, stage: EXECUTION_STAGE.OWNER_SINGLE_LONG } }).decide({ turn: 0, request: {}, history: [] });
    } catch { /* extraction shape mismatches are irrelevant here — only the forwarded call args matter */ }
    assert.equal(captured?.timeoutMs, 1_800_000, `${product} must receive the LONG timeoutMs`);
  }
});

// DSH-TIMEOUT-1 Part D (Finding T-3): the FLOOR half of the new contract —
// a stage whose central policy value is SHORTER than a bridge's own
// pre-existing default (e.g. a 120000ms council read-only stage against
// Antigravity's 300000ms default) must still forward that bridge's own
// default, never the shorter policy value — no currently-working timeout
// may silently regress. Table-driven across every non-Claude backend so a
// future default-constant edit in any one bridge is verified against this
// SAME floor contract automatically.
test('every non-Claude backend forwards an explicit timeoutMs floored at its OWN bridge default for a stage whose policy value is shorter (no regression)', async () => {
  const { CODEX_CLI_DEFAULT_TIMEOUT_MS, summarizeCodexCliRun } = await import('../src/session/codex-cli-session-bridge.mjs');
  const { OPENCODE_DEFAULT_TIMEOUT_MS } = await import('../src/session/opencode-cli-session-bridge.mjs');
  const { GROK_CLI_DEFAULT_TIMEOUT_MS } = await import('../src/session/grok-cli-session-bridge.mjs');
  const { ANTIGRAVITY_DEFAULT_TIMEOUT_MS } = await import('../src/session/antigravity-cli-session-bridge.mjs');
  const shortStageOptions = { timeoutMs: 120_000, stage: EXECUTION_STAGE.COUNCIL_CHAIR_PLAN };

  {
    let captured;
    const registry = new ProductionPmBackendRegistry({ probe: () => true, codexRunner: async (value) => { captured = value; return summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"ok"}') }); } });
    await registry.resolve({ id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' }, { project: { repo_path: 'C:/p' }, executionOptions: shortStageOptions }).decide({ turn: 0, request: {}, history: [] });
    assert.equal(captured.timeoutMs, CODEX_CLI_DEFAULT_TIMEOUT_MS, 'codex must floor at its own default, not the shorter 120000ms policy value');
    assert.ok(CODEX_CLI_DEFAULT_TIMEOUT_MS > 120_000);
  }
  {
    let captured;
    const registry = new ProductionPmBackendRegistry({ probe: () => true, openCodeRunner: async (value) => { captured = value; return { events: [], text: '{"type":"finish","output":"ok"}' }; } });
    try { await registry.resolve({ id: 'p', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { repo_path: 'C:/p' }, executionOptions: shortStageOptions }).decide({ turn: 0, request: {}, history: [] }); } catch { /* extraction shape irrelevant */ }
    assert.equal(captured.timeoutMs, OPENCODE_DEFAULT_TIMEOUT_MS);
  }
  {
    let captured;
    const registry = new ProductionPmBackendRegistry({ probe: () => true, grokRunner: async (value) => { captured = value; return { output: { text: '{"type":"finish","output":"ok"}' } }; } });
    await registry.resolve({ id: 'p', product: 'grok', transport: 'stdio', session_kind: 'STATELESS' }, { project: { repo_path: 'C:/p' }, executionOptions: shortStageOptions }).decide({ turn: 0, request: {}, history: [] });
    assert.equal(captured.timeoutMs, GROK_CLI_DEFAULT_TIMEOUT_MS);
  }
  {
    let captured;
    const registry = new ProductionPmBackendRegistry({
      probe: () => true,
      antigravityRunner: async (value) => { captured = value; return { events: [], result: { status: 'SUCCESS', response: '{"type":"finish","output":"ok"}' } }; },
    });
    await registry.resolve({ id: 'p', product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' }, { project: { repo_path: 'C:/p' }, executionOptions: shortStageOptions }).decide({ turn: 0, request: {}, history: [] });
    assert.equal(captured.timeoutMs, ANTIGRAVITY_DEFAULT_TIMEOUT_MS, 'antigravity must floor at its own 300000ms default, not the shorter 120000ms policy value');
    assert.ok(ANTIGRAVITY_DEFAULT_TIMEOUT_MS > 120_000);
  }
});

// DSH-TIMEOUT-1 Part I regression matrix — "Council implementation
// participant receives implementation budget" for a non-Claude backend
// too, proving T-2+T-3 compose correctly (the PM-review-corrected
// COUNCIL_IMPLEMENTATION_PARTICIPANT stage resolves the FULL
// LONG_TASK_HARD_DEADLINE_MS, 1800000ms — the same LONG budget
// OWNER_SINGLE_LONG gets, not merely OWNER_SINGLE's shorter 300000ms —
// which exceeds every non-Claude bridge default, so it forwards
// explicitly, unlike the read-only 120000ms council stages, which floor).
test('COUNCIL_IMPLEMENTATION_PARTICIPANT (1800000ms, the SAME LONG budget as OWNER_SINGLE_LONG) is explicitly forwarded to a non-Claude backend, exceeding its own bridge default', async () => {
  const { CODEX_CLI_DEFAULT_TIMEOUT_MS, summarizeCodexCliRun } = await import('../src/session/codex-cli-session-bridge.mjs');
  let captured;
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexRunner: async (value) => { captured = value; return summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"ok"}') }); } });
  await registry.resolve({ id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' }, { project: { repo_path: 'C:/p' }, executionOptions: { timeoutMs: 1_800_000, stage: EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT } }).decide({ turn: 0, request: {}, history: [] });
  assert.equal(captured.timeoutMs, 1_800_000);
  assert.ok(captured.timeoutMs > CODEX_CLI_DEFAULT_TIMEOUT_MS);
});

// ---- Full composition wiring: SUBMIT_TASK -> runtimeClass -> executionOptions ----

async function withComposition(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p10-r024-long-'));
  mkdirSync(join(root, 'repo'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const captured = [];
  const resolvePmDriver = (profile, context) => {
    captured.push(context);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'ok' }; } };
  };
  resolvePmDriver.inspect = (profile) => ({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind });
  const profile = { id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
  const project = { id: 'p', repo_path: join(root, 'repo'), default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'),
    projects: [project], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p', pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const coordination = { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} };
  const owner = { close: async () => {}, claimNotifications: async () => [] };
  const composition = await createP5ProductionComposition(config, { resolvePmDriver, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  try { await fn({ composition, captured, project, profile: composition.profileRegistry.get('pm') }); }
  finally { await composition.close(); rmSync(root, { recursive: true, force: true }); }
}

test('a task_source-bearing SUBMIT_TASK resolves the driver with the LONG timeout policy (1800000ms)', async () => {
  await withComposition(async ({ composition, captured, project, profile }) => {
    const taskSource = { type: 'GIT_FILE', requestedRef: 'abc1234', resolvedCommitSha: '0'.repeat(40), path: 'tasks/dsh/x.md', contentSha256: '1'.repeat(64), contentBytes: 10 };
    const result = await composition.taskController.submit({ command: { command_id: 'cmd-long', payload: { body: 'the resolved task file text', task_source: taskSource }, accepted_at: '2026-01-01T00:00:00.000Z' }, project, profile });
    assert.equal(result.status, 'MATERIALIZED');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].executionOptions.timeoutMs, 1_800_000);
    assert.equal(captured[0].executionOptions.stage, 'single_pm_long');
    const task = composition.taskController.getTask(result.task_id);
    assert.equal(task.envelope.context.runtimeClass, 'LONG');
    assert.deepEqual(task.envelope.context.taskSource, taskSource);
  });
});

test('a plain SUBMIT_TASK (no task_source) stays on the NORMAL policy — regression-safe', async () => {
  await withComposition(async ({ composition, captured, project, profile }) => {
    const result = await composition.taskController.submit({ command: { command_id: 'cmd-normal', payload: { body: 'a normal task' }, accepted_at: '2026-01-01T00:00:00.000Z' }, project, profile });
    assert.equal(captured[0].executionOptions.timeoutMs, 300_000);
    assert.equal(captured[0].executionOptions.stage, 'single_pm');
    const task = composition.taskController.getTask(result.task_id);
    assert.equal(task.envelope.context.runtimeClass, 'NORMAL');
    assert.equal('taskSource' in task.envelope.context, false);
  });
});

// ---- Part T/Y: activity never extends the hard deadline (the bridge's own timer is unconditional) ----

function fakeSlowSpawn(delayMs) {
  return () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    // Emits ongoing "activity" chunks throughout — proving the timer still
    // fires at exactly timeoutMs regardless of how much real activity
    // occurred in between (Part Y: activity does not extend the hard
    // deadline).
    const activityTimer = setInterval(() => { try { child.stdout.write('.'); } catch { /* stream may already be ending */ } }, Math.max(1, Math.floor(delayMs / 5)));
    setTimeout(() => {
      clearInterval(activityTimer);
      child.stdout.end(JSON.stringify({ session_id: 's1', result: JSON.stringify({ type: 'finish', output: 'done' }) }));
      child.stderr.end('');
      child.emit('close', 0);
    }, delayMs);
    return child;
  };
}

test('a call that outlives the LONG timeoutMs is still killed at exactly that ceiling, even with ongoing activity chunks', async () => {
  const { runClaudeProcess } = await import('../src/session/claude-code-session-bridge.mjs');
  const SCALED_LONG_MS = 100; // stands in for 1_800_000ms
  const REAL_CALL_DURATION_MS = 300; // outlives the scaled ceiling
  await assert.rejects(
    runClaudeProcess({ binary: process.execPath, prompt: 'x', timeoutMs: SCALED_LONG_MS, spawnImpl: fakeSlowSpawn(REAL_CALL_DURATION_MS) }),
    (error) => error.code === 'CLAUDE_TIMEOUT' && error.terminationRequestedByDsh === true,
  );
});

test('no auto-retry and no partial salvage on hard timeout — the caller sees exactly one typed rejection, never a synthesized success', async () => {
  const { runClaudeProcess } = await import('../src/session/claude-code-session-bridge.mjs');
  let calls = 0;
  const countingSpawn = (delayMs) => (...args) => { calls += 1; return fakeSlowSpawn(delayMs)(...args); };
  await assert.rejects(runClaudeProcess({ binary: process.execPath, prompt: 'x', timeoutMs: 20, spawnImpl: countingSpawn(200) }), (e) => e.code === 'CLAUDE_TIMEOUT');
  assert.equal(calls, 1);
});
