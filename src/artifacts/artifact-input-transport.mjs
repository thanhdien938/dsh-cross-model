/**
 * P20.4 §20–§24 — the ONE reusable sealed-artifact INPUT adapter for
 * downstream (Council Member / Chair) report invocations.
 *
 * Authority: docs/P20/P20_4_SONNET_IMPLEMENTATION_MASTER_PROMPT.md
 * §20/§21/§22/§23/§24/§37,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §8.
 *
 * For every input ArtifactReference:
 *   resolveAndVerifySealedReference()  (P20.3 full authority + containment)
 *   -> consumer artifact-input capability/admission check
 *   -> NATIVE_ASSIGNED_READ (verified path/identity only, NEVER the body)
 *      or VERBATIM_CONTENT (the SAME verified buffer, strict UTF-8, injected
 *      as explicitly UNTRUSTED evidence — never trimmed/normalized/summarised)
 *
 * Council code never re-implements sealed-reference verification — it calls
 * here. Deterministic input ordering is preserved. Oversize fails closed
 * with a typed error; there is NO silent truncation or summary fallback.
 *
 * Uses only fresh-disk P20.3 authority + Node fs; no model output, no clock.
 */

import { resolveAndVerifySealedReference } from './artifact-recovery.mjs';
import { resolveReportRoute } from './backend-report-capability.mjs';
import { INPUT_TRANSPORT } from './artifact-schema.mjs';

export class ArtifactInputTransportError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactInputTransportError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Explicit, versioned aggregate compatibility-payload limit (§22 — "explicit
// versioned byte/aggregate limits rather than an unexplained magic number").
// A Chair synthesis reads chair-plan + up to COUNCIL_MAX_PARTICIPANTS reports
// + up to COUNCIL_MAX_PARTICIPANTS critiques. 8 MiB is well above any
// plausible aggregate of Markdown reports yet far below provider input
// ceilings; a caller may LOWER it, never silently raise it.
export const ARTIFACT_INPUT_SIZE_POLICY = Object.freeze({
  version: 'p20.4-input-1',
  maxTotalInputBytes: 8 * 1024 * 1024,
});

function clampLimit(requested) {
  const cap = ARTIFACT_INPUT_SIZE_POLICY.maxTotalInputBytes;
  if (!Number.isInteger(requested) || requested <= 0) return cap;
  return Math.min(requested, cap);
}

/**
 * Strict UTF-8 decode of a Buffer, or fail closed (§22). `ignoreBOM: true`
 * so a leading U+FEFF is PRESERVED verbatim — no normalization/trim.
 */
function strictUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (error) {
    throw new ArtifactInputTransportError(`sealed artifact ${JSON.stringify(label)} is not valid UTF-8 — refusing to inject as evidence: ${error.message}`, 'ARTIFACT_INPUT_NOT_UTF8', { label });
  }
}

/**
 * Prepare the ordered sealed inputs for one downstream report invocation.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @param {string} input.consumerBackend  product key of the CONSUMER
 * @param {object} [input.capabilityPolicy]  admitted policy (default conservative)
 * @param {'NATIVE_ASSIGNED_READ'|'VERBATIM_CONTENT'} input.requestedInputTransport
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [input.requestedDelivery]
 *        the CONSUMER's own ACTUAL report delivery mechanism (P20.8R2+:
 *        DIRECT_WRITE for claude-code/opencode/antigravity). A report route
 *        needs some delivery mechanism to resolve even though this call only
 *        admits the INPUT side — but it must be the consumer's real one, not
 *        an assumed one, or the exact-tuple capability policy legitimately
 *        refuses an unproven fact (P20.8R4). Defaults to the prior literal
 *        `'VERBATIM_MATERIALIZATION'` for every caller that predates this
 *        parameter — byte-for-byte unchanged behavior for them.
 * @param {Array<{ label: string, reference: object }>} input.references  ORDERED
 * @param {{ maxTotalInputBytes?: number }} [input.limits]
 * @returns {{ transport: string, totalBytes: number, entries: Array<object>, sizePolicyVersion: string }}
 */
export function prepareArtifactInputs({ store, consumerBackend, capabilityPolicy, requestedInputTransport, requestedDelivery = 'VERBATIM_MATERIALIZATION', references, limits = {} }) {
  if (!store || typeof store.openTaskById !== 'function') {
    throw new ArtifactInputTransportError('an ArtifactStore is required', 'ARTIFACT_INPUT_NO_STORE');
  }
  if (requestedInputTransport !== INPUT_TRANSPORT.NATIVE_ASSIGNED_READ && requestedInputTransport !== INPUT_TRANSPORT.VERBATIM_CONTENT) {
    throw new ArtifactInputTransportError(`requestedInputTransport must be NATIVE_ASSIGNED_READ or VERBATIM_CONTENT, got ${JSON.stringify(requestedInputTransport)}`, 'ARTIFACT_INPUT_TRANSPORT_INVALID');
  }
  const refs = Array.isArray(references) ? references : [];
  // §24: verify the consumer's artifact-input route BEFORE any expensive work.
  // P20.8R4: `requestedDelivery` must be the consumer's ACTUAL production
  // delivery mechanism (never hard-coded, never inferred from backend/model/
  // profile name — the caller already resolved it) so this checks the SAME
  // exact-tuple capability fact the consumer's own report call will use.
  const route = resolveReportRoute({
    policy: capabilityPolicy,
    product: consumerBackend,
    requestedDelivery,
    requestedInputTransport,
  });
  if (!route.ok) {
    throw new ArtifactInputTransportError(
      `consumer ${JSON.stringify(consumerBackend)} cannot use artifact input transport ${JSON.stringify(requestedInputTransport)}: ${route.reason}`,
      route.code === 'ARTIFACT_REPORT_INPUT_UNSUPPORTED' ? 'ARTIFACT_INPUT_ROUTE_UNSUPPORTED' : (route.code ?? 'ARTIFACT_INPUT_ROUTE_UNSUPPORTED'),
      { consumerBackend, requestedInputTransport, reason: route.reason },
    );
  }

  const maxTotal = clampLimit(limits.maxTotalInputBytes);
  const entries = [];
  let totalBytes = 0;

  for (const item of refs) {
    const label = typeof item?.label === 'string' && item.label ? item.label : 'sealed-artifact';
    let verified;
    try {
      verified = resolveAndVerifySealedReference({ store, reference: item?.reference });
    } catch (error) {
      throw new ArtifactInputTransportError(
        `sealed input ${JSON.stringify(label)} failed full authority verification: ${error.message}`,
        'ARTIFACT_INPUT_REF_VERIFY_FAILED',
        { label, cause: error.code ?? null },
      );
    }
    totalBytes += verified.bytes;
    if (totalBytes > maxTotal) {
      throw new ArtifactInputTransportError(
        `aggregate sealed-artifact input (${totalBytes} bytes) exceeds the ${ARTIFACT_INPUT_SIZE_POLICY.version} limit of ${maxTotal} bytes — no summary/truncation fallback`,
        'ARTIFACT_INPUT_OVERSIZE',
        { totalBytes, maxTotal, sizePolicyVersion: ARTIFACT_INPUT_SIZE_POLICY.version },
      );
    }
    if (requestedInputTransport === INPUT_TRANSPORT.NATIVE_ASSIGNED_READ) {
      entries.push(Object.freeze({
        transport: INPUT_TRANSPORT.NATIVE_ASSIGNED_READ,
        label,
        path: verified.path,
        artifact_relpath: item.reference.artifact_relpath,
        sha256: verified.sha256,
        bytes: verified.bytes,
        // NEVER the body — §21 forbids pasting the report as a fallback.
      }));
    } else {
      const text = strictUtf8(verified.buffer, label);
      entries.push(Object.freeze({
        transport: INPUT_TRANSPORT.VERBATIM_CONTENT,
        label,
        text, // the COMPLETE verified report content, byte-faithful
        sha256: verified.sha256,
        bytes: verified.bytes,
      }));
    }
  }

  return Object.freeze({
    transport: requestedInputTransport,
    totalBytes,
    entries: Object.freeze(entries),
    sizePolicyVersion: ARTIFACT_INPUT_SIZE_POLICY.version,
  });
}

/**
 * Render the prepared inputs into the `{ trustedRefBlock, evidence }` a
 * report prompt needs.
 *   - VERBATIM_CONTENT  -> `evidence: [{ label, content }]` (untrusted, exact)
 *   - NATIVE_ASSIGNED_READ -> a trusted descriptor block naming the verified
 *     path + sha256 + bytes for each artifact; `evidence` stays empty (no
 *     accidental body paste).
 *
 * Order is preserved exactly as prepared.
 */
export function renderPreparedInputs(prepared) {
  if (!prepared || !Array.isArray(prepared.entries)) {
    return { trustedRefBlock: null, evidence: [] };
  }
  if (prepared.transport === INPUT_TRANSPORT.VERBATIM_CONTENT) {
    return {
      trustedRefBlock: null,
      evidence: prepared.entries.map((e) => ({ label: e.label, content: e.text })),
    };
  }
  const lines = ['ASSIGNED SEALED ARTIFACTS (read-only, verified — read the COMPLETE file, do not expect its body inline):'];
  for (const e of prepared.entries) {
    lines.push(`- ${e.label}: path=${e.path} sha256=${e.sha256} bytes=${e.bytes}`);
  }
  return { trustedRefBlock: lines.join('\n'), evidence: [] };
}
