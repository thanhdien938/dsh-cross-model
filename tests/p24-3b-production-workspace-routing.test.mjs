// P24.3B — production task-workspace ROUTING (reports/
// P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md;
// P24.3A's src/pm/task-workspace-manager.mjs; this phase's own
// reports/P24_3B_PRODUCTION_WORKSPACE_ROUTING_IMPLEMENTATION_20260917.md).
//
// Three layers, same discipline as the existing P24 suites:
//   1. Pure unit tests for task-execution-context.mjs (deterministic, no I/O).
//   2. Real disposable-git-repo + real SQLite integration tests using the
//      SAME OwnerTaskController -> ProductionPmWorkHandler harness pattern
//      tests/p24-1g7a-single-final-settlement.test.mjs already established
//      (never a shallow taskRepository fake) — proving the FULL v1
//      admission -> execution -> settlement -> cleanup lifecycle end to
//      end, and that a legacy (isolation-not-wired) task is byte-for-byte
//      unaffected.
//   3. Real `createP5ProductionComposition()` tests (mirroring
//      tests/phase5-r2-production-composition.test.mjs's own pattern) that
//      prove provider cwd routing and the project-keyed-cache fix using a
//      spy PM backend registry — the ONE thing the OwnerTaskController-
//      direct harness cannot reach, since it substitutes its own fake
//      `createRuntime` rather than exercising p5-production-composition.mjs's
//      real one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity, resolvePmWorkspaceIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { GIT_SETTLEMENT_STATE } from '../src/pm/git-settlement-journal.mjs';
import { ensureTaskWorkspace, TASK_WORKSPACE_STATE } from '../src/pm/task-workspace-manager.mjs';
import { resolveTaskWorkspaceBinding, resolveExecutionRepoPath, resolveExecutionProject, projectExecutionCacheKey } from '../src/pm/task-execution-context.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';

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

// ---------------------------------------------------------------------------
// Layer 1 — pure unit tests, task-execution-context.mjs
// ---------------------------------------------------------------------------

test('resolveTaskWorkspaceBinding: absent/malformed/unsupported-version context all resolve to null (legacy)', () => {
  assert.equal(resolveTaskWorkspaceBinding(null), null);
  assert.equal(resolveTaskWorkspaceBinding({}), null);
  assert.equal(resolveTaskWorkspaceBinding({ taskWorkspace: null }), null);
  assert.equal(resolveTaskWorkspaceBinding({ taskWorkspace: { isolation_version: 2, workspace_path: '/x' } }), null, 'unsupported version fails closed to legacy, never adopted');
  assert.equal(resolveTaskWorkspaceBinding({ taskWorkspace: { isolation_version: 1, workspace_path: '' } }), null, 'empty path is not a valid binding');
  const valid = { isolation_version: 1, workspace_path: '/runtime/worktrees/p/t', repository_common_dir: '/repo/.git' };
  assert.deepEqual(resolveTaskWorkspaceBinding({ taskWorkspace: valid }), valid);
});

test('resolveExecutionRepoPath/resolveExecutionProject: legacy falls back to project.repo_path unchanged; v1 overrides only repo_path', () => {
  const project = Object.freeze({ id: 'proj-1', repo_path: '/registered/checkout', autonomy: { revision: 1, effects: {} }, workspace_id: 'abc' });
  assert.equal(resolveExecutionRepoPath(project, null), project.repo_path);
  assert.equal(resolveExecutionProject(project, null), project, 'legacy: SAME reference returned, not merely equal — never a needless clone');

  const taskContext = { taskWorkspace: { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-1', repository_common_dir: '/registered/.git' } };
  assert.equal(resolveExecutionRepoPath(project, taskContext), '/runtime/worktrees/proj-1/task-1');
  const view = resolveExecutionProject(project, taskContext);
  assert.equal(view.repo_path, '/runtime/worktrees/proj-1/task-1');
  assert.equal(view.id, project.id, 'identity/other fields preserved verbatim');
  assert.equal(view.workspace_id, project.workspace_id);
  assert.notEqual(view, project, 'v1: a fresh, ephemeral view — never the same reference (never mutates/replaces the canonical registry object)');
  assert.equal(project.repo_path, '/registered/checkout', 'the canonical project record itself is never mutated');
});

test('projectExecutionCacheKey: stable per project for legacy; unique per task workspace for v1', () => {
  const project = Object.freeze({ id: 'proj-1', repo_path: '/registered/checkout' });
  assert.equal(projectExecutionCacheKey(project, null), projectExecutionCacheKey(project, {}));
  const ctxA = { taskWorkspace: { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-a' } };
  const ctxB = { taskWorkspace: { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-b' } };
  assert.notEqual(projectExecutionCacheKey(project, ctxA), projectExecutionCacheKey(project, ctxB), 'two different task workspaces for the SAME project never collide');
  assert.notEqual(projectExecutionCacheKey(project, ctxA), projectExecutionCacheKey(project, null), 'a v1 task never shares the legacy cache entry');
});

// ---------------------------------------------------------------------------
// Layer 1b — resolvePmWorkspaceIdentity: repository-common-dir dedup (§4)
// ---------------------------------------------------------------------------

function fakeWork(taskId, pmRunId) { return { pm_run_id: pmRunId, work_item_id: `w-${taskId}` }; }
function fakePmRepository(run) { return { load: () => run }; }
function fakeTaskRepository(task) { return { getOwnerTask: () => task }; }

test('resolvePmWorkspaceIdentity: two registered projects sharing one repository_common_dir but different repo_path/workspace_id resolve to the SAME workspace identity', () => {
  const run = { request: { context: { ownerCommandId: 'cmd-1' } } };
  const commandId = 'cmd-1';
  const taskId = deterministicOwnerId('task', commandId);
  const task = { projectId: 'proj-a', context: {} };
  const projectA = { id: 'proj-a', repo_path: '/checkout/alias-a', workspace_id: 'hash-a', repository_common_dir: '/real/repo/.git' };
  const projectB = { id: 'proj-b', repo_path: '/checkout/alias-b', workspace_id: 'hash-b', repository_common_dir: '/real/repo/.git' };
  const idA = resolvePmWorkspaceIdentity({ work: fakeWork(taskId, 'pmrun-1'), pmRepository: fakePmRepository(run), taskRepository: fakeTaskRepository(task), projects: new Map([['proj-a', projectA]]) });
  const idB = resolvePmWorkspaceIdentity({ work: fakeWork(taskId, 'pmrun-1'), pmRepository: fakePmRepository(run), taskRepository: fakeTaskRepository({ ...task, projectId: 'proj-b' }), projects: new Map([['proj-b', projectB]]) });
  assert.equal(idA.workspace_id, idB.workspace_id, 'same underlying repository, different registered paths -> same workspace identity');
});

test('resolvePmWorkspaceIdentity: a project with no repository_common_dir (legacy config, non-Git, or Git probe failure) falls back to workspace_id/repo_path exactly as before P24.3B', () => {
  const run = { request: { context: { ownerCommandId: 'cmd-2' } } };
  const taskId = deterministicOwnerId('task', 'cmd-2');
  const task = { projectId: 'proj-c', context: {} };
  const projectWithVerified = { id: 'proj-c', repo_path: '/checkout/c', workspace_id: 'hash-c' };
  const id1 = resolvePmWorkspaceIdentity({ work: fakeWork(taskId, 'pmrun-2'), pmRepository: fakePmRepository(run), taskRepository: fakeTaskRepository(task), projects: new Map([['proj-c', projectWithVerified]]) });
  assert.equal(id1.workspace_id, 'hash-c');
  const projectUnverified = { id: 'proj-d', repo_path: '/checkout/d' };
  const id2 = resolvePmWorkspaceIdentity({ work: fakeWork(taskId, 'pmrun-2'), pmRepository: fakePmRepository(run), taskRepository: fakeTaskRepository({ ...task, projectId: 'proj-d' }), projects: new Map([['proj-d', projectUnverified]]) });
  assert.equal(id2.workspace_id, 'unverified:/checkout/d');
});

// ---------------------------------------------------------------------------
// Layer 2 — real OwnerTaskController -> ProductionPmWorkHandler lifecycle,
// mirroring tests/p24-1g7a-single-final-settlement.test.mjs's own harness.
// ---------------------------------------------------------------------------

async function withRealStack(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-3b-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-3b-git-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'p24-3b-workspaces-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const pmRepository = new PmRepository({ store });
    const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
    await fn({ agentBusRepository, pmRepository, workDir, bareDir, workspaceRoot });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function realCreateRuntime({ pmRepository, output = 'done', data = { type: 'single_result' } } = {}) {
  return () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output, data }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
}

function buildHandler({ agentBusRepository, pmRepository, project }) {
  return new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }), enableRepoHistoryMaterialization: false,
  });
}

async function submitTask({ agentBusRepository, project, payload, clientKind = 'LOCAL', isolation = null }) {
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null, ...(isolation ?? {}) });
  await controller.submit({ command: { command_id: commandId, client_kind: clientKind, payload }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  return { commandId, taskId, readBack };
}

async function createPmRun({ pmRepository, readBack, commandId }) {
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  return pmRunId;
}

const boundProject = (workDir) => ({ id: 'proj-p24-3b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL' } } });

function userSnapshot(workDir) {
  return {
    head: git(workDir, ['rev-parse', 'HEAD']).trim(),
    branch: git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    porcelain: git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim(),
    diffUnstaged: git(workDir, ['diff']).trim(),
    diffStaged: git(workDir, ['diff', '--cached']).trim(),
    trackedBytes: existsSync(join(workDir, 'tracked-dirty.txt')) ? readFileSync(join(workDir, 'tracked-dirty.txt'), 'utf8') : null,
  };
}

test('§22.1/2/16/18 — v1: dirty registered checkout admitted, task executes isolated, completes, settles, and cleans up WITHOUT ever touching the dirty user checkout; local task branch retained', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir, workspaceRoot }) => {
  const project = boundProject(workDir);

  // Dirty the REGISTERED checkout the way the old shared-worktree guard
  // would have refused outright — the whole point of P24.3.
  writeFileSync(join(workDir, 'tracked-dirty.txt'), 'staged\n');
  git(workDir, ['add', 'tracked-dirty.txt']);
  writeFileSync(join(workDir, 'tracked-dirty.txt'), 'staged\nplus unstaged edit\n');
  writeFileSync(join(workDir, 'untracked.txt'), 'never tracked\n');
  const before = userSnapshot(workDir);
  assert.notEqual(before.porcelain, '', 'sanity: registered checkout really is dirty');

  const { commandId, taskId, readBack } = await submitTask({
    agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } },
    isolation: { ensureTaskWorkspace, taskWorkspaceRoot: workspaceRoot },
  });

  const ws = readBack.context.taskWorkspace;
  assert.ok(ws, 'admission stamped a v1 workspace binding');
  assert.equal(ws.isolation_version, 1);
  assert.ok(existsSync(ws.workspace_path));
  assert.equal(git(ws.workspace_path, ['status', '--porcelain']).trim(), '', 'isolated worktree started clean, independent of the dirty registered checkout');

  const afterAdmission = userSnapshot(workDir);
  assert.deepEqual(afterAdmission, before, 'admission never touched the registered checkout');

  // The "task" writes its result INSIDE the isolated workspace only.
  writeFileSync(join(ws.workspace_path, 'task-result.txt'), 'isolated task output\n');

  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const taskBranch = ws.workspace_path && readBack.context.taskBranch.task_branch;

  // The one result commit contains ONLY the isolated task's own file — the
  // dirty registered-checkout files were never staged/committed anywhere.
  const resultSha = git(workDir, ['rev-parse', taskBranch]).trim();
  const committedFiles = git(workDir, ['ls-tree', '-r', '--name-only', resultSha]).trim().split('\n');
  assert.ok(committedFiles.includes('task-result.txt'));
  assert.equal(committedFiles.includes('tracked-dirty.txt'), false, 'the registered checkout\'s dirty tracked file never leaked into the result commit');
  assert.equal(committedFiles.includes('untracked.txt'), false, 'the registered checkout\'s untracked file never leaked into the result commit');

  assert.equal(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), false, 'isolated worktree removed after settlement');
  assert.equal(git(workDir, ['rev-parse', taskBranch]).trim(), resultSha, 'local task branch retained at the result commit after cleanup');
  assert.equal(outcome.result.branchRestore, undefined, 'a v1 task never runs the legacy restoreOriginalBranch path');

  const afterCleanup = userSnapshot(workDir);
  assert.deepEqual(afterCleanup, before, 'the registered checkout is STILL untouched after the full lifecycle completes');

  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
}));

test('§22.19/22 — failed task: zero commit/push, and the (unpublished, dirty) isolated workspace is retained rather than force-cleaned', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir, workspaceRoot }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitTask({
    agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } },
    isolation: { ensureTaskWorkspace, taskWorkspaceRoot: workspaceRoot },
  });
  const ws = readBack.context.taskWorkspace;
  assert.ok(ws);
  // Simulate partial, uncommitted work left behind by a task that then fails.
  writeFileSync(join(ws.workspace_path, 'partial-output.txt'), 'never finished\n');

  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project],
    createRuntime: () => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'error', message: 'boom', code: 'SCRIPTED_FAILURE' }] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    }),
    enableRepoHistoryMaterialization: false,
  });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.equal(git(workDir, ['ls-remote', bareDir, readBack.context.taskBranch.task_branch]).trim(), '', 'the task branch was never pushed to the remote');

  // Cleanup is conservative: the dirty, unpublished workspace is retained,
  // never force-removed just because the task failed.
  assert.ok(outcome.result.workspaceCleanup);
  assert.notEqual(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), true, 'workspace retained, evidence preserved');
  assert.equal(existsSync(join(ws.workspace_path, 'partial-output.txt')), true);
}));

test('§22.27 — a legacy task (isolation not wired on the controller) is byte-for-byte unaffected: no taskWorkspace stamped, legacy restore path runs', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } } });
  assert.equal(readBack.context.taskWorkspace, undefined, 'no isolation deps supplied -> no workspace binding, exactly pre-P24.3 shape');
  writeFileSync(join(workDir, 'CHANGE.md'), 'legacy path work\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.ok(outcome.result.branchRestore, 'legacy path still runs restoreOriginalBranch, exactly as before P24.3B');
  assert.equal(outcome.result.workspaceCleanup, undefined, 'legacy path never invokes workspace cleanup');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, readBack.context.taskBranch.task_branch]).trim().split(/\s+/);
  assert.notEqual(remoteSha, baseSha);
}));

// ---------------------------------------------------------------------------
// Layer 3 — real createP5ProductionComposition(): provider cwd routing +
// project-keyed-cache safety, using a spy PM backend registry.
// ---------------------------------------------------------------------------

function spyBackendRegistry() {
  const capturedRepoPaths = [];
  const backend = {
    inspect: (profile) => Object.freeze({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind }),
    resolve: (profile, { project }) => {
      capturedRepoPaths.push(project.repo_path);
      return Object.freeze({ name: `production:${profile.product}:${profile.id}`, async decide() { return { type: 'finish', output: 'ok', data: { type: 'single_result' } }; } });
    },
    list: () => [],
  };
  return { backend, capturedRepoPaths };
}

async function withComposition({ project, backend, deps = {} }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3b-composition-'));
  try {
    const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
    const profile = { id: 'pm-1', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
    const config = {
      postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [project], profiles: [profile],
      telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: project.id, pollIntervalMs: 10 },
      coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
      pm: { scriptedDecisions: null },
    };
    let registered = null;
    const coordination = { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async (v) => { registered = v; } };
    const owner = { close: async () => {}, claimNotifications: async () => [] };
    const composition = await createP5ProductionComposition(config, { pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }), ...deps });
    try {
      await fn({ composition, profile, config, getRegisteredWork: () => registered });
    } finally {
      await composition.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('§22.3/29 — real composition: provider cwd equals task.workspace_path for a v1 task (both at admission-time profile resolution and at execution time), never project.repo_path', async () => {
  await withRealStack(async ({ agentBusRepository: _unused, workDir, workspaceRoot }) => {
    void _unused;
    const project = { id: 'proj-real', repo_path: workDir, default_pm_profile_id: 'pm-1', autonomy: { revision: 1, effects: { BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const { backend, capturedRepoPaths } = spyBackendRegistry();
    await withComposition({ project, backend, deps: { enableTaskWorkspaceIsolation: true, taskWorkspaceRoot: workspaceRoot } }, async ({ composition }) => {
      const commandId = `cmd-${randomUUID()}`;
      await composition.taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'objective', git: { commit: true, push: true } } }, project, profile: composition.profileRegistry.get('pm-1') });
      const taskId = deterministicOwnerId('task', commandId);
      const task = composition.agentBusRepository.getOwnerTask(taskId);
      const ws = task.context.taskWorkspace;
      assert.ok(ws, 'real composition admission also stamps a v1 workspace binding when enableTaskWorkspaceIsolation is set');

      const pmRunId = deterministicOwnerId('pmrun', commandId);
      const handler = new ProductionPmWorkHandler({
        coordinationStore: { completeClaim: async () => {} }, pmRepository: composition.pmRepository, ownerRepository: {},
        taskRepository: composition.agentBusRepository, projects: [project], createRuntime: composition.createRuntime, enableRepoHistoryMaterialization: false,
      });
      await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

      assert.ok(capturedRepoPaths.length >= 1, 'the spy backend was actually invoked');
      for (const cwd of capturedRepoPaths) {
        assert.equal(cwd, ws.workspace_path, 'every backend invocation received the ISOLATED workspace path as cwd, never the registered checkout');
        assert.notEqual(cwd, project.repo_path);
      }
    });
  });
});

test('§22.28 — real composition: omitting the isolation deps (every existing/default deployment) leaves cwd = project.repo_path, exactly pre-P24.3 behavior', async () => {
  await withRealStack(async ({ workDir }) => {
    const project = { id: 'proj-real-legacy', repo_path: workDir, default_pm_profile_id: 'pm-1', autonomy: { revision: 1, effects: { BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const { backend, capturedRepoPaths } = spyBackendRegistry();
    await withComposition({ project, backend }, async ({ composition }) => {
      const commandId = `cmd-${randomUUID()}`;
      await composition.taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'objective', git: { commit: true, push: true } } }, project, profile: composition.profileRegistry.get('pm-1') });
      const taskId = deterministicOwnerId('task', commandId);
      const task = composition.agentBusRepository.getOwnerTask(taskId);
      assert.equal(task.context.taskWorkspace, undefined);
      assert.ok(capturedRepoPaths.length >= 1);
      for (const cwd of capturedRepoPaths) assert.equal(cwd, project.repo_path);
    });
  });
});

test('§22.4/26 — real composition: workflowRunnerForProject never reuses a cached instance across two different task workspaces (project-keyed-cache fix), but DOES reuse one legacy instance for the same project', async () => {
  await withRealStack(async ({ workDir }) => {
    const project = { id: 'proj-cache', repo_path: workDir, default_pm_profile_id: 'pm-1', autonomy: { revision: 1, effects: {} } };
    const { backend } = spyBackendRegistry();
    await withComposition({ project, backend }, async ({ composition }) => {
      const legacyA = composition.workflowRunnerForProject(project, null);
      const legacyB = composition.workflowRunnerForProject(project, {});
      assert.equal(legacyA, legacyB, 'two legacy calls for the SAME project share one cached runner, unchanged pre-P24.3 behavior');

      const ctxTaskA = { taskWorkspace: { isolation_version: 1, workspace_path: join(workDir, '..', 'ws-task-a'), repository_common_dir: '/x/.git' } };
      const ctxTaskB = { taskWorkspace: { isolation_version: 1, workspace_path: join(workDir, '..', 'ws-task-b'), repository_common_dir: '/x/.git' } };
      const runnerA = composition.workflowRunnerForProject(project, ctxTaskA);
      const runnerB = composition.workflowRunnerForProject(project, ctxTaskB);
      assert.notEqual(runnerA, runnerB, 'two different task workspaces for the SAME project never share a cached runner');
      assert.notEqual(runnerA, legacyA, 'a v1 task never reuses the legacy project-wide cached runner either');
    });
  });
});
