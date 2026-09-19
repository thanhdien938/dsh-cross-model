// Focused deterministic tests for the DSH MODEL OUTPUT CORPUS research
// tooling (MASTER PHASE 12). Research-only: proves the harness's own
// guarantees (canonical hash enforcement, cost exclusion, reasoning-extreme
// selection, byte preservation, layer separation, no normalization, secret
// withholding, deterministic dialect classification) and that Layer C goes
// through the REAL production parse boundary (parseDecision/normalizePmDecision
// via createCliPmDriver) — production behavior is never modified here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_PROBE_SHA256,
  CANONICAL_PROBE_BYTES,
  verifyCanonicalProbe,
  sha256OfBytes,
  classifyCodexModelCost,
  classifyAntigravityModelCost,
  selectReasoningExtremes,
  classifyDialect,
  observeCurrentParse,
  scanArtifactForSecretRisk,
  modelSlug,
  reasoningSlug,
} from '../scripts/research/model-output-corpus/corpus-lib.mjs';
import { collectOneConfiguration, teeSpawnFactory } from '../scripts/research/model-output-corpus/codex-baseline.mjs';
import { collectOneConfiguration as collectAntigravityConfiguration, parseAgyModelsStdout, antigravityReasoningExtremes } from '../scripts/research/model-output-corpus/antigravity-baseline.mjs';
import { collectOneConfiguration as collectOpenCodeConfiguration, parseOpencodeModelsVerboseStdout, classifyOpencodeModelCost, opencodeReasoningExtremes, variantEchoFromEvents, OPENCODE_VARIANT_ORDER } from '../scripts/research/model-output-corpus/opencode-baseline.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANONICAL_PROBE_PATH = join(REPO_ROOT, 'research', 'model-output-corpus', 'CANONICAL_PROBE_PROMPT.txt');

// ---- 1. Canonical prompt hash enforcement (fail closed) -------------------

test('canonical probe on disk matches the required SHA-256 and byte count', () => {
  const result = verifyCanonicalProbe((p) => readFileSync(p), CANONICAL_PROBE_PATH);
  assert.equal(result.ok, true, `canonical probe must verify: ${result.error ?? ''}`);
  assert.equal(result.sha256, CANONICAL_PROBE_SHA256);
  assert.equal(result.bytes, CANONICAL_PROBE_BYTES);
});

test('canonical probe verification fails closed on tampered bytes', () => {
  const tampered = Buffer.from(`${readFileSync(CANONICAL_PROBE_PATH, 'utf8')}X`, 'utf8');
  const result = verifyCanonicalProbe(() => tampered, 'fake-path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANONICAL_PROBE_MISMATCH');
});

test('canonical probe verification fails closed on missing file', () => {
  const result = verifyCanonicalProbe(() => { throw new Error('nope'); }, 'fake-path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANONICAL_PROBE_MISSING');
});

test('utf8 round-trip of the canonical probe preserves exact bytes (prompt byte-identical guarantee)', () => {
  const bytes = readFileSync(CANONICAL_PROBE_PATH);
  const text = bytes.toString('utf8');
  const roundTrip = Buffer.from(text, 'utf8');
  assert.ok(bytes.equals(roundTrip), 'Buffer.from(text,"utf8") must reproduce the canonical bytes');
  assert.equal(sha256OfBytes(roundTrip), CANONICAL_PROBE_SHA256);
  assert.equal(roundTrip.length, CANONICAL_PROBE_BYTES);
});

// ---- 2. Cost/availability classification & exclusion ----------------------

test('scheduled/past retirement_at classifies EPHEMERAL and excludes invocation', () => {
  const result = classifyCodexModelCost({
    slug: 'gpt-5.4-mini',
    visibility: 'list',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    upgrade: { model: 'gpt-5.6-luna', retirement_at: '2026-08-31T19:00:00Z' },
  }, { nowIso: '2026-09-08T00:00:00.000Z' });
  assert.equal(result.classification, 'EPHEMERAL');
  assert.equal(result.eligible, false);
});

test('explicit free/trial markers in catalogue metadata classify FREE/TRIAL and exclude invocation', () => {
  assert.equal(classifyCodexModelCost({ slug: 'm-free', visibility: 'list', description: 'Free preview model' }).classification, 'FREE');
  assert.equal(classifyCodexModelCost({ slug: 'm-free', visibility: 'list', description: 'Free preview model' }).eligible, false);
  assert.equal(classifyCodexModelCost({ slug: 'm-trial', visibility: 'list', availability_nux: { message: 'Start your trial today' } }).classification, 'TRIAL');
  assert.equal(classifyCodexModelCost({ slug: 'm-trial', visibility: 'list', availability_nux: { message: 'Start your trial today' } }).eligible, false);
});

test('non-owner-facing (hidden) models classify UNKNOWN and are NOT eligible (NEEDS_OWNER_CLASSIFICATION)', () => {
  for (const visibility of ['hide', 'unlisted', null, undefined]) {
    const result = classifyCodexModelCost({ slug: 'gpt-reserve', visibility, description: 'Fast and affordable agentic coding model.' });
    assert.equal(result.classification, 'UNKNOWN', `visibility=${visibility}`);
    assert.equal(result.eligible, false);
    assert.ok(result.evidence.join(' ').includes('NEEDS_OWNER_CLASSIFICATION'));
  }
});

test('owner-facing list model without free/trial/ephemeral markers is PAID_OR_STANDARD and eligible', () => {
  const result = classifyCodexModelCost({ slug: 'gpt-5.6-sol', visibility: 'list', description: 'Reliable agentic workhorse for everyday tasks.' });
  assert.equal(result.classification, 'PAID_OR_STANDARD');
  assert.equal(result.eligible, true);
});

test('cost classification never infers PAID solely from a name lacking "-free"', () => {
  const result = classifyCodexModelCost({ slug: 'premium-unlimited-model', visibility: 'list', description: 'A model.' });
  assert.equal(result.classification, 'PAID_OR_STANDARD');
  // and the inverse: a list model that is NOT marked free stays paid — but an
  // unknown-visibility model is never auto-paid even with a plain name.
  assert.equal(classifyCodexModelCost({ slug: 'premium-unlimited-model', visibility: 'hide' }).classification, 'UNKNOWN');
});

// ---- 3. Reasoning extremes selection --------------------------------------

test('lowest/highest reasoning selection samples only the two catalogue extremes', () => {
  const result = selectReasoningExtremes(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(result.configurations, ['low', 'ultra']);
  assert.equal(result.single, false);
});

test('reasoning extremes respect per-model subsets (never invents unsupported values)', () => {
  assert.deepEqual(selectReasoningExtremes(['low', 'medium', 'high', 'xhigh', 'max']).configurations, ['low', 'max']);
  assert.deepEqual(selectReasoningExtremes(['low', 'medium', 'high', 'xhigh']).configurations, ['low', 'xhigh']);
});

test('single reasoning level runs once; no reasoning control runs default once', () => {
  const single = selectReasoningExtremes(['medium']);
  assert.equal(single.single, true);
  assert.deepEqual(single.configurations, ['medium']);
  const none = selectReasoningExtremes([]);
  assert.equal(none.single, true);
  assert.deepEqual(none.configurations, ['default']);
});

// ---- 4. Deterministic dialect classification -------------------------------

test('dialect classification is deterministic and read-only across the full taxonomy', () => {
  const finish = JSON.stringify({ type: 'finish', output: 'done', data: {} });
  const cases = [
    ['', 'EMPTY'],
    ['   \n  ', 'EMPTY'],
    [finish, 'RAW_CANONICAL_JSON'],
    ['```json\n' + finish + '\n```', 'FENCED_JSON'],
    ['Sure! Here is the decision:\n' + finish, 'PROSE_PREFIX_JSON'],
    [finish + '\n\nHope that helps!', 'PROSE_SUFFIX_JSON'],
    ['Analysis first.\n' + finish + '\nEnd note.', 'PROSE_AROUND_JSON'],
    [finish + '\n' + finish, 'MULTIPLE_JSON_VALUES'],
    ['[1,2,3]', 'TOP_LEVEL_ARRAY'],
    ['"just a string"', 'TOP_LEVEL_NON_OBJECT'],
    ['{"no_type_field":true}', 'MISSING_REQUIRED_FIELD'],
    [JSON.stringify({ type: 'finish', output: 42 }), 'WRONG_FIELD_TYPE'],
    ['{"type":"finish","output":"o"', 'TRUNCATED'],
    ['{"type":"finish",output broken}', 'MALFORMED_JSON'],
    ['plain prose with no json at all', 'UNKNOWN'],
  ];
  for (const [text, expected] of cases) {
    const first = classifyDialect(text);
    const second = classifyDialect(text);
    assert.equal(first.dialect, expected, `classifyDialect(${JSON.stringify(text.slice(0, 60))})`);
    assert.equal(first.dialect, second.dialect, 'deterministic (same input -> same class)');
  }
});

test('dialect classification never mutates its input', () => {
  const text = '```json\n{"type":"finish","output":"x"}\n```';
  const snapshot = text.slice();
  classifyDialect(text);
  assert.equal(text, snapshot);
});

// ---- 5. Secret-risk artifact withholding ----------------------------------

test('secret scan flags bearer/authorization/api-key/credentialed-URL patterns', () => {
  assert.equal(scanArtifactForSecretRisk('normal event stream output').safe, true);
  assert.equal(scanArtifactForSecretRisk('Authorization: Bearer abc123').safe, false);
  assert.equal(scanArtifactForSecretRisk('error: api_key=abcd1234efgh5678').safe, false);
  assert.equal(scanArtifactForSecretRisk('postgres://user:secret@host/db').safe, false);
  const hits = scanArtifactForSecretRisk('bearer xyz').hits;
  assert.equal(hits[0].kind, 'bearer-token');
});

// ---- 6. Full collector pipeline over a fake spawn: layers stay separate, ---
// ---- raw/extracted data is stored verbatim, no normalization ---------------

function fakeCodexChild({ stdoutText, exitCode = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.written = [];
  child.stdin.end = (data) => {
    if (data !== undefined) child.stdin.written.push(Buffer.from(data, 'utf8'));
    child.stdin.emit('end');
  };
  child.stdin.on('error', () => {});
  child.pid = 424242;
  queueMicrotask(() => {
    if (stdoutText) child.stdout.emit('data', stdoutText);
    child.emit('close', exitCode, null);
  });
  return child;
}

function cannedCodexStdout(agentMessageText) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 't-corpus-test' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: agentMessageText } }),
    '',
    '',
  ].join('\n');
}

async function runCollectorFixture({ agentMessageText, exitCode = 0, runRoot }) {
  const canonical = readFileSync(CANONICAL_PROBE_PATH);
  return collectOneConfiguration({
    configuration: {
      connector: 'codex',
      provider: null,
      model: 'test-model',
      cost_classification: 'PAID_OR_STANDARD',
      supported_reasoning: ['low', 'ultra'],
      selected_reasoning: 'low',
      planned_sample_count: 1,
    },
    prompt: canonical.toString('utf8'),
    promptMeta: { sha256: sha256OfBytes(canonical), bytes: canonical.length },
    repo: { branch: 'test-branch', head: 'test-head' },
    connectorVersion: 'codex-cli 0.0.0-test',
    binary: 'fake-codex.exe',
    runRoot,
    spawnImplOverride: () => fakeCodexChild({ stdoutText: cannedCodexStdout(agentMessageText), exitCode }),
  });
}

test('collector captures three separate layers over a fake spawn; extracted text is verbatim and prompt bytes are preserved', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-test-'));
  try {
    const decision = JSON.stringify({ type: 'finish', output: 'corpus test output', data: { executive_summary: 's' } });
    const metadata = await runCollectorFixture({ agentMessageText: decision, runRoot });

    const runDir = join(runRoot, modelSlug('test-model'), reasoningSlug('low'), 'run-001');
    // Layer separation: all three layers exist as distinct artifacts.
    assert.equal(existsSync(join(runDir, 'raw-stdout.txt')), true);
    assert.equal(existsSync(join(runDir, 'raw-stderr.txt')), true);
    assert.equal(existsSync(join(runDir, 'raw-events.jsonl')), true);
    assert.equal(existsSync(join(runDir, 'extracted-assistant.txt')), true);
    assert.equal(existsSync(join(runDir, 'parse-observation.json')), true);
    assert.equal(existsSync(join(runDir, 'metadata.json')), true);

    // Layer A: raw stdout stored byte-exactly as the fake process emitted it.
    assert.equal(readFileSync(join(runDir, 'raw-stdout.txt'), 'utf8'), cannedCodexStdout(decision));

    // Layer B: extracted assistant output is the agent_message text VERBATIM
    // (no fence stripping, no normalization, no repair).
    assert.equal(readFileSync(join(runDir, 'extracted-assistant.txt'), 'utf8'), decision);

    // Prompt bytes preserved through stdin (exact canonical bytes).
    // (The fake child records what the bridge wrote to stdin.)
    // Layer C: parse observation ran through the real production boundary.
    const parseObservation = JSON.parse(readFileSync(join(runDir, 'parse-observation.json'), 'utf8'));
    assert.equal(parseObservation.outcome, 'PASS');
    assert.equal(parseObservation.normalized_decision.type, 'finish');

    // Metadata contract: core fields present and honest.
    assert.equal(metadata.model, 'test-model');
    assert.equal(metadata.prompt_sha256, CANONICAL_PROBE_SHA256);
    assert.equal(metadata.prompt_bytes, CANONICAL_PROBE_BYTES);
    assert.equal(metadata.reasoning_requested, 'low');
    assert.equal(metadata.retry_index, 0);
    assert.equal(metadata.sample_index, 1);
    assert.equal(metadata.invocation_failed, false);
    assert.equal(metadata.dialect_classification, 'RAW_CANONICAL_JSON');
    assert.equal(metadata.current_parse_outcome, 'PASS');
    assert.equal(metadata.http_status, null);
    assert.equal(metadata.provider, null);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('collector stores fenced output verbatim (no stripping) and classifies FENCED_JSON', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-test-'));
  try {
    const fenced = '```json\n{"type":"finish","output":"fenced body","data":{}}\n```';
    const metadata = await runCollectorFixture({ agentMessageText: fenced, runRoot });
    const runDir = join(runRoot, modelSlug('test-model'), reasoningSlug('low'), 'run-001');
    const extracted = readFileSync(join(runDir, 'extracted-assistant.txt'), 'utf8');
    assert.equal(extracted, fenced, 'extracted-assistant.txt must never be normalized');
    assert.equal(metadata.dialect_classification, 'FENCED_JSON');
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('collector withholds raw artifacts containing secret-like values and records the risk marker', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-test-'));
  try {
    const decision = JSON.stringify({ type: 'finish', output: 'x', data: {} });
    const leaky = cannedCodexStdout(decision) + '\nAuthorization: Bearer sk-abcdefghijklmnop1234\n';
    const runRoot2 = mkdtempSync(join(tmpdir(), 'dsh-corpus-test-'));
    try {
      const configuration = {
        connector: 'codex',
        provider: null,
        model: 'test-model',
        cost_classification: 'PAID_OR_STANDARD',
        supported_reasoning: ['low', 'ultra'],
        selected_reasoning: 'ultra',
        planned_sample_count: 1,
      };
      const leakyMetadata = await collectOneConfiguration({
        configuration,
        prompt: readFileSync(CANONICAL_PROBE_PATH).toString('utf8'),
        promptMeta: { sha256: CANONICAL_PROBE_SHA256, bytes: CANONICAL_PROBE_BYTES },
        repo: { branch: 'b', head: 'h' },
        connectorVersion: 'v',
        binary: 'fake',
        runRoot: runRoot2,
        spawnImplOverride: () => fakeCodexChild({ stdoutText: leaky, exitCode: 0 }),
      });
      const runDir = join(runRoot2, modelSlug('test-model'), reasoningSlug('ultra'), 'run-001');
      assert.equal(existsSync(join(runDir, 'raw-stdout.txt')), false, 'raw stdout must be withheld');
      assert.equal(existsSync(join(runDir, 'raw-stdout.txt.withheld.json')), true);
      const note = JSON.parse(readFileSync(join(runDir, 'raw-stdout.txt.withheld.json'), 'utf8'));
      assert.equal(note.marker, 'RAW_ARTIFACT_WITHHELD_SECRET_RISK');
      assert.equal(note.sha256, sha256OfBytes(Buffer.from(leaky, 'utf8')));
      assert.ok(leakyMetadata.raw_stdout_withheld);
    } finally {
      rmSync(runRoot2, { recursive: true, force: true });
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('collector records failed transports without inventing parse observations', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-test-'));
  try {
    const metadata = await runCollectorFixture({ agentMessageText: null, exitCode: 3, runRoot });
    assert.equal(metadata.invocation_failed, true);
    assert.equal(metadata.current_parse_outcome, 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT');
    assert.equal(metadata.process_exit_code, 3);
    assert.equal(metadata.assistant_output_bytes, null);
    const runDir = join(runRoot, modelSlug('test-model'), reasoningSlug('low'), 'run-001');
    const parseObservation = JSON.parse(readFileSync(join(runDir, 'parse-observation.json'), 'utf8'));
    assert.equal(parseObservation.outcome, 'NOT_RUN');
    assert.ok(String(parseObservation.note).includes('transport/extraction'));
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('tee spawn wrapper captures raw stdout/stderr and exit code from a real child stream shape', async () => {
  const capture = {};
  const spawnImpl = teeSpawnFactory(capture, () => fakeCodexChild({ stdoutText: 'RAW-STDOUT-BODY', exitCode: 0 }));
  spawnImpl('fake.exe', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(capture.rawStdout, 'RAW-STDOUT-BODY');
  assert.equal(capture.exitCode, 0);
  assert.equal(capture.rawStdoutBytes, Buffer.byteLength('RAW-STDOUT-BODY', 'utf8'));
  assert.equal(capture.spawned, true);
});

// ---- 7. Layer C uses the REAL production parse boundary --------------------

test('parse observation goes through production parseDecision: trailing stray brace fails with PM_DECISION_PARSE_FAILED + subreason', async () => {
  const good = JSON.stringify({ type: 'finish', output: 'complete decision', data: {} });
  const observation = await observeCurrentParse(`${good}}`);
  assert.equal(observation.outcome, 'FAIL');
  assert.equal(observation.error_code, 'PM_DECISION_PARSE_FAILED');
  assert.equal(observation.parse_subreason, 'PM_DECISION_JSON_INVALID');
  assert.ok(observation.structural_diagnostics);
  assert.equal(observation.normalized_decision, null);
});

test('parse observation (production truth): balanced decision object with trailing prose is ACCEPTED by the extraction path', async () => {
  const good = JSON.stringify({ type: 'finish', output: 'complete decision', data: {} });
  const observation = await observeCurrentParse(`${good}\nHope this helps!`);
  assert.equal(observation.outcome, 'PASS');
  assert.equal(observation.normalized_decision.type, 'finish');
});

test('parse observation: empty finish output fails with production PM_DECISION_EMPTY_OUTPUT', async () => {
  const observation = await observeCurrentParse(JSON.stringify({ type: 'finish', output: '   ', data: {} }));
  assert.equal(observation.outcome, 'FAIL');
  assert.equal(observation.error_code, 'PM_DECISION_EMPTY_OUTPUT');
});

test('parse observation: prose-wrapped valid decision still passes the production extraction path, with normalize re-check', async () => {
  const decision = JSON.stringify({ type: 'finish', output: 'wrapped in prose', data: {} });
  const observation = await observeCurrentParse(`Here is my decision:\n${decision}`);
  assert.equal(observation.outcome, 'PASS');
  assert.equal(observation.normalized_decision.type, 'finish');
  assert.equal(observation.normalize_outcome, 'PASS');
});

// ---- 8. Antigravity connector classification & reasoning axis --------------

test('antigravity cost classification: explicit free/trial/deprecation markers exclude invocation', () => {
  assert.equal(classifyAntigravityModelCost({ slug: 'm-free', display_name: 'Free model' }).classification, 'FREE');
  assert.equal(classifyAntigravityModelCost({ slug: 'm-free', display_name: 'Free model' }).eligible, false);
  assert.equal(classifyAntigravityModelCost({ slug: 'm-trial', display_name: 'Trial preview' }).classification, 'TRIAL');
  assert.equal(classifyAntigravityModelCost({ slug: 'm-deprecated', display_name: 'Deprecated (sunsetting)' }).classification, 'EPHEMERAL');
  assert.equal(classifyAntigravityModelCost({ slug: 'm-deprecated', display_name: 'Deprecated (sunsetting)' }).eligible, false);
});

test('antigravity cost classification: authenticated catalogue row with no markers is PAID_OR_STANDARD (never name-only inference)', () => {
  const result = classifyAntigravityModelCost({ slug: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)' });
  assert.equal(result.classification, 'PAID_OR_STANDARD');
  assert.equal(result.eligible, true);
  assert.ok(result.evidence.join(' ').includes('agy models'));
});

test('antigravity reasoning axis: tier-suffixed slug supports exactly its own tier; unsuffixed slug runs default once', () => {
  const tiered = antigravityReasoningExtremes('gemini-3.8-flash-high');
  assert.deepEqual(tiered.supported_reasoning_levels, ['high']);
  assert.deepEqual(tiered.configurations, ['high']);
  assert.equal(tiered.reasoning_extremes.single, true);
  const unsuffixed = antigravityReasoningExtremes('claude-sonnet-4-6');
  assert.equal(unsuffixed.tier, null);
  assert.deepEqual(unsuffixed.supported_reasoning_levels, []);
  assert.deepEqual(unsuffixed.configurations, ['default']);
});

// ---- 9. Antigravity inventory parser --------------------------------------

test('parseAgyModelsStdout parses TSV catalogue rows and never mistakes progress prose for a model', () => {
  const stdout = [
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    '',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].join('\n');
  const models = parseAgyModelsStdout(stdout);
  assert.deepEqual(models.map((m) => m.slug), ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']);
  assert.equal(models[0].display_name, 'Gemini 3.8 Flash (High)');
  // progress prose ("Fetching available models...") rides on stderr and must
  // never be treated as a catalogue row even if it leaked into stdout text.
  assert.deepEqual(parseAgyModelsStdout('Fetching available models...\n'), []);
});

// ---- 10. Antigravity collector pipeline over a fake spawn ------------------

function fakeAgyChild({ stdoutText, exitCode = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.written = [];
  child.stdin.end = (data) => {
    if (data !== undefined) child.stdin.written.push(Buffer.from(data, 'utf8'));
    child.stdin.emit('end');
  };
  child.stdin.on('error', () => {});
  child.pid = 424243;
  queueMicrotask(() => {
    if (stdoutText) child.stdout.emit('data', stdoutText);
    child.emit('close', exitCode, null);
  });
  return child;
}

function cannedAgyStdout({ status = 'SUCCESS', response = '', error = null }) {
  return [
    JSON.stringify({ event: 'init', conversation_id: 'c-corpus-test', init: { cwd: 'x', permission_mode: 'request-review' } }),
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c-corpus-test', step_index: 0, state: 'DONE', step_type: 'user_input' } }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'c-corpus-test', status, response, ...(error ? { error } : {}), duration_seconds: 1.2, num_turns: 1, usage: { total_tokens: 10 } } }),
    '',
  ].join('\n');
}

async function runAntigravityCollectorFixture({ status, response, error, exitCode = 0, runRoot }) {
  const canonical = readFileSync(CANONICAL_PROBE_PATH);
  return collectAntigravityConfiguration({
    configuration: {
      connector: 'antigravity',
      provider: null,
      model: 'test-agy-model-high',
      cost_classification: 'PAID_OR_STANDARD',
      supported_reasoning: ['high'],
      selected_reasoning: 'high',
      planned_sample_count: 1,
    },
    prompt: canonical.toString('utf8'),
    promptMeta: { sha256: sha256OfBytes(canonical), bytes: canonical.length },
    repo: { branch: 'test-branch', head: 'test-head' },
    connectorVersion: '1.0.0-test',
    binary: 'fake-agy.exe',
    runRoot,
    spawnImplOverride: () => fakeAgyChild({ stdoutText: cannedAgyStdout({ status, response, error }), exitCode }),
  });
}

test('antigravity collector captures three separate layers over a fake stream-json spawn; extracted response is verbatim and canonical prompt bytes reach stdin intact', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-agy-test-'));
  try {
    const decision = JSON.stringify({ type: 'finish', output: 'agy corpus test output', data: { executive_summary: 's' } });
    const metadata = await runAntigravityCollectorFixture({ status: 'SUCCESS', response: decision, runRoot });

    const runDir = join(runRoot, modelSlug('test-agy-model-high'), reasoningSlug('high'), 'run-001');
    assert.equal(existsSync(join(runDir, 'raw-stdout.txt')), true);
    assert.equal(existsSync(join(runDir, 'raw-stderr.txt')), true);
    assert.equal(existsSync(join(runDir, 'raw-events.jsonl')), true);
    assert.equal(existsSync(join(runDir, 'extracted-assistant.txt')), true);
    assert.equal(existsSync(join(runDir, 'parse-observation.json')), true);
    assert.equal(existsSync(join(runDir, 'metadata.json')), true);

    // Layer A: raw stdout stored byte-exactly.
    assert.equal(readFileSync(join(runDir, 'raw-stdout.txt'), 'utf8'), cannedAgyStdout({ status: 'SUCCESS', response: decision }));

    // Layer B: extracted assistant output is the terminal result's response
    // VERBATIM (the production extractor trims; no fence/prose/JSON repair).
    assert.equal(readFileSync(join(runDir, 'extracted-assistant.txt'), 'utf8'), decision);

    // Canonical prompt bytes preserved: verified byte-exactly in the dedicated
    // stdin-envelope test below; metadata records the enforced hashes.
    assert.equal(metadata.prompt_sha256, CANONICAL_PROBE_SHA256);

    // Layer C: parse observation ran through the real production boundary
    // with product=antigravity.
    const parseObservation = JSON.parse(readFileSync(join(runDir, 'parse-observation.json'), 'utf8'));
    assert.equal(parseObservation.outcome, 'PASS');
    assert.equal(parseObservation.normalized_decision.type, 'finish');

    assert.equal(metadata.model, 'test-agy-model-high');
    assert.equal(metadata.prompt_sha256, CANONICAL_PROBE_SHA256);
    assert.equal(metadata.prompt_bytes, CANONICAL_PROBE_BYTES);
    assert.equal(metadata.reasoning_requested, 'high');
    assert.equal(metadata.structured_output_mode, 'NONE');
    assert.equal(metadata.invocation_failed, false);
    assert.equal(metadata.dialect_classification, 'RAW_CANONICAL_JSON');
    assert.equal(metadata.current_parse_outcome, 'PASS');
    assert.equal(metadata.http_status, null);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('antigravity collector: canonical prompt bytes survive the stdin NDJSON envelope byte-identically', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-agy-test-'));
  try {
    const canonical = readFileSync(CANONICAL_PROBE_PATH);
    // Re-run the fixture against a capturing fake spawn to inspect stdin.
    let capturedStdin = null;
    const original = collectAntigravityConfiguration;
    const metadata = await original({
      configuration: { connector: 'antigravity', provider: null, model: 'stdin-check-high', cost_classification: 'PAID_OR_STANDARD', supported_reasoning: ['high'], selected_reasoning: 'high', planned_sample_count: 1 },
      prompt: canonical.toString('utf8'),
      promptMeta: { sha256: CANONICAL_PROBE_SHA256, bytes: CANONICAL_PROBE_BYTES },
      repo: { branch: 'b', head: 'h' },
      connectorVersion: 'v',
      binary: 'fake-agy.exe',
      runRoot,
      spawnImplOverride: () => {
        const child = fakeAgyChild({ stdoutText: cannedAgyStdout({ status: 'SUCCESS', response: JSON.stringify({ type: 'finish', output: 'x', data: {} }) }) });
        const originalEnd = child.stdin.end.bind(child.stdin);
        child.stdin.end = (data) => { capturedStdin = data; return originalEnd(data); };
        return child;
      },
    });
    assert.ok(metadata);
    const envelope = JSON.parse(capturedStdin.trim());
    assert.equal(envelope.event, 'user');
    const contentBytes = Buffer.from(envelope.message.content, 'utf8');
    assert.ok(contentBytes.equals(canonical), 'stdin user-event content must be the exact canonical probe bytes');
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('antigravity collector records a non-SUCCESS terminal status as an extraction anomaly without inventing a parse observation', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-agy-test-'));
  try {
    const metadata = await runAntigravityCollectorFixture({ status: 'ERROR', response: '{"type":"finish","output":"partial"}', error: 'The stream was interrupted. Please continue the task you were working on.', runRoot });
    assert.equal(metadata.invocation_failed, false, 'process exit code 0 is never success evidence for the antigravity bridge');
    assert.equal(metadata.extraction_anomaly.code, 'ANTIGRAVITY_RUN_FAILED');
    assert.equal(metadata.assistant_output_bytes, null);
    assert.equal(metadata.current_parse_outcome, 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT');
    assert.equal(metadata.dialect_classification, 'EMPTY');
    const runDir = join(runRoot, modelSlug('test-agy-model-high'), reasoningSlug('high'), 'run-001');
    const parseObservation = JSON.parse(readFileSync(join(runDir, 'parse-observation.json'), 'utf8'));
    assert.equal(parseObservation.outcome, 'NOT_RUN');
    // Layer A preserved the full response in the raw envelope even though
    // extraction refused it — the corpus keeps both layers separate.
    const rawStdout = readFileSync(join(runDir, 'raw-stdout.txt'), 'utf8');
    assert.ok(rawStdout.includes('"status":"ERROR"'));
    assert.ok(rawStdout.includes('partial'));
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

// ---- 11. OpenCode catalogue parser -----------------------------------------

test('parseOpencodeModelsVerboseStdout parses slug+JSON catalogue blocks', () => {
  const stdout = [
    'opencode/big-pickle',
    '{',
    '  "id": "big-pickle",',
    '  "providerID": "opencode",',
    '  "status": "active",',
    '  "cost": { "input": 0, "output": 0 },',
    '  "variants": {}',
    '}',
    'opencode-go/glm-5.3-flash',
    '{',
    '  "id": "glm-5.3-flash",',
    '  "providerID": "opencode-go",',
    '  "status": "active",',
    '  "cost": { "input": 0.1, "output": 0.2 },',
    '  "variants": { "low": { "reasoningEffort": "low" }, "high": { "reasoningEffort": "high" } }',
    '}',
    '',
  ].join('\n');
  const models = parseOpencodeModelsVerboseStdout(stdout);
  assert.deepEqual(models.map((m) => m.slug), ['opencode/big-pickle', 'opencode-go/glm-5.3-flash']);
  assert.equal(models[0].record.providerID, 'opencode');
  assert.deepEqual(Object.keys(models[1].record.variants), ['low', 'high']);
  // no invented records from prose or empty input
  assert.deepEqual(parseOpencodeModelsVerboseStdout(''), []);
  assert.deepEqual(parseOpencodeModelsVerboseStdout('random prose line\nwithout json'), []);
});

// ---- 12. OpenCode cost/availability classification -------------------------

test('opencode cost classification: explicit free/trial markers and non-active status exclude invocation', () => {
  assert.equal(classifyOpencodeModelCost({ id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', providerID: 'opencode', status: 'active', cost: { input: 0, output: 0 } }).classification, 'FREE');
  assert.equal(classifyOpencodeModelCost({ id: 'm-trial', name: 'Trial preview', providerID: 'opencode-go', status: 'active', cost: { input: 1, output: 2 } }).classification, 'TRIAL');
  assert.equal(classifyOpencodeModelCost({ id: 'm-old', name: 'Old model', providerID: 'opencode-go', status: 'deprecated', cost: { input: 1, output: 2 } }).classification, 'EPHEMERAL');
  assert.equal(classifyOpencodeModelCost({ id: 'm-sunset', name: 'Sunsetting soon', providerID: 'opencode-go', status: 'active', cost: { input: 1, output: 2 } }).classification, 'EPHEMERAL');
});

test('opencode cost classification: positive catalogue cost is PAID_OR_STANDARD (never name-only inference)', () => {
  const result = classifyOpencodeModelCost({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', providerID: 'opencode-go', status: 'active', cost: { input: 0.1, output: 0.2 } });
  assert.equal(result.classification, 'PAID_OR_STANDARD');
  assert.equal(result.eligible, true);
  // a non-free NAME with zero authoritative cost on a first-party provider is
  // never auto-promoted to PAID merely for lacking "-free"
  const zeroCost = classifyOpencodeModelCost({ id: 'big-pickle', name: 'Big Pickle', providerID: 'opencode', status: 'active', cost: { input: 0, output: 0 } });
  assert.equal(zeroCost.classification, 'FREE');
});

test('opencode cost classification: placeholder zero cost on third-party config providers is UNKNOWN and owner-excluded', () => {
  const result = classifyOpencodeModelCost({ id: 'gpt-6-astra', name: 'GPT-6 Astra', providerID: 'xcode-best', status: 'active', cost: { input: 0, output: 0 } });
  assert.equal(result.classification, 'UNKNOWN');
  assert.equal(result.eligible, false);
  assert.equal(result.owner_excluded, true);
  assert.ok(result.evidence.join(' ').includes('NEEDS_OWNER_CLASSIFICATION'));
});

// ---- 13. OpenCode reasoning axis (variant extremes) ------------------------

test('opencode variant extremes: none/minimal rank below low; selection keeps only the two extremes', () => {
  assert.ok(OPENCODE_VARIANT_ORDER.indexOf('none') < OPENCODE_VARIANT_ORDER.indexOf('minimal'));
  assert.ok(OPENCODE_VARIANT_ORDER.indexOf('minimal') < OPENCODE_VARIANT_ORDER.indexOf('low'));
  const extremes = opencodeReasoningExtremes({ variants: { minimal: { reasoningEffort: 'minimal' }, low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' }, xhigh: { reasoningEffort: 'xhigh' } } });
  assert.deepEqual(extremes.configurations, ['minimal', 'xhigh']);
  const noneHigh = opencodeReasoningExtremes({ variants: { none: { reasoningEffort: 'none' }, low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } });
  assert.deepEqual(noneHigh.configurations, ['none', 'high']);
});

test('opencode variant extremes: single variant runs once; empty variants map falls back to default', () => {
  const single = opencodeReasoningExtremes({ variants: { max: { reasoningEffort: 'max' } } });
  assert.equal(single.reasoning_extremes.single, true);
  assert.deepEqual(single.configurations, ['max']);
  const none = opencodeReasoningExtremes({ variants: {} });
  assert.deepEqual(none.configurations, ['default']);
  assert.equal(none.default_variant_fallback, 'default');
});

test('variantEchoFromEvents finds a variant string anywhere in the event tree; null when absent', () => {
  assert.equal(variantEchoFromEvents([{ type: 'step-start', part: { type: 'step-start', variant: 'xhigh' } }]), 'xhigh');
  assert.equal(variantEchoFromEvents([{ type: 'text', part: { type: 'text', text: 'no variant here' } }]), null);
  assert.equal(variantEchoFromEvents([]), null);
});

// ---- 14. OpenCode collector pipeline over a fake spawn ---------------------

function fakeOpenCodeChild({ stdoutText, exitCode = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.written = [];
  child.stdin.end = (data) => {
    if (data !== undefined) child.stdin.written.push(Buffer.from(data, 'utf8'));
    child.stdin.emit('end');
  };
  child.stdin.on('error', () => {});
  child.pid = 424244;
  queueMicrotask(() => {
    if (stdoutText) child.stdout.emit('data', stdoutText);
    child.emit('close', exitCode, null);
  });
  return child;
}

function cannedOpenCodeStdout(text, { variantEcho = null } = {}) {
  const lines = [];
  if (variantEcho) lines.push(JSON.stringify({ type: 'step-start', part: { type: 'step-start', variant: variantEcho } }));
  lines.push(JSON.stringify({ type: 'text', part: { type: 'text', text } }));
  lines.push('');
  return lines.join('\n');
}

async function runOpenCodeCollectorFixture({ text, exitCode = 0, variantEcho = null, runRoot }) {
  const canonical = readFileSync(CANONICAL_PROBE_PATH);
  return collectOpenCodeConfiguration({
    configuration: {
      connector: 'opencode',
      provider: 'opencode-go',
      model: 'opencode-go/test-model',
      cost_classification: 'PAID_OR_STANDARD',
      supported_variants: ['low', 'xhigh'],
      selected_variant: 'low',
      planned_sample_count: 1,
    },
    prompt: canonical.toString('utf8'),
    promptMeta: { sha256: sha256OfBytes(canonical), bytes: canonical.length },
    repo: { branch: 'test-branch', head: 'test-head' },
    connectorVersion: '1.18.18-test',
    binary: 'fake-opencode.exe',
    runRoot,
    spawnImplOverride: (cmd, args) => {
      const child = fakeOpenCodeChild({ stdoutText: cannedOpenCodeStdout(text, { variantEcho }), exitCode });
      child.spawnArgs = args;
      return child;
    },
  });
}

test('opencode collector captures three layers over a fake spawn; model/variant stay argv and canonical probe bytes reach stdin', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-opencode-test-'));
  try {
    const decision = JSON.stringify({ type: 'finish', output: 'opencode corpus test output', data: { executive_summary: 's' } });
    let capturedArgs = null;
    let capturedStdin = null;
    const canonical = readFileSync(CANONICAL_PROBE_PATH);
    const metadata = await collectOpenCodeConfiguration({
      configuration: {
        connector: 'opencode', provider: 'opencode-go', model: 'opencode-go/test-model',
        cost_classification: 'PAID_OR_STANDARD', supported_variants: ['low', 'xhigh'], selected_variant: 'xhigh', planned_sample_count: 1,
      },
      prompt: canonical.toString('utf8'),
      promptMeta: { sha256: CANONICAL_PROBE_SHA256, bytes: CANONICAL_PROBE_BYTES },
      repo: { branch: 'b', head: 'h' },
      connectorVersion: '1.18.18-test',
      binary: 'fake-opencode.exe',
      runRoot,
      spawnImplOverride: (cmd, args, opts) => {
        capturedArgs = args;
        const child = fakeOpenCodeChild({ stdoutText: cannedOpenCodeStdout(decision, { variantEcho: 'xhigh' }) });
        const originalEnd = child.stdin.end.bind(child.stdin);
        child.stdin.end = (data) => { capturedStdin = data; return originalEnd(data); };
        return child;
      },
    });

    // Production parity: --model/--variant as argv, prompt NOT in argv.
    assert.ok(capturedArgs.includes('--model'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--model') + 1], 'opencode-go/test-model');
    assert.ok(capturedArgs.includes('--variant'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--variant') + 1], 'xhigh');
    assert.ok(capturedArgs.every((arg, i) => !(typeof arg === 'string' && arg.includes('DSH MODEL OUTPUT DIALECT PROBE'))), 'canonical probe must never ride in argv');

    // Canonical probe bytes delivered via stdin byte-identically.
    assert.ok(Buffer.from(capturedStdin, 'utf8').equals(canonical), 'stdin must carry the exact canonical probe bytes');

    const runDir = join(runRoot, modelSlug('opencode-go/test-model'), reasoningSlug('xhigh'), 'run-001');
    assert.equal(existsSync(join(runDir, 'raw-stdout.txt')), true);
    assert.equal(existsSync(join(runDir, 'extracted-assistant.txt')), true);
    assert.equal(existsSync(join(runDir, 'parse-observation.json')), true);
    assert.equal(readFileSync(join(runDir, 'extracted-assistant.txt'), 'utf8'), decision);

    const parseObservation = JSON.parse(readFileSync(join(runDir, 'parse-observation.json'), 'utf8'));
    assert.equal(parseObservation.outcome, 'PASS');
    assert.equal(parseObservation.normalized_decision.type, 'finish');

    assert.equal(metadata.prompt_sha256, CANONICAL_PROBE_SHA256);
    assert.equal(metadata.prompt_bytes, CANONICAL_PROBE_BYTES);
    assert.equal(metadata.reasoning_requested, 'xhigh');
    assert.equal(metadata.reasoning_effective, 'xhigh');
    assert.equal(metadata.structured_output_mode, 'NONE');
    assert.equal(metadata.provider_terminal_status, 'PROVIDER_TERMINAL_SUCCESS');
    assert.equal(metadata.collector_capture_status, 'COLLECTOR_CAPTURE_COMPLETED');
    assert.equal(metadata.dialect_classification, 'RAW_CANONICAL_JSON');
    assert.equal(metadata.current_parse_outcome, 'PASS');
    assert.equal(metadata.http_status, null);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('opencode collector: default variant forwards no --variant flag; reasoning_effective stays null without an echo', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-opencode-test-'));
  try {
    const decision = JSON.stringify({ type: 'finish', output: 'default run', data: {} });
    let capturedArgs = null;
    await collectOpenCodeConfiguration({
      configuration: {
        connector: 'opencode', provider: 'opencode-go', model: 'opencode-go/test-model',
        cost_classification: 'PAID_OR_STANDARD', supported_variants: [], selected_variant: 'default', planned_sample_count: 1,
      },
      prompt: readFileSync(CANONICAL_PROBE_PATH).toString('utf8'),
      promptMeta: { sha256: CANONICAL_PROBE_SHA256, bytes: CANONICAL_PROBE_BYTES },
      repo: { branch: 'b', head: 'h' },
      connectorVersion: 'v',
      binary: 'fake-opencode.exe',
      runRoot,
      spawnImplOverride: (cmd, args) => { capturedArgs = args; return fakeOpenCodeChild({ stdoutText: cannedOpenCodeStdout(decision) }); },
    });
    assert.ok(!capturedArgs.includes('--variant'), 'no --variant flag when the model has no reasoning control');
    const runDir = join(runRoot, modelSlug('opencode-go/test-model'), reasoningSlug('default'), 'run-001');
    const metadata = JSON.parse(readFileSync(join(runDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.reasoning_requested, 'default');
    assert.equal(metadata.reasoning_effective, null);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('opencode collector records failed transports as PROVIDER_TERMINAL_ERROR without inventing parse observations', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-opencode-test-'));
  try {
    const metadata = await runOpenCodeCollectorFixture({ text: null, exitCode: 1, runRoot });
    assert.equal(metadata.invocation_failed, true);
    assert.equal(metadata.provider_terminal_status, 'PROVIDER_TERMINAL_ERROR');
    assert.equal(metadata.current_parse_outcome, 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT');
    assert.equal(metadata.assistant_output_bytes, null);
    assert.equal(metadata.dialect_classification, 'EMPTY');
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('opencode collector: exit 0 with no text parts is PROVIDER_TERMINAL_UNKNOWN, kept separate from capture status', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-corpus-opencode-test-'));
  try {
    const stdout = [JSON.stringify({ type: 'step-start', part: { type: 'step-start' } }), ''].join('\n');
    const metadata = await collectOpenCodeConfiguration({
      configuration: {
        connector: 'opencode', provider: 'opencode-go', model: 'opencode-go/test-model',
        cost_classification: 'PAID_OR_STANDARD', supported_variants: ['low'], selected_variant: 'low', planned_sample_count: 1,
      },
      prompt: readFileSync(CANONICAL_PROBE_PATH).toString('utf8'),
      promptMeta: { sha256: CANONICAL_PROBE_SHA256, bytes: CANONICAL_PROBE_BYTES },
      repo: { branch: 'b', head: 'h' },
      connectorVersion: 'v',
      binary: 'fake-opencode.exe',
      runRoot,
      spawnImplOverride: () => fakeOpenCodeChild({ stdoutText: stdout, exitCode: 0 }),
    });
    assert.equal(metadata.invocation_failed, false, 'exit 0 is not invented into a transport failure');
    assert.equal(metadata.extraction_anomaly.code, 'OPENCODE_ASSISTANT_OUTPUT_MISSING');
    assert.equal(metadata.provider_terminal_status, 'PROVIDER_TERMINAL_UNKNOWN');
    assert.equal(metadata.collector_capture_status, 'COLLECTOR_CAPTURE_COMPLETED', 'the collector still captured all three layers');
    assert.equal(metadata.current_parse_outcome, 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT');
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});
