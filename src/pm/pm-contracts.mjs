/**
 * Gate 6 — project-owned PM contracts.
 *
 * PM drivers return normalized orchestration decisions. The contract is
 * intentionally unaware of provider/model identity: a PM may be scripted,
 * backed by a DSH parent, an API model, or another future driver without
 * changing the orchestration substrate.
 */

import { createId, nowUtc } from '../bus/envelopes.mjs';
import { InvalidEnvelopeError } from '../bus/errors.mjs';

export const PM_DECISION_TYPES = Object.freeze({
  WORKFLOW: 'workflow',
  PEER_EXCHANGE: 'peer_exchange',
  FINISH: 'finish',
  AWAIT_OWNER: 'await_owner',
});

export const PM_CAPABILITIES = Object.freeze([
  PM_DECISION_TYPES.WORKFLOW,
  PM_DECISION_TYPES.PEER_EXCHANGE,
  PM_DECISION_TYPES.FINISH,
  PM_DECISION_TYPES.AWAIT_OWNER,
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEnvelopeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalPlainObject(value, label) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new InvalidEnvelopeError(`${label} must be a plain object when provided`);
  return value;
}

/** Create a normalized caller request for one PM run. */
export function createPmRequest({ id, objective, context } = {}) {
  return {
    id: id ?? createId('pmreq'),
    objective: requireNonEmptyString(objective, 'pm.request.objective'),
    context: optionalPlainObject(context, 'pm.request.context') ?? {},
    createdAt: nowUtc(),
  };
}

/**
 * Validate and normalize one PM driver decision.
 * The runtime executes these decisions through existing project-owned layers.
 */
export function normalizePmDecision(decision) {
  if (!isPlainObject(decision)) {
    throw new InvalidEnvelopeError('pm decision must be a plain object');
  }
  const type = requireNonEmptyString(decision.type, 'pm.decision.type');

  if (type === PM_DECISION_TYPES.WORKFLOW) {
    if (!isPlainObject(decision.spec)) {
      throw new InvalidEnvelopeError('workflow decision requires a plain-object spec');
    }
    return { type, spec: decision.spec };
  }

  if (type === PM_DECISION_TYPES.PEER_EXCHANGE) {
    if (!Array.isArray(decision.routes) || decision.routes.length === 0) {
      throw new InvalidEnvelopeError('peer_exchange decision requires a non-empty routes array');
    }
    const routes = decision.routes.map((route, index) => {
      if (!isPlainObject(route)) throw new InvalidEnvelopeError(`peer_exchange.routes[${index}] must be a plain object`);
      return {
        from: requireNonEmptyString(route.from, `peer_exchange.routes[${index}].from`),
        to: requireNonEmptyString(route.to, `peer_exchange.routes[${index}].to`),
      };
    });
    const normalized = {
      type,
      conversationId: decision.conversationId ?? null,
      routes,
      body: requireNonEmptyString(decision.body, 'peer_exchange.body'),
      sourceResult: decision.sourceResult ?? null,
      context: optionalPlainObject(decision.context, 'peer_exchange.context'),
      metadata: optionalPlainObject(decision.metadata, 'peer_exchange.metadata'),
      maxHops: decision.maxHops ?? null,
    };
    if (normalized.conversationId !== null) {
      normalized.conversationId = requireNonEmptyString(normalized.conversationId, 'peer_exchange.conversationId');
    }
    if (normalized.maxHops !== null && (!Number.isInteger(normalized.maxHops) || normalized.maxHops < 1)) {
      throw new InvalidEnvelopeError('peer_exchange.maxHops must be a positive integer when provided');
    }
    return normalized;
  }

  if (type === PM_DECISION_TYPES.FINISH) {
    return {
      type,
      output: typeof decision.output === 'string' ? decision.output : '',
      data: optionalPlainObject(decision.data, 'finish.data'),
    };
  }

  if (type === PM_DECISION_TYPES.AWAIT_OWNER) {
    const kind = requireNonEmptyString(decision.kind, 'await_owner.kind').toUpperCase();
    if (!['QUESTION', 'APPROVAL'].includes(kind)) throw new InvalidEnvelopeError('await_owner.kind must be QUESTION or APPROVAL');
    const allowedResponses = [...new Set(decision.allowedResponses ?? [])];
    if (allowedResponses.length === 0 || allowedResponses.some((v) => typeof v !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(v))) throw new InvalidEnvelopeError('await_owner.allowedResponses is invalid');
    return { type, kind, title: requireNonEmptyString(decision.title, 'await_owner.title'), prompt: requireNonEmptyString(decision.prompt, 'await_owner.prompt'), allowedResponses, localOnly: decision.localOnly === true };
  }

  throw new InvalidEnvelopeError(`unsupported pm decision type: ${type}`);
}

/** Normalize a PM driver's identity and decide() capability. */
export function assertPmDriver(driver) {
  if (driver === null || typeof driver !== 'object') {
    throw new TypeError('PmRuntime requires a PM driver object');
  }
  const name = requireNonEmptyString(driver.name, 'pm.driver.name');
  if (typeof driver.decide !== 'function') {
    throw new TypeError(`PM driver "${name}" must implement decide(input)`);
  }
  return driver;
}
