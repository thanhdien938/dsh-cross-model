import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverApiProviderModels, normalizeOpenRouterModel, MODEL_DISCOVERY_LIMIT } from '../src/pm/api-backend/api-model-discovery.mjs';
import { translateReasoningForProvider } from '../src/pm/api-backend/api-reasoning-translation.mjs';

const entry = { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'DSH_API_OPENROUTER_KEY', headers: {} };

test('normalizes a bounded safe OpenRouter model contract', () => {
  const model = normalizeOpenRouterModel({ id: 'openai/example', name: 'Example', context_length: 123, pricing: { prompt: '0.1' }, supported_parameters: ['reasoning', 'tools'], created: 1, secret: 'must-not-pass' });
  assert.deepEqual(Object.keys(model), ['id', 'name', 'family', 'contextLength', 'pricing', 'supportedParameters', 'created', 'reasoningSupport', 'reasoningOptions']);
  assert.equal(model.reasoningSupport, 'SUPPORTED');
  assert.equal(JSON.stringify(model).includes('must-not-pass'), false);
});

test('fetches /models only through trusted runtime and bounds results', async () => {
  let request;
  const result = await discoverApiProviderModels(entry, { env: { DSH_API_OPENROUTER_KEY: 'test-secret' }, fetchImpl: async (url, init) => { request = { url, init }; return { ok: true, status: 200, json: async () => ({ data: Array.from({ length: MODEL_DISCOVERY_LIMIT + 10 }, (_, i) => ({ id: `vendor/model-${i}` })) }) }; } });
  assert.equal(result.ok, true); assert.equal(result.models.length, MODEL_DISCOVERY_LIMIT);
  assert.equal(request.url, 'https://openrouter.ai/api/v1/models'); assert.equal(request.init.method, 'GET'); assert.equal('body' in request.init, false);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('missing key and HTTP failure are safe typed failures', async () => {
  const missing = await discoverApiProviderModels(entry, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.deepEqual(missing, { ok: false, code: 'API_SECRET_MISSING', message: 'OpenRouter key is missing' });
  const failed = await discoverApiProviderModels(entry, { env: { DSH_API_OPENROUTER_KEY: 'x' }, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(failed.ok, false); assert.equal(failed.httpStatus, 503);
});

test('deferred providers cannot be discovered', async () => {
  const result = await discoverApiProviderModels({ ...entry, id: 'deepseek' }, { env: { DSH_API_OPENROUTER_KEY: 'x' } });
  assert.equal(result.code, 'API_MODEL_DISCOVERY_DEFERRED');
});

test('OpenRouter reasoning translation is provider/model-capability gated', () => {
  assert.deepEqual(translateReasoningForProvider('openrouter', { supports_reasoning_effort: true }, 'high'), { reasoning: { effort: 'high' } });
  assert.deepEqual(translateReasoningForProvider('openrouter', { supports_reasoning_effort: false }, 'high'), {});
  assert.deepEqual(translateReasoningForProvider('openrouter', { supports_reasoning_effort: true }, null), {});
});
