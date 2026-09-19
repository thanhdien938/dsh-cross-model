# DSH MODEL OUTPUT CORPUS — antigravity BASELINE REPORT

- Generated: 2026-09-08T01:46:46.302Z (phase 1.0)
- Repo branch/head: codex/council-participant-execution-audit @ 25622581d6a3d19a0805fd1849c8f4bc7526a6d8
- Canonical probe: sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5, 4112 bytes (verified fail-closed before every invocation batch)

CONNECTOR: antigravity
CONNECTOR_VERSION: agy 1.1.27 (discovery command: `agy models`)

## Inventory summary

- DISCOVERED_MODELS: 14
- PAID_OR_STANDARD_MODELS: 14
- FREE_MODELS_EXCLUDED: 0
- TRIAL_MODELS_EXCLUDED: 0
- EPHEMERAL_MODELS_EXCLUDED: 0
- UNKNOWN_MODELS_NOT_INVOKED: 0 (NEEDS_OWNER_CLASSIFICATION)
- ELIGIBLE_MODELS: 14
- PLANNED_CONFIGURATIONS: 14

### Model inventory & classification

The live `agy models` catalogue exposes only `slug<TAB>display name` per row — no per-model cost/availability/deprecation metadata. Classification evidence below is therefore catalogue-presence + marker-scan based (never name-only inference).

| model | display name | reasoning tier | supported reasoning | cost classification | evidence |
| --- | --- | --- | --- | --- | --- |
| gemini-3.8-flash-high | Gemini 3.8 Flash (High) | high | high | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.8-flash-medium | Gemini 3.8 Flash (Medium) | medium | medium | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.8-flash-low | Gemini 3.8 Flash (Low) | low | low | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.7-flash-high | Gemini 3.7 Flash (High) | high | high | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.7-flash-medium | Gemini 3.7 Flash (Medium) | medium | medium | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.7-flash-low | Gemini 3.7 Flash (Low) | low | low | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.6-flash-high | Gemini 3.6 Flash (High) | high | high | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.6-flash-medium | Gemini 3.6 Flash (Medium) | medium | medium | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.6-flash-low | Gemini 3.6 Flash (Low) | low | low | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.1-pro-high | Gemini 3.1 Pro (High) | high | high | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gemini-3.1-pro-low | Gemini 3.1 Pro (Low) | low | low | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| claude-sonnet-4-6 | Claude Sonnet 4.6 (Thinking) | (none) | (none — default once) | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| claude-opus-4-6-thinking | Claude Opus 4.6 (Thinking) | (none) | (none — default once) | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |
| gpt-oss-120b-medium | GPT-OSS 120B (Medium) | medium | medium | PAID_OR_STANDARD | returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata |

### Reasoning axis (Antigravity-specific)

The reasoning axis is the model slug's own tier suffix (`-low`/`-medium`/`-high`) — live-proven (docs/p9/06,07) that `--effort` is NOT an independent execution axis: for tier-suffixed models it must exactly match the slug's tier (and behaves identically when omitted), and for Claude slugs it is rejected unconditionally. Production execution therefore never forwards `--effort`, and neither did this harness. Consequence: every model supports exactly ONE reasoning configuration (its own tier, or `default` for the Claude slugs), so lowest == highest for every eligible model and each model is invoked exactly once.

| model | supported reasoning | selected reasoning | planned samples |
| --- | --- | --- | --- |
| gemini-3.8-flash-high | high | high | 1 |
| gemini-3.8-flash-medium | medium | medium | 1 |
| gemini-3.8-flash-low | low | low | 1 |
| gemini-3.7-flash-high | high | high | 1 |
| gemini-3.7-flash-medium | medium | medium | 1 |
| gemini-3.7-flash-low | low | low | 1 |
| gemini-3.6-flash-high | high | high | 1 |
| gemini-3.6-flash-medium | medium | medium | 1 |
| gemini-3.6-flash-low | low | low | 1 |
| gemini-3.1-pro-high | high | high | 1 |
| gemini-3.1-pro-low | low | low | 1 |
| claude-sonnet-4-6 | (none — default once) | default | 1 |
| claude-opus-4-6-thinking | (none — default once) | default | 1 |
| gpt-oss-120b-medium | medium | medium | 1 |

## Baseline collection results

- ATTEMPTED_BASELINE_INVOCATIONS: 14
- COMPLETED_INVOCATIONS: 14
- FAILED_INVOCATIONS: 0
- CURRENT_PARSER_PASS: 11
- CURRENT_PARSER_FAIL: 2
- DIALECT_COUNTS: {"UNKNOWN":2,"RAW_CANONICAL_JSON":11,"EMPTY":1}
- REASONING_DIALECT_DIVERGENCE: none (one configuration per model)
- RAW_ARTIFACTS_WITHHELD: none

### Matrix

| model | provider | reasoning | exit/http | assistant bytes | dialect | current parser | repeat candidate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-4-6-thinking | null (not exposed) | default | exit=0 http=n/a | 971 | UNKNOWN | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| claude-sonnet-4-6 | null (not exposed) | default | exit=0 http=n/a | 17519 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.1-pro-high | null (not exposed) | high | exit=0 http=n/a | 21815 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.1-pro-low | null (not exposed) | low | exit=0 http=n/a | 18062 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.6-flash-high | null (not exposed) | high | exit=0 http=n/a | 19271 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.6-flash-low | null (not exposed) | low | exit=0 http=n/a | 9657 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.6-flash-medium | null (not exposed) | medium | exit=0 http=n/a | n/a | EMPTY | NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | YES |
| gemini-3.7-flash-high | null (not exposed) | high | exit=0 http=n/a | 19944 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.7-flash-low | null (not exposed) | low | exit=0 http=n/a | 17415 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.7-flash-medium | null (not exposed) | medium | exit=0 http=n/a | 17830 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.8-flash-high | null (not exposed) | high | exit=0 http=n/a | 21016 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.8-flash-low | null (not exposed) | low | exit=0 http=n/a | 18765 | RAW_CANONICAL_JSON | PASS | no |
| gemini-3.8-flash-medium | null (not exposed) | medium | exit=0 http=n/a | 19040 | RAW_CANONICAL_JSON | PASS | no |
| gpt-oss-120b-medium | null (not exposed) | medium | exit=0 http=n/a | 768 | UNKNOWN | FAIL (PM_DECISION_PARSE_FAILED) | YES |

## Repeat candidates

- claude-opus-4-6-thinking/default (UNKNOWN, parser PM_DECISION_PARSE_FAILED)
- gemini-3.6-flash-medium/medium (EMPTY)
- gpt-oss-120b-medium/medium (UNKNOWN, parser PM_DECISION_PARSE_FAILED)

## Corpus evidence notes (structurally unusual outputs)

- claude-opus-4-6-thinking/default: dialect=UNKNOWN (no recognizable JSON structure); stream end-state: result (stream completed — the model ended its own turn with this output); terminal result status: SUCCESS; response length present in the raw result envelope: 968 chars
- gemini-3.6-flash-medium/medium: dialect=EMPTY (no assistant output: ANTIGRAVITY_RUN_FAILED); stream end-state: result (stream completed — the model ended its own turn with this output); terminal result status: ERROR; terminal error text: "The stream was interrupted. Please continue the task you were working on."; response length present in the raw result envelope: 16263 chars
- gpt-oss-120b-medium/medium: dialect=UNKNOWN (no recognizable JSON structure); stream end-state: result (stream completed — the model ended its own turn with this output); terminal result status: SUCCESS; response length present in the raw result envelope: 763 chars

## Anomalies

- TRANSPORT_ANOMALIES: none
- EXTRACTION_ANOMALIES: gemini-3.6-flash-medium/medium: ANTIGRAVITY_RUN_FAILED

## SCHEMA_MODE_OBSERVED

- Structured-output modes across runs: {"NONE":14}
- Every run was collected WITHOUT the native `--json-schema` flag (mode `NONE`): the harness deliberately exercises the free-form output path production single-PM execution uses. Production Antigravity DOES attach a native JSON schema on certain council participant steps (participant-json-schema.mjs / `native_json_schema`), but never for a single-PM decision probe, and enabling it here merely to obtain a compliant sample was forbidden by the MASTER prompt. Model output noncompliance below is therefore genuine free-path behavior, not a schema artifact.

## Distinguishing failure layers

The corpus phase deliberately separates:
1. **provider/model output noncompliance** — model output shape (dialect column / extracted-assistant.txt): the terminal `result` event's own status says SUCCESS while the response shape is unusual — the model ended its own turn with that output;
2. **Antigravity connector extraction defect** — invocation_failed / extraction_anomaly / Layer A raw artifacts (e.g. status CANCELED/ERROR, missing response);
3. **current DSH parser rejection** — CURRENT_PARSER_FAIL with typed codes (e.g. PM_DECISION_PARSE_FAILED).

A parser FAIL is corpus evidence only. Per PLAN section 18, no production parser change is justified by this data, and none was made (PRODUCTION_PARSER_CHANGED: NO).

## Evidence limitations

- One baseline sample per configuration (variability not yet confirmed — repeat candidates above).
- reasoning_effective is recorded only when the Antigravity event stream echoes an effort/reasoning_effort field; otherwise null (never inferred).
- http_status is null throughout: the antigravity connector is a stdio transport; HTTP status is not exposed.
- raw stderr is captured raw via a tee-spawn wrapper; the production bridge additionally summarizes stderr with its own sanitization (safe()) — both layers are kept separate.
- The `agy models` catalogue carries no cost metadata; classification relies on the authenticated owner-facing catalogue row itself (see inventory) — no model was classified from naming alone.
- Headless `--mode plan` auto-denies tool permission requests; the canonical probe needs no tools, but a model that chose to call tools would end CANCELED (that outcome is corpus evidence, not a harness bug).

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- COUNCIL_VALIDATOR_CHANGED: NO
- EVIDENCE_VALIDATOR_CHANGED: NO
- ANTIGRAVITY_PRODUCTION_BRIDGE_CHANGED: NO (bridge used as-is: src/session/antigravity-cli-session-bridge.mjs)
- Parse observation ran through the real production boundary (createCliPmDriver -> parseDecision / normalizePmDecision, product=antigravity).
