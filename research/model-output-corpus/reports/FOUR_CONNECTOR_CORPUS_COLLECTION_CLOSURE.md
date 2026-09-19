# DSH FOUR-CONNECTOR CORPUS COLLECTION CLOSURE

- Generated: 2026-09-08T08:32:15.160Z
- Integration branch: corpus/four-connector-supplemental-closure (isolated worktree)
- This is a COLLECTION STATUS report ONLY. It contains NO parser recommendations, NO connector rankings, NO final dialect interpretation, and NO production model certification.

## Collection status

- CODEX_BASELINE_STATUS: COLLECTED (10 baseline samples)
- CODEX_REPEAT_STATUS: COMPLETED (2 supplemental samples, run-002/run-003)
- ANTIGRAVITY_BASELINE_STATUS: COLLECTED (14 baseline samples)
- ANTIGRAVITY_REPEAT_STATUS: COMPLETED (6 supplemental samples; 1 provider-terminal failure recorded as evidence)
- OPENCODE_BASELINE_STATUS: COLLECTED (44 baseline samples)
- OPENCODE_REPEAT_STATUS: COMPLETED (20 supplemental samples planned; 19 fresh invocations + 1 already-complete refusal; 2 transport failures recorded as evidence)
- OPENROUTER_CORE_BASELINE_STATUS: COLLECTED (20 models / 40 baseline samples)
- OPENROUTER_REPEAT_STATUS: COMPLETED (18 supplemental samples; claude-opus-5 repeats exposed HTTP 402 billing gate at both reasoning levels — recorded as evidence)
- OPENROUTER_OPENCODE_OVERLAP_STATUS: EXACT_IDENTITY_UNRESOLVED — 0 overlap invocations (see api-openrouter-opencode-overlap-supplement-report.md)
- CLAUDE_CODE_COLLECTION_STATUS: DEFERRED_QUOTA_UNAVAILABLE (NOT_COLLECTED — must be shown NOT_COLLECTED/DEFERRED, never PASS, in the later matrix)
- GROK_COLLECTION_STATUS: DEFERRED_NO_ACTIVE_SUBSCRIPTION_PLAN (NOT_COLLECTED — must be shown NOT_COLLECTED/DEFERRED, never PASS, in the later matrix)
- CANONICAL_PROBE_STATUS: VERIFIED sha256=102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5 bytes=4112
- OFFLINE_CONSISTENCY_AUDIT_STATUS: FAIL (108 samples; 5 mismatches; metadata-only supplemental correction record issued for 5 transport-error-as-parse-fail rows)

## Factual counts

- TOTAL_EXISTING_BASELINE_SAMPLES: 108
- TOTAL_REPEAT_SAMPLES_ATTEMPTED: 46
- TOTAL_OVERLAP_SUPPLEMENT_SAMPLES: 0
- TOTAL_PROVIDER_SUCCESS: 137
- TOTAL_PROVIDER_ERROR: 17
- TOTAL_PARSER_PASS: 114
- TOTAL_PARSER_FAIL: 31

Per-connector sample counts: `{"codex":{"baseline":10,"repeats":2},"antigravity":{"baseline":14,"repeats":6},"opencode":{"baseline":44,"repeats":20},"api/openrouter":{"baseline":40,"repeats":18}}`

## Supplemental collection policy outcomes

- OPENCODE_ACCESS_BLOCKED_NO_REPEAT: 4 (opencode-go muse-spark-1.2-contributor minimal/xhigh, muse-spark-1.3-contributor minimal/xhigh — HTTP 403 "requires explicit opt in"; account state NOT changed; Muse NOT invoked)
- OPENROUTER_BILLING_BLOCKED_NO_REPEAT: 2 (anthropic/claude-fable-5.1 low/high — baseline HTTP 402 API_BILLING_FAILED; billing state NOT changed; NOT re-invoked)

## Deferred connectors

Claude-code and grok were NOT invoked in this closure task. The later output
matrix MUST display both connectors as NOT_COLLECTED / DEFERRED rather than
PASS, and must not infer compatibility from historical anecdote.

## Boundary observations carried forward (facts only)

- OpenRouter Claude Haiku 4.5: dialect FENCED_JSON at both reasoning levels while the CURRENT production parser accepted the preserved Layer-B bytes on offline re-run (observation; parser unchanged).
- Antigravity gemini-3.6-flash-medium baseline: raw terminal envelope contains a complete response (RAW_CANONICAL_JSON, 16286 bytes) while production extraction refuses the non-SUCCESS (ERROR) terminal status; both supplemental repeats completed via the normal SUCCESS path.
- Provider-error samples: EMPTY outputs are downstream of provider terminal failure (402/403/transport) in the recorded corpus; TRUNCATED outputs occur under provider SUCCESS and are model-output behavior, not extraction defects.

## Readiness gate

READY_FOR_FOUR_CONNECTOR_OUTPUT_MATRIX_ANALYSIS: YES

YES means the corpus is structurally ready for the NEXT analysis phase. It
does NOT mean production is ready.
