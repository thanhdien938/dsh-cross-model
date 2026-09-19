// P11-R5.1 — Codex model/effort catalogue: prefer REALTIME discovery from
// the installed Codex CLI's own `codex debug models` subcommand; fall back
// to a DSH-managed JSON file (config/codex-model-catalogue.json) only when
// that command is unavailable. Neither path ever guesses a model id or
// effort value — every entry this module can produce traces to either the
// live CLI's own JSON or the owner-approved JSON fallback.
//
// REALTIME DISCOVERY EVIDENCE (2026-08-27, Codex CLI 0.147.0):
//   `codex --help` documents a `debug` subcommand; `codex debug --help`
//   documents `models: Render the raw model catalog as JSON`. Running it
//   returns `{ models: [ { slug, display_name, visibility,
//   default_reasoning_level, supported_reasoning_levels: [{effort,
//   description}], ... } ] }` — local, non-secret (no auth/credential
//   fields), machine-readable, and a real documented CLI command (not UI
//   scraping, not undocumented endpoints, no credential extraction). This
//   satisfies the owner's realtime-discovery acceptance criteria, so
//   CODEX_REALTIME_MODEL_DISCOVERY = SUPPORTED (see docs/p11/08 R5.1
//   section for the full transcript).
//
//   Of the 8 models the live catalogue currently returns, 6 have
//   `visibility: "list"` (owner-facing) and exactly match the owner's
//   Codex Desktop screenshot: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
//   gpt-5.5, gpt-5.4, gpt-5.4-mini. `gpt-reserve` and `codex-auto-review`
//   are `visibility: "hide"` (internal, never owner-facing) and are
//   filtered out. Per-model `supported_reasoning_levels` are NOT uniform:
//   sol/terra support ultra, luna tops out at max, the rest top out at
//   xhigh — this module preserves that per-model truth rather than
//   offering one global list (Part L).
//
// To manually re-verify against a newer Codex install: run
// `codex debug models` and diff against config/codex-model-catalogue.json
// (see docs/p11/CODEX_CATALOGUE_MAINTENANCE.md).
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_EFFORT_LABELS } from './pm-reasoning-capability.mjs';

const KNOWN_CODEX_EFFORT_VALUES = new Set(Object.keys(CODEX_EFFORT_LABELS));
const DEFAULT_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'codex-model-catalogue.json');

function effortLabel(value) {
  return CODEX_EFFORT_LABELS[value] ?? value;
}

// Owner's screenshot model labels ("5.6 Sol", "5.4 Mini", "5.5") are
// reproduced EXACTLY by stripping the live catalogue's own "GPT-" prefix
// and turning the remaining hyphens into spaces — never a separately
// guessed label. Falls back to the raw slug if display_name is missing.
export function deriveCodexModelLabel(displayName, slug) {
  if (typeof displayName === 'string' && displayName.trim()) {
    const stripped = displayName.replace(/^GPT-/i, '').replace(/-/g, ' ').trim();
    return stripped || slug;
  }
  return slug;
}

// Normalizes `codex debug models`' raw `.models` array into this module's
// shared { id, label, enabled, efforts:[{value,label}] } shape. Only
// visibility:"list" entries are owner-facing; a malformed individual entry
// is skipped rather than aborting the whole catalogue (Part Q: fail safe).
export function normalizeLiveCodexModels(rawModels) {
  if (!Array.isArray(rawModels)) return [];
  const entries = [];
  for (const m of rawModels) {
    if (!m || typeof m !== 'object') continue;
    if (m.visibility !== 'list') continue;
    const id = typeof m.slug === 'string' ? m.slug.trim() : '';
    if (!id) continue;
    const rawEfforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = rawEfforts
      .map((l) => (typeof l?.effort === 'string' ? l.effort : null))
      .filter((v) => v && KNOWN_CODEX_EFFORT_VALUES.has(v))
      .map((v) => ({ value: v, label: effortLabel(v) }));
    entries.push({ id, label: deriveCodexModelLabel(m.display_name, id), enabled: true, efforts });
  }
  return entries;
}

function needsShell(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary ?? ''));
}

// A small, self-contained bounded spawn — deliberately not shared with
// pm-connection-probe.mjs's runBoundedProbe() to avoid a circular import
// (that module already imports this one). Same shape/behavior: kills only
// its own child on timeout, never throws, resolves { ok, stdout }.
function runBounded(spawnImpl, binary, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(binary, args, { windowsHide: true, shell: needsShell(binary), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      finish({ ok: false, stdout: '' });
    }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', () => {});
    child.once('error', () => finish({ ok: false, stdout: '' }));
    child.once('close', (code) => finish({ ok: code === 0, stdout }));
  });
}

// PART A/B/C: realtime discovery via the official `codex debug models`
// subcommand. Returns `null` on ANY failure (not installed, times out,
// non-zero exit, unparsable JSON, no owner-facing entries) so the caller
// can fall back to the JSON catalogue — never throws, never partially
// trusts a malformed response.
export async function discoverCodexModelCatalogueLive({ spawnImpl = nodeSpawn, binary = 'codex', timeoutMs = 8000 } = {}) {
  const result = await runBounded(spawnImpl, binary, ['debug', 'models'], timeoutMs);
  if (!result.ok || !result.stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const entries = normalizeLiveCodexModels(parsed?.models);
  if (!entries.length) return null;
  return { entries, clientVersion: typeof parsed?.client_version === 'string' ? parsed.client_version : null, fetchedAt: new Date().toISOString() };
}

// PART F/Q: strict-but-safe validation of the JSON fallback file. Never
// throws — a structurally broken root fails to an empty catalogue (safe,
// never corrupts anything downstream); an individual bad model/effort
// entry is dropped with a recorded reason while the rest of the file still
// loads (a bad optional entry must not take down the whole catalogue).
export function validateAndNormalizeCodexCatalogueJson(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entries: [], schemaVersion: null, lastVerified: null, errors: ['catalogue root must be a JSON object'] };
  }
  if (parsed.schema_version !== 1) {
    errors.push(`unsupported schema_version: ${JSON.stringify(parsed.schema_version)}`);
    return { entries: [], schemaVersion: parsed.schema_version ?? null, lastVerified: typeof parsed.last_verified === 'string' ? parsed.last_verified : null, errors };
  }
  if (!Array.isArray(parsed.models)) {
    errors.push('"models" must be an array');
    return { entries: [], schemaVersion: 1, lastVerified: typeof parsed.last_verified === 'string' ? parsed.last_verified : null, errors };
  }
  const seenIds = new Set();
  const labelOwners = new Map();
  const entries = [];
  parsed.models.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') { errors.push(`models[${i}]: not an object, skipped`); return; }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) { errors.push(`models[${i}]: empty/missing id, skipped`); return; }
    if (seenIds.has(id)) { errors.push(`models[${i}]: duplicate id "${id}", skipped`); return; }
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id;
    if (labelOwners.has(label) && labelOwners.get(label) !== id) errors.push(`models[${i}] ("${id}"): label "${label}" duplicates another model's label — kept, but this is ambiguous to the owner`);
    labelOwners.set(label, id);
    const rawEfforts = Array.isArray(raw.efforts) ? raw.efforts : [];
    const seenEfforts = new Set();
    const efforts = [];
    for (const value of rawEfforts) {
      if (typeof value !== 'string' || !value.trim()) { errors.push(`models[${i}] ("${id}"): non-string/empty effort value, skipped`); continue; }
      if (!KNOWN_CODEX_EFFORT_VALUES.has(value)) { errors.push(`models[${i}] ("${id}"): unknown effort value "${value}" (not in ${[...KNOWN_CODEX_EFFORT_VALUES].join('/')}), skipped`); continue; }
      if (seenEfforts.has(value)) { errors.push(`models[${i}] ("${id}"): duplicate effort "${value}", skipped`); continue; }
      seenEfforts.add(value);
      efforts.push({ value, label: effortLabel(value) });
    }
    seenIds.add(id);
    entries.push({ id, label, enabled: raw.enabled !== false, efforts });
  });
  return { entries, schemaVersion: 1, lastVerified: typeof parsed.last_verified === 'string' ? parsed.last_verified : null, errors };
}

function loadJsonFallbackFromDisk(jsonPath, readFileImpl) {
  let raw;
  try {
    raw = readFileImpl(jsonPath, 'utf8');
  } catch (e) {
    return { entries: [], schemaVersion: null, lastVerified: null, errors: [`catalogue file unreadable at ${jsonPath}: ${e.message}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], schemaVersion: null, lastVerified: null, errors: [`catalogue file is not valid JSON: ${e.message}`] };
  }
  return validateAndNormalizeCodexCatalogueJson(parsed);
}

// PART D/M/O: the one generic loader — prefers live discovery, falls back
// to the JSON file, and always re-reads/re-spawns fresh (no in-process
// cache), so both a Codex CLI update and a JSON edit are picked up on the
// very next call with no restart (bounded hot reload).
export async function loadCodexCatalogue({ spawnImpl = nodeSpawn, binary = 'codex', timeoutMs = 8000, jsonPath = DEFAULT_JSON_PATH, readFileImpl = readFileSync } = {}) {
  const live = await discoverCodexModelCatalogueLive({ spawnImpl, binary, timeoutMs });
  if (live) {
    return {
      mode: 'LIVE',
      sourceLabel: `Live Codex catalogue — \`codex debug models\`${live.clientVersion ? ` (client ${live.clientVersion})` : ''}, fetched ${live.fetchedAt}`,
      entries: live.entries,
      validationErrors: [],
    };
  }
  const fallback = loadJsonFallbackFromDisk(jsonPath, readFileImpl);
  const skipped = fallback.errors.length;
  return {
    mode: 'JSON_FALLBACK',
    sourceLabel: `DSH-managed Codex catalogue (${jsonPath}, schema v${fallback.schemaVersion ?? '?'}, last verified ${fallback.lastVerified ?? 'unknown'}) — not live-discovered${skipped ? `; ${skipped} entr${skipped === 1 ? 'y' : 'ies'} skipped during validation` : ''}`,
    entries: fallback.entries,
    validationErrors: fallback.errors,
  };
}

// PART M: normalizes either catalogue mode into the flat fields
// pm-connection-probe.mjs's `facts.modelDiscovery` / the renderer actually
// consume — the renderer never needs to know which mode produced them.
// Only `enabled` entries are exposed (Part G/S: a disabled/unresolved
// entry stays out of NEW-profile selection without deleting anything).
export function catalogueToModelDiscoveryFields(catalogue) {
  const enabled = (catalogue?.entries ?? []).filter((e) => e.enabled);
  return {
    models: enabled.map((e) => e.id),
    modelLabels: Object.fromEntries(enabled.map((e) => [e.id, e.label])),
    modelEffortLevels: Object.fromEntries(enabled.map((e) => [e.id, e.efforts.map((f) => f.value)])),
    source: catalogue?.sourceLabel ?? 'unavailable',
  };
}

export { DEFAULT_JSON_PATH as CODEX_MODEL_CATALOGUE_JSON_PATH };
