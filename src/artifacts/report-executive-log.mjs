/**
 * P20.2 — executive.log delivery evidence (NOT the final seal authority).
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §17,
 * docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §12.
 *
 * Writes only safe operational facts to the app-assigned attempt
 * `executive.log` path. Never writes API keys, auth headers, `.env`,
 * hidden reasoning, or unsanitised stderr. Reuses the existing audit
 * sanitiser. P20.3 owns log finalisation / seal — this is delivery
 * evidence a later gate can build on.
 */

import { existsSync, writeFileSync, readFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { sanitizeAuditData } from '../orchestration/audit-sanitize.mjs';

export class ReportExecutiveLogError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ReportExecutiveLogError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const SAFE_FIELDS = [
  'task_id', 'invocation_id', 'execution_id', 'attempt_ordinal',
  'store_id', 'project_id', 'role', 'stage', 'round',
  'profile_id', 'backend', 'model', 'actor_alias',
  'started_at', 'finished_at', 'duration_ms',
  'terminal_state', 'timed_out', 'cancelled',
  // P23.1 §5 — additive top-level convenience field for a non-SUCCESS
  // executive log; the same fact is also nested under `safe_diagnostics
  // .error_code` (every report backend's *ErrorToResult() already sets
  // that), so this never becomes the sole place the fact lives.
  'error_code',
  'provider_finish_reason', 'process_exit_code',
  'delivery_mechanism', 'input_transport',
  'assigned_report_relpath', 'report_bytes', 'report_sha256_observed',
  'visible_output_source', 'usage',
  // P23.1 §5 — additive: points at the sibling execution-diagnostics.json
  // (execution-diagnostics-artifact.mjs) when one was written for a
  // non-SUCCESS terminal result. `null`/absent for a SUCCESS attempt (no
  // diagnostics artifact is ever written on the success path).
  'diagnostics_artifact_relpath',
  // P24.3C-R1 — additive durable per-invocation task-workspace evidence
  // (reports/P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md's
  // ECRY_SAME_TASK_WORKSPACE_REUSED gap: no invocation/artifact record
  // durably carried the actual execution cwd, so full isolation reuse could
  // only be SUPPORTED, never PROVEN, per invocation). `null` for a legacy
  // task with no isolated workspace binding (byte-for-byte unaffected) — the
  // SAME absence convention as every other schema-v10/v11 workspace field.
  'workspace_isolation_version', 'workspace_repository_common_dir', 'workspace_path',
];

/**
 * @param {object} input
 * @param {object} input.attempt  P20.1 AttemptWorkspace (needs .path + .executiveLogPath)
 * @param {object} input.facts    a flat object of the safe fields above
 * @param {object} [input.safeDiagnostics]  already-sanitised extra facts
 * @returns {{ path: string, bytes: number }}
 */
export function writeReportExecutiveLog({ attempt, facts, safeDiagnostics = null }) {
  if (!attempt || typeof attempt.executiveLogPath !== 'string' || typeof attempt.path !== 'string') {
    throw new ReportExecutiveLogError('a P20.1 AttemptWorkspace with .executiveLogPath is required', 'REPORT_EXECLOG_BAD_ATTEMPT');
  }
  const logPath = resolve(attempt.executiveLogPath);
  const attemptDir = resolve(attempt.path);
  if (!(logPath.startsWith(attemptDir + sep) && !logPath.slice(attemptDir.length).split(sep).includes('..'))) {
    throw new ReportExecutiveLogError(`executive.log path escapes the attempt directory: ${logPath}`, 'REPORT_EXECLOG_PATH_OUTSIDE_ATTEMPT', { logPath });
  }
  if (existsSync(logPath)) {
    throw new ReportExecutiveLogError(`executive.log already exists at the assigned path; refusing to overwrite: ${logPath}`, 'REPORT_EXECLOG_EXISTS', { logPath });
  }

  const clean = {};
  for (const key of SAFE_FIELDS) {
    if (facts != null && facts[key] !== undefined) clean[key] = sanitizeAuditData(facts[key]);
  }
  const body = {
    kind: 'P20ReportDeliveryEvidence',
    schema_version: 1,
    note: 'delivery evidence only — NOT a seal or authoritative reference (P20.3 owns that)',
    ...clean,
    safe_diagnostics: safeDiagnostics == null ? null : sanitizeAuditData(safeDiagnostics),
    written_at: new Date().toISOString(),
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new ReportExecutiveLogError(`executive.log write failed: ${error.message}`, 'REPORT_EXECLOG_IO_FAILED', { logPath, cause: error.code ?? null });
  }
  return { path: logPath, bytes: Buffer.byteLength(text, 'utf8') };
}

// ---- P20.3 §14 — executive-log finalization -------------------------

const FINALIZATION_ALLOWED = new Set([
  'integrity_state', 'final_report_bytes', 'final_report_sha256',
  'repair_state', 'seal_at', 'seal_version', 'size_policy_version', 'max_report_bytes',
]);

/**
 * Add app-owned OPERATIONAL finalization fields to an existing
 * `executive.log` (delivery evidence -> seal-required record). The original
 * delivery-evidence fields are preserved verbatim — this never rewrites
 * historical execution truth and never adds semantic interpretation or
 * hidden reasoning. A sealed attempt requires this to succeed.
 *
 * @param {object} input
 * @param {string} input.logPath
 * @param {object} input.finalization  keys limited to FINALIZATION_ALLOWED
 * @returns {{ path: string, bytes: number }}
 */
export function finalizeReportExecutiveLog({ logPath, finalization }) {
  if (typeof logPath !== 'string' || !logPath) {
    throw new ReportExecutiveLogError('logPath is required', 'REPORT_EXECLOG_BAD_ATTEMPT');
  }
  if (!existsSync(logPath)) {
    throw new ReportExecutiveLogError(`executive.log is missing at ${logPath}; cannot finalize`, 'EXECUTIVE_LOG_MISSING', { logPath });
  }
  let existing;
  try {
    existing = JSON.parse(readFileSync(logPath, 'utf8'));
  } catch (error) {
    throw new ReportExecutiveLogError(`executive.log is unreadable/corrupt: ${error.message}`, 'ARTIFACT_METADATA_INVALID', { logPath });
  }
  const clean = {};
  for (const [k, v] of Object.entries(finalization ?? {})) {
    if (!FINALIZATION_ALLOWED.has(k)) {
      throw new ReportExecutiveLogError(`finalization field ${JSON.stringify(k)} is not an allowed operational field`, 'ARTIFACT_METADATA_INVALID', { field: k });
    }
    if (v !== undefined) clean[k] = sanitizeAuditData(v);
  }
  const merged = { ...existing, finalized: true, finalization: { ...clean, finalized_at: new Date().toISOString() } };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const tmp = `${logPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, logPath);
  } catch (error) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new ReportExecutiveLogError(`executive.log finalization write failed: ${error.message}`, 'ARTIFACT_SEAL_FAILED', { logPath, cause: error.code ?? null });
  }
  return { path: logPath, bytes: Buffer.byteLength(text, 'utf8') };
}
