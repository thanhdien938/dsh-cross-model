// P11-R0 — DSH reasoning -> provider request-field translation.
//
// DSH's PM reasoning value (`profile.reasoning`, free-form string —
// pm-reasoning-capability.mjs's REASONING_CAPABILITY documents the tokens
// each backend/CLI has actually proven) must never be blindly forwarded as
// a provider-specific request field. This module is the ONE seam that maps
// a DSH reasoning token to a provider's own request shape — gated on that
// provider's `supports_reasoning_effort` capability
// (api-provider-capabilities.mjs) — so a provider that hasn't proven
// support for reasoning-effort extensions never receives one, and every
// other provider never needs its own translation logic anywhere else.
//
// DeepSeek's documented request extension (task rule "DEEPSEEK REASONING
// MAPPING") is `reasoning_effort` alongside a `thinking` toggle. R0 forwards
// `reasoning_effort` only for a KNOWN, bounded DSH token; an unrecognized
// value is dropped (never forwarded raw) rather than guessed at — this is a
// provider TRANSLATION layer, not global workflow semantics (spec: "Do not
// globally assume every provider accepts reasoning_effort. Do not send
// unsupported fields blindly.").
const DEEPSEEK_FLASH_REASONING = Object.freeze({ low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' });
const DEEPSEEK_PRO_REASONING = Object.freeze({ low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max' });

// Returns a plain object of extra chat-completion request fields to merge
// in, or `{}` when the provider doesn't support reasoning-effort, the
// profile has no reasoning value, or the value isn't one of the provider's
// known tokens. Never throws — an unrecognized reasoning value is a
// silent, safe no-op, not a request failure.
export function translateReasoningForProvider(providerId, capabilities, reasoning, model = '') {
  if (!capabilities?.supports_reasoning_effort || typeof reasoning !== 'string' || !reasoning) return {};
  if (providerId === 'openrouter') {
    const value = reasoning.toLowerCase();
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) return {};
    return { reasoning: { effort: value } };
  }
  if (providerId === 'deepseek') {
    const value = reasoning.toLowerCase();
    const mapping = model === 'deepseek-v4-flash'
      ? DEEPSEEK_FLASH_REASONING
      : model === 'deepseek-v4-pro'
        ? DEEPSEEK_PRO_REASONING
        : null;
    const translated = mapping?.[value];
    if (!translated) return {};
    // Current DeepSeek v4 models enable thinking by default. We forward
    // only the documented, model-specific reasoning_effort value and do
    // not invent a global `thinking` policy for other providers/models.
    return { reasoning_effort: translated };
  }
  return {};
}
