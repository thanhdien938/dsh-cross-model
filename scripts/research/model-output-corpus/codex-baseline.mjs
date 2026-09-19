// DSH MODEL OUTPUT CORPUS & DIALECT DISCOVERY — codex connector baseline.
//
// Research-only harness (PLAN section 3, MASTER "RESEARCH TOOLING ALLOWED").
// Reuses the production codex connector implementation unchanged:
//   - src/session/codex-cli-session-bridge.mjs (runCodexCliProcess,
//     summarizeCodexCliRun, extractCodexAssistantText, binary resolution)
//   - src/pm/codex-model-catalogue.mjs (live `codex debug models` discovery)
// and observes the production parse boundary via corpus-lib.mjs's
// observeCurrentParse() (createCliPmDriver stub-run seam).
//
// Subcommands:
//   node codex-baseline.mjs inventory   -> capture + classify + write inventory JSON
//   node codex-baseline.mjs collect     -> planned baseline invocations + 3-layer capture
//   node codex-baseline.mjs report      -> aggregate corpus into the baseline report
//
// Fails closed BEFORE any provider invocation if the canonical probe does not
// match the required SHA-256/byte count.

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PHASE_VERSION,
  CANONICAL_PROBE_SHA256,
  CANONICAL_PROBE_BYTES,
  verifyCanonicalProbe,
  sha256OfBytes,
  classifyCodexModelCost,
  selectReasoningExtremes,
  classifyDialect,
  observeCurrentParse,
  scanArtifactForSecretRisk,
  modelSlug,
  reasoningSlug,
} from './corpus-lib.mjs';
import {
  resolveCodexCliBinary,
  summarizeCodexCliRun,
  extractCodexAssistantText,
  runCodexCliProcess,
  codexSourceEnv,
} from '../../../src/session/codex-cli-session-bridge.mjs';
import { buildProviderChildEnv } from '../../../src/session/provider-child-policy.mjs';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const CANONICAL_PROBE_PATH = join(CORPUS_ROOT, 'CANONICAL_PROBE_PROMPT.txt');
const INVENTORY_PATH = join(CORPUS_ROOT, 'connector-inventory', 'codex.json');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs', 'codex');
const REPORT_PATH = join(CORPUS_ROOT, 'reports', 'codex-baseline-report.md');

const CONNECTOR = 'codex';
const INVENTORY_TIMEOUT_MS = 15_000;
// Production hang-safety ceiling (production-pm-backend-registry.mjs
// HANG_SAFETY_CEILING_MS) — a research harness budget, never a change to
// production timeout policy.
const COLLECT_TIMEOUT_MS = 600_000;

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function nowUtc() {
  return new Date().toISOString();
}

function gitInfo() {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  return { branch, head };
}

function runBoundedCapture(binary, args, { timeoutMs, env }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = nodeSpawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      resolvePromise({ ok: false, exitCode: null, stdout: '', stderr: String(error?.message ?? error), durationMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      finish({ ok: false, exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nspawn-error: ${error?.message ?? error}` }));
    child.once('close', (code) => finish({ ok: code === 0, exitCode: code, stdout, stderr }));
  });
}

async function codexConnectorVersion(binary) {
  const result = await runBoundedCapture(binary, ['--version'], { timeoutMs: 10_000, env: buildProviderChildEnv({ provider: 'codex', sourceEnv: codexSourceEnv() }) });
  return result.ok ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// PHASE 2 — connector inventory
// ---------------------------------------------------------------------------

async function commandInventory() {
  const probe = verifyCanonicalProbe((p) => readFileSync(p), CANONICAL_PROBE_PATH);
  if (!probe.ok) fail(`canonical probe verification failed: ${probe.error} (${probe.reason})`, probe.reason);

  const binary = resolveCodexCliBinary();
  if (!binary) fail('codex CLI binary could not be resolved', 'CODEX_CLI_NOT_RESOLVED');
  const connectorVersion = await codexConnectorVersion(binary);

  const env = buildProviderChildEnv({ provider: 'codex', sourceEnv: codexSourceEnv() });
  const rawCapture = await runBoundedCapture(binary, ['debug', 'models'], { timeoutMs: INVENTORY_TIMEOUT_MS, env });
  if (!rawCapture.ok || !rawCapture.stdout.trim()) {
    fail(`live catalogue discovery failed (exit=${rawCapture.exitCode}, timedOut=${Boolean(rawCapture.timedOut)}): ${rawCapture.stderr.slice(0, 400)}`, 'CODEX_DEBUG_MODELS_FAILED');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawCapture.stdout);
  } catch (error) {
    fail(`live catalogue stdout is not valid JSON: ${error.message}`, 'CODEX_DEBUG_MODELS_UNPARSABLE');
  }
  if (!Array.isArray(parsed?.models)) fail('live catalogue JSON has no "models" array', 'CODEX_DEBUG_MODELS_MALFORMED');

  const models = parsed.models.map((m) => {
    const cost = classifyCodexModelCost(m);
    const reasoning = selectReasoningExtremes((m.supported_reasoning_levels ?? []).map((l) => (l && typeof l.effort === 'string' ? l.effort : null)).filter(Boolean));
    return {
      id: m.slug ?? null,
      display_name: m.display_name ?? null,
      visibility: m.visibility ?? null,
      description: m.description ?? null,
      default_reasoning_level: m.default_reasoning_level ?? null,
      supported_reasoning_levels: reasoning.levels,
      reasoning_extremes: { lowest: reasoning.lowest, highest: reasoning.highest, single: reasoning.single },
      default_reasoning_fallback: reasoning.levels.length === 0 ? 'default' : null,
      cost_classification: cost.classification,
      cost_classification_evidence: cost.evidence,
      invocation_eligible: cost.eligible,
    };
  });

  const counts = {
    total_discovered: models.length,
    paid_or_standard: models.filter((m) => m.cost_classification === 'PAID_OR_STANDARD').length,
    free_excluded: models.filter((m) => m.cost_classification === 'FREE').length,
    trial_excluded: models.filter((m) => m.cost_classification === 'TRIAL').length,
    ephemeral_excluded: models.filter((m) => m.cost_classification === 'EPHEMERAL').length,
    unknown_not_invoked: models.filter((m) => m.cost_classification === 'UNKNOWN').length,
    eligible: models.filter((m) => m.invocation_eligible).length,
  };

  const plannedConfigurations = [];
  for (const m of models.filter((entry) => entry.invocation_eligible)) {
    for (const reasoning of m.reasoning_extremes.single ? [m.reasoning_extremes.lowest ?? 'default'] : [m.reasoning_extremes.lowest, m.reasoning_extremes.highest]) {
      plannedConfigurations.push({
        connector: CONNECTOR,
        provider: null,
        provider_note: 'provider/route identity is not exposed by `codex debug models`; invocation routes via the authenticated Codex CLI service',
        model: m.id,
        cost_classification: m.cost_classification,
        supported_reasoning: m.supported_reasoning_levels,
        selected_reasoning: reasoning,
        planned_sample_count: 1,
      });
    }
  }

  const inventory = {
    phase_version: PHASE_VERSION,
    captured_at_utc: nowUtc(),
    repo: gitInfo(),
    connector: CONNECTOR,
    connector_version: connectorVersion,
    binary,
    discovery_command: 'codex debug models',
    discovery_raw: {
      stdout_bytes: Buffer.byteLength(rawCapture.stdout, 'utf8'),
      stdout_sha256: sha256OfBytes(Buffer.from(rawCapture.stdout, 'utf8')),
      stderr_bytes: Buffer.byteLength(rawCapture.stderr, 'utf8'),
      exit_code: rawCapture.exitCode,
      duration_ms: rawCapture.durationMs,
    },
    catalogue_client_version: typeof parsed.client_version === 'string' ? parsed.client_version : null,
    counts,
    planned_configurations: plannedConfigurations,
    planned_baseline_invocations: plannedConfigurations.length,
    canonical_probe: { sha256: probe.sha256, bytes: probe.bytes },
    models,
  };

  mkdirSync(dirname(INVENTORY_PATH), { recursive: true });
  writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ inventory_path: INVENTORY_PATH, counts, planned_baseline_invocations: plannedConfigurations.length, planned_configurations: plannedConfigurations }, null, 2));
}

// ---------------------------------------------------------------------------
// PHASE 5/6/7/8 — plan + baseline collection with three capture layers
// ---------------------------------------------------------------------------

function teeSpawnFactory(capture, spawnImpl = nodeSpawn) {
  return (cmd, args, opts) => {
    const child = spawnImpl(cmd, args, opts);
    capture.spawned = true;
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
    child.once('close', (code, signal) => {
      capture.exitCode = code;
      capture.exitSignal = signal ?? null;
      capture.rawStdout = stdout;
      capture.rawStderr = stderr;
      capture.rawStdoutBytes = Buffer.byteLength(stdout, 'utf8');
      capture.rawStderrBytes = Buffer.byteLength(stderr, 'utf8');
      capture.settledAt = nowUtc();
    });
    return child;
  };
}

function extractEventsJsonlFromRawStdout(rawStdout) {
  const lines = String(rawStdout ?? '').split(/\r?\n/).filter((line) => line.trim());
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // non-JSON stdout lines stay only in raw-stdout.txt
    }
  }
  return events;
}

function findReasoningEcho(events) {
  for (const event of events ?? []) {
    const candidates = [event, event?.item, event?.thread, event?.thread?.model_info];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (typeof candidate.effort === 'string') return candidate.effort;
      if (typeof candidate.reasoning_effort === 'string') return candidate.reasoning_effort;
    }
  }
  return null;
}

function writeRunArtifact(runDir, name, content) {
  writeFileSync(join(runDir, name), content, 'utf8');
}

function withholdArtifact(runDir, name, content, reason) {
  const bytes = Buffer.from(content ?? '', 'utf8');
  const note = {
    withheld: true,
    reason,
    marker: 'RAW_ARTIFACT_WITHHELD_SECRET_RISK',
    sha256: sha256OfBytes(bytes),
    byte_length: bytes.length,
    recorded_at_utc: nowUtc(),
  };
  writeRunArtifact(runDir, `${name}.withheld.json`, `${JSON.stringify(note, null, 2)}\n`);
  return note;
}

async function collectOneConfiguration({ configuration, prompt, promptMeta, repo, connectorVersion, binary, runRoot = RUNS_ROOT, runLabel = 'run-001', sampleKind = 'baseline', spawnImplOverride = null }) {
  const runDir = join(runRoot, modelSlug(configuration.model), reasoningSlug(configuration.selected_reasoning), runLabel);
  mkdirSync(runDir, { recursive: true });

  const capture = {};
  const startedAt = Date.now();
  let bridgeError = null;
  let bridgeSummary = null;
  try {
    bridgeSummary = await runCodexCliProcess({
      binary,
      cwd: REPO_ROOT,
      prompt,
      model: configuration.model,
      reasoning: configuration.selected_reasoning === 'default' ? undefined : configuration.selected_reasoning,
      timeoutMs: COLLECT_TIMEOUT_MS,
      spawnImpl: spawnImplOverride ?? teeSpawnFactory(capture),
    });
  } catch (error) {
    bridgeError = error;
    if (error?.summary) bridgeSummary = error.summary;
  }
  const durationMs = Date.now() - startedAt;

  // ---- Layer A: raw transport -------------------------------------------
  const rawStdout = capture.rawStdout ?? bridgeSummary?.stdout ?? '';
  const rawStderr = capture.rawStderr ?? bridgeSummary?.stderr ?? '';
  const rawStdoutRisk = scanArtifactForSecretRisk(rawStdout);
  const rawStderrRisk = scanArtifactForSecretRisk(rawStderr);
  let stdoutWithheld = null;
  let stderrWithheld = null;
  if (rawStdoutRisk.safe) writeRunArtifact(runDir, 'raw-stdout.txt', rawStdout);
  else stdoutWithheld = withholdArtifact(runDir, 'raw-stdout.txt', rawStdout, rawStdoutRisk.hits);
  if (rawStderrRisk.safe) writeRunArtifact(runDir, 'raw-stderr.txt', rawStderr);
  else stderrWithheld = withholdArtifact(runDir, 'raw-stderr.txt', rawStderr, rawStderrRisk.hits);

  const events = bridgeSummary?.events?.length ? bridgeSummary.events : extractEventsJsonlFromRawStdout(rawStdout);
  if (events.length) {
    const eventsRisk = scanArtifactForSecretRisk(JSON.stringify(events));
    if (eventsRisk.safe) writeRunArtifact(runDir, 'raw-events.jsonl', `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    else stdoutWithheld = stdoutWithheld ?? withholdArtifact(runDir, 'raw-events.jsonl', events.map((event) => JSON.stringify(event)).join('\n'), eventsRisk.hits);
  }

  const exitCode = capture.exitCode ?? bridgeSummary?.code ?? (bridgeError ? bridgeError.exitCode ?? null : null);

  // ---- Layer B: connector-extracted assistant output --------------------
  let assistantText = null;
  let extractionAnomaly = null;
  try {
    assistantText = extractCodexAssistantText(bridgeSummary);
  } catch (error) {
    extractionAnomaly = { code: error?.code ?? 'CODEX_EXTRACTION_ERROR', message: String(error?.message ?? error).slice(0, 300) };
  }
  let assistantBytes = null;
  let assistantSha = null;
  if (typeof assistantText === 'string') {
    const assistantBytesBuf = Buffer.from(assistantText, 'utf8');
    assistantBytes = assistantBytesBuf.length;
    assistantSha = sha256OfBytes(assistantBytesBuf);
    writeRunArtifact(runDir, 'extracted-assistant.txt', assistantText);
  } else {
    writeRunArtifact(runDir, 'extracted-assistant.txt', '');
  }

  // ---- Layer C: current DSH parse observation ---------------------------
  let parseObservation = null;
  if (typeof assistantText === 'string') {
    parseObservation = await observeCurrentParse(assistantText);
    writeRunArtifact(runDir, 'parse-observation.json', `${JSON.stringify(parseObservation, null, 2)}\n`);
  } else {
    parseObservation = {
      outcome: 'NOT_RUN',
      error_code: null,
      parse_subreason: null,
      structural_diagnostics: null,
      normalized_decision: null,
      normalize_outcome: null,
      normalize_error_code: null,
      note: 'no assistant output was extracted (transport/extraction layer), so the production parse boundary was not reached',
    };
    writeRunArtifact(runDir, 'parse-observation.json', `${JSON.stringify(parseObservation, null, 2)}\n`);
  }

  const dialect = typeof assistantText === 'string' && assistantText.trim() ? classifyDialect(assistantText) : { dialect: extractionAnomaly ? 'EMPTY' : 'EMPTY', detail: extractionAnomaly ? `no assistant output: ${extractionAnomaly.code}` : null };

  const invocationFailed = Boolean(bridgeError) || exitCode !== 0;
  const metadata = {
    phase_version: PHASE_VERSION,
    timestamp_utc: nowUtc(),
    repo_branch: repo.branch,
    repo_head: repo.head,
    connector: CONNECTOR,
    connector_version: connectorVersion,
    provider: null,
    provider_note: 'provider/route identity is not exposed by the codex CLI; invocation routed via the authenticated Codex CLI service',
    model: configuration.model,
    profile_id_if_any: null,
    cost_classification: configuration.cost_classification,
    reasoning_supported: configuration.supported_reasoning,
    reasoning_requested: configuration.selected_reasoning,
    reasoning_effective: findReasoningEcho(events),
    structured_output_mode: 'NONE',
    structured_output_note: 'the codex bridge (runCodexCliProcess) never forwards a JSON schema; free-form text only',
    transport_mode: 'stdio',
    transport_note: 'codex exec --ephemeral --sandbox read-only --skip-git-repo-check --json --color never; prompt via stdin',
    prompt_sha256: promptMeta.sha256,
    prompt_bytes: promptMeta.bytes,
    duration_ms: durationMs,
    process_exit_code: exitCode,
    http_status: null,
    raw_stdout_bytes: capture.rawStdoutBytes ?? Buffer.byteLength(rawStdout, 'utf8'),
    raw_stderr_bytes: capture.rawStderrBytes ?? Buffer.byteLength(rawStderr, 'utf8'),
    raw_response_bytes: capture.rawStdoutBytes ?? Buffer.byteLength(rawStdout, 'utf8'),
    assistant_output_bytes: assistantBytes,
    assistant_output_sha256: assistantSha,
    current_parse_outcome: parseObservation.outcome === 'PASS' ? 'PASS' : parseObservation.outcome === 'NOT_RUN' ? 'NOT_ATTEMPTED_NO_ASSISTANT_OUTPUT' : 'FAIL',
    current_parse_error_code: parseObservation.error_code,
    retry_index: 0,
    sample_kind: sampleKind,
    sample_index: 1,
    invocation_failed: invocationFailed,
    invocation_error_code: bridgeError?.code ?? null,
    invocation_error_message: bridgeError ? String(bridgeError.message ?? '').slice(0, 400) : null,
    extraction_anomaly: extractionAnomaly,
    dialect_classification: dialect.dialect,
    dialect_detail: dialect.detail,
    raw_stdout_withheld: stdoutWithheld,
    raw_stderr_withheld: stderrWithheld,
  };
  writeRunArtifact(runDir, 'metadata.json', `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function commandCollect() {
  const probe = verifyCanonicalProbe((p) => readFileSync(p), CANONICAL_PROBE_PATH);
  if (!probe.ok) fail(`canonical probe verification failed: ${probe.error} (${probe.reason})`, probe.reason);
  if (!existsSync(INVENTORY_PATH)) fail('inventory missing — run the `inventory` subcommand first', 'INVENTORY_MISSING');
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const configurations = inventory.planned_configurations ?? [];
  if (!configurations.length) fail('inventory has zero planned configurations', 'NO_PLANNED_CONFIGURATIONS');

  // The prompt is read fresh per invocation from the verified canonical file;
  // its bytes are re-verified every time (fail closed before any invocation).
  const promptBuffer = readFileSync(CANONICAL_PROBE_PATH);
  const currentProbe = verifyCanonicalProbe(() => promptBuffer, CANONICAL_PROBE_PATH);
  if (!currentProbe.ok) fail('canonical probe changed during collection — aborting before invocation', 'CANONICAL_PROBE_MISMATCH');
  const prompt = promptBuffer.toString('utf8');
  if (Buffer.byteLength(prompt, 'utf8') !== CANONICAL_PROBE_BYTES || sha256OfBytes(promptBuffer) !== CANONICAL_PROBE_SHA256) {
    fail('canonical prompt bytes do not survive the utf8 round-trip — aborting', 'CANONICAL_PROMPT_BYTE_IDENTICAL_FAILED');
  }
  const promptMeta = { sha256: sha256OfBytes(promptBuffer), bytes: promptBuffer.length };
  const repo = gitInfo();
  const binary = resolveCodexCliBinary();
  const connectorVersion = inventory.connector_version ?? await codexConnectorVersion(binary);

  console.error(`Collecting ${configurations.length} baseline invocation(s) for connector=${CONNECTOR} (connector_version=${connectorVersion ?? 'unknown'})...`);
  const results = [];
  for (const configuration of configurations) {
    process.stdout.write(`-> model=${configuration.model} reasoning=${configuration.selected_reasoning} ... `);
    const metadata = await collectOneConfiguration({ configuration, prompt, promptMeta, repo, connectorVersion, binary });
    results.push(metadata);
    const assistantNote = metadata.assistant_output_bytes == null ? 'NO-ASSISTANT-OUTPUT' : `${metadata.assistant_output_bytes}B`;
    console.error(`${metadata.invocation_failed ? 'FAILED' : 'completed'} | exit=${metadata.process_exit_code} | assistant=${assistantNote} | dialect=${metadata.dialect_classification} | parse=${metadata.current_parse_outcome}${metadata.current_parse_error_code ? `(${metadata.current_parse_error_code})` : ''}`);
  }
  console.log(JSON.stringify({ completed: results.filter((r) => !r.invocation_failed).length, failed: results.filter((r) => r.invocation_failed).length, results }, null, 2));
}

// ---------------------------------------------------------------------------
// PHASE 11 — connector report
// ---------------------------------------------------------------------------

function listRunMetadata() {
  const results = [];
  if (!existsSync(RUNS_ROOT)) return results;
  for (const modelDir of readdirSync(RUNS_ROOT)) {
    const modelPath = join(RUNS_ROOT, modelDir);
    if (!statSync(modelPath).isDirectory()) continue;
    for (const reasoningDir of readdirSync(modelPath)) {
      const reasoningPath = join(modelPath, reasoningDir);
      if (!statSync(reasoningPath).isDirectory()) continue;
      for (const runDir of readdirSync(reasoningPath)) {
        const metadataPath = join(reasoningPath, runDir, 'metadata.json');
        if (!existsSync(metadataPath)) continue;
        results.push(JSON.parse(readFileSync(metadataPath, 'utf8')));
      }
    }
  }
  return results;
}

function commandReport() {
  if (!existsSync(INVENTORY_PATH)) fail('inventory missing — run the `inventory` subcommand first', 'INVENTORY_MISSING');
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const runs = listRunMetadata();

  const attempted = runs.length;
  const completed = runs.filter((r) => !r.invocation_failed).length;
  const failed = runs.filter((r) => r.invocation_failed).length;
  const parsePass = runs.filter((r) => r.current_parse_outcome === 'PASS').length;
  const parseFail = runs.filter((r) => r.current_parse_outcome === 'FAIL').length;
  const dialectCounts = {};
  for (const run of runs) dialectCounts[run.dialect_classification] = (dialectCounts[run.dialect_classification] ?? 0) + 1;
  const repeatCandidates = runs.filter((r) => {
    if (r.current_parse_outcome === 'FAIL') return true;
    if (r.extraction_anomaly) return true;
    if (['RAW_CANONICAL_JSON'].includes(r.dialect_classification)) return false;
    return true;
  }).map((r) => `${r.model}/${r.reasoning_requested} (${r.dialect_classification}${r.current_parse_outcome === 'FAIL' ? `, parser ${r.current_parse_error_code ?? 'FAIL'}` : ''})`);

  // Dialect differences between lowest/highest reasoning per model.
  const perModelReasoningDialects = {};
  for (const run of runs) {
    perModelReasoningDialects[run.model] = perModelReasoningDialects[run.model] ?? {};
    perModelReasoningDialects[run.model][run.reasoning_requested] = run.dialect_classification;
  }
  const reasoningDialectDivergence = Object.entries(perModelReasoningDialects)
    .filter(([, byReasoning]) => new Set(Object.values(byReasoning)).size > 1)
    .map(([model, byReasoning]) => `${model}: ${JSON.stringify(byReasoning)}`);

  const transportAnomalies = runs.filter((r) => r.invocation_failed).map((r) => `${r.model}/${r.reasoning_requested}: exit=${r.process_exit_code} code=${r.invocation_error_code ?? 'n/a'} ${r.invocation_error_message ?? ''}`.trim());
  const extractionAnomalies = runs.filter((r) => r.extraction_anomaly).map((r) => `${r.model}/${r.reasoning_requested}: ${r.extraction_anomaly.code}`);
  const withheld = runs.filter((r) => r.raw_stdout_withheld || r.raw_stderr_withheld).map((r) => `${r.model}/${r.reasoning_requested}`);

  // Corpus evidence notes: for structurally unusual outputs, record the raw
  // stream end-state so the report can distinguish provider/model contract
  // variability (model ended its own turn with bad output) from a connector
  // transport cut (stream never completed).
  const evidenceNotes = [];
  for (const run of runs) {
    if (!['TRUNCATED', 'MALFORMED_JSON', 'MULTIPLE_JSON_VALUES', 'CONNECTOR_ENVELOPE', 'EMPTY'].includes(run.dialect_classification)) continue;
    const runDir = join(RUNS_ROOT, modelSlug(run.model), reasoningSlug(run.reasoning_requested), 'run-001');
    let streamEndState = 'unknown';
    try {
      const events = readFileSync(join(runDir, 'raw-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const lastType = events.length ? String(events[events.length - 1]?.type ?? 'unknown') : 'no-events';
      streamEndState = lastType === 'turn.completed' ? 'turn.completed (the model ended its own turn with this output — provider/model contract variability, transport intact)' : lastType;
    } catch { /* raw-events.jsonl absent/withheld — keep 'unknown' */ }
    evidenceNotes.push(`${run.model}/${run.reasoning_requested}: dialect=${run.dialect_classification} (${run.dialect_detail ?? 'no detail'}); stream end-state: ${streamEndState}`);
  }

  const matrixRows = runs.map((r) => `| ${r.model} | ${r.provider ?? 'null (not exposed)'} | ${r.reasoning_requested} | exit=${r.process_exit_code ?? 'n/a'} http=${r.http_status ?? 'n/a'} | ${r.assistant_output_bytes ?? 'n/a'} | ${r.dialect_classification} | ${r.current_parse_outcome}${r.current_parse_error_code ? ` (${r.current_parse_error_code})` : ''} | ${repeatCandidates.some((c) => c.startsWith(`${r.model}/${r.reasoning_requested} `)) ? 'YES' : 'no'} |`);

  const report = `# DSH MODEL OUTPUT CORPUS — ${CONNECTOR} BASELINE REPORT

- Generated: ${nowUtc()} (phase ${PHASE_VERSION})
- Repo branch/head: ${inventory.repo.branch} @ ${inventory.repo.head}
- Canonical probe: sha256 ${inventory.canonical_probe.sha256}, ${inventory.canonical_probe.bytes} bytes (verified fail-closed before every invocation batch)

CONNECTOR: ${CONNECTOR}
CONNECTOR_VERSION: ${inventory.connector_version ?? 'unknown'} (discovery command: \`${inventory.discovery_command}\`)

## Inventory summary

- DISCOVERED_MODELS: ${inventory.counts.total_discovered}
- PAID_OR_STANDARD_MODELS: ${inventory.counts.paid_or_standard}
- FREE_MODELS_EXCLUDED: ${inventory.counts.free_excluded}
- TRIAL_MODELS_EXCLUDED: ${inventory.counts.trial_excluded}
- EPHEMERAL_MODELS_EXCLUDED: ${inventory.counts.ephemeral_excluded}
- UNKNOWN_MODELS_NOT_INVOKED: ${inventory.counts.unknown_not_invoked} (NEEDS_OWNER_CLASSIFICATION)
- ELIGIBLE_MODELS: ${inventory.counts.eligible}
- PLANNED_CONFIGURATIONS: ${inventory.planned_baseline_invocations}

### Model inventory & classification

| model | visibility | default effort | supported reasoning | cost classification | evidence |
| --- | --- | --- | --- | --- | --- |
${inventory.models.map((m) => `| ${m.id} | ${m.visibility} | ${m.default_reasoning_level ?? 'n/a'} | ${m.supported_reasoning_levels.join('/') || '(none — default once)'} | ${m.cost_classification} | ${m.cost_classification_evidence.join('; ')} |`).join('\n')}

### Reasoning matrix & planned invocations

| model | supported reasoning | lowest selected | highest selected | planned samples |
| --- | --- | --- | --- | --- |
${inventory.models.filter((m) => m.invocation_eligible).map((m) => `| ${m.id} | ${m.supported_reasoning_levels.join('/')} | ${m.reasoning_extremes.lowest} | ${m.reasoning_extremes.highest} | ${m.reasoning_extremes.single ? 1 : 2} |`).join('\n')}

## Baseline collection results

- ATTEMPTED_BASELINE_INVOCATIONS: ${attempted}
- COMPLETED_INVOCATIONS: ${completed}
- FAILED_INVOCATIONS: ${failed}
- CURRENT_PARSER_PASS: ${parsePass}
- CURRENT_PARSER_FAIL: ${parseFail}
- DIALECT_COUNTS: ${JSON.stringify(dialectCounts)}
- REASONING_DIALECT_DIVERGENCE: ${reasoningDialectDivergence.length ? reasoningDialectDivergence.join(' ; ') : 'none'}
- RAW_ARTIFACTS_WITHHELD: ${withheld.length ? withheld.join(', ') : 'none'}

### Matrix

| model | provider | reasoning | exit/http | assistant bytes | dialect | current parser | repeat candidate |
| --- | --- | --- | --- | --- | --- | --- | --- |
${matrixRows.join('\n') || '(no runs)'}

## Repeat candidates

${repeatCandidates.length ? repeatCandidates.map((c) => `- ${c}`).join('\n') : 'none'}

## Corpus evidence notes (structurally unusual outputs)

${evidenceNotes.length ? evidenceNotes.map((n) => `- ${n}`).join('\n') : 'none'}

## Anomalies

- TRANSPORT_ANOMALIES: ${transportAnomalies.length ? transportAnomalies.join(' ; ') : 'none'}
- EXTRACTION_ANOMALIES: ${extractionAnomalies.length ? extractionAnomalies.join(' ; ') : 'none'}

## Distinguishing failure layers

The corpus phase deliberately separates:
1. **provider/model contract variability** — model output shape (dialect column / extracted-assistant.txt);
2. **connector extraction/transport defect** — invocation_failed / extraction_anomaly / Layer A raw artifacts;
3. **current DSH parser rejection** — CURRENT_PARSER_FAIL with typed codes (e.g. PM_DECISION_PARSE_FAILED).

A parser FAIL is corpus evidence only. Per PLAN section 18, no production parser change is justified by this data, and none was made (PRODUCTION_PARSER_CHANGED: NO).

## Evidence limitations

- One baseline sample per configuration (variability not yet confirmed — repeat candidates above).
- reasoning_effective is recorded only when the connector's event stream echoes it; otherwise null.
- http_status is null throughout: the codex connector is a stdio transport; HTTP status is not exposed.
- stderr is captured raw via a tee-spawn wrapper; the production bridge additionally summarizes stderr with its own URL/bearer-token redaction (safe()) — both layers are kept separate.
- Hidden (visibility != list) models were classified UNKNOWN (no cost/availability evidence) and were NOT invoked.

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- COUNCIL_VALIDATOR_CHANGED: NO
- EVIDENCE_VALIDATOR_CHANGED: NO
- Connector bridge used as-is: src/session/codex-cli-session-bridge.mjs
- Parse observation ran through the real production boundary (createCliPmDriver -> parseDecision / normalizePmDecision).
`;

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(JSON.stringify({ report_path: REPORT_PATH, attempted, completed, failed, parsePass, parseFail, dialectCounts, repeatCandidates }, null, 2));
}

// ---------------------------------------------------------------------------
// Repeat-confirmation subcommand (closure PHASE 3/4). Runs ONE additional
// sample for an EXISTING baseline configuration, stored as run-002/run-003.
// Refuses to invent configurations and refuses to overwrite existing runs.
// ---------------------------------------------------------------------------

function argValue(args, name) {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function commandRepeat(args) {
  const runLabel = argValue(args, 'run');
  const model = argValue(args, 'model');
  const reasoning = argValue(args, 'reasoning');
  if (!runLabel || !/^run-\d+$/.test(runLabel) || runLabel === 'run-001') fail(`repeat requires --run=run-00N (N>=2), got --run=${runLabel}`, 'INVALID_REPEAT_RUN_LABEL');
  if (!model || !reasoning) fail('repeat requires --model=<slug> and --reasoning=<level>', 'INVALID_REPEAT_ARGS');

  const probe = verifyCanonicalProbe((p) => readFileSync(p), CANONICAL_PROBE_PATH);
  if (!probe.ok) fail(`canonical probe verification failed: ${probe.error} (${probe.reason})`, probe.reason);
  if (!existsSync(INVENTORY_PATH)) fail('inventory missing — run the `inventory` subcommand first', 'INVENTORY_MISSING');
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const configuration = (inventory.planned_configurations ?? []).find((c) => c.model === model && c.selected_reasoning === reasoning);
  if (!configuration) fail(`no baseline configuration matches model=${model} reasoning=${reasoning}; repeat candidates must repeat an existing baseline configuration`, 'REPEAT_CONFIG_NOT_IN_BASELINE');
  const runDir = join(RUNS_ROOT, modelSlug(model), reasoningSlug(reasoning), runLabel);
  if (existsSync(join(runDir, 'metadata.json'))) fail(`refusing to overwrite existing repeat run: ${runDir}`, 'REPEAT_RUN_ALREADY_EXISTS');

  const promptBuffer = readFileSync(CANONICAL_PROBE_PATH);
  const prompt = promptBuffer.toString('utf8');
  const promptMeta = { sha256: sha256OfBytes(promptBuffer), bytes: promptBuffer.length };
  const repo = gitInfo();
  const binary = resolveCodexCliBinary();
  const connectorVersion = inventory.connector_version ?? await codexConnectorVersion(binary);

  console.error(`Repeat sample ${runLabel}: model=${model} reasoning=${reasoning} ...`);
  const metadata = await collectOneConfiguration({ configuration, prompt, promptMeta, repo, connectorVersion, binary, runLabel, sampleKind: 'repeat' });
  const assistantNote = metadata.assistant_output_bytes == null ? 'NO-ASSISTANT-OUTPUT' : `${metadata.assistant_output_bytes}B`;
  console.error(`${metadata.invocation_failed ? 'FAILED' : 'completed'} | exit=${metadata.process_exit_code} | assistant=${assistantNote} | dialect=${metadata.dialect_classification} | parse=${metadata.current_parse_outcome}${metadata.current_parse_error_code ? `(${metadata.current_parse_error_code})` : ''}`);
  console.log(JSON.stringify({ run_label: runLabel, configuration: { model, reasoning }, metadata }, null, 2));
}

// ---------------------------------------------------------------------------

export { collectOneConfiguration, teeSpawnFactory };

import { pathToFileURL } from 'node:url';
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const subcommand = process.argv[2];
  const commands = { inventory: commandInventory, collect: commandCollect, repeat: commandRepeat, report: commandReport };
  if (!commands[subcommand]) {
    console.error('Usage: node codex-baseline.mjs <inventory|collect|repeat|report> [--run=run-00N --model=<slug> --reasoning=<level>]');
    process.exit(2);
  }
  Promise.resolve(commands[subcommand](process.argv.slice(3))).catch((error) => {
    console.error(`FATAL: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
