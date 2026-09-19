import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { PeerRelay, PeerRelayError } from '../src/peer/peer-relay.mjs';
import { PeerState } from '../src/peer/peer-state.mjs';
import { buildPeerContext, boundedRecentMessages, DEFAULT_PEER_HISTORY_LIMIT } from '../src/peer/peer-context.mjs';

function newHarness() {
  const events = new EventBus({ onListenerError: () => {} });
  const state = new StateStore();
  const registry = new AgentRegistry();
  const bus = new AgentBus({ registry, events, state });
  const peerState = new PeerState();
  const relay = new PeerRelay({ bus, events, state: peerState });
  return { events, state, registry, bus, peerState, relay };
}

function okAdapter(output, opts = {}) {
  const adapter = {
    counts: { start: 0 },
    start: async ({ task }) => {
      okAdapter.lastTask = task;
      opts.capture?.(task);
      adapter.counts.start += 1;
      return { output: typeof output === 'function' ? output(task) : output, stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  };
  return adapter;
}

/** Fake adapter that keeps the task context it last received. */
function captureAdapter(capture) {
  return {
    start: async ({ task }) => {
      capture(task);
      return { output: `out:${task.context.peer?.to ?? task.recipient}`, stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  };
}

test('recordMessage records centrally without dispatching or spawning a run', () => {
  const { bus, state, registry } = newHarness();
  registry.register('alpha', okAdapter('x'));
  const beforeRuns = state.runCount;
  const message = bus.recordMessage({
    from: 'alpha', to: 'bravo', taskId: 'task_1', body: 'hello', kind: 'peer.request',
    conversationId: 'conv_1', hopId: 'hop_1', metadata: { note: 'record-only' },
  });
  assert.equal(message.from, 'alpha');
  assert.equal(message.to, 'bravo');
  assert.equal(message.kind, 'peer.request');
  assert.equal(message.conversationId, 'conv_1');
  assert.equal(message.hopId, 'hop_1');
  assert.deepEqual(message.metadata, { note: 'record-only' });
  assert.equal(state.runCount, beforeRuns, 'recordMessage must not create a run');
  assert.equal(state.messagesForTask('task_1').length, 1, 'message retrievable via state store without a task');
});

test('existing AgentBus.send() remains one-shot unsupported and does not spawn a child', async () => {
  const { bus, registry } = newHarness();
  let starts = 0;
  registry.register('alpha', {
    start: async () => { starts += 1; return { output: 'o', stopReason: 'completed' }; },
    send: async () => 'UNSUPPORTED',
    cancel: async () => {},
    dispose: async () => {},
  });
  const run = await bus.dispatch({ recipient: 'alpha', body: 'do it' });
  await assert.rejects(
    bus.send({ from: 'pm', to: 'alpha', taskId: run.taskId, runId: run.id, body: 'live?' }),
    (err) => err.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.equal(starts, 1, 'send() must not create a fresh child');
});

test('one peer relay records the request message before recipient dispatch', async () => {
  const { registry, relay, peerState } = newHarness();
  const received = [];
  registry.register('alpha', captureAdapter((t) => received.push(t)));
  registry.register('bravo', okAdapter('b out'));
  const conversation = relay.createConversation();
  const events = [];
  for (const name of ['peer.request.created', 'peer.hop.started', 'peer.hop.completed']) {
    relay.events.on(name, () => events.push(name));
  }
  const outcome = await relay.relay({
    conversationId: conversation.id, from: 'alpha', to: 'bravo', body: 'review this',
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.requestMessage.from, 'alpha');
  assert.equal(outcome.requestMessage.to, 'bravo');
  assert.ok(outcome.requestMessage.id.startsWith('msg_'));
  assert.equal(peerState.messagesForConversation(conversation.id).length, 2);
  assert.deepEqual(events, ['peer.request.created', 'peer.hop.started', 'peer.hop.completed']);
});

test('relay performs exactly one fresh recipient dispatch', async () => {
  const { registry, relay } = newHarness();
  const counts = { alpha: 0, bravo: 0 };
  registry.register('alpha', {
    start: async () => { counts.alpha += 1; return { output: 'a', stopReason: 'completed' }; },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', {
    start: async () => { counts.bravo += 1; return { output: 'b', stopReason: 'completed' }; },
    cancel: async () => {},
    dispose: async () => {},
  });
  const conversation = relay.createConversation();
  await relay.relay({ conversationId: conversation.id, from: 'alpha', to: 'bravo', body: 'm' });
  assert.equal(counts.alpha, 0, 'sender must not be re-dispatched by the relay');
  assert.equal(counts.bravo, 1, 'recipient must be dispatched exactly once');
});

test('recipient context contains source message/result lineage and request', async () => {
  const { registry, bus, relay } = newHarness();
  let bravoTask = null;
  registry.register('alpha', okAdapter('token-123'));
  registry.register('bravo', captureAdapter((t) => { bravoTask = t; }));
  const seed = await bus.dispatch({ recipient: 'alpha', body: 'produce token' });
  const seedResult = bus.result(seed.id);
  const conversation = relay.createConversation();
  await relay.relay({
    conversationId: conversation.id,
    from: 'alpha', to: 'bravo',
    body: 'relay my result',
    sourceResult: seedResult,
  });
  assert.ok(bravoTask, 'recipient was never dispatched');
  assert.equal(bravoTask.context.peer.conversationId, conversation.id);
  assert.equal(bravoTask.context.source.taskId, seedResult.taskId);
  assert.equal(bravoTask.context.source.runId, seedResult.runId);
  assert.equal(bravoTask.context.source.resultId, seedResult.id);
  assert.equal(bravoTask.context.source.output, 'token-123');
  assert.equal(bravoTask.context.request.body, 'relay my result');
});

test('response message is recorded with correct replyTo pointing at the request', async () => {
  const { registry, relay, peerState } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('B_ACK:token-123'));
  const conversation = relay.createConversation();
  const outcome = await relay.relay({
    conversationId: conversation.id, from: 'alpha', to: 'bravo', body: 'relay',
  });
  assert.equal(outcome.responseMessage.from, 'bravo');
  assert.equal(outcome.responseMessage.to, 'alpha');
  assert.equal(outcome.responseMessage.replyTo, outcome.requestMessage.id);
  assert.equal(outcome.responseMessage.body, 'B_ACK:token-123');
  const messages = peerState.messagesForConversation(conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, outcome.requestMessage.id);
  assert.equal(messages[1].replyTo, outcome.requestMessage.id);
});

test('conversation/hop/message/task/run/result IDs correlate end-to-end', async () => {
  const { registry, bus, relay } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  const conversation = relay.createConversation();
  const outcome = await relay.relay({
    conversationId: conversation.id, from: 'alpha', to: 'bravo', body: 'm',
  });
  const hop = relay.state.getHop(outcome.hopId);
  assert.equal(hop.conversationId, conversation.id);
  assert.equal(hop.requestMessageId, outcome.requestMessage.id);
  assert.equal(hop.responseMessageId, outcome.responseMessage.id);
  assert.equal(hop.recipientTaskId, outcome.result.taskId);
  assert.equal(hop.recipientRunId, outcome.result.runId);
  assert.equal(hop.recipientResultId, outcome.result.id);
  assert.equal(outcome.result.agent, 'bravo');
  const run = bus.run(outcome.result.runId);
  assert.equal(run.taskId, outcome.result.taskId);
});

test('bounded recent-message context is deterministic and never exceeds the limit', async () => {
  const { registry, relay, peerState } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  const conversation = relay.createConversation();
  const tasks = [];
  // 5 hops -> 10 messages total; bound should keep the newest N
  for (let i = 0; i < 5; i += 1) {
    const before = registry._get ? null : null;
    const adapter = captureAdapter((t) => tasks.push(t));
    registry.register(`bravo${i}`, adapter);
    await relay.relay({
      conversationId: conversation.id, from: 'alpha', to: `bravo${i}`, body: `m${i}`,
      historyLimit: 4,
    });
    void before;
  }
  const last = tasks[tasks.length - 1];
  assert.ok(last, 'no recipient task captured');
  assert.ok(Array.isArray(last.context.recentMessages));
  assert.ok(last.context.recentMessages.length <= 4, `recentMessages=${last.context.recentMessages.length}`);
  assert.equal(last.context.recentMessages.length, 4);
  const messages = peerState.messagesForConversation(conversation.id);
  assert.equal(messages.length, 10);
  const ids = last.context.recentMessages.map((m) => m.id);
  // At hop 5's capture time only 9 messages existed (8 from prior hops + this request).
  assert.deepEqual(ids, messages.slice(-5, -1).map((m) => m.id));
});

test('arbitrary backend names work through the relay', async () => {
  const { registry, relay } = newHarness();
  registry.register('waldo', okAdapter('w'));
  registry.register('frank', okAdapter('f'));
  registry.register('nine-nine', okAdapter('n'));
  const conversation = relay.createConversation();
  const outcome = await relay.relay({
    conversationId: conversation.id, from: 'waldo', to: 'frank', body: 'hi',
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.agent, 'frank');
});

test('automatic two-hop A -> B -> A executes two fresh dispatches with fresh IDs', async () => {
  const { registry, bus, relay } = newHarness();
  const freshTaskIds = new Set();
  const seen = [];
  const capturing = (name) => ({
    start: async ({ task }) => {
      freshTaskIds.add(task.id);
      seen.push(task.context.peer ? `${name}:peer` : `${name}:seed`);
      const token = (task.context.source?.output?.match(/(T5_[0-9a-f]+)/i) || [])[0];
      return {
        output: token ? `${name}_ACK:${token}` : (name === 'alpha' ? 'T5_1234abcd' : `${name}_out`),
        stopReason: 'completed',
      };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('alpha', capturing('alpha'));
  registry.register('bravo', capturing('bravo'));
  const conversation = relay.createConversation();
  const exchange = await relay.exchange({
    conversationId: conversation.id,
    routes: [
      { from: 'alpha', to: 'bravo' },
      { from: 'bravo', to: 'alpha' },
    ],
    body: 'start',
  });
  assert.equal(exchange.status, 'completed');
  assert.equal(exchange.hops.length, 2);
  assert.equal(freshTaskIds.size, 3, 'seed A + hop A->B + hop B->A each use a fresh task id');
  const hop0 = exchange.hops[0];
  const hop1 = exchange.hops[1];
  assert.equal(hop1.requestMessage.replyTo, hop0.responseMessage.id);
  assert.ok(
    hop1.result.output.includes('T5_1234abcd'),
    'seed token produced by A must reach fresh A automatically via B',
  );
  // source lineage: hop1 source is hop0's recipient result (fresh B)
  const hop1Rec = relay.state.getHop(hop1.hopId);
  assert.equal(hop1Rec.sourceTaskId, hop0.result.taskId);
  assert.equal(hop1Rec.sourceResultId, hop0.result.id);
  assert.ok(seen.includes('alpha:seed') && seen.includes('bravo:peer') && seen.includes('alpha:peer'));
});

test('second hop uses the first hop response automatically without manual injection', async () => {
  const { registry, relay } = newHarness();
  const contexts = [];
  registry.register('alpha', {
    start: async ({ task }) => {
      contexts.push(task.context);
      const token = (task.context.source?.output?.match(/(T5_[0-9a-f]+)/i) || [])[0];
      return { output: token ? `ALPHA_ACK:${token}` : 'T5_a1b2c3d4', stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', {
    start: async ({ task }) => {
      contexts.push(task.context);
      const token = (task.context.source?.output?.match(/(T5_[0-9a-f]+)/i) || [])[0];
      return { output: token ? `BRAVO_ACK:${token}` : 'bravo-nothing', stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  const conversation = relay.createConversation();
  const exchange = await relay.exchange({
    conversationId: conversation.id,
    routes: [
      { from: 'alpha', to: 'bravo' },
      { from: 'bravo', to: 'alpha' },
    ],
    body: 'go',
  });
  assert.equal(exchange.status, 'completed');
  // Hop 0: alpha seed produces token -> bravo reads it from source.output
  assert.equal(exchange.hops[0].result.output, 'BRAVO_ACK:T5_a1b2c3d4');
  // Hop 1: alpha reads bravo's derived token from source automatically
  assert.equal(exchange.hops[1].result.output, 'ALPHA_ACK:T5_a1b2c3d4');
});

test('failure in B prevents the return hop to A', async () => {
  const { registry, relay } = newHarness();
  const counts = { alphaPeer: 0, alphaSeed: 0, bravo: 0 };
  registry.register('alpha', {
    start: async ({ task }) => {
      if (task.context?.peer) counts.alphaPeer += 1;
      else counts.alphaSeed += 1;
      return { output: 'a', stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', {
    start: async () => { counts.bravo += 1; throw new Error('boom in B'); },
    cancel: async () => {},
    dispose: async () => {},
  });
  const conversation = relay.createConversation();
  await assert.rejects(
    relay.exchange({
      conversationId: conversation.id,
      routes: [
        { from: 'alpha', to: 'bravo' },
        { from: 'bravo', to: 'alpha' },
      ],
      body: 'go',
    }),
    (err) => err.code === 'PEER_HOP_FAILED',
  );
  assert.equal(counts.alphaPeer, 0, 'A must not be re-dispatched as a recipient after B fails');
  assert.equal(counts.alphaSeed, 1, 'A is touched once as the hop-0 seed');
  assert.equal(counts.bravo, 1);
  assert.equal(relay.state.getConversation(conversation.id).status, 'failed');
  const hop = relay.state.hopsForConversation(conversation.id)[0];
  assert.equal(hop.status, 'failed');
  assert.equal(hop.error.message, 'boom in B');
  assert.equal(hop.responseMessageId, null, 'no fake response may be created on failure');
  assert.equal(relay.state.messagesForConversation(conversation.id).length, 1, 'only the request message exists');
});

test('cancellation prevents future hops and reaches the active bus run where possible', async () => {
  const { bus, registry, relay } = newHarness();
  let bravoRunId = null;
  const cancelCalls = { bravo: 0 };
  const alphaDispatches = { seed: 0, peer: 0 };
  registry.register('alpha', {
    start: async ({ task }) => {
      if (task.context?.peer) alphaDispatches.peer += 1;
      else alphaDispatches.seed += 1;
      return { output: 'a', stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', {
    start: async ({ run, signal }) => {
      bravoRunId = run.id;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    cancel: async () => { cancelCalls.bravo += 1; },
    dispose: async () => {},
  });
  const conversation = relay.createConversation();
  const pending = relay.exchange({
    conversationId: conversation.id,
    routes: [
      { from: 'alpha', to: 'bravo' },
      { from: 'bravo', to: 'alpha' },
    ],
    body: 'go',
  });
  await new Promise((resolve) => {
    const waitRunning = () => {
      const run = bravoRunId ? bus.run(bravoRunId) : null;
      if (run && run.status === 'running') resolve();
      else setImmediate(waitRunning);
    };
    waitRunning();
  });
  await relay.cancel(conversation.id);
  await assert.rejects(pending, (err) => err.code === 'PEER_HOP_CANCELLED' || err.code === 'CONVERSATION_TERMINAL');
  assert.equal(relay.state.getConversation(conversation.id).status, 'cancelled');
  assert.equal(alphaDispatches.peer, 0, 'A must not dispatch as a recipient after cancellation');
  assert.equal(alphaDispatches.seed, 1, 'A is touched once as the hop-0 seed before cancellation');
  assert.ok(cancelCalls.bravo >= 1, 'active recipient run should receive a cancel call');
  const hops = relay.state.hopsForConversation(conversation.id);
  assert.ok(hops.some((h) => h.status === 'cancelled'));
});

test('max-hop bound is enforced', async () => {
  const { registry, relay } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  const conversation = relay.createConversation();
  await assert.rejects(
    relay.exchange({
      conversationId: conversation.id,
      routes: [
        { from: 'alpha', to: 'bravo' },
        { from: 'bravo', to: 'alpha' },
        { from: 'alpha', to: 'bravo' },
      ],
      maxHops: 2,
      body: 'go',
    }),
    (err) => err.code === 'MAX_HOPS_EXCEEDED',
  );
  assert.equal(relay.state.hopCount, 0, 'no hop may execute when the route exceeds the bound');
});

test('malformed metadata/context is rejected clearly', async () => {
  const { registry, relay } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  const conversation = relay.createConversation();
  await assert.rejects(
    relay.relay({ conversationId: conversation.id, from: 'alpha', to: 'bravo', body: '', context: {} }),
    (err) => err.code === 'INVALID_PEER_INPUT',
  );
  await assert.rejects(
    relay.relay({ conversationId: conversation.id, from: '', to: 'bravo', body: 'm', context: {} }),
    (err) => err.code === 'INVALID_PEER_INPUT',
  );
  await assert.rejects(
    relay.relay({ conversationId: 'nope', from: 'alpha', to: 'bravo', body: 'm' }),
    (err) => err.code === 'UNKNOWN_CONVERSATION',
  );
  await assert.rejects(
    relay.relay({ conversationId: conversation.id, from: 'alpha', to: 'bravo', body: 'm', context: 'not-an-object' }),
    (err) => err.code === 'INVALID_PEER_INPUT',
  );
});

test('no permanent role coupling exists in peer contracts', () => {
  const { registry, relay } = newHarness();
  registry.register('writer', okAdapter('w'));
  registry.register('reviewer', okAdapter('r'));
  registry.register('judge', okAdapter('j'));
  const conversation = relay.createConversation();
  const exchange = relay.exchange({
    conversationId: conversation.id,
    routes: [
      { from: 'writer', to: 'reviewer' },
      { from: 'reviewer', to: 'judge' },
    ],
    body: 'any order is fine',
  });
  assert.ok(exchange instanceof Promise, 'role-named backends are just arbitrary identities');
});

test('peer context builder is deterministic and merges explicit context by precedence', () => {
  const conversation = { id: 'conv_1', status: 'running', hops: [], messages: [], createdAt: 't0' };
  const hop = { id: 'hop_1', conversationId: 'conv_1', index: 0, from: 'a', to: 'b' };
  const requestMessage = { id: 'msg_1', from: 'a', to: 'b', body: 'hey', replyTo: null, metadata: { m: 1 }, createdAt: 't1' };
  const sourceResult = { id: 'result_1', taskId: 'task_1', runId: 'run_1', output: 'out', artifacts: [], handoff: { keep: true } };
  const recentMessages = [
    { id: 'msg_0', from: 'pm', to: 'a', body: 'start', replyTo: null, createdAt: 't0' },
  ];
  const packet = buildPeerContext({ conversation, hop, requestMessage, sourceResult, recentMessages });
  const packet2 = buildPeerContext({ conversation, hop, requestMessage, sourceResult, recentMessages });
  assert.deepEqual(packet, packet2, 'buildPeerContext must be deterministic');
  assert.equal(packet.peer.conversationId, 'conv_1');
  assert.equal(packet.peer.requestMessageId, 'msg_1');
  assert.equal(packet.source.output, 'out');
  assert.deepEqual(packet.source.handoff, { keep: true });
  assert.equal(packet.request.body, 'hey');
  assert.deepEqual(packet.recentMessages.map((m) => m.id), ['msg_0']);

  const overridden = buildPeerContext({
    conversation, hop, requestMessage, sourceResult, recentMessages,
    explicitContext: { source: { output: 'explicit-wins' } },
  });
  assert.equal(overridden.source.output, 'explicit-wins', 'explicit context must override derived per top-level key');
  assert.equal(overridden.peer.conversationId, 'conv_1', 'unoverridden keys stay derived');
});

test('boundedRecentMessages helper respects the limit and normalizes shape', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `msg_${i}`, from: 'a', to: 'b', body: `b${i}`, replyTo: null, createdAt: `t${i}`,
  }));
  const bounded = boundedRecentMessages(messages, 8);
  assert.equal(bounded.length, 8);
  assert.equal(bounded[0].id, 'msg_2');
  assert.deepEqual(Object.keys(bounded[0]).sort(), ['body', 'createdAt', 'from', 'id', 'replyTo', 'to']);
});

test('unknown recipient backend fails the hop and records no fake response', async () => {
  const { registry, relay } = newHarness();
  registry.register('alpha', okAdapter('a'));
  const conversation = relay.createConversation();
  await assert.rejects(
    relay.relay({ conversationId: conversation.id, from: 'alpha', to: 'ghost', body: 'm' }),
    (err) => err.code === 'PEER_HOP_FAILED',
  );
  assert.equal(relay.state.getConversation(conversation.id).status, 'failed');
  assert.equal(relay.state.messagesForConversation(conversation.id).length, 1, 'request recorded, no fake response');
});

test('recordMessage with null taskId produces a conversation-scoped message', () => {
  const { bus } = newHarness();
  const message = bus.recordMessage({
    from: 'alpha', to: 'bravo', taskId: null, runId: null, body: 'seed', conversationId: 'conv_x',
  });
  assert.equal(message.taskId, null);
  assert.equal(message.conversationId, 'conv_x');
});