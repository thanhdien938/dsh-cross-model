/**
 * Council/Debate WORKSPACE_READ capability model — remediation of
 * docs/evidence/DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md
 * (§§6, 8, 9, 16, 17), PATCHED by the owner-review remediation recorded in
 * docs/evidence/DSH_COUNCIL_WORKSPACE_READ_IMPLEMENTATION_20260906.md's
 * "Owner Review Remediation" section (Gap A — native secret isolation).
 *
 * This module is the ONE authoritative resolver every caller (Council
 * admission, Council/Debate prompt building, tests) must use —
 * `resolveProfileCapabilities(profile)`. It is a pure function of
 * `profile.product` only: never inferred from a profile id/display-name
 * substring (a profile named `live1-codex-...` gets its capability from
 * `profile.product === 'codex'`, never from the string "codex" appearing in
 * its id — Part: "no profile is granted WORKSPACE_READ solely because its
 * name contains codex/claude/gemini").
 *
 * ---------------------------------------------------------------------
 * GAP A — why NATIVE_WORKSPACE_READ_PRODUCTS is now EMPTY
 * ---------------------------------------------------------------------
 * The original implementation classified `codex` and `claude-code` as
 * WORKSPACE_READ_NATIVE because their bridges genuinely invoke a real,
 * vendor read-only mode (`--sandbox read-only` / `--permission-mode plan`)
 * with the correct project `cwd`. Owner review correctly identified that
 * "read-only" is a WRITE boundary, not a SECRET boundary: neither vendor
 * sandbox denylists `.env`, `.ssh/`, `.runtime/`, credential/token/session
 * files, or any of DSH's own denylisted paths (workspace-safe-reader.mjs).
 * A native participant pointed at the real `project.repo_path` could
 * therefore genuinely read a secret file and quote it back — a real gap,
 * not a theoretical one.
 *
 * The considered fix was a DSH-owned "sanitized read-only workspace view"
 * (a bounded, deny-list-filtered mirror of the repo, with the native CLI's
 * `cwd` pointed at it instead of the real repo). That mechanism was
 * evaluated and REJECTED for this patch: proving it fully safe for an
 * ARBITRARY, unbounded real repository (symlink/junction/hardlink/
 * reparse-point escape during the copy itself, `.git` credential-helper
 * leakage, unbounded copy time/disk for a large repo) is a materially
 * larger and riskier undertaking than this focused patch's scope, and the
 * task's own instructions explicitly permit — and given the stated
 * priority "security wins over capability convenience", effectively
 * direct — failing closed to the evidence-packet route instead of shipping
 * an unproven sanitized-copy mechanism ("Do NOT fake it... No backend may
 * remain classified NATIVE_WORKSPACE_READ merely because its native CLI
 * has a read-only sandbox.").
 *
 * Both `codex` and `claude-code` are therefore now classified `TEXT_ONLY`
 * for the WORKSPACE_READ purposes this module governs: EVERY participant,
 * regardless of backend, now reads the repository ONLY through DSH's own
 * bounded, hash-verified, deny-list-enforced evidence packet
 * (workspace-evidence-packet.mjs) — there is no remaining code path in
 * this feature that hands a native CLI a `cwd` inside the real,
 * unsanitized project repository for a `workspace_requirement:'READ'`
 * step. This is a strictly MORE secure posture than the original
 * implementation, not a capability regression in anything this feature
 * ever shipped live (no owner-live WORKSPACE_READ canary had run before
 * this patch).
 *
 * `WORKSPACE_READ_NATIVE` remains a defined enum value — the resolver
 * mechanism is ready for a FUTURE backend that proves a genuinely
 * project-confined, secret-denylist-respecting native mode (or a later,
 * separately-scoped sanitized-view implementation) without requiring a
 * second resolver. `NATIVE_WORKSPACE_READ_PRODUCTS` is that one allowlist;
 * today it is intentionally empty.
 *
 * `WORKSPACE_MUTATE` is declared as a reserved capability value only — this
 * implementation grants it to no profile and no code path reads it as an
 * execution authority. The pre-existing, unrelated `executionCapable` /
 * `isImplementationParticipant` mechanism (P18-W4R6) is NOT this capability
 * and is left completely untouched — a WORKSPACE_READ participant is
 * never, by itself, execution-capable.
 */

export const WORKSPACE_CAPABILITY = Object.freeze({
  // No trusted native filesystem route for THIS feature; receives a
  // DSH-built, bounded, hash-verified evidence packet appended to its
  // prompt text (workspace-evidence-packet.mjs). Every currently
  // registered backend product resolves here — see Gap A above.
  TEXT_ONLY: 'TEXT_ONLY',
  // Reserved for a future backend/mechanism that proves a genuinely
  // project-confined, secret-denylist-respecting native read route.
  // `NATIVE_WORKSPACE_READ_PRODUCTS` (below) is empty today — no profile
  // currently resolves to this value.
  WORKSPACE_READ_NATIVE: 'WORKSPACE_READ_NATIVE',
  // Reserved. Never returned by resolveProfileCapabilities() in this
  // implementation.
  WORKSPACE_MUTATE: 'WORKSPACE_MUTATE',
});

// GAP A remediation: intentionally EMPTY. See the file-header rationale —
// neither Codex's `--sandbox read-only` nor Claude Code's
// `--permission-mode plan` denylists secret-shaped paths, so neither is
// trusted with direct access to the real project.repo_path for a
// workspace-read-required step. Kept as a real Set (not deleted/inlined)
// so re-admitting a future proven-safe backend is a one-line, fully
// evidenced change here, never a scattered set of ad-hoc checks elsewhere.
const NATIVE_WORKSPACE_READ_PRODUCTS = Object.freeze(new Set([]));

/**
 * @param {{ id?: string, product?: string }} profile - a registered PM
 *   profile (production-pm-backend-registry.mjs's SUPPORTED shape). Never
 *   consulted for anything other than `.product`.
 * @returns {{ profileId: string|null, product: string|null, workspaceCapability: string, native: boolean }}
 *   Frozen, deterministic, pure-function-of-product-only result.
 */
export function resolveProfileCapabilities(profile) {
  const product = typeof profile?.product === 'string' ? profile.product : null;
  const native = product !== null && NATIVE_WORKSPACE_READ_PRODUCTS.has(product);
  return Object.freeze({
    profileId: typeof profile?.id === 'string' ? profile.id : null,
    product,
    workspaceCapability: native ? WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE : WORKSPACE_CAPABILITY.TEXT_ONLY,
    native,
  });
}

/** Convenience boolean — never a second source of truth, delegates to resolveProfileCapabilities(). */
export function isNativeWorkspaceReader(profile) {
  return resolveProfileCapabilities(profile).native;
}

export { NATIVE_WORKSPACE_READ_PRODUCTS };
