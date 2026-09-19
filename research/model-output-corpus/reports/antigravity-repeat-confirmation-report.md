# DSH MODEL OUTPUT CORPUS — ANTIGRAVITY REPEAT CONFIRMATION (ADDITIVE SUPPLEMENT)

- Generated: 2026-09-08T08:32:15.028Z
- Sample basis: canonical probe sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5 (4112 bytes), byte-identical to baseline.
- These labels are OBSERVATIONS ONLY — they are NOT production certification.
- Baseline report is NOT rewritten; this report is additive.

### claude-opus-4-6-thinking / default

- BASELINE (run-001): run=baseline | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=971B | dialect=UNKNOWN | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=620B | dialect=UNKNOWN | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=18769B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS_IMPLIED|UNKNOWN|FAIL":2,"PROVIDER_TERMINAL_SUCCESS_IMPLIED|RAW_CANONICAL_JSON|PASS":1} — minority signature is a one-off

### gpt-oss-120b-medium / medium

- BASELINE (run-001): run=baseline | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=768B | dialect=UNKNOWN | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=15353B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_ERROR | exit=1 | http=n/a | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | PROVIDER_ERROR
- STABILITY_LABEL: MIXED — two provider-effective samples differ

### gemini-3.6-flash-medium / medium

- BASELINE (run-001): run=baseline | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT
- run-002: run=repeat | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=18123B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS-implied | exit=0 | http=n/a | bytes=17091B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS_IMPLIED|EMPTY|NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT":1,"PROVIDER_TERMINAL_SUCCESS_IMPLIED|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

## Factual counts

- REPEAT_SAMPLES_ATTEMPTED: 6
- REPEAT_SAMPLES_COMPLETED_NO_PROVIDER_ERROR: 5
- REPEAT_SAMPLES_WITH_PROVIDER_LEVEL_ERROR: 1

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- PRODUCTION_CONNECTOR_RUNTIME_CHANGED: NO
