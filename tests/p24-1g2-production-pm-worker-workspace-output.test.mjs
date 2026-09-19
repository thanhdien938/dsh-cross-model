import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
import { gitBlobSha1 } from '../src/pm/workspace-output-materializer.mjs';
import { buildArtifactReference } from '../src/artifacts/artifact-schema.mjs';

// P24.1G2 — end-to-end proof, through the REAL ProductionPmWorkHandler and a
// REAL local git fixture (bare "origin", never network/GitHub), that a
// typed `workspace_output` request is materialized VERBATIM from the sealed
// artifact_v1 `final_ref` BEFORE Git settlement, lands in the result
// commit, and is independently verified on the pushed remote — closing
// reports/P24_1G_REQUESTED_REPORT_GIT_SETTLEMENT_AUDIT_FIX_20260916.md.

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
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

// A fully-shaped, sealed ArtifactReference (writeTaskReviewManifest() ->
// buildTaskReviewManifest() validates the WHOLE shape via
// validateArtifactReference(...,{requireSealed:true}), not just sha256/
// bytes) — this is the SAME shape single-artifact-driver.mjs's real
// completeSingleReportArtifact() produces as `out.completion.finalRef`.
function sealFixture(storeRoot, { taskId, projectId }, relpath, content) {
  const abs = join(storeRoot, ...relpath.split('/'));
  mkdirSync(join(storeRoot, ...relpath.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(abs, content);
  return buildArtifactReference({
    storeId: 'store-test', projectId, taskId, invocationId: 'inv-test', attemptOrdinal: 0,
    artifactRelpath: relpath, sha256: sha256(content), bytes: Buffer.byteLength(content), sealedAt: '2026-01-01T00:00:00.000Z',
  }, { sealed: true });
}

async function withHandlerFixture(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-1g2-e2e-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-1g2-e2e-git-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'p24-1g2-e2e-logs-'));
  const storeRoot = mkdtempSync(join(tmpdir(), 'p24-1g2-e2e-store-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const pmRepository = new PmRepository({ store });
    const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
    await fn({ pmRepository, workDir, bareDir, logRoot, storeRoot });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

function buildHandler({ pmRepository, project, taskRepositoryContext, logRoot, decisions, resolveProjectArtifactStore = null }) {
  const ownerRepository = { createInteraction: async (v) => v };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'pm-1', context: taskRepositoryContext } : null) };
  const createRuntime = () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  const coordinationStore = { completeClaim: async () => {} };
  const taskDiagnosticsFactory = logRoot ? createTaskDiagnosticLogFactory({ runtimeRoot: logRoot }) : null;
  return new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, enableRepoHistoryMaterialization: false, resolveProjectArtifactStore });
}

test('no workspace_output requested: settlement is byte-for-byte unaffected (existing regression path)', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot }) => {
  const commandId = 'cmd-e2e-no-output';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const project = { id: 'proj-e2e-a', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-a', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, logRoot, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }], taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding } });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-a', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-a' }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES');
  // P24.1G7B §5/§17 — zero actual target-repo diff means zero result
  // commit, which means push is skipped entirely, regardless of
  // git.push=true — never a no-op push of the unchanged branch.
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
}));

test('happy path: typed workspace_output materializes verbatim, lands in the result commit, and is verified on the pushed remote', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot, storeRoot }) => {
  const commandId = 'cmd-e2e-happy';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const content = Buffer.from('# P24 sealed report\n\nthe real content\n', 'utf8');
  const finalRef = sealFixture(storeRoot, { taskId, projectId: 'proj-e2e-b' }, `tasks/${taskId}/single/alias/inv/attempt-00/report.md`, content);

  const project = { id: 'proj-e2e-b', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'produce a report', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true }, workspaceOutput: { report_path: 'reports/qualification/foo.md', required: true, non_empty: true } } }), { id: 'pmrun-b', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result', transport_version: 'artifact_v1', final_ref: finalRef } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding, workspaceOutput: { report_path: 'reports/qualification/foo.md', required: true, non_empty: true } },
    resolveProjectArtifactStore: () => ({ root: storeRoot }),
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-b', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-b' }).action_id }, fence: {} });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');

  // ---- the typed report is present, byte-identical, in the result commit ----
  const resultSha = git(workDir, ['log', '--format=%H', `${binding.base_sha}..${binding.task_branch}`]).trim().split('\n').at(-1);
  const tree = git(workDir, ['ls-tree', '-r', '--name-only', resultSha]).trim().split('\n');
  assert.ok(tree.includes('reports/qualification/foo.md'), `result commit must contain the typed report; tree=${tree.join(',')}`);
  const blobSha = git(workDir, ['rev-parse', `${resultSha}:reports/qualification/foo.md`]).trim();
  assert.equal(blobSha, gitBlobSha1(content));

  // ---- proven present, with matching content, on the pushed remote ----
  const remoteLine = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim();
  const [remoteSha] = remoteLine.split(/\s+/);
  const remoteBlobSha = git(workDir, ['rev-parse', `${remoteSha}:reports/qualification/foo.md`]).trim();
  assert.equal(remoteBlobSha, gitBlobSha1(content));
}));

test('materialization failure (no artifact store configured) fails closed: no false LOCAL_COMMIT_VERIFIED/REMOTE_PUSH_VERIFIED, nothing pushed', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot, storeRoot }) => {
  const commandId = 'cmd-e2e-no-store';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const content = Buffer.from('unreachable\n', 'utf8');
  const finalRef = sealFixture(storeRoot, { taskId, projectId: 'proj-e2e-c' }, `tasks/${taskId}/report.md`, content);

  const project = { id: 'proj-e2e-c', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-c', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result', transport_version: 'artifact_v1', final_ref: finalRef } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding, workspaceOutput: { report_path: 'reports/foo.md', required: true, non_empty: true } },
    resolveProjectArtifactStore: null, // no store wired — materialization cannot possibly succeed
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-c', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-c' }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_FAILED');
  assert.notEqual(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '', 'the bound task branch was never pushed');
}));

test('sealed artifact hash mismatch (tampered/stale final_ref) fails closed before any commit', async () => withHandlerFixture(async ({ pmRepository, workDir, bareDir, logRoot, storeRoot }) => {
  const commandId = 'cmd-e2e-hash-mismatch';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const content = Buffer.from('actual sealed content\n', 'utf8');
  const finalRef = sealFixture(storeRoot, { taskId, projectId: 'proj-e2e-d' }, `tasks/${taskId}/report.md`, content);
  const tamperedFinalRef = { ...finalRef, sha256: 'a'.repeat(64) };

  const project = { id: 'proj-e2e-d', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true } } }), { id: 'pmrun-d', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result', transport_version: 'artifact_v1', final_ref: tamperedFinalRef } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding, workspaceOutput: { report_path: 'reports/foo.md', required: true, non_empty: true } },
    resolveProjectArtifactStore: () => ({ root: storeRoot }),
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-d', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-d' }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_FAILED');
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '');
}));

test('review manifest records refs/path/hash/status for a typed workspace_output request (never full report content)', async () => withHandlerFixture(async ({ pmRepository, workDir, logRoot, storeRoot }) => {
  const commandId = 'cmd-e2e-review';
  const taskId = deterministicOwnerId('task', commandId);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'SINGLE' });
  const content = Buffer.from('# reviewed report\n', 'utf8');
  const finalRef = sealFixture(storeRoot, { taskId, projectId: 'proj-e2e-e' }, `tasks/${taskId}/report.md`, content);

  const project = { id: 'proj-e2e-e', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  await pmRepository.create(createPmRequest({ objective: 'x', context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DIRECT', git: { commit: true, push: true }, review: { requested: true } } }), { id: 'pmrun-e', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({
    pmRepository, project, logRoot,
    decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result', transport_version: 'artifact_v1', final_ref: finalRef } }],
    taskRepositoryContext: { durability: 'DIRECT', gitSync: { commit: true, push: true }, taskBranch: binding, review: { requested: true }, workspaceOutput: { report_path: 'reports/foo.md', required: true, non_empty: true } },
    resolveProjectArtifactStore: () => ({ root: storeRoot }),
  });
  const outcome = await handler.execute({ work: { pm_run_id: 'pmrun-e', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-e' }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');

  const resultSha = git(workDir, ['log', '--format=%H', `${binding.base_sha}..${binding.task_branch}`]).trim().split('\n').at(-1);
  const manifestJson = git(workDir, ['show', `${resultSha}:docs/task-review/${taskId}.json`]);
  const manifest = JSON.parse(manifestJson);
  assert.deepEqual(manifest.workspace_output, { requested: true, path: 'reports/foo.md', sha256: finalRef.sha256, bytes: finalRef.bytes, materialization_status: 'VERIFIED' });
  assert.equal(JSON.stringify(manifest).includes('reviewed report'), false, 'the manifest never embeds the report content itself');
}));
