import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { analyze, ROOT, stability, csv, parseCsv, structuralReview, duplicateKeys, ratio } from './output-matrix-analysis.mjs';
import { observeCurrentParse } from './corpus-lib.mjs';
import { renderAudit } from './output-matrix-report.mjs';
import { extractAntigravityAssistantText } from '../../../src/session/antigravity-cli-session-bridge.mjs';

// Any accidental provider/process invocation fails this suite immediately.
globalThis.fetch = () => { throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = () => { throw new Error('OFFLINE_TEST_PROCESS_FORBIDDEN'); };
syncBuiltinESMExports();
function treeHash(dir) {
  const hash = createHash('sha256');
  function visit(path) { for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const file = join(path, e.name); if (e.isDirectory()) visit(file); else { hash.update(file); hash.update(readFileSync(file)); } } }
  visit(dir); return hash.digest('hex');
}
const rawRoot = join(ROOT, 'research/model-output-corpus/runs');
const rawBefore = treeHash(rawRoot), srcBefore = treeHash(join(ROOT, 'src'));
const result = await analyze();

test('154 identities and all independent denominators reconcile', () => {
  const { totals: t } = result.summary;
  assert.equal(result.rows.length, 154); assert.equal(new Set(result.rows.map(r => r.sample_id)).size, 154);
  assert.deepEqual([t.provider_success, t.provider_error, t.provider_unknown, t.assistant_present, t.parser_attempted, t.parser_pass, t.parser_fail, t.parser_not_attempted], [136, 18, 0, 136, 136, 114, 22, 18]);
  assert.equal(t.parser_pass + t.parser_fail + t.parser_not_attempted, t.total);
  assert.deepEqual(result.summary.sample_kinds, { BASELINE: 108, REPEAT: 46 });
});
test('skipped API outcomes and native Antigravity ERROR override summary labels only', () => {
  assert.equal(result.rows.filter(r => r.recorded_parser_state === 'FAIL' && r.current_parser_state === 'NOT_ATTEMPTED').length, 9);
  const agy = result.rows.find(r => r.sample_id === 'antigravity/gemini-3.6-flash-medium/medium/run-001');
  assert.equal(agy.provider_terminal_status, 'ERROR'); assert.equal(agy.terminal_response_bytes, 16286);
  assert.equal(agy.current_parser_state, 'NOT_ATTEMPTED');
  assert.throws(() => extractAntigravityAssistantText({ result: { status: 'ERROR', response: '{"type":"finish","output":"x"}' } }), { code: 'ANTIGRAVITY_RUN_FAILED' });
});
test('provider failures never become format failures; absent bytes stay unavailable', () => {
  assert(result.rows.filter(r => r.provider_terminal_status === 'ERROR').every(r => r.model_contract_anomaly === null && r.current_parser_state === 'NOT_ATTEMPTED'));
  assert(result.rows.filter(r => !r.assistant_file_present).every(r => r.assistant_output_bytes === null));
  assert.equal(result.summary.totals.extraction_mismatches, 0);
  assert.equal(result.rows.filter(r => r.extraction_check === 'MATCH').length, 136);
});
test('repeat directory ordinals preserve all three slots despite historical index=1', () => {
  assert.equal(result.repeats.length, 23);
  assert.equal(result.summary.integrity_reconciliation.filter(r => r.field === 'sample_index').length, 46);
  assert.deepEqual(result.summary.repeat_stability, { ONE_OFF_1_OF_3: 9, REPRODUCED_2_OF_3: 4, MIXED: 5, REPRODUCED_3_OF_3: 3, PROVIDER_BLOCKED: 2 });
  assert(result.repeats.every(r => r.sample_ids.length === 3 && r.sample_ids[1].endsWith('run-002') && r.sample_ids[2].endsWith('run-003')));
  assert.equal(result.summary.historical_repeat_stability.ONE_OFF_1_OF_3, 10);
});
test('stability is directional only through explicit slot outcomes, with missing evidence distinct', () => {
  const s = (i, terminal = 'SUCCESS', dialect = 'RAW_CANONICAL_JSON', parser = 'PASS') => ({ sample_index: i, provider_terminal_status: terminal, dialect, current_parser_state: parser });
  assert.equal(stability([s(1), s(2), s(3)]), 'REPRODUCED_3_OF_3');
  assert.equal(stability([s(1, 'ERROR'), s(2), s(3)]), 'REPRODUCED_2_OF_3');
  assert.equal(stability([s(1), s(2), s(3, 'SUCCESS', 'UNKNOWN', 'FAIL')]), 'ONE_OFF_1_OF_3');
  assert.equal(stability([s(1), s(2, 'ERROR'), s(3, 'ERROR')]), 'INSUFFICIENT_EXECUTION_EVIDENCE');
  assert.equal(stability([s(1), s(2)]), 'INSUFFICIENT_EXECUTION_EVIDENCE');
  assert.equal(stability([s(1, 'ERROR'), s(2, 'ERROR'), s(3, 'ERROR')]), 'PROVIDER_BLOCKED');
});
test('all CSV products round-trip identities, embedded JSON, commas, quotes and newlines', () => {
  for (const rows of [result.rows, result.repeats, result.dialects, result.summary.provider_failures]) assert.equal(parseCsv(csv(rows)).length, rows.length);
  const rows = [{ id: 'a,"b"\nc', value: 'Tiếng Việt', absent: null }];
  assert.deepEqual(parseCsv(csv(rows)), [{ ...rows[0], absent: '' }]);
  const reportRoot = join(ROOT, 'research/model-output-corpus/reports');
  for (const [name, rows] of [['four-connector-output-matrix.csv', result.rows], ['repeat-stability-matrix.csv', result.repeats], ['parser-dialect-acceptance-matrix.csv', result.dialects], ['provider-transport-failure-matrix.csv', result.summary.provider_failures]]) assert.equal(readFileSync(join(reportRoot, name), 'utf8'), csv(rows));
  assert.deepEqual(JSON.parse(readFileSync(join(reportRoot, 'four-connector-output-matrix-summary.json'), 'utf8')), result.summary);
});
test('deferred connectors and exact overlap are not fabricated', () => {
  assert.deepEqual([...new Set(result.rows.map(r => r.connector))], ['codex', 'antigravity', 'opencode', 'api/openrouter']);
  assert.equal(result.summary.exact_overlap_models, 0);
  assert.equal(result.summary.overlap_candidate_decisions.OVERLAP_IDENTITY_UNRESOLVED, 25);
  assert.match(result.summary.deferred_connectors['claude-code'], /NOT_COLLECTED.*QUOTA_UNAVAILABLE/);
  assert.match(result.summary.deferred_connectors.grok, /NOT_COLLECTED.*NO_ACTIVE_SUBSCRIPTION_PLAN/);
  assert(result.rows.every(r => r.reasoning_effective === null && r.structured_output_mode === 'NONE'));
});
test('PASS review detects real prose extraction but no changed fields or duplicate keys in decisions', () => {
  const passed = result.summary.structural_reviews.filter(r => r.parser_state === 'PASS');
  assert.equal(passed.length, 114); assert(passed.every(r => r.bounded_json_valid && r.contract_state === 'PASS'));
  assert(passed.every(r => r.changed_field_count === 0 && r.discarded_field_count === 0 && r.duplicate_key_count === 0));
  assert.equal(passed.filter(r => r.bounded_wrapper === 'PROSE_PREFIX_SINGLE_JSON_FENCE').length, 3);
  assert.equal(passed.filter(r => r.bounded_wrapper === 'SINGLE_JSON_FENCE').length, 9);
  assert.equal(result.summary.structural_reviews.filter(r => r.parser_state === 'FAIL' && r.bounded_json_valid).length, 0);
});
test('structural scanner never includes payload values and distinguishes wrapper classes', () => {
  const raw = '{"type":"finish","output":"synthetic-canary-secret","data":{}}';
  assert.equal(structuralReview(raw).whole_json_valid, true);
  assert.equal(structuralReview('```json\n' + raw + '\n```').bounded_wrapper, 'SINGLE_JSON_FENCE');
  assert.equal(structuralReview('prose```json\n' + raw + '\n```').bounded_wrapper, 'PROSE_PREFIX_SINGLE_JSON_FENCE');
  assert.equal(JSON.stringify(structuralReview(raw)).includes('synthetic-canary-secret'), false);
  assert.equal(duplicateKeys('{"x":1,"x":2,"n":{"x":3,"x":4},"a":[{"x":5}]}'), 2);
});
test('source-only adversarial probes characterize existing permissive parser, not corpus observations', async () => {
  const good = '{"type":"finish","output":"synthetic","data":{}}';
  for (const text of [good, '```json\n' + good + '\n```', 'prose ' + good, '{"unrelated":true} ' + good, '```python\n' + good + '\n```']) assert.equal((await observeCurrentParse(text)).outcome, 'PASS');
  assert.equal((await observeCurrentParse(good + good)).outcome, 'FAIL');
  assert.equal((await observeCurrentParse(good.slice(0, -1))).outcome, 'FAIL');
  assert.equal((await observeCurrentParse('{"type":"finish"}')).error_code, 'PM_DECISION_EMPTY_OUTPUT');
  const wrong = await observeCurrentParse('{"type":"finish","output":"x","data":[]}');
  assert.equal(wrong.outcome, 'PASS'); assert.equal(wrong.normalize_outcome, 'FAIL');
});
test('repeat generation deterministic; raw corpus and production remain byte-identical', async () => {
  assert.deepEqual(await analyze(), result);
  assert.equal(treeHash(rawRoot), rawBefore); assert.equal(treeHash(join(ROOT, 'src')), srcBefore);
});
test('reports have required structure and every generated percentage shows its denominator', () => {
  const report = readFileSync(join(ROOT, 'docs/audit/DSH_FOUR_CONNECTOR_OUTPUT_MATRIX_ANALYSIS_20260908.md'), 'utf8');
  const architecture = readFileSync(join(ROOT, 'docs/architecture/DSH_CANONICAL_PARSER_OUTPUT_NORMALIZATION_ARCHITECTURE_20260908.md'), 'utf8');
  assert.equal(report.replaceAll('\r\n', '\n'), renderAudit(result));
  assert.equal(renderAudit(result), renderAudit(result));
  for (let n = 1; n <= 20; n++) assert.match(report, new RegExp('^# ' + n + ' ', 'm'));
  for (let n = 1; n <= 15; n++) assert.match(report, new RegExp('Q' + n + '\\.'));
  for (const text of [report, architecture, JSON.stringify(result.summary)]) for (const m of text.matchAll(/\d+(?:\.\d+)?%/g)) assert.match(text.slice(Math.max(0, m.index - 40), m.index + m[0].length), /\d+ \/ \d+ = \d+(?:\.\d+)?%$/);
  assert.equal(ratio(0, 0), '0 / 0 = undefined');
});
