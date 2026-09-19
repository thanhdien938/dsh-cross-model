/**
 * P20.8 §8.2 — operator-only production capability probe seam.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §8.2, §9, §10.
 *
 * This module is deliberately NOT reachable from any owner task/prompt
 * path — it is imported only by the standalone operator CLI script
 * (scripts/p20-production-capability-probe.mjs) and by tests. Nothing in
 * production dispatch (OwnerTaskController, ProductionPmWorker,
 * DurablePmRuntime, CouncilChairDriver, SingleArtifactDriver) ever imports
 * it — §8.2's "not callable merely because a normal task prompt asks for
 * it" is enforced by construction (no caller wiring), not by a runtime
 * flag a clever prompt could flip.
 *
 * The probe reuses the REAL production report-content-plane call —
 * `runSingleReport({..., complete:true})`, the SAME function
 * SingleArtifactDriver calls in production — against the CANONICAL
 * production ArtifactStore (never a session-scratch store) and the SAME
 * report-backend adapter production owner tasks would use
 * (p20-report-route-resolution.mjs's createCliReportBackendResolver output).
 * No second orchestration engine.
 *
 * `assertReportRoute()`'s literal-PROVEN admission is never bypassed or
 * monkey-patched — instead an EPHEMERAL, probe-call-scoped policy object is
 * built (buildProbeCapabilityPolicy below) that marks PROVEN only the exact
 * `(product, route)` cell under test, leaving every other cell — including
 * every OTHER route of the same product — exactly as
 * DEFAULT_BACKEND_REPORT_POLICY already has it. This ephemeral object is
 * never persisted and never touches the real DEFAULT_BACKEND_REPORT_POLICY
 * or the durable CapabilityEvidenceRegistry; only a caller who has already
 * verified §8.2/§13's safety preconditions and receives `ok:true` back
 * from this function may choose to call `CapabilityEvidenceRegistry
 * .recordProven()` — that persistence step is NOT performed by this module
 * itself (§8.1: "persists exact evidence only after every required
 * assertion passes" — the assertions live here, the persistence decision
 * stays with the operator script that also enforces the exact-roster
 * freeze and the live-call budget).
 */

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_MECHANISM } from '../artifacts/artifact-delivery.mjs';
import { INPUT_TRANSPORT } from '../artifacts/artifact-schema.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE } from '../artifacts/backend-report-capability.mjs';
import { runSingleReport } from '../pm/single-report-operation.mjs';
import { buildCapabilityTuple } from '../artifacts/capability-evidence-registry.mjs';

export class ProductionCapabilityProbeError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ProductionCapabilityProbeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// §10 — deliberately byte-sensitive probe content: leading/trailing
// whitespace, Unicode/emoji, an em dash, a Markdown fence, a zero-width
// marker, and JSON-looking text — exactly the categories §10 requires
// comparing exact bytes/hash against. Shared by the instruction builder
// below AND the on-disk byte verification, so both sides can never
// silently drift apart. P20.8R7 §1.1/§3 — this exact-byte-copy contract
// is UNCHANGED and stays the acceptance rule for `VERBATIM_MATERIALIZATION`
// ONLY: the app must prove it captures provider-visible output verbatim,
// with no trim/normalization/drop of its own. It is no longer used to
// judge `DIRECT_WRITE` (see `DIRECT_WRITE_PROBE_NONCE_PREFIX` below) —
// for that route the provider is the AUTHOR of report.md, not a copier of
// an app-provided byte string, so reproducing an arbitrary fenced/
// zero-width canary byte-for-byte was never what DIRECT_WRITE authoring
// capability actually means (P20.8R6 profiles 23/7 lost live-call budget
// to exactly this over-constrained rule — see the P20.8R7 report).
export const CAPABILITY_PROBE_CANARY_BLOCK = [
  '```',
  '  leading and trailing spaces on this line   ',
  'unicode: café ✅ 🚀 — em dash',
  'zero-width marker:​(here)​',
  '{"looks_like_json": true, "value": 42}',
  '```',
].join('\n');

// P20.8R7 §3 — a fresh, app-generated, high-entropy nonce line per
// DIRECT_WRITE probe call. Proves the provider itself authored the
// assigned file for THIS exact call (a stale/copied/fabricated file could
// never carry a nonce minted after the process started) without requiring
// it to reproduce any particular formatting/whitespace/Unicode of an
// app-provided block.
export const DIRECT_WRITE_PROBE_NONCE_PREFIX = 'P20_DIRECT_WRITE_PROBE_NONCE=';

/** A fresh nonce LINE (prefix + high-entropy value) for one DIRECT_WRITE probe call. */
export function generateDirectWriteProbeNonce() {
  return `${DIRECT_WRITE_PROBE_NONCE_PREFIX}${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

/**
 * A READ_ONLY, non-project, clearly synthetic instruction — "must not do
 * useful project work" (§9). For DIRECT_WRITE (P20.8R7 §3), the app-owned
 * trusted section (report-prompt.mjs) already told the model the assigned
 * path; this untrusted instruction asks it to AUTHOR a tiny report itself
 * containing the exact nonce line exactly once — never to copy an
 * app-provided block byte-for-byte. For VERBATIM_MATERIALIZATION, the
 * original exact-copy-fidelity instruction is UNCHANGED.
 */
export function buildCapabilityProbeInstructions({ deliveryMechanism = DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, directWriteNonceLine = null } = {}) {
  if (deliveryMechanism === DELIVERY_MECHANISM.DIRECT_WRITE) {
    if (typeof directWriteNonceLine !== 'string' || !directWriteNonceLine.startsWith(DIRECT_WRITE_PROBE_NONCE_PREFIX)) {
      throw new ProductionCapabilityProbeError('a directWriteNonceLine is required to build a DIRECT_WRITE probe instruction', 'CAPABILITY_PROBE_NO_NONCE');
    }
    return [
      'P20.8 CAPABILITY PROBE -- bounded, synthetic, non-project canary task.',
      'This is NOT a real project task. Do not read or modify any other file. Do not use any tool other than what is required to complete your assigned deliverable.',
      'Author a short Markdown report YOURSELF (your own words, any short content) and write it to your assigned official report file (see the trusted section above). Do not write to any other path.',
      'Your report must be non-empty and must include the EXACT line below, verbatim, EXACTLY ONCE, anywhere in your report:',
      '',
      directWriteNonceLine,
    ].join('\n');
  }
  return [
    'P20.8 CAPABILITY PROBE -- bounded, synthetic, non-project canary task.',
    'This is NOT a real project task. Do not read or modify any other file. Do not use any tool other than what is required to complete your assigned deliverable.',
    'Reply with your ENTIRE final visible answer being EXACTLY the fenced block below, with nothing else before or after it -- reproduce it byte-for-byte, including the leading/trailing spaces on its second line:',
    '',
    CAPABILITY_PROBE_CANARY_BLOCK,
  ].join('\n');
}

/**
 * An ephemeral, probe-call-scoped capability policy where ONLY the exact
 * `(product, deliveryMechanism)` / `(product, inputTransport)` cell is
 * forced PROVEN — every other product, and every other route of the SAME
 * product, is left exactly as DEFAULT_BACKEND_REPORT_POLICY already has
 * it. Never persisted; never mutates the imported default object (frozen
 * anyway). Refuses (fails closed) if the requested route is UNSUPPORTED
 * for this product — a probe can only ever move UNPROVEN -> proof
 * attempt, never UNSUPPORTED -> anything.
 */
export function buildProbeCapabilityPolicy({ basePolicy = DEFAULT_BACKEND_REPORT_POLICY, product, deliveryMechanism, inputTransport = null }) {
  const base = basePolicy.backends?.[product];
  if (!base) {
    throw new ProductionCapabilityProbeError(`no base capability record for product ${JSON.stringify(product)}`, 'CAPABILITY_PROBE_UNKNOWN_PRODUCT', { product });
  }
  const report_delivery = { ...base.report_delivery };
  if (report_delivery[deliveryMechanism] === CAPABILITY_STATE.UNSUPPORTED) {
    throw new ProductionCapabilityProbeError(`product ${product} does not support delivery ${deliveryMechanism}`, 'CAPABILITY_PROBE_UNSUPPORTED_DELIVERY', { product, deliveryMechanism });
  }
  report_delivery[deliveryMechanism] = CAPABILITY_STATE.PROVEN;
  const artifact_input = { ...base.artifact_input };
  if (inputTransport) {
    if (artifact_input[inputTransport] === CAPABILITY_STATE.UNSUPPORTED) {
      throw new ProductionCapabilityProbeError(`product ${product} does not support input ${inputTransport}`, 'CAPABILITY_PROBE_UNSUPPORTED_INPUT', { product, inputTransport });
    }
    artifact_input[inputTransport] = CAPABILITY_STATE.PROVEN;
  }
  return Object.freeze({
    enforcement_version: `${basePolicy.enforcement_version}+probe-ephemeral-1`,
    backends: Object.freeze({ ...basePolicy.backends, [product]: Object.freeze({ report_delivery: Object.freeze(report_delivery), artifact_input: Object.freeze(artifact_input) }) }),
  });
}

/**
 * @param {object} input
 * @param {import('../artifacts/artifact-store.mjs').ArtifactStore} input.store  the CANONICAL production store.
 * @param {{id:string, product:string, model?:string, reasoning?:string}} input.profile
 * @param {{backend:string, runReport:Function}} input.reportBackend  the REAL production adapter for this exact profile.
 * @param {string} [input.deliveryMechanism]
 * @param {string} [input.inputTransport]
 * @param {{path:string|null, version:string|null}} [input.executableIdentity]
 * @param {string} [input.sourceAccessMode]
 * @returns {Promise<object>} `{ ok, taskId, tuple, inputTuple, evidence, out }` on success,
 *   `{ ok:false, taskId, failureCode, out?, error? }` on any failure — never throws for an
 *   ordinary probe failure (a truthful non-PROVEN outcome IS the expected shape §8.1 wants).
 */
export async function runProductionCapabilityProbe({
  store, profile, reportBackend,
  deliveryMechanism = DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION,
  inputTransport = INPUT_TRANSPORT.VERBATIM_CONTENT,
  executableIdentity = { path: null, version: null },
  sourceAccessMode = 'READ_ONLY',
  now = () => new Date().toISOString(),
}) {
  if (!store || typeof store.allocateTask !== 'function') {
    throw new ProductionCapabilityProbeError('the canonical production ArtifactStore is required', 'CAPABILITY_PROBE_NO_STORE');
  }
  if (!profile?.id || !profile?.product) {
    throw new ProductionCapabilityProbeError('profile {id, product} is required', 'CAPABILITY_PROBE_NO_PROFILE');
  }
  if (!reportBackend || typeof reportBackend.runReport !== 'function' || reportBackend.backend !== profile.product) {
    throw new ProductionCapabilityProbeError('reportBackend must be the REAL production adapter for this exact profile.product', 'CAPABILITY_PROBE_BAD_BACKEND', { product: profile.product, backend: reportBackend?.backend ?? null });
  }

  const createdAt = now();
  const taskId = `p20-8-probe-${profile.id}-${randomUUID()}`;
  const capabilityPolicy = buildProbeCapabilityPolicy({ product: profile.product, deliveryMechanism, inputTransport });
  const isDirectWrite = deliveryMechanism === DELIVERY_MECHANISM.DIRECT_WRITE;
  // P20.8R7 §3 — minted fresh per call, before the instruction is built, so
  // it is impossible for any pre-existing/stale file to already contain it.
  const directWriteNonceLine = isDirectWrite ? generateDirectWriteProbeNonce() : null;
  const instructions = buildCapabilityProbeInstructions({ deliveryMechanism, directWriteNonceLine });

  let out;
  try {
    out = await runSingleReport({
      store, taskId, taskSlug: 'p20-8-capability-probe', createdAt,
      invocationId: 'inv-probe', executionId: `exec-${randomUUID()}`,
      profileId: profile.id, backend: profile.product, actorAlias: profile.id,
      instructions, deliveryMechanism, inputTransport, capabilityPolicy,
      reportBackend, directWriter: reportBackend.directWriter, complete: true,
    });
  } catch (error) {
    // §20 — never auto-retry UNKNOWN_OUTCOME: this function is a single
    // bounded attempt; the caller decides whether/when to invoke it again
    // (bounded by the operator script's own MAX_LIVE_PROBE_INVOCATIONS).
    return { ok: false, taskId, failureCode: error?.code ?? error?.name ?? 'CAPABILITY_PROBE_FAILED', error };
  }

  // §9/§10 — DIRECT_WRITE never materializes accepted_visible_text (it is
  // null by construction, cli-report-backends.mjs) — the model's own
  // written FILE is the sole report authority, read back and compared to
  // the exact canary bytes below. VERBATIM_MATERIALIZATION still requires
  // the returned text before anything is treated as passing.
  let acceptedText = null;
  if (!isDirectWrite) {
    acceptedText = out.result?.accepted_visible_text ?? null;
    if (typeof acceptedText !== 'string') {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_NO_VISIBLE_TEXT', out };
    }
  }
  if (!out.completion?.finalRef) {
    return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_NOT_SEALED', out };
  }
  // `finalRef` (the sealed ArtifactReference, always populated once the
  // Task Final Artifact Gate has run) is the reliable source — prefer it
  // over `gateResult`'s own field names, which vary by internal shape.
  const sealedBytes = out.completion.finalRef?.bytes ?? out.completion.gateResult?.bytes ?? null;
  const sealedSha256 = out.completion.finalRef?.sha256 ?? out.completion.gateResult?.sha256 ?? null;

  if (isDirectWrite) {
    // P20.8R7 §1.1/§3 — the sole authority is the FILE the model itself
    // wrote; the proof is AUTHORING (the assigned path exists, is
    // non-empty, and carries the fresh app-minted nonce exactly once),
    // never exact reproduction of an app-provided byte string. Read the
    // sealed bytes back off disk independently (never reuse the CLI
    // bridge's own hashing/comparison code) so a real drift between what
    // was sealed and what is actually on disk cannot hide.
    let onDisk;
    try {
      onDisk = readFileSync(join(store.root, out.completion.finalRef.artifact_relpath), 'utf8');
    } catch (error) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_SEALED_FILE_UNREADABLE', out, error };
    }
    if (onDisk.trim().length === 0) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_DIRECT_WRITE_EMPTY', out };
    }
    const nonceOccurrences = onDisk.split(directWriteNonceLine).length - 1;
    if (nonceOccurrences !== 1) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_DIRECT_WRITE_NONCE_MISSING_OR_DUPLICATED', out, nonceOccurrences };
    }
    // §6/§9 — DSH must not have materialized provider stdout as report
    // authority for this DIRECT_WRITE call; `accepted_visible_text` stays
    // null by construction in the real adapter (cli-report-backends.mjs) —
    // a non-null value here would mean a silent fallback route ran.
    if (out.result?.accepted_visible_text !== null && out.result?.accepted_visible_text !== undefined) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_DIRECT_WRITE_MATERIALIZATION_FALLBACK', out };
    }
    if (out.result?.safe_diagnostics?.direct_write !== true) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_DIRECT_WRITE_DIAGNOSTIC_MISSING', out };
    }
    // Independent recompute — never reuse deliverDirectWrite()'s own
    // sha256File()/statSync() bookkeeping — proving the SEALED bytes/hash
    // are exactly the bytes actually on disk right now, unrewritten.
    const recomputedBytes = Buffer.byteLength(onDisk, 'utf8');
    const recomputedSha256 = createHash('sha256').update(onDisk, 'utf8').digest('hex');
    if (sealedBytes !== null && sealedBytes !== recomputedBytes) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_BYTE_DRIFT', out, recomputedBytes, sealedBytes };
    }
    if (sealedSha256 !== null && sealedSha256 !== recomputedSha256) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_HASH_DRIFT', out, recomputedSha256, sealedSha256 };
    }
  } else {
    const expectedBytes = Buffer.byteLength(acceptedText, 'utf8');
    const expectedSha256 = out.delivery?.sha256 ?? null;
    if (sealedBytes !== null && sealedBytes !== expectedBytes) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_BYTE_DRIFT', out, expectedBytes, sealedBytes };
    }
    if (sealedSha256 !== null && expectedSha256 !== null && sealedSha256 !== expectedSha256) {
      return { ok: false, taskId, failureCode: 'CAPABILITY_PROBE_HASH_DRIFT', out, expectedSha256, sealedSha256 };
    }
  }

  const tuple = buildCapabilityTuple({
    profileId: profile.id, product: profile.product, model: profile.model ?? null, reasoning: profile.reasoning ?? null,
    executablePath: executableIdentity.path, executableVersion: executableIdentity.version, os: process.platform,
    routeKind: 'report_delivery', routeValue: deliveryMechanism, sourceAccessMode,
  });
  const inputTuple = inputTransport ? buildCapabilityTuple({
    profileId: profile.id, product: profile.product, model: profile.model ?? null, reasoning: profile.reasoning ?? null,
    executablePath: executableIdentity.path, executableVersion: executableIdentity.version, os: process.platform,
    routeKind: 'artifact_input', routeValue: inputTransport, sourceAccessMode,
  }) : null;

  const evidence = Object.freeze({
    task_id: taskId,
    final_ref: out.completion.finalRef,
    report_sha256: sealedSha256,
    report_bytes: sealedBytes,
    terminal_state: out.result?.terminal_state ?? null,
    delivery_mechanism: deliveryMechanism,
    // P20.8R7 — renamed from the old `direct_write_content_verified` to
    // avoid ever implying "exact PM canary copy fidelity" was proven for
    // DIRECT_WRITE; this fact means exactly what §1.1/§3 define: the
    // provider authored the assigned file itself, non-empty, containing
    // the fresh app-minted nonce exactly once, sealed unrewritten.
    direct_write_authoring_verified: isDirectWrite ? true : undefined,
    direct_write_nonce_present_exactly_once: isDirectWrite ? true : undefined,
    accepted_text_sha256_matches_sealed: !isDirectWrite ? true : undefined,
    call_count: 1,
  });

  return { ok: true, taskId, tuple, inputTuple, evidence, out };
}
