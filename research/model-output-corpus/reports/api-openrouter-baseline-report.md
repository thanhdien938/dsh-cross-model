# API / OpenRouter â€” DSH Model Output Corpus Baseline Report

- TARGET_CONNECTOR: api
- TARGET_API_PROVIDER: openrouter
- OPENROUTER_VERSION_OR_API_VERSION: v1 (https://openrouter.ai/api/v1)
- CONNECTOR_VERSION: p11-api-backend (api product, openai-chat protocol)
- REPO_BRANCH: corpus/api-openrouter-baseline
- REPO_HEAD: 7b6df0490bef812894df6b2654baef16d17a2b70
- CANONICAL_PROBE_SHA256: 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5
- CANONICAL_PROBE_BYTES: 4112
- Collection date: 2026-09-08T02:42:30.593Z

## OPENROUTER_VERSION_OR_API_VERSION

Public REST API `v1` at `https://openrouter.ai/api/v1`; transport is the production
`openai-chat` protocol path (`POST /chat/completions`, non-streaming). Catalogue
endpoint `https://openrouter.ai/api/v1/models` returned HTTP 200.

## TOTAL_OPENROUTER_MODELS_DISCOVERED

428 (full live catalogue snapshot 2026-09-08T02:42:30.593Z).
Production `discoverApiProviderModels()` caps at 500; the live
catalogue (428) is below that cap, so no discovery truncation occurred.

Invocation scope is deliberately bounded (the entire marketplace is NOT baselined).

## CORE_VENDOR_MODELS_SELECTED

20 models across the four core vendor families:

| provider_family | model_slug | cost_classification | supported_reasoning | selected_lowest | selected_highest | rationale |
|---|---|---|---|---|---|---|
| openai | openai/gpt-6-astra | PAID_OR_STANDARD | low/medium/high | low | high | current OpenAI flagship generation (newest openai-family catalogue entry) |
| openai | openai/gpt-6-astra-pro | PAID_OR_STANDARD | low/medium/high | low | high | premium tier of the current flagship generation (materially distinct product) |
| openai | openai/gpt-5.6-terra | PAID_OR_STANDARD | low/medium/high | low | high | current GPT-5.6 generation, heavy variant |
| openai | openai/gpt-5.6-luna | PAID_OR_STANDARD | low/medium/high | low | high | current GPT-5.6 generation, light variant |
| openai | openai/gpt-5.6-sol | PAID_OR_STANDARD | low/medium/high | low | high | current GPT-5.6 generation, mid variant |
| openai | openai/gpt-5.5 | PAID_OR_STANDARD | low/medium/high | low | high | prior main generation, still independently active production |
| openai | openai/gpt-5.4-mini | PAID_OR_STANDARD | low/medium/high | low | high | current light/mini production tier (no newer mini generation exists) |
| openai | openai/gpt-5.3-codex | PAID_OR_STANDARD | low/medium/high | low | high | current codex-specialized production line |
| openai | openai/gpt-oss-120b | PAID_OR_STANDARD | low/medium/high | low | high | current open-weight production line (distinct architecture identity) |
| anthropic | anthropic/claude-opus-5 | PAID_OR_STANDARD | low/medium/high | low | high | current Claude flagship |
| anthropic | anthropic/claude-sonnet-5 | PAID_OR_STANDARD | low/medium/high | low | high | current Claude mainline |
| anthropic | anthropic/claude-fable-5.1 | PAID_OR_STANDARD | low/medium/high | low | high | current Fable line (newest generation) |
| anthropic | anthropic/claude-haiku-4.5 | PAID_OR_STANDARD | low/medium/high | low | high | current fast tier (no newer haiku generation exists) |
| google | google/gemini-3.8-flash | PAID_OR_STANDARD | low/medium/high | low | high | current Gemini Flash generation |
| google | google/gemini-3.5-flash-lite | PAID_OR_STANDARD | low/medium/high | low | high | current Flash-Lite tier (no newer flash-lite generation exists) |
| google | google/gemini-3.1-pro-preview | PAID_OR_STANDARD | low/medium/high | low | high | current Gemini Pro production route (no non-preview 3.x Pro exists in the catalogue) |
| google | google/gemma-4-31b-it | PAID_OR_STANDARD | low/medium/high | low | high | current open-weight Gemma generation |
| z-ai | z-ai/glm-5.3 | PAID_OR_STANDARD | low/medium/high | low | high | current GLM flagship |
| z-ai | z-ai/glm-5.3-flash | PAID_OR_STANDARD | low/medium/high | low | high | current GLM fast tier |
| z-ai | z-ai/glm-5v-turbo | PAID_OR_STANDARD | low/medium/high | low | high | current GLM vision-line production model (text output) |

Selection provenance: CORE_VENDOR only. No historical snapshots were selected
where an explicit current successor exists; superseded-but-active generations
outside the bounded selection are listed under "eligible but not selected".

## OPENCODE_CORPUS_STATE

IN_PROGRESS_OR_UNACCEPTED â€” at collection start the OpenCode corpus artifacts existed only as
uncommitted working-tree state (no completed OpenCode corpus commit, no accepted
opencode-baseline-report.md terminating marker). Per the parallel-safe collection
contract the partial OpenCode inventory was NOT consumed.

## OPENCODE_OVERLAP_MODELS_SELECTED

DEFERRED â€” OPENCODE_OVERLAP_DEFERRED_PENDING_INVENTORY=YES.
A bounded overlap supplement (DeepSeek / Moonshot / Qwen / Mistral / ... families,
matched by exact model identity) may be run after the OpenCode inventory is accepted.

## DEDUPLICATED_ELIGIBLE_MODELS

20 (each selected model invoked once per selected reasoning extreme;
single selection source, so no cross-source deduplication was required).

## EXCLUSION_COUNTS

Evaluated over the 188 core-vendor-family catalogue entries
(openai/anthropic/google/z-ai â€” the bounded scope denominator):

- FREE_EXCLUDED: 4
- TRIAL_EXCLUDED: 0
- EPHEMERAL_EXCLUDED: 0
- NON_TEXT_EXCLUDED: 11
- BATCH_EXCLUDED: 58
- ROUTER_ALIAS_EXCLUDED: 1
- DUPLICATE_ALIAS_EXCLUDED: 10
- UNKNOWN_NOT_INVOKED: 0 (every catalogue entry exposes pricing/architecture metadata sufficient for classification; no entry remained UNKNOWN)

Eligible but not selected by the bounded curation (PAID_OR_STANDARD, documented
for completeness, never invoked): 84

- anthropic/claude-3-haiku
- anthropic/claude-fable-5
- anthropic/claude-opus-4
- anthropic/claude-opus-4.1
- anthropic/claude-opus-4.5
- anthropic/claude-opus-4.6
- anthropic/claude-opus-4.7
- anthropic/claude-opus-4.8
- anthropic/claude-sonnet-4
- anthropic/claude-sonnet-4.5
- anthropic/claude-sonnet-4.6
- google/gemini-2.5-flash
- google/gemini-2.5-flash-lite
- google/gemini-2.5-pro
- google/gemini-2.5-pro-preview
- google/gemini-2.5-pro-preview-05-06
- google/gemini-3-flash-preview
- google/gemini-3.1-flash-lite
- google/gemini-3.1-flash-lite-preview
- google/gemini-3.1-pro-preview-customtools
- google/gemini-3.5-flash
- google/gemini-3.6-flash
- google/gemini-3.7-flash
- google/gemma-2-27b-it
- google/gemma-3-12b-it
- google/gemma-3-27b-it
- google/gemma-3-4b-it
- google/gemma-4-26b-a4b-it
- openai/gpt-3.5-turbo
- openai/gpt-3.5-turbo-0613
- openai/gpt-3.5-turbo-16k
- openai/gpt-3.5-turbo-instruct
- openai/gpt-4
- openai/gpt-4-turbo
- openai/gpt-4-turbo-preview
- openai/gpt-4.1
- openai/gpt-4.1-mini
- openai/gpt-4.1-nano
- openai/gpt-4o
- openai/gpt-4o-2024-05-13
- openai/gpt-4o-2024-08-06
- openai/gpt-4o-2024-11-20
- openai/gpt-4o-mini
- openai/gpt-4o-mini-2024-07-18
- openai/gpt-5
- openai/gpt-5-mini
- openai/gpt-5-nano
- openai/gpt-5-pro
- openai/gpt-5.1
- openai/gpt-5.1-codex
- openai/gpt-5.1-codex-max
- openai/gpt-5.1-codex-mini
- openai/gpt-5.2
- openai/gpt-5.2-chat
- openai/gpt-5.2-codex
- openai/gpt-5.2-pro
- openai/gpt-5.4
- openai/gpt-5.4-nano
- openai/gpt-5.4-pro
- openai/gpt-5.5-pro
- openai/gpt-5.6-luna-pro
- openai/gpt-5.6-sol-pro
- openai/gpt-5.6-terra-pro
- openai/gpt-oss-20b
- openai/gpt-oss-safeguard-20b
- openai/o1
- openai/o1-pro
- openai/o3
- openai/o3-mini
- openai/o3-mini-high
- openai/o3-pro
- openai/o4-mini
- openai/o4-mini-high
- z-ai/glm-4.5
- z-ai/glm-4.5-air
- z-ai/glm-4.5v
- z-ai/glm-4.6
- z-ai/glm-4.6v
- z-ai/glm-4.7
- z-ai/glm-4.7-flash
- z-ai/glm-5
- z-ai/glm-5-turbo
- z-ai/glm-5.1
- z-ai/glm-5.2

## PLANNED_CONFIGURATIONS

40 (= 1 planned baseline sample per selected model Ã— selected
reasoning extreme; reasoning-capable models get low + high, non-reasoning models
a single default run).

## ATTEMPTED_BASELINE_INVOCATIONS

40

## COLLECTOR_CAPTURE_COMPLETED / FAILED

- COLLECTOR_CAPTURE_COMPLETED: 40
- COLLECTOR_CAPTURE_FAILED: 0

## PROVIDER_TERMINAL_STATUS

- PROVIDER_TERMINAL_SUCCESS: 35
- PROVIDER_TERMINAL_ERROR: 5
- PROVIDER_TERMINAL_UNKNOWN: 0

## CURRENT_PARSER_PASS / FAIL

- CURRENT_PARSER_PASS: 31
- CURRENT_PARSER_FAIL: 9

Layer C runs the real production parse boundary (parseDecision + normalizePmDecision)
in observation mode. A FAIL is corpus evidence, not a backend bug verdict.

## DIALECT_COUNTS

- EMPTY: 5
- FENCED_JSON: 2
- RAW_CANONICAL_JSON: 29
- TRUNCATED: 2
- MALFORMED_JSON: 2

## REPEAT_CANDIDATES

- anthropic/claude-fable-5.1/high
- anthropic/claude-fable-5.1/low
- anthropic/claude-haiku-4.5/high
- anthropic/claude-haiku-4.5/low
- anthropic/claude-opus-5/high
- anthropic/claude-opus-5/low
- google/gemma-4-31b-it/high
- openai/gpt-oss-120b/low
- z-ai/glm-5.3/low
- z-ai/glm-5.3-flash/high
- z-ai/glm-5.3-flash/low

Marked only; NO repeat/confirmation samples were executed in this baseline session.

## MODEL_IDENTITY_MISMATCHES

NONE â€” every response_model matched its requested_model

No fallback model list was configured; a request for model X must not execute model Y.

## TRANSPORT_ANOMALIES

- z-ai/glm-5.3-flash/low: This operation was aborted

## EXTRACTION_ANOMALIES

- anthropic/claude-fable-5.1/high: API_BILLING_FAILED
- anthropic/claude-fable-5.1/low: API_BILLING_FAILED
- anthropic/claude-opus-5/high: API_EMPTY_RESPONSE
- anthropic/claude-opus-5/low: API_EMPTY_RESPONSE
- z-ai/glm-5.3-flash/low: API_NETWORK_ERROR

## CONCURRENT_COLLECTION_RESOURCE_CONTAMINATION

- z-ai/glm-5.3-flash/low: http=200 code=API_NETWORK_ERROR (CONCURRENT_COLLECTION_RESOURCE_CONTAMINATION_POSSIBLE â€” an OpenCode collector session was active in another working tree during this run)

All OpenRouter invocations ran strictly sequentially with a 2000ms inter-request delay.

## REASONING_EFFECTIVE_EVIDENCE

reasoning_effective=null for every sample â€” the OpenRouter chat-completion response does not authoritatively echo the effective reasoning setting, so no effective value was inferred.

reasoning_requested values are evidence-backed: OpenRouter's documented
`reasoning.effort` accepted values (low|medium|high), intersected with the
production openrouter reasoning translation. reasoning_supported is derived
from each model's catalogue supported_parameters (same rule as production
normalizeOpenRouterModel()).

## EVIDENCE_LIMITATIONS

- OpenRouter returns the model's hidden reasoning trace in choices[0].message.reasoning
  by default. Per PLAN section 9 (hidden chain-of-thought is never persisted), every
  raw-response.json containing that field was stored as a SANITIZED STRUCTURAL COPY:
  the reasoning fields were replaced with a withhold marker, the original body's
  SHA-256 + byte count were recorded in the artifact's raw_artifact_policy block and
  in the run metadata (raw_response_original_sha256), and the artifact was marked
  RAW_ARTIFACT_WITHHELD_SECRET_RISK. The assistant message.content — the only field
  production extraction reads — is untouched and byte-identical to Layer B.
- One baseline sample per configuration: single-sample dialect observations are
  not variability measurements (repeat candidates are marked, not rerun).
- reasoning_effective is null throughout: OpenRouter does not echo the applied
  reasoning setting, so the corpus records the requested value only.
- OpenRouter may route the same model id across multiple upstream provider
  endpoints; the `provider` field of each raw response is recorded per sample
  (provider_route) but endpoint selection remains normal production semantics.
- The canonical probe enforces a strict JSON contract; models with strong
  reasoning may spend large reasoning-token budgets before emitting output â€”
  usage metadata per sample records what the provider exposed.
- Exclusion counts use the core-vendor-family catalogue entries as denominator;
  the wider marketplace is inventoried by count only.

## SAMPLE MATRIX

| selection_source | provider_family | requested_model | response_model | reasoning_requested | reasoning_effective | http | provider_terminal | finish_reason | assistant_bytes | dialect | current_parser | repeat_candidate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CORE_VENDOR | anthropic | anthropic/claude-fable-5.1 | null | high | null | 402 | ERROR | null | null | EMPTY | FAIL (API_BILLING_FAILED) | YES |
| CORE_VENDOR | anthropic | anthropic/claude-fable-5.1 | null | low | null | 402 | ERROR | null | null | EMPTY | FAIL (API_BILLING_FAILED) | YES |
| CORE_VENDOR | anthropic | anthropic/claude-haiku-4.5 | anthropic/claude-haiku-4.5 | high | null | 200 | SUCCESS | stop | 19171 | FENCED_JSON | PASS | YES |
| CORE_VENDOR | anthropic | anthropic/claude-haiku-4.5 | anthropic/claude-haiku-4.5 | low | null | 200 | SUCCESS | stop | 18710 | FENCED_JSON | PASS | YES |
| CORE_VENDOR | anthropic | anthropic/claude-opus-5 | anthropic/claude-opus-5 | high | null | 200 | ERROR | content_filter | null | EMPTY | FAIL (API_EMPTY_RESPONSE) | YES |
| CORE_VENDOR | anthropic | anthropic/claude-opus-5 | anthropic/claude-opus-5 | low | null | 200 | ERROR | content_filter | null | EMPTY | FAIL (API_EMPTY_RESPONSE) | YES |
| CORE_VENDOR | anthropic | anthropic/claude-sonnet-5 | anthropic/claude-sonnet-5 | high | null | 200 | SUCCESS | stop | 15711 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | anthropic | anthropic/claude-sonnet-5 | anthropic/claude-sonnet-5 | low | null | 200 | SUCCESS | stop | 14635 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.1-pro-preview | google/gemini-3.1-pro-preview | high | null | 200 | SUCCESS | stop | 17438 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.1-pro-preview | google/gemini-3.1-pro-preview | low | null | 200 | SUCCESS | stop | 16696 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.5-flash-lite | google/gemini-3.5-flash-lite | high | null | 200 | SUCCESS | stop | 16500 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.5-flash-lite | google/gemini-3.5-flash-lite | low | null | 200 | SUCCESS | stop | 12483 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.8-flash | google/gemini-3.8-flash | high | null | 200 | SUCCESS | stop | 18837 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemini-3.8-flash | google/gemini-3.8-flash | low | null | 200 | SUCCESS | stop | 18386 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | google | google/gemma-4-31b-it | google/gemma-4-31b-it | high | null | 200 | SUCCESS | length | 12866 | TRUNCATED | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| CORE_VENDOR | google | google/gemma-4-31b-it | google/gemma-4-31b-it | low | null | 200 | SUCCESS | stop | 15525 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.3-codex | openai/gpt-5.3-codex | high | null | 200 | SUCCESS | stop | 17193 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.3-codex | openai/gpt-5.3-codex | low | null | 200 | SUCCESS | stop | 15319 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.4-mini | openai/gpt-5.4-mini | high | null | 200 | SUCCESS | stop | 15916 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.4-mini | openai/gpt-5.4-mini | low | null | 200 | SUCCESS | stop | 10849 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.5 | openai/gpt-5.5 | high | null | 200 | SUCCESS | stop | 17294 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.5 | openai/gpt-5.5 | low | null | 200 | SUCCESS | stop | 16144 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-luna | openai/gpt-5.6-luna | high | null | 200 | SUCCESS | stop | 15846 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-luna | openai/gpt-5.6-luna | low | null | 200 | SUCCESS | stop | 11038 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-sol | openai/gpt-5.6-sol | high | null | 200 | SUCCESS | stop | 19173 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-sol | openai/gpt-5.6-sol | low | null | 200 | SUCCESS | stop | 17487 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-terra | openai/gpt-5.6-terra | high | null | 200 | SUCCESS | stop | 16282 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-5.6-terra | openai/gpt-5.6-terra | low | null | 200 | SUCCESS | stop | 16134 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-6-astra | openai/gpt-6-astra | high | null | 200 | SUCCESS | stop | 20470 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-6-astra | openai/gpt-6-astra | low | null | 200 | SUCCESS | stop | 19803 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-6-astra-pro | openai/gpt-6-astra-pro | high | null | 200 | SUCCESS | stop | 21231 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-6-astra-pro | openai/gpt-6-astra-pro | low | null | 200 | SUCCESS | stop | 19080 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-oss-120b | openai/gpt-oss-120b | high | null | 200 | SUCCESS | stop | 17150 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | openai | openai/gpt-oss-120b | openai/gpt-oss-120b | low | null | 200 | SUCCESS | stop | 14738 | MALFORMED_JSON | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| CORE_VENDOR | z-ai | z-ai/glm-5.3 | z-ai/glm-5.3 | high | null | 200 | SUCCESS | stop | 20340 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | z-ai | z-ai/glm-5.3 | z-ai/glm-5.3 | low | null | 200 | SUCCESS | stop | 17752 | MALFORMED_JSON | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| CORE_VENDOR | z-ai | z-ai/glm-5.3-flash | z-ai/glm-5.3-flash | high | null | 200 | SUCCESS | stop | 17157 | TRUNCATED | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| CORE_VENDOR | z-ai | z-ai/glm-5.3-flash | null | low | null | 200 | ERROR | null | null | EMPTY | FAIL (API_NETWORK_ERROR) | YES |
| CORE_VENDOR | z-ai | z-ai/glm-5v-turbo | z-ai/glm-5v-turbo | high | null | 200 | SUCCESS | stop | 12787 | RAW_CANONICAL_JSON | PASS | no |
| CORE_VENDOR | z-ai | z-ai/glm-5v-turbo | z-ai/glm-5v-turbo | low | null | 200 | SUCCESS | stop | 12342 | RAW_CANONICAL_JSON | PASS | no |

## FINAL_MARKER

DSH_MODEL_OUTPUT_CORPUS_api_openrouter_BASELINE_COMPLETE
