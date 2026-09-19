import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareTaskBranch, TaskBranchLifecycleError } from '../src/pm/task-branch-binding.mjs';

// P18-W4R5 — task-branch BASE ISOLATION remediation. The real, live-owner-
// found defect: `prepareTaskBranch()` defaulted `base_branch` to whatever
// branch happened to be the workspace's CURRENT checkout at prepare time
// (`originalCheckout`), instead of the project's actual configured base.
// When the workspace was left sitting on a PRIOR `dsh/task-*` branch from
// an earlier task (the normal end-state after a task completes — nothing
// switches the workspace back to master/main), the next task's branch was
// silently created from that prior task branch's published head rather
// than from origin/master, folding the prior task's history (including any
// UNMERGED, task-local commits) into the new task.
//
// These tests exercise the fix against real, fully-local git repositories
// only (a local bare repo standing in for "origin" — same discipline as
// p18-w4r2-task-branch-binding.test.mjs).

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
test.before(() => { root = mkdtempSync(join(tmpdir(), 'p18-w4r5-branch-')); });
test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });

// ---- 1. workspace currently on master/main -> new task starts at base_sha -

test('workspace currently on main: a fresh task starts exactly at the remote base SHA', async () => {
  const dir = join(root, 'on-main');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const originSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-on-main' });
  assert.equal(binding.base_branch, 'main');
  assert.equal(binding.base_sha, originSha);
  assert.equal(git(workDir, ['rev-parse', 'HEAD']).trim(), originSha);
});

// ---- 2/3. workspace on a PRIOR task branch -> new task STILL bases off ----
//           the configured remote base, never the prior branch; none of
//           the prior branch's unmerged commits leak into the new one.

test('workspace left checked out on a PRIOR dsh/task-* branch: the next task STILL bases off the configured remote branch, never the prior task branch, and its unmerged commits never leak in', async () => {
  const dir = join(root, 'on-prior-task-branch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const originSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  // First task: prepares, then does unpushed, unmerged work on its own
  // branch. Nothing ever switches the workspace back to main afterward —
  // this is the real end-of-task state that triggered the live defect.
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-prior' });
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), first.task_branch);
  writeFileSync(join(workDir, 'prior-unmerged.txt'), 'unmerged prior-task work\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'prior task unmerged commit']);
  const priorTaskHeadSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(priorTaskHeadSha, originSha);

  // Second task: prepared while the workspace is STILL on the first task's
  // branch (no baseBranch override supplied — exactly how
  // owner-task-controller.mjs's real caller invokes this).
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), first.task_branch, 'sanity: workspace really is still on the prior task branch');
  const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-second' });

  assert.equal(second.base_branch, 'main');
  assert.equal(second.base_sha, originSha, 'base_sha must be origin/main, not the prior task branch head');
  assert.notEqual(second.base_sha, priorTaskHeadSha);
  assert.equal(git(workDir, ['rev-parse', second.task_branch]).trim(), originSha);

  // The prior task's unmerged commit must not appear in the new branch.
  const lsTree = git(workDir, ['ls-tree', '-r', '--name-only', second.task_branch]).trim();
  assert.equal(lsTree.includes('prior-unmerged.txt'), false);
  const mergeBase = git(workDir, ['merge-base', first.task_branch, second.task_branch]).trim();
  assert.equal(mergeBase, originSha, 'the only shared history is the common remote base, not one containing the other');

  // The prior branch itself is untouched — its unmerged commit is preserved.
  assert.equal(git(workDir, ['rev-parse', first.task_branch]).trim(), priorTaskHeadSha);
});

// ---- 4. local master ahead of origin/master, AND workspace on a prior -----
//         task branch -> new task uses the verified REMOTE base, neither
//         the locally-ahead master nor the prior task branch.

test('local main ahead of origin AND workspace on a prior task branch: the new task uses the verified remote base SHA, not local-ahead main and not the prior task branch', async () => {
  const dir = join(root, 'local-ahead-and-prior-branch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const originSha = git(workDir, ['rev-parse', 'origin/main']).trim();

  // Advance local main with a commit that is never pushed.
  writeFileSync(join(workDir, 'local-only.txt'), 'local ahead\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'local-only ahead commit']);
  const localMainSha = git(workDir, ['rev-parse', 'main']).trim();
  assert.notEqual(localMainSha, originSha);

  // First task branch: created from the verified remote base (origin/main),
  // not local-ahead main — then diverges with its own commit.
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-ahead-first' });
  assert.equal(first.base_sha, originSha);
  writeFileSync(join(workDir, 'first-task-work.txt'), 'first task work\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'first task work commit']);

  // Second task, prepared while checked out on the first task's branch:
  // must resolve to origin/main — immune to BOTH local-ahead main AND the
  // currently-checked-out prior task branch.
  const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-ahead-second' });
  assert.equal(second.base_branch, 'main');
  assert.equal(second.base_sha, originSha);
  assert.notEqual(second.base_sha, localMainSha);
  assert.notEqual(second.base_sha, git(workDir, ['rev-parse', first.task_branch]).trim());

  const lsTree = git(workDir, ['ls-tree', '-r', '--name-only', second.task_branch]).trim();
  assert.equal(lsTree.includes('local-only.txt'), false);
  assert.equal(lsTree.includes('first-task-work.txt'), false);
});

// ---- 5. recovery of the same task does not reset/recreate its branch -----

test('recovery of the same task (no baseBranch override, matching the real caller) reuses the existing branch and never resets it, even called from a different checkout', async () => {
  const dir = join(root, 'recovery-no-override');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-recover' });
  writeFileSync(join(workDir, 'in-progress.txt'), 'partial work\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'in-progress commit']);
  const partialSha = git(workDir, ['rev-parse', 'HEAD']).trim();

  // Recovery call: identical shape to owner-task-controller.mjs's real
  // call site — no baseBranch, no expectedBaseSha.
  const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-recover' });
  assert.equal(second.task_branch, first.task_branch);
  assert.equal(second.base_branch, first.base_branch);
  assert.equal(second.base_sha, first.base_sha);
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), first.task_branch);
  assert.equal(git(workDir, ['rev-parse', 'HEAD']).trim(), partialSha, 'the in-progress commit is preserved, never reset');
  assert.equal(git(workDir, ['log', '-1', '--format=%s']).trim(), 'in-progress commit');
});

// ---- 6. wrong existing task branch ancestry fails closed ------------------

test('an existing dsh/task-<id> branch with no common history with the configured base fails closed instead of being silently reused', async () => {
  const dir = join(root, 'wrong-ancestry');
  const { workDir } = initWorktreeWithBareRemote(dir);

  // Simulate a foreign/hand-tampered branch occupying the exact name DSH
  // would derive, built from a completely orphaned, unrelated history.
  git(workDir, ['checkout', '-q', '--orphan', 'dsh/task-task-r5-wrong']);
  git(workDir, ['rm', '-rq', '--cached', '.']);
  writeFileSync(join(workDir, 'unrelated.txt'), 'nothing to do with this project\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'unrelated orphan history']);
  git(workDir, ['checkout', '-q', 'main']);

  await assert.rejects(
    () => prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-wrong' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BASE_ANCESTRY_UNRESOLVED',
  );
  // The foreign branch itself is left completely untouched (never reset).
  assert.equal(git(workDir, ['log', '-1', '--format=%s', 'dsh/task-task-r5-wrong']).trim(), 'unrelated orphan history');
});

// ---- 7. dirty worktree still rejects before branch preparation ------------

test('a dirty workspace still refuses PREPARE outright even while checked out on a prior task branch', async () => {
  const dir = join(root, 'dirty-on-prior-branch');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-dirty-first' });
  writeFileSync(join(workDir, 'uncommitted.txt'), 'dirty\n');

  await assert.rejects(
    () => prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-r5-dirty-second' }),
    (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_WORKSPACE_DIRTY',
  );
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), first.task_branch, 'workspace never moved');
  const branches = git(workDir, ['branch', '--list']).trim().split('\n').map((l) => l.replace(/^\*?\s*/, '').trim());
  assert.equal(branches.includes('dsh/task-task-r5-dirty-second'), false, 'no branch created');
});

// ---- 8. SINGLE / COUNCIL / DEBATE share the same primitive ----------------

for (const taskMode of ['SINGLE', 'COUNCIL', 'DEBATE']) {
  test(`${taskMode}: base isolation holds identically while checked out on a prior task branch (same primitive, no per-mode variant)`, async () => {
    const dir = join(root, `mode-isolation-${taskMode.toLowerCase()}`);
    const { workDir } = initWorktreeWithBareRemote(dir);
    const originSha = git(workDir, ['rev-parse', 'origin/main']).trim();
    const first = await prepareTaskBranch({ projectRepoPath: workDir, taskId: `task-r5-${taskMode.toLowerCase()}-first` });
    writeFileSync(join(workDir, 'unmerged.txt'), 'unmerged\n');
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'unmerged commit']);

    const second = await prepareTaskBranch({ projectRepoPath: workDir, taskId: `task-r5-${taskMode.toLowerCase()}-second`, taskMode });
    assert.equal(second.task_mode, taskMode);
    assert.equal(second.base_sha, originSha);
    assert.notEqual(second.base_sha, git(workDir, ['rev-parse', first.task_branch]).trim());
  });
}
