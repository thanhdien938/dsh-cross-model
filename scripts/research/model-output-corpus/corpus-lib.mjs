// DSH MODEL OUTPUT CORPUS & DIALECT DISCOVERY — research-only library.
//
// Observation/research tooling ONLY (PLAN section 3): this module never
// imports production behavior INTO production and never changes production
// parser semantics. It REUSES production code read-only:
//   - Layer C (current parse observation) goes through the REAL production
//     parse boundary via createCliPmDriver()'s decide() with a stubbed run()
//     closure, so PASS/FAIL/error codes/diagnostics come from
//     production-pm-backend-registry.mjs's parseDecision() itself — never a
//     reimplementation. normalizePmDecision() (pm-contracts.mjs) is likewise
//     called read-only as the downstream normalizer check.
//
// Everything in here is deterministic and side-effect-free except file IO
// performed by explicit caller request.

import { createHash } from 'node:crypto';
import { InvalidEnvelopeError } from '../../../src/bus/errors.mjs';
import { normalizePmDecision } from '../../../src/pm/pm-contracts.mjs';

export const PHASE_VERSION = '1.0';
export const CANONICAL_PROBE_SHA256 = '102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5';
export const CANONICAL_PROBE_BYTES = 4112;

// Dialect taxonomy (PLAN section 12 / MASTER PHASE 9) — exact values.
export const DIALECTS = Object.freeze([
  'RAW_CANONICAL_JSON',
  'FENCED_JSON',
  'PROSE_PREFIX_JSON',
  'PROSE_SUFFIX_JSON',
  'PROSE_AROUND_JSON',
  'MULTIPLE_JSON_VALUES',
  'CONNECTOR_ENVELOPE',
  'TOP_LEVEL_ARRAY',
  'TOP_LEVEL_NON_OBJECT',
  'MISSING_REQUIRED_FIELD',
  'WRONG_FIELD_TYPE',
  'MALFORMED_JSON',
  'TRUNCATED',
  'EMPTY',
  'UNKNOWN',
]);

// Codex reasoning-effort ladder, sourced from pm-reasoning-capability.mjs's
// CODEX_EFFORT_LABELS key order + the catalogue's own per-level description
// text (low="lighter reasoning" ... ultra="maximum reasoning with automatic
// task delegation"). Used ONLY to pick lowest/highest SUPPORTED levels.
export const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function effortRank(value) {
  const index = EFFORT_ORDER.indexOf(value);
  return index === -1 ? EFFORT_ORDER.length : index; // unknown values sort last, deterministically
}

/**
 * PLAN section 6 / MASTER PHASE 4: select ONLY the lowest and highest
 * SUPPORTED reasoning levels for a model. Never invents values: the input is
 * whatever the connector's catalogue enumerated for that model.
 * Returns { levels, lowest, highest, single, configurations } where
 * configurations is the exact list of reasoning values to invoke (1 or 2).
 */
export function selectReasoningExtremes(supportedLevels, { order = EFFORT_ORDER } = {}) {
  // `order` is an OPTIONAL connector-specific ladder (e.g. OpenCode variants
  // include 'none'/'minimal'/'thinking' which the Codex EFFORT_ORDER does not
  // rank). Default keeps the exact Codex-era behavior — existing callers and
  // tests are unaffected.
  const orderRank = (value) => {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
  };
  const levels = (Array.isArray(supportedLevels) ? supportedLevels : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
  if (levels.length === 0) {
    // No explicit reasoning control -> run once with `default` (never invent).
    return { levels: [], lowest: null, highest: null, single: true, configurations: ['default'] };
  }
  const ordered = [...levels].sort((a, b) => orderRank(a) - orderRank(b) || a.localeCompare(b));
  const lowest = ordered[0];
  const highest = ordered[ordered.length - 1];
  if (lowest === highest) {
    return { levels: ordered, lowest, highest, single: true, configurations: [lowest] };
  }
  return { levels: ordered, lowest, highest, single: false, configurations: [lowest, highest] };
}

/**
 * Cost/availability classification (PLAN section 5 / MASTER PHASE 2-3).
 * Deterministic, evidence-backed, conservative:
 *   - catalogue upgrade.retirement_at (scheduled deprecation)        -> EPHEMERAL
 *   - explicit free / trial markers in catalogue text fields         -> FREE / TRIAL
 *   - not owner-facing (visibility !== 'list')                       -> UNKNOWN
 *   - owner-facing list entry with no free/trial/ephemeral marker    -> PAID_OR_STANDARD
 * Never infers PAID merely because a name lacks "-free".
 */
export function classifyCodexModelCost(model, { nowIso = new Date().toISOString() } = {}) {
  const evidence = [];
  const scanTexts = [model?.slug, model?.display_name, model?.description, model?.availability_nux?.message, ...(Array.isArray(model?.service_tiers) ? model.service_tiers.map((t) => `${t?.id ?? ''} ${t?.name ?? ''} ${t?.description ?? ''}`) : [])]
    .filter((v) => typeof v === 'string')
    .join(' \u2014 ');
  if (/\bfree\b/i.test(scanTexts)) {
    return { classification: 'FREE', eligible: false, evidence: [`explicit "free" marker in catalogue metadata`] };
  }
  if (/\btrial\b/i.test(scanTexts)) {
    return { classification: 'TRIAL', eligible: false, evidence: [`explicit "trial" marker in catalogue metadata`] };
  }
  const retirementAt = model?.upgrade && typeof model.upgrade === 'object' ? model.upgrade.retirement_at : null;
  if (typeof retirementAt === 'string' && retirementAt.trim()) {
    const scheduled = !Number.isNaN(Date.parse(retirementAt));
    const past = scheduled && Date.parse(retirementAt) <= Date.parse(nowIso);
    return {
      classification: 'EPHEMERAL',
      eligible: false,
      evidence: [
        `catalogue upgrade.retirement_at=${retirementAt}${past ? ' (already past at classification time)' : ' (scheduled)'}`,
        model?.upgrade?.model ? `catalogue upgrade.model=${model.upgrade.model}` : null,
      ].filter(Boolean),
    };
  }
  if (model?.visibility !== 'list') {
    return {
      classification: 'UNKNOWN',
      eligible: false,
      evidence: [`visibility=${JSON.stringify(model?.visibility ?? null)} is not owner-facing; catalogue exposes no cost/availability evidence -> NEEDS_OWNER_CLASSIFICATION`],
    };
  }
  evidence.push('owner-facing visibility=list; no free/trial/ephemeral marker anywhere in catalogue metadata');
  return { classification: 'PAID_OR_STANDARD', eligible: true, evidence };
}

/**
 * Antigravity cost/availability classification (PLAN section 5 / MASTER
 * PHASE 2-3). The Antigravity CLI catalogue (`agy models`, TSV rows:
 * slug <TAB> display name) exposes NO per-model cost/availability metadata —
 * no visibility field, no tiers, no retirement marker. Classification is
 * therefore evidence-backed and conservative, mirroring the Codex precedent:
 *   - explicit free / trial / deprecation markers in catalogue text fields
 *     -> FREE / TRIAL / EPHEMERAL
 *   - row returned by the authenticated owner-facing `agy models` catalogue
 *     with no marker anywhere -> PAID_OR_STANDARD
 * Never infers PAID merely because a name lacks "-free"; the positive
 * evidence is the catalogue row itself (authenticated, owner-facing list).
 */
export function classifyAntigravityModelCost(model) {
  const evidence = [];
  const scanTexts = [model?.slug, model?.display_name]
    .filter((v) => typeof v === 'string')
    .join(' \u2014 ');
  if (/\bfree\b/i.test(scanTexts)) {
    return { classification: 'FREE', eligible: false, evidence: [`explicit "free" marker in catalogue metadata`] };
  }
  if (/\btrial\b/i.test(scanTexts)) {
    return { classification: 'TRIAL', eligible: false, evidence: [`explicit "trial" marker in catalogue metadata`] };
  }
  if (/\b(deprecat\w*|retir\w*|sunset|end[- ]of[- ]life|eol)\b/i.test(scanTexts)) {
    return { classification: 'EPHEMERAL', eligible: false, evidence: [`explicit deprecation/retirement marker in catalogue metadata`] };
  }
  evidence.push('returned by the authenticated owner-facing `agy models` catalogue; no free/trial/ephemeral/deprecation marker anywhere in catalogue metadata');
  return { classification: 'PAID_OR_STANDARD', eligible: true, evidence };
}

// ---------------------------------------------------------------------------
// Canonical probe verification (PLAN section 4 / MASTER PHASE 1) — fail closed.
// ---------------------------------------------------------------------------

export function sha256OfBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyCanonicalProbe(readAllBytesImpl, filePath, { requiredSha256 = CANONICAL_PROBE_SHA256, requiredBytes = CANONICAL_PROBE_BYTES } = {}) {
  let bytes;
  try {
    bytes = readAllBytesImpl(filePath);
  } catch (error) {
    return { ok: false, reason: 'CANONICAL_PROBE_MISSING', sha256: null, bytes: null, error: String(error?.message ?? error) };
  }
  const actualSha = sha256OfBytes(bytes);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bytes.length !== requiredBytes || actualSha !== requiredSha256 || hasBom) {
    return {
      ok: false,
      reason: 'CANONICAL_PROBE_MISMATCH',
      sha256: actualSha,
      bytes: bytes.length,
      error: `sha256=${actualSha} bytes=${bytes.length} bom=${hasBom} (required sha256=${requiredSha256} bytes=${requiredBytes} bom=false)`,
    };
  }
  return { ok: true, reason: null, sha256: actualSha, bytes: bytes.length, error: null };
}

// ---------------------------------------------------------------------------
// Secret-risk policy (PLAN section 9 / MASTER PHASE 7A). Deterministic scan;
// a raw artifact that matches is withheld (never written) and the caller is
// told to record hash + structural note + RAW_ARTIFACT_WITHHELD_SECRET_RISK.
// Never claims byte-exact raw AND silently redacts.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/bearer\s+\S+/i, 'bearer-token'],
  [/authorization\s*:/i, 'auth-header'],
  [/api[_-]?key\s*[:=]/i, 'api-key'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'openai-style-secret'],
  [/(?:postgres(?:ql)?|https?):\/\/[^\s]*@[^\s]+/i, 'credentialed-url'],
  [/session[_-]?token\s*[:=]/i, 'session-token'],
  [/cookie\s*:/i, 'cookie'],
];

export function scanArtifactForSecretRisk(text) {
  const value = String(text ?? '');
  const hits = [];
  for (const [pattern, kind] of SECRET_PATTERNS) {
    const match = pattern.exec(value);
    if (match) hits.push({ kind, index: match.index });
  }
  return { safe: hits.length === 0, hits };
}

// ---------------------------------------------------------------------------
// Dialect classification (PLAN section 12 / MASTER PHASE 9) — deterministic,
// read-only, never mutates or repairs the input. When uncertain -> UNKNOWN.
// ---------------------------------------------------------------------------

function balancedObjectRanges(text) {
  // Mirrors production extractSingleDecision()'s scanner shape for RESEARCH
  // classification only (Layer C never uses this — it uses the real parser).
  const ranges = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) return { balanced: false, ranges, unterminated: false };
      depth -= 1;
      if (depth === 0) {
        ranges.push({ start, end: index });
        start = -1;
      }
    }
  }
  return { balanced: depth === 0 && !inString, ranges, unterminated: depth > 0 || inString };
}

function decisionShapeCheck(parsedObject) {
  if (!parsedObject || typeof parsedObject !== 'object' || Array.isArray(parsedObject)) return null;
  if (typeof parsedObject.type !== 'string' || !parsedObject.type.trim()) return { dialect: 'MISSING_REQUIRED_FIELD', detail: 'no top-level "type" string' };
  if (parsedObject.type === 'finish') {
    if (typeof parsedObject.output !== 'string') return { dialect: 'WRONG_FIELD_TYPE', detail: 'finish.output is not a string' };
    if (!parsedObject.output.trim()) return { dialect: 'MISSING_REQUIRED_FIELD', detail: 'finish.output is empty' };
    if (parsedObject.data !== undefined && (parsedObject.data === null || typeof parsedObject.data !== 'object' || Array.isArray(parsedObject.data))) return { dialect: 'WRONG_FIELD_TYPE', detail: 'finish.data is not a plain object' };
    return null;
  }
  // Any other type must pass the production normalizer to be shape-valid.
  try {
    normalizePmDecision(parsedObject);
    return null;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/must be a plain object|unsupported pm decision type/.test(message)) return { dialect: 'WRONG_FIELD_TYPE', detail: message };
    return { dialect: 'MISSING_REQUIRED_FIELD', detail: message };
  }
}

const ENVELOPE_MARKER_KEYS = ['item', 'thread', 'usage', 'event', 'events', 'turn', 'response'];

export function classifyDialect(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { dialect: 'EMPTY', detail: null };
  let whole = null;
  let wholeValid = false;
  try {
    whole = JSON.parse(trimmed);
    wholeValid = true;
  } catch {
    wholeValid = false;
  }
  if (wholeValid) {
    if (Array.isArray(whole)) return { dialect: 'TOP_LEVEL_ARRAY', detail: `array length ${whole.length}` };
    if (whole === null || typeof whole !== 'object') return { dialect: 'TOP_LEVEL_NON_OBJECT', detail: typeof whole };
    const envelopeKeys = Object.keys(whole).filter((k) => ENVELOPE_MARKER_KEYS.includes(k));
    if (envelopeKeys.length > 0 && typeof whole.type === 'string' && /completed|started|error/.test(whole.type) && !decisionShapeCheck(whole)) {
      return { dialect: 'CONNECTOR_ENVELOPE', detail: `connector stream envelope leaked into extraction (keys: ${envelopeKeys.join(',')})` };
    }
    const shape = decisionShapeCheck(whole);
    if (shape) return { dialect: shape.dialect, detail: shape.detail };
    return { dialect: 'RAW_CANONICAL_JSON', detail: null };
  }
  const scan = balancedObjectRanges(trimmed);
  if (scan.ranges.length > 1) {
    return { dialect: 'MULTIPLE_JSON_VALUES', detail: `${scan.ranges.length} balanced top-level objects` };
  }
  if (scan.ranges.length === 1) {
    const { start, end } = scan.ranges[0];
    const prefix = trimmed.slice(0, start).trim();
    const suffix = trimmed.slice(end + 1).trim();
    if (prefix.startsWith('```') || suffix.endsWith('```')) {
      return { dialect: 'FENCED_JSON', detail: 'fence around the JSON object' };
    }
    let parsedObject = null;
    try {
      parsedObject = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return { dialect: 'MALFORMED_JSON', detail: 'embedded object failed to parse' };
    }
    const shape = decisionShapeCheck(parsedObject);
    if (shape) return { dialect: shape.dialect, detail: `${shape.detail} (embedded in prose)` };
    if (prefix && suffix) return { dialect: 'PROSE_AROUND_JSON', detail: `prefix ${prefix.length} chars / suffix ${suffix.length} chars` };
    if (prefix) return { dialect: 'PROSE_PREFIX_JSON', detail: `prefix ${prefix.length} chars` };
    if (suffix) return { dialect: 'PROSE_SUFFIX_JSON', detail: `suffix ${suffix.length} chars` };
    return { dialect: 'MALFORMED_JSON', detail: 'unreachable' };
  }
  if (trimmed.startsWith('```')) {
    return { dialect: 'FENCED_JSON', detail: 'fence present' };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    if (scan.unterminated) return { dialect: 'TRUNCATED', detail: 'JSON started but never balanced (output likely cut off)' };
    return { dialect: 'MALFORMED_JSON', detail: 'JSON-like text failed to parse' };
  }
  if (/\{\s*"/.test(trimmed)) {
    return { dialect: scan.unterminated ? 'TRUNCATED' : 'MALFORMED_JSON', detail: 'JSON object embedded in prose but not extractable' };
  }
  return { dialect: 'UNKNOWN', detail: 'no recognizable JSON structure' };
}

// ---------------------------------------------------------------------------
// Layer C — current DSH parse observation (MASTER PHASE 7C).
// Runs the REAL production parse boundary read-only: createCliPmDriver()'s
// decide() with a stubbed run() closure that returns the exact extracted
// text. Then, when parseDecision() accepted an object, additionally runs the
// real normalizePmDecision() (pm-contracts.mjs) as the downstream normalizer
// check. No production behavior is modified.
// ---------------------------------------------------------------------------

export async function observeCurrentParse(extractedText, { product = 'codex' } = {}) {
  const { createCliPmDriver, ProductionPmBackendError } = await import('../../../src/pm/production-pm-backend-registry.mjs');
  const text = extractedText ?? '';
  const driver = createCliPmDriver({
    profile: { id: 'corpus-parse-observation', product, model: null },
    project: { id: 'corpus' },
    run: async () => text,
    observer: null,
  });
  let outcome;
  try {
    const decision = await driver.decide({
      request: { id: 'corpus-parse-observation', objective: '', context: {} },
      turn: 1,
      history: [],
    });
    let normalizeOutcome = 'PASS';
    let normalizeErrorCode = null;
    try {
      normalizePmDecision(decision);
    } catch (error) {
      normalizeOutcome = error instanceof InvalidEnvelopeError ? 'FAIL' : 'FAIL';
      normalizeErrorCode = 'PM_DECISION_NORMALIZE_FAILED';
    }
    outcome = {
      outcome: 'PASS',
      error_code: null,
      parse_subreason: null,
      structural_diagnostics: null,
      normalized_decision: normalizeOutcome === 'PASS' ? decision : null,
      normalize_outcome: normalizeOutcome,
      normalize_error_code: normalizeErrorCode,
    };
  } catch (error) {
    const isProductionParseError = error instanceof ProductionPmBackendError;
    outcome = {
      outcome: 'FAIL',
      error_code: isProductionParseError ? error.code : String(error?.code ?? 'UNKNOWN_ERROR'),
      parse_subreason: error?.parseSubreason ?? null,
      structural_diagnostics: error?.diagnostics ?? null,
      normalized_decision: null,
      normalize_outcome: null,
      normalize_error_code: null,
    };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Model slug / reasoning slug helpers for corpus run paths.
// ---------------------------------------------------------------------------

export function modelSlug(modelId) {
  return String(modelId ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-model';
}

export function reasoningSlug(reasoningValue) {
  return String(reasoningValue ?? 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}
