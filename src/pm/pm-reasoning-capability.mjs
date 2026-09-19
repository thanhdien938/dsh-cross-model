// P11-R5.1 Part I: Codex execution-value -> owner-facing display label,
// derived ONLY from `codex debug models`' own per-level `description` text
// (never intuition) — see codex-model-catalogue.mjs's header for the exact
// live JSON this was read from:
//   low    "Fast responses with lighter reasoning"                -> Light
//   medium "Balances speed and reasoning depth for everyday tasks" -> Medium
//   high   "Greater reasoning depth for complex problems"          -> High
//   xhigh  "Extra high reasoning depth for complex problems"       -> Extra High
//   max    "Maximum reasoning depth for the hardest problems"      -> Max
//   ultra  "Maximum reasoning with automatic task delegation"      -> Ultra
// The owner's Codex Desktop screenshot showed only 5 labels (Light/Medium/
// High/Extra High/Ultra) — one fewer than the 6 real values gpt-5.6-sol/
// -terra both live-prove. Rather than guess which of max/ultra the owner's
// screenshot's "Ultra" slot corresponds to, both are exposed as distinct,
// truthfully-labeled options (see docs/p11/08 R5.1 section).
export const CODEX_EFFORT_LABELS = Object.freeze({
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
});

// P6-W3-R4 Part F: per-product reasoning-effort capability truth, sourced
// from live `--help` research against the installed CLIs (see docs/p6/
// implementation/24_CONNECTION_CENTER_V2.md for the full transcripts) —
// never a hardcoded cross-provider parity assumption. `levels: null` means
// the CLI documents the flag but does not enumerate accepted values; the
// renderer must offer manual entry in that case, never an invented list.
export const REASONING_CAPABILITY = Object.freeze({
  'claude-code': Object.freeze({
    selection: 'SUPPORTED',
    levels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    flag: '--effort <level> (alias --reasoning-effort)',
    source: 'claude --help (2.1.235): "Effort level for the current session (low, medium, high, xhigh, max)" — fully enumerated by the installed CLI.',
  }),
  opencode: Object.freeze({
    selection: 'SUPPORTED',
    levels: Object.freeze(['minimal', 'high', 'max']),
    flag: '--variant <value>',
    source: 'opencode run --help (1.18.18): "model variant (provider-specific reasoning effort, e.g., high, max, minimal)" — the CLI gives these only as examples; actual accepted values are provider/model-specific, so DSH also allows a manual override.',
  }),
  // P11-R5.1 Part C/J: superseded the old `codex exec --help`-can't-
  // enumerate-it guess (minimal/low/medium/high, "documented-but-not-
  // independently-verified"). `codex debug models` (0.147.0, documented in
  // its own `--help` as "Render the raw model catalog as JSON") is a real
  // official CLI subcommand — local, machine-readable, non-secret, no
  // credential/UI-scraping involved — and live-proves every currently
  // owner-visible model's `supported_reasoning_levels`. Across the 6
  // owner-facing models it enumerates low/medium/high/xhigh/max/ultra;
  // "minimal" appears in NONE of them and has been removed rather than
  // carried forward on old, weaker evidence. Levels are NOT uniform per
  // model (gpt-5.5/5.4/5.4-mini top out at xhigh; only gpt-5.6-sol/-terra
  // reach ultra) — the true per-model subset lives in
  // codex-model-catalogue.mjs's modelEffortLevels, never here; `levels`
  // below is only the union, a safe default while no model is selected.
  codex: Object.freeze({
    selection: 'SUPPORTED',
    levels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    labels: CODEX_EFFORT_LABELS,
    flag: '-c model_reasoning_effort=<value>',
    source: '`codex debug models` (client_version observed 0.149.0) — the installed Codex CLI\'s own live model catalogue; each model\'s `supported_reasoning_levels[].effort` enumerates exactly the values `-c model_reasoning_effort=<value>` accepts for that model. See src/pm/codex-model-catalogue.mjs.',
  }),
  grok: Object.freeze({
    selection: 'SUPPORTED',
    levels: null,
    flag: '--reasoning-effort <value> (alias --effort)',
    source: 'grok --help (1.0.5) documents the flag but does not enumerate accepted values; DSH requires a manual value here rather than inventing a level list.',
  }),
  // P9-R0 Part O: `agy --help` enumerates exactly low/medium/high for
  // --effort, live-verified. P9-R0.2/R0.3 (docs/p9/06,07): live evidence
  // proved --effort is NOT an independent execution axis for Antigravity —
  // for every tier-suffixed model (Gemini, GPT-OSS) it must exactly match
  // the model slug's own trailing -low/-medium/-high or the CLI rejects
  // the run outright, and omitting it behaves identically to matching it;
  // for Claude it is rejected unconditionally, any value. Production
  // execution therefore never forwards `--effort` at all (see
  // production-pm-backend-registry.mjs's antigravity run closure) —
  // `reasoning` stays a real, meaningful, and (for tier-suffixed models)
  // service-guarded profile field (P9-R0.3's
  // PM_PROFILE_ANTIGRAVITY_MODEL_REASONING_CONFLICT guard), just no longer
  // a separately-sent CLI flag. `levels` remains the true set of values a
  // profile's reasoning field may hold; `selection: 'SUPPORTED'` reflects
  // that the field is still real and enforced, not that it maps to a live
  // flag.
  antigravity: Object.freeze({
    selection: 'SUPPORTED',
    levels: Object.freeze(['low', 'medium', 'high']),
    flag: 'derived from --model\'s own tier suffix; not forwarded as --effort in production execution (docs/p9/07)',
    source: 'agy --help (1.1.19) documents --effort, but live evidence (docs/p9/06) proved it duplicates/conflicts with the model slug\'s own tier rather than being independent — see docs/p9/07_NATIVE_MODEL_IDENTITY_IMPLEMENTATION.md.',
  }),
});

export function reasoningCapabilityFor(product) {
  return REASONING_CAPABILITY[product] ?? Object.freeze({ selection: 'UNKNOWN', levels: null, flag: null, source: 'no reasoning research recorded for this product' });
}
