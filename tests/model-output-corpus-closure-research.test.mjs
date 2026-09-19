// Focused deterministic tests for the four-connector corpus CLOSURE tooling
// (research-only). No live provider calls, no production code touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseOpenRouterSlug,
  evaluateOverlapCandidate,
} from '../scripts/research/model-output-corpus/openrouter-opencode-exact-overlap.mjs';
import {
  ROLLUP_FIELDS,
  buildRollupRow,
  rowsToCsv,
} from '../scripts/research/model-output-corpus/four-connector-analysis-input.mjs';
import { REPEAT_PLANS } from '../scripts/research/model-output-corpus/four-connector-closure-reports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCRIPTS = join(REPO_ROOT, 'scripts', 'research', 'model-output-corpus');

const CATALOGUE = [
  { id: 'z-ai/glm-5.3' },
  { id: 'z-ai/glm-5.3:batch' },
  { id: 'z-ai/glm-5.2' },
  { id: 'z-ai/glm-5.3-flash' },
  { id: 'openai/gpt-5.6-luna' },
  { id: 'openai/gpt-5.6-sol' },
  { id: 'x-ai/grok-4.6' },
  { id: 'moonshotai/kimi-k2.7-code' },
];

const ELIGIBLE_OPENCODE_MODEL = {
  slug: 'opencode-go/grok-4.6',
  id: 'grok-4.6',
  provider_id: 'opencode-go',
  cost_classification: 'PAID_OR_STANDARD',
  invocation_eligible: true,
};

function runRepeatGuard(script, args) {
  try {
    execFileSync('node', [join(SCRIPTS, script), 'repeat', ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: '' };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter slug parsing
// ---------------------------------------------------------------------------

test('parseOpenRouterSlug splits vendor/model and isolates route variants', () => {
  assert.deepEqual(parseOpenRouterSlug('z-ai/glm-5.3'), { vendor: 'z-ai', explicitModel: 'glm-5.3', routeVariant: null });
  assert.deepEqual(parseOpenRouterSlug('z-ai/glm-5.3:batch').routeVariant, 'batch');
  assert.equal(parseOpenRouterSlug('no-slash'), null);
  assert.equal(parseOpenRouterSlug('/leading'), null);
});

// ---------------------------------------------------------------------------
// Exact-overlap matcher — rejects name similarity, requires vendor evidence
// ---------------------------------------------------------------------------

test('matcher rejects merely-similar model names (family/version drift)', () => {
  for (const lookalike of ['glm-5.4', 'kimi-k2.6', 'gpt-5.6-terra']) {
    const decision = evaluateOverlapCandidate({ ...ELIGIBLE_OPENCODE_MODEL, id: lookalike, slug: `opencode-go/${lookalike}` }, CATALOGUE);
    assert.equal(decision.decision, 'NO_NAME_IDENTITY_MATCH_ON_OPENROUTER', lookalike);
  }
});

test('matcher refuses an EXACT name match when vendor identity evidence is absent', () => {
  const decision = evaluateOverlapCandidate(ELIGIBLE_OPENCODE_MODEL, CATALOGUE);
  assert.equal(decision.decision, 'OVERLAP_IDENTITY_UNRESOLVED');
  assert.match(decision.reason, /NO upstream vendor identity evidence/);
  assert.deepEqual(decision.name_identity_matches, ['x-ai/grok-4.6']);
});

test('matcher confirms exact identity only with matching explicit vendor evidence', () => {
  const decision = evaluateOverlapCandidate(
    { ...ELIGIBLE_OPENCODE_MODEL, upstream_vendor_identity_evidence: { vendor: 'x-ai', source: 'synthetic-test-evidence' } },
    CATALOGUE,
  );
  assert.equal(decision.decision, 'OVERLAP_EXACT_IDENTITY_CONFIRMED');
  assert.deepEqual(decision.openrouter_exact_slugs, ['x-ai/grok-4.6']);
});

test('matcher rejects exact name match whose vendor evidence disagrees with the OpenRouter vendor', () => {
  const decision = evaluateOverlapCandidate(
    { ...ELIGIBLE_OPENCODE_MODEL, upstream_vendor_identity_evidence: { vendor: 'z-ai', source: 'synthetic-test-evidence' } },
    CATALOGUE,
  );
  assert.equal(decision.decision, 'OVERLAP_IDENTITY_UNRESOLVED');
});

test('matcher skips models already sampled in the CORE_VENDOR baseline under exact identity', () => {
  const decision = evaluateOverlapCandidate(
    { ...ELIGIBLE_OPENCODE_MODEL, id: 'glm-5.3', slug: 'opencode-go/glm-5.3', upstream_vendor_identity_evidence: { vendor: 'z-ai', source: 'synthetic-test-evidence' } },
    CATALOGUE,
    { coreVendorSlugs: ['z-ai/glm-5.3'] },
  );
  assert.equal(decision.decision, 'OVERLAP_SKIPPED_ALREADY_IN_CORE_VENDOR_BASELINE');
});

test('matcher skips OpenCode models that are not eligible PAID_OR_STANDARD', () => {
  const decision = evaluateOverlapCandidate({ ...ELIGIBLE_OPENCODE_MODEL, cost_classification: 'FREE', invocation_eligible: false }, CATALOGUE);
  assert.equal(decision.decision, 'OVERLAP_SKIPPED_NOT_ELIGIBLE_OPENCODE');
});

// ---------------------------------------------------------------------------
// Analysis-input rollup — identity preservation, conclusion-free columns
// ---------------------------------------------------------------------------

test('rollup row preserves sample identity fields verbatim', () => {
  const row = buildRollupRow({
    connector_version: 'codex-cli 0.153.4',
    model: 'gpt-5.6-luna',
    reasoning_requested: 'low',
    assistant_output_sha256: 'deadbeef',
    assistant_output_bytes: 15479,
    dialect_classification: 'TRUNCATED',
    current_parse_outcome: 'FAIL',
    current_parse_error_code: 'PM_DECISION_PARSE_FAILED',
    sample_kind: 'repeat',
    selection_source: ['CORE_VENDOR', 'REPEAT_CONFIRMATION'],
  }, { connector: 'codex', runRelativePath: 'gpt-5.6-luna/low/run-002' });
  assert.equal(row.connector, 'codex');
  assert.equal(row.model, 'gpt-5.6-luna');
  assert.equal(row.assistant_output_sha256, 'deadbeef');
  assert.equal(row.assistant_output_bytes, 15479);
  assert.equal(row.dialect, 'TRUNCATED');
  assert.equal(row.current_parser_outcome, 'FAIL');
  assert.equal(row.current_parser_error, 'PM_DECISION_PARSE_FAILED');
  assert.equal(row.sample_kind, 'repeat');
  assert.equal(row.selection_source, 'CORE_VENDOR+REPEAT_CONFIRMATION');
  assert.equal(row.run_relative_path, 'gpt-5.6-luna/low/run-002');
  assert.equal(row.exact_overlap_identity_if_any, null);
});

test('rollup field set contains no analytical-conclusion columns', () => {
  const forbidden = /verdict|ranking|certif|compatib|better|score|recommend/i;
  for (const field of ROLLUP_FIELDS) assert.doesNotMatch(field, forbidden, field);
});

test('rollup CSV keeps header order and escapes embedded commas', () => {
  const csv = rowsToCsv([buildRollupRow({ model: 'a,b', dialect_classification: 'X' }, { connector: 'codex', runRelativePath: 'm/r/run-001' })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], ROLLUP_FIELDS.join(','));
  assert.ok(lines[1].includes('"a,b"'));
});

// ---------------------------------------------------------------------------
// Repeat plan guards — blocked configurations never scheduled
// ---------------------------------------------------------------------------

test('repeat plans exclude access-blocked Muse and billing-blocked fable-5.1 configurations', () => {
  const allPlanned = Object.values(REPEAT_PLANS).flat();
  for (const [model] of allPlanned) {
    assert.doesNotMatch(model, /muse/i, 'Muse access-blocked models must never be scheduled');
    assert.doesNotMatch(model, /fable/i, 'fable-5.1 billing-blocked models must never be scheduled');
  }
  assert.equal(allPlanned.length, 23); // configurations (1 codex + 3 antigravity + 10 opencode + 9 openrouter); 46 live invocations at 2 samples each
});

// ---------------------------------------------------------------------------
// Repeat run-numbering guards — run-001 never overwritten (fails closed
// BEFORE any provider invocation; safe deterministic child-process test)
// ---------------------------------------------------------------------------

test('codex repeat refuses --run=run-001 without invoking any provider', () => {
  const result = runRepeatGuard('codex-baseline.mjs', ['--run=run-001', '--model=gpt-5.6-luna', '--reasoning=low']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /got --run=run-001/);
});

test('codex repeat refuses configurations outside the baseline plan', () => {
  const result = runRepeatGuard('codex-baseline.mjs', ['--run=run-002', '--model=not-a-baseline-model', '--reasoning=low']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /no baseline configuration matches/);
});

// ---------------------------------------------------------------------------
// Committed analysis-input dataset sanity (identity preservation on disk)
// ---------------------------------------------------------------------------

test('committed four-connector-analysis-input.json preserves unique sample identities and row count', () => {
  const path = join(REPO_ROOT, 'research', 'model-output-corpus', 'reports', 'four-connector-analysis-input.json');
  assert.ok(existsSync(path), 'analysis-input JSON must exist');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.rows.length, parsed.row_count);
  const identities = new Set(parsed.rows.map((r) => `${r.connector}|${r.run_relative_path}`));
  assert.equal(identities.size, parsed.rows.length, 'every sample row must have a unique connector+run identity');
  for (const row of parsed.rows) {
    assert.ok(row.connector, 'connector recorded');
    assert.ok(row.run_relative_path?.startsWith('run-') || /run-\d+$/.test(row.run_relative_path ?? ''), 'run path recorded');
    assert.equal(row.exact_overlap_identity_if_any, null, 'no overlap invocation happened, so no overlap identity may be claimed');
  }
});

test('closure policy artifacts exist and closure report declares deferred connectors', () => {
  const reports = join(REPO_ROOT, 'research', 'model-output-corpus', 'reports');
  for (const name of [
    'four-connector-offline-consistency-audit.md',
    'codex-repeat-confirmation-report.md',
    'antigravity-repeat-confirmation-report.md',
    'opencode-repeat-confirmation-report.md',
    'api-openrouter-repeat-confirmation-report.md',
    'api-openrouter-opencode-overlap-supplement-report.md',
    'FOUR_CONNECTOR_CORPUS_COLLECTION_CLOSURE.md',
  ]) {
    assert.ok(existsSync(join(reports, name)), `${name} must exist`);
  }
  const closure = readFileSync(join(reports, 'FOUR_CONNECTOR_CORPUS_COLLECTION_CLOSURE.md'), 'utf8');
  assert.match(closure, /CLAUDE_CODE_COLLECTION_STATUS: DEFERRED_QUOTA_UNAVAILABLE/);
  assert.match(closure, /GROK_COLLECTION_STATUS: DEFERRED_NO_ACTIVE_SUBSCRIPTION_PLAN/);
  assert.match(closure, /READY_FOR_FOUR_CONNECTOR_OUTPUT_MATRIX_ANALYSIS: YES/);
  assert.doesNotMatch(closure, /parser should|we recommend|best connector|certified for production/i);
});
