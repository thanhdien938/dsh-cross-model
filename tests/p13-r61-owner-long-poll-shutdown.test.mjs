import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerRuntime } from '../src/owner/owner-runtime.mjs';
import { TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';

test('normal drain aborts an in-flight Telegram long poll without failure backoff', async () => {
  let receivedSignal;
  const fetchImpl = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    receivedSignal = signal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const adapter = new TelegramOwnerAdapter({
    token: 'test-token', ownerUserId: '1', ownerChatId: '2', projectId: 'p', service: {}, fetchImpl,
  });
  const failures = [];
  const runtime = new OwnerRuntime({
    adapter,
    notifier: { flush: async () => {} },
    pollIntervalMs: 10,
    notifierIntervalMs: 10,
    backoffMs: 60_000,
    log: (event) => failures.push(event),
  });
  const abort = new AbortController();
  const running = runtime.run({ signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));

  const started = Date.now();
  abort.abort();
  const result = await running;

  assert.equal(receivedSignal, abort.signal);
  assert.equal(result.status, 'STOPPED');
  assert.equal(runtime.running, false);
  assert.equal(failures.length, 0);
  assert.ok(Date.now() - started < 1_000, 'shutdown must not wait for long-poll/backoff timeout');
});
