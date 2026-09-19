import {
  CAPABILITY_STATUS,
  PROVEN_SESSION_CAPABILITY_MATRIX,
} from '../session/proven-capability-matrix.mjs';

export class CapabilitySelectionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CapabilitySelectionError';
    Object.assign(this, extra);
  }
}

const BACKENDS = Object.freeze(Object.keys(PROVEN_SESSION_CAPABILITY_MATRIX).sort());
const CAPABILITIES = Object.freeze(Object.keys(PROVEN_SESSION_CAPABILITY_MATRIX[BACKENDS[0]].capabilities).sort());
const CAPABILITY_SET = new Set(CAPABILITIES);
const BACKEND_SET = new Set(BACKENDS);

function uniqueStrings(values, label) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new CapabilitySelectionError(`${label} must be an array`, { code: 'INVALID_SELECTOR' });
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CapabilitySelectionError(`${label} entries must be non-empty strings`, { code: 'INVALID_SELECTOR' });
    }
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function assertKnownCapabilities(capabilities) {
  for (const capability of capabilities) {
    if (!CAPABILITY_SET.has(capability)) {
      throw new CapabilitySelectionError(`unknown capability: ${capability}`, {
        code: 'UNKNOWN_CAPABILITY',
        capability,
      });
    }
  }
}

function assertKnownBackends(backends, label) {
  for (const backend of backends) {
    if (!BACKEND_SET.has(backend)) {
      throw new CapabilitySelectionError(`unknown backend in ${label}: ${backend}`, {
        code: 'UNKNOWN_BACKEND',
        backend,
      });
    }
  }
}

export function normalizeCapabilitySelector(selector) {
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) {
    throw new CapabilitySelectionError('capability selector must be a plain object', { code: 'INVALID_SELECTOR' });
  }
  const requires = uniqueStrings(selector.requires, 'selector.requires');
  if (requires.length === 0) {
    throw new CapabilitySelectionError('selector.requires must contain at least one capability', { code: 'INVALID_SELECTOR' });
  }
  const prefer = uniqueStrings(selector.prefer, 'selector.prefer');
  const exclude = uniqueStrings(selector.exclude, 'selector.exclude');
  assertKnownCapabilities(requires);
  assertKnownBackends(prefer, 'selector.prefer');
  assertKnownBackends(exclude, 'selector.exclude');
  return Object.freeze({
    requires: Object.freeze([...requires]),
    prefer: Object.freeze([...prefer]),
    exclude: Object.freeze([...exclude]),
  });
}

export function eligibleBackends(selector) {
  const normalized = normalizeCapabilitySelector(selector);
  const excluded = new Set(normalized.exclude);
  return BACKENDS.filter((backend) => {
    if (excluded.has(backend)) return false;
    const capabilities = PROVEN_SESSION_CAPABILITY_MATRIX[backend].capabilities;
    return normalized.requires.every((capability) => capabilities[capability] === CAPABILITY_STATUS.PROVED);
  });
}

export function selectBackend(selector) {
  const normalized = normalizeCapabilitySelector(selector);
  const eligible = eligibleBackends(normalized);
  if (eligible.length === 0) {
    throw new CapabilitySelectionError(
      `no proven backend satisfies: ${normalized.requires.join(', ')}`,
      { code: 'NO_PROVEN_BACKEND', requires: [...normalized.requires] },
    );
  }
  const eligibleSet = new Set(eligible);
  const preferred = normalized.prefer.find((backend) => eligibleSet.has(backend));
  const backend = preferred ?? eligible[0];
  return Object.freeze({
    backend,
    eligible: Object.freeze([...eligible]),
    selector: normalized,
    profile: PROVEN_SESSION_CAPABILITY_MATRIX[backend],
  });
}

export function capabilitySnapshot() {
  const snapshot = {};
  for (const backend of BACKENDS) {
    const profile = PROVEN_SESSION_CAPABILITY_MATRIX[backend];
    snapshot[backend] = Object.freeze({
      product: profile.product,
      version: profile.version,
      transport: profile.transport,
      capabilities: Object.freeze({ ...profile.capabilities }),
    });
  }
  return Object.freeze(snapshot);
}

export function knownCapabilityNames() {
  return [...CAPABILITIES];
}

export function knownBackendNames() {
  return [...BACKENDS];
}
