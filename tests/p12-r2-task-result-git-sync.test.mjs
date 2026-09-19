import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitTaskResult, pushTaskResult, GitSyncError } from '../src/pm/task-result-git-sync.mjs';

// P12-R2 — proves DSH's first-ever git WRITE capability against real,
// fully-local git repositories only (a local bare repo standing in for
// "origin" — never a real network/GitHub remote, matching the megaprompt's
// R5 TEST 5 "prefer a fixture/test target, never risk owner repositories").

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

let root;
test.before(() => { root = mkdtempSync(join(tmpdir(), 'p12-r2-gitsync-')); });
test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });

// ---- commitTaskResult -------------------------------------------------

test('commitTaskResult: nothing dirty is a verified no-op, never a failure', async () => {
  const dir = join(root, 'clean');
  const { workDir } = initWorktreeWithBareRemote(dir);
  const before = git(workDir, ['rev-parse', 'HEAD']).trim();
  const result = await commitTaskResult({ projectRepoPath: workDir });
  assert.equal(result.status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(result.committed, false);
  assert.equal(result.dirty, false);
  assert.equal(result.reason, 'NOTHING_TO_COMMIT');
  assert.equal(result.sha, before);
  assert.equal(result.branch, 'main');
});

test('commitTaskResult: dirty worktree is committed and independently verified via rev-parse HEAD', async () => {
  const dir = join(root, 'dirty');
  const { workDir } = initWorktreeWithBareRemote(dir);
  writeFileSync(join(workDir, 'CHANGED.md'), 'task result content\n');
  const result = await commitTaskResult({ projectRepoPath: workDir, message: 'DSH: task-abc result' });
  assert.equal(result.status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(result.committed, true);
  assert.equal(result.dirty, false);
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  const actualHead = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.equal(result.sha, actualHead);
  const log = git(workDir, ['log', '-1', '--format=%s']).trim();
  assert.equal(log, 'DSH: task-abc result');
});

test('commitTaskResult: a crafted multi-line message is collapsed to one line, never injecting extra commit text', async () => {
  const dir = join(root, 'multiline-msg');
  const { workDir } = initWorktreeWithBareRemote(dir);
  writeFileSync(join(workDir, 'CHANGED.md'), 'x\n');
  const result = await commitTaskResult({ projectRepoPath: workDir, message: 'line one\nline two\nrm -rf /' });
  assert.equal(result.committed, true);
  const log = git(workDir, ['log', '-1', '--format=%B']).trim();
  assert.equal(log.includes('\n'), false);
  assert.equal(log, 'line one line two rm -rf /');
});

test('commitTaskResult: not a git worktree fails closed with a typed code', async () => {
  const dir = join(root, 'not-a-repo');
  mkdirSync(dir, { recursive: true });
  await assert.rejects(
    () => commitTaskResult({ projectRepoPath: dir }),
    (e) => e instanceof GitSyncError && e.code === 'LOCAL_GIT_FAILED' && e.reason === 'NOT_A_WORKTREE',
  );
});

test('commitTaskResult: missing project path is refused before any git subprocess', async () => {
  await assert.rejects(() => commitTaskResult({}), (e) => e instanceof GitSyncError && e.reason === 'PROJECT_PATH_MISSING');
});

// ---- pushTaskResult -----------------------------------------------------

test('pushTaskResult: a real push is independently verified via fetch + SHA comparison, not just exit code', async () => {
  const dir = join(root, 'push-ok');
  const { bareDir, workDir } = initWorktreeWithBareRemote(dir);
  writeFileSync(join(workDir, 'CHANGED.md'), 'push me\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'local change']);
  const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();

  const result = await pushTaskResult({ projectRepoPath: workDir });
  assert.equal(result.status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(result.remote, 'origin');
  assert.equal(result.branch, 'main');
  assert.equal(result.sha, localSha);

  // Independently verify (from an unrelated clean clone) the bare "remote"
  // really has this exact SHA — proves the module's own verification isn't
  // trusting anything the module itself computed.
  const verifyClone = join(dir, 'verify-clone');
  git(dir, ['clone', '-q', bareDir, verifyClone]);
  const remoteSha = git(verifyClone, ['rev-parse', 'main']).trim();
  assert.equal(remoteSha, localSha);
});

test('pushTaskResult: no remote configured fails closed, never silently no-ops', async () => {
  const dir = join(root, 'no-remote');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);

  await assert.rejects(
    () => pushTaskResult({ projectRepoPath: dir }),
    (e) => e instanceof GitSyncError && e.code === 'REMOTE_SYNC_FAILED' && e.reason === 'REMOTE_NOT_CONFIGURED',
  );
});

test('pushTaskResult: push to an unreachable remote fails closed with a typed, non-leaking code', async () => {
  const dir = join(root, 'unreachable-remote');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  git(dir, ['remote', 'add', 'origin', 'https://user:secret-token@example.invalid/nonexistent.git']);

  try {
    await pushTaskResult({ projectRepoPath: dir, timeoutMs: 4000 });
    assert.fail('expected pushTaskResult to reject');
  } catch (error) {
    assert.ok(error instanceof GitSyncError);
    assert.equal(error.code, 'REMOTE_SYNC_FAILED');
    // The credential embedded in the (fake) remote URL must never surface
    // anywhere in the thrown error's own serializable shape.
    const serialized = JSON.stringify({ message: error.message, code: error.code, reason: error.reason });
    assert.equal(serialized.includes('secret-token'), false);
  }
});

test('pushTaskResult: missing project path is refused before any git subprocess', async () => {
  await assert.rejects(() => pushTaskResult({}), (e) => e instanceof GitSyncError && e.reason === 'PROJECT_PATH_MISSING');
});

// ---- combined pipeline: materialize-shaped dirty tree -> commit -> push -

test('a full commit-then-push pipeline against a local fixture remote works end-to-end, with the resulting SHA independently confirmable', async () => {
  const dir = join(root, 'pipeline');
  const { bareDir, workDir } = initWorktreeWithBareRemote(dir);
  // Simulate what R2 actually does: the backend changed a file, then
  // materialization wrote docs/history/** — all still uncommitted at once.
  writeFileSync(join(workDir, 'src-change.txt'), 'backend change\n');
  mkdirSync(join(workDir, 'docs', 'history', 'single', 'task-1'), { recursive: true });
  writeFileSync(join(workDir, 'docs', 'history', 'single', 'task-1', 'Task.md'), '# Task\n');

  const commitResult = await commitTaskResult({ projectRepoPath: workDir, message: 'DSH: task-1 result' });
  assert.equal(commitResult.committed, true);
  const pushResult = await pushTaskResult({ projectRepoPath: workDir });
  assert.equal(pushResult.sha, commitResult.sha);

  const verifyClone = join(dir, 'verify-clone-2');
  git(dir, ['clone', '-q', bareDir, verifyClone]);
  assert.equal(existsSync(join(verifyClone, 'src-change.txt')), true);
  assert.equal(existsSync(join(verifyClone, 'docs', 'history', 'single', 'task-1', 'Task.md')), true);
});
