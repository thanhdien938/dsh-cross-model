// DSH MODEL OUTPUT CORPUS & DIALECT DISCOVERY — opencode connector baseline.
//
// Research-only harness (PLAN section 3, MASTER "RESEARCH TOOLING ALLOWED").
// Reuses the production OpenCode connector implementation unchanged:
//   - src/session/opencode-cli-session-bridge.mjs (runOpenCodeProcess,
//     summarizeOpenCodeRun, extractOpenCodeAssistantText, binary resolution)
// and observes the production parse boundary via corpus-lib.mjs's
// observeCurrentParse() (createCliPmDriver stub-run seam, product=opencode).
//
// Deliberate scope decisions (MASTER "IMPORTANT OPENCODE-SPECIFIC RULE"):
//   - the canonical probe travels through stdin EXACTLY as production's
//     repaired transport delivers it (d1f5a27); model/variant stay argv
//     (--model <slug>, --variant <name>) exactly like production's
//     extraArgs construction in production-pm-backend-registry.mjs;
//   - no JSON cleanup, no fence stripping, no malformed-output repair,
//     no parser weakening — PM_DECISION_PARSE_FAILED is corpus evidence;
//   - no native structured-output flag exists on `opencode run` (1.18.18),
//     so structured_output_mode is NONE for every sample.
//
// Owner scope restriction (owner instruction, 2026-09-08): ONLY first-party
// opencode providers (`opencode`, `opencode-go`) are invocation-eligible.
// Config-defined third-party providers observed in the same catalogue
// (`xcode-best*`) are inventoried for completeness but NEVER invoked.
//
// Subcommands:
//   node opencode-baseline.mjs inventory   -> capture + classify + write inventory JSON
//   node opencode-baseline.mjs collect     -> planned baseline invocations + 3-layer capture
//   node opencode-baseline.mjs report      -> aggregate corpus into the baseline report
//
// Fails closed BEFORE any provider invocation if the canonical probe does not
// match the required SHA-256/byte count.

import { spawn as nodeSpawn, execFileSync as nodeExecFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const CANONICAL_PROBE_PATH = join(CORPUS_ROOT, 'CANONICAL_PROBE_PROMPT.txt');
const INVENTORY_PATH = join(CORPUS_ROOT, 'connector-inventory', 'opencode.json');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs', 'opencode');
const REPORT_PATH = join(CORPUS_ROOT, 'reports', 'opencode-baseline-report.md');

import {
  PHASE_VERSION,
  CANONICAL_PROBE_SHA256,
  CANONICAL_PROBE_BYTES,
  verifyCanonicalProbe,
  sha256OfBytes,
  selectReasoningExtremes,
  classifyDialect,
  observeCurrentParse,
  scanArtifactForSecretRisk,
  modelSlug,
  reasoningSlug,
} from './corpus-lib.mjs';
import {
  resolveOpenCodeBinary,
  runOpenCodeProcess,
  extractOpenCodeAssistantText,
} from '../../../src/session/opencode-cli-session-bridge.mjs';

const CONNECTOR = 'opencode';
const INVENTORY_TIMEOUT_MS = 120_000;
// Research-harness budget (production hang-safety ceiling analogue), never a
// change to production timeout policy.
const COLLECT_TIMEOUT_MS = 600_000;

// First-party providers eligible for invocation (owner instruction 2026-09-08).
const FIRST_PARTY_PROVIDERS = Object.freeze(['opencode', 'opencode-go']);

// OpenCode variant ladder for LOWEST/HIGHEST selection. Source: the live
// `opencode models --verbose` catalogue's per-model `variants` maps, which
// expose keys the Codex-era EFFORT_ORDER does not rank ('none', 'minimal',
// 'thinking'). Values are NEVER invented — the input is whatever the
// catalogue enumerated for that model.
export const OPENCODE_VARIANT_ORDER = Object.freeze(['none', 'thinking', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

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
  const branch = nodeExecFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const head = nodeExecFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  return { branch, head };
}

function runBoundedCapture(binary, args, { timeoutMs, cwd = REPO_ROOT } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = nodeSpawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd });
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

async function opencodeConnectorVersion(binary) {
  const result = await runBoundedCapture(binary, ['--version'], { timeoutMs: 15_000 });
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Parses the live `opencode models --verbose` stdout. Format per model:
 *   <providerID>/<modelID>
 *   { pretty-printed JSON catalogue record }
 * The slug header line is REQUIRED to look like a provider/model pair; every
 * subsequent brace-led line belongs to the current record's JSON buffer.
 */
export function parseOpencodeModelsVerboseStdout(stdout) {
  const SLUG_HEADER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const models = [];
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current) return;
    const text = buffer.join('\n').trim();
    let record = null;
    let parseError = null;
    if (text) {
      try {
        record = JSON.parse(text);
      } catch (error) {
        parseError = String(error?.message ?? error);
      }
    }
    models.push({ slug: current, record, parse_error: parseError });
    current = null;
    buffer = [];
  };
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (SLUG_HEADER.test(trimmed)) {
      flush();
      current = trimmed;
      continue;
    }
    if (current !== null && trimmed) buffer.push(line);
  }
  flush();
  return models.filter((m) => m.record && !m.parse_error);
}

/**
 * OpenCode cost/availability classification (PLAN section 5 / MASTER PHASE
 * 2-3). Evidence-backed and conservative, using the authoritative catalogue
 * record itself (`opencode models --verbose`, models.dev cache):
 *   - explicit free/trial markers in id/name                          -> FREE / TRIAL
 *   - status !== 'active' or deprecation marker                       -> EPHEMERAL
 *   - positive catalogue cost (input or output > 0)                   -> PAID_OR_STANDARD
 *   - zero catalogue cost on a FIRST-PARTY provider (opencode,
 *     opencode-go — the same catalogue surfaces real costs for its paid
 *     models elsewhere, so a listed 0 is meaningful pricing)          -> FREE
 *   - zero catalogue cost on a config-defined third-party provider
 *     (xcode-best*: placeholder 0/0 metadata, empty api url, 0 context
 *     limits — NOT authoritative pricing)                             -> UNKNOWN (NEEDS_OWNER_CLASSIFICATION)
 * Never infers PAID merely because a name lacks "-free"; never assumes FREE
 * from informal naming when the catalogue contradicts it.
 */
export function classifyOpencodeModelCost(model, { firstPartyProviders = FIRST_PARTY_PROVIDERS } = {}) {
  const evidence = [];
  const id = typeof model?.id === 'string' ? model.id : '';
  const name = typeof model?.name === 'string' ? model.name : '';
  const scanTexts = `${id} \u2014 ${name}`;
  if (/\btrial\b/i.test(scanTexts)) {
    return { classification: 'TRIAL', eligible: false, evidence: ['explicit "trial" marker in catalogue metadata'], owner_excluded: false };
  }
  const status = typeof model?.status === 'string' ? model.status : null;
  if (status && status !== 'active') {
    return { classification: 'EPHEMERAL', eligible: false, evidence: [`catalogue status=${status} (not active)`], owner_excluded: false };
  }
  if (/\b(deprecat\w*|retir\w*|sunset|end[- ]of[- ]life|eol)\b/i.test(scanTexts)) {
    return { classification: 'EPHEMERAL', eligible: false, evidence: ['explicit deprecation/retirement marker in catalogue metadata'], owner_excluded: false };
  }
  if (/\bfree\b/i.test(scanTexts)) {
    return { classification: 'FREE', eligible: false, evidence: ['explicit "free" marker in catalogue metadata'], owner_excluded: false };
  }
  const cost = model?.cost && typeof model.cost === 'object' ? model.cost : null;
  const inputCost = Number(cost?.input);
  const outputCost = Number(cost?.output);
  if (Number.isFinite(inputCost) && Number.isFinite(outputCost) && (inputCost > 0 || outputCost > 0)) {
    return { classification: 'PAID_OR_STANDARD', eligible: true, evidence: [`catalogue cost input=${inputCost} output=${outputCost} (per M tokens, models.dev cache)`], owner_excluded: false };
  }
  const providerId = typeof model?.providerID === 'string' ? model.providerID : null;
  const isFirstParty = providerId !== null && firstPartyProviders.includes(providerId);
  if (isFirstParty) {
    evidence.push(`catalogue cost input=${cost?.input ?? 'n/a'} output=${cost?.output ?? 'n/a'} — authoritative first-party catalogue (${providerId}) prices this model at zero; no paid pricing listed`);
    return { classification: 'FREE', eligible: false, evidence, owner_excluded: false };
  }
  evidence.push(`catalogue cost is placeholder 0/0 from a config-defined third-party provider (providerID=${providerId ?? 'null'}, no authoritative pricing in the models.dev cache) -> NEEDS_OWNER_CLASSIFICATION`);
  return { classification: 'UNKNOWN', eligible: false, evidence, owner_excluded: true };
}

/**
 * OpenCode reasoning extremes (MASTER PHASE 4). The supported variant set is
 * the catalogue's own `variants` map keys for that model (never invented);
 * selection uses the OpenCode variant ladder and keeps only the two extremes.
 * A model with an empty variants map has no explicit reasoning control and
 * runs once as `default` (production would forward no --variant flag).
 */
export function opencodeReasoningExtremes(record) {
  const variantKeys = record?.variants && typeof record.variants === 'object' && !Array.isArray(record.variants)
    ? Object.keys(record.variants)
    : [];
  const extremes = selectReasoningExtremes(variantKeys, { order: OPENCODE_VARIANT_ORDER });
  return {
    supported_variants: extremes.levels,
    variant_reasoning_efforts: variantKeys.length
      ? Object.fromEntries(variantKeys.map((key) => [key, record.variants[key]?.reasoningEffort ?? record.variants[key]?.effort ?? record.variants[key]?.thinking?.type ?? null]))
      : {},
    reasoning_extremes: { lowest: extremes.lowest, highest: extremes.highest, single: extremes.single },
    default_variant_fallback: extremes.levels.length === 0 ? 'default' : null,
    configurations: extremes.configurations,
  };
}

/** Variant-selection evidence per model, persisted for the report. */
export function variantEchoFromEvents(events) {
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue;
    const stack = [event];
    const seen = new Set();
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (typeof value.variant === 'string' && value.variant.trim()) return value.variant;
      for (const nested of Object.values(value)) {
        if (nested && typeof nested === 'object') stack.push(nested);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PHASE 2 — connector inventory
// ---------------------------------------------------------------------------

async function commandInventory() {
  const probe = verifyCanonicalProbe((p) => readFileSync(p), CANONICAL_PROBE_PATH);
  if (!probe.ok) fail(`canonical probe verification failed: ${probe.error} (${probe.reason})`, probe.reason);

  const binary = resolveOpenCodeBinary();
  if (!binary) fail('opencode CLI binary could not be resolved', 'OPENCODE_CLI_NOT_RESOLVED');
  const connectorVersion = await opencodeConnectorVersion(binary);

  const rawCapture = await runBoundedCapture(binary, ['models', '--verbose'], { timeoutMs: INVENTORY_TIMEOUT_MS });
  if (!rawCapture.ok || !rawCapture.stdout.trim()) {
    fail(`live catalogue discovery failed (exit=${rawCapture.exitCode}, timedOut=${Boolean(rawCapture.timedOut)}): ${rawCapture.stderr.slice(0, 400)}`, 'OPENCODE_MODELS_FAILED');
  }
  const discovered = parseOpencodeModelsVerboseStdout(rawCapture.stdout);
  if (!discovered.length) fail('live catalogue stdout yielded no recognizable model records', 'OPENCODE_MODELS_EMPTY');

  const models = discovered.map(({ slug, record }) => {
    const cost = classifyOpencodeModelCost(record);
    const reasoning = opencodeReasoningExtremes(record);
    const firstParty = FIRST_PARTY_PROVIDERS.includes(record.providerID);
    return {
      slug,
      id: record.id ?? null,
      provider_id: record.providerID ?? null,
      display_name: record.name ?? null,
      status: record.status ?? null,
      release_date: record.release_date ?? null,
      api_url: record.api?.url ?? null,
      cost: record.cost ?? null,
      limit: record.limit ?? null,
      capabilities: record.capabilities ?? null,
      supported_variants: reasoning.supported_variants,
      variant_reasoning_efforts: reasoning.variant_reasoning_efforts,
      reasoning_extremes: reasoning.reasoning_extremes,
      default_variant_fallback: reasoning.default_variant_fallback,
      cost_classification: cost.classification,
      cost_classification_evidence: cost.evidence,
      first_party_provider: firstParty,
      owner_excluded: cost.owner_excluded || !firstParty,
      owner_exclusion_reason: (!firstParty ? 'owner instruction (2026-09-08): collect first-party opencode models only; config-defined third-party providers are inventoried but never invoked' : null),
      invocation_eligible: cost.eligible && firstParty,
    };
  });

  const counts = {
    total_discovered: models.length,
    paid_or_standard: models.filter((m) => m.cost_classification === 'PAID_OR_STANDARD').length,
    free_excluded: models.filter((m) => m.cost_classification === 'FREE').length,
    trial_excluded: models.filter((m) => m.cost_classification === 'TRIAL').length,
    ephemeral_excluded: models.filter((m) => m.cost_classification === 'EPHEMERAL').length,
    unknown_not_invoked: models.filter((m) => m.cost_classification === 'UNKNOWN').length,
    owner_excluded: models.filter((m) => m.owner_excluded).length,
    eligible: models.filter((m) => m.invocation_eligible).length,
  };

  const plannedConfigurations = [];
  for (const m of models.filter((entry) => entry.invocation_eligible)) {
    for (const reasoning of opencodeReasoningExtremes(discovered.find((d) => d.slug === m.slug)?.record).configurations) {
      plannedConfigurations.push({
        connector: CONNECTOR,
        provider: m.provider_id,
        model: m.slug,
        cost_classification: m.cost_classification,
        supported_variants: m.supported_variants,
        selected_variant: reasoning,
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
    discovery_command: 'opencode models --verbose',
    discovery_raw: {
      stdout_bytes: Buffer.byteLength(rawCapture.stdout, 'utf8'),
      stdout_sha256: sha256OfBytes(Buffer.from(rawCapture.stdout, 'utf8')),
      stderr_bytes: Buffer.byteLength(rawCapture.stderr, 'utf8'),
      exit_code: rawCapture.exitCode,
      duration_ms: rawCapture.durationMs,
    },
    catalogue_metadata_note: '`opencode models --verbose` exposes per-model catalogue records (id, providerID, name, status, cost, limit, capabilities, variants) from the models.dev cache; config-defined third-party providers appear with placeholder 0/0 cost metadata',
    owner_scope_restriction: 'Owner instruction (2026-09-08): invoke FIRST-PARTY providers only (opencode, opencode-go). The xcode-best* config-defined third-party providers are inventoried for completeness but never invoked in this corpus run.',
    native_structured_output: {
      cli_flag: null,
      production_use: 'none — `opencode run` (1.18.18) exposes no structured-output/schema flag',
      corpus_mode: 'NONE — free-form output path only',
    },
    reasoning_axis_note: 'the reasoning axis is the catalogue `variants` map per model (e.g. none/minimal/low/medium/high/xhigh/max); production forwards --variant <name> only when a variant is selected; models with an empty variants map have no reasoning control and run once as default',
    counts,
    planned_configurations: plannedConfigurations,
    planned_baseline_invocations: plannedConfigurations.length,
    canonical_probe: { sha256: probe.sha256, bytes: probe.bytes },
    models,
  };

  mkdirSync(dirname(INVENTORY_PATH), { recursive: true });
  writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ inventory_path: INVENTORY_PATH, counts, planned_baseline_invocations: plannedConfigurations.length }, null, 2));
}

// ---------------------------------------------------------------------------
// PHASE 5/6/7/8 — plan + baseline collection with three capture layers
// ---------------------------------------------------------------------------

function teeSpawnFactory(capture, spawnImpl = nodeSpawn) {
  return (cmd, args, opts) => {
    const child = spawnImpl(cmd, args, opts);
    capture.spawned = true;
    capture.args = args;
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
  const runDir = join(runRoot, modelSlug(configuration.model), reasoningSlug(configuration.selected_variant), runLabel);
  mkdirSync(runDir, { recursive: true });

  const capture = {};
  const startedAt = Date.now();
  let bridgeError = null;
  let bridgeSummary = null;
  try {
    // Production parity: model/variant stay argv; the canonical probe travels
    // through the repaired stdin transport (d1f5a27) untouched.
    const extraArgs = ['--model', configuration.model];
    if (configuration.selected_variant !== 'default') extraArgs.push('--variant', configuration.selected_variant);
    bridgeSummary = await runOpenCodeProcess({
      binary,
      cwd: REPO_ROOT,
      prompt,
      extraArgs,
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

  const events = bridgeSummary?.events?.length ? bridgeSummary.events : [];
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
    assistantText = extractOpenCodeAssistantText(bridgeSummary);
  } catch (error) {
    extractionAnomaly = { code: error?.code ?? 'OPENCODE_EXTRACTION_ERROR', message: String(error?.message ?? error).slice(0, 300) };
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
    parseObservation = await observeCurrentParse(assistantText, { product: CONNECTOR });
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

  const dialect = typeof assistantText === 'string' && assistantText.trim() ? classifyDialect(assistantText) : { dialect: 'EMPTY', detail: extractionAnomaly ? `no assistant output: ${extractionAnomaly.code}` : null };

  // PHASE 8 — collector capture status vs provider terminal status, recorded
  // independently (never equated).
  const collectorCaptureStatus = 'COLLECTOR_CAPTURE_COMPLETED';
  let providerTerminalStatus;
  if (exitCode !== 0 || bridgeError) providerTerminalStatus = 'PROVIDER_TERMINAL_ERROR';
  else if (typeof assistantText === 'string' && assistantText.trim()) providerTerminalStatus = 'PROVIDER_TERMINAL_SUCCESS';
  else providerTerminalStatus = 'PROVIDER_TERMINAL_UNKNOWN';

  const invocationFailed = Boolean(bridgeError) || exitCode !== 0;
  const metadata = {
    phase_version: PHASE_VERSION,
    timestamp_utc: nowUtc(),
    repo_branch: repo.branch,
    repo_head: repo.head,
    connector: CONNECTOR,
    connector_version: connectorVersion,
    provider: configuration.provider,
    provider_note: `provider identity comes from the catalogue record (providerID=${configuration.provider}); routed via the installed opencode CLI (1.18.18)`,
    model: configuration.model,
    profile_id_if_any: null,
    cost_classification: configuration.cost_classification,
    reasoning_supported: configuration.supported_variants,
    reasoning_requested: configuration.selected_variant,
    reasoning_effective: variantEchoFromEvents(events),
    structured_output_mode: 'NONE',
    structured_output_note: '`opencode run` (1.18.18) exposes no structured-output/schema flag; the harness observes the free-form output path production single-PM execution uses',
    transport_mode: 'stdio',
    transport_note: 'opencode run --format json --dir <cwd> --model <slug> [--variant <name>]; canonical probe delivered via the repaired production stdin transport (d1f5a27) — no argv prompt',
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
    collector_capture_status: collectorCaptureStatus,
    provider_terminal_status: providerTerminalStatus,
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
  const binary = resolveOpenCodeBinary();
  const connectorVersion = inventory.connector_version ?? await opencodeConnectorVersion(binary);

  console.error(`Collecting ${configurations.length} baseline invocation(s) for connector=${CONNECTOR} (connector_version=${connectorVersion ?? 'unknown'})...`);
  const results = [];
  for (const configuration of configurations) {
    // Resume guard: a configuration whose run-001 metadata already exists was
    // already collected (possibly by an earlier interrupted pass) and is never
    // re-invoked — baseline samples are exactly one per configuration.
    const existingMetadata = join(RUNS_ROOT, modelSlug(configuration.model), reasoningSlug(configuration.selected_variant), 'run-001', 'metadata.json');
    if (existsSync(existingMetadata)) {
      results.push(JSON.parse(readFileSync(existingMetadata, 'utf8')));
      console.error(`SKIP (already collected) model=${configuration.model} variant=${configuration.selected_variant}`);
      continue;
    }
    process.stdout.write(`-> model=${configuration.model} variant=${configuration.selected_variant} ... `);
    const metadata = await collectOneConfiguration({ configuration, prompt, promptMeta, repo, connectorVersion, binary });
    results.push(metadata);
    const assistantNote = metadata.assistant_output_bytes == null ? 'NO-ASSISTANT-OUTPUT' : `${metadata.assistant_output_bytes}B`;
    console.error(`${metadata.invocation_failed ? 'FAILED' : 'completed'} | exit=${metadata.process_exit_code} | ${metadata.provider_terminal_status} | assistant=${assistantNote} | dialect=${metadata.dialect_classification} | parse=${metadata.current_parse_outcome}${metadata.current_parse_error_code ? `(${metadata.current_parse_error_code})` : ''}`);
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
  const captureCompleted = runs.filter((r) => r.collector_capture_status === 'COLLECTOR_CAPTURE_COMPLETED').length;
  const captureFailed = runs.filter((r) => r.collector_capture_status === 'COLLECTOR_CAPTURE_FAILED').length;
  const providerSuccess = runs.filter((r) => r.provider_terminal_status === 'PROVIDER_TERMINAL_SUCCESS').length;
  const providerError = runs.filter((r) => r.provider_terminal_status === 'PROVIDER_TERMINAL_ERROR').length;
  const providerUnknown = runs.filter((r) => r.provider_terminal_status === 'PROVIDER_TERMINAL_UNKNOWN').length;
  const parsePass = runs.filter((r) => r.current_parse_outcome === 'PASS').length;
  const parseFail = runs.filter((r) => r.current_parse_outcome === 'FAIL').length;
  const dialectCounts = {};
  for (const run of runs) dialectCounts[run.dialect_classification] = (dialectCounts[run.dialect_classification] ?? 0) + 1;
  const repeatCandidates = runs.filter((r) => {
    if (r.current_parse_outcome === 'FAIL') return true;
    if (r.extraction_anomaly) return true;
    if (r.provider_terminal_status !== 'PROVIDER_TERMINAL_SUCCESS') return true;
    if (['RAW_CANONICAL_JSON'].includes(r.dialect_classification)) return false;
    return true;
  }).map((r) => `${r.model}/${r.reasoning_requested} (${r.dialect_classification}${r.current_parse_outcome === 'FAIL' ? `, parser ${r.current_parse_error_code ?? 'FAIL'}` : ''}${r.provider_terminal_status !== 'PROVIDER_TERMINAL_SUCCESS' ? `, ${r.provider_terminal_status}` : ''})`);

  const perModelVariantDialects = {};
  for (const run of runs) {
    perModelVariantDialects[run.model] = perModelVariantDialects[run.model] ?? {};
    perModelVariantDialects[run.model][run.reasoning_requested] = run.dialect_classification;
  }
  const variantDialectDivergence = Object.entries(perModelVariantDialects)
    .filter(([, byVariant]) => new Set(Object.values(byVariant)).size > 1)
    .map(([model, byVariant]) => `${model}: ${JSON.stringify(byVariant)}`);

  const transportAnomalies = runs.filter((r) => r.invocation_failed).map((r) => `${r.model}/${r.reasoning_requested}: exit=${r.process_exit_code} code=${r.invocation_error_code ?? 'n/a'} ${r.invocation_error_message ?? ''}`.trim());
  const extractionAnomalies = runs.filter((r) => r.extraction_anomaly).map((r) => `${r.model}/${r.reasoning_requested}: ${r.extraction_anomaly.code}`);
  const withheld = runs.filter((r) => r.raw_stdout_withheld || r.raw_stderr_withheld).map((r) => `${r.model}/${r.reasoning_requested}`);

  // Corpus evidence notes: for structurally unusual outputs, record the raw
  // stream end-state so the report can distinguish provider/model output
  // noncompliance (the stream itself completed with that output) from a
  // connector transport cut (non-zero exit, timeout, missing text parts).
  const evidenceNotes = [];
  for (const run of runs) {
    if (!['TRUNCATED', 'MALFORMED_JSON', 'MULTIPLE_JSON_VALUES', 'CONNECTOR_ENVELOPE', 'EMPTY', 'UNKNOWN', 'TOP_LEVEL_ARRAY', 'TOP_LEVEL_NON_OBJECT', 'FENCED_JSON', 'PROSE_PREFIX_JSON', 'PROSE_SUFFIX_JSON', 'PROSE_AROUND_JSON', 'MISSING_REQUIRED_FIELD', 'WRONG_FIELD_TYPE'].includes(run.dialect_classification)) continue;
    const runDir = join(RUNS_ROOT, modelSlug(run.model), reasoningSlug(run.reasoning_requested), 'run-001');
    let streamEndState = 'unknown';
    let eventCount = null;
    try {
      const events = readFileSync(join(runDir, 'raw-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      eventCount = events.length;
      const lastEvent = events.length ? events[events.length - 1] : null;
      streamEndState = lastEvent ? String(lastEvent?.type ?? 'unknown-type') : 'no-events';
    } catch { /* raw-events.jsonl absent/withheld — keep 'unknown' */ }
    evidenceNotes.push(`${run.model}/${run.reasoning_requested}: dialect=${run.dialect_classification} (${run.dialect_detail ?? 'no detail'}); stream end-state: last event type=${streamEndState}, events=${eventCount ?? 'n/a'}, exit=${run.process_exit_code}, provider_terminal=${run.provider_terminal_status}`);
  }

  const matrixRows = runs.map((r) => `| ${r.model} | ${r.provider ?? 'null'} | ${r.reasoning_requested} | ${r.reasoning_effective ?? 'null'} | exit=${r.process_exit_code ?? 'n/a'} http=${r.http_status ?? 'n/a'} | ${r.provider_terminal_status} | ${r.assistant_output_bytes ?? 'n/a'} | ${r.dialect_classification} | ${r.current_parse_outcome}${r.current_parse_error_code ? ` (${r.current_parse_error_code})` : ''} | ${repeatCandidates.some((c) => c.startsWith(`${r.model}/${r.reasoning_requested} `)) ? 'YES' : 'no'} |`);

  const reasoningEffectiveEvidence = runs.map((r) => `${r.model}/${r.reasoning_requested}: reasoning_effective=${JSON.stringify(r.reasoning_effective)} (variant echo from the JSON event stream; null = no authoritative echo, never inferred)`);

  const report = `# DSH MODEL OUTPUT CORPUS — ${CONNECTOR} BASELINE REPORT

- Generated: ${nowUtc()} (phase ${PHASE_VERSION})
- Repo branch/head: ${inventory.repo.branch} @ ${inventory.repo.head}
- Canonical probe: sha256 ${inventory.canonical_probe.sha256}, ${inventory.canonical_probe.bytes} bytes (verified fail-closed before every invocation batch)

CONNECTOR: ${CONNECTOR}
CONNECTOR_VERSION: ${inventory.connector_version ?? 'unknown'} (discovery command: \`${inventory.discovery_command}\`)

## Inventory summary

- DISCOVERED_MODELS: ${inventory.counts.total_discovered}
- PAID_OR_STANDARD: ${inventory.counts.paid_or_standard}
- FREE_EXCLUDED: ${inventory.counts.free_excluded}
- TRIAL_EXCLUDED: ${inventory.counts.trial_excluded}
- EPHEMERAL_EXCLUDED: ${inventory.counts.ephemeral_excluded}
- UNKNOWN_NOT_INVOKED: ${inventory.counts.unknown_not_invoked} (NEEDS_OWNER_CLASSIFICATION)
- ELIGIBLE_MODELS: ${inventory.counts.eligible}
- PLANNED_CONFIGURATIONS: ${inventory.planned_baseline_invocations}

### Owner scope restriction

${inventory.owner_scope_restriction}

### Model inventory & classification

Classification evidence below comes from the authoritative \`opencode models --verbose\` catalogue records (models.dev cache); config-defined third-party providers carry placeholder 0/0 cost metadata and are classified UNKNOWN, never invoked.

| model | provider | status | supported variants | cost classification | first-party | owner excluded | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
${inventory.models.map((m) => `| ${m.slug} | ${m.provider_id ?? 'n/a'} | ${m.status ?? 'n/a'} | ${m.supported_variants.join('/') || '(none — default once)'} | ${m.cost_classification} | ${m.first_party_provider ? 'yes' : 'no'} | ${m.owner_excluded ? 'YES' : 'no'} | ${m.cost_classification_evidence.join('; ')}${m.owner_exclusion_reason ? `; ${m.owner_exclusion_reason}` : ''} |`).join('\n')}

### Reasoning axis (OpenCode-specific)

The reasoning axis is the catalogue \`variants\` map per model. Production forwards \`--variant <name>\` only when a variant is selected; models with an empty variants map have no reasoning control and run once as \`default\` (no --variant flag). Only LOWEST_SUPPORTED and HIGHEST_SUPPORTED variants were selected (OpenCode variant ladder: ${OPENCODE_VARIANT_ORDER.join(' < ')}); values were never invented.

## Baseline collection results

- ATTEMPTED_BASELINE_INVOCATIONS: ${attempted}
- COLLECTOR_CAPTURE_COMPLETED: ${captureCompleted}
- COLLECTOR_CAPTURE_FAILED: ${captureFailed}
- PROVIDER_TERMINAL_SUCCESS: ${providerSuccess}
- PROVIDER_TERMINAL_ERROR: ${providerError}
- PROVIDER_TERMINAL_UNKNOWN: ${providerUnknown}
- CURRENT_PARSER_PASS: ${parsePass}
- CURRENT_PARSER_FAIL: ${parseFail}
- DIALECT_COUNTS: ${JSON.stringify(dialectCounts)}
- VARIANT_DIALECT_DIVERGENCE: ${variantDialectDivergence.length ? variantDialectDivergence.join(' ; ') : 'none'}
- RAW_ARTIFACTS_WITHHELD: ${withheld.length ? withheld.join(', ') : 'none'}

### Matrix

| model | provider | reasoning_requested | reasoning_effective | exit/http | provider terminal | assistant bytes | dialect | current parser | repeat candidate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${matrixRows.join('\n') || '(no runs)'}

## Repeat candidates

${repeatCandidates.length ? repeatCandidates.map((c) => `- ${c}`).join('\n') : 'none'}

## Corpus evidence notes (structurally unusual outputs)

${evidenceNotes.length ? evidenceNotes.map((n) => `- ${n}`).join('\n') : 'none'}

## Anomalies

- TRANSPORT_ANOMALIES: ${transportAnomalies.length ? transportAnomalies.join(' ; ') : 'none'}
- EXTRACTION_ANOMALIES: ${extractionAnomalies.length ? extractionAnomalies.join(' ; ') : 'none'}

## REASONING_EFFECTIVE_EVIDENCE

${reasoningEffectiveEvidence.join('\n')}

## Structured-output mode observed

- Every run was collected WITHOUT any structured-output mechanism (mode \`NONE\`): \`opencode run\` (1.18.18) exposes no schema flag. Model output noncompliance below is therefore genuine free-path behavior, not a schema artifact.

## Distinguishing failure layers

The corpus phase deliberately separates:
1. **provider/model output noncompliance** — model output shape (dialect column / extracted-assistant.txt): the stream itself completed (exit 0) with the unusual response — the model ended its own turn with that output;
2. **opencode connector transport/extraction defect** — invocation_failed / extraction_anomaly / Layer A raw artifacts (non-zero exit, timeout, missing text parts);
3. **current DSH parser rejection** — CURRENT_PARSER_FAIL with typed codes (e.g. PM_DECISION_PARSE_FAILED).

A parser FAIL is corpus evidence only. Per PLAN section 18, no production parser change is justified by this data, and none was made (PRODUCTION_PARSER_CHANGED: NO).

## Evidence limitations

- One baseline sample per configuration (variability not yet confirmed — repeat candidates above).
- reasoning_effective is recorded only when the OpenCode JSON event stream echoes a variant field; otherwise null (never inferred merely because --variant was requested).
- http_status is null throughout: the opencode connector is a stdio transport; HTTP status is not exposed.
- raw stdout/stderr are captured raw via a tee-spawn wrapper alongside the production bridge's own summary — both layers are kept separate.
- The canonical probe asks for exactly one JSON object; a model that chose to call tools or answer conversationally produces the recorded dialect as-is (corpus evidence, not a harness bug).

## Production untouched

- PRODUCTION_PARSER_CHANGED: NO
- COUNCIL_VALIDATOR_CHANGED: NO
- EVIDENCE_VALIDATOR_CHANGED: NO
- OPENCODE_PRODUCTION_BRIDGE_CHANGED: NO (bridge used as-is: src/session/opencode-cli-session-bridge.mjs)
- OPENCODE_STDIN_TRANSPORT_CHANGED: NO (canonical probe delivered through the repaired production stdin transport, d1f5a27)
- Parse observation ran through the real production boundary (createCliPmDriver -> parseDecision / normalizePmDecision, product=opencode).
`;

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(JSON.stringify({ report_path: REPORT_PATH, attempted, captureCompleted, captureFailed, providerSuccess, providerError, providerUnknown, parsePass, parseFail, dialectCounts, repeatCandidates }, null, 2));
}

// ---------------------------------------------------------------------------
// Repeat-confirmation subcommand (closure PHASE 3/6). Runs ONE additional
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
  const configuration = (inventory.planned_configurations ?? []).find((c) => c.model === model && c.selected_variant === reasoning);
  if (!configuration) fail(`no baseline configuration matches model=${model} reasoning=${reasoning}; repeat candidates must repeat an existing baseline configuration`, 'REPEAT_CONFIG_NOT_IN_BASELINE');
  const runDir = join(RUNS_ROOT, modelSlug(model), reasoningSlug(reasoning), runLabel);
  if (existsSync(join(runDir, 'metadata.json'))) fail(`refusing to overwrite existing repeat run: ${runDir}`, 'REPEAT_RUN_ALREADY_EXISTS');

  const promptBuffer = readFileSync(CANONICAL_PROBE_PATH);
  const prompt = promptBuffer.toString('utf8');
  const promptMeta = { sha256: sha256OfBytes(promptBuffer), bytes: promptBuffer.length };
  const repo = gitInfo();
  const binary = resolveOpenCodeBinary();
  const connectorVersion = inventory.connector_version ?? await opencodeConnectorVersion(binary);

  console.error(`Repeat sample ${runLabel}: model=${model} variant=${reasoning} ...`);
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
    console.error('Usage: node opencode-baseline.mjs <inventory|collect|repeat|report> [--run=run-00N --model=<slug> --reasoning=<level>]');
    process.exit(2);
  }
  Promise.resolve(commands[subcommand](process.argv.slice(3))).catch((error) => {
    console.error(`FATAL: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
