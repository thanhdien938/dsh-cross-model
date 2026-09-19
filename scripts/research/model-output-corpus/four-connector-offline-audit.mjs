// DSH MODEL OUTPUT CORPUS — four-connector OFFLINE consistency audit.
//
// RESEARCH-ONLY observation tooling (closure PHASE 2). It re-reads every
// already-captured corpus sample and RECOMPUTES, from the stored artifacts:
//   - extracted-assistant byte count + SHA-256;
//   - research dialect classification (corpus-lib classifyDialect);
//   - current production parse observation (corpus-lib observeCurrentParse,
//     the REAL production parse boundary, read-only);
// and compares the recomputed values with the values recorded in each run's
// metadata.json / parse-observation.json.
//
// It NEVER rewrites raw artifacts, NEVER re-runs a provider, and NEVER
// "corrects" a discrepancy in place. Mismatches are reported as
// CORPUS_METADATA_MISMATCH rows; the caller decides any supplemental
// metadata correction record.
//
// Usage:
//   node four-connector-offline-audit.mjs            # audit + write report
//   node four-connector-offline-audit.mjs --json     # print JSON summary only

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sha256OfBytes,
  classifyDialect,
  observeCurrentParse,
} from './corpus-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs');
const REPORT_PATH = join(CORPUS_ROOT, 'reports', 'four-connector-offline-consistency-audit.md');
const JSON_PATH = join(CORPUS_ROOT, 'reports', 'four-connector-offline-consistency-audit.json');

const CONNECTORS = [
  { key: 'codex', runRoot: join(RUNS_ROOT, 'codex'), product: 'codex', terminalFields: 'derived' },
  { key: 'antigravity', runRoot: join(RUNS_ROOT, 'antigravity'), product: 'antigravity', terminalFields: 'derived' },
  { key: 'opencode', runRoot: join(RUNS_ROOT, 'opencode'), product: 'opencode', terminalFields: 'explicit' },
  { key: 'api/openrouter', runRoot: join(RUNS_ROOT, 'api', 'openrouter'), product: 'api', terminalFields: 'explicit' },
];

function listRunDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const modelDir of readdirSync(root)) {
    const modelPath = join(root, modelDir);
    if (!statSync(modelPath).isDirectory()) continue;
    for (const reasoningDir of readdirSync(modelPath)) {
      const reasoningPath = join(modelPath, reasoningDir);
      if (!statSync(reasoningPath).isDirectory()) continue;
      for (const runDir of readdirSync(reasoningPath)) {
        const runPath = join(reasoningPath, runDir);
        if (statSync(runPath).isDirectory() && runDir.startsWith('run-')) out.push({ relative: `${modelDir}/${reasoningDir}/${runDir}`, path: runPath });
      }
    }
  }
  return out;
}

function recordedTerminalStatus(metadata) {
  if (typeof metadata.provider_terminal_status === 'string') return metadata.provider_terminal_status;
  if (metadata.invocation_failed === true) return 'PROVIDER_TERMINAL_ERROR';
  if (metadata.invocation_failed === false && metadata.extraction_anomaly) return 'RECORDED_RUN_LEVEL_ANOMALY_NO_EXPLICIT_TERMINAL_FIELD';
  if (metadata.invocation_failed === false) return 'PROVIDER_TERMINAL_SUCCESS_IMPLIED';
  return 'UNRECORDED';
}

async function auditOneRun(connector, run) {
  const metadataPath = join(run.path, 'metadata.json');
  if (!existsSync(metadataPath)) {
    return { connector: connector.key, run: run.relative, status: 'AUDIT_SKIPPED_NO_METADATA' };
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const extractedPath = join(run.path, 'extracted-assistant.txt');
  const extractedBytesBuf = existsSync(extractedPath) ? readFileSync(extractedPath) : null;
  const extractedText = extractedBytesBuf === null ? null : extractedBytesBuf.toString('utf8');

  const recomputed = {
    assistant_output_bytes: extractedBytesBuf === null ? null : extractedBytesBuf.length,
    assistant_output_sha256: extractedBytesBuf === null ? null : sha256OfBytes(extractedBytesBuf),
    dialect_classification: null,
    dialect_detail: null,
  };
  if (extractedText !== null && extractedText.trim()) {
    const dialect = classifyDialect(extractedText);
    recomputed.dialect_classification = dialect.dialect;
    recomputed.dialect_detail = dialect.detail;
  } else {
    recomputed.dialect_classification = 'EMPTY';
  }

  // Layer C re-observation: only when there is real extracted text (the
  // baseline harnesses record NOT_ATTEMPTED when no assistant output exists).
  let recomputedParse = null;
  if (extractedText !== null && extractedText.trim()) {
    const observation = await observeCurrentParse(extractedText, { product: connector.product });
    recomputedParse = {
      outcome: observation.outcome,
      error_code: observation.error_code,
    };
  }

  const mismatches = [];
  const compare = (field, recorded, recomputedValue, { onlyIfRecordedNotNull = false } = {}) => {
    if (onlyIfRecordedNotNull && (recorded === null || recorded === undefined)) return;
    if (String(recorded) !== String(recomputedValue)) {
      mismatches.push({ field, recorded_value: recorded ?? null, recomputed_value: recomputedValue ?? null });
    }
  };

  // Byte/hash: metadata null + empty file is the established no-output
  // recording convention (extraction refused), not a mismatch.
  if (metadata.assistant_output_bytes !== null && metadata.assistant_output_bytes !== undefined) {
    compare('assistant_output_bytes', metadata.assistant_output_bytes, recomputed.assistant_output_bytes);
  } else if (recomputed.assistant_output_bytes !== null && recomputed.assistant_output_bytes > 0) {
    mismatches.push({ field: 'assistant_output_bytes', recorded_value: null, recomputed_value: recomputed.assistant_output_bytes });
  }
  if (metadata.assistant_output_sha256 !== null && metadata.assistant_output_sha256 !== undefined) {
    compare('assistant_output_sha256', metadata.assistant_output_sha256, recomputed.assistant_output_sha256);
  } else if (recomputed.assistant_output_sha256 !== null && recomputed.assistant_output_bytes > 0) {
    mismatches.push({ field: 'assistant_output_sha256', recorded_value: null, recomputed_value: recomputed.assistant_output_sha256 });
  }

  // Dialect: only comparable when the baseline actually classified a dialect
  // from non-empty output.
  if (metadata.dialect_classification && metadata.dialect_classification !== 'EMPTY' && recomputed.dialect_classification !== 'EMPTY') {
    compare('dialect_classification', metadata.dialect_classification, recomputed.dialect_classification);
  } else if (metadata.dialect_classification !== 'EMPTY' && metadata.dialect_classification !== null && recomputed.dialect_classification === 'EMPTY') {
    mismatches.push({ field: 'dialect_classification', recorded_value: metadata.dialect_classification, recomputed_value: 'EMPTY (stored extracted-assistant is empty/absent)' });
  }

  // Parse observation: compare recorded metadata outcome with recomputed.
  const recordedParseOutcome = metadata.current_parse_outcome;
  if (recomputedParse) {
    const recordedNormalized = recordedParseOutcome === 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT' ? 'NOT_RUN' : recordedParseOutcome;
    if (recordedNormalized !== recomputedParse.outcome) {
      mismatches.push({ field: 'current_parse_outcome', recorded_value: recordedParseOutcome, recomputed_value: recomputedParse.outcome });
    } else if (recomputedParse.outcome === 'FAIL') {
      compare('current_parse_error_code', metadata.current_parse_error_code, recomputedParse.error_code);
    }
  } else if (recordedParseOutcome === 'PASS' || recordedParseOutcome === 'FAIL') {
    // Distinguish a genuine parse-observation discrepancy from the recorded
    // baseline convention of writing the TRANSPORT error into
    // current_parse_error_code with outcome FAIL when the production parser
    // was never reached (empty Layer-B after a provider/adapter failure).
    // That is a metadata recording-convention issue, not evidence corruption;
    // it receives a metadata-only supplemental correction record.
    const transportErrorCode = metadata.invocation_error_code ?? metadata.extraction_anomaly ?? null;
    if (
      recordedParseOutcome === 'FAIL'
      && metadata.current_parse_error_code
      && transportErrorCode
      && String(metadata.current_parse_error_code) === String(transportErrorCode)
      && (metadata.invocation_failed === true || metadata.extraction_anomaly)
    ) {
      mismatches.push({
        field: 'current_parse_outcome',
        recorded_value: recordedParseOutcome,
        recomputed_value: 'NOT_RUN (production parser never reached; empty Layer-B downstream of provider/adapter failure)',
        classification: 'TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY',
        metadata_only_corrected_value: 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT',
      });
    } else {
      mismatches.push({ field: 'current_parse_outcome', recorded_value: recordedParseOutcome, recomputed_value: 'NOT_RUN (stored extracted-assistant is empty/absent)' });
    }
  }

  // parse-observation.json cross-check (when present).
  const parseObsPath = join(run.path, 'parse-observation.json');
  if (existsSync(parseObsPath) && recomputedParse) {
    try {
      const parseObs = JSON.parse(readFileSync(parseObsPath, 'utf8'));
      if (String(parseObs.outcome) !== String(recomputedParse.outcome)) {
        mismatches.push({ field: 'parse-observation.json:outcome', recorded_value: parseObs.outcome, recomputed_value: recomputedParse.outcome });
      }
      if (recomputedParse.outcome === 'FAIL' && String(parseObs.error_code ?? '') !== String(recomputedParse.error_code ?? '')) {
        mismatches.push({ field: 'parse-observation.json:error_code', recorded_value: parseObs.error_code ?? null, recomputed_value: recomputedParse.error_code ?? null });
      }
    } catch (error) {
      mismatches.push({ field: 'parse-observation.json', recorded_value: 'UNPARSEABLE', recomputed_value: String(error?.message ?? error) });
    }
  }

  return {
    connector: connector.key,
    run: run.relative,
    status: mismatches.length ? 'CORPUS_METADATA_MISMATCH' : 'CONSISTENT',
    model: metadata.model ?? null,
    reasoning: metadata.reasoning_requested ?? null,
    sample_index: metadata.sample_index ?? null,
    recorded: {
      assistant_output_bytes: metadata.assistant_output_bytes ?? null,
      assistant_output_sha256: metadata.assistant_output_sha256 ?? null,
      dialect_classification: metadata.dialect_classification ?? null,
      current_parse_outcome: metadata.current_parse_outcome ?? null,
      current_parse_error_code: metadata.current_parse_error_code ?? null,
      provider_terminal_status: recordedTerminalStatus(metadata),
      collector_capture_status: metadata.collector_capture_status ?? null,
      invocation_failed: metadata.invocation_failed ?? null,
      invocation_error_code: metadata.invocation_error_code ?? null,
      extraction_anomaly_code: metadata.extraction_anomaly?.code ?? null,
      http_status: metadata.http_status ?? null,
      process_exit_code: metadata.process_exit_code ?? null,
      finish_reason: metadata.finish_reason ?? null,
      transport_anomaly: metadata.transport_anomaly ?? null,
    },
    recomputed: {
      ...recomputed,
      parse: recomputedParse,
    },
    mismatches,
  };
}

// --- Special observation checks (closure PHASE 2, "offline questions") ------

function antigravityTerminalEnvelopeCheck() {
  const runDir = join(RUNS_ROOT, 'antigravity', 'gemini-3.6-flash-medium', 'medium', 'run-001');
  if (!existsSync(runDir)) return { present: false };
  const eventsPath = join(runDir, 'raw-events.jsonl');
  if (!existsSync(eventsPath)) return { present: false };
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const resultEvent = [...events].reverse().find((event) => event?.event === 'result');
  const result = resultEvent?.result ?? null;
  const responseString = typeof result?.response === 'string' ? result.response : null;
  let responseDialect = null;
  if (responseString) {
    try {
      responseDialect = classifyDialect(JSON.parse(responseString) && responseString ? responseString : responseString).dialect;
    } catch {
      responseDialect = classifyDialect(responseString).dialect;
    }
  }
  const metadata = JSON.parse(readFileSync(join(runDir, 'metadata.json'), 'utf8'));
  return {
    present: true,
    terminal_result_status: result?.status ?? null,
    terminal_response_present: Boolean(responseString),
    terminal_response_bytes: responseString === null ? null : Buffer.byteLength(responseString, 'utf8'),
    terminal_response_dialect_from_raw: responseDialect,
    extractor_recorded_assistant_bytes: metadata.assistant_output_bytes,
    extractor_recorded_parse_outcome: metadata.current_parse_outcome,
    extractor_extraction_anomaly: metadata.extraction_anomaly?.code ?? null,
    observation: 'raw terminal envelope contains the previously recorded complete response while production extraction refuses the non-SUCCESS terminal status',
  };
}

function providerErrorDownstreamCheck(allResults) {
  const rows = [];
  for (const result of allResults) {
    if (result.status === 'AUDIT_SKIPPED_NO_METADATA') continue;
    const dialect = result.recomputed?.dialect_classification ?? result.recorded?.dialect_classification ?? null;
    if (!['EMPTY', 'TRUNCATED'].includes(dialect)) continue;
    const providerFailed = result.recorded.invocation_failed === true
      || ['PROVIDER_TERMINAL_ERROR', 'ERROR', 'FAILED'].includes(result.recorded.provider_terminal_status)
      || Boolean(result.recorded.extraction_anomaly_code);
    rows.push({
      connector: result.connector,
      run: result.run,
      dialect,
      provider_terminal_status: result.recorded.provider_terminal_status,
      invocation_failed: result.recorded.invocation_failed,
      invocation_error_code: result.recorded.invocation_error_code,
      extraction_anomaly_code: result.recorded.extraction_anomaly_code,
      classification: providerFailed
        ? 'EMPTY_OR_TRUNCATED_IS_DOWNSTREAM_OF_PROVIDER_TERMINAL_FAILURE'
        : 'NO_EXPLICIT_PROVIDER_TERMINAL_FAILURE_RECORDED',
    });
  }
  return rows;
}

function opencodeDialectParserMapping(allResults) {
  const byKey = {};
  for (const result of allResults) {
    if (result.connector !== 'opencode' || result.status === 'AUDIT_SKIPPED_NO_METADATA') continue;
    const dialect = result.recomputed?.dialect_classification ?? 'EMPTY';
    if (dialect === 'RAW_CANONICAL_JSON') continue;
    const key = `${dialect} -> ${result.recomputed?.parse?.outcome ?? 'NOT_RUN'}`;
    byKey[key] = byKey[key] ?? [];
    byKey[key].push(`${result.model}/${result.reasoning}`);
  }
  return Object.entries(byKey).map(([mapping, runs]) => ({ mapping, count: runs.length, runs }));
}

async function main() {
  const results = [];
  for (const connector of CONNECTORS) {
    const runs = listRunDirs(connector.runRoot);
    for (const run of runs) {
      results.push(await auditOneRun(connector, run));
    }
  }

  const mismatches = results.filter((r) => r.status === 'CORPUS_METADATA_MISMATCH');
  const auditStatus = mismatches.length === 0 ? 'PASS' : 'FAIL';
  const audited = results.filter((r) => r.status !== 'AUDIT_SKIPPED_NO_METADATA');

  // Metadata-only supplemental correction record (closure PHASE 2 policy):
  // for mismatches classified TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL the only
  // dispute is the recorded parse outcome; the correction is recorded in a NEW
  // supplemental file — historical metadata.json / raw artifacts are NOT
  // modified.
  const metadataOnlyCorrections = mismatches.flatMap((r) => r.mismatches
    .filter((m) => m.classification === 'TRANSPORT_ERROR_RECORDED_AS_PARSE_FAIL_METADATA_ONLY')
    .map((m) => ({
      correction_record: 'CORPUS_METADATA_CORRECTION',
      classification: m.classification,
      connector: r.connector,
      model: r.model,
      reasoning: r.reasoning,
      run: r.run,
      field: m.field,
      recorded_value: m.recorded_value,
      recomputed_value: m.recomputed_value,
      corrected_value: m.metadata_only_corrected_value,
      rationale: 'recorded FAIL carries the upstream transport/adapter error code (identical to invocation_error_code/extraction_anomaly); the production parser was never reached because extracted-assistant is empty downstream of the provider failure — the per-run parse-observation.json already records skipped=true',
      historical_files_modified: false,
    })));
  const correctionsPath = join(CORPUS_ROOT, 'reports', 'four-connector-offline-audit-metadata-corrections.json');
  if (metadataOnlyCorrections.length) {
    writeFileSync(correctionsPath, `${JSON.stringify({ generated_utc: new Date().toISOString(), correction_count: metadataOnlyCorrections.length, corrections: metadataOnlyCorrections }, null, 2)}\n`, 'utf8');
  }

  const mismatchRows = mismatches.flatMap((r) => r.mismatches.map((m) => `### CORPUS_METADATA_MISMATCH\n\n- connector: ${r.connector}\n- model: ${r.model}\n- reasoning: ${r.reasoning}\n- run: ${r.run}\n- field: ${m.field}\n- recorded value: \`${JSON.stringify(m.recorded_value)}\`\n- recomputed value: \`${JSON.stringify(m.recomputed_value)}\`${m.classification ? `\n- classification: ${m.classification}` : ''}\n${m.metadata_only_corrected_value ? `- metadata-only corrected value: \`${m.metadata_only_corrected_value}\` (supplemental record; historical files untouched)\n` : ''}`)).join('\n');

  // Async re-parse for the OpenRouter Haiku special check (exact Layer-B bytes).
  const haikuSpecial = [];
  for (const reasoning of ['low', 'high']) {
    const runDir = join(RUNS_ROOT, 'api', 'openrouter', 'anthropic-claude-haiku-4.5', reasoning, 'run-001');
    const extractedPath = join(runDir, 'extracted-assistant.txt');
    if (!existsSync(extractedPath)) {
      haikuSpecial.push({ reasoning, status: 'NO_STORED_LAYER_B' });
      continue;
    }
    const bytes = readFileSync(extractedPath);
    const text = bytes.toString('utf8');
    const parse = await observeCurrentParse(text, { product: 'api' });
    haikuSpecial.push({
      reasoning,
      layer_b_bytes: bytes.length,
      layer_b_sha256: sha256OfBytes(bytes),
      recorded_dialect: JSON.parse(readFileSync(join(runDir, 'metadata.json'), 'utf8')).dialect_classification,
      recomputed_dialect: classifyDialect(text).dialect,
      current_parser_outcome: parse.outcome,
      current_parser_error_code: parse.error_code,
    });
  }

  const summary = {
    generated_utc: new Date().toISOString(),
    audit_status: auditStatus,
    samples_audited: audited.length,
    samples_skipped_no_metadata: results.length - audited.length,
    mismatch_count: mismatches.length,
    by_connector: Object.fromEntries(CONNECTORS.map((c) => [
      c.key,
      {
        audited: audited.filter((r) => r.connector === c.key).length,
        consistent: audited.filter((r) => r.connector === c.key && r.status === 'CONSISTENT').length,
        mismatched: audited.filter((r) => r.connector === c.key && r.status === 'CORPUS_METADATA_MISMATCH').length,
      },
    ])),
    mismatches,
    special_checks: {
      openrouter_claude_haiku_4_5_fenced_json_parser_recheck: haikuSpecial,
      antigravity_gemini_3_6_flash_medium_terminal_envelope: antigravityTerminalEnvelopeCheck(),
      opencode_non_raw_dialect_to_parser_outcome_mapping: opencodeDialectParserMapping(results),
      provider_error_downstream_classification: providerErrorDownstreamCheck(results),
    },
    policy: {
      raw_artifacts_modified: false,
      providers_invoked: false,
      discrepancies_silently_corrected: false,
    },
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const matrix = audited.map((r) => `| ${r.connector} | ${r.run} | ${r.recorded.provider_terminal_status} | ${r.recorded.dialect_classification} | ${r.recomputed.dialect_classification} | ${r.recorded.current_parse_outcome} | ${r.recomputed.parse?.outcome ?? 'NOT_RUN'} | ${r.status} |`).join('\n');

  const report = `# DSH MODEL OUTPUT CORPUS — FOUR-CONNECTOR OFFLINE CONSISTENCY AUDIT

- Generated: ${summary.generated_utc}
- Mode: OFFLINE (no provider invocation; stored artifacts only)
- Audit status: ${auditStatus}
- Samples audited: ${summary.samples_audited} (skipped without metadata: ${summary.samples_skipped_no_metadata})
- Mismatches: ${summary.mismatch_count}

## Per-connector totals

| connector | audited | consistent | mismatched |
| --- | --- | --- | --- |
${Object.entries(summary.by_connector).map(([key, v]) => `| ${key} | ${v.audited} | ${v.consistent} | ${v.mismatched} |`).join('\n')}

## Recomputation method

For every stored sample the audit recomputed from disk (never from metadata):

1. extracted-assistant.txt byte count and SHA-256;
2. research dialect classification via the shared research classifier;
3. current production parse observation via the REAL production parse boundary
   (read-only, observation mode);
and compared these against the recorded metadata.json / parse-observation.json
values. No raw artifact was rewritten and no discrepancy was silently
corrected.

## Full sample matrix

| connector | run | provider terminal (recorded) | dialect (recorded) | dialect (recomputed) | parse (recorded) | parse (recomputed) | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
${matrix}

## Mismatches

${mismatchRows || 'none'}

## Explicit offline questions reconfirmed

### 1. OpenRouter Claude Haiku 4.5 — FENCED_JSON dialect vs current parser

Re-run of the CURRENT production parser (offline, unmodified) against the exact preserved Layer-B bytes:

| reasoning | layer-B bytes | layer-B sha256 | dialect (recorded) | dialect (recomputed) | current parser outcome | error code |
| --- | --- | --- | --- | --- | --- | --- |
${haikuSpecial.map((r) => `| ${r.reasoning} | ${r.layer_b_bytes} | ${r.layer_b_sha256} | ${r.recorded_dialect} | ${r.recomputed_dialect} | ${r.current_parser_outcome} | ${r.current_parser_error_code ?? 'n/a'} |`).join('\n')}

Observation only — parser behavior was NOT changed.

### 2. Antigravity gemini-3.6-flash-medium — terminal envelope vs extraction

${JSON.stringify(summary.special_checks.antigravity_gemini_3_6_flash_medium_terminal_envelope, null, 2)}

### 3. OpenCode — non-RAW dialect labels vs parser outcomes

${summary.special_checks.opencode_non_raw_dialect_to_parser_outcome_mapping.map((m) => `- \`${m.mapping}\`: ${m.count} sample(s) — ${m.runs.join(', ')}`).join('\n') || 'none'}

### 4. Provider-error samples — EMPTY/TRUNCATED downstream classification

${summary.special_checks.provider_error_downstream_classification.map((r) => `- ${r.connector} ${r.run}: dialect=${r.dialect}, provider_terminal_status=${r.provider_terminal_status}, invocation_failed=${r.invocation_failed}, extraction_anomaly=${r.extraction_anomaly_code ?? 'none'} → ${r.classification}`).join('\n') || 'no EMPTY/TRUNCATED samples'}

## Policy attestations

- RAW_ARTIFACTS_MODIFIED: NO
- PROVIDERS_INVOKED: NO
- DISCREPANCIES_SILENTLY_CORRECTED: NO
`;

  writeFileSync(REPORT_PATH, report, 'utf8');
  writeFileSync(JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`AUDIT_STATUS: ${auditStatus}`);
  console.log(`SAMPLES_AUDITED: ${summary.samples_audited}`);
  console.log(`MISMATCH_COUNT: ${summary.mismatch_count}`);
  console.log(`REPORT: ${REPORT_PATH}`);
}

await main();
