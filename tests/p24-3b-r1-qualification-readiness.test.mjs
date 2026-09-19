// P24.3B-R1 — qualification readiness closure (reports/
// P24_3B_R1_QUALIFICATION_READINESS_CLOSURE_20260917.md). Closes four
// gaps left open by P24.3B's own report:
//   Gap 1: Council/Debate isolated-workspace routing, end to end, through
//          the REAL createP5ProductionComposition() stack.
//   Gap 2: an explicit owned-process-tree barrier before cleanup, reusing
//          backend-execution-observer.mjs's EXISTING per-signal tracking
//          (withReapedOwnedSpawnLifecycle/awaitOwnedSpawnReaping) — no new
//          process-supervision subsystem.
//   Gap 3: repository_common_dir occupancy proven through the REAL
//          ProductionPmWorker admission/slot/coordination path, not
//          merely resolvePmWorkspaceIdentity()'s bare return value.
//   Gap 4: a minimum fail-closed capability preflight (submodule/hook/
//          filter) for isolated-workspace activation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { ProductionPmWorkHandler, ProductionPmWorker, ADMISSION_REJECTED, pmWorkIdentity, resolvePmWorkspaceIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { ensureTaskWorkspace, cleanupTaskWorkspace, resolveRepositoryCommonDir, TASK_WORKSPACE_STATE } from '../src/pm/task-workspace-manager.mjs';
import { validateTaskWorkspaceRepositoryCapabilities, TaskWorkspaceCapabilityError } from '../src/pm/task-workspace-capability-preflight.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';
import { TRANSPORT_VERSION } from '../src/artifacts/artifact-transport.mjs';
import { withReapedOwnedSpawnLifecycle, awaitOwnedSpawnReaping } from '../src/runtime/backend-execution-observer.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';

// P24.3B-R2 — several tests below exercise
// `withReapedOwnedSpawnLifecycle`'s internal bounded waits, which use
// `timer.unref()` (correct for a real process, which always has other
// live handles keeping the loop alive regardless of this one timer). In
// a bare `node --test` file with no other live handles, Node can decide
// the event loop is "idle" and end the process before an unref'd timer's
// own callback fires, surfacing as a spurious
// `cancelledByParent`/"Promise resolution is still pending but the event
// loop has already resolved" failure — a bare-test-harness artifact, not
// a production defect. This ref'd interval keeps the loop demonstrably
// non-idle for the file's entire lifetime, which is the real fix (not a
// timing-bound bump, which only widens the same idle-loop window).
const __keepAlive = setInterval(() => {}, 50);
test.after(() => clearInterval(__keepAlive));

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
async function withDisposableRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3b-r1-'));
  try { await fn(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

// =============================================================================
// GAP #4 — capability preflight
// =============================================================================

test('§8.21 — a plain repository (no submodules/hooks/filters) is accepted', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  await assert.doesNotReject(() => validateTaskWorkspaceRepositoryCapabilities({ repoPath: workDir }));
}));

test('§8.22 — a repository with .gitmodules is rejected TASK_WORKSPACE_SUBMODULE_UNSUPPORTED', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  writeFileSync(join(workDir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n');
  await assert.rejects(
    () => validateTaskWorkspaceRepositoryCapabilities({ repoPath: workDir }),
    (e) => e instanceof TaskWorkspaceCapabilityError && e.code === 'TASK_WORKSPACE_SUBMODULE_UNSUPPORTED',
  );
}));

test('§8.23 — a repository with a custom (non-sample) hook is rejected TASK_WORKSPACE_HOOK_UNSUPPORTED', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const hooksDir = git(workDir, ['rev-parse', '--git-path', 'hooks']).trim();
  const hookPath = join(workDir, hooksDir, 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
  try { chmodSync(hookPath, 0o755); } catch { /* not meaningful on this filesystem, harmless */ }
  await assert.rejects(
    () => validateTaskWorkspaceRepositoryCapabilities({ repoPath: workDir }),
    (e) => e instanceof TaskWorkspaceCapabilityError && e.code === 'TASK_WORKSPACE_HOOK_UNSUPPORTED',
  );
}));

test('§8.24 — a repository with a configured, gitattributes-referenced clean/smudge filter is rejected TASK_WORKSPACE_FILTER_UNSUPPORTED', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  git(workDir, ['config', '--local', 'filter.dsh-test-filter.clean', 'cat']);
  git(workDir, ['config', '--local', 'filter.dsh-test-filter.smudge', 'cat']);
  writeFileSync(join(workDir, '.gitattributes'), '*.bin filter=dsh-test-filter\n');
  await assert.rejects(
    () => validateTaskWorkspaceRepositoryCapabilities({ repoPath: workDir }),
    (e) => e instanceof TaskWorkspaceCapabilityError && e.code === 'TASK_WORKSPACE_FILTER_UNSUPPORTED',
  );
}));

test('§8.24b — a repository whose .gitattributes never references filter= is accepted even if an unrelated filter is configured (e.g. machine-wide git-lfs)', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  // A filter DEFINITION existing in effective config (this exact shape is
  // how a machine-wide Git LFS install registers itself at the SYSTEM
  // config level) must never, by itself, reject a repository that never
  // actually assigns it to any path.
  git(workDir, ['config', '--local', 'filter.unused-filter.clean', 'cat']);
  await assert.doesNotReject(() => validateTaskWorkspaceRepositoryCapabilities({ repoPath: workDir }));
}));

test('§8.25/26/27 — a real submission: capability rejection happens BEFORE any workspace allocation, never mutates the checkout, and legacy (non-isolated) submission for the SAME repository condition is entirely unaffected', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  // Committed (clean tree) so the LEGACY submission below can only ever
  // fail for its own pre-existing reasons (there are none here) -- never
  // because of ordinary dirtiness, which would confound this proof.
  writeFileSync(join(workDir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'add submodule declaration']);
  const before = git(workDir, ['status', '--porcelain']).trim();
  const beforeHead = git(workDir, ['rev-parse', 'HEAD']).trim();

  const store = new SqlitePersistenceStore();
  await store.open({ path: join(root, 'x.db') }); await store.migrate();
  const agentBusRepository = new AgentBusRepository({ store });
  const project = { id: 'proj-submodule', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL' } } };
  try {
    const isolatedController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, ensureTaskWorkspace, taskWorkspaceRoot: join(root, 'workspaces') });
    await assert.rejects(
      () => isolatedController.submit({ command: { command_id: `cmd-${randomUUID()}`, client_kind: 'LOCAL', payload: { body: 'x', git: { commit: true, push: true } } }, project, profile: { id: 'pm-1' } }),
      (e) => e.code === 'TASK_WORKSPACE_SUBMODULE_UNSUPPORTED',
    );
    assert.equal(existsSync(join(root, 'workspaces')), false, 'no workspace root content was ever created — rejection happened before any allocation attempt');
    assert.equal(git(workDir, ['status', '--porcelain']).trim(), before);
    assert.equal(git(workDir, ['rev-parse', 'HEAD']).trim(), beforeHead);

    // Legacy (isolation NOT wired) admission for the IDENTICAL repository
    // condition is completely unaffected by this new gate — the existing
    // shared-worktree admission either succeeds or fails for its own
    // pre-existing reasons only, never because of the new preflight.
    const legacyController = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
    await legacyController.submit({ command: { command_id: `cmd-${randomUUID()}`, client_kind: 'LOCAL', payload: { body: 'y', git: { commit: true, push: true } } }, project, profile: { id: 'pm-1' } });
  } finally {
    await store.close();
  }
}));

// =============================================================================
// GAP #2 — owned-process-tree cleanup barrier
// =============================================================================

function realCreateRuntimeFactory({ pmRepository, decisions } = {}) {
  return () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
}

async function withProcessBarrierStack(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-3b-r1-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-3b-r1-git-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'p24-3b-r1-ws-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') }); await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const pmRepository = new PmRepository({ store });
    const { workDir } = initWorktreeWithBareRemote(gitRoot);
    await fn({ agentBusRepository, pmRepository, workDir, workspaceRoot });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

const boundProject = (workDir) => ({ id: 'proj-p24-3b-r1', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL' } } });

async function submitIsolatedTask({ agentBusRepository, project, payload, workspaceRoot }) {
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null, ensureTaskWorkspace, taskWorkspaceRoot: workspaceRoot });
  await controller.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  return { commandId, taskId, readBack };
}
async function createPmRunFor({ pmRepository, readBack, commandId }) {
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  return pmRunId;
}

// A fake "owned provider process" that never fires exit/close/error on its
// own — deterministically simulates "still active"/"unresolvable" without
// depending on any real OS process or timing.
function fakeNeverExitingChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {}; // SIGTERM is a no-op -- the "process" ignores it
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function fakeTaskkillThatNeverConfirms() {
  const emitter = new EventEmitter();
  process.nextTick(() => emitter.emit('close', 1)); // taskkill itself "fails" quickly; the target never actually dies
  return emitter;
}
// P24.3B-R2 — root cause of the intermittent (and, once, fully
// deterministic) "cancelledByParent"/"Promise resolution is still
// pending but the event loop has already resolved" failures identified:
// `withReapedOwnedSpawnLifecycle`'s internal `boundedWait()` uses
// `timer.unref()` (correct for a real production process, which always
// has other live handles keeping the loop alive regardless). In a bare
// `node --test` file with nothing else registered, an unref'd timer can
// let Node decide the event loop is "idle" and end the process before
// that timer's own callback ever fires — a bare-test-harness artifact,
// not a production defect. The real, permanent fix is the file-level
// `__keepAlive` ref'd interval below, which keeps the loop demonstrably
// non-idle for this file's entire lifetime; these bounds are restored to
// their original 5ms/15ms (previously bumped to 30ms/120ms as an
// ineffective mitigation that only widened the same idle-loop window).
function registerOwnedSpawn(signal, { exitsImmediately = false, gracefulAfterMs = 5, reapAfterMs = 15 } = {}) {
  const rawSpawn = () => {
    const child = fakeNeverExitingChild();
    if (exitsImmediately) process.nextTick(() => child.emit('exit', 0, null));
    return child;
  };
  const wrapped = withReapedOwnedSpawnLifecycle(rawSpawn, signal, { gracefulAfterMs, reapAfterMs, taskkillSpawn: fakeTaskkillThatNeverConfirms });
  wrapped('git', ['status'], {});
}

test('§8.11/12 — an owned process that cannot be confirmed exited within the bounded reap window blocks cleanup: the workspace is RETAINED, never removed, with a typed reason', async () => withProcessBarrierStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  assert.ok(ws);
  const pmRunId = await createPmRunFor({ pmRepository, readBack, commandId });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntimeFactory({ pmRepository, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    enableRepoHistoryMaterialization: false,
  });
  const controller = new AbortController();
  registerOwnedSpawn(controller.signal);
  controller.abort(); // simulates the exact abort path a real owner-cancel/timeout takes

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: controller.signal });
  assert.equal(outcome.result.workspaceCleanup.status, 'RETAINED');
  assert.equal(outcome.result.workspaceCleanup.code, 'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN');
  assert.equal(existsSync(ws.workspace_path), true, 'workspace never removed while process ownership is unresolved');
  // Pre-aborting the signal (the deterministic way to drive
  // withReapedOwnedSpawnLifecycle's OWN bounded terminate()/reap sequence
  // without real timing) makes this execution its own cancellation, not a
  // completion -- gitSync is correctly gated off entirely (result.outcome
  // still exists, with its own independent, unaffected disposition). The
  // one property this test asserts about the OUTCOME is that it is
  // present and self-consistent regardless of the cleanup barrier having
  // fired -- cleanup and execution outcome are computed on two entirely
  // separate code paths (see production-pm-worker.mjs's own comment on
  // `#tryCleanupIsolatedTaskWorkspace`).
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
}));

test('§8.13 — an owned process CONFIRMED exited (its own exit event fires before cleanup runs) permits normal cleanup', async () => withProcessBarrierStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  const pmRunId = await createPmRunFor({ pmRepository, readBack, commandId });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntimeFactory({ pmRepository, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    enableRepoHistoryMaterialization: false,
  });
  const controller = new AbortController();
  registerOwnedSpawn(controller.signal, { exitsImmediately: true }); // fires 'exit' on the next tick, confirming itself with no abort needed

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: controller.signal });
  assert.equal(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), false);
}));

// P24.3B-R2 Gap #5 superseded this test's original expectation. A fresh
// signal on a LATER adoption call proves nothing about the ORIGINAL
// execution's process state (a genuinely different process lifetime), so
// treating "nothing tracked under it" as "confirmed safe to remove" was
// itself the exact unsafe inference P24.3B-R2's own qualification brief
// prohibits ("new process sees empty WeakMap and blindly removes
// potentially-active workspace"). production-pm-worker.mjs's adoption
// branch now ALWAYS defers (`assumeProcessStateUnknown:true`) unless the
// durable workspace record already says REMOVED — a real "retry" for an
// undecided workspace is now an explicit operator/reconciliation action
// calling `cleanupTaskWorkspace()` directly (unaffected, still fully
// functional — P24.3A proved it extensively), not an automatic side
// effect of a later adoption poll.
test('§8.14 — after a deferred cleanup, automatic re-adoption NEVER blindly retries (a fresh signal proves nothing about the original process); an explicit operator/reconciliation cleanupTaskWorkspace() call still succeeds', async () => withProcessBarrierStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  const pmRunId = await createPmRunFor({ pmRepository, readBack, commandId });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntimeFactory({ pmRepository, decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    enableRepoHistoryMaterialization: false,
  });
  const firstController = new AbortController();
  registerOwnedSpawn(firstController.signal);
  firstController.abort();
  const first = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: firstController.signal });
  assert.equal(first.result.workspaceCleanup.status, 'RETAINED');
  assert.equal(existsSync(ws.workspace_path), true);

  // Automatic re-adoption with a fresh signal: now correctly conservative
  // — deferred again, never removed, regardless of how "clean" the
  // fresh signal looks. A FRESH handler instance, matching a genuinely
  // separate later poll/process.
  const handler2 = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntimeFactory({ pmRepository, decisions: [] }),
    enableRepoHistoryMaterialization: false,
  });
  const secondController = new AbortController();
  const second = await handler2.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: secondController.signal });
  assert.equal(second.status, 'COMPLETED');
  assert.equal(second.adopted, true);
  assert.equal(second.result.workspaceCleanup.status, 'RETAINED');
  assert.equal(second.result.workspaceCleanup.code, 'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN');
  assert.equal(existsSync(ws.workspace_path), true, 'automatic re-adoption never removes on unproven safety');

  // An explicit operator/reconciliation action, calling the SAME
  // conservative, fail-closed primitive P24.3A already proved, directly
  // (never through the automatic adoption barrier) still succeeds.
  const explicit = await cleanupTaskWorkspace({ taskRepository: agentBusRepository, projectRepoPath: workDir, taskId });
  assert.equal(explicit.state, TASK_WORKSPACE_STATE.REMOVED);
  assert.equal(existsSync(ws.workspace_path), false);
  assert.equal(git(workDir, ['rev-parse', readBack.context.taskBranch.task_branch]).trim().length, 40, 'branch retained throughout');
}));

test('§8.15 — a timeout/failed task result is unchanged by a deferred (process-blocked) cleanup', async () => withProcessBarrierStack(async ({ agentBusRepository, pmRepository, workDir, workspaceRoot }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitIsolatedTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true } }, workspaceRoot });
  const ws = readBack.context.taskWorkspace;
  writeFileSync(join(ws.workspace_path, 'partial.txt'), 'never finished\n');
  const pmRunId = await createPmRunFor({ pmRepository, readBack, commandId });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project],
    createRuntime: () => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'error', message: 'boom', code: 'SCRIPTED_TIMEOUT' }] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    }),
    enableRepoHistoryMaterialization: false,
  });
  const controller = new AbortController();
  registerOwnedSpawn(controller.signal);
  controller.abort();
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {}, signal: controller.signal });
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED', 'failed task -> zero commit/push, regardless of the process barrier');
  assert.equal(outcome.result.workspaceCleanup.status, 'RETAINED');
  assert.equal(existsSync(join(ws.workspace_path, 'partial.txt')), true, 'partial evidence preserved, never swept away');
}));

// =============================================================================
// GAP #3 — real repository_common_dir occupancy enforcement
// =============================================================================

function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }
function fakeCoordination({ candidates } = {}) {
  const acquired = [];
  const activelyClaimed = new Set();
  const done = new Set();
  return {
    acquired,
    listPmActionCandidates: async () => candidates.filter((w) => !activelyClaimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id, leaseMs }) => { acquired.push(work_item_id); activelyClaimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fence', leaseMs }; },
    renewClaim: async () => {},
    completeWork: (id) => { activelyClaimed.delete(id); done.add(id); },
  };
}
function holdOpenHandler() {
  const gates = new Map();
  return { gates, execute: async ({ work: w }) => { let release; const gate = new Promise((r) => { release = r; }); gates.set(w.work_item_id, release); await gate; return { status: 'COMPLETED' }; } };
}
function fakePmRepositoryFor(runsByPmRunId) { return { load: (id) => runsByPmRunId[id] }; }
function fakeTaskRepositoryFor(tasksByTaskId) { return { getOwnerTask: (id) => tasksByTaskId[id] }; }

test('§8.17/18/19 — two registered projects that are DIFFERENT paths of the SAME repository (shared repository_common_dir) serialize: the second task never starts a provider while the first owns the repository, and proceeds once the first releases', async () => withDisposableRoot(async (root) => {
  const { workDir } = initWorktreeWithBareRemote(root);
  const linkedPath = join(root, 'linked-alias');
  git(workDir, ['worktree', 'add', '-b', 'alias-branch', linkedPath, 'main']);
  const commonDirA = await resolveRepositoryCommonDir({ repoPath: workDir });
  const commonDirB = await resolveRepositoryCommonDir({ repoPath: linkedPath });
  assert.equal(commonDirA, commonDirB, 'sanity: these really are the same underlying repository');

  const projectA = { id: 'proj-alias-a', repo_path: workDir, repository_common_dir: commonDirA };
  const projectB = { id: 'proj-alias-b', repo_path: linkedPath, repository_common_dir: commonDirB };
  const projects = new Map([['proj-alias-a', projectA], ['proj-alias-b', projectB]]);

  const commandIdA = 'cmd-occ-a', commandIdB = 'cmd-occ-b';
  const taskIdA = deterministicOwnerId('task', commandIdA), taskIdB = deterministicOwnerId('task', commandIdB);
  const runA = { request: { context: { ownerCommandId: commandIdA } } }, runB = { request: { context: { ownerCommandId: commandIdB } } };
  const pmRepository = fakePmRepositoryFor({ 'pm-a': runA, 'pm-b': runB });
  const taskRepository = fakeTaskRepositoryFor({ [taskIdA]: { projectId: 'proj-alias-a', context: {} }, [taskIdB]: { projectId: 'proj-alias-b', context: {} } });
  const resolveWorkIdentity = (w) => resolvePmWorkspaceIdentity({ work: w, pmRepository, taskRepository, projects });

  const coordination = fakeCoordination({ candidates: [work('a', { pm_run_id: 'pm-a' }), work('b', { pm_run_id: 'pm-b' })] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity, globalLimit: 2 });

  const first = await worker.runOnce();
  assert.equal(first.status, 'WORK');
  assert.deepEqual(first.started.map((s) => s.work_item_id), ['a']);

  const second = await worker.runOnce();
  assert.equal(second.status, 'IDLE');
  assert.deepEqual(second.rejected, [{ work_item_id: 'b', reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: `repo:${commonDirA}` }]);
  assert.equal(coordination.acquired.includes('b'), false, 'task B never even reached acquireClaim, let alone provider execution, while A owns the repository');

  handler.gates.get('a')();
  await first.started[0].promise;
  coordination.completeWork('a');
  const third = await worker.runOnce();
  assert.equal(third.status, 'WORK');
  assert.deepEqual(third.started.map((s) => s.work_item_id), ['b'], 'once A releases repository occupancy, B proceeds');
  handler.gates.get('b')?.();
}));

test('§8.20 — two DIFFERENT repositories (different repository_common_dir) may still run concurrently up to the existing global concurrency limit', async () => withDisposableRoot(async (root) => {
  const { workDir: workDirA } = initWorktreeWithBareRemote(join(root, 'repo-a'));
  const { workDir: workDirB } = initWorktreeWithBareRemote(join(root, 'repo-b'));
  const commonDirA = await resolveRepositoryCommonDir({ repoPath: workDirA });
  const commonDirB = await resolveRepositoryCommonDir({ repoPath: workDirB });
  assert.notEqual(commonDirA, commonDirB);

  const projects = new Map([
    ['proj-x', { id: 'proj-x', repo_path: workDirA, repository_common_dir: commonDirA }],
    ['proj-y', { id: 'proj-y', repo_path: workDirB, repository_common_dir: commonDirB }],
  ]);
  const commandIdX = 'cmd-occ-x', commandIdY = 'cmd-occ-y';
  const taskIdX = deterministicOwnerId('task', commandIdX), taskIdY = deterministicOwnerId('task', commandIdY);
  const pmRepository = fakePmRepositoryFor({ 'pm-x': { request: { context: { ownerCommandId: commandIdX } } }, 'pm-y': { request: { context: { ownerCommandId: commandIdY } } } });
  const taskRepository = fakeTaskRepositoryFor({ [taskIdX]: { projectId: 'proj-x', context: {} }, [taskIdY]: { projectId: 'proj-y', context: {} } });
  const resolveWorkIdentity = (w) => resolvePmWorkspaceIdentity({ work: w, pmRepository, taskRepository, projects });

  const coordination = fakeCoordination({ candidates: [work('x', { pm_run_id: 'pm-x' }), work('y', { pm_run_id: 'pm-y' })] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity, globalLimit: 2 });

  const result = await worker.runOnce();
  assert.equal(result.status, 'WORK');
  assert.deepEqual(new Set(result.started.map((s) => s.work_item_id)), new Set(['x', 'y']), 'both unrelated repositories admitted concurrently, within the existing global=2 limit, unchanged');
  handler.gates.get('x')(); handler.gates.get('y')();
}));

test('§8 regression — resolvePmWorkspaceIdentity itself is unaffected for a config that never computed repository_common_dir (real config-loader byte-for-byte fallback, re-confirmed)', () => {
  const run = { request: { context: { ownerCommandId: 'cmd-legacy-occ' } } };
  const taskId = deterministicOwnerId('task', 'cmd-legacy-occ');
  const pmRepository = fakePmRepositoryFor({ pmrun: run });
  const taskRepository = fakeTaskRepositoryFor({ [taskId]: { projectId: 'proj-legacy', context: {} } });
  const project = { id: 'proj-legacy', repo_path: '/checkout/legacy', workspace_id: 'hash-legacy' };
  const identity = resolvePmWorkspaceIdentity({ work: work('legacy', { pm_run_id: 'pmrun' }), pmRepository, taskRepository, projects: new Map([['proj-legacy', project]]) });
  assert.equal(identity.workspace_id, 'hash-legacy');
});

// =============================================================================
// GAP #1 — Council/Debate isolated-workspace routing, real composition
// =============================================================================

async function withCouncilComposition({ project, resolvePmDriver, deps = {} }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3b-r1-council-'));
  try {
    const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
    const chairProfile = { id: 'chair', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
    const p1Profile = { id: 'p1', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
    const p2Profile = { id: 'p2', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
    const config = {
      postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [project], profiles: [chairProfile, p1Profile, p2Profile],
      telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: project.id, pollIntervalMs: 10 },
      coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
      pm: { scriptedDecisions: null },
    };
    const coordination = { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} };
    const owner = { close: async () => {}, claimNotifications: async () => [] };
    const composition = await createP5ProductionComposition(config, { resolvePmDriver, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }), ...deps });
    try { await fn({ composition, chairProfile }); } finally { await composition.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function scriptedCouncilDriver(capturedCwds) {
  const resolvePmDriver = (profile, context = {}) => {
    capturedCwds.push({ profileId: profile.id, repoPath: context.project?.repo_path ?? null });
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        const round = input.request.context.round ?? null;
        // Legacy (non-artifact_v1) Council/Debate never materializes model
        // output into the repository on its own -- the whole point here
        // is to simulate a real step doing SOME file edit in whatever cwd
        // it was actually given, so the resulting result commit (or its
        // absence) is real, provable evidence of cwd routing, not merely
        // a captured argument.
        if (context.project?.repo_path) {
          writeFileSync(join(context.project.repo_path, `${profile.id}-${stepKind}-${round ?? 'x'}.txt`), `${profile.id} at ${stepKind} round=${round}\n`);
        }
        if (stepKind === 'chair_plan') {
          const ids = input.request.context.participantProfileIds ?? [];
          return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: Object.fromEntries(ids.map((id) => [id, `focus ${id}`])), critique_focus: 'be rigorous', synthesis_focus: 'converge' } };
        }
        if (stepKind === 'participant_report') return { type: 'finish', output: `${profile.id} report`, data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
        if (stepKind === 'participant_critique') return { type: 'finish', output: 'critique', data: { type: 'council_critique', criticisms: [], agreements: ['ok'], revised_recommendation: 'r2', remaining_disagreements: [] } };
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
        if (stepKind === 'debate_brief') return { type: 'finish', output: 'brief', data: { type: 'debate_brief', brief: `ROUND ${round} BRIEF` } };
        if (stepKind === 'debate_response') return { type: 'finish', output: `${profile.id} response`, data: { type: 'debate_response', response: `${profile.id} round ${round} response` } };
        if (stepKind === 'debate_synthesis') return { type: 'finish', output: `DEBATE REPORT ROUND ${round}`, data: { type: 'debate_synthesis', continue_debate: round === 0, reason: 'r', unresolved_questions: round === 0 ? ['more'] : [] } };
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  resolvePmDriver.inspect = (profile) => ({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind });
  return resolvePmDriver;
}

test('§8.1/2/9 — real Council through real composition: chair AND every participant cwd equals the isolated task.workspace_path; registered checkout stays dirty and untouched; one final commit on dsh/task-<id>', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initWorktreeWithBareRemote(root);
    writeFileSync(join(workDir, 'tracked-dirty.txt'), 'dirty\n');
    git(workDir, ['add', 'tracked-dirty.txt']);
    writeFileSync(join(workDir, 'untracked.txt'), 'untracked\n');
    const beforeHead = git(workDir, ['rev-parse', 'HEAD']).trim();
    const beforePorcelain = git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim();
    assert.notEqual(beforePorcelain, '');

    const workspaceRoot = join(root, 'workspaces');
    const project = { id: 'proj-council', repo_path: workDir, default_pm_profile_id: 'chair', autonomy: { revision: 1, effects: { BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const capturedCwds = [];
    const resolvePmDriver = scriptedCouncilDriver(capturedCwds);
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

    await withCouncilComposition({ project, resolvePmDriver, deps: { enableTaskWorkspaceIsolation: true, taskWorkspaceRoot: workspaceRoot } }, async ({ composition }) => {
      const commandId = `cmd-${randomUUID()}`;
      await composition.taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'run the council', git: { commit: true, push: true } } }, project, profile: composition.profileRegistry.get('chair'), council });
      const taskId = deterministicOwnerId('task', commandId);
      const task = composition.agentBusRepository.getOwnerTask(taskId);
      const ws = task.context.taskWorkspace;
      assert.ok(ws, 'the council task was admitted into isolation');
      assert.equal(git(ws.workspace_path, ['status', '--porcelain']).trim(), '');

      const pmRunId = deterministicOwnerId('pmrun', commandId);
      const handler = new ProductionPmWorkHandler({
        coordinationStore: { completeClaim: async () => {} }, pmRepository: composition.pmRepository, ownerRepository: {},
        taskRepository: composition.agentBusRepository, projects: [project], createRuntime: composition.createRuntime, enableRepoHistoryMaterialization: false,
      });
      const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

      assert.ok(capturedCwds.length >= 4, 'chair_plan + 2 participant_report + chair_synthesis, at minimum');
      for (const { repoPath } of capturedCwds) assert.equal(repoPath, ws.workspace_path, 'every chair/participant invocation ran against the isolated workspace, never the registered checkout');

      assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
      assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
      const taskBranch = task.context.taskBranch.task_branch;
      assert.match(taskBranch, /^dsh\/task-/);
      const resultSha = git(workDir, ['rev-parse', taskBranch]).trim();
      const commitCount = git(workDir, ['log', '--format=%H', `${beforeHead}..${resultSha}`]).trim().split('\n').filter(Boolean).length;
      assert.equal(commitCount, 1, 'exactly one final result commit -- no per-participant/chair intermediate commit');
      const committedFiles = git(workDir, ['ls-tree', '-r', '--name-only', resultSha]).trim().split('\n');
      assert.equal(committedFiles.includes('tracked-dirty.txt'), false, 'the dirty registered-checkout file never leaked into the result commit');

      assert.equal(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
      assert.equal(git(workDir, ['rev-parse', taskBranch]).trim(), resultSha, 'local task branch retained after cleanup');

      assert.equal(git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim(), beforePorcelain, 'registered checkout STILL dirty in exactly the same way, untouched by the whole Council lifecycle');
    });
  });
});

test('§8.5/6/7/8.10 — real Debate through real composition: Round 1 and Round 2 participants AND chair synthesis all reuse the SAME isolated workspace (no second worktree allocated); one final commit; registered checkout untouched', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initWorktreeWithBareRemote(root);
    writeFileSync(join(workDir, 'tracked-dirty.txt'), 'dirty\n');
    git(workDir, ['add', 'tracked-dirty.txt']);
    const beforeHead = git(workDir, ['rev-parse', 'HEAD']).trim();
    const beforePorcelain = git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim();

    const workspaceRoot = join(root, 'workspaces');
    const project = { id: 'proj-debate', repo_path: workDir, default_pm_profile_id: 'chair', autonomy: { revision: 1, effects: { BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const capturedCwds = [];
    const resolvePmDriver = scriptedCouncilDriver(capturedCwds);
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });

    await withCouncilComposition({ project, resolvePmDriver, deps: { enableTaskWorkspaceIsolation: true, taskWorkspaceRoot: workspaceRoot } }, async ({ composition }) => {
      const commandId = `cmd-${randomUUID()}`;
      await composition.taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'run the debate', git: { commit: true, push: true } } }, project, profile: composition.profileRegistry.get('chair'), council });
      const taskId = deterministicOwnerId('task', commandId);
      const task = composition.agentBusRepository.getOwnerTask(taskId);
      const ws = task.context.taskWorkspace;
      assert.ok(ws);

      const pmRunId = deterministicOwnerId('pmrun', commandId);
      const handler = new ProductionPmWorkHandler({
        coordinationStore: { completeClaim: async () => {} }, pmRepository: composition.pmRepository, ownerRepository: {},
        taskRepository: composition.agentBusRepository, projects: [project], createRuntime: composition.createRuntime, enableRepoHistoryMaterialization: false,
      });
      const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

      // Every single invocation -- Council phase AND both Debate rounds --
      // ran against the identical isolated path. No second worktree was
      // ever allocated: there is exactly one durable task_workspace_registry
      // row for this task_id (P24.3A's own uniqueness guarantee), and this
      // assertion proves every ACTUAL execution agreed with it.
      assert.ok(capturedCwds.length >= 4);
      const distinctCwds = new Set(capturedCwds.map((c) => c.repoPath));
      assert.deepEqual(distinctCwds, new Set([ws.workspace_path]), 'exactly one distinct cwd across the whole Council+Debate run -- Round 1, Round 2 and chair synthesis all reused the SAME workspace');

      assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
      const taskBranch = task.context.taskBranch.task_branch;
      const resultSha = git(workDir, ['rev-parse', taskBranch]).trim();
      const commitCount = git(workDir, ['log', '--format=%H', `${beforeHead}..${resultSha}`]).trim().split('\n').filter(Boolean).length;
      assert.equal(commitCount, 1, 'exactly one final result commit across both debate rounds -- no per-round commit');

      assert.equal(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
      assert.equal(git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim(), beforePorcelain, 'registered checkout untouched across the whole Debate lifecycle');
    });
  });
});

test('§8.3 — real artifact_v1 Council through real composition: the product package materializes under reports/dsh-tasks/<task_id>/ INSIDE the isolated task.workspace_path, folded into the same final commit', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initWorktreeWithBareRemote(root);
    const workspaceRoot = join(root, 'workspaces');
    const artifactRoot = join(root, 'dsh-artifacts');
    const project = { id: 'proj-council-art', repo_path: workDir, default_pm_profile_id: 'chair', autonomy: { revision: 1, effects: { BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

    // artifact_v1 Council steps never call decide() at all -- every report
    // is generated through artifactCouncil.resolveReportBackend instead
    // (see src/pm/council/council-chair-driver.mjs). This resolvePmDriver
    // exists only so composition startup's readiness probe finds every
    // configured profile "available"; its decide() is provably unreached.
    const resolvePmDriver = () => ({ name: 'unused-for-artifact', async decide() { throw new Error('artifact council steps never call decide()'); } });
    resolvePmDriver.inspect = (profile) => ({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind });

    const reportCalls = [];
    const reportBackendResolver = (profileId) => ({
      backend: 'fake',
      async runReport({ request }) {
        const stage = request?.stage ?? null;
        reportCalls.push({ profileId, stage });
        return buildReportBackendResult({
          backend: request?.backend ?? 'fake', profileId: request?.profileId ?? profileId, model: 'fake-1', executionId: request?.executionId,
          terminalState: TERMINAL_STATE.SUCCESS, providerFinishReason: 'stop', timedOut: false, cancelled: false, durationMs: 5,
          acceptedVisibleText: `# ${stage} by ${profileId}\n\nbody for ${profileId}\n`, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE,
        });
      },
    });

    const deps = {
      enableTaskWorkspaceIsolation: true, taskWorkspaceRoot: workspaceRoot,
      resolveNewTaskTransportVersion: () => TRANSPORT_VERSION.ARTIFACT_V1,
      artifactStore: createArtifactStore({ storeId: 's-p24-3b-r1', projectId: project.id, root: artifactRoot }),
      councilArtifactRuntime: { createdAt: new Date().toISOString(), reportBackendResolver, consumerInputTransport: 'VERBATIM_CONTENT' },
    };

    await withCouncilComposition({ project, resolvePmDriver, deps }, async ({ composition }) => {
      const commandId = `cmd-${randomUUID()}`;
      await composition.taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'run the artifact council', git: { commit: true, push: true } } }, project, profile: composition.profileRegistry.get('chair'), council });
      const taskId = deterministicOwnerId('task', commandId);
      const task = composition.agentBusRepository.getOwnerTask(taskId);
      const ws = task.context.taskWorkspace;
      assert.ok(ws, 'artifact_v1 council task was also admitted into isolation');

      const pmRunId = deterministicOwnerId('pmrun', commandId);
      const handler = new ProductionPmWorkHandler({
        coordinationStore: { completeClaim: async () => {} }, pmRepository: composition.pmRepository, ownerRepository: {},
        taskRepository: composition.agentBusRepository, projects: [project], createRuntime: composition.createRuntime, enableRepoHistoryMaterialization: false,
        resolveProjectArtifactStore: () => deps.artifactStore,
      });
      const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
      assert.ok(reportCalls.length >= 3, 'chair_plan + 2 participant reports, at minimum, ran through the report backend');
      assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
      const taskBranch = task.context.taskBranch.task_branch;
      const resultSha = git(workDir, ['rev-parse', taskBranch]).trim();
      const committedFiles = git(workDir, ['ls-tree', '-r', '--name-only', resultSha]).trim().split('\n');
      const productFiles = committedFiles.filter((f) => f.startsWith(`reports/dsh-tasks/${taskId}/`));
      assert.ok(productFiles.length > 0, `expected reports/dsh-tasks/${taskId}/ files in the result commit, got: ${JSON.stringify(committedFiles)}`);
      // The isolated workspace, not the registered checkout, is where this
      // was actually materialized from/into before the commit -- the
      // workspace is already removed by now (post-cleanup), so this is
      // proven by the commit's own tree contents above, plus the fact
      // that the registered checkout was NEVER the cwd of the commit
      // operation (execRepoPath === ws.workspace_path throughout).
      assert.equal(outcome.result.workspaceCleanup.status, TASK_WORKSPACE_STATE.REMOVED);
    });
  });
});
