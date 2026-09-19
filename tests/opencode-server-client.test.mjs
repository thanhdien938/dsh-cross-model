import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeServerClient } from '../src/session/opencode-server-client.mjs';

function fakeFetchFactory(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const key = `${options.method ?? 'GET'} ${new URL(url).pathname}`;
    const value = routes.get(key);
    if (value instanceof Response) return value;
    return new Response(value === undefined ? '' : JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

test('session helpers map to documented HTTP routes', async () => {
  const routes = new Map([
    ['GET /global/health', { healthy: true, version: '1.18.18' }],
    ['POST /session', { id: 'ses_1' }],
    ['POST /session/ses_1/prompt_async', null],
    ['POST /session/ses_1/abort', true],
    ['GET /session/status', { ses_1: { type: 'idle' } }],
    ['GET /session/ses_1/message', []],
  ]);
  const { fetchImpl, calls } = fakeFetchFactory(routes);
  const client = new OpenCodeServerClient({ baseUrl: 'http://127.0.0.1:4096/', fetchImpl });
  assert.equal((await client.health()).healthy, true);
  assert.equal((await client.createSession({ title: 'x' })).id, 'ses_1');
  await client.promptAsync('ses_1', { parts: [{ type: 'text', text: 'hello' }] });
  assert.equal(await client.abort('ses_1'), true);
  assert.deepEqual(await client.sessionStatus(), { ses_1: { type: 'idle' } });
  assert.deepEqual(await client.listMessages('ses_1'), []);
  assert.equal(calls[2].options.body, JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }));
});

test('HTTP errors are surfaced without fabricated success', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'bad' }), { status: 500 });
  const client = new OpenCodeServerClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  await assert.rejects(() => client.health(), (error) => error.code === 'OPENCODE_SERVER_HTTP_ERROR' && error.status === 500);
});

test('event subscriber parses JSON SSE data frames', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"session.status","properties":{"sessionID":"ses_1"}}\n\n'));
      controller.close();
    },
  });
  const fetchImpl = async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const client = new OpenCodeServerClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const seen = [];
  await client.subscribeEvents((event) => seen.push(event));
  assert.deepEqual(seen.map((event) => event.type), ['server.connected', 'session.status']);
});

test('aborting an event subscription cancels a pending SSE reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const fetchImpl = async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const client = new OpenCodeServerClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const controller = new AbortController();
  const subscription = client.subscribeEvents(() => {}, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await subscription;
  assert.equal(cancelled, true);
});
