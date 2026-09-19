import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';
import { OwnerRuntime } from '../src/owner/owner-runtime.mjs';

// P14-R0C Part D/E forensic finding: `TelegramOwnerAdapter#send()` used to
// `await this.fetch()` with NO timeout and NO abort signal at all. Every
// `routed.read`/`routed.operation` branch in pollOnce() (including the
// exact `/profiles` path the owner reported hanging) calls `await
// this.send(...)` sequentially and unguarded — a single stalled outbound
// Telegram request therefore blocked pollOnce() forever, and
// OwnerRuntime#run() (owner-runtime.mjs) awaits pollOnce() with no
// per-cycle timeout of its own, so the hang was permanent: no error, no
// backoff, no retry, every subsequent command stopped being processed too.
// These tests prove: (1) a hung send() now throws instead of hanging
// forever, quickly and with a clear message; (2) a normal fast send is
// completely unaffected; (3) the EXISTING at-least-once retry/backoff
// machinery (documented in telegram-owner-client.mjs as "R1-F") already
// recovers correctly once send() actually throws — this fix needed no new
// retry logic, only for something to throw instead of hang forever.

// Matches p13-r61-owner-long-poll-shutdown.test.mjs's established pattern:
// a fetchImpl that only ever settles when its `signal` aborts.
function hangingFetchUntilAbort() {
  return (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    if (!signal) return; // never resolves -- would hang the test too if mis-wired
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), { once: true });
  });
}

function fakeProfilesUpdate(updateId = 1) {
  return { update_id: updateId, message: { from: { id: 1 }, chat: { id: 2 }, text: '/profiles' } };
}

test('sendTimeoutMs is stored, defaults sanely, and rejects invalid overrides (never zero/negative/non-integer)', () => {
  const base = { token: 't', ownerUserId: '1', ownerChatId: '2', service: {}, projectId: 'p' };
  assert.equal(new TelegramOwnerAdapter(base).sendTimeoutMs, 15000);
  assert.equal(new TelegramOwnerAdapter({ ...base, sendTimeoutMs: 5000 }).sendTimeoutMs, 5000);
  for (const invalid of [0, -1, -100, 1.5, NaN, 'x', null]) {
    assert.equal(new TelegramOwnerAdapter({ ...base, sendTimeoutMs: invalid }).sendTimeoutMs, 15000, `invalid sendTimeoutMs ${invalid} must fall back to the default`);
  }
});

test('a hung send() throws a clear timeout error instead of hanging forever', async () => {
  const adapter = new TelegramOwnerAdapter({
    token: 't', ownerUserId: '1', ownerChatId: '2', service: {}, projectId: 'p',
    fetchImpl: hangingFetchUntilAbort(), sendTimeoutMs: 50,
  });
  const start = Date.now();
  await assert.rejects(adapter.send('hello'), (e) => e instanceof Error && e.message.includes('timed out after 50ms'));
  assert.ok(Date.now() - start < 1000, 'must not wait anywhere near real production timeout durations in a test');
});

test('a normal, fast send() still succeeds unaffected by the timeout wiring', async () => {
  let receivedInit;
  const adapter = new TelegramOwnerAdapter({
    token: 't', ownerUserId: '1', ownerChatId: '2', service: {}, projectId: 'p',
    fetchImpl: async (_url, init) => { receivedInit = init; return { ok: true, json: async () => ({ ok: true }) }; },
  });
  await adapter.send('hello');
  assert.ok(receivedInit.signal instanceof AbortSignal, 'send() must still pass an AbortSignal on the ordinary path (defense in depth), not only when a caller happens to hang');
  assert.equal(receivedInit.signal.aborted, false);
});

test('THE EXACT REPORTED SCENARIO: a /profiles command whose response send hangs no longer wedges the whole Telegram loop -- the existing at-least-once retry (R1-F) recovers it', async () => {
  const service = { read: async () => [] };
  const adapter = new TelegramOwnerAdapter({
    token: 't', ownerUserId: '1', ownerChatId: '2', service, projectId: 'p', aliasRegistry: {},
    sendTimeoutMs: 30,
    fetchImpl: async (url, init) => {
      if (String(url).includes('getUpdates')) return { ok: true, json: async () => ({ result: [fakeProfilesUpdate(1)] }) };
      // sendMessage -- the exact hang the owner hit.
      return hangingFetchUntilAbort()(url, init);
    },
  });
  const failures = [];
  const runtime = new OwnerRuntime({
    adapter,
    notifier: { flush: async () => {} },
    pollIntervalMs: 10,
    notifierIntervalMs: 10,
    backoffMs: 10,
    log: (event) => failures.push(event),
  });
  const abort = new AbortController();
  const running = runtime.run({ signal: abort.signal, maxCycles: 3 });
  const result = await Promise.race([
    running,
    new Promise((_r, reject) => setTimeout(() => reject(new Error('TEST TIMEOUT: loop is still wedged -- the defect is NOT fixed')), 5000)),
  ]);
  abort.abort();

  assert.equal(result.status, 'STOPPED');
  // Every cycle hit the hung send() and had to recover via the existing
  // owner_loop_failure/backoff path -- proving the loop survives instead
  // of freezing on cycle 1 forever.
  assert.ok(failures.length >= 1, 'the hung send() must surface as a recovered owner_loop_failure, not silence');
  assert.ok(failures.every((f) => f.stage === 'owner_loop_failure'), 'every logged failure is the documented recovery path, not something else going wrong');
  // The offset must NOT have advanced past the hung update -- R1-F's
  // documented "same update retried" guarantee, unaffected by this fix.
  assert.equal(adapter.offset, 0, 'a permanently-hung send must keep retrying the SAME update (offset never advances), never silently drop it');
});
