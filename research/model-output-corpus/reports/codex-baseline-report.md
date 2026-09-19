# DSH MODEL OUTPUT CORPUS — codex BASELINE REPORT

- Generated: 2026-09-08T00:38:29.439Z (phase 1.0)
- Repo branch/head: codex/council-participant-execution-audit @ d1f5a27fa9839b8cc26358f05a5237c4b397e3d9
- Canonical probe: sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5, 4112 bytes (verified fail-closed before every invocation batch)

CONNECTOR: codex
CONNECTOR_VERSION: codex-cli 0.153.4 (discovery command: `codex debug models`)

## Inventory summary

- DISCOVERED_MODELS: 8
- PAID_OR_STANDARD_MODELS: 5
- FREE_MODELS_EXCLUDED: 0
- TRIAL_MODELS_EXCLUDED: 0
- EPHEMERAL_MODELS_EXCLUDED: 1
- UNKNOWN_MODELS_NOT_INVOKED: 2 (NEEDS_OWNER_CLASSIFICATION)
- ELIGIBLE_MODELS: 5
- PLANNED_CONFIGURATIONS: 10

### Model inventory & classification

| model | visibility | default effort | supported reasoning | cost classification | evidence |
| --- | --- | --- | --- | --- | --- |
| gpt-6-astra | list | low | low/medium/high/xhigh/max/ultra | PAID_OR_STANDARD | owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata |
| gpt-reserve | hide | medium | low/medium/high/xhigh/max | UNKNOWN | visibility="hide" is not owner-facing; catalogue exposes no cost/availability evidence -> NEEDS_OWNER_CLASSIFICATION |
| gpt-5.6-sol | list | low | low/medium/high/xhigh/max/ultra | PAID_OR_STANDARD | owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata |
| gpt-5.6-terra | list | medium | low/medium/high/xhigh/max/ultra | PAID_OR_STANDARD | owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata |
| gpt-5.6-luna | list | medium | low/medium/high/xhigh/max | PAID_OR_STANDARD | owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata |
| gpt-5.5 | list | medium | low/medium/high/xhigh | PAID_OR_STANDARD | owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata |
| gpt-5.4-mini | list | medium | low/medium/high/xhigh | EPHEMERAL | catalogue upgrade.retirement_at=2026-08-31T19:00:00Z (already past at classification time); catalogue upgrade.model=gpt-5.6-luna |
| codex-auto-review | hide | medium | low/medium/high/xhigh/max | UNKNOWN | visibility="hide" is not owner-facing; catalogue exposes no cost/availability evidence -> NEEDS_OWNER_CLASSIFICATION |

### Reasoning matrix & planned invocations

| model | supported reasoning | lowest selected | highest selected | planned samples |
| --- | --- | --- | --- | --- |
| gpt-6-astra | low/medium/high/xhigh/max/ultra | low | ultra | 2 |
| gpt-5.6-sol | low/medium/high/xhigh/max/ultra | low | ultra | 2 |
| gpt-5.6-terra | low/medium/high/xhigh/max/ultra | low | ultra | 2 |
| gpt-5.6-luna | low/medium/high/xhigh/max | low | max | 2 |
| gpt-5.5 | low/medium/high/xhigh | low | xhigh | 2 |

## Baseline collection results

- ATTEMPTED_BASELINE_INVOCATIONS: 10
- COMPLETED_INVOCATIONS: 10
- FAILED_INVOCATIONS: 0
- CURRENT_PARSER_PASS: 9
- CURRENT_PARSER_FAIL: 1
- DIALECT_COUNTS: {"RAW_CANONICAL_JSON":9,"TRUNCATED":1}
- REASONING_DIALECT_DIVERGENCE: gpt-5.6-luna: {"low":"TRUNCATED","max":"RAW_CANONICAL_JSON"}
- RAW_ARTIFACTS_WITHHELD: none

### Matrix

| model | provider | reasoning | exit/http | assistant bytes | dialect | current parser | repeat candidate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.5 | null (not exposed) | low | exit=0 http=n/a | 15305 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.5 | null (not exposed) | xhigh | exit=0 http=n/a | 19210 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.6-luna | null (not exposed) | low | exit=0 http=n/a | 15479 | TRUNCATED | FAIL (PM_DECISION_PARSE_FAILED) | YES |
| gpt-5.6-luna | null (not exposed) | max | exit=0 http=n/a | 16425 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.6-sol | null (not exposed) | low | exit=0 http=n/a | 17196 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.6-sol | null (not exposed) | ultra | exit=0 http=n/a | 18022 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.6-terra | null (not exposed) | low | exit=0 http=n/a | 14864 | RAW_CANONICAL_JSON | PASS | no |
| gpt-5.6-terra | null (not exposed) | ultra | exit=0 http=n/a | 17874 | RAW_CANONICAL_JSON | PASS | no |
| gpt-6-astra | null (not exposed) | low | exit=0 http=n/a | 18969 | RAW_CANONICAL_JSON | PASS | no |
| gpt-6-astra | null (not exposed) | ultra | exit=0 http=n/a | 19989 | RAW_CANONICAL_JSON | PASS | no |

## Repeat candidates

- gpt-5.6-luna/low (TRUNCATED, parser PM_DECISION_PARSE_FAILED)

## Corpus evidence notes (structurally unusual outputs)

- gpt-5.6-luna/low: dialect=TRUNCATED (JSON started but never balanced (output likely cut off)); stream end-state: turn.completed (the model ended its own turn with this output — provider/model contract variability, transport intact)

## Anomalies

- TRANSPORT_ANOMALIES: none
- EXTRACTION_ANOMALIES: none

## Distinguishing failure layers

The corpus phase deliberately separates:
1. **provider/model contract variability** — model output shape (dialect column / extracted-assistant.txt);
2. **connector extraction/transport defect** — invocation_failed / extraction_anomaly / Layer A raw artifacts;
3. **current DSH parser rejection** — CURRENT_PARSER_FAIL with typed codes (e.g. PM_DECISION_PARSE_FAILED).

A parser FAIL is corpus evidence only. Per PLAN section 18, no production parser change is justified by this data, and none was made (PRODUCTION_PARSER_CHANGED: NO).

## Evidence limitations

- One baseline sample per configuration (variability not yet confirmed — repeat candidates above).
- reasoning_effective is recorded only when the connector's event stream echoes it; otherwise null.
- http_status is null throughout: the codex connector is a stdio transport; HTTP status is not exposed.
- stderr is captured raw via a tee-spawn wrapper; the production bridge additionally summarizes stderr with its own URL/bearer-token redaction (safe()) — both layers are kept separate.
- Hidden (visibility != list) models were classified UNKNOWN (no cost/availability evidence) and were NOT invoked.

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- COUNCIL_VALIDATOR_CHANGED: NO
- EVIDENCE_VALIDATOR_CHANGED: NO
- Connector bridge used as-is: src/session/codex-cli-session-bridge.mjs
- Parse observation ran through the real production boundary (createCliPmDriver -> parseDecision / normalizePmDecision).
