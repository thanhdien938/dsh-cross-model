import { knownBackendNames } from './capability-selector.mjs';

export const BACKEND_HEALTH_STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const BACKEND_FAILURE_CLASSIFICATION = Object.freeze({
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT',
  AUTH: 'AUTH',
  CONFIG: 'CONFIG',
  PROTOCOL: 'PROTOCOL',
  UNKNOWN_FAILURE: 'UNKNOWN_FAILURE',
});

const RETRYABLE = new Set([
  BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
  BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
  BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
  BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
]);

const BACKENDS = new Set(knownBackendNames());
export const DEFAULT_BACKEND_HEALTH_COOLDOWN_MS = 60_000;

export class BackendHealthError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'BackendHealthError';
    Object.assign(this, extra);
  }
}

export function requireHealthBackend(backend) {
  if (typeof backend !== 'string' || !BACKENDS.has(backend)) {
    throw new BackendHealthError(`unknown backend: ${backend}`, { code: 'UNKNOWN_BACKEND', backend });
  }
  return backend;
}

export function healthTimeIso(ms) {
  return new Date(ms).toISOString();
}

export function sanitizeHealthDiagnostic(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, 500);
  try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); }
}

function freezeObservation(observation) {
  return Object.freeze({ ...observation });
}

export class BackendHealthRegistry {
  #clock;
  #cooldownMs;
  #entries = new Map();

  constructor({ clock = () => Date.now(), cooldownMs = DEFAULT_BACKEND_HEALTH_COOLDOWN_MS } = {}) {
    if (typeof clock !== 'function') throw new TypeError('health registry clock must be a function');
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1) throw new TypeError('cooldownMs must be a positive integer');
    this.#clock = clock;
    this.#cooldownMs = cooldownMs;
    for (const backend of BACKENDS) this.#entries.set(backend, this.#unknownEntry(backend));
  }

  #unknownEntry(backend) {
    return freezeObservation({
      backend,
      status: BACKEND_HEALTH_STATUS.UNKNOWN,
      classification: null,
      retryable: false,
      observedAt: null,
      cooldownUntil: null,
      diagnostic: null,
    });
  }

  #materialize(entry) {
    if (
      entry.status === BACKEND_HEALTH_STATUS.UNAVAILABLE &&
      entry.retryable &&
      entry.cooldownUntil !== null &&
      this.#clock() >= entry.cooldownUntil
    ) {
      return freezeObservation({
        backend: entry.backend,
        status: BACKEND_HEALTH_STATUS.UNKNOWN,
        classification: entry.classification,
        retryable: true,
        observedAt: entry.observedAt,
        cooldownUntil: entry.cooldownUntil,
        diagnostic: entry.diagnostic,
      });
    }
    return entry;
  }

  get(backend) {
    requireHealthBackend(backend);
    return this.#materialize(this.#entries.get(backend));
  }

  recordSuccess(backend, { degraded = false, diagnostic = null } = {}) {
    requireHealthBackend(backend);
    const observedMs = this.#clock();
    const entry = freezeObservation({
      backend,
      status: degraded ? BACKEND_HEALTH_STATUS.DEGRADED : BACKEND_HEALTH_STATUS.HEALTHY,
      classification: null,
      retryable: false,
      observedAt: healthTimeIso(observedMs),
      cooldownUntil: null,
      diagnostic: sanitizeHealthDiagnostic(diagnostic),
    });
    this.#entries.set(backend, entry);
    return entry;
  }

  recordFailure(backend, { classification = BACKEND_FAILURE_CLASSIFICATION.UNKNOWN_FAILURE, diagnostic = null, cooldownMs } = {}) {
    requireHealthBackend(backend);
    if (!Object.values(BACKEND_FAILURE_CLASSIFICATION).includes(classification)) {
      throw new BackendHealthError(`unknown failure classification: ${classification}`, {
        code: 'UNKNOWN_FAILURE_CLASSIFICATION', classification,
      });
    }
    const retryable = RETRYABLE.has(classification);
    const observedMs = this.#clock();
    const resolvedCooldown = cooldownMs === undefined ? this.#cooldownMs : cooldownMs;
    if (retryable && (!Number.isInteger(resolvedCooldown) || resolvedCooldown < 1)) {
      throw new TypeError('retryable failure cooldownMs must be a positive integer');
    }
    const entry = freezeObservation({
      backend,
      status: BACKEND_HEALTH_STATUS.UNAVAILABLE,
      classification,
      retryable,
      observedAt: healthTimeIso(observedMs),
      cooldownUntil: retryable ? observedMs + resolvedCooldown : null,
      diagnostic: sanitizeHealthDiagnostic(diagnostic),
    });
    this.#entries.set(backend, entry);
    return entry;
  }

  snapshot() {
    const out = {};
    for (const backend of [...BACKENDS].sort()) out[backend] = this.get(backend);
    return Object.freeze(out);
  }
}

export function isUsableHealthStatus(status) {
  return status === BACKEND_HEALTH_STATUS.HEALTHY || status === BACKEND_HEALTH_STATUS.DEGRADED;
}

export function isRetryableHealthClassification(classification) {
  return RETRYABLE.has(classification);
}

export function knownHealthBackends() {
  return [...BACKENDS].sort();
}
