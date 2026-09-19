/**
 * P22.4 §G/§5 — the single versioned SUPPORTED/UNSUPPORTED production
 * backend-capability authority.
 *
 * Authority: docs/P22/P22_3_SIX_BACKEND_UNIFIED_ARTIFACT_EXECUTION_ARCHITECTURE.md §5.
 *
 * Historically, production report/artifact-input admission for a specific
 * profile went through `capability-evidence-registry.mjs`'s per-run overlay,
 * which required a durable, EXACT-TUPLE (profile_id, product, model,
 * reasoning, executable path/version, OS, route, source-access mode) PROVEN
 * record before `backend-report-capability.mjs`'s `assertReportRoute()`
 * would admit it. That evidence store is qualification evidence (it answers
 * "did a bounded offline/sandbox probe once demonstrate this backend family
 * CAN do this route" — see p20-production-capability-probe.mjs) — it was
 * never meant to gate every new profile/model/reasoning/display-name
 * forever, but `buildRunCapabilityPolicy()` only ever upgrades a cell to
 * PROVEN when a matching tuple is found, so a brand-new profile (a new
 * profile_id is, by construction, a new tuple key) can never match ANY
 * existing evidence record, however many times its underlying model has
 * already been proven under a different profile id.
 *
 * This module is the fix: it is a STATIC, code-reviewed, adapter-level fact
 * — "this backend PRODUCT has a real, implemented, tested report-delivery /
 * artifact-input route" — completely independent of profile/model/
 * reasoning/display-name/executable-version identity. Changing any of those
 * fields on a profile can never change what this module returns for that
 * profile's `product`. It reads NO file, spawns NO process, and consults
 * the capability-evidence-registry NOT AT ALL (§5: "Production admission
 * must not import/read their evidence registry").
 *
 * `capability-evidence-registry.mjs` and `p20-production-capability-probe.mjs`
 * remain valid, unmodified SETUP/QUALIFICATION tools — they answer "should we
 * ship this adapter at all", not "should this run be admitted".
 */

import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE, DELIVERY_MECHANISM, INPUT_TRANSPORT } from '../artifacts/backend-report-capability.mjs';
import { ARTIFACT_ROLE, ROLE_STAGE_MATRIX } from '../artifacts/artifact-paths.mjs';

export class ProductionBackendCapabilityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ProductionBackendCapabilityError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * P22.5 — the four product task modes a backend can be used for. This is a
 * SEPARATE axis from report_delivery/artifact_input above: a product can
 * have a fully working report-delivery/artifact-input route and still be
 * restricted, by deliberate PRODUCT POLICY, from certain task modes. This
 * is never a qualification/proof state (there is no PARTIAL/UNPROVEN value
 * here) — a mode is either an intended product capability (true) or an
 * intentionally unsupported one (false), decided once per product, not per
 * profile/model/reasoning.
 */
export const TASK_MODE = Object.freeze({
  SINGLE: 'SINGLE',
  COUNCIL: 'COUNCIL',
  DEBATE_MEMBER: 'DEBATE_MEMBER',
  DEBATE_CHAIR: 'DEBATE_CHAIR',
});
const TASK_MODE_VALUES = new Set(Object.values(TASK_MODE));

const FULL_MULTI_AGENT_TASK_MODES = Object.freeze({
  [TASK_MODE.SINGLE]: true, [TASK_MODE.COUNCIL]: true, [TASK_MODE.DEBATE_MEMBER]: true, [TASK_MODE.DEBATE_CHAIR]: true,
});

/**
 * P22.5 §H — the exact, owner-facing explanation for why `api` (or any
 * future SINGLE-only product) cannot be used for a given multi-agent mode.
 * Reused verbatim by the runtime admission error AND the Desktop UI help
 * text so the two never drift.
 */
export const API_MULTI_AGENT_POLICY_GUIDANCE =
  'Direct API profiles support Single tasks only. To use this model in Council or Debate, configure the API provider in OpenCode and use an OpenCode PM profile.';

/**
 * The one authoritative "this product's adapter really implements this
 * route, and product policy allows it for these task modes" table.
 * SUPPORTED/UNSUPPORTED (report_delivery/artifact_input) and
 * true/false (task_modes) only — no per-profile/per-model dimension exists
 * here at all. Adding a seventh backend, changing a product's route, or
 * changing which task modes a product is offered for is a code review of
 * THIS table (and the adapter/product decision it describes), never a
 * per-profile qualification step.
 */
export const PRODUCTION_BACKEND_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({ report_delivery: DELIVERY_MECHANISM.DIRECT_WRITE, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT, task_modes: FULL_MULTI_AGENT_TASK_MODES }),
  opencode: Object.freeze({ report_delivery: DELIVERY_MECHANISM.DIRECT_WRITE, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT, task_modes: FULL_MULTI_AGENT_TASK_MODES }),
  antigravity: Object.freeze({ report_delivery: DELIVERY_MECHANISM.DIRECT_WRITE, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT, task_modes: FULL_MULTI_AGENT_TASK_MODES }),
  // P22.4 §C/§E: Codex/Grok CLIs already run production execution in a
  // fully write-capable mode today (see production-pm-backend-registry.mjs
  // — codex: `--dangerously-bypass-approvals-and-sandbox`; grok:
  // `--permission-mode bypassPermissions --sandbox off`). DIRECT_WRITE for
  // the report plane reuses that same already-shipped write capability —
  // it is not a new, unproven native feature.
  codex: Object.freeze({ report_delivery: DELIVERY_MECHANISM.DIRECT_WRITE, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT, task_modes: FULL_MULTI_AGENT_TASK_MODES }),
  grok: Object.freeze({ report_delivery: DELIVERY_MECHANISM.DIRECT_WRITE, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT, task_modes: FULL_MULTI_AGENT_TASK_MODES }),
  // P22.5 — `api` is SUPPORTED_SINGLE_ONLY: an INTENTIONAL, permanent
  // product-policy decision, not an unproven/incomplete migration state
  // (see docs/P22/P22_5_FINAL_MULTI_AGENT_PRODUCT_POLICY_AND_MIGRATION_CLOSURE.md).
  // The report-delivery/artifact-input route below is real and unchanged
  // from P22.4 — direct API SINGLE keeps using the full artifact/report/
  // seal/final_ref/settlement pipeline. DSH deliberately does not maintain
  // a second multi-agent control protocol for a text-completion-only
  // backend: an API-hosted model that needs Council/Debate is used through
  // an OpenCode PM profile instead (see API_MULTI_AGENT_POLICY_GUIDANCE).
  api: Object.freeze({
    report_delivery: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, artifact_input: INPUT_TRANSPORT.VERBATIM_CONTENT,
    task_modes: Object.freeze({ [TASK_MODE.SINGLE]: true, [TASK_MODE.COUNCIL]: false, [TASK_MODE.DEBATE_MEMBER]: false, [TASK_MODE.DEBATE_CHAIR]: false }),
    unsupportedTaskModeGuidance: API_MULTI_AGENT_POLICY_GUIDANCE,
  }),
});

/**
 * Map an artifact stage to the TASK_MODE it represents, using the SAME
 * single frozen role/stage matrix (artifact-paths.mjs) every other P20/P22
 * module already consults — never a second, divergent stage classification.
 */
export function taskModeForArtifactStage(stage) {
  const row = ROLE_STAGE_MATRIX[stage];
  if (!row) throw new ProductionBackendCapabilityError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'PRODUCTION_CAPABILITY_UNKNOWN_STAGE', { stage });
  if (row.role === ARTIFACT_ROLE.SINGLE) return TASK_MODE.SINGLE;
  if (!row.debate) return TASK_MODE.COUNCIL;
  return row.role === ARTIFACT_ROLE.CHAIR ? TASK_MODE.DEBATE_CHAIR : TASK_MODE.DEBATE_MEMBER;
}

/**
 * `{ ok, product, mode, code, reason }` — never throws.
 *
 * A product NOT present in `PRODUCTION_BACKEND_SUPPORT` at all (an unknown
 * backend id, or an offline test double such as `'fake'`/`'a'`/`'WRONG'`)
 * is NEVER rejected here — this axis is purely ADDITIVE product policy for
 * backends this table explicitly knows about; it must never duplicate or
 * pre-empt the separate, authoritative unknown-backend/route rejection
 * `resolveReportRoute()`/`assertReportRoute()` (backend-report-capability.mjs)
 * already performs with its own, differently-coded errors. Only a KNOWN
 * product whose row explicitly marks a mode `false` is rejected here.
 */
export function resolveBackendTaskModeSupport(product, mode) {
  if (!TASK_MODE_VALUES.has(mode)) {
    return { ok: false, product, mode, code: 'PRODUCTION_CAPABILITY_INVALID_TASK_MODE', reason: `mode must be one of ${[...TASK_MODE_VALUES].join(', ')}` };
  }
  const row = PRODUCTION_BACKEND_SUPPORT[product];
  if (!row || row.task_modes?.[mode] !== false) {
    return { ok: true, product, mode, code: null, reason: null };
  }
  const guidance = row.unsupportedTaskModeGuidance ? ` ${row.unsupportedTaskModeGuidance}` : '';
  return { ok: false, product, mode, code: 'BACKEND_TASK_MODE_UNSUPPORTED', reason: `${product} does not support ${mode} tasks by product policy.${guidance}` };
}

/** Throw-style wrapper — code `BACKEND_TASK_MODE_UNSUPPORTED` (or an invalid-input code). */
export function assertBackendTaskModeSupported(product, mode) {
  const result = resolveBackendTaskModeSupport(product, mode);
  if (!result.ok) throw new ProductionBackendCapabilityError(result.reason, result.code, { product, mode });
  return result;
}

/** `{ ok, product, route, code, reason }` — never throws. */
export function resolveProductionCapability(product, routeKind) {
  if (routeKind !== 'report_delivery' && routeKind !== 'artifact_input') {
    return { ok: false, product, route: null, code: 'PRODUCTION_CAPABILITY_INVALID_ROUTE_KIND', reason: 'routeKind must be report_delivery or artifact_input' };
  }
  const row = PRODUCTION_BACKEND_SUPPORT[product];
  const route = row?.[routeKind] ?? null;
  if (!route) {
    return { ok: false, product, route: null, code: 'PRODUCTION_CAPABILITY_UNSUPPORTED_PRODUCT', reason: `no production ${routeKind} route for product ${JSON.stringify(product)}` };
  }
  return { ok: true, product, route, code: null, reason: null };
}

/** Throw-style wrapper. */
export function assertProductionCapability(product, routeKind) {
  const result = resolveProductionCapability(product, routeKind);
  if (!result.ok) throw new ProductionBackendCapabilityError(result.reason, result.code, { product, routeKind });
  return result;
}

/**
 * Build a policy object shaped EXACTLY like DEFAULT_BACKEND_REPORT_POLICY /
 * buildRunCapabilityPolicy()'s return value — a drop-in replacement at every
 * `resolveReportRoute`/`assertReportRoute` call site — except every cell is
 * derived ONLY from PRODUCTION_BACKEND_SUPPORT above, never from a durable
 * per-tuple evidence file. A product/route this table marks supported is
 * PROVEN for every profile of that product, regardless of profile id,
 * model, reasoning, display name, or executable version — and regardless
 * of whether the capability-evidence-registry file is present, empty,
 * corrupt, or historical. A product/route this table does not mark
 * supported stays exactly at `basePolicy`'s own (conservative UNSUPPORTED/
 * UNPROVEN) state — this function only ever ADDS admission, never removes
 * an existing UNSUPPORTED refusal.
 *
 * No registry, no profile list, no I/O: this is a pure function of the
 * static table, which is why it is safe to call with zero knowledge of
 * which profiles a given run actually uses.
 */
export function buildProductionCapabilityPolicy({ basePolicy = DEFAULT_BACKEND_REPORT_POLICY } = {}) {
  const backends = {};
  for (const [product, base] of Object.entries(basePolicy.backends ?? {})) {
    const support = PRODUCTION_BACKEND_SUPPORT[product];
    if (!support) { backends[product] = base; continue; }
    const report_delivery = { ...base.report_delivery };
    if (support.report_delivery && report_delivery[support.report_delivery] !== CAPABILITY_STATE.UNSUPPORTED) {
      report_delivery[support.report_delivery] = CAPABILITY_STATE.PROVEN;
    }
    const artifact_input = { ...base.artifact_input };
    if (support.artifact_input && artifact_input[support.artifact_input] !== CAPABILITY_STATE.UNSUPPORTED) {
      artifact_input[support.artifact_input] = CAPABILITY_STATE.PROVEN;
    }
    backends[product] = Object.freeze({ report_delivery: Object.freeze(report_delivery), artifact_input: Object.freeze(artifact_input) });
  }
  // A supported product absent from basePolicy entirely (should not happen —
  // every PRODUCTION_BACKEND_SUPPORT key has a matching DEFAULT_BACKEND_REPORT_POLICY
  // row) still fails closed rather than silently admitting an unknown backend.
  for (const product of Object.keys(PRODUCTION_BACKEND_SUPPORT)) {
    if (!(product in backends)) {
      throw new ProductionBackendCapabilityError(`production-supported product ${JSON.stringify(product)} has no base capability record`, 'PRODUCTION_CAPABILITY_UNKNOWN_BASE_PRODUCT', { product });
    }
  }
  return Object.freeze({ enforcement_version: `${basePolicy.enforcement_version}+p22.4-production-capability-1`, backends: Object.freeze(backends) });
}
