/**
 * Deterministic PM driver for Gate 6 tests/smoke.
 *
 * This is deliberately not a policy engine. It simply proves that PmRuntime
 * depends on a tiny swappable `name + decide()` contract instead of a specific
 * parent model implementation.
 */

import { InvalidEnvelopeError } from '../bus/errors.mjs';

export function createScriptedPmDriver({ name, decisions } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidEnvelopeError('scripted PM driver name must be a non-empty string');
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new InvalidEnvelopeError('scripted PM driver requires a non-empty decisions array');
  }

  let cursor = 0;
  return {
    name,
    async decide(input) {
      if (cursor >= decisions.length) {
        throw new InvalidEnvelopeError(`scripted PM driver "${name}" exhausted decisions at turn ${input?.turn ?? cursor}`);
      }
      const entry = decisions[cursor++];
      return typeof entry === 'function' ? entry(input) : entry;
    },
  };
}
