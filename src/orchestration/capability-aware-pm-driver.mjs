import { capabilitySnapshot, selectBackend } from './capability-selector.mjs';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveEndpoint(endpoint) {
  if (typeof endpoint === 'string') return endpoint;
  if (isPlainObject(endpoint)) return selectBackend(endpoint).backend;
  return endpoint;
}

export function resolveCapabilityAwareDecision(decision) {
  if (!isPlainObject(decision)) return decision;

  if (decision.type === 'workflow' && isPlainObject(decision.spec) && Array.isArray(decision.spec.steps)) {
    return {
      ...decision,
      spec: {
        ...decision.spec,
        steps: decision.spec.steps.map((step) => ({
          ...step,
          recipient: resolveEndpoint(step?.recipient),
        })),
      },
    };
  }

  if (decision.type === 'peer_exchange' && Array.isArray(decision.routes)) {
    return {
      ...decision,
      routes: decision.routes.map((route) => ({
        ...route,
        from: resolveEndpoint(route?.from),
        to: resolveEndpoint(route?.to),
      })),
    };
  }

  return decision;
}

export function createCapabilityAwarePmDriver(driver) {
  if (!driver || typeof driver !== 'object' || typeof driver.decide !== 'function') {
    throw new TypeError('capability-aware PM wrapper requires driver.decide()');
  }
  if (typeof driver.name !== 'string' || driver.name.trim() === '') {
    throw new TypeError('capability-aware PM wrapper requires driver.name');
  }
  const backendCapabilities = capabilitySnapshot();
  return Object.freeze({
    name: driver.name,
    async decide(input) {
      const decision = await driver.decide({ ...input, backendCapabilities });
      return resolveCapabilityAwareDecision(decision);
    },
  });
}
