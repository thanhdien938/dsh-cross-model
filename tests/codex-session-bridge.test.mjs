import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexSessionBridge, CODEX_SANDBOX_MODES, CODEX_DOCUMENTED_SESSION_CAPABILITIES, CODEX_UNPROVEN_SESSION_CAPABILITIES } from '../src/session/codex-session-bridge.mjs';

class FakeClient extends EventEmitter {
  calls = [];
  responses = new Map();
  stopped = false;
  async request(method, params) {
    this.calls.push({ method, params });
    const value = this.responses.get(method);
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value ?? {};
  }
  waitFor(predicate) {
    return new Promise((resolve) => {
      const listener = (message) => {
        if (predicate(message)) {
          this.off('notification', listener);
          resolve(message);
        }
      };
      this.on('notification', listener);
    });
  }
  async stop() { this.stopped = true; }
}

test('Codex documented profile is distinct from unproven runtime profile', () => {
  assert.equal(CODEX_DOCUMENTED_SESSION_CAPABILITIES.resume_existing, true);
  assert.equal(CODEX_DOCUMENTED_SESSION_CAPABILITIES.send_next_turn, true);
  assert.equal(CODEX_DOCUMENTED_SESSION_CAPABILITIES.concurrent_client_safe, false);
  assert.deepEqual(Object.values(CODEX_UNPROVEN_SESSION_CAPABILITIES), [false, false, false, false, false, false]);
});

test('createThread creates durable non-ephemeral thread by default', async () => {
  const client = new FakeClient();
  client.responses.set('thread/start', { thread: { id: 'thr_1' } });
  const bridge = new CodexSessionBridge({ client });
  const out = await bridge.createThread({ cwd: 'C:/repo' });
  assert.equal(out.thread.id, 'thr_1');
  assert.deepEqual(client.calls[0], { method: 'thread/start', params: { cwd: 'C:/repo', ephemeral: false } });
});

test('resume maps exactly to thread/resume', async () => {
  const client = new FakeClient();
  client.responses.set('thread/resume', { thread: { id: 'thr_1' } });
  const bridge = new CodexSessionBridge({ client });
  await bridge.resume('thr_1', { personality: 'friendly' });
  assert.deepEqual(client.calls[0], { method: 'thread/resume', params: { threadId: 'thr_1', personality: 'friendly' } });
});

test('sendNextTurn maps exactly to turn/start on same thread', async () => {
  const client = new FakeClient();
  client.responses.set('turn/start', { turn: { id: 'turn_1' } });
  const bridge = new CodexSessionBridge({ client });
  const out = await bridge.sendNextTurn('thr_1', 'hello');
  assert.equal(out.turn.id, 'turn_1');
  assert.deepEqual(client.calls[0], {
    method: 'turn/start',
    params: { threadId: 'thr_1', input: [{ type: 'text', text: 'hello' }] },
  });
});

test('interrupt uses active turn id captured from turn/start result', async () => {
  const client = new FakeClient();
  client.responses.set('turn/start', { turn: { id: 'turn_9' } });
  const bridge = new CodexSessionBridge({ client });
  await bridge.sendNextTurn('thr_1', 'work');
  await bridge.interrupt('thr_1');
  assert.deepEqual(client.calls[1], { method: 'turn/interrupt', params: { threadId: 'thr_1', turnId: 'turn_9' } });
});

test('subscribeEvents filters notifications by thread and returns unsubscribe', () => {
  const client = new FakeClient();
  const bridge = new CodexSessionBridge({ client });
  const seen = [];
  const unsubscribe = bridge.subscribeEvents('thr_1', (event) => seen.push(event.method));
  client.emit('notification', { method: 'item/started', params: { threadId: 'thr_2' } });
  client.emit('notification', { method: 'item/started', params: { threadId: 'thr_1' } });
  unsubscribe();
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thr_1' } });
  assert.deepEqual(seen, ['item/started']);
});

test('waitForTurnTerminal requires matching thread and turn', async () => {
  const client = new FakeClient();
  const bridge = new CodexSessionBridge({ client });
  const waiting = bridge.waitForTurnTerminal('thr_1', 'turn_1');
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_other' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
  const terminal = await waiting;
  assert.equal(terminal.params.turn.id, 'turn_1');
});

test('waitForTurnTerminal returns cached terminal event when completion raced ahead', async () => {
  const client = new FakeClient();
  const bridge = new CodexSessionBridge({ client });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_fast', status: 'completed' } } });
  const terminal = await bridge.waitForTurnTerminal('thr_1', 'turn_fast');
  assert.equal(terminal.params.turn.status, 'completed');
});

test('dispose detaches and stops client', async () => {
  const client = new FakeClient();
  const bridge = new CodexSessionBridge({ client });
  await bridge.dispose();
  assert.equal(client.stopped, true);
});

test('Codex sandbox mode constants match installed app-server SandboxMode enum', () => {
  assert.deepEqual(Object.values(CODEX_SANDBOX_MODES), ['read-only', 'workspace-write', 'danger-full-access']);
});
