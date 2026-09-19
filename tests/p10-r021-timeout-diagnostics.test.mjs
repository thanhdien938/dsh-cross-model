import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProductionPmBackendRegistry, ProductionPmBackendError } from '../src/pm/production-pm-backend-registry.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { forwardBackendEventToTaskLog, createTaskDiagnosticLogFactory, TaskDiagnosticLog, taskLogDir, TASK_LOG_EVENT_TYPES } from '../src/runtime/task-diagnostic-log.mjs';
import { buildTaskSummaryMarkdown } from '../src/runtime/task-diagnostic-summary.mjs';
import { resolveExecutionOptions, EXECUTION_STAGE } from '../src/pm/pm-execution-timeout-policy.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };

function claudeTimeoutError({ timeoutMs = 300_000, elapsedMs = 300_123, processPid = 44896, stdoutBytes = 0, stderrBytes = 0, assistantOutputPresent = false } = {}) {
  const error = new Error(`claude process timed out after ${timeoutMs}ms`);
  error.name = 'ClaudeCodeSessionError';
  error.code = 'CLAUDE_TIMEOUT';
  Object.assign(error, { timeoutMs, elapsedMs, processPid, stdoutBytes, stderrBytes, assistantOutputPresent, terminationRequestedByDsh: true, observedSignal: null, observedExitCode: null, stdout: '', stderr: 'irrelevant raw text that must never leak into diagnostics' });
  return error;
}

// ---- Part E: only claude-code forwards executionOptions.timeoutMs -------

test('registry forwards executionOptions.timeoutMs to the Claude bridge only', async () => {
  let capturedTimeout;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeRunner: async (value) => { capturedTimeout = value.timeoutMs; return { sessionId: 's1', result: JSON.stringify({ type: 'finish', output: 'ok' }) }; },
  });
  const profile = { id: 'c', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const executionOptions = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE);
  await registry.resolve(profile, { project: PROJECT, executionOptions }).decide({ turn: 0, request: {}, history: [] });
  assert.equal(capturedTimeout, 300_000);
});

// DSH-TIMEOUT-1 Part D (audit Finding T-3) supersedes this test's original
// "Part E: unsupported backends unchanged" premise — production execution
// now ALWAYS forwards an explicit, policy-derived `timeoutMs` to every
// backend (production-pm-backend-registry.mjs's explicitBridgeTimeoutMs()),
// floored at that bridge's own pre-existing default so a currently-working
// timeout can only be raised, never silently lowered. COUNCIL_PARTICIPANT_
// REPORT's 120000ms policy value is shorter than Codex's own 180000ms
// bridge default (CODEX_CLI_DEFAULT_TIMEOUT_MS), so the FLOORED value
// (180000ms, not the unfloored 120000ms) is what now reaches the bridge —
// still an explicit, present field, never the old "field entirely absent"
// behavior this test used to assert.
test('registry forwards an explicit, floored timeoutMs to Codex for a stage shorter than its own bridge default (Finding T-3 fix)', async () => {
  const { CODEX_CLI_DEFAULT_TIMEOUT_MS } = await import('../src/session/codex-cli-session-bridge.mjs');
  let codexInput;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    codexRunner: async (value) => { codexInput = value; return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"type":"finish","output":"ok"}' } }), events: [] }; },
  });
  const profile = { id: 'x', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  const executionOptions = resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT);
  try {
    await registry.resolve(profile, { project: PROJECT, executionOptions }).decide({ turn: 0, request: {}, history: [] });
  } catch { /* extractCodexAssistantText's real parsing rules are not this test's concern */ }
  assert.equal('timeoutMs' in (codexInput ?? {}), true);
  assert.equal(codexInput.timeoutMs, CODEX_CLI_DEFAULT_TIMEOUT_MS);
  assert.ok(codexInput.timeoutMs > executionOptions.timeoutMs, 'the floor must raise, never adopt, the shorter policy value verbatim');
});

// ---- Part K/N: BACKEND_TIMEOUT observer event on a *_TIMEOUT error ------

test('a CLAUDE_TIMEOUT error emits a structured BACKEND_TIMEOUT observer event before the generic terminal FAILED event', async () => {
  const emitted = [];
  const observer = createBackendExecutionObserver({ emit: (event) => emitted.push(event) });
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer,
    claudeRunner: async () => { throw claudeTimeoutError(); },
  });
  const profile = { id: 'c', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const executionOptions = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE);
  await assert.rejects(registry.resolve(profile, { project: PROJECT, executionOptions }).decide({ turn: 0, request: {}, history: [] }), (e) => e.code === 'CLAUDE_TIMEOUT');

  const timeoutEvent = emitted.find((e) => e.eventKind === 'TIMEOUT');
  const terminalEvent = emitted.find((e) => e.eventKind === 'TERMINAL');
  assert.ok(timeoutEvent, 'a TIMEOUT event was emitted');
  assert.ok(terminalEvent, 'a TERMINAL event was still emitted');
  assert.equal(timeoutEvent.stage, EXECUTION_STAGE.OWNER_SINGLE);
  assert.equal(timeoutEvent.timeoutMs, 300_000);
  assert.equal(timeoutEvent.durationMs, 300_123);
  assert.equal(timeoutEvent.pid, 44896);
  assert.equal(timeoutEvent.terminationRequested, true);
  assert.equal(timeoutEvent.backendProduct, 'claude-code');
  // The TIMEOUT event must precede the TERMINAL event in emission order.
  assert.ok(emitted.indexOf(timeoutEvent) < emitted.indexOf(terminalEvent));
});

test('no raw prompt, raw stdout/stderr text, or secrets ever appear on the TIMEOUT event', async () => {
  const emitted = [];
  const observer = createBackendExecutionObserver({ emit: (event) => emitted.push(event) });
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer,
    claudeRunner: async () => { throw claudeTimeoutError({ stdoutBytes: 12, stderrBytes: 4, assistantOutputPresent: true }); },
  });
  const profile = { id: 'c', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  await assert.rejects(registry.resolve(profile, { project: PROJECT, executionOptions: resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE) }).decide({ turn: 0, request: { objective: 'a secret owner task about api_key=sk-verysecret' }, history: [] }));
  const timeoutEvent = emitted.find((e) => e.eventKind === 'TIMEOUT');
  const serialized = JSON.stringify(timeoutEvent);
  assert.equal(serialized.includes('secret owner task'), false);
  assert.equal(serialized.includes('irrelevant raw text'), false);
  assert.equal(serialized.includes('sk-verysecret'), false);
  // Only structural counts/booleans travel -- never raw output.
  assert.equal(timeoutEvent.stdoutBytes, 12);
  assert.equal(timeoutEvent.stderrBytes, 4);
  assert.equal(timeoutEvent.assistantOutputPresent, true);
});

test('a non-timeout error (e.g. PM_DECISION_EMPTY_OUTPUT) never emits a TIMEOUT event', async () => {
  const emitted = [];
  const observer = createBackendExecutionObserver({ emit: (event) => emitted.push(event) });
  const registry = new ProductionPmBackendRegistry({
    probe: () => true, observer,
    claudeRunner: async () => ({ sessionId: 's1', result: JSON.stringify({ type: 'finish' }) }),
  });
  const profile = { id: 'c', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  await assert.rejects(registry.resolve(profile, { project: PROJECT }).decide({ turn: 0, request: {}, history: [] }), (e) => e.code === 'PM_DECISION_EMPTY_OUTPUT');
  assert.equal(emitted.some((e) => e.eventKind === 'TIMEOUT'), false);
});

// ---- BACKEND_TIMEOUT task-log bridge (Part K) -----------------------------

test('forwardBackendEventToTaskLog forwards a TIMEOUT event as a BACKEND_TIMEOUT task-log entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r021-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: dir });
    const event = {
      eventKind: 'TIMEOUT', taskId: 'task-1', projectId: 'dsh-p6-test-b', pmRunId: 'run-1', taskMode: 'SINGLE',
      profileId: 'live1-claude-pm', backendProduct: 'claude-code', pid: 44896, attempt: 0, stage: 'single_pm',
      timeoutMs: 300_000, durationMs: 300_123, stdoutBytes: 0, stderrBytes: 0, assistantOutputPresent: false, terminationRequested: true,
    };
    assert.equal(forwardBackendEventToTaskLog(event, factory), true);
    const lines = readFileSync(join(taskLogDir(dir, 'task-1'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.event_type === 'BACKEND_TIMEOUT');
    assert.ok(entry);
    assert.equal(entry.stage, 'single_pm');
    assert.equal(entry.timeout_ms, 300_000);
    assert.equal(entry.elapsed_ms, 300_123);
    assert.equal(entry.process_pid, 44896);
    assert.equal(entry.product, 'claude-code');
    assert.equal(entry.termination_requested, true);
    assert.equal(TASK_LOG_EVENT_TYPES.BACKEND_TIMEOUT, 'BACKEND_TIMEOUT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('forwardBackendEventToTaskLog still ignores STDOUT_EVENT/CONTEXT (never a second source of truth beyond SPAWN/EXIT/TIMEOUT)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r021-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: dir });
    assert.equal(forwardBackendEventToTaskLog({ eventKind: 'STDOUT_SUMMARY', taskId: 't1' }, factory), false);
    assert.equal(forwardBackendEventToTaskLog({ eventKind: 'CONTEXT', taskId: 't1' }, factory), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- summary.md Timeout section (Part L) ---------------------------------

test('buildTaskSummaryMarkdown renders a Timeout section only when timeoutDetail is present', () => {
  const withoutTimeout = buildTaskSummaryMarkdown({ taskId: 't1', status: 'completed' });
  assert.equal(withoutTimeout.includes('## Timeout'), false);

  const withTimeout = buildTaskSummaryMarkdown({
    taskId: 't2', status: 'failed', errorCode: 'CLAUDE_TIMEOUT',
    timeoutDetail: { backend: 'claude-code', stage: 'single_pm', profile: 'live1-claude-pm', configuredTimeoutMs: 300_000, elapsedMs: 300_123, processPid: 44896, outputObserved: false, terminalError: 'CLAUDE_TIMEOUT' },
  });
  assert.ok(withTimeout.includes('## Timeout'));
  assert.ok(withTimeout.includes('300000 ms'));
  assert.ok(withTimeout.includes('300123 ms'));
  assert.ok(withTimeout.includes('44896'));
  assert.ok(withTimeout.includes('single_pm'));
  assert.ok(withTimeout.includes('CLAUDE_TIMEOUT'));
});

// ---- end-to-end: TaskDiagnosticLog round-trip matches what production- ---
// ---- pm-worker.mjs's timeoutDetail extraction expects --------------------

test('a real TaskDiagnosticLog BACKEND_TIMEOUT event round-trips through readback with the exact field names production-pm-worker.mjs reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r021-'));
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: dir, taskId: 'task-2', projectId: 'p', pmRunId: 'run-2', taskMode: 'SINGLE' });
    log.event('BACKEND_TIMEOUT', {
      profile_id: 'live1-claude-pm', product: 'claude-code', process_pid: 44896, attempt: 0, stage: 'single_pm',
      timeout_ms: 300_000, elapsed_ms: 300_123, stdout_bytes: 0, stderr_bytes: 0, assistant_output_present: false, termination_requested: true,
    });
    const raw = readFileSync(join(log.dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = raw.filter((e) => e.event_type === 'BACKEND_TIMEOUT').at(-1);
    assert.equal(last.product, 'claude-code');
    assert.equal(last.stage, 'single_pm');
    assert.equal(last.timeout_ms, 300_000);
    assert.equal(last.elapsed_ms, 300_123);
    assert.equal(last.process_pid, 44896);
    assert.equal(last.assistant_output_present, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
