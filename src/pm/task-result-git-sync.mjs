/**
 * P12-R2 — durable, DSH-verified local commit / remote push of a completed
 * task's result (docs/p12/01_P12_R0_*_SONNET5.md §8; docs/p12/03_P12_R2_*).
 *
 * This is the FIRST git-write capability DSH has ever had — P10/P11/R1's
 * git helpers (git-facts-async.mjs, task-source-resolver.mjs's runGit) are
 * strictly read-only by design. This module is deliberately opt-in
 * (never called unless the owner explicitly requested it) and never trusts
 * a command's own exit code alone: every operation re-reads actual Git
 * state afterward (`git rev-parse`, `git status --porcelain`, a real
 * `git fetch` + SHA comparison for push) before reporting success — DSH
 * never trusts model prose ("I committed the changes") and never trusts a
 * subprocess exit code as the sole proof of a durable state change either.
 *
 * Every spawn is a bounded, argv-array (`shell:false`) call — never a shell
 * string, exactly the same discipline task-source-resolver.mjs already
 * uses. No message/stderr from `git` is ever surfaced to a caller beyond a
 * bounded, non-secret reason code (Part-style: never leak a credential
 * embedded in a remote URL that might appear in git's own error text).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { withReapedOwnedSpawnLifecycle } from '../runtime/backend-execution-observer.mjs';

export class GitSyncError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'GitSyncError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const GIT_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 45_000;
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_MESSAGE_LEN = 500;
export const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Exported (P18-W4R2) so task-branch-binding.mjs's git-lifecycle
// preparation/verification (fetch, rev-parse, merge-base, checkout) reuses
// the exact same bounded, argv-array (`shell:false`), timeout-guarded
// spawn discipline this module established in P12-R2 — never a second,
// drifted copy of the same subprocess-safety logic.
export function runGit(args, { cwd, timeoutMs = GIT_TIMEOUT_MS, spawnImpl = nodeSpawn, maxBytes = MAX_OUTPUT_BYTES, processSettlementOptions } = {}) {
  return new Promise((resolve) => {
    let child;
    const ownership = new AbortController();
    try {
      const ownedSpawn = withReapedOwnedSpawnLifecycle(spawnImpl, ownership.signal, processSettlementOptions);
      child = ownedSpawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, code: null, stdout: '', stderr: '', truncated: false });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    let timeoutInitiated = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(async () => {
      timeoutInitiated = true;
      ownership.abort();
      let ownershipState = 'UNRESOLVED_OWNERSHIP';
      try {
        const result = await child.__dshReapOwnedProcessTree?.();
        ownershipState = result?.state ?? ownershipState;
      } catch { /* unresolved remains fail-closed */ }
      finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated, timedOut: true, ownershipState });
    }, timeoutMs);
    child.stdout?.on?.('data', (chunk) => {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) { truncated = true; try { child.kill(); } catch { /* best-effort */ } return; }
      chunks.push(buf);
    });
    child.stderr?.on?.('data', (chunk) => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
    child.once('error', () => { if (!timeoutInitiated) finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated, ownershipState: 'CONFIRMED_EXITED' }); });
    child.once('close', (code) => { if (!timeoutInitiated) finish({ ok: code === 0, code, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated, ownershipState: 'CONFIRMED_EXITED' }); });
  });
}

function safeMessage(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  const fallback = 'DSH: task result';
  const chosen = text.length > 0 ? text : fallback;
  // Deterministic, bounded, single-line — never model prose passed through
  // uninspected: newlines are collapsed so a crafted multi-line "message"
  // can never inject a second, unreviewed commit-message paragraph.
  return chosen.replace(/[\r\n]+/g, ' ').slice(0, MAX_MESSAGE_LEN);
}

/**
 * Commit whatever is currently dirty in `projectRepoPath` (the backend's own
 * code changes plus, if materialization already ran, the freshly-written
 * `docs/history/**`/`progress.md` files — matching the pipeline order
 * docs/p12/00_*_PLAN_SONNET5.md §10 describes: materialize -> verify ->
 * commit -> push). If nothing is dirty, this is a verified no-op success
 * (LOCAL_COMMIT_VERIFIED, committed:false) — never a failure (P12-R2-H:
 * "Git not requested"/"nothing to do" is not the same as a Git failure).
 */
export async function commitTaskResult({ projectRepoPath, message, spawnImpl = nodeSpawn, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new GitSyncError('project repository path is required', 'LOCAL_GIT_FAILED', { reason: 'PROJECT_PATH_MISSING' });
  }
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], opts);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new GitSyncError('project working directory is not a git worktree', 'LOCAL_GIT_FAILED', { reason: 'NOT_A_WORKTREE' });
  }

  const statusBefore = await runGit(['status', '--porcelain'], opts);
  if (!statusBefore.ok) {
    throw new GitSyncError('git status failed', 'LOCAL_GIT_FAILED', { reason: 'STATUS_FAILED' });
  }
  const dirty = statusBefore.stdout.trim().length > 0;

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const branch = branchRes.ok ? branchRes.stdout.trim() : null;

  if (!dirty) {
    const headRes = await runGit(['rev-parse', 'HEAD'], opts);
    const sha = headRes.ok ? headRes.stdout.trim() : null;
    return Object.freeze({ status: 'LOCAL_COMMIT_VERIFIED', committed: false, sha: COMMIT_SHA_RE.test(sha ?? '') ? sha : null, branch, dirty: false, reason: 'NOTHING_TO_COMMIT' });
  }

  const addRes = await runGit(['add', '-A'], opts);
  if (!addRes.ok) {
    throw new GitSyncError('git add failed', 'LOCAL_GIT_FAILED', { reason: 'ADD_FAILED' });
  }
  const commitRes = await runGit(['commit', '-m', safeMessage(message)], opts);
  if (!commitRes.ok) {
    throw new GitSyncError('git commit failed', 'LOCAL_GIT_FAILED', { reason: 'COMMIT_FAILED' });
  }

  // Never trust the commit command's own exit code alone: re-read actual
  // state before reporting success.
  const headRes = await runGit(['rev-parse', 'HEAD'], opts);
  const sha = headRes.ok ? headRes.stdout.trim() : null;
  if (!sha || !COMMIT_SHA_RE.test(sha)) {
    throw new GitSyncError('could not verify the resulting commit SHA', 'LOCAL_GIT_FAILED', { reason: 'SHA_UNVERIFIED' });
  }
  const statusAfter = await runGit(['status', '--porcelain'], opts);
  const stillDirty = statusAfter.ok ? statusAfter.stdout.trim().length > 0 : true;

  return Object.freeze({ status: 'LOCAL_COMMIT_VERIFIED', committed: true, sha, branch, dirty: stillDirty, reason: 'COMMITTED' });
}

/**
 * Push the current branch (or an explicit `branch`) to `remote` and verify
 * the push independently of its own exit code: a real `git fetch` of that
 * exact branch, then a SHA comparison against local HEAD. A push whose exit
 * code is 0 but whose remote-tracking ref cannot be independently confirmed
 * to match is treated as unverified, never as success (P12-R2-E: "Verify
 * remote result").
 */
export async function pushTaskResult({ projectRepoPath, remote = 'origin', branch = null, spawnImpl = nodeSpawn, timeoutMs = PUSH_TIMEOUT_MS } = {}) {
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new GitSyncError('project repository path is required', 'REMOTE_SYNC_FAILED', { reason: 'PROJECT_PATH_MISSING' });
  }
  if (typeof remote !== 'string' || !REMOTE_NAME_RE.test(remote)) {
    throw new GitSyncError('Git remote name is invalid', 'GIT_REMOTE_INVALID', { reason: 'REMOTE_NAME_INVALID' });
  }
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], opts);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new GitSyncError('project working directory is not a git worktree', 'REMOTE_SYNC_FAILED', { reason: 'NOT_A_WORKTREE' });
  }
  const remoteCheck = await runGit(['remote', 'get-url', remote], opts);
  if (!remoteCheck.ok) {
    throw new GitSyncError(`remote is not configured: ${remote}`, 'REMOTE_SYNC_FAILED', { reason: 'REMOTE_NOT_CONFIGURED' });
  }

  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
    resolvedBranch = branchRes.ok ? branchRes.stdout.trim() : null;
  }
  if (!resolvedBranch || resolvedBranch === 'HEAD') {
    throw new GitSyncError('cannot push from a detached HEAD', 'REMOTE_SYNC_FAILED', { reason: 'DETACHED_HEAD' });
  }

  const localShaRes = await runGit(['rev-parse', 'HEAD'], opts);
  const localSha = localShaRes.ok ? localShaRes.stdout.trim() : null;
  if (!localSha || !COMMIT_SHA_RE.test(localSha)) {
    throw new GitSyncError('could not resolve local HEAD before pushing', 'REMOTE_SYNC_FAILED', { reason: 'LOCAL_HEAD_UNRESOLVED' });
  }

  const pushRes = await runGit(['push', remote, resolvedBranch], opts);
  if (!pushRes.ok) {
    throw new GitSyncError('git push failed', 'REMOTE_SYNC_FAILED', { reason: 'PUSH_FAILED' });
  }

  // Independent verification: a real fetch of the exact ref just pushed,
  // then compare SHAs — never rely on push's own exit code alone.
  const fetchRes = await runGit(['fetch', remote, resolvedBranch], opts);
  if (!fetchRes.ok) {
    throw new GitSyncError('could not verify remote state after push (fetch failed)', 'REMOTE_SYNC_FAILED', { reason: 'VERIFY_FETCH_FAILED' });
  }
  const remoteShaRes = await runGit(['rev-parse', 'FETCH_HEAD'], opts);
  const remoteSha = remoteShaRes.ok ? remoteShaRes.stdout.trim() : null;
  if (!remoteSha || !COMMIT_SHA_RE.test(remoteSha) || remoteSha !== localSha) {
    throw new GitSyncError('remote HEAD does not match local HEAD after push', 'REMOTE_SYNC_FAILED', { reason: 'SHA_MISMATCH' });
  }

  return Object.freeze({ status: 'REMOTE_PUSH_VERIFIED', remote, branch: resolvedBranch, sha: remoteSha });
}
