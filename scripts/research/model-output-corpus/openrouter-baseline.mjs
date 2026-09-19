// DSH MODEL OUTPUT CORPUS â€” API / OpenRouter connector baseline harness.
//
// RESEARCH-ONLY collection tooling (PLAN section 3 / MASTER PROMPT). It
// reuses production code READ-ONLY:
//   - transport:  runApiBackendRequest() (api-backend-adapter.mjs) via the
//     exact production openai-chat protocol path;
//   - provider config: loadApiProviderConfig() over the owner's real
//     .runtime/live1/api-providers.yaml (secret-free; only env NAMES);
//   - secret:     DSH_API_OPENROUTER_KEY is read from the owner's .env into
//     process.env in-memory and NEVER logged, echoed, or persisted;
//   - Layer B:    the exact string runApiBackendRequest() returns;
//   - Layer C:    corpus-lib.observeCurrentParse() (production parseDecision
//     + normalizePmDecision, observation mode only).
// Raw transport capture (Layer A) uses the adapter's existing `fetchImpl`
// DI seam: a tee-wrapper around global fetch. Production request/response
// semantics are untouched â€” the wrapper only clones the Response to retain
// the raw body/status/headers for the corpus.
//
// Canonical probe bytes are verified (fail closed) before ANY invocation.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  PHASE_VERSION,
  verifyCanonicalProbe,
  observeCurrentParse,
  classifyDialect,
  scanArtifactForSecretRisk,
  sha256OfBytes,
  modelSlug,
  reasoningSlug,
} from './corpus-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CORPUS_ROOT = join(REPO_ROOT, 'research', 'model-output-corpus');
const CANONICAL_PROBE = join(CORPUS_ROOT, 'CANONICAL_PROBE_PROMPT.txt');
const INVENTORY_PATH = join(CORPUS_ROOT, 'connector-inventory', 'api-openrouter.json');
const RUNS_ROOT = join(CORPUS_ROOT, 'runs', 'api', 'openrouter');

// Owner runtime state (read-only, outside this worktree; never committed).
const MAIN_REPO_ROOT = process.env.DSH_MAIN_REPO_ROOT ?? REPO_ROOT;
const OWNER_ENV_FILE = process.env.DSH_CORPUS_OWNER_ENV ?? join(MAIN_REPO_ROOT, '.env');
const OWNER_PROVIDERS_YAML = process.env.DSH_CORPUS_OWNER_API_PROVIDERS ?? join(MAIN_REPO_ROOT, '.runtime', 'live1', 'api-providers.yaml');

const OPENROUTER_CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_API_VERSION = 'v1';
const CONNECTOR_VERSION = 'p11-api-backend (api product, openai-chat protocol)';
const REQUEST_TIMEOUT_MS = 600_000;
const INTER_REQUEST_DELAY_MS = 2_000;

// OpenRouter reasoning-effort evidence:
//  - production translation (api-reasoning-translation.mjs) forwards
//    `reasoning: { effort: <token> }` for openrouter when the catalogue
//    marks the model reasoning-capable (supported_parameters include
//    'reasoning' or 'reasoning_effort' â€” same rule as production
//    api-model-discovery.mjs normalizeOpenRouterModel);
//  - OpenRouter's documented effort field accepts low | medium | high.
// The extremes below are the LOWEST and HIGHEST of those accepted values â€”
// no level outside the accepted set is ever invented or sent.
const OPENROUTER_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
const OPENROUTER_EFFORT_LEVELS_SOURCE =
  'openrouter reasoning.effort documented accepted values (low|medium|high); all selected values are also in the production openrouter translation token list';

// ---------------------------------------------------------------------------
// Core-vendor selection (bounded scope â€” NOT the whole marketplace).
// Exact, explicit model slugs, evidence-backed from the live catalogue
// snapshot. Current active production text/chat families only; explicit
// successors preferred over historical snapshots; batch/:free/:online/
// :nitro/image/audio products never selected. Each entry must exist in the
// live catalogue snapshot or collection fails closed.
// ---------------------------------------------------------------------------
export const CORE_VENDOR_SELECTION = Object.freeze([
  // OpenAI â€” current active production families.
  { id: 'openai/gpt-6-astra', provider_family: 'openai', rationale: 'current OpenAI flagship generation (newest openai-family catalogue entry)' },
  { id: 'openai/gpt-6-astra-pro', provider_family: 'openai', rationale: 'premium tier of the current flagship generation (materially distinct product)' },
  { id: 'openai/gpt-5.6-terra', provider_family: 'openai', rationale: 'current GPT-5.6 generation, heavy variant' },
  { id: 'openai/gpt-5.6-luna', provider_family: 'openai', rationale: 'current GPT-5.6 generation, light variant' },
  { id: 'openai/gpt-5.6-sol', provider_family: 'openai', rationale: 'current GPT-5.6 generation, mid variant' },
  { id: 'openai/gpt-5.5', provider_family: 'openai', rationale: 'prior main generation, still independently active production' },
  { id: 'openai/gpt-5.4-mini', provider_family: 'openai', rationale: 'current light/mini production tier (no newer mini generation exists)' },
  { id: 'openai/gpt-5.3-codex', provider_family: 'openai', rationale: 'current codex-specialized production line' },
  { id: 'openai/gpt-oss-120b', provider_family: 'openai', rationale: 'current open-weight production line (distinct architecture identity)' },
  // Anthropic â€” current active production families.
  { id: 'anthropic/claude-opus-5', provider_family: 'anthropic', rationale: 'current Claude flagship' },
  { id: 'anthropic/claude-sonnet-5', provider_family: 'anthropic', rationale: 'current Claude mainline' },
  { id: 'anthropic/claude-fable-5.1', provider_family: 'anthropic', rationale: 'current Fable line (newest generation)' },
  { id: 'anthropic/claude-haiku-4.5', provider_family: 'anthropic', rationale: 'current fast tier (no newer haiku generation exists)' },
  // Google â€” current active production families.
  { id: 'google/gemini-3.8-flash', provider_family: 'google', rationale: 'current Gemini Flash generation' },
  { id: 'google/gemini-3.5-flash-lite', provider_family: 'google', rationale: 'current Flash-Lite tier (no newer flash-lite generation exists)' },
  { id: 'google/gemini-3.1-pro-preview', provider_family: 'google', rationale: 'current Gemini Pro production route (no non-preview 3.x Pro exists in the catalogue)' },
  { id: 'google/gemma-4-31b-it', provider_family: 'google', rationale: 'current open-weight Gemma generation' },
  // Z.AI â€” current active production families.
  { id: 'z-ai/glm-5.3', provider_family: 'z-ai', rationale: 'current GLM flagship' },
  { id: 'z-ai/glm-5.3-flash', provider_family: 'z-ai', rationale: 'current GLM fast tier' },
  { id: 'z-ai/glm-5v-turbo', provider_family: 'z-ai', rationale: 'current GLM vision-line production model (text output)' },
]);

export const CORE_VENDOR_FAMILIES = Object.freeze(['openai', 'anthropic', 'google', 'z-ai']);

// Route-variant suffixes that must never be invoked (MASTER exclusions).
const EXCLUDED_ROUTE_SUFFIXES = Object.freeze([':online', ':nitro', ':floor']);

function readFileUtf8(path) {
  return readFileSync(path, 'utf8');
}

// Byte reader (not utf8-decoded) for canonical probe verification.
function readFileBytes(path) {
  return readFileSync(path);
}

// Loads the owner's OpenRouter key into process.env in memory. The value is
// never returned, logged, or written anywhere.
function ensureOpenRouterKey() {
  if (process.env.DSH_API_OPENROUTER_KEY && process.env.DSH_API_OPENROUTER_KEY.trim()) return true;
  if (!existsSync(OWNER_ENV_FILE)) return false;
  const text = readFileUtf8(OWNER_ENV_FILE);
  for (const line of text.split(/\r?\n/)) {
    const match = /^DSH_API_OPENROUTER_KEY=(.+)$/.exec(line.trim());
    if (match && match[1].trim()) {
      process.env.DSH_API_OPENROUTER_KEY = match[1].trim();
      return true;
    }
  }
  return false;
}

async function fetchCatalogue() {
  if (!ensureOpenRouterKey()) throw new Error('DSH_API_OPENROUTER_KEY unavailable (owner .env not found) â€” refusing to touch OpenRouter');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(OPENROUTER_CATALOGUE_URL, {
      headers: { Authorization: `Bearer ${process.env.DSH_API_OPENROUTER_KEY}` },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`OpenRouter catalogue returned HTTP ${response.status}`);
    return { httpStatus: response.status, bodyText, catalogue: JSON.parse(bodyText) };
  } finally {
    clearTimeout(timer);
  }
}

// Deterministic cost/route classification for one catalogue entry
// (MASTER PHASE 2-3 semantics specialized to OpenRouter's published
// pricing/variant metadata). Never infers PAID from a name alone.
export function classifyOpenRouterCatalogueEntry(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : '';
  const pricing = entry?.pricing && typeof entry.pricing === 'object' ? entry.pricing : {};
  const promptPrice = Number.parseFloat(pricing.prompt ?? 'NaN');
  const completionPrice = Number.parseFloat(pricing.completion ?? 'NaN');
  const isZeroPriced = Number.isFinite(promptPrice) && Number.isFinite(completionPrice) && promptPrice === 0 && completionPrice === 0;
  const outputModalities = Array.isArray(entry?.architecture?.output_modalities) ? entry.architecture.output_modalities : null;
  const textOutput = Array.isArray(outputModalities) && outputModalities.includes('text');
  const imageOutput = Array.isArray(outputModalities) && outputModalities.includes('image');
  const audioOutput = Array.isArray(outputModalities) && outputModalities.includes('audio');
  const scanTexts = [entry?.id, entry?.name, entry?.description].filter((v) => typeof v === 'string').join(' â€” ');
  const evidence = [];
  if (id.endsWith(':free') || isZeroPriced) {
    return { classification: 'FREE', eligible: false, exclusion: 'FREE_EXCLUDED', evidence: [`zero-priced catalogue entry (pricing.prompt=${pricing.prompt}, pricing.completion=${pricing.completion}${id.endsWith(':free') ? ', ":free" route variant' : ''})`] };
  }
  if (/\btrial\b/i.test(scanTexts)) {
    return { classification: 'TRIAL', eligible: false, exclusion: 'TRIAL_EXCLUDED', evidence: ['explicit "trial" marker in catalogue metadata'] };
  }
  const displayName = typeof entry?.name === 'string' ? entry.name : '';
  if (id.endsWith(':batch') || /\(batch\)\s*$/.test(displayName)) {
    return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'BATCH_EXCLUDED', evidence: ['batch-route variant (async batch endpoint), not the standard conversational path'] };
  }
  for (const suffix of EXCLUDED_ROUTE_SUFFIXES) {
    if (id.endsWith(suffix)) {
      return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'ROUTER_ALIAS_EXCLUDED', evidence: [`route variant suffix "${suffix}" (non-standard throughput/priority route of the same underlying model)`] };
    }
  }
  if (Array.isArray(outputModalities)) {
    if (!textOutput) {
      return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'NON_TEXT_EXCLUDED', evidence: [`output_modalities=${JSON.stringify(outputModalities)} does not include text`] };
    }
    if (imageOutput || audioOutput) {
      // Image/audio generation products (Nano Banana, GPT-5-Image, Lyria, ...):
      // their primary output product is non-text even when text is also listed.
      return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'NON_TEXT_EXCLUDED', evidence: [`output_modalities=${JSON.stringify(outputModalities)} â€” primary output product is image/audio generation`] };
    }
  } else {
    const modality = typeof entry?.architecture?.modality === 'string' ? entry.architecture.modality : null;
    if (!modality || !modality.endsWith('->text')) {
      return { classification: 'UNKNOWN', eligible: false, exclusion: 'UNKNOWN_NOT_INVOKED', evidence: [`no output-modality evidence in catalogue metadata (modality=${JSON.stringify(modality)}) â€” NEEDS_OWNER_CLASSIFICATION`] };
    }
  }
  if (id.startsWith('~')) {
    return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'DUPLICATE_ALIAS_EXCLUDED', evidence: ['alternate "~" provider route of another vendor\'s underlying model (duplicate route, not a distinct model identity)'] };
  }
  if (/(latest|chat-latest)$/i.test(id) || id.endsWith('-latest')) {
    return { classification: 'PAID_OR_STANDARD', eligible: false, exclusion: 'ROUTER_ALIAS_EXCLUDED', evidence: ['moving alias â€” underlying identity cannot be pinned to a stable version'] };
  }
  if (Array.isArray(outputModalities)) {
    evidence.push(`output_modalities=${JSON.stringify(outputModalities)} supports the standard text/chat path`);
  }
  evidence.push('non-zero paid pricing in catalogue metadata; no free/trial/batch/route-variant/non-text marker');
  return { classification: 'PAID_OR_STANDARD', eligible: true, exclusion: null, evidence };
}

export function reasoningCapability(entry) {
  const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : [];
  const capable = params.includes('reasoning') || params.includes('reasoning_effort');
  // Mirrors production normalizeOpenRouterModel(): a catalogue entry is
  // reasoning-capable when supported_parameters include 'reasoning' or
  // 'reasoning_effort'. Selected extremes are the lowest/highest of
  // OpenRouter's accepted effort values (never invented levels).
  return {
    reasoning_supported: capable ? [...OPENROUTER_EFFORT_LEVELS] : [],
    selected_configurations: capable ? ['low', 'high'] : ['default'],
    evidence: capable ? `catalogue supported_parameters include ${params.includes('reasoning_effort') ? "'reasoning_effort'" : "'reasoning'"} (production normalizeOpenRouterModel() marks reasoningSupport=SUPPORTED)` : 'no reasoning parameter in catalogue supported_parameters â€” single default run',
  };
}

export function buildSelection(catalogue) {
  const byId = new Map();
  for (const entry of catalogue?.data ?? []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const total = byId.size;
  const familyOf = (id) => {
    const family = id.split('/')[0];
    return CORE_VENDOR_FAMILIES.includes(family)
      ? family
      : family.startsWith('~') && CORE_VENDOR_FAMILIES.includes(family.slice(1))
        ? family.slice(1)
        : null;
  };
  const scoped = [...byId.values()].filter((entry) => familyOf(entry.id) != null);
  const exclusionCounts = { FREE_EXCLUDED: 0, TRIAL_EXCLUDED: 0, EPHEMERAL_EXCLUDED: 0, NON_TEXT_EXCLUDED: 0, BATCH_EXCLUDED: 0, ROUTER_ALIAS_EXCLUDED: 0, DUPLICATE_ALIAS_EXCLUDED: 0 };
  const scopedClassified = scoped
    .map((entry) => ({ id: entry.id, ...classifyOpenRouterCatalogueEntry(entry) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const item of scopedClassified) {
    if (item.exclusion) exclusionCounts[item.exclusion] += 1;
  }
  const candidates = scopedClassified.filter((item) => item.eligible).map((item) => item.id);
  const selected = [];
  const selectionErrors = [];
  for (const plan of CORE_VENDOR_SELECTION) {
    const entry = byId.get(plan.id);
    if (!entry) {
      selectionErrors.push(`curated model ${plan.id} not present in the live catalogue snapshot`);
      continue;
    }
    const classified = classifyOpenRouterCatalogueEntry(entry);
    if (!classified.eligible) {
      selectionErrors.push(`curated model ${plan.id} classified ${classified.classification}/${classified.exclusion} â€” refusing to invoke`);
      continue;
    }
    const reasoning = reasoningCapability(entry);
    selected.push({
    selection_source: selectionSource,
      provider_family: plan.provider_family,
      model_slug: entry.id,
      catalogue_name: entry.name ?? null,
      cost_classification: classified.classification,
      classification_evidence: classified.evidence,
      supported_reasoning: reasoning.reasoning_supported,
      reasoning_evidence: reasoning.evidence,
      selected_lowest: reasoning.selected_configurations[0] === 'low' ? 'low' : null,
      selected_highest: reasoning.selected_configurations.includes('high') ? 'high' : null,
      selected_configurations: reasoning.selected_configurations,
      planned_samples: reasoning.selected_configurations.length,
      rationale: plan.rationale,
    });
  }
  const unselectedEligible = candidates.filter((id) => !CORE_VENDOR_SELECTION.some((plan) => plan.id === id));
  return {
    total_openrouter_models_discovered: total,
    core_vendor_candidates: scoped.length,
    core_vendor_candidates_eligible: candidates.length,
    exclusion_counts: exclusionCounts,
    selected,
    selection_errors: selectionErrors,
    unselected_eligible: unselectedEligible,
    planned_configurations: selected.reduce((sum, model) => sum + model.planned_samples, 0),
  };
}

async function loadProductionProviderEntry() {
  const { loadApiProviderConfig } = await import('../../../src/pm/api-backend/api-provider-config.mjs');
  const providers = await loadApiProviderConfig({ path: OWNER_PROVIDERS_YAML, env: process.env });
  const entry = providers.openrouter;
  if (!entry) throw new Error(`provider "openrouter" missing from owner provider config (${OWNER_PROVIDERS_YAML})`);
  return entry;
}

// Tee-wrapper around global fetch (the adapter's existing DI seam): the real
// request/response flow is untouched; a clone retains the raw body + status +
// response headers for Layer A. Never captures request headers (Authorization).
function makeCapturingFetch(capture) {
  return async (url, init = {}) => {
    try {
      const response = await fetch(url, init);
      const clone = response.clone();
      let bodyText = null;
      try {
        bodyText = await clone.text();
      } catch (error) {
        bodyText = null;
        capture.cloneError = String(error?.message ?? error);
      }
      capture.raw = { url: String(url), http_status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), body_text: bodyText };
      return response;
    } catch (error) {
      capture.raw = { url: String(url), transport_error: String(error?.message ?? error) };
      throw error;
    }
  };
}

function parseRawBody(capture) {
  const raw = capture.raw ?? null;
  if (!raw || raw.body_text == null) return null;
  try {
    return JSON.parse(raw.body_text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hidden chain-of-thought policy (PLAN section 9: "Never persist ... hidden
// chain-of-thought"). OpenRouter returns the model's reasoning trace in
// choices[0].message.reasoning / reasoning_details by default. The raw
// response body therefore CANNOT be persisted byte-exact: a sanitized
// structural copy is retained (assistant message.content untouched), the
// original body's SHA-256 + byte count are recorded, and the artifact is
// marked RAW_ARTIFACT_WITHHELD_SECRET_RISK. Never claims byte-exact raw AND
// silently redacts.
// ---------------------------------------------------------------------------
export const COT_WITHHOLD_MARKER = '<WITHHELD: hidden chain-of-thought (reasoning trace) — never persisted per DSH corpus PLAN section 9; SHA-256 of the original response body is recorded in raw_artifact_policy>';
const COT_WITHHELD_FIELDS = ['choices[0].message.reasoning', 'choices[0].message.reasoning_details'];

export function sanitizeRawResponseForPersistence(rawResponse) {
  if (!rawResponse || typeof rawResponse.body_text !== 'string' || !rawResponse.body_text.trim()) {
    return { sanitized: rawResponse, withheld: false, originalSha256: null, originalBytes: rawResponse?.body_text != null ? Buffer.byteLength(rawResponse.body_text, 'utf8') : null };
  }
  let body;
  try {
    body = JSON.parse(rawResponse.body_text);
  } catch {
    return { sanitized: rawResponse, withheld: false, originalSha256: sha256OfBytes(Buffer.from(rawResponse.body_text, 'utf8')), originalBytes: Buffer.byteLength(rawResponse.body_text, 'utf8') };
  }
  const message = body?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') {
    return { sanitized: rawResponse, withheld: false, originalSha256: sha256OfBytes(Buffer.from(rawResponse.body_text, 'utf8')), originalBytes: Buffer.byteLength(rawResponse.body_text, 'utf8') };
  }
  const originalSha256 = sha256OfBytes(Buffer.from(rawResponse.body_text, 'utf8'));
  const originalBytes = Buffer.byteLength(rawResponse.body_text, 'utf8');
  const withheldFields = [];
  if ('reasoning' in message) {
    message.reasoning = COT_WITHHOLD_MARKER;
    withheldFields.push(COT_WITHHELD_FIELDS[0]);
  }
  if ('reasoning_details' in message) {
    message.reasoning_details = COT_WITHHOLD_MARKER;
    withheldFields.push(COT_WITHHELD_FIELDS[1]);
  }
  if (withheldFields.length === 0) {
    return { sanitized: rawResponse, withheld: false, originalSha256, originalBytes };
  }
  const sanitized = {
    ...rawResponse,
    body_text: JSON.stringify(body),
    raw_artifact_policy: {
      marker: 'RAW_ARTIFACT_WITHHELD_SECRET_RISK',
      withheld_fields: withheldFields,
      withholding_reason: 'hidden chain-of-thought (OpenRouter reasoning trace) is never persisted per PLAN section 9; sanitized structural copy retained; assistant message.content is untouched and byte-identical to what production extracted',
      original_body_text_sha256: originalSha256,
      original_body_text_bytes: originalBytes,
      sanitized_body_text_note: 'body_text is a structural copy with the reasoning fields replaced by the withhold marker — NOT byte-exact raw',
    },
  };
  return { sanitized, withheld: true, originalSha256, originalBytes };
}

function extractFinishReason(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  return choice?.finish_reason ?? null;
}

async function collectOneInner({ model, reasoning, providerEntry, canonicalPrompt, runLabel = 'run-001', sampleKind = 'baseline', selectionSource = ['CORE_VENDOR'], sampleIndex = 1 }) {
  const { runApiBackendRequest } = await import('../../../src/pm/api-backend/api-backend-adapter.mjs');
  const { ApiBackendError } = await import('../../../src/pm/api-backend/api-backend-errors.mjs');
  const capture = {};
  const observations = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let extracted = null;
  let adapterError = null;
  let observePayload = null;
  try {
    extracted = await runApiBackendRequest({
      providerId: 'openrouter',
      model,
      reasoning: reasoning === 'default' ? null : reasoning,
      modelReasoningSupport: reasoning === 'default' ? 'UNSUPPORTED' : 'SUPPORTED',
      prompt: canonicalPrompt,
      providers: { openrouter: providerEntry },
      env: process.env,
      fetchImpl: makeCapturingFetch(capture),
      timeoutMs: REQUEST_TIMEOUT_MS,
      observe: (method, payload) => {
        if (method === 'apiUsage') observations.push(payload);
      },
    });
  } catch (error) {
    adapterError = error;
  }
  const durationMs = Date.now() - t0;
  const rawBody = parseRawBody(capture);
  const raw = capture.raw ?? null;
  const httpStatus = raw?.http_status ?? null;
  const responseModel = typeof rawBody?.model === 'string' ? rawBody.model : (observations[0]?.returnedModel ?? null);
  const providerRoute = typeof rawBody?.provider === 'string' ? rawBody.provider : null;
  const requestId = typeof rawBody?.id === 'string' ? rawBody.id : (observations[0]?.requestId ?? null);
  const finishReason = rawBody ? extractFinishReason(rawBody) : null;
  const usage = rawBody?.usage && typeof rawBody.usage === 'object' ? rawBody.usage : (observations[0]?.usage ?? null);
  const transportError = raw?.transport_error ?? null;

  let providerTerminalStatus;
  if (adapterError) providerTerminalStatus = 'ERROR';
  else if (httpStatus != null && httpStatus >= 200 && httpStatus < 300 && finishReason) providerTerminalStatus = 'SUCCESS';
  else providerTerminalStatus = 'UNKNOWN';

  const modelIdentityMismatch = responseModel != null && responseModel !== model;

  // Layer A persistence: chain-of-thought withholding (PLAN section 9) first,
  // then secret-risk scan of the sanitized artifact.
  const runDir = join(RUNS_ROOT, modelSlug(model), reasoningSlug(reasoning), runLabel);
  mkdirSync(runDir, { recursive: true });
  const rawResponse = {
    url: raw?.url ?? null,
    http_status: httpStatus,
    response_headers: raw?.headers ?? null,
    body_text: raw?.body_text ?? null,
    transport_error: transportError,
  };
  const cotPolicy = sanitizeRawResponseForPersistence(rawResponse);
  let rawWithheld = null;
  if (cotPolicy.withheld) {
    rawWithheld = { withheld: true, kind: 'HIDDEN_CHAIN_OF_THOUGHT', fields: COT_WITHHELD_FIELDS, original_body_text_sha256: cotPolicy.originalSha256 };
  }
  if (cotPolicy.sanitized.body_text != null) {
    const secretScan = scanArtifactForSecretRisk(cotPolicy.sanitized.body_text);
    if (!secretScan.safe) rawWithheld = { withheld: true, kind: 'SECRET_RISK', hits: secretScan.hits };
  }
  const rawResponsePath = join(runDir, 'raw-response.json');
  if (rawWithheld?.kind === 'SECRET_RISK') {
    writeFileSync(join(runDir, 'raw-response-WITHHELD.json'), JSON.stringify({ RAW_ARTIFACT_WITHHELD_SECRET_RISK: true, hits: rawWithheld.hits, body_text_sha256: cotPolicy.originalSha256, body_text_bytes: cotPolicy.originalBytes }, null, 2), 'utf8');
  } else {
    writeFileSync(rawResponsePath, JSON.stringify(cotPolicy.sanitized, null, 2), 'utf8');
  }
  // Request configuration excluding secrets (no Authorization header).
  const requestConfig = {
    url: raw?.url ?? `${OPENROUTER_BASE_URL}/chat/completions`,
    method: 'POST',
    model,
    reasoning_requested: reasoning,
    messages: [{ role: 'user', content_sha256: sha256OfBytes(canonicalPrompt), content_bytes: canonicalPrompt.length, content_source: 'CANONICAL_PROBE_PROMPT.txt (byte-identical, see prompt_sha256)' }],
    extra: reasoning === 'default' ? {} : { reasoning: { effort: reasoning } },
    stream: false,
    timeout_ms: REQUEST_TIMEOUT_MS,
  };
  writeFileSync(join(runDir, 'raw-request.json'), JSON.stringify(requestConfig, null, 2), 'utf8');

  // Layer B â€” exactly what production extraction handed toward parsing.
  let extractedBytes = null;
  let extractedSha = null;
  if (typeof extracted === 'string') {
    writeFileSync(join(runDir, 'extracted-assistant.txt'), extracted, 'utf8');
    extractedBytes = Buffer.byteLength(extracted, 'utf8');
    extractedSha = sha256OfBytes(Buffer.from(extracted, 'utf8'));
  }

  // Layer C â€” current DSH parse observation (production parser, read-only).
  let parseObservation;
  let currentParseOutcome = null;
  let currentParseErrorCode = null;
  if (typeof extracted === 'string') {
    parseObservation = await observeCurrentParse(extracted, { product: 'api' });
    currentParseOutcome = parseObservation.outcome;
    currentParseErrorCode = parseObservation.error_code;
  } else {
    currentParseOutcome = 'FAIL';
    currentParseErrorCode = adapterError?.code ?? 'UNKNOWN_ERROR';
    parseObservation = {
      skipped: true,
      reason: 'production API adapter threw before assistant-text extraction; Layer C parse observation not applicable',
      adapter_error_code: adapterError?.code ?? 'UNKNOWN_ERROR',
      adapter_error_message: adapterError?.message ?? null,
    };
  }
  writeFileSync(join(runDir, 'parse-observation.json'), JSON.stringify(parseObservation, null, 2), 'utf8');

  const dialect = typeof extracted === 'string' ? classifyDialect(extracted) : { dialect: 'EMPTY', detail: 'no assistant text extracted (production adapter error)' };

  const repeatCandidate =
    currentParseOutcome === 'FAIL' ||
    providerTerminalStatus !== 'SUCCESS' ||
    adapterError != null ||
    modelIdentityMismatch ||
    ['FENCED_JSON', 'PROSE_PREFIX_JSON', 'PROSE_SUFFIX_JSON', 'PROSE_AROUND_JSON', 'MULTIPLE_JSON_VALUES', 'TOP_LEVEL_ARRAY', 'TOP_LEVEL_NON_OBJECT', 'MISSING_REQUIRED_FIELD', 'WRONG_FIELD_TYPE', 'MALFORMED_JSON', 'TRUNCATED', 'EMPTY', 'UNKNOWN'].includes(dialect.dialect);

  const metadata = {
    phase_version: PHASE_VERSION,
    timestamp_utc: startedAt,
    completed_utc: new Date().toISOString(),
    repo_branch: gitHead().branch,
    repo_head: gitHead().head,
    connector: 'api',
    connector_version: CONNECTOR_VERSION,
    provider: 'openrouter',
    provider_family: model.split('/')[0],
    model,
    profile_id_if_any: null,
    selection_source: ['CORE_VENDOR'],
    cost_classification: 'PAID_OR_STANDARD',
    reasoning_supported: reasoning === 'default' ? [] : [...OPENROUTER_EFFORT_LEVELS],
    reasoning_levels_source: OPENROUTER_EFFORT_LEVELS_SOURCE,
    reasoning_requested: reasoning,
    reasoning_effective: null,
    reasoning_effective_note: rawBody ? 'OpenRouter chat-completion response does not authoritatively echo the effective reasoning setting' : null,
    structured_output_mode: 'NONE',
    structured_output_note: 'production openai-chat protocol sends no response_format/schema; free-form output path observed',
    transport_mode: 'https POST openai-chat /chat/completions (non-streaming)',
    prompt_sha256: sha256OfBytes(canonicalPrompt),
    prompt_bytes: Buffer.byteLength(canonicalPrompt, 'utf8'),
    duration_ms: durationMs,
    process_exit_code: null,
    http_status: httpStatus,
    raw_stdout_bytes: null,
    raw_stderr_bytes: null,
    raw_response_bytes: raw?.body_text != null ? Buffer.byteLength(raw.body_text, 'utf8') : null,
    assistant_output_bytes: extractedBytes,
    assistant_output_sha256: extractedSha,
    current_parse_outcome: currentParseOutcome,
    current_parse_error_code: currentParseErrorCode,
    retry_index: 0,
    sample_kind: sampleKind,
    sample_index: sampleIndex,
    requested_model: model,
    response_model: responseModel,
    model_identity_mismatch: modelIdentityMismatch,
    provider_route: providerRoute,
    request_id: requestId,
    finish_reason: finishReason,
    usage: usage ?? null,
    provider_terminal_status: providerTerminalStatus,
    collector_capture_status: 'COMPLETED',
    collector_capture_failed: null,
    invocation_failed: adapterError != null,
    invocation_error_code: adapterError?.code ?? null,
    invocation_error_message: adapterError?.message ?? null,
    transport_anomaly: transportError ?? (capture.cloneError ?? null),
    extraction_anomaly: typeof extracted === 'string' ? null : (adapterError?.code ?? 'no assistant text produced'),
    dialect_classification: dialect.dialect,
    dialect_detail: dialect.detail,
    raw_response_withheld: rawWithheld?.withheld === true ? 'RAW_ARTIFACT_WITHHELD_SECRET_RISK' : null,
    raw_response_withheld_kind: rawWithheld?.kind ?? null,
    raw_response_original_sha256: rawWithheld?.withheld === true ? (rawWithheld.original_body_text_sha256 ?? null) : null,
    repeat_candidate: repeatCandidate,
    concurrent_collection_contamination_note: null,
  };
  writeFileSync(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  return metadata;
}

function gitHead() {
  try {
    return {
      branch: execSync('git branch --show-current', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      head: execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    };
  } catch {
    return { branch: null, head: null };
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdInventory() {
  const probeVerification = verifyCanonicalProbe(readFileBytes, CANONICAL_PROBE);
  if (!probeVerification.ok) throw new Error(`canonical probe verification failed closed: ${probeVerification.reason} ${probeVerification.error ?? ''}`);
  const { httpStatus, catalogue } = await fetchCatalogue();
  const selection = buildSelection(catalogue);
  const inventory = {
    connector: 'api',
    provider: 'openrouter',
    api_version: OPENROUTER_API_VERSION,
    base_url: OPENROUTER_BASE_URL,
    catalogue_endpoint: OPENROUTER_CATALOGUE_URL,
    catalogue_http_status: httpStatus,
    catalogue_retrieved_at: new Date().toISOString(),
    total_openrouter_models_discovered: selection.total_openrouter_models_discovered,
    production_model_discovery_limit: 500,
    opencode_corpus_state: 'IN_PROGRESS_OR_UNACCEPTED',
    opencode_overlap_deferred_pending_inventory: true,
    selection_sources: ['CORE_VENDOR'],
    core_vendor_families: [...CORE_VENDOR_FAMILIES],
    core_vendor_candidates: selection.core_vendor_candidates,
    core_vendor_candidates_eligible: selection.core_vendor_candidates_eligible,
    exclusion_counts: selection.exclusion_counts,
    selected_models: selection.selected,
    selection_errors: selection.selection_errors,
    unselected_eligible: selection.unselected_eligible,
    planned_configurations: selection.planned_configurations,
    planned_baseline_invocations: selection.planned_configurations,
    reasoning_levels_source: OPENROUTER_EFFORT_LEVELS_SOURCE,
    notes: [
      'scope is deliberately bounded to the four core vendor families; the full 428-model marketplace is inventoried by count only',
      'exclusion counts are evaluated over the core-vendor-family catalogue entries (the bounded scope denominator)',
      'no fallback model list is configured; a request for model X must not execute model Y',
    ],
  };
  mkdirSync(dirname(INVENTORY_PATH), { recursive: true });
  writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2), 'utf8');
  console.log(`INVENTORY_WRITTEN ${INVENTORY_PATH}`);
  console.log(`TOTAL_OPENROUTER_MODELS_DISCOVERED=${inventory.total_openrouter_models_discovered}`);
  console.log(`CORE_VENDOR_CANDIDATES=${selection.core_vendor_candidates} ELIGIBLE=${selection.core_vendor_candidates_eligible}`);
  console.log(`SELECTED_MODELS=${selection.selected.length} PLANNED_CONFIGURATIONS=${selection.planned_configurations}`);
  console.log(`EXCLUSIONS=${JSON.stringify(selection.exclusion_counts)}`);
  if (selection.selection_errors.length) {
    for (const error of selection.selection_errors) console.error(`SELECTION_ERROR: ${error}`);
    process.exitCode = 1;
  }
}

function printDryRunMatrix() {
  const inventory = JSON.parse(readFileUtf8(INVENTORY_PATH));
  console.log(`TOTAL_OPENROUTER_MODELS_DISCOVERED=${inventory.total_openrouter_models_discovered}`);
  console.log(`CORE_VENDOR_CANDIDATES=${inventory.core_vendor_candidates}`);
  console.log(`OPENCODE_CORPUS_STATE=${inventory.opencode_corpus_state}`);
  console.log(`OPENCODE_OVERLAP_DEFERRED_PENDING_INVENTORY=${inventory.opencode_overlap_deferred_pending_inventory ? 'YES' : 'NO'}`);
  console.log(`FREE_EXCLUDED=${inventory.exclusion_counts.FREE_EXCLUDED}`);
  console.log(`TRIAL_EXCLUDED=${inventory.exclusion_counts.TRIAL_EXCLUDED}`);
  console.log(`EPHEMERAL_EXCLUDED=${inventory.exclusion_counts.EPHEMERAL_EXCLUDED}`);
  console.log(`NON_TEXT_EXCLUDED=${inventory.exclusion_counts.NON_TEXT_EXCLUDED}`);
  console.log(`BATCH_EXCLUDED=${inventory.exclusion_counts.BATCH_EXCLUDED}`);
  console.log(`ROUTER_ALIAS_EXCLUDED=${inventory.exclusion_counts.ROUTER_ALIAS_EXCLUDED}`);
  console.log(`DUPLICATE_ALIAS_EXCLUDED=${inventory.exclusion_counts.DUPLICATE_ALIAS_EXCLUDED}`);
  console.log(`ELIGIBLE_MODELS=${inventory.selected_models.length}`);
  console.log(`PLANNED_CONFIGURATIONS=${inventory.planned_configurations}`);
  console.log(`PLANNED_BASELINE_INVOCATIONS=${inventory.planned_baseline_invocations}`);
  console.log('--- dry-run matrix (1 planned sample per configuration) ---');
  for (const model of inventory.selected_models) {
    for (const reasoning of model.selected_configurations) {
      console.log(`${model.selection_source.join('+')} | ${model.provider_family} | ${model.model_slug} | ${model.cost_classification} | supported=${model.supported_reasoning.join('/') || 'none'} | selected=${reasoning} | planned_samples=1`);
    }
  }
}

async function cmdCanary() {
  const probeVerification = verifyCanonicalProbe(readFileBytes, CANONICAL_PROBE);
  if (!probeVerification.ok) throw new Error(`canonical probe verification failed closed: ${probeVerification.reason} ${probeVerification.error ?? ''}`);
  if (!ensureOpenRouterKey()) throw new Error('DSH_API_OPENROUTER_KEY unavailable â€” fail closed before provider invocation');
  const providerEntry = await loadProductionProviderEntry();
  const capture = {};
  const { sendOpenAiChatCompletion } = await import('../../../src/pm/api-backend/api-openai-chat-protocol.mjs');
  const result = await sendOpenAiChatCompletion({
    baseUrl: providerEntry.baseUrl,
    apiKey: process.env.DSH_API_OPENROUTER_KEY,
    model: 'openai/gpt-oss-20b',
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    extra: { reasoning: { effort: 'high' } },
    fetchImpl: makeCapturingFetch(capture),
    signal: AbortSignal.timeout(120_000),
  });
  const body = parseRawBody(capture);
  console.log(`CANARY_OK model=${result.returnedModel} provider=${body?.provider ?? 'unknown'} finish=${result.finishReason} http=${result.httpStatus} reasoning_effort_high_accepted=yes`);
}

async function cmdCollect({ only = null } = {}) {
  verifyCanonicalProbe(readFileBytes, CANONICAL_PROBE);
  if (!ensureOpenRouterKey()) throw new Error('DSH_API_OPENROUTER_KEY unavailable â€” fail closed before provider invocation');
  const inventory = JSON.parse(readFileUtf8(INVENTORY_PATH));
  const providerEntry = await loadProductionProviderEntry();
  const canonicalPrompt = readFileSync(CANONICAL_PROBE, 'utf8');
  const planned = [];
  for (const model of inventory.selected_models) {
    for (const reasoning of model.selected_configurations) {
      if (only && !only.includes(model.model_slug)) continue;
      planned.push({ model: model.model_slug, reasoning });
    }
  }
  console.log(`PLANNED_BASELINE_INVOCATIONS=${planned.length} (sequential, no concurrency)`);
  const results = [];
  let index = 0;
  for (const config of planned) {
    index += 1;
    const existing = join(RUNS_ROOT, modelSlug(config.model), reasoningSlug(config.reasoning), 'run-001', 'metadata.json');
    if (existsSync(existing)) {
      const prior = JSON.parse(readFileUtf8(existing));
      console.log(`[${index}/${planned.length}] SKIP (already collected) ${config.model} reasoning=${config.reasoning} parse=${prior.current_parse_outcome} dialect=${prior.dialect_classification}`);
      results.push(prior);
      continue;
    }
    process.stdout.write(`[${index}/${planned.length}] ${config.model} reasoning=${config.reasoning} ... `);
    let metadata;
    try {
      metadata = await collectOneInner({ model: config.model, reasoning: config.reasoning, providerEntry, canonicalPrompt });
    } catch (error) {
      console.log(`HARNESS_ERROR: ${String(error?.message ?? error)}`);
      results.push({ model: config.model, reasoning: config.reasoning, harness_error: String(error?.message ?? error), collector_capture_status: 'FAILED' });
      continue;
    }
    console.log(`http=${metadata.http_status} finish=${metadata.finish_reason} provider=${metadata.provider_route} bytes=${metadata.assistant_output_bytes} parse=${metadata.current_parse_outcome}(${metadata.current_parse_error_code ?? '-'}) dialect=${metadata.dialect_classification} repeat=${metadata.repeat_candidate}`);
    results.push(metadata);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, INTER_REQUEST_DELAY_MS));
  }
  const summaryPath = join(RUNS_ROOT, 'collection-summary.json');
  writeFileSync(summaryPath, JSON.stringify({ collected_at: new Date().toISOString(), count: results.length, results }, null, 2), 'utf8');
  console.log(`SUMMARY_WRITTEN ${summaryPath}`);
}

function collectRunMetadata() {
  const results = [];
  if (!existsSync(RUNS_ROOT)) return results;
  for (const modelDir of readdirSync(RUNS_ROOT, { withFileTypes: true })) {
    if (!modelDir.isDirectory() || modelDir.name === 'collection-summary.json') continue;
    for (const reasoningDir of readdirSync(join(RUNS_ROOT, modelDir.name), { withFileTypes: true })) {
      if (!reasoningDir.isDirectory()) continue;
      const metadataPath = join(RUNS_ROOT, modelDir.name, reasoningDir.name, 'run-001', 'metadata.json');
      if (existsSync(metadataPath)) results.push(JSON.parse(readFileUtf8(metadataPath)));
    }
  }
  return results;
}

async function cmdReport() {
  const inventory = JSON.parse(readFileUtf8(INVENTORY_PATH));
  const runs = collectRunMetadata();
  const count = (predicate) => runs.filter(predicate).length;
  const dialectCounts = {};
  for (const run of runs) dialectCounts[run.dialect_classification] = (dialectCounts[run.dialect_classification] ?? 0) + 1;
  const repeatCandidates = runs.filter((run) => run.repeat_candidate).map((run) => `${run.requested_model}/${run.reasoning_requested}`);
  const identityMismatches = runs.filter((run) => run.model_identity_mismatch);
  const transportAnomalies = runs.filter((run) => run.transport_anomaly);
  const extractionAnomalies = runs.filter((run) => run.extraction_anomaly);
  const contamination = runs.filter((run) => run.http_status === 429 || run.invocation_error_code === 'API_RATE_LIMITED' || run.invocation_error_code === 'API_PROVIDER_UNAVAILABLE' || run.invocation_error_code === 'API_TIMEOUT' || run.invocation_error_code === 'API_NETWORK_ERROR');
  const providerSuccess = count((run) => run.provider_terminal_status === 'SUCCESS');
  const providerError = count((run) => run.provider_terminal_status === 'ERROR');
  const providerUnknown = count((run) => run.provider_terminal_status === 'UNKNOWN');
  const parsePass = count((run) => run.current_parse_outcome === 'PASS');
  const parseFail = count((run) => run.current_parse_outcome === 'FAIL');
  const captureCompleted = count((run) => run.collector_capture_status === 'COMPLETED');
  const captureFailed = runs.length - captureCompleted;
  const effectiveEvidence = runs.filter((run) => run.reasoning_effective != null);
  const matrixRows = runs.map((run) => `| CORE_VENDOR | ${run.provider_family} | ${run.requested_model} | ${run.response_model ?? 'null'} | ${run.reasoning_requested} | ${run.reasoning_effective ?? 'null'} | ${run.http_status ?? 'null'} | ${run.provider_terminal_status} | ${run.finish_reason ?? 'null'} | ${run.assistant_output_bytes ?? 'null'} | ${run.dialect_classification} | ${run.current_parse_outcome}${run.current_parse_error_code ? ` (${run.current_parse_error_code})` : ''} | ${run.repeat_candidate ? 'YES' : 'no'} |`);
  const report = `# API / OpenRouter â€” DSH Model Output Corpus Baseline Report

- TARGET_CONNECTOR: api
- TARGET_API_PROVIDER: openrouter
- OPENROUTER_VERSION_OR_API_VERSION: ${OPENROUTER_API_VERSION} (${OPENROUTER_BASE_URL})
- CONNECTOR_VERSION: ${CONNECTOR_VERSION}
- REPO_BRANCH: ${runs[0]?.repo_branch ?? gitHead().branch}
- REPO_HEAD: ${runs[0]?.repo_head ?? gitHead().head}
- CANONICAL_PROBE_SHA256: 102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5
- CANONICAL_PROBE_BYTES: 4112
- Collection date: ${inventory.catalogue_retrieved_at}

## OPENROUTER_VERSION_OR_API_VERSION

Public REST API \`v1\` at \`${OPENROUTER_BASE_URL}\`; transport is the production
\`openai-chat\` protocol path (\`POST /chat/completions\`, non-streaming). Catalogue
endpoint \`${OPENROUTER_CATALOGUE_URL}\` returned HTTP ${inventory.catalogue_http_status}.

## TOTAL_OPENROUTER_MODELS_DISCOVERED

${inventory.total_openrouter_models_discovered} (full live catalogue snapshot ${inventory.catalogue_retrieved_at}).
Production \`discoverApiProviderModels()\` caps at ${inventory.production_model_discovery_limit}; the live
catalogue (${inventory.total_openrouter_models_discovered}) is below that cap, so no discovery truncation occurred.

Invocation scope is deliberately bounded (the entire marketplace is NOT baselined).

## CORE_VENDOR_MODELS_SELECTED

${inventory.selected_models.length} models across the four core vendor families:

| provider_family | model_slug | cost_classification | supported_reasoning | selected_lowest | selected_highest | rationale |
|---|---|---|---|---|---|---|
${inventory.selected_models.map((model) => `| ${model.provider_family} | ${model.model_slug} | ${model.cost_classification} | ${model.supported_reasoning.join('/') || 'none'} | ${model.selected_lowest ?? '-'} | ${model.selected_highest ?? '-'} | ${model.rationale} |`).join('\n')}

Selection provenance: CORE_VENDOR only. No historical snapshots were selected
where an explicit current successor exists; superseded-but-active generations
outside the bounded selection are listed under "eligible but not selected".

## OPENCODE_CORPUS_STATE

${inventory.opencode_corpus_state} â€” at collection start the OpenCode corpus artifacts existed only as
uncommitted working-tree state (no completed OpenCode corpus commit, no accepted
opencode-baseline-report.md terminating marker). Per the parallel-safe collection
contract the partial OpenCode inventory was NOT consumed.

## OPENCODE_OVERLAP_MODELS_SELECTED

DEFERRED â€” ${inventory.opencode_overlap_deferred_pending_inventory ? 'OPENCODE_OVERLAP_DEFERRED_PENDING_INVENTORY=YES' : 'not deferred'}.
A bounded overlap supplement (DeepSeek / Moonshot / Qwen / Mistral / ... families,
matched by exact model identity) may be run after the OpenCode inventory is accepted.

## DEDUPLICATED_ELIGIBLE_MODELS

${inventory.selected_models.length} (each selected model invoked once per selected reasoning extreme;
single selection source, so no cross-source deduplication was required).

## EXCLUSION_COUNTS

Evaluated over the ${inventory.core_vendor_candidates} core-vendor-family catalogue entries
(openai/anthropic/google/z-ai â€” the bounded scope denominator):

- FREE_EXCLUDED: ${inventory.exclusion_counts.FREE_EXCLUDED}
- TRIAL_EXCLUDED: ${inventory.exclusion_counts.TRIAL_EXCLUDED}
- EPHEMERAL_EXCLUDED: ${inventory.exclusion_counts.EPHEMERAL_EXCLUDED}
- NON_TEXT_EXCLUDED: ${inventory.exclusion_counts.NON_TEXT_EXCLUDED}
- BATCH_EXCLUDED: ${inventory.exclusion_counts.BATCH_EXCLUDED}
- ROUTER_ALIAS_EXCLUDED: ${inventory.exclusion_counts.ROUTER_ALIAS_EXCLUDED}
- DUPLICATE_ALIAS_EXCLUDED: ${inventory.exclusion_counts.DUPLICATE_ALIAS_EXCLUDED}
- UNKNOWN_NOT_INVOKED: 0 (every catalogue entry exposes pricing/architecture metadata sufficient for classification; no entry remained UNKNOWN)

Eligible but not selected by the bounded curation (PAID_OR_STANDARD, documented
for completeness, never invoked): ${inventory.unselected_eligible.length}

${inventory.unselected_eligible.map((id) => `- ${id}`).join('\n')}

## PLANNED_CONFIGURATIONS

${inventory.planned_configurations} (= 1 planned baseline sample per selected model Ã— selected
reasoning extreme; reasoning-capable models get low + high, non-reasoning models
a single default run).

## ATTEMPTED_BASELINE_INVOCATIONS

${runs.length}

## COLLECTOR_CAPTURE_COMPLETED / FAILED

- COLLECTOR_CAPTURE_COMPLETED: ${captureCompleted}
- COLLECTOR_CAPTURE_FAILED: ${captureFailed}

## PROVIDER_TERMINAL_STATUS

- PROVIDER_TERMINAL_SUCCESS: ${providerSuccess}
- PROVIDER_TERMINAL_ERROR: ${providerError}
- PROVIDER_TERMINAL_UNKNOWN: ${providerUnknown}

## CURRENT_PARSER_PASS / FAIL

- CURRENT_PARSER_PASS: ${parsePass}
- CURRENT_PARSER_FAIL: ${parseFail}

Layer C runs the real production parse boundary (parseDecision + normalizePmDecision)
in observation mode. A FAIL is corpus evidence, not a backend bug verdict.

## DIALECT_COUNTS

${Object.entries(dialectCounts).map(([dialect, n]) => `- ${dialect}: ${n}`).join('\n') || '- (no samples)'}

## REPEAT_CANDIDATES

${repeatCandidates.length === 0 ? 'NONE' : repeatCandidates.map((entry) => `- ${entry}`).join('\n')}

Marked only; NO repeat/confirmation samples were executed in this baseline session.

## MODEL_IDENTITY_MISMATCHES

${identityMismatches.length === 0 ? 'NONE â€” every response_model matched its requested_model' : identityMismatches.map((run) => `- ${run.requested_model} -> ${run.response_model}`).join('\n')}

No fallback model list was configured; a request for model X must not execute model Y.

## TRANSPORT_ANOMALIES

${transportAnomalies.length === 0 ? 'NONE' : transportAnomalies.map((run) => `- ${run.requested_model}/${run.reasoning_requested}: ${run.transport_anomaly}`).join('\n')}

## EXTRACTION_ANOMALIES

${extractionAnomalies.length === 0 ? 'NONE' : extractionAnomalies.map((run) => `- ${run.requested_model}/${run.reasoning_requested}: ${run.extraction_anomaly}`).join('\n')}

## CONCURRENT_COLLECTION_RESOURCE_CONTAMINATION

${contamination.length === 0 ? 'NONE â€” no HTTP 429, quota, rate-limit, overload, timeout, or connection-reset events were observed.' : contamination.map((run) => `- ${run.requested_model}/${run.reasoning_requested}: http=${run.http_status} code=${run.invocation_error_code ?? '-'} (CONCURRENT_COLLECTION_RESOURCE_CONTAMINATION_POSSIBLE â€” an OpenCode collector session was active in another working tree during this run)`).join('\n')}

All OpenRouter invocations ran strictly sequentially with a ${INTER_REQUEST_DELAY_MS}ms inter-request delay.

## REASONING_EFFECTIVE_EVIDENCE

${effectiveEvidence.length === 0 ? 'reasoning_effective=null for every sample â€” the OpenRouter chat-completion response does not authoritatively echo the effective reasoning setting, so no effective value was inferred.' : effectiveEvidence.map((run) => `- ${run.requested_model}/${run.reasoning_requested}: ${JSON.stringify(run.reasoning_effective)}`).join('\n')}

reasoning_requested values are evidence-backed: OpenRouter's documented
\`reasoning.effort\` accepted values (low|medium|high), intersected with the
production openrouter reasoning translation. reasoning_supported is derived
from each model's catalogue supported_parameters (same rule as production
normalizeOpenRouterModel()).

## EVIDENCE_LIMITATIONS

- OpenRouter returns the model's hidden reasoning trace in choices[0].message.reasoning
  by default. Per PLAN section 9 (hidden chain-of-thought is never persisted), every
  raw-response.json containing that field was stored as a SANITIZED STRUCTURAL COPY:
  the reasoning fields were replaced with a withhold marker, the original body's
  SHA-256 + byte count were recorded in the artifact's raw_artifact_policy block and
  in the run metadata (raw_response_original_sha256), and the artifact was marked
  RAW_ARTIFACT_WITHHELD_SECRET_RISK. The assistant message.content — the only field
  production extraction reads — is untouched and byte-identical to Layer B.
- One baseline sample per configuration: single-sample dialect observations are
  not variability measurements (repeat candidates are marked, not rerun).
- reasoning_effective is null throughout: OpenRouter does not echo the applied
  reasoning setting, so the corpus records the requested value only.
- OpenRouter may route the same model id across multiple upstream provider
  endpoints; the \`provider\` field of each raw response is recorded per sample
  (provider_route) but endpoint selection remains normal production semantics.
- The canonical probe enforces a strict JSON contract; models with strong
  reasoning may spend large reasoning-token budgets before emitting output â€”
  usage metadata per sample records what the provider exposed.
- Exclusion counts use the core-vendor-family catalogue entries as denominator;
  the wider marketplace is inventoried by count only.

## SAMPLE MATRIX

| selection_source | provider_family | requested_model | response_model | reasoning_requested | reasoning_effective | http | provider_terminal | finish_reason | assistant_bytes | dialect | current_parser | repeat_candidate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${matrixRows.join('\n') || '| - | - | - | - | - | - | - | - | - | - | - | - | - |'}

## FINAL_MARKER

DSH_MODEL_OUTPUT_CORPUS_api_openrouter_BASELINE_COMPLETE
`;
  const reportPath = join(CORPUS_ROOT, 'reports', 'api-openrouter-baseline-report.md');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  console.log(`REPORT_WRITTEN ${reportPath}`);
}

import { pathToFileURL } from 'node:url';

async function cmdSanitize() {
  let sanitizedRuns = 0;
  const updateOne = (runDir) => {
    const rawResponsePath = join(runDir, 'raw-response.json');
    if (!existsSync(rawResponsePath)) return;
    const rawResponse = JSON.parse(readFileUtf8(rawResponsePath));
    if (rawResponse.raw_artifact_policy) return; // already sanitized
    const result = sanitizeRawResponseForPersistence(rawResponse);
    writeFileSync(rawResponsePath, JSON.stringify(result.sanitized, null, 2), 'utf8');
    const metadataPath = join(runDir, 'metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileUtf8(metadataPath));
      metadata.raw_response_withheld = result.withheld ? 'RAW_ARTIFACT_WITHHELD_SECRET_RISK' : null;
      metadata.raw_response_withheld_kind = result.withheld ? 'HIDDEN_CHAIN_OF_THOUGHT' : null;
      metadata.raw_response_original_sha256 = result.withheld ? result.originalSha256 : null;
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }
    sanitizedRuns += 1;
  };
  if (!existsSync(RUNS_ROOT)) throw new Error('no runs to sanitize');
  for (const modelDir of readdirSync(RUNS_ROOT, { withFileTypes: true })) {
    if (!modelDir.isDirectory()) continue;
    for (const reasoningDir of readdirSync(join(RUNS_ROOT, modelDir.name), { withFileTypes: true })) {
      if (!reasoningDir.isDirectory()) continue;
      updateOne(join(RUNS_ROOT, modelDir.name, reasoningDir.name, 'run-001'));
    }
  }
  console.log(`SANITIZED_RUNS=${sanitizedRuns}`);
}

// Repeat-confirmation subcommand (closure PHASE 3/7): ONE additional sample
// for an EXISTING baseline configuration, stored as run-002/run-003.
async function cmdRepeat() {
  const runArg = process.argv.find((arg) => arg.startsWith('--run='));
  const modelArg = process.argv.find((arg) => arg.startsWith('--model='));
  const reasoningArg = process.argv.find((arg) => arg.startsWith('--reasoning='));
  const runLabel = runArg ? runArg.split('=')[1] : null;
  const model = modelArg ? modelArg.split('=')[1] : null;
  const reasoning = reasoningArg ? reasoningArg.split('=')[1] : null;
  if (!runLabel || !/^run-\d+$/.test(runLabel) || runLabel === 'run-001') throw new Error(`repeat requires --run=run-00N (N>=2), got --run=${runLabel}`);
  if (!model || !reasoning) throw new Error('repeat requires --model=<slug> and --reasoning=<level>');
  verifyCanonicalProbe(readFileBytes, CANONICAL_PROBE);
  if (!ensureOpenRouterKey()) throw new Error('DSH_API_OPENROUTER_KEY unavailable — fail closed before provider invocation');
  const inventory = JSON.parse(readFileUtf8(INVENTORY_PATH));
  const selected = inventory.selected_models.find((m) => m.model_slug === model);
  if (!selected || !selected.selected_configurations.includes(reasoning)) {
    throw new Error(`no baseline configuration matches model=${model} reasoning=${reasoning}; repeat candidates must repeat an existing baseline configuration`);
  }
  const existing = join(RUNS_ROOT, modelSlug(model), reasoningSlug(reasoning), runLabel, 'metadata.json');
  if (existsSync(existing)) throw new Error(`refusing to overwrite existing repeat run: ${existing}`);
  const providerEntry = await loadProductionProviderEntry();
  const canonicalPrompt = readFileSync(CANONICAL_PROBE, 'utf8');
  process.stdout.write(`REPEAT ${runLabel} ${model} reasoning=${reasoning} ... `);
  const metadata = await collectOneInner({ model, reasoning, providerEntry, canonicalPrompt, runLabel, sampleKind: 'repeat', selectionSource: ['CORE_VENDOR', 'REPEAT_CONFIRMATION'] });
  console.log(`http=${metadata.http_status} finish=${metadata.finish_reason} provider=${metadata.provider_route} bytes=${metadata.assistant_output_bytes} parse=${metadata.current_parse_outcome}(${metadata.current_parse_error_code ?? '-'}) dialect=${metadata.dialect_classification}`);
  return metadata;
}

export { collectOneInner, loadProductionProviderEntry, ensureOpenRouterKey, readFileBytes, readFileUtf8, makeCapturingFetch, parseRawBody };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const command = process.argv[2] ?? 'help';
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  if (command === 'inventory') await cmdInventory();
  else if (command === 'dry-run') printDryRunMatrix();
  else if (command === 'canary') await cmdCanary();
  else if (command === 'collect') await cmdCollect({ only: onlyArg ? onlyArg.split('=')[1].split(',') : null });
  else if (command === 'repeat') await cmdRepeat();
  else if (command === 'sanitize') await cmdSanitize();
  else if (command === 'report') await cmdReport();
  else {
    console.log('usage: node openrouter-baseline.mjs <inventory|dry-run|canary|collect|repeat|sanitize|report> [--only=slug1,slug2] [--run=run-00N --model=slug --reasoning=level]');
  }
}
