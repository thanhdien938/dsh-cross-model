/**
 * P20.8 §8 — exact-tuple durable capability-evidence registry.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §8.
 *
 * `DEFAULT_BACKEND_REPORT_POLICY` (backend-report-capability.mjs) stays a
 * conservative, backend-family-scoped UNPROVEN default. It is NEVER hand-
 * edited by this module. Instead this registry records an EXPLICIT,
 * narrow-tuple, durable, application-owned fact ("this exact profile tuple
 * passed a bounded live probe for this exact route") and — only at the
 * moment a specific production run is about to execute a specific set of
 * known profiles — builds a FRESH, per-run overlay policy object that
 * `assertReportRoute()` still evaluates with its ordinary literal-PROVEN
 * rule (§8.1: "the final state accepted by assertReportRoute() must still
 * be literal PROVEN").
 *
 * §8.1 hard rules enforced here:
 *   - evidence is bound to the FULL exact tuple (profile_id, product,
 *     model, reasoning, executable path+version, OS, delivery mechanism,
 *     input mechanism, source-access mode) — never just `product`;
 *   - a tuple field drift (different model/reasoning/executable/etc.) is a
 *     DIFFERENT tuple key — it simply has no matching evidence, so it is
 *     never treated as proven;
 *   - the overlay this module builds NEVER marks a whole backend family
 *     PROVEN — only the exact `(product, deliveryMechanism)` /
 *     `(product, inputTransport)` cell for a run whose EVERY participating
 *     profile of that product independently resolves proven for that exact
 *     route (buildRunCapabilityPolicy() fails closed — refuses to build an
 *     overlay cell at all — the moment two participating profiles of the
 *     same product disagree, rather than silently picking one);
 *   - no `PROBE_ALLOWED` / `TRUST_ME` / custom truthy state is ever
 *     introduced — every cell this module writes is either the existing
 *     `CAPABILITY_STATE.PROVEN` or left at the base policy's own state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE, DELIVERY_MECHANISM, INPUT_TRANSPORT } from './backend-report-capability.mjs';

export class CapabilityEvidenceError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CapabilityEvidenceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const REGISTRY_SCHEMA_VERSION = 1;

/** Canonical, order-independent JSON for hashing — every field explicit. */
function canonicalTupleJson(tuple) {
  const ordered = {
    profile_id: tuple.profileId,
    product: tuple.product,
    model: tuple.model ?? null,
    reasoning: tuple.reasoning ?? null,
    executable_path: tuple.executablePath ?? null,
    executable_version: tuple.executableVersion ?? null,
    os: tuple.os ?? null,
    route_kind: tuple.routeKind, // 'report_delivery' | 'artifact_input'
    route_value: tuple.routeValue, // e.g. VERBATIM_MATERIALIZATION / VERBATIM_CONTENT
    source_access_mode: tuple.sourceAccessMode ?? null,
  };
  return JSON.stringify(ordered);
}

/**
 * Build one exact-tuple capability probe/evidence identity. `routeKind` is
 * 'report_delivery' (routeValue one of DELIVERY_MECHANISM) or
 * 'artifact_input' (routeValue one of INPUT_TRANSPORT).
 */
export function buildCapabilityTuple({
  profileId, product, model = null, reasoning = null,
  executablePath = null, executableVersion = null, os = process.platform,
  routeKind, routeValue, sourceAccessMode = null,
}) {
  if (typeof profileId !== 'string' || !profileId) throw new CapabilityEvidenceError('profileId is required', 'CAPABILITY_TUPLE_INVALID');
  if (typeof product !== 'string' || !product) throw new CapabilityEvidenceError('product is required', 'CAPABILITY_TUPLE_INVALID');
  if (routeKind !== 'report_delivery' && routeKind !== 'artifact_input') throw new CapabilityEvidenceError('routeKind must be report_delivery or artifact_input', 'CAPABILITY_TUPLE_INVALID');
  const validValues = routeKind === 'report_delivery' ? Object.values(DELIVERY_MECHANISM) : Object.values(INPUT_TRANSPORT);
  if (!validValues.includes(routeValue)) throw new CapabilityEvidenceError(`routeValue must be one of ${validValues.join(', ')}`, 'CAPABILITY_TUPLE_INVALID');
  return Object.freeze({ profileId, product, model, reasoning, executablePath, executableVersion, os, routeKind, routeValue, sourceAccessMode });
}

/** Stable sha256 hex identity for an exact tuple — the registry's own key. */
export function capabilityTupleKey(tuple) {
  return createHash('sha256').update(canonicalTupleJson(tuple), 'utf8').digest('hex');
}

function atomicWriteJson(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/**
 * The durable, canonical, runtime-local evidence store. One JSON file under
 * the canonical runtime base (never `.dsh-artifacts` itself, never a
 * session-scratch path) — survives restart, never auto-created with proven
 * entries.
 */
export class CapabilityEvidenceRegistry {
  #filePath;

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
      throw new CapabilityEvidenceError('filePath must be an absolute path', 'CAPABILITY_REGISTRY_PATH_INVALID');
    }
    this.#filePath = filePath;
  }

  get filePath() { return this.#filePath; }

  /** Fresh, empty registry shape when the file does not yet exist. */
  #emptyDoc() {
    return { schema_version: REGISTRY_SCHEMA_VERSION, records: {} };
  }

  /** Read the durable evidence doc. Never throws for "file absent". */
  read() {
    if (!existsSync(this.#filePath)) return this.#emptyDoc();
    let doc;
    try {
      doc = JSON.parse(readFileSync(this.#filePath, 'utf8'));
    } catch (error) {
      throw new CapabilityEvidenceError(`capability evidence file is corrupt: ${error.message}`, 'CAPABILITY_REGISTRY_CORRUPT', { filePath: this.#filePath });
    }
    if (doc?.schema_version !== REGISTRY_SCHEMA_VERSION || typeof doc?.records !== 'object' || doc.records === null) {
      throw new CapabilityEvidenceError('capability evidence file has an unsupported schema', 'CAPABILITY_REGISTRY_SCHEMA_UNSUPPORTED', { filePath: this.#filePath });
    }
    return doc;
  }

  /**
   * Look up whether an EXACT tuple is durably PROVEN. Any drift in any
   * field produces a different key -> no match -> UNPROVEN (fail closed).
   */
  resolve(tuple) {
    const doc = this.read();
    const key = capabilityTupleKey(tuple);
    const record = doc.records[key];
    if (!record || record.state !== CAPABILITY_STATE.PROVEN) return null;
    return record;
  }

  /**
   * Persist a PROVEN fact for an exact tuple. Only called by the operator-
   * only production capability probe seam (§8.2), and only after every
   * required probe assertion has already passed — this function performs
   * no probe/assertion itself, it is a pure durable write.
   */
  recordProven({ tuple, evidenceId = randomUUID(), evidence = {}, provenAt = new Date().toISOString() }) {
    const key = capabilityTupleKey(tuple);
    const doc = this.read();
    doc.records[key] = {
      tuple: {
        profile_id: tuple.profileId, product: tuple.product, model: tuple.model, reasoning: tuple.reasoning,
        executable_path: tuple.executablePath, executable_version: tuple.executableVersion, os: tuple.os,
        route_kind: tuple.routeKind, route_value: tuple.routeValue, source_access_mode: tuple.sourceAccessMode,
      },
      state: CAPABILITY_STATE.PROVEN,
      evidence_id: evidenceId,
      proven_at: provenAt,
      evidence, // non-secret facts only — caller's responsibility (§8.2, §21)
    };
    atomicWriteJson(this.#filePath, doc);
    return { key, record: doc.records[key] };
  }
}

/**
 * §8.1 — build a FRESH, per-run capability-policy overlay from durable
 * evidence, for an explicit, known, closed set of participating profiles.
 * Never mutates DEFAULT_BACKEND_REPORT_POLICY. Fails closed (throws) rather
 * than silently union-ing two disagreeing profiles of the same product —
 * this is what keeps one profile's proof from ever broadening to "the
 * whole backend family" when a run happens to use two profiles of one
 * product with different required routes.
 *
 * @param {object} input
 * @param {CapabilityEvidenceRegistry} input.registry
 * @param {Array<{profileId,product,model,reasoning,executablePath,executableVersion,os,deliveryMechanism,inputTransport,sourceAccessMode}>} input.participants
 * @param {object} [input.basePolicy] defaults to DEFAULT_BACKEND_REPORT_POLICY
 * @returns {object} a frozen policy object shaped exactly like DEFAULT_BACKEND_REPORT_POLICY
 */
export function buildRunCapabilityPolicy({ registry, participants, basePolicy = DEFAULT_BACKEND_REPORT_POLICY }) {
  if (!(registry instanceof CapabilityEvidenceRegistry)) {
    throw new CapabilityEvidenceError('registry must be a CapabilityEvidenceRegistry', 'CAPABILITY_OVERLAY_BAD_REGISTRY');
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new CapabilityEvidenceError('participants must be a non-empty array', 'CAPABILITY_OVERLAY_NO_PARTICIPANTS');
  }
  // productDecision[product] = { deliveryMechanism: Map<value, proven:boolean-agreement>, ... }
  const productCells = new Map(); // product -> { report_delivery: Map<value, boolean>, artifact_input: Map<value, boolean> }
  for (const p of participants) {
    const cells = productCells.get(p.product) ?? { report_delivery: new Map(), artifact_input: new Map() };
    if (p.deliveryMechanism) {
      const tuple = buildCapabilityTuple({
        profileId: p.profileId, product: p.product, model: p.model, reasoning: p.reasoning,
        executablePath: p.executablePath, executableVersion: p.executableVersion, os: p.os,
        routeKind: 'report_delivery', routeValue: p.deliveryMechanism, sourceAccessMode: p.sourceAccessMode,
      });
      const proven = Boolean(registry.resolve(tuple));
      const existing = cells.report_delivery.get(p.deliveryMechanism);
      if (existing !== undefined && existing !== proven) {
        throw new CapabilityEvidenceError(
          `conflicting capability evidence for product ${JSON.stringify(p.product)} route ${JSON.stringify(p.deliveryMechanism)}: two participating profiles disagree — refusing to broaden`,
          'CAPABILITY_OVERLAY_CONFLICT', { product: p.product, routeKind: 'report_delivery', routeValue: p.deliveryMechanism },
        );
      }
      cells.report_delivery.set(p.deliveryMechanism, proven);
    }
    if (p.inputTransport) {
      const tuple = buildCapabilityTuple({
        profileId: p.profileId, product: p.product, model: p.model, reasoning: p.reasoning,
        executablePath: p.executablePath, executableVersion: p.executableVersion, os: p.os,
        routeKind: 'artifact_input', routeValue: p.inputTransport, sourceAccessMode: p.sourceAccessMode,
      });
      const proven = Boolean(registry.resolve(tuple));
      const existing = cells.artifact_input.get(p.inputTransport);
      if (existing !== undefined && existing !== proven) {
        throw new CapabilityEvidenceError(
          `conflicting capability evidence for product ${JSON.stringify(p.product)} route ${JSON.stringify(p.inputTransport)}: two participating profiles disagree — refusing to broaden`,
          'CAPABILITY_OVERLAY_CONFLICT', { product: p.product, routeKind: 'artifact_input', routeValue: p.inputTransport },
        );
      }
      cells.artifact_input.set(p.inputTransport, proven);
    }
    productCells.set(p.product, cells);
  }

  const backends = {};
  for (const [product, base] of Object.entries(basePolicy.backends ?? {})) {
    const cells = productCells.get(product);
    if (!cells) { backends[product] = base; continue; }
    const report_delivery = { ...base.report_delivery };
    for (const [value, proven] of cells.report_delivery) {
      if (proven && report_delivery[value] !== CAPABILITY_STATE.UNSUPPORTED) report_delivery[value] = CAPABILITY_STATE.PROVEN;
    }
    const artifact_input = { ...base.artifact_input };
    for (const [value, proven] of cells.artifact_input) {
      if (proven && artifact_input[value] !== CAPABILITY_STATE.UNSUPPORTED) artifact_input[value] = CAPABILITY_STATE.PROVEN;
    }
    backends[product] = Object.freeze({ report_delivery: Object.freeze(report_delivery), artifact_input: Object.freeze(artifact_input) });
  }
  // A participating product absent from basePolicy is never silently admitted.
  for (const product of productCells.keys()) {
    if (!(product in backends)) {
      throw new CapabilityEvidenceError(`participating product ${JSON.stringify(product)} has no base capability record`, 'CAPABILITY_OVERLAY_UNKNOWN_PRODUCT', { product });
    }
  }
  return Object.freeze({ enforcement_version: `${basePolicy.enforcement_version}+p20.8-evidence-overlay-1`, backends: Object.freeze(backends) });
}
