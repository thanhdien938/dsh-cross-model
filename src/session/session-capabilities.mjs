export const SESSION_CAPABILITY_KEYS = Object.freeze([
  'resume_existing',
  'send_next_turn',
  'interrupt_active_turn',
  'stream_events',
  'concurrent_client_safe',
  'ui_live_refresh',
]);

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze(
  Object.fromEntries(SESSION_CAPABILITY_KEYS.map((key) => [key, false])),
);

export class SessionCapabilityError extends Error {
  constructor(message, { code = 'SESSION_CAPABILITY_ERROR', backend = null, capability = null } = {}) {
    super(message);
    this.name = 'SessionCapabilityError';
    this.code = code;
    this.backend = backend;
    this.capability = capability;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function normalizeSessionCapabilities(input = {}) {
  if (!isPlainObject(input)) {
    throw new SessionCapabilityError('session capabilities must be a plain object', { code: 'INVALID_CAPABILITIES' });
  }
  for (const key of Object.keys(input)) {
    if (!SESSION_CAPABILITY_KEYS.includes(key)) {
      throw new SessionCapabilityError(`unknown session capability: ${key}`, { code: 'UNKNOWN_CAPABILITY', capability: key });
    }
    if (typeof input[key] !== 'boolean') {
      throw new SessionCapabilityError(`session capability ${key} must be boolean`, { code: 'INVALID_CAPABILITY_VALUE', capability: key });
    }
  }
  return Object.freeze({ ...DEFAULT_SESSION_CAPABILITIES, ...input });
}

export function assertBridgeMatchesCapabilities(bridge, capabilities, backend = null) {
  if (bridge === null || typeof bridge !== 'object') {
    throw new SessionCapabilityError('session bridge must be an object', { code: 'INVALID_SESSION_BRIDGE', backend });
  }
  const requirements = {
    resume_existing: 'resume',
    send_next_turn: 'sendNextTurn',
    interrupt_active_turn: 'interrupt',
    stream_events: 'subscribeEvents',
  };
  for (const [capability, method] of Object.entries(requirements)) {
    if (capabilities[capability] && typeof bridge[method] !== 'function') {
      throw new SessionCapabilityError(
        `backend ${backend ?? '<unknown>'} declares ${capability} but bridge lacks ${method}()`,
        { code: 'CAPABILITY_METHOD_MISMATCH', backend, capability },
      );
    }
  }
  return true;
}
