// P9-R0.4.1 Part A: ONE pure helper for SEMANTIC execution-identity
// comparison — deliberately separate from profileFingerprint()
// (pm-profile-registry.mjs), which is NEVER changed by this module (Part
// B: historical PmRun fingerprint pinning must not move).
//
// Two different canonical PM profile ids can still describe the exact
// same real execution configuration (owner-live proof: `live1-antigravity-
// gemini-high` and `live1-antigravity-gemini-3-7-flash-high` are both
// PM/STATELESS/antigravity/stdio/gemini-3.7-flash-high/high). This helper
// exists so a trusted create-time guard (PmProfileConfigService.create(),
// see desktop/electron/main/services/pmProfileConfigService.ts) can detect
// that BEFORE persisting a redundant second canonical id — never as a
// substitute for the fingerprint, only as an additional, narrower
// creation-time check.
//
// Fields compared: role_kind, session_kind, product, transport, model,
// reasoning — the exact same seven-minus-id fields profileFingerprint()
// hashes. Deliberately EXCLUDES: id (Part A: a different id does not make
// a different identity), status (Part S: ACTIVE vs INACTIVE is lifecycle,
// not identity — an active and an inactive profile with identical fields
// ARE duplicates), fingerprint (derived, not an input), alias/display
// label (presentation only).
//
// `null` is preserved exactly as `null` — a Codex profile with
// `model: null` ("inherit the CLI's own default at execution time") is a
// GENUINELY DIFFERENT identity from one pinned to that CLI's current
// default model slug, even though they might resolve to the same model on
// a given day (Part R). JSON.stringify on an explicit, ordered tuple keeps
// null/string/undefined-coerced-to-null all distinguishable and never
// collapses two different values into the same key by string
// concatenation accident (e.g. "codex" + "" vs "code" + "x").
// P11-R0 Part A: `provider` joins the tuple (meaningful only for
// `product:'api'` profiles — `null` for every existing product, so two
// non-api profiles compare exactly as before). This changes the tuple's
// JSON shape for every profile, but the function's OUTPUT is never
// persisted/pinned anywhere (only compared live, both sides through this
// same function, at profile-creation time) — see profileFingerprint()
// (pm-profile-registry.mjs) for the one place that DOES need byte-for-byte
// stability across this change, which is handled separately there.
export function executionIdentityKey(profile) {
  return JSON.stringify([
    profile?.role_kind ?? null,
    profile?.session_kind ?? null,
    profile?.product ?? null,
    profile?.provider ?? null,
    profile?.transport ?? null,
    profile?.model ?? null,
    profile?.reasoning ?? null,
  ]);
}

// Convenience: true iff two profiles share the exact same execution
// identity (id/status/fingerprint irrelevant to the comparison).
export function sameExecutionIdentity(a, b) {
  return executionIdentityKey(a) === executionIdentityKey(b);
}

// Finds the first profile in `profiles` whose execution identity matches
// `candidate`'s — used by the create-time duplicate guard. Returns
// `undefined` when there is no match.
export function findExecutionIdentityDuplicate(candidate, profiles) {
  const key = executionIdentityKey(candidate);
  return (profiles ?? []).find((p) => executionIdentityKey(p) === key);
}
