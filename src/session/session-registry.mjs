import {
  SessionCapabilityError,
  assertBridgeMatchesCapabilities,
  normalizeSessionCapabilities,
} from './session-capabilities.mjs';

function requireName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new SessionCapabilityError('session backend name must be a non-empty string', { code: 'INVALID_SESSION_BACKEND' });
  }
  return name;
}

export class SessionRegistry {
  #entries = new Map();

  register(name, bridge = {}, capabilities = {}, { replace = false } = {}) {
    const backend = requireName(name);
    const normalized = normalizeSessionCapabilities(capabilities);
    assertBridgeMatchesCapabilities(bridge, normalized, backend);
    if (!replace && this.#entries.has(backend)) {
      throw new SessionCapabilityError(`session backend already registered: ${backend}`, {
        code: 'DUPLICATE_SESSION_BACKEND', backend,
      });
    }
    this.#entries.set(backend, { backend, bridge, capabilities: normalized });
    return this;
  }

  unregister(name) {
    return this.#entries.delete(name);
  }

  has(name) {
    return this.#entries.has(name);
  }

  get(name) {
    return this.#entries.get(name);
  }

  list() {
    return [...this.#entries.keys()].sort();
  }

  report() {
    return this.list().map((backend) => ({
      backend,
      capabilities: { ...this.#entries.get(backend).capabilities },
    }));
  }
}
