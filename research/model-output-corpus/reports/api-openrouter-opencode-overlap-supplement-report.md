# API/OpenRouter × OpenCode — EXACT OVERLAP SUPPLEMENT REPORT (closure PHASE 8)

- Generated: 2026-09-08T08:27:55.738Z
- Exact-overlap rule: same provider/vendor identity AND same model family AND same explicit model/version.
- Vendor-identity gate: the OpenCode catalogue record must carry explicit upstream vendor identity evidence naming the same vendor as the OpenRouter slug's vendor family.
- Decisions: `{"OVERLAP_SKIPPED_NOT_ELIGIBLE_OPENCODE":23,"OVERLAP_IDENTITY_UNRESOLVED":25,"NO_NAME_IDENTITY_MATCH_ON_OPENROUTER":2}`
- EXACT_OVERLAP_MODELS: 0
- OVERLAP_CONFIGURATIONS PLANNED: 0
- OVERLAP_INVOCATIONS PERFORMED: 0

## Decision

NO pair was invoked. Every name-level candidate fails the vendor-identity
evidence gate: the first-party `opencode-go` catalogue (`opencode models
--verbose`, models.dev cache) exposes NO upstream vendor identity field, and
OpenRouter exposes no `opencode` vendor slug. Pairing on the model/version
name string alone would violate the exact-overlap rule ("do not pair models
solely because marketing names look similar"), so every such pair is recorded
as OVERLAP_IDENTITY_UNRESOLVED rather than invoked.

## Candidate decisions (eligible OpenCode models with any OpenRouter relevance)

| opencode slug | OpenRouter name-identity matches | decision | reason |
| --- | --- | --- | --- |
| opencode-go/deepseek-v4-flash | deepseek/deepseek-v4-flash | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/deepseek-v4-flash-vision-exp | deepseek/deepseek-v4-flash-vision-exp | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/deepseek-v4-pro | deepseek/deepseek-v4-pro | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/glm-5.1 | z-ai/glm-5.1 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/glm-5.2 | z-ai/glm-5.2 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/glm-5.3 | z-ai/glm-5.3 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/glm-5.3-flash | z-ai/glm-5.3-flash | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/gpt-5.6-luna | openai/gpt-5.6-luna | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/grok-4.6 | x-ai/grok-4.6 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/hy3 | tencent/hy3 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/hy4-preview | tencent/hy4-preview | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/kimi-k2.6 | moonshotai/kimi-k2.6 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/kimi-k2.7-code | moonshotai/kimi-k2.7-code | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/kimi-k3 | moonshotai/kimi-k3 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/longcat-2.0 | meituan/longcat-2.0 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/mimo-v2.5 | xiaomi/mimo-v2.5 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/mimo-v2.5-pro | xiaomi/mimo-v2.5-pro | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/minimax-m2.7 | minimax/minimax-m2.7 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/minimax-m3 | minimax/minimax-m3 | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/muse-spark-1.2-contributor | meta/muse-spark-1.2-contributor | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/muse-spark-1.3-contributor | meta/muse-spark-1.3-contributor | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/omen-alpha | none | NO_NAME_IDENTITY_MATCH_ON_OPENROUTER | no OpenRouter catalogue slug with the same explicit model/version string |
| opencode-go/qwen3.6-plus | qwen/qwen3.6-plus | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/qwen3.7-max | qwen/qwen3.7-max | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/qwen3.7-plus | qwen/qwen3.7-plus | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/qwen3.8-flash | qwen/qwen3.8-flash | OVERLAP_IDENTITY_UNRESOLVED | opencode catalogue record carries NO upstream vendor identity evidence; name identity alone is not exact equivalence (same provider/vendor identity leg unevidenced) |
| opencode-go/qwen3.8-max | none | NO_NAME_IDENTITY_MATCH_ON_OPENROUTER | no OpenRouter catalogue slug with the same explicit model/version string |

## Policy attestations

- OVERLAP_IDENTITY_UNRESOLVED_PAIRS_INVOKED: 0
- PROVIDERS_INVOKED_FOR_OVERLAP: 0
- RAW_EVIDENCE_MODIFIED: NO
- CROSS_CONNECTOR_OUTPUT_COMPARISON_PERFORMED: NO (explicitly deferred to the matrix-analysis phase)
