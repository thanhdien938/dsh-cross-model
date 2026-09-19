# DSH MODEL OUTPUT CORPUS — FOUR-CONNECTOR OFFLINE CONSISTENCY AUDIT

- Generated: 2026-09-08T06:21:43.196Z
- Mode: OFFLINE (no provider invocation; stored artifacts only)
- Audit status: FAIL
- Samples audited: 108 (skipped without metadata: 0)
- Mismatches: 5

## Per-connector totals

| connector | audited | consistent | mismatched |
| --- | --- | --- | --- |
| codex | 10 | 10 | 0 |
| antigravity | 14 | 14 | 0 |
| opencode | 44 | 44 | 0 |
| api/openrouter | 40 | 35 | 5 |

## Recomputation method

For every stored sample the audit recomputed from disk (never from metadata):

1. extracted-assistant.txt byte count and SHA-256;
2. research dialect classification via the shared research classifier;
3. current production parse observation via the REAL production parse boundary
   (read-only, observation mode);
and compared these against the recorded metadata.json / parse-observation.json
values. No raw artifact was rewritten and no discrepancy was silently
corrected.

## Full sample matrix

| connector | run | provider terminal (recorded) | dialect (recorded) | dialect (recomputed) | parse (recorded) | parse (recomputed) | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | gpt-5.5/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.5/xhigh/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.6-luna/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | TRUNCATED | TRUNCATED | FAIL | FAIL | CONSISTENT |
| codex | gpt-5.6-luna/max/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.6-sol/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.6-sol/ultra/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.6-terra/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-5.6-terra/ultra/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-6-astra/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| codex | gpt-6-astra/ultra/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | claude-opus-4-6-thinking/default/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | UNKNOWN | UNKNOWN | FAIL | FAIL | CONSISTENT |
| antigravity | claude-sonnet-4-6/default/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.1-pro-high/high/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.1-pro-low/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.6-flash-high/high/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.6-flash-low/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.6-flash-medium/medium/run-001 | RECORDED_RUN_LEVEL_ANOMALY_NO_EXPLICIT_TERMINAL_FIELD | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| antigravity | gemini-3.7-flash-high/high/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.7-flash-low/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.7-flash-medium/medium/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.8-flash-high/high/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.8-flash-low/low/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gemini-3.8-flash-medium/medium/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| antigravity | gpt-oss-120b-medium/medium/run-001 | PROVIDER_TERMINAL_SUCCESS_IMPLIED | UNKNOWN | UNKNOWN | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-deepseek-v4-flash/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-deepseek-v4-flash/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-deepseek-v4-flash-vision-exp/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-deepseek-v4-flash-vision-exp/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-deepseek-v4-pro/high/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-deepseek-v4-pro/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.1/default/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.2/high/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.2/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.3/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.3/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.3-flash/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-glm-5.3-flash/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-gpt-5.6-luna/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-gpt-5.6-luna/none/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-grok-4.6/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-grok-4.6/xhigh/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-hy3/high/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-hy3/none/run-001 | PROVIDER_TERMINAL_SUCCESS | MALFORMED_JSON | MALFORMED_JSON | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-hy4-preview/high/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-hy4-preview/none/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-kimi-k2.6/default/run-001 | PROVIDER_TERMINAL_ERROR | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| opencode | opencode-go-kimi-k2.7-code/default/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-kimi-k3/max/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-longcat-2.0/high/run-001 | PROVIDER_TERMINAL_SUCCESS | FENCED_JSON | FENCED_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-longcat-2.0/low/run-001 | PROVIDER_TERMINAL_SUCCESS | UNKNOWN | UNKNOWN | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-mimo-v2.5/default/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-mimo-v2.5-pro/default/run-001 | PROVIDER_TERMINAL_SUCCESS | MALFORMED_JSON | MALFORMED_JSON | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-minimax-m2.7/default/run-001 | PROVIDER_TERMINAL_SUCCESS | TRUNCATED | TRUNCATED | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-minimax-m3/none/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-minimax-m3/thinking/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-muse-spark-1.2-contributor/minimal/run-001 | PROVIDER_TERMINAL_ERROR | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| opencode | opencode-go-muse-spark-1.2-contributor/xhigh/run-001 | PROVIDER_TERMINAL_ERROR | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| opencode | opencode-go-muse-spark-1.3-contributor/minimal/run-001 | PROVIDER_TERMINAL_ERROR | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| opencode | opencode-go-muse-spark-1.3-contributor/xhigh/run-001 | PROVIDER_TERMINAL_ERROR | EMPTY | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | NOT_RUN | CONSISTENT |
| opencode | opencode-go-omen-alpha/high/run-001 | PROVIDER_TERMINAL_SUCCESS | TRUNCATED | TRUNCATED | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-omen-alpha/low/run-001 | PROVIDER_TERMINAL_SUCCESS | MALFORMED_JSON | MALFORMED_JSON | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-qwen3.6-plus/default/run-001 | PROVIDER_TERMINAL_SUCCESS | FENCED_JSON | FENCED_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-qwen3.7-max/default/run-001 | PROVIDER_TERMINAL_SUCCESS | UNKNOWN | UNKNOWN | FAIL | FAIL | CONSISTENT |
| opencode | opencode-go-qwen3.7-plus/default/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-qwen3.8-flash/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-qwen3.8-flash/xhigh/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-qwen3.8-max/low/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| opencode | opencode-go-qwen3.8-max/xhigh/run-001 | PROVIDER_TERMINAL_SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | anthropic-claude-fable-5.1/high/run-001 | ERROR | EMPTY | EMPTY | FAIL | NOT_RUN | CORPUS_METADATA_MISMATCH |
| api/openrouter | anthropic-claude-fable-5.1/low/run-001 | ERROR | EMPTY | EMPTY | FAIL | NOT_RUN | CORPUS_METADATA_MISMATCH |
| api/openrouter | anthropic-claude-haiku-4.5/high/run-001 | SUCCESS | FENCED_JSON | FENCED_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | anthropic-claude-haiku-4.5/low/run-001 | SUCCESS | FENCED_JSON | FENCED_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | anthropic-claude-opus-5/high/run-001 | ERROR | EMPTY | EMPTY | FAIL | NOT_RUN | CORPUS_METADATA_MISMATCH |
| api/openrouter | anthropic-claude-opus-5/low/run-001 | ERROR | EMPTY | EMPTY | FAIL | NOT_RUN | CORPUS_METADATA_MISMATCH |
| api/openrouter | anthropic-claude-sonnet-5/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | anthropic-claude-sonnet-5/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.1-pro-preview/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.1-pro-preview/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.5-flash-lite/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.5-flash-lite/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.8-flash/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemini-3.8-flash/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | google-gemma-4-31b-it/high/run-001 | SUCCESS | TRUNCATED | TRUNCATED | FAIL | FAIL | CONSISTENT |
| api/openrouter | google-gemma-4-31b-it/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.3-codex/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.3-codex/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.4-mini/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.4-mini/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.5/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.5/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-luna/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-luna/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-sol/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-sol/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-terra/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-5.6-terra/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-6-astra/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-6-astra/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-6-astra-pro/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-6-astra-pro/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-oss-120b/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | openai-gpt-oss-120b/low/run-001 | SUCCESS | MALFORMED_JSON | MALFORMED_JSON | FAIL | FAIL | CONSISTENT |
| api/openrouter | z-ai-glm-5.3/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | z-ai-glm-5.3/low/run-001 | SUCCESS | MALFORMED_JSON | MALFORMED_JSON | FAIL | FAIL | CONSISTENT |
| api/openrouter | z-ai-glm-5.3-flash/high/run-001 | SUCCESS | TRUNCATED | TRUNCATED | FAIL | FAIL | CONSISTENT |
| api/openrouter | z-ai-glm-5.3-flash/low/run-001 | ERROR | EMPTY | EMPTY | FAIL | NOT_RUN | CORPUS_METADATA_MISMATCH |
| api/openrouter | z-ai-glm-5v-turbo/high/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |
| api/openrouter | z-ai-glm-5v-turbo/low/run-001 | SUCCESS | RAW_CANONICAL_JSON | RAW_CANONICAL_JSON | PASS | PASS | CONSISTENT |

## Mismatches

### CORPUS_METADATA_MISMATCH

- connector: api/openrouter
- model: anthropic/claude-fable-5.1
- reasoning: high
- run: anthropic-claude-fable-5.1/high/run-001
- field: current_parse_outcome
- recorded value: `"FAIL"`
- recomputed value: `"NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)"`
- classification: TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY
- metadata-only corrected value: `NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT` (supplemental record; historical files untouched)

### CORPUS_METADATA_MISMATCH

- connector: api/openrouter
- model: anthropic/claude-fable-5.1
- reasoning: low
- run: anthropic-claude-fable-5.1/low/run-001
- field: current_parse_outcome
- recorded value: `"FAIL"`
- recomputed value: `"NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)"`
- classification: TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY
- metadata-only corrected value: `NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT` (supplemental record; historical files untouched)

### CORPUS_METADATA_MISMATCH

- connector: api/openrouter
- model: anthropic/claude-opus-5
- reasoning: high
- run: anthropic-claude-opus-5/high/run-001
- field: current_parse_outcome
- recorded value: `"FAIL"`
- recomputed value: `"NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)"`
- classification: TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY
- metadata-only corrected value: `NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT` (supplemental record; historical files untouched)

### CORPUS_METADATA_MISMATCH

- connector: api/openrouter
- model: anthropic/claude-opus-5
- reasoning: low
- run: anthropic-claude-opus-5/low/run-001
- field: current_parse_outcome
- recorded value: `"FAIL"`
- recomputed value: `"NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)"`
- classification: TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY
- metadata-only corrected value: `NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT` (supplemental record; historical files untouched)

### CORPUS_METADATA_MISMATCH

- connector: api/openrouter
- model: z-ai/glm-5.3-flash
- reasoning: low
- run: z-ai-glm-5.3-flash/low/run-001
- field: current_parse_outcome
- recorded value: `"FAIL"`
- recomputed value: `"NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)"`
- classification: TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY
- metadata-only corrected value: `NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT` (supplemental record; historical files untouched)


## Explicit offline questions reconfirmed

### 1. OpenRouter Claude Haiku 4.5 — FENCED_JSON dialect vs current parser

Re-run of the CURRENT production parser (offline, unmodified) against the exact preserved Layer-B bytes:

| reasoning | layer-B bytes | layer-B sha256 | dialect (recorded) | dialect (recomputed) | current parser outcome | error code |
| --- | --- | --- | --- | --- | --- | --- |
| low | 18710 | a1aa330f9a43731d343ab1c69b380815d43a4ed90f98d91956a8576ab151a5dc | FENCED_JSON | FENCED_JSON | PASS | n/a |
| high | 19171 | 71f71e4f9c10add5aeffa5ac4734a19ae0a85221ebff324befe146d2881a36dc | FENCED_JSON | FENCED_JSON | PASS | n/a |

Observation only — parser behavior was NOT changed.

### 2. Antigravity gemini-3.6-flash-medium — terminal envelope vs extraction

{
  "present": true,
  "terminal_result_status": "ERROR",
  "terminal_response_present": true,
  "terminal_response_bytes": 16286,
  "terminal_response_dialect_from_raw": "RAW_CANONICAL_JSON",
  "extractor_recorded_assistant_bytes": null,
  "extractor_recorded_parse_outcome": "NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT",
  "extractor_extraction_anomaly": "ANTIGRAVITY_RUN_FAILED",
  "observation": "raw terminal envelope contains the previously recorded complete response while production extraction refuses the non-SUCCESS terminal status"
}

### 3. OpenCode — non-RAW dialect labels vs parser outcomes

- `MALFORMED_JSON -> FAIL`: 3 sample(s) — opencode-go/hy3/none, opencode-go/mimo-v2.5-pro/default, opencode-go/omen-alpha/low
- `EMPTY -> NOT_RUN`: 5 sample(s) — opencode-go/kimi-k2.6/default, opencode-go/muse-spark-1.2-contributor/minimal, opencode-go/muse-spark-1.2-contributor/xhigh, opencode-go/muse-spark-1.3-contributor/minimal, opencode-go/muse-spark-1.3-contributor/xhigh
- `FENCED_JSON -> PASS`: 2 sample(s) — opencode-go/longcat-2.0/high, opencode-go/qwen3.6-plus/default
- `UNKNOWN -> FAIL`: 2 sample(s) — opencode-go/longcat-2.0/low, opencode-go/qwen3.7-max/default
- `TRUNCATED -> FAIL`: 2 sample(s) — opencode-go/minimax-m2.7/default, opencode-go/omen-alpha/high

### 4. Provider-error samples — EMPTY/TRUNCATED downstream classification

- codex gpt-5.6-luna/low/run-001: dialect=TRUNCATED, provider_terminal_status=PROVIDER_TERMINAL_SUCCESS_IMPLIED, invocation_failed=false, extraction_anomaly=none → NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED
- antigravity gemini-3.6-flash-medium/medium/run-001: dialect=EMPTY, provider_terminal_status=RECORDED_RUN_LEVEL_ANOMALY_NO_EXPLICIT_TERMINAL_FIELD, invocation_failed=false, extraction_anomaly=ANTIGRAVITY_RUN_FAILED → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-kimi-k2.6/default/run-001: dialect=EMPTY, provider_terminal_status=PROVIDER_TERMINAL_ERROR, invocation_failed=true, extraction_anomaly=OPENCODE_ASSISTANT_OUTPUT_MISSING → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-minimax-m2.7/default/run-001: dialect=TRUNCATED, provider_terminal_status=PROVIDER_TERMINAL_SUCCESS, invocation_failed=false, extraction_anomaly=none → NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED
- opencode opencode-go-muse-spark-1.2-contributor/minimal/run-001: dialect=EMPTY, provider_terminal_status=PROVIDER_TERMINAL_ERROR, invocation_failed=true, extraction_anomaly=OPENCODE_ASSISTANT_OUTPUT_MISSING → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-muse-spark-1.2-contributor/xhigh/run-001: dialect=EMPTY, provider_terminal_status=PROVIDER_TERMINAL_ERROR, invocation_failed=true, extraction_anomaly=OPENCODE_ASSISTANT_OUTPUT_MISSING → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-muse-spark-1.3-contributor/minimal/run-001: dialect=EMPTY, provider_terminal_status=PROVIDER_TERMINAL_ERROR, invocation_failed=true, extraction_anomaly=OPENCODE_ASSISTANT_OUTPUT_MISSING → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-muse-spark-1.3-contributor/xhigh/run-001: dialect=EMPTY, provider_terminal_status=PROVIDER_TERMINAL_ERROR, invocation_failed=true, extraction_anomaly=OPENCODE_ASSISTANT_OUTPUT_MISSING → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- opencode opencode-go-omen-alpha/high/run-001: dialect=TRUNCATED, provider_terminal_status=PROVIDER_TERMINAL_SUCCESS, invocation_failed=false, extraction_anomaly=none → NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED
- api/openrouter anthropic-claude-fable-5.1/high/run-001: dialect=EMPTY, provider_terminal_status=ERROR, invocation_failed=true, extraction_anomaly=none → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- api/openrouter anthropic-claude-fable-5.1/low/run-001: dialect=EMPTY, provider_terminal_status=ERROR, invocation_failed=true, extraction_anomaly=none → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- api/openrouter anthropic-claude-opus-5/high/run-001: dialect=EMPTY, provider_terminal_status=ERROR, invocation_failed=true, extraction_anomaly=none → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- api/openrouter anthropic-claude-opus-5/low/run-001: dialect=EMPTY, provider_terminal_status=ERROR, invocation_failed=true, extraction_anomaly=none → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE
- api/openrouter google-gemma-4-31b-it/high/run-001: dialect=TRUNCATED, provider_terminal_status=SUCCESS, invocation_failed=false, extraction_anomaly=none → NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED
- api/openrouter z-ai-glm-5.3-flash/high/run-001: dialect=TRUNCATED, provider_terminal_status=SUCCESS, invocation_failed=false, extraction_anomaly=none → NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED
- api/openrouter z-ai-glm-5.3-flash/low/run-001: dialect=EMPTY, provider_terminal_status=ERROR, invocation_failed=true, extraction_anomaly=none → EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE

## Policy attestations

- RAW_ARTIFACTS_MODIFIED: NO
- PROVIDERS_INVOKED: NO
- DISCREPANCIES_SILENTLY_CORRECTED: NO
