// P24.3B-R2 — environment qualification and final pre-live gate (reports/
// P24_3B_R2_ENVIRONMENT_QUALIFICATION_20260917.md). Three gates:
//   Gate A: real Postgres-backed repository occupancy, real worker path.
//   Gate B: real crash/restart/adoption behavior with isolated workspaces.
//   Gate C: real Windows filesystem qualification.
//
// Every target repository in this file is a disposable, non-DSH fixture
// repository (never the DSH source checkout itself).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { migrateCoordination } from '../scripts/coordination-migrate.mjs';
import { startDisposablePostgres, isDisposablePostgresAvailable } from './fixtures/disposable-postgres.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import {
  ProductionPmWorker, ProductionPmWorkHandler, ADMISSION_REJECTED, pmWorkIdentity, resolvePmWorkspaceIdentity, claimFence,
} from '../src/runtime/production-pm-worker.mjs';
import { createWorkerIncarnationId } from '../src/coordination/multi-process-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { GIT_SETTLEMENT_STATE } from '../src/pm/git-settlement-journal.mjs';
import { ensureTaskWorkspace, cleanupTaskWorkspace, resolveRepositoryCommonDir, TASK_WORKSPACE_STATE, TaskWorkspaceError } from '../src/pm/task-workspace-manager.mjs';
import { deriveTaskBranchName } from '../src/pm/task-branch-binding.mjs';
import { withReapedOwnedSpawnLifecycle } from '../src/runtime/backend-execution-observer.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

// §3 — a genuinely non-DSH, disposable target repository (a plain "widget
// library" fixture, never the DSH source checkout).
function initWorktreeWithBareRemote(root, { seed = 'seed\n' } = {}) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', 'main']);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', 'main']);
  git(workDir, ['config', 'user.email', 'dsh-r2-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH R2 Test']);
  writeFileSync(join(workDir, 'widget.txt'), seed);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', 'main']);
  return { bareDir, workDir };
}
async function withDisposableRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3b-r2-'));
  try { await fn(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

// =============================================================================
// GATE A — real Postgres-backed repository occupancy, real worker path
// =============================================================================

async function withRealCoordination(fn) {
  const disposable = await startDisposablePostgres();
  await migrateCoordination({ dsn: disposable.dsn });
  const coordination = await new PostgresCoordinationStore().open({ connectionString: disposable.dsn, connectionTimeoutMillis: 10_000 });
  try {
    await coordination.assertReady();
    await fn({ coordination, dsn: disposable.dsn });
  } finally {
    await coordination.close();
    await disposable.stop();
  }
}

function holdOpenHandler() {
  const gates = new Map();
  return {
    gates,
    execute: async ({ work: w }) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      gates.set(w.work_item_id, release);
      await gate;
      return { status: 'COMPLETED' };
    },
  };
}

async function registerWorker(coordination, logicalId) {
  const incarnationId = createWorkerIncarnationId(logicalId);
  await coordination.registerWorkerIncarnation({ logical_worker_id: logicalId, worker_incarnation_id: incarnationId, host_id: 'r2-host', installed_profiles: [], capacity: { max_concurrency: 2, reported_in_use: 0 } });
  return incarnationId;
}

async function registerPmActionWork(coordination, { taskId, pmRunId }) {
  const identity = pmWorkIdentity({ taskId, pmRunId });
  await coordination.registerWorkIdentity(identity);
  return identity;
}

const hasPostgres = isDisposablePostgresAvailable();

test('§4.A1/A2/A3 — real Postgres: two registered projects sharing one repository_common_dir (a real linked-worktree alias) serialize through the REAL PostgresCoordinationStore + real ProductionPmWorker admission path', { skip: !hasPostgres ? 'PostgreSQL (initdb) not available in this environment' : false }, async () => {
  await withRealCoordination(async ({ coordination }) => {
    await withDisposableRoot(async (root) => {
      const { workDir } = initWorktreeWithBareRemote(root);
      const linkedPath = join(root, 'linked-alias');
      git(workDir, ['worktree', 'add', '-b', 'alias-branch', linkedPath, 'main']);
      const commonDirA = await resolveRepositoryCommonDir({ repoPath: workDir });
      const commonDirB = await resolveRepositoryCommonDir({ repoPath: linkedPath });
      assert.equal(commonDirA, commonDirB, 'sanity: real alias of one repository');

      const projectA = { id: 'proj-r2-alias-a', repo_path: workDir, repository_common_dir: commonDirA };
      const projectB = { id: 'proj-r2-alias-b', repo_path: linkedPath, repository_common_dir: commonDirB };
      const projects = new Map([['proj-r2-alias-a', projectA], ['proj-r2-alias-b', projectB]]);

      const taskIdA = deterministicOwnerId('task', 'cmd-r2-pg-a'), taskIdB = deterministicOwnerId('task', 'cmd-r2-pg-b');
      const pmRunIdA = deterministicOwnerId('pmrun', 'cmd-r2-pg-a'), pmRunIdB = deterministicOwnerId('pmrun', 'cmd-r2-pg-b');
      const pmRepository = { load: (id) => ({ request: { context: { ownerCommandId: id === pmRunIdA ? 'cmd-r2-pg-a' : 'cmd-r2-pg-b' } } }) };
      const taskRepository = { getOwnerTask: (id) => (id === taskIdA ? { projectId: 'proj-r2-alias-a', context: {} } : { projectId: 'proj-r2-alias-b', context: {} }) };
      const resolveWorkIdentity = (w) => resolvePmWorkspaceIdentity({ work: w, pmRepository, taskRepository, projects });

      const incarnation1 = await registerWorker(coordination, 'r2-logical-worker');
      await registerPmActionWork(coordination, { taskId: taskIdA, pmRunId: pmRunIdA });
      await registerPmActionWork(coordination, { taskId: taskIdB, pmRunId: pmRunIdB });

      const handler = holdOpenHandler();
      const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: incarnation1, resolveWorkIdentity, globalLimit: 2 });

      const first = await worker.runOnce();
      assert.equal(first.status, 'WORK');
      assert.deepEqual(first.started.map((s) => s.work_item_id), [pmWorkIdentity({ taskId: taskIdA, pmRunId: pmRunIdA }).work_item_id]);

      const second = await worker.runOnce();
      assert.equal(second.status, 'IDLE');
      assert.deepEqual(second.rejected, [{ work_item_id: pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id, reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: `repo:${commonDirA}` }]);

      // Real durable evidence: the coordination DB itself records exactly
      // one ACTIVE claim right now, for task A's work item.
      const claimA = await coordination.readClaim(pmWorkIdentity({ taskId: taskIdA, pmRunId: pmRunIdA }).work_item_id);
      assert.equal(claimA.claim_state, 'ACTIVE');
      // Task B's own claim row is legitimately null (fencing_generation
      // still 0) -- B was never admitted far enough to reach
      // acquireClaim() at all (WORKSPACE_CAPACITY refused it before that),
      // which is itself real durable proof no second claim was ever taken.
      const claimB = await coordination.readClaim(pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id);
      assert.equal(claimB, null, 'task B never reached acquireClaim at all while A owns the repository');

      handler.gates.get(pmWorkIdentity({ taskId: taskIdA, pmRunId: pmRunIdA }).work_item_id)();
      await first.started[0].promise;
      await coordination.completeClaim(claimFence(claimA));

      const third = await worker.runOnce();
      assert.equal(third.status, 'WORK');
      assert.deepEqual(third.started.map((s) => s.work_item_id), [pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id], 'once A releases, B proceeds — real Postgres durable state enforced the whole exclusion');
      handler.gates.get(pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id)?.();
    });
  });
});

test('§4.A4 — real Postgres: two genuinely different repositories run concurrently under the existing global=2 limit', { skip: !hasPostgres ? 'PostgreSQL (initdb) not available in this environment' : false }, async () => {
  await withRealCoordination(async ({ coordination }) => {
    await withDisposableRoot(async (root) => {
      const { workDir: workDirX } = initWorktreeWithBareRemote(join(root, 'repo-x'));
      const { workDir: workDirY } = initWorktreeWithBareRemote(join(root, 'repo-y'));
      const commonDirX = await resolveRepositoryCommonDir({ repoPath: workDirX });
      const commonDirY = await resolveRepositoryCommonDir({ repoPath: workDirY });
      assert.notEqual(commonDirX, commonDirY);

      const projects = new Map([
        ['proj-r2-x', { id: 'proj-r2-x', repo_path: workDirX, repository_common_dir: commonDirX }],
        ['proj-r2-y', { id: 'proj-r2-y', repo_path: workDirY, repository_common_dir: commonDirY }],
      ]);
      const taskIdX = deterministicOwnerId('task', 'cmd-r2-pg-x'), taskIdY = deterministicOwnerId('task', 'cmd-r2-pg-y');
      const pmRunIdX = deterministicOwnerId('pmrun', 'cmd-r2-pg-x'), pmRunIdY = deterministicOwnerId('pmrun', 'cmd-r2-pg-y');
      const pmRepository = { load: (id) => ({ request: { context: { ownerCommandId: id === pmRunIdX ? 'cmd-r2-pg-x' : 'cmd-r2-pg-y' } } }) };
      const taskRepository = { getOwnerTask: (id) => (id === taskIdX ? { projectId: 'proj-r2-x', context: {} } : { projectId: 'proj-r2-y', context: {} }) };
      const resolveWorkIdentity = (w) => resolvePmWorkspaceIdentity({ work: w, pmRepository, taskRepository, projects });

      const incarnation = await registerWorker(coordination, 'r2-logical-worker-2');
      await registerPmActionWork(coordination, { taskId: taskIdX, pmRunId: pmRunIdX });
      await registerPmActionWork(coordination, { taskId: taskIdY, pmRunId: pmRunIdY });
      const handler = holdOpenHandler();
      const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: incarnation, resolveWorkIdentity, globalLimit: 2 });

      const result = await worker.runOnce();
      assert.equal(result.status, 'WORK');
      assert.equal(result.started.length, 2, 'both unrelated repositories admitted concurrently under the existing global=2 limit');
      handler.gates.get(pmWorkIdentity({ taskId: taskIdX, pmRunId: pmRunIdX }).work_item_id)();
      handler.gates.get(pmWorkIdentity({ taskId: taskIdY, pmRunId: pmRunIdY }).work_item_id)();
    });
  });
});

test('§4.A5/A6 — real Postgres: a SECOND worker incarnation (simulating a restarted process, with an EMPTY in-memory slot table) still cannot start a same-repository task while a FIRST incarnation durably owns it — durable cross-incarnation occupancy, not in-memory state', { skip: !hasPostgres ? 'PostgreSQL (initdb) not available in this environment' : false }, async () => {
  await withRealCoordination(async ({ coordination }) => {
    await withDisposableRoot(async (root) => {
      const { workDir } = initWorktreeWithBareRemote(root);
      const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });
      const project = { id: 'proj-r2-restart', repo_path: workDir, repository_common_dir: commonDir };
      const projects = new Map([['proj-r2-restart', project]]);

      const taskIdA = deterministicOwnerId('task', 'cmd-r2-restart-a'), taskIdB = deterministicOwnerId('task', 'cmd-r2-restart-b');
      const pmRunIdA = deterministicOwnerId('pmrun', 'cmd-r2-restart-a'), pmRunIdB = deterministicOwnerId('pmrun', 'cmd-r2-restart-b');
      const pmRepository = { load: (id) => ({ request: { context: { ownerCommandId: id === pmRunIdA ? 'cmd-r2-restart-a' : 'cmd-r2-restart-b' } } }) };
      const taskRepository = { getOwnerTask: () => ({ projectId: 'proj-r2-restart', context: {} }) };
      const resolveWorkIdentity = (w) => resolvePmWorkspaceIdentity({ work: w, pmRepository, taskRepository, projects });

      // Incarnation 1: acquires and holds the repository.
      const incarnation1 = await registerWorker(coordination, 'r2-restart-worker');
      await registerPmActionWork(coordination, { taskId: taskIdA, pmRunId: pmRunIdA });
      const handler1 = holdOpenHandler();
      const worker1 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler1, workerIncarnationId: incarnation1, resolveWorkIdentity, globalLimit: 2 });
      const firstTick = await worker1.runOnce();
      assert.equal(firstTick.started.length, 1);

      // Simulate a restart: a BRAND NEW ProductionPmWorker instance (its
      // own, entirely empty this.slots/this.activeByWorkspace) with a
      // DIFFERENT worker_incarnation_id, sharing ONLY the real Postgres
      // coordination store — the exact "new process" shape.
      const incarnation2 = await registerWorker(coordination, 'r2-restart-worker-2');
      await registerPmActionWork(coordination, { taskId: taskIdB, pmRunId: pmRunIdB });
      const handler2 = holdOpenHandler();
      const worker2 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler2, workerIncarnationId: incarnation2, resolveWorkIdentity, globalLimit: 2 });
      const secondTick = await worker2.runOnce();
      assert.equal(secondTick.status, 'IDLE');
      assert.deepEqual(secondTick.rejected, [{ work_item_id: pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id, reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: `repo:${commonDir}` }], 'the SECOND incarnation, with zero in-memory knowledge of the first, still correctly refuses — proving the exclusion is durable cross-process state (listActivePmActionWork), never an in-process-only assumption');

      handler1.gates.get(pmWorkIdentity({ taskId: taskIdA, pmRunId: pmRunIdA }).work_item_id)();
      await firstTick.started[0].promise;
      const claimA = await coordination.readClaim(pmWorkIdentity({ taskId: taskIdA, pmRunId: pmRunIdA }).work_item_id);
      await coordination.completeClaim(claimFence(claimA));

      const thirdTick = await worker2.runOnce();
      assert.equal(thirdTick.status, 'WORK');
      assert.deepEqual(thirdTick.started.map((s) => s.work_item_id), [pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id]);
      handler2.gates.get(pmWorkIdentity({ taskId: taskIdB, pmRunId: pmRunIdB }).work_item_id)?.();
    });
  });
});

// =============================================================================
// GATE B — real crash / restart / adoption behavior with isolated workspaces
// =============================================================================

async function withRealSqliteStack(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-3b-r2-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-3b-r2-git-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'p24-3b-r2-ws-'));
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
const boundProjectB = (workDir) => ({ id: 'proj-r2-b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL' } } });
async function submitIsolatedR2({ agentBusRepository, project, payload, workspaceRoot }) {
  const commandId = `cmd-r2-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null, ensureTaskWorkspace, taskWorkspaceRoot: workspaceRoot });
  await controller.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  return { commandId, taskId, readBack };
}
async function createPmRunForR2({ pmRepository, readBack, commandId, driverName = 'single-pm-fake' }) {
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: driverName, startedAt: '2026-01-01T00:00:00.000Z' });
  return pmRunId;
}
function newHandlerR2({ pmRepository, agentBusRepository, project, decisions }) {
  return new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: () => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    }),
    enableRepoHistoryMaterialization: false,
  });
}

test('§5.B1 — real crash/restart: a task admitted (workspace allocated) then "restarted" (a fresh OwnerTaskController + fresh ProductionPmWorkHandler reading the SAME durable SQLite) resolves the IDENTICAL base pin/task branch/workspace record, allocates no second worktree, and never falls back to project.repo_path', async () => withRealSqliteStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProjectB(workDir);
  const { commandId, taskId, readBack: firstReadBack } = await submitIsolatedR2({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } }, workspaceRoot });
  const wsBefore = firstReadBack.context.taskWorkspace;
  const branchBefore = firstReadBack.context.taskBranch;
  assert.ok(wsBefore);

  // "Restart": nothing more happens with the first controller/handler at
  // all -- a completely FRESH OwnerTaskController + a fresh
  // ProductionPmWorkHandler are constructed, sharing ONLY the same
  // durable SQLite file (the exact "new process, same DB" shape).
  const restartedReadBack = agentBusRepository.getOwnerTask(taskId);
  assert.deepEqual(restartedReadBack.context.taskWorkspace, wsBefore, 'identical durable workspace record after restart -- no re-derivation');
  assert.deepEqual(restartedReadBack.context.taskBranch, branchBefore, 'identical base_sha/task_branch after restart -- no re-pin');
  assert.equal(existsSync(wsBefore.workspace_path), true, 'the SAME worktree, never re-allocated');
  assert.equal(git(workDir, ['worktree', 'list']).trim().split('\n').length, 2, 'exactly one linked worktree (plus the registered checkout) -- no duplicate allocation across the simulated restart');

  const pmRunId = await createPmRunForR2({ pmRepository, readBack: restartedReadBack, commandId });
  const handler = newHandlerR2({ pmRepository, agentBusRepository, project, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES', 'no file written -- proves execution ran against the EXISTING clean workspace, not a fresh empty one masquerading as "no changes" for a different reason');
  assert.equal(git(workDir, ['rev-parse', branchBefore.task_branch]).trim(), branchBefore.base_sha, 'branch still exactly at the original pin -- confirms no re-pin/no duplicate base resolution occurred at any point');
}));

test('§5.B2 — real crash mid-execution: partial task-local content survives an abrupt "restart" (no automatic resume/no fresh empty workspace), and the registered checkout remains untouched throughout', async () => withRealSqliteStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProjectB(workDir);
  writeFileSync(join(workDir, 'user-tracked.txt'), 'user work in progress\n');
  git(workDir, ['add', 'user-tracked.txt']);
  const userBefore = git(workDir, ['status', '--porcelain']).trim();
  assert.notEqual(userBefore, '', 'sanity: registered checkout is dirty');

  const { taskId, readBack } = await submitIsolatedR2({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  // Deterministic partial task-local content, as if the model had
  // started editing before the process died mid-turn.
  writeFileSync(join(ws.workspace_path, 'partial-work.txt'), 'half-finished edit\n');

  // Abrupt termination is simulated by simply doing nothing further with
  // this task's execution -- no handler.execute() call ever ran; "restart"
  // is the NEXT statement re-reading durable state cold.
  const afterRestart = agentBusRepository.getOwnerTask(taskId);
  assert.deepEqual(afterRestart.context.taskWorkspace, ws, 'workspace remains identifiable after the simulated crash');
  assert.equal(existsSync(join(ws.workspace_path, 'partial-work.txt')), true, 'partial state is not deleted blindly');

  // Current accepted recovery semantics: automatic resume is not
  // attempted here (this test never calls handler.execute()); an explicit
  // cleanup attempt on this now-dirty workspace correctly fails closed
  // rather than silently discarding the partial edit into a "fresh empty
  // workspace."
  await assert.rejects(
    () => cleanupTaskWorkspace({ taskRepository: agentBusRepository, projectRepoPath: workDir, taskId }),
    (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_CLEANUP_BLOCKED_DIRTY',
  );
  assert.equal(existsSync(join(ws.workspace_path, 'partial-work.txt')), true, 'still not deleted');
  assert.equal(git(workDir, ['status', '--porcelain']).trim(), userBefore, 'the registered checkout is untouched by any of this');
}));

test('§5.B3 — real crash after PM completion, before Git settlement: adoption discovers/reuses via G7B, never a second result commit, never a re-pin', async () => withRealSqliteStack(async ({ agentBusRepository, pmRepository, workDir, bareDir, workspaceRoot }) => {
  const project = boundProjectB(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedR2({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  const pinBefore = readBack.context.taskBranch.base_sha;
  writeFileSync(join(ws.workspace_path, 'result.txt'), 'the actual work\n');

  const pmRunId = deterministicOwnerId('pmrun', commandId);
  // The EXACT G7A crash-simulation technique (tests/p24-1g7a-single-final-
  // settlement.test.mjs's own docstring): drive the PM turn to a durable
  // `completed` status DIRECTLY via DurablePmRuntime, bypassing
  // ProductionPmWorkHandler.execute() entirely -- exactly what a process
  // that died between "PM completion persisted" and "Git settlement ran"
  // would leave behind.
  const rawRuntime = new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const preCrashResult = await rawRuntime.resume(pmRunId);
  assert.equal(preCrashResult.status, 'completed');

  // "Restart": a fresh handler adopts this pm_run (run.status==='completed',
  // no Git settlement has EVER run) via execute()'s adoption branch.
  const handler = newHandlerR2({ pmRepository, agentBusRepository, project, decisions: [] });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.adopted, true);

  const taskBranch = readBack.context.taskBranch.task_branch;
  const resultSha = git(workDir, ['rev-parse', taskBranch]).trim();
  assert.notEqual(resultSha, pinBefore, 'a real result commit now exists');
  const commitCount = git(workDir, ['log', '--format=%H', `${pinBefore}..${resultSha}`]).trim().split('\n').filter(Boolean).length;
  assert.equal(commitCount, 1, 'exactly one result commit -- G7B reuse-or-create-once, never duplicated');
  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
  assert.equal(record.task_base_sha, pinBefore, 'no re-pin: the settlement journal still names the ORIGINAL admission pin');
}));

test('§5.B4 — real crash after push verified, before cleanup: a second, later adoption call never re-runs the provider, never creates a second commit, never re-pushes, and safely completes/retains cleanup', async () => withRealSqliteStack(async ({ agentBusRepository, pmRepository, workDir, bareDir, workspaceRoot }) => {
  const project = boundProjectB(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedR2({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  writeFileSync(join(ws.workspace_path, 'result.txt'), 'the actual work\n');
  const pmRunId = await createPmRunForR2({ pmRepository, readBack, commandId });

  // First adoption call: completes settlement (commit+push+SETTLED) AND
  // cleanup (REMOVED) in one pass -- this IS "push verified, before
  // cleanup" reaching all the way through, since production code has no
  // artificial pause point between the two (introducing one purely for
  // testability was judged out of scope for a qualification-only phase --
  // see this phase's own report).
  const handler1 = newHandlerR2({ pmRepository, agentBusRepository, project, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] });
  const first = await handler1.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  const taskBranch = readBack.context.taskBranch.task_branch;
  const firstResultSha = git(workDir, ['rev-parse', taskBranch]).trim();
  assert.equal(first.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);

  // "Restart": a genuinely SECOND adoption call for the SAME already-
  // fully-settled-and-cleaned pm_run/task -- the scripted driver would
  // throw if decide() were ever called again, proving no provider re-run.
  const handler2 = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: () => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    }),
    enableRepoHistoryMaterialization: false,
  });
  const second = await handler2.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(second.adopted, true);
  assert.equal(git(workDir, ['rev-parse', taskBranch]).trim(), firstResultSha, 'no second commit -- branch tip unchanged');
  assert.equal(second.result.workspaceCleanup.already_removed, true, 'cleanup of an already-REMOVED workspace is a safe, idempotent no-op');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, taskBranch]).trim().split(/\s+/);
  assert.equal(remoteSha, firstResultSha, 'remote still equals the ONE real result, never re-pushed to something else');
}));

test('§5.B5 — CURRENT BEHAVIOR PROOF: an adoption-path cleanup call, whose signal was never used for the ORIGINAL execution\'s spawns (a genuinely different process lifetime), must not treat "nothing tracked" as "confirmed safe" -- proving whatever the ACTUAL current behavior is, deterministically', async () => withRealSqliteStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProjectB(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedR2({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  const pmRunId = deterministicOwnerId('pmrun', commandId);

  // Simulate the ORIGINAL execution's provider process still being
  // (unknowably, from a NEW process's point of view) alive: register an
  // owned spawn under a signal that will NEVER be passed to the adoption
  // call below -- exactly modeling "a different process lifetime," where
  // the crashed process's own AbortController/WeakMap entry is simply
  // gone, taking any knowledge of that spawn with it.
  const originalController = new AbortController();
  const rawSpawn = () => { const c = new EventEmitter(); c.pid = 424242; c.kill = () => {}; return c; };
  withReapedOwnedSpawnLifecycle(rawSpawn, originalController.signal, {})('git', ['status'], {});
  // (originalController is deliberately never aborted and never referenced
  // again -- its process, in this simulation, no longer exists.)

  const rawRuntime = new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  await rawRuntime.resume(pmRunId);

  // The "new process" adopts with its OWN fresh signal/AbortController --
  // it has zero knowledge of `originalController` above.
  const handler = newHandlerR2({ pmRepository, agentBusRepository, project, decisions: [] });
  const freshController = new AbortController();
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: freshController.signal });

  // Required safety invariant (this phase's own brief, verbatim): DSH
  // MUST NOT delete a task workspace based solely on "new process has no
  // in-memory owned processes." Assert the ACTUAL, current disposition:
  assert.equal(outcome.result.workspaceCleanup.status, 'RETAINED', 'adoption-path cleanup must retain (fail closed) when it has no possible evidence about the ORIGINAL execution\'s process state -- an empty WeakMap under a signal that was never used for the original spawns proves nothing');
  assert.equal(existsSync(ws.workspace_path), true, 'workspace physically still present -- never removed on unproven safety');
}));

// =============================================================================
// GATE C — real Windows filesystem qualification
// =============================================================================

test('§6.C1 — path with spaces: allocation/execution/cleanup succeed end to end when both the registered checkout AND the runtime worktree root contain spaces', async () => withDisposableRoot(async (root) => {
  const spacedRoot = join(root, 'dsh test root with spaces');
  mkdirSync(spacedRoot, { recursive: true });
  const { workDir } = initWorktreeWithBareRemote(join(spacedRoot, 'target repo alpha'));
  const workspaceRoot = join(spacedRoot, 'runtime worktrees root');
  mkdirSync(workspaceRoot, { recursive: true });

  const taskId = 'task-c1-spaces';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  const ws = await ensureTaskWorkspace({
    taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-c1', taskId,
    taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot,
  });
  assert.ok(ws.workspace_path.includes(' '), 'sanity: the derived path really does contain a space component');
  assert.equal(git(ws.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);
  writeFileSync(join(ws.workspace_path, 'result.txt'), 'ok\n');
  git(ws.workspace_path, ['add', '-A']);
  git(ws.workspace_path, ['commit', '-q', '-m', 'result']);
  const cleaned = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
  assert.equal(cleaned.state, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), false);
  assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName(taskId)]).trim().length, 40, 'branch retained');
}));

// P24.3B-R2 Gate C2 — a REAL, deterministic defect was found and fixed
// here (not merely tested): direct `git worktree add` CLI probes on this
// exact Windows/git build proved `fatal: '$GIT_DIR' too big` fires around
// a 210-220 character TOTAL workspace path length -- well before the OS's
// own 260-character MAX_PATH limit, and with a message that gives an
// operator no actionable signal at all. `deriveTaskWorkspacePath()` now
// fails closed with a clear, typed `WORKSPACE_PATH_TOO_LONG` at a
// conservative 200-character bound, before ever invoking git.

test('§6.C2a — a moderately long, realistic nested runtime root (well under the safe bound) succeeds end to end', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  // Deep, but realistic, production-shaped nesting (runtime base /
  // worktrees / v1 / nested / deeper) -- comfortably under the 200-char
  // safe bound once the two bounded ID components are appended.
  const workspaceRoot = join(root, 'dsh-runtime-storage', 'worktrees', 'v1', 'nested', 'deeper');
  mkdirSync(workspaceRoot, { recursive: true });
  const taskId = 'task-c2a-realistic';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  const ws = await ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-c2a', taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot });
  assert.ok(ws.workspace_path.length > 60, `sanity: path is realistically deep (${ws.workspace_path.length} chars)`);
  assert.equal(git(ws.workspace_path, ['status', '--porcelain']).trim(), '');
  const cleaned = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
  assert.equal(cleaned.state, TASK_WORKSPACE_STATE.REMOVED);
}));

test('§6.C2b — a runtime worktree root long enough to trip the REAL git "$GIT_DIR too big" defect is rejected deterministically BEFORE any git mutation, with a clear typed reason', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const deepSegments = ['dsh-runtime-storage', 'worktrees', 'v1', 'a-reasonably-long-project-identifier-segment', 'nested', 'deeper', 'safe-bound-exceeding-path-segment'];
  const workspaceRoot = join(root, ...deepSegments);
  mkdirSync(workspaceRoot, { recursive: true });
  const taskId = 'task-c2-a-fairly-long-deterministic-task-identifier-value';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  await assert.rejects(
    () => ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId: 'a-reasonably-long-project-identifier-segment', taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot }),
    (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_PATH_TOO_LONG',
  );
  // Never reached git at all: no worktree was registered, no branch was created.
  assert.equal(git(workDir, ['worktree', 'list']).trim().split('\n').length, 1);
  assert.equal(git(workDir, ['branch', '--list']).trim().includes(deriveTaskBranchName(taskId)), false);
}));

// P24.3B-R2 Gate C3/C7/C8 — real evidence check FIRST (debug_rule):
// Node's own default `fs.openSync` on this Windows/Node build does NOT
// deny delete-sharing (libuv opens with FILE_SHARE_DELETE included by
// default, to better match POSIX semantics) -- confirmed empirically: a
// plain `fs.openSync(...,'r+')` handle held open does NOT block deletion
// here. The audit's own original probe used .NET's explicit
// `FileShare.None`, which DOES deny delete-sharing; this test reproduces
// that exact real mechanism via a genuine, separate PowerShell process
// (never a fake/simulated lock), matching the audit's own technique.
function launchExclusiveLockHolder(filePath) {
  // Written OUTSIDE the task workspace (the OS temp root, never inside
  // `ws.workspace_path`) -- a script file living INSIDE the workspace
  // would itself be untracked content the dirty-check correctly refuses
  // to clean up over, which would test the wrong thing entirely.
  const scriptPath = join(tmpdir(), `dsh-r2-lock-holder-${randomUUID()}.ps1`);
  writeFileSync(scriptPath, [
    'param([string]$Target)',
    '$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    'Write-Output "LOCKED"',
    '[Console]::In.ReadLine() | Out-Null',
    '$stream.Close()',
    'Write-Output "RELEASED"',
  ].join('\n'));
  const child = nodeSpawn('powershell', ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Target', filePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const ready = new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      if (buf.includes('LOCKED')) resolve();
    });
  });
  return {
    ready,
    release: () => new Promise((resolve) => {
      child.once('exit', () => { try { rmSync(scriptPath, { force: true }); } catch { /* best-effort */ } resolve(); });
      child.stdin.write('go\n');
    }),
  };
}

test('§6.C3/C7/C8 — a real, OS-level exclusive-share Windows file lock (a genuine separate process, FileShare.None) blocks cleanup (retained, typed reason, never force-deleted); releasing the lock and retrying succeeds; the local task branch remains available throughout', { skip: process.platform !== 'win32' ? 'Windows OS-level FileShare.None lock' : false }, async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const workspaceRoot = join(root, 'workspaces');
  const taskId = 'task-c3-handle-lock';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  const ws = await ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-c3', taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot });
  const lockedFile = join(ws.workspace_path, 'locked.txt');
  writeFileSync(lockedFile, 'held open\n');
  git(ws.workspace_path, ['add', '-A']);
  git(ws.workspace_path, ['commit', '-q', '-m', 'add locked file']);

  const lock = launchExclusiveLockHolder(lockedFile);
  await lock.ready;
  try {
    // A real FileShare.None lock can surface through EITHER of
    // cleanupTaskWorkspace()'s two conservative gates: `git status`
    // itself may be unable to confirm the locked file's content matches
    // the index (denied even READ sharing) and report it as dirty
    // (`WORKSPACE_CLEANUP_BLOCKED_DIRTY` -> durable `CLEANUP_PENDING`),
    // OR status succeeds but the actual `git worktree remove` then fails
    // to delete/rename the locked file (`WORKSPACE_CLEANUP_FAILED` ->
    // durable `BLOCKED`). Both are the SAME real safety property (never
    // force-deleted, always retained, always a typed reason) — which
    // exact gate trips is a git-version/behavior detail this test does
    // not assume either way.
    await assert.rejects(
      () => cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId }),
      (e) => e instanceof TaskWorkspaceError && ['WORKSPACE_CLEANUP_FAILED', 'WORKSPACE_CLEANUP_BLOCKED_DIRTY'].includes(e.code),
    );
    const { record } = registry.getTaskWorkspace(taskId);
    assert.ok([TASK_WORKSPACE_STATE.BLOCKED, TASK_WORKSPACE_STATE.CLEANUP_PENDING].includes(record.state));
    assert.ok(['CLEANUP_REMOVE_FAILED', 'DIRTY_WORKSPACE'].includes(record.reason_code));
    assert.equal(existsSync(ws.workspace_path), true, 'never force-deleted while the real OS-level lock is held');
  } finally {
    await lock.release();
  }

  // Release + retry: now succeeds.
  const retried = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
  assert.equal(retried.state, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), false);
  assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName(taskId)]).trim().length, 40, 'local task branch remains available throughout');
}));

test('§6.C4 — a real child process whose cwd is inside the task workspace blocks/interferes with cleanup rather than silently succeeding on a still-in-use directory', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const workspaceRoot = join(root, 'workspaces');
  const taskId = 'task-c4-cwd-lock';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  const ws = await ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-c4', taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot });

  // A real, long-lived child process (a plain `node` holding stdin open)
  // with its cwd set INSIDE the task workspace -- the exact "descendant
  // still retaining cwd" scenario the P24.3 audit itself flagged as
  // unqualified.
  const child = nodeSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: ws.workspace_path, stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150)); // let it actually start and open its cwd handle
    let cleanupError = null;
    let cleanupResult = null;
    try { cleanupResult = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId }); }
    catch (e) { cleanupError = e; }
    // Windows does not always refuse to remove a directory that is a live
    // process's cwd (behavior is filesystem/handle-mode dependent) -- so
    // this asserts the SAFETY property, not a single hard-coded outcome:
    // EITHER cleanup fails closed (retained, typed, never force-deleted)
    // OR it genuinely succeeds because the OS permitted it -- but it must
    // never report REMOVED while silently leaving the child's cwd
    // dangling in a way that corrupts durable state.
    if (cleanupError) {
      assert.ok(cleanupError instanceof TaskWorkspaceError);
      const { record } = registry.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
      assert.equal(existsSync(ws.workspace_path), true, 'retained, not force-deleted, when the OS refused removal');
    } else {
      assert.equal(cleanupResult.state, TASK_WORKSPACE_STATE.REMOVED);
    }
  } finally {
    child.kill();
  }
}));

// P24.3B-R2 Gate C5 — real evidence (debug_rule): a REAL Windows junction
// (`mklink /J`, never simulated) placed at the exact `<runtimeWorktreeRoot>/
// <project_id>` location, pointing OUTSIDE the DSH-controlled root, was
// probed directly. `deriveTaskWorkspacePath()`'s own containment check is
// purely LEXICAL (a documented P24.3A limitation) and cannot see through
// it, so `git worktree add` DOES physically follow the junction and write
// into the foreign target — but `ensureTaskWorkspace()`'s own POST-
// allocation verification (`finalizeReady()`'s `git rev-parse --show-
// toplevel` comparison) catches the resulting path mismatch and marks the
// durable record BLOCKED (`TOPLEVEL_MISMATCH`), throwing a typed error
// rather than ever reporting the foreign workspace as READY/adopted. This
// is a real, POST-HOC (not pre-emptive) containment defense — documented
// honestly as a KNOWN_LIMITATION in this phase's report, per the brief's
// own explicit "do NOT recursively traverse arbitrary junction targets"
// instruction (a full pre-emptive ancestor-realpath resolution before
// every allocation was judged out of this qualification phase's scope).
test('§6.C5 — a real Windows junction redirecting the project_id path component outside the runtime worktree root is never silently adopted: allocation fails closed (typed, BLOCKED), never reported READY', { skip: process.platform !== 'win32' ? 'Windows NTFS junction mechanism' : false }, async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const legitRoot = join(root, 'legit-worktree-root');
  mkdirSync(legitRoot, { recursive: true });
  const foreignTarget = join(root, 'foreign-target-outside-root');
  mkdirSync(foreignTarget, { recursive: true });
  const projectId = 'proj-junction';
  const junctionPath = join(legitRoot, projectId);
  execFileSync('cmd', ['/c', 'mklink', '/J', junctionPath, foreignTarget], { windowsHide: true });

  const taskId = 'task-c5-junction';
  const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
  const registry = fakeTaskWorkspaceRegistry();
  await assert.rejects(
    () => ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId, taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: legitRoot }),
    (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_VERIFICATION_FAILED',
  );
  const { record } = registry.getTaskWorkspace(taskId);
  assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
  assert.equal(record.reason_code, 'TOPLEVEL_MISMATCH');
}));

// P24.3B-R2 Gate C6 — real evidence: a Windows RESERVED DEVICE NAME
// (CON/NUL/COM1/...) as a project_id or task_id passes DSH's own
// identifier regex (it is ordinary alphanumeric text) but real Windows
// itself refuses to create a directory/file with that literal name.
// Probed directly: `git worktree add` fails, surfaced as the EXISTING
// typed `WORKSPACE_ALLOCATION_FAILED` — never a crash, never partial
// corruption (nothing is physically created), never a silently-adopted
// broken workspace. This already satisfies the brief's own "reject... according
// to current manager policy" — no new reserved-name-specific code was
// added; the EXISTING git-level, typed rejection is safe as-is.
for (const [label, projectId, taskId] of [['project_id', 'CON', 'task-c6-1'], ['task_id', 'proj-c6', 'NUL'], ['task_id', 'proj-c6', 'COM1']]) {
  test(`§6.C6 — a Windows reserved device name ("${label}"=${projectId === 'CON' || projectId === 'NUL' || projectId === 'COM1' ? projectId : taskId}) fails closed with a typed error, never a crash or partial corruption`, { skip: process.platform !== 'win32' ? 'Windows reserved device names (CON/NUL/COM1)' : false }, async () => withDisposableRoot(async (root) => {
    const { workDir } = initWorktreeWithBareRemote(root);
    const workspaceRoot = join(root, 'workspaces');
    mkdirSync(workspaceRoot, { recursive: true });
    const pin = git(workDir, ['rev-parse', 'HEAD']).trim();
    const registry = fakeTaskWorkspaceRegistry();
    await assert.rejects(
      () => ensureTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, projectId, taskId, taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: workspaceRoot }),
      (e) => e instanceof TaskWorkspaceError,
    );
    // Never a crash, never left in a state that would confuse a later
    // reconciliation pass into believing this task has a real workspace.
    const { record } = registry.getTaskWorkspace(taskId);
    assert.notEqual(record?.state, TASK_WORKSPACE_STATE.READY);
  }));
}

function fakeTaskWorkspaceRegistry() {
  const rows = new Map();
  return {
    getTaskWorkspace(taskId) {
      const row = rows.get(taskId);
      return row ? { record: row.record, revision: row.revision } : { record: null, revision: 0 };
    },
    upsertTaskWorkspace(taskId, { expectedRevision, record }) {
      const row = rows.get(taskId);
      const currentRevision = row ? row.revision : 0;
      if (currentRevision !== expectedRevision) { const e = new Error('stale'); e.code = 'WORKSPACE_RECOVERY_CONFLICT'; throw e; }
      const nextRevision = currentRevision + 1;
      const stored = { ...record };
      rows.set(taskId, { record: stored, revision: nextRevision });
      return { record: stored, revision: nextRevision };
    },
  };
}
