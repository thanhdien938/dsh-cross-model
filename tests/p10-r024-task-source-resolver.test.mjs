import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveGitFileTaskSource, validateTaskFilePath, matchTaskFileDirective,
  TaskSourceError, MAX_TASK_FILE_BYTES,
} from '../src/owner/task-source-resolver.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  // Part I: every real canonical DSH project has an "origin" remote
  // configured — a placeholder, unreachable URL is fine here since the
  // happy-path tests below only need `git remote get-url` to succeed
  // (config presence), never an actual network fetch.
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/placeholder.git']);
  return dir;
}
function commitFile(dir, relPath, content) {
  const full = join(dir, ...relPath.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `add ${relPath}`]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

let root;
test.before(() => { root = mkdtempSync(join(tmpdir(), 'p10-r024-tsr-')); });
test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });

// ---- Part H: path validation ------------------------------------------------

test('valid tasks/dsh/*.md path is accepted', () => {
  assert.equal(validateTaskFilePath('tasks/dsh/FOO.md'), 'tasks/dsh/FOO.md');
  assert.equal(validateTaskFilePath('tasks/dsh/sub/FOO.md'), 'tasks/dsh/sub/FOO.md');
});

test('traversal segments are rejected', () => {
  assert.throws(() => validateTaskFilePath('tasks/dsh/../secrets.md'), (e) => e instanceof TaskSourceError && e.code === 'TASK_FILE_PATH_INVALID');
  assert.throws(() => validateTaskFilePath('tasks/dsh/./x.md'), (e) => e.code === 'TASK_FILE_PATH_INVALID');
});

test('absolute / drive-letter / UNC / backslash paths are rejected', () => {
  for (const bad of ['/etc/passwd', 'C:/tasks/dsh/x.md', '\\\\server\\share\\x.md', 'tasks\\dsh\\x.md']) {
    assert.throws(() => validateTaskFilePath(bad), (e) => e.code === 'TASK_FILE_PATH_INVALID', `expected rejection for: ${bad}`);
  }
});

test('a path outside tasks/dsh/ is rejected', () => {
  assert.throws(() => validateTaskFilePath('docs/dsh/x.md'), (e) => e.code === 'TASK_FILE_PATH_INVALID');
  assert.throws(() => validateTaskFilePath('tasks/other/x.md'), (e) => e.code === 'TASK_FILE_PATH_INVALID');
});

test('empty/non-.md paths are rejected', () => {
  assert.throws(() => validateTaskFilePath(''), (e) => e.code === 'TASK_FILE_PATH_INVALID');
  assert.throws(() => validateTaskFilePath('tasks/dsh/x.txt'), (e) => e.code === 'TASK_FILE_PATH_INVALID');
  assert.throws(() => validateTaskFilePath('tasks/dsh/'), (e) => e.code === 'TASK_FILE_PATH_INVALID');
});

// ---- Part B/§17.1: dispatch directive parsing ------------------------------

test('matchTaskFileDirective parses the exact --task-file <ref> <path> shape and nothing else', () => {
  assert.deepEqual(matchTaskFileDirective('--task-file ff134b8 tasks/dsh/X.md'), { ref: 'ff134b8', path: 'tasks/dsh/X.md' });
  assert.equal(matchTaskFileDirective('do the normal task'), null);
  // Part M: no task-file overrides — trailing prose after the directive is
  // not a task-file dispatch at all (falls back to plain-text handling,
  // which the caller will treat as an ordinary task body).
  assert.equal(matchTaskFileDirective('--task-file ff134b8 tasks/dsh/X.md extra prose'), null);
});

// ---- Part D-N: real git repository resolution ------------------------------

test('valid commit + valid task path resolves content, hash, and immutable commit sha', async () => {
  const repo = initRepo(join(root, 'repoA'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'hello world\n');
  const result = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/T.md' });
  assert.equal(result.type, 'GIT_FILE');
  assert.equal(result.resolvedCommitSha, sha);
  assert.equal(result.content, 'hello world\n');
  assert.equal(result.contentSha256, createHash('sha256').update(Buffer.from('hello world\n', 'utf8')).digest('hex'));
});

test('a branch name resolves to the immutable commit sha (not the branch string itself)', async () => {
  const repo = initRepo(join(root, 'repoBranch'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'v1\n');
  const result = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: 'main', path: 'tasks/dsh/T.md' });
  assert.equal(result.requestedRef, 'main');
  assert.equal(result.resolvedCommitSha, sha);
  assert.notEqual(result.resolvedCommitSha, 'main');
});

test('an immutable resolution is unaffected by a LATER commit on the same branch (Part G)', async () => {
  const repo = initRepo(join(root, 'repoImmutable'));
  const shaV1 = commitFile(repo, 'tasks/dsh/T.md', 'v1\n');
  const first = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: shaV1, path: 'tasks/dsh/T.md' });
  commitFile(repo, 'tasks/dsh/T.md', 'v2 — the branch moved on\n');
  // Re-resolving the SAME originally-pinned commit sha must still return v1.
  const second = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: shaV1, path: 'tasks/dsh/T.md' });
  assert.equal(first.content, second.content);
  assert.equal(second.content, 'v1\n');
});

test('missing path at a valid commit is TASK_FILE_NOT_FOUND', async () => {
  const repo = initRepo(join(root, 'repoMissingPath'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'x\n');
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/DOES_NOT_EXIST.md' }),
    (e) => e instanceof TaskSourceError && e.code === 'TASK_FILE_NOT_FOUND',
  );
});

test('a directory at the requested path (never a regular file) is TASK_FILE_NOT_FOUND', async () => {
  const repo = initRepo(join(root, 'repoDirlike'));
  // "tasks/dsh/dirlike.md" is itself a TREE (directory) in this commit —
  // it contains "inner.md" as a blob, so git treats the .md-suffixed
  // segment as a directory, not a file (Part AM #8).
  const sha = commitFile(repo, 'tasks/dsh/dirlike.md/inner.md', 'x\n');
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/dirlike.md' }),
    (e) => e.code === 'TASK_FILE_NOT_FOUND' && e.reason === 'NOT_A_BLOB',
  );
});

test('a binary/NUL-containing file is TASK_FILE_INVALID_TEXT', async () => {
  const repo = initRepo(join(root, 'repoBinary'));
  const full = join(repo, 'tasks', 'dsh', 'BIN.md');
  mkdirSync(join(repo, 'tasks', 'dsh'), { recursive: true });
  writeFileSync(full, Buffer.from([0x68, 0x69, 0x00, 0x62, 0x79, 0x65]));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'add binary']);
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/BIN.md' }),
    (e) => e.code === 'TASK_FILE_INVALID_TEXT',
  );
});

test('an oversized file is rejected as TASK_FILE_TOO_LARGE, never silently truncated', async () => {
  const repo = initRepo(join(root, 'repoOversize'));
  const big = 'x'.repeat(MAX_TASK_FILE_BYTES + 1024);
  const sha = commitFile(repo, 'tasks/dsh/BIG.md', big);
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/BIG.md' }),
    (e) => e.code === 'TASK_FILE_TOO_LARGE',
  );
});

test('an unconfigured expected remote is TASK_FILE_REPOSITORY_MISMATCH', async () => {
  const repo = initRepo(join(root, 'repoNoRemote'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'x\n');
  await assert.rejects(
    // `origin` DOES exist on this fixture (initRepo's placeholder) — the
    // mismatch is exercised by asking for a DIFFERENT, unconfigured remote
    // name, exactly like a real misconfigured project would hit.
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'upstream-not-configured', requestedRef: sha, path: 'tasks/dsh/T.md' }),
    (e) => e.code === 'TASK_FILE_REPOSITORY_MISMATCH',
  );
});

test('a non-git working directory is TASK_FILE_REPOSITORY_MISMATCH', async () => {
  const notARepo = join(root, 'notARepo');
  mkdirSync(notARepo, { recursive: true });
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: notARepo, expectedRemote: 'origin', requestedRef: 'HEAD', path: 'tasks/dsh/T.md' }),
    (e) => e.code === 'TASK_FILE_REPOSITORY_MISMATCH',
  );
});

test('a fetch is required and succeeds for a ref that exists only on the configured remote (Part F/G)', async () => {
  const upstream = initRepo(join(root, 'upstream'));
  commitFile(upstream, 'tasks/dsh/upstream-seed.md', 'seed\n');
  git(upstream, ['checkout', '-q', '-b', 'feature']);
  const featureSha = commitFile(upstream, 'tasks/dsh/FEATURE.md', 'feature content\n');
  git(upstream, ['checkout', '-q', 'main']);

  const local = join(root, 'localClone');
  git(root, ['clone', '-q', upstream, local]);
  // The local clone does NOT yet have the "feature" branch fetched.
  const result = await resolveGitFileTaskSource({ projectRepoPath: local, expectedRemote: 'origin', requestedRef: 'feature', path: 'tasks/dsh/FEATURE.md' });
  assert.equal(result.resolvedCommitSha, featureSha);
  assert.equal(result.content, 'feature content\n');
  assert.equal(result.fetched, true);
});

test('a ref that does not exist locally or on the remote is a typed failure (never a crash, never a fabricated result)', async () => {
  const upstream = initRepo(join(root, 'upstreamMissingRef'));
  commitFile(upstream, 'tasks/dsh/T.md', 'x\n');
  const local = join(root, 'localMissingRef');
  git(root, ['clone', '-q', upstream, local]);
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: local, expectedRemote: 'origin', requestedRef: 'this-ref-does-not-exist-anywhere', path: 'tasks/dsh/T.md' }),
    (e) => e.code === 'TASK_FILE_FETCH_FAILED' || e.code === 'TASK_FILE_REF_INVALID',
  );
});

test('resolution never mutates the project worktree — HEAD/branch/status are unchanged before and after', async () => {
  const upstream = initRepo(join(root, 'upstreamNoMutate'));
  commitFile(upstream, 'tasks/dsh/upstream-seed.md', 'seed\n');
  git(upstream, ['checkout', '-q', '-b', 'feature']);
  commitFile(upstream, 'tasks/dsh/FEATURE.md', 'feature content\n');
  git(upstream, ['checkout', '-q', 'main']);
  const local = join(root, 'localNoMutate');
  git(root, ['clone', '-q', upstream, local]);

  const before = { head: git(local, ['rev-parse', 'HEAD']).trim(), branch: git(local, ['branch', '--show-current']).trim(), status: git(local, ['status', '--porcelain']).trim() };
  await resolveGitFileTaskSource({ projectRepoPath: local, expectedRemote: 'origin', requestedRef: 'feature', path: 'tasks/dsh/FEATURE.md' });
  const after = { head: git(local, ['rev-parse', 'HEAD']).trim(), branch: git(local, ['branch', '--show-current']).trim(), status: git(local, ['status', '--porcelain']).trim() };
  assert.deepEqual(after, before);
});

test('every git spawn is argv-array, shell:false (never a shell string)', async () => {
  const repo = initRepo(join(root, 'repoShellFalse'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'x\n');
  const seenOptions = [];
  const realSpawn = (await import('node:child_process')).spawn;
  const capturingSpawn = (binary, args, options) => { seenOptions.push(options); return realSpawn(binary, args, options); };
  await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/T.md', spawnImpl: capturingSpawn });
  assert.ok(seenOptions.length > 0);
  for (const options of seenOptions) assert.equal(options.shell, false);
});

test('content hash is stable across repeated resolutions of the same commit/path', async () => {
  const repo = initRepo(join(root, 'repoStableHash'));
  const sha = commitFile(repo, 'tasks/dsh/T.md', 'stable content\n');
  const a = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/T.md' });
  const b = await resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/T.md' });
  assert.equal(a.contentSha256, b.contentSha256);
});

// ---- P10-R0.2.4.2 Part V: project-scoped repository identity ---------------
//
// The owner's live TEST 2/3 supplied a commit SHA from the DSH SOURCE repo
// (dsh-cross-model-debate-poc) while dispatching against a DIFFERENT target
// project (dsh-p6-test-b). These tests reproduce that exact shape with two
// independent real git repositories — proving the resolver rejects a
// foreign-repository ref/path pair without ever mutating the target
// project's worktree, using the SAME `projectRepoPath` (target-project-only)
// contract the resolver already exposes (Part H: no --task-repo, no
// cross-repository fetch — see task-source-resolver.mjs's own docstring).

test('Part V.1/V.5/V.6/V.7: valid target-project ref+path resolves; no worktree mutation', async () => {
  const target = initRepo(join(root, 'targetProjectValid'));
  const sha = commitFile(target, 'tasks/dsh/CANARY.md', 'target project content\n');
  const before = { head: git(target, ['rev-parse', 'HEAD']).trim(), status: git(target, ['status', '--porcelain']).trim() };
  const result = await resolveGitFileTaskSource({ projectRepoPath: target, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/CANARY.md' });
  assert.equal(result.resolvedCommitSha, sha);
  assert.equal(result.content, 'target project content\n');
  const after = { head: git(target, ['rev-parse', 'HEAD']).trim(), status: git(target, ['status', '--porcelain']).trim() };
  assert.deepEqual(after, before);
});

test('Part V.2: a commit SHA that only exists in a DIFFERENT (source) repository is rejected against the target project, never accepted', async () => {
  // "source" stands in for dsh-cross-model-debate-poc; "target" stands in
  // for dsh-p6-test-b. They are two entirely independent histories with
  // their own unrelated `origin` remotes — exactly like the real projects.
  const source = initRepo(join(root, 'foreignSourceRepo'));
  const foreignSha = commitFile(source, 'tasks/dsh/P10-R0.2.4_LONG_TASK_DISPATCH_CANARY.md', 'source-repo-only content\n');
  const target = initRepo(join(root, 'targetProjectForeignRef'));
  commitFile(target, 'tasks/dsh/OTHER.md', 'unrelated target content\n');

  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: target, expectedRemote: 'origin', requestedRef: foreignSha, path: 'tasks/dsh/P10-R0.2.4_LONG_TASK_DISPATCH_CANARY.md' }),
    // The foreign commit does not exist in the target project's local object
    // store, and the target's own (unrelated) `origin` remote cannot supply
    // it either — the resolver's existing, already-tested taxonomy
    // classifies this as TASK_FILE_FETCH_FAILED (or, if the ref happens to
    // parse as a bare hex string with no matching object at all,
    // TASK_FILE_REF_INVALID). Both are correct, honest "this ref does not
    // belong to this project's repository" outcomes — see Part N/Finding.
    (e) => e instanceof TaskSourceError && (e.code === 'TASK_FILE_FETCH_FAILED' || e.code === 'TASK_FILE_REF_INVALID'),
  );
});

test('Part V.3: valid target ref + missing file is TASK_FILE_NOT_FOUND (isolates path failure from repository mismatch)', async () => {
  const target = initRepo(join(root, 'targetProjectMissingFile'));
  const sha = commitFile(target, 'tasks/dsh/EXISTS.md', 'x\n');
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: target, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/DOES_NOT_EXIST_R0241.md' }),
    (e) => e.code === 'TASK_FILE_NOT_FOUND',
  );
});

test('Part V.4: a target project with no configured remote at all is TASK_FILE_REPOSITORY_MISMATCH (the owner\'s actual live failure mode)', async () => {
  const target = join(root, 'targetProjectNoRemote');
  mkdirSync(target, { recursive: true });
  git(target, ['init', '-q', '-b', 'main']);
  git(target, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(target, ['config', 'user.name', 'DSH Test']);
  const sha = commitFile(target, 'tasks/dsh/CANARY.md', 'x\n');
  // Deliberately NO `git remote add origin ...` — reproduces dsh-p6-test-b's
  // real state before this wave's remote was configured.
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: target, expectedRemote: 'origin', requestedRef: sha, path: 'tasks/dsh/CANARY.md' }),
    (e) => e.code === 'TASK_FILE_REPOSITORY_MISMATCH' && e.reason === 'REMOTE_NOT_CONFIGURED',
  );
});

test('a ref/remote value that starts with "-" is refused before ever reaching a git argv (defense against flag injection)', async () => {
  const repo = initRepo(join(root, 'repoFlagInjection'));
  commitFile(repo, 'tasks/dsh/T.md', 'x\n');
  await assert.rejects(
    resolveGitFileTaskSource({ projectRepoPath: repo, expectedRemote: 'origin', requestedRef: '--upload-pack=evil', path: 'tasks/dsh/T.md' }),
    (e) => e.code === 'TASK_FILE_REF_INVALID',
  );
});
