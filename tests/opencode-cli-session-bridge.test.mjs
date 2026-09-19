import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  OpenCodeCliSessionBridge,
  OPENCODE_BINARY_CANDIDATES,
  OPENCODE_DOCUMENTED_SESSION_CAPABILITIES,
  OPENCODE_UNPROVEN_SESSION_CAPABILITIES,
  resolveOpenCodeBinary,
  runOpenCodeProcess,
  summarizeOpenCodeRun,
} from '../src/session/opencode-cli-session-bridge.mjs';
import { EventEmitter } from 'node:events';

test('OpenCode documented profile is distinct from unproven runtime profile', () => {
  assert.equal(OPENCODE_DOCUMENTED_SESSION_CAPABILITIES.resume_existing, true);
  assert.equal(OPENCODE_DOCUMENTED_SESSION_CAPABILITIES.send_next_turn, true);
  assert.equal(OPENCODE_DOCUMENTED_SESSION_CAPABILITIES.stream_events, true);
  assert.deepEqual(Object.values(OPENCODE_UNPROVEN_SESSION_CAPABILITIES), [false, false, false, false, false, false]);
});

test('binary candidates exclude PATH and include only absolute known installs', () => {
  assert.ok(OPENCODE_BINARY_CANDIDATES.every((value) => /^[A-Za-z]:[\\/]|^\//.test(value)));
  assert.ok(OPENCODE_BINARY_CANDIDATES.some((value) => /[\\/]\.opencode[\\/]bin[\\/]opencode$/.test(value)));
});

test('resolveOpenCodeBinary returns a trusted invokable binary or strict unavailability', () => {
  const binary = resolveOpenCodeBinary();
  assert.equal(typeof binary, 'string');
  if (binary === '') return;
  assert.match(binary, /opencode/);
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary) });
  assert.equal(probe.status, 0, (probe.stderr || '').trim());
  assert.match(probe.stdout + (probe.stderr || ''), /\d+\.\d+\.\d+/);
});

test('live OpenCode execution uses the same Windows command-wrapper rule as readiness', async () => {
  let options;
  const pending = runOpenCodeProcess({
    binary: 'C:\\trusted\\opencode.cmd',
    prompt: 'proof',
    timeoutMs: 1000,
    spawnImpl: (_binary, _args, spawnOptions) => {
      options = spawnOptions;
      const child = new EventEmitter();
      child.pid = undefined;
      child.kill = () => true;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error('fixture stop'), { code: 'FIXTURE_STOP' })));
      return child;
    },
  });
  await assert.rejects(pending);
  assert.equal(options.shell, process.platform === 'win32');
});

test('summarizeOpenCodeRun parses NDJSON and finds nested session id', () => {
  const stdout = [
    JSON.stringify({ type: 'session', session: { id: 'ses_1' } }),
    JSON.stringify({ type: 'text', text: 'ok' }),
  ].join('\n');
  const out = summarizeOpenCodeRun({ stdout, code: 0 });
  assert.equal(out.sessionId, 'ses_1');
  assert.equal(out.events.length, 2);
});

test('createSession requires native session id from runner output', async () => {
  const bridge = new OpenCodeCliSessionBridge({
    binary: 'fake-opencode',
    runner: async () => ({ code: 0, stdout: '', stderr: '', events: [{ type: 'x' }], sessionId: null }),
  });
  await assert.rejects(() => bridge.createSession('hello'), (error) => error.code === 'MISSING_OPENCODE_SESSION_ID');
});

test('createSession returns runner session and events', async () => {
  const calls = [];
  const bridge = new OpenCodeCliSessionBridge({
    binary: 'fake-opencode',
    cwd: 'C:/repo',
    runner: async (input) => {
      calls.push(input);
      return { code: 0, stdout: '', stderr: '', events: [{ type: 'session' }], sessionId: 'ses_1' };
    },
  });
  const out = await bridge.createSession('remember');
  assert.equal(out.sessionId, 'ses_1');
  assert.equal(calls[0].sessionId, undefined);
});

test('resume is metadata-only and never spawns or fabricates a new session', async () => {
  let calls = 0;
  const bridge = new OpenCodeCliSessionBridge({ runner: async () => { calls += 1; } });
  const out = await bridge.resume('ses_1');
  assert.deepEqual(out, { sessionId: 'ses_1', resumed: true, options: {} });
  assert.equal(calls, 0);
});

test('sendNextTurn passes the exact native session id to a fresh CLI process', async () => {
  const calls = [];
  const bridge = new OpenCodeCliSessionBridge({
    binary: 'fake-opencode',
    runner: async (input) => {
      calls.push(input);
      return { code: 0, stdout: '', stderr: '', events: [], sessionId: 'ses_1' };
    },
  });
  await bridge.sendNextTurn('ses_1', 'what was it?');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'ses_1');
  assert.equal(calls[0].prompt, 'what was it?');
});

test('subscribeEvents does not claim a live cross-process subscription', () => {
  const bridge = new OpenCodeCliSessionBridge({ runner: async () => ({}) });
  const unsubscribe = bridge.subscribeEvents('ses_1', () => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});
