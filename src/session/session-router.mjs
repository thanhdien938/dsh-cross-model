import { SessionCapabilityError } from './session-capabilities.mjs';

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SessionCapabilityError(`${label} must be a non-empty string`, { code: 'INVALID_SESSION_INPUT' });
  }
  return value;
}

function assertPlainObject(value, label) {
  if (value === undefined || value === null) return {};
  const proto = typeof value === 'object' && !Array.isArray(value) ? Object.getPrototypeOf(value) : null;
  if (proto !== Object.prototype && proto !== null) {
    throw new SessionCapabilityError(`${label} must be a plain object`, { code: 'INVALID_SESSION_INPUT' });
  }
  return value;
}

export class SessionRouter {
  #registry;
  #agentBus;

  constructor({ registry, agentBus = null } = {}) {
    if (!registry || typeof registry.get !== 'function') {
      throw new TypeError('SessionRouter requires a session registry');
    }
    this.#registry = registry;
    this.#agentBus = agentBus;
  }

  capabilities(backend) {
    const entry = this.#entry(backend);
    return { ...entry.capabilities };
  }

  report() {
    return this.#registry.report();
  }

  async resume(backend, sessionId, options = {}) {
    return this.#invoke(backend, 'resume_existing', 'resume', [requireString(sessionId, 'sessionId'), assertPlainObject(options, 'options')]);
  }

  async sendNextTurn(backend, sessionId, message, options = {}) {
    requireString(message, 'message');
    return this.#invoke(
      backend,
      'send_next_turn',
      'sendNextTurn',
      [requireString(sessionId, 'sessionId'), message, assertPlainObject(options, 'options')],
    );
  }

  async interrupt(backend, sessionId, options = {}) {
    return this.#invoke(
      backend,
      'interrupt_active_turn',
      'interrupt',
      [requireString(sessionId, 'sessionId'), assertPlainObject(options, 'options')],
    );
  }

  subscribeEvents(backend, sessionId, listener) {
    if (typeof listener !== 'function') {
      throw new SessionCapabilityError('listener must be a function', { code: 'INVALID_SESSION_INPUT' });
    }
    const entry = this.#entry(backend);
    this.#requireCapability(entry, 'stream_events');
    return entry.bridge.subscribeEvents(requireString(sessionId, 'sessionId'), listener);
  }

  planFreshDispatchFallback({ backend, body, context = {}, expectedOutput = null, sender = 'pm' } = {}) {
    requireString(backend, 'backend');
    requireString(body, 'body');
    requireString(sender, 'sender');
    const normalizedContext = assertPlainObject(context, 'context');
    if (expectedOutput !== null && (typeof expectedOutput !== 'string' || expectedOutput.trim() === '')) {
      throw new SessionCapabilityError('expectedOutput must be null or a non-empty string', { code: 'INVALID_SESSION_INPUT' });
    }
    return Object.freeze({
      mode: 'fresh_dispatch',
      backend,
      sender,
      truthfulContinuity: false,
      body,
      context: normalizedContext,
      expectedOutput,
      executed: false,
    });
  }

  async executeFreshDispatchPlan(plan) {
    if (!this.#agentBus || typeof this.#agentBus.dispatch !== 'function') {
      throw new SessionCapabilityError('no AgentBus configured for explicit fallback execution', { code: 'NO_AGENT_BUS' });
    }
    if (!plan || plan.mode !== 'fresh_dispatch' || plan.executed !== false || plan.truthfulContinuity !== false) {
      throw new SessionCapabilityError('invalid fresh-dispatch fallback plan', { code: 'INVALID_FALLBACK_PLAN' });
    }
    return this.#agentBus.dispatch({
      sender: plan.sender,
      recipient: plan.backend,
      body: plan.body,
      context: plan.context,
      expectedOutput: plan.expectedOutput,
    });
  }

  #entry(backend) {
    requireString(backend, 'backend');
    const entry = this.#registry.get(backend);
    if (!entry) {
      throw new SessionCapabilityError(`unknown session backend: ${backend}`, { code: 'UNKNOWN_SESSION_BACKEND', backend });
    }
    return entry;
  }

  #requireCapability(entry, capability) {
    if (!entry.capabilities[capability]) {
      throw new SessionCapabilityError(
        `backend ${entry.backend} does not support ${capability}`,
        { code: 'UNSUPPORTED_SESSION_CAPABILITY', backend: entry.backend, capability },
      );
    }
  }

  async #invoke(backend, capability, method, args) {
    const entry = this.#entry(backend);
    this.#requireCapability(entry, capability);
    return entry.bridge[method](...args);
  }
}
