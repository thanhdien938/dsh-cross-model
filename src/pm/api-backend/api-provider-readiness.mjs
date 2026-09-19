// P11-R0 — per-provider Connection Center readiness. Two deliberately
// separate tiers (spec: "Do not pretend KEY_PRESENT == HEALTHY"):
//
//  1. `synchronousReadiness()` — zero I/O, zero network: is the provider
//     CONFIGURED at all, and is its secret env var currently set? Safe to
//     call as often as any other capability check (no periodic-polling
//     concern applies — there is no network call here at all).
//
//  2. `probeApiProviderReadiness()` — ONE live, lightweight HTTP call
//     (`GET {base_url}/models`, a standard OpenAI-compatible non-billable
//     endpoint — no generation, no token spend) that actually proves
//     reachability/auth. This is intentionally NOT invoked by
//     ProductionPmBackendRegistry#capabilities()/#capability() (which stay
//     zero-network for 'api', matching every other backend's own
//     zero-cost capability tier) — a caller (a future Connection Center
//     "Refresh" action) invokes it explicitly, satisfying "manual refresh
//     only, no periodic API polling" by construction: nothing in this
//     codebase calls it on a timer.
import { resolveApiKey } from './api-provider-config.mjs';

export const API_PROVIDER_READINESS = Object.freeze({
  CONFIGURED: 'CONFIGURED',
  KEY_PRESENT: 'KEY_PRESENT',
  REACHABLE: 'REACHABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

export function synchronousReadiness(entry, env = process.env) {
  let keyPresent = true;
  try {
    resolveApiKey(entry, env);
  } catch {
    keyPresent = false;
  }
  return Object.freeze({ id: entry.id, protocol: entry.protocol, configured: true, keyPresent, status: keyPresent ? API_PROVIDER_READINESS.KEY_PRESENT : API_PROVIDER_READINESS.CONFIGURED });
}

// Live probe — one bounded GET, no request body, no generation. Never
// throws; any failure degrades to a typed status instead (this is a
// read-only diagnostic, not a gate on task execution).
export async function probeApiProviderReadiness(entry, { env = process.env, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const base = synchronousReadiness(entry, env);
  if (!base.keyPresent) return base;
  let apiKey;
  try {
    apiKey = resolveApiKey(entry, env);
  } catch {
    return base;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${entry.baseUrl}/models`, { method: 'GET', headers: { ...entry.headers, Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    if (response.ok) return Object.freeze({ ...base, status: API_PROVIDER_READINESS.REACHABLE });
    if (response.status === 401 || response.status === 403) return Object.freeze({ ...base, status: API_PROVIDER_READINESS.AUTH_FAILED });
    if (response.status === 429) return Object.freeze({ ...base, status: API_PROVIDER_READINESS.RATE_LIMITED });
    return Object.freeze({ ...base, status: API_PROVIDER_READINESS.UNAVAILABLE });
  } catch {
    // Network/DNS/TLS/abort — ambiguous whether the provider is actually
    // down or this host simply has no route to it right now; never claim a
    // confident UNAVAILABLE from a single client-side transport failure.
    return Object.freeze({ ...base, status: API_PROVIDER_READINESS.UNKNOWN });
  } finally {
    clearTimeout(timer);
  }
}
