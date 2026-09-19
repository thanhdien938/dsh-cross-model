/**
 * P20.2A — low-level report result envelope.
 *
 * Authority:
 *   docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §9–§11, §30
 *   docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §14
 *
 * A `ReportBackendResult` carries execution / transport facts about ONE
 * report-producing provider execution — NOT PM semantics. It never holds
 * `decision`, `verdict`, `findings`, `recommendation`, … (§30). The report
 * body itself stays opaque Markdown bytes.
 *
 * This module is pure — no filesystem, no clock, no network. `invokeReport`
 * (report-invocation.mjs) and the per-backend report transports build these.
 */

import { createHash } from 'node:crypto';
import { TERMINAL_STATE, findForbiddenSemanticKeys } from '../artifacts/artifact-schema.mjs';

export { TERMINAL_STATE };

/** Where the accepted visible text came from — provenance only. */
export const VISIBLE_OUTPUT_SOURCE = Object.freeze({
  API_CHAT_CONTENT: 'API_CHAT_CONTENT',
  CLI_ASSISTANT_TEXT: 'CLI_ASSISTANT_TEXT',
  DIRECT_WRITE_FILE: 'DIRECT_WRITE_FILE',
  FAKE: 'FAKE',
});
const VISIBLE_SOURCE_VALUES = new Set(Object.values(VISIBLE_OUTPUT_SOURCE));
const TERMINAL_VALUES = new Set(Object.values(TERMINAL_STATE));

export class ReportResultError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ReportResultError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Map an OpenAI-style chat-completion `finish_reason` to a terminal state.
 * A truncation/length finish is NOT a complete report success (§9.2).
 * Unknown / absent ⇒ UNKNOWN_OUTCOME (never optimistically SUCCESS).
 */
export function mapChatCompletionFinishReason(finishReason) {
  switch (finishReason) {
    case 'stop':
    case 'end_turn':
    case 'complete':
      return TERMINAL_STATE.SUCCESS;
    case 'length':
    case 'max_tokens':
    case 'model_length':
      return TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE;
    case 'content_filter':
      return TERMINAL_STATE.PROVIDER_ERROR;
    case 'tool_calls':
    case 'function_call':
      return TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE;
    case null:
    case undefined:
      return TERMINAL_STATE.UNKNOWN_OUTCOME;
    default:
      return TERMINAL_STATE.UNKNOWN_OUTCOME;
  }
}

/**
 * @param {object} input
 * @param {string} input.backend    product family (e.g. "api", "claude-code")
 * @param {string} input.profileId
 * @param {string} [input.model]
 * @param {string} input.executionId
 * @param {string} input.terminalState  one of TERMINAL_STATE
 * @param {string|null} [input.providerFinishReason]
 * @param {number|null} [input.processExitCode]
 * @param {boolean} [input.timedOut]
 * @param {boolean} [input.cancelled]
 * @param {number|null} [input.durationMs]
 * @param {string|null} [input.acceptedVisibleText]  the EXACT accepted visible
 *        final content — no trim/normalize/parse (§10). null for a pure
 *        direct-write ack.
 * @param {string|null} [input.visibleOutputSource]  one of VISIBLE_OUTPUT_SOURCE
 * @param {object|null} [input.directWriteAck]  { assignedReportRelpath, ackText }
 * @param {object|null} [input.usage]  safe token usage if already available
 * @param {object|null} [input.safeDiagnostics]  already-sanitized facts only
 */
export function buildReportBackendResult(input) {
  const {
    backend, profileId, model = null, executionId, terminalState,
    providerFinishReason = null, processExitCode = null,
    timedOut = false, cancelled = false, durationMs = null,
    acceptedVisibleText = null, visibleOutputSource = null,
    directWriteAck = null, usage = null, safeDiagnostics = null,
    // P20.5 §7/§22/§24 — a SEPARATE typed machine-control channel a
    // Debate-typed-control-capable backend may surface FROM THE SAME
    // execution. NEVER derived from `accepted_visible_text`. A backend that
    // does not support it leaves this null.
    debateTypedControl = null,
  } = input ?? {};

  const hasText = typeof acceptedVisibleText === 'string';
  // P20.2R R3: keep the generic envelope internally self-consistent — a
  // TIMEOUT/CANCELLED terminal state implies the matching flag. This is not
  // provider-specific semantics; it just prevents a caller passing a
  // contradictory envelope into future sealing code. `validateReportBackendResult`
  // still rejects a hand-mutated contradiction.
  const timedOutFlag = Boolean(timedOut) || terminalState === TERMINAL_STATE.TIMEOUT;
  const cancelledFlag = Boolean(cancelled) || terminalState === TERMINAL_STATE.CANCELLED;
  const result = {
    schema_version: 1,
    kind: 'ReportBackendResult',
    backend,
    profile_id: profileId,
    model,
    execution_id: executionId,
    terminal_state: terminalState,
    provider_finish_reason: providerFinishReason,
    process_exit_code: processExitCode,
    timed_out: timedOutFlag,
    cancelled: cancelledFlag,
    duration_ms: durationMs,
    accepted_visible_text: hasText ? acceptedVisibleText : null,
    accepted_visible_bytes: hasText ? Buffer.byteLength(acceptedVisibleText, 'utf8') : null,
    visible_output_source: visibleOutputSource,
    direct_write_ack: directWriteAck,
    usage,
    safe_diagnostics: safeDiagnostics,
    debate_typed_control: typeof debateTypedControl === 'boolean'
      ? Object.freeze({ continue_debate: debateTypedControl })
      : null,
  };
  return Object.freeze(result);
}

export function validateReportBackendResult(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return { ok: false, errors: ['ReportBackendResult must be an object'] };

  // P20.2R R3: this is a VERSIONED P20 transport envelope.
  if (obj.schema_version !== 1) errors.push('schema_version: must be 1');
  if (obj.kind !== 'ReportBackendResult') errors.push('kind: must be "ReportBackendResult"');
  if (typeof obj.backend !== 'string' || !obj.backend) errors.push('backend: required non-empty string');
  if (typeof obj.profile_id !== 'string' || !obj.profile_id) errors.push('profile_id: required non-empty string');
  if (typeof obj.execution_id !== 'string' || !obj.execution_id) errors.push('execution_id: required non-empty string');
  if (!TERMINAL_VALUES.has(obj.terminal_state)) errors.push(`terminal_state: one of ${[...TERMINAL_VALUES].join(', ')}`);

  const hasText = typeof obj.accepted_visible_text === 'string';
  if (obj.accepted_visible_text !== null && !hasText) errors.push('accepted_visible_text: string or null');
  if (hasText) {
    if (obj.accepted_visible_bytes !== Buffer.byteLength(obj.accepted_visible_text, 'utf8')) {
      errors.push('accepted_visible_bytes: must equal the UTF-8 byte length of accepted_visible_text');
    }
    // R3: text present ⇒ a valid provenance source is required.
    if (!VISIBLE_SOURCE_VALUES.has(obj.visible_output_source)) {
      errors.push(`visible_output_source: required (one of ${[...VISIBLE_SOURCE_VALUES].join(', ')}) when accepted_visible_text is a string`);
    }
  } else {
    // R3: no text ⇒ byte count must also be null (never a dangling number).
    if (obj.accepted_visible_bytes !== null && obj.accepted_visible_bytes !== undefined) {
      errors.push('accepted_visible_bytes: must be null when accepted_visible_text is null');
    }
    if (obj.visible_output_source !== null && obj.visible_output_source !== undefined && !VISIBLE_SOURCE_VALUES.has(obj.visible_output_source)) {
      errors.push(`visible_output_source: one of ${[...VISIBLE_SOURCE_VALUES].join(', ')} or null`);
    }
  }

  // R3: terminal_state must be self-consistent with the timed_out / cancelled
  // flags. (Non-success states MAY still carry forensic visible text — that
  // is allowed, never rejected here.)
  if (obj.timed_out !== true && obj.timed_out !== false) errors.push('timed_out: must be a boolean');
  if (obj.cancelled !== true && obj.cancelled !== false) errors.push('cancelled: must be a boolean');
  if (obj.terminal_state === TERMINAL_STATE.TIMEOUT && obj.timed_out !== true) errors.push('timed_out: must be true when terminal_state is TIMEOUT');
  if (obj.terminal_state === TERMINAL_STATE.CANCELLED && obj.cancelled !== true) errors.push('cancelled: must be true when terminal_state is CANCELLED');
  if (obj.terminal_state === TERMINAL_STATE.SUCCESS && obj.timed_out === true) errors.push('terminal_state SUCCESS is contradictory with timed_out=true');
  if (obj.terminal_state === TERMINAL_STATE.SUCCESS && obj.cancelled === true) errors.push('terminal_state SUCCESS is contradictory with cancelled=true');

  // P20.5 — the optional typed-control channel, when present, must be EXACTLY
  // `{ continue_debate: boolean }` (a machine fact — never report semantics).
  if (obj.debate_typed_control !== null && obj.debate_typed_control !== undefined) {
    const tc = obj.debate_typed_control;
    if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) {
      errors.push('debate_typed_control: must be an object or null');
    } else {
      const keys = Object.keys(tc);
      if (keys.length !== 1 || keys[0] !== 'continue_debate') errors.push('debate_typed_control: only a `continue_debate` key is permitted');
      if (typeof tc.continue_debate !== 'boolean') errors.push('debate_typed_control.continue_debate must be a boolean');
    }
  }

  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * Terminal-truth gate (§9.1, exit gate #4). A report attempt is
 * delivery-eligible ONLY on a truthful SUCCESS. "Some text exists" or "a
 * file exists" never implies success. Returns `{ eligible, reason, code }`.
 */
export function reportDeliveryEligible(result) {
  if (result === null || typeof result !== 'object') {
    return { eligible: false, reason: 'result is not an object', code: 'REPORT_RESULT_INVALID' };
  }
  if (result.terminal_state === TERMINAL_STATE.SUCCESS && !result.timed_out && !result.cancelled) {
    return { eligible: true, reason: null, code: null };
  }
  const map = {
    [TERMINAL_STATE.TIMEOUT]: 'REPORT_EXECUTION_TIMEOUT',
    [TERMINAL_STATE.CANCELLED]: 'REPORT_EXECUTION_CANCELLED',
    [TERMINAL_STATE.PROVIDER_ERROR]: 'REPORT_PROVIDER_ERROR',
    [TERMINAL_STATE.PROCESS_ERROR]: 'REPORT_PROCESS_ERROR',
    [TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE]: 'REPORT_TRUNCATED_OR_INCOMPLETE',
    [TERMINAL_STATE.UNKNOWN_OUTCOME]: 'REPORT_UNKNOWN_OUTCOME',
    [TERMINAL_STATE.SUCCESS]: 'REPORT_SUCCESS_BUT_TIMED_OUT_OR_CANCELLED',
  };
  return {
    eligible: false,
    reason: `terminal_state=${result.terminal_state} timed_out=${result.timed_out} cancelled=${result.cancelled} is not a truthful report success`,
    code: map[result.terminal_state] ?? 'REPORT_NOT_DELIVERABLE',
  };
}

/** sha256 hex of a UTF-8 string (delivery observation only, not authority). */
export function sha256HexUtf8(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
