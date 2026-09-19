import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PeerRepository } from '../src/persistence/repositories/peer-repository.mjs';
import { DurablePeerState } from '../src/peer/durable-peer-state.mjs';
import { PeerState } from '../src/peer/peer-state.mjs';
import { PeerRelay } from '../src/peer/peer-relay.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { createConversationRecord, createPeerHopRecord } from '../src/peer/peer-contracts.mjs';
import { createMessageEnvelope } from '../src/bus/envelopes.mjs';
import { PersistenceError } from '../src/persistence/persistence-errors.mjs';
import { BusError } from '../src/bus/errors.mjs';

async function openPeer(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-peer-'));
  const path = join(dir, 'store.db');
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  const repo = new PeerRepository({ store });
  const state = new DurablePeerState({ repository: repo });
  const handles = [
    { kind: 'store', value: store },
    { kind: 'dir', value: dir },
  ];
  t.after(async () => {
    for (const { kind, value } of handles) {
      if (kind === 'store') {
        try {
          await value.close();
        } catch {
          // best-effort close; never mask the test result
        }
      }
    }
    for (const { kind, value } of handles) {
      if (kind === 'dir') rmSync(value, { recursive: true, force: true });
    }
  });
  return { dir, path, store, repo, state, handles };
}

async function reopenPeer(t, opened) {
  const store = new SqlitePersistenceStore();
  await store.open({ path: opened.path });
  await store.migrate();
  opened.handles.push({ kind: 'store', value: store });
  const repo = new PeerRepository({ store });
  const state = new DurablePeerState({ repository: repo });
  return { store, repo, state };
}

function countingBus(calls) {
  return {
    dispatch: async () => {
      calls.push('dispatch');
      return { id: 'never', status: 'completed', result: { output: 'x', stopReason: 'completed' } };
    },
    recordMessage: (input) => {
      calls.push('recordMessage');
      return createMessageEnvelope(input);
    },
    events: new EventBus(),
  };
}

function sampleConversation() {
  return createConversationRecord({});
}

function sampleRequest(conversationId, hopId, source) {
  return createMessageEnvelope({
    from: 'alpha',
    to: 'beta',
    taskId: source?.sourceTaskId ?? null,
    runId: source?.sourceRunId ?? null,
    body: 'request body',
    replyTo: null,
    kind: 'message',
    conversationId,
    hopId,
  });
}

function durablePrepared(state, conversation, index, source = {}) {
  const current = state.getConversation(conversation.id);
  const hopId = `hop_parity_${index}`;
  const requestMessage = sampleRequest(conversation.id, hopId, source);
  return state.prepareHop({
    conversationId: conversation.id,
    conversationPatch: current.status === 'created' ? { status: 'running' } : null,
    hop: { id: hopId, index, from: 'alpha', to: 'beta', requestMessageId: requestMessage.id, ...source },
    requestMessage,
  });
}

// ---------------------------------------------------------------------------
// 8. parity
// ---------------------------------------------------------------------------
test('8. peer repository/state create and read parity with legacy PeerState', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const legacy = new PeerState();

  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  legacy.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  // first hop, running + lineage, via the atomic prepare on durable and the
  // legacy sequence on in-memory. Identical ids and the full field set are
  // written to both stores so the records can be compared for deep equivalence.
  if (!state.hasAtomicHopPrepare) throw new Error('durable state must advertise atomic hop prepare');
  const source = { sourceTaskId: 'task_s', sourceRunId: 'run_s', sourceResultId: 'result_s' };
  const prepared = durablePrepared(state, conversation, 0, source);

  legacy.updateConversationStatus(conversation.id, { status: 'running' });
  const legacyHop = legacy.createHop({
    conversationId: conversation.id,
    index: prepared.hop.index,
    from: prepared.hop.from,
    to: prepared.hop.to,
  });
  legacy.updateHopStatus(legacyHop.id, {
    status: 'running',
    ...source,
    requestMessageId: prepared.requestMessage.id,
    responseMessageId: null,
    recipientTaskId: null,
    recipientRunId: null,
    recipientResultId: null,
    completedAt: null,
    error: null,
  });
  legacy.addConversationMessage(conversation.id, structuredClone(prepared.requestMessage));

  const durableHop = state.getHop(prepared.hop.id);
  assert.equal(state.hasAtomicHopPrepare, true);
  assert.equal(durableHop.status, 'running');
  // the legacy PeerHopMap assigns its own hop id and timestamp
  // (createHop takes no id/createdAt), so compare every field with those
  // two normalized to the durable write's values
  assert.deepEqual(durableHop, { ...legacy.getHop(legacyHop.id), id: prepared.hop.id, createdAt: prepared.hop.createdAt });
  assert.deepEqual(state.getConversation(conversation.id), {
    ...legacy.getConversation(conversation.id),
    hops: [prepared.hop.id],
  });
  assert.equal(state.getConversation(conversation.id).hops[0], prepared.hop.id);
  assert.deepEqual(state.messagesForConversation(conversation.id), legacy.messagesForConversation(conversation.id));
  assert.deepEqual(
    state.hopsForConversation(conversation.id),
    legacy.hopsForConversation(conversation.id).map((h) => ({ ...h, id: prepared.hop.id, createdAt: prepared.hop.createdAt })),
  );
});

test('9. conversation/hop legal and illegal transitions match legacy behavior', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const legacy = new PeerState();
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  legacy.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  // legal transitions
  state.updateConversationStatus(conversation.id, { status: 'running' });
  legacy.updateConversationStatus(conversation.id, { status: 'running' });

  // illegal conversation transition: running -> created
  const sameRejection = (fnA, fnB) => {
    let a = null;
    let b = null;
    try {
      fnA();
    } catch (error) {
      a = error;
    }
    try {
      fnB();
    } catch (error) {
      b = error;
    }
    assert.ok(a instanceof BusError, 'durable must throw a BusError');
    assert.ok(b instanceof BusError, 'legacy must throw a BusError');
    assert.equal(a.message, b.message);
  };

  sameRejection(
    () => state.updateConversationStatus(conversation.id, { status: 'created' }),
    () => legacy.updateConversationStatus(conversation.id, { status: 'created' }),
  );

  const prepared = durablePrepared(state, conversation, 0);
  const legacyHop = legacy.createHop({ conversationId: conversation.id, index: 0, from: 'alpha', to: 'beta' });
  legacy.updateHopStatus(legacyHop.id, { status: 'running' });

  // illegal hop transition: running -> running
  sameRejection(
    () => state.updateHopStatus(prepared.hop.id, { status: 'running' }),
    () => legacy.updateHopStatus(legacyHop.id, { status: 'running' }),
  );

  // terminal conversation blocks further hops in both
  state.updateConversationStatus(conversation.id, { status: 'failed', error: { message: 'x' } });
  legacy.updateConversationStatus(conversation.id, { status: 'failed', error: { message: 'x' } });
  sameRejection(
    () => durablePrepared(state, conversation, 1),
    () => legacy.createHop({ conversationId: conversation.id, index: 1, from: 'a', to: 'b' }),
  );
});

test('10. peer request/response messages + lineage round-trip faithfully', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  const source = { sourceTaskId: 'task_src', sourceRunId: 'run_src', sourceResultId: 'result_src' };
  const prepared = durablePrepared(state, conversation, 0, source);
  const hopId = prepared.hop.id;

  // response message + terminal hop with recipient lineage (simulates the
  // relay's post-dispatch bookkeeping)
  const responseMessage = createMessageEnvelope({
    from: 'beta',
    to: 'alpha',
    taskId: 'task_rcp',
    runId: 'run_rcp',
    body: 'response body',
    replyTo: prepared.requestMessage.id,
    kind: 'message',
    conversationId: conversation.id,
    hopId,
  });
  state.addConversationMessage(conversation.id, responseMessage);
  const updated = state.updateHopStatus(hopId, {
    responseMessageId: responseMessage.id,
    recipientTaskId: 'task_rcp',
    recipientRunId: 'run_rcp',
    recipientResultId: 'result_rcp',
    status: 'completed',
    completedAt: '2026-08-18T00:00:00.000Z',
  });
  state.updateConversationStatus(conversation.id, { status: 'completed' });

  assert.equal(updated.status, 'completed');
  assert.equal(updated.requestMessageId, prepared.requestMessage.id);
  assert.equal(updated.responseMessageId, responseMessage.id);
  assert.equal(updated.sourceTaskId, 'task_src');
  assert.equal(updated.recipientTaskId, 'task_rcp');

  const reopened = await reopenPeer(t, opened);
  const after = reopened.state.getHop(hopId);
  assert.deepEqual(after, updated);
  const messages = reopened.state.messagesForConversation(conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, prepared.requestMessage.id);
  assert.equal(messages[1].id, responseMessage.id);
  assert.deepEqual(messages[1], responseMessage);
});

test('11. peer transcript/message ordering survives close/reopen', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  const prepared = durablePrepared(state, conversation, 0);
  for (const [i, event] of [
    'conversation.started',
    'peer.request.created',
    'peer.hop.started',
    'peer.hop.completed',
    'conversation.completed',
  ].entries()) {
    state.appendEvent({
      conversationId: conversation.id,
      hopId: prepared.hop.id,
      messageId: i % 2 === 0 ? null : prepared.requestMessage.id,
      event,
      at: `2026-08-18T00:00:0${i}.000Z`,
    });
  }

  const reopened = await reopenPeer(t, opened);
  const after = reopened.state.transcriptForConversation(conversation.id);
  assert.deepEqual(
    after.map((entry) => entry.event),
    [
      'conversation.started',
      'peer.request.created',
      'peer.hop.started',
      'peer.hop.completed',
      'conversation.completed',
    ],
  );
  assert.deepEqual(after, state.transcriptForConversation(conversation.id));
  assert.equal(reopened.state.messagesForConversation(conversation.id).length, 1);
});

test('12. fresh object reopen reconstructs conversation/hops/messages/transcript deep-equivalent', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  const source = { sourceTaskId: 'task_s', sourceRunId: 'run_s', sourceResultId: 'result_s' };
  const prepared = durablePrepared(state, conversation, 0, source);
  const responseMessage = createMessageEnvelope({
    from: 'beta',
    to: 'alpha',
    taskId: 'task_r',
    runId: 'run_r',
    body: 'resp',
    replyTo: prepared.requestMessage.id,
    kind: 'message',
    conversationId: conversation.id,
    hopId: prepared.hop.id,
  });
  state.addConversationMessage(conversation.id, responseMessage);
  state.updateHopStatus(prepared.hop.id, {
    responseMessageId: responseMessage.id,
    recipientTaskId: 'task_r',
    recipientRunId: 'run_r',
    recipientResultId: 'result_r',
    status: 'completed',
    completedAt: '2026-08-18T00:00:00.000Z',
  });
  state.updateConversationStatus(conversation.id, { status: 'completed' });
  state.appendEvent({
    conversationId: conversation.id,
    hopId: prepared.hop.id,
    event: 'conversation.completed',
    at: '2026-08-18T00:00:00.000Z',
  });

  const before = state.getConversation(conversation.id);
  const beforeHop = state.getHop(prepared.hop.id);
  const beforeTranscript = state.transcript();
  const reopened = await reopenPeer(t, opened);
  assert.deepEqual(reopened.state.getConversation(conversation.id), before);
  assert.deepEqual(reopened.state.getHop(prepared.hop.id), beforeHop);
  assert.deepEqual(
    reopened.state.messagesForConversation(conversation.id),
    state.messagesForConversation(conversation.id),
  );
  assert.deepEqual(reopened.state.transcript(), beforeTranscript);
});

test('13. nonterminal conversation/hop survives reopen unchanged and causes zero adapter calls', async (t) => {
  const opened = await openPeer(t);
  const { state } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  const prepared = durablePrepared(state, conversation, 0);
  state.appendEvent({
    conversationId: conversation.id,
    hopId: prepared.hop.id,
    event: 'peer.hop.started',
    at: '2026-08-18T00:00:00.000Z',
  });

  const beforeConversation = state.getConversation(conversation.id);
  const beforeHop = state.getHop(prepared.hop.id);
  const reopened = await reopenPeer(t, opened);
  assert.deepEqual(reopened.state.getConversation(conversation.id), beforeConversation);
  assert.deepEqual(reopened.state.getHop(prepared.hop.id), beforeHop);
  assert.equal(reopened.state.getConversation(conversation.id).status, 'running');
  assert.equal(reopened.state.getHop(prepared.hop.id).status, 'running');

  const calls = [];
  const relay = new PeerRelay({ bus: countingBus(calls), state: reopened.state });
  assert.equal(calls.length, 0, 'constructing relay/hydrating durable state must not dispatch');
});

test('14. atomic peer prepare persists hop + request message + running state together', async (t) => {
  const opened = await openPeer(t);
  const { state, repo } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });
  const source = { sourceTaskId: 'task_a', sourceRunId: 'run_a', sourceResultId: 'result_a' };
  const prepared = durablePrepared(state, conversation, 0, source);

  // one atomic write: hop, message, and conversation running state all visible
  assert.equal(state.getConversation(conversation.id).status, 'running');
  assert.equal(repo.countHops(), 1);
  assert.equal(repo.countConversations(), 1);
  assert.equal(state.getHop(prepared.hop.id).requestMessageId, prepared.requestMessage.id);
  assert.equal(state.getHop(prepared.hop.id).sourceTaskId, 'task_a');
  assert.deepEqual(state.messagesForConversation(conversation.id), [prepared.requestMessage]);
});

test('15. injected failure in atomic peer prepare leaves no partial state + zero AgentBus dispatch', async (t) => {
  const opened = await openPeer(t);
  const { store } = opened;

  // Wrap the real store: inside the repository transaction the first write
  // (hop insert) succeeds, then the request-message insert throws, exactly like
  // a crash between the two logical writes. SQLite rolls the whole transaction
  // back through the real store.
  const crashing = new Proxy(store, {
    get(target, prop) {
      if (prop === 'transactionSync') {
        return (fn) =>
          target.transactionSync((ctx) => {
            const wrapped = {};
            for (const [key, value] of Object.entries(ctx)) wrapped[key] = value;
            wrapped.run = (sql, params) => {
              if (String(sql).includes('INSERT INTO peer_conversation_messages')) {
                throw new Error('INJECTED_CRASH_IN_ATOMIC_PEER_PREPARE');
              }
              return ctx.run(sql, params);
            };
            return fn(wrapped);
          });
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const repo = new PeerRepository({ store: crashing });
  const state = new DurablePeerState({ repository: repo });
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  const calls = [];
  const relay = new PeerRelay({ bus: countingBus(calls), state });
  await assert.rejects(
    () => relay.relay({ conversationId: conversation.id, from: 'alpha', to: 'beta', body: 'request body' }),
    /INJECTED_CRASH_IN_ATOMIC_PEER_PREPARE/,
  );

  // zero partial hop, zero message rows, conversation still created, zero dispatch
  assert.equal(store.get('SELECT COUNT(*) AS c FROM peer_hops').c, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM peer_conversation_messages').c, 0);
  assert.equal(state.getConversation(conversation.id).status, 'created');
  assert.equal(state.hopCount, 0);
  assert.deepEqual(calls, [], 'no AgentBus recordMessage/dispatch may occur after a failed atomic prepare');
});

test('16p. duplicate/stable-id peer constraints fail deterministically', async (t) => {
  const opened = await openPeer(t);
  const { state, store } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  // duplicate conversation id
  await assert.throws(
    () => state.createConversation({ id: conversation.id, createdAt: conversation.createdAt }),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_CONVERSATION',
  );

  // duplicate hop index in the same conversation via atomic prepare
  durablePrepared(state, conversation, 0);
  const hopId = 'hop_dup';
  await assert.throws(
    () => state.prepareHop({
      conversationId: conversation.id,
      hop: { id: hopId, index: 0, from: 'alpha', to: 'beta', requestMessageId: 'msg_dup' },
      requestMessage: createMessageEnvelope({
        id: 'msg_dup',
        from: 'alpha',
        to: 'beta',
        body: 'dup',
        conversationId: conversation.id,
        hopId,
      }),
    }),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_HOP_INDEX',
  );
  assert.equal(state.hopCount, 1);

  // duplicate peer message id (first insert succeeds, second collides)
  const dupMessage = createMessageEnvelope({
    id: 'msg_dup2',
    from: 'alpha',
    to: 'beta',
    body: 'dup',
    conversationId: conversation.id,
    hopId,
  });
  state.addConversationMessage(conversation.id, dupMessage);
  await assert.throws(
    () => state.addConversationMessage(conversation.id, dupMessage),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_PEER_MESSAGE',
  );
});

test('18. NOT_JSON_FAITHFUL peer payload/message fails before any mutation', async (t) => {
  const opened = await openPeer(t);
  const { state, store } = opened;
  const conversation = sampleConversation();
  state.createConversation({ id: conversation.id, createdAt: conversation.createdAt });

  const badMessage = createMessageEnvelope({
    from: 'alpha',
    to: 'beta',
    body: 'bad',
    conversationId: conversation.id,
    hopId: 'hop_bad',
  });
  badMessage.metadata = { when: new Date('2026-08-18T00:00:00.000Z') }; // Date is NOT JSON-faithful
  await assert.rejects(
    async () =>
      state.prepareHop({
        conversationId: conversation.id,
        hop: { id: 'hop_bad', index: 0, from: 'alpha', to: 'beta', requestMessageId: badMessage.id },
        requestMessage: badMessage,
      }),
    (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL',
  );
  assert.equal(store.get('SELECT COUNT(*) AS c FROM peer_hops').c, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM peer_conversation_messages').c, 0);
  assert.equal(state.getConversation(conversation.id).status, 'created');

  // same guarantee through addConversationMessage alone
  await assert.throws(
    () => state.addConversationMessage(conversation.id, badMessage),
    (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL',
  );
  assert.equal(store.get('SELECT COUNT(*) AS c FROM peer_conversation_messages').c, 0);
});