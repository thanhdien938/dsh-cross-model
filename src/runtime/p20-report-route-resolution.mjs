/**
 * P20.8 §6.2 / §8 / §9 — production report-route resolution.
 *
 * Binds the three live-authorized CLI report backends
 * (pm/report-backends/cli-report-backends.mjs) to a profile registry +
 * project, and builds the per-run §8 exact-tuple capability-evidence
 * overlay from the durable CapabilityEvidenceRegistry
 * (artifacts/capability-evidence-registry.mjs). No second orchestration
 * engine — this module only supplies the DI functions
 * `councilArtifactRuntime.reportBackendResolver` /
 * SingleArtifactDriver's `resolveReportBackend` already expect.
 */

import { resolveClaudeExecutable } from '../session/claude-code-session-bridge.mjs';
import { resolveOpenCodeExecutable } from '../session/opencode-cli-session-bridge.mjs';
import { resolveAntigravityExecutable } from '../session/antigravity-cli-session-bridge.mjs';
import { resolveCodexCliExecutable } from '../session/codex-cli-session-bridge.mjs';
import { resolveGrokExecutable } from '../session/grok-acp-client.mjs';
import {
  createClaudeReportBackend, createOpenCodeReportBackend, createAntigravityReportBackend,
  createCodexReportBackend, createGrokReportBackend, CliReportBackendError,
} from '../pm/report-backends/cli-report-backends.mjs';
import { createApiReportBackend } from '../pm/api-backend/api-report-transport.mjs';
import { DELIVERY_MECHANISM, INPUT_TRANSPORT } from '../artifacts/backend-report-capability.mjs';
import { buildRunCapabilityPolicy } from '../artifacts/capability-evidence-registry.mjs';
import { createBackendExecutionObserver } from './backend-execution-observer.mjs';
import { assertReportBackendTimeoutPolicy, PRODUCTION_REPORT_BACKEND_TIMEOUT_MS } from '../pm/report-execution-timeout-policy.mjs';

// P20.8R2 §0/§1 — DIRECT_WRITE is now the MANDATORY Phase-1 acceptance
// route for all three authorized backends (superseding P20.8's own
// VERBATIM_MATERIALIZATION choice, which stays available as compatibility
// code — see cli-report-backends.mjs's `deliveryMechanism` option — but is
// no longer used to claim production acceptance here). The app allocates
// the deterministic report path and gives it to the model; the model
// writes the file itself; DSH only verifies/hashes/seals it.
// `inputTransport` (a SEPARATE axis — how a stage CONSUMES a prior sealed
// artifact) is unaffected by this and stays VERBATIM_CONTENT.
// P22.4 §C/§D/§E/§H — Codex and Grok join the three original DIRECT_WRITE
// products: both CLIs already run production execution in a fully
// write-capable mode (see production-pm-backend-registry.mjs's own
// registrations — codex: `--dangerously-bypass-approvals-and-sandbox`;
// grok: `--permission-mode bypassPermissions --sandbox off`), so report-
// plane DIRECT_WRITE reuses that already-shipped capability rather than
// inventing a new one. `api` has no local filesystem, so it stays
// VERBATIM_MATERIALIZATION (DSH itself materializes the exact accepted
// chat-completion content) — never a false DIRECT_WRITE claim.
export const PRODUCTION_ROUTE_BY_PRODUCT = Object.freeze({
  'claude-code': Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
  opencode: Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
  antigravity: Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
  codex: Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
  grok: Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
  api: Object.freeze({ deliveryMechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT }),
});

const EXECUTABLE_RESOLVER_BY_PRODUCT = Object.freeze({
  'claude-code': resolveClaudeExecutable,
  opencode: resolveOpenCodeExecutable,
  antigravity: resolveAntigravityExecutable,
  codex: resolveCodexCliExecutable,
  grok: resolveGrokExecutable,
  // api: no executable to resolve — resolveExecutableIdentity() below
  // already returns { path: null, version: null } for an unlisted product.
});

/** Trusted executable path+version identity for a product, or nulls when unresolved. */
export function resolveExecutableIdentity(product) {
  const resolver = EXECUTABLE_RESOLVER_BY_PRODUCT[product];
  if (!resolver) return { path: null, version: null };
  let resolved;
  try { resolved = resolver(); } catch { return { path: null, version: null }; }
  return { path: resolved?.path ?? null, version: resolved?.version ?? null };
}

/** Build one §8 exact-tuple capability participant descriptor for a profile. */
export function buildCapabilityParticipant({ profileRegistry, profileId, sourceAccessMode = 'READ_ONLY' }) {
  const profile = profileRegistry.get(profileId);
  const route = PRODUCTION_ROUTE_BY_PRODUCT[profile.product];
  if (!route) {
    throw new CliReportBackendError(`no production route policy for product ${JSON.stringify(profile.product)}`, 'CLI_REPORT_ROUTE_UNSUPPORTED_PRODUCT', { product: profile.product, profileId });
  }
  const executable = resolveExecutableIdentity(profile.product);
  return {
    profileId,
    product: profile.product,
    model: profile.model ?? null,
    reasoning: profile.reasoning ?? null,
    executablePath: executable.path,
    executableVersion: executable.version,
    os: process.platform,
    deliveryMechanism: route.deliveryMechanism,
    inputTransport: route.inputTransport,
    sourceAccessMode,
  };
}

/**
 * §8 — build the per-run capability-policy overlay for an explicit, known,
 * closed set of participating profile ids (a Council's chair+participants,
 * or a SINGLE task's one profile). Fails closed (throws) if the registry
 * has no proof, or if two participating profiles of the same product
 * disagree — see capability-evidence-registry.mjs's buildRunCapabilityPolicy().
 */
export function buildRunCapabilityPolicyForProfiles({ registry, profileRegistry, profileIds, sourceAccessMode = 'READ_ONLY', basePolicy }) {
  const participants = [...new Set(profileIds)].map((profileId) => buildCapabilityParticipant({ profileRegistry, profileId, sourceAccessMode }));
  return buildRunCapabilityPolicy({ registry, participants, ...(basePolicy ? { basePolicy } : {}) });
}

/**
 * A cached `resolveReportBackend(profileId) -> { backend, runReport,
 * directWriter, deliveryMechanism }` factory for one project — the exact
 * contract council-artifact-orchestrator.mjs's `resolveReportBackend` /
 * single-artifact-driver.mjs's `resolveReportBackend` both require.
 * `directWriter`/`deliveryMechanism` are additive fields every pre-R2
 * caller of the 2-field `{backend, runReport}` shape simply ignores.
 *
 * `deliveryMechanism` always resolves from PRODUCTION_ROUTE_BY_PRODUCT
 * above (DIRECT_WRITE for all three authorized backends in this phase) —
 * never inferred per-call, never a caller override, so every stage for a
 * given product uses the identical route.
 *
 * P20.8R3 — `observer`, when supplied by the caller (p5-production-
 * composition.mjs passes its own execLogObserver — the SAME sink the
 * decision-plane ProductionPmBackendRegistry already uses), is threaded
 * straight through to every backend this resolver builds, so each report
 * invocation's START/PROCESS_SPAWN/PROCESS_EXIT/TERMINAL facts surface
 * through the existing BackendExecutionObserver contract. Absent
 * `observer` (every pre-R3 caller/test), this defaults to a fresh
 * `createBackendExecutionObserver()` — the EXACT same default
 * ProductionPmBackendRegistry's own constructor already uses — so a
 * report execution is never silently unobserved: it always at least
 * reaches the stdout `##DSH_BACKEND_EXEC##` sentinel Desktop already
 * ingests, with task-log forwarding as an additive extra when a richer
 * observer is threaded through.
 */
export function createCliReportBackendResolver({ profileRegistry, project, spawnImpl, timeoutMsByProduct = PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, observer, apiProviders = {}, apiEnv, apiFetch }) {
  if (!profileRegistry || typeof profileRegistry.get !== 'function') throw new CliReportBackendError('profileRegistry is required', 'CLI_REPORT_RESOLVER_NO_REGISTRY');
  if (!project || typeof project.repo_path !== 'string') throw new CliReportBackendError('project.repo_path is required', 'CLI_REPORT_RESOLVER_NO_PROJECT');
  const effectiveObserver = observer ?? createBackendExecutionObserver();
  assertReportBackendTimeoutPolicy(timeoutMsByProduct);
  const cache = new Map();
  return function resolveReportBackend(profileId, executionOptions = null) {
    const profile = profileRegistry.get(profileId);
    const effectiveTimeout = resolveArtifactReportTimeout(profile.product, timeoutMsByProduct, executionOptions);
    const cacheKey = `${profileId}:${effectiveTimeout ?? 'default'}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const route = PRODUCTION_ROUTE_BY_PRODUCT[profile.product];
    if (!route) {
      throw new CliReportBackendError(`no production route policy for product ${JSON.stringify(profile.product)}`, 'CLI_REPORT_ROUTE_UNSUPPORTED_PRODUCT', { product: profile.product, profileId });
    }
    let backend;
    if (profile.product === 'claude-code') {
      backend = createClaudeReportBackend({ model: profile.model, effort: profile.reasoning, cwd: project.repo_path, spawnImpl, timeoutMs: effectiveTimeout, deliveryMechanism: route.deliveryMechanism, observer: effectiveObserver });
    } else if (profile.product === 'opencode') {
      backend = createOpenCodeReportBackend({ model: profile.model, reasoning: profile.reasoning, cwd: project.repo_path, spawnImpl, timeoutMs: effectiveTimeout, deliveryMechanism: route.deliveryMechanism, observer: effectiveObserver });
    } else if (profile.product === 'antigravity') {
      backend = createAntigravityReportBackend({ model: profile.model, cwd: project.repo_path, spawnImpl, timeoutMs: effectiveTimeout, deliveryMechanism: route.deliveryMechanism, observer: effectiveObserver });
    } else if (profile.product === 'codex') {
      backend = createCodexReportBackend({ model: profile.model, reasoning: profile.reasoning, cwd: project.repo_path, spawnImpl, timeoutMs: effectiveTimeout, deliveryMechanism: route.deliveryMechanism, observer: effectiveObserver });
    } else if (profile.product === 'grok') {
      backend = createGrokReportBackend({ model: profile.model, reasoning: profile.reasoning, cwd: project.repo_path, spawnImpl, timeoutMs: effectiveTimeout, deliveryMechanism: route.deliveryMechanism, observer: effectiveObserver });
    } else if (profile.product === 'api') {
      backend = createApiReportBackend({ providerId: profile.provider, model: profile.model, reasoning: profile.reasoning, providers: apiProviders, env: apiEnv, fetchImpl: apiFetch, timeoutMs: effectiveTimeout });
    } else {
      throw new CliReportBackendError(`no production report backend adapter for product ${JSON.stringify(profile.product)}`, 'CLI_REPORT_BACKEND_UNSUPPORTED_PRODUCT', { product: profile.product, profileId });
    }
    cache.set(cacheKey, backend);
    return backend;
  };
}

export function resolveArtifactReportTimeout(product, timeoutMsByProduct, executionOptions = null) {
  const policyTimeout = Number.isFinite(executionOptions?.timeoutMs) ? executionOptions.timeoutMs : null;
  const productTimeout = timeoutMsByProduct?.[product];
  return product === 'api'
    ? policyTimeout
    : (policyTimeout == null ? productTimeout : Math.max(productTimeout, policyTimeout));
}
