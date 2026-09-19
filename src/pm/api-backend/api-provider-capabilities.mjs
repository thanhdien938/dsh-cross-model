// P11-R0 — centralized provider capability model. Mirrors the pattern
// already established by pm-reasoning-capability.mjs's REASONING_CAPABILITY
// and production-pm-backend-registry.mjs's *_CLI_CAPABILITIES constants:
// ONE static table, never inferred from a provider id string at arbitrary
// call sites (spec: "Do not infer from provider name at arbitrary call
// sites. Centralize provider capability data."). A provider id not present
// here (any future operator-configured provider) gets the conservative
// DEFAULT — nothing is ever assumed supported just because a provider
// speaks the generic `openai-chat` protocol.
export const API_PROVIDER_CAPABILITIES = Object.freeze({
  openrouter: Object.freeze({
    supports_streaming: true,
    supports_reasoning_effort: false,
    supports_json_schema: false,
    supports_tools: true,
    supports_responses_api: false,
  }),
  deepseek: Object.freeze({
    supports_streaming: true,
    // DeepSeek documents provider-specific `thinking`/`reasoning_effort`
    // request extensions (task rule "DEEPSEEK REASONING MAPPING") — the
    // actual DSH-reasoning -> provider-field translation lives in
    // api-reasoning-translation.mjs, gated on this flag so it is never sent
    // to a provider that doesn't advertise support for it.
    supports_reasoning_effort: true,
    supports_json_schema: false,
    supports_tools: true,
    supports_responses_api: false,
  }),
  'xcode-best': Object.freeze({
    // Third-party relay, treated as a plain OpenAI-compatible passthrough —
    // no provider-specific extensions assumed until live-proven.
    supports_streaming: true,
    supports_reasoning_effort: false,
    supports_json_schema: false,
    supports_tools: false,
    supports_responses_api: false,
  }),
});

const DEFAULT_CAPABILITIES = Object.freeze({
  supports_streaming: false,
  supports_reasoning_effort: false,
  supports_json_schema: false,
  supports_tools: false,
  supports_responses_api: false,
});

export function capabilitiesForProvider(providerId) {
  return API_PROVIDER_CAPABILITIES[providerId] ?? DEFAULT_CAPABILITIES;
}
