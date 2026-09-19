import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GROK_BINARY_CANDIDATES, resolveGrokBinary } from '../src/session/grok-acp-client.mjs';
import { GrokSessionBridge, GROK_DOCUMENTED_SESSION_CAPABILITIES, GROK_UNPROVEN_SESSION_CAPABILITIES } from '../src/session/grok-session-bridge.mjs';

class FakeClient extends EventEmitter {
  calls = [];
  notifications = [];
  responses = new Map();
  stopped = false;
  async request(method, params) {
    this.calls.push({ method, params });
    const value = this.responses.get(method);
    if (value instanceof Error) throw value;
    if (method === 'session/prompt') {
      for (const notification of this.notifications) this.emit('notification', notification);
    }
    return typeof value === 'function' ? value(params) : value ?? {};
  }
  notify(method, params) { this.calls.push({ method, params, notification: true }); }
  async stop() { this.stopped = true; }
}

test('Grok documented profile is distinct from unproven runtime profile', () => {
  assert.equal(GROK_DOCUMENTED_SESSION_CAPABILITIES.resume_existing, true);
  assert.equal(GROK_DOCUMENTED_SESSION_CAPABILITIES.send_next_turn, true);
  assert.equal(GROK_DOCUMENTED_SESSION_CAPABILITIES.stream_events, true);
  assert.deepEqual(Object.values(GROK_UNPROVEN_SESSION_CAPABILITIES), [false, false, false, false, false, false]);
});

test('binary candidates exclude PATH and resolution is absolute or unavailable', () => {
  assert.match(GROK_BINARY_CANDIDATES[0], /[\\/]\.grok[\\/]bin[\\/]grok$/);
  assert.ok(GROK_BINARY_CANDIDATES.every((value) => /^[A-Za-z]:[\\/]|^\//.test(value)));
  const resolved = resolveGrokBinary();
  assert.ok(resolved === '' || /^[A-Za-z]:[\\/]|^\//.test(resolved));
});

test('createSession maps to session/new and requires returned sessionId', async () => {
  const client = new FakeClient();
  client.responses.set('session/new', { sessionId: 'sess_1' });
  const bridge = new GrokSessionBridge({ client, cwd: 'C:/repo' });
  const out = await bridge.createSession();
  assert.equal(out.sessionId, 'sess_1');
  assert.equal(client.calls[0].method, 'session/new');
  assert.equal(client.calls[0].params.cwd, 'C:/repo');
});

test('resume maps exactly to session/load and does not replay transcript', async () => {
  const client = new FakeClient();
  client.responses.set('session/load', { loaded: true });
  const bridge = new GrokSessionBridge({ client, cwd: 'C:/repo' });
  await bridge.resume('sess_1');
  assert.equal(client.calls[0].method, 'session/load');
  assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['_meta', 'cwd', 'mcpServers', 'sessionId']);
  assert.equal(client.calls[0].params.sessionId, 'sess_1');
});

test('sendNextTurn collects only matching session update chunks', async () => {
  const client = new FakeClient();
  client.responses.set('session/prompt', { stopReason: 'end_turn' });
  client.notifications = [
    { method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'bad' } } } },
    { method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking' } } } },
    { method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello ' } } } },
    { method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'world' } } } },
  ];
  const bridge = new GrokSessionBridge({ client });
  const out = await bridge.sendNextTurn('sess_1', 'hi');
  assert.equal(out.text, 'hello world');
  assert.equal(out.updates.length, 3);
  assert.equal(client.calls[0].method, 'session/prompt');
});

test('interrupt maps to ACP session/cancel notification', () => {
  const client = new FakeClient();
  const bridge = new GrokSessionBridge({ client });
  const out = bridge.interrupt('sess_1');
  assert.equal(out.sent, true);
  assert.deepEqual(client.calls[0], { method: 'session/cancel', params: { sessionId: 'sess_1' }, notification: true });
});

test('subscribeEvents filters by session and returns unsubscribe', () => {
  const client = new FakeClient();
  const bridge = new GrokSessionBridge({ client });
  const seen = [];
  const unsub = bridge.subscribeEvents('sess_1', (event) => seen.push(event.method));
  client.emit('notification', { method: 'session/update', params: { sessionId: 'other' } });
  client.emit('notification', { method: 'session/update', params: { sessionId: 'sess_1' } });
  unsub();
  client.emit('notification', { method: 'session/update', params: { sessionId: 'sess_1' } });
  assert.deepEqual(seen, ['session/update']);
});

test('dispose stops the ACP client', async () => {
  const client = new FakeClient();
  const bridge = new GrokSessionBridge({ client });
  await bridge.dispose();
  assert.equal(client.stopped, true);
});
