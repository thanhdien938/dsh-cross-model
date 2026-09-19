/**
 * Council/Debate WORKSPACE_READ remediation — the evidence CONTRACT a
 * participant's `participant_report`/`debate_response` step must satisfy
 * when the council's `workspace_requirement` is `READ` (docs/evidence/
 * DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §15: "A repository-
 * audit participant report must carry structured evidence... A plain text
 * finish with zero repository evidence must NOT satisfy a workspace-read-
 * required audit participant step").
 *
 * `validateEvidence()` is called from council-step-workflow-runner.mjs's
 * validateStepData() ONLY when `spec.workspaceRequirement === 'READ'` — for
 * every pre-existing (NONE) council/debate this module is never imported by
 * an executed code path's decision logic, so behavior there is byte-for-
 * byte unchanged (Part 1/2 regression requirement).
 *
 * Deterministic, fail-closed, bounded: a malformed or empty evidence array
 * is REJECTED, never silently accepted or repaired (mirrors this codebase's
 * existing parseDecision()/validateStepData() discipline — no heuristic
 * salvage, ever).
 */

import { readFileBounded, redactWorkspaceEvidenceContent, WorkspaceSafeReadError } from './workspace-safe-reader.mjs';

export const MAX_EVIDENCE_ENTRIES = 20;
export const MAX_EVIDENCE_PATH_CHARS = 400;
export const MAX_EVIDENCE_CLAIM_CHARS = 2000;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

// DSH-COUNCIL-EVIDENCE-DROP-DIAGNOSTICS (live evidence task-66YXX7_3b202TqwQap1PcVpk3-D27GHd,
// live1-antigravity-gemini-3-8-flash-high 2026-09-07): the participant emitted a
// structurally complete council_report whose `evidence` array carried 8 object
// entries — and ZERO survived validation (`NO_VALID_EVIDENCE_ENTRIES`) with no
// durable record of WHY each entry was dropped, because every drop branch below
// `continue`s silently. This module now additionally returns a bounded,
// CONTENT-FREE per-entry drop histogram alongside the unchanged fail-closed
// verdict. Diagnostics record ONLY: total counts and drop-reason identifiers —
// never a path name, hash value, claim text, or any other entry content
// (mirrors council-step-workflow-runner.mjs's dataShapeSummary() discipline,
// so the same privacy contract holds: keys/types/counts only).
// Histogram keys reuse the EXISTING typed identifiers wherever one exists
// (the shapeError codes, the internal hashVerified labels) and add exactly
// two new identifiers for branches that previously had none: the Gap-B
// outside-manifest drop and the live-disk hash-check failure. The terminal
// validator `reason` codes (MISSING_EVIDENCE / TOO_MANY_EVIDENCE_ENTRIES /
// NO_VALID_EVIDENCE_ENTRIES) are byte-for-byte UNCHANGED — this is strictly
// additive evidence, never a widening of what is accepted.
const MAX_DROP_REASON_KEYS = 24;
function shapeBaseCode(reason) {
  // shapeError() appends `:<index>`; the histogram keys on the stable base code.
  const index = reason.lastIndexOf(':');
  return index > 0 ? reason.slice(0, index) : reason;
}
function evidenceDiagnostics() {
  return { entries_seen: 0, entries_valid: 0, entries_dropped: 0, drop_reasons: {}, drop_reasons_truncated: false };
}
function countDrop(diagnostics, code) {
  const dropReasons = diagnostics.drop_reasons;
  if (!Object.hasOwn(dropReasons, code)) {
    if (Object.keys(dropReasons).length >= MAX_DROP_REASON_KEYS) {
      diagnostics.drop_reasons_truncated = true;
      return;
    }
    dropReasons[code] = 0;
  }
  dropReasons[code] += 1;
}

// Final owner-review micro-patch, Blocker C ("do not duplicate divergent
// secret regex families unnecessarily"): delegates to workspace-safe-
// reader.mjs's redactWorkspaceEvidenceContent() — the ONE canonical
// secret-CONTENT redaction authority this module now shares with the
// evidence-packet builder, rather than a second, separately-maintained
// pattern. Name kept for backward compatibility (Part 19 test #30: "no
// secrets appear in persisted evidence metadata/logs").
export function redactEvidenceSecrets(text) { return redactWorkspaceEvidenceContent(text); }

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Validate one raw evidence entry's SHAPE only (no filesystem access) —
 * returns a typed reason string or null.
 */
function shapeError(entry, index) {
  if (!isPlainObject(entry)) return `EVIDENCE_ENTRY_NOT_OBJECT:${index}`;
  if (typeof entry.path !== 'string' || !entry.path.trim()) return `EVIDENCE_ENTRY_MISSING_PATH:${index}`;
  if (entry.path.length > MAX_EVIDENCE_PATH_CHARS) return `EVIDENCE_ENTRY_PATH_TOO_LONG:${index}`;
  if (entry.path.includes('..') || entry.path.startsWith('/') || /^[A-Za-z]:/.test(entry.path)) return `EVIDENCE_ENTRY_PATH_UNSAFE:${index}`;
  if (typeof entry.sha256 !== 'string' || !SHA256_HEX_RE.test(entry.sha256)) return `EVIDENCE_ENTRY_INVALID_SHA256:${index}`;
  if (entry.line_start !== undefined && entry.line_start !== null && !Number.isInteger(entry.line_start)) return `EVIDENCE_ENTRY_INVALID_LINE_START:${index}`;
  if (entry.line_end !== undefined && entry.line_end !== null && !Number.isInteger(entry.line_end)) return `EVIDENCE_ENTRY_INVALID_LINE_END:${index}`;
  if (typeof entry.claim !== 'string' || !entry.claim.trim()) return `EVIDENCE_ENTRY_MISSING_CLAIM:${index}`;
  if (entry.claim.length > MAX_EVIDENCE_CLAIM_CHARS) return `EVIDENCE_ENTRY_CLAIM_TOO_LONG:${index}`;
  return null;
}

/**
 * @param {unknown} evidence - the raw `data.evidence` value from a
 *   participant's finish decision.
 * @param {{ repoPath: string|null, allowedPaths: Set<string>|null, authoritativeHashes: (Map<string,string>|Record<string,string>|null) }} opts -
 *   `repoPath` enables real hash verification against the actual file on
 *   disk (test matrix #21) as a FALLBACK only; when null (repo
 *   unavailable), entries are accepted on shape alone. `allowedPaths` —
 *   owner-review remediation Gap B (§12): when the council supplied an
 *   explicit `workspace_evidence_paths` manifest, an evidence entry citing
 *   a path OUTSIDE that manifest is rejected even if it is otherwise a
 *   real, hash-verified, in-root file — "participant evidence must
 *   reference only allowed/supplied paths". `null` (no manifest — every
 *   pre-Gap-B council) preserves the original behavior byte-for-byte: any
 *   real, in-root, non-denied, hash-verified path is accepted.
 *
 *   `authoritativeHashes` — final stabilization patch (§17/§18 of the
 *   brief: "evidence validation must match what model saw" /
 *   "source change during run"). When present (the council/debate's
 *   evidence-packet run — council-chair-driver.mjs threads this from the
 *   SAME cached packet every stage's prompt embedded), a cited hash is
 *   compared against THIS frozen snapshot, taken once at packet-build
 *   time — never a fresh `readFileBounded()` re-read of the CURRENT
 *   filesystem. This closes a real gap: without it, a participant's
 *   honest, correct citation of exactly what the packet showed it could be
 *   wrongly rejected (or, in principle, wrongly accepted against
 *   coincidentally-matching drifted content) if the underlying file
 *   changed between packet-build and evidence-validation time. A path
 *   absent from the snapshot means "not in the packet the model saw" and
 *   is rejected (`PATH_NOT_IN_PACKET`), regardless of the live
 *   filesystem. When `authoritativeHashes` is omitted (every pre-
 *   stabilization caller/test, and any direct/test caller that only
 *   passes `repoPath`), the original live-disk-read behavior is preserved
 *   byte-for-byte — this is purely additive.
 * @returns {{ ok: boolean, reason: string|null, entries: object[], diagnostics: object }}
 *   `entries` are the VALIDATED (hash-checked where possible), redacted
 *   entries — never the raw untrusted input — safe to persist.
 *   `diagnostics` is the bounded, content-free drop histogram described
 *   above (counts and reason identifiers only) — present on BOTH success
 *   and failure; only failure surfaces ever persist it.
 */
export function validateEvidence(evidence, { repoPath = null, allowedPaths = null, authoritativeHashes = null } = {}) {
  const diagnostics = evidenceDiagnostics();
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, reason: 'MISSING_EVIDENCE', entries: [], diagnostics };
  }
  diagnostics.entries_seen = evidence.length;
  if (evidence.length > MAX_EVIDENCE_ENTRIES) {
    // Early abort: none of the over-budget entries were individually
    // evaluated — reported as not accepted (entries_dropped) with no
    // per-entry histogram beyond the terminal reason itself.
    diagnostics.entries_dropped = evidence.length;
    return { ok: false, reason: `TOO_MANY_EVIDENCE_ENTRIES:${evidence.length}`, entries: [], diagnostics };
  }
  const lookupAuthoritativeHash = (path) => {
    if (!authoritativeHashes) return undefined;
    if (typeof authoritativeHashes.get === 'function') return authoritativeHashes.get(path);
    return authoritativeHashes[path];
  };
  const validated = [];
  for (let i = 0; i < evidence.length; i += 1) {
    const entry = evidence[i];
    const err = shapeError(entry, i);
    if (err) { countDrop(diagnostics, shapeBaseCode(err)); continue; } // a malformed individual entry is dropped, not fatal — see the "no valid entries survive" check below
    if (allowedPaths && !allowedPaths.has(entry.path)) { countDrop(diagnostics, 'EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST'); continue; } // Gap B: outside the owner-authored manifest
    let hashVerified = 'NOT_CHECKED';
    if (authoritativeHashes) {
      // §17/§18: bind to what the model actually saw, never a live re-read.
      const expected = lookupAuthoritativeHash(entry.path);
      if (expected === undefined) { hashVerified = 'PATH_NOT_IN_PACKET'; countDrop(diagnostics, 'PATH_NOT_IN_PACKET'); continue; }
      hashVerified = String(expected).toLowerCase() === entry.sha256.toLowerCase() ? 'MATCH' : 'MISMATCH';
      if (hashVerified === 'MISMATCH') { countDrop(diagnostics, 'EVIDENCE_HASH_MISMATCH'); continue; }
    } else if (repoPath) {
      try {
        const real = readFileBounded(repoPath, entry.path);
        if (!real.exists) { hashVerified = 'PATH_NOT_FOUND'; countDrop(diagnostics, 'EVIDENCE_PATH_NOT_FOUND'); continue; }
        hashVerified = real.sha256.toLowerCase() === entry.sha256.toLowerCase() ? 'MATCH' : 'MISMATCH';
        if (hashVerified === 'MISMATCH') { countDrop(diagnostics, 'EVIDENCE_HASH_MISMATCH'); continue; }
      } catch (error) {
        // WorkspaceSafeReadError (escape/deny-listed) is a hard reject for
        // this entry, never a soft pass-through.
        if (error instanceof WorkspaceSafeReadError) { hashVerified = `REFUSED:${error.code}`; countDrop(diagnostics, `EVIDENCE_READ_REFUSED:${error.code}`); continue; }
        hashVerified = 'CHECK_ERROR';
        countDrop(diagnostics, 'EVIDENCE_HASH_CHECK_ERROR');
        continue;
      }
    }
    diagnostics.entries_valid += 1;
    validated.push({
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      line_start: entry.line_start ?? null,
      line_end: entry.line_end ?? null,
      claim: redactEvidenceSecrets(entry.claim).slice(0, MAX_EVIDENCE_CLAIM_CHARS),
      hash_verified: hashVerified,
    });
  }
  diagnostics.entries_dropped = diagnostics.entries_seen - diagnostics.entries_valid;
  if (validated.length === 0) return { ok: false, reason: 'NO_VALID_EVIDENCE_ENTRIES', entries: [], diagnostics };
  return { ok: true, reason: null, entries: validated, diagnostics };
}
