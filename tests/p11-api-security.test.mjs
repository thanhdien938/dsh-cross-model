import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretValues, redactHeaders, redactObjectDeep, safeProviderDetail } from '../src/pm/api-backend/api-redaction.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { startFakeOpenAiServer, errorStatusFixture } from './lib/fake-openai-server.mjs';

test('redactSecretValues removes an exact known secret value wherever it appears', () => {
  const out = redactSecretValues('token=sk-abc123def456 in request', ['sk-abc123def456']);
  assert.equal(out.includes('sk-abc123def456'), false);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecretValues defense-in-depth catches an Authorization/Bearer pattern even without the exact secret listed', () => {
  const out = redactSecretValues('Authorization: Bearer some-unknown-token-value', []);
  assert.equal(out.includes('some-unknown-token-value'), false);
});

test('redactSecretValues never touches unrelated short substrings', () => {
  assert.equal(redactSecretValues('the model is gpt-x', ['gp']), 'the model is gpt-x');
});

test('redactHeaders masks Authorization/api-key-shaped header names but preserves everything else', () => {
  const out = redactHeaders({ Authorization: 'Bearer sk-live', 'X-OpenRouter-Title': 'DSH', 'x-api-key': 'sk-other' });
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out['x-api-key'], '[REDACTED]');
  assert.equal(out['X-OpenRouter-Title'], 'DSH');
});

test('redactObjectDeep masks sensitive key names recursively without touching unrelated content', () => {
  const out = redactObjectDeep({ ok: true, nested: { apiKey: 'sk-x', task: 'do the thing' }, headers: { Authorization: 'Bearer y' } });
  assert.equal(out.nested.apiKey, '[REDACTED]');
  assert.equal(out.nested.task, 'do the thing');
  assert.equal(out.headers.Authorization, '[REDACTED]');
});

test('safeProviderDetail bounds length so a pathological body cannot balloon a diagnostic event', () => {
  const huge = 'x'.repeat(10000);
  assert.ok(safeProviderDetail(huge).length <= 401);
});

// End-to-end: a real (fake-server) 401 failure's thrown error — the exact
// object that would flow into a BackendExecutionObserver 'terminal' event,
// Telegram error text, Desktop diagnostics, and repository-history
// ExecutionLog.md — must never carry the raw key, even serialized whole.
test('END TO END: an API key never appears in ANY surface reachable from a real failure — observer events, thrown error, JSON serialization', async () => {
  const secret = 'sk-owner-real-secret-abcdef123456';
  const server = await startFakeOpenAiServer(errorStatusFixture(401, `rejected key Bearer ${secret}`));
  try {
    const openrouter = { ...validateProviderEntry('openrouter', { protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'DSH_API_OPENROUTER_KEY' }), baseUrl: server.baseUrl };
    const events = [];
    const observer = { start() {}, parser() {}, terminal(ctx, payload) { events.push(['terminal', ctx, payload]); }, stdoutSummary() {}, apiUsage(ctx, payload) { events.push(['apiUsage', ctx, payload]); } };
    const registry = new ProductionPmBackendRegistry({ probe: () => true, observer, apiProviders: { openrouter }, apiEnv: { DSH_API_OPENROUTER_KEY: secret }, apiFetch: fetch });
    const profile = { id: 'api-openrouter-canary', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'openrouter', model: 'openai/gpt-x' };
    let thrown = null;
    try {
      await registry.resolve(profile, { project: { repo_path: 'C:/p' } }).decide({ turn: 0, request: {}, history: [] });
      assert.fail('expected the 401 to reject');
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown.code, 'API_AUTH_FAILED');
    const errorSerialized = JSON.stringify(Object.assign({ message: thrown.message }, thrown));
    assert.equal(errorSerialized.includes(secret), false);
    const eventsSerialized = JSON.stringify(events);
    assert.equal(eventsSerialized.includes(secret), false);
  } finally {
    await server.close();
  }
});

test('SECRET NOT REQUIRED FOR STARTUP: constructing the registry with zero env keys and zero provider config never throws', () => {
  assert.doesNotThrow(() => new ProductionPmBackendRegistry({ probe: () => true }));
});
