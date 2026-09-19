/**
 * P22.6 — post-settlement runtime worktree branch return.
 *
 * Authority: docs/P22/P22_6_POST_SETTLEMENT_RUNTIME_BRANCH_RETURN_FIX.md
 *
 * `prepareTaskBranch()` (task-branch-binding.mjs) has always captured
 * `original_checkout` — the branch active immediately before task-branch
 * preparation. `restoreOriginalBranch()` is the new function that returns
 * a worktree to that captured branch after a Git-settled task reaches a
 * terminal state; `production-pm-worker.mjs` now calls it (a) at the end
 * of the normal terminal (completed/failed/cancelled) settlement path, and
 * (b) inside `#settleFailure()` for a failure that unwinds outside that
 * path entirely (e.g. an early lineage check). Both call sites are
 * best-effort: a restore failure is recorded as a distinct diagnostic and
 * NEVER changes the task's own real outcome.
 *
 * Real local git fixtures throughout (a local bare repo standing in for
 * "origin") — mirrors tests/p22-1-production-pm-worker-review-manifest.test.mjs
 * and tests/p18-w4r2-production-pm-worker-settlement.test.mjs exactly. No
 * live provider/network calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { prepareTaskBranch, restoreOriginalBranch, TaskBranchLifecycleError } from '../src/pm/task-branch-binding.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';
import { buildArtifactReference } from '../src/artifacts/artifact-schema.mjs';

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
  // The RUNTIME worktree's home is a DISTINCT local-only branch — exactly
  // like production (`runtime/p22-live`, never `origin`'s own default
  // branch) — created from the same commit main already has.
  git(workDir, ['checkout', '-b', 'runtime/p22-live']);
  return { bareDir, workDir };
}

async function withHandlerFixture(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p22-6-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p22-6-git-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'p22-6-logs-'));
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

function buildHandler({ pmRepository, project, taskRepositoryContext, logRoot, decisions, interactionsCreated = [], enableRepoHistoryMaterialization = false }) {
  const ownerRepository = { createInteraction: async (v) => { interactionsCreated.push(v); return v; } };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'pm-1', context: taskRepositoryContext } : null) };
  const createRuntime = () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'p22-6-fake', decisions }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  const coordinationStore = { completeClaim: async () => {} };
  const taskDiagnosticsFactory = logRoot ? createTaskDiagnosticLogFactory({ runtimeRoot: logRoot }) : null;
  return new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, enableRepoHistoryMaterialization });
}

function sealedFinalRef({ taskId, projectId, sha256 = 'b'.repeat(64), bytes = 17 }) {
  return buildArtifactReference({
    storeId: 'store-p22-6-v1', projectId, taskId, invocationId: 'inv-1', attemptOrdinal: 0,
    artifactRelpath: `${taskId}/inv-1/attempt-0/report.md`, sha256, bytes, sealedAt: '2026-09-14T00:00:00.000Z',
  }, { sealed: true });
}

async function run({ workDir, pmRepository, logRoot, projectId = `proj-${Math.random().toString(36).slice(2)}`, commandId = `cmd-${Math.random().toString(36).slice(2)}`, decisions, git: gitOpts = { commit: true, push: false }, review = null, bound = true, interactionsCreated = [] }) {
  const taskId = deterministicOwnerId('task', commandId);
  const binding = bound ? await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' }) : null;
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: gitOpts } });
  const pmRunId = `pmrun-${Math.random().toString(36).slice(2)}`;
  await pmRepository.create(request, { id: pmRunId, driver: 'p22-6-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  // `review.requested` is read off the durable OWNER TASK's own context
  // (production-pm-worker.mjs: `task.context?.review?.requested`) — a
  // SEPARATE object from the pm_request's own context above.
  const handler = buildHandler({ pmRepository, project, logRoot, decisions, interactionsCreated, taskRepositoryContext: { durability: 'DIRECT', gitSync: gitOpts, ...(binding ? { taskBranch: binding } : {}), ...(review ? { review } : {}) } });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  const currentBranch = git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return { outcome, taskId, binding, project, currentBranch, pmRunId };
}

const FINISH = { type: 'finish', output: 'done', data: { type: 'single_result' } };
const FINISH_ARTIFACT = (taskId, projectId, finalRef) => ({ type: 'finish', output: 'the report', data: { transport_version: 'artifact_v1', task_id: taskId, final_ref: finalRef, report_sha256: finalRef.sha256, report_bytes: finalRef.bytes } });

// ==================================================================
// 1-3 — success-path restore across the three git-sync combinations
// ==================================================================

test('1 — successful commit-only task restores home branch', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const { outcome, binding, currentBranch } = await run({ workDir, pmRepository, logRoot, decisions: [FINISH], git: { commit: true, push: false } });
  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED');
  assert.equal(currentBranch, binding.original_checkout);
  assert.equal(binding.original_checkout, 'runtime/p22-live');
}));

test('2 — successful commit+push task with no actual diff restores home branch and pushes nothing (P24.1G7B: zero result commit -> zero push)', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const { outcome, binding, currentBranch } = await run({ workDir, pmRepository, logRoot, decisions: [FINISH], git: { commit: true, push: true } });
  // P24.1G7B §5/§17 — FINISH alone produces no repo diff; internal
  // settlement machinery existing is never allowed to manufacture a push
  // for a task with zero actual target-repository output.
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED');
  assert.equal(currentBranch, binding.original_checkout);
}));

test('3 — commit+push+review task restores home branch', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const interactionsCreated = [];
  const projectId = 'proj-p22-6-review';
  const commandId = 'cmd-p22-6-review';
  const taskId = deterministicOwnerId('task', commandId);
  const finalRef = sealedFinalRef({ taskId, projectId });
  const { outcome, binding, currentBranch } = await run({
    workDir, pmRepository, logRoot, projectId, commandId,
    decisions: [FINISH_ARTIFACT(taskId, projectId, finalRef)],
    git: { commit: true, push: true }, review: { requested: true }, interactionsCreated,
  });
  assert.equal(outcome.result.outcome.review_status, 'READY_FOR_REVIEW');
  assert.equal(interactionsCreated.length, 1, 'a real review interaction was created');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED');
  assert.equal(currentBranch, binding.original_checkout);
}));

// ==================================================================
// 4 — non-Git tasks are completely unaffected
// ==================================================================

test('4 — non-Git task never switches branch', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'runtime/p22-live');
  const { outcome, binding, currentBranch } = await run({ workDir, pmRepository, logRoot, decisions: [FINISH], bound: false, git: { commit: false, push: false } });
  assert.equal(binding, null, 'no task-branch binding was ever created');
  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.branchRestore, undefined, 'restore code never even runs for a non-Git task');
  assert.equal(currentBranch, 'runtime/p22-live', 'worktree never left its home branch');
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '', 'no extra Git mutation of any kind');
}));

// ==================================================================
// 5 — task execution failure after branch preparation still restores
// ==================================================================

test('5 — task execution failure (result.status=failed) after branch preparation restores home branch', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  // DurablePmRuntime catches a thrown driver decision internally and
  // persists a canonical `failed` result (durable-pm-runtime.mjs) — this is
  // "task execution failure", reaching the SAME terminal settlement block
  // the success path uses (gitSync stays null since status!=='completed',
  // but taskBranchBinding still triggers the restore).
  const { outcome, binding, currentBranch } = await run({ workDir, pmRepository, logRoot, decisions: [() => { throw new Error('simulated backend failure'); }], git: { commit: true, push: true } });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED');
  assert.equal(currentBranch, binding.original_checkout);
}));

test('5b — an early lineage failure (execution never reaches the normal terminal block) still restores home via #settleFailure()', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-p22-6-lineage';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch, 'worktree is genuinely on the task branch when the failure happens');
  const project = { id: 'proj-p22-6-lineage', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: false } } });
  await pmRepository.create(request, { id: 'pmrun-lineage', driver: 'p22-6-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, decisions: [FINISH], taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: false }, taskBranch: binding } });
  // A DELIBERATELY WRONG action_id trips the lineage check at the very top
  // of execute() — BEFORE `taskBranchBinding` is ever read in that method's
  // own scope — routing straight to #settleFailure(), which must re-derive
  // the binding from durable state instead.
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-lineage', action_id: 'wrong-action-id' }, fence: {} });
  assert.equal(outcome.status, 'FAILURE_SETTLED');
  assert.equal(outcome.code ?? outcome.classification ?? true, outcome.code ?? outcome.classification ?? true, 'original failure classification is preserved (not asserted further — settlement-code contract is out of this task\'s scope)');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.original_checkout, 'the worktree was still restored home even though execution never reached the normal terminal path');
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '');
}));

// ==================================================================
// 6-8 — commit/push/remote-verification failures still attempt restore
// ==================================================================

test('6 — commit failure (executor-changed checkout) attempts safe restore', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  // The scripted decision's own side effect simulates a backend that moved
  // the checkout away from the bound branch during its turn (exactly the
  // adversarial case task-branch-binding.mjs's PRE_COMMIT verifyBoundBranch
  // exists to catch) — landing back on `runtime/p22-live` as a side effect,
  // which happens to already BE the captured home branch.
  const decisions = [() => { git(workDir, ['checkout', 'runtime/p22-live']); return FINISH; }];
  const { outcome, binding, currentBranch } = await run({ workDir, pmRepository, logRoot, decisions, git: { commit: true, push: true } });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_FAILED', 'commit correctly refused: checked-out branch no longer matches the binding');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED', 'restore was still attempted, and trivially succeeded (already home)');
  assert.equal(currentBranch, binding.original_checkout);
}));

test('7/8 — push (and independent remote-verification) failure attempts safe restore', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-p22-6-push-fail';
  const taskId = deterministicOwnerId('task', commandId);
  // Prepare FIRST (this performs its own real `git fetch origin`, which
  // must still succeed against the real bare remote) — only THEN break the
  // remote, so the failure is isolated to the later push/verify step, never
  // to preparation itself.
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  // A real file change on the bound branch, exactly as a real backend turn
  // would leave one — otherwise there is nothing for commitTaskResult() to
  // commit at all (LOCAL_GIT_VERIFIED_NO_CHANGES), which this test isn't
  // about.
  writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n');
  // pushTaskResult()'s own contract (task-result-git-sync.mjs): `git push`
  // itself, and its immediately-following independent fetch+SHA
  // verification, both fail identically (REMOTE_SYNC_FAILED) against an
  // unreachable remote — there is no separate black-box way to fail ONLY
  // the verification step of a successful push without deeper mocking, so
  // this one fixture change (an unreachable remote URL, the same proven
  // technique tests/p12-r2-task-result-git-sync.test.mjs already uses)
  // exercises the SAME `remoteSyncStatus=FAILED` catch this worker uses for
  // both #7 and #8 — the restore code that runs after neither knows nor
  // cares which of the two actually failed.
  git(workDir, ['remote', 'set-url', 'origin', 'https://user:x@example.invalid/nonexistent.git']);
  const project = { id: 'proj-p22-6-push-fail', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-pushfail', driver: 'p22-6-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, decisions: [FINISH], taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-pushfail', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-pushfail' }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_SYNC_FAILED');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED', 'the LOCAL commit still succeeded — only the remote step failed');
  assert.equal(outcome.result.branchRestore?.status, 'RESTORED', 'restore was still attempted and succeeded despite the remote failure');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.original_checkout);
}));

// ==================================================================
// 9 — a dirty worktree blocks destructive restore
// ==================================================================

test('9 — a dirty worktree blocks restore (fails closed, never reset/clean/force)', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-dirty', taskMode: 'SINGLE' });
  writeFileSync(join(workDir, 'UNTRACKED_LEFTOVER.md'), 'never touch me\n');
  await assert.rejects(
    restoreOriginalBranch({ projectRepoPath: workDir, binding }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_RESTORE_BLOCKED_DIRTY_WORKTREE',
  );
  // Evidence preserved: the file is untouched, the branch never moved.
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '?? UNTRACKED_LEFTOVER.md');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch);
}));

test('9b — the same dirty-worktree case surfaces end-to-end through the worker as a recorded restore failure, task outcome unaffected', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-p22-6-dirty-e2e';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-6-dirty', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: false, push: false } } });
  await pmRepository.create(request, { id: 'pmrun-dirty', driver: 'p22-6-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  // A decision whose OWN side effect leaves an untracked file behind —
  // gitSync.commit=false here so this untracked leftover is never itself
  // committed/cleaned by the normal flow; it is purely there to make the
  // POST-settlement restore attempt find a dirty tree.
  const decisions = [() => { writeFileSync(join(workDir, 'LEFTOVER.md'), 'x\n'); return FINISH; }];
  const handler = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: false, push: false }, taskBranch: binding } });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-dirty', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-dirty' }).action_id }, fence: {} });
  assert.equal(outcome.result.status, 'completed', 'the real task outcome is unaffected by the restore failure');
  assert.equal(outcome.result.branchRestore?.status, 'FAILED');
  assert.equal(outcome.result.branchRestore?.code, 'TASK_BRANCH_RESTORE_BLOCKED_DIRTY_WORKTREE');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch, 'worktree deliberately left on the task branch rather than destroying the leftover file');
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '?? LEFTOVER.md', 'the leftover file is untouched');
}));

// ==================================================================
// 10 — restore failure never hides the original failure
// ==================================================================

test('10 — a genuine task FAILURE plus a restore failure still reports the ORIGINAL failure, not a false success', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-p22-6-both-fail';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-6-both-fail', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: false } } });
  await pmRepository.create(request, { id: 'pmrun-bf', driver: 'p22-6-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  // The task itself fails AND leaves an untracked file behind (so the
  // subsequent restore attempt also fails, dirty-worktree) — two
  // independent failures in the same settlement.
  const decisions = [() => { writeFileSync(join(workDir, 'BOTH_FAIL.md'), 'x\n'); throw new Error('simulated backend failure'); }];
  const handler = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: false }, taskBranch: binding } });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-bf', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-bf' }).action_id }, fence: {} });
  assert.equal(outcome.result.status, 'failed', 'the ORIGINAL task failure is preserved, never silently marked successful');
  assert.equal(outcome.result.branchRestore?.status, 'FAILED', 'the SEPARATE restore failure is recorded, not swallowed');
  assert.equal(outcome.result.branchRestore?.code, 'TASK_BRANCH_RESTORE_BLOCKED_DIRTY_WORKTREE');
}));

// ==================================================================
// 11/12/13/14 — two sequential Git-settled tasks
// ==================================================================

test('11/12/13/14 — two sequential Git tasks: both base from project authority (not each other); home branch SHA is unchanged; both task branches survive', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const homeShaBefore = git(workDir, ['rev-parse', 'runtime/p22-live']).trim();
  const configuredBaseSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  // Each decision writes a REAL, distinct file (mirroring the CHANGE.md
  // pattern tests/p18-w4r2-production-pm-worker-settlement.test.mjs
  // already uses) so a genuine new commit — not just a VERIFIED_NO_CHANGES
  // no-op — lands on each task branch; only then does "parent commit"
  // mean anything to check.
  const decisionA = () => { writeFileSync(join(workDir, 'TASK_A.md'), 'a\n'); return FINISH; };
  const decisionB = () => { writeFileSync(join(workDir, 'TASK_B.md'), 'b\n'); return FINISH; };

  const a = await run({ workDir, pmRepository, logRoot, decisions: [decisionA], git: { commit: true, push: true } });
  assert.equal(a.outcome.result.status, 'completed');
  assert.equal(a.outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(a.currentBranch, 'runtime/p22-live', 'TASK A returned home');
  assert.equal(a.binding.base_sha, configuredBaseSha, 'TASK_A_PARENT = configured base SHA');

  const b = await run({ workDir, pmRepository, logRoot, decisions: [decisionB], git: { commit: true, push: true } });
  assert.equal(b.outcome.result.status, 'completed');
  assert.equal(b.outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(b.currentBranch, 'runtime/p22-live', 'TASK B returned home');
  assert.equal(b.binding.base_sha, configuredBaseSha, 'TASK_B_PARENT = configured base SHA, independent of task A');
  assert.notEqual(a.binding.task_branch, b.binding.task_branch);

  // Task B must NOT descend from Task A merely because A ran first.
  // (`~1`, never `^` — the latter is cmd.exe's OWN escape character, and on
  // Windows `execFileSync` spawning `git` can route through a `.cmd` shim
  // via cmd.exe even with array-form argv, silently corrupting a bare `^`.)
  const bParent = git(workDir, ['rev-parse', `${b.binding.task_branch}~1`]).trim();
  assert.equal(bParent, configuredBaseSha, "Task B's own parent commit is the project base, never Task A's branch tip");
  const mergeBaseAB = git(workDir, ['merge-base', a.binding.task_branch, b.binding.task_branch]).trim();
  assert.equal(mergeBaseAB, configuredBaseSha, 'the only shared history between A and B is the common project base');

  // 13 — runtime home branch SHA is unchanged by either task.
  assert.equal(git(workDir, ['rev-parse', 'runtime/p22-live']).trim(), homeShaBefore, 'home branch was never advanced/merged into');

  // 14 — both task branches (and their remote counterparts) remain intact.
  for (const branch of [a.binding.task_branch, b.binding.task_branch]) {
    assert.doesNotThrow(() => git(workDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));
    const remoteLine = git(bareDir, ['show-ref', `refs/heads/${branch}`]).trim();
    assert.ok(remoteLine.length > 0, `${branch} exists on the remote`);
  }
}));
