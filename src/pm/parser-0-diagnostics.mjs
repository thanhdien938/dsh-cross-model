// PARSER-0 — truthful layered diagnostics (OBSERVABILITY ONLY).
//
// Scope contract (approved four-connector output-matrix analysis,
// docs/audit/DSH_FOUR_CONNECTOR_OUTPUT_MATRIX_ANALYSIS_20260908.md):
// this module NEVER changes what DSH accepts or rejects, never changes
// provider execution, retry, timeout, prompt, schema or selection behavior,
// and never invokes a provider. It is a small, bounded, content-free,
// JSON-serializable fact set attached BESIDE the existing public error
// codes (which remain byte-for-byte stable) so that:
//   - a provider/transport/terminal failure with no assistant output is
//     represented as parser_attempted=false / parser_state=NOT_ATTEMPTED
//     (never as a model-JSON parse failure);
//   - JSON decoding (L5) stays distinguishable from PM contract validation
//     (L6) and step-specific semantic/evidence validation (L7);
//   - the approved corpus denominators (154/136/18/136/114/22/18) remain
//     deterministically recomputable from per-attempt facts alone.
//
// Security posture: fixed enums, booleans, counts and byte lengths only.
// Never raw assistant output, never hidden reasoning, never credentials,
// headers, full provider payloads or environment data. Facts a connector
// does not expose stay `null` — never inferred.

export const PARSER_0_DIAGNOSTIC_VERSION = 1;

// Target layer model — never collapsed into one generic "parse failed" state.
export const PARSER_0_LAYERS = Object.freeze({
  INVOCATION: 'L0_INVOCATION',
  EXECUTION: 'L1_EXECUTION',
  ENVELOPE: 'L2_ENVELOPE',
  EXTRACTION: 'L3_EXTRACTION',
  FORMAT: 'L4_FORMAT',
  PARSER: 'L5_PARSER',
  PM_CONTRACT: 'L6_PM_CONTRACT',
  STEP_VALIDATION: 'L7_STEP_VALIDATION',
});

// Bounded enum vocabularies. Unknown/unevaluated facts are `null`, never guessed.
export const PARSER_0_EXECUTION_STATES = Object.freeze(['SUCCESS', 'ERROR', 'UNKNOWN']);
export const PARSER_0_TERMINAL_STATES = Object.freeze(['SUCCESS', 'ERROR', 'UNKNOWN']);
export const PARSER_0_EXTRACTION_STATES = Object.freeze(['NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED', 'UNAVAILABLE', 'UNKNOWN']);
export const PARSER_0_PARSER_STATES = Object.freeze(['PASS', 'FAIL', 'NOT_ATTEMPTED']);
export const PARSER_0_CONTRACT_STATES = Object.freeze(['PASS', 'FAIL', 'NOT_ATTEMPTED', 'NOT_EVALUATED']);
// Goal F: safe phase facts for the API request/response pipeline. A body-read
// abort is therefore never indistinguishable from a connect/fetch failure.
export const PARSER_0_REQUEST_PHASES = Object.freeze(['FETCH', 'RESPONSE_BODY_READ', 'HTTP_STATUS', 'RESPONSE_JSON_DECODE', 'ASSISTANT_EXTRACTION']);

const LAYER_VALUES = Object.freeze(Object.values(PARSER_0_LAYERS));

function pick(value, allowed) { return typeof value === 'string' && allowed.includes(value) ? value : null; }
function boolOrNull(value) { return typeof value === 'boolean' ? value : null; }
function intOrNull(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function boundedCode(value) { return typeof value === 'string' && value ? value.slice(0, 120) : null; }

// The one builder. Every field is always present (null when genuinely
// unavailable) so the shape is stable for consumers; the object is frozen,
// fixed-size, content-free and JSON-serializable.
export function buildLayeredDiagnostic({
  executionState, terminalState, terminalStatus,
  terminalResponsePresent, terminalResponseBytes,
  extractionState, assistantOutputPresent, assistantOutputBytes,
  parserAttempted, parserState, parseErrorCode, parseSubreason,
  pmContractState, stepValidationState,
  providerHttpStatus, finishReason,
  structuredOutputRequested, structuredOutputPresent,
  attemptOrdinal, requestPhase, executionErrorCode,
} = {}) {
  const diagnostic = {
    diagnostic_version: PARSER_0_DIAGNOSTIC_VERSION,
    execution_state: pick(executionState, PARSER_0_EXECUTION_STATES),
    terminal_state: pick(terminalState, PARSER_0_TERMINAL_STATES),
    terminal_status: boundedCode(terminalStatus),
    terminal_response_present: boolOrNull(terminalResponsePresent),
    terminal_response_bytes: intOrNull(terminalResponseBytes),
    extraction_state: pick(extractionState, PARSER_0_EXTRACTION_STATES),
    assistant_output_present: boolOrNull(assistantOutputPresent),
    assistant_output_bytes: intOrNull(assistantOutputBytes),
    parser_attempted: boolOrNull(parserAttempted),
    parser_state: pick(parserState, PARSER_0_PARSER_STATES),
    parse_error_code: boundedCode(parseErrorCode),
    parse_subreason: boundedCode(parseSubreason),
    pm_contract_state: pick(pmContractState, PARSER_0_CONTRACT_STATES),
    step_validation_state: pick(stepValidationState, PARSER_0_CONTRACT_STATES),
    provider_http_status: intOrNull(providerHttpStatus),
    finish_reason: boundedCode(finishReason),
    structured_output_requested: boolOrNull(structuredOutputRequested),
    structured_output_present: boolOrNull(structuredOutputPresent),
    attempt_ordinal: intOrNull(attemptOrdinal),
    request_phase: pick(requestPhase, PARSER_0_REQUEST_PHASES),
    execution_error_code: boundedCode(executionErrorCode),
  };
  diagnostic.primary_layer = primaryLayer(diagnostic);
  return Object.freeze(diagnostic);
}

// One deterministic layer attribution per diagnostic — never a generic
// "parse failed". Execution/terminal failures own the row even when a
// downstream layer would also have failed.
export function primaryLayer(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  if (diagnostic.execution_state === 'ERROR' || diagnostic.terminal_state === 'ERROR') return PARSER_0_LAYERS.EXECUTION;
  if (diagnostic.extraction_state === 'UNAVAILABLE' || diagnostic.extraction_state === 'FAILED') return PARSER_0_LAYERS.EXTRACTION;
  if (diagnostic.parser_state === 'FAIL') return PARSER_0_LAYERS.PARSER;
  if (diagnostic.pm_contract_state === 'FAIL') return PARSER_0_LAYERS.PM_CONTRACT;
  if (diagnostic.step_validation_state === 'FAIL') return PARSER_0_LAYERS.STEP_VALIDATION;
  if (diagnostic.parser_state === 'PASS') return PARSER_0_LAYERS.PARSER;
  return null;
}

// Goal C: the provider-failure shape. parser_attempted is false because the
// real execution path never reached parseDecision — never derived from an
// error code after the fact. HTTP 402/403, timeouts, body aborts,
// Antigravity terminal ERROR and content_filter-with-empty-content all land
// here: execution/availability failures, not model JSON parse failures.
export function executionFailureDiagnosticFromError(error, {
  structuredOutputRequested = null, attemptOrdinal = null, terminalStatus = 'FAILED',
} = {}) {
  const outputPresent = error?.assistantOutputPresent === true;
  return buildLayeredDiagnostic({
    executionState: 'ERROR',
    terminalState: 'ERROR',
    terminalStatus,
    terminalResponsePresent: error?.terminalResponsePresent ?? null,
    terminalResponseBytes: error?.terminalResponseBytes ?? null,
    extractionState: 'NOT_ATTEMPTED',
    assistantOutputPresent: outputPresent,
    assistantOutputBytes: outputPresent ? null : 0,
    parserAttempted: false,
    parserState: 'NOT_ATTEMPTED',
    pmContractState: 'NOT_EVALUATED',
    stepValidationState: 'NOT_EVALUATED',
    providerHttpStatus: intOrNull(error?.httpStatus),
    finishReason: boundedCode(error?.finishReason),
    structuredOutputRequested,
    structuredOutputPresent: null,
    attemptOrdinal,
    requestPhase: pick(error?.requestPhase, PARSER_0_REQUEST_PHASES),
    executionErrorCode: boundedCode(error?.code),
  });
}

// The parser-attempt shape. `state` is PASS or FAIL for the REAL
// parseDecision boundary only; pmContractState stays NOT_EVALUATED here
// because parseDecision is NOT the full PM contract validator (the runtime
// normalizer and council validators run downstream).
export function parserOutcomeDiagnostic({
  state, bytes, errorCode = null, parseSubreason = null,
  structuredOutputRequested = null, structuredOutputPresent = null, attemptOrdinal = null,
} = {}) {
  const parserState = pick(state, ['PASS', 'FAIL']);
  if (!parserState) throw new TypeError('PARSER-0 parser outcome requires PASS or FAIL');
  return buildLayeredDiagnostic({
    executionState: 'SUCCESS',
    terminalState: 'SUCCESS',
    extractionState: 'SUCCEEDED',
    assistantOutputPresent: true,
    assistantOutputBytes: intOrNull(bytes),
    parserAttempted: true,
    parserState,
    parseErrorCode: parserState === 'FAIL' ? boundedCode(errorCode) : null,
    parseSubreason: parserState === 'FAIL' ? boundedCode(parseSubreason) : null,
    pmContractState: 'NOT_EVALUATED',
    stepValidationState: 'NOT_EVALUATED',
    structuredOutputRequested,
    structuredOutputPresent,
    attemptOrdinal,
  });
}

// Goal H: the explicit denominator populations, computed deterministically
// from per-attempt facts alone — no guesswork, no second analytics subsystem.
export function computeDenominatorCounters(diagnostics) {
  const rows = Array.isArray(diagnostics) ? diagnostics : [];
  const count = (fn) => rows.reduce((total, row) => total + (fn(row) === true ? 1 : 0), 0);
  return Object.freeze({
    ALL_CAPTURED: rows.length,
    PROVIDER_TERMINAL_SUCCESS: count((r) => r?.terminal_state === 'SUCCESS'),
    PROVIDER_TERMINAL_ERROR: count((r) => r?.terminal_state === 'ERROR'),
    ASSISTANT_OUTPUT_PRESENT: count((r) => r?.assistant_output_present === true),
    ASSISTANT_OUTPUT_ABSENT: count((r) => r?.assistant_output_present === false),
    PARSER_ATTEMPTED: count((r) => r?.parser_attempted === true),
    PARSER_PASS: count((r) => r?.parser_state === 'PASS'),
    PARSER_FAIL: count((r) => r?.parser_state === 'FAIL'),
    PARSER_NOT_ATTEMPTED: count((r) => r?.parser_state === 'NOT_ATTEMPTED'),
    PM_CONTRACT_PASS: count((r) => r?.pm_contract_state === 'PASS'),
    PM_CONTRACT_FAIL: count((r) => r?.pm_contract_state === 'FAIL'),
    STEP_VALIDATION_PASS: count((r) => r?.step_validation_state === 'PASS'),
    STEP_VALIDATION_FAIL: count((r) => r?.step_validation_state === 'FAIL'),
  });
}
