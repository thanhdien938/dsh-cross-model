import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { DuplicateRegistrationError, InvalidAdapterError } from '../src/bus/errors.mjs';

const okAdapter = { start: async () => ({ output: 'x' }) };

test('registry: register/get/has/list three arbitrary backends, deterministic listing', () => {
  const registry = new AgentRegistry();
  registry.register('alpha', okAdapter, { transport: 'fake' });
  registry.register('bravo', okAdapter, { transport: 'fake' });
  registry.register('charlie', okAdapter, { transport: 'fake' });
  assert.equal(registry.has('alpha'), true);
  assert.equal(registry.has('nope'), false);
  assert.equal(typeof registry.get('bravo').start, 'function');
  assert.deepEqual(registry.list(), ['alpha', 'bravo', 'charlie']);
});

test('registry: preserves metadata and rejects duplicates unless replace', () => {
  const registry = new AgentRegistry();
  registry.register('alpha', okAdapter, { transport: 'fake', product: 'Alpha' });
  assert.equal(registry.getEntry('alpha').metadata.product, 'Alpha');
  assert.throws(() => registry.register('alpha', okAdapter), DuplicateRegistrationError);
  registry.register('alpha', okAdapter, { transport: 'replaced' }, { replace: true });
  assert.equal(registry.getEntry('alpha').metadata.transport, 'replaced');
});

test('registry: rejects invalid names and invalid adapters', () => {
  const registry = new AgentRegistry();
  assert.throws(() => registry.register('', okAdapter), InvalidAdapterError);
  assert.throws(() => registry.register('alpha', null), InvalidAdapterError);
  assert.throws(() => registry.register('alpha', { start: 'not-a-function' }), InvalidAdapterError);
});

test('registry: unregister removes a backend', () => {
  const registry = new AgentRegistry();
  registry.register('alpha', okAdapter);
  assert.equal(registry.unregister('alpha'), true);
  assert.equal(registry.unregister('alpha'), false);
  assert.deepEqual(registry.list(), []);
});
