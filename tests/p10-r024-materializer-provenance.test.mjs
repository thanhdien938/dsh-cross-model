import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { materializeTaskHistory } from '../src/runtime/repo-history-materializer.mjs';
import { extractTaskSourceAndRuntimeClass } from '../src/runtime/repo-history-extract.mjs';

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r024-mat-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PROFILES = { 'live1-codex-gpt-5-6-sol-pm': { product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', transport: 'stdio' } };
const resolveProfile = (id) => PROFILES[id] ?? null;

function singleTurn() { return [{ turn: 0, decision: { type: 'finish' }, outcome: { status: 'completed', completedAt: '2026-08-25T00:10:00.000Z' } }]; }

function baseArgs(root, overrides = {}) {
  return {
    projectRoot: root, taskId: 'task-r024matL0ngProvenanceZZZZZZZZZ01', pmRunId: 'pmrun-r024matL0ngProvenanceZZZZZZZZZ01',
    projectId: 'dsh-p6-test-b', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', commandId: 'tg-long-1',
    createdAt: '2026-08-25T00:08:00.000Z', completedAt: '2026-08-25T00:10:00.000Z', status: 'completed',
    ownerTaskText: 'resolved long task text', pmProfileId: 'live1-codex-gpt-5-6-sol-pm', history: singleTurn(),
    finalOutput: 'done', finalData: null, resolveProfile, events: [], ...overrides,
  };
}

function longTaskEvents() {
  return [
    { event_type: 'TASK_ACCEPTED', pm_profile_id: 'live1-codex-gpt-5-6-sol-pm', runtime_class: 'LONG' },
    { event_type: 'TASK_SOURCE_RESOLVED', type: 'GIT_FILE', requested_ref: 'ff134b8', resolved_commit_sha: '0'.repeat(40), path: 'tasks/dsh/P10-R0.2.4_LONG_TASK_DISPATCH_CANARY.md', content_sha256: '1'.repeat(64), content_bytes: 512 },
    { event_type: 'LONG_TASK_RUNTIME_STARTED', runtime_class: 'LONG', hard_deadline_ms: 1_800_000 },
    { event_type: 'BACKEND_PROCESS_SPAWN', timestamp: '2026-08-25T00:08:01.000Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', process_pid: 5555 },
    { event_type: 'BACKEND_LIVENESS_STATE', timestamp: '2026-08-25T00:08:02.000Z', from: null, to: 'ACTIVE' },
    { event_type: 'BACKEND_LIVENESS_STATE', timestamp: '2026-08-25T00:09:30.000Z', from: 'ACTIVE', to: 'QUIET_RUNNING' },
    { event_type: 'BACKEND_PROCESS_EXIT', timestamp: '2026-08-25T00:09:59.900Z', profile_id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', exit_code: 0 },
  ];
}

test('extractTaskSourceAndRuntimeClass reads GIT_FILE provenance and LONG runtime class from events', () => {
  const { taskSource, runtimeClass, hardDeadlineMs } = extractTaskSourceAndRuntimeClass(longTaskEvents());
  assert.equal(runtimeClass, 'LONG');
  assert.equal(hardDeadlineMs, 1_800_000);
  assert.equal(taskSource.requestedRef, 'ff134b8');
  assert.equal(taskSource.resolvedCommitSha, '0'.repeat(40));
  assert.equal(taskSource.path, 'tasks/dsh/P10-R0.2.4_LONG_TASK_DISPATCH_CANARY.md');
});

test('a NORMAL task (no task-source events) reports runtimeClass NORMAL and taskSource null', () => {
  const { taskSource, runtimeClass } = extractTaskSourceAndRuntimeClass([{ event_type: 'TASK_ACCEPTED' }, { event_type: 'BACKEND_PROCESS_SPAWN' }]);
  assert.equal(runtimeClass, 'NORMAL');
  assert.equal(taskSource, null);
});

test('Task.md for a LONG task carries the "## Task source" section and runtime class', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseArgs(root, { events: longTaskEvents() }));
  const taskMd = readFileSync(join(root, ...result.historyPath.split('/'), 'Task.md'), 'utf8');
  assert.match(taskMd, /runtime class: LONG/);
  assert.match(taskMd, /## Task source/);
  assert.match(taskMd, /requested_ref: ff134b8/);
  assert.match(taskMd, new RegExp(`resolved_commit_sha: ${'0'.repeat(40)}`));
  assert.match(taskMd, /path: tasks\/dsh\/P10-R0\.2\.4_LONG_TASK_DISPATCH_CANARY\.md/);
}));

test('Task.md for a NORMAL task shows runtime class NORMAL and no Task source section', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseArgs(root, { taskId: 'task-r024matNormalZZZZZZZZZZZZZZZZZZ01', pmRunId: 'pmrun-r024matNormalZZZZZZZZZZZZZZZZZZ01', events: [{ event_type: 'TASK_ACCEPTED' }] }));
  const taskMd = readFileSync(join(root, ...result.historyPath.split('/'), 'Task.md'), 'utf8');
  assert.match(taskMd, /runtime class: NORMAL/);
  assert.equal(taskMd.includes('## Task source'), false);
}));

test('ExecutionLog.md for a LONG task shows the LONG_TASK_RUNTIME summary and last liveness state (no per-chunk spam)', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseArgs(root, { taskId: 'task-r024matExecLogZZZZZZZZZZZZZZZZZZ01', pmRunId: 'pmrun-r024matExecLogZZZZZZZZZZZZZZZZZZ01', events: longTaskEvents() }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /LONG_TASK_RUNTIME/);
  assert.match(log, /hard_deadline_ms: 1800000/);
  // Only the LAST liveness state is summarized — not every intermediate transition line-by-line.
  assert.match(log, /last_liveness_state: QUIET_RUNNING/);
  assert.equal((log.match(/BACKEND_LIVENESS_STATE/g) ?? []).length, 0);
}));

test('ExecutionLog.md for a LONG task that hit the hard deadline records HARD_DEADLINE_REACHED', () => withTmpProject((root) => {
  const events = [...longTaskEvents(), { event_type: 'HARD_DEADLINE_REACHED', timestamp: '2026-08-25T00:38:00.000Z', configured_ms: 1_800_000, elapsed_ms: 1_800_002, process_pid: 5555, termination_requested: true }];
  const result = materializeTaskHistory(baseArgs(root, { taskId: 'task-r024matHardDeadlineZZZZZZZZZZZ01', pmRunId: 'pmrun-r024matHardDeadlineZZZZZZZZZZZ01', status: 'failed', events }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.match(log, /HARD_DEADLINE_REACHED/);
  assert.match(log, /elapsed_ms: 1800002/);
  assert.match(log, /hard_deadline_reached: true/);
}));

test('ExecutionLog.md for a NORMAL task has no LONG_TASK_RUNTIME section (regression)', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseArgs(root, { taskId: 'task-r024matNoLongSectionZZZZZZZZZZZ01', pmRunId: 'pmrun-r024matNoLongSectionZZZZZZZZZZZ01', events: [{ event_type: 'TASK_ACCEPTED' }] }));
  const log = readFileSync(join(root, ...result.historyPath.split('/'), 'ExecutionLog.md'), 'utf8');
  assert.equal(log.includes('LONG_TASK_RUNTIME'), false);
}));
