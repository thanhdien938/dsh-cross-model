/**
 * P20.2E — application-owned backend report capability records + routing.
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §20–§23,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §9–§11.
 *
 * Capabilities are EXPLICIT application facts. They are never inferred from a
 * model name, a profile name, a generic `executionCapable`, or provider
 * marketing. A route that is UNSUPPORTED or UNPROVEN-where-proof-is-required
 * fails closed (§31 — never a silent fallback to the legacy PM parser).
 *
 * Pure: no filesystem, no network.
 */

import { DELIVERY_MECHANISM, INPUT_TRANSPORT } from './artifact-schema.mjs';

export { DELIVERY_MECHANISM, INPUT_TRANSPORT };

export const CAPABILITY_STATE = Object.freeze({
  PROVEN: 'PROVEN',
  UNPROVEN: 'UNPROVEN',
  UNSUPPORTED: 'UNSUPPORTED',
});

export class BackendReportCapabilityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'BackendReportCapabilityError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * P20.2 entry posture — the PM-freeze conservative default (§21).
 *
 *  - No CLI backend has a PROVEN direct-write route (needs a sandbox proof
 *    that P20.2 does not perform — REAL_BACKEND_DIRECT_WRITE_PROOF: DEFERRED).
 *  - CLI materialization is UNPROVEN because every current CLI visible-output
 *    extractor trims / strips zero-width / joins / drops earlier messages
 *    (see the P20.2 report §8), so exact accepted bytes cannot yet be
 *    captured truthfully from those paths.
 *  - `api` materialization is PROVEN offline: `normalizeChatCompletionResponse`
 *    returns the raw `choice.message.content` verbatim plus `finish_reason`,
 *    and `api-report-transport.mjs` maps it into a ReportBackendResult with
 *    a truthful terminal state, all exercised by an HTTP fixture.
 *  - `api` has NO local filesystem ⇒ direct write UNSUPPORTED.
 *
 * `report_delivery` / `artifact_input` list the mechanisms and the state of
 * each. `enforcement_version` is an explicit version string.
 */
export const DEFAULT_BACKEND_REPORT_POLICY = Object.freeze({
  enforcement_version: 'p20.2-entry-1',
  backends: Object.freeze({
    'claude-code': Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNPROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNPROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNPROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.UNPROVEN }),
    }),
    codex: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNPROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNPROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNPROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.UNPROVEN }),
    }),
    opencode: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNPROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNPROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNPROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.UNPROVEN }),
    }),
    grok: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNPROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNPROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNPROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.UNPROVEN }),
    }),
    antigravity: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNPROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.UNPROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNSUPPORTED, VERBATIM_CONTENT: CAPABILITY_STATE.UNPROVEN }),
    }),
    api: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.UNSUPPORTED, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.PROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.UNSUPPORTED, VERBATIM_CONTENT: CAPABILITY_STATE.PROVEN }),
    }),
    // Offline test seam only: a deterministic in-process fake backend whose
    // exact bytes are app-controlled. Never a real provider.
    fake: Object.freeze({
      report_delivery: Object.freeze({ DIRECT_WRITE: CAPABILITY_STATE.PROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.PROVEN }),
      artifact_input: Object.freeze({ NATIVE_ASSIGNED_READ: CAPABILITY_STATE.PROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.PROVEN }),
    }),
  }),
});

/**
 * Resolve a report route, fail closed.
 *
 * @param {object} input
 * @param {object} [input.policy]  defaults to DEFAULT_BACKEND_REPORT_POLICY
 * @param {string} input.product   backend family key
 * @param {string} input.requestedDelivery   one of DELIVERY_MECHANISM
 * @param {string} [input.requestedInputTransport]  one of INPUT_TRANSPORT
 * @returns {{ ok: boolean, delivery: string|null, input: string|null, reason: string|null, code: string|null, deliveryState: string|null }}
 */
export function resolveReportRoute({ policy = DEFAULT_BACKEND_REPORT_POLICY, product, requestedDelivery, requestedInputTransport = null } = {}) {
  const backend = policy?.backends?.[product];
  if (!backend) {
    return { ok: false, delivery: null, input: null, reason: `no report capability record for backend ${JSON.stringify(product)}`, code: 'ARTIFACT_REPORT_BACKEND_UNKNOWN', deliveryState: null };
  }
  if (!Object.values(DELIVERY_MECHANISM).includes(requestedDelivery)) {
    return { ok: false, delivery: null, input: null, reason: `requestedDelivery must be one of ${Object.values(DELIVERY_MECHANISM).join(', ')}`, code: 'ARTIFACT_REPORT_DELIVERY_INVALID', deliveryState: null };
  }
  const deliveryState = backend.report_delivery?.[requestedDelivery] ?? CAPABILITY_STATE.UNSUPPORTED;
  if (deliveryState === CAPABILITY_STATE.UNSUPPORTED) {
    return { ok: false, delivery: null, input: null, reason: `${product} does not support delivery ${requestedDelivery}`, code: 'ARTIFACT_REPORT_DELIVERY_UNSUPPORTED', deliveryState };
  }
  // Capability facts are an allowlist: a malformed/custom policy value is
  // not proof. Preserve the established refusal code for all unproven facts.
  if (deliveryState !== CAPABILITY_STATE.PROVEN) {
    return { ok: false, delivery: null, input: null, reason: `${product} delivery ${requestedDelivery} is not PROVEN — route stays disabled until proven offline`, code: 'ARTIFACT_REPORT_DELIVERY_UNPROVEN', deliveryState };
  }
  let input = null;
  if (requestedInputTransport !== null) {
    if (!Object.values(INPUT_TRANSPORT).includes(requestedInputTransport)) {
      return { ok: false, delivery: null, input: null, reason: `requestedInputTransport must be one of ${Object.values(INPUT_TRANSPORT).join(', ')}`, code: 'ARTIFACT_REPORT_INPUT_INVALID', deliveryState };
    }
    const inputState = backend.artifact_input?.[requestedInputTransport] ?? CAPABILITY_STATE.UNSUPPORTED;
    if (inputState !== CAPABILITY_STATE.PROVEN) {
      return { ok: false, delivery: null, input: null, reason: `${product} input transport ${requestedInputTransport} is ${inputState}`, code: 'ARTIFACT_REPORT_INPUT_UNSUPPORTED', deliveryState };
    }
    input = requestedInputTransport;
  }
  return { ok: true, delivery: requestedDelivery, input, reason: null, code: null, deliveryState };
}

/** Throw-style wrapper for callers that want an assertion. */
export function assertReportRoute(input) {
  const route = resolveReportRoute(input);
  if (!route.ok) {
    throw new BackendReportCapabilityError(route.reason, route.code, { product: input?.product, requestedDelivery: input?.requestedDelivery });
  }
  return route;
}
