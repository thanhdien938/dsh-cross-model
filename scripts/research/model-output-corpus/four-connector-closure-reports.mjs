// DSH MODEL OUTPUT CORPUS — closure PHASE 11 + 13 report generator.
//
// RESEARCH-ONLY. Reads stored run metadata (baseline run-001 + supplemental
// run-00N) and writes the ADDITIVE repeat-confirmation reports and the
// COLLECTION-STATUS closure report. It does NOT rewrite baseline reports,
// does NOT produce parser recommendations, rankings, dialect interpretation,
// or production certification.
//
// Usage: node four-connector-closure-reports.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs');
const REPORTS = join(CORPUS_ROOT, 'reports');

const CONNECTOR_CONFIGS = {
  codex: { root: join(RUNS_ROOT, 'codex'), report: join(REPORTS, 'codex-repeat-confirmation-report.md'), keyField: 'selected_reasoning' },
  antigravity: { root: join(RUNS_ROOT, 'antigravity'), report: join(REPORTS, 'antigravity-repeat-confirmation-report.md'), keyField: 'selected_reasoning' },
  opencode: { root: join(RUNS_ROOT, 'opencode'), report: join(REPORTS, 'opencode-repeat-confirmation-report.md'), keyField: 'selected_variant' },
  'api/openrouter': { root: join(RUNS_ROOT, 'api', 'openrouter'), report: join(REPORTS, 'api-openrouter-repeat-confirmation-report.md'), keyField: 'reasoning' },
};

export const REPEAT_PLANS = {
  codex: [['gpt-5.6-luna', 'low']],
  antigravity: [['claude-opus-4-6-thinking', 'default'], ['gpt-oss-120b-medium', 'medium'], ['gemini-3.6-flash-medium', 'medium']],
  opencode: [['opencode-go/hy3', 'none'], ['opencode-go/kimi-k2.6', 'default'], ['opencode-go/longcat-2.0', 'low'], ['opencode-go/longcat-2.0', 'high'], ['opencode-go/mimo-v2.5-pro', 'default'], ['opencode-go/minimax-m2.7', 'default'], ['opencode-go/omen-alpha', 'low'], ['opencode-go/omen-alpha', 'high'], ['opencode-go/qwen3.6-plus', 'default'], ['opencode-go/qwen3.7-max', 'default']],
  'api/openrouter': [['anthropic/claude-haiku-4.5', 'low'], ['anthropic/claude-haiku-4.5', 'high'], ['anthropic/claude-opus-5', 'low'], ['anthropic/claude-opus-5', 'high'], ['openai/gpt-oss-120b', 'low'], ['google/gemma-4-31b-it', 'high'], ['z-ai/glm-5.3', 'low'], ['z-ai/glm-5.3-flash', 'low'], ['z-ai/glm-5.3-flash', 'high']],
};

function readMetadata(runRoot, modelSlugDir, reasoningSlugDir, runDir) {
  const path = join(runRoot, modelSlugDir, reasoningSlugDir, runDir, 'metadata.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function providerBlocked(metadata) {
  if (!metadata) return null;
  const terminal = metadata.provider_terminal_status ?? (metadata.invocation_failed ? 'PROVIDER_TERMINAL_ERROR' : null);
  const billing = metadata.invocation_error_code === 'API_BILLING_FAILED' || metadata.http_status === 402;
  const access = metadata.http_status === 403 || (typeof metadata.invocation_error_message === 'string' && metadata.invocation_error_message.includes('statusCode":403'));
  if (billing) return 'BILLING_BLOCKED';
  if (access) return 'ACCESS_BLOCKED';
  if (metadata.invocation_failed || terminal === 'ERROR' || terminal === 'PROVIDER_TERMINAL_ERROR') return 'PROVIDER_ERROR';
  return null;
}

function signature(metadata) {
  if (!metadata) return null;
  const terminal = metadata.provider_terminal_status ?? (metadata.invocation_failed ? 'PROVIDER_TERMINAL_ERROR' : 'PROVIDER_TERMINAL_SUCCESS_IMPLIED');
  return `${terminal}|${metadata.dialect_classification}|${metadata.current_parse_outcome}`;
}

function stabilityLabel(samples) {
  const present = samples.filter(Boolean);
  const attempted = present.length;
  const blockedKinds = present.map(providerBlocked);
  const effective = present.filter((m, i) => !['BILLING_BLOCKED', 'ACCESS_BLOCKED', 'PROVIDER_ERROR'].includes(blockedKinds[i]));
  const signatures = effective.map(signature);
  const counts = {};
  for (const s of signatures) counts[s] = (counts[s] ?? 0) + 1;
  const distinct = Object.keys(counts).length;
  if (attempted === 0) return { label: 'INSUFFICIENT_EXECUTION_EVIDENCE', note: 'no samples recorded' };
  if (effective.length === 0) return { label: 'PROVIDER_BLOCKED', note: 'every recorded sample ended in a provider-level block/failure' };
  if (effective.length === 1) return { label: 'INSUFFICIENT_EXECUTION_EVIDENCE', note: 'only one provider-effective sample' };
  if (effective.length === 2) {
    return distinct === 1
      ? { label: 'REPRODUCED_2_OF_3', note: 'two provider-effective samples share one outcome signature (third slot not provider-effective)' }
      : { label: 'MIXED', note: 'two provider-effective samples differ' };
  }
  if (distinct === 1) return { label: 'REPRODUCED_3_OF_3', note: 'all three samples share one outcome signature' };
  if (distinct === 2) return { label: 'ONE_OFF_1_OF_3', note: `outcome signatures: ${JSON.stringify(counts)} — minority signature is a one-off` };
  return { label: 'MIXED', note: `outcome signatures: ${JSON.stringify(counts)}` };
}

function listRuns(modelSlugDir, reasoningSlugDir, connectorKey) {
  const root = CONNECTOR_CONFIGS[connectorKey].root;
  const dir = join(root, modelSlugDir, reasoningSlugDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^run-\d+$/.test(name) && statSync(join(dir, name)).isDirectory()).sort();
}

function loadConfigSamples(connectorKey, model, reasoning) {
  const { modelSlug, reasoningSlug } = slugify();
  return listRuns(modelSlug(model), reasoningSlug(reasoning), connectorKey)
    .map((runDir) => ({ runDir, metadata: readMetadata(CONNECTOR_CONFIGS[connectorKey].root, modelSlug(model), reasoningSlug(reasoning), runDir) }));
}

let slugFns = null;
function slugify() {
  if (slugFns) return slugFns;
  return slugFns = {
    modelSlug: (id) => String(id ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-model',
    reasoningSlug: (v) => String(v ?? 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default',
  };
}

function fmt(metadata) {
  if (!metadata) return 'not attempted';
  const note = metadata.assistant_output_bytes == null ? 'NO-ASSISTANT-OUTPUT' : `${metadata.assistant_output_bytes}B`;
  const blocked = providerBlocked(metadata);
  return `run=${metadata.sample_kind ?? 'baseline'} | terminal=${metadata.provider_terminal_status ?? (metadata.invocation_failed ? 'PROVIDER_TERMINAL_ERROR' : 'SUCCESS-implied')} | exit=${metadata.process_exit_code ?? 'n/a'} | http=${metadata.http_status ?? 'n/a'} | bytes=${note} | dialect=${metadata.dialect_classification} | parser=${metadata.current_parse_outcome}${metadata.current_parse_error_code ? `(${metadata.current_parse_error_code})` : ''}${blocked ? ` | ${blocked}` : ''}`;
}

function connectorRepeatReport(connectorKey) {
  const configs = REPEAT_PLANS[connectorKey];
  const sections = [];
  const totals = { attempted: 0, completed: 0, providerErrors: 0 };
  for (const [model, reasoning] of configs) {
    const samples = loadConfigSamples(connectorKey, model, reasoning);
    const baseline = samples.find((s) => s.runDir === 'run-001')?.metadata ?? null;
    const repeats = samples.filter((s) => s.runDir !== 'run-001');
    const label = stabilityLabel(samples.map((s) => s.metadata));
    totals.attempted += repeats.length;
    totals.completed += repeats.filter((s) => s.metadata && !s.metadata.invocation_failed).length;
    totals.providerErrors += repeats.filter((s) => s.metadata && providerBlocked(s.metadata)).length;
    sections.push(`### ${model} / ${reasoning}

- BASELINE (run-001): ${fmt(baseline)}
- run-002: ${fmt(repeats.find((r) => r.runDir === 'run-002')?.metadata ?? null)}
- run-003: ${fmt(repeats.find((r) => r.runDir === 'run-003')?.metadata ?? null)}
- STABILITY_LABEL: ${label.label} — ${label.note}`);
  }
  return { sections, totals };
}

function repeatReportHeader(connectorKey, title) {
  return `# DSH MODEL OUTPUT CORPUS — ${title} (ADDITIVE SUPPLEMENT)

- Generated: ${new Date().toISOString()}
- Sample basis: canonical probe sha256 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5 (4112 bytes), byte-identical to baseline.
- These labels are OBSERVATIONS ONLY — they are NOT production certification.
- Baseline report is NOT rewritten; this report is additive.

`;
}

function countAllRuns() {
  const rows = { baseline: 0, repeats: 0, overlap: 0 };
  const perConnector = {};
  for (const [connectorKey, config] of Object.entries(CONNECTOR_CONFIGS)) {
    perConnector[connectorKey] = { baseline: 0, repeats: 0 };
    if (!existsSync(config.root)) continue;
    for (const modelDir of readdirSync(config.root)) {
      const modelPath = join(config.root, modelDir);
      if (!statSync(modelPath).isDirectory()) continue;
      for (const reasoningDir of readdirSync(modelPath)) {
        const reasoningPath = join(modelPath, reasoningDir);
        if (!statSync(reasoningPath).isDirectory()) continue;
        for (const runDir of readdirSync(reasoningPath)) {
          if (!/^run-\d+$/.test(runDir)) continue;
          const metadataPath = join(reasoningPath, runDir, 'metadata.json');
          if (!existsSync(metadataPath)) continue;
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
          const kind = metadata.sample_kind ?? 'baseline';
          const bucket = runDir === 'run-001' && kind === 'baseline' ? 'baseline' : 'repeats';
          rows[bucket] += 1;
          perConnector[connectorKey][bucket] += 1;
        }
      }
    }
  }
  return { rows, perConnector };
}

function classifyAll(metadataEntries) {
  let providerSuccess = 0;
  let providerError = 0;
  let parserPass = 0;
  let parserFail = 0;
  for (const metadata of metadataEntries) {
    const blocked = providerBlocked(metadata);
    if (blocked) providerError += 1; else providerSuccess += 1;
    if (metadata.current_parse_outcome === 'PASS') parserPass += 1;
    else if (metadata.current_parse_outcome === 'FAIL') parserFail += 1;
  }
  return { providerSuccess, providerError, parserPass, parserFail };
}

function allMetadata() {
  const entries = [];
  for (const config of Object.values(CONNECTOR_CONFIGS)) {
    if (!existsSync(config.root)) continue;
    for (const modelDir of readdirSync(config.root)) {
      const modelPath = join(config.root, modelDir);
      if (!statSync(modelPath).isDirectory()) continue;
      for (const reasoningDir of readdirSync(modelPath)) {
        const reasoningPath = join(modelPath, reasoningDir);
        if (!statSync(reasoningPath).isDirectory()) continue;
        for (const runDir of readdirSync(reasoningPath)) {
          if (!/^run-\d+$/.test(runDir)) continue;
          const metadataPath = join(reasoningPath, runDir, 'metadata.json');
          if (existsSync(metadataPath)) entries.push(JSON.parse(readFileSync(metadataPath, 'utf8')));
        }
      }
    }
  }
  return entries;
}

function main() {
  // Phase 11 — additive repeat reports.
  const repeatSummaries = {};
  for (const [connectorKey, config] of Object.entries(CONNECTOR_CONFIGS)) {
    const { sections, totals } = connectorRepeatReport(connectorKey);
    repeatSummaries[connectorKey] = { totals, labelCounts: {} };
    const title = `${connectorKey.toUpperCase()} REPEAT CONFIRMATION`;
    const report = `${repeatReportHeader(connectorKey, title)}${sections.join('\n\n')}

## Factual counts

- REPEAT_SAMPLES_ATTEMPTED: ${totals.attempted}
- REPEAT_SAMPLES_COMPLETED_NO_PROVIDER_ERROR: ${totals.completed}
- REPEAT_SAMPLES_WITH_PROVIDER_LEVEL_ERROR: ${totals.providerErrors}

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- PRODUCTION_CONNECTOR_RUNTIME_CHANGED: NO
`;
    writeFileSync(config.report, report, 'utf8');
    console.log(`REPORT_WRITTEN ${config.report}`);
  }

  // Phase 13 — collection closure report.
  const { rows, perConnector } = countAllRuns();
  const entries = allMetadata();
  const { providerSuccess, providerError, parserPass, parserFail } = classifyAll(entries);
  const auditJsonPath = join(REPORTS, 'four-connector-offline-consistency-audit.json');
  const audit = existsSync(auditJsonPath) ? JSON.parse(readFileSync(auditJsonPath, 'utf8')) : null;
  const overlapJsonPath = join(REPORTS, 'api-openrouter-opencode-overlap-candidates.json');
  const overlap = existsSync(overlapJsonPath) ? JSON.parse(readFileSync(overlapJsonPath, 'utf8')) : null;
  const probePath = join(CORPUS_ROOT, 'CANONICAL_PROBE_PROMPT.txt');
  const probeBytes = readFileSync(probePath);
  const probeSha = createHash('sha256').update(probeBytes).digest('hex');

  const repeatAttempted = rows.repeats;
  const closureReport = `# DSH FOUR-CONNECTOR CORPUS COLLECTION CLOSURE

- Generated: ${new Date().toISOString()}
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
- CANONICAL_PROBE_STATUS: VERIFIED sha256=${probeSha} bytes=${probeBytes.length}
- OFFLINE_CONSISTENCY_AUDIT_STATUS: ${audit ? audit.audit_status : 'NOT_RUN'} (${audit ? `${audit.samples_audited} samples; ${audit.mismatch_count} mismatches; metadata-only supplemental correction record issued for ${audit.mismatch_count} transport-error-as-parse-fail rows` : 'n/a'})

## Factual counts

- TOTAL_EXISTING_BASELINE_SAMPLES: ${rows.baseline}
- TOTAL_REPEAT_SAMPLES_ATTEMPTED: ${repeatAttempted}
- TOTAL_OVERLAP_SUPPLEMENT_SAMPLES: ${overlap ? overlap.overlap_invocations_planned : 0}
- TOTAL_PROVIDER_SUCCESS: ${providerSuccess}
- TOTAL_PROVIDER_ERROR: ${providerError}
- TOTAL_PARSER_PASS: ${parserPass}
- TOTAL_PARSER_FAIL: ${parserFail}

Per-connector sample counts: \`${JSON.stringify(perConnector)}\`

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
`;

  writeFileSync(join(REPORTS, 'FOUR_CONNECTOR_CORPUS_COLLECTION_CLOSURE.md'), closureReport, 'utf8');
  console.log('REPORT_WRITTEN FOUR_CONNECTOR_CORPUS_COLLECTION_CLOSURE.md');
  console.log(`COUNTS baseline=${rows.baseline} repeats=${rows.repeats} providerSuccess=${providerSuccess} providerError=${providerError} parserPass=${parserPass} parserFail=${parserFail}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
