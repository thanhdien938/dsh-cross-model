// DSH MODEL OUTPUT CORPUS — four-connector ANALYSIS-INPUT rollup (closure
// PHASE 12). Machine-readable, conclusion-free sample rollup for the owner/PM
// and the NEXT matrix-analysis phase.
//
// Every row carries observation metadata only. There is NO analytical
// conclusion column, NO connector ranking, NO compatibility verdict, and NO
// raw chain-of-thought anywhere in the output.
//
// Usage:
//   node four-connector-analysis-input.mjs            # write JSON + CSV
//   node four-connector-analysis-input.mjs --stdout   # print JSON only

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs');
const JSON_PATH = join(CORPUS_ROOT, 'reports', 'four-connector-analysis-input.json');
const CSV_PATH = join(CORPUS_ROOT, 'reports', 'four-connector-analysis-input.csv');

export const ROLLUP_FIELDS = Object.freeze([
  'connector',
  'connector_version',
  'provider_family',
  'model',
  'requested_model',
  'response_model',
  'sample_kind',
  'sample_index',
  'reasoning_requested',
  'reasoning_effective',
  'structured_output_mode',
  'provider_terminal_status',
  'http_status',
  'process_exit_code',
  'finish_reason',
  'assistant_output_bytes',
  'assistant_output_sha256',
  'dialect',
  'current_parser_outcome',
  'current_parser_error',
  'transport_anomaly',
  'extraction_anomaly',
  'repeat_candidate',
  'selection_source',
  'exact_overlap_identity_if_any',
  'run_relative_path',
]);

const CONNECTORS = [
  { key: 'codex', runRoot: join(RUNS_ROOT, 'codex') },
  { key: 'antigravity', runRoot: join(RUNS_ROOT, 'antigravity') },
  { key: 'opencode', runRoot: join(RUNS_ROOT, 'opencode') },
  { key: 'api/openrouter', runRoot: join(RUNS_ROOT, 'api', 'openrouter') },
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
        if (statSync(runPath).isDirectory() && /^run-\d+$/.test(runDir)) out.push({ path: runPath, relative: `${modelDir}/${reasoningDir}/${runDir}` });
      }
    }
  }
  return out;
}

function recordedTerminalStatus(metadata) {
  if (typeof metadata.provider_terminal_status === 'string') return metadata.provider_terminal_status;
  if (metadata.invocation_failed === true) return 'PROVIDER_TERMINAL_ERROR';
  if (metadata.invocation_failed === false && metadata.extraction_anomaly) return 'RUN_LEVEL_ANOMALY_NO_EXPLICIT_TERMINAL_FIELD';
  if (metadata.invocation_failed === false) return 'PROVIDER_TERMINAL_SUCCESS_IMPLIED';
  return null;
}

export function buildRollupRow(metadata, { connector, runRelativePath } = {}) {
  const transportAnomaly = metadata.transport_anomaly ?? null;
  const extractionAnomalyRaw = metadata.extraction_anomaly ?? null;
  return {
    connector,
    connector_version: metadata.connector_version ?? null,
    provider_family: metadata.provider_family ?? metadata.provider ?? null,
    model: metadata.model ?? null,
    requested_model: metadata.requested_model ?? metadata.model ?? null,
    response_model: metadata.response_model ?? null,
    sample_kind: metadata.sample_kind ?? 'baseline',
    sample_index: metadata.sample_index ?? null,
    reasoning_requested: metadata.reasoning_requested ?? null,
    reasoning_effective: metadata.reasoning_effective ?? null,
    structured_output_mode: metadata.structured_output_mode ?? null,
    provider_terminal_status: recordedTerminalStatus(metadata),
    http_status: metadata.http_status ?? null,
    process_exit_code: metadata.process_exit_code ?? null,
    finish_reason: metadata.finish_reason ?? null,
    assistant_output_bytes: metadata.assistant_output_bytes ?? null,
    assistant_output_sha256: metadata.assistant_output_sha256 ?? null,
    dialect: metadata.dialect_classification ?? null,
    current_parser_outcome: metadata.current_parse_outcome ?? null,
    current_parser_error: metadata.current_parse_error_code ?? null,
    transport_anomaly: transportAnomaly == null ? null : (typeof transportAnomaly === 'string' ? transportAnomaly : JSON.stringify(transportAnomaly)),
    extraction_anomaly: extractionAnomalyRaw == null ? null : (typeof extractionAnomalyRaw === 'string' ? extractionAnomalyRaw : (extractionAnomalyRaw.code ?? JSON.stringify(extractionAnomalyRaw))),
    repeat_candidate: metadata.repeat_candidate ?? null,
    selection_source: Array.isArray(metadata.selection_source) ? metadata.selection_source.join('+') : (metadata.selection_source ?? null),
    exact_overlap_identity_if_any: null,
    run_relative_path: runRelativePath ?? null,
  };
}

export function collectRollupRows() {
  const rows = [];
  for (const connector of CONNECTORS) {
    for (const run of listRunDirs(connector.runRoot)) {
      const metadataPath = join(run.path, 'metadata.json');
      if (!existsSync(metadataPath)) continue;
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      rows.push(buildRollupRow(metadata, { connector: connector.key, runRelativePath: run.relative }));
    }
  }
  return rows;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows) {
  const header = ROLLUP_FIELDS.join(',');
  const lines = rows.map((row) => ROLLUP_FIELDS.map((field) => csvEscape(row[field])).join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

function main() {
  const rows = collectRollupRows();
  const summary = {
    generated_utc: new Date().toISOString(),
    purpose: 'analysis-ready corpus rollup for the NEXT four-connector output-matrix analysis phase; observation metadata only',
    row_count: rows.length,
    by_connector: Object.fromEntries(CONNECTORS.map((c) => [c.key, rows.filter((r) => r.connector === c.key).length])),
    policy: {
      raw_chain_of_thought_included: false,
      analytical_conclusion_columns: false,
      connector_ranking_included: false,
      production_certification_included: false,
    },
    rows,
  };
  if (process.argv.includes('--stdout')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  writeFileSync(JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(CSV_PATH, rowsToCsv(rows), 'utf8');
  console.log(`ROWS=${rows.length}`);
  console.log(`JSON=${JSON_PATH}`);
  console.log(`CSV=${CSV_PATH}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
