// Deterministic, content-free audit rendering. Run only after the offline analyzer.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, ROOT, BASE, ratio, countBy } from './output-matrix-analysis.mjs';
const table = (heads, rows) => '\n| ' + heads.join(' | ') + ' |\n| ' + heads.map(() => '---').join(' | ') + ' |\n' + rows.map(r => '| ' + r.map(v => String(v ?? 'null').replaceAll('|', ' / ').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n') + '\n';
const facts = obj => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('; ');
export function renderAudit({ summary: s, rows, repeats, dialects }) {
  const fail = rows.filter(r => r.current_parser_state === 'FAIL');
  const baseFailures = repeats.filter(r => r.baseline.endsWith('|FAIL'));
  const recoveredNext = baseFailures.filter(r => r.baseline_failure_recovered_run_002).length;
  const recoveredEither = baseFailures.filter(r => r.baseline_failure_recovered_either_repeat).length;
  const paired = s.reasoning_pairs.filter(r => r.both_success);
  const prosePasses = s.structural_reviews.filter(r => r.bounded_wrapper === 'PROSE_PREFIX_SINGLE_JSON_FENCE');
  const source = `\nSource references below identify source at the frozen analysis base, not current provider documentation. No web or provider calls were made.\n\n- S1: [production-pm-backend-registry.mjs](../../src/pm/production-pm-backend-registry.mjs), runner registrations 150-229, createCliPmDriver 463-596, parseDecision/extractSingleDecision 708-743, diagnostic subreasons 773-802, await_owner repair 847 onward.\n- S2: [pm-contracts.mjs](../../src/pm/pm-contracts.mjs), normalizePmDecision 60 onward; [pm-decision-schema.mjs](../../src/pm/pm-decision-schema.mjs), builder 7 onward; [durable-pm-runtime.mjs](../../src/pm/durable-pm-runtime.mjs) line 170 and [pm-runtime.mjs](../../src/pm/pm-runtime.mjs) line 156.\n- S3: [OpenCode bridge](../../src/session/opencode-cli-session-bridge.mjs), extractOpenCodeAssistantText 72-80, process close gate 161 onward.\n- S4: [Codex bridge](../../src/session/codex-cli-session-bridge.mjs), extraction 73 and process gate 151.\n- S5: [Antigravity bridge](../../src/session/antigravity-cli-session-bridge.mjs), terminal result selection 80-98, status/response gate 107-138, schema path 243-287.\n- S6: [API protocol](../../src/pm/api-backend/api-openai-chat-protocol.mjs), content extraction 27-50, request/body/error boundary 61-95; [API adapter](../../src/pm/api-backend/api-backend-adapter.mjs), request/error mapping 29-70; [capability flags](../../src/pm/api-backend/api-provider-capabilities.mjs).\n- S7: [Council runner](../../src/pm/council/council-step-workflow-runner.mjs), step validation 299-372, native schema 610-619, parse retry 621-728, semantic repair 743-805, result validator 820 onward; [participant schema](../../src/pm/council/participant-json-schema.mjs), request eligibility 37 onward.\n- S8: [research classifier/observer](../../scripts/research/model-output-corpus/corpus-lib.mjs), classifyDialect and observeCurrentParse; [closure label generator](../../scripts/research/model-output-corpus/four-connector-closure-reports.mjs), providerBlocked/signature/stabilityLabel.\n`;
  return `# 1 Executive Verdict

**PROVEN:** The 154-row closed corpus reconciles to **136 provider-terminal successes, 18 provider-terminal errors, 136 parser attempts, 114 PASS, 22 FAIL, and 18 NOT_ATTEMPTED**. Of terminal-success samples on which parsing was attempted, **${ratio(114, 136)}** passed. This is a parser-compatibility observation on one synthetic prompt, not a reliability ranking or production certification.

**PROVEN:** Production accepts all 102 RAW_CANONICAL_JSON and all 12 FENCED_JSON samples. The fence mechanism is balanced-object decision selection, not a dedicated safe single-fence stripper. Three accepted OpenCode LongCat samples include prose outside the fence. No rejected output has a canonical decision recoverable merely by removing a lone fence/whitespace. No selected PASS decision loses, fabricates or changes fields during PM normalization; external prose is discarded in those three cases.

Recommend **terminal-gated, dialect-bounded validation**, capability-gated native generation on already supported paths, and measured bounded regeneration. Preserve provider failure gates and semantic/evidence validation. Do not add model-specific parser branches. The [architecture proposal](../architecture/DSH_CANONICAL_PARSER_OUTPUT_NORMALIZATION_ARCHITECTURE_20260908.md) details alternatives, intentional compatibility narrowing, adversarial review and rollout. Nothing in production is implemented here.

# 2 Corpus Scope and Limitations

Analysis base: \`${BASE}\`. Branch: \`analysis/four-connector-output-matrix\`. The isolated worktree descends directly from the closure evidence. The source checkout's unrelated owner changes remain untouched.

Counts recomputed from [input JSON](../../research/model-output-corpus/reports/four-connector-analysis-input.json), verified byte-for-byte against the regenerated [input CSV](../../research/model-output-corpus/reports/four-connector-analysis-input.csv) and per-run metadata: ${facts(s.sample_kinds)}; OVERLAP_SUPPLEMENT: 0. All 154 records have structured_output_mode=NONE and reasoning_effective=null. Prompt SHA-256 is 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5, 4112 UTF-8 bytes without BOM. All per-run prompt hashes/lengths were checked.

Read the closure report, all four baseline reports, all four repeat reports, overlap supplement/candidate decisions, full offline consistency report and its five correction records. The two original planning documents were read from the source checkout's untracked directory \`DSH MODEL OUTPUT CORPUS & DIALECT DISCOVERY\`; they are contextual instructions, not files in the closure commit. Their older six-connector gate does not override the owner's explicit authorization for this four-connector analysis. They were not copied into or committed on this branch.

The historical offline consistency audit covered only 108 baseline rows. This analysis replays all 136 nonempty Layer-B outputs with the actual production createCliPmDriver boundary and normalizer, and independently re-extracts all nonempty output from saved raw envelopes. It never invokes a model. API raw responses may be sanitized structural copies with reasoning withheld; assistant content remains the preserved extraction source. No raw reasoning or assistant prose is reproduced in these reports.

Sample selection was not random: 108 baselines and 46 follow-ups targeted unusual results, not every configuration. OpenRouter was a bounded core-vendor selection; OpenCode's route and model population differ. Repeated configurations have only three samples. Corpus runs bypass production task prompt rendering to preserve the canonical probe, so this is extraction/parser evidence, not an end-to-end production workload trial. Process SUCCESS is also not a proof that a model honored every prompt instruction or that an effective effort was applied.

Claude-code = **NOT_COLLECTED / DEFERRED_QUOTA_UNAVAILABLE**. Grok = **NOT_COLLECTED / DEFERRED_NO_ACTIVE_SUBSCRIPTION_PLAN**. An Anthropic or Grok-family model through another collected connector is not evidence for those deferred products. No PASS is assigned to either.

Confidence definitions: **PROVEN** = direct source or raw corpus fact; **STRONGLY_SUPPORTED** = repeated observations; **SUGGESTIVE** = limited/indirect comparison; **UNKNOWN** = evidence cannot resolve. Arithmetic is PROVEN; future operational performance is not.

# 3 Data Integrity Reconciliation

The original rollup records ${facts(s.historical_parser_states)}. Its nine explicit NOT_ATTEMPTED rows explain the gap in 114 + 31 versus 154. They comprise Antigravity Gemini3.6-medium baseline and GPT-OSS run-003, plus seven OpenCode failures (three timeouts and four access blocks). But there are **nine more API rows with recorded FAIL and parse-observation.skipped=true**. Five baseline cases already have closure correction records; four Opus repeat billing rows require the same interpretation. Thus 31 recorded FAIL minus nine skipped API rows equals **22 actual parser failures**; nine original skips plus nine corrected API skips equals **18 NOT_ATTEMPTED**.

Antigravity Gemini3.6-medium baseline has process exit 0, invocation_failed=false, no explicit metadata terminal field, but raw result.status=ERROR. Correcting this changes closure totals 137 success / 17 error to **136 success / 18 error**. This preserves, rather than weakens, the bridge's fail-closed rule.

All 46 repeat records retain metadata sample_index=1. The derived matrix adds sample_index_recorded=1 and sets sample_index to the directory ordinal 2 or 3; connector plus full run_relative_path is the unique sample identity. No records are collapsed. All observed bytes/hashes and dialects match the stored source where recorded. Missing assistant files retain byte length null; existing empty files have zero bytes. Availability is independently measured from nonempty text.

Complete skip ledger (the recorded state distinguishes the original nine from the nine corrected API cases):
${table(['Sample identity', 'Recorded parser state', 'Execution cause'], s.not_attempted_rows.map(r => [r.sample_id, r.recorded_parser_state, r.provider_failure_category]))}
Denominator ledger:
${table(['Population', 'Count', 'Meaning'], [['A. All captures', 154, 'Every original row, including provider failures'], ['B. Provider terminal success', 136, 'Native Antigravity gate; recorded adapter/process success for other products'], ['C. Nonempty Layer-B output', 136, 'Independent saved-output availability check'], ['D. Parser attempted', 136, 'Actual observation not skipped, replayed offline'], ['PASS among B intersect D', ratio(114, 136), 'Q1 requested denominator'], ['PASS among raw syntactically canonical JSON', ratio(102, 102), 'Q2 raw whole-object population; no provider-error payload'], ['PASS among canonical objects including fenced presentations', ratio(114, 114), 'Separately labeled extracted-decision population, not whole-text JSON']])}
The repeat labels also needed recomputation. Applying the historical generator semantics to row facts yields 3 REPRODUCED_3_OF_3, 3 REPRODUCED_2_OF_3, 10 ONE_OFF_1_OF_3, 5 MIXED, 2 PROVIDER_BLOCKED. The historical gate overlooked the Gemini terminal ERROR. Applying the raw-status correction yields the owner-suggested **3, 4, 9, 5, 2**, total 23. Agreement with that proposed arithmetic is a verified result, not a copied assumption. Neither an 8/4 printed summary nor the old labels alone are authoritative.

Derived files: [output matrix CSV](../../research/model-output-corpus/reports/four-connector-output-matrix.csv), [summary JSON](../../research/model-output-corpus/reports/four-connector-output-matrix-summary.json), [dialect CSV](../../research/model-output-corpus/reports/parser-dialect-acceptance-matrix.csv), [repeat CSV](../../research/model-output-corpus/reports/repeat-stability-matrix.csv), and [provider failures CSV](../../research/model-output-corpus/reports/provider-transport-failure-matrix.csv). JSON retains every content-free per-sample structural review, correction ledger, reasoning pair and denominator. CSV null is an empty field; booleans are explicit; nested summaries are JSON-encoded CSV cells. Unknown provider identity is never filled from model names.

# 4 Four-Connector Matrix
${table(['Connector', 'Total', 'Terminal success', 'Terminal error', 'Nonempty B', 'Attempted', 'PASS', 'FAIL', 'Not attempted', 'PASS / attempted'], Object.entries(s.by_connector).map(([c, m]) => [c, m.total, m.provider_success, m.provider_error, m.assistant_present, m.parser_attempted, m.parser_pass, m.parser_fail, m.parser_not_attempted, m.pass_per_attempt]))}
${table(['Connector', 'Dialect distribution', 'Repeat configuration distribution', 'Execution failures', 'Extraction diagnostic rows / proven byte mismatches'], Object.entries(s.by_connector).map(([c, m]) => [c, facts(m.dialects), facts(m.repeat_stability), facts(m.provider_failures) || 'none', m.extraction_diagnostic_rows + ' / ' + m.extraction_mismatches]))}
**Codex:** Twelve outputs from five model identities, ten baselines plus two Luna-low repeats. Last completed assistant message extraction matched all twelve Layer-B files. Luna-low baseline was unbalanced; both repeats were raw JSON. No execution failure is observed, but twelve selected samples do not establish broad reliability.

**Antigravity:** Twenty samples, with eighteen terminal SUCCESS and two ERROR. Four actual parser failures comprise three non-JSON outputs and one malformed JSON output. A complete response in one ERROR envelope is deliberately not Layer B. Native schema was NONE throughout; cannot extrapolate to the native participant schema lane.

**OpenCode:** Sixty-four samples, seven execution failures, ten actual parser failures. Concatenating assistant text parts matches saved output on all 57 nonempty cases; this can include earlier assistant commentary, as LongCat demonstrates. Existing extraction-anomaly metadata downstream of timeout/403 does not prove seven extractor defects. Three prose-plus-fence outputs pass the current parser. No eligible content was demonstrably lost by the implemented extraction contract.

**API/OpenRouter:** Fifty-eight samples, nine upstream failures, seven actual parser failures. All 49 nonempty content strings match production protocol extraction. Six Haiku fence outputs pass unchanged. Five baseline and four repeat skipped failures were incorrectly represented as parser FAIL in the source rollup. Public model family is exposed, but provider routing can change; no controlled connector comparison follows from these totals.

The required reasoning breakdown for each connector is in section 9 and the JSON. These are distributions, not a connector reliability ranking.

# 5 Provider/Transport Failure Matrix
${table(['Category', 'Count', 'Current behavior / assessment'], Object.entries(s.totals.provider_failures).map(([k, n]) => [k, n, k === 'BODY_ABORT' ? 'Fail closed; generic API_NETWORK_ERROR loses abort phase/cause specificity' : k.startsWith('TERMINAL_ERROR') ? 'Correct fail closed; add safe response-present distinction' : k === 'CONTENT_FILTER_EMPTY' ? 'Correct no-content rejection; preserve finish_reason rather than diagnose model JSON' : 'Correct upstream rejection; do not count as parser failure']))}
No additional provider-failure category is observed. Stream interruption is specifically present in the Gemini terminal ERROR diagnostic, overlapping its response-present row; do not add it as another sample. GPT-OSS Antigravity run-003 is terminal ERROR with empty response. Three timeout rows are OpenCode Kimi baseline and LongCat low run-002/high run-003. Four Muse baseline rows expose HTTP 403 inside process error events even though top-level metadata http_status is null; derived provider_http_status retains this distinction. Six billing rows are two Fable baselines plus four Opus repeats. Both Opus baselines are HTTP 200 with content_filter and empty content. GLM5.3-flash low baseline is the one body abort. Possible concurrent resource contamination was recorded historically but its causal role is UNKNOWN.

**Antigravity special case, explicit answers:** (1) YES, rejecting non-SUCCESS is correct. (2) NO, this is not a parser defect; parsing was never attempted. (3) NO proven extractor defect; extraction intentionally enforces status. (4) Primarily terminal/provider variability, supported by the raw interrupted terminal and two later normal successes. (5) YES, add TERMINAL_ERROR_WITH_RESPONSE_PRESENT diagnostics with response byte count, while rejecting the payload. The raw terminal response is 16286 bytes and structurally canonical; it is never included in Q2's Layer-B compliance denominator.

Production source distinctions matter: OpenCode/Codex bridges gate process exit but do not independently require every documented native terminal event. Their success counts mean the current recorded process/adapter success contract, not stronger event certification. API content extraction does not generally reject every non-stop finish_reason if content exists; in this corpus content_filter cases are empty and length cases remain parse failures. Treat those as source limitations, not invented observed successful bypasses.

# 6 Dialect Matrix
${table(['Dialect', 'Samples', 'PASS', 'FAIL', 'Not attempted', 'Connectors'], dialects.map(r => [r.dialect, r.sample_count, r.parser_pass, r.parser_fail, r.parser_not_attempted, r.connectors.join(', ')]))}
The dialect CSV additionally enumerates every producing connector/model identity and repeat outcome/class distribution. All six observed labels are preserved; unobserved arrays, multiple values and other theoretical classes are not fabricated rows. The FENCED_JSON classifier checks fence presence before proving wrapper-only semantics, so this label includes three prose-prefixed cases. TRUNCATED means the research scanner found unbalanced JSON-like text; it does not by itself prove token-limit truncation, a stream cut or an absent closing brace as the only defect.

# 7 Current Parser Acceptance Matrix

RAW_CANONICAL_JSON: ${ratio(102, 102)} accepted. FENCED_JSON: ${ratio(12, 12)} accepted, including nine lone fences and three prose-plus-fence wrappers. MALFORMED_JSON: 0 / 8 accepted; TRUNCATED: 0 / 9; UNKNOWN: 0 / 5. EMPTY: 0 attempts / 18 empty-or-absent outputs, so no empirical parser rejection rate is assigned to EMPTY.

**Exact Haiku path (S1/S6/S8):** normalizeChatCompletionResponse returns choices[0].message.content as a string. Re-extraction matches Layer B, so the API adapter did not strip a fence. createCliPmDriver calls parseDecision on that string. Whole-string JSON.parse fails on the fence. extractSingleDecision scans balanced braces while tracking quoted strings/escapes, decodes candidate objects, filters decision-shaped candidates, and returns the sole decision. A finish must have nonempty string output; the downstream PM normalizer accepts object data. The observer runs both. All six Haiku low/high samples pass that unmodified path. No model-specific rule is involved, and normalizePmDecision never parses fence text.

**Layer trace:** L0 canonical probe and requested configuration; L1 terminal/HTTP/process semantics; L2 event JSON or HTTP envelope; L3 connector content selection; L4 dialect; L5 text decoder/selection; L6 PM normalizer; L7 step validator. Real PM runtimes normalize at S2 after driver return. Council calls its own finish/data validator at S7. Native structured output constrains upstream generation only. A parser PASS in this study is not proof that all requested probe word counts or evidence semantics are valid, and is never Council PASS.

# 8 Repeat Stability Analysis

Configurations are grouped by connector, exposed model identifier, requested reasoning and mode, with run-001/run-002/run-003 identities preserved. SUCCESS slots determine format signatures. REPRODUCED_3_OF_3 means all three execution-effective slots share dialect/parser state; REPRODUCED_2_OF_3 means two successful-execution slots agree and the third is blocked. ONE_OFF_1_OF_3 means a 2:1 split among three successful executions, and can refer to a minority PASS. MIXED means differing two effective slots or three distinct signatures. PROVIDER_BLOCKED means zero execution-effective slots; fewer than two effective slots otherwise means INSUFFICIENT_EXECUTION_EVIDENCE. No configuration falls in the latter class here.

${table(['Configuration', 'Baseline', 'run-002', 'run-003', 'Recomputed class'], repeats.map(r => [r.connector + ':' + r.model + ':' + r.reasoning_requested, r.baseline, r.run_002, r.run_003, r.repeat_stability_class]))}
Recomputed distribution: ${facts(s.repeat_stability)}. Three stable three-slot signatures are Haiku low, Haiku high and Qwen3.6-plus default: all FENCED_JSON/PASS. Four two-effective-slot reproductions are Gemini3.6-medium (raw/PASS), Kimi2.6 default (raw/PASS), LongCat high (fenced/PASS), and GLM5.3-flash low (TRUNCATED/FAIL). The last is stable failure over its two effective slots, not compatibility.

Among 23 selected configurations, ${ratio(3, 23)} have an identical signature over all three samples, and another ${ratio(4, 23)} have matching signatures over two successful executions with one blocked slot. Fourteen configurations vary (nine one-off and five mixed); two remain provider blocked. No claim of statistical confidence or general model stability follows.

Baseline failures followed by two PASS outputs: Luna low, HY3 none, Mimo2.5-pro default, Qwen3.7-max default, Gemma4 high, API GPT-OSS low, API GLM5.3 low. In contrast, Antigravity Opus default and GLM5.3-flash high each show two FAIL and only one PASS; their ONE_OFF labels describe minority success. Minimax and both Omen configurations show distinct failing dialects before their final PASS. Preserve these directions rather than treating ONE_OFF as synonymous with a one-off failure.

# 9 Requested-Reasoning Analysis

All effective reasoning fields are null: actual applied-effort causality is **UNKNOWN**. Requested-setting association is **SUGGESTIVE**. Baseline same-identifier pairs exist for 42 model/connector combinations: five Codex, seventeen OpenCode and twenty API. Both sides executed successfully in 37 pairs. Dialects differ in ${ratio(paired.filter(r => r.dialect_differs).length, paired.length)} of those pairs; parser outcome differs in ${ratio(paired.filter(r => r.parser_differs).length, paired.length)}. Five pairs have at least one provider failure and are excluded from this format-pair denominator.

${table(['Baseline pair with dialect difference', 'Requested settings and outcomes', 'Both provider-success?'], s.reasoning_pairs.filter(r => r.dialect_differs).map(r => [r.connector + ':' + r.model, r.observations.map(o => o.reasoning + ': ' + o.dialect + '/' + o.parser + '/' + o.terminal).join('; '), r.both_success]))}
Antigravity tier-suffixed slugs are distinct exposed model identities, not one model with an independently changed effort parameter. Gemini high/low tier baselines are raw/PASS; the medium error is a terminal event, not proven reasoning effect. Source never forwards profile.reasoning as --effort in production. Codex and OpenCode use different supported extremes across models; OpenRouter low/high cannot be equated to Codex low/ultra. Haiku fences persist at both requested settings; repeat recoveries at fixed settings weaken claims that a baseline dialect difference is caused by effort.

All-sample requested-setting aggregates below are descriptive and repeat-selection-biased; they do not replace the paired baseline analysis:
${table(['Connector', 'Requested reasoning', 'Captured', 'Terminal success', 'PASS', 'FAIL', 'Not attempted', 'Dialect counts'], Object.entries(s.by_connector).flatMap(([c, m]) => Object.entries(m.reasoning).map(([effort, n]) => [c, effort, n.total, n.provider_success, n.parser_pass, n.parser_fail, n.parser_not_attempted, facts(n.dialects)])))}

# 10 Connector vs Model Attribution Limits

The overlap candidate dataset contains 50 OpenCode inventory decisions: ${facts(s.overlap_candidate_decisions)}. Recomputed exact-overlap models = 0; overlap invocations = 0. The gate requires authoritative upstream vendor, family and explicit version identity. Twenty-five name matches lack upstream vendor evidence; matching marketing names is not proof. OpenCode's opencode-go route is not an upstream vendor identity. Therefore no controlled same-exact-model OpenCode/OpenRouter causal comparison is made.

Model-family observations may guide future collection only. Connector distributions mix models, runtime versions, settings, retries and provider access states. The source-supported need is connector-specific envelope extraction and terminal gating, not connector-specific canonical syntax. No irreducibly model-specific transport contract is proven, so no model-specific parser branch is justified.

# 11 False-Negative Parser Review

Every FAIL with terminal success and nonempty assistant output was reviewed structurally and replayed. There are 22: seventeen JSON-like but invalid outputs (eight MALFORMED_JSON plus nine unbalanced TRUNCATED labels), and five outputs with no recognizable JSON decision. Whole JSON decoding and exact single-fence recognition cannot recover a valid canonical object in any of them. Output texts, reasoning and engine error excerpts are omitted; offsets below are JavaScript character positions, not UTF-8 byte offsets.

${table(['Sample identity', 'Dialect', 'Review class', 'Structural diagnostic', 'Position'], fail.map(r => [r.sample_id, r.dialect, r.dialect === 'UNKNOWN' ? 'E: non-contract prose/no recognizable JSON' : 'A: invalid or incomplete JSON', r.structural_review.syntax_diagnostic, r.structural_review.syntax_position]))}
A = 17, B (valid JSON with semantically wrong PM contract) = 0 observed among actual FAIL, C (harmless deterministic wrapper only) = 0, D (multiple ambiguous payloads) = 0, E = 5, F = 0 unresolved after structural review. The legacy UNKNOWN *dialect* is retained for those five outputs; this review calls out their non-JSON contract shape without quoting their prose. No inferred character repair is attempted.

Some MALFORMED_JSON outputs have literal control characters in strings; others violate JSON token/quote/delimiter structure. Automatically escaping characters or inserting delimiters changes the payload and is outside bounded presentation normalization. Some TRUNCATED outputs end normally at the provider while remaining lexically unbalanced, so their exact generation cause is UNKNOWN. They must still fail closed.

# 12 False-Positive Parser Review

All 114 selected PASS objects have type=finish, nonempty string output, plain-object data, no duplicate keys under token review, and zero changed/discarded/added fields under actual normalizePmDecision. No captured accepted decision is truncated, conflicting, coerced from a wrong type, or missing a required finish output. All 102 raw decisions are whole-text JSON. Nine fenced decisions are lone fences.

**Observed exception to a whole-output safety claim:** three LongCat outputs contain assistant prose before a fenced canonical decision. The current parser discards that outside prose. These are true observed broad-wrapper acceptances, not invented adversarial cases:
${table(['Sample', 'Prose prefix bytes', 'Selected object contract', 'Assessment'], prosePasses.map(r => [r.sample_id, r.prose_prefix_bytes, r.contract_state, 'Legacy parser accepts prose-plus-fence; no second conflicting decision observed']))}
No malicious contradiction is established in these three cases. However, the current implementation does not prove their outside prose harmless. The safe target should not generalize from these examples to arbitrary prose extraction. A narrowing rollout must disclose their loss of acceptance.

**Source-only findings, not additional corpus samples:** synthetic offline probes demonstrate current acceptance of a sole decision with arbitrary prose, a decision beside an unrelated JSON object, and a decision inside a non-JSON-labeled fence. It rejects two valid competing decisions and incomplete JSON. Whole valid JSON containing finish.data=[] passes decoding but fails the normalizer. The direct JSON path does not enforce the entire canonical contract itself. These cases justify layer separation and an exact-value grammar; they are not counted as observed corpus false positives. No hidden content is copied into fixtures or diagnostics.

# 13 Native Structured Output Assessment

All corpus mode values are NONE; there are zero native-schema trial rows. Source inspections distinguish capability flags from active behavior:
${table(['Connector/path', 'Active implementation', 'Recommendation'], [['Codex', 'structuredOutput=true flag; no schema forwarding in active registry/bridge', 'OPTIONAL future work after actual capability verification'], ['OpenCode', '--format json is event transport; active runner ignores schema; 1.18.18 report says no schema flag', 'UNSUITABLE as a required native decision-schema path here'], ['Antigravity selected read-only participant steps', 'participant_report / participant_critique / debate_response enable --json-schema; implementation participants excluded', 'PRIMARY on these already-enabled paths, full-model acceptance UNKNOWN'], ['Antigravity single PM / other steps', 'No schema request on active path', 'OPTIONAL only after step/model acceptance'], ['API/OpenRouter', 'supports_json_schema=false; no response_format emitted', 'OPTIONAL future per-model capability; never assume connector-wide support'], ['Claude-code / Grok', 'Source may have unrelated native paths; no corpus collected', 'NOT_COLLECTED; no empirical PASS']])}
Antigravity serializes a schema with a size bound, writes a temporary file, passes --json-schema, and rejects nonzero schema invocation exit. Its terminal response gate still applies. Council reconstructs the schema for initial and semantic-repair attempts. Schema is an upstream shape constraint; evidence membership and frozen hashes remain independently validated. The generic PM schema uses top-level oneOf, while active generic PM does not automatically request it. Stale registry comments saying only Claude understands schema do not override the actual Antigravity branch.

# 14 Retry Evidence

Fourteen repeated configurations start with a real parser FAIL. The next sample is PASS in **${ratio(recoveredNext, baseFailures.length)}**; at least one of the two supplemental samples is PASS in **${ratio(recoveredEither, baseFailures.length)}**. Six of the latter recover only at run-003, and one never produces PASS. These are selected historical repeats of identical probe bytes, not a deployed retry policy experiment, and changing the prompt as production Council does is another difference.

${table(['Baseline failure dialect', 'Repeated configurations', 'PASS on run-002', 'PASS on either repeat'], ['TRUNCATED', 'MALFORMED_JSON', 'UNKNOWN'].map(d => { const rs = baseFailures.filter(r => r.baseline.includes('|' + d + '|')); return [d, rs.length, rs.filter(r => r.baseline_failure_recovered_run_002).length, rs.filter(r => r.baseline_failure_recovered_either_repeat).length]; }))}
Of five repeated configurations initially blocked at execution, Gemini3.6-medium and Kimi2.6 subsequently pass twice, GLM5.3-flash low executes but fails parsing twice, and both Opus settings remain provider blocked. This distinguishes execution recovery from format recovery. Fable billing and four Muse access configurations were intentionally not repeated; abstention is not a compatibility failure.

S7 already bounds generic Council parse retry to two calls per decideOnce, on PM_DECISION_PARSE_FAILED only. It uses a format repair prompt, not byte-identical repetition. Separate semantic repair may call decideOnce again and increase the total step budget to four backend calls. S1's single-PM await_owner repair is another distinct path. API has no hidden adapter retry. Recommend explicit total-call accounting before extending any retry policy; do not add an invisible retry underneath existing layers.

One fresh retry for eligible read-only format failures is SUGGESTIVE as the minimum compatibility improvement. No retry for accepted fences, billing/access/auth/configuration, cancellation or policy refusals. Persistent identical failures exhaust the budget. Transport retries need cleanup and idempotency proof; no blind repeat of tool-capable execution. Full proposal and rollback are in the architecture.

# 15 Error Taxonomy Assessment

PM_DECISION_PARSE_FAILED alone is too coarse, but current production already attaches parseSubreason and sanitized diagnostics. Preserve those seams. Distinguish execution (HTTP/timeout/native ERROR), extraction (content source missing/refused), formatting (raw/fence/prose), decoding (invalid/incomplete/multiple values/wrong top level), PM contract and step semantic/evidence errors. A successful fence is a format observation, not an error code.

The corpus gives eight malformed, nine unbalanced and five no-JSON outputs behind one public parser code. Balanced malformed objects can be reported as NO_DECISION_FOUND because their decode exceptions are ignored during candidate collection. The body-abort case can be labeled generic API_NETWORK_ERROR because response.text is outside the fetch try/catch. Both are diagnostic weaknesses without evidence of fail-open success.

Use NOT_ATTEMPTED as a state and its no-assistant reason, not a parser FAIL code. Use PM_OUTPUT_INCOMPLETE_JSON only when lexical evidence establishes incompleteness; TRUNCATED may remain a historical classifier label or a provider finish marker, never a guessed transport cause. MULTIPLE_VALUES and DUPLICATE_KEYS need token evidence; unsupported categories remain UNKNOWN rather than semantic guesses. The architecture taxonomy lists exact classifications and conditions.

# 16 Compatibility Registry Assessment

YES, advisory first. Minimum observation identity: connector, exposed provider/route, requested model, requested reasoning, mode; dataset scope carries step kind and schema version. Provenance carries runtime version, prompt hash, returned identifier, collection time and original sample IDs. Unknown fields stay null. The corpus contains only one probe step, so it cannot populate Council-specific compatibility or an independent effective-effort axis.

Use STRICT_CANONICAL, CANONICAL_WITH_BOUNDED_NORMALIZATION, VARIABLE, PROVIDER_BLOCKED, UNSUPPORTED and UNKNOWN only with their sample counts and scope. Single raw PASS is not certification; provider blocked is not format incompatibility. The three LongCat prose cases prevent equating every FENCED_JSON label with the bounded-normalization status. Initially control diagnostics and native capability preferences only. Any later eligibility/retry use must be owner-reviewed, expire with drift, and never weaken semantic validation or select a model-specific parser.

# 17 Key Proven Invariants

1. All 154 original identities remain, with 108 baseline and 46 repeated rows and zero overlap samples; raw evidence and production source remain unchanged.
2. Actual attempts are 136, with 114 PASS and 22 FAIL; the 18 upstream/terminal failures do not become model-format failures. No proven extraction byte mismatch occurs on the 136 nonempty outputs.
3. Every raw canonical decision and every captured fence passes the current decoder and PM normalizer. Haiku acceptance uses the shared balanced-object fallback; three LongCat PASS samples include outside prose.
4. No actual rejected sample is valid canonical JSON hidden only by a harmless lone-fence/whitespace wrapper. No PASS object's fields were normalized away or fabricated in this corpus.
5. All effective-effort values are unknown; exact OpenCode/OpenRouter upstream-model overlap is unproven; no Claude-code/Grok product observations exist.

Failure attribution for the 40 non-PASS captures is **18 provider/transport/terminal failures, zero proven connector extraction defects, 22 model-format/non-contract-output failures, zero observed valid-JSON canonical-contract rejections**. These categories partition the actual non-PASS captures. Extraction diagnostic fields on 18 upstream failures are not 18 defects. L7 was not exercised, so Council semantic compatibility remains UNKNOWN rather than zero failures.

# 18 Key Remaining Unknowns

1. Full native-schema and Council/evidence-contract acceptance per connector/model/step; corpus free-form success cannot answer it.
2. Effective reasoning and any causal effect of effort; provider responses never echo it here.
3. Exact upstream identity across OpenCode/OpenRouter and future alias/provider-route drift.
4. Future production retry recovery, cost and side-effect safety under different prompts/contexts; three selected samples cannot establish reliability.
5. Exact mechanism behind every unbalanced/model output and transient interruption, including possible collection resource contention; corpus labels alone cannot settle cause.

# 19 Architecture Decision

Recommend Option B: **terminal-gated, dialect-bounded validation**, with capability-gated native output on supported paths. The architecture compares strict-only (102 / 136 = 75.0% observed coverage), bounded raw-plus-lone-fence (111 / 136 = 81.6%), universal native-first (UNKNOWN, zero native corpus samples), and current permissive extraction (114 / 136 = 83.8%). B deliberately narrows three legacy prose acceptances; it does not magically repair the 22 failures. Start diagnostics-only, shadow the narrower grammar, then make the behavioral change separately reviewable.

Mandatory questions, answered explicitly:

- **Q1.** Provider success AND parser attempted: ${ratio(114, 136)} PASS.
- **Q2.** Raw whole-text syntactically valid canonical decisions: ${ratio(102, 102)} PASS. If counting canonical decision objects inside presentations separately: ${ratio(114, 114)} PASS. Neither includes raw JSON withheld by failed terminal semantics.
- **Q3.** RAW_CANONICAL_JSON and FENCED_JSON are observed accepted; the latter includes prose-prefixed fences. No other observed dialect passes.
- **Q4.** None of the 22 actual rejected outputs is a deterministic wrapper-only recovery candidate. Lone fences already pass.
- **Q5.** Invalid/incomplete JSON, semantic missing/wrong types, ambiguous multiple/conflicting values, prose requiring intent guessing, terminal failure and empty content must remain fail closed. Some are source-only risks, not observed rejected dialects here.
- **Q6.** Eighteen execution/transport/terminal failures; zero proven extractor defects; twenty-two model output format failures; zero observed actual valid-JSON canonical contract rejections. Council semantic outcome is untested, not PASS.
- **Q7.** Requested-setting association is SUGGESTIVE (seven differing dialects in 37 successful baseline pairs); effective-effort causality is UNKNOWN. Fixed-setting repeats vary too.
- **Q8.** Three configs match over all three effective runs, four over two effective runs with a block, fourteen vary, two are provider blocked. Stability is signature-specific and selected-sample-limited.
- **Q9.** NO connector-specific canonical parser; YES connector-specific transport/terminal/extraction contracts already required.
- **Q10.** NO model-specific parser logic supported by evidence.
- **Q11.** YES a small dialect layer to make and narrow the existing boundary explicit; NO new permissive normalization to salvage failing outputs.
- **Q12.** Prefer native on already-enabled Antigravity read-only participant/report/critique/debate paths, subject to independent semantic validation. Other collected paths need capability/acceptance work; OpenCode event JSON is not a native decision schema.
- **Q13.** YES an advisory, provenance-based compatibility registry; no validator bypass or unsupported certification.
- **Q14.** YES richer layered taxonomy; build on existing parseSubreason and structural diagnostics, with parser NOT_ATTEMPTED distinct.
- **Q15.** No parser broadening has demonstrated benefit. The minimum evidence-supported compatibility candidate is one explicitly budgeted fresh generation for eligible read-only format failures, reusing the existing bounded retry seam; ${ratio(recoveredNext, baseFailures.length)} selected baseline-failure configurations recovered on their next identical-prompt sample. Future gain is UNKNOWN. First improve diagnostics and total call accounting without changing acceptance.

Adversarial review challenged prose with a second object, malformed/non-JSON fences, inferred brace repairs, failed terminal response salvage, registry/model alias drift, effort mismatch, compounded retries and model-dependent schema support. The strongest objection is the three-sample coverage loss from tightening prose. Contain it with shadow comparison and explicit rollout gating, not an undocumented exception. Source-only probes show current permissiveness, but no captured malicious conflicting decision was found. Detailed objections and controls appear in the architecture.

# 20 Migration Plan

PARSER-0: truthful layered diagnostics and denominators, preserving current behavior. PARSER-1: explicit structural grammar in shadow, comparing all 154 historical samples and acknowledging exactly three current-PASS deltas. PARSER-2: shared total retry accounting before extending eligible read-only retry. PARSER-3: advisory registry. PARSER-4: per-model/step native capability policy. PARSER-5: separately authorized live acceptance and strict rollout. No live work is authorized by this audit. Each stage's production files, required tests, risk, rollback and acceptance gate is specified in the architecture's migration table; no production changes are included in this commit.

Regression strategy: retain historical byte/hash evidence locally; build sanitized minimal raw-envelope, extracted-assistant, dialect, decoder, PM contract and step-semantic fixtures. Preserve repeat identities and error categories when sanitizing. Do not copy reasoning, auth headers or arbitrary engine error excerpts. Native/semantic/evidence fixtures must be independent of free-form probe fixtures. Ordinary tests are offline; provider calls and subprocess invocation are disabled in the new analysis test suite.

Analysis verification command: \`node scripts/research/model-output-corpus/output-matrix-analysis.mjs\`, then \`node scripts/research/model-output-corpus/output-matrix-report.mjs\`, then \`node --test scripts/research/model-output-corpus/output-matrix-analysis.test.mjs\`. Node 22.19.0 used existing installed dependencies through an untracked node_modules junction; no install or API quota was required. Tests cover deterministic generation, every CSV/JSON count, raw/source byte preservation, skips, original metadata indices, current parser adversarial boundaries, no exact overlap fabrication, and percentage denominators. Run \`git diff --check\` and commit only the reports, matrices and research tooling. No merge or push.

${source}
`.trimEnd() + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await analyze();
  writeFileSync(join(ROOT, 'docs/audit/DSH_FOUR_CONNECTOR_OUTPUT_MATRIX_ANALYSIS_20260908.md'), renderAudit(result));
  console.log('AUDIT_REPORT_RENDERED');
}
