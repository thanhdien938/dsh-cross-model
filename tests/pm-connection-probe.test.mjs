import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { probeConnectionFacts, unavailableConnectionFacts, runBoundedProbe } from '../src/pm/pm-connection-probe.mjs';
import { reasoningCapabilityFor } from '../src/pm/pm-reasoning-capability.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

// P6-W3-R4/P6.5 Part L (AUTH matrix + responsiveness): every scenario
// below is driven by an injected fake async spawn — never a real CLI,
// never real auth state, never a real child process — so this suite is
// deterministic, fast, and safe to run anywhere, including CI without any
// of the four CLIs installed. The fake mirrors the exact
// EventEmitter/stream shape node:child_process.spawn() returns, matching
// the same pattern tests/production-codex-grok-backends.test.mjs already
// uses for the (also-async) CLI runners.
function fakeSpawnByArgs(byArgsKey) {
  return (binary, args) => {
    const key = args.join(' ');
    const fixture = byArgsKey[key];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    if (fixture?.hang) return child; // never closes -> exercises the timeout path
    const code = fixture?.code ?? (fixture ? 0 : 1);
    queueMicrotask(() => {
      child.stdout.end(fixture?.stdout ?? '');
      child.stderr.end(fixture?.stderr ?? '');
      queueMicrotask(() => child.emit('close', code));
    });
    return child;
  };
}

test('claude: logged-in JSON fixture -> LOGGED_IN, secrets never surfaced', async () => {
  const spawnImpl = fakeSpawnByArgs({
    'auth status': { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', orgId: 'org-secret', apiKey: 'sk-should-never-appear' }) },
    '--help': { stdout: "--model <model>  Model for the current session (e.g. 'fable', 'opus', or 'sonnet') or 'claude-fable-5'." },
  });
  const facts = await probeConnectionFacts('claude-code', 'claude', { spawnImpl });
  assert.equal(facts.authProbe, 'SUPPORTED');
  assert.equal(facts.authState, 'LOGGED_IN');
  assert.equal(JSON.stringify(facts).includes('example.com'), false);
  assert.equal(JSON.stringify(facts).includes('org-secret'), false);
  assert.equal(JSON.stringify(facts).includes('sk-should-never-appear'), false);
  assert.deepEqual(facts.modelDiscovery.models, ['fable', 'opus', 'sonnet', 'claude-fable-5']);
});

test('claude: logged-out JSON fixture -> LOGGED_OUT', async () => {
  const spawnImpl = fakeSpawnByArgs({ 'auth status': { stdout: JSON.stringify({ loggedIn: false }) } });
  const facts = await probeConnectionFacts('claude-code', 'claude', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_OUT');
});

test('claude: malformed output -> UNKNOWN, never thrown', async () => {
  const spawnImpl = fakeSpawnByArgs({ 'auth status': { stdout: 'not json at all' } });
  const facts = await probeConnectionFacts('claude-code', 'claude', { spawnImpl });
  assert.equal(facts.authState, 'UNKNOWN');
});

test('claude: --version-only success never implies LOGGED_IN', async () => {
  // No 'auth status' fixture registered at all -> the probe command itself
  // fails to run (exit 1 / no output), which must degrade to UNKNOWN, not
  // fabricate LOGGED_IN just because the binary is invokable.
  const spawnImpl = fakeSpawnByArgs({});
  const facts = await probeConnectionFacts('claude-code', 'claude', { spawnImpl });
  assert.equal(facts.authState, 'UNKNOWN');
});

test('opencode: credentials present -> LOGGED_IN, model list parsed', async () => {
  const spawnImpl = fakeSpawnByArgs({
    'auth list': { stdout: '4 credentials' },
    models: { stdout: 'opencode-go/glm-5.3\nxcode-best/gpt-5.5\nnot-a-model-line\n' },
  });
  const facts = await probeConnectionFacts('opencode', 'opencode', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_IN');
  assert.deepEqual(facts.modelDiscovery.models, ['opencode-go/glm-5.3', 'xcode-best/gpt-5.5']);
});

test('opencode: zero credentials -> LOGGED_OUT', async () => {
  const spawnImpl = fakeSpawnByArgs({ 'auth list': { stdout: '0 credentials' } });
  const facts = await probeConnectionFacts('opencode', 'opencode', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_OUT');
});

test('codex: "Logged in using ChatGPT" -> LOGGED_IN', async () => {
  const spawnImpl = fakeSpawnByArgs({
    'login status': { stdout: 'Logged in using ChatGPT\n' },
    'doctor --json': { stdout: JSON.stringify({ checks: { 'config.load': { details: { model: 'gpt-5.6-sol' } } } }) },
  });
  const facts = await probeConnectionFacts('codex', 'codex', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_IN');
  assert.equal(facts.nativeDefaultModel, 'gpt-5.6-sol');
});

test('codex: "Not logged in" -> LOGGED_OUT', async () => {
  const spawnImpl = fakeSpawnByArgs({ 'login status': { stdout: 'Not logged in\n' } });
  const facts = await probeConnectionFacts('codex', 'codex', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_OUT');
});

// P11-R5.1 Part A/M: `codex debug models` is a real, official, local CLI
// subcommand — when it succeeds, modelDiscovery must report LIVE, per-model
// labels, and per-model effort levels, never fall back silently.
test('codex: modelDiscovery reports LIVE when `codex debug models` succeeds, with per-model labels and effort levels', async () => {
  const spawnImpl = fakeSpawnByArgs({
    'login status': { stdout: 'Logged in using ChatGPT\n' },
    'debug models': { stdout: JSON.stringify({ client_version: '0.149.0', models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    ] }) },
  });
  const facts = await probeConnectionFacts('codex', 'codex', { spawnImpl });
  assert.equal(facts.modelDiscovery.supported, true);
  assert.deepEqual(facts.modelDiscovery.models, ['gpt-5.6-sol', 'gpt-5.4']);
  assert.deepEqual(facts.modelDiscovery.modelLabels, { 'gpt-5.6-sol': '5.6 Sol', 'gpt-5.4': '5.4' });
  assert.deepEqual(facts.modelDiscovery.modelEffortLevels['gpt-5.6-sol'], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(facts.modelDiscovery.modelEffortLevels['gpt-5.4'], ['low', 'medium', 'high', 'xhigh']);
  assert.match(facts.modelDiscovery.source, /^Live Codex catalogue/);
});

// P11-R5.1 Part D: when live discovery is unavailable, modelDiscovery must
// fall back to the DSH-managed JSON catalogue (config/codex-model-
// catalogue.json) — honestly labeled as not live-discovered.
test('codex: modelDiscovery falls back to the DSH-managed JSON catalogue when `codex debug models` is unavailable', async () => {
  const spawnImpl = fakeSpawnByArgs({ 'login status': { stdout: 'Logged in using ChatGPT\n' } });
  const facts = await probeConnectionFacts('codex', 'codex', { spawnImpl });
  assert.equal(facts.modelDiscovery.supported, true);
  assert.ok(facts.modelDiscovery.models.includes('gpt-5.6-sol'));
  assert.match(facts.modelDiscovery.source, /DSH-managed/);
  assert.match(facts.modelDiscovery.source, /not live-discovered/);
});

test('grok: "You are logged in" -> LOGGED_IN with model list + native default', async () => {
  const spawnImpl = fakeSpawnByArgs({
    models: { stdout: 'You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n' },
  });
  const facts = await probeConnectionFacts('grok', 'grok', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_IN');
  assert.equal(facts.nativeDefaultModel, 'grok-4.6');
  assert.deepEqual(facts.modelDiscovery.models, ['grok-4.6', 'grok-4.5']);
});

test('antigravity: `agy models` returning real slugs -> LOGGED_IN with model list (live shape)', async () => {
  const spawnImpl = fakeSpawnByArgs({
    models: { stdout: 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n' },
  });
  const facts = await probeConnectionFacts('antigravity', 'agy', { spawnImpl });
  assert.equal(facts.authState, 'LOGGED_IN');
  assert.deepEqual(facts.modelDiscovery.models, ['gemini-3.7-flash-high', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']);
});

test('antigravity: `agy models` probe never spends inference quota — it is the metadata probe, not a -p run', async () => {
  const capture = {};
  const spawnImpl = (binary, args, options) => { Object.assign(capture, { binary, args, options }); return fakeSpawnByArgs({ models: { stdout: 'gemini-3.7-flash-high\tG\n' } })(binary, args, options); };
  await probeConnectionFacts('antigravity', 'agy', { spawnImpl });
  assert.deepEqual(capture.args, ['models']);
  assert.equal(capture.args.includes('-p'), false);
});

test('antigravity: no recognizable model list -> stays UNKNOWN, never fabricates LOGGED_OUT from a weak signal', async () => {
  const spawnImpl = fakeSpawnByArgs({ models: { stdout: '' } });
  const facts = await probeConnectionFacts('antigravity', 'agy', { spawnImpl });
  assert.equal(facts.authState, 'UNKNOWN');
});

test('every backend: unsupported product -> UNKNOWN, distinct from a real probe failure', async () => {
  const facts = await probeConnectionFacts('not-a-real-product', 'whatever', { spawnImpl: fakeSpawnByArgs({}) });
  assert.equal(facts.authProbe, 'UNSUPPORTED');
  assert.equal(facts.authState, 'UNKNOWN');
});

test('a probe that times out degrades to UNKNOWN, never hangs the caller', async () => {
  const spawnImpl = fakeSpawnByArgs({ models: { hang: true } });
  const facts = await probeConnectionFacts('grok', 'grok', { spawnImpl, timeoutMs: 20 });
  assert.equal(facts.authState, 'UNKNOWN');
  assert.match(facts.authDetail, /timed out/);
});

test('a spawnImpl that throws never propagates out of probeConnectionFacts', async () => {
  const spawnImpl = () => { throw new Error('boom'); };
  const facts = await probeConnectionFacts('grok', 'grok', { spawnImpl });
  assert.equal(facts.authState, 'UNKNOWN');
});

test('CLI not installed -> UNKNOWN with an honest detail, not a probe attempt', () => {
  const facts = unavailableConnectionFacts('CLI not installed');
  assert.equal(facts.authState, 'UNKNOWN');
  assert.equal(facts.authDetail, 'CLI not installed');
});

test('reasoning capability is truthful per backend and never invents cross-provider parity', () => {
  assert.deepEqual(reasoningCapabilityFor('claude-code').levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(reasoningCapabilityFor('grok').levels, null);
  assert.deepEqual(reasoningCapabilityFor('antigravity').levels, ['low', 'medium', 'high']);
  assert.equal(reasoningCapabilityFor('unknown-product').selection, 'UNKNOWN');
});

// P11-R5.1 Part I/J: codex's union-of-live-catalogue levels replaced the
// old "minimal" guess (never proven by any live evidence); labels are
// derived only from `codex debug models`' own per-level description text.
test('codex reasoning capability: live-verified low/medium/high/xhigh/max/ultra with owner-facing labels, "minimal" removed', () => {
  const cap = reasoningCapabilityFor('codex');
  assert.equal(cap.selection, 'SUPPORTED');
  assert.deepEqual(cap.levels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(cap.levels.includes('minimal'), false);
  assert.deepEqual(cap.labels, { low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' });
  assert.match(cap.flag, /model_reasoning_effort/);
});

// P6.5 Part D/L: runBoundedProbe is the one shared async primitive every
// per-product prober above goes through. These prove its own contract
// directly: async/non-blocking, bounded timeout, bounded output, kills
// only the one probe child on timeout, never throws.
test('runBoundedProbe: returns exitCode/stdout/stderr/durationMs on a clean exit', async () => {
  const spawnImpl = fakeSpawnByArgs({ '--version': { stdout: '1.2.3\n', code: 0 } });
  const result = await runBoundedProbe({ executable: 'x', args: ['--version'], spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '1.2.3');
  assert.equal(typeof result.durationMs, 'number');
});

test('runBoundedProbe: kills only the timed-out probe child and reports timedOut', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    return child; // never emits close/error -> must hit the timeout path
  };
  const result = await runBoundedProbe({ executable: 'x', args: ['--slow'], timeoutMs: 15, spawnImpl });
  assert.equal(result.timedOut, true);
  assert.equal(killed, true);
});

test('runBoundedProbe: bounds stdout to maxOutputBytes instead of growing unbounded', async () => {
  const huge = 'x'.repeat(10_000);
  const spawnImpl = fakeSpawnByArgs({ dump: { stdout: huge, code: 0 } });
  const result = await runBoundedProbe({ executable: 'x', args: ['dump'], maxOutputBytes: 100, spawnImpl });
  assert.ok(result.stdout.length <= 200); // bounded, not the full 10,000-char dump
});

const alwaysInstalled = async () => ({ installed: true, version: '1.0.0' });
const neverInstalled = async () => ({ installed: false, version: null });

test('capabilities() merges auth/model/reasoning facts via the injectable connectionProbe seam', async () => {
  const registry = new ProductionPmBackendRegistry({
    installedProbe: alwaysInstalled,
    claudeBinary: 'claude',
    openCodeBinary: 'opencode',
    codexBinary: 'codex',
    grokBinary: 'grok',
    connectionProbe: async (product) => (product === 'codex' ? { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: 'ok', nativeDefaultModel: 'gpt-5.6-sol', modelDiscovery: { supported: false, models: null, source: 'none' } } : { authProbe: 'SUPPORTED', authState: 'UNKNOWN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } }),
  });
  const by = new Map((await registry.capabilities()).map((v) => [v.product, v]));
  assert.equal(by.get('codex').authState, 'LOGGED_IN');
  assert.equal(by.get('codex').nativeDefaultModel, 'gpt-5.6-sol');
  assert.equal(typeof by.get('codex').authCheckedAt, 'string');
  assert.equal(by.get('claude-code').authState, 'UNKNOWN');
  assert.deepEqual(by.get('codex').reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal('authReady' in by.get('codex'), false);
});

test('capabilities() never fails the whole call when a custom connectionProbe throws for one backend', async () => {
  const registry = new ProductionPmBackendRegistry({ installedProbe: alwaysInstalled, claudeBinary: 'claude', openCodeBinary: 'opencode', codexBinary: 'codex', grokBinary: 'grok', antigravityBinary: 'agy', connectionProbe: () => { throw new Error('boom'); } });
  const list = await registry.capabilities();
  // P11-R0: six backends now (api added) — 'api' has no CLI, never calls
  // `connectionProbe` at all (see production-pm-backend-registry.mjs's
  // `#buildApiCapability`), so a throwing connectionProbe stub is out of
  // scope for it; the other five CLI-based backends' behavior is unchanged.
  assert.equal(list.length, 6);
  assert.ok(list.filter((v) => v.product !== 'api').every((v) => v.authState === 'ERROR'));
});

test('capabilities() never fails the whole call when a custom installedProbe throws for one backend', async () => {
  const registry = new ProductionPmBackendRegistry({
    claudeBinary: 'claude', openCodeBinary: 'opencode', codexBinary: 'codex', grokBinary: 'grok', antigravityBinary: 'agy',
    installedProbe: async (binary) => { if (binary === 'codex') throw new Error('boom'); return { installed: true, version: '1.0.0' }; },
    connectionProbe: async () => ({ authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } }),
  });
  const by = new Map((await registry.capabilities()).map((v) => [v.product, v]));
  assert.equal(by.get('codex').cliInstalled, false);
  assert.equal(by.get('grok').cliInstalled, true);
});

test('CLI not installed short-circuits the connection probe entirely', async () => {
  let calls = 0;
  const registry = new ProductionPmBackendRegistry({ installedProbe: neverInstalled, claudeBinary: 'missing', openCodeBinary: 'missing', codexBinary: 'missing', grokBinary: 'missing', antigravityBinary: 'missing', connectionProbe: () => { calls += 1; return { authProbe: 'SUPPORTED', authState: 'LOGGED_IN', authDetail: null, nativeDefaultModel: null, modelDiscovery: { supported: false, models: null, source: 'none' } }; } });
  const list = await registry.capabilities();
  assert.equal(calls, 0);
  // P11-R0: 'api' has no CLI at all — `cliInstalled` is honestly `null`
  // (not applicable), never a misleading `false` — see the comment above.
  assert.ok(list.filter((v) => v.product !== 'api').every((v) => v.cliInstalled === false && v.authState === 'UNKNOWN'));
});
