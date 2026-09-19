/**
 * P20.3A/§9–§16 — deterministic Invocation Artifact Gate + seal facts.
 *
 * Authority: docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md,
 * docs/P20/P20_3_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §5, §9–§16, §27.
 *
 * The gate is NON-SEMANTIC: a report containing malformed JSON, several
 * decisions, disagreement, or no structured answer is valid if it is
 * artifact-integrity-valid. It operates on FRESH DISK evidence (§5) — the
 * caller passes an `InvocationWorkspace` and the gate uses its
 * `freshRecord()` / `freshAttemptMetadata()` locked fresh reads, never a
 * cached snapshot.
 *
 * This module never writes app-owned metadata (the store does that) and
 * never modifies report bytes.
 */

import { openSync, fstatSync, readSync, closeSync, existsSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep, join } from 'node:path';
import { assertContainedRegularFile, isWithin } from './artifact-path-identity.mjs';

// ---- integrity states / codes (§27) — operational, never semantic ----
export const INTEGRITY_STATE = Object.freeze({
  ARTIFACT_PASS: 'ARTIFACT_PASS',
  REPORT_MISSING: 'REPORT_MISSING',
  REPORT_EMPTY: 'REPORT_EMPTY',
  REPORT_UNREADABLE: 'REPORT_UNREADABLE',
  REPORT_OUTSIDE_WORKSPACE: 'REPORT_OUTSIDE_WORKSPACE',
  REPORT_AMBIGUOUS: 'REPORT_AMBIGUOUS',
  REPORT_HASH_FAILED: 'REPORT_HASH_FAILED',
  REPORT_OVERSIZE: 'REPORT_OVERSIZE',
  REPORT_NONREGULAR: 'REPORT_NONREGULAR',
  REPORT_PATH_INVALID: 'REPORT_PATH_INVALID',
  REPORT_IDENTITY_CHANGED: 'REPORT_IDENTITY_CHANGED',
  REPORT_HARDLINK_UNSAFE: 'REPORT_HARDLINK_UNSAFE',
  EXECUTIVE_LOG_MISSING: 'EXECUTIVE_LOG_MISSING',
  ARTIFACT_METADATA_INVALID: 'ARTIFACT_METADATA_INVALID',
  ARTIFACT_STORE_MISMATCH: 'ARTIFACT_STORE_MISMATCH',
  ARTIFACT_SEAL_FAILED: 'ARTIFACT_SEAL_FAILED',
  ATTEMPT_COLLISION: 'ATTEMPT_COLLISION',
  STALE_CLAIM: 'STALE_CLAIM',
  TASK_CANCELLED: 'TASK_CANCELLED',
  UNKNOWN_PROVIDER_OUTCOME: 'UNKNOWN_PROVIDER_OUTCOME',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  DELIVERY_EVIDENCE_MISMATCH: 'DELIVERY_EVIDENCE_MISMATCH',
  ARTIFACT_REPAIRED: 'ARTIFACT_REPAIRED',
  ARTIFACT_REPAIR_FAILED: 'ARTIFACT_REPAIR_FAILED',
});

export class ArtifactIntegrityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactIntegrityError';
    this.code = code; // one of INTEGRITY_STATE
    Object.assign(this, extra);
  }
}
const fail = (code, message, extra = {}) => { throw new ArtifactIntegrityError(message, code, extra); };

// ---- §11 explicit, versioned report-size policy ----------------------
// 25 MiB — a deliberate, documented default: comfortably above any plausible
// Markdown report yet far below process/OS single-buffer limits, and small
// enough that a full-file hash is fast. Callers may lower it via
// createInvocationArtifactGate({ maxReportBytes }); never raise silently.
export const REPORT_SIZE_POLICY = Object.freeze({
  version: 'p20.3-size-1',
  maxReportBytes: 25 * 1024 * 1024,
});

// ---- §10 Unicode empty predicate ------------------------------------
// REPORT_EMPTY iff zero bytes OR the decoded text is only Unicode
// White_Space code points. Uses the Unicode `White_Space` property
// explicitly — it does NOT classify U+200B/U+200C/U+200D (zero-width) or
// U+FEFF as whitespace, so a zero-width-only file is NOT empty (§10).
const WHITESPACE_ONLY_RE = /^\p{White_Space}*$/u;

export function isReportEmpty(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ''), 'utf8');
  if (buf.length === 0) return true;
  return WHITESPACE_ONLY_RE.test(buf.toString('utf8'));
}

// ---- §12 containment + real filesystem identity --------------------
// P20.3R R8: containment delegates to the ONE shared platform-aware path
// primitive (src/artifacts/artifact-path-identity.mjs) — never a manual
// display-string `toLowerCase()`.

const CONTAINMENT_CODE = Object.freeze({
  PATH_INVALID: INTEGRITY_STATE.REPORT_PATH_INVALID,
  OUTSIDE_WORKSPACE: INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE,
  MISSING: INTEGRITY_STATE.REPORT_MISSING,
  UNREADABLE: INTEGRITY_STATE.REPORT_UNREADABLE,
  NONREGULAR: INTEGRITY_STATE.REPORT_NONREGULAR,
});

/**
 * Resolve + containment-check the expected report path against the trusted
 * store root and the assigned attempt directory. Fails closed on traversal,
 * drive change, UNC, symlink/junction/reparse escape, or a non-regular
 * file. Returns the resolved absolute path.
 */
export function assertReportContained({ storeRoot, attemptDir, reportPath }) {
  return assertContainedRegularFile({
    storeRoot,
    attemptDir,
    reportPath,
    lstatSync,
    existsSync,
    fail: (family, message) => fail(CONTAINMENT_CODE[family] ?? INTEGRITY_STATE.REPORT_PATH_INVALID, message),
  });
}

// ---- §13 descriptor-based hash + TOCTOU identity stability --------

/**
 * Open the expected report once, fstat identity/size, hash ALL bytes
 * through that descriptor, fstat again, reject size/identity drift, close.
 * Enforces the size policy and hardlink policy where link-count is reliable.
 *
 * @returns {{ sha256: string, bytes: number, ino: number, dev: number }}
 */
export function hashReportDescriptor(absReport, { maxReportBytes }) {
  let fd;
  try { fd = openSync(absReport, 'r'); } catch (error) {
    fail(error.code === 'EACCES' ? INTEGRITY_STATE.REPORT_UNREADABLE : INTEGRITY_STATE.REPORT_MISSING, `cannot open report: ${error.message}`);
  }
  try {
    const st1 = fstatSync(fd);
    if (!st1.isFile()) fail(INTEGRITY_STATE.REPORT_NONREGULAR, 'descriptor is not a regular file');
    // Hardlink policy — only where nlink is reliable (POSIX). On win32
    // fstat nlink is typically 1 for a normal file; an unreliable value is
    // not treated as unsafe (documented platform limitation).
    if (process.platform !== 'win32' && Number.isInteger(st1.nlink) && st1.nlink > 1) {
      fail(INTEGRITY_STATE.REPORT_HARDLINK_UNSAFE, `report has unsafe hardlink multiplicity (nlink=${st1.nlink})`);
    }
    if (st1.size > maxReportBytes) fail(INTEGRITY_STATE.REPORT_OVERSIZE, `report is ${st1.size} bytes, over the ${maxReportBytes}-byte policy`);

    const hash = createHash('sha256');
    const chunks = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    let n;
    // eslint-disable-next-line no-cond-assign
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      total += n;
      if (total > maxReportBytes) fail(INTEGRITY_STATE.REPORT_OVERSIZE, `report grew past the ${maxReportBytes}-byte policy during hashing`);
      const slice = buf.subarray(0, n);
      hash.update(slice);
      chunks.push(Buffer.from(slice)); // keep for the whitespace-only check + consumer reuse
    }
    const st2 = fstatSync(fd);
    if (st2.size !== st1.size || st2.ino !== st1.ino || st2.dev !== st1.dev || st2.mtimeMs !== st1.mtimeMs) {
      fail(INTEGRITY_STATE.REPORT_IDENTITY_CHANGED, 'report identity/size/mtime changed during validation');
    }
    if (total !== st1.size) fail(INTEGRITY_STATE.REPORT_HASH_FAILED, `hashed ${total} bytes but fstat size is ${st1.size}`);
    return { sha256: hash.digest('hex'), bytes: total, ino: st1.ino, dev: st1.dev, buffer: Buffer.concat(chunks, total) };
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
  }
}

// ---- §9 the Invocation Artifact Gate ------------------------------

// P20.3R R1 — terminal truth is checked BEFORE any repairable file failure
// (REPORT_MISSING / REPORT_EMPTY / candidate scan / delivery repair). An
// execution failure is NEVER artifact repair (freeze §23).
const NON_SUCCESS_TERMINAL_TO_STATE = Object.freeze({
  TIMEOUT: INTEGRITY_STATE.EXECUTION_FAILED,
  PROVIDER_ERROR: INTEGRITY_STATE.EXECUTION_FAILED,
  PROCESS_ERROR: INTEGRITY_STATE.EXECUTION_FAILED,
  TRUNCATED_OR_INCOMPLETE: INTEGRITY_STATE.EXECUTION_FAILED,
  CANCELLED: INTEGRITY_STATE.TASK_CANCELLED,
  UNKNOWN_OUTCOME: INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME,
});
// Invocation lifecycles that may present a sealable candidate.
const SEALABLE_LIFECYCLE = new Set(['DELIVERED']);

/**
 * @param {object} opts
 * @param {number} [opts.maxReportBytes]  override the size policy downward
 * @returns a gate function.
 */
export function createInvocationArtifactGate(opts = {}) {
  const maxReportBytes = Number.isInteger(opts.maxReportBytes) && opts.maxReportBytes > 0
    ? Math.min(opts.maxReportBytes, REPORT_SIZE_POLICY.maxReportBytes)
    : REPORT_SIZE_POLICY.maxReportBytes;

  /**
   * @param {object} input
   * @param {import('./artifact-store.mjs').ArtifactStore} input.store
   * @param {import('./artifact-store.mjs').InvocationWorkspace} input.invocation
   * @param {number} input.attemptOrdinal
   * @param {object} input.expected  app-owned identity to bind against:
   *        { storeId, projectId, taskId, invocationId, role, stage, round,
   *          profileId, actorAlias, executionId }
   * @returns {{ state, reportPath, sha256, bytes, buffer, sizePolicy, attemptMetadata, invocationRecord }}
   */
  return function runInvocationArtifactGate({ store, invocation, attemptOrdinal, expected }) {
    if (!store || typeof store.root !== 'string') fail(INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, 'a valid ArtifactStore is required');
    if (!invocation || typeof invocation.freshRecord !== 'function') fail(INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, 'a P20.1 InvocationWorkspace is required');
    if (!Number.isInteger(attemptOrdinal) || attemptOrdinal < 0) fail(INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, 'attemptOrdinal must be a non-negative integer');
    const exp = expected ?? {};

    // 1. FRESH disk read of invocation.json + schema validate (store method).
    let rec;
    try { rec = invocation.freshRecord(); } catch (error) {
      fail(error.code === 'ARTIFACT_INVOCATION_RECORD_CORRUPT' ? INTEGRITY_STATE.ARTIFACT_METADATA_INVALID : INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, `fresh invocation.json read failed: ${error.message}`, { cause: error.code });
    }
    // 2. FRESH disk read of the attempt artifact.json + schema validate.
    let meta;
    try { meta = invocation.freshAttemptMetadata(attemptOrdinal); } catch (error) {
      fail(INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, `fresh attempt artifact.json read failed: ${error.message}`, { cause: error.code });
    }

    // 3. identity must agree: expected <-> invocation.json <-> artifact.json.
    const idPairs = [
      ['store_id', exp.storeId, rec.store_id, meta.store_id],
      ['project_id', exp.projectId, rec.project_id, meta.project_id],
      ['task_id', exp.taskId, rec.task_id, meta.task_id],
      ['invocation_id', exp.invocationId, rec.invocation_id, meta.invocation_id],
      ['attempt_ordinal', attemptOrdinal, meta.attempt_ordinal],
      ['role', exp.role, rec.role, meta.role],
      ['stage', exp.stage, rec.stage, meta.stage],
      ['round', exp.round ?? null, rec.round ?? null, meta.round ?? null],
      ['profile_id', exp.profileId, rec.profile_id, meta.profile_id],
      ['actor_alias', exp.actorAlias, rec.actor_alias, meta.actor_alias],
    ];
    if (exp.executionId !== undefined) idPairs.push(['execution_id', exp.executionId, meta.execution_id]);
    for (const [field, ...vals] of idPairs) {
      const [head, ...rest] = vals;
      if (rest.some((v) => v !== head)) fail(INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH, `identity mismatch on ${field}: ${JSON.stringify(vals)}`);
    }
    if (rec.store_id !== store.storeId || rec.project_id !== store.projectId) {
      fail(INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH, `invocation belongs to store=${rec.store_id}/project=${rec.project_id}, not ${store.storeId}/${store.projectId}`);
    }

    // R1: TERMINAL TRUTH FIRST — before any report path resolution, hash,
    // empty check, candidate scan, or delivery repair.
    // (a) the invocation must be a sealable candidate — a RUNNING/ASSIGNED/
    //     FAILED/CANCELLED/SEALED invocation is not.
    if (!SEALABLE_LIFECYCLE.has(rec.lifecycle)) {
      let code = INTEGRITY_STATE.EXECUTION_FAILED;
      if (rec.lifecycle === 'CANCELLED') code = INTEGRITY_STATE.TASK_CANCELLED;
      else if (rec.lifecycle === 'FAILED' && rec.integrity_state === INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME) code = INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME;
      else if (rec.lifecycle === 'SEALED') code = INTEGRITY_STATE.ARTIFACT_SEAL_FAILED;
      fail(code, `invocation lifecycle ${rec.lifecycle} cannot present a sealable report candidate`, { lifecycle: rec.lifecycle });
    }
    // (b) the attempt's terminal_state must be EXACTLY 'SUCCESS'. A missing/
    //     null/unknown terminal_state on a would-be-delivered attempt is not
    //     accepted merely because a file exists (deterministic contract:
    //     missing/null => ARTIFACT_METADATA_INVALID).
    if (meta.terminal_state === undefined || meta.terminal_state === null) {
      fail(INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, 'attempt artifact.json has no terminal_state; not a sealable success candidate');
    }
    if (meta.terminal_state !== 'SUCCESS') {
      fail(NON_SUCCESS_TERMINAL_TO_STATE[meta.terminal_state] ?? INTEGRITY_STATE.EXECUTION_FAILED, `attempt terminal_state ${meta.terminal_state} is not SUCCESS — execution failure is not artifact repair`, { terminalState: meta.terminal_state });
    }

    // 4/5/6. containment against the trusted store root + assigned attempt dir.
    const attemptDir = join(invocation.path, `attempt-${String(attemptOrdinal).padStart(2, '0')}`);
    const reportRel = meta.report_relpath;
    if (typeof reportRel !== 'string' || !reportRel || reportRel.includes('\\') || reportRel.includes('..')) {
      fail(INTEGRITY_STATE.REPORT_PATH_INVALID, `artifact.json report_relpath is not a safe store-relative path: ${JSON.stringify(reportRel)}`);
    }
    const expectedReportAbs = resolve(store.root, ...reportRel.split('/'));
    const reportPath = assertReportContained({ storeRoot: store.root, attemptDir, reportPath: expectedReportAbs });

    // 7–14. descriptor hash + identity stability + size + regular-file.
    const hashed = hashReportDescriptor(reportPath, { maxReportBytes });

    // 10/11. not zero-byte / not Unicode-whitespace-only.
    if (isReportEmpty(hashed.buffer)) fail(INTEGRITY_STATE.REPORT_EMPTY, 'report is empty (zero bytes or Unicode-whitespace only)');

    // 17. observed delivery evidence, when present, must agree with actual bytes.
    if (typeof meta.report_sha256 === 'string' && meta.report_sha256 !== hashed.sha256) {
      fail(INTEGRITY_STATE.DELIVERY_EVIDENCE_MISMATCH, `delivery-evidence sha256 ${meta.report_sha256} != actual ${hashed.sha256}`);
    }
    if (Number.isInteger(meta.report_bytes) && meta.report_bytes !== hashed.bytes) {
      fail(INTEGRITY_STATE.DELIVERY_EVIDENCE_MISMATCH, `delivery-evidence bytes ${meta.report_bytes} != actual ${hashed.bytes}`);
    }

    // (terminal truth was already enforced above, before any file work — R1.)

    // 15. executive.log exists (finalizability is checked by the finalizer).
    const logRel = meta.executive_log_relpath;
    if (typeof logRel !== 'string' || !logRel) fail(INTEGRITY_STATE.EXECUTIVE_LOG_MISSING, 'artifact.json has no executive_log_relpath');
    const logAbs = resolve(store.root, ...logRel.split('/'));
    if (!isWithin(attemptDir, logAbs)) fail(INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE, `executive.log path is outside the attempt dir`);
    if (!existsSync(logAbs)) fail(INTEGRITY_STATE.EXECUTIVE_LOG_MISSING, `executive.log missing at ${logAbs}`);
    try { if (!statSync(logAbs).isFile()) fail(INTEGRITY_STATE.EXECUTIVE_LOG_MISSING, 'executive.log is not a regular file'); }
    catch (error) { fail(INTEGRITY_STATE.EXECUTIVE_LOG_MISSING, `executive.log stat failed: ${error.message}`); }

    return {
      state: INTEGRITY_STATE.ARTIFACT_PASS,
      reportPath,
      executiveLogPath: logAbs,
      sha256: hashed.sha256,
      bytes: hashed.bytes,
      buffer: hashed.buffer,
      sizePolicy: { version: REPORT_SIZE_POLICY.version, max_report_bytes: maxReportBytes },
      attemptMetadata: meta,
      invocationRecord: rec,
    };
  };
}

/** Default gate (full size policy). */
export const runInvocationArtifactGate = createInvocationArtifactGate();
