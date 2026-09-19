import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { DurableOrchestrationAuditTrace } from '../src/orchestration/durable-orchestration-audit-trace.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { RetryFailoverExecutor } from '../src/orchestration/retry-failover-executor.mjs';
import { AuditRepository } from '../src/persistence/repositories/audit-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function ok(output, calls) {
  return { async start() { calls.push(output); return { output }; } };
}

function fail(message, calls, name) {
  return { async start() { calls.push(name); throw new Error(message); } };
}

function throwingTrace(types = null) {
  const observed = [];
  return {
    observed,
    record(type) {
      observed.push(type);
      if (types === null || types.has(type)) throw new Error(`AUDIT_FAILURE:${type}`);
    },
  };
}

function setup({ adapters, auditTrace = null, maxAttempts = 3 } = {}) {
  const registry = new AgentRegistry();
  const events = new EventBus({ onListenerError: () => {} });
  const bus = new AgentBus({ registry, events, state: new StateStore() });
  const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
  for (const [name, adapter] of Object.entries(adapters)) {
    registry.register(name, adapter);
    health.recordSuccess(name);
  }
  const feedback = attachExecutionHealthFeedback({ events, healthRegistry: health });
  const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, maxAttempts, auditTrace });
  return { executor, health, feedback };
}

test('retry.started audit failure cannot prevent selection, dispatch, or completion', async () => {
  const calls = [];
  const audit = throwingTrace(new Set(['retry.started']));
  const h = setup({ adapters: { codex: ok('done', calls) }, auditTrace: audit });
  const result = await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
  assert.equal(result.status, 'completed');
  assert.equal(result.backend, 'codex');
  assert.deepEqual(calls, ['done']);
  assert.ok(audit.observed.includes('selection.made'));
  h.feedback.dispose();
});

test('all successful-path audit failures leave the successful result unchanged', async () => {
  const calls = [];
  const audit = throwingTrace(new Set(['selection.made', 'attempt.started', 'attempt.completed', 'retry.completed']));
  const h = setup({ adapters: { codex: ok('same-result', calls) }, auditTrace: audit });
  const result = await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
  assert.equal(result.status, 'completed');
  assert.equal(result.backend, 'codex');
  assert.equal(result.result.output, 'same-result');
  assert.deepEqual(result.attempts.map(({ backend, status }) => ({ backend, status })), [{ backend: 'codex', status: 'completed' }]);
  h.feedback.dispose();
});

for (const failingType of ['attempt.failed', 'failover.reselect']) {
  test(`${failingType} audit failure cannot prevent retry reselection`, async () => {
    const calls = [];
    const audit = throwingTrace(new Set([failingType]));
    const h = setup({
      adapters: {
        grok: fail('503 Service temporarily unavailable', calls, 'grok'),
        opencode: ok('fallback', calls),
      },
      auditTrace: audit,
    });
    const result = await h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' });
    assert.equal(result.status, 'completed');
    assert.equal(result.backend, 'opencode');
    assert.equal(result.result.output, 'fallback');
    assert.deepEqual(calls, ['grok', 'fallback']);
    h.feedback.dispose();
  });
}

for (const [message, expectedCode] of [
  ['401 Unauthorized invalid credential', 'NON_RETRYABLE_FAILURE'],
  ['unclassified application assertion', 'AMBIGUOUS_FAILURE'],
]) {
  test(`retry.stopped audit failure preserves ${expectedCode}`, async () => {
    const calls = [];
    const h = setup({ adapters: { codex: fail(message, calls, 'codex') }, auditTrace: throwingTrace(new Set(['retry.stopped'])) });
    await assert.rejects(
      () => h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' }),
      (error) => error.code === expectedCode && !String(error.message).includes('AUDIT_FAILURE'),
    );
    h.feedback.dispose();
  });
}

test('retry.exhausted audit failure preserves RETRY_EXHAUSTED', async () => {
  const calls = [];
  const h = setup({
    adapters: { codex: fail('503 Service temporarily unavailable', calls, 'codex') },
    auditTrace: throwingTrace(new Set(['retry.exhausted'])),
    maxAttempts: 1,
  });
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' }),
    (error) => error.code === 'RETRY_EXHAUSTED' && !String(error.message).includes('AUDIT_FAILURE'),
  );
  h.feedback.dispose();
});

async function withDurableTrace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-isolation-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'audit.db') });
    await store.migrate();
    const repository = new AuditRepository({ store });
    await fn({ store, repository });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sealed durable audit rejection remains observational during execution', async () => {
  await withDurableTrace(async ({ repository }) => {
    const trace = DurableOrchestrationAuditTrace.create({ repository, traceId: 'sealed_trace' });
    trace.seal({ done: true });
    const calls = [];
    const h = setup({ adapters: { codex: ok('done', calls) }, auditTrace: trace });
    const result = await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
    assert.equal(result.status, 'completed');
    assert.equal(result.backend, 'codex');
    assert.deepEqual(calls, ['done']);
    assert.equal(trace.snapshot().entries.length, 1);
    h.feedback.dispose();
  });
});

test('durable repository write failure cannot mutate routing or execution outcome', async () => {
  await withDurableTrace(async ({ store, repository }) => {
    DurableOrchestrationAuditTrace.create({ repository, traceId: 'write_failure' });
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'transactionSync') return () => { throw new Error('INJECTED_AUDIT_WRITE_FAILURE'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const trace = DurableOrchestrationAuditTrace.open({
      repository: new AuditRepository({ store: failingStore }),
      traceId: 'write_failure',
    });
    const calls = [];
    const h = setup({ adapters: { codex: ok('baseline', calls) }, auditTrace: trace });
    const healthBefore = h.health.snapshot();
    const result = await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
    assert.equal(result.status, 'completed');
    assert.equal(result.backend, 'codex');
    assert.equal(result.result.output, 'baseline');
    assert.deepEqual(calls, ['baseline']);
    assert.equal(repository.countEntries('write_failure'), 0);
    assert.equal(healthBefore.codex.status, 'HEALTHY');
    assert.equal(h.health.snapshot().codex.status, 'HEALTHY');
    h.feedback.dispose();
  });
});
