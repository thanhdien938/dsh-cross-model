import { capabilitySnapshot } from './capability-selector.mjs';
import { selectBackendWithHealth } from './health-aware-selector.mjs';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveEndpoint(endpoint, healthSnapshot) {
  if (typeof endpoint === 'string') return endpoint;
  if (isPlainObject(endpoint)) return selectBackendWithHealth(endpoint, healthSnapshot).backend;
  return endpoint;
}

export function resolveHealthAwareDecision(decision, healthSnapshot) {
  if (!isPlainObject(decision)) return decision;

  if (decision.type === 'workflow' && isPlainObject(decision.spec) && Array.isArray(decision.spec.steps)) {
    return {
      ...decision,
      spec: {
        ...decision.spec,
        steps: decision.spec.steps.map((step) => ({
          ...step,
          recipient: resolveEndpoint(step?.recipient, healthSnapshot),
        })),
      },
    };
  }

  if (decision.type === 'peer_exchange' && Array.isArray(decision.routes)) {
    return {
      ...decision,
      routes: decision.routes.map((route) => ({
        ...route,
        from: resolveEndpoint(route?.from, healthSnapshot),
        to: resolveEndpoint(route?.to, healthSnapshot),
      })),
    };
  }

  return decision;
}

export function createHealthAwarePmDriver(driver, { healthRegistry } = {}) {
  if (!driver || typeof driver !== 'object' || typeof driver.decide !== 'function') {
    throw new TypeError('health-aware PM wrapper requires driver.decide()');
  }
  if (typeof driver.name !== 'string' || driver.name.trim() === '') {
    throw new TypeError('health-aware PM wrapper requires driver.name');
  }
  if (!healthRegistry || typeof healthRegistry.snapshot !== 'function') {
    throw new TypeError('health-aware PM wrapper requires healthRegistry.snapshot()');
  }
  const backendCapabilities = capabilitySnapshot();
  return Object.freeze({
    name: driver.name,
    async decide(input) {
      const backendHealth = healthRegistry.snapshot();
      const decision = await driver.decide({ ...input, backendCapabilities, backendHealth });
      return resolveHealthAwareDecision(decision, backendHealth);
    },
  });
}
