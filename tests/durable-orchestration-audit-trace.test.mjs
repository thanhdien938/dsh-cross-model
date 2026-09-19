import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { OrchestrationAuditTrace } from '../src/orchestration/orchestration-audit-trace.mjs';
import { DurableOrchestrationAuditTrace } from '../src/orchestration/durable-orchestration-audit-trace.mjs';
import { AuditRepository } from '../src/persistence/repositories/audit-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g6-audit-'));
  const path = join(dir, 'audit.db');
  const stores = [];
  let tick = 0;
  const clock = () => `2026-08-18T00:00:${String(tick++).padStart(2, '0')}.000Z`;
  const open = async () => {
    const store = new SqlitePersistenceStore();
    await store.open({ path });
    await store.migrate();
    stores.push(store);
    return { store, repository: new AuditRepository({ store }) };
  };
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { open, clock };
}

test('new trace starts empty/unsealed and appends exact monotonic sequence', async (t) => {
  const f = await fixture(t);
  const { repository } = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_new', clock: f.clock });
  assert.deepEqual(trace.snapshot(), { traceId: 'trace_new', sealed: false, entries: [] });
  const one = trace.record('one', { n: 1 });
  const two = trace.record('two', { n: 2 });
  assert.deepEqual([one.sequence, two.sequence], [1, 2]);
  assert.deepEqual(trace.snapshot().entries.map((entry) => entry.sequence), [1, 2]);
});

test('close/reopen continues at durable max+1 with no hydration event', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const first = DurableOrchestrationAuditTrace.create({ repository: a.repository, traceId: 'trace_restart', clock: f.clock });
  first.record('one', { value: 1 });
  first.record('two', { value: 2 });
  const before = first.snapshot();
  await a.store.close();
  const b = await f.open();
  const reopened = DurableOrchestrationAuditTrace.open({ repository: b.repository, traceId: 'trace_restart', clock: f.clock });
  assert.deepEqual(reopened.snapshot(), before);
  assert.equal(b.repository.countEntries('trace_restart'), 2);
  assert.equal(reopened.record('three', {}).sequence, 3);
});

test('failed append transaction leaves count/max unchanged and next commit has no gap', async (t) => {
  const f = await fixture(t);
  const base = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository: base.repository, traceId: 'trace_append_fail', clock: f.clock });
  trace.record('one', {});
  const crashingStore = new Proxy(base.store, {
    get(target, prop) {
      if (prop === 'transactionSync') {
        return (fn) => target.transactionSync((ctx) => fn(Object.freeze({
          ...ctx,
          run(sql, params) {
            if (String(sql).startsWith('INSERT INTO audit_entries')) throw new Error('INJECTED_APPEND_FAILURE');
            return ctx.run(sql, params);
          },
        })));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const flaky = DurableOrchestrationAuditTrace.open({ repository: new AuditRepository({ store: crashingStore }), traceId: 'trace_append_fail', clock: f.clock });
  assert.throws(() => flaky.record('failed', {}), /INJECTED_APPEND_FAILURE/);
  assert.equal(base.repository.countEntries('trace_append_fail'), 1);
  assert.equal(base.repository.maxSequence('trace_append_fail'), 1);
  assert.equal(trace.record('two', {}).sequence, 2);
});

test('sanitization parity occurs before storage for keys, token strings, bounds, depth and Errors', async (t) => {
  const f = await fixture(t);
  const { store, repository } = await f.open();
  const durable = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_sanitize', clock: f.clock });
  const legacy = new OrchestrationAuditTrace({ traceId: 'legacy', clock: f.clock });
  const nested = { level: {} };
  let cursor = nested.level;
  for (let index = 0; index < 8; index += 1) { cursor.next = {}; cursor = cursor.next; }
  const payload = {
    authorization: 'Bearer abcdefghijklmnop',
    apiKey: 'sk-super-secret-value',
    nested: { password: 'hunter2' },
    tokenText: 'xai_1234567890abcdef',
    long: 'x'.repeat(900),
    deep: nested,
    error: Object.assign(new Error('safe summary'), { code: 'E_SAFE' }),
  };
  const expected = legacy.record('diagnostic', payload).data;
  const actual = durable.record('diagnostic', payload).data;
  assert.deepEqual(actual, expected);
  const raw = store.get('SELECT data FROM audit_entries WHERE trace_id = ? AND sequence = 1', ['trace_sanitize']).data;
  for (const secret of ['abcdefghijklmnop', 'sk-super-secret-value', 'hunter2', '1234567890abcdef']) assert.equal(raw.includes(secret), false);
  assert.match(raw, /REDACTED/);
  assert.ok(actual.long.length <= 500);
  assert.match(JSON.stringify(actual), /MAX_DEPTH/);
});

test('healthFeedback durable shape matches legacy contract', async (t) => {
  const f = await fixture(t);
  const { repository } = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_health', clock: f.clock });
  const entry = trace.healthFeedback({
    outcome: 'FAILURE_RECORDED', backend: 'grok', classification: 'UPSTREAM_UNAVAILABLE', event: 'agent.failed',
    health: { status: 'UNAVAILABLE' }, ignored: 'not persisted by shape',
  });
  assert.equal(entry.type, 'health.feedback');
  assert.deepEqual(entry.data, {
    outcome: 'FAILURE_RECORDED', backend: 'grok', classification: 'UPSTREAM_UNAVAILABLE', event: 'agent.failed', health: { status: 'UNAVAILABLE' },
  });
});

test('seal atomically appends exactly one final entry and is idempotent', async (t) => {
  const f = await fixture(t);
  const { repository } = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_seal', clock: f.clock });
  trace.record('one', {});
  const first = trace.seal({ status: 'completed' });
  const second = trace.seal({ status: 'ignored' });
  assert.equal(first.sealed, true);
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[1].type, 'trace.sealed');
  assert.deepEqual(second, first);
  assert.equal(repository.countEntries('trace_seal'), 2);
});

test('injected seal failure rolls back both final entry and sealed flag', async (t) => {
  const f = await fixture(t);
  const base = await f.open();
  DurableOrchestrationAuditTrace.create({ repository: base.repository, traceId: 'trace_seal_fail', clock: f.clock }).record('one', {});
  const crashingStore = new Proxy(base.store, {
    get(target, prop) {
      if (prop === 'transactionSync') {
        return (fn) => target.transactionSync((ctx) => fn(Object.freeze({
          ...ctx,
          run(sql, params) {
            if (String(sql).startsWith('UPDATE audit_traces SET sealed')) throw new Error('INJECTED_SEAL_FAILURE');
            return ctx.run(sql, params);
          },
        })));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const flaky = DurableOrchestrationAuditTrace.open({ repository: new AuditRepository({ store: crashingStore }), traceId: 'trace_seal_fail', clock: f.clock });
  assert.throws(() => flaky.seal({ status: 'failed' }), /INJECTED_SEAL_FAILURE/);
  assert.equal(base.repository.countEntries('trace_seal_fail'), 1);
  assert.equal(base.repository.loadTrace('trace_seal_fail').sealed, false);
});

test('sealed reopen is immutable; record and repeated seal add nothing', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository: a.repository, traceId: 'trace_reopen_sealed', clock: f.clock });
  trace.record('one', {});
  trace.seal({ done: true });
  await a.store.close();
  const b = await f.open();
  const reopened = DurableOrchestrationAuditTrace.open({ repository: b.repository, traceId: 'trace_reopen_sealed', clock: f.clock });
  assert.equal(reopened.sealed, true);
  assert.throws(() => reopened.record('later', {}), (error) => error.code === 'AUDIT_TRACE_SEALED');
  const before = b.repository.countEntries('trace_reopen_sealed');
  const poisonous = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('MUST_NOT_SANITIZE'); } });
  assert.doesNotThrow(() => reopened.seal(poisonous));
  assert.throws(() => reopened.record('later', poisonous), (error) => error.code === 'AUDIT_TRACE_SEALED');
  assert.equal(b.repository.countEntries('trace_reopen_sealed'), before);
  assert.equal(b.repository.maxSequence('trace_reopen_sealed'), 2);
});

test('duplicate create and unknown open fail deterministically', async (t) => {
  const f = await fixture(t);
  const { repository } = await f.open();
  DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_identity', clock: f.clock });
  assert.throws(
    () => DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_identity', clock: f.clock }),
    (error) => error.code === 'AUDIT_TRACE_EXISTS',
  );
  assert.throws(
    () => DurableOrchestrationAuditTrace.open({ repository, traceId: 'trace_missing', clock: f.clock }),
    (error) => error.code === 'UNKNOWN_AUDIT_TRACE',
  );
});

test('malformed JSON and impossible sequence history fail closed', async (t) => {
  const f = await fixture(t);
  const { store, repository } = await f.open();
  const jsonTrace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_bad_json', clock: f.clock });
  jsonTrace.record('one', {});
  store.run("UPDATE audit_entries SET data = '{bad' WHERE trace_id = ?", ['trace_bad_json']);
  assert.throws(() => jsonTrace.snapshot(), (error) => error.code === 'CORRUPT_AUDIT_DATA');

  const gapTrace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_gap', clock: f.clock });
  gapTrace.record('one', {}); gapTrace.record('two', {});
  store.run('UPDATE audit_entries SET sequence = 3 WHERE trace_id = ? AND sequence = 2', ['trace_gap']);
  assert.throws(() => gapTrace.snapshot(), (error) => error.code === 'CORRUPT_AUDIT_HISTORY');
});

test('sealed flag/seal-entry mismatch fails closed', async (t) => {
  const f = await fixture(t);
  const { store, repository } = await f.open();
  const trace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'trace_bad_seal', clock: f.clock });
  trace.record('one', {});
  store.run('UPDATE audit_traces SET sealed = 1 WHERE trace_id = ?', ['trace_bad_seal']);
  assert.throws(() => trace.snapshot(), (error) => error.code === 'CORRUPT_AUDIT_HISTORY');
});

test('durable facade and execution consumers contain no audit SQL/SQLite dependency', () => {
  const facade = readFileSync(new URL('../src/orchestration/durable-orchestration-audit-trace.mjs', import.meta.url), 'utf8');
  const consumers = [
    '../src/orchestration/retry-failover-executor.mjs',
    '../src/orchestration/execution-health-feedback.mjs',
    '../src/bus/agent-bus.mjs',
    '../src/workflow/workflow-runner.mjs',
    '../src/peer/peer-relay.mjs',
    '../src/pm/pm-runtime.mjs',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  const forbidden = /from\s+['"][^'"]*(?:sqlite|audit-repository)|(?:SELECT|INSERT|UPDATE|DELETE)[^;\n]*audit_(?:traces|entries)/i;
  assert.doesNotMatch(facade, forbidden);
  assert.doesNotMatch(consumers, forbidden);
});
