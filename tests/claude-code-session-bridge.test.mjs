import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  ClaudeCodeSessionBridge,
  CLAUDE_BINARY_CANDIDATES,
  CLAUDE_DOCUMENTED_SESSION_CAPABILITIES,
  CLAUDE_UNPROVEN_SESSION_CAPABILITIES,
  resolveClaudeBinary,
} from '../src/session/claude-code-session-bridge.mjs';

function fakeRunnerFactory(outputs) {
  const calls = [];
  const runner = async (input) => {
    calls.push(input);
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { runner, calls };
}

test('Claude documented profile is distinct from unproven runtime profile', () => {
  assert.equal(CLAUDE_DOCUMENTED_SESSION_CAPABILITIES.resume_existing, true);
  assert.equal(CLAUDE_DOCUMENTED_SESSION_CAPABILITIES.send_next_turn, true);
  assert.equal(CLAUDE_DOCUMENTED_SESSION_CAPABILITIES.stream_events, true);
  assert.equal(CLAUDE_DOCUMENTED_SESSION_CAPABILITIES.interrupt_active_turn, false);
  assert.deepEqual(Object.values(CLAUDE_UNPROVEN_SESSION_CAPABILITIES), [false, false, false, false, false, false]);
});

test('binary resolution considers only absolute known installs by default', () => {
  assert.ok(CLAUDE_BINARY_CANDIDATES.length >= 1);
  assert.ok(CLAUDE_BINARY_CANDIDATES.every((value) => /^[A-Za-z]:[\\/]|^\//.test(value)));
  assert.match(CLAUDE_BINARY_CANDIDATES[0], /[\\/]\.local[\\/]bin[\\/]claude$/);
});

test('resolveClaudeBinary returns a trusted invokable binary or strict unavailability', () => {
  const binary = resolveClaudeBinary();
  assert.equal(typeof binary, 'string');
  if (binary === '') return;
  assert.match(binary, /claude/);
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, (probe.stderr || '').trim());
  assert.match(probe.stdout + (probe.stderr || ''), /2\.\d+\.\d+/);
});

test('createSession starts without resume and requires a session id', async () => {
  const { runner, calls } = fakeRunnerFactory([{ sessionId: 'sess_1', result: 'ok' }]);
  const bridge = new ClaudeCodeSessionBridge({ runner, cwd: 'C:/repo' });
  const out = await bridge.createSession('remember marker');
  assert.equal(out.sessionId, 'sess_1');
  assert.equal(calls[0].resume, null);
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].prompt, 'remember marker');
});

test('sendNextTurn resumes same native session id', async () => {
  const { runner, calls } = fakeRunnerFactory([{ sessionId: 'sess_1', result: 'marker' }]);
  const bridge = new ClaudeCodeSessionBridge({ runner });
  const out = await bridge.sendNextTurn('sess_1', 'what marker?');
  assert.equal(out.sessionId, 'sess_1');
  assert.equal(calls[0].resume, 'sess_1');
  assert.equal(calls[0].stream, false);
});

test('sendNextTurn rejects a changed session id', async () => {
  const { runner } = fakeRunnerFactory([{ sessionId: 'sess_other', result: 'x' }]);
  const bridge = new ClaudeCodeSessionBridge({ runner });
  await assert.rejects(() => bridge.sendNextTurn('sess_1', 'continue'), (error) => error.code === 'SESSION_ID_CHANGED');
});

test('streamTurn requests stream mode and preserves session id', async () => {
  const { runner, calls } = fakeRunnerFactory([{ sessionId: 'sess_1', result: 'ok', events: [{ type: 'system' }, { type: 'result' }] }]);
  const bridge = new ClaudeCodeSessionBridge({ runner });
  const out = await bridge.streamTurn('sess_1', 'stream this');
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].resume, 'sess_1');
  assert.equal(out.events.length, 2);
});

test('resume without a prompt is descriptive only and does not invoke runner', async () => {
  const { runner, calls } = fakeRunnerFactory([]);
  const bridge = new ClaudeCodeSessionBridge({ runner });
  const out = await bridge.resume('sess_1');
  assert.deepEqual(out, { sessionId: 'sess_1', resumed: true });
  assert.equal(calls.length, 0);
});

test('resume with prompt delegates to a native resumed next turn', async () => {
  const { runner, calls } = fakeRunnerFactory([{ sessionId: 'sess_1', result: 'ok' }]);
  const bridge = new ClaudeCodeSessionBridge({ runner });
  await bridge.resume('sess_1', { prompt: 'continue' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, 'sess_1');
});
