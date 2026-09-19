# DSH MODEL OUTPUT CORPUS — API/OPENROUTER REPEAT CONFIRMATION (ADDITIVE SUPPLEMENT)

- Generated: 2026-09-08T08:32:15.051Z
- Sample basis: canonical probe sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5 (4112 bytes), byte-identical to baseline.
- These labels are OBSERVATIONS ONLY — they are NOT production certification.
- Baseline report is NOT rewritten; this report is additive.

### anthropic/claude-haiku-4.5 / low

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=18710B | dialect=FENCED_JSON | parser=PASS
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=19898B | dialect=FENCED_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=21334B | dialect=FENCED_JSON | parser=PASS
- STABILITY_LABEL: REPRODUCED_3_OF_3 — all three samples share one outcome signature

### anthropic/claude-haiku-4.5 / high

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=19171B | dialect=FENCED_JSON | parser=PASS
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=19341B | dialect=FENCED_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=21175B | dialect=FENCED_JSON | parser=PASS
- STABILITY_LABEL: REPRODUCED_3_OF_3 — all three samples share one outcome signature

### anthropic/claude-opus-5 / low

- BASELINE (run-001): run=baseline | terminal=ERROR | exit=n/a | http=200 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_EMPTY_RESPONSE) | PROVIDER_ERROR
- run-002: run=repeat | terminal=ERROR | exit=n/a | http=402 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_BILLING_FAILED) | BILLING_BLOCKED
- run-003: run=repeat | terminal=ERROR | exit=n/a | http=402 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_BILLING_FAILED) | BILLING_BLOCKED
- STABILITY_LABEL: PROVIDER_BLOCKED — every recorded sample ended in a provider-level block/failure

### anthropic/claude-opus-5 / high

- BASELINE (run-001): run=baseline | terminal=ERROR | exit=n/a | http=200 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_EMPTY_RESPONSE) | PROVIDER_ERROR
- run-002: run=repeat | terminal=ERROR | exit=n/a | http=402 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_BILLING_FAILED) | BILLING_BLOCKED
- run-003: run=repeat | terminal=ERROR | exit=n/a | http=402 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_BILLING_FAILED) | BILLING_BLOCKED
- STABILITY_LABEL: PROVIDER_BLOCKED — every recorded sample ended in a provider-level block/failure

### openai/gpt-oss-120b / low

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=14738B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=12424B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=13209B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"SUCCESS|MALFORMED_JSON|FAIL":1,"SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

### google/gemma-4-31b-it / high

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=12866B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=14226B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=14815B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"SUCCESS|TRUNCATED|FAIL":1,"SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

### z-ai/glm-5.3 / low

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=17752B | dialect=MALFORMED_JSON | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=18174B | dialect=RAW_CANONICAL_JSON | parser=PASS
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=17034B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"SUCCESS|MALFORMED_JSON|FAIL":1,"SUCCESS|RAW_CANONICAL_JSON|PASS":2} — minority signature is a one-off

### z-ai/glm-5.3-flash / low

- BASELINE (run-001): run=baseline | terminal=ERROR | exit=n/a | http=200 | bytes=NO-ASSISTANT-OUTPUT | dialect=EMPTY | parser=FAIL(API_NETWORK_ERROR) | PROVIDER_ERROR
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=18371B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=16174B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- STABILITY_LABEL: REPRODUCED_2_OF_3 — two provider-effective samples share one outcome signature (third slot not provider-effective)

### z-ai/glm-5.3-flash / high

- BASELINE (run-001): run=baseline | terminal=SUCCESS | exit=n/a | http=200 | bytes=17157B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-002: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=15569B | dialect=TRUNCATED | parser=FAIL(PM_DECISION_PARSE_FAILED)
- run-003: run=repeat | terminal=SUCCESS | exit=n/a | http=200 | bytes=19024B | dialect=RAW_CANONICAL_JSON | parser=PASS
- STABILITY_LABEL: ONE_OFF_1_OF_3 — outcome signatures: {"SUCCESS|TRUNCATED|FAIL":2,"SUCCESS|RAW_CANONICAL_JSON|PASS":1} — minority signature is a one-off

## Factual counts

- REPEAT_SAMPLES_ATTEMPTED: 18
- REPEAT_SAMPLES_COMPLETED_NO_PROVIDER_ERROR: 14
- REPEAT_SAMPLES_WITH_PROVIDER_LEVEL_ERROR: 4

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- PRODUCTION_CONNECTOR_RUNTIME_CHANGED: NO
