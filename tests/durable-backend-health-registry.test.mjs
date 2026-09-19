import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventBus } from '../src/bus/event-bus.mjs';
import {
  BACKEND_FAILURE_CLASSIFICATION,
  BACKEND_HEALTH_STATUS,
} from '../src/orchestration/backend-health-registry.mjs';
import { DurableBackendHealthRegistry } from '../src/orchestration/durable-backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { selectBackendWithHealth } from '../src/orchestration/health-aware-selector.mjs';
import { HealthRepository } from '../src/persistence/repositories/health-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

async function fixture(t, { start = Date.parse('2026-08-18T00:00:00.000Z'), freshnessMs = 1_000, cooldownMs = 500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g5-health-'));
  const path = join(dir, 'health.db');
  let now = start;
  const stores = [];
  const open = async () => {
    const store = new SqlitePersistenceStore();
    await store.open({ path });
    await store.migrate();
    stores.push(store);
    const repository = new HealthRepository({ store });
    const registry = new DurableBackendHealthRegistry({ repository, clock: () => now, freshnessMs, cooldownMs });
    return { store, repository, registry };
  };
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { open, advance(ms) { now += ms; }, setNow(value) { now = value; }, now: () => now };
}

test('fresh HEALTHY and DEGRADED survive reopen with the same observation and revision', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const healthy = a.registry.recordSuccess('codex', { diagnostic: 'real completion' });
  const degraded = a.registry.recordSuccess('grok', { degraded: true });
  await a.store.close();
  f.advance(999);
  const b = await f.open();
  assert.deepEqual(b.registry.get('codex'), healthy);
  assert.deepEqual(b.registry.get('grok'), degraded);
  assert.equal(healthy.revision, 1);
  assert.equal(degraded.revision, 1);
});

test('stale HEALTHY and DEGRADED materialize UNKNOWN without rewriting raw evidence or revision', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const healthy = a.registry.recordSuccess('codex');
  const degraded = a.registry.recordSuccess('grok', { degraded: true });
  f.advance(1_000);
  assert.equal(a.registry.get('codex').status, BACKEND_HEALTH_STATUS.UNKNOWN);
  assert.equal(a.registry.get('grok').status, BACKEND_HEALTH_STATUS.UNKNOWN);
  assert.deepEqual(a.repository.getRaw('codex'), healthy);
  assert.deepEqual(a.repository.getRaw('grok'), degraded);
  assert.equal(a.repository.getRaw('codex').revision, 1);
});

test('retryable UNAVAILABLE survives active cooldown then expires to UNKNOWN, never HEALTHY', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const failed = a.registry.recordFailure('opencode', {
    classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
  });
  await a.store.close();
  f.advance(499);
  const b = await f.open();
  assert.equal(b.registry.get('opencode').status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
  f.advance(1);
  const expired = b.registry.get('opencode');
  assert.equal(expired.status, BACKEND_HEALTH_STATUS.UNKNOWN);
  assert.notEqual(expired.status, BACKEND_HEALTH_STATUS.HEALTHY);
  assert.deepEqual(b.repository.getRaw('opencode'), failed);
});

test('AUTH, CONFIG and PROTOCOL stay sticky across long restart until real success', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  a.registry.recordFailure('codex', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH });
  a.registry.recordFailure('claude-code', { classification: BACKEND_FAILURE_CLASSIFICATION.CONFIG });
  a.registry.recordFailure('grok', { classification: BACKEND_FAILURE_CLASSIFICATION.PROTOCOL });
  await a.store.close();
  f.advance(365 * 24 * 60 * 60 * 1_000);
  const b = await f.open();
  for (const backend of ['codex', 'claude-code', 'grok']) {
    assert.equal(b.registry.get(backend).status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
    assert.equal(b.registry.get(backend).revision, 1);
    const success = b.registry.recordSuccess(backend);
    assert.equal(success.status, BACKEND_HEALTH_STATUS.HEALTHY);
    assert.equal(success.revision, 2);
  }
});

test('brand-new facade returns UNKNOWN and hydration creates no rows or success feedback', async (t) => {
  const f = await fixture(t);
  const { registry, repository } = await f.open();
  const feedback = [];
  const events = new EventBus();
  const sub = attachExecutionHealthFeedback({ events, healthRegistry: registry, onFeedback: (item) => feedback.push(item) });
  assert.deepEqual(Object.values(registry.snapshot()).map((entry) => entry.status), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.equal(repository.count(), 0);
  assert.deepEqual(feedback, []);
  sub.dispose();
});

test('execution feedback persists completed/recognized failure and ignores unknown/cancelled', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const events = new EventBus();
  attachExecutionHealthFeedback({ events, healthRegistry: a.registry });
  events.emit('agent.completed', { agent: 'codex' });
  assert.equal(a.repository.getRaw('codex').status, BACKEND_HEALTH_STATUS.HEALTHY);
  events.emit('agent.failed', { agent: 'codex', error: { message: 'HTTP 429 rate limit exceeded' } });
  const failed = a.repository.getRaw('codex');
  assert.equal(failed.classification, BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT);
  assert.equal(failed.revision, 2);
  events.emit('agent.failed', { agent: 'codex', error: { message: 'task assertion mismatch' } });
  events.emit('agent.cancelled', { agent: 'codex' });
  assert.deepEqual(a.repository.getRaw('codex'), failed);
  await a.store.close();
  const b = await f.open();
  assert.deepEqual(b.repository.getRaw('codex'), failed);
});

test('failed success/failure writes expose no uncommitted state and do not increment revision', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const before = a.registry.recordSuccess('opencode');
  const crashingStore = new Proxy(a.store, {
    get(target, prop) {
      if (prop === 'transactionSync') {
        return (fn) => target.transactionSync((ctx) => fn(Object.freeze({
          ...ctx,
          run(sql, params) {
            if (String(sql).includes('INSERT INTO backend_health')) throw new Error('INJECTED_HEALTH_WRITE_FAILURE');
            return ctx.run(sql, params);
          },
        })));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const flaky = new DurableBackendHealthRegistry({
    repository: new HealthRepository({ store: crashingStore }),
    clock: f.now,
    freshnessMs: 1_000,
    cooldownMs: 500,
  });
  assert.throws(() => flaky.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH }), /INJECTED_HEALTH_WRITE_FAILURE/);
  assert.deepEqual(a.repository.getRaw('opencode'), before);
  assert.throws(() => flaky.recordSuccess('opencode', { degraded: true }), /INJECTED_HEALTH_WRITE_FAILURE/);
  assert.deepEqual(flaky.get('opencode'), before);
});

test('health-aware selector consumes only the materialized durable snapshot', async (t) => {
  const f = await fixture(t);
  const { registry } = await f.open();
  registry.recordSuccess('opencode');
  registry.recordSuccess('grok', { degraded: true });
  assert.equal(selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['grok'] }, registry.snapshot()).backend, 'opencode');
  f.advance(1_000);
  assert.throws(
    () => selectBackendWithHealth({ requires: ['interrupt_active_turn'] }, registry.snapshot()),
    (error) => error.code === 'NO_USABLE_BACKEND',
  );
  registry.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH });
  assert.throws(
    () => selectBackendWithHealth({ requires: ['concurrent_client_safe'] }, registry.snapshot()),
    (error) => error.code === 'NO_USABLE_BACKEND' && error.health.opencode.status === BACKEND_HEALTH_STATUS.UNAVAILABLE,
  );
});

test('HealthRepository is the only new health-domain SQL owner', () => {
  const facade = readFileSync(new URL('../src/orchestration/durable-backend-health-registry.mjs', import.meta.url), 'utf8');
  const consumers = [
    '../src/orchestration/execution-health-feedback.mjs',
    '../src/orchestration/health-aware-selector.mjs',
    '../src/bus/agent-bus.mjs',
    '../src/workflow/workflow-runner.mjs',
    '../src/peer/peer-relay.mjs',
    '../src/orchestration/retry-failover-executor.mjs',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(facade, /sqlite|SELECT |INSERT INTO|UPDATE backend_health|DELETE FROM/i);
  assert.doesNotMatch(consumers, /from\s+['"][^'"]*(?:sqlite|health-repository)|(?:SELECT|INSERT|UPDATE|DELETE)[^;\n]*backend_health/i);
});
