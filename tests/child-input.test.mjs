import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildInput } from '../src/bus/child-input.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { InvalidEnvelopeError } from '../src/bus/errors.mjs';

function newHarness() {
  const events = new EventBus();
  const state = new StateStore();
  const registry = new AgentRegistry();
  const bus = new AgentBus({ registry, events, state });
  return { events, state, registry, bus };
}

test('context path: TaskEnvelope with non-empty context preserves it through dispatch', async () => {
  const { state, registry, bus } = newHarness();
  let received;
  registry.register('alpha', {
    start: async ({ task }) => {
      received = task;
      return { output: 'ok', stopReason: 'completed' };
    },
    dispose: async () => {},
  });
  const context = { topic: 'determinism', depth: { level: 1, tags: ['a', 'b'] } };
  await bus.dispatch({ recipient: 'alpha', body: 'analyze', context, expectedOutput: 'a report' });
  assert.deepEqual(received.context, context);
  assert.equal(received.body, 'analyze');
  assert.equal(received.expectedOutput, 'a report');
  assert.deepEqual(state.getTask(received.id).context, context);
});

test('canonical child input: includes task body verbatim', () => {
  const text = buildChildInput({ body: 'Summarize the trade-offs.', context: {}, expectedOutput: null });
  assert.match(text, /^TASK\nSummarize the trade-offs\./);
});

test('canonical child input: includes nested structured context as indented JSON', () => {
  const context = { debate: { rounds: 2, participants: ['codex', 'claude'] }, verdict: null };
  const text = buildChildInput({ body: 'x', context, expectedOutput: null });
  assert.match(text, /\nCONTEXT\n\{/);
  assert.ok(text.includes('"participants"'));
  assert.ok(text.includes('"rounds"'));
  assert.ok(text.includes('  '));
});

test('canonical child input: includes expectedOutput when provided', () => {
  const text = buildChildInput({ body: 'x', context: {}, expectedOutput: 'Return a one-line verdict' });
  assert.match(text, /\nEXPECTED OUTPUT\nReturn a one-line verdict$/);
});

test('canonical child input: empty context stays compact with an explicit marker', () => {
  const text = buildChildInput({ body: 'x', context: {} });
  assert.match(text, /\nCONTEXT\n<empty>\n/);
  assert.doesNotMatch(text, /\{/);
});

test('canonical child input: absent expectedOutput uses the explicit unspecified marker', () => {
  const text = buildChildInput({ body: 'x', context: {} });
  assert.match(text, /\nEXPECTED OUTPUT\n<unspecified>$/);
});

test('canonical child input: equivalent context objects serialize deterministically', () => {
  const a = { b: { d: 1, c: 2 }, a: 1 };
  const b = { a: 1, b: { c: 2, d: 1 } };
  assert.equal(buildChildInput({ body: 'x', context: a }), buildChildInput({ body: 'x', context: b }));
});

test('canonical child input: rejects non-serializable context values clearly', () => {
  assert.throws(() => buildChildInput({ body: 'x', context: { fn: () => {} } }), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({ body: 'x', context: { sym: Symbol('s') } }), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({ body: 'x', context: { big: 10n } }), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({ body: 'x', context: { n: NaN } }), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({ body: 'x', context: { nested: { bad: undefined } } }), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({ body: 'x', context: { when: new Date() } }), InvalidEnvelopeError);
  const circular = {};
  circular.self = circular;
  assert.throws(() => buildChildInput({ body: 'x', context: circular }), InvalidEnvelopeError);
});

test('canonical child input: rejects a malformed task envelope', () => {
  assert.throws(() => buildChildInput(null), InvalidEnvelopeError);
  assert.throws(() => buildChildInput({}), InvalidEnvelopeError);
});
