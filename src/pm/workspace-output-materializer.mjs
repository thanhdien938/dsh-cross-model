/**
 * P24.1G2 — typed workspace report materialization.
 *
 * Authority: reports/P24_1G_REQUESTED_REPORT_GIT_SETTLEMENT_AUDIT_FIX_20260916.md
 * (root cause: OUTPUT_CONTRACT_GAP — SINGLE artifact_v1's DIRECT_WRITE
 * report contract deliberately keeps the model READ_ONLY against the
 * repository and seals its report into the DSH-owned P20 artifact store
 * only; a repo-relative path named in task prose was never authoritative
 * and was never produced).
 *
 * This module is the SMALLEST safe fix for that gap: an application-owned,
 * typed `workspace_output.report_path` (normalized/validated in
 * owner-task-controller.mjs, never derived from task prose) tells DSH
 * itself — never the model — to copy the ALREADY-SEALED artifact bytes,
 * verbatim, into that one repo-relative path before Git settlement runs.
 * The model's own write permission/authority (`source_write_policy:
 * READ_ONLY`, report-prompt.mjs) is completely unchanged by this module.
 *
 * Every write here is DSH's own, from bytes DSH itself already sealed and
 * hashed (artifact-integrity.mjs's `hashReportDescriptor()` — the same
 * TOCTOU-safe, identity-checked read the P20 Artifact Integrity Gate uses
 * to seal a report in the first place) — never a second read of the raw
 * provider process output, never a transformation of the report content.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { resolveSafeRepoPath, WorkspaceSafeReadError } from './council/workspace-safe-reader.mjs';
import { isWithin } from '../artifacts/artifact-path-identity.mjs';
import { hashReportDescriptor, isReportEmpty, REPORT_SIZE_POLICY } from '../artifacts/artifact-integrity.mjs';
import { runGit } from './task-result-git-sync.mjs';

export class WorkspaceOutputError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WorkspaceOutputError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// §14 — the minimum typed, deterministic failure vocabulary the master
// prompt requires, plus two additive lifecycle-boundary codes this module
// itself needs (STORE_UNAVAILABLE / NO_SEALED_ARTIFACT) — never a bare
// Error, never a string scraped from a filesystem/git error message.
export const WORKSPACE_OUTPUT_CODE = Object.freeze({
  PATH_INVALID: 'WORKSPACE_OUTPUT_PATH_INVALID',
  PATH_ESCAPE: 'WORKSPACE_OUTPUT_PATH_ESCAPE',
  MATERIALIZATION_FAILED: 'WORKSPACE_OUTPUT_MATERIALIZATION_FAILED',
  EMPTY: 'WORKSPACE_OUTPUT_EMPTY',
  HASH_MISMATCH: 'WORKSPACE_OUTPUT_HASH_MISMATCH',
  NOT_IN_RESULT_COMMIT: 'WORKSPACE_OUTPUT_NOT_IN_RESULT_COMMIT',
  REMOTE_VERIFY_FAILED: 'WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED',
  STORE_UNAVAILABLE: 'WORKSPACE_OUTPUT_STORE_UNAVAILABLE',
  NO_SEALED_ARTIFACT: 'WORKSPACE_OUTPUT_NO_SEALED_ARTIFACT',
});

// A blanket `.git/` deny — workspace-safe-reader.mjs's own DENY_PATTERNS
// only denies the specific `.git-credentials` file, never the whole `.git`
// directory (it was written for READING arbitrary evidence files, where
// e.g. `.git/HEAD` is harmless to read). Writing/overwriting anything under
// `.git/` is never acceptable for a typed report-materialization target.
function assertNotDotGit(relPosixPath, reportPath) {
  if (relPosixPath === '.git' || relPosixPath.startsWith('.git/')) {
    throw new WorkspaceOutputError(`workspace_output.report_path may not target the .git directory: ${reportPath}`, WORKSPACE_OUTPUT_CODE.PATH_ESCAPE, { reportPath });
  }
}

// resolveSafeRepoPath()'s own symlink-escape check only runs when the
// candidate path already `existsSync()` — exactly wrong for a WRITE
// destination, which usually does not exist yet. This walks up from the
// candidate to the nearest EXISTING ancestor directory and verifies that
// ancestor's REAL (symlink/junction-resolved) path still lands inside
// `repoRootAbs` — the same real-filesystem-identity authority
// artifact-path-identity.mjs already establishes for the artifact store
// side, applied here to the repo-write side.
function assertNoAncestorSymlinkEscape(repoRootAbs, candidateAbs, reportPath) {
  let dir = dirname(candidateAbs);
  // Bounded: a path segment count is always finite; this can never loop
  // more times than the candidate has path components.
  for (let i = 0; i < 256; i += 1) {
    if (existsSync(dir)) {
      let real;
      try { real = realpathSync(dir); } catch { real = dir; }
      if (!isWithin(repoRootAbs, real)) {
        throw new WorkspaceOutputError(`workspace_output.report_path resolves outside the project root via a symlink/junction ancestor: ${reportPath}`, WORKSPACE_OUTPUT_CODE.PATH_ESCAPE, { reportPath });
      }
      return;
    }
    if (isWithin(repoRootAbs, dir) && resolve(dir) === resolve(repoRootAbs)) return;
    const parent = dirname(dir);
    if (parent === dir) return; // filesystem root reached — nothing more to walk
    dir = parent;
  }
}

/**
 * Resolve + fully validate a typed `workspace_output.report_path` against
 * `repoRoot`. Reuses `resolveSafeRepoPath()` — the ONE existing containment
 * + deny-list + symlink-escape authority this codebase already established
 * for Council's WORKSPACE_READ capability (workspace-safe-reader.mjs) —
 * rather than a second, diverging path-safety implementation. Adds only
 * what that read-oriented module does not need: a blanket `.git/` deny and
 * an ancestor-symlink-escape guard for a destination that may not exist yet.
 *
 * @returns {{ absPath: string, relPosixPath: string }}
 */
export function assertWorkspaceOutputPathSafe({ repoRoot, reportPath }) {
  if (typeof reportPath !== 'string' || reportPath.trim() === '') {
    throw new WorkspaceOutputError('workspace_output.report_path must be a non-empty string', WORKSPACE_OUTPUT_CODE.PATH_INVALID, { reportPath });
  }
  let resolved;
  try {
    resolved = resolveSafeRepoPath(repoRoot, reportPath);
  } catch (error) {
    if (error instanceof WorkspaceSafeReadError) {
      const escapeCodes = new Set(['WORKSPACE_READ_PATH_ABSOLUTE', 'WORKSPACE_READ_PATH_ESCAPE', 'WORKSPACE_READ_SYMLINK_ESCAPE', 'WORKSPACE_READ_REALPATH_DENIED']);
      const code = escapeCodes.has(error.code) ? WORKSPACE_OUTPUT_CODE.PATH_ESCAPE : WORKSPACE_OUTPUT_CODE.PATH_INVALID;
      throw new WorkspaceOutputError(`workspace_output.report_path is unsafe: ${error.message}`, code, { reportPath, cause: error.code });
    }
    throw error;
  }
  assertNotDotGit(resolved.relPosixPath, reportPath);
  assertNoAncestorSymlinkEscape(resolve(repoRoot), resolved.absPath, reportPath);
  return resolved;
}

/** git's own blob object id (SHA-1) for `buffer` — `sha1("blob "+len+"\0"+content)`. */
export function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

/**
 * The ONE DSH-owned, VERBATIM copy from a sealed P20 artifact into a typed
 * repo-relative workspace path. Never transforms content (no newline
 * normalization, no Markdown post-processing) — the destination file's
 * bytes are required to be byte-identical to the sealed artifact's bytes,
 * verified by both sha256 (§8 step 9/10) and, separately, by the exact git
 * blob object id the eventual commit will contain (so a caller can verify
 * "in the result commit" / "on the remote" purely with git plumbing, never
 * a second content re-read).
 *
 * @returns {{ absPath: string, relPath: string, sha256: string, bytes: number, blobSha1: string }}
 */
export function materializeWorkspaceOutput({
  repoRoot, reportPath, storeRoot, artifactRelpath,
  expectedSha256 = null, expectedBytes = null, nonEmpty = true,
  maxBytes = REPORT_SIZE_POLICY.maxReportBytes,
}) {
  const dest = assertWorkspaceOutputPathSafe({ repoRoot, reportPath });

  if (typeof storeRoot !== 'string' || !storeRoot) {
    throw new WorkspaceOutputError('an artifact store root is required to materialize workspace_output', WORKSPACE_OUTPUT_CODE.STORE_UNAVAILABLE, {});
  }
  if (typeof artifactRelpath !== 'string' || !artifactRelpath) {
    throw new WorkspaceOutputError('final_ref.artifact_relpath is required to materialize workspace_output', WORKSPACE_OUTPUT_CODE.NO_SEALED_ARTIFACT, {});
  }
  const sourceAbs = resolve(join(storeRoot, ...artifactRelpath.split('/')));
  if (!isWithin(storeRoot, sourceAbs)) {
    throw new WorkspaceOutputError('sealed artifact relpath escapes the artifact store root', WORKSPACE_OUTPUT_CODE.MATERIALIZATION_FAILED, { artifactRelpath });
  }

  let sourceRead;
  try {
    sourceRead = hashReportDescriptor(sourceAbs, { maxReportBytes: maxBytes });
  } catch (error) {
    throw new WorkspaceOutputError(`could not read the sealed artifact for materialization: ${error.message}`, WORKSPACE_OUTPUT_CODE.MATERIALIZATION_FAILED, { cause: error.code ?? null });
  }

  // Defense in depth — the sealed artifact.json's own recorded facts (from
  // the P20 Integrity Gate that sealed it, potentially minutes earlier)
  // must still agree with what DSH reads right now, byte for byte.
  if (typeof expectedSha256 === 'string' && expectedSha256 && sourceRead.sha256 !== expectedSha256) {
    throw new WorkspaceOutputError('sealed artifact bytes do not match the recorded final_ref sha256', WORKSPACE_OUTPUT_CODE.HASH_MISMATCH, { expectedSha256, actualSha256: sourceRead.sha256 });
  }
  if (Number.isInteger(expectedBytes) && sourceRead.bytes !== expectedBytes) {
    throw new WorkspaceOutputError('sealed artifact bytes do not match the recorded final_ref byte length', WORKSPACE_OUTPUT_CODE.HASH_MISMATCH, { expectedBytes, actualBytes: sourceRead.bytes });
  }
  if (nonEmpty !== false && isReportEmpty(sourceRead.buffer)) {
    throw new WorkspaceOutputError('sealed artifact is empty; workspace_output requires non-empty content', WORKSPACE_OUTPUT_CODE.EMPTY, {});
  }

  mkdirSync(dirname(dest.absPath), { recursive: true });
  const tmpPath = join(dirname(dest.absPath), `.dsh-workspace-output-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, sourceRead.buffer);
    renameSync(tmpPath, dest.absPath);
  } catch (error) {
    throw new WorkspaceOutputError(`could not write workspace output to ${reportPath}: ${error.message}`, WORKSPACE_OUTPUT_CODE.MATERIALIZATION_FAILED, { cause: error.code ?? null });
  }

  let writtenRead;
  try {
    writtenRead = hashReportDescriptor(dest.absPath, { maxReportBytes: maxBytes });
  } catch (error) {
    throw new WorkspaceOutputError(`could not verify the materialized workspace output: ${error.message}`, WORKSPACE_OUTPUT_CODE.MATERIALIZATION_FAILED, { cause: error.code ?? null });
  }
  if (writtenRead.sha256 !== sourceRead.sha256 || writtenRead.bytes !== sourceRead.bytes) {
    throw new WorkspaceOutputError('materialized workspace output does not byte-match the sealed artifact', WORKSPACE_OUTPUT_CODE.HASH_MISMATCH, {});
  }

  return Object.freeze({
    absPath: dest.absPath,
    relPath: dest.relPosixPath,
    sha256: writtenRead.sha256,
    bytes: writtenRead.bytes,
    blobSha1: gitBlobSha1(writtenRead.buffer),
  });
}

/**
 * `git rev-parse <ref>:<path>` — the git object id of the blob at `path` in
 * `ref`, or `null` when the path does not exist in that tree (a non-zero
 * exit, e.g. "fatal: path ... does not exist in ..."). Text-only plumbing
 * output (a 40-hex object id) — never a raw content read, so this is safe
 * to decode as UTF-8 via the existing `runGit()` helper (never a second,
 * bespoke binary-safe spawn implementation).
 */
async function readGitBlobShaAtRef({ projectRepoPath, ref, reportPath, spawnImpl, timeoutMs }) {
  const res = await runGit(['rev-parse', `${ref}:${reportPath}`], { cwd: projectRepoPath, spawnImpl, timeoutMs });
  const sha = res.ok ? res.stdout.trim() : null;
  return /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null;
}

/**
 * Prove — with git plumbing against the actual commit, never by re-trusting
 * the local worktree's own existence check alone — that `reportPath` is
 * present in `commitSha`'s tree with EXACTLY the blob content just
 * materialized. Throws `WORKSPACE_OUTPUT_NOT_IN_RESULT_COMMIT` (path
 * absent) or `WORKSPACE_OUTPUT_HASH_MISMATCH` (present but different
 * content) — the caller (production-pm-worker.mjs) folds either into the
 * SAME `LOCAL_GIT_FAILED` outcome dimension every other Git-lifecycle
 * defect already uses; it never reports `LOCAL_COMMIT_VERIFIED` when this
 * throws.
 */
export async function assertWorkspaceOutputInResultCommit({ projectRepoPath, commitSha, reportPath, expectedBlobSha1, spawnImpl, timeoutMs }) {
  const actual = await readGitBlobShaAtRef({ projectRepoPath, ref: commitSha, reportPath, spawnImpl, timeoutMs });
  if (!actual) {
    throw new WorkspaceOutputError(`workspace output path is not present in the result commit: ${reportPath}`, WORKSPACE_OUTPUT_CODE.NOT_IN_RESULT_COMMIT, { commitSha, reportPath });
  }
  if (actual !== expectedBlobSha1) {
    throw new WorkspaceOutputError(`workspace output blob in the result commit does not match the materialized content: ${reportPath}`, WORKSPACE_OUTPUT_CODE.HASH_MISMATCH, { commitSha, reportPath });
  }
  return Object.freeze({ commitSha, reportPath, blobSha1: actual });
}

/**
 * The remote-side twin of `assertWorkspaceOutputInResultCommit()`. Callers
 * pass the SAME `remoteSha` that `pushTaskResult()` already independently
 * verified (a real post-push `git fetch` + local-vs-remote SHA comparison —
 * task-result-git-sync.mjs) — so this function's local `rev-parse` against
 * that exact, already-remote-proven commit object is a proof about the
 * pushed remote tree's content, not merely the local worktree, without a
 * second network round trip. Throws `WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED`
 * for either an absent path or a content mismatch — the caller folds this
 * into `REMOTE_SYNC_FAILED`, never `REMOTE_PUSH_VERIFIED`.
 */
export async function assertWorkspaceOutputVerifiedOnRemote({ projectRepoPath, remoteSha, reportPath, expectedBlobSha1, spawnImpl, timeoutMs }) {
  const actual = await readGitBlobShaAtRef({ projectRepoPath, ref: remoteSha, reportPath, spawnImpl, timeoutMs });
  if (!actual || actual !== expectedBlobSha1) {
    throw new WorkspaceOutputError(`workspace output could not be verified on the remote-pushed commit: ${reportPath}`, WORKSPACE_OUTPUT_CODE.REMOTE_VERIFY_FAILED, { remoteSha, reportPath, found: actual });
  }
  return Object.freeze({ remoteSha, reportPath, blobSha1: actual });
}
