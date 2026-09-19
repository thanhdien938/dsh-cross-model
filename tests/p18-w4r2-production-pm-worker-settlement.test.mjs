import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { prepareTaskBranch } from '../src/pm/task-branch-binding.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';

// P18-W4R2 / P24.1G7A — the corrected settlement order end-to-end, through
// the REAL ProductionPmWorkHandler.execute(), against a REAL local git
// fixture (a local bare repo standing in for "origin", never a network/
// GitHub remote): verify bound branch -> materialize history (no self-
// referential SHA yet) -> ONE result commit carrying both the code change
// and the materialized history -> verify worktree clean -> push the EXACT
// bound branch -> independently verify the remote head equals that one
// commit. Single-final-settlement (reports/
// P24_1G7_SINGLE_SETTLEMENT_GIT_WORKFLOW_AUDIT_20260916.md) replaced the
// former two-commit (A=code, B=materialization) sequence with exactly one.

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initWorktreeWithBareRemote(root) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', 'main']);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', 'main']);
  git(workDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', 'main']);
  return { bareDir, workDir };
}

async function withHandlerFixture(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p18-w4r2-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p18-w4r2-git-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'p18-w4r2-logs-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const pmRepository = new PmRepository({ store });
    const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
    await fn({ pmRepository, workDir, bareDir, logRoot });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
}

function buildHandler({ pmRepository, project, taskRepositoryContext, logRoot, enableRepoHistoryMaterialization = true, interactionsCreated = [] }) {
  const ownerRepository = { createInteraction: async (v) => { interactionsCreated.push(v); return v; } };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'pm-1', context: taskRepositoryContext } : null) };
  const createRuntime = () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  const coordinationStore = { completeClaim: async () => {} };
  const taskDiagnosticsFactory = logRoot ? createTaskDiagnosticLogFactory({ runtimeRoot: logRoot }) : null;
  return new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, enableRepoHistoryMaterialization });
}

test('P24.1G7A full task-branch-bound settlement: materialize history -> ONE result commit (code + history) -> worktree clean -> push exact bound branch -> remote verified (Telegram origin)', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const commandId = 'cmd-w4r2-settlement';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, projectId: 'proj-w4r2', taskMode: 'SINGLE' });
  const baseSha = binding.base_sha;
  // Simulate the backend's own real edit, made on the now-checked-out
  // bound task branch (exactly as a real PM backend turn would leave it).
  writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n');

  const project = { id: 'proj-w4r2', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({
    objective: 'do the thing',
    context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DURABLE_LOCAL', git: { commit: true, push: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-w4r2', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, taskRepositoryContext: { durability: 'DURABLE_LOCAL', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const work = { pm_run_id: 'pmrun-w4r2', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-w4r2' }).action_id };

  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED', 'Telegram origin succeeds for its OWN bound task branch');

  // ---- P24.1G7A: exactly ONE result commit on the task branch, carrying
  // BOTH the code change AND the materialized history (there is no second
  // "materialization" commit any more) ----
  const log = git(workDir, ['log', '--format=%H %s', `${baseSha}..${binding.task_branch}`]).trim().split('\n');
  assert.equal(log.length, 1, `expected exactly 1 commit ahead of base, got:\n${log.join('\n')}`);
  const [rLine] = log;
  const [shaR] = rLine.split(' ');
  assert.match(rLine, new RegExp(`DSH: single task ${taskId} result`));
  assert.match(rLine, new RegExp(`DSH-Task-Id: ${taskId}`), 'the one result commit carries the task identity trailer (recovery evidence)');

  // ---- the materialized history is present in the SAME one commit, and
  // (since it was necessarily written BEFORE the commit even existed —
  // there is no self-referential SHA to embed any more for the in-repo
  // legacy destination) omits its own result-commit SHA rather than
  // inventing/guessing one ----
  const rTreeFull = git(workDir, ['ls-tree', '-r', '--name-only', shaR]).trim().split('\n');
  const historyFile = rTreeFull.find((f) => f.startsWith('docs/history/single/') && f.endsWith('ExecutiveSummary.md'));
  assert.ok(historyFile, 'materialized ExecutiveSummary.md must be present in the one result commit');
  assert.ok(rTreeFull.includes('CHANGE.md'), 'the one result commit carries the code change');
  assert.ok(rTreeFull.some((f) => f.startsWith('docs/history/single/')), 'the one result commit carries the materialized history');

  // ---- worktree clean after full settlement ----
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '');
  // P22.6: the worktree must have returned to its ORIGINAL (pre-task-branch)
  // checkout — the home branch `prepareTaskBranch()` captured — not remain
  // on the bound task branch.
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.original_checkout);
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED');
  assert.equal(outcome.result.branchRestore?.branch, binding.original_checkout);

  // ---- the one result commit is independently verifiable on the remote, under the EXACT bound branch ----
  const remoteLine = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim();
  const [remoteSha] = remoteLine.split(/\s+/);
  assert.equal(remoteSha, shaR);

  // ---- base branch on the remote is completely untouched ----
  const remoteMain = git(workDir, ['ls-remote', bareDir, 'main']).trim().split(/\s+/)[0];
  assert.equal(remoteMain, baseSha);
}));

test('materialization produces no diff (no docs/history write): B equals A, never an invented second commit', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-w4r2-noop-materialization';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n');

  const project = { id: 'proj-w4r2b', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-w4r2b', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  // durability: DIRECT -> materialization never even runs (P12-R2 default),
  // so no second commit should ever be attempted.
  const handler = buildHandler({ pmRepository, project, logRoot, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const work = { pm_run_id: 'pmrun-w4r2b', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-w4r2b' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const log = git(workDir, ['log', '--format=%H', `${binding.base_sha}..${binding.task_branch}`]).trim().split('\n');
  assert.equal(log.length, 1, 'exactly one commit — no invented second commit');
}));

test('executor-changed checkout is caught fail-closed BEFORE execution — the whole run settles FAILED, nothing is committed or pushed', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const commandId = 'cmd-w4r2-violation';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  // Simulate a foreign process (another task, or the executor itself)
  // leaving a DIFFERENT branch checked out before this handler ever runs.
  git(workDir, ['checkout', '-q', '-b', 'dsh/task-someone-elses-task']);

  const project = { id: 'proj-w4r2c', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-w4r2c', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const work = { pm_run_id: 'pmrun-w4r2c', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-w4r2c' }).action_id };

  const outcome = await handler.execute({ work, fence: {} });
  assert.equal(outcome.status, 'FAILURE_SETTLED');
  assert.equal(outcome.code, 'TASK_BRANCH_BINDING_VIOLATION');

  // Nothing was ever pushed to either branch.
  const remoteTaskBranch = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim();
  assert.equal(remoteTaskBranch, '', 'the bound task branch was never pushed');
}));

test('a task cannot publish another task\'s branch — a foreign binding is refused at push time, never silently redirected', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const commandId = 'cmd-w4r2-foreign';
  const taskId = deterministicOwnerId('task', commandId);
  const realBinding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n');
  // A corrupted/foreign binding: same task branch checked out locally, but
  // claims a DIFFERENT task_branch name than what's actually bound.
  const foreignBinding = { ...realBinding, task_branch: 'dsh/task-a-totally-different-task' };

  const project = { id: 'proj-w4r2d', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-w4r2d', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: foreignBinding } });
  const work = { pm_run_id: 'pmrun-w4r2d', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-w4r2d' }).action_id };

  const outcome = await handler.execute({ work, fence: {} });
  // The PRE_EXECUTION verify already refuses (actual checkout != foreignBinding.task_branch).
  assert.equal(outcome.status, 'FAILURE_SETTLED');
  assert.equal(outcome.code, 'TASK_BRANCH_BINDING_VIOLATION');
  assert.equal(git(workDir, ['ls-remote', bareDir, 'dsh/task-a-totally-different-task']).trim(), '');
}));

test('next task does not sweep the previous task\'s artifacts — each task settles on its own bound branch', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const commandId1 = 'cmd-w4r2-first';
  const taskId1 = deterministicOwnerId('task', commandId1);
  const binding1 = await prepareTaskBranch({ projectRepoPath: workDir, taskId: taskId1, taskMode: 'SINGLE' });
  writeFileSync(join(workDir, 'FIRST.md'), 'first task work\n');
  const project1 = { id: 'proj-w4r2e', repo_path: workDir, taskId: taskId1, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'first', context: { ownerCommandId: commandId1, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-w4r2e', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler1 = buildHandler({ pmRepository, project: project1, logRoot, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding1 } });
  const outcome1 = await handler1.execute({ work: { pm_run_id: 'pmrun-w4r2e', action_id: pmWorkIdentity({ taskId: taskId1, pmRunId: 'pmrun-w4r2e' }).action_id }, fence: {} });
  assert.equal(outcome1.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');

  // Back to the original base branch before preparing the second task —
  // exactly what OwnerTaskController.submit() does for each new task.
  git(workDir, ['checkout', '-q', binding1.original_checkout]);
  const commandId2 = 'cmd-w4r2-second';
  const taskId2 = deterministicOwnerId('task', commandId2);
  const binding2 = await prepareTaskBranch({ projectRepoPath: workDir, taskId: taskId2, taskMode: 'SINGLE' });
  writeFileSync(join(workDir, 'SECOND.md'), 'second task work\n');
  const project2 = { id: 'proj-w4r2e', repo_path: workDir, taskId: taskId2, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'second', context: { ownerCommandId: commandId2, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-w4r2f', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler2 = buildHandler({ pmRepository, project: project2, logRoot, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding2 } });
  const outcome2 = await handler2.execute({ work: { pm_run_id: 'pmrun-w4r2f', action_id: pmWorkIdentity({ taskId: taskId2, pmRunId: 'pmrun-w4r2f' }).action_id }, fence: {} });
  assert.equal(outcome2.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');

  // The second task's branch carries ONLY its own file — never the first task's.
  const secondTree = git(workDir, ['ls-tree', '-r', '--name-only', binding2.task_branch]).trim();
  assert.ok(secondTree.includes('SECOND.md'));
  assert.ok(!secondTree.includes('FIRST.md'), 'the second task branch never swept in the first task\'s artifact');
  // The first task's own branch is untouched and still carries its own file.
  const firstTree = git(workDir, ['ls-tree', '-r', '--name-only', binding1.task_branch]).trim();
  assert.ok(firstTree.includes('FIRST.md'));
  assert.ok(!firstTree.includes('SECOND.md'));
}));
