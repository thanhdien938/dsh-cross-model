// Offline analysis only. No provider runners, credentials, network or process execution.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { classifyDialect, observeCurrentParse, sha256OfBytes, verifyCanonicalProbe } from './corpus-lib.mjs';
import { collectRollupRows, rowsToCsv } from './four-connector-analysis-input.mjs';
import { normalizePmDecision } from '../../../src/pm/pm-contracts.mjs';
import { extractOpenCodeAssistantText, summarizeOpenCodeRun } from '../../../src/session/opencode-cli-session-bridge.mjs';
import { extractCodexAssistantText, summarizeCodexCliRun } from '../../../src/session/codex-cli-session-bridge.mjs';
import { extractAntigravityAssistantText, summarizeAntigravityCliRun } from '../../../src/session/antigravity-cli-session-bridge.mjs';
import { normalizeChatCompletionResponse } from '../../../src/pm/api-backend/api-openai-chat-protocol.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASE = 'cb01af1a9c4d6d81845014661afa94a2653ad702';
const REPORTS = 'research/model-output-corpus/reports';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const countBy = (rows, fn) => rows.reduce((out, row) => { const key = typeof fn === 'function' ? fn(row) : row[fn]; out[key ?? 'null'] = (out[key ?? 'null'] ?? 0) + 1; return out; }, {});
export const groupBy = (rows, fn) => rows.reduce((out, row) => { (out[fn(row)] ??= []).push(row); return out; }, {});
export const ratio = (n, d) => `${n} / ${d} = ${d ? (100 * n / d).toFixed(1) + '%' : 'undefined'}`;
export function csv(rows, fields = Object.keys(rows[0] ?? {})) {
  const cell = value => { const s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return [fields.join(','), ...rows.map(r => fields.map(k => cell(r[k])).join(','))].join('\n') + '\n';
}
export function parseCsv(text) {
  const records = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(cell); cell = ''; if (c === '\n') { records.push(row); row = []; } }
    else if (c !== '\r' || quoted) cell += c;
  }
  assert.equal(quoted, false); if (cell || row.length) { row.push(cell); records.push(row); }
  const fields = records.shift(); return records.map(r => { assert.equal(r.length, fields.length); return Object.fromEntries(fields.map((f, i) => [f, r[i]])); });
}

// Historical closure labels classified the minority of a 2:1 split as ONE_OFF,
// even if that minority was a PASS. Keep the definition explicit, with slot facts.
export function stability(samples) {
  const effective = samples.filter(r => r.provider_terminal_status === 'SUCCESS');
  if (samples.length !== 3 || new Set(samples.map(r => r.sample_index)).size !== 3) return 'INSUFFICIENT_EXECUTION_EVIDENCE';
  if (!effective.length) return 'PROVIDER_BLOCKED';
  if (effective.length === 1) return 'INSUFFICIENT_EXECUTION_EVIDENCE';
  const n = new Set(effective.map(r => `${r.dialect}|${r.current_parser_state}`)).size;
  if (effective.length === 2) return n === 1 ? 'REPRODUCED_2_OF_3' : 'MIXED';
  return n === 1 ? 'REPRODUCED_3_OF_3' : n === 2 ? 'ONE_OFF_1_OF_3' : 'MIXED';
}

// Structural review: never emits output text, JSON values or engine error excerpts.
export function structuralReview(text) {
  const trimmed = text.trim(); let payload = trimmed, wrapper = 'NONE';
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fence) { payload = fence[1]; wrapper = 'SINGLE_JSON_FENCE'; }
  const prefixedFence = !fence && /```json\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const prefixBytes = prefixedFence ? Buffer.byteLength(trimmed.slice(0, prefixedFence.index)) : 0;
  if (prefixedFence) { payload = prefixedFence[1]; wrapper = 'PROSE_PREFIX_SINGLE_JSON_FENCE'; }
  let value;
  try { value = JSON.parse(payload); } catch (error) {
    const message = String(error.message);
    return { whole_json_valid: false, bounded_wrapper: wrapper, syntax_diagnostic: /Unexpected end|Unterminated/.test(message) ? 'INCOMPLETE_JSON' : /control character/i.test(message) ? 'UNESCAPED_CONTROL_CHARACTER' : /escape/i.test(message) ? 'INVALID_ESCAPE' : 'JSON_SYNTAX_INVALID', syntax_position: Number(/position (\d+)/.exec(message)?.[1]) || null };
  }
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  let normalized = null, contract = 'PASS';
  try { normalized = normalizePmDecision(value); } catch { contract = 'FAIL'; }
  const discarded = object && normalized ? Object.keys(value).filter(k => !Object.hasOwn(normalized, k)) : [];
  const changed = object && normalized ? Object.keys(normalized).filter(k => JSON.stringify(normalized[k]) !== JSON.stringify(value[k])) : [];
  return { whole_json_valid: wrapper === 'NONE', bounded_json_valid: true, bounded_wrapper: wrapper, prose_prefix_bytes: prefixBytes, top_level: object ? 'OBJECT' : Array.isArray(value) ? 'ARRAY' : typeof value, decision_type_finish: value?.type === 'finish', output_nonempty_string: typeof value?.output === 'string' && !!value.output.trim(), data_plain_object: value?.data !== null && typeof value?.data === 'object' && !Array.isArray(value.data), contract_state: contract, discarded_field_count: discarded.length, changed_field_count: changed.length, duplicate_key_count: duplicateKeys(payload) };
}

// Walk valid JSON tokens, tracking keys per object; counts only, never field contents.
export function duplicateKeys(text) {
  let i = 0, duplicates = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const str = () => { const start = i++; while (i < text.length) { if (text[i++] === '\\') i++; else if (text[i - 1] === '"') break; } return JSON.parse(text.slice(start, i)); };
  const value = () => { ws(); if (text[i] === '{') { i++; ws(); const keys = new Set(); if (text[i] === '}') { i++; return; } while (i < text.length) { ws(); const key = str(); if (keys.has(key)) duplicates++; keys.add(key); ws(); assert.equal(text[i++], ':'); value(); ws(); if (text[i++] === '}') break; } }
    else if (text[i] === '[') { i++; ws(); if (text[i] === ']') { i++; return; } while (i < text.length) { value(); ws(); if (text[i++] === ']') break; } }
    else if (text[i] === '"') str(); else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; } };
  value(); return duplicates;
}

export function metrics(rows) {
  const pass = rows.filter(r => r.current_parser_state === 'PASS').length;
  const fail = rows.filter(r => r.current_parser_state === 'FAIL').length;
  return { total: rows.length, provider_success: rows.filter(r => r.provider_terminal_status === 'SUCCESS').length, provider_error: rows.filter(r => r.provider_terminal_status === 'ERROR').length, provider_unknown: rows.filter(r => r.provider_terminal_status === 'UNKNOWN').length, assistant_present: rows.filter(r => r.assistant_output_present).length, parser_attempted: pass + fail, parser_pass: pass, parser_fail: fail, parser_not_attempted: rows.filter(r => r.current_parser_state === 'NOT_ATTEMPTED').length, pass_per_attempt: ratio(pass, pass + fail), dialects: countBy(rows, 'dialect'), provider_failures: countBy(rows.filter(r => r.provider_failure_category), 'provider_failure_category'), extraction_diagnostic_rows: rows.filter(r => r.extraction_anomaly).length, extraction_mismatches: rows.filter(r => r.extraction_check === 'MISMATCH').length, effective_reasoning_known: rows.filter(r => r.reasoning_effective !== null).length };
}

export async function analyze(root = ROOT) {
  const inputPath = join(root, REPORTS, 'four-connector-analysis-input.json');
  const input = json(inputPath); const inputCsv = readFileSync(join(root, REPORTS, 'four-connector-analysis-input.csv'), 'utf8');
  assert.equal(input.rows.length, 154); assert.equal(input.row_count, 154);
  assert.deepEqual(input.rows, collectRollupRows());
  assert.equal(inputCsv.replaceAll('\r\n', '\n'), rowsToCsv(input.rows));
  assert.equal(parseCsv(inputCsv).length, 154);
  assert.equal(verifyCanonicalProbe(readFileSync, join(root, 'research/model-output-corpus/CANONICAL_PROBE_PROMPT.txt')).ok, true);
  const corrections = json(join(root, REPORTS, 'four-connector-offline-audit-metadata-corrections.json')).corrections;
  const overlap = json(join(root, REPORTS, 'api-openrouter-opencode-overlap-candidates.json'));
  assert.equal(overlap.exact_overlap_models.length, 0); assert.equal(overlap.overlap_invocations_planned, 0);
  const rows = [], reviews = [], integrity = [];
  for (const original of input.rows) {
    const r = { ...original, sample_index_recorded: original.sample_index, sample_index: Number(/run-(\d+)$/.exec(original.run_relative_path)[1]), sample_kind: original.sample_kind.toUpperCase() };
    const dir = join(root, 'research/model-output-corpus/runs', r.connector, r.run_relative_path);
    const m = json(join(dir, 'metadata.json')), o = json(join(dir, 'parse-observation.json'));
    const assistantFilePresent = existsSync(join(dir, 'extracted-assistant.txt'));
    const bytes = assistantFilePresent ? readFileSync(join(dir, 'extracted-assistant.txt')) : Buffer.alloc(0), text = bytes.toString('utf8');
    const id = `${r.connector}/${r.run_relative_path}`;
    assert.equal(m.prompt_sha256, '102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5'); assert.equal(m.prompt_bytes, 4112);
    if (m.assistant_output_bytes !== null) assert.equal(bytes.length, m.assistant_output_bytes, id);
    if (m.assistant_output_sha256) assert.equal(sha256OfBytes(bytes), m.assistant_output_sha256, id);
    assert.equal(classifyDialect(text).dialect, r.dialect, id);
    const rawPath = join(dir, r.connector === 'api/openrouter' ? 'raw-response.json' : 'raw-stdout.txt');
    const raw = existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : '';
    let summary = null, extracted = null, extractionCode = null, nativeStatus = null, responsePresent = null, responseBytes = null;
    try {
      if (r.connector === 'codex') { summary = summarizeCodexCliRun({ stdout: raw, code: m.process_exit_code }); extracted = extractCodexAssistantText(summary); }
      if (r.connector === 'opencode') { summary = summarizeOpenCodeRun({ stdout: raw, code: m.process_exit_code }); extracted = extractOpenCodeAssistantText(summary); }
      if (r.connector === 'antigravity') { summary = summarizeAntigravityCliRun({ stdout: raw, code: m.process_exit_code }); nativeStatus = summary.result?.status ?? null; responsePresent = typeof summary.result?.response === 'string' && !!summary.result.response.trim(); responseBytes = typeof summary.result?.response === 'string' ? Buffer.byteLength(summary.result.response) : null; extracted = extractAntigravityAssistantText(summary); }
      if (r.connector === 'api/openrouter' && raw.trim()) { const envelope = JSON.parse(raw); const body = typeof envelope.body_text === 'string' ? JSON.parse(envelope.body_text) : envelope; extracted = normalizeChatCompletionResponse(body).text; }
    } catch (error) { extractionCode = error.code ?? 'RAW_REPLAY_INVALID'; }
    const terminal = nativeStatus !== null ? nativeStatus === 'SUCCESS' ? 'SUCCESS' : 'ERROR' : /ERROR|FAILED/.test(r.provider_terminal_status ?? '') || m.invocation_failed ? 'ERROR' : /SUCCESS/.test(r.provider_terminal_status ?? '') ? 'SUCCESS' : 'UNKNOWN';
    const providerHttp = r.http_status ?? summary?.events?.find(e => e?.type === 'error')?.error?.data?.statusCode ?? null;
    let failure = null;
    if (terminal === 'ERROR') {
      failure = providerHttp === 402 ? 'HTTP_402' : providerHttp === 403 ? 'HTTP_403' : m.invocation_error_code?.endsWith('_TIMEOUT') ? 'TIMEOUT' : m.finish_reason === 'content_filter' ? 'CONTENT_FILTER_EMPTY' : m.transport_anomaly && /abort/i.test(m.transport_anomaly) ? 'BODY_ABORT' : nativeStatus === 'ERROR' && responsePresent ? 'TERMINAL_ERROR_WITH_RESPONSE_PRESENT' : nativeStatus === 'ERROR' ? 'TERMINAL_ERROR_EMPTY' : 'OTHER_PROVIDER_ERROR';
    }
    const historicalSkip = o.skipped === true || r.current_parser_outcome === 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT';
    if (historicalSkip) assert.equal(text.trim(), '', id);
    const observed = historicalSkip ? null : await observeCurrentParse(text, { product: r.connector === 'api/openrouter' ? 'api' : r.connector });
    if (observed) { assert.equal(observed.outcome, o.outcome, id); assert.equal(observed.error_code, o.error_code, id); }
    const state = observed?.outcome ?? 'NOT_ATTEMPTED';
    const review = text.trim() ? structuralReview(text) : null;
    const extractionCheck = extracted === null ? 'REFUSED_OR_UNAVAILABLE' : extracted === text ? 'MATCH' : 'MISMATCH';
    rows.push({ ...r, sample_id: id, provider_terminal_status_recorded: r.provider_terminal_status, provider_terminal_status: terminal, terminal_evidence: nativeStatus !== null ? 'RAW_ANTIGRAVITY_RESULT_STATUS' : r.connector === 'codex' ? 'PROCESS_EXIT_AND_RECORDED_SUCCESS' : 'RECORDED_ADAPTER_OR_PROCESS_STATUS', transport_status: m.invocation_error_code ?? (m.process_exit_code !== null ? `PROCESS_EXIT_${m.process_exit_code}` : r.http_status !== null ? `HTTP_${r.http_status}` : null), provider_http_status: providerHttp, native_terminal_status: nativeStatus, terminal_response_present: responsePresent, terminal_response_bytes: responseBytes, assistant_output_present: !!text.trim(), assistant_output_bytes: assistantFilePresent ? bytes.length : null, assistant_file_present: assistantFilePresent, current_parser_state: state, current_parser_error: state === 'FAIL' ? observed.error_code : null, current_parser_subreason: observed?.parse_subreason ?? null, historical_parser_error: r.current_parser_error, parser_skip_reason: historicalSkip ? 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT' : null, current_normalizer_state: observed?.normalize_outcome ?? null, repeat_stability_class: null, transport_anomaly: ['TIMEOUT', 'BODY_ABORT', 'TERMINAL_ERROR_WITH_RESPONSE_PRESENT', 'TERMINAL_ERROR_EMPTY'].includes(failure) ? failure : null, extraction_anomaly: r.extraction_anomaly, extraction_check: extractionCheck, extraction_replay_error: extractionCode, model_contract_anomaly: state === 'FAIL' && terminal === 'SUCCESS' ? r.dialect : null, provider_access_or_billing_block: failure === 'HTTP_402' ? 'BILLING_BLOCKED' : failure === 'HTTP_403' ? 'ACCESS_BLOCKED' : null, provider_failure_category: failure, invocation_error_code: m.invocation_error_code ?? null, provider_route: m.provider_route ?? null, recorded_parser_state: r.current_parser_outcome, structural_review: review });
    if (review) reviews.push({ sample_id: id, dialect: r.dialect, parser_state: state, ...review });
    if (r.sample_index !== r.sample_index_recorded) integrity.push({ sample_id: id, field: 'sample_index', recorded: r.sample_index_recorded, reconciled: r.sample_index, evidence: 'run directory ordinal; original metadata retained' });
    if (state !== r.current_parser_outcome && !(state === 'NOT_ATTEMPTED' && r.current_parser_outcome === 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT')) integrity.push({ sample_id: id, field: 'parser_state', recorded: r.current_parser_outcome, reconciled: state, evidence: 'parse-observation.json skipped=true; empty Layer B', closure_correction_present: corrections.some(c => c.connector === r.connector && c.run === r.run_relative_path) });
    if (nativeStatus === 'ERROR' && !/ERROR/.test(r.provider_terminal_status)) integrity.push({ sample_id: id, field: 'provider_terminal_status', recorded: r.provider_terminal_status, reconciled: 'ERROR', evidence: 'raw result.status=ERROR' });
  }
  assert.equal(new Set(rows.map(r => r.sample_id)).size, 154);
  const configKey = r => JSON.stringify([r.connector, r.model, r.reasoning_requested, r.structured_output_mode]);
  const repeats = Object.values(groupBy(rows, configKey)).filter(rs => rs.some(r => r.sample_kind === 'REPEAT')).map(rs => {
    rs.sort((a, b) => a.sample_index - b.sample_index); const label = stability(rs); for (const r of rs) r.repeat_stability_class = label;
    const first = rs[0]; const slot = r => `${r.provider_terminal_status}|${r.dialect}|${r.current_parser_state}`;
    // Reproduce the old algorithm from row facts, including its Antigravity gate omission.
    const historical = rs.map(r => ({ ...r, provider_terminal_status: r.provider_terminal_status_recorded === 'RUN_LEVEL_ANOMALY_NO_EXPLICIT_TERMINAL_FIELD' ? 'SUCCESS' : r.provider_terminal_status, current_parser_state: r.recorded_parser_state }));
    return { connector: first.connector, model: first.model, reasoning_requested: first.reasoning_requested, structured_output_mode: first.structured_output_mode, samples: rs.length, sample_ids: rs.map(r => r.sample_id), baseline: slot(rs[0]), run_002: slot(rs[1]), run_003: slot(rs[2]), historical_stability_class: stability(historical), repeat_stability_class: label, provider_success: rs.filter(r => r.provider_terminal_status === 'SUCCESS').length, parser_pass: rs.filter(r => r.current_parser_state === 'PASS').length, baseline_failure_recovered_run_002: rs[0].current_parser_state === 'FAIL' && rs[1].current_parser_state === 'PASS', baseline_failure_recovered_either_repeat: rs[0].current_parser_state === 'FAIL' && rs.slice(1).some(r => r.current_parser_state === 'PASS') };
  });
  const dialects = Object.entries(groupBy(rows, r => r.dialect)).map(([dialect, rs]) => ({ dialect, sample_count: rs.length, parser_pass: rs.filter(r => r.current_parser_state === 'PASS').length, parser_fail: rs.filter(r => r.current_parser_state === 'FAIL').length, parser_not_attempted: rs.filter(r => r.current_parser_state === 'NOT_ATTEMPTED').length, connectors: [...new Set(rs.map(r => r.connector))].sort(), models: [...new Set(rs.map(r => r.connector + ':' + r.model))].sort(), repeat_sample_states: countBy(rs.filter(r => r.sample_kind === 'REPEAT'), 'current_parser_state'), repeat_config_classes: countBy(repeats.filter(c => c.sample_ids.some(id => rs.some(r => r.sample_id === id))), 'repeat_stability_class') }));
  const paired = Object.values(groupBy(rows.filter(r => r.sample_kind === 'BASELINE'), r => `${r.connector}:${r.model}`)).filter(rs => rs.length === 2).map(rs => ({ connector: rs[0].connector, model: rs[0].model, observations: rs.map(r => ({ reasoning: r.reasoning_requested, dialect: r.dialect, parser: r.current_parser_state, terminal: r.provider_terminal_status })), both_success: rs.every(r => r.provider_terminal_status === 'SUCCESS'), dialect_differs: rs[0].dialect !== rs[1].dialect, parser_differs: rs[0].current_parser_state !== rs[1].current_parser_state }));
  const summary = { analysis_base_head: BASE, original_corpus_rows: input.rows.length, corpus_rows_reconciled: rows.length, input_json_sha256: sha256OfBytes(readFileSync(inputPath)), totals: metrics(rows), sample_kinds: countBy(rows, 'sample_kind'), historical_parser_states: countBy(input.rows, 'current_parser_outcome'), by_connector: Object.fromEntries(Object.entries(groupBy(rows, r => r.connector)).map(([c, rs]) => [c, { ...metrics(rs), sample_kinds: countBy(rs, 'sample_kind'), repeat_stability: countBy(repeats.filter(r => r.connector === c), 'repeat_stability_class'), reasoning: Object.fromEntries(Object.entries(groupBy(rs, r => r.reasoning_requested)).map(([effort, rr]) => [effort, metrics(rr)])) }])), repeat_configurations: repeats.length, repeat_stability: countBy(repeats, 'repeat_stability_class'), historical_repeat_stability: countBy(repeats, 'historical_stability_class'), dialects, reasoning_pairs: paired, integrity_reconciliation: integrity, not_attempted_rows: rows.filter(r => r.current_parser_state === 'NOT_ATTEMPTED').map(r => ({ sample_id: r.sample_id, recorded_parser_state: r.recorded_parser_state, provider_failure_category: r.provider_failure_category })), provider_failures: rows.filter(r => r.provider_failure_category).map(r => ({ sample_id: r.sample_id, category: r.provider_failure_category, transport_status: r.transport_status, provider_http_status: r.provider_http_status, terminal_response_present: r.terminal_response_present, terminal_response_bytes: r.terminal_response_bytes })), structural_reviews: reviews, exact_overlap_models: overlap.exact_overlap_models.length, overlap_candidate_decisions: countBy(overlap.decisions, r => r.decision), deferred_connectors: { 'claude-code': 'NOT_COLLECTED / DEFERRED_QUOTA_UNAVAILABLE', grok: 'NOT_COLLECTED / DEFERRED_NO_ACTIVE_SUBSCRIPTION_PLAN' }, policy: { offline: true, providers_invoked: false, raw_evidence_modified: false, production_code_changed: false, reasoning_content_included: false } };
  return { rows, repeats, dialects, summary };
}

export function writeArtifacts(result, root = ROOT) {
  const out = name => join(root, REPORTS, name);
  const { rows, repeats, dialects, summary } = result;
  writeFileSync(out('four-connector-output-matrix.csv'), csv(rows));
  writeFileSync(out('four-connector-output-matrix-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(out('parser-dialect-acceptance-matrix.csv'), csv(dialects));
  writeFileSync(out('repeat-stability-matrix.csv'), csv(repeats));
  writeFileSync(out('provider-transport-failure-matrix.csv'), csv(summary.provider_failures));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await analyze(); writeArtifacts(result);
  console.log(JSON.stringify({ totals: result.summary.totals, repeats: result.summary.repeat_stability, historical_repeats: result.summary.historical_repeat_stability, integrity: result.summary.integrity_reconciliation.length }, null, 2));
}
