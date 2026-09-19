/**
 * P20.5 §22/§23/§24 — Debate typed-control backend capability.
 *
 * `DEBATE_TYPED_CONTROL` is an EXPLICIT capability axis, SEPARATE from report
 * delivery / artifact input / source-workspace capability. It is NEVER inferred
 * from a backend or model name, and NEVER from generic structured-output /
 * `tool_calls` support (§22/§24). A backend may be fully report-capable yet
 * Debate-typed-control UNSUPPORTED.
 *
 * A backend is `PROVEN` for artifact Debate ONLY when a deterministic offline
 * proof exists that it can surface, from the SAME report execution, a typed
 * `continue_debate` boolean on a channel that is NOT a reinterpretation of the
 * visible report bytes, AND whose identity can be bound to that execution.
 * No live model/API call may be used to prove this phase (§23).
 *
 * Pure: no filesystem, no clock, no network.
 */

export const DEBATE_TYPED_CONTROL_STATUS = Object.freeze({
  PROVEN: 'PROVEN',
  UNPROVEN: 'UNPROVEN',
  UNSUPPORTED: 'UNSUPPORTED',
});
const STATUS_VALUES = new Set(Object.values(DEBATE_TYPED_CONTROL_STATUS));

export class DebateBackendCapabilityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'DebateBackendCapabilityError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * §23 — the offline-honest production backend Debate-readiness matrix. Every
 * production family: report-delivery + artifact-input were proven in
 * P20.2/P20.4; the SAME-EXECUTION typed control channel is UNPROVEN because it
 * cannot be established without a live call. Therefore ARTIFACT_DEBATE_READY is
 * false for every real family and real owner-facing artifact Debate stays
 * disabled / fail-closed (§23/§25/§57).
 */
// P22.4 §I: this table remains DOCUMENTATION ONLY (debateBackendReadinessReport()
// below) — real admission never reads it. `resolveDebateTypedControlStatus()`
// reads the ACTUAL instantiated report-backend object's own
// `supportsDebateTypedControl`/`debateTypedControlStatus` flag, which is now
// `true` for claude-code/opencode/antigravity/codex/grok whenever that
// backend was constructed with `deliveryMechanism: 'DIRECT_WRITE'` (the
// production route for all five — see production-backend-capabilities.mjs
// and cli-report-backends.mjs). This table is kept in sync for humans, not
// for correctness.
export const PRODUCTION_DEBATE_BACKEND_MATRIX = Object.freeze({
  'claude-code': mkRow({ same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.PROVEN, artifact_debate_ready: true, note: 'DIRECT_WRITE strict envelope, admitted per-instance (see cli-report-backends.mjs)' }),
  codex: mkRow({ same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.PROVEN, artifact_debate_ready: true, note: 'DIRECT_WRITE strict envelope, admitted per-instance (P22.4)' }),
  opencode: mkRow({ same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.PROVEN, artifact_debate_ready: true, note: 'DIRECT_WRITE strict envelope, admitted per-instance (P22.4)' }),
  grok: mkRow({ same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.PROVEN, artifact_debate_ready: true, note: 'DIRECT_WRITE strict envelope, admitted per-instance (P22.4)' }),
  antigravity: mkRow({ same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.PROVEN, artifact_debate_ready: true, note: 'DIRECT_WRITE strict envelope, admitted per-instance (P22.4)' }),
  // P22.5 — `api` Debate non-admission is now PERMANENT PRODUCT POLICY, not
  // an unproven/incomplete migration state: DSH deliberately does not build
  // a second multi-agent control protocol for a text-completion-only
  // backend. An API-hosted model that needs Council/Debate is used through
  // an OpenCode PM profile instead — see
  // production-backend-capabilities.mjs's API_MULTI_AGENT_POLICY_GUIDANCE,
  // and `assertBackendTaskModeSupported('api', TASK_MODE.DEBATE_CHAIR)`,
  // which now rejects api at Council/Debate admission BEFORE this same-
  // execution typed-control check is ever reached. The typed-control
  // primitive itself stays honestly UNPROVEN (no channel exists), which is
  // simply true, not a gap awaiting a future adapter.
  api: mkRow({
    note: 'SUPPORTED_SINGLE_ONLY by product policy — visible content only, no separate typed-control channel, and none is planned; use an OpenCode PM profile for Council/Debate instead',
  }),
});

function mkRow(over = {}) {
  return Object.freeze({
    report_delivery_status: 'PROVEN',
    artifact_input_status: 'PROVEN',
    same_execution_typed_control_status: DEBATE_TYPED_CONTROL_STATUS.UNPROVEN,
    artifact_debate_ready: false,
    note: over.note ?? null,
  });
}

/**
 * The overall real-backend verdict for the P20.5 final response
 * (`REAL_DEBATE_TYPED_CONTROL_ROUTE`). `DEFERRED` when no production family is
 * PROVEN offline.
 */
export function debateBackendReadinessReport() {
  const anyReady = Object.values(PRODUCTION_DEBATE_BACKEND_MATRIX).some((r) => r.artifact_debate_ready === true);
  return Object.freeze({
    matrix: PRODUCTION_DEBATE_BACKEND_MATRIX,
    real_debate_typed_control_route: anyReady ? 'PROVEN' : 'DEFERRED',
  });
}

/**
 * Resolve a report backend's Debate typed-control status. Reads ONLY an
 * EXPLICIT app-owned flag on the backend object — never a name/model heuristic.
 *
 *   backend.debateTypedControlStatus === 'PROVEN'      -> PROVEN
 *   backend.supportsDebateTypedControl === true        -> PROVEN (test/admitted)
 *   backend.debateTypedControlStatus === 'UNSUPPORTED' -> UNSUPPORTED
 *   otherwise                                          -> UNPROVEN
 */
export function resolveDebateTypedControlStatus(reportBackend) {
  if (!reportBackend || typeof reportBackend !== 'object') return DEBATE_TYPED_CONTROL_STATUS.UNPROVEN;
  const explicit = reportBackend.debateTypedControlStatus;
  if (STATUS_VALUES.has(explicit)) return explicit;
  if (reportBackend.supportsDebateTypedControl === true) return DEBATE_TYPED_CONTROL_STATUS.PROVEN;
  return DEBATE_TYPED_CONTROL_STATUS.UNPROVEN;
}

/**
 * §25 — capability-only preflight. Fail closed BEFORE any Debate provider call
 * unless the resolved Debate Chair synthesis route is PROVEN for typed control.
 *
 * @param {object} reportBackend
 * @param {object} [ctx] { profileId, role }
 * @throws {DebateBackendCapabilityError} code `DEBATE_TYPED_CONTROL_UNSUPPORTED`
 */
export function assertDebateTypedControlAdmitted(reportBackend, ctx = {}) {
  const status = resolveDebateTypedControlStatus(reportBackend);
  if (status !== DEBATE_TYPED_CONTROL_STATUS.PROVEN) {
    throw new DebateBackendCapabilityError(
      `artifact Debate requires a PROVEN same-execution typed-control route for the Debate Chair synthesis${ctx.profileId ? ` (profile ${ctx.profileId})` : ''}; resolved status = ${status}`,
      'DEBATE_TYPED_CONTROL_UNSUPPORTED',
      { status, profileId: ctx.profileId ?? null },
    );
  }
  return status;
}
