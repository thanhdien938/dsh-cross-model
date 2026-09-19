import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkspaceOutputError, assertWorkspaceOutputPathSafe, materializeWorkspaceOutput, gitBlobSha1,
  assertWorkspaceOutputInResultCommit, assertWorkspaceOutputVerifiedOnRemote,
} from '../src/pm/workspace-output-materializer.mjs';

// P24.1G2 — direct unit coverage of the ONE DSH-owned materialization/
// verification primitive: never model prose, never a repo write from the
// model, VERBATIM bytes only, git-plumbing-proven "really in this commit /
// really on the remote".

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function withTempRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-repo-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function withTempStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-store-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function sealFixture(storeRoot, relpath, content) {
  const abs = join(storeRoot, ...relpath.split('/'));
  mkdirSync(join(storeRoot, ...relpath.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(abs, content);
  return { artifact_relpath: relpath, sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

// ---- assertWorkspaceOutputPathSafe -----------------------------------

test('assertWorkspaceOutputPathSafe: accepts a safe nested repo-relative path', () => withTempRepo((repoRoot) => {
  const { relPosixPath } = assertWorkspaceOutputPathSafe({ repoRoot, reportPath: 'reports/qualification/foo.md' });
  assert.equal(relPosixPath, 'reports/qualification/foo.md');
}));

test('assertWorkspaceOutputPathSafe: rejects .. traversal, absolute, UNC, and .git paths', () => withTempRepo((repoRoot) => {
  for (const p of ['../escape.md', '/etc/passwd', '\\\\host\\share\\x.md', '.git/config', '.git']) {
    assert.throws(() => assertWorkspaceOutputPathSafe({ repoRoot, reportPath: p }), WorkspaceOutputError, p);
  }
}));

test('assertWorkspaceOutputPathSafe: rejects a symlinked ancestor directory that escapes the repo root', {
  skip: process.platform === 'win32' && !process.env.DSH_TEST_ALLOW_SYMLINKS ? 'symlink creation requires elevated privileges on this Windows runner' : false,
}, () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-outside-'));
  try {
    mkdirSync(join(repoRoot, 'reports'), { recursive: true });
    symlinkSync(outside, join(repoRoot, 'reports', 'linked'), 'dir');
    assert.throws(() => assertWorkspaceOutputPathSafe({ repoRoot, reportPath: 'reports/linked/x.md' }), (e) => e.code === 'WORKSPACE_OUTPUT_PATH_ESCAPE');
  } finally { rmSync(repoRoot, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// ---- materializeWorkspaceOutput ---------------------------------------

test('materializeWorkspaceOutput: verbatim byte-identical copy, nested parent dirs created, hash matches', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const content = Buffer.from('# Report\n\nhello world\n', 'utf8');
  const finalRef = sealFixture(storeRoot, 'tasks/t1/single/alias/inv/attempt-00/report.md', content);
  const out = materializeWorkspaceOutput({
    repoRoot, reportPath: 'reports/qualification/nested/deep/foo.md', storeRoot,
    artifactRelpath: finalRef.artifact_relpath, expectedSha256: finalRef.sha256, expectedBytes: finalRef.bytes,
  });
  assert.equal(out.relPath, 'reports/qualification/nested/deep/foo.md');
  assert.equal(out.sha256, finalRef.sha256);
  assert.equal(out.bytes, finalRef.bytes);
  const written = readFileSync(out.absPath);
  assert.deepEqual(written, content, 'destination bytes are byte-identical to the sealed source — no transformation');
  assert.equal(out.blobSha1, gitBlobSha1(content));
})));

test('materializeWorkspaceOutput: required non_empty + zero-byte sealed artifact is rejected', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const finalRef = sealFixture(storeRoot, 'tasks/t1/report.md', Buffer.alloc(0));
  assert.throws(
    () => materializeWorkspaceOutput({ repoRoot, reportPath: 'reports/foo.md', storeRoot, artifactRelpath: finalRef.artifact_relpath, expectedSha256: finalRef.sha256, expectedBytes: finalRef.bytes, nonEmpty: true }),
    (e) => e.code === 'WORKSPACE_OUTPUT_EMPTY',
  );
})));

test('materializeWorkspaceOutput: non_empty:false permits an empty sealed artifact', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const finalRef = sealFixture(storeRoot, 'tasks/t1/report.md', Buffer.alloc(0));
  const out = materializeWorkspaceOutput({ repoRoot, reportPath: 'reports/foo.md', storeRoot, artifactRelpath: finalRef.artifact_relpath, expectedSha256: finalRef.sha256, expectedBytes: finalRef.bytes, nonEmpty: false });
  assert.equal(out.bytes, 0);
})));

test('materializeWorkspaceOutput: a tampered/stale expected sha256 fails closed (hash mismatch)', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const content = Buffer.from('real content', 'utf8');
  const finalRef = sealFixture(storeRoot, 'tasks/t1/report.md', content);
  assert.throws(
    () => materializeWorkspaceOutput({ repoRoot, reportPath: 'reports/foo.md', storeRoot, artifactRelpath: finalRef.artifact_relpath, expectedSha256: 'f'.repeat(64), expectedBytes: finalRef.bytes }),
    (e) => e.code === 'WORKSPACE_OUTPUT_HASH_MISMATCH',
  );
})));

test('materializeWorkspaceOutput: an unsafe destination path is refused before any read of the sealed artifact', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const finalRef = sealFixture(storeRoot, 'tasks/t1/report.md', Buffer.from('x'));
  assert.throws(
    () => materializeWorkspaceOutput({ repoRoot, reportPath: '../escape.md', storeRoot, artifactRelpath: finalRef.artifact_relpath, expectedSha256: finalRef.sha256, expectedBytes: finalRef.bytes }),
    (e) => e.code === 'WORKSPACE_OUTPUT_PATH_ESCAPE',
  );
})));

test('materializeWorkspaceOutput: re-materializing identical content is an idempotent no-op (restart/recovery safety)', () => withTempRepo((repoRoot) => withTempStore((storeRoot) => {
  const content = Buffer.from('idempotent content\n', 'utf8');
  const finalRef = sealFixture(storeRoot, 'tasks/t1/report.md', content);
  const args = { repoRoot, reportPath: 'reports/foo.md', storeRoot, artifactRelpath: finalRef.artifact_relpath, expectedSha256: finalRef.sha256, expectedBytes: finalRef.bytes };
  const first = materializeWorkspaceOutput(args);
  const second = materializeWorkspaceOutput(args); // simulates a crash-restart re-entry
  assert.deepEqual({ sha256: first.sha256, bytes: first.bytes, blobSha1: first.blobSha1 }, { sha256: second.sha256, bytes: second.bytes, blobSha1: second.blobSha1 });
})));

// ---- git-plumbing verification (real git, no network) -----------------

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initRepoWithBareRemote(root) {
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

test('assertWorkspaceOutputInResultCommit: passes when the exact blob is present in the commit, fails when absent or different', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-repo-'));
  try {
    const { workDir } = initRepoWithBareRemote(root);
    const content = Buffer.from('materialized report\n', 'utf8');
    mkdirSync(join(workDir, 'reports'), { recursive: true });
    writeFileSync(join(workDir, 'reports', 'foo.md'), content);
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'add report']);
    const sha = git(workDir, ['rev-parse', 'HEAD']).trim();

    const ok = await assertWorkspaceOutputInResultCommit({ projectRepoPath: workDir, commitSha: sha, reportPath: 'reports/foo.md', expectedBlobSha1: gitBlobSha1(content) });
    assert.equal(ok.commitSha, sha);

    await assert.rejects(
      assertWorkspaceOutputInResultCommit({ projectRepoPath: workDir, commitSha: sha, reportPath: 'reports/does-not-exist.md', expectedBlobSha1: gitBlobSha1(content) }),
      (e) => e.code === 'WORKSPACE_OUTPUT_NOT_IN_RESULT_COMMIT',
    );
    await assert.rejects(
      assertWorkspaceOutputInResultCommit({ projectRepoPath: workDir, commitSha: sha, reportPath: 'reports/foo.md', expectedBlobSha1: gitBlobSha1(Buffer.from('different')) }),
      (e) => e.code === 'WORKSPACE_OUTPUT_HASH_MISMATCH',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertWorkspaceOutputVerifiedOnRemote: proves the pushed commit tree contains the exact blob', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p24-1g2-mat-repo-'));
  try {
    const { bareDir, workDir } = initRepoWithBareRemote(root);
    const content = Buffer.from('remote-verified report\n', 'utf8');
    mkdirSync(join(workDir, 'reports'), { recursive: true });
    writeFileSync(join(workDir, 'reports', 'foo.md'), content);
    git(workDir, ['add', '-A']);
    git(workDir, ['commit', '-q', '-m', 'add report']);
    git(workDir, ['push', '-q', 'origin', 'main']);
    const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();
    const remoteSha = git(workDir, ['ls-remote', bareDir, 'main']).trim().split(/\s+/)[0];
    assert.equal(remoteSha, localSha);

    const ok = await assertWorkspaceOutputVerifiedOnRemote({ projectRepoPath: workDir, remoteSha, reportPath: 'reports/foo.md', expectedBlobSha1: gitBlobSha1(content) });
    assert.equal(ok.remoteSha, remoteSha);

    await assert.rejects(
      assertWorkspaceOutputVerifiedOnRemote({ projectRepoPath: workDir, remoteSha, reportPath: 'reports/foo.md', expectedBlobSha1: gitBlobSha1(Buffer.from('wrong')) }),
      (e) => e.code === 'WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
