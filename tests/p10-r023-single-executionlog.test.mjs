import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { materializeTaskHistory, EXECUTION_LOG_VERSION } from '../src/runtime/repo-history-materializer.mjs';
import { buildSingleExecutionEntries, extractSingleProcessEvidence } from '../src/runtime/repo-history-extract.mjs';

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r023-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PROFILES = {
  'live1-claude-pm': { product: 'claude-code', model: 'sonnet', reasoning: 'high', session_kind: 'STATELESS', transport: 'stdio' },
  'live1-codex-gpt-5-6-sol-pm': { product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', transport: 'stdio' },
};
const resolveProfile = (id) => PROFILES[id] ?? null;

function singleTurn(status = 'completed') {
  return [{ turn: 0, decision: { type: 'finish' }, outcome: { status, completedAt: '2026-08-24T14:38:05.658Z' } }];
}

function baseSingleArgs(root, overrides = {}) {
  return {
    projectRoot: root, taskId: 'task-yadbWFjx_zv8UYxKP1Q-9eNGkqUieVRU', pmRunId: 'pmrun-yadbWFjx_zv8UYxKP1Q-9eNGkqUieVRU',
    projectId: 'dsh-p6-test-b', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', commandId: 'tg-abc',
    createdAt: '2026-08-24T14:36:42.372Z', completedAt: '2026-08-24T14:38:05.658Z', status: 'completed',
    ownerTaskText: 'T3 task text', pmProfileId: 'live1-codex-gpt-5-6-sol-pm', history: singleTurn(),
    finalOutput: 'done', finalData: null, resolveProfile, events: [], ...overrides,
  };
}

function codexEvents() {
  return [
    { event_type: 'TASK_ACCEPTED', pm_profile_id: 'live1-codex-gpt-5-6-sol-pm' },
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: '2026-08-24T14:36:42.648Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', process_pid: 4364 },
    { event_type: 'BACKEND_PROCESS_EXIT', timestamp: '2026-08-24T14:38:05.642Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', exit_code: 0 },
    { event_type: 'CODEX_SANDBOX_STATE', timestamp: '2026-08-24T14:38:05.656Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', stage: 'single_pm', sandbox_state: 'READY', sandbox_failure_code: null, helper_resolution: 'FOUND', helper_execution: 'OK' },
  ];
}

function claudeEvents() {
  return [
    { event_type: 'TASK_ACCEPTED', pm_profile_id: 'live1-claude-pm' },
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: '2026-08-24T13:10:10.607Z', profile_id: 'live1-claude-pm', product: 'claude-code', process_pid: 42764 },
    { event_type: 'BACKEND_PROCESS_EXIT', timestamp: '2026-08-24T13:12:05.060Z', profile_id: 'live1-claude-pm', product: 'claude-code', exit_code: 0 },
  ];
}

// ---- Part Z.1/Z.2: Claude/Codex SINGLE with PID ---------------------------

test('1: Claude SINGLE with PID projects PM identity + process_pid into ExecutionLog.md', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, {
    taskId: 'task-1alISjgrMqS0xj_-ctGwaD2BhfzaOGhv', pmRunId: 'pmrun-1alISjgrMqS0xj_-ctGwaD2BhfzaOGhv',
    pmProfileId: 'live1-claude-pm', events: claudeEvents(),
  }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /profile_id: live1-claude-pm/);
  assert.match(log, /product: claude-code/);
  assert.match(log, /process_pid: 42764/);
  assert.match(log, /exit_code: 0/);
}));

test('2: Codex SINGLE with PID projects PM identity + process_pid into ExecutionLog.md', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /profile_id: live1-codex-gpt-5-6-sol-pm/);
  assert.match(log, /product: codex/);
  assert.match(log, /process_pid: 4364/);
}));

// ---- Part Z.3: Codex sandbox READY projection ------------------------------

test('3: Codex sandbox READY/FOUND/OK is projected as its own section', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /## CODEX SANDBOX/);
  assert.match(log, /state: READY/);
  assert.match(log, /helper_resolution: FOUND/);
  assert.match(log, /helper_execution: OK/);
}));

// ---- Part Z.4: missing PID -------------------------------------------------

test('4: missing PID is honestly represented, never fabricated', () => {
  const entries = buildSingleExecutionEntries({
    taskId: 't', pmRunId: 'r', taskAcceptedAt: '2026-01-01T00:00:00Z', taskCompletedAt: '2026-01-01T00:01:00Z',
    status: 'completed', profileId: 'live1-claude-pm', profile: PROFILES['live1-claude-pm'], history: singleTurn(),
    events: [{ event_type: 'BACKEND_PROCESS_SPAWN', product: 'claude-code', process_pid: null }],
  });
  const spawnEntry = entries.find((e) => e.heading === 'BACKEND_PROCESS_SPAWN');
  assert.equal(spawnEntry.fields.process_pid, 'NOT RECORDED');
});

// ---- Part Z.5: process exit 0 ----------------------------------------------

test('5: process exit 0 is represented plainly', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /## BACKEND_PROCESS_EXIT[\s\S]*?exit_code: 0/);
}));

// ---- Part Z.6: nonzero exit representation ---------------------------------

test('6: a nonzero exit_code is projected as-is, never reinterpreted as success', () => {
  const entries = buildSingleExecutionEntries({
    taskId: 't', pmRunId: 'r', taskAcceptedAt: null, taskCompletedAt: null, status: 'failed',
    profileId: 'p', profile: null, history: [],
    events: [{ event_type: 'BACKEND_PROCESS_EXIT', exit_code: 1 }],
  });
  const exitEntry = entries.find((e) => e.heading === 'BACKEND_PROCESS_EXIT');
  assert.equal(exitEntry.fields.exit_code, 1);
});

// ---- Part Z.7/Z.8: task completed / handoff completed ----------------------

test('7/8: TASK_COMPLETED and REPOSITORY HANDOFF sections are present with real status/path', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /## TASK_COMPLETED[\s\S]*?status: completed/);
  assert.match(log, /## REPOSITORY HANDOFF[\s\S]*?materialization: COMPLETED/);
}));

// ---- Part Z.9: history path -------------------------------------------------

test('9: REPOSITORY HANDOFF history_path matches the real materialized folder', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.ok(log.includes(`history_path: ${result.historyPath}`));
}));

// ---- Part Z.10: idempotent flag ---------------------------------------------

test('10: a second materialize call at the SAME execution_log_version is idempotent and does not rewrite content', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  assert.equal(first.idempotent, false);
  const before = readFileSync(join(root, ...first.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  const second = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  assert.equal(second.idempotent, true);
  assert.equal(second.historyPath, first.historyPath);
  const after = readFileSync(join(root, ...first.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.equal(before, after);
}));

test('a stale (pre-R0.2.3) marker with no execution_log_version is treated as stale and re-materialized', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseSingleArgs(root, { events: [] }));
  const markerPath = join(root, ...first.historyPath.split('/'), '.materialized.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  delete marker.execution_log_version;
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  const second = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  assert.equal(second.idempotent, false, 'stale marker must trigger re-materialization, not a no-op');
  const log = readFileSync(join(root, ...second.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /process_pid: 4364/);
}));

// ---- Part Z.11-14: no raw stream/prompt/CoT content -----------------------

test('11/12/13/14: no raw stdout/stderr/task-prompt-dump/CoT ever appears in ExecutionLog.md', () => withTmpProject((root) => {
  const events = [
    ...codexEvents(),
    // A hostile/unexpected event field never sanctioned by the builder's
    // fixed allowlist -- must never leak through even if events.jsonl
    // somehow carried one.
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: 't', process_pid: 1, raw_stdout: 'SECRET_STDOUT_BLOB', raw_stderr: 'SECRET_STDERR_BLOB', chain_of_thought: 'private reasoning' },
  ];
  const result = materializeTaskHistory(baseSingleArgs(root, { events, ownerTaskText: 'A'.repeat(50000) }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.equal(log.includes('SECRET_STDOUT_BLOB'), false);
  assert.equal(log.includes('SECRET_STDERR_BLOB'), false);
  assert.equal(log.includes('private reasoning'), false);
  assert.equal(log.includes('A'.repeat(1000)), false, 'the full owner task text must never appear in ExecutionLog.md');
}));

// ---- Part Z.15: bounded output ----------------------------------------------

test('15: ExecutionLog.md stays small/bounded even with many events', () => withTmpProject((root) => {
  const manyEvents = [];
  for (let i = 0; i < 50; i += 1) {
    manyEvents.push({ event_type: 'BACKEND_PROCESS_SPAWN', timestamp: `t${i}`, process_pid: 1000 + i, product: 'codex' });
    manyEvents.push({ event_type: 'BACKEND_PROCESS_EXIT', timestamp: `t${i}`, exit_code: 0 });
  }
  const result = materializeTaskHistory(baseSingleArgs(root, { events: manyEvents }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.ok(log.length < 20000, `ExecutionLog.md unexpectedly large: ${log.length} bytes`);
}));

// ---- extractSingleProcessEvidence (Walkthrough.md's Process/Session section) --

test('extractSingleProcessEvidence returns null when no process events exist (honest "not recorded")', () => {
  assert.equal(extractSingleProcessEvidence([]), null);
  assert.equal(extractSingleProcessEvidence(), null);
});

test('extractSingleProcessEvidence never infers native session id/reuse from PID', () => {
  const evidence = extractSingleProcessEvidence(codexEvents());
  assert.equal(evidence.processObserved, true);
  assert.equal(evidence.processPid, 4364);
  assert.equal(evidence.nativeSessionId, null);
  assert.equal(evidence.nativeSessionReuse, 'UNKNOWN');
  assert.equal(evidence.sandboxState, 'READY');
});

test('Walkthrough.md carries a Process / Session Evidence section', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { events: codexEvents() }));
  const walkthrough = readFileSync(join(root, ...result.historyPath.split('/'), 'Walkthrough.md'), 'utf8');
  assert.match(walkthrough, /# Process \/ Session Evidence/);
  assert.match(walkthrough, /process_pid: 4364/);
  assert.match(walkthrough, /sandbox: READY/);
}));

test('EXECUTION_LOG_VERSION is a stable positive integer', () => {
  assert.equal(Number.isInteger(EXECUTION_LOG_VERSION), true);
  assert.ok(EXECUTION_LOG_VERSION >= 2);
});
