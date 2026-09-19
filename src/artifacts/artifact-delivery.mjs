/**
 * P20.2 — report delivery mechanisms.
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §15–§16, §22,
 * docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §13.
 *
 *   VERBATIM_MATERIALIZATION — DSH writes the exact accepted visible bytes
 *     to the app-assigned attempt report path. No trim, no newline
 *     normalisation, no zero-width stripping, no "pretty Markdown" pass, no
 *     JSON canonicalisation, no semantic parse.
 *
 *   DIRECT_WRITE — the provider execution writes the assigned file itself.
 *     P20.2 provided the offline abstraction + fail-closed checks with a
 *     deterministic local fake `writer`. P20.8R2 activates the REAL
 *     production route: `writer` may instead be a stateless confirmation
 *     callback (marked `writer.expectPreExisting = true`) for a real async
 *     CLI backend whose own already-awaited invocation already wrote the
 *     file (src/pm/report-backends/cli-report-backends.mjs).
 *
 * This module never seals anything and never selects an authoritative
 * attempt (P20.3 owns that).
 */

import { existsSync, writeFileSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DELIVERY_MECHANISM } from './artifact-schema.mjs';

export { DELIVERY_MECHANISM };

export class ArtifactDeliveryError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactDeliveryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function assertAttemptShape(attempt) {
  if (!attempt || typeof attempt !== 'object' || typeof attempt.path !== 'string' || typeof attempt.reportPath !== 'string') {
    throw new ArtifactDeliveryError('a P20.1 AttemptWorkspace (with .path and .reportPath) is required', 'ARTIFACT_DELIVERY_BAD_ATTEMPT');
  }
}

/** The report path MUST resolve strictly inside the assigned attempt dir. */
function assertReportPathContained(attempt) {
  const attemptDir = resolve(attempt.path);
  const reportPath = resolve(attempt.reportPath);
  const rel = reportPath.slice(attemptDir.length);
  const insideDir = reportPath.startsWith(attemptDir + sep) && !rel.split(sep).includes('..');
  if (!insideDir) {
    throw new ArtifactDeliveryError(`assigned report path escapes the attempt directory: ${reportPath}`, 'ARTIFACT_DELIVERY_PATH_OUTSIDE_ATTEMPT', { attemptDir, reportPath });
  }
  return reportPath;
}

function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let n;
    // eslint-disable-next-line no-cond-assign
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Write `acceptedVisibleText` to `attempt.reportPath` byte-for-byte.
 *
 * @param {object} input
 * @param {object} input.attempt  P20.1 AttemptWorkspace
 * @param {string} input.acceptedVisibleText  EXACT accepted visible final content
 * @returns {{ mechanism: 'VERBATIM_MATERIALIZATION', reportPath: string, bytes: number, sha256: string }}
 */
export function deliverVerbatimMaterialization({ attempt, acceptedVisibleText }) {
  assertAttemptShape(attempt);
  if (typeof acceptedVisibleText !== 'string') {
    throw new ArtifactDeliveryError('acceptedVisibleText must be a string (the exact accepted visible bytes)', 'ARTIFACT_DELIVERY_NO_CONTENT');
  }
  const reportPath = assertReportPathContained(attempt);
  if (existsSync(reportPath)) {
    throw new ArtifactDeliveryError(`a report file already exists at the assigned attempt path; refusing to overwrite: ${reportPath}`, 'ARTIFACT_DELIVERY_REPORT_EXISTS', { reportPath });
  }
  const buf = Buffer.from(acceptedVisibleText, 'utf8');
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buf, { flag: 'wx' }); // exclusive; no normalisation
  } catch (error) {
    throw new ArtifactDeliveryError(`verbatim materialisation write failed: ${error.message}`, 'ARTIFACT_MATERIALIZATION_IO_FAILED', { reportPath, cause: error.code ?? null });
  }
  // Verify identity did not change (defensive; P20.3 will do the full gate).
  const onDisk = statSync(reportPath);
  if (onDisk.size !== buf.length) {
    throw new ArtifactDeliveryError(`materialised size ${onDisk.size} != accepted bytes ${buf.length}`, 'ARTIFACT_MATERIALIZATION_SIZE_MISMATCH', { reportPath });
  }
  return { mechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, reportPath, bytes: buf.length, sha256: sha256File(reportPath) };
}

/**
 * DIRECT_WRITE contract. `writer(assignedPath)` either (a) a deterministic
 * local fake that CAUSES the file to be created during this call (the
 * original P20.2 offline contract — still the default), or (b) a
 * synchronous CONFIRMATION callback for a real backend whose own async
 * provider invocation (already awaited by the caller, BEFORE this function
 * runs — see report-invocation.mjs / report-stage-completion.mjs) already
 * wrote the assigned file as a side effect of the model's own Write tool
 * use — set `writer.expectPreExisting = true` to select this mode (P20.8R2
 * §5/§6: "the app owns deterministic path allocation and verification; the
 * model owns the report bytes"). The marker lives on the writer function
 * itself (not a separate parameter here) so every existing call site
 * (ReportInvoker.invokeReport(), runBoundedDeliveryRepair()) picks up the
 * correct mode automatically from whichever writer the caller supplied,
 * with zero changes to those call sites.
 *
 * P20.2R R2 — the terminal ACKNOWLEDGEMENT text and the official REPORT FILE
 * are two different things:
 *   - `allowEmptyAck` governs ONLY the ack text (an empty ack is permitted
 *     when a real report file exists);
 *   - the assigned `report.md` MUST be non-zero-byte for a successful
 *     DIRECT_WRITE delivery candidate, regardless of `allowEmptyAck`.
 * (P20.3 adds the stronger whitespace-only Unicode emptiness rule + full
 * Integrity Gate; P20.2R only blocks the obvious zero-byte false delivery.)
 * Report bytes are never trimmed or rewritten.
 *
 * @param {object} input
 * @param {object} input.attempt
 * @param {(assignedPath: string) => ({ ackText?: string }|void)} input.writer
 *   set `writer.expectPreExisting = true` for the real-backend-already-wrote-it mode.
 * @param {boolean} [input.allowEmptyAck]  governs the ack text only
 * @returns {{ mechanism: 'DIRECT_WRITE', reportPath: string, bytes: number, sha256: string, ackText: string }}
 */
export function deliverDirectWrite({ attempt, writer, allowEmptyAck = true }) {
  assertAttemptShape(attempt);
  if (typeof writer !== 'function') {
    throw new ArtifactDeliveryError('a deterministic local writer function is required', 'ARTIFACT_DELIVERY_NO_WRITER');
  }
  const reportPath = assertReportPathContained(attempt);
  const expectPreExisting = writer.expectPreExisting === true;
  if (expectPreExisting) {
    // The real provider invocation already ran (awaited by the caller
    // BEFORE this function was called) and was expected to write the file
    // itself. Verify that now, before invoking the confirmation writer —
    // a missing file at this point is the model failing to write its
    // assigned deliverable, not an app-side delivery bug.
    if (!existsSync(reportPath)) {
      throw new ArtifactDeliveryError(`DIRECT_WRITE expected the provider invocation to have already written the assigned report, but no file exists at: ${reportPath}`, 'ARTIFACT_DIRECT_WRITE_REPORT_MISSING', { reportPath });
    }
  } else if (existsSync(reportPath)) {
    throw new ArtifactDeliveryError(`a report file already exists at the assigned attempt path; refusing to overwrite: ${reportPath}`, 'ARTIFACT_DELIVERY_REPORT_EXISTS', { reportPath });
  }
  let ack;
  try {
    ack = writer(reportPath) ?? {};
  } catch (error) {
    throw new ArtifactDeliveryError(`direct-write writer failed: ${error.message}`, 'ARTIFACT_DIRECT_WRITE_WRITER_FAILED', { reportPath, cause: error.code ?? null });
  }
  const ackText = typeof ack.ackText === 'string' ? ack.ackText : '';
  if (!existsSync(reportPath)) {
    throw new ArtifactDeliveryError(`direct-write completed but no report exists at the assigned path: ${reportPath}`, 'ARTIFACT_DIRECT_WRITE_REPORT_MISSING', { reportPath });
  }
  const st = statSync(reportPath);
  if (!st.isFile()) {
    throw new ArtifactDeliveryError(`assigned report path is not a regular file: ${reportPath}`, 'ARTIFACT_DIRECT_WRITE_NONREGULAR', { reportPath });
  }
  // R2: the official report file itself must not be zero bytes — an empty
  // ACK never authorises an empty REPORT.
  if (st.size === 0) {
    throw new ArtifactDeliveryError('DIRECT_WRITE produced a zero-byte official report file; an empty acknowledgement does not authorise an empty report', 'ARTIFACT_DIRECT_WRITE_REPORT_EMPTY', { reportPath });
  }
  if (ackText === '' && !allowEmptyAck) {
    throw new ArtifactDeliveryError('an empty terminal acknowledgement is not permitted here', 'ARTIFACT_DIRECT_WRITE_EMPTY_ACK', { reportPath });
  }
  return { mechanism: DELIVERY_MECHANISM.DIRECT_WRITE, reportPath, bytes: st.size, sha256: sha256File(reportPath), ackText };
}
