# DSH MODEL OUTPUT CORPUS — OPENCODE REPEAT CONFIRMATION (ADDITIVE SUPPLEMENT)

- Generated: 2026-09-08T08:32:15.041Z
- Sample basis: canonical probe sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5 (4112 bytes), byte-identical to baseline.
- These labels are OBSERVATIONS ONLY — they are NOT production certification.
- Baseline report is NOT rewritten; this report is additive.

### opencode-go/hy3 / none

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=10785B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=10481B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=10513B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|MALFORMED_JSON|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

### opencode-go/kimi-k2.6 / default

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_ERROR | exit=n/a | http=n/a | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | PROVIDER_ERROR
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=16803B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=16985B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: REPRODUCED_2_OF_3 — two provider-effective samples share one outcome signature (third slot not provider-effective)

### opencode-go/longcat-2.0 / low

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=761B | dialect=UNKNOWN | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_ERROR | exit=n/a | http=n/a | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | PROVIDER_ERROR
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=19710B | dialect=FENCED_JSON | parser=PASS
- STABILITY_LABEL: MIXED — two provider-effective samples differ

### opencode-go/longcat-2.0 / high

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=20093B | dialect=FENCED_JSON | parser=PASS
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=18529B | dialect=FENCED_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_ERROR | exit=n/a | http=n/a | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT | PROVIDER_ERROR
- STABILITY_LABEL: REPRODUCED_2_OF_3 — two provider-effective samples share one outcome signature (third slot not provider-effective)

### opencode-go/mimo-v2.5-pro / default

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=13653B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=17012B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=14538B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|MALFORMED_JSON|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

### opencode-go/minimax-m2.7 / default

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=9119B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=12543B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=14644B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: MIXED — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|TRUNCATED|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|MALFORMED_JSON|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":1}

### opencode-go/omen-alpha / low

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=14958B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=14033B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=16792B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: MIXED — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|MALFORMED_JSON|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|TRUNCATED|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":1}

### opencode-go/omen-alpha / high

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=15787B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=18370B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=15472B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: MIXED — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|TRUNCATED|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|MALFORMED_JSON|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":1}

### opencode-go/qwen3.6-plus / default

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=17007B | dialect=FENCED_JSON | parser=PASS
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=13987B | dialect=FENCED_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=14759B | dialect=FENCED_JSON | parser=PASS
- STABILITY_LABEL: REPRODUCED_3_OF_3 — all three samples share one outcome signature

### opencode-go/qwen3.7-max / default

- BASELINE (run-001): run=baseline | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=515B | dialect=UNKNOWN | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=20688B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=PROVIDER_TERMINAL_SUCCESS | exit=0 | http=n/a | bytes=16165B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"PROVIDER_TERMINAL_SUCCESS|UNKNOWN|FAIL":1,"PROVIDER_TERMINAL_SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

## Factual counts

- REPEAT_SAMPLES_ATTEMPTED: 20
- REPEAT_SAMPLES_COMPLETED_NO_PROVIDER_ERROR: 18
- REPEAT_SAMPLES_WITH_PROVIDER_LEVEL_ERROR: 2

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- PRODUCTION_CONNECTOR_RUNTIME_CHANGED: NO
