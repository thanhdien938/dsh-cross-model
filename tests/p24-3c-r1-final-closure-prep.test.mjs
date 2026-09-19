/**
 * P24.3C-R1 — final closure prep (reports/
 * P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md's three confirmed
 * closure needs, implemented additively, feature-OFF-by-construction like
 * every P24.3 phase before it):
 *
 *   B. durable git-worktree-failure diagnostics (schema v11)
 *   C. durable per-invocation task-workspace evidence (executive.log)
 *   D. orphaned-ALLOCATING reconciliation (task-workspace-orphan-reconciliation.mjs)
 *
 * Workstream A (independent qualification-target fixtures) is proven by a
 * dedicated section at the bottom that inspects the REAL fixture
 * repositories this phase created under qualification-targets/ — skipped
 * (never failed) on a machine where they are absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import {
  ensureTaskWorkspace,
  TaskWorkspaceError,
  TASK_WORKSPACE_STATE,
  resolveRepositoryCommonDir,
} from '../src/pm/task-workspace-manager.mjs';
import {
  reconcileOrphanedAllocatingTaskWorkspaces,
  ORPHAN_RECONCILIATION_CLASSIFICATION,
  TASK_WORKSPACE_ORPHANED_ALLOCATION_REASON,
} from '../src/pm/task-workspace-orphan-reconciliation.mjs';
import { deriveTaskBranchName } from '../src/pm/task-branch-binding.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { SCHEMA_VERSION } from '../src/persistence/sqlite/migrations.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initRepo(root, name, { branch = 'main' } = {}) {
  const bareDir = join(root, `${name}-origin.git`);
  const workDir = join(root, `${name}-work`);
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', branch]);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', branch]);
  git(workDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', branch]);
  return { bareDir, workDir };
}
function headSha(workDir) { return git(workDir, ['rev-parse', 'HEAD']).trim(); }

async function withDisposableRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3c-r1-'));
  try { await fn(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

async function openSqliteRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'p24-3c-r1-sqlite-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const repo = new AgentBusRepository({ store });
  return {
    dir, store, repo,
    async closeStoreOnly() { await store.close(); },
    async close() { await store.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

function spawnImplFailingWorktreeAdd({ stderr = 'simulated fatal: could not create worktree\n', code = 128 } = {}) {
  return (command, args, options) => {
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
      });
      return child;
    }
    return nodeSpawn(command, args, options);
  };
}

// Executive-log filenames are `<ts>__<alias>__<stage>__executive.log`
// (artifact-paths.mjs's `executiveLogFileName()`) — matched by suffix.
function findFiles(root, suffix) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(suffix)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ===========================================================================
// Workstream B — durable git-worktree-failure diagnostics (schema v11)
// ===========================================================================

test('B1: a failed `git worktree add` durably persists bounded stderr/exit-code/operation, not just the in-memory exception', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'diag-add-fail');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-diag-add-fail-1';
      await assert.rejects(
        ensureTaskWorkspace({
          taskRepository: repo, projectRepoPath: workDir, projectId: 'proj-diag', taskId,
          taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
          spawnImpl: spawnImplFailingWorktreeAdd({ stderr: 'simulated fatal: unable to create worktree\n', code: 128 }),
        }),
        (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_ALLOCATION_FAILED',
      );
      const rows = repo.listTaskWorkspaceGitDiagnostics(taskId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].git_operation, 'WORKTREE_ADD');
      assert.equal(rows[0].error_code, 'WORKSPACE_ALLOCATION_FAILED');
      assert.equal(rows[0].exit_code, 128);
      assert.equal(rows[0].timed_out, false);
      assert.match(rows[0].bounded_stderr, /unable to create worktree/);
      assert.equal(rows[0].task_branch, deriveTaskBranchName(taskId));
      assert.equal(rows[0].pinned_base_sha, pin);
      assert.equal(rows[0].project_id, 'proj-diag');
    } finally { await close(); }
  });
});

test('B2: the persisted diagnostic survives a repository/process reopen', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'diag-reopen');
    const pin = headSha(workDir);
    const { dir, repo, closeStoreOnly } = await openSqliteRepo();
    const taskId = 'task-diag-reopen-1';
    await assert.rejects(
      ensureTaskWorkspace({
        taskRepository: repo, projectRepoPath: workDir, projectId: 'proj-reopen', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
        spawnImpl: spawnImplFailingWorktreeAdd(),
      }),
      () => true,
    );
    await closeStoreOnly();

    // Reopen the SAME sqlite file with fresh objects — simulates a process restart.
    const store2 = new SqlitePersistenceStore();
    await store2.open({ path: join(dir, 'store.db') });
    await store2.migrate();
    const repo2 = new AgentBusRepository({ store: store2 });
    try {
      const rows = repo2.listTaskWorkspaceGitDiagnostics(taskId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].git_operation, 'WORKTREE_ADD');
    } finally {
      await store2.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

test('B3: the timed_out flag round-trips through the durable accessor', async () => {
  const { repo, close } = await openSqliteRepo();
  try {
    repo.recordTaskWorkspaceGitDiagnostic('task-timeout-1', {
      projectId: 'proj-x', gitOperation: 'WORKTREE_ADD', errorCode: 'WORKSPACE_ALLOCATION_FAILED',
      exitCode: null, timedOut: true, boundedStderr: '', boundedStdout: '',
      workspacePath: '/x/y', taskBranch: 'dsh/task-task-timeout-1', pinnedBaseSha: 'a'.repeat(40),
    });
    const [row] = repo.listTaskWorkspaceGitDiagnostics('task-timeout-1');
    assert.equal(row.timed_out, true);
    assert.equal(typeof row.timed_out, 'boolean');
  } finally { await close(); }
});

test('B4: no secret/env-like data is persisted — the sweeper never scoops up process.env, only the bounded git stdio it was given', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'diag-no-secrets');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    const secret = 'shh-super-secret-token-should-never-be-persisted';
    process.env.DSH_TEST_FAKE_SECRET_P24_3C_R1 = secret;
    try {
      const taskId = 'task-diag-no-secrets-1';
      await assert.rejects(
        ensureTaskWorkspace({
          taskRepository: repo, projectRepoPath: workDir, projectId: 'proj-secret', taskId,
          taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
          spawnImpl: spawnImplFailingWorktreeAdd(),
        }),
        () => true,
      );
      const [row] = repo.listTaskWorkspaceGitDiagnostics(taskId);
      const serialized = JSON.stringify(row);
      assert.equal(serialized.includes(secret), false, 'diagnostic must never contain live process.env values');
      // Structural: the accessor accepts no env/credential-shaped field at all.
      assert.deepEqual(Object.keys(row).sort(), [
        'bounded_stderr', 'bounded_stdout', 'created_at', 'error_code', 'exit_code',
        'git_operation', 'id', 'pinned_base_sha', 'project_id', 'task_branch', 'task_id', 'timed_out', 'workspace_path',
      ].sort());
    } finally {
      delete process.env.DSH_TEST_FAKE_SECRET_P24_3C_R1;
      await close();
    }
  });
});

test('B5: an oversized stderr/stdout is capped at the same 4096-byte bound, never grows the row unbounded', async () => {
  const { repo, close } = await openSqliteRepo();
  try {
    const huge = 'x'.repeat(100_000);
    repo.recordTaskWorkspaceGitDiagnostic('task-oversized-1', {
      projectId: 'proj-x', gitOperation: 'WORKTREE_ADD', errorCode: 'WORKSPACE_ALLOCATION_FAILED',
      exitCode: 1, timedOut: false, boundedStderr: huge, boundedStdout: huge,
      workspacePath: '/x/y', taskBranch: 'dsh/task-task-oversized-1', pinnedBaseSha: 'a'.repeat(40),
    });
    const [row] = repo.listTaskWorkspaceGitDiagnostics('task-oversized-1');
    assert.equal(row.bounded_stderr.length, 4096);
    assert.equal(row.bounded_stdout.length, 4096);
  } finally { await close(); }
});

test('B6: a normal successful allocation creates zero diagnostic rows', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'diag-none-on-success');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-diag-none-1';
      const ws = await ensureTaskWorkspace({
        taskRepository: repo, projectRepoPath: workDir, projectId: 'proj-ok', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      });
      assert.equal(ws.state, TASK_WORKSPACE_STATE.READY);
      assert.equal(repo.listTaskWorkspaceGitDiagnostics(taskId).length, 0);
    } finally { await close(); }
  });
});

// ===========================================================================
// Workstream C — durable per-invocation task-workspace evidence
// ===========================================================================

test('C1: a SINGLE report invocation records the supplied workspace evidence in executive.log', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const workspaceEvidence = { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-1', repository_common_dir: '/repo/.git' };
    const out = await runSingleReport({
      store, taskId: 'task-ws-ev-1', taskSlug: 'ws evidence', createdAt: '2026-09-18T00:00:00Z',
      invocationId: 'inv-ws-ev-1', executionId: 'exec-ws-ev-1', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: fakeReportBackend({ text: 'body' }), workspaceEvidence,
    });
    const log = JSON.parse(readFileSync(out.executiveLog.path, 'utf8'));
    assert.equal(log.workspace_isolation_version, 1);
    assert.equal(log.workspace_path, workspaceEvidence.workspace_path);
    assert.equal(log.workspace_repository_common_dir, workspaceEvidence.repository_common_dir);
  });
});

test('C2 (test 14): a legacy invocation with no workspaceEvidence records null fields — byte-for-byte compatible', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const out = await runSingleReport({
      store, taskId: 'task-ws-legacy-1', taskSlug: 'legacy', createdAt: '2026-09-18T00:00:00Z',
      invocationId: 'inv-ws-legacy-1', executionId: 'exec-ws-legacy-1', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: fakeReportBackend({ text: 'body' }),
    });
    const log = JSON.parse(readFileSync(out.executiveLog.path, 'utf8'));
    assert.equal(log.workspace_isolation_version, null);
    assert.equal(log.workspace_path, null);
    assert.equal(log.workspace_repository_common_dir, null);
    // Every pre-existing field is unaffected.
    assert.equal(log.terminal_state, 'SUCCESS');
    assert.equal(log.delivery_mechanism, 'VERBATIM_MATERIALIZATION');
  });
});

test('C3 (test 13): two sequential SINGLE tasks with different workspaceEvidence record different workspace identities', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const evA = { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-A', repository_common_dir: '/repo/.git' };
    const evB = { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-1/task-B', repository_common_dir: '/repo/.git' };
    const outA = await runSingleReport({
      store, taskId: 'task-ws-A', taskSlug: 'a', createdAt: '2026-09-18T00:00:00Z',
      invocationId: 'inv-ws-A', executionId: 'exec-ws-A', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: fakeReportBackend({ text: 'body-a' }), workspaceEvidence: evA,
    });
    const outB = await runSingleReport({
      store, taskId: 'task-ws-B', taskSlug: 'b', createdAt: '2026-09-18T00:01:00Z',
      invocationId: 'inv-ws-B', executionId: 'exec-ws-B', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: fakeReportBackend({ text: 'body-b' }), workspaceEvidence: evB,
    });
    const logA = JSON.parse(readFileSync(outA.executiveLog.path, 'utf8'));
    const logB = JSON.parse(readFileSync(outB.executiveLog.path, 'utf8'));
    assert.notEqual(logA.workspace_path, logB.workspace_path);
    assert.equal(logA.workspace_path, evA.workspace_path);
    assert.equal(logB.workspace_path, evB.workspace_path);
  });
});

test('C4 (tests 8-12): every Council stage AND both Debate rounds record the SAME task-workspace identity', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({
      chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1,
      debate: { enabled: true, max_rounds: 2 },
    });
    const calls = [];
    const workspaceEvidence = { isolation_version: 1, workspace_path: '/runtime/worktrees/proj-cm/task-ws-council-1', repository_common_dir: '/repo/.git' };
    const rt = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls,
      taskId: 'task-ws-council-1', maxTurns: 40, workspaceEvidence,
      debate: { debateTypedControl: true, continueDebate: ({ round }) => round === 1 },
    });
    const res = await rt.run({ objective: 'x', pmRunId: 'c5'.repeat(50) + 'WSEV', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.equal(res.data.debate.rounds_run, 2);

    const store = newArtifactStore();
    const logs = findFiles(store.tasksRoot, 'executive.log').map((p) => JSON.parse(readFileSync(p, 'utf8')));
    // chair_plan, chair_synthesis, 3x report, 3x critique, round-1 (brief+3 responses+synthesis), round-2 (brief+3 responses+synthesis)
    assert.ok(logs.length >= 10, `expected many stage executive logs, got ${logs.length}`);
    for (const log of logs) {
      assert.equal(log.workspace_isolation_version, 1, JSON.stringify(log));
      assert.equal(log.workspace_path, workspaceEvidence.workspace_path);
      assert.equal(log.workspace_repository_common_dir, workspaceEvidence.repository_common_dir);
    }
  });
});

// ===========================================================================
// Workstream D — orphaned-ALLOCATING reconciliation
// ===========================================================================

async function seedAllocatingRow(repo, { taskId, projectId, workDir, pin, workspacePath }) {
  const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });
  const record = {
    project_id: projectId, isolation_version: 1, repository_common_dir: commonDir,
    workspace_path: workspacePath, task_branch: deriveTaskBranchName(taskId),
    pinned_base_sha: pin, remote_config_fingerprint: null, state: TASK_WORKSPACE_STATE.ALLOCATING, reason_code: null,
  };
  const written = repo.upsertTaskWorkspace(taskId, { expectedRevision: 0, record });
  return { record: written.record, revision: written.revision };
}

test('D1 (test 15): a proven-safe orphan (branch at pin, no registration, no path, no task row) is classified and transitioned to BLOCKED', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-safe');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-safe-1';
      // Simulate exactly the dsh-p6-test-b failure shape: branch created by a
      // fresh-allocation attempt, but the worktree step never registered it
      // (no `.git/worktrees` entry) and no directory was ever left on disk.
      git(workDir, ['branch', deriveTaskBranchName(taskId), pin]);
      await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan', workDir, pin, workspacePath: join(root, 'runtime-worktrees', 'proj-orphan', taskId) });

      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan', projectRepoPath: workDir });
      assert.equal(results.length, 1);
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.ORPHANED_SAFE_TO_BLOCK);
      assert.equal(results[0].mutated, true);

      const { record } = repo.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
      assert.equal(record.reason_code, TASK_WORKSPACE_ORPHANED_ALLOCATION_REASON);
      // The branch itself is never deleted.
      assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName(taskId)]).trim(), pin);
    } finally { await close(); }
  });
});

test('D2 (test 16): an ALLOCATING row with a real worktree registration is retained untouched', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-registered');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-registered-1';
      const workspacePath = join(root, 'runtime-worktrees', 'proj-orphan-reg', taskId);
      git(workDir, ['worktree', 'add', '-b', deriveTaskBranchName(taskId), workspacePath, pin]);
      const { revision } = await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-reg', workDir, pin, workspacePath });

      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-reg', projectRepoPath: workDir });
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.RETAINED_WORKTREE_REGISTERED);
      assert.equal(results[0].mutated, false);
      const { record, revision: after } = repo.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.ALLOCATING);
      assert.equal(after, revision);
    } finally { await close(); }
  });
});

test('D3 (test 17): an ALLOCATING row whose workspace path exists on disk is retained untouched', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-path-exists');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-path-1';
      const workspacePath = join(root, 'runtime-worktrees', 'proj-orphan-path', taskId);
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, 'leftover.txt'), 'partial\n');
      await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-path', workDir, pin, workspacePath });

      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-path', projectRepoPath: workDir });
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.RETAINED_PATH_EXISTS);
      assert.equal(results[0].mutated, false);
      assert.equal(existsSync(workspacePath), true);
    } finally { await close(); }
  });
});

test('D4 (test 18): a branch that has moved beyond its pinned base is BLOCKED, never auto-transitioned', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-ahead');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-ahead-1';
      git(workDir, ['branch', deriveTaskBranchName(taskId), pin]);
      // Something else advanced the branch beyond the pin.
      const worktreeTmp = join(root, 'tmp-checkout');
      git(workDir, ['worktree', 'add', worktreeTmp, deriveTaskBranchName(taskId)]);
      writeFileSync(join(worktreeTmp, 'extra.txt'), 'unexpected commit\n');
      git(worktreeTmp, ['add', '-A']);
      git(worktreeTmp, ['commit', '-q', '-m', 'unexpected']);
      git(workDir, ['worktree', 'remove', worktreeTmp]);

      await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-ahead', workDir, pin, workspacePath: join(root, 'runtime-worktrees', 'proj-orphan-ahead', taskId) });
      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-ahead', projectRepoPath: workDir });
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.BLOCKED_BRANCH_AHEAD_OF_BASE);
      assert.equal(results[0].mutated, false);
      const { record } = repo.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.ALLOCATING, 'never auto-transitioned');
    } finally { await close(); }
  });
});

test('D5 (test 19): a repository-identity mismatch is BLOCKED, never inspected further', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-identity-a');
    const { workDir: otherWorkDir } = initRepo(root, 'orphan-identity-b');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-identity-1';
      // Row recorded against a DIFFERENT repository's common dir.
      await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-identity', workDir: otherWorkDir, pin, workspacePath: join(root, 'runtime-worktrees', 'proj-orphan-identity', taskId) });
      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-identity', projectRepoPath: workDir });
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.BLOCKED_REPOSITORY_IDENTITY_MISMATCH);
      assert.equal(results[0].mutated, false);
    } finally { await close(); }
  });
});

test('D6 (test 21): a task row already existing for this task_id makes the sweeper skip it entirely', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-task-exists');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-orphan-taskrow-1';
      git(workDir, ['branch', deriveTaskBranchName(taskId), pin]);
      await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-taskrow', workDir, pin, workspacePath: join(root, 'runtime-worktrees', 'proj-orphan-taskrow', taskId) });
      // Seed a minimal real `tasks` row for the same task_id.
      repo.createOwnerTask(
        { id: taskId, sender: 'owner', recipient: 'pm', body: 'x', context: null, createdAt: new Date().toISOString() },
        { projectId: 'proj-orphan-taskrow', pmProfileId: 'pm-1', effectiveAutonomy: {}, envelopeRevision: 1, projectConfigFingerprint: 'fp' },
      );

      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-taskrow', projectRepoPath: workDir });
      assert.equal(results[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.TASK_ROW_EXISTS_SKIPPED);
      assert.equal(results[0].mutated, false);
      const { record } = repo.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.ALLOCATING);
    } finally { await close(); }
  });
});

test('D7 (test 20): READY/CLEANUP_PENDING/REMOVED rows are never touched (only ALLOCATING is ever inspected)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-other-states');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      for (const [suffix, state] of [['ready', 'READY'], ['cleanup', 'CLEANUP_PENDING'], ['removed', 'REMOVED']]) {
        const taskId = `task-orphan-state-${suffix}`;
        const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });
        repo.upsertTaskWorkspace(taskId, {
          expectedRevision: 0,
          record: {
            project_id: 'proj-orphan-states', isolation_version: 1, repository_common_dir: commonDir,
            workspace_path: join(root, 'runtime-worktrees', 'proj-orphan-states', taskId), task_branch: deriveTaskBranchName(taskId),
            pinned_base_sha: pin, remote_config_fingerprint: null, state, reason_code: null,
          },
        });
      }
      const results = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-states', projectRepoPath: workDir });
      assert.equal(results.length, 0, 'only ALLOCATING rows are ever inspected');
      for (const suffix of ['ready', 'cleanup', 'removed']) {
        const { record } = repo.getTaskWorkspace(`task-orphan-state-${suffix}`);
        assert.notEqual(record.state, 'BLOCKED');
      }
    } finally { await close(); }
  });
});

test('D8 (tests 22-23): reconciliation is idempotent and stable across a repository reopen', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'orphan-idempotent');
    const pin = headSha(workDir);
    const { dir, repo, closeStoreOnly } = await openSqliteRepo();
    const taskId = 'task-orphan-idempotent-1';
    git(workDir, ['branch', deriveTaskBranchName(taskId), pin]);
    await seedAllocatingRow(repo, { taskId, projectId: 'proj-orphan-idempotent', workDir, pin, workspacePath: join(root, 'runtime-worktrees', 'proj-orphan-idempotent', taskId) });

    const first = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-idempotent', projectRepoPath: workDir });
    assert.equal(first[0].mutated, true);
    // Second pass in the SAME process: nothing left to classify (no longer ALLOCATING).
    const second = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'proj-orphan-idempotent', projectRepoPath: workDir });
    assert.equal(second.length, 0);
    await closeStoreOnly();

    // Restart: reopen the same sqlite file and confirm the BLOCKED state persisted stably.
    const store2 = new SqlitePersistenceStore();
    await store2.open({ path: join(dir, 'store.db') });
    await store2.migrate();
    const repo2 = new AgentBusRepository({ store: store2 });
    try {
      const { record } = repo2.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
      assert.equal(record.reason_code, TASK_WORKSPACE_ORPHANED_ALLOCATION_REASON);
      const third = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo2, projectId: 'proj-orphan-idempotent', projectRepoPath: workDir });
      assert.equal(third.length, 0);
    } finally {
      await store2.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

test('D9: dry-run mode classifies without mutating (faithful reproduction of the real dsh-p6-test-b row shape)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'dsh-p6-shape');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      // Faithful reproduction of reports/P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md's
      // DSH_P6_TASK_WORKSPACE_REGISTRY finding: branch exists at exactly the
      // pin, `.git/worktrees` has no registration, and the on-disk worktree
      // root is completely empty (no directory was ever created).
      const taskId = 'task-XhfQD9b3xekaidf8lxOkSgotUQgsgkcD';
      git(workDir, ['branch', deriveTaskBranchName(taskId), pin]);
      await seedAllocatingRow(repo, { taskId, projectId: 'dsh-p6-test-b', workDir, pin, workspacePath: join(root, 'worktrees', 'dsh-p6-test-b', taskId) });

      const dry = await reconcileOrphanedAllocatingTaskWorkspaces({ taskRepository: repo, projectId: 'dsh-p6-test-b', projectRepoPath: workDir, dryRun: true });
      assert.equal(dry[0].classification, ORPHAN_RECONCILIATION_CLASSIFICATION.ORPHANED_SAFE_TO_BLOCK);
      assert.equal(dry[0].mutated, false);
      const { record } = repo.getTaskWorkspace(taskId);
      assert.equal(record.state, TASK_WORKSPACE_STATE.ALLOCATING, 'dry-run performs zero durable writes');
    } finally { await close(); }
  });
});

// ===========================================================================
// Workstream A — independent qualification-target fixtures
// (proven against the real repos this phase created; skipped, never failed,
//  on a machine where they are not present)
// ===========================================================================

const QUAL_ROOT = 'E:\\DATA\\codex_project\\DSH_PROJECT\\qualification-targets';
const FIXTURE_A = join(QUAL_ROOT, 'P24C-INDEPENDENT-A');
const FIXTURE_B = join(QUAL_ROOT, 'P24C-INDEPENDENT-B');
const DSH_REPO = join(QUAL_ROOT, '..', 'dsh-cross-model-debate-poc');

test('A1-A6 (tests 24-29): the independent qualification fixtures have distinct common-dirs/remotes from each other and from DSH', async () => {
  if (!existsSync(FIXTURE_A) || !existsSync(FIXTURE_B)) {
    return; // not present on this machine — proven only where the fixtures exist
  }
  const dshCommon = await resolveRepositoryCommonDir({ repoPath: DSH_REPO });
  const aCommon = await resolveRepositoryCommonDir({ repoPath: FIXTURE_A });
  const bCommon = await resolveRepositoryCommonDir({ repoPath: FIXTURE_B });
  assert.notEqual(aCommon.toLowerCase(), dshCommon.toLowerCase(), 'fixture A common-dir != DSH');
  assert.notEqual(bCommon.toLowerCase(), dshCommon.toLowerCase(), 'fixture B common-dir != DSH');
  assert.notEqual(aCommon.toLowerCase(), bCommon.toLowerCase(), 'fixture A common-dir != fixture B common-dir');

  const dshRemote = git(DSH_REPO, ['remote', 'get-url', 'origin']).trim();
  const aRemote = git(FIXTURE_A, ['remote', 'get-url', 'origin']).trim();
  const bRemote = git(FIXTURE_B, ['remote', 'get-url', 'origin']).trim();
  assert.notEqual(aRemote, dshRemote, 'fixture A remote != DSH remote');
  assert.notEqual(bRemote, dshRemote, 'fixture B remote != DSH remote');
  assert.notEqual(aRemote, bRemote, 'fixture A remote != fixture B remote');
});

test('A7 (test 30): fixture B remains dirty (tracked-modified + staged + untracked) without blocking a controlled local isolated-workspace setup', async () => {
  if (!existsSync(FIXTURE_B)) return;
  const status = git(FIXTURE_B, ['status', '--porcelain']).trim().split('\n').filter(Boolean);
  assert.ok(status.some((l) => l.startsWith(' M') || l.startsWith('M ')), 'expected a tracked-modified marker');
  assert.ok(status.some((l) => l.startsWith('A ')), 'expected a staged marker');
  assert.ok(status.some((l) => l.startsWith('??')), 'expected an untracked marker');

  // Controlled local proof: allocating an ISOLATED task workspace (a linked
  // worktree at a pinned SHA) never requires the REGISTERED checkout itself
  // to be clean — task-workspace-manager.mjs never touches projectRepoPath's
  // HEAD/index. Uses a disposable SQLite registry so fixture B's own durable
  // state (if any is registered in a real LIVE1 database) is never touched.
  const pin = git(FIXTURE_B, ['rev-parse', 'HEAD']).trim();
  const { repo, close } = await openSqliteRepo();
  await withDisposableRoot(async (root) => {
    try {
      const taskId = 'task-fixture-b-dirty-probe';
      const ws = await ensureTaskWorkspace({
        taskRepository: repo, projectRepoPath: FIXTURE_B, projectId: 'p24c-independent-b-probe', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      });
      assert.equal(ws.state, TASK_WORKSPACE_STATE.READY);
      // Fixture B's own dirty state is completely unaffected.
      const statusAfter = git(FIXTURE_B, ['status', '--porcelain']).trim().split('\n').filter(Boolean);
      assert.deepEqual(statusAfter.sort(), status.sort());
      // Clean up the disposable worktree/branch this probe created.
      git(FIXTURE_B, ['worktree', 'remove', ws.workspace_path]);
      git(FIXTURE_B, ['branch', '-D', deriveTaskBranchName(taskId)]);
    } finally { await close(); }
  });
});

test('schema v11 is additive and exact', () => {
  assert.equal(SCHEMA_VERSION, 11);
});
