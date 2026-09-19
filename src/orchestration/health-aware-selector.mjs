import { eligibleBackends, normalizeCapabilitySelector } from './capability-selector.mjs';
import { BACKEND_HEALTH_STATUS, isUsableHealthStatus } from './backend-health-registry.mjs';

export class HealthAwareSelectionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'HealthAwareSelectionError';
    Object.assign(this, extra);
  }
}

function requireHealthSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new HealthAwareSelectionError('backend health snapshot must be an object', { code: 'INVALID_HEALTH_SNAPSHOT' });
  }
  return snapshot;
}

function tier(status) {
  if (status === BACKEND_HEALTH_STATUS.HEALTHY) return 0;
  if (status === BACKEND_HEALTH_STATUS.DEGRADED) return 1;
  return 2;
}

export function selectBackendWithHealth(selector, healthSnapshot) {
  const normalized = normalizeCapabilitySelector(selector);
  const snapshot = requireHealthSnapshot(healthSnapshot);
  const capabilityEligible = eligibleBackends(normalized);

  if (capabilityEligible.length === 0) {
    throw new HealthAwareSelectionError(
      `no proven backend satisfies: ${normalized.requires.join(', ')}`,
      { code: 'NO_PROVEN_BACKEND', requires: [...normalized.requires], capabilityEligible: [] },
    );
  }

  const usable = capabilityEligible.filter((backend) => isUsableHealthStatus(snapshot[backend]?.status));
  if (usable.length === 0) {
    const health = {};
    for (const backend of capabilityEligible) health[backend] = snapshot[backend] ?? null;
    throw new HealthAwareSelectionError(
      `no usable backend satisfies: ${normalized.requires.join(', ')}`,
      { code: 'NO_USABLE_BACKEND', requires: [...normalized.requires], capabilityEligible: [...capabilityEligible], health },
    );
  }

  const usableSet = new Set(usable);
  const preferredRank = new Map(normalized.prefer.map((backend, index) => [backend, index]));
  const ranked = [...usable].sort((a, b) => {
    const tierDiff = tier(snapshot[a].status) - tier(snapshot[b].status);
    if (tierDiff !== 0) return tierDiff;
    const pa = preferredRank.has(a) ? preferredRank.get(a) : Number.MAX_SAFE_INTEGER;
    const pb = preferredRank.has(b) ? preferredRank.get(b) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  const backend = ranked[0];
  return Object.freeze({
    backend,
    usable: Object.freeze([...ranked]),
    capabilityEligible: Object.freeze([...capabilityEligible]),
    selector: normalized,
    health: snapshot[backend],
    preferredEligible: Object.freeze(normalized.prefer.filter((candidate) => usableSet.has(candidate))),
  });
}
