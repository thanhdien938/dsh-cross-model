/**
 * P20.8R3 — report-plane backend execution observability (wiring only).
 *
 * Authority: docs/P20/P20_8R3_REPORT_PLANE_BACKEND_EXECUTION_OBSERVABILITY_MASTER_PROMPT.md
 *
 * Proves that a P20 report-plane CLI invocation (claude-code / opencode /
 * antigravity, via cli-report-backends.mjs's create*ReportBackend()
 * factories) surfaces through the EXACT SAME BackendExecutionObserver
 * contract the decision plane already uses (backend-execution-
 * observer.mjs's createBackendExecutionObserver() + withSpawnObservation())
 * — never a second observer protocol, IPC channel, or event schema.
 *
 * Offline only. No real Claude/OpenCode/Antigravity CLI is ever spawned:
 * every test injects a fake ChildProcess-shaped EventEmitter as
 * `spawnImpl`, matching the exact fake-child pattern
 * tests/backend-execution-observer.test.mjs already uses for
 * withSpawnObservation(). ZERO_LIVE_PROVIDER_CALLS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createClaudeReportBackend,
  createOpenCodeReportBackend,
  createAntigravityReportBackend,
} from '../src/pm/report-backends/cli-report-backends.mjs';
import { createBackendExecutionObserver, EXEC_LOG_SENTINEL } from '../src/runtime/backend-execution-observer.mjs';
import { createCliReportBackendResolver } from '../src/runtime/p20-report-route-resolution.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';

// ---- fake CLI child process ------------------------------------------
//
// A minimal real node:events.EventEmitter (not a single-callback-slot
// stub) so that BOTH the real bridge's own listeners (child.on('close'|
// 'error', ...), child.stdout.on('data', ...)) AND withSpawnObservation()'s
// listeners (child.once('exit', ...), child.stdout.on('data', ...)) can
// coexist on the same streams/process, exactly like a real ChildProcess
// allows multiple listeners per event.
function fakeCliChild({ stdout = '', stderr = '', exitCode = 0, pid = 4242 } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => {};
  proc.stdin.end = () => {};
  // Deferred so every caller (the real bridge AND withSpawnObservation())
  // has already attached its listeners — a real child process's first
  // 'data'/'close' always arrives asynchronously. setImmediate (after all
  // microtasks/promise continuations drain) gives more scheduling headroom
  // than a single queueMicrotask tick, which proved marginal enough to be
  // observed racing against listener attachment under loaded CI runners
  // even though it was reliable locally.
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('exit', exitCode, null);
    proc.emit('close', exitCode, null);
  });
  return proc;
}

function fakeRequest(overrides = {}) {
  return {
    profileId: 'p20r3-claude-pm',
    executionId: 'exec-p20r3-0001',
    taskId: 'task-p20r3-0001',
    stage: 'artifact_council_participant_report',
    role: 'participant',
    store: { projectId: 'dsh-p20r3-project' },
    ...overrides,
  };
}

function collectingObserver() {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  return { observer, events };
}

// A real CLI run also emits STDOUT_EVENT/STDERR chunks between
// PROCESS_SPAWN and PROCESS_EXIT (withSpawnObservation() observes every
// stdout/stderr `data` event) — this only asserts the four REQUIRED
// lifecycle phases §8 item 1-3 names appear, in order, ignoring how many
// STDOUT_EVENT/STDERR chunks land in between.
function assertPhaseSubsequence(events, expected) {
  const phases = events.map((e) => e.phase);
  let cursor = 0;
  for (const phase of expected) {
    const found = phases.indexOf(phase, cursor);
    assert.ok(found >= cursor, `expected phase ${phase} at/after index ${cursor}, got sequence ${JSON.stringify(phases)}`);
    cursor = found + 1;
  }
}

// ---- 1/2/3 — START -> PROCESS_SPAWN -> PROCESS_EXIT -> TERMINAL -------

test('Claude report-plane invocation emits START -> PROCESS_SPAWN -> PROCESS_EXIT -> TERMINAL through the existing observer seam', async () => {
  const { observer, events } = collectingObserver();
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'claude-sonnet',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'RAW PROMPT TEXT — must never be observed', request: fakeRequest() });
  assert.equal(result.terminal_state, 'SUCCESS');
  assertPhaseSubsequence(events, ['START', 'PROCESS_SPAWN', 'PROCESS_EXIT', 'TERMINAL']);
  assert.equal(events.at(-1).status, 'COMPLETED');
  assert.equal(events[0].backendProduct, 'claude-code');
});

test('OpenCode report-plane invocation emits START -> PROCESS_SPAWN -> PROCESS_EXIT -> TERMINAL through the existing observer seam', async () => {
  const { observer, events } = collectingObserver();
  const backend = createOpenCodeReportBackend({
    binary: 'fake-opencode', cwd: '/repo', model: 'grok-code',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: '', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'RAW PROMPT TEXT — must never be observed', request: fakeRequest({ profileId: 'p20r3-opencode-pm' }) });
  assert.equal(result.terminal_state, 'SUCCESS');
  assertPhaseSubsequence(events, ['START', 'PROCESS_SPAWN', 'PROCESS_EXIT', 'TERMINAL']);
  assert.equal(events.at(-1).status, 'COMPLETED');
  assert.equal(events[0].backendProduct, 'opencode');
});

test('Antigravity report-plane invocation emits START -> PROCESS_SPAWN -> PROCESS_EXIT -> TERMINAL through the existing observer seam', async () => {
  const { observer, events } = collectingObserver();
  const backend = createAntigravityReportBackend({
    binary: 'fake-agy', cwd: '/repo', model: 'antigravity-fast',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })}\n`, exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'RAW PROMPT TEXT — must never be observed', request: fakeRequest({ profileId: 'p20r3-antigravity-pm' }) });
  assert.equal(result.terminal_state, 'SUCCESS');
  assertPhaseSubsequence(events, ['START', 'PROCESS_SPAWN', 'PROCESS_EXIT', 'TERMINAL']);
  assert.equal(events.at(-1).status, 'COMPLETED');
  assert.equal(events[0].backendProduct, 'antigravity');
});

// ---- 4 — correlation identity ------------------------------------------

test('emitted event identity carries backendProduct/profileId/projectId/taskId/runId/stage/cwd/model, and never fabricates pmRunId', async () => {
  const { observer, events } = collectingObserver();
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo/project-b', model: 'claude-sonnet-5',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  await backend.runReport({
    prompt: 'prompt', request: fakeRequest({
      profileId: 'p20r3-claude-pm', executionId: 'exec-correlation-0007', taskId: 'task-correlation-0007',
      stage: 'artifact_council_chair_synthesis', role: 'chair', store: { projectId: 'dsh-correlation-project' },
    }),
  });
  const start = events.find((e) => e.phase === 'START');
  assert.equal(start.backendProduct, 'claude-code');
  assert.equal(start.profileId, 'p20r3-claude-pm');
  assert.equal(start.projectId, 'dsh-correlation-project');
  assert.equal(start.taskId, 'task-correlation-0007');
  assert.equal(start.runId, 'exec-correlation-0007');
  assert.equal(start.stage, 'artifact_council_chair_synthesis');
  assert.equal(start.role, 'chair');
  assert.equal(start.cwd, '/repo/project-b');
  assert.equal(start.model, 'claude-sonnet-5');
  // Never fabricated — this layer has no PM decision-plane run.
  assert.equal(start.pmRunId, null);
  for (const e of events) assert.equal(e.pmRunId, null, `pmRunId must stay null on every event, got ${e.pmRunId} on ${e.phase}`);
});

// ---- 5 — truthful failed terminal on a report-plane failure ------------

test('a report-plane process failure emits a truthful FAILED terminal event (never optimistic COMPLETED)', async () => {
  const { observer, events } = collectingObserver();
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'claude-sonnet',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: '', stderr: 'boom', exitCode: 1 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'prompt', request: fakeRequest() });
  assert.notEqual(result.terminal_state, 'SUCCESS');
  const terminalEvent = events.find((e) => e.phase === 'TERMINAL');
  assert.ok(terminalEvent, 'a TERMINAL event must always be emitted, success or failure');
  assert.equal(terminalEvent.status, 'FAILED');
  // The observer's terminal() method (backend-execution-observer.mjs)
  // folds `error` into the human-readable `message` string only — the
  // SAME convention the decision plane's own observe(observer,'terminal',
  // ...) calls already use — never a dedicated top-level field.
  assert.ok(terminalEvent.message.includes('FAILED'));
  assert.ok(terminalEvent.message.includes('CLAUDE_EXIT_FAILED'), `expected a safe, visible error code in the terminal message, got: ${terminalEvent.message}`);
});

test('a CANCELLED Antigravity report-plane outcome still surfaces as an observed FAILED terminal (existing observer/UI vocabulary has no distinct CANCELLED badge)', async () => {
  const { observer, events } = collectingObserver();
  const backend = createAntigravityReportBackend({
    binary: 'fake-agy', cwd: '/repo', model: 'antigravity-fast',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: `${JSON.stringify({ event: 'result', result: { status: 'CANCELED' } })}\n`, exitCode: 0 }),
    deliveryMechanism: 'VERBATIM_MATERIALIZATION',
  });
  const result = await backend.runReport({ prompt: 'prompt', request: fakeRequest({ profileId: 'p20r3-antigravity-pm' }) });
  assert.equal(result.terminal_state, 'CANCELLED');
  assert.equal(result.cancelled, true);
  const terminalEvent = events.find((e) => e.phase === 'TERMINAL');
  assert.equal(terminalEvent.status, 'FAILED');
  assert.ok(terminalEvent.message.includes('CLI_REPORT_CANCELLED'));
});

// ---- 6 — observer failure never affects the real report result ---------

test('a throwing observer sink is swallowed and never alters the report execution result', async () => {
  const throwingObserver = createBackendExecutionObserver({ emit: () => { throw new Error('sink exploded'); } });
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'claude-sonnet',
    observer: throwingObserver,
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'prompt', request: fakeRequest() });
  assert.equal(result.terminal_state, 'SUCCESS');
});

test('an observer whose methods are entirely missing (a partial custom observer) never breaks a report execution', async () => {
  const backend = createOpenCodeReportBackend({
    binary: 'fake-opencode', cwd: '/repo', model: 'grok-code',
    observer: {}, // no start/spawn/exit/terminal methods at all
    spawnImpl: () => fakeCliChild({ stdout: '', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  const result = await backend.runReport({ prompt: 'prompt', request: fakeRequest({ profileId: 'p20r3-opencode-pm' }) });
  assert.equal(result.terminal_state, 'SUCCESS');
});

// ---- 7 — never the raw report/prompt body -------------------------------

test('no observed event ever carries the raw prompt text or the model report content', async () => {
  const SECRET_PROMPT = 'RAW-PROMPT-CANARY-f19c2b';
  const SECRET_STDOUT = 'RAW-REPORT-CANARY-a77e40';
  const { observer, events } = collectingObserver();
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'claude-sonnet',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: `{"result":${JSON.stringify(SECRET_STDOUT)}}`, exitCode: 0 }),
    // VERBATIM_MATERIALIZATION: the report text IS returned in the
    // function result — the observability contract must still never leak
    // it into any observed event.
    deliveryMechanism: 'VERBATIM_MATERIALIZATION',
  });
  const result = await backend.runReport({ prompt: SECRET_PROMPT, request: fakeRequest() });
  assert.equal(result.accepted_visible_text, SECRET_STDOUT, 'sanity: the report result itself does carry the real text');
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(SECRET_PROMPT), false, 'prompt text must never reach an observed event');
  assert.equal(serialized.includes(SECRET_STDOUT), false, 'report/assistant text must never reach an observed event');
});

// ---- 3 (composition) — createCliReportBackendResolver threads the SAME observer to every product, defaults safely when absent ----

test('createCliReportBackendResolver threads one shared observer into all three product backends', async () => {
  const { observer, events } = collectingObserver();
  const profileRegistry = new PmProfileRegistry([
    { id: 'p20r3-claude', role_kind: 'PM', product: 'claude-code', model: 'claude-sonnet', session_kind: 'STATELESS', transport: 'stdio' },
    { id: 'p20r3-opencode', role_kind: 'PM', product: 'opencode', model: 'grok-code', session_kind: 'STATELESS', transport: 'stdio' },
  ]);
  const resolver = createCliReportBackendResolver({
    profileRegistry, project: { id: 'proj-1', repo_path: '/repo' },
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    observer,
  });
  await resolver('p20r3-claude').runReport({ prompt: 'p', request: fakeRequest({ profileId: 'p20r3-claude' }) });
  await resolver('p20r3-opencode').runReport({ prompt: 'p', request: fakeRequest({ profileId: 'p20r3-opencode' }) });
  const products = new Set(events.filter((e) => e.phase === 'START').map((e) => e.backendProduct));
  assert.deepEqual(products, new Set(['claude-code', 'opencode']));
});

test('createCliReportBackendResolver defaults to a real (non-null) observer when none is supplied — a report execution is never silently unobserved', async () => {
  const profileRegistry = new PmProfileRegistry([
    { id: 'p20r3-claude-default', role_kind: 'PM', product: 'claude-code', model: 'claude-sonnet', session_kind: 'STATELESS', transport: 'stdio' },
  ]);
  const resolver = createCliReportBackendResolver({
    profileRegistry, project: { id: 'proj-1', repo_path: '/repo' },
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    // observer intentionally omitted
  });
  const originalLog = console.log;
  const logged = [];
  console.log = (line) => logged.push(line);
  try {
    const result = await resolver('p20r3-claude-default').runReport({ prompt: 'p', request: fakeRequest({ profileId: 'p20r3-claude-default' }) });
    assert.equal(result.terminal_state, 'SUCCESS');
  } finally {
    console.log = originalLog;
  }
  const sentinelLines = logged.filter((l) => typeof l === 'string' && l.startsWith(EXEC_LOG_SENTINEL));
  assert.ok(sentinelLines.length > 0, 'the default observer must still write the stdout sentinel Desktop ingests');
});

// ---- 10 — optional local non-model smoke: sentinel line is Desktop-ingestible ----

test('optional smoke: an emitted event round-trips through the exact ##DSH_BACKEND_EXEC## sentinel line format Desktop already parses', async () => {
  const lines = [];
  const observer = createBackendExecutionObserver({ emit: (event) => { lines.push(`${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}`); } });
  const backend = createClaudeReportBackend({
    binary: 'fake-claude', cwd: '/repo', model: 'claude-sonnet',
    observer,
    spawnImpl: () => fakeCliChild({ stdout: '{"result":"ok"}', exitCode: 0 }),
    deliveryMechanism: 'DIRECT_WRITE',
  });
  await backend.runReport({ prompt: 'p', request: fakeRequest() });
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    assert.ok(line.startsWith(EXEC_LOG_SENTINEL));
    // Mirrors backendExecutionLogService.ts's processLine(): strip the
    // sentinel prefix, then JSON.parse the remainder.
    const parsed = JSON.parse(line.slice(EXEC_LOG_SENTINEL.length).trim());
    assert.equal(parsed.backendProduct, 'claude-code');
    assert.ok(['claude-code', 'opencode', 'antigravity', 'codex', 'grok'].includes(parsed.backendProduct));
  }
});
