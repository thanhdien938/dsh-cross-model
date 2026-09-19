import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../src/session/session-registry.mjs';
import { SessionRouter } from '../src/session/session-router.mjs';
import {
  DEFAULT_SESSION_CAPABILITIES,
  SessionCapabilityError,
  normalizeSessionCapabilities,
} from '../src/session/session-capabilities.mjs';

test('all session capabilities default false', () => {
  assert.deepEqual(normalizeSessionCapabilities(), DEFAULT_SESSION_CAPABILITIES);
});

test('unknown and non-boolean capability declarations are rejected', () => {
  assert.throws(() => normalizeSessionCapabilities({ teleport: true }), /unknown session capability/);
  assert.throws(() => normalizeSessionCapabilities({ resume_existing: 'yes' }), /must be boolean/);
});

test('registry supports arbitrary backend names and deterministic reports', () => {
  const registry = new SessionRegistry();
  registry.register('zeta', {}, {});
  registry.register('alpha', { resume: async () => 'ok' }, { resume_existing: true });
  assert.deepEqual(registry.list(), ['alpha', 'zeta']);
  assert.deepEqual(registry.report().map((r) => r.backend), ['alpha', 'zeta']);
});

test('capability cannot be claimed when bridge method is absent', () => {
  const registry = new SessionRegistry();
  assert.throws(
    () => registry.register('alpha', {}, { send_next_turn: true }),
    (error) => error instanceof SessionCapabilityError && error.code === 'CAPABILITY_METHOD_MISMATCH',
  );
});

test('supported operations delegate exactly once', async () => {
  const calls = [];
  const bridge = {
    resume: async (...args) => { calls.push(['resume', ...args]); return { nativeSessionId: 'native-1' }; },
    sendNextTurn: async (...args) => { calls.push(['next', ...args]); return { output: 'reply' }; },
    interrupt: async (...args) => { calls.push(['interrupt', ...args]); return { interrupted: true }; },
    subscribeEvents: (...args) => { calls.push(['events', ...args]); return () => {}; },
  };
  const registry = new SessionRegistry().register('waldo', bridge, {
    resume_existing: true,
    send_next_turn: true,
    interrupt_active_turn: true,
    stream_events: true,
  });
  const router = new SessionRouter({ registry });
  await router.resume('waldo', 's1');
  await router.sendNextTurn('waldo', 's1', 'hello');
  await router.interrupt('waldo', 's1');
  const listener = () => {};
  const unsubscribe = router.subscribeEvents('waldo', 's1', listener);
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c[0]), ['resume', 'next', 'interrupt', 'events']);
});

test('unsupported operation fails before bridge invocation', async () => {
  let calls = 0;
  const registry = new SessionRegistry().register('one-shot', {
    resume: async () => { calls += 1; },
  }, {});
  const router = new SessionRouter({ registry });
  await assert.rejects(
    () => router.resume('one-shot', 's1'),
    (error) => error.code === 'UNSUPPORTED_SESSION_CAPABILITY',
  );
  assert.equal(calls, 0);
});

test('fresh dispatch fallback is explicit and does not execute during planning', () => {
  let dispatched = 0;
  const agentBus = { dispatch: async () => { dispatched += 1; return { id: 'run-1' }; } };
  const registry = new SessionRegistry().register('alpha', {}, {});
  const router = new SessionRouter({ registry, agentBus });
  const plan = router.planFreshDispatchFallback({ backend: 'alpha', body: 'hello', context: { x: 1 } });
  assert.equal(plan.mode, 'fresh_dispatch');
  assert.equal(plan.truthfulContinuity, false);
  assert.equal(plan.executed, false);
  assert.equal(dispatched, 0);
});

test('explicit fallback execution creates exactly one fresh AgentBus dispatch', async () => {
  const calls = [];
  const agentBus = { dispatch: async (input) => { calls.push(input); return { id: 'run-1' }; } };
  const registry = new SessionRegistry().register('alpha', {}, {});
  const router = new SessionRouter({ registry, agentBus });
  const plan = router.planFreshDispatchFallback({ backend: 'alpha', body: 'hello', context: { x: 1 }, sender: 'pm' });
  const run = await router.executeFreshDispatchPlan(plan);
  assert.equal(run.id, 'run-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient, 'alpha');
});

test('registry replace and unregister semantics are explicit', () => {
  const registry = new SessionRegistry().register('alpha', {}, {});
  assert.throws(() => registry.register('alpha', {}, {}), /already registered/);
  registry.register('alpha', { resume: async () => 'ok' }, { resume_existing: true }, { replace: true });
  assert.equal(registry.get('alpha').capabilities.resume_existing, true);
  assert.equal(registry.unregister('alpha'), true);
  assert.equal(registry.has('alpha'), false);
});

test('router does not infer capabilities from provider-like backend names', async () => {
  const registry = new SessionRegistry();
  registry.register('codex', {}, {});
  registry.register('claude-code', {}, {});
  registry.register('grok', {}, {});
  const router = new SessionRouter({ registry });
  for (const backend of registry.list()) {
    assert.deepEqual(router.capabilities(backend), DEFAULT_SESSION_CAPABILITIES);
    await assert.rejects(() => router.resume(backend, 's1'), /does not support resume_existing/);
  }
});
