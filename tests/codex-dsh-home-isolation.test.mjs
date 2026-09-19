import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runCodexCliProcess, resolveCodexDshHome, codexSourceEnv } from '../src/session/codex-cli-session-bridge.mjs';

// CODEX-ENV-ISO R2: proof that the DSH Codex backend's child processes get
// a dedicated CODEX_HOME, isolated from the owner's shared `~/.codex` that
// the VS Code ChatGPT extension / Codex Desktop alpha app-server processes
// continuously rewrite (docs/env/02_CODEX_DSH_HOME_ISOLATION.md). Uses a
// fake spawn (no real process, no inference quota spent) — same pattern
// p9-codex-pinned-model.test.mjs already uses for this exact function.
function fakeSpawn({ stdout = '', capture = {} } = {}) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end('');
      queueMicrotask(() => child.emit('close', 0));
    });
    return child;
  };
}
const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
].join('\n');

test('resolveCodexDshHome defaults to a fixed DSH-only directory, never the shared default', () => {
  const home = resolveCodexDshHome({});
  assert.equal(home, join(homedir(), '.codex-dsh'));
});

test('resolveCodexDshHome honors an explicit DSH_CODEX_HOME override', () => {
  const home = resolveCodexDshHome({ DSH_CODEX_HOME: 'C:\\custom\\codex-home' });
  assert.equal(home, 'C:\\custom\\codex-home');
});

test('codexSourceEnv overrides CODEX_HOME but preserves every other ambient key untouched', () => {
  const env = codexSourceEnv({ PATH: '/x', CODEX_HOME: '/should-be-overridden', OTHER: '1' });
  assert.equal(env.CODEX_HOME, join(homedir(), '.codex-dsh'));
  assert.equal(env.PATH, '/x');
  assert.equal(env.OTHER, '1');
});

test('runCodexCliProcess spawns the real child with the dedicated CODEX_HOME injected, never the ambient one', async () => {
  const capture = {};
  const spawnImpl = fakeSpawn({ stdout: codexJson('OK'), capture });
  const result = await runCodexCliProcess({
    binary: 'C:\\stable\\codex.exe',
    prompt: 'ping',
    spawnImpl,
  });
  assert.equal(result.code, 0);
  assert.equal(capture.options.env.CODEX_HOME, join(homedir(), '.codex-dsh'));
});

test('runCodexCliProcess honors a DSH_CODEX_HOME override present in the ambient environment', async () => {
  const capture = {};
  const spawnImpl = fakeSpawn({ stdout: codexJson('OK'), capture });
  const previous = process.env.DSH_CODEX_HOME;
  process.env.DSH_CODEX_HOME = 'C:\\override\\codex-home';
  try {
    await runCodexCliProcess({ binary: 'C:\\stable\\codex.exe', prompt: 'ping', spawnImpl });
    assert.equal(capture.options.env.CODEX_HOME, 'C:\\override\\codex-home');
  } finally {
    if (previous === undefined) delete process.env.DSH_CODEX_HOME;
    else process.env.DSH_CODEX_HOME = previous;
  }
});
