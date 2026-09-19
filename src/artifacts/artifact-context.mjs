/**
 * P20.6 — SINGLE Context Chaining: the ONE app-owned, versioned artifact
 * context selector / resolver / admission seam.
 *
 * Authority: docs/P20/P20_6_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §7–§15,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §8,
 * P20_START_HERE.md ("SINGLE is first-class").
 *
 * Canonical principle: "Artifacts over Parsing, Paths over Payload
 * Transformation". This module NEVER parses a prior report body for
 * semantics, NEVER reinterprets legacy `requires_context.task_id` /
 * `docs/history`, and NEVER trusts a mutable `latest` file as authority.
 *
 *   selector  ->  resolveContextSelectors()  ->  concrete sealed ArtifactReference[]
 *             ->  admitArtifactContext()     ->  route + aggregate-size admission
 *   (persist exact ordered refs in task-manifest.json.previous_task_refs)
 *   ->  verifyPersistedContextRefs()  (fresh-disk full re-verification)
 *   ->  prepareArtifactInputs()/renderPreparedInputs()  (the existing adapter)
 *
 * Two boundaries (§12): admission BEFORE target task allocation / provider,
 * and consumption re-verification from the FRESH persisted target manifest
 * immediately before the report invocation. Post-admission hash drift fails
 * closed before the target provider call; a broken selected ref is never
 * auto-replaced by a newer/latest one.
 *
 * Pure orchestration over existing P20.3 authority (resolveAndVerifySealed-
 * Reference) + the P20.4 input adapter (prepareArtifactInputs). No clock, no
 * model output, no new hash-only validator.
 */

import { validateArtifactReference } from './artifact-schema.mjs';
import { canonicalArtifactRefIdentity } from './artifact-schema.mjs';
import { resolveAndVerifySealedReference, resolveAndVerifyTaskFinalArtifact } from './artifact-recovery.mjs';
import {
  prepareArtifactInputs,
  renderPreparedInputs,
  ArtifactInputTransportError,
} from './artifact-input-transport.mjs';
import { INPUT_TRANSPORT, TRANSPORT_VERSION } from './artifact-schema.mjs';
import { latestCompletedTaskId } from './artifact-index.mjs';

export class ArtifactContextError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactContextError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The deterministic internal selector forms P20.6 supports (§9). */
export const ARTIFACT_CONTEXT_SELECTOR_KIND = Object.freeze({
  ARTIFACT_REF: 'ARTIFACT_REF',
  TASK_FINAL: 'TASK_FINAL',
  LATEST_FINAL: 'LATEST_FINAL',
});
const SELECTOR_KINDS = new Set(Object.values(ARTIFACT_CONTEXT_SELECTOR_KIND));

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Pure structural validation of one selector object. No filesystem.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateContextSelector(selector) {
  const errors = [];
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) {
    return { ok: false, errors: ['selector must be an object'] };
  }
  if (!SELECTOR_KINDS.has(selector.kind)) {
    return { ok: false, errors: [`selector.kind must be one of ${[...SELECTOR_KINDS].join(', ')}`] };
  }
  // A selector NEVER carries a filesystem path (§9 "Do not accept filesystem paths").
  for (const forbidden of ['path', 'report_path', 'absolute_path', 'file', 'filepath']) {
    if (selector[forbidden] !== undefined) errors.push(`selector must not carry a filesystem path field ${JSON.stringify(forbidden)}`);
  }
  if (selector.kind === ARTIFACT_CONTEXT_SELECTOR_KIND.ARTIFACT_REF) {
    const rv = validateArtifactReference(selector.reference, { requireSealed: true });
    if (!rv.ok) errors.push(`selector.reference: ${rv.errors.join('; ')}`);
  } else if (selector.kind === ARTIFACT_CONTEXT_SELECTOR_KIND.TASK_FINAL) {
    if (!isNonEmptyString(selector.task_id)) errors.push('selector.task_id must be a non-empty string');
  }
  // LATEST_FINAL takes no further fields.
  return { ok: errors.length === 0, errors };
}

function fullVerifyConcreteRef({ store, reference, targetTaskId, originLabel }) {
  // cross-store / cross-project first (§19) — a typed, specific failure.
  if (reference.store_id !== store.storeId) {
    throw new ArtifactContextError(
      `${originLabel}: concrete ref store_id ${JSON.stringify(reference.store_id)} != target store_id ${JSON.stringify(store.storeId)}`,
      'ARTIFACT_CONTEXT_CROSS_STORE', { originLabel },
    );
  }
  if (reference.project_id !== store.projectId) {
    throw new ArtifactContextError(
      `${originLabel}: concrete ref project_id ${JSON.stringify(reference.project_id)} != target project_id ${JSON.stringify(store.projectId)}`,
      'ARTIFACT_CONTEXT_CROSS_PROJECT', { originLabel },
    );
  }
  if (isNonEmptyString(targetTaskId) && reference.task_id === targetTaskId) {
    throw new ArtifactContextError(
      `${originLabel}: a task may not select its own artifact as prior context (task_id ${JSON.stringify(targetTaskId)})`,
      'ARTIFACT_CONTEXT_SELF_REFERENCE', { originLabel },
    );
  }
  try {
    resolveAndVerifySealedReference({ store, reference });
  } catch (error) {
    throw new ArtifactContextError(
      `${originLabel}: concrete sealed ref failed full authority/hash/bytes/sealed_at verification: ${error.message}`,
      'ARTIFACT_CONTEXT_REF_VERIFY_FAILED', { originLabel, cause: error.code ?? null },
    );
  }
}

function resolveOne({ store, selector, targetTaskId, index }) {
  const originLabel = `selector[${index}] ${selector?.kind ?? '?'}`;
  const sv = validateContextSelector(selector);
  if (!sv.ok) {
    throw new ArtifactContextError(`${originLabel}: ${sv.errors.join('; ')}`, 'ARTIFACT_CONTEXT_INVALID_SELECTOR', { originLabel, errors: sv.errors });
  }

  if (selector.kind === ARTIFACT_CONTEXT_SELECTOR_KIND.ARTIFACT_REF) {
    const reference = structuredClone(selector.reference);
    fullVerifyConcreteRef({ store, reference, targetTaskId, originLabel });
    return reference;
  }

  if (selector.kind === ARTIFACT_CONTEXT_SELECTOR_KIND.TASK_FINAL) {
    if (isNonEmptyString(targetTaskId) && selector.task_id === targetTaskId) {
      throw new ArtifactContextError(`${originLabel}: task-final selector names the target task itself (${JSON.stringify(targetTaskId)})`, 'ARTIFACT_CONTEXT_SELF_REFERENCE', { originLabel });
    }
    // P20.6R R2 — the SHARED source-task FINAL authority proof. The selected
    // ref must be THE final authority of the named source task, not merely
    // any independently valid sealed artifact in the same store/project.
    const reference = resolveSourceTaskFinal({ store, sourceTaskId: selector.task_id, targetTaskId, originLabel });
    return reference;
  }

  // LATEST_FINAL — a SELECTOR ONLY. The newest COMPLETED/PASS candidate is
  // discovered from authoritative manifests, then the SAME source-task FINAL
  // authority proof runs on that candidate. If the newest candidate's final
  // authority is corrupt/cross-task/wrong-topology it FAILS CLOSED — it never
  // silently falls back to an older task and hides the corruption (§9.3/§15,
  // R2.4). Resolved once; a later movement of "latest" never changes an
  // already-admitted target.
  // P20.8 PRE-R3 R3-3 — latestCompletedTaskId() itself fails closed
  // (ARTIFACT_INDEX_LATEST_AMBIGUOUS) when a newer task folder exists whose
  // authority metadata cannot be read/parsed safely enough to rank it; that
  // refusal is re-surfaced in THIS module's own error taxonomy rather than
  // leaking a raw ArtifactIndexError to callers of resolveContextSelectors.
  let latestTaskId;
  try {
    latestTaskId = latestCompletedTaskId({ store });
  } catch (error) {
    throw new ArtifactContextError(`${originLabel}: ${error.message}`, 'ARTIFACT_CONTEXT_LATEST_AMBIGUOUS', { originLabel, cause: error.code ?? null });
  }
  if (!latestTaskId) {
    throw new ArtifactContextError(`${originLabel}: no completed, gate-passed task with a final_ref exists to resolve LATEST_FINAL`, 'ARTIFACT_CONTEXT_TASK_NOT_FOUND', { originLabel });
  }
  return resolveSourceTaskFinal({ store, sourceTaskId: latestTaskId, targetTaskId, originLabel });
}

function resolveSourceTaskFinal({ store, sourceTaskId, targetTaskId, originLabel }) {
  let finalRef;
  try {
    ({ finalRef } = resolveAndVerifyTaskFinalArtifact({ store, taskId: sourceTaskId }));
  } catch (error) {
    const code = ({
      ARTIFACT_CONTEXT_TASK_NOT_FOUND: 'ARTIFACT_CONTEXT_TASK_NOT_FOUND',
      ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE: 'ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE',
      ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    })[error.code] ?? 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED';
    throw new ArtifactContextError(`${originLabel}: ${error.message}`, code, { originLabel, sourceTaskId, cause: error.code ?? null });
  }
  const reference = structuredClone(finalRef);
  // relative-to-TARGET guards (self / cross-store / cross-project) + a final
  // full disk re-verify.
  fullVerifyConcreteRef({ store, reference, targetTaskId, originLabel });
  return reference;
}

/**
 * §9/§10 — resolve every selector ONCE to a concrete, fully-verified sealed
 * ArtifactReference, in the exact given order. Duplicate concrete refs FAIL
 * CLOSED (§7/§H — never silently deduplicated). Self / cross-store /
 * cross-project refs fail closed. No target task is created here.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @param {Array<object>} input.selectors  ordered internal selector forms
 * @param {string} input.targetTaskId  the task that will consume this context
 * @returns {object[]}  ordered concrete sealed ArtifactReference objects
 */
export function resolveContextSelectors({ store, selectors, targetTaskId }) {
  if (!store || typeof store.openTaskById !== 'function') {
    throw new ArtifactContextError('an ArtifactStore is required', 'ARTIFACT_CONTEXT_INVALID_SELECTOR');
  }
  if (!Array.isArray(selectors)) {
    throw new ArtifactContextError('selectors must be an array', 'ARTIFACT_CONTEXT_INVALID_SELECTOR');
  }
  const refs = [];
  const seen = new Map();
  selectors.forEach((selector, index) => {
    const ref = resolveOne({ store, selector, targetTaskId, index });
    const key = canonicalArtifactRefIdentity(ref);
    if (seen.has(key)) {
      throw new ArtifactContextError(
        `selector[${index}] resolves to the same concrete sealed artifact as selector[${seen.get(key)}] — duplicate context refs are rejected, never silently deduplicated`,
        'ARTIFACT_CONTEXT_DUPLICATE_REF', { index, duplicateOf: seen.get(key) },
      );
    }
    seen.set(key, index);
    refs.push(Object.freeze(ref));
  });
  return refs;
}

function mapInputTransportError(error, originLabel) {
  if (!(error instanceof ArtifactInputTransportError)) {
    return new ArtifactContextError(`${originLabel}: ${error.message}`, 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED', { cause: error.code ?? null });
  }
  const map = {
    ARTIFACT_INPUT_ROUTE_UNSUPPORTED: 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED',
    ARTIFACT_INPUT_TRANSPORT_INVALID: 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED',
    ARTIFACT_INPUT_NO_STORE: 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED',
    ARTIFACT_INPUT_OVERSIZE: 'ARTIFACT_CONTEXT_OVERSIZE',
    ARTIFACT_INPUT_REF_VERIFY_FAILED: 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED',
    ARTIFACT_INPUT_NOT_UTF8: 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED',
  };
  const code = map[error.code] ?? 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED';
  return new ArtifactContextError(`${originLabel}: ${error.message}`, code, { cause: error.code ?? null, ...(error.totalBytes !== undefined ? { totalBytes: error.totalBytes, maxTotal: error.maxTotal } : {}) });
}

/**
 * §10/§11 — admit the resolved concrete refs against the CONSUMER's route:
 * verified sealed-reference input adapter, route admission, aggregate byte
 * cap. `NATIVE_ASSIGNED_READ` is path/ref only and PROOF-gated;
 * `VERBATIM_CONTENT` is exact, complete, strict-UTF-8, untrusted. Oversize
 * fails closed — no truncate / summary fallback.
 *
 * P20.8R4: `requestedDelivery`, when supplied, must be the CONSUMER's
 * actual production report delivery mechanism (e.g. DIRECT_WRITE for a
 * P20.8R2+-routed backend) — forwarded, never hard-coded here, straight
 * to `prepareArtifactInputs()`. Omitted (every pre-R4 caller), it falls
 * through to that function's own backward-compatible
 * `'VERBATIM_MATERIALIZATION'` default — byte-for-byte unchanged.
 *
 * @returns {{ prepared: object, rendered: { trustedRefBlock: string|null, evidence: Array<{label:string,content:string}> } }}
 */
export function admitArtifactContext({ store, refs, consumerBackend, capabilityPolicy, requestedInputTransport, requestedDelivery, limits = {} }) {
  const transport = requestedInputTransport ?? INPUT_TRANSPORT.VERBATIM_CONTENT;
  const references = (Array.isArray(refs) ? refs : []).map((reference, i) => ({ label: `prior-artifact-${i + 1}`, reference }));
  let prepared;
  try {
    prepared = prepareArtifactInputs({
      store,
      consumerBackend,
      capabilityPolicy,
      requestedInputTransport: transport,
      ...(requestedDelivery !== undefined ? { requestedDelivery } : {}),
      references,
      limits,
    });
  } catch (error) {
    throw mapInputTransportError(error, 'artifact context admission');
  }
  return { prepared, rendered: renderPreparedInputs(prepared) };
}

/**
 * §12 Boundary B — read the FRESH persisted target manifest, take its
 * `previous_task_refs` verbatim, and full-verify every concrete ref again
 * against fresh disk authority (self / cross-store / cross-project / dup
 * re-checked). An in-memory selector result is NEVER preferred over the
 * persisted manifest. Post-admission hash drift throws here, before the
 * target provider call.
 *
 * @returns {object[]}  the persisted concrete refs, re-verified, in order
 */
export function verifyPersistedContextRefs({ store, targetTaskId, refs }) {
  if (!Array.isArray(refs)) {
    throw new ArtifactContextError('persisted previous_task_refs is not an array', 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED');
  }
  const seen = new Map();
  const out = [];
  refs.forEach((reference, index) => {
    const originLabel = `previous_task_refs[${index}]`;
    const rv = validateArtifactReference(reference, { requireSealed: true });
    if (!rv.ok) {
      throw new ArtifactContextError(`${originLabel}: not a valid sealed ArtifactReference: ${rv.errors.join('; ')}`, 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED', { originLabel });
    }
    fullVerifyConcreteRef({ store, reference, targetTaskId, originLabel });
    const key = canonicalArtifactRefIdentity(reference);
    if (seen.has(key)) {
      throw new ArtifactContextError(`${originLabel}: duplicate concrete sealed ref (same canonical identity as previous_task_refs[${seen.get(key)}])`, 'ARTIFACT_CONTEXT_DUPLICATE_REF', { index, duplicateOf: seen.get(key) });
    }
    seen.set(key, index);
    out.push(Object.freeze(structuredClone(reference)));
  });
  return out;
}

/**
 * §12/§13 — the full consumption-side preparation: fresh-read the target
 * manifest, re-verify its persisted `previous_task_refs` (Boundary B),
 * re-run the consumer route/size admission, and render the ordered inputs
 * for the report prompt. Returns the persisted refs (order preserved), the
 * prepared adapter result, and the `{ trustedRefBlock, evidence }` render.
 *
 * P20.8R4: `requestedDelivery`, when supplied, is forwarded verbatim to
 * `admitArtifactContext()` — see its own docstring above.
 *
 * @returns {{ refs: object[], prepared: object, rendered: object, transport: string, entries: object[] }}
 */
export function prepareContextForConsumption({ store, task, targetTaskId, consumerBackend, capabilityPolicy, requestedInputTransport, requestedDelivery, limits = {} }) {
  const tId = targetTaskId ?? task?.taskId;
  if (!store || typeof store.storeId !== 'string') {
    throw new ArtifactContextError('Boundary B: an ArtifactStore is required', 'ARTIFACT_CONTEXT_BOUNDARY_B_TARGET_MISMATCH');
  }
  if (!isNonEmptyString(tId)) {
    throw new ArtifactContextError('Boundary B: a targetTaskId is required', 'ARTIFACT_CONTEXT_BOUNDARY_B_TARGET_MISMATCH');
  }
  let manifest;
  try { manifest = task.freshManifest(); }
  catch (error) {
    throw new ArtifactContextError(`target task manifest unreadable at consumption: ${error.message}`, 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED', { cause: error.code ?? null });
  }
  // P20.6R R3 — BIND the target task object/id/store/project/mode BEFORE
  // reading its refs. A caller-supplied task workspace whose manifest does not
  // match the claimed target must NEVER be allowed to supply context refs.
  const idMismatch = [];
  if (manifest.transport_version !== TRANSPORT_VERSION.ARTIFACT_V1) idMismatch.push(`transport_version=${JSON.stringify(manifest.transport_version)}`);
  if (manifest.store_id !== store.storeId) idMismatch.push(`store_id ${JSON.stringify(manifest.store_id)} != ${JSON.stringify(store.storeId)}`);
  if (manifest.project_id !== store.projectId) idMismatch.push(`project_id ${JSON.stringify(manifest.project_id)} != ${JSON.stringify(store.projectId)}`);
  if (manifest.task_id !== tId) idMismatch.push(`task_id ${JSON.stringify(manifest.task_id)} != targetTaskId ${JSON.stringify(tId)}`);
  if (typeof task?.taskId === 'string' && task.taskId !== tId) idMismatch.push(`TaskWorkspace.taskId ${JSON.stringify(task.taskId)} != targetTaskId ${JSON.stringify(tId)}`);
  if (manifest.mode !== 'single') idMismatch.push(`mode ${JSON.stringify(manifest.mode)} != 'single' (P20.6 SINGLE context lane)`);
  if (idMismatch.length) {
    throw new ArtifactContextError(
      `Boundary B: the consumption target manifest does not match the claimed target: ${idMismatch.join('; ')}`,
      'ARTIFACT_CONTEXT_BOUNDARY_B_TARGET_MISMATCH', { mismatches: idMismatch },
    );
  }
  const persisted = Array.isArray(manifest.previous_task_refs) ? manifest.previous_task_refs : [];
  const refs = verifyPersistedContextRefs({ store, targetTaskId: tId, refs: persisted });
  const { prepared, rendered } = admitArtifactContext({
    store, refs, consumerBackend, capabilityPolicy, requestedInputTransport, requestedDelivery, limits,
  });
  return { refs, prepared, rendered, transport: prepared.transport, entries: prepared.entries };
}
