# DSH MODEL OUTPUT CORPUS — opencode BASELINE REPORT

- Generated: 2026-09-08T04:00:23.083Z (phase 1.0)
- Repo branch/head: codex/council-participant-execution-audit @ 7b6df0490bef812894df6b2654baef16d17a2b70
- Canonical probe: sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5, 4112 bytes (verified fail-closed before every invocation batch)

CONNECTOR: opencode
CONNECTOR_VERSION: 1.18.18 (discovery command: `opencode models --verbose`)

## Inventory summary

- DISCOVERED_MODELS: 50
- PAID_OR_STANDARD: 27
- FREE_EXCLUDED: 7
- TRIAL_EXCLUDED: 0
- EPHEMERAL_EXCLUDED: 0
- UNKNOWN_NOT_INVOKED: 16 (NEEDS_OWNER_CLASSIFICATION)
- ELIGIBLE_MODELS: 27
- PLANNED_CONFIGURATIONS: 44

### Owner scope restriction

Owner instruction (2026-09-08): invoke FIRST-PARTY providers only (opencode, opencode-go). The xcode-best* config-defined third-party providers are inventoried for completeness but never invoked in this corpus run.

### Model inventory & classification

Classification evidence below comes from the authoritative `opencode models --verbose` catalogue records (models.dev cache); config-defined third-party providers carry placeholder 0/0 cost metadata and are classified UNKNOWN, never invoked.

| model | provider | status | supported variants | cost classification | first-party | owner excluded | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opencode/big-pickle | opencode | active | (none — default once) | FREE | yes | no | catalogue cost input=0 output=0 — authoritative first-party catalogue (opencode) prices this model at zero; no paid pricing listed |
| opencode/ling-3.0-flash-fin-free | opencode | active | low/medium/high | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode/mimo-v2.5-free | opencode | active | (none — default once) | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode/muse-spark-1.2-contributor-free | opencode | active | minimal/low/medium/high/xhigh | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode/muse-spark-1.3-contributor-free | opencode | active | minimal/low/medium/high/xhigh | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode/nemotron-3-ultra-free | opencode | active | (none — default once) | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode/nemotron-3.5-lightning-free | opencode | active | (none — default once) | FREE | yes | no | explicit "free" marker in catalogue metadata |
| opencode-go/deepseek-v4-flash | opencode-go | active | low/high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=0.22 output=0.66 (per M tokens, models.dev cache) |
| opencode-go/deepseek-v4-flash-vision-exp | opencode-go | active | low/high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=0.22 output=0.66 (per M tokens, models.dev cache) |
| opencode-go/deepseek-v4-pro | opencode-go | active | high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=0.66 output=1.98 (per M tokens, models.dev cache) |
| opencode-go/glm-5.1 | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=1.4 output=4.4 (per M tokens, models.dev cache) |
| opencode-go/glm-5.2 | opencode-go | active | high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=1.4 output=4.4 (per M tokens, models.dev cache) |
| opencode-go/glm-5.3 | opencode-go | active | low/high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=1.4 output=4.4 (per M tokens, models.dev cache) |
| opencode-go/glm-5.3-flash | opencode-go | active | low/high/max | PAID_OR_STANDARD | yes | no | catalogue cost input=0.075 output=0.25 (per M tokens, models.dev cache) |
| opencode-go/gpt-5.6-luna | opencode-go | active | none/low/medium/high/xhigh/max | PAID_OR_STANDARD | yes | no | catalogue cost input=0.2 output=1.2 (per M tokens, models.dev cache) |
| opencode-go/grok-4.6 | opencode-go | active | low/medium/high/xhigh | PAID_OR_STANDARD | yes | no | catalogue cost input=2 output=6 (per M tokens, models.dev cache) |
| opencode-go/hy3 | opencode-go | active | none/low/high | PAID_OR_STANDARD | yes | no | catalogue cost input=0.14 output=0.58 (per M tokens, models.dev cache) |
| opencode-go/hy4-preview | opencode-go | active | none/high | PAID_OR_STANDARD | yes | no | catalogue cost input=0.834 output=2.501 (per M tokens, models.dev cache) |
| opencode-go/kimi-k2.6 | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.95 output=4 (per M tokens, models.dev cache) |
| opencode-go/kimi-k2.7-code | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.95 output=4 (per M tokens, models.dev cache) |
| opencode-go/kimi-k3 | opencode-go | active | max | PAID_OR_STANDARD | yes | no | catalogue cost input=3 output=15 (per M tokens, models.dev cache) |
| opencode-go/longcat-2.0 | opencode-go | active | low/medium/high | PAID_OR_STANDARD | yes | no | catalogue cost input=0.3 output=1.2 (per M tokens, models.dev cache) |
| opencode-go/mimo-v2.5 | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.14 output=0.28 (per M tokens, models.dev cache) |
| opencode-go/mimo-v2.5-pro | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.435 output=0.87 (per M tokens, models.dev cache) |
| opencode-go/minimax-m2.7 | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.3 output=1.2 (per M tokens, models.dev cache) |
| opencode-go/minimax-m3 | opencode-go | active | none/thinking | PAID_OR_STANDARD | yes | no | catalogue cost input=0.3 output=1.2 (per M tokens, models.dev cache) |
| opencode-go/muse-spark-1.2-contributor | opencode-go | active | minimal/low/medium/high/xhigh | PAID_OR_STANDARD | yes | no | catalogue cost input=0.1 output=0.2 (per M tokens, models.dev cache) |
| opencode-go/muse-spark-1.3-contributor | opencode-go | active | minimal/low/medium/high/xhigh | PAID_OR_STANDARD | yes | no | catalogue cost input=0.1 output=0.2 (per M tokens, models.dev cache) |
| opencode-go/omen-alpha | opencode-go | active | low/high | PAID_OR_STANDARD | yes | no | catalogue cost input=0.2 output=0.66 (per M tokens, models.dev cache) |
| opencode-go/qwen3.6-plus | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.5 output=3 (per M tokens, models.dev cache) |
| opencode-go/qwen3.7-max | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=2.5 output=7.5 (per M tokens, models.dev cache) |
| opencode-go/qwen3.7-plus | opencode-go | active | (none — default once) | PAID_OR_STANDARD | yes | no | catalogue cost input=0.4 output=1.6 (per M tokens, models.dev cache) |
| opencode-go/qwen3.8-flash | opencode-go | active | low/medium/xhigh | PAID_OR_STANDARD | yes | no | catalogue cost input=0.15 output=0.47 (per M tokens, models.dev cache) |
| opencode-go/qwen3.8-max | opencode-go | active | low/medium/xhigh | PAID_OR_STANDARD | yes | no | catalogue cost input=2 output=6 (per M tokens, models.dev cache) |
| xcode-best/gpt-5.4 | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-5.5 | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-5.5-reasoning | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra-high | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra-low | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra-max | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra-medium | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best/gpt-6-astra-xhigh | xcode-best | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-opus-4-8 | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-opus-4-8-reasoning | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-opus-5 | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-opus-5-reasoning | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-sonnet-4-6 | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-claude/claude-sonnet-4-6-reasoning | xcode-best-claude | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-claude, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |
| xcode-best-grok/grok-4.5 | xcode-best-grok | active | (none — default once) | UNKNOWN | no | YES | catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=xcode-best-grok, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION; owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked |

### Reasoning axis (OpenCode-specific)

The reasoning axis is the catalogue `variants` map per model. Production forwards `--variant <name>` only when a variant is selected; models with an empty variants map have no reasoning control and run once as `default` (no --variant flag). Only LOWEST_SUPPORTED and HIGHEST_SUPPORTED variants were selected (OpenCode variant ladder: none < thinking < minimal < low < medium < high < xhigh < max < ultra); values were never invented.

## Baseline collection results

- ATTEMPTED_BASELINE_INVOCATIONS: 44
- COLLECTOR_CAPTURE_COMPLETED: 44
- COLLECTOR_CAPTURE_FAILED: 0
- PROVIDER_TERMINAL_SUCCESS: 39
- PROVIDER_TERMINAL_ERROR: 5
- PROVIDER_TERMINAL_UNKNOWN: 0
- CURRENT_PARSER_PASS: 32
- CURRENT_PARSER_FAIL: 7
- DIALECT_COUNTS: {"RAW_CANONICAL_JSON":30,"MALFORMED_JSON":3,"EMPTY":5,"FENCED_JSON":2,"UNKNOWN":2,"TRUNCATED":2}
- VARIANT_DIALECT_DIVERGENCE: opencode-go/hy3: {"high":"RAW_CANONICAL_JSON","none":"MALFORMED_JSON"} ; opencode-go/longcat-2.0: {"high":"FENCED_JSON","low":"UNKNOWN"} ; opencode-go/omen-alpha: {"high":"TRUNCATED","low":"MALFORMED_JSON"}
- RAW_ARTIFACTS_WITHHELD: none

### Matrix

| model | provider | reasoning_requested | reasoning_effective | exit/http | provider terminal | assistant bytes | dialect | current parser | repeat candidate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opencode-go/deepseek-v4-flash | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16119 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/deepseek-v4-flash | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 18292 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/deepseek-v4-flash-vision-exp | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 18908 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/deepseek-v4-flash-vision-exp | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 17518 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/deepseek-v4-pro | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16289 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/deepseek-v4-pro | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16223 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.1 | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 21329 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.2 | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 19453 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.2 | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 21465 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.3 | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 17795 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.3 | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 17742 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.3-flash | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 14564 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/glm-5.3-flash | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16008 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/gpt-5.6-luna | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16183 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/gpt-5.6-luna | opencode-go | none | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 13490 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/grok-4.6 | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16521 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/grok-4.6 | opencode-go | xhigh | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16468 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/hy3 | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 13896 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/hy3 | opencode-go | none | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 10785 | MALFORMED_JSON | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/hy4-preview | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 16923 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/hy4-preview | opencode-go | none | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 17241 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/kimi-k2.6 | opencode-go | default | null | exit=n/a http=n/a | PROVIDER_TERMINAL_ERROR | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| opencode-go/kimi-k2.7-code | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 13667 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/kimi-k3 | opencode-go | max | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 18274 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/longcat-2.0 | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 20093 | FENCED_JSON | PASS | YES |
| opencode-go/longcat-2.0 | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 761 | UNKNOWN | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/mimo-v2.5 | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 12438 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/mimo-v2.5-pro | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 13653 | MALFORMED_JSON | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/minimax-m2.7 | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 9119 | TRUNCATED | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/minimax-m3 | opencode-go | none | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 11612 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/minimax-m3 | opencode-go | thinking | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 18251 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/muse-spark-1.2-contributor | opencode-go | minimal | null | exit=1 http=n/a | PROVIDER_TERMINAL_ERROR | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| opencode-go/muse-spark-1.2-contributor | opencode-go | xhigh | null | exit=1 http=n/a | PROVIDER_TERMINAL_ERROR | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| opencode-go/muse-spark-1.3-contributor | opencode-go | minimal | null | exit=1 http=n/a | PROVIDER_TERMINAL_ERROR | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| opencode-go/muse-spark-1.3-contributor | opencode-go | xhigh | null | exit=1 http=n/a | PROVIDER_TERMINAL_ERROR | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| opencode-go/omen-alpha | opencode-go | high | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 15787 | TRUNCATED | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/omen-alpha | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 14958 | MALFORMED_JSON | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/qwen3.6-plus | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 17007 | FENCED_JSON | PASS | YES |
| opencode-go/qwen3.7-max | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 515 | UNKNOWN | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| opencode-go/qwen3.7-plus | opencode-go | default | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 15809 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/qwen3.8-flash | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 19490 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/qwen3.8-flash | opencode-go | xhigh | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 13131 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/qwen3.8-max | opencode-go | low | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 20412 | RAW_CANONICAL_JSON | PASS | no |
| opencode-go/qwen3.8-max | opencode-go | xhigh | null | exit=0 http=n/a | PROVIDER_TERMINAL_SUCCESS | 20645 | RAW_CANONICAL_JSON | PASS | no |

## Repeat candidates

- opencode-go/hy3/none (MALFORMED_JSON, parser PM_DECISION_PARSE_FAILED)
- opencode-go/kimi-k2.6/default (EMPTY, PROVIDER_TERMINAL_ERROR)
- opencode-go/longcat-2.0/high (FENCED_JSON)
- opencode-go/longcat-2.0/low (UNKNOWN, parser PM_DECISION_PARSE_FAILED)
- opencode-go/mimo-v2.5-pro/default (MALFORMED_JSON, parser PM_DECISION_PARSE_FAILED)
- opencode-go/minimax-m2.7/default (TRUNCATED, parser PM_DECISION_PARSE_FAILED)
- opencode-go/muse-spark-1.2-contributor/minimal (EMPTY, PROVIDER_TERMINAL_ERROR)
- opencode-go/muse-spark-1.2-contributor/xhigh (EMPTY, PROVIDER_TERMINAL_ERROR)
- opencode-go/muse-spark-1.3-contributor/minimal (EMPTY, PROVIDER_TERMINAL_ERROR)
- opencode-go/muse-spark-1.3-contributor/xhigh (EMPTY, PROVIDER_TERMINAL_ERROR)
- opencode-go/omen-alpha/high (TRUNCATED, parser PM_DECISION_PARSE_FAILED)
- opencode-go/omen-alpha/low (MALFORMED_JSON, parser PM_DECISION_PARSE_FAILED)
- opencode-go/qwen3.6-plus/default (FENCED_JSON)
- opencode-go/qwen3.7-max/default (UNKNOWN, parser PM_DECISION_PARSE_FAILED)

## Corpus evidence notes (structurally unusual outputs)

- opencode-go/hy3/none: dialect=MALFORMED_JSON (embedded object failed to parse); stream end-state: last event type=step_finish, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/kimi-k2.6/default: dialect=EMPTY (no assistant output: OPENCODE_ASSISTANT_OUTPUT_MISSING); stream end-state: last event type=unknown, events=n/a, exit=null, provider_terminal=PROVIDER_TERMINAL_ERROR
- opencode-go/longcat-2.0/high: dialect=FENCED_JSON (fence around the JSON object); stream end-state: last event type=step_finish, events=29, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/longcat-2.0/low: dialect=UNKNOWN (no recognizable JSON structure); stream end-state: last event type=step_finish, events=39, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/mimo-v2.5-pro/default: dialect=MALFORMED_JSON (embedded object failed to parse); stream end-state: last event type=step_finish, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/minimax-m2.7/default: dialect=TRUNCATED (JSON started but never balanced (output likely cut off)); stream end-state: last event type=text, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/muse-spark-1.2-contributor/minimal: dialect=EMPTY (no assistant output: OPENCODE_ASSISTANT_OUTPUT_MISSING); stream end-state: last event type=error, events=1, exit=1, provider_terminal=PROVIDER_TERMINAL_ERROR
- opencode-go/muse-spark-1.2-contributor/xhigh: dialect=EMPTY (no assistant output: OPENCODE_ASSISTANT_OUTPUT_MISSING); stream end-state: last event type=error, events=1, exit=1, provider_terminal=PROVIDER_TERMINAL_ERROR
- opencode-go/muse-spark-1.3-contributor/minimal: dialect=EMPTY (no assistant output: OPENCODE_ASSISTANT_OUTPUT_MISSING); stream end-state: last event type=error, events=1, exit=1, provider_terminal=PROVIDER_TERMINAL_ERROR
- opencode-go/muse-spark-1.3-contributor/xhigh: dialect=EMPTY (no assistant output: OPENCODE_ASSISTANT_OUTPUT_MISSING); stream end-state: last event type=error, events=1, exit=1, provider_terminal=PROVIDER_TERMINAL_ERROR
- opencode-go/omen-alpha/high: dialect=TRUNCATED (JSON started but never balanced (output likely cut off)); stream end-state: last event type=step_finish, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/omen-alpha/low: dialect=MALFORMED_JSON (embedded object failed to parse); stream end-state: last event type=step_finish, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/qwen3.6-plus/default: dialect=FENCED_JSON (fence around the JSON object); stream end-state: last event type=step_finish, events=3, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS
- opencode-go/qwen3.7-max/default: dialect=UNKNOWN (no recognizable JSON structure); stream end-state: last event type=step_finish, events=27, exit=0, provider_terminal=PROVIDER_TERMINAL_SUCCESS

## Anomalies

- TRANSPORT_ANOMALIES: opencode-go/kimi-k2.6/default: exit=null code=OPENCODE_TIMEOUT OpenCode process timeout after 600000ms ; opencode-go/muse-spark-1.2-contributor/minimal: exit=1 code=OPENCODE_RUN_FAILED OpenCode exited 1: {"type":"error","timestamp":1788838726190,"sessionID":"ses_f80e73d29ffeQuzOz9ae7Zeh39","error":{"name":"APIError","data":{"message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/wrk_01M0AE0J3MNJ9YD3F61CCXX0NB/go","statusCode":403,"isRetryable":false,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a37aec ; opencode-go/muse-spark-1.2-contributor/xhigh: exit=1 code=OPENCODE_RUN_FAILED OpenCode exited 1: {"type":"error","timestamp":1788838729153,"sessionID":"ses_f80e730e1ffe4oX8juI63q9ozE","error":{"name":"APIError","data":{"message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/wrk_01M0AE0J3MNJ9YD3F61CCXX0NB/go","statusCode":403,"isRetryable":false,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a37aec ; opencode-go/muse-spark-1.3-contributor/minimal: exit=1 code=OPENCODE_RUN_FAILED OpenCode exited 1: {"type":"error","timestamp":1788838732142,"sessionID":"ses_f80e7254dffeBnFjSuiVrnP3ju","error":{"name":"APIError","data":{"message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/wrk_01M0AE0J3MNJ9YD3F61CCXX0NB/go","statusCode":403,"isRetryable":false,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a37aec ; opencode-go/muse-spark-1.3-contributor/xhigh: exit=1 code=OPENCODE_RUN_FAILED OpenCode exited 1: {"type":"error","timestamp":1788838735173,"sessionID":"ses_f80e719faffeUzffO88J4LHbBn","error":{"name":"APIError","data":{"message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/wrk_01M0AE0J3MNJ9YD3F61CCXX0NB/go","statusCode":403,"isRetryable":false,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a37aec
- EXTRACTION_ANOMALIES: opencode-go/kimi-k2.6/default: OPENCODE_ASSISTANT_OUTPUT_MISSING ; opencode-go/muse-spark-1.2-contributor/minimal: OPENCODE_ASSISTANT_OUTPUT_MISSING ; opencode-go/muse-spark-1.2-contributor/xhigh: OPENCODE_ASSISTANT_OUTPUT_MISSING ; opencode-go/muse-spark-1.3-contributor/minimal: OPENCODE_ASSISTANT_OUTPUT_MISSING ; opencode-go/muse-spark-1.3-contributor/xhigh: OPENCODE_ASSISTANT_OUTPUT_MISSING

## REASONING_EFFECTIVE_EVIDENCE

opencode-go/deepseek-v4-flash/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/deepseek-v4-flash/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/deepseek-v4-flash-vision-exp/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/deepseek-v4-flash-vision-exp/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/deepseek-v4-pro/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/deepseek-v4-pro/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.1/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.2/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.2/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.3/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.3/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.3-flash/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/glm-5.3-flash/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/gpt-5.6-luna/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/gpt-5.6-luna/none: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/grok-4.6/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/grok-4.6/xhigh: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/hy3/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/hy3/none: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/hy4-preview/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/hy4-preview/none: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/kimi-k2.6/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/kimi-k2.7-code/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/kimi-k3/max: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/longcat-2.0/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/longcat-2.0/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/mimo-v2.5/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/mimo-v2.5-pro/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/minimax-m2.7/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/minimax-m3/none: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/minimax-m3/thinking: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/muse-spark-1.2-contributor/minimal: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/muse-spark-1.2-contributor/xhigh: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/muse-spark-1.3-contributor/minimal: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/muse-spark-1.3-contributor/xhigh: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/omen-alpha/high: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/omen-alpha/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.6-plus/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.7-max/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.7-plus/default: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.8-flash/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.8-flash/xhigh: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.8-max/low: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)
opencode-go/qwen3.8-max/xhigh: reasoning_effective=null (variant echo from the JSON event stream; null = no authoritative echo, never inferred)

## Structured-output mode observed

- Every run was collected WITHOUT any structured-output mechanism (mode `NONE`): `opencode run` (1.18.18) exposes no schema flag. Model output noncompliance below is therefore genuine free-path behavior, not a schema artifact.

## Distinguishing failure layers

The corpus phase deliberately separates:
1. **provider/model output noncompliance** — model output shape (dialect column / extracted-assistant.txt): the stream itself completed (exit 0) with the unusual response — the model ended its own turn with that output;
2. **opencode connector transport/extraction defect** — invocation_failed / extraction_anomaly / Layer A raw artifacts (non-zero exit, timeout, missing text parts);
3. **current DSH parser rejection** — CURRENT_PARSER_FAIL with typed codes (e.g. PM_DECISION_PARSE_FAILED).

A parser FAIL is corpus evidence only. Per PLAN section 18, no production parser change is justified by this data, and none was made (PRODUCTION_PARSER_CHANGED: NO).

## Evidence limitations

- One baseline sample per configuration (variability not yet confirmed — repeat candidates above).
- reasoning_effective is recorded only when the OpenCode JSON event stream echoes a variant field; otherwise null (never inferred merely because --variant was requested).
- http_status is null throughout: the opencode connector is a stdio transport; HTTP status is not exposed.
- raw stdout/stderr are captured raw via a tee-spawn wrapper alongside the production bridge's own summary — both layers are kept separate.
- The canonical probe asks for exactly one JSON object; a model that chose to call tools or answer conversationally produces the recorded dialect as-is (corpus evidence, not a harness bug).

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- COUNCIL_VALIDATOR_CHANGED: NO
- EVIDENCE_VALIDATOR_CHANGED: NO
- OPENCODE_PRODUCTION_BRIDGE_CHANGED: NO (bridge used as-is: src/session/opencode-cli-session-bridge.mjs)
- OPENCODE_STDIN_TRANSPORT_CHANGED: NO (canonical probe delivered through the repaired production stdin transport, d1f5a27)
- Parse observation ran through the real production boundary (createCliPmDriver -> parseDecision / normalizePmDecision, product=opencode).
