const EXECUTABLE = new Set(['ACTIVE']);
const REQUIREMENT_KEYS = ['backend', 'product', 'version', 'transport'];

export function evaluateWorkerEligibility({ worker, requirement, providerHealth = 'UNKNOWN' } = {}) {
  const required = normalizeRequirement(requirement);
  if (!worker || typeof worker !== 'object') return result(false, 'WORKER_UNKNOWN', providerHealth);
  if (!EXECUTABLE.has(worker.status)) return result(false, `WORKER_${worker.status ?? 'UNKNOWN'}`, providerHealth);
  const capacity = worker.capacity;
  if (!capacity || capacity.reported_in_use >= capacity.max_concurrency) return result(false, 'WORKER_CAPACITY_FULL', providerHealth);
  const profile = worker.installed_profiles?.find((candidate) => REQUIREMENT_KEYS.every((key) => candidate[key] === required[key]) && (required.fingerprint === undefined || candidate.fingerprint === required.fingerprint));
  if (!profile) return result(false, 'WORKER_PROFILE_MISMATCH', providerHealth);
  if (providerHealth === 'UNAVAILABLE') return result(false, 'PROVIDER_UNAVAILABLE', providerHealth, profile);
  return result(true, 'ELIGIBLE', providerHealth, profile);
}

export function selectEligibleWorkers({ workers = [], requirement, providerHealth = 'UNKNOWN' } = {}) {
  return Object.freeze(workers.map((worker) => ({ worker, eligibility: evaluateWorkerEligibility({ worker, requirement, providerHealth }) })).filter((entry) => entry.eligibility.eligible).sort((a, b) => a.worker.worker_incarnation_id.localeCompare(b.worker.worker_incarnation_id)));
}

function normalizeRequirement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('runtime requirement is required');
  const allowed = [...REQUIREMENT_KEYS, 'fingerprint']; const keys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || REQUIREMENT_KEYS.some((key) => typeof value[key] !== 'string' || !value[key])) throw new TypeError('runtime requirement is invalid');
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !('value' in d)) throw new TypeError('runtime requirement is invalid'); }
  return value;
}
function result(eligible, reason, providerHealth, profile = null) { return Object.freeze({ eligible, reason, providerHealth, profile: profile ? Object.freeze({ backend: profile.backend, product: profile.product, version: profile.version, transport: profile.transport, fingerprint: profile.fingerprint ?? null }) : null }); }
