// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: Part A coverage.
//
// Raw output -> parser -> PM_DECISION_AMBIGUOUS_DECISIONS is now ELIGIBLE
// for the canonicalization gateway (src/pm/output-canonicalization/
// gateway.mjs), under a preservation-only contract: the canonicalizer may
// de-duplicate identical representations into one NORMALIZED decision, but
// when the source contains 2+ genuinely distinct substantive decisions it
// MUST return MULTIPLE_DECISIONS with every one of them preserved, verbatim,
// in order — and MUST NEVER select, merge, drop, or invent a candidate. The
// council step itself still always fails this round on this path (nothing
// here gives the canonicalizer or the parser semantic decision authority);
// the enriched diagnostic is the "bounded internal representation handed to
// the orchestration layer" the architecture doc describes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { canonicalizationDiagnostic, decodeCanonicalizer, eligibleForCanonicalization, canonicalizationConfig, PRIMARY_CANONICALIZER } from '../src/pm/output-canonicalization/gateway.mjs';

const project = { id: 'test', repo_path: process.cwd() };
const profile = { id: 'source', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
const input = { request: { id: 'r', objective: 'test' }, history: [], turn: 0, capabilities: ['finish'] };

const report = (analysis, recommendation, risks = []) => ({ type: 'finish', output: `summary:${analysis}`, data: { type: 'council_report', analysis, recommendation, risks, uncertainties: [] } });
const concat = (...decisions) => decisions.map((d) => JSON.stringify(d)).join('\n');
const normalized = (decision) => JSON.stringify({ normalization_status: 'NORMALIZED', canonical_decision: decision });
const multiple = (decisions) => JSON.stringify({ normalization_status: 'MULTIPLE_DECISIONS', canonical_candidates: decisions });

function setup(output, response, options = {}) {
  let calls = 0; const diagnostics = [];
  const driver = createCliPmDriver({
    profile, project,
    run: async () => { if (output instanceof Error) throw output; return output; },
    canonicalize: async (args) => { calls += 1; assert.equal(args.depth, 1); if (response instanceof Error) throw response; return response; },
    observer: { canonicalization: (_ctx, d) => diagnostics.push(d) },
    ...options,
  });
  return { decide: (extra) => driver.decide({ ...input, ...extra }), calls: () => calls, diagnostics };
}

// 1. unique malformed decision -> NORMALIZED (JSON_INVALID subreason, not
// AMBIGUOUS_DECISIONS -- pre-existing behavior, included for completeness).
test('1: unique malformed decision -> NORMALIZED', async () => {
  const decision = report('a', 'r');
  const t = setup(JSON.stringify(decision).slice(0, -1), normalized(decision));
  assert.deepEqual(await t.decide(), decision);
  assert.equal(t.calls(), 1);
});

// 2. two duplicate decisions -> NORMALIZED with one canonical decision.
test('2: two duplicate decisions -> NORMALIZED (one canonical)', async () => {
  const decision = report('same', 'same');
  const t = setup(concat(decision, decision), normalized(decision));
  const resolved = await t.decide();
  assert.deepEqual(resolved, decision);
  assert.equal(t.calls(), 1);
  assert.equal(canonicalizationDiagnostic(resolved).state, 'CANONICALIZED_PARSE_PASS');
});

// 3. two substantive same-verdict, different-evidence decisions -> MULTIPLE_DECISIONS with 2.
test('3: same verdict, different evidence -> MULTIPLE_DECISIONS x2', async () => {
  const d1 = report('agree', 'proceed', ['risk-a']);
  const d2 = report('agree', 'proceed', ['risk-b', 'risk-c']);
  const t = setup(concat(d1, d2), multiple([d1, d2]));
  await assert.rejects(t.decide(), { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' });
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.state, 'CANONICALIZATION_MULTIPLE_DECISIONS_PRESERVED');
  assert.equal(diag.result, 'MULTIPLE_DECISIONS');
  assert.equal(diag.candidate_count, 2);
  assert.equal(diag.candidates.length, 2);
  assert.deepEqual(diag.candidates.map((c) => c.canonical_decision), [d1, d2]);
  assert.ok(diag.candidates.every((c) => typeof c.source_hash === 'string' && c.source_hash.length === 64));
});

// 4. two conflicting verdicts -> MULTIPLE_DECISIONS with 2.
test('4: conflicting verdicts -> MULTIPLE_DECISIONS x2', async () => {
  const d1 = report('x', 'APPROVE');
  const d2 = report('x', 'REJECT');
  const t = setup(concat(d1, d2), multiple([d1, d2]));
  await assert.rejects(t.decide(), { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' });
  assert.equal(t.diagnostics.at(-1).candidate_count, 2);
});

// 5. three substantive decisions -> MULTIPLE_DECISIONS with 3.
test('5: three substantive decisions -> MULTIPLE_DECISIONS x3', async () => {
  const ds = [report('a1', 'r1'), report('a2', 'r2'), report('a3', 'r3')];
  const t = setup(concat(...ds), multiple(ds));
  await assert.rejects(t.decide());
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.candidate_count, 3);
  assert.deepEqual(diag.candidates.map((c) => c.canonical_decision), ds);
});

// 6. no candidate dropped: source has 2 distinct, canonicalizer returns only 1 -> FAIL.
test('6: dropped candidate -> validation FAIL', async () => {
  const d1 = report('a1', 'r1'); const d2 = report('a2', 'r2');
  const t = setup(concat(d1, d2), multiple([d1]));
  await assert.rejects(t.decide(), { code: 'PM_DECISION_PARSE_FAILED' });
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.state, 'CANONICALIZATION_MULTIPLE_DECISIONS_INVALID');
  assert.equal(diag.multiple_decisions_invalid_reason, 'CANDIDATE_COUNT_MISMATCH');
  assert.equal(diag.multiple_decisions_expected_count, 2);
  assert.equal(diag.multiple_decisions_returned_count, 1);
});

// 7. no candidate invented: source has 2 distinct, canonicalizer returns 3 -> FAIL.
test('7: invented candidate -> validation FAIL', async () => {
  const d1 = report('a1', 'r1'); const d2 = report('a2', 'r2'); const invented = report('NEVER_IN_SOURCE', 'fabricated');
  const t = setup(concat(d1, d2), multiple([d1, d2, invented]));
  await assert.rejects(t.decide());
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.multiple_decisions_invalid_reason, 'CANDIDATE_COUNT_MISMATCH');
  assert.equal(diag.multiple_decisions_expected_count, 2);
  assert.equal(diag.multiple_decisions_returned_count, 3);
});

// 8. ordering preserved where meaningful.
test('8: candidate order preserved', async () => {
  const ds = ['first', 'second', 'third'].map((label) => report(label, 'r'));
  const t = setup(concat(...ds), multiple(ds));
  await assert.rejects(t.decide());
  const diag = t.diagnostics.at(-1);
  assert.deepEqual(diag.candidates.map((c) => c.canonical_decision.data.analysis), ['first', 'second', 'third']);
});

// 9. canonicalizer tries to select one of conflicting candidates -> validation FAIL.
test('9: selection attempt -> forbidden', async () => {
  const d1 = report('x', 'APPROVE'); const d2 = report('x', 'REJECT');
  const t = setup(concat(d1, d2), normalized(d1));
  await assert.rejects(t.decide(), { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' });
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.state, 'CANONICALIZATION_FORBIDDEN_SELECTION');
  assert.equal(diag.forbidden_selection_detected, true);
  assert.equal(diag.multiple_decisions_expected_count, 2);
});

// 10. canonicalizer merges conflicting candidates -> validation FAIL.
test('10: merge attempt -> forbidden', async () => {
  const d1 = report('position A', 'approve'); const d2 = report('position B', 'reject');
  const merged = report('position A and position B combined', 'approve with caveats');
  const t = setup(concat(d1, d2), normalized(merged));
  await assert.rejects(t.decide());
  assert.equal(t.diagnostics.at(-1).state, 'CANONICALIZATION_FORBIDDEN_SELECTION');
});

// 11. each candidate individually parser-valid.
test('11: candidate must be individually parser-valid', async () => {
  const d1 = report('a1', 'r1'); const d2 = report('a2', 'r2');
  const invalidShape = { type: 'finish', output: '' }; // fails parseDecision's FINISH empty-output check
  const t = setup(concat(d1, d2), multiple([d1, invalidShape]));
  await assert.rejects(t.decide());
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.multiple_decisions_invalid_reason, 'CANDIDATE_SHAPE_INVALID');
});

// 12. each candidate individually PM-contract-valid where required.
test('12: candidate must be individually PM-contract-valid', async () => {
  const d1 = report('a1', 'r1'); const d2 = report('a2', 'r2');
  const invalidContract = { type: 'workflow' }; // parses shape-wise but fails normalizePmDecision (missing spec)
  const t = setup(concat(d1, d2), multiple([d1, invalidContract]));
  await assert.rejects(t.decide());
  const diag = t.diagnostics.at(-1);
  assert.equal(diag.multiple_decisions_invalid_reason, 'CANDIDATE_PM_CONTRACT_INVALID');
});

// 13. empty output remains not canonicalizable (unchanged eligibility gate).
test('13: empty output remains not canonicalizable', async () => {
  const t = setup('', multiple([report('a', 'r')]));
  await assert.rejects(t.decide());
  assert.equal(t.calls(), 0);
  assert.equal(eligibleForCanonicalization({ output: '', error: { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' } }), false);
});

// 14. depth > 0 remains ineligible for the AMBIGUOUS_DECISIONS path too.
test('14: depth > 0 remains ineligible', () => {
  assert.equal(eligibleForCanonicalization({ output: concat(report('a', 'r'), report('b', 'r2')), error: { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' }, depth: 1 }), false);
  assert.equal(eligibleForCanonicalization({ output: concat(report('a', 'r'), report('b', 'r2')), error: { code: 'PM_DECISION_PARSE_FAILED', parseSubreason: 'PM_DECISION_AMBIGUOUS_DECISIONS' }, depth: 0 }), true);
});

// 15. no recursion: an already-depth-1 decide() never invokes the canonicalizer, even for a multi-decision-eligible error.
test('15: no recursion for the multi-decision path', async () => {
  const d1 = report('a1', 'r1'); const d2 = report('a2', 'r2');
  const t = setup(concat(d1, d2), multiple([d1, d2]));
  await assert.rejects(t.decide({ canonicalizationDepth: 1 }));
  assert.equal(t.calls(), 0);
});

// Decode-layer guard: a MULTIPLE_DECISIONS wrapper is rejected outright when
// multi-decision mode was never requested (allowMultipleDecisions defaults
// to false) -- proves the capability cannot leak into any other subreason's
// existing 2-way contract.
test('decodeCanonicalizer rejects MULTIPLE_DECISIONS unless explicitly allowed', () => {
  const wrapper = multiple([report('a', 'r')]);
  assert.throws(() => decodeCanonicalizer(wrapper), /CANONICALIZER_INVALID_WRAPPER/);
  assert.doesNotThrow(() => decodeCanonicalizer(wrapper, { allowMultipleDecisions: true }));
  assert.throws(() => decodeCanonicalizer(JSON.stringify({ normalization_status: 'MULTIPLE_DECISIONS', canonical_candidates: [] }), { allowMultipleDecisions: true }), /CANONICALIZER_INVALID_WRAPPER/, 'empty candidates array must still fail closed');
});

// Backward compatibility: a non-AMBIGUOUS_DECISIONS subreason's NORMALIZED
// path is completely unaffected by the new forbidden-selection guard (no
// sourceDistinctSubstantiveCount is ever attached for any other subreason).
test('non-ambiguous subreasons are unaffected by the selection guard', async () => {
  const decision = report('a', 'r');
  const t = setup('{"type":"finish",', normalized(decision)); // PM_DECISION_JSON_INVALID, single candidate
  const resolved = await t.decide();
  assert.deepEqual(resolved, decision);
  const diag = canonicalizationDiagnostic(resolved);
  assert.equal(diag.state, 'CANONICALIZED_PARSE_PASS');
  assert.equal('candidates' in diag, false);
  assert.equal('forbidden_selection_detected' in diag, false);
});

test('canonicalization config/profile unchanged for the multi-decision path', () => {
  assert.equal(canonicalizationConfig({}).profileId, PRIMARY_CANONICALIZER);
});
