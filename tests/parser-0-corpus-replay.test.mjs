// PARSER-0 — historical corpus replay (offline, fixture/corpus-replay based).
//
// Primary regression truth set: the reconciled 154-row four-connector corpus
// (approved analysis commit 55c8f4c6d60d7dc985f2f46c621257507c8f5575).
// REQUIRED INVARIANTS:
//   154 total / 136 provider success / 18 provider error
//   136 parser attempted / 114 PASS / 22 FAIL / 18 NOT attempted
//   historical acceptance delta: 0 (114 PASS stay PASS, 22 FAIL stay FAIL)
// All 18 parser-not-attempted samples are explicitly verified as
// provider/transport/terminal failures with parser_attempted=false — never
// reclassified as model JSON parse failures. No provider, CLI, network or
// process execution: every row is replayed through the real production
// createCliPmDriver() boundary with a stubbed run() closure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, ROOT } from '../scripts/research/model-output-corpus/output-matrix-analysis.mjs';
import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';
import { computeDenominatorCounters, PARSER_0_LAYERS, PARSER_0_DIAGNOSTIC_VERSION } from '../src/pm/parser-0-diagnostics.mjs';
import { ApiBackendError, API_ERROR_CODES } from '../src/pm/api-backend/api-backend-errors.mjs';
import { AntigravityCliError } from '../src/session/antigravity-cli-session-bridge.mjs';

const productOf = (connector) => (connector === 'api/openrouter' ? 'api' : connector);

// Rebuilds the provider-failure cause from the APPROVED reconciliation facts
// (never from guessed diagnostics) so the replayed execution path matches the
// recorded transport truth for each of the 18 not-attempted samples.
function providerFailureFor(row) {
  const category = row.provider_failure_category;
  if (category === 'HTTP_402') return new ApiBackendError('API provider returned HTTP 402', API_ERROR_CODES.BILLING_FAILED, { httpStatus: 402 });
  if (category === 'HTTP_403') return new ApiBackendError('API provider returned HTTP 403', API_ERROR_CODES.FORBIDDEN, { httpStatus: 403 });
  if (category === 'TIMEOUT') return Object.assign(new Error('provider execution timed out'), { code: 'OPENCODE_TIMEOUT', assistantOutputPresent: false });
  if (category === 'CONTENT_FILTER_EMPTY') return new ApiBackendError('provider returned no usable assistant content', API_ERROR_CODES.EMPTY_RESPONSE, { finishReason: 'content_filter' });
  if (category === 'BODY_ABORT') return new ApiBackendError('network error reading API provider response body', API_ERROR_CODES.NETWORK_ERROR, { requestPhase: 'RESPONSE_BODY_READ', aborted: true });
  if (category === 'TERMINAL_ERROR_WITH_RESPONSE_PRESENT') return new AntigravityCliError('Antigravity run failed', { code: 'ANTIGRAVITY_RUN_FAILED', terminalResponsePresent: true, terminalResponseBytes: row.terminal_response_bytes });
  if (category === 'TERMINAL_ERROR_EMPTY') return new AntigravityCliError('Antigravity run failed', { code: 'ANTIGRAVITY_RUN_FAILED', terminalResponsePresent: false, terminalResponseBytes: null });
  return null;
}

// Replays ONE corpus row through the real production parse boundary with a
// stubbed run() closure — the exact seam the approved analysis itself uses
// (corpus-lib observeCurrentParse), extended here with a capturing observer
// so the PARSER-0 diagnostic of the REAL execution path can be asserted.
async function replayRow(row) {
  const attempted = row.current_parser_state !== 'NOT_ATTEMPTED';
  const text = attempted ? readFileSync(join(ROOT, 'research/model-output-corpus/runs', row.connector, row.run_relative_path, 'extracted-assistant.txt'), 'utf8') : '';
  const events = [];
  const observer = { layeredDiagnostic: (ctx, diagnostic) => events.push(diagnostic) };
  const failure = attempted ? null : providerFailureFor(row);
  assert.ok(attempted || failure, `row ${row.sample_id}: every not-attempted row must have a reconciled provider failure cause`);
  const driver = createCliPmDriver({
    profile: { id: 'parser-0-corpus-replay', product: productOf(row.connector), model: null },
    project: { id: 'corpus' },
    observer,
    run: attempted ? async () => text : async () => { throw failure; },
  });
  let error = null;
  let pmContractState = null;
  try {
    const decision = await driver.decide({ request: { id: 'parser-0-replay', objective: '', context: {} }, turn: 1, history: [] });
    try { normalizePmDecision(decision); pmContractState = 'PASS'; } catch { pmContractState = 'FAIL'; }
  } catch (cause) { error = cause; }
  const diagnostic = error?.layeredDiagnostic ?? events.at(-1) ?? null;
  assert.ok(diagnostic, `row ${row.sample_id}: the real execution path must always produce a layered diagnostic`);
  assert.equal(diagnostic.diagnostic_version, PARSER_0_DIAGNOSTIC_VERSION);
  assert.ok(JSON.stringify(diagnostic).length < 1024, 'diagnostics stay bounded and content-free');
  return { sample_id: row.sample_id, diagnostic, pmContractState, error };
}

test('154-row corpus replay: denominators reconcile exactly and acceptance delta is zero', async () => {
  const { rows, summary } = await analyze();
  // The approved analysis truth, recomputed from raw corpus evidence.
  assert.equal(summary.totals.total, 154);
  assert.equal(summary.totals.provider_success, 136);
  assert.equal(summary.totals.provider_error, 18);
  assert.equal(summary.totals.parser_attempted, 136);
  assert.equal(summary.totals.parser_pass, 114);
  assert.equal(summary.totals.parser_fail, 22);
  assert.equal(summary.totals.parser_not_attempted, 18);

  const records = [];
  for (const row of rows) records.push({ row, ...(await replayRow(row)) });

  // Denominator counters computed from the per-attempt facts alone (Goal H).
  // PM contract state is joined from the real normalizer verdict on each
  // accepted decision (the driver deliberately does not claim it).
  const counters = computeDenominatorCounters(records.map((r) => (r.pmContractState ? { ...r.diagnostic, pm_contract_state: r.pmContractState } : r.diagnostic)));
  assert.deepEqual(counters, {
    ALL_CAPTURED: 154,
    PROVIDER_TERMINAL_SUCCESS: 136,
    PROVIDER_TERMINAL_ERROR: 18,
    ASSISTANT_OUTPUT_PRESENT: 136,
    ASSISTANT_OUTPUT_ABSENT: 18,
    PARSER_ATTEMPTED: 136,
    PARSER_PASS: 114,
    PARSER_FAIL: 22,
    PARSER_NOT_ATTEMPTED: 18,
    PM_CONTRACT_PASS: 114,
    PM_CONTRACT_FAIL: 0,
    STEP_VALIDATION_PASS: 0,
    STEP_VALIDATION_FAIL: 0,
  });

  // ACCEPTANCE GATE A: zero acceptance delta across all 136 attempted rows.
  let delta = 0;
  for (const { row, diagnostic } of records) {
    if (row.current_parser_state === 'NOT_ATTEMPTED') continue;
    if (diagnostic.parser_state !== row.current_parser_state) delta += 1;
    assert.equal(diagnostic.parser_attempted, true, row.sample_id);
    assert.equal(diagnostic.assistant_output_present, true, row.sample_id);
    assert.equal(diagnostic.execution_state, 'SUCCESS', row.sample_id);
    assert.equal(diagnostic.pm_contract_state, 'NOT_EVALUATED', `${row.sample_id}: the driver never claims the PM contract verdict`);
    if (row.current_parser_state === 'FAIL') {
      assert.equal(diagnostic.parse_error_code, row.current_parser_error, row.sample_id);
      assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.PARSER, row.sample_id);
    }
  }
  assert.equal(delta, 0, 'historical parser verdicts must be IDENTICAL before and after PARSER-0');

  // The twelve FENCED_JSON samples (including the three prose-plus-fence
  // OpenCode cases) must still PASS — no PARSER-1 narrowing happened.
  const fenced = records.filter((r) => r.row.dialect === 'FENCED_JSON');
  assert.equal(fenced.length, 12);
  assert.equal(fenced.every((r) => r.diagnostic.parser_state === 'PASS'), true);
  const prosePrefix = records.filter((r) => (r.row.structural_review?.prose_prefix_bytes ?? 0) > 0);
  assert.equal(prosePrefix.length, 3);
  assert.equal(prosePrefix.every((r) => r.diagnostic.parser_state === 'PASS'), true);
});

test('all 18 parser-not-attempted samples are provider failures with parser_attempted=false', async () => {
  const { rows, summary } = await analyze();
  const notAttempted = summary.not_attempted_rows;
  assert.equal(notAttempted.length, 18);
  const expectedIds = new Set(notAttempted.map((r) => r.sample_id));
  const byId = new Map(rows.map((row) => [`${row.connector}/${row.run_relative_path}`, row]));
  const replayed = [];
  for (const [sampleId, row] of byId) {
    if (!expectedIds.has(sampleId)) continue;
    const { diagnostic } = await replayRow(row);
    replayed.push({ sampleId, category: row.provider_failure_category, diagnostic });
    // The REQUIRED PRINCIPLE: execution/availability failure, NOT parse failure.
    assert.equal(diagnostic.parser_attempted, false, sampleId);
    assert.equal(diagnostic.parser_state, 'NOT_ATTEMPTED', sampleId);
    assert.equal(diagnostic.execution_state, 'ERROR', sampleId);
    assert.equal(diagnostic.assistant_output_present, false, sampleId);
    assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION, sampleId);
    assert.equal(diagnostic.parse_error_code, null, `${sampleId}: no parse error may be synthesized for a provider failure`);
    // Category-specific typed facts survive on the diagnostic surface.
    if (row.provider_failure_category === 'HTTP_402') assert.equal(diagnostic.provider_http_status, 402, sampleId);
    if (row.provider_failure_category === 'HTTP_403') assert.equal(diagnostic.provider_http_status, 403, sampleId);
    if (row.provider_failure_category === 'CONTENT_FILTER_EMPTY') assert.equal(diagnostic.finish_reason, 'content_filter', sampleId);
    if (row.provider_failure_category === 'BODY_ABORT') assert.equal(diagnostic.request_phase, 'RESPONSE_BODY_READ', sampleId);
    if (row.provider_failure_category === 'TERMINAL_ERROR_WITH_RESPONSE_PRESENT') {
      assert.equal(diagnostic.terminal_response_present, true, sampleId);
      assert.equal(diagnostic.terminal_response_bytes, row.terminal_response_bytes, sampleId);
    }
    if (row.provider_failure_category === 'TERMINAL_ERROR_EMPTY') assert.equal(diagnostic.terminal_response_present, false, sampleId);
  }
  assert.equal(replayed.length, 18, 'every one of the 18 not-attempted samples is explicitly verified');
});

test('no corpus row ever means terminal error + no assistant output + parser actually failed', async () => {
  const { rows } = await analyze();
  for (const row of rows) {
    if (row.current_parser_state !== 'NOT_ATTEMPTED') continue;
    assert.equal(row.provider_terminal_status, 'ERROR', row.sample_id);
    assert.equal(row.assistant_output_present, false, row.sample_id);
    assert.equal(row.current_parser_error, null, row.sample_id);
  }
  // And the raw corpus was not mutated to make any of this pass.
  const input = JSON.parse(readFileSync(join(ROOT, 'research/model-output-corpus/reports/four-connector-analysis-input.json'), 'utf8'));
  assert.equal(input.rows.length, 154);
  assert.equal(input.row_count, 154);
  assert.equal(existsSync(join(ROOT, 'research/model-output-corpus/runs')), true);
});
