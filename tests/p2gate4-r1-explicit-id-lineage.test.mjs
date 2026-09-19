import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PeerRepository } from '../src/persistence/repositories/peer-repository.mjs';
import { DurableStateStore } from '../src/bus/durable-state-store.mjs';
import { DurablePeerState } from '../src/peer/durable-peer-state.mjs';
import { PeerRelay } from '../src/peer/peer-relay.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { BusError } from '../src/bus/errors.mjs';
import { createMessageEnvelope } from '../src/bus/envelopes.mjs';

function openDurable(t, { subdir = 'db' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-r1-'));
  const store = new SqlitePersistenceStore();
  const opener = store.open({ path: join(dir, subdir) }).then(() => store.migrate());
  const dbPath = join(dir, subdir);
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { open: async () => { await opener; return dbPath; }, dir, store };
}

async function makeDurableBus(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-r1-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const repository = new AgentBusRepository({ store });
  const state = new DurableStateStore({ repository });
  const registry = new AgentRegistry();
  const adapter = {
    start: async (input) => ({ output: 'response from recipient', stopReason: 'completed' }),
    dispose: async () => {},
  };
  registry.register('alpha', adapter);
  registry.register('beta', adapter);
  const bus = new AgentBus({ registry, events: new EventBus(), state });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bus, store, state, repository, dir };
}

async function seedDurableTask(state, taskId) {
  state.createTask({
    id: taskId,
    sender: 'pm',
    recipient: 'alpha',
    body: 'seed task',
    status: 'created',
    createdAt: new Date().toISOString(),
  });
}

test('R1-A. recordMessage preserves an explicit id exactly (legacy + durable bus)', async (t) => {
  const legacy = new AgentBus({
    registry: new AgentRegistry(),
    events: new EventBus(),
    state: new StateStore({}),
  });
  const explicitLegacy = legacy.recordMessage({
    id: 'msg_exp_legacy',
    from: 'alpha',
    to: 'beta',
    taskId: 'task_exp_legacy',
    body: 'explicit id request',
  });
  assert.equal(explicitLegacy.id, 'msg_exp_legacy');

  const { bus, state } = await makeDurableBus(t);
  await seedDurableTask(state, 'task_exp_durable');
  const explicit = bus.recordMessage({
    id: 'msg_exp_durable',
    from: 'alpha',
    to: 'beta',
    taskId: 'task_exp_durable',
    body: 'explicit id request',
  });
  assert.equal(explicit.id, 'msg_exp_durable');
  const rehydrated = bus.messagesForTask('task_exp_durable');
  assert.equal(rehydrated.length, 1);
  assert.equal(rehydrated[0].id, 'msg_exp_durable', 'durable rehydration keeps the explicit id');
});

test('R1-B. omitting id still generates a normal fresh id (legacy unchanged)', async (t) => {
  const legacy = new AgentBus({
    registry: new AgentRegistry(),
    events: new EventBus(),
    state: new StateStore({}),
  });
  const first = legacy.recordMessage({ from: 'alpha', to: 'beta', taskId: 'task_gen_1', body: 'a' });
  const second = legacy.recordMessage({ from: 'alpha', to: 'beta', taskId: 'task_gen_2', body: 'b' });
  assert.match(first.id, /^msg_/);
  assert.match(second.id, /^msg_/);
  assert.notEqual(first.id, second.id);

  const { bus, state } = await makeDurableBus(t);
  await seedDurableTask(state, 'task_gen_d1');
  await seedDurableTask(state, 'task_gen_d2');
  const d1 = bus.recordMessage({ from: 'alpha', to: 'beta', taskId: 'task_gen_d1', body: 'a' });
  const d2 = bus.recordMessage({ from: 'alpha', to: 'beta', taskId: 'task_gen_d2', body: 'b' });
  assert.match(d1.id, /^msg_/);
  assert.match(d2.id, /^msg_/);
  assert.notEqual(d1.id, d2.id);
  assert.equal(d1.id.slice(0, 4), 'msg_');
});

test('R1-C+D. durable relay: request id === peer message id === hop.requestMessageId === central bus id; response.replyTo === central request id', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-r1-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const peerRepo = new PeerRepository({ store });
  const busRepo = new AgentBusRepository({ store });
  const peerState = new DurablePeerState({ repository: peerRepo });
  const busState = new DurableStateStore({ repository: busRepo });
  const registry = new AgentRegistry();
  const adapter = {
    start: async (input) => ({ output: 'response from recipient', stopReason: 'completed' }),
    dispose: async () => {},
  };
  registry.register('alpha', adapter);
  registry.register('beta', adapter);
  const bus = new AgentBus({ registry, events: new EventBus(), state: busState });
  const relay = new PeerRelay({ bus, state: peerState });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const conversation = peerState.createConversation({});
  const outcome = await relay.exchange({
    conversationId: conversation.id,
    routes: [{ from: 'alpha', to: 'beta' }],
    body: 'request body',
  });

  const requestMessage = outcome.finalHop.requestMessage;
  const responseMessage = outcome.finalHop.responseMessage;
  const hop = peerState.getHop(outcome.finalHop.hopId);

  // R1-C: stable id is the single lineage anchor everywhere
  assert.equal(requestMessage.id, hop.requestMessageId, 'relay request id === hop.requestMessageId');
  assert.equal(requestMessage.id, peerState.messagesForConversation(conversation.id)[0].id, 'relay request id === persisted peer message id');

  // task-scoped central lineages exist for the request
  const central = bus.messagesForTask(requestMessage.taskId);
  assert.ok(central.some((message) => message.id === requestMessage.id), 'central bus contains the request under the SAME id');
  assert.equal(central.find((message) => message.id === requestMessage.id).id, requestMessage.id, 'central request id === durable request id');
  assert.ok(central.length >= 1, 'task-scoped lineage exists');

  // R1-D: response replyTo points at the CENTRALLY recorded request id
  assert.equal(responseMessage.replyTo, requestMessage.id, 'response.replyTo === central request id');
  assert.ok(bus.messagesForTask(requestMessage.taskId).some((message) => message.id === requestMessage.id), 'replyTo id exists in central lineage');
});

test('R1-E. reopen preserves the same explicit ids (peer message, hop, central bus)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-r1-'));
  const dbPath = join(dir, 'store.db');

  let store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  await store.migrate();
  const peerRepo = new PeerRepository({ store });
  const busRepo = new AgentBusRepository({ store });
  const peerState = new DurablePeerState({ repository: peerRepo });
  const busState = new DurableStateStore({ repository: busRepo });
  const registry = new AgentRegistry();
  const adapter = {
    start: async (input) => ({ output: 'response from recipient', stopReason: 'completed' }),
    dispose: async () => {},
  };
  registry.register('alpha', adapter);
  registry.register('beta', adapter);
  const bus = new AgentBus({ registry, events: new EventBus(), state: busState });
  const relay = new PeerRelay({ bus, state: peerState });

  const conversation = peerState.createConversation({});
  const outcome = await relay.exchange({
    conversationId: conversation.id,
    routes: [{ from: 'alpha', to: 'beta' }],
    body: 'reopen request body',
  });
  const requestId = outcome.finalHop.requestMessage.id;
  const hopId = outcome.finalHop.hopId;
  const requestTaskId = outcome.finalHop.requestMessage.taskId;

  await store.close();

  // reopen with fresh objects only (same DB file)
  store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  const reopenedPeerState = new DurablePeerState({ repository: new PeerRepository({ store }) });
  const reopenedBusState = new DurableStateStore({ repository: new AgentBusRepository({ store }) });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const reopenedConversation = reopenedPeerState.getConversation(conversation.id);
  assert.ok(reopenedConversation.hops.includes(hopId), 'reopened conversation references the same hop id');
  const reopenedHop = reopenedPeerState.hopsForConversation(conversation.id)[0];
  assert.equal(reopenedHop.id, hopId);
  assert.equal(reopenedHop.requestMessageId, requestId, 'reopened hop.requestMessageId unchanged');
  assert.equal(reopenedPeerState.messagesForConversation(conversation.id)[0].id, requestId, 'reopened peer message id unchanged');
  const reopenedCentral = reopenedBusState.messagesForTask(requestTaskId);
  assert.ok(reopenedCentral.some((message) => message.id === requestId), 'reopened central bus request id unchanged');
  const reopenedResponseReplyTo = reopenedPeerState.messagesForConversation(conversation.id)[1].replyTo;
  assert.equal(reopenedResponseReplyTo, requestId, 'reopened response.replyTo unchanged');
});

test('R1-F. duplicate explicit id on the durable bus fails deterministically (no renamed second message)', async (t) => {
  const { bus, state } = await makeDurableBus(t);
  await seedDurableTask(state, 'task_dup_explicit');
  const first = bus.recordMessage({
    id: 'msg_dup_explicit',
    from: 'alpha',
    to: 'beta',
    taskId: 'task_dup_explicit',
    body: 'first',
  });
  assert.equal(first.id, 'msg_dup_explicit');
  assert.throws(
    () => bus.recordMessage({
      id: 'msg_dup_explicit',
      from: 'alpha',
      to: 'beta',
      taskId: 'task_dup_explicit',
      body: 'second',
    }),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_MESSAGE',
    're-recording the same explicit id must fail deterministically',
  );
  // durable store still holds exactly one message under that id — no second,
  // differently-named copy was silently created
  const messages = bus.messagesForTask('task_dup_explicit');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'msg_dup_explicit');
});

test('R1-A2. createMessageEnvelope accepts an explicit id (peer relay pre-creation contract)', () => {
  const envelope = createMessageEnvelope({
    id: 'msg_relay_preseed',
    from: 'alpha',
    to: 'beta',
    body: 'pre-created request',
  });
  assert.equal(envelope.id, 'msg_relay_preseed');
  const generated = createMessageEnvelope({ from: 'alpha', to: 'beta', body: 'plain' });
  assert.match(generated.id, /^msg_/);
});
