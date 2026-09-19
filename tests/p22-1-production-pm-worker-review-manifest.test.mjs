import { buildRuntime } from './fixtures/p20-durable-council-harness.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
import { buildArtifactReference } from '../src/artifacts/artifact-schema.mjs';
import { LOCAL_GIT_STATUS, REMOTE_SYNC_STATUS } from '../src/pm/task-outcome-model.mjs';

// P22.1 — opt-in GitHub review completeness for P20 tasks, exercised
// through the REAL ProductionPmWorkHandler.execute() settlement path
// (mirrors tests/p18-w4r2-production-pm-worker-settlement.test.mjs's
// fixture exactly), against a real local git fixture (a local bare repo
// standing in for "origin" — never a network/GitHub remote, no live
// provider calls). Docs read: docs/P22/P22_0_AUTOMATIC_TASK_GITHUB_REVIEW_
// BRANCH_AUDIT.md, docs/P22/P22_1_OPT_IN_GITHUB_REVIEW_COMPLETENESS_
// IMPLEMENTATION_REPORT.md.

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
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p22-1-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p22-1-git-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'p22-1-logs-'));
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

function buildHandler({ pmRepository, project, taskRepositoryContext, logRoot, decisions, enableRepoHistoryMaterialization = false }) {
  const ownerRepository = { createInteraction: async (v) => v };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'pm-1', context: taskRepositoryContext } : null) };
  const createRuntime = () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'p22-1-fake', decisions }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  const coordinationStore = { completeClaim: async () => {} };
  const taskDiagnosticsFactory = logRoot ? createTaskDiagnosticLogFactory({ runtimeRoot: logRoot }) : null;
  return new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, enableRepoHistoryMaterialization });
}

// P24.2: a fabricated final_ref is no longer sufficient for Council Git
// settlement. These review regressions now generate real durable stage products.
function realCouncilHandler({pmRepository,project,logRoot,binding,taskId,council}) {
  const artifactStore=createArtifactStore({storeId:'p22-real',projectId:project.id,root:join(logRoot,'artifacts')});
  return new ProductionPmWorkHandler({
    coordinationStore:{completeClaim:async()=>{}},pmRepository,ownerRepository:{},projects:[project],
    taskRepository:{getOwnerTask:id=>({id,projectId:project.id,context:{durability:'DIRECT',gitSync:{commit:true,push:true},taskBranch:binding}})},
    resolveProjectArtifactStore:()=>artifactStore,
    createRuntime:()=>buildRuntime({council,artifactStore,pmRepository,
      stepState:new DurableWorkflowState({repository:new WorkflowRepository({store:pmRepository.store})}),
      taskId,calls:[],maxTurns:32,debate:{debateTypedControl:true,continueDebate:({round})=>round===1}}),
  });
}

// P22.6: the worktree returns to its original (pre-task-branch) checkout
// once settlement reaches a terminal state, so a manifest committed onto
// the task branch is no longer present on disk afterward — read it via
// `git show <branch>:<path>` instead of a raw filesystem path, exactly
// like this file's own `git ls-tree`/`git show` reads for tree content.
function readManifestFromBranch(workDir, branch, taskId) {
  return JSON.parse(git(workDir, ['show', `${branch}:docs/task-review/${taskId}.json`]));
}
function manifestExistsOnBranch(workDir, branch, taskId) {
  try { git(workDir, ['cat-file', '-e', `${branch}:docs/task-review/${taskId}.json`]); return true; } catch { return false; }
}

function sealedFinalRef({ taskId, projectId, sha256 = 'a'.repeat(64), bytes = 42 }) {
  return buildArtifactReference({
    storeId: 'store-p20-v1', projectId, taskId, invocationId: 'inv-1', attemptOrdinal: 0,
    artifactRelpath: `${taskId}/inv-1/attempt-0/report.md`, sha256, bytes, sealedAt: '2026-09-13T00:00:00.000Z',
  }, { sealed: true });
}

async function runOnce({ workDir, pmRepository, logRoot, projectId, decisions, bound = true, push = true, commit = true }) {
  const commandId = `cmd-${Math.random().toString(36).slice(2)}`;
  const taskId = deterministicOwnerId('task', commandId);
  const binding = bound ? await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' }) : null;
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit, push } } });
  const pmRunId = `pmrun-${Math.random().toString(36).slice(2)}`;
  await pmRepository.create(request, { id: pmRunId, driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit, push }, ...(binding ? { taskBranch: binding } : {}) } });
  const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
  const outcome = await handler.execute({ work, fence: {} });
  return { outcome, taskId, binding, project };
}

test('push=false + P20 artifact: no review manifest, existing behavior unchanged', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const projectId = 'proj-p22-1-a';
  // finalRef task_id is resolved AFTER runOnce derives taskId, so build the
  // decision lazily via a driver that reads the durable task_id off the
  // scripted decision is not possible; instead assert on absence generically:
  // no push requested -> gitSync?.commit block never runs at all, so no
  // manifest write can occur regardless of decision content.
  const decisions = [{ type: 'finish', output: 'ok', data: { transport_version: 'artifact_v1', task_id: 'placeholder', final_ref: null } }];
  const { taskId } = await runOnce({ workDir, pmRepository, logRoot, projectId, decisions, push: false, commit: false });
  assert.equal(existsSync(join(workDir, 'docs', 'task-review', `${taskId}.json`)), false);
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '', 'nothing at all was committed');
}));

test('push=true + P20 SINGLE artifact: review manifest created with final_ref/hash/bytes, runtime report bytes never copied', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const projectId = 'proj-p22-1-b';
  const commandId = 'cmd-p22-1-b';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const finalRef = sealedFinalRef({ taskId, projectId });
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-b', driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'the report body', data: { transport_version: 'artifact_v1', task_id: taskId, invocation_id: 'inv-1', final_ref: finalRef, report_sha256: finalRef.sha256, report_bytes: finalRef.bytes } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding },
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-b', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-b' }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(manifestExistsOnBranch(workDir, binding.task_branch, taskId), true);
  const manifest = readManifestFromBranch(workDir, binding.task_branch, taskId);
  assert.equal(manifest.task_mode, 'SINGLE');
  assert.deepEqual(manifest.final_ref, finalRef);
  assert.equal(manifest.report_sha256, finalRef.sha256);
  assert.equal(manifest.report_bytes, finalRef.bytes);
  assert.equal(manifest.branch, binding.task_branch);

  // Runtime report bytes are never copied into the source tree.
  const tree = git(workDir, ['ls-tree', '-r', '--name-only', binding.task_branch]).trim().split('\n');
  assert.ok(tree.includes(`docs/task-review/${taskId}.json`));
  assert.ok(!tree.some((f) => f.endsWith('report.md')), 'no report.md staged into Git');
  for (const f of tree) assert.ok(!f.startsWith('.runtime'), '.runtime is never staged');

}));

test('push=true + Council P20 artifact + zero source changes: manifest is the real metadata change that gets committed/published', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const projectId = 'proj-p22-1-c';
  const commandId = 'cmd-p22-1-c';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'COUNCIL' });
  // Deliberately NO source file write here — the zero-source-change case.
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  // `taskMode` inside production-pm-worker.mjs is derived from the durable
  // pm_request's OWN `context.council` (`run.request.context?.council`),
  // never from the owner-task record — see production-pm-worker.mjs:206.
  const council = normalizeCouncilSpec({ chair_profile_id:'chair-1', participant_profile_ids:['p1','p2'], rounds:1, debate:{enabled:false,max_rounds:2} });
  const request = createPmRequest({ objective: 'do the council thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true }, council } });
  await pmRepository.create(request, { id: 'pmrun-c', driver: 'council:chair-1', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = realCouncilHandler({pmRepository,project,logRoot,binding,taskId,council});
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-c', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-c' }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  const product=JSON.parse(git(workDir,['show',binding.task_branch+':reports/dsh-tasks/'+taskId+'/manifest.json']));
  assert.equal(product.mode,'COUNCIL');
  assert.equal(product.artifacts.length,4);
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED', 'a real commit happened, not VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');

  const log = git(workDir, ['log', '--format=%H %s', `${binding.base_sha}..${binding.task_branch}`]).trim().split('\n');
  assert.equal(log.length, 1, 'exactly one real commit — product package and review manifest — for an otherwise zero-source-change Council task');

  const manifest = readManifestFromBranch(workDir, binding.task_branch, taskId);
  assert.equal(manifest.task_mode, 'COUNCIL');
  assert.deepEqual(manifest.topology.participant_profile_ids, ['p1', 'p2']);

  const remoteLine = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim();
  const [remoteSha] = remoteLine.split(/\s+/);
  const localSha = git(workDir, ['rev-parse', binding.task_branch]).trim();
  assert.equal(remoteSha, localSha, 'task branch publish path succeeds');
}));

test('push=true + Debate P20 artifact: manifest records Debate topology truthfully, never flattened to Council', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const projectId = 'proj-p22-1-d';
  const commandId = 'cmd-p22-1-d';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'COUNCIL' });
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const council = normalizeCouncilSpec({ chair_profile_id:'chair-1', participant_profile_ids:['p1','p2'], rounds:1, debate:{enabled:true,max_rounds:2} });
  const request = createPmRequest({ objective: 'do the debate thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true }, council } });
  await pmRepository.create(request, { id: 'pmrun-d', driver: 'council:chair-1', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = realCouncilHandler({pmRepository,project,logRoot,binding,taskId,council});
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-d', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-d' }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  const product=JSON.parse(git(workDir,['show',binding.task_branch+':reports/dsh-tasks/'+taskId+'/manifest.json']));
  assert.equal(product.mode,'DEBATE');
  assert.equal(product.artifacts.length,12);
  const manifest = readManifestFromBranch(workDir, binding.task_branch, taskId);
  assert.equal(manifest.task_mode, 'DEBATE', 'never flattened to COUNCIL, even though the shared worker taskMode local is COUNCIL internally');
  assert.deepEqual(manifest.topology.debate, { enabled: true, rounds_run: 2, max_rounds: 2 });
}));

test('non-P20 zero-change push path is unchanged: no manifest, existing no-change publication behavior stands', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot }) => {
  const projectId = 'proj-p22-1-e';
  const commandId = 'cmd-p22-1-e';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  // No source changes, no P20 artifact (legacy non-artifact finish shape).
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'plain legacy task', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-e', driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding },
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-e', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-e' }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES', 'unchanged: still a verified no-op commit, exactly as before P22.1');
  assert.equal(manifestExistsOnBranch(workDir, binding.task_branch, taskId), false, 'no manifest for a task with no P20 artifact, regardless of push');
}));

test('re-running settlement for the same completed task is idempotent: same facts -> same manifest, no divergent content', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const projectId = 'proj-p22-1-f';
  const commandId = 'cmd-p22-1-f';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const finalRef = sealedFinalRef({ taskId, projectId });
  const project = { id: projectId, repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const decisions = [{ type: 'finish', output: 'the report body', data: { transport_version: 'artifact_v1', final_ref: finalRef } }];
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-f1', driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler1 = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  await handler1.execute({ work: { pm_run_id: 'pmrun-f1', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-f1' }).action_id }, fence: {} });
  // P22.6: the worktree is back on its original branch after handler1
  // settles — read the committed manifest via `git show`, and explicitly
  // re-checkout the bound task branch before simulating a later, unrelated
  // local change on it (exactly what a real recovery/replay caller would
  // do before reusing an existing binding — see prepareTaskBranch()'s own
  // "already exists" reuse path, which does the identical checkout).
  const firstBytes = git(workDir, ['show', `${binding.task_branch}:docs/task-review/${taskId}.json`]);
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.original_checkout, 'worktree returned home after the first settlement');

  // Simulate a second settlement replay for the SAME task (e.g. a second
  // pm_run against the identical durable facts) — must reproduce byte-
  // identical manifest content, not diverge. Same ownerCommandId -> the
  // handler derives the SAME taskId, this really is "the same task"
  // replaying settlement, not a different one.
  await pmRepository.create(createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-f2', driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:01.000Z' });

  git(workDir, ['checkout', binding.task_branch]);
  writeFileSync(join(workDir, 'IRRELEVANT.md'), 'unrelated later change\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'unrelated']);
  // Re-run writeTaskReviewManifest directly via a fresh handler execution against the same manifest facts.
  const handler2 = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const outcome2 = await handler2.execute({ work: { pm_run_id: 'pmrun-f2', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-f2' }).action_id }, fence: {} });
  assert.equal(outcome2.result.status, 'completed');
  assert.equal(git(workDir, ['show', `${binding.task_branch}:docs/task-review/${taskId}.json`]), firstBytes, 'identical verified inputs reproduce byte-identical manifest content');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.original_checkout, 'worktree returned home after the replayed settlement too');
}));

// ---------------------------------------------------------------------
// P22.1-R1 (PM audit) — a PRESENT but invalid/unsealed/cross-task/cross-
// project final_ref must fail closed through the existing Git settlement
// error path, never be silently treated as "no final_ref". Every case
// below asserts all three required properties together: no manifest file
// is left behind, local_git_status is FAILED (never VERIFIED/VERIFIED_
// NO_CHANGES), remote_sync_status stays NOT_REQUESTED (push never even
// attempted), and the task's own execution verdict ('completed') is
// preserved unchanged per existing P12 settlement semantics (a Git/
// manifest failure downstream of a successful provider turn never flips
// result.status).
// ---------------------------------------------------------------------

async function assertFailsClosed({ workDir, pmRepository, logRoot, commandId, taskId, binding, project, finalRef, pmRunId = 'pmrun-r1' }) {
  const decisions = [{ type: 'finish', output: 'the report body', data: { transport_version: 'artifact_v1', final_ref: finalRef } }];
  // ownerCommandId MUST be the exact commandId taskId was derived from
  // (execute() re-derives taskId from `run.request.context.ownerCommandId`
  // itself, deterministicOwnerId('task', commandId)) — a mismatch here
  // would make the handler look up a DIFFERENT taskId than the one this
  // fixture prepared a branch/binding for, failing at PM_WORK_LINEAGE_
  // INVALID before ever reaching the P22.1 seam under test.
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: pmRunId, driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, decisions, taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed', 'execution verdict is preserved even though the Git/manifest stage fails');
  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.FAILED, 'a present-but-invalid final_ref fails the commit stage closed, never VERIFIED/VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, REMOTE_SYNC_STATUS.NOT_REQUESTED, 'push is skipped entirely after the manifest/validation failure');
  assert.equal(existsSync(join(workDir, 'docs', 'task-review', `${taskId}.json`)), false, 'no manifest is ever written for an invalid final_ref');
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '', 'nothing was left committed or dirty');
  return outcome;
}

test('P22.1-R1: present malformed (non-object) final_ref fails closed — never silently treated as absent', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-r1-malformed';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-1-r1a', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await assertFailsClosed({ workDir, pmRepository, logRoot, commandId, taskId, binding, project, finalRef: 'not-a-ref-object', pmRunId: 'pmrun-r1a' });
}));

test('P22.1-R1: present but unsealed final_ref fails closed', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-r1-unsealed';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-1-r1b', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const unsealed = buildArtifactReference({
    storeId: 'store-p20-v1', projectId: project.id, taskId, invocationId: 'inv-1', attemptOrdinal: 0,
    artifactRelpath: `${taskId}/inv-1/attempt-0/report.md`,
  }, { sealed: false });
  await assertFailsClosed({ workDir, pmRepository, logRoot, commandId, taskId, binding, project, finalRef: unsealed, pmRunId: 'pmrun-r1b' });
}));

test('P22.1-R1: present final_ref belonging to a different task (cross-task) fails closed', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-r1-crosstask';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-1-r1c', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const foreignTaskRef = sealedFinalRef({ taskId: 'some-other-task-entirely', projectId: project.id });
  await assertFailsClosed({ workDir, pmRepository, logRoot, commandId, taskId, binding, project, finalRef: foreignTaskRef, pmRunId: 'pmrun-r1c' });
}));

test('P22.1-R1: present final_ref belonging to a different project (cross-project) fails closed', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-r1-crossproject';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-1-r1d', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const foreignProjectRef = sealedFinalRef({ taskId, projectId: 'some-other-project-entirely' });
  await assertFailsClosed({ workDir, pmRepository, logRoot, commandId, taskId, binding, project, finalRef: foreignProjectRef, pmRunId: 'pmrun-r1d' });
}));

test('P22.1-R1: final_ref absent/null is unchanged — no manifest, no failure, ordinary no-change commit', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-r1-absent';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-p22-1-r1e', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({ objective: 'plain legacy task', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } });
  await pmRepository.create(request, { id: 'pmrun-r1e', driver: 'p22-1-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding },
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-r1e', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r1e' }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED_NO_CHANGES, 'absent final_ref takes the byte-for-byte pre-P22.1 no-change path, never FAILED');
  // P24.1G7B §5/§17 — a task with zero actual target-repository diff must
  // never push at all, even when git.push=true: internal settlement
  // machinery existing (or, pre-G7B, an empty no-op push republishing the
  // unchanged branch) is never allowed to manufacture a Git side effect
  // for a task that produced no real output. Absent final_ref still takes
  // the byte-for-byte no-manifest/no-failure path (never FAILED) — it is
  // ONLY the push count that changed from the pre-G7B behavior.
  assert.equal(outcome.result.outcome.remote_sync_status, REMOTE_SYNC_STATUS.NOT_REQUESTED, 'no result commit exists (nothing was dirty) -> push is skipped entirely, never a no-op push of the unchanged branch');
  assert.equal(existsSync(join(workDir, 'docs', 'task-review', `${taskId}.json`)), false);
}));
