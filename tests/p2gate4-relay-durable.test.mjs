import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PeerRepository } from '../src/persistence/repositories/peer-repository.mjs';
import { DurablePeerState } from '../src/peer/durable-peer-state.mjs';
import { PeerRelay } from '../src/peer/peer-relay.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';

test('A. durable PeerRelay: one exchange uses atomic prepare + completes conversation/hops/messages/transcript', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-relay-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const repo = new PeerRepository({ store });
  const state = new DurablePeerState({ repository: repo });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const registry = new AgentRegistry();
  const active = [];
  const adapter = {
    start: async (input) => {
      active.push(input.envelope);
      return { output: 'response from recipient', stopReason: 'completed' };
    },
    dispose: async () => {},
  };
  registry.register('alpha', adapter);
  registry.register('beta', adapter);
  const bus = new AgentBus({ registry, events: new EventBus(), state: new StateStore({}) });
  const relay = new PeerRelay({ bus, state });

  assert.equal(relay.hasAtomicHopPrepare, true);
  const conversation = state.createConversation({});
  const outcome = await relay.exchange({
    conversationId: conversation.id,
    routes: [{ from: 'alpha', to: 'beta' }],
    body: 'request body',
  });

  // one seed dispatch (to the route's from) + one relay dispatch (to the route's
  // to); both completed; no replay/resume happened
  assert.equal(active.length, 2);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.finalHop?.status, 'completed');

  // conversation + the hop terminal and coherent after reopen
  const reopened = new DurablePeerState({ repository: new PeerRepository({ store }) });
  const after = reopened.getConversation(conversation.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.hops.length, 1);
  const hops = reopened.hopsForConversation(conversation.id);
  assert.equal(hops[0].status, 'completed');
  assert.equal(hops[0].requestMessageId, outcome.finalHop.requestMessage.id);
  assert.equal(hops[0].responseMessageId, outcome.finalHop.responseMessage.id);

  // messages committed in peer conversation store, in order, under the same
  // ids the relay returned (central AgentBus record shares those ids)
  const messages = reopened.messagesForConversation(conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, outcome.finalHop.requestMessage.id);
  assert.equal(messages[1].id, outcome.finalHop.responseMessage.id);
  assert.deepEqual(messages[0], outcome.finalHop.requestMessage);
  assert.deepEqual(messages[1], outcome.finalHop.responseMessage);

  // transcript ordering preserved
  assert.deepEqual(
    reopened.transcriptForConversation(conversation.id).map((entry) => entry.event),
    [
      'conversation.started',
      'peer.request.created',
      'peer.hop.started',
      'peer.response.created',
      'peer.hop.completed',
      'conversation.completed',
    ],
  );

  // zero automatic resume/replay/adapter calls from reopen
  assert.equal(active.length, 2);
});