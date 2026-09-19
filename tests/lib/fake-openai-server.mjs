// P11-R0 test helper — a deterministic local fake OpenAI-compatible HTTP
// server. NOT a test file itself (`npm test` only globs `tests/*.mjs`, not
// `tests/lib/*`), so this is safe to import from any P11 test without
// being picked up as its own suite. No live provider/API spending is ever
// needed for the P11 test suite — every fixture below runs against
// `127.0.0.1` only.
import { createServer } from 'node:http';

export async function startFakeOpenAiServer(handler) {
  const requests = [];
  let disconnectCount = 0;
  const server = createServer((req, res) => {
    res.once('close', () => { if (!res.writableEnded) disconnectCount += 1; });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* recorded raw below regardless */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, rawBody: body, body: parsed });
      handler(req, res, body);
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get disconnectCount() { return disconnectCount; },
    close: () => new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export function jsonFixture(status, obj) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
}

export function successFixture({ content = 'ok', model = 'fixture-model', requestId = 'req-fixture-1', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } = {}) {
  return jsonFixture(200, { id: requestId, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
}

export function errorStatusFixture(status, message = 'provider error') {
  return jsonFixture(status, { error: { message, type: 'fixture_error' } });
}

export function malformedJsonFixture() {
  return (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not-valid-json'); };
}

export function emptyBodyFixture() {
  return (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(''); };
}

export function emptyAssistantContentFixture() {
  return jsonFixture(200, { id: 'req-empty', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
}

export function connectionResetFixture() {
  return (req, res) => { req.socket.destroy(); };
}

export function hangFixture() {
  // Deliberately never write a response — the caller's own AbortController
  // (timeout or explicit cancel) is what ends the request.
  return () => {};
}
