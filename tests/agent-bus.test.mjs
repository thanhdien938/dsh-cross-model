import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import {
  AgentNotRegisteredError,
  InvalidEnvelopeError,
  UnsupportedCapabilityError,
  UNSUPPORTED,
} from '../src/bus/errors.mjs';

function newHarness() {
  const events = new EventBus();
  const state = new StateStore();
  const registry = new AgentRegistry();
  const bus = new AgentBus({ registry, events, state });
  return { events, state, registry, bus };
}

const okAdapter = { start: async () => ({ output: 'fake output', stopReason: 'completed' }) };

test('dispatch completes through a registered fake adapter with correlated ids', async () => {
  const { state, registry, bus } = newHarness();
  registry.register('alpha', okAdapter);
  const run = await bus.dispatch({ recipient: 'alpha', body: 'do the work' });
  assert.equal(run.status, 'completed');
  const result = bus.result(run.id);
  assert.equal(result.taskId, run.taskId);
  assert.equal(result.runId, run.id);
  assert.equal(result.agent, 'alpha');
  assert.equal(result.output, 'fake output');
  assert.equal(state.getTask(run.taskId).recipient, 'alpha');
});

test('dispatch to an unknown backend fails clearly', async () => {
  const { bus } = newHarness();
  await assert.rejects(bus.dispatch({ recipient: 'ghost', body: 'x' }), AgentNotRegisteredError);
});

test('lifecycle events occur in the correct order on success', async () => {
  const { registry, bus } = newHarness();
  const order = [];
  bus.events.all((event) => order.push(event));
  registry.register('beta', okAdapter);
  await bus.dispatch({ recipient: 'beta', body: 'x' });
  assert.deepEqual(order, [
    'task.created',
    'task.dispatched',
    'agent.started',
    'result.created',
    'agent.completed',
  ]);
});

test('failed adapter emits agent.failed and records a failed run with sanitized error', async () => {
  const { state, registry, bus } = newHarness();
  const events = [];
  bus.events.all((event) => events.push(event));
  registry.register('gamma', {
    start: async () => { throw new Error('boom'); },
    dispose: async () => {},
  });
  await assert.rejects(bus.dispatch({ recipient: 'gamma', body: 'x' }), /boom/);
  const run = state.listRuns({ status: 'failed' })[0];
  assert.equal(run.error.message, 'boom');
  assert.equal(run.error instanceof Error, false);
  assert.ok(events.includes('agent.failed'));
  assert.ok(!events.includes('result.created'));
});

test('cancellation reaches the adapter and records cancelled state', async () => {
  const { state, registry, bus } = newHarness();
  const calls = [];
  registry.register('delta', {
    start: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    cancel: async () => { calls.push('cancel'); },
    dispose: async () => { calls.push('dispose'); },
  });
  let runId;
  bus.events.once('agent.started', (payload) => { runId = payload.runId; });
  const pending = bus.dispatch({ recipient: 'delta', body: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.getRun(runId).status, 'running');
  await bus.cancel(runId);
  await assert.rejects(pending);
  assert.equal(state.getRun(runId).status, 'cancelled');
  assert.ok(calls.includes('cancel'));
  assert.ok(calls.includes('dispose'));
});

test('send records a message centrally and reports unsupported live delivery explicitly', async () => {
  const { state, registry, bus } = newHarness();
  const events = [];
  bus.events.all((event) => events.push(event));
  registry.register('epsilon', okAdapter);
  const run = await bus.dispatch({ recipient: 'epsilon', body: 'x' });
  await assert.rejects(
    bus.send({ from: 'pm', to: 'epsilon', taskId: run.taskId, runId: run.id, body: 'note' }),
    UnsupportedCapabilityError,
  );
  assert.equal(state.messagesForTask(run.taskId).length, 1);
  assert.equal(state.messagesForTask(run.taskId)[0].body, 'note');
  assert.ok(events.includes('message.created'));
});

test('send to a live two-way fake actually delivers', async () => {
  const { state, registry, bus } = newHarness();
  const sent = [];
  registry.register('zeta', {
    start: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    send: async ({ message }) => { sent.push(message); return {}; },
    cancel: async () => {},
    dispose: async () => {},
  });
  let runId;
  bus.events.once('agent.started', (payload) => { runId = payload.runId; });
  const pending = bus.dispatch({ recipient: 'zeta', body: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  const outcome = await bus.send({ from: 'pm', to: 'zeta', taskId: bus.run(runId).taskId, runId, body: 'note' });
  assert.equal(outcome.delivered, true);
  assert.equal(sent.length, 1);
  await bus.cancel(runId);
  await assert.rejects(pending);
  assert.equal(state.messagesForTask(bus.run(runId).taskId).length, 1);
});

test('transcript preserves task/message/result ordering', async () => {
  const { state, registry, bus } = newHarness();
  registry.register('eta', okAdapter);
  const run = await bus.dispatch({ recipient: 'eta', body: 'x' });
  try {
    await bus.send({ from: 'pm', to: 'eta', taskId: run.taskId, runId: run.id, body: 'note' });
  } catch {
    // expected: one-shot completion means no live session
  }
  const events = state.transcriptForTask(run.taskId).map((entry) => entry.event);
  assert.deepEqual(events, [
    'task.created',
    'task.dispatched',
    'agent.started',
    'result.created',
    'agent.completed',
    'message.created',
  ]);
});

test('agent names are arbitrary; registry and bus have no provider special cases', async () => {
  const { registry, bus } = newHarness();
  for (const name of ['waldo', 'frank', 'nine-nine']) {
    registry.register(name, okAdapter);
  }
  assert.deepEqual(registry.list(), ['frank', 'nine-nine', 'waldo']);
  const run = await bus.dispatch({ recipient: 'waldo', body: 'anything' });
  assert.equal(run.agent, 'waldo');
  assert.equal(bus.result(run.id).output, 'fake output');
});

test('UNSUPPORTED send marker never fabricates success', async () => {
  const { registry, bus } = newHarness();
  registry.register('iota', {
    start: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    send: async () => UNSUPPORTED,
    cancel: async () => {},
    dispose: async () => {},
  });
  let runId;
  bus.events.once('agent.started', (payload) => { runId = payload.runId; });
  const pending = bus.dispatch({ recipient: 'iota', body: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    bus.send({ from: 'pm', to: 'iota', taskId: bus.run(runId).taskId, runId, body: 'note' }),
    UnsupportedCapabilityError,
  );
  await bus.cancel(runId);
  await assert.rejects(pending);
});

test('handoff path: adapter handoff reaches ResultEnvelope.handoff exactly', async () => {
  const { registry, bus } = newHarness();
  const handoff = { summary: 'done', nextContext: { step: 2 }, recommendations: ['a', 'b'] };
  registry.register('kappa', {
    start: async () => ({ output: 'final text', stopReason: 'completed', handoff }),
    dispose: async () => {},
  });
  const run = await bus.dispatch({ recipient: 'kappa', body: 'x' });
  assert.deepEqual(bus.result(run.id).handoff, handoff);
});

test('handoff path: absent handoff normalizes to null', async () => {
  const { registry, bus } = newHarness();
  registry.register('lambda', okAdapter);
  const run = await bus.dispatch({ recipient: 'lambda', body: 'x' });
  assert.equal(bus.result(run.id).handoff, null);
});

test('handoff path: malformed handoff is rejected by envelope validation', async () => {
  const { registry, bus } = newHarness();
  for (const bad of ['a string', ['an', 'array'], new Date(), 42]) {
    const start = async () => ({ output: 'x', stopReason: 'completed', handoff: bad });
    registry.register(`mu-${typeof bad}-${JSON.stringify(bad)}`, { start, dispose: async () => {} });
  }
  for (const name of registry.list()) {
    await assert.rejects(bus.dispatch({ recipient: name, body: 'x' }), InvalidEnvelopeError);
  }
});

test('handoff path: task/run/agent correlation is preserved with a handoff', async () => {
  const { registry, bus } = newHarness();
  registry.register('nu', {
    start: async () => ({ output: 'x', stopReason: 'completed', handoff: { ok: true } }),
    dispose: async () => {},
  });
  const run = await bus.dispatch({ recipient: 'nu', body: 'x' });
  const result = bus.result(run.id);
  assert.equal(result.taskId, run.taskId);
  assert.equal(result.runId, run.id);
  assert.equal(result.agent, 'nu');
  assert.equal(result.output, 'x');
});

test('unknown backend: validate-before-persist leaves no task record and emits no task.created', async () => {
  const { state, bus } = newHarness();
  const events = [];
  bus.events.all((event) => events.push(event));
  await assert.rejects(bus.dispatch({ recipient: 'ghost', body: 'x' }), AgentNotRegisteredError);
  assert.equal(state.taskCount, 0);
  assert.equal(state.runCount, 0);
  assert.ok(!events.includes('task.created'));
});
