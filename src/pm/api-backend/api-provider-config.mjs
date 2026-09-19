// P11-R0 — API provider registry: administrator-authored, secret-free
// configuration (protocol/base_url/api_key_env/optional headers) for the
// `api` backend's providers. This is the ONLY place a provider's base URL
// or protocol is decided — a PM profile references a provider by id
// (`profile.provider`), an owner task can never supply or override a base
// URL/protocol/header (spec: "PROVIDER_BASE_URL_CAN_BE_OVERRIDDEN_BY_TASK"
// is a STOP condition).
//
// Mirrors the loading/validation style already used for projects.yaml/
// pm_profiles.yaml (p5-production-config.mjs): strict, fail-closed
// validation of whatever config IS present; but unlike those two required
// files, an `api_providers_file` is entirely OPTIONAL — omitting it (or the
// whole file not existing) yields an EMPTY provider registry, never a
// config-load failure and never a startup failure (spec: "Missing external
// API secrets must never prevent application startup" — the stronger form
// of that same invariant is that missing PROVIDER CONFIG entirely must not
// prevent startup either; only a PRESENT-but-malformed file is a real
// authoring error).
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ApiBackendError, API_ERROR_CODES } from './api-backend-errors.mjs';

export class ApiProviderConfigError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ApiProviderConfigError';
    this.code = 'API_PROVIDER_CONFIG_INVALID';
  }
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME_RE = /^DSH_[A-Z0-9_]+$/;
const SUPPORTED_PROTOCOLS = new Set(['openai-chat']);
// Runtime-owned — never accepted from provider header config (spec: "But
// Authorization must be runtime-owned. Do not put API key into generic
// headers configuration.").
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'proxy-authorization',
  'host', 'content-length', 'content-type',
  'connection', 'transfer-encoding', 'trailer', 'upgrade', 'expect',
]);

function boundedString(value, label, { maxLength = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new ApiProviderConfigError(`${label} is invalid`);
  return value;
}

function validBaseUrl(value) {
  boundedString(value, 'provider base_url', { maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiProviderConfigError('provider base_url must be an absolute URL');
  }
  if (parsed.protocol !== 'https:') throw new ApiProviderConfigError('provider base_url must use https');
  return value.replace(/\/+$/, '');
}

function validHeaders(raw) {
  if (raw == null) return Object.freeze({});
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApiProviderConfigError('provider headers must be an object');
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_HEADER_NAMES.has(key.toLowerCase())) throw new ApiProviderConfigError(`provider headers cannot set runtime-owned header "${key}"`);
    out[boundedString(key, 'provider header name', { maxLength: 128 })] = boundedString(String(value), 'provider header value', { maxLength: 512 });
  }
  return Object.freeze(out);
}

// One provider entry: `{protocol,baseUrl,apiKeyEnv,headers}`. Deliberately
// does NOT resolve the secret itself (spec: "Optional provider config
// specifies only ENV NAME. Runtime: process.env[api_key_env]. Do not
// persist resolved secret.") — resolveApiKey() below does that, lazily, at
// dispatch time only.
export function validateProviderEntry(id, raw) {
  if (!PROVIDER_ID_RE.test(id)) throw new ApiProviderConfigError(`provider id "${id}" is invalid`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiProviderConfigError(`provider "${id}" config must be an object`);
  const protocol = boundedString(raw.protocol, `provider "${id}" protocol`);
  if (!SUPPORTED_PROTOCOLS.has(protocol)) throw new ApiProviderConfigError(`provider "${id}" protocol "${protocol}" is not supported in P11-R0 (supported: ${[...SUPPORTED_PROTOCOLS].join(', ')})`);
  const baseUrl = validBaseUrl(raw.base_url);
  const apiKeyEnv = boundedString(raw.api_key_env, `provider "${id}" api_key_env`, { maxLength: 128 });
  if (!ENV_NAME_RE.test(apiKeyEnv)) throw new ApiProviderConfigError(`provider "${id}" api_key_env must match ${ENV_NAME_RE}`);
  const headers = validHeaders(raw.headers);
  return Object.freeze({ id, protocol, baseUrl, apiKeyEnv, headers });
}

// `doc` is the parsed YAML document's top-level `api_providers` map (or the
// whole doc, if it already IS that map). Returns a frozen `{[providerId]:
// entry}` map. An empty/absent doc yields `{}`, never an error.
export function validateApiProvidersDoc(doc, { onInvalidProvider = null } = {}) {
  const map = doc?.api_providers ?? doc ?? {};
  if (typeof map !== 'object' || Array.isArray(map)) throw new ApiProviderConfigError('api_providers must be an object keyed by provider id');
  const out = {};
  for (const [id, raw] of Object.entries(map)) {
    try {
      out[id] = validateProviderEntry(id, raw);
    } catch (error) {
      if (!(error instanceof ApiProviderConfigError)) throw error;
      onInvalidProvider?.(Object.freeze({ id, code: error.code, message: error.message }));
    }
  }
  return Object.freeze(out);
}

// Loads+validates an api-providers.yaml-shaped file. `path` omitted/null =>
// no configured providers (`{}`) — this is the default/no-op case every
// existing deployment with zero API config hits, and it must never throw.
// `path` given but the file cannot be read => real config error (an
// operator who explicitly pointed at a file expects it to load).
export async function loadApiProviderConfig({ path, env = process.env, onInvalidProvider = null } = {}) {
  void env; // secrets are resolved lazily by resolveApiKey(), never here.
  if (!path) return Object.freeze({});
  const text = await readFile(path, 'utf8');
  return validateApiProvidersDoc(parse(text), { onInvalidProvider });
}

// Resolves the provider config entry for `providerId`, or throws a typed
// API_PROVIDER_CONFIG_INVALID — never returns undefined for a caller to
// forget to check.
export function getProviderConfig(providers, providerId) {
  const entry = providers?.[providerId];
  if (!entry) throw new ApiBackendError(`API provider "${providerId}" is not configured`, API_ERROR_CODES.PROVIDER_CONFIG_INVALID, { provider: providerId });
  return entry;
}

// Resolves the API key for a provider entry from `env` — lazily, only at
// actual dispatch time, and NEVER persisted anywhere beyond this call's
// local variable. Throws API_SECRET_MISSING (never a bare/undefined value)
// when the env var is absent or empty, so the caller fails BEFORE issuing
// any HTTP request (spec: "fail before HTTP request with API_SECRET_MISSING").
export function resolveApiKey(providerEntry, env = process.env) {
  const value = env[providerEntry.apiKeyEnv];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiBackendError(`API key environment variable "${providerEntry.apiKeyEnv}" is not set for provider "${providerEntry.id}"`, API_ERROR_CODES.SECRET_MISSING, { provider: providerEntry.id, apiKeyEnv: providerEntry.apiKeyEnv });
  }
  return value;
}
