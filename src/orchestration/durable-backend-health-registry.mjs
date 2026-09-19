import {
  BACKEND_FAILURE_CLASSIFICATION,
  BACKEND_HEALTH_STATUS,
  BackendHealthError,
  DEFAULT_BACKEND_HEALTH_COOLDOWN_MS,
  healthTimeIso,
  isRetryableHealthClassification,
  knownHealthBackends,
  requireHealthBackend,
  sanitizeHealthDiagnostic,
} from './backend-health-registry.mjs';

export const DEFAULT_BACKEND_HEALTH_FRESHNESS_MS = 5 * 60_000;

const STICKY_FAILURES = new Set([
  BACKEND_FAILURE_CLASSIFICATION.AUTH,
  BACKEND_FAILURE_CLASSIFICATION.CONFIG,
  BACKEND_FAILURE_CLASSIFICATION.PROTOCOL,
]);

const freeze = (value) => Object.freeze({ ...value });

export class DurableBackendHealthRegistry {
  #repository;
  #clock;
  #cooldownMs;
  #freshnessMs;

  constructor({
    repository,
    clock = () => Date.now(),
    cooldownMs = DEFAULT_BACKEND_HEALTH_COOLDOWN_MS,
    freshnessMs = DEFAULT_BACKEND_HEALTH_FRESHNESS_MS,
  } = {}) {
    if (!repository || typeof repository.getRaw !== 'function' || typeof repository.commitObservation !== 'function') {
      throw new TypeError('durable health registry requires a HealthRepository-like getRaw()/commitObservation()');
    }
    if (typeof clock !== 'function') throw new TypeError('durable health registry clock must be a function');
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1) throw new TypeError('cooldownMs must be a positive integer');
    if (!Number.isInteger(freshnessMs) || freshnessMs < 1) throw new TypeError('freshnessMs must be a positive integer');
    this.#repository = repository;
    this.#clock = clock;
    this.#cooldownMs = cooldownMs;
    this.#freshnessMs = freshnessMs;
  }

  #unknown(backend, raw) {
    return freeze(raw ? { ...raw, status: BACKEND_HEALTH_STATUS.UNKNOWN } : {
      backend,
      status: BACKEND_HEALTH_STATUS.UNKNOWN,
      classification: null,
      retryable: false,
      observedAt: null,
      cooldownUntil: null,
      diagnostic: null,
      revision: 0,
    });
  }

  #materialize(backend, raw) {
    if (!raw) return this.#unknown(backend);
    const now = this.#clock();
    if (raw.status === BACKEND_HEALTH_STATUS.HEALTHY || raw.status === BACKEND_HEALTH_STATUS.DEGRADED) {
      const observedMs = Date.parse(raw.observedAt);
      return Number.isFinite(observedMs) && now - observedMs < this.#freshnessMs ? raw : this.#unknown(backend, raw);
    }
    if (raw.status === BACKEND_HEALTH_STATUS.UNAVAILABLE && raw.retryable) {
      return Number.isFinite(raw.cooldownUntil) && raw.cooldownUntil > now ? raw : this.#unknown(backend, raw);
    }
    if (raw.status === BACKEND_HEALTH_STATUS.UNAVAILABLE && STICKY_FAILURES.has(raw.classification)) return raw;
    return raw;
  }

  get(backend) {
    requireHealthBackend(backend);
    return this.#materialize(backend, this.#repository.getRaw(backend));
  }

  recordSuccess(backend, { degraded = false, diagnostic = null } = {}) {
    requireHealthBackend(backend);
    const observation = freeze({
      backend,
      status: degraded ? BACKEND_HEALTH_STATUS.DEGRADED : BACKEND_HEALTH_STATUS.HEALTHY,
      classification: null,
      retryable: false,
      observedAt: healthTimeIso(this.#clock()),
      cooldownUntil: null,
      diagnostic: sanitizeHealthDiagnostic(diagnostic),
    });
    return this.#repository.commitObservation(observation);
  }

  recordFailure(backend, {
    classification = BACKEND_FAILURE_CLASSIFICATION.UNKNOWN_FAILURE,
    diagnostic = null,
    cooldownMs,
  } = {}) {
    requireHealthBackend(backend);
    if (!Object.values(BACKEND_FAILURE_CLASSIFICATION).includes(classification)) {
      throw new BackendHealthError(`unknown failure classification: ${classification}`, {
        code: 'UNKNOWN_FAILURE_CLASSIFICATION', classification,
      });
    }
    const retryable = isRetryableHealthClassification(classification);
    const resolvedCooldown = cooldownMs === undefined ? this.#cooldownMs : cooldownMs;
    if (retryable && (!Number.isInteger(resolvedCooldown) || resolvedCooldown < 1)) {
      throw new TypeError('retryable failure cooldownMs must be a positive integer');
    }
    const observedMs = this.#clock();
    const observation = freeze({
      backend,
      status: BACKEND_HEALTH_STATUS.UNAVAILABLE,
      classification,
      retryable,
      observedAt: healthTimeIso(observedMs),
      cooldownUntil: retryable ? observedMs + resolvedCooldown : null,
      diagnostic: sanitizeHealthDiagnostic(diagnostic),
    });
    return this.#repository.commitObservation(observation);
  }

  snapshot() {
    const out = {};
    for (const backend of knownHealthBackends()) out[backend] = this.get(backend);
    return Object.freeze(out);
  }
}
