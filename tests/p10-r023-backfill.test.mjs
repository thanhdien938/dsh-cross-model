import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { materializeTaskHistory } from '../src/runtime/repo-history-materializer.mjs';

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r023-backfill-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PROFILES = {
  'live1-claude-pm': { product: 'claude-code', model: 'sonnet', reasoning: 'high', session_kind: 'STATELESS', transport: 'stdio' },
  'live1-codex-gpt-5-6-sol-pm': { product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', transport: 'stdio' },
};
const resolveProfile = (id) => PROFILES[id] ?? null;

// Fixtures mirroring the REAL owner-live T2/T3 durable shape exactly (task
// ids, pm_run ids, PIDs, timestamps — see docs/p10/09_PORTABLE_SINGLE_
// PROCESS_EVIDENCE_SONNET5.md for the live evidence this was captured
// from).
function t2Args(root, overrides = {}) {
  return {
    projectRoot: root, taskId: 'task-1alISjgrMqS0xj_-ctGwaD2BhfzaOGhv', pmRunId: 'pmrun-1alISjgrMqS0xj_-ctGwaD2BhfzaOGhv',
    projectId: 'dsh-p6-test-b', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', commandId: 'tg-YlCgZ-38I1SRbL1iFRFH4H-kssV26Nhx',
    createdAt: '2026-08-24T13:10:10.141Z', completedAt: '2026-08-24T13:12:05.062Z', status: 'completed',
    ownerTaskText: 'P10 SESSION TEST T2 — REPOSITORY CONTEXT RECOVERY.', pmProfileId: 'live1-claude-pm',
    history: [{ turn: 0, decision: { type: 'finish' }, outcome: { status: 'completed', completedAt: '2026-08-24T13:12:05.062Z' } }],
    finalOutput: 'T2 recovered T1 context from repository history.', finalData: null, resolveProfile, events: [], ...overrides,
  };
}
function t2Events() {
  return [
    { event_type: 'TASK_ACCEPTED', pm_profile_id: 'live1-claude-pm', client_kind: 'TELEGRAM' },
    { event_type: 'PM_RUN_CREATED', driver: 'production:claude-code:live1-claude-pm' },
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: '2026-08-24T13:10:10.607Z', profile_id: 'live1-claude-pm', product: 'claude-code', process_pid: 42764 },
    { event_type: 'BACKEND_PROCESS_EXIT', timestamp: '2026-08-24T13:12:05.060Z', profile_id: 'live1-claude-pm', product: 'claude-code', exit_code: 0 },
    { event_type: 'TASK_COMPLETED' },
    { event_type: 'HANDOFF_MATERIALIZATION_START' },
    { event_type: 'HANDOFF_MATERIALIZATION_COMPLETED', history_path: 'docs/history/single/20260824T131010Z__1alISjgr__p10_session_test_t2_repository_context_recovery', idempotent: false },
  ];
}

function t3Args(root, overrides = {}) {
  return {
    projectRoot: root, taskId: 'task-yadbWFjx_zv8UYxKP1Q-9eNGkqUieVRU', pmRunId: 'pmrun-yadbWFjx_zv8UYxKP1Q-9eNGkqUieVRU',
    projectId: 'dsh-p6-test-b', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', commandId: 'tg-nS2QzMfmcdN3J4Ye4-EGDJ4bEQOY2Y6w',
    createdAt: '2026-08-24T14:36:42.372Z', completedAt: '2026-08-24T14:38:05.658Z', status: 'completed',
    ownerTaskText: 'P10 SESSION TEST T3 — CROSS-BACKEND REPOSITORY CONTEXT RECOVERY.', pmProfileId: 'live1-codex-gpt-5-6-sol-pm',
    history: [{ turn: 0, decision: { type: 'finish' }, outcome: { status: 'completed', completedAt: '2026-08-24T14:38:05.658Z' } }],
    finalOutput: 'T3 recovered T1/T2 context across backends.', finalData: null, resolveProfile, events: [], ...overrides,
  };
}
function t3Events() {
  return [
    { event_type: 'TASK_ACCEPTED', pm_profile_id: 'live1-codex-gpt-5-6-sol-pm', client_kind: 'TELEGRAM' },
    { event_type: 'PM_RUN_CREATED', driver: 'production:codex:live1-codex-gpt-5-6-sol-pm' },
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: '2026-08-24T14:36:42.648Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', process_pid: 4364 },
    { event_type: 'BACKEND_PROCESS_EXIT', timestamp: '2026-08-24T14:38:05.642Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', exit_code: 0 },
    { event_type: 'CODEX_SANDBOX_STATE', timestamp: '2026-08-24T14:38:05.656Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', stage: 'single_pm', sandbox_state: 'READY', sandbox_failure_code: null, helper_resolution: 'FOUND', helper_execution: 'OK' },
    { event_type: 'TASK_COMPLETED' },
    { event_type: 'HANDOFF_MATERIALIZATION_START' },
    { event_type: 'HANDOFF_MATERIALIZATION_COMPLETED', history_path: 'docs/history/single/20260824T143642Z__yadbWFjx__p10_session_test_t3_cross_backend_repository', idempotent: false },
  ];
}

// P10-R0.2.3 Part AB — simulates the exact backfill scenario: a task was
// ORIGINALLY materialized under the OLD (pre-R0.2.3) code, whose
// `.materialized.json` marker carried no `execution_log_version` field at
// all (that field is new this wave) — simulated here by stripping it after
// the first call — then re-materialized via the SAME materializeTaskHistory()
// call (scripts/p10-r02-backfill-task.mjs, unmodified) once real events are
// available, exactly matching how the marker-version staleness check
// (Part X/Y) triggers a real re-run.
function stripExecutionLogVersion(root, historyPath) {
  const markerPath = join(root, ...historyPath.split('/'), '.materialized.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  delete marker.execution_log_version;
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

test('T2 backfill: PID 42764 is projected, folder/task result are unchanged, no duplicate folder', () => withTmpProject((root) => {
  const original = materializeTaskHistory(t2Args(root, { events: [] }));
  const originalTaskMd = readFileSync(join(root, ...original.historyPath.split('/'), 'Task.md'), 'utf8');
  const originalPlanMd = readFileSync(join(root, ...original.historyPath.split('/'), 'Plan.md'), 'utf8');
  stripExecutionLogVersion(root, original.historyPath);

  const backfilled = materializeTaskHistory(t2Args(root, { events: t2Events() }));

  assert.equal(backfilled.historyPath, original.historyPath, 'backfill must land in the SAME task folder, never a duplicate');
  assert.equal(backfilled.idempotent, false, 'a version-stale re-materialization is a real rewrite, not a no-op');
  const singleDirs = readdirSync(join(root, 'docs', 'history', 'single'));
  assert.equal(singleDirs.length, 1, 'exactly one T2 folder must exist -- no duplicate');

  const log = readFileSync(join(root, ...backfilled.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /process_pid: 42764/);
  assert.match(log, /profile_id: live1-claude-pm/);
  assert.match(log, /product: claude-code/);

  // Part N: task result/content is NOT altered by backfill.
  const backfilledTaskMd = readFileSync(join(root, ...backfilled.historyPath.split('/'), 'Task.md'), 'utf8');
  const backfilledPlanMd = readFileSync(join(root, ...backfilled.historyPath.split('/'), 'Plan.md'), 'utf8');
  assert.equal(backfilledTaskMd, originalTaskMd, 'Task.md content must be byte-identical (same durable inputs)');
  assert.equal(backfilledPlanMd, originalPlanMd, 'Plan.md content must be byte-identical (same durable inputs)');
}));

test('T3 backfill: PID 4364 + sandbox READY/FOUND/OK projected, folder/task result unchanged, no duplicate folder', () => withTmpProject((root) => {
  const original = materializeTaskHistory(t3Args(root, { events: [] }));
  const originalTaskMd = readFileSync(join(root, ...original.historyPath.split('/'), 'Task.md'), 'utf8');
  stripExecutionLogVersion(root, original.historyPath);

  const backfilled = materializeTaskHistory(t3Args(root, { events: t3Events() }));

  assert.equal(backfilled.historyPath, original.historyPath);
  const singleDirs = readdirSync(join(root, 'docs', 'history', 'single'));
  assert.equal(singleDirs.length, 1);

  const log = readFileSync(join(root, ...backfilled.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /process_pid: 4364/);
  assert.match(log, /## CODEX SANDBOX[\s\S]*?state: READY/);
  assert.match(log, /helper_resolution: FOUND/);
  assert.match(log, /helper_execution: OK/);

  const backfilledTaskMd = readFileSync(join(root, ...backfilled.historyPath.split('/'), 'Task.md'), 'utf8');
  assert.equal(backfilledTaskMd, originalTaskMd, 'Task.md content must be byte-identical (same durable inputs)');
}));

test('backfill for BOTH T2 and T3 in the same project root never cross-contaminates progress.md (exactly one line each)', () => withTmpProject((root) => {
  materializeTaskHistory(t2Args(root, { events: t2Events() }));
  materializeTaskHistory(t3Args(root, { events: t3Events() }));
  // Re-run both again (the actual backfill re-run scenario) -- must not
  // append a second progress.md line for either task (Part AF).
  materializeTaskHistory(t2Args(root, { events: t2Events() }));
  materializeTaskHistory(t3Args(root, { events: t3Events() }));
  const progress = readFileSync(join(root, 'progress.md'), 'utf8');
  const t2Lines = progress.split('\n').filter((l) => l.includes('| task-1alISjgrMqS0xj_-ctGwaD2BhfzaOGhv |'));
  const t3Lines = progress.split('\n').filter((l) => l.includes('| task-yadbWFjx_zv8UYxKP1Q-9eNGkqUieVRU |'));
  assert.equal(t2Lines.length, 1);
  assert.equal(t3Lines.length, 1);
}));

test('a backfill re-run at the SAME (current) version is a true no-op the second time', () => withTmpProject((root) => {
  materializeTaskHistory(t3Args(root, { events: t3Events() }));
  const again = materializeTaskHistory(t3Args(root, { events: t3Events() }));
  assert.equal(again.idempotent, true);
}));
