import { resolveApiKey } from './api-provider-config.mjs';
import { capabilitiesForProvider } from './api-provider-capabilities.mjs';

export const MODEL_DISCOVERY_LIMIT = 500;
const REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeOpenRouterModel(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const supported = Array.isArray(raw.supported_parameters) ? raw.supported_parameters.filter((v) => typeof v === 'string').slice(0, 64) : [];
  const reasoningSupport = supported.some((v) => ['reasoning', 'reasoning_effort'].includes(v)) ? 'SUPPORTED' : supported.length ? 'UNSUPPORTED' : 'UNKNOWN';
  const pricing = raw.pricing && typeof raw.pricing === 'object'
    ? Object.fromEntries(Object.entries(raw.pricing).filter(([, value]) => typeof value === 'string' || Number.isFinite(value)).slice(0, 16))
    : null;
  return Object.freeze({
    id: raw.id.trim().slice(0, 256),
    name: typeof raw.name === 'string' ? raw.name.slice(0, 256) : null,
    family: raw.id.includes('/') ? raw.id.split('/')[0].slice(0, 128) : null,
    contextLength: Number.isFinite(raw.context_length) ? raw.context_length : null,
    pricing,
    supportedParameters: Object.freeze(supported),
    created: Number.isFinite(raw.created) || typeof raw.created === 'string' ? raw.created : null,
    reasoningSupport,
    reasoningOptions: reasoningSupport === 'SUPPORTED' ? REASONING_LEVELS : Object.freeze([]),
  });
}

export async function discoverApiProviderModels(entry, { env = process.env, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (entry?.id !== 'openrouter') return Object.freeze({ ok: false, code: 'API_MODEL_DISCOVERY_DEFERRED', message: 'model discovery is enabled only for the primary OpenRouter provider' });
  let apiKey;
  try { apiKey = resolveApiKey(entry, env); }
  catch { return Object.freeze({ ok: false, code: 'API_SECRET_MISSING', message: 'OpenRouter key is missing' }); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${entry.baseUrl}/models`, { method: 'GET', headers: { ...entry.headers, Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    if (!response.ok) return Object.freeze({ ok: false, code: 'API_MODEL_DISCOVERY_FAILED', message: `OpenRouter model discovery returned HTTP ${response.status}`, httpStatus: response.status });
    const body = await response.json();
    const models = (Array.isArray(body?.data) ? body.data : []).map(normalizeOpenRouterModel).filter(Boolean).slice(0, MODEL_DISCOVERY_LIMIT);
    return Object.freeze({ ok: true, provider: entry.id, httpStatus: response.status, retrievedAt: new Date().toISOString(), models: Object.freeze(models), providerCapabilities: capabilitiesForProvider(entry.id) });
  } catch (error) {
    return Object.freeze({ ok: false, code: error?.name === 'AbortError' ? 'API_MODEL_DISCOVERY_TIMEOUT' : 'API_MODEL_DISCOVERY_FAILED', message: 'OpenRouter model discovery failed safely' });
  } finally { clearTimeout(timer); }
}
