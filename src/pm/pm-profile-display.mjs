// P9-R0.4 Part A: ONE canonical display-format helper for PM profiles —
// every owner-facing surface (Desktop's Single/Chair/Participants
// selectors, PM Configuration, PM Profile Management, Telegram
// `/profiles`/`/aliases`) renders a profile through this module rather than
// inventing its own string. The canonical profile id (`profile.id`) remains
// the durable identity everywhere; this module only ever produces a
// SECONDARY, human-readable label — "backend/product · model · reasoning" —
// never a replacement for the id.
//
// Deliberately pure and dependency-free (no Node builtins) so the exact
// same algorithm can run from Telegram/runtime code (imported directly,
// this file) and from the Electron main process (imported the same way —
// see main.ts's importEsmModule usage elsewhere in this codebase) without
// ever being reimplemented in the untrusted renderer bundle: the renderer
// only ever displays a `displayLabel` string it was handed over IPC.

// Part A: known backend/product -> owner-facing display name. An unknown
// product (should never happen — PmProfileRegistry already bounds `product`
// to a non-empty string) falls back to the raw value verbatim rather than
// throwing — a display helper must never be the reason a profile fails to
// render.
const PRODUCT_DISPLAY_NAMES = Object.freeze({
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
});

export function pmProductDisplayName(product) {
  if (typeof product !== 'string' || !product) return 'Unknown';
  return PRODUCT_DISPLAY_NAMES[product] ?? product;
}

// Part A: "default/inherited" is the one, consistent fallback string for an
// unset model/reasoning — matches the wording ConnectionCenter/Telegram
// already used pre-R0.4 (Part A: "Codex · default/inherited · medium").
const UNSET = 'default/inherited';

export function pmProfileModelLabel(profile) {
  return profile?.model ? String(profile.model) : UNSET;
}

export function pmProfileReasoningLabel(profile) {
  // Part A: Antigravity's reasoning is model-encoded (P9-R0.3) — the
  // stored `reasoning` value is shown as-is for audit/UI continuity; no
  // additional semantics are invented for it here.
  return profile?.reasoning ? String(profile.reasoning) : UNSET;
}

// Part A/C: the ONE primary label — "Claude Code · sonnet · high" — used
// everywhere a profile needs to be self-describing without a hover/tooltip
// (Composer's Single/Chair select, Participants checklist, PM Profile
// Management, PM Configuration).
export function formatPmProfileLabel(profile) {
  return `${pmProductDisplayName(profile?.product)} · ${pmProfileModelLabel(profile)} · ${pmProfileReasoningLabel(profile)}`;
}

// Part B: a denser, single-line variant for space-constrained surfaces
// (Telegram `/aliases`, shorthand acks) — same three facts, `|`-joined,
// omitting reasoning entirely when unset rather than printing
// "default/inherited" a second time in a compact context.
export function formatPmProfileCompact(profile) {
  const parts = [pmProductDisplayName(profile?.product), pmProfileModelLabel(profile)];
  if (profile?.reasoning) parts.push(String(profile.reasoning));
  return parts.join(' | ');
}

// Part L: canonical id is always secondary metadata — this helper hands
// back BOTH strings so a call site can lay them out however it needs
// (primary text + subtext, primary + tooltip, one line with the id
// appended, ...) without re-deriving the label itself.
export function describePmProfile(profile) {
  return Object.freeze({
    id: profile?.id ?? null,
    label: formatPmProfileLabel(profile),
    compact: formatPmProfileCompact(profile),
    status: profile?.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
  });
}
