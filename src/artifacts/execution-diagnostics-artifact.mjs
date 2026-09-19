/**
 * P23.1 — dedicated forensic-diagnostics artifact for a non-SUCCESS report
 * backend execution (Claude Sonnet 120s-timeout audit finding).
 *
 * Authority: reports/P23_REPORT_TIMEOUT_FORENSICS_OBSERVABILITY_20260914.md.
 *
 * Written ONLY for a TIMEOUT/FAILED/etc. attempt, alongside (never instead
 * of) the existing executive.log delivery-evidence file
 * (report-executive-log.mjs). This file is diagnostic-only:
 *   - it is NEVER `report.md` and never satisfies `reportDeliveryEligible()`;
 *   - it is NEVER read by any delivery/seal/barrier code path;
 *   - it stays inside the existing runtime-local artifact-store tree
 *     (`.runtime/<env>/dsh-artifacts/...`), already outside Git (P20's own
 *     storage convention) — never committed, never uploaded automatically.
 *
 * Bounded by construction: the caller is expected to have already reduced
 * any raw provider text to `report-execution-forensics.mjs`'s `compact`/
 * `preview` shapes before calling this — this module does not itself read
 * unbounded provider output.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep, join } from 'node:path';
import { sanitizeAuditData } from '../orchestration/audit-sanitize.mjs';

export const EXECUTION_DIAGNOSTICS_FILENAME = 'execution-diagnostics.json';

export class ExecutionDiagnosticsArtifactError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ExecutionDiagnosticsArtifactError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const SAFE_FIELDS = [
  'task_id', 'invocation_id', 'execution_id', 'attempt_ordinal',
  'store_id', 'project_id', 'role', 'stage', 'round',
  'profile_id', 'backend', 'model', 'actor_alias',
  'started_at', 'finished_at', 'duration_ms',
  'terminal_state', 'error_code',
  'timeout_ms', 'exit_code', 'signal',
  'stdout_bytes', 'stderr_bytes', 'stdout_captured', 'stderr_captured',
  'stdout_sha256', 'stderr_sha256', 'assistant_output_present',
  'stdout_chunk_count', 'stdout_total_bytes', 'stdout_first_event_at', 'stdout_last_event_at',
  'stderr_chunk_count', 'stderr_total_bytes', 'stderr_first_event_at', 'stderr_last_event_at',
];

/** Absolute path this attempt's diagnostics artifact would live at. */
export function executionDiagnosticsPath(attempt) {
  return join(attempt.path, EXECUTION_DIAGNOSTICS_FILENAME);
}

/**
 * Relative-to-store path, derived from the ALREADY-assigned report relpath
 * (same directory, sibling filename) so callers never need a second
 * relpath-computation convention. `null` in, `null` out.
 */
export function executionDiagnosticsRelpath(reportRelpath) {
  if (typeof reportRelpath !== 'string' || !reportRelpath) return null;
  return reportRelpath.replace(/[^/\\]+$/, EXECUTION_DIAGNOSTICS_FILENAME);
}

/**
 * @param {object} input
 * @param {object} input.attempt   P20.1 AttemptWorkspace (needs .path)
 * @param {object} input.facts     flat object of the SAFE_FIELDS above
 * @param {string|null} [input.boundedStdoutPreview]  already bounded+redacted (report-execution-forensics.mjs)
 * @param {string|null} [input.boundedStderrPreview]  already bounded+redacted
 * @returns {{ path: string, bytes: number }}
 */
export function writeExecutionDiagnosticsArtifact({ attempt, facts, boundedStdoutPreview = null, boundedStderrPreview = null }) {
  if (!attempt || typeof attempt.path !== 'string') {
    throw new ExecutionDiagnosticsArtifactError('a P20.1 AttemptWorkspace is required', 'EXECUTION_DIAGNOSTICS_BAD_ATTEMPT');
  }
  const artifactPath = resolve(executionDiagnosticsPath(attempt));
  const attemptDir = resolve(attempt.path);
  if (!(artifactPath.startsWith(attemptDir + sep) && !artifactPath.slice(attemptDir.length).split(sep).includes('..'))) {
    throw new ExecutionDiagnosticsArtifactError(`execution-diagnostics.json path escapes the attempt directory: ${artifactPath}`, 'EXECUTION_DIAGNOSTICS_PATH_OUTSIDE_ATTEMPT', { artifactPath });
  }
  if (existsSync(artifactPath)) {
    throw new ExecutionDiagnosticsArtifactError(`execution-diagnostics.json already exists at the assigned path; refusing to overwrite: ${artifactPath}`, 'EXECUTION_DIAGNOSTICS_EXISTS', { artifactPath });
  }

  const clean = {};
  for (const key of SAFE_FIELDS) {
    if (facts != null && facts[key] !== undefined) clean[key] = sanitizeAuditData(facts[key]);
  }
  const body = {
    kind: 'P23ExecutionDiagnosticsArtifact',
    schema_version: 1,
    note: 'FORENSIC / NON-AUTHORITATIVE — diagnostic evidence only. This is never report.md, never delivery-eligible, and never consulted by any delivery/seal/barrier decision.',
    ...clean,
    // Previews are inserted AFTER the generic sanitize pass above (never
    // reprocessed by it): report-execution-forensics.mjs already redacted
    // and bounded them to <= 8 KiB per stream; audit-sanitize's own
    // 500-char generic string cap would otherwise silently discard most of
    // an intentionally larger, already-safe forensic preview.
    bounded_stdout_preview: typeof boundedStdoutPreview === 'string' ? boundedStdoutPreview : null,
    bounded_stderr_preview: typeof boundedStderrPreview === 'string' ? boundedStderrPreview : null,
    written_at: new Date().toISOString(),
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  try {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new ExecutionDiagnosticsArtifactError(`execution-diagnostics.json write failed: ${error.message}`, 'EXECUTION_DIAGNOSTICS_IO_FAILED', { artifactPath, cause: error.code ?? null });
  }
  return { path: artifactPath, bytes: Buffer.byteLength(text, 'utf8') };
}
