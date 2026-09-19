import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { materializeTaskHistory, EXECUTION_LOG_VERSION } from '../src/runtime/repo-history-materializer.mjs';
import { buildTaskOutcome, EXECUTION_STATUS, VERIFICATION_STATUS, ARTIFACT_STATUS, LOCAL_GIT_STATUS, REMOTE_SYNC_STATUS } from '../src/pm/task-outcome-model.mjs';

// P12-R2 — the new additive artifacts (task.json, ExecutiveSummary.md,
// conditional Verification.md/Progress.md, council member Status.md).
// Every pre-existing file/path this materializer already wrote (P10) is
// re-verified unchanged by tests/p10-r02-repo-history-materializer.test.mjs
// et al. — this file proves ONLY the new P12 additions.

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p12-r2-mat-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function resolveProfile(id) { return id === 'pm-a' ? { product: 'claude-code', model: 'sonnet', session_kind: 'STATELESS' } : null; }

function baseSingleArgs(root, overrides = {}) {
  return {
    projectRoot: root, taskId: 'task-r2-single', pmRunId: 'pmrun-r2-single', projectId: 'proj-x', taskMode: 'SINGLE',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', status: 'completed',
    ownerTaskText: 'Do a single PM task', pmProfileId: 'pm-a', history: [], finalOutput: 'done', finalData: {}, resolveProfile,
    ...overrides,
  };
}

test('task.json is always written and matches the versioned schema', () => withTmpProject((root) => {
  const outcome = buildTaskOutcome({
    executionStatus: EXECUTION_STATUS.PASSED,
    artifactStatus: ARTIFACT_STATUS.MATERIALIZED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.VERIFIED,
  });
  const result = materializeTaskHistory(baseSingleArgs(root, { durability: 'DURABLE_REMOTE', outcome, resultCommit: 'a'.repeat(40) }));
  const dir = join(root, ...result.historyPath.split('/'));
  const taskJsonPath = join(dir, 'task.json');
  assert.ok(existsSync(taskJsonPath));
  const parsed = JSON.parse(readFileSync(taskJsonPath, 'utf8'));
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.task_id, 'task-r2-single');
  assert.equal(parsed.mode, 'SINGLE');
  assert.equal(parsed.durability, 'DURABLE_REMOTE');
  assert.equal(parsed.execution_status, 'EXECUTION_PASSED');
  assert.equal(parsed.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(parsed.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(parsed.result_commit, 'a'.repeat(40));
  assert.equal(parsed.terminal_marker, 'COMPLETED');
}));

test('ExecutiveSummary.md is always written, with a bounded objective/result excerpt', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { finalOutput: 'the actual PM result text' }));
  const dir = join(root, ...result.historyPath.split('/'));
  const text = readFileSync(join(dir, 'ExecutiveSummary.md'), 'utf8');
  assert.match(text, /# Executive Summary/);
  assert.match(text, /task-r2-single/);
  assert.match(text, /the actual PM result text/);
}));

test('Verification.md is NOT written when no task claims verification (the current default for every backend)', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { finalData: {} }));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.equal(existsSync(join(dir, 'Verification.md')), false);
}));

test('Verification.md IS written when finish.data.verification is populated (the additive, no-schema-change convention)', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, {
    finalData: { verification: { status: 'PASSED', summary: 'ran the test suite', details: ['42 tests passed'] } },
  }));
  const dir = join(root, ...result.historyPath.split('/'));
  const text = readFileSync(join(dir, 'Verification.md'), 'utf8');
  assert.match(text, /VERIFICATION_PASSED/);
  assert.match(text, /ran the test suite/);
  assert.match(text, /42 tests passed/);
}));

test('task-local Progress.md is NOT written for a SINGLE task with only one turn', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { history: [{ turn: 0 }] }));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.equal(existsSync(join(dir, 'Progress.md')), false);
}));

test('task-local Progress.md IS written for a SINGLE task with multiple turns', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseSingleArgs(root, { history: [{ turn: 0 }, { turn: 1 }] }));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.ok(existsSync(join(dir, 'Progress.md')));
}));

test('a re-materialization at an OLD marker version (pre-P12) is treated as stale and gains the new files', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseSingleArgs(root));
  const dir = join(root, ...first.historyPath.split('/'));
  // Simulate a marker written by the pre-P12 materializer (no task.json,
  // older execution_log_version).
  writeFileSync(join(dir, '.materialized.json'), JSON.stringify({ task_id: 'task-r2-single', pm_run_id: 'pmrun-r2-single', task_mode: 'SINGLE', materialized_at: '2026-01-01T00:01:00.000Z', folder: first.folderName, execution_log_version: 3 }));
  rmSync(join(dir, 'task.json'));
  assert.equal(existsSync(join(dir, 'task.json')), false);

  const second = materializeTaskHistory(baseSingleArgs(root));
  assert.equal(second.idempotent, false, 'a stale (old-version) marker must trigger re-materialization, not an idempotent no-op');
  assert.ok(existsSync(join(dir, 'task.json')), 'the new file must now be present after re-materialization');
}));

test('a re-materialization at the CURRENT marker version is a true idempotent no-op', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseSingleArgs(root));
  assert.equal(first.idempotent, false);
  const second = materializeTaskHistory(baseSingleArgs(root));
  assert.equal(second.idempotent, true);
  assert.equal(second.reason, 'ALREADY_MATERIALIZED');
}));

// ---- COUNCIL-specific additions ----------------------------------------

function councilTurn(turn, stepKind, participantProfileId, round, handoffExtra = {}) {
  return {
    turn, decision: { type: 'workflow', spec: { round } },
    outcome: { status: 'completed', completedAt: `2026-08-24T10:5${turn}:00.000Z`, finalResult: { handoff: { stepKind, participantProfileId, ok: true, ...handoffExtra } } },
  };
}

function baseCouncilArgs(root, overrides = {}) {
  const history = [
    councilTurn(0, 'chair_plan', 'chair-1', 0, { participant_instructions: { 'p-1': 'go', 'p-2': 'go' }, attempts: [{ attempt: 0, ok: true }] }),
    councilTurn(1, 'participant_report', 'p-1', 1, { analysis: 'a1', recommendation: 'r1' }),
    { turn: 2, decision: { type: 'workflow', spec: { round: 1 } }, outcome: { status: 'completed', completedAt: '2026-08-24T10:52:00.000Z', finalResult: { handoff: { stepKind: 'participant_report', participantProfileId: 'p-2', ok: false, reason: 'BACKEND_TIMEOUT' } } } },
    councilTurn(3, 'participant_critique', 'p-1', 2, { criticisms: [], agreements: [] }),
    { turn: 4, decision: { type: 'workflow', spec: { round: 2 } }, outcome: { status: 'completed', completedAt: '2026-08-24T10:54:00.000Z', finalResult: { handoff: { stepKind: 'participant_critique', participantProfileId: 'p-2', ok: false, reason: 'NO_REPORT_STEP_REACHED' } } } },
    councilTurn(5, 'chair_synthesis', 'chair-1', 2, { output: 'final synthesis text' }),
  ];
  return {
    projectRoot: root, taskId: 'task-r2-council', pmRunId: 'pmrun-r2-council', projectId: 'proj-x', taskMode: 'COUNCIL',
    createdAt: '2026-08-24T10:50:00.000Z', completedAt: '2026-08-24T10:55:00.000Z', status: 'completed',
    ownerTaskText: 'Council task', council: { chair_profile_id: 'chair-1', participant_profile_ids: ['p-1', 'p-2'], rounds: 2 },
    history, finalOutput: 'final synthesis text', finalData: { type: 'council', degraded: true },
    resolveProfile: (id) => (id === 'chair-1' ? { product: 'claude-code', model: 'sonnet' } : id === 'p-1' ? { product: 'codex', model: 'gpt' } : { product: 'grok', model: 'grok-4' }),
    events: [],
    ...overrides,
  };
}

test('COUNCIL gains task.json, ExecutiveSummary.md, and a Status.md per member alongside the existing Round1/Round2 files', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.ok(existsSync(join(dir, 'task.json')));
  assert.ok(existsSync(join(dir, 'ExecutiveSummary.md')));
  assert.ok(existsSync(join(dir, 'Progress.md')), 'COUNCIL always has multiple checkpoints');

  // p-1 succeeded both rounds. Folder naming is memberFolderName()'s own
  // deterministic `${product}__${model}` convention (repo-history-id.mjs) —
  // reused here as-is, not re-derived.
  assert.ok(existsSync(join(dir, 'members', 'codex__gpt', 'Round1_Report.md')));
  // p-2 failed both rounds — Status.md must exist and be truthful, never fabricating a report.
  const statusPath = join(dir, 'members', 'grok__grok-4', 'Status.md');
  assert.ok(existsSync(statusPath), 'expected a Status.md for the failed participant under its deterministic member folder');
  const statusText = readFileSync(statusPath, 'utf8');
  assert.match(statusText, /STATUS.*FAILED/is);
  assert.match(statusText, /ROUND1_REPORT_CREATED.*NO/is);

  const taskJson = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
  assert.equal(taskJson.degraded, true);
  assert.equal(taskJson.terminal_marker, 'COMPLETED_DEGRADED');
}));

test('COUNCIL now participates in version-gated re-materialization exactly like SINGLE (the old "council never re-materializes" exception is retired)', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...first.historyPath.split('/'));
  writeFileSync(join(dir, '.materialized.json'), JSON.stringify({ task_id: 'task-r2-council', pm_run_id: 'pmrun-r2-council', task_mode: 'COUNCIL', materialized_at: '2026-08-24T10:55:00.000Z', folder: first.folderName, execution_log_version: 3 }));
  const second = materializeTaskHistory(baseCouncilArgs(root));
  assert.equal(second.idempotent, false);

  const third = materializeTaskHistory(baseCouncilArgs(root));
  assert.equal(third.idempotent, true, 'once at EXECUTION_LOG_VERSION, a repeat call is a true no-op');
}));

test('EXECUTION_LOG_VERSION was bumped for this wave\'s format change (P12-R2 bumped 3->4; P19-D2 bumped again, 4->5, for the additive Debate/Round-N/** tree — see repo-history-materializer.mjs)', () => {
  assert.equal(EXECUTION_LOG_VERSION, 5);
});
