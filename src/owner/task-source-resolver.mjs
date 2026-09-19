/**
 * P10-R0.2.4 — Git-backed LONG task source resolution (Part D-N).
 *
 * DSH itself resolves and loads an owner-authored long-task file from the
 * canonical project's own Git repository — the model/PM is never told to
 * `git fetch`/`git restore` task instructions as part of normal production
 * execution (Part D/AH stop condition:
 * TASK_FILE_RETRIEVAL_REQUIRES_MODEL_GIT_ACTION). Every spawn here is a
 * read-only, argv-array (`shell:false`) Git plumbing call — never a shell
 * string, never a mutation of the canonical project worktree (no checkout/
 * reset/merge/pull/restore — Part E/BB stop conditions):
 *
 *   1. `git rev-parse --is-inside-work-tree` / `git remote get-url <remote>`
 *      — confirm the project's own local worktree/remote identity (Part I).
 *   2. `git rev-parse --verify <ref>^{commit}` — resolve the OWNER-SUPPLIED
 *      ref to a concrete commit locally; only if that fails, a scoped
 *      `git fetch <remote> <ref>` (never a checkout) followed by the same
 *      resolution against `FETCH_HEAD` (Part F/G).
 *   3. `git cat-file -e/-t <sha>:<path>` — confirm the exact path exists at
 *      that immutable commit and is a regular blob, never a directory
 *      (Part H/AM).
 *   4. `git cat-file -s <sha>:<path>` — bounded size check BEFORE reading
 *      any content (Part J).
 *   5. `git show <sha>:<path>` — read the file bytes directly from Git
 *      object data (never `git restore`/`git checkout`), UTF-8-validated,
 *      hashed (Part K/M).
 *
 * The result is immutable once resolved (Part G): callers must always use
 * `resolvedCommitSha`, never re-resolve `requestedRef` against a branch
 * that may have moved during execution.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export class TaskSourceError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskSourceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- Part H: exact allowed path shape --------------------------------------
export const TASK_FILE_PATH_PREFIX = 'tasks/dsh/';
const TASK_FILE_PATH_RE = /^tasks\/dsh\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/;

// ---- Part J: bounded task-file size ----------------------------------------
export const MAX_TASK_FILE_BYTES = 256 * 1024; // 256 KiB, Part J recommended max

// ---- Part F: canonical remote, never silently chosen -----------------------
export const DEFAULT_EXPECTED_REMOTE = 'origin';

const GIT_TIMEOUT_MS = 15_000;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Part H — validate a Telegram/dispatch-supplied task-file path BEFORE it
 * ever reaches a Git argv. Rejects absolute paths, UNC paths, drive-letter
 * paths, backslashes, `.`/`..` traversal segments, and anything outside
 * `tasks/dsh/**.md`. Never trusts the caller-supplied string beyond this.
 */
export function validateTaskFilePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new TaskSourceError('task file path is required', 'TASK_FILE_PATH_INVALID', { path: rawPath ?? null });
  }
  if (rawPath.length > 512) {
    throw new TaskSourceError('task file path is too long', 'TASK_FILE_PATH_INVALID', { path: null });
  }
  if (rawPath.includes('\\')) {
    throw new TaskSourceError('task file path must use forward slashes only', 'TASK_FILE_PATH_INVALID', { path: rawPath });
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('//') || /^[A-Za-z]:/.test(rawPath)) {
    throw new TaskSourceError('task file path must be relative — absolute/UNC/drive-letter paths are refused', 'TASK_FILE_PATH_INVALID', { path: rawPath });
  }
  const segments = rawPath.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new TaskSourceError('task file path may not contain "." or ".." traversal segments', 'TASK_FILE_PATH_INVALID', { path: rawPath });
  }
  if (!TASK_FILE_PATH_RE.test(rawPath)) {
    throw new TaskSourceError(`task file path must match ${TASK_FILE_PATH_PREFIX}<name>.md`, 'TASK_FILE_PATH_INVALID', { path: rawPath });
  }
  return rawPath;
}

/** Part B/§17.1: parse `--task-file <ref> <path>` — the ENTIRE remaining text, nothing else (Part M: no task-file overrides). Returns `{ref,path}` or `null` (not a task-file directive at all — caller falls back to plain task text). */
const TASK_FILE_DIRECTIVE_RE = /^--task-file\s+(\S+)\s+(\S+)\s*$/;
export function matchTaskFileDirective(text) {
  const m = String(text ?? '').trim().match(TASK_FILE_DIRECTIVE_RE);
  if (!m) return null;
  return { ref: m[1], path: m[2] };
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new TaskSourceError('task file ref is invalid', 'TASK_FILE_REF_INVALID', { ref: typeof ref === 'string' ? ref.slice(0, 128) : null });
  }
  return ref;
}

function validateRemote(remote) {
  if (typeof remote !== 'string' || !REF_RE.test(remote)) {
    throw new TaskSourceError('expected remote is invalid', 'TASK_FILE_REPOSITORY_MISMATCH', { remote: null });
  }
  return remote;
}

/** One bounded, read-only, argv-array (never shell) git subprocess call. */
function runGit(args, { cwd, timeoutMs = GIT_TIMEOUT_MS, spawnImpl = nodeSpawn, maxBytes = MAX_TASK_FILE_BYTES + 4096 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('git', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, code: null, stdoutBuffer: Buffer.alloc(0), stderr: '', truncated: false });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      finish({ ok: false, code: null, stdoutBuffer: Buffer.concat(chunks), stderr, truncated, timedOut: true });
    }, timeoutMs);
    child.stdout?.on?.('data', (chunk) => {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        truncated = true;
        try { child.kill(); } catch { /* best-effort */ }
        return;
      }
      chunks.push(buf);
    });
    child.stderr?.on?.('data', (chunk) => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
    child.once('error', () => finish({ ok: false, code: null, stdoutBuffer: Buffer.concat(chunks), stderr, truncated }));
    child.once('close', (code) => finish({ ok: code === 0, code, stdoutBuffer: Buffer.concat(chunks), stderr, truncated }));
  });
}

/**
 * Part D-N — resolve exactly one GIT_FILE task source. Never mutates the
 * project worktree (no checkout/reset/merge/pull/restore); never changes
 * HEAD or the current branch. Throws a `TaskSourceError` with one of the
 * Part O typed codes on any failure — callers must not spawn a backend on
 * a thrown result (Part N: task acceptance order).
 */
export async function resolveGitFileTaskSource({
  projectRepoPath,
  expectedRemote = DEFAULT_EXPECTED_REMOTE,
  requestedRef,
  path,
  maxBytes = MAX_TASK_FILE_BYTES,
  spawnImpl = nodeSpawn,
  timeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new TaskSourceError('project repository path is required', 'TASK_FILE_REPOSITORY_MISMATCH', {});
  }
  const safePath = validateTaskFilePath(path);
  const ref = validateRef(requestedRef);
  const remote = validateRemote(expectedRemote);
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl, maxBytes: 8192 };

  // Part I: cwd really is the expected git worktree.
  const insideCheck = await runGit(['rev-parse', '--is-inside-work-tree'], opts);
  if (!insideCheck.ok || insideCheck.stdoutBuffer.toString('utf8').trim() !== 'true') {
    throw new TaskSourceError('project working directory is not a git worktree', 'TASK_FILE_REPOSITORY_MISMATCH', { reason: 'NOT_A_WORKTREE' });
  }
  // Part I: expected remote is actually configured.
  const remoteCheck = await runGit(['remote', 'get-url', remote], opts);
  if (!remoteCheck.ok) {
    throw new TaskSourceError(`expected remote is not configured: ${remote}`, 'TASK_FILE_REPOSITORY_MISMATCH', { reason: 'REMOTE_NOT_CONFIGURED', remote });
  }

  // Part G: resolve requestedRef to an immutable commit SHA — try locally
  // first (Part F: fetch only when needed), never checking out anything.
  let resolvedSha = await resolveCommit(ref, opts);
  let fetched = false;
  if (!resolvedSha) {
    const fetchResult = await runGit(['fetch', remote, ref], { ...opts, timeoutMs: Math.max(timeoutMs, 20_000) });
    if (!fetchResult.ok) {
      throw new TaskSourceError(`git fetch failed for ref: ${ref}`, 'TASK_FILE_FETCH_FAILED', { ref, remote });
    }
    fetched = true;
    resolvedSha = await resolveCommit('FETCH_HEAD', opts) ?? await resolveCommit(ref, opts);
  }
  if (!resolvedSha || !COMMIT_SHA_RE.test(resolvedSha)) {
    throw new TaskSourceError(`task file ref did not resolve to a commit: ${ref}`, 'TASK_FILE_REF_INVALID', { ref, fetched });
  }

  // Part H/AM: path must exist at that commit, and be a regular blob.
  const objectRef = `${resolvedSha}:${safePath}`;
  const existCheck = await runGit(['cat-file', '-e', objectRef], opts);
  if (!existCheck.ok) {
    throw new TaskSourceError(`task file not found at commit: ${safePath}`, 'TASK_FILE_NOT_FOUND', { path: safePath, resolvedCommitSha: resolvedSha });
  }
  const typeCheck = await runGit(['cat-file', '-t', objectRef], opts);
  if (!typeCheck.ok || typeCheck.stdoutBuffer.toString('utf8').trim() !== 'blob') {
    throw new TaskSourceError(`task file path is not a regular file: ${safePath}`, 'TASK_FILE_NOT_FOUND', { path: safePath, resolvedCommitSha: resolvedSha, reason: 'NOT_A_BLOB' });
  }

  // Part J: bounded size check BEFORE reading content.
  const sizeCheck = await runGit(['cat-file', '-s', objectRef], opts);
  const sizeText = sizeCheck.ok ? sizeCheck.stdoutBuffer.toString('utf8').trim() : '';
  const size = /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  if (size === null) {
    throw new TaskSourceError('failed to read task file size', 'TASK_FILE_READ_FAILED', { path: safePath, resolvedCommitSha: resolvedSha });
  }
  if (size > maxBytes) {
    throw new TaskSourceError(`task file exceeds the ${maxBytes}-byte limit: ${size} bytes`, 'TASK_FILE_TOO_LARGE', { path: safePath, resolvedCommitSha: resolvedSha, bytes: size, maxBytes });
  }

  // Part K: read bytes directly from Git object data — never git restore/checkout.
  const showResult = await runGit(['show', objectRef], { ...opts, maxBytes: maxBytes + 4096 });
  if (!showResult.ok) {
    throw new TaskSourceError(`git show failed for task file: ${safePath}`, 'TASK_FILE_READ_FAILED', { path: safePath, resolvedCommitSha: resolvedSha });
  }
  if (showResult.truncated || showResult.stdoutBuffer.length > maxBytes) {
    throw new TaskSourceError(`task file exceeds the ${maxBytes}-byte limit`, 'TASK_FILE_TOO_LARGE', { path: safePath, resolvedCommitSha: resolvedSha, maxBytes });
  }

  const buffer = showResult.stdoutBuffer;
  // Part K: reject binary/NUL-containing content; no automatic binary decoding.
  if (buffer.includes(0)) {
    throw new TaskSourceError('task file is not valid UTF-8 text (contains NUL)', 'TASK_FILE_INVALID_TEXT', { path: safePath, resolvedCommitSha: resolvedSha });
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new TaskSourceError('task file is not valid UTF-8 text', 'TASK_FILE_INVALID_TEXT', { path: safePath, resolvedCommitSha: resolvedSha });
  }

  const { createHash } = await import('node:crypto');
  const contentSha256 = createHash('sha256').update(buffer).digest('hex');

  return Object.freeze({
    type: 'GIT_FILE',
    requestedRef: ref,
    resolvedCommitSha: resolvedSha,
    path: safePath,
    remote,
    content,
    contentBytes: buffer.length,
    contentSha256,
    fetched,
  });
}

async function resolveCommit(ref, opts) {
  const result = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], opts);
  if (!result.ok) return null;
  const sha = result.stdoutBuffer.toString('utf8').trim();
  return COMMIT_SHA_RE.test(sha) ? sha : null;
}

// ---- P12-R1: named, bounded source-kind vocabulary -------------------------
// Orthogonal to durability (P12-R0 §4/§7): a task's source kind never
// implies how durably its result is handled. There is still exactly one
// resolver (above) and exactly one durable source shape (`type:'GIT_FILE'`)
// — these three names are a classification LABEL for owner-facing/artifact
// reporting, never a second resolution path.
export const TASK_SOURCE_KIND = Object.freeze({
  DIRECT_PROMPT: 'DIRECT_PROMPT',
  LOCAL_TASK_FILE: 'LOCAL_TASK_FILE',
  PINNED_GIT_TASK_FILE: 'PINNED_GIT_TASK_FILE',
});

/**
 * Classify an already-resolved task source (or its absence) into one of the
 * three TASK_SOURCE_KIND labels. `taskSource` is either `null`/`undefined`
 * (no `--task-file` directive was used — a DIRECT_PROMPT task) or the frozen
 * result object `resolveGitFileTaskSource()` returns. The distinction
 * between LOCAL_TASK_FILE and PINNED_GIT_TASK_FILE is exactly the
 * resolver's own `fetched` flag: the ref was already resolvable in the
 * project's local worktree (LOCAL_TASK_FILE) vs. it required a `git fetch`
 * from the remote to resolve (PINNED_GIT_TASK_FILE) — no new resolver logic,
 * a pure projection of data the resolver already returns.
 */
export function classifyTaskSourceKind(taskSource) {
  if (!taskSource) return TASK_SOURCE_KIND.DIRECT_PROMPT;
  return taskSource.fetched ? TASK_SOURCE_KIND.PINNED_GIT_TASK_FILE : TASK_SOURCE_KIND.LOCAL_TASK_FILE;
}
