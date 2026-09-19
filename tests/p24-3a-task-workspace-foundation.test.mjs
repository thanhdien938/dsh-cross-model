// P24.3A — task-workspace-isolation FOUNDATION (reports/
// P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md;
// this phase's own reports/P24_3A_TASK_WORKSPACE_FOUNDATION_
// IMPLEMENTATION_20260917.md).
//
// Real disposable git fixtures throughout, same discipline as
// p18-w4r5-task-branch-base-isolation.test.mjs / p24-1g6a-dynamic-base-
// admission.test.mjs — the whole point of this phase is that the manager
// is proven against REAL Git worktree behavior, never a mocked Git
// primitive for the allocation/cleanup assertions themselves. Only the
// simulated-Windows-cleanup-failure case (§17 item 23) injects a fault at
// the `spawnImpl` boundary, deterministically, standing in for a real
// NTFS sharing violation / AV lock (the architecture audit's own
// FileShare.None probe demonstrated the real OS behavior; this phase
// verifies the MANAGER'S reaction to ANY failed removal, portably).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import {
  ensureTaskWorkspace,
  cleanupTaskWorkspace,
  deriveTaskWorkspacePath,
  resolveRepositoryCommonDir,
  TaskWorkspaceError,
  TASK_WORKSPACE_STATE,
  WORKSPACE_ISOLATION_VERSION,
} from '../src/pm/task-workspace-manager.mjs';
import { deriveTaskBranchName } from '../src/pm/task-branch-binding.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { SCHEMA_VERSION } from '../src/persistence/sqlite/migrations.mjs';

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

// In-memory stand-in for AgentBusRepository's schema-v10 accessor pair —
// same fixture discipline as p24-1g6a's own `fakeJournal()`: the CAS
// contract under test is the MANAGER's use of it, not SQLite itself
// (agentbus-repository.test.mjs / the migration test below separately
// prove the real accessor pair backs the identical contract).
function fakeWorkspaceRegistry() {
  const rows = new Map();
  return {
    getTaskWorkspace(taskId) {
      const row = rows.get(taskId);
      return row ? { record: row.record, revision: row.revision } : { record: null, revision: 0 };
    },
    upsertTaskWorkspace(taskId, { expectedRevision, record }) {
      const row = rows.get(taskId);
      const currentRevision = row ? row.revision : 0;
      if (currentRevision !== expectedRevision) { const e = new Error('stale workspace revision'); e.code = 'WORKSPACE_RECOVERY_CONFLICT'; throw e; }
      const nextRevision = currentRevision + 1;
      const stored = { ...record };
      rows.set(taskId, { record: stored, revision: nextRevision });
      return { record: stored, revision: nextRevision };
    },
    _rows: rows,
  };
}

async function withDisposableRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-3a-'));
  try { await fn(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

function userSnapshot(workDir) {
  return {
    head: git(workDir, ['rev-parse', 'HEAD']).trim(),
    branch: git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    porcelain: git(workDir, ['status', '--porcelain', '--untracked-files=all']).trim(),
    diffUnstaged: git(workDir, ['diff']).trim(),
    diffStaged: git(workDir, ['diff', '--cached']).trim(),
    trackedBytes: existsSync(join(workDir, 'tracked-dirty.txt')) ? readFileSync(join(workDir, 'tracked-dirty.txt'), 'utf8') : null,
    untrackedBytes: existsSync(join(workDir, 'untracked-file.txt')) ? readFileSync(join(workDir, 'untracked-file.txt'), 'utf8') : null,
  };
}

// ---------------------------------------------------------------------------
// §17.1-4,9-13 — clean/dirty/staged/untracked user checkout non-interference
// ---------------------------------------------------------------------------

test('clean user checkout: allocates a linked worktree at the exact pinned SHA, on the deterministic branch, clean', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'clean');
    const pin = headSha(workDir);
    const runtimeRoot = join(root, 'runtime-worktrees');
    const registry = fakeWorkspaceRegistry();

    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-clean', taskId: 'task-clean-1',
      taskBranch: deriveTaskBranchName('task-clean-1'), pinnedBaseSha: pin, runtimeWorktreeRoot: runtimeRoot,
    });

    assert.equal(ws.state, TASK_WORKSPACE_STATE.READY);
    assert.equal(ws.isolation_version, WORKSPACE_ISOLATION_VERSION);
    assert.equal(ws.pinned_base_sha, pin);
    assert.equal(ws.reused, false);
    assert.equal(git(ws.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);
    assert.equal(git(ws.workspace_path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), deriveTaskBranchName('task-clean-1'));
    assert.equal(git(ws.workspace_path, ['status', '--porcelain']).trim(), '');
    // task worktree is a DIFFERENT directory from the registered checkout
    assert.notEqual(join(ws.workspace_path), join(workDir));
    // common dir identity: both worktrees belong to the same repository
    const userCommonDir = await resolveRepositoryCommonDir({ repoPath: workDir });
    const taskCommonDir = await resolveRepositoryCommonDir({ repoPath: ws.workspace_path });
    assert.equal(userCommonDir, taskCommonDir);
  });
});

test('dirty tracked + untracked + staged user checkout: full lifecycle (allocate, execute, cleanup) never touches user state', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'dirty');
    const pin = headSha(workDir);

    // tracked file staged then changed again (mixed staged+unstaged), plus an untracked file — §17.2/3/4.
    writeFileSync(join(workDir, 'tracked-dirty.txt'), 'staged version\n');
    git(workDir, ['add', 'tracked-dirty.txt']);
    writeFileSync(join(workDir, 'tracked-dirty.txt'), 'staged version\nplus unstaged edit\n');
    writeFileSync(join(workDir, 'untracked-file.txt'), 'never tracked\n');

    const before = userSnapshot(workDir);
    assert.notEqual(before.porcelain, '', 'sanity: user checkout really is dirty before allocation');

    const runtimeRoot = join(root, 'runtime-worktrees');
    const registry = fakeWorkspaceRegistry();
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-dirty', taskId: 'task-dirty-1',
      taskBranch: deriveTaskBranchName('task-dirty-1'), pinnedBaseSha: pin, runtimeWorktreeRoot: runtimeRoot,
    });
    assert.equal(ws.state, TASK_WORKSPACE_STATE.READY);

    // §17.9-12 — user checkout is byte-for-byte unchanged immediately after allocation.
    const afterAllocate = userSnapshot(workDir);
    assert.deepEqual(afterAllocate, before);

    // §17.13 — task worktree started clean and does NOT see the user's dirty/untracked files.
    assert.equal(existsSync(join(ws.workspace_path, 'tracked-dirty.txt')), false, 'task worktree must not see the user\'s uncommitted tracked change');
    assert.equal(existsSync(join(ws.workspace_path, 'untracked-file.txt')), false, 'task worktree must not see the user\'s untracked file');

    // "Execute" a task: write a result file, commit it, in the TASK workspace only.
    writeFileSync(join(ws.workspace_path, 'task-result.txt'), 'task output\n');
    git(ws.workspace_path, ['add', '-A']);
    git(ws.workspace_path, ['commit', '-q', '-m', 'task result']);
    const resultSha = git(ws.workspace_path, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(resultSha, pin);

    const afterExecute = userSnapshot(workDir);
    assert.deepEqual(afterExecute, before, 'user checkout unaffected by task execution');

    const cleaned = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId: 'task-dirty-1' });
    assert.equal(cleaned.state, TASK_WORKSPACE_STATE.REMOVED);
    assert.equal(cleaned.branch_retained, true);
    assert.equal(existsSync(ws.workspace_path), false, 'worktree directory removed');
    assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName('task-dirty-1')]).trim(), resultSha, 'local task branch retained at the result commit after cleanup');

    const afterCleanup = userSnapshot(workDir);
    assert.deepEqual(afterCleanup, before, 'user checkout unaffected by cleanup');
  });
});

// ---------------------------------------------------------------------------
// §17.5-6 — user on a non-default / prior dsh/task-* branch
// ---------------------------------------------------------------------------

test('user checkout on a non-default branch: task workspace still starts at the exact caller-supplied pin, and the user branch/HEAD never move', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'nondefault');
    const pin = headSha(workDir);
    git(workDir, ['checkout', '-q', '-b', 'user-topic']);
    writeFileSync(join(workDir, 'topic-work.txt'), 'topic\n');
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'topic commit']);
    const topicSha = git(workDir, ['rev-parse', 'HEAD']).trim();

    const registry = fakeWorkspaceRegistry();
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-nd', taskId: 'task-nd-1',
      taskBranch: deriveTaskBranchName('task-nd-1'), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    assert.equal(git(ws.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'user-topic', 'user checkout never switched');
    assert.equal(git(workDir, ['rev-parse', 'HEAD']).trim(), topicSha, 'user HEAD never moved');
  });
});

test('user checkout left on an OLD dsh/task-* branch from a prior task: new allocation is unaffected and the old branch is untouched', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'oldtask');
    const pin = headSha(workDir);
    const oldTaskBranch = deriveTaskBranchName('task-old-1');
    git(workDir, ['checkout', '-q', '-b', oldTaskBranch]);
    writeFileSync(join(workDir, 'old-task-work.txt'), 'old\n');
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'old task commit']);
    const oldTaskSha = git(workDir, ['rev-parse', 'HEAD']).trim();

    const registry = fakeWorkspaceRegistry();
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-old', taskId: 'task-new-1',
      taskBranch: deriveTaskBranchName('task-new-1'), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    assert.equal(git(ws.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), oldTaskBranch, 'user checkout still sitting on the OLD task branch, untouched');
    assert.equal(git(workDir, ['rev-parse', oldTaskBranch]).trim(), oldTaskSha, 'old task branch itself is untouched');
  });
});

// ---------------------------------------------------------------------------
// §17.14 — existing valid workspace reused
// ---------------------------------------------------------------------------

test('a second ensureTaskWorkspace call for the same task reuses the existing READY workspace without a second `worktree add`', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'reuse');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const args = {
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-reuse', taskId: 'task-reuse-1',
      taskBranch: deriveTaskBranchName('task-reuse-1'), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    };
    const first = await ensureTaskWorkspace(args);
    assert.equal(first.reused, false);
    const worktreeCountBefore = git(workDir, ['worktree', 'list']).trim().split('\n').length;

    const second = await ensureTaskWorkspace(args);
    assert.equal(second.reused, true);
    assert.equal(second.workspace_path, first.workspace_path);
    const worktreeCountAfter = git(workDir, ['worktree', 'list']).trim().split('\n').length;
    assert.equal(worktreeCountAfter, worktreeCountBefore, 'no additional worktree was registered on reuse');
  });
});

// ---------------------------------------------------------------------------
// §17.15 — interrupted allocation recovery
// ---------------------------------------------------------------------------

test('interrupted allocation (crash between durable ALLOCATING write and `worktree add`) recovers cleanly on replay', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'interrupted');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-interrupted-1';
    const taskBranch = deriveTaskBranchName(taskId);
    const workspacePath = deriveTaskWorkspacePath({ runtimeWorktreeRoot: join(root, 'runtime-worktrees'), projectId: 'proj-int', taskId });
    const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });

    // Simulate the crash point: durable ALLOCATING record written, but no
    // git worktree add ever ran (branch absent, path absent).
    registry.upsertTaskWorkspace(taskId, {
      expectedRevision: 0,
      record: {
        project_id: 'proj-int', isolation_version: WORKSPACE_ISOLATION_VERSION, repository_common_dir: commonDir,
        workspace_path: workspacePath, task_branch: taskBranch, pinned_base_sha: pin, remote_config_fingerprint: null,
        state: TASK_WORKSPACE_STATE.ALLOCATING, reason_code: null,
      },
    });

    const recovered = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-int', taskId,
      taskBranch, pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    assert.equal(recovered.state, TASK_WORKSPACE_STATE.READY);
    assert.equal(git(recovered.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);
  });
});

test('interrupted allocation where the branch was created but the worktree add failed: replay attaches the existing branch rather than re-creating it', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'partialbranch');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-partial-1';
    const taskBranch = deriveTaskBranchName(taskId);
    const workspacePath = deriveTaskWorkspacePath({ runtimeWorktreeRoot: join(root, 'runtime-worktrees'), projectId: 'proj-partial', taskId });
    const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });

    // Simulate the audit's own proven-non-atomic failure mode: the branch
    // survives a failed `worktree add -b` (created straight off the pin,
    // exactly what a real interrupted add would leave behind).
    git(workDir, ['branch', taskBranch, pin]);

    registry.upsertTaskWorkspace(taskId, {
      expectedRevision: 0,
      record: {
        project_id: 'proj-partial', isolation_version: WORKSPACE_ISOLATION_VERSION, repository_common_dir: commonDir,
        workspace_path: workspacePath, task_branch: taskBranch, pinned_base_sha: pin, remote_config_fingerprint: null,
        state: TASK_WORKSPACE_STATE.ALLOCATING, reason_code: null,
      },
    });

    const recovered = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-partial', taskId,
      taskBranch, pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    assert.equal(recovered.state, TASK_WORKSPACE_STATE.READY);
    assert.equal(git(recovered.workspace_path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), taskBranch);
  });
});

// ---------------------------------------------------------------------------
// §17.16-19 — rejection of foreign path / repository / branch mismatch / ancestry
// ---------------------------------------------------------------------------

test('a durable record whose workspace_path does not match the deterministically derived path is rejected (WORKSPACE_PATH_MISMATCH)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'foreignpath');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-foreign-path-1';
    const commonDir = await resolveRepositoryCommonDir({ repoPath: workDir });
    registry.upsertTaskWorkspace(taskId, {
      expectedRevision: 0,
      record: {
        project_id: 'proj-fp', isolation_version: WORKSPACE_ISOLATION_VERSION, repository_common_dir: commonDir,
        workspace_path: join(root, 'somewhere-else', 'not-derived'), task_branch: deriveTaskBranchName(taskId),
        pinned_base_sha: pin, remote_config_fingerprint: null, state: TASK_WORKSPACE_STATE.READY, reason_code: null,
      },
    });
    await assert.rejects(
      () => ensureTaskWorkspace({
        taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-fp', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_PATH_MISMATCH',
    );
  });
});

test('a durable record bound to a different repository common dir is rejected (WORKSPACE_REPOSITORY_MISMATCH)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir: workDirA } = initRepo(root, 'repoA');
    const { workDir: workDirB } = initRepo(root, 'repoB');
    const pinA = headSha(workDirA);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-cross-repo-1';
    const commonDirB = await resolveRepositoryCommonDir({ repoPath: workDirB });
    const workspacePath = deriveTaskWorkspacePath({ runtimeWorktreeRoot: join(root, 'runtime-worktrees'), projectId: 'proj-x', taskId });
    registry.upsertTaskWorkspace(taskId, {
      expectedRevision: 0,
      record: {
        project_id: 'proj-x', isolation_version: WORKSPACE_ISOLATION_VERSION, repository_common_dir: commonDirB,
        workspace_path: workspacePath, task_branch: deriveTaskBranchName(taskId), pinned_base_sha: pinA,
        remote_config_fingerprint: null, state: TASK_WORKSPACE_STATE.READY, reason_code: null,
      },
    });
    await assert.rejects(
      () => ensureTaskWorkspace({
        taskRepository: registry, projectRepoPath: workDirA, projectId: 'proj-x', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pinA, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_REPOSITORY_MISMATCH',
    );
  });
});

test('caller-supplied taskBranch that does not match the deterministic branch derived from task_id is rejected before any git mutation', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'branchmismatch');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    await assert.rejects(
      () => ensureTaskWorkspace({
        taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-bm', taskId: 'task-bm-1',
        taskBranch: 'dsh/task-some-other-id', pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_TASK_BRANCH_MISMATCH',
    );
    assert.equal(git(workDir, ['worktree', 'list']).trim().split('\n').length, 1, 'no worktree was created');
  });
});

test('an existing dsh/task-<id> branch with no ancestry to the pinned base is rejected instead of silently adopted (WORKSPACE_BRANCH_ANCESTRY_MISMATCH)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'ancestry');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-ancestry-1';
    const taskBranch = deriveTaskBranchName(taskId);

    // Foreign/orphan history occupying the exact deterministic branch name.
    git(workDir, ['checkout', '-q', '--orphan', taskBranch]);
    git(workDir, ['rm', '-rq', '--cached', '.']);
    writeFileSync(join(workDir, 'unrelated.txt'), 'nothing to do with this task\n');
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'unrelated orphan history']);
    git(workDir, ['checkout', '-q', 'main']);
    const foreignSha = git(workDir, ['rev-parse', taskBranch]).trim();

    await assert.rejects(
      () => ensureTaskWorkspace({
        taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-anc', taskId,
        taskBranch, pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_BRANCH_ANCESTRY_MISMATCH',
    );
    // The foreign branch is left completely untouched.
    assert.equal(git(workDir, ['rev-parse', taskBranch]).trim(), foreignSha);
    const { record } = registry.getTaskWorkspace(taskId);
    assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
  });
});

// ---------------------------------------------------------------------------
// §17.20-21 — cleanup success, branch retention, refused dirty cleanup
// ---------------------------------------------------------------------------

test('cleanup succeeds on a clean task workspace and preserves the local task branch', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'cleanup-ok');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-cleanup-ok-1';
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-cleanok', taskId,
      taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    const cleaned = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
    assert.equal(cleaned.state, TASK_WORKSPACE_STATE.REMOVED);
    assert.equal(cleaned.branch_retained, true);
    assert.equal(existsSync(ws.workspace_path), false);
    assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName(taskId)]).trim(), pin, 'branch still exists, at the pin (zero-change task)');
    // idempotent: cleaning up an already-removed workspace is a safe no-op
    const second = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
    assert.equal(second.already_removed, true);
  });
});

test('cleanup refuses a task workspace with unexpected dirty/untracked content and retains it (WORKSPACE_CLEANUP_BLOCKED_DIRTY)', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'cleanup-dirty');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-cleanup-dirty-1';
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-cleandirty', taskId,
      taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });
    writeFileSync(join(ws.workspace_path, 'uncommitted-output.txt'), 'not committed\n');

    await assert.rejects(
      () => cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_CLEANUP_BLOCKED_DIRTY',
    );
    assert.equal(existsSync(ws.workspace_path), true, 'workspace retained, not deleted');
    assert.equal(existsSync(join(ws.workspace_path, 'uncommitted-output.txt')), true, 'uncommitted evidence preserved');
    const { record } = registry.getTaskWorkspace(taskId);
    assert.equal(record.state, TASK_WORKSPACE_STATE.CLEANUP_PENDING);
    assert.equal(record.reason_code, 'DIRTY_WORKSPACE');
  });
});

// ---------------------------------------------------------------------------
// §17.23 — simulated Windows/open-handle cleanup failure => BLOCKED, retained
// ---------------------------------------------------------------------------

function spawnImplFailingWorktreeRemove() {
  return (command, args, options) => {
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('simulated Windows sharing violation: unable to unlink working tree file\n'));
        child.emit('close', 1);
      });
      return child;
    }
    return nodeSpawn(command, args, options);
  };
}

test('a failed worktree removal (simulated Windows sharing-violation / AV-lock fault injection) leaves the workspace BLOCKED and retained, never force-removed', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'cleanup-locked');
    const pin = headSha(workDir);
    const registry = fakeWorkspaceRegistry();
    const taskId = 'task-cleanup-locked-1';
    const ws = await ensureTaskWorkspace({
      taskRepository: registry, projectRepoPath: workDir, projectId: 'proj-locked', taskId,
      taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
    });

    await assert.rejects(
      () => cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId, spawnImpl: spawnImplFailingWorktreeRemove() }),
      (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_CLEANUP_FAILED',
    );
    assert.equal(existsSync(ws.workspace_path), true, 'workspace retained on removal failure');
    const { record } = registry.getTaskWorkspace(taskId);
    assert.equal(record.state, TASK_WORKSPACE_STATE.BLOCKED);
    assert.equal(record.reason_code, 'CLEANUP_REMOVE_FAILED');

    // A subsequent cleanup with a working spawnImpl can still recover it —
    // BLOCKED here is retryable, never terminal.
    const recovered = await cleanupTaskWorkspace({ taskRepository: registry, projectRepoPath: workDir, taskId });
    assert.equal(recovered.state, TASK_WORKSPACE_STATE.REMOVED);
  });
});

// ---------------------------------------------------------------------------
// §17.25 — path traversal rejection
// ---------------------------------------------------------------------------

test('path traversal in project_id/task_id is rejected before any filesystem/git operation', () => {
  assert.throws(
    () => deriveTaskWorkspacePath({ runtimeWorktreeRoot: '/runtime/worktrees', projectId: '../../etc', taskId: 'task-1' }),
    (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_PROJECT_ID_INVALID',
  );
  assert.throws(
    () => deriveTaskWorkspacePath({ runtimeWorktreeRoot: '/runtime/worktrees', projectId: 'proj-1', taskId: '../../../etc/passwd' }),
    (e) => e instanceof TaskWorkspaceError && e.code === 'WORKSPACE_TASK_ID_INVALID',
  );
});

// ---------------------------------------------------------------------------
// §17.26 — two aliases of the same repository share one identity
// ---------------------------------------------------------------------------

test('two different linked-worktree paths of the SAME repository resolve to the identical repository common dir', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'aliases');
    // A second, ordinary linked worktree of the SAME repository, created
    // directly (not through the manager) — the manager must recognize it
    // as the same repository identity as the primary checkout.
    const secondPath = join(root, 'aliases-second-worktree');
    git(workDir, ['worktree', 'add', '-b', 'alias-check', secondPath, 'main']);

    const identityA = await resolveRepositoryCommonDir({ repoPath: workDir });
    const identityB = await resolveRepositoryCommonDir({ repoPath: secondPath });
    assert.equal(identityA, identityB);
  });
});

// ---------------------------------------------------------------------------
// §17.27 — legacy task with no isolation version unaffected
// ---------------------------------------------------------------------------

test('a task with no durable workspace row at all reads back as absent, never inferred', () => {
  const registry = fakeWorkspaceRegistry();
  const { record, revision } = registry.getTaskWorkspace('some-legacy-task-never-isolated');
  assert.equal(record, null);
  assert.equal(revision, 0);
});

// ---------------------------------------------------------------------------
// §17.28 — feature remains OFF in production composition (source-level proof)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real SQLite (schema v10) backing the exact same manager contract —
// proves the durable accessor pair, additive migration, and CAS discipline
// for real, not merely the in-memory `fakeWorkspaceRegistry()` fixture used
// above for the Git-behavior-focused tests.
// ---------------------------------------------------------------------------

async function openSqliteRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'p24-3a-sqlite-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const repo = new AgentBusRepository({ store });
  return {
    dir, store, repo,
    async close() { await store.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

test('schema v10 is additive: migrating a fresh store creates task_workspace_registry and legacy tables remain intact', async () => {
  const { store, repo, close } = await openSqliteRepo();
  try {
    assert.equal(SCHEMA_VERSION, 11);
    // Legacy schema v9 accessor still works untouched on a freshly migrated store.
    const admission = repo.getGitAdmission('some-legacy-task');
    assert.equal(admission.record, null);
    assert.equal(admission.revision, 0);
    // New schema v10 accessor also works, starting empty.
    const workspace = repo.getTaskWorkspace('some-task');
    assert.equal(workspace.record, null);
    assert.equal(workspace.revision, 0);
  } finally {
    await close();
  }
});

test('real AgentBusRepository.getTaskWorkspace/upsertTaskWorkspace round-trip through SQLite with CAS discipline identical to getGitAdmission/upsertGitAdmission', async () => {
  const { repo, close } = await openSqliteRepo();
  try {
    const taskId = 'task-sqlite-1';
    const insertRecord = {
      project_id: 'proj-sqlite', isolation_version: 1, repository_common_dir: '/repo/.git',
      workspace_path: '/runtime/worktrees/proj-sqlite/task-sqlite-1', task_branch: 'dsh/task-task-sqlite-1',
      pinned_base_sha: 'a'.repeat(40), remote_config_fingerprint: null, state: 'ALLOCATING', reason_code: null,
    };
    const written = repo.upsertTaskWorkspace(taskId, { expectedRevision: 0, record: insertRecord });
    assert.equal(written.revision, 1);
    assert.equal(written.record.state, 'ALLOCATING');

    // Stale CAS write is rejected, exactly like updateGitAdmission's own contract.
    assert.throws(
      () => repo.upsertTaskWorkspace(taskId, { expectedRevision: 0, record: { ...insertRecord, state: 'READY' } }),
      (e) => e.code === 'WORKSPACE_RECOVERY_CONFLICT',
    );

    const advanced = repo.upsertTaskWorkspace(taskId, { expectedRevision: 1, record: { ...insertRecord, state: 'READY' } });
    assert.equal(advanced.revision, 2);
    assert.equal(advanced.record.state, 'READY');

    const read = repo.getTaskWorkspace(taskId);
    assert.equal(read.revision, 2);
    assert.equal(read.record.workspace_path, insertRecord.workspace_path);
    assert.equal(read.record.pinned_base_sha, insertRecord.pinned_base_sha);
  } finally {
    await close();
  }
});

test('the ensureTaskWorkspace/cleanupTaskWorkspace lifecycle works end-to-end against the REAL SQLite-backed repository, not only the in-memory fixture', async () => {
  await withDisposableRoot(async (root) => {
    const { workDir } = initRepo(root, 'sqlite-e2e');
    const pin = headSha(workDir);
    const { repo, close } = await openSqliteRepo();
    try {
      const taskId = 'task-sqlite-e2e-1';
      const ws = await ensureTaskWorkspace({
        taskRepository: repo, projectRepoPath: workDir, projectId: 'proj-sqlite-e2e', taskId,
        taskBranch: deriveTaskBranchName(taskId), pinnedBaseSha: pin, runtimeWorktreeRoot: join(root, 'runtime-worktrees'),
      });
      assert.equal(ws.state, TASK_WORKSPACE_STATE.READY);
      assert.equal(git(ws.workspace_path, ['rev-parse', 'HEAD']).trim(), pin);

      const cleaned = await cleanupTaskWorkspace({ taskRepository: repo, projectRepoPath: workDir, taskId });
      assert.equal(cleaned.state, TASK_WORKSPACE_STATE.REMOVED);
      assert.equal(existsSync(ws.workspace_path), false);
      assert.equal(git(workDir, ['rev-parse', deriveTaskBranchName(taskId)]).trim(), pin);
    } finally {
      await close();
    }
  });
});

// P24.3B superseded this P24.3A invariant for the three files P24.3B
// intentionally, additively wires with an OPT-IN (dependency-presence-
// gated, default-null) DI seam: owner-task-controller.mjs
// (ensureTaskWorkspace/taskWorkspaceRoot), production-pm-worker.mjs
// (cleanupTaskWorkspace), and p5-production-composition.mjs (threads both
// through from `deps`). Those three now legitimately reference the
// module; the true "feature stays OFF" invariant moves to the REAL
// production entrypoint (scripts/p5-runtime.mjs) never enabling it, plus
// the behavioral proof in tests/p24-3b-production-workspace-routing.test.mjs
// that default construction (every existing caller) is unaffected.
test('no production runtime/owner composition file that has NOT opted into P24.3B routing imports task-workspace-manager.mjs', () => {
  const productionFiles = [
    '../src/owner/owner-control-service.mjs',
    '../src/pm/task-base-admission.mjs',
    '../src/pm/task-branch-binding.mjs',
    '../scripts/p5-runtime.mjs',
  ];
  for (const rel of productionFiles) {
    const url = new URL(rel, import.meta.url);
    const source = readFileSync(url, 'utf8');
    assert.equal(/task-workspace-manager/.test(source), false, `${rel} must not reference task-workspace-manager.mjs`);
  }
});
