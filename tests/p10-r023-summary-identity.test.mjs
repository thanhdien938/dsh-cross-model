import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveSinglePmProfileId, finalizeTaskDiagnostics } from '../src/runtime/production-pm-worker.mjs';
import { TaskDiagnosticLog } from '../src/runtime/task-diagnostic-log.mjs';
import { buildTaskSummaryMarkdown } from '../src/runtime/task-diagnostic-summary.mjs';

// ---- Part AA.1/2/3: pm_profile_id -> displayed, Claude, Codex -----------

test('1/2: task.pmProfileId (Claude) is resolved directly', () => {
  assert.equal(resolveSinglePmProfileId({ task: { pmProfileId: 'live1-claude-pm' } }), 'live1-claude-pm');
});

test('1/3: task.pmProfileId (Codex) is resolved directly', () => {
  assert.equal(resolveSinglePmProfileId({ task: { pmProfileId: 'live1-codex-gpt-5-6-sol-pm' } }), 'live1-codex-gpt-5-6-sol-pm');
});

// ---- Part AA.4: fallback from structured pm run field ---------------------

test('4a: falls back to run.pmProfileId when task is unavailable', () => {
  assert.equal(resolveSinglePmProfileId({ task: null, run: { pmProfileId: 'live1-opencode-pm' } }), 'live1-opencode-pm');
});

test('4b: falls back to result.driver (structured, canonical DSH format) when neither task nor run carries it', () => {
  assert.equal(resolveSinglePmProfileId({ task: null, run: null, result: { driver: 'production:codex:live1-codex-gpt-5-6-sol-pm' } }), 'live1-codex-gpt-5-6-sol-pm');
  assert.equal(resolveSinglePmProfileId({ result: { driver: 'scripted:live1-fake-pm' } }), 'live1-fake-pm');
});

test('priority order: task.pmProfileId wins over run.pmProfileId, which wins over result.driver', () => {
  const args = { task: { pmProfileId: 'from-task' }, run: { pmProfileId: 'from-run' }, result: { driver: 'production:codex:from-driver' } };
  assert.equal(resolveSinglePmProfileId(args), 'from-task');
  assert.equal(resolveSinglePmProfileId({ ...args, task: null }), 'from-run');
  assert.equal(resolveSinglePmProfileId({ ...args, task: null, run: null }), 'from-driver');
});

// ---- Part AA.5: UNKNOWN only when no identity exists -----------------------

test('5: resolves to null (renders UNKNOWN) only when no evidence exists at all', () => {
  assert.equal(resolveSinglePmProfileId({}), null);
  assert.equal(resolveSinglePmProfileId({ task: {}, run: {}, result: {} }), null);
  assert.equal(resolveSinglePmProfileId({ task: { pmProfileId: '' }, result: { driver: 'not-a-canonical-string' } }), null);
});

// ---- Part AA.7: no profile parsing from arbitrary prose --------------------

test('7: a non-canonical driver string never gets parsed into a fabricated profile id', () => {
  assert.equal(resolveSinglePmProfileId({ result: { driver: 'the codex process for live1-codex-gpt-5-6-sol-pm ran fine' } }), null);
  assert.equal(resolveSinglePmProfileId({ result: { driver: 'production' } }), null);
});

// ---- end-to-end: finalizeTaskDiagnostics -> summary.md's "## PM" section --

function withTmpDiagnostics(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r023-summary-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('finalizeTaskDiagnostics: SINGLE summary.md shows the real profile id, never UNKNOWN, when task.pmProfileId is known (T3-like)', () => withTmpDiagnostics((dir) => {
  const taskLog = new TaskDiagnosticLog({ runtimeRoot: dir, taskId: 'task-t3', projectId: 'dsh-p6-test-b', pmRunId: 'pmrun-t3', taskMode: 'SINGLE' });
  const result = { history: [{ turn: 0, decision: { type: 'finish' }, outcome: { status: 'completed' } }], data: null, output: 'ok', status: 'completed', startedAt: 't0', completedAt: 't1', driver: 'production:codex:live1-codex-gpt-5-6-sol-pm' };
  finalizeTaskDiagnostics({ taskLog, taskId: 'task-t3', projectId: 'dsh-p6-test-b', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', council: null, result, pmProfileId: 'live1-codex-gpt-5-6-sol-pm' });
  const summary = readFileSync(join(taskLog.dir, 'summary.md'), 'utf8');
  assert.match(summary, /## PM\n- profile: live1-codex-gpt-5-6-sol-pm/);
  assert.equal(summary.includes('profile: UNKNOWN'), false);
}));

test('finalizeTaskDiagnostics: SINGLE summary.md falls back to UNKNOWN honestly when truly no identity is available', () => withTmpDiagnostics((dir) => {
  const taskLog = new TaskDiagnosticLog({ runtimeRoot: dir, taskId: 'task-x', projectId: 'p', pmRunId: 'r', taskMode: 'SINGLE' });
  const result = { history: [], data: null, output: '', status: 'completed', startedAt: 't0', completedAt: 't1' };
  finalizeTaskDiagnostics({ taskLog, taskId: 'task-x', projectId: 'p', taskMode: 'SINGLE', submittedVia: 'TELEGRAM', council: null, result });
  const summary = readFileSync(join(taskLog.dir, 'summary.md'), 'utf8');
  assert.match(summary, /## PM\n- profile: UNKNOWN/);
}));

// ---- Part AA.6: council summary unchanged ----------------------------------

test('6: COUNCIL summary.md is completely unaffected — still uses council.chair_profile_id directly', () => withTmpDiagnostics((dir) => {
  const taskLog = new TaskDiagnosticLog({ runtimeRoot: dir, taskId: 'task-council', projectId: 'p', pmRunId: 'r', taskMode: 'COUNCIL' });
  const council = { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['a', 'b'], rounds: 2 };
  const result = { history: [], data: { degraded: false }, output: 'synth', status: 'completed', startedAt: 't0', completedAt: 't1', driver: 'council:live1-claude-pm' };
  // `pmProfileId` is intentionally passed here too (as the real call site
  // always computes it) but must have ZERO effect on the council branch.
  finalizeTaskDiagnostics({ taskLog, taskId: 'task-council', projectId: 'p', taskMode: 'COUNCIL', submittedVia: 'TELEGRAM', council, result, pmProfileId: 'should-be-ignored-for-council' });
  const summary = readFileSync(join(taskLog.dir, 'summary.md'), 'utf8');
  assert.match(summary, /## PM \/ Chair\n- profile: live1-claude-pm/);
  assert.equal(summary.includes('should-be-ignored-for-council'), false);
}));

// ---- pure builder regression: buildTaskSummaryMarkdown's own param is unrenamed ----

test('buildTaskSummaryMarkdown itself is unchanged — chairProfileId param still drives the ## PM section for SINGLE', () => {
  const md = buildTaskSummaryMarkdown({ taskId: 't', status: 'completed', taskMode: 'SINGLE', chairProfileId: 'live1-claude-pm' });
  assert.match(md, /## PM\n- profile: live1-claude-pm/);
});
