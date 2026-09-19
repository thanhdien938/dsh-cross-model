import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { createProductionPmDriverResolver } from '../src/runtime/p5-production-composition.mjs';
import { runCodexCliProcess, summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';
import { runGrokCliProcess } from '../src/session/grok-cli-session-bridge.mjs';

const finish = (output = 'ok') => JSON.stringify({ type: 'finish', output });
const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');

function successfulSpawn(stdout, capture) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args, options, stdin: '' });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', (chunk) => { capture.stdin += chunk; });
    child.stdin.on('finish', () => {
      child.stdout.end(stdout);
      child.stderr.end();
      queueMicrotask(() => child.emit('close', 0));
    });
    if (options.stdio[0] === 'ignore') queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      queueMicrotask(() => child.emit('close', 0));
    });
    return child;
  };
}

function genericInput() {
  return { turn: 0, request: { id: 'r', objective: 'work', context: {} }, history: [], capabilities: ['finish'] };
}

test('generic Claude always uses bypassPermissions even when upstream requests plan', async () => {
  const calls = [];
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer: {},
    claudeBinary: 'claude-fixture',
    claudeRunner: async (args) => { calls.push(args); return { result: finish() }; },
  });
  const profile = { id: 'claude-any-model', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS', model: 'sonnet', reasoning: 'high' };
  await registry.resolve(profile, { project: { repo_path: 'C:/repo' }, executionOptions: { permissionMode: 'plan' } }).decide(genericInput());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].permissionMode, 'bypassPermissions');
  assert.equal(calls[0].model, 'sonnet');
  assert.equal(calls[0].effort, 'high');
});

test('internal Claude canonicalizer remains plan, ephemeral, and distinct from trusted generic execution', async () => {
  const calls = [];
  const canonicalizerProfile = { id: 'canonicalizer', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS', model: 'sonnet', reasoning: 'low' };
  const registry = new ProductionPmBackendRegistry({
    profileRegistry: { get: (id) => id === 'canonicalizer' ? canonicalizerProfile : null },
    canonicalization: { enabled: true, profileId: 'canonicalizer', captureRawWrapperText: false },
    probe: () => true,
    observer: {},
    claudeBinary: 'claude-fixture',
    claudeRunner: async (args) => {
      calls.push(args);
      if (args.ephemeral) return { result: JSON.stringify({ normalization_status: 'UNSAFE', reason_code: 'OTHER_UNSAFE' }) };
      return { result: '{"type":"finish","output":"truncated' };
    },
  });
  const profile = { id: 'generic', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  await assert.rejects(registry.resolve(profile, { project: { repo_path: 'C:/repo' } }).decide(genericInput()));
  assert.equal(calls[0].permissionMode, 'bypassPermissions');
  assert.equal(calls[0].ephemeral, undefined);
  assert.equal(calls[1].permissionMode, 'plan');
  assert.equal(calls[1].ephemeral, true);
});

test('generic OpenCode appends --auto once and preserves model/variant', async () => {
  let call;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer: {},
    openCodeBinary: 'opencode-fixture',
    openCodeRunner: async (args) => { call = args; return { events: [{ type: 'text', part: { type: 'text', text: finish() } }] }; },
  });
  const profile = { id: 'open-any-model', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS', model: 'provider/model', reasoning: 'high' };
  await registry.resolve(profile, { project: { repo_path: 'C:/repo' } }).decide(genericInput());
  assert.deepEqual(call.extraArgs, ['--model', 'provider/model', '--variant', 'high', '--auto']);
  assert.equal(call.extraArgs.filter((arg) => arg === '--auto').length, 1);
  assert.equal(call.cwd, 'C:/repo');
});

test('generic Antigravity uses accept-edits plus skip-permissions and preserves model/cwd', async () => {
  let call;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer: {},
    antigravityBinary: 'agy-fixture',
    antigravityRunner: async (args) => { call = args; return { events: [], result: { status: 'SUCCESS', response: finish() } }; },
  });
  const profile = { id: 'agy-any-model', product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS', model: 'gemini-model', reasoning: 'high' };
  await registry.resolve(profile, { project: { repo_path: process.cwd() } }).decide(genericInput());
  assert.equal(call.mode, 'accept-edits');
  assert.equal(call.dangerouslySkipPermissions, true);
  assert.equal(call.model, 'gemini-model');
  assert.equal(call.cwd, process.cwd());
  assert.equal('reasoning' in call, false);
});

test('Codex exact trusted argv preserves execution protocol, model/reasoning, cwd, stdin, and CODEX_HOME', async () => {
  const capture = {};
  await runCodexCliProcess({
    binary: 'codex-fixture', cwd: 'C:/repo', prompt: 'stdin prompt', model: 'gpt-model', reasoning: 'xhigh',
    spawnImpl: successfulSpawn(codexJson('ok'), capture),
  });
  assert.deepEqual(capture.args, [
    'exec', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '--json', '--color', 'never', '--model', 'gpt-model', '-c', 'model_reasoning_effort=xhigh', '-',
  ]);
  assert.equal(capture.args.includes('--sandbox'), false);
  assert.equal(capture.args.includes('read-only'), false);
  assert.equal(capture.options.cwd, 'C:/repo');
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.env.CODEX_HOME.endsWith('.codex-dsh'), true);
  assert.equal(capture.stdin, 'stdin prompt');
});

test('Grok exact trusted argv restores web capability and preserves single/json/no-subagents/model/reasoning', async () => {
  const capture = {};
  await runGrokCliProcess({
    binary: 'grok-fixture', cwd: 'C:/repo', prompt: 'single prompt', model: 'grok-model', reasoning: 'high',
    spawnImpl: successfulSpawn(JSON.stringify({ text: 'ok' }), capture),
  });
  assert.deepEqual(capture.args, [
    '--cwd', 'C:/repo', '--single', 'single prompt', '--output-format', 'json',
    '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '--no-plan', '--no-subagents',
    '--model', 'grok-model', '--reasoning-effort', 'high',
  ]);
  assert.equal(capture.args.includes('--disable-web-search'), false);
  assert.equal(capture.options.cwd, 'C:/repo');
  assert.equal(capture.options.shell, false);
  assert.deepEqual(capture.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('API remains HTTP/text-only registration and scripted remains in-process', async () => {
  let apiCall;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer: {},
    apiProviders: { fixture: {} },
    apiRunner: async (args) => { apiCall = args; return finish('api-ok'); },
  });
  const api = { id: 'api', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'fixture', model: 'api-model' };
  assert.deepEqual(await registry.resolve(api, { project: { repo_path: 'C:/repo' } }).decide(genericInput()), { type: 'finish', output: 'api-ok' });
  assert.equal(apiCall.model, 'api-model');
  assert.equal('permissionMode' in apiCall, false);

  const scriptedDecision = { type: 'finish', output: 'scripted-ok' };
  const resolver = createProductionPmDriverResolver({ scriptedDecisions: [scriptedDecision] });
  const scripted = { id: 'scripted', product: 'scripted', transport: 'in-process', session_kind: 'STATELESS' };
  assert.deepEqual(await resolver(scripted).decide({ turn: 0 }), scriptedDecision);
});

test('Codex timeout and Grok timeout remain typed and bounded', async () => {
  const hangingSpawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  };
  await assert.rejects(runCodexCliProcess({ prompt: 'p', timeoutMs: 5, spawnImpl: hangingSpawn }), { code: 'CODEX_TIMEOUT' });
  await assert.rejects(runGrokCliProcess({ prompt: 'p', timeoutMs: 5, spawnImpl: hangingSpawn }), { code: 'GROK_TIMEOUT' });
});

test('injected Codex registry runner preserves parsing and generic model inheritance', async () => {
  let call;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    observer: {},
    codexBinary: 'codex-fixture',
    codexRunner: async (args) => { call = args; return summarizeCodexCliRun({ stdout: codexJson(finish('parsed')) }); },
  });
  const profile = { id: 'codex-model', product: 'codex', transport: 'stdio', session_kind: 'STATELESS', model: 'gpt-model', reasoning: 'max' };
  assert.deepEqual(await registry.resolve(profile, { project: { repo_path: 'C:/repo' } }).decide(genericInput()), { type: 'finish', output: 'parsed' });
  assert.equal(call.model, 'gpt-model');
  assert.equal(call.reasoning, 'max');
  assert.equal(call.cwd, 'C:/repo');
});
