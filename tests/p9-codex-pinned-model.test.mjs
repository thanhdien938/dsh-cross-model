import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { runCodexCliProcess, extractCodexAssistantText } from '../src/session/codex-cli-session-bridge.mjs';

// P9-R0.4.1 Part J/T22/T23: proof that a pinned Codex profile's `model`
// forwards `--model <slug>` and `reasoning` forwards the EXISTING, UNCHANGED
// `-c model_reasoning_effort=<value>` mapping through the real production
// argv-construction path (runCodexCliProcess — src/session/codex-cli-
// session-bridge.mjs, not modified by this wave). Uses a fake spawn (no
// real process, no inference quota spent) — the same pattern
// production-codex-grok-backends.test.mjs already uses for this exact
// function.
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

// The real, owner-live-discovered native default model for this Codex CLI
// installation — see docs/p9/09_DUPLICATE_IDENTITY_AND_CODEX_PINNING.md
// §Codex live model discovery (`codex doctor --json` -> checks['config.
// load'].details.model, the exact same metadata-only source production's
// own capability probe already uses — src/pm/pm-connection-probe.mjs
// probeCodex()). Not re-probed live here (Part H: no inference quota, no
// live CLI dependency in a unit test) — pinned as a literal so this test
// documents and proves the SAME slug the real pinned profile was created
// with.
const DISCOVERED_NATIVE_MODEL = 'gpt-5.6-sol';

test('a pinned Codex profile forwards --model <discovered-native-slug> to the real production argv path', async () => {
  const capture = {};
  const out = await runCodexCliProcess({
    binary: 'codex-safe',
    cwd: 'C:/project',
    prompt: 'Report repository name and current branch.',
    model: DISCOVERED_NATIVE_MODEL,
    reasoning: 'medium',
    spawnImpl: fakeSpawn({ stdout: codexJson('ok'), capture }),
  });
  assert.equal(extractCodexAssistantText(out), 'ok');
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2), ['--model', DISCOVERED_NATIVE_MODEL]);
});

test('the same call preserves the EXISTING, unchanged reasoning mapping (-c model_reasoning_effort=<value>)', async () => {
  const capture = {};
  await runCodexCliProcess({
    binary: 'codex-safe',
    prompt: 'p',
    model: DISCOVERED_NATIVE_MODEL,
    reasoning: 'medium',
    spawnImpl: fakeSpawn({ stdout: codexJson('ok'), capture }),
  });
  assert.ok(capture.args.includes('-c'));
  const cIndex = capture.args.indexOf('-c');
  assert.equal(capture.args[cIndex + 1], 'model_reasoning_effort=medium');
});

test('an UNPINNED (model: null) profile omits --model entirely, exactly as before this wave', async () => {
  const capture = {};
  await runCodexCliProcess({ binary: 'codex-safe', prompt: 'p', model: null, reasoning: 'medium', spawnImpl: fakeSpawn({ stdout: codexJson('ok'), capture }) });
  assert.equal(capture.args.includes('--model'), false);
  assert.ok(capture.args.includes('-c')); // reasoning is independent of model pinning
});

test('argv is shell-free and cwd-isolated (unchanged production safety properties)', async () => {
  const capture = {};
  await runCodexCliProcess({ binary: 'codex-safe', cwd: 'C:/isolated', prompt: 'p', model: DISCOVERED_NATIVE_MODEL, spawnImpl: fakeSpawn({ stdout: codexJson('ok'), capture }) });
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.cwd, 'C:/isolated');
});
