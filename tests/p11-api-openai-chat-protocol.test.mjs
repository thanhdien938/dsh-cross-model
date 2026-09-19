import test from 'node:test';
import assert from 'node:assert/strict';
import { sendOpenAiChatCompletion, normalizeChatCompletionResponse } from '../src/pm/api-backend/api-openai-chat-protocol.mjs';
import { ApiBackendError } from '../src/pm/api-backend/api-backend-errors.mjs';
import { startFakeOpenAiServer, successFixture, errorStatusFixture, malformedJsonFixture, emptyBodyFixture, emptyAssistantContentFixture, connectionResetFixture, hangFixture } from './lib/fake-openai-server.mjs';

async function withServer(handler, fn) {
  const server = await startFakeOpenAiServer(handler);
  try { return await fn(server); } finally { await server.close(); }
}

test('a normalized success fixture extracts text/model/requestId/usage', async () => {
  await withServer(successFixture({ content: 'hello from fixture', model: 'gpt-x', requestId: 'req-42', usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } }), async (server) => {
    const result = await sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'sk-test', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fetch });
    assert.equal(result.text, 'hello from fixture');
    assert.equal(result.returnedModel, 'gpt-x');
    assert.equal(result.requestId, 'req-42');
    assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 7, cached_tokens: 'UNKNOWN', total_tokens: 10 });
    assert.deepEqual(result.requestFields, ['messages', 'model', 'stream']);
  });
});

test('runtime-owned authorization and content type override direct caller headers', async () => {
  await withServer(successFixture({ content: 'ok' }), async (server) => {
    await sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'runtime-key', model: 'm', messages: [], headers: { Authorization: 'Bearer attacker', 'Content-Type': 'text/plain' }, fetchImpl: fetch });
    assert.equal(server.requests[0].headers.authorization, 'Bearer runtime-key');
    assert.match(server.requests[0].headers['content-type'], /^application\/json/);
  });
});

test('missing usage is UNKNOWN, never zero', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'r', model: 'm', choices: [{ message: { content: 'ok' } }] })); }, async (server) => {
    const result = await sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch });
    assert.deepEqual(result.usage, { input_tokens: 'UNKNOWN', output_tokens: 'UNKNOWN', cached_tokens: 'UNKNOWN', total_tokens: 'UNKNOWN' });
  });
});

const STATUS_CASES = [
  [400, 'API_REQUEST_INVALID'],
  [401, 'API_AUTH_FAILED'],
  [402, 'API_BILLING_FAILED'],
  [403, 'API_FORBIDDEN'],
  [404, 'API_MODEL_NOT_FOUND'],
  [408, 'API_TIMEOUT'],
  [429, 'API_RATE_LIMITED'],
  [500, 'API_PROVIDER_UNAVAILABLE'],
  [502, 'API_PROVIDER_UNAVAILABLE'],
  [503, 'API_PROVIDER_UNAVAILABLE'],
  [504, 'API_PROVIDER_UNAVAILABLE'],
];
for (const [status, code] of STATUS_CASES) {
  test(`HTTP ${status} maps to typed ${code} and DSH survives the failure`, async () => {
    await withServer(errorStatusFixture(status, 'fixture failure'), async (server) => {
      await assert.rejects(
        sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'sk-test', model: 'm', messages: [], fetchImpl: fetch }),
        (e) => e instanceof ApiBackendError && e.code === code && e.httpStatus === status,
      );
    });
  });
}

test('malformed JSON response is API_RESPONSE_INVALID', async () => {
  await withServer(malformedJsonFixture(), async (server) => {
    await assert.rejects(sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch }), (e) => e instanceof ApiBackendError && e.code === 'API_RESPONSE_INVALID');
  });
});

test('an empty response body is API_EMPTY_RESPONSE', async () => {
  await withServer(emptyBodyFixture(), async (server) => {
    await assert.rejects(sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch }), (e) => e instanceof ApiBackendError && e.code === 'API_EMPTY_RESPONSE');
  });
});

test('a well-formed response with empty assistant content is API_EMPTY_RESPONSE', async () => {
  await withServer(emptyAssistantContentFixture(), async (server) => {
    await assert.rejects(sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch }), (e) => e instanceof ApiBackendError && e.code === 'API_EMPTY_RESPONSE');
  });
});

test('a connection reset before any response is API_NETWORK_ERROR', async () => {
  await withServer(connectionResetFixture(), async (server) => {
    await assert.rejects(sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch }), (e) => e instanceof ApiBackendError && e.code === 'API_NETWORK_ERROR');
  });
});

test('a genuine DNS/connection failure (nothing listening) is API_NETWORK_ERROR, not a raw uncaught throw', async () => {
  await assert.rejects(sendOpenAiChatCompletion({ baseUrl: 'https://127.0.0.1:1', apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch }), (e) => e instanceof ApiBackendError && e.code === 'API_NETWORK_ERROR');
});

test('caller-driven abort is API_CANCELLED', async () => {
  await withServer(hangFixture(), async (server) => {
    const controller = new AbortController();
    const pending = sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl: fetch, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e instanceof ApiBackendError && e.code === 'API_CANCELLED');
  });
});

test('the API key is never present in a thrown error, even when the provider error body echoes it back', async () => {
  const secret = 'sk-super-secret-value-1234';
  await withServer(jsonEchoFixture(secret), async (server) => {
    try {
      await sendOpenAiChatCompletion({ baseUrl: server.baseUrl, apiKey: secret, model: 'm', messages: [], fetchImpl: fetch });
      assert.fail('expected to throw');
    } catch (error) {
      const serialized = JSON.stringify({ message: error.message, ...error });
      assert.equal(serialized.includes(secret), false);
    }
  });
});
function jsonEchoFixture(secret) {
  return (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `invalid key used: Bearer ${secret}` } })); };
}

test('normalizeChatCompletionResponse rejects a non-object body', () => {
  assert.throws(() => normalizeChatCompletionResponse(null), (e) => e instanceof ApiBackendError && e.code === 'API_RESPONSE_INVALID');
  assert.throws(() => normalizeChatCompletionResponse('a string'), (e) => e instanceof ApiBackendError && e.code === 'API_RESPONSE_INVALID');
});
