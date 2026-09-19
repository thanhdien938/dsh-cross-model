import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { startFakeOpenAiServer, successFixture, errorStatusFixture } from './lib/fake-openai-server.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';

test('api backend is in the SUPPORTED catalogue as the sixth product, http/STATELESS', () => {
  const registry = new ProductionPmBackendRegistry({ probe: () => true });
  const entry = registry.list().find((v) => v.product === 'api');
  assert.deepEqual(entry, { product: 'api', transport: 'http', session_kind: 'STATELESS' });
});

test('an api PM profile with zero configured providers is available at the registration level, and fails closed per-profile at resolve/decide time', async () => {
  const registry = new ProductionPmBackendRegistry({ probe: () => true });
  const profile = { id: 'api-openrouter-canary', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'openrouter', model: 'openai/gpt-x' };
  assert.equal(registry.inspect(profile).available, true);
  await assert.rejects(registry.resolve(profile, { project: { repo_path: 'C:/p' } }).decide({ turn: 0, request: {}, history: [] }), (e) => e.code === 'API_PROVIDER_CONFIG_INVALID');
});

test('SUCCESS FIXTURE: fake provider response normalizes -> existing strict PM parser -> finish -> task completed, exactly like every CLI backend', async () => {
  const server = await startFakeOpenAiServer(successFixture({ content: '{"type":"finish","output":"api-backend-ok"}' }));
  try {
    const openrouter = { ...validateProviderEntry('openrouter', { protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'DSH_API_OPENROUTER_KEY' }), baseUrl: server.baseUrl };
    const registry = new ProductionPmBackendRegistry({ probe: () => true, apiProviders: { openrouter }, apiEnv: { DSH_API_OPENROUTER_KEY: 'sk-fake' }, apiFetch: fetch });
    const profile = { id: 'api-openrouter-canary', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'openrouter', model: 'openai/gpt-x' };
    const decision = await registry.resolve(profile, { project: { repo_path: 'C:/isolated' } }).decide({ turn: 0, request: {}, history: [] });
    assert.deepEqual(decision, { type: 'finish', output: 'api-backend-ok' });
  } finally {
    await server.close();
  }
});

// ============================================================
// CRITICAL FAILURE CONTAINMENT TEST — P11-R0 hard gate.
// Sequence (per task rule "FAILURE CONTAINMENT TEST — CRITICAL" and
// "BROKEN PROVIDER DOES NOT BREAK APP TEST"):
//   1. API backend configured with a fake provider returning 500.
//   2. API invocation FAILS with typed API_PROVIDER_UNAVAILABLE.
//   3. The SAME registry instance immediately runs an existing (non-API)
//      backend — here Codex, with an injected fixture runner exactly like
//      production-codex-grok-backends.test.mjs already does — and it PASSES.
//   4. A further owner command (another resolve()+decide() call) is
//      accepted — no runtime restart, no global backend-state corruption.
// ============================================================
test('CRITICAL: a 500 from one API provider is contained — DSH/registry stays healthy and every other backend keeps working', async () => {
  const server = await startFakeOpenAiServer(errorStatusFixture(500, 'fixture provider outage'));
  try {
    const openrouter = { ...validateProviderEntry('openrouter', { protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'DSH_API_OPENROUTER_KEY' }), baseUrl: server.baseUrl };
    const codexJson = (text) => [JSON.stringify({ type: 'thread.started', thread_id: 't' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }), JSON.stringify({ type: 'turn.completed', usage: {} })].join('\n');
    const registry = new ProductionPmBackendRegistry({
      probe: () => true,
      codexBinary: 'codex',
      codexRunner: async () => summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"codex-still-fine"}') }),
      apiProviders: { openrouter },
      apiEnv: { DSH_API_OPENROUTER_KEY: 'sk-fake' },
      apiFetch: fetch,
    });

    // 1+2: the API task fails, typed, contained.
    const apiProfile = { id: 'api-openrouter-canary', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'openrouter', model: 'openai/gpt-x' };
    await assert.rejects(
      registry.resolve(apiProfile, { project: { repo_path: 'C:/isolated' } }).decide({ turn: 0, request: {}, history: [] }),
      (e) => e.code === 'API_PROVIDER_UNAVAILABLE',
    );

    // 3: the registry instance is still healthy — an unrelated existing
    // backend (Codex) resolves and completes normally, same instance, no
    // restart, immediately after the API failure above.
    const codexProfile = { id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
    const codexDecision = await registry.resolve(codexProfile, { project: { repo_path: 'C:/isolated' } }).decide({ turn: 0, request: {}, history: [] });
    assert.deepEqual(codexDecision, { type: 'finish', output: 'codex-still-fine' });

    // 4: "submit another owner command" — a further resolve()/decide() call
    // (even against the SAME failed API profile) is still accepted, not
    // refused by any latched/global failure state.
    await assert.rejects(
      registry.resolve(apiProfile, { project: { repo_path: 'C:/isolated' } }).decide({ turn: 0, request: {}, history: [] }),
      (e) => e.code === 'API_PROVIDER_UNAVAILABLE',
    );
    const secondCodexDecision = await registry.resolve(codexProfile, { project: { repo_path: 'C:/isolated' } }).decide({ turn: 0, request: {}, history: [] });
    assert.deepEqual(secondCodexDecision, { type: 'finish', output: 'codex-still-fine' });
  } finally {
    await server.close();
  }
});

// PROVIDER ISOLATION TEST — provider A unhealthy must never mark provider B
// unhealthy (spec: "Do not collapse provider-specific status into one
// global red API state").
test('PROVIDER ISOLATION: provider A failing never affects provider B, same registry instance', async () => {
  const badServer = await startFakeOpenAiServer(errorStatusFixture(500, 'A is down'));
  const goodServer = await startFakeOpenAiServer(successFixture({ content: '{"type":"finish","output":"B-is-fine"}' }));
  try {
    const providerA = { ...validateProviderEntry('provider-a', { protocol: 'openai-chat', base_url: 'https://a.invalid', api_key_env: 'DSH_API_PROVIDER_A_KEY' }), baseUrl: badServer.baseUrl };
    const providerB = { ...validateProviderEntry('provider-b', { protocol: 'openai-chat', base_url: 'https://b.invalid', api_key_env: 'DSH_API_PROVIDER_B_KEY' }), baseUrl: goodServer.baseUrl };
    const registry = new ProductionPmBackendRegistry({ probe: () => true, apiProviders: { 'provider-a': providerA, 'provider-b': providerB }, apiEnv: { DSH_API_PROVIDER_A_KEY: 'ka', DSH_API_PROVIDER_B_KEY: 'kb' }, apiFetch: fetch });
    const profileA = { id: 'a', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'provider-a', model: 'm' };
    const profileB = { id: 'b', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'provider-b', model: 'm' };
    await assert.rejects(registry.resolve(profileA, { project: { repo_path: 'C:/p' } }).decide({ turn: 0, request: {}, history: [] }), (e) => e.code === 'API_PROVIDER_UNAVAILABLE');
    const decisionB = await registry.resolve(profileB, { project: { repo_path: 'C:/p' } }).decide({ turn: 0, request: {}, history: [] });
    assert.deepEqual(decisionB, { type: 'finish', output: 'B-is-fine' });

    const capability = await registry.capability('api');
    assert.equal(capability.dshBackendAvailable, true);
    const providerStatuses = Object.fromEntries(capability.providers.map((p) => [p.id, p.status]));
    assert.equal(providerStatuses['provider-a'], 'KEY_PRESENT');
    assert.equal(providerStatuses['provider-b'], 'KEY_PRESENT');
  } finally {
    await badServer.close();
    await goodServer.close();
  }
});

test('capability("api") reports zero-network CONFIGURED/KEY_PRESENT truth and never claims cliInstalled/dshBackendAvailable false just because no providers are configured', async () => {
  const registry = new ProductionPmBackendRegistry({ probe: () => true });
  const capability = await registry.capability('api');
  assert.equal(capability.dshBackendAvailable, true);
  assert.equal(capability.cliInstalled, null);
  assert.deepEqual(capability.providers, []);
});
