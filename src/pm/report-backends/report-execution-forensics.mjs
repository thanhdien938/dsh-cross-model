/**
 * P23.1 — bounded, safe forensic evidence extraction for a non-SUCCESS
 * report-backend execution (Claude Sonnet 120s-timeout audit finding).
 *
 * Authority: reports/P23_REPORT_TIMEOUT_FORENSICS_OBSERVABILITY_20260914.md.
 *
 * The forensic audit for task-vufXVTFJcMGkMWMeoc9JB_URsfSCIGR4 found that a
 * killed Claude CLI process's `ClaudeCodeSessionError` DOES carry
 * `stdout`/`stderr`/`stdoutBytes`/`stderrBytes`/`assistantOutputPresent`
 * (claude-code-session-bridge.mjs's timeout rejection) — but
 * `claudeErrorToResult()` (cli-report-backends.mjs) discarded all of it,
 * keeping only `{ error_code }`. This module is the ONE place that turns
 * those raw, potentially-large, potentially-sensitive fields into SAFE,
 * BOUNDED forensic facts — never a report, never unlimited raw bytes in a
 * structured/DB-shaped field.
 *
 * Two distinct outputs, by design:
 *   - `compact`  — small, fixed-shape facts (byte counts, hashes, booleans,
 *     the exit code/signal) safe to embed directly in `ReportBackendResult
 *     .safe_diagnostics` and therefore in executive.log / task-diagnostic
 *     events.jsonl.
 *   - `preview`  — bounded (<= FORENSIC_PREVIEW_MAX_BYTES per stream),
 *     REDACTED head+tail text, intended ONLY for the dedicated
 *     execution-diagnostics.json artifact (execution-diagnostics-artifact
 *     .mjs) — never for the executive log, never for events.jsonl, never
 *     treated as report content.
 *
 * "Field absent from this backend's error shape" (null) is always kept
 * distinct from "field present but the captured value was empty" (0 /
 * false) — never conflated (P23.1 §3).
 */

import { createHash } from 'node:crypto';
import { sanitizeExecutionLogText } from '../../runtime/backend-execution-observer.mjs';

// P23.1 §3 — "Preferred maximum: stdout preview <= 8 KiB, stderr preview
// <= 8 KiB". Applied per-stream, after redaction, never before (redaction
// must see the whole captured string so a secret split across the
// truncation boundary is never accidentally exposed on one side only —
// mitigated by redacting first, bounding second).
export const FORENSIC_PREVIEW_MAX_BYTES = 8 * 1024;

const PREVIEW_TRUNCATION_LABEL = (totalBytes, halfBytes) =>
  `\n…[FORENSIC PREVIEW TRUNCATED — non-authoritative, ${totalBytes} bytes captured, showing first/last ~${halfBytes}B only]…\n`;

/** sha256 hex of a UTF-8 string, or null when there was nothing to hash. */
export function sha256HexOrNull(text) {
  if (typeof text !== 'string') return null;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A bounded, REDACTED head+tail preview of a raw backend text stream.
 * Reuses backend-execution-observer.mjs's `sanitizeExecutionLogText()` —
 * the SAME secret-shaped-substring redaction already applied to raw
 * process stdout/stderr elsewhere in DSH — rather than a second, competing
 * redaction pass. Returns `null` for a missing/empty string (never an
 * empty-string placeholder that could be mistaken for "0 bytes captured,
 * confirmed empty" — see `captureExecutionForensics()` for that distinct
 * fact).
 */
export function boundedRedactedPreview(text, maxBytes = FORENSIC_PREVIEW_MAX_BYTES) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const redacted = sanitizeExecutionLogText(text);
  const buf = Buffer.from(redacted, 'utf8');
  if (buf.byteLength <= maxBytes) return redacted;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  return `${head}${PREVIEW_TRUNCATION_LABEL(buf.byteLength, half)}${tail}`;
}

/**
 * Build SAFE forensic facts from a session-bridge error (e.g. a
 * `ClaudeCodeSessionError` on `CLAUDE_TIMEOUT`/`CLAUDE_EXIT_FAILED`).
 * Byte counts and hashes are always computed over the FULL captured
 * string (never the bounded preview) — a truncated preview must never
 * make the recorded byte count/hash look smaller than what was actually
 * observed (P23.1 Test G).
 *
 * Defensive by construction: every field an error object doesn't carry is
 * `null` (a backend whose bridge doesn't yet capture stdout/stderr on
 * timeout — every CLI backend except claude-code today — simply gets an
 * honestly-mostly-null result, never a fabricated value).
 *
 * @returns {{ compact: object, preview: { stdout_preview: string|null, stderr_preview: string|null } }}
 */
export function captureExecutionForensics(error) {
  const hasStdout = typeof error?.stdout === 'string';
  const hasStderr = typeof error?.stderr === 'string';
  const stdoutBytes = hasStdout
    ? Buffer.byteLength(error.stdout, 'utf8')
    : (Number.isFinite(error?.stdoutBytes) ? error.stdoutBytes : null);
  const stderrBytes = hasStderr
    ? Buffer.byteLength(error.stderr, 'utf8')
    : (Number.isFinite(error?.stderrBytes) ? error.stderrBytes : null);
  return Object.freeze({
    compact: Object.freeze({
      timeout_ms: Number.isFinite(error?.timeoutMs) ? error.timeoutMs : null,
      elapsed_ms: Number.isFinite(error?.elapsedMs) ? error.elapsedMs : null,
      // Distinct from `*_bytes === 0`: this backend/error shape simply never
      // captures the stream at all (e.g. every non-Claude CLI bridge today).
      stdout_captured: hasStdout,
      stderr_captured: hasStderr,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      stdout_sha256: hasStdout ? sha256HexOrNull(error.stdout) : null,
      stderr_sha256: hasStderr ? sha256HexOrNull(error.stderr) : null,
      assistant_output_present: typeof error?.assistantOutputPresent === 'boolean' ? error.assistantOutputPresent : null,
      exit_code: (error?.exitCode ?? error?.observedExitCode) ?? null,
      signal: (error?.signal ?? error?.observedSignal) ?? null,
      termination_requested: error?.terminationRequestedByDsh === true || error?.terminationRequested === true,
      stdout_chunk_count: Number.isInteger(error?.streamSummary?.stdout_chunk_count) ? error.streamSummary.stdout_chunk_count : null,
      stdout_total_bytes: Number.isFinite(error?.streamSummary?.stdout_total_bytes) ? error.streamSummary.stdout_total_bytes : null,
      stdout_first_event_at: error?.streamSummary?.stdout_first_event_at ?? null,
      stdout_last_event_at: error?.streamSummary?.stdout_last_event_at ?? null,
      stderr_chunk_count: Number.isInteger(error?.streamSummary?.stderr_chunk_count) ? error.streamSummary.stderr_chunk_count : null,
      stderr_total_bytes: Number.isFinite(error?.streamSummary?.stderr_total_bytes) ? error.streamSummary.stderr_total_bytes : null,
      stderr_first_event_at: error?.streamSummary?.stderr_first_event_at ?? null,
      stderr_last_event_at: error?.streamSummary?.stderr_last_event_at ?? null,
    }),
    preview: Object.freeze({
      stdout_preview: hasStdout ? boundedRedactedPreview(error.stdout) : null,
      stderr_preview: hasStderr ? boundedRedactedPreview(error.stderr) : null,
    }),
  });
}

/**
 * Remove the (potentially several-KB) `preview` sub-object from a
 * `safeDiagnostics` value before it goes into executive.log / events.jsonl
 * — those stay small and structural; only execution-diagnostics.json ever
 * carries the bounded preview text (P23.1 §3/§5: "do not dump unlimited
 * stdout/stderr into executive.log" — bounded is still not free everywhere
 * it could go).
 */
export function withoutForensicPreview(safeDiagnostics) {
  if (!safeDiagnostics || typeof safeDiagnostics !== 'object') return safeDiagnostics ?? null;
  const { preview, ...rest } = safeDiagnostics;
  return rest;
}
