import { createHash } from 'node:crypto';

export const PRIMARY_CANONICALIZER = 'live1-claude-sonnet-low';
export const MAX_CANONICALIZATION_DEPTH = 1;
export const UNSAFE_REASONS = Object.freeze(['MULTIPLE_COMPETING_DECISIONS', 'SEMANTIC_CONTENT_MISSING', 'TRUNCATED_SEMANTIC_CONTENT', 'AMBIGUOUS_DECISION', 'UNRECOVERABLE_STRUCTURE', 'OTHER_UNSAFE']);
import { buildCanonicalizationPrompt, buildMultiDecisionCanonicalizationPrompt } from './contract.mjs';
export { TRANSFORMATION_CONTRACT, MULTI_DECISION_TRANSFORMATION_CONTRACT } from './contract.mjs';
const facts = text => ({sha256:createHash('sha256').update(text).digest('hex'), bytes:Buffer.byteLength(text)});
const metadata = new WeakMap();
export const canonicalizationDiagnostic = value => value && typeof value === 'object' ? metadata.get(value) ?? value.canonicalizationDiagnostic ?? null : null;
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): `captureRawWrapperText`
// reads the SAME opt-in, off-by-default flag as t5-raw-evidence-capture.mjs
// (DSH_T5_RAW_EVIDENCE_CAPTURE) — never a second flag to keep in sync. This
// is the ONE deliberate exception to the raw-output-boundary hardening
// (docs/implementation/DSH_CANONICALIZER_RAW_OUTPUT_BOUNDARY_HARDENING_20260909.md):
// every existing caller (every real production run today, with the flag
// unset) gets `false` here and the diagnostic's `wrapper_text` field is
// simply never set — byte-for-byte the same hash-only retention as before.
export function canonicalizationConfig(env = process.env) {
  return Object.freeze({
    enabled: !['0','false','off'].includes(String(env.DSH_PM_CANONICALIZATION_ENABLED ?? 'true').toLowerCase()),
    profileId: env.DSH_PM_CANONICALIZER_PROFILE ?? PRIMARY_CANONICALIZER,
    captureRawWrapperText: ['1','true','on','yes'].includes(String(env.DSH_T5_RAW_EVIDENCE_CAPTURE ?? '0').toLowerCase()),
  });
}
export function safeClaudeUsage(value) {
  const source = value?.raw?.usage ?? value?.usage ?? value?.events?.findLast(e => e?.type === 'result')?.usage;
  const result = {};
  for (const key of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','total_tokens']) {
    if (Number.isFinite(source?.[key]) && source[key] >= 0) result[key] = source[key];
  }
  return result;
}
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: `allowMultipleDecisions` is
// `false` by every existing/default call — the exact prior 2-key,
// UNSAFE-or-NORMALIZED-only decode is byte-for-byte unchanged for every
// caller that omits it. Only acceptPmOutput's own AMBIGUOUS_DECISIONS branch
// (below) ever passes `true`. A `MULTIPLE_DECISIONS` wrapper is REJECTED
// (fails closed, same as any other unrecognized shape) whenever
// `allowMultipleDecisions` is `false` — a canonicalizer response can never
// smuggle a multi-candidate shape into a subreason that never asked for one.
export function decodeCanonicalizer(text, {allowMultipleDecisions = false} = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw new Error('CANONICALIZER_INVALID_WRAPPER');
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== 2) throw new Error('CANONICALIZER_INVALID_WRAPPER');
  if (value.normalization_status === 'UNSAFE' && UNSAFE_REASONS.includes(value.reason_code)) return value;
  if (value.normalization_status === 'NORMALIZED' && value.canonical_decision && typeof value.canonical_decision === 'object' && !Array.isArray(value.canonical_decision)) return value;
  if (allowMultipleDecisions && value.normalization_status === 'MULTIPLE_DECISIONS' && Array.isArray(value.canonical_candidates) && value.canonical_candidates.length > 0
    && value.canonical_candidates.every(c => c && typeof c === 'object' && !Array.isArray(c))) return value;
  throw new Error('CANONICALIZER_INVALID_WRAPPER');
}
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: PM_DECISION_AMBIGUOUS_DECISIONS
// is now ELIGIBLE (previously the one hard content-based exclusion here).
// Nothing else about eligibility changed — same enabled/depth/size/error-code
// gates as before. What changed is what acceptPmOutput() does once it IS
// eligible for this specific subreason: see isAmbiguousDecisionsError() and
// the MULTIPLE_DECISIONS branch below, which is a preservation-only path
// that can never itself choose a winner (docs/architecture/
// DSH_MULTI_DECISION_CANONICAL_HANDOFF.md).
export function eligibleForCanonicalization({output,error,depth=0,enabled=true}) {
  return enabled && depth === 0 && typeof output === 'string' && output.trim() !== '' && Buffer.byteLength(output) <= 1024 * 1024
    && error?.code === 'PM_DECISION_PARSE_FAILED';
}
function isAmbiguousDecisionsError(error) {
  return error?.code === 'PM_DECISION_PARSE_FAILED' && error?.parseSubreason === 'PM_DECISION_AMBIGUOUS_DECISIONS';
}

// The only fallback entry. Provider failures never reach it. No retries and no
// recursive parser adapter: the injected invoke is a low-level backend call.
export async function acceptPmOutput({output,parse,validateContract,invoke,contract,ctx={},signal,depth=0,config=canonicalizationConfig(),emit=()=>{}}) {
  let originalError;
  try { const decision = parse(output); emit({state:'RAW_PARSE_PASS'}); return decision; }
  catch (error) { originalError = error; }
  const raw = facts(String(output ?? ''));
  const diagnostic = {state:'RAW_PARSE_FAIL_CANONICALIZATION_NOT_ELIGIBLE', raw_parser_state:'FAIL', raw_parser_subreason:originalError.parseSubreason ?? null,
    raw_output_sha256:raw.sha256,raw_output_bytes:raw.bytes,source_profile:ctx.profileId ?? null,source_step:contract?.step_kind ?? ctx.phase ?? ctx.stage ?? null,
    canonicalizer_profile:config.profileId,attempt_ordinal:1,depth:1,result:null,canonicalized_parser_state:'NOT_ATTEMPTED',pm_contract_state:'NOT_EVALUATED',semantic_state:'NOT_EVALUATED'};
  const publish = () => { originalError.canonicalizationDiagnostic = {...diagnostic}; emit({...diagnostic}); };
  if (!eligibleForCanonicalization({output,error:originalError,depth,enabled:config.enabled}) || typeof invoke !== 'function') { publish(); throw originalError; }
  diagnostic.state = 'RAW_PARSE_FAIL_CANONICALIZATION_ATTEMPTED'; publish();
  const started = Date.now();
  // Preservation-only mode: ONLY when the raw parser's own subreason is
  // AMBIGUOUS_DECISIONS. Every other eligible subreason gets the EXACT prior
  // prompt/decode/validation path, byte-for-byte — this branch adds a new
  // capability, it never changes the existing one.
  const multiDecisionMode = isAmbiguousDecisionsError(originalError);
  try {
    const promptBuilder = multiDecisionMode ? buildMultiDecisionCanonicalizationPrompt : buildCanonicalizationPrompt;
    const response = await invoke({prompt:promptBuilder(output,contract),profileId:config.profileId,ctx,signal,depth:1});
    diagnostic.execution_state = 'SUCCESS'; diagnostic.token_usage = safeClaudeUsage(response);
    const wrapperText = response?.result ?? response;
    diagnostic.wrapper_bytes = typeof wrapperText === 'string' ? Buffer.byteLength(wrapperText) : null;
    diagnostic.wrapper_sha256 = typeof wrapperText === 'string' ? facts(wrapperText).sha256 : null;
    if (config.captureRawWrapperText && typeof wrapperText === 'string') diagnostic.wrapper_text = wrapperText;
    try { const w=JSON.parse(wrapperText); diagnostic.wrapper_json_valid=true; diagnostic.wrapper_object=!!w&&typeof w==='object'&&!Array.isArray(w); }
    catch { diagnostic.wrapper_json_valid=false; }
    let wrapper;
    try { wrapper = decodeCanonicalizer(wrapperText, {allowMultipleDecisions: multiDecisionMode}); diagnostic.wrapper_contract_state='PASS'; }
    catch { diagnostic.wrapper_contract_state='FAIL'; throw new Error('CANONICALIZER_WRAPPER_INVALID'); }
    diagnostic.result = wrapper.normalization_status;
    if (wrapper.normalization_status === 'UNSAFE') {
      diagnostic.state = 'CANONICALIZATION_UNSAFE'; diagnostic.reason_code = wrapper.reason_code;
    } else if (wrapper.normalization_status === 'MULTIPLE_DECISIONS') {
      // NO SILENT FIRST/LAST/LARGEST/SHORTEST/MAJORITY/LLM-SELECTED-CANDIDATE
      // WINS, ever: this branch NEVER resolves to a single decision and
      // NEVER returns from acceptPmOutput — it only enriches the diagnostic
      // attached to the SAME originalError that was always going to be
      // thrown, so the council step still fails this round exactly as
      // before (Chair/orchestrator ownership: nothing here decides FOR it —
      // see docs/architecture/DSH_MULTI_DECISION_CANONICAL_HANDOFF.md).
      const candidates = wrapper.canonical_candidates;
      // Deterministic ground truth from the REAL parser
      // (extractSingleDecision's own de-duplicated substantive-candidate
      // count, additive on the error — never a re-scan of raw text here,
      // never an LLM judge): when available, the preserved candidate count
      // must match it exactly, catching both silent drops and inventions
      // without ever comparing candidate CONTENT (which legitimate
      // formatting/escaping repair can change) against the source.
      const expectedCount = Number.isInteger(originalError.sourceDistinctSubstantiveCount) ? originalError.sourceDistinctSubstantiveCount : null;
      const perCandidate = candidates.map((candidate, ordinal) => {
        let parseOk = false, contractOk = false, decision = null;
        try { decision = parse(JSON.stringify(candidate)); parseOk = true; } catch { /* recorded via candidateShapeInvalid below */ }
        if (parseOk) { try { validateContract(decision); contractOk = true; } catch { /* recorded via candidateContractInvalid below */ } }
        return { ordinal, sha256: facts(JSON.stringify(candidate)).sha256, parseOk, contractOk };
      });
      const candidateShapeInvalid = perCandidate.some((c) => !c.parseOk);
      const candidateContractInvalid = perCandidate.some((c) => c.parseOk && !c.contractOk);
      const countMismatch = expectedCount !== null && candidates.length !== expectedCount;
      if (candidateShapeInvalid || candidateContractInvalid || countMismatch) {
        diagnostic.multiple_decisions_invalid_reason = candidateShapeInvalid ? 'CANDIDATE_SHAPE_INVALID' : candidateContractInvalid ? 'CANDIDATE_PM_CONTRACT_INVALID' : 'CANDIDATE_COUNT_MISMATCH';
        diagnostic.multiple_decisions_expected_count = expectedCount;
        diagnostic.multiple_decisions_returned_count = candidates.length;
        throw new Error('CANONICALIZER_MULTIPLE_DECISIONS_INVALID');
      }
      diagnostic.state = 'CANONICALIZATION_MULTIPLE_DECISIONS_PRESERVED';
      diagnostic.candidate_count = candidates.length;
      // The bounded internal representation handed to the orchestration
      // layer (Part A mission spec): status + ordinal/canonical_decision/
      // source_hash per candidate, no hidden reasoning. This rides on
      // originalError.canonicalizationDiagnostic via publish() below, which
      // council-step-workflow-runner.mjs already spreads into the durable
      // turn handoff's attempts[] entry (canonicalizationDiagnostic(error))
      // — no new plumbing needed there.
      diagnostic.candidates = perCandidate.map((c) => ({ordinal: c.ordinal, canonical_decision: candidates[c.ordinal], source_hash: c.sha256}));
      diagnostic.latency_ms = Date.now() - started;
      publish();
      // Deliberately falls through to the function's own final
      // `throw originalError` below (same as UNSAFE) — never returns a
      // decision, never recurses, never retries.
    } else {
      // NO SILENT SELECTION/MERGE: when the source subreason was
      // AMBIGUOUS_DECISIONS and the real parser's own de-duplicated count
      // proves 2+ genuinely distinct substantive decisions were present, a
      // single NORMALIZED decision here is FORBIDDEN — whether it is a
      // first/last/majority pick or a blended merge, this deterministic
      // check cannot distinguish (and does not need to: both are equally
      // forbidden). Every other subreason has no `sourceDistinctSubstantiveCount`
      // (undefined), so this guard is a no-op for the entire pre-existing,
      // already benchmark-qualified NORMALIZED path.
      if (multiDecisionMode && Number.isInteger(originalError.sourceDistinctSubstantiveCount) && originalError.sourceDistinctSubstantiveCount > 1) {
        diagnostic.forbidden_selection_detected = true;
        diagnostic.multiple_decisions_expected_count = originalError.sourceDistinctSubstantiveCount;
        throw new Error('CANONICALIZER_FORBIDDEN_SELECTION');
      }
      diagnostic.state = 'CANONICALIZATION_NORMALIZED'; publish();
      const canonical = JSON.stringify(wrapper.canonical_decision), canonicalFacts = facts(canonical);
      diagnostic.canonical_output_sha256 = canonicalFacts.sha256; diagnostic.canonical_output_bytes = canonicalFacts.bytes;
      let decision;
      try { decision = parse(canonical); diagnostic.canonicalized_parser_state = 'PASS'; }
      catch { diagnostic.canonicalized_parser_state = 'FAIL'; throw new Error('CANONICALIZED_PARSE_FAIL'); }
      try { validateContract(decision); diagnostic.pm_contract_state = 'PASS'; }
      catch { diagnostic.pm_contract_state = 'FAIL'; throw new Error('CANONICALIZED_CONTRACT_FAIL'); }
      diagnostic.state = 'CANONICALIZED_PARSE_PASS'; diagnostic.latency_ms = Date.now() - started;
      metadata.set(decision, diagnostic); publish(); return decision;
    }
  } catch {
    diagnostic.result = 'FAILED';
    diagnostic.state = diagnostic.wrapper_contract_state === 'FAIL' ? 'CANONICALIZATION_WRAPPER_FAILED'
      : diagnostic.forbidden_selection_detected ? 'CANONICALIZATION_FORBIDDEN_SELECTION'
      : diagnostic.multiple_decisions_invalid_reason ? 'CANONICALIZATION_MULTIPLE_DECISIONS_INVALID'
      : diagnostic.canonicalized_parser_state === 'FAIL' ? 'CANONICALIZED_PARSE_FAIL'
      : diagnostic.pm_contract_state === 'FAIL' ? 'CANONICALIZED_CONTRACT_FAIL'
      : 'CANONICALIZATION_EXECUTION_FAILED';
    diagnostic.execution_state ??= 'ERROR';
  }
  diagnostic.latency_ms = Date.now() - started; publish(); throw originalError;
}
