import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prepareTaskBranch, verifyBoundBranch, assertTaskBranchPublishable, isWorktreeClean,
  deriveTaskBranchName, isProtectedBranch, TaskBranchLifecycleError, TASK_BRANCH_PREFIX,
} from '../src/pm/task-branch-binding.mjs';

// P18-W4R2 — proves the trusted-local-git-effects task-branch binding
// against real, fully-local git repositories only (a local bare repo
// standing in for "origin" — never a real network/GitHub remote, matching
// this codebase's established discipline — see p12-r2-task-result-git-
// sync.test.mjs's own header).

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initWorktreeWithBareRemote(root, { branch = 'main' } = {}) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
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

let root;
test.before(() => { root = mkdtempSync(join(tmpdir(), 'p18-w4r2-branch-')); });
test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });

// ---- deriveTaskBranchName / isProtectedBranch (pure) -----------------------

test('deriveTaskBranchName: deterministic, always dsh/task-<task_id>, never a caller-supplied name', () => {
  assert.equal(deriveTaskBranchName('abc123'), 'dsh/task-abc123');
  assert.equal(deriveTaskBranchName('abc123'), deriveTaskBranchName('abc123'));
  assert.notEqual(deriveTaskBranchName('abc123'), deriveTaskBranchName('xyz789'));
  assert.equal(TASK_BRANCH_PREFIX, 'dsh/task-');
});

test('deriveTaskBranchName: an invalid task_id is refused with a typed code, never silently coerced', () => {
  assert.throws(() => deriveTaskBranchName(''), (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_TASK_ID_INVALID');
  assert.throws(() => deriveTaskBranchName(null), (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_TASK_ID_INVALID');
});

test('isProtectedBranch: main/master/release/*/production/* are protected; a dsh/task-* branch is not', () => {
  for (const name of ['main', 'master', 'release/1.0', 'production/live']) assert.equal(isProtectedBranch(name), true, name);
  assert.equal(isProtectedBranch('dsh/task-abc'), false);
  assert.equal(isProtectedBranch('feature/other'), false);
});

// ---- prepareTaskBranch: caller cannot provide branch -----------------------

test('prepareTaskBranch: ignores any caller-supplied branch-name-shaped field — branch is always dsh/task-<task_id>', async () => {
  const dir = join(root, 'no-caller-branch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({
    projectRepoPath: workDir, taskId: 'task-caller-1',
    branchName: 'evil-branch', branch: 'evil-branch', taskBranch: 'evil-branch', task_branch: 'evil-branch',
  });
  assert.equal(binding.task_branch, 'dsh/task-task-caller-1');
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'dsh/task-task-caller-1');
});

// ---- prepareTaskBranch: exact verified remote base SHA ---------------------

test('prepareTaskBranch: creates the branch from the exact verified remote base SHA', async () => {
  const dir = join(root, 'base-sha');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const remoteSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-base-1', projectId: 'proj-1', taskMode: 'SINGLE' });
  assert.equal(binding.base_sha, remoteSha);
  assert.equal(binding.task_branch, 'dsh/task-task-base-1');
  assert.equal(binding.base_branch, 'main');
  assert.equal(binding.remote, 'origin');
  assert.equal(binding.original_checkout, 'main');
  assert.equal(binding.project_id, 'proj-1');
  assert.equal(binding.task_mode, 'SINGLE');
  assert.equal(git(workDir, ['rev-parse', 'HEAD']).trim(), remoteSha);
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'dsh/task-task-base-1');
});

// ---- prepareTaskBranch: local-ahead base never contaminates the new branch -

test('prepareTaskBranch: a locally-ahead base branch never contaminates the new task branch', async () => {
  const dir = join(root, 'local-ahead');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const remoteSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  writeFileSync(join(workDir, 'local-only.txt'), 'local ahead\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'local-only ahead commit']);
  const localHeadSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(localHeadSha, remoteSha);

  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-ahead-1' });
  assert.equal(binding.base_sha, remoteSha);
  assert.equal(git(workDir, ['rev-parse', 'dsh/task-task-ahead-1']).trim(), remoteSha);
  const lsTree = git(workDir, ['ls-tree', '-r', '--name-only', 'dsh/task-task-ahead-1']).trim();
  assert.equal(lsTree.includes('local-only.txt'), false);
  // The original locally-ahead branch is completely untouched.
  assert.equal(git(workDir, ['rev-parse', 'main']).trim(), localHeadSha);
});

// ---- prepareTaskBranch: dirty workspace blocks before execution -----------

test('prepareTaskBranch: a dirty workspace refuses outright, before any branch is touched', async () => {
  const dir = join(root, 'dirty-workspace');
  const { workDir } = initWorktreeWithBareRemote(dir);
  writeFileSync(join(workDir, 'uncommitted.txt'), 'dirty\n');
  const branchesBefore = git(workDir, ['branch', '--list']).trim();

  await assert.rejects(
    () => prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-dirty-1' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_WORKSPACE_DIRTY',
  );
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  assert.equal(existsSync(join(workDir, 'uncommitted.txt')), true, 'never discarded');
  assert.equal(git(workDir, ['branch', '--list']).trim(), branchesBefore, 'no branch created');
});

// ---- one bound branch per mode (SINGLE / COUNCIL / DEBATE) -----------------
// task-branch-binding.mjs itself is mode-agnostic (task_mode is opaque
// metadata on the binding) — DEBATE is not yet a distinct top-level
// task_mode elsewhere in this codebase (production-pm-worker.mjs only ever
// computes SINGLE/COUNCIL), but this module's own binding logic never
// branches on task_mode at all, so it is exercised here directly to prove
// mode-independence at the layer that actually matters (the git effects).

for (const taskMode of ['SINGLE', 'COUNCIL', 'DEBATE']) {
  test(`prepareTaskBranch: ${taskMode} mode binds to exactly one dsh/task-<task_id> branch`, async () => {
    const dir = join(root, `mode-${taskMode.toLowerCase()}`);
    const { workDir } = initWorktreeWithBareRemote(dir);
    const taskId = `task-${taskMode.toLowerCase()}-1`;
    const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode });
    assert.equal(binding.task_mode, taskMode);
    assert.equal(binding.task_branch, `dsh/task-${taskId}`);
    const branches = git(workDir, ['branch', '--list']).trim().split('\n').map((l) => l.replace(/^\*?\s*/, '').trim());
    assert.deepEqual(branches.filter((b) => b.startsWith('dsh/task-')), [`dsh/task-${taskId}`]);
  });
}

// ---- repository-wide read, per mode ----------------------------------------

test('prepareTaskBranch: repository-wide read — every mode can read another remote branch that is neither its base nor its own task branch', async () => {
  const dir = join(root, 'repo-wide-read');
  const { bareDir, workDir } = initWorktreeWithBareRemote(dir);
  const otherClone = join(dir, 'other-clone');
  git(dir, ['clone', '-q', bareDir, otherClone]);
  git(otherClone, ['checkout', '-q', '-b', 'feature/other']);
  git(otherClone, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(otherClone, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(otherClone, 'OTHER.md'), 'other branch content\n');
  git(otherClone, ['add', '-A']);
  git(otherClone, ['commit', '-q', '-m', 'other branch commit']);
  git(otherClone, ['push', '-q', 'origin', 'feature/other']);

  for (const taskMode of ['SINGLE', 'COUNCIL', 'DEBATE']) {
    const taskId = `task-read-${taskMode.toLowerCase()}`;
    await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode, baseBranch: 'main' });
    const content = git(workDir, ['show', 'origin/feature/other:OTHER.md']).trim();
    assert.equal(content, 'other branch content');
    // Reading another branch never changes the bound writable branch.
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), `dsh/task-${taskId}`);
  }
});

test('prepareTaskBranch: a task can compare its own bound branch against the base branch', async () => {
  const dir = join(root, 'diff-against-base');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-diff-1' });
  writeFileSync(join(workDir, 'new-file.txt'), 'x\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'task change']);
  const diff = git(workDir, ['diff', '--name-only', `${binding.base_branch}...${binding.task_branch}`]).trim();
  assert.equal(diff, 'new-file.txt');
});

test('prepareTaskBranch: a task can inspect a prior, unrelated DSH task branch for context', async () => {
  const dir = join(root, 'prior-task-branch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-prior-1' });
  writeFileSync(join(workDir, 'prior.txt'), 'prior work\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'prior task commit']);
  git(workDir, ['checkout', '-q', first.original_checkout]);

  const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-prior-2' });
  assert.notEqual(second.task_branch, first.task_branch);
  const content = git(workDir, ['show', `${first.task_branch}:prior.txt`]).trim();
  assert.equal(content, 'prior work');
});

// ---- idempotent replay / rerun ---------------------------------------------

test('prepareTaskBranch: rerun/recovery with the identical task_id reuses the immutable binding, never a second checkout -b', async () => {
  const dir = join(root, 'idempotent-replay');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-replay-1' });
  writeFileSync(join(workDir, 'in-progress.txt'), 'partial work\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'in-progress commit']);

  // A real caller doing recovery reads `base_branch` back from its own
  // already-durable binding (task.context.taskBranch) — never re-derives
  // it from live checkout state, which at replay time IS the task branch
  // itself, not the original base.
  const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-replay-1', baseBranch: first.base_branch, expectedBaseSha: first.base_sha });
  // original_checkout honestly reflects whatever was checked out AT THIS
  // CALL (the task branch itself, on replay) — every other field of the
  // immutable binding is byte-identical to the first preparation.
  assert.deepEqual({ ...second, original_checkout: undefined }, { ...first, original_checkout: undefined });
  assert.equal(second.original_checkout, 'dsh/task-task-replay-1');
  // The in-progress commit is still there — replay never recreated the branch.
  assert.equal(git(workDir, ['log', '-1', '--format=%s']).trim(), 'in-progress commit');
});

test('prepareTaskBranch: base SHA drift after reservation fails closed', async () => {
  const dir = join(root, 'base-drift');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-drift-1' });
  await assert.rejects(
    () => prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-drift-1', baseBranch: 'main', expectedBaseSha: `${'f'.repeat(40)}` }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BASE_SHA_DRIFT',
  );
  // A brand-new preparation whose caller's own recorded baseline no longer
  // matches the live remote also fails closed (never silently proceeds on
  // stale information).
  await assert.rejects(
    () => prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-drift-2', baseBranch: 'main', expectedBaseSha: `${'a'.repeat(40)}` }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BASE_SHA_DRIFT',
  );
  assert.ok(binding.task_branch); // sanity: first preparation itself succeeded
});

// ---- verifyBoundBranch: fail-closed on an executor-changed checkout -------

test('verifyBoundBranch: an executor-changed checkout is caught fail-closed before commit', async () => {
  const dir = join(root, 'violation-commit');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-violation-1' });
  git(workDir, ['checkout', '-q', 'main']); // simulate the executor switching away during its own turn

  await assert.rejects(
    () => verifyBoundBranch({ projectRepoPath: workDir, binding, stage: 'PRE_COMMIT' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_VIOLATION'
      && e.expected_task_branch === binding.task_branch && e.observed_branch === 'main' && e.stage === 'PRE_COMMIT',
  );
});

test('verifyBoundBranch: an executor-changed checkout is caught fail-closed before push', async () => {
  const dir = join(root, 'violation-push');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-violation-2' });
  git(workDir, ['checkout', '-q', 'main']);

  await assert.rejects(
    () => verifyBoundBranch({ projectRepoPath: workDir, binding, stage: 'PRE_PUSH' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_VIOLATION' && e.stage === 'PRE_PUSH',
  );
});

test('verifyBoundBranch: no binding at all is refused distinctly from a mismatch', async () => {
  const dir = join(root, 'no-binding');
  const { workDir } = initWorktreeWithBareRemote(dir);
  await assert.rejects(
    () => verifyBoundBranch({ projectRepoPath: workDir, binding: null, stage: 'PRE_COMMIT' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_MISSING',
  );
});

// ---- assertTaskBranchPublishable: the full push-policy checklist ----------

test('assertTaskBranchPublishable: own task branch, own remote — authorized', async () => {
  const dir = join(root, 'publish-ok');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-pub-ok' });
  assert.equal(assertTaskBranchPublishable({ binding, requestedBranch: binding.task_branch, requestedRemote: binding.remote }), true);
});

test('assertTaskBranchPublishable: another task\'s branch is rejected', async () => {
  const dir = join(root, 'publish-foreign');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-pub-mine' });
  assert.throws(
    () => assertTaskBranchPublishable({ binding, requestedBranch: 'dsh/task-someone-elses-task', requestedRemote: binding.remote }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_VIOLATION',
  );
});

for (const protectedBranch of ['main', 'master', 'release/1.0', 'production/live']) {
  test(`assertTaskBranchPublishable: ${protectedBranch} is rejected even if somehow reached`, () => {
    const fakeBinding = { task_branch: protectedBranch, remote: 'origin' };
    assert.throws(
      () => assertTaskBranchPublishable({ binding: fakeBinding, requestedBranch: protectedBranch, requestedRemote: 'origin' }),
      (e) => e instanceof TaskBranchLifecycleError && (e.code === 'TASK_BRANCH_NAMESPACE_VIOLATION' || e.code === 'TASK_BRANCH_PROTECTED_NAME'),
    );
  });
}

test('assertTaskBranchPublishable: a non-allowlisted (mismatched) remote is rejected', async () => {
  const dir = join(root, 'publish-remote-mismatch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-pub-remote' });
  assert.throws(
    () => assertTaskBranchPublishable({ binding, requestedBranch: binding.task_branch, requestedRemote: 'upstream' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_REMOTE_MISMATCH',
  );
});

test('force push and branch deletion are structurally unavailable — no git invocation across a full prepare+commit+push flow ever carries --force/--force-with-lease/-D/--delete', async () => {
  const dir = join(root, 'no-force-no-delete');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const invocations = [];
  const { spawn: nodeSpawn } = await import('node:child_process');
  const spyingSpawn = (cmd, args, opts) => { invocations.push(args); return nodeSpawn(cmd, args, opts); };

  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-no-force', spawnImpl: spyingSpawn });
  writeFileSync(join(workDir, 'change.txt'), 'x\n');
  const { commitTaskResult, pushTaskResult } = await import('../src/pm/task-result-git-sync.mjs');
  await commitTaskResult({ projectRepoPath: workDir, message: 'DSH: no-force test', spawnImpl: spyingSpawn });
  await pushTaskResult({ projectRepoPath: workDir, branch: binding.task_branch, spawnImpl: spyingSpawn });

  const forbidden = ['--force', '--force-with-lease', '-D', '--delete'];
  for (const args of invocations) {
    for (const flag of forbidden) assert.equal(args.includes(flag), false, `unexpected ${flag} in: git ${args.join(' ')}`);
  }
  assert.ok(invocations.some((args) => args[0] === 'push'), 'a real push invocation happened');
});

// ---- isWorktreeClean ---------------------------------------------------

test('isWorktreeClean: true on a clean tree, false once something is dirty', async () => {
  const dir = join(root, 'worktree-clean');
  const { workDir } = initWorktreeWithBareRemote(dir);
  assert.equal(await isWorktreeClean({ projectRepoPath: workDir }), true);
  writeFileSync(join(workDir, 'dirty.txt'), 'x\n');
  assert.equal(await isWorktreeClean({ projectRepoPath: workDir }), false);
});
