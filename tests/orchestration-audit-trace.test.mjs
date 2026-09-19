import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { RetryFailoverExecutor } from '../src/orchestration/retry-failover-executor.mjs';
import { OrchestrationAuditTrace, createAuditHealthFeedbackSink } from '../src/orchestration/orchestration-audit-trace.mjs';

function ok(output) { return { async start() { return { output }; } }; }
function fail(message) { return { async start() { throw new Error(message); } }; }

function setup({ adapters = {}, maxAttempts = 3 } = {}) {
  const registry = new AgentRegistry();
  const events = new EventBus({ onListenerError: () => {} });
  const state = new StateStore();
  const bus = new AgentBus({ registry, events, state });
  const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
  for (const [name, adapter] of Object.entries(adapters)) registry.register(name, adapter);
  const trace = new OrchestrationAuditTrace({ traceId: 'trace_test', clock: () => '2026-08-18T04:00:00.000Z' });
  const feedback = attachExecutionHealthFeedback({
    events,
    healthRegistry: health,
    onFeedback: createAuditHealthFeedbackSink(trace),
  });
  const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, maxAttempts, auditTrace: trace });
  return { registry, events, state, bus, health, trace, feedback, executor };
}

test('audit trace entries have deterministic sequence, trace id, timestamp, and frozen data', () => {
  const trace = new OrchestrationAuditTrace({ traceId: 'trace_alpha', clock: () => '2026-08-18T00:00:00.000Z' });
  const a = trace.record('one', { value: 1 });
  const b = trace.record('two', { nested: { ok: true } });
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  assert.equal(a.traceId, 'trace_alpha');
  assert.equal(a.timestamp, '2026-08-18T00:00:00.000Z');
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(b.data), true);
  assert.equal(Object.isFrozen(b.data.nested), true);
});

test('audit trace redacts sensitive keys and does not store raw secrets', () => {
  const trace = new OrchestrationAuditTrace({ traceId: 'trace_redact' });
  trace.record('diagnostic', {
    authorization: 'Bearer abcdefghijklmnop',
    apiKey: 'sk-super-secret-value',
    nested: { password: 'hunter2' },
  });
  const text = JSON.stringify(trace.snapshot());
  assert.equal(text.includes('hunter2'), false);
  assert.equal(text.includes('sk-super-secret-value'), false);
  assert.equal(text.includes('abcdefghijklmnop'), false);
  assert.match(text, /REDACTED/);
});

test('sealing trace is idempotent and prevents later mutation', () => {
  const trace = new OrchestrationAuditTrace({ traceId: 'trace_seal' });
  trace.record('a', {});
  const first = trace.seal({ status: 'completed' });
  const second = trace.seal({ status: 'ignored' });
  assert.equal(first.entries.length, 2);
  assert.equal(second.entries.length, 2);
  assert.equal(trace.sealed, true);
  assert.throws(() => trace.record('later', {}), /sealed/);
});

test('successful execution emits health feedback before attempt completed and no body is stored', async () => {
  const h = setup({ adapters: { codex: ok('ok') } });
  h.health.recordSuccess('codex');
  await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'TOP_SECRET_TASK_BODY_123' });
  const snapshot = h.trace.snapshot();
  const types = snapshot.entries.map((entry) => entry.type);
  assert.ok(types.indexOf('health.feedback') < types.indexOf('attempt.completed'));
  assert.equal(types.at(-1), 'retry.completed');
  assert.equal(JSON.stringify(snapshot).includes('TOP_SECRET_TASK_BODY_123'), false);
  h.feedback.dispose();
});

test('503 failover trace explains failure, health mutation, reselection, and completion', async () => {
  const h = setup({ adapters: { grok: fail('503 Service temporarily unavailable'), opencode: ok('fallback') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  const out = await h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' });
  assert.equal(out.backend, 'opencode');
  const entries = h.trace.snapshot().entries;
  const types = entries.map((entry) => entry.type);
  assert.deepEqual(types.filter((type) => type === 'selection.made'), ['selection.made', 'selection.made']);
  const failed = entries.find((entry) => entry.type === 'attempt.failed');
  assert.equal(failed.data.backend, 'grok');
  assert.equal(failed.data.classification, 'UPSTREAM_UNAVAILABLE');
  const feedbackIndex = types.indexOf('health.feedback');
  const failedIndex = types.indexOf('attempt.failed');
  const reselectIndex = types.indexOf('failover.reselect');
  assert.ok(feedbackIndex < failedIndex && failedIndex < reselectIndex);
  const selections = entries.filter((entry) => entry.type === 'selection.made');
  assert.equal(selections[0].data.backend, 'grok');
  assert.equal(selections[1].data.backend, 'opencode');
  h.feedback.dispose();
});

test('non-retryable auth failure is traceable and stops without second selection', async () => {
  const h = setup({ adapters: { grok: fail('401 Unauthorized invalid credential'), opencode: ok('unused') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' }),
    (error) => error.code === 'NON_RETRYABLE_FAILURE',
  );
  const entries = h.trace.snapshot().entries;
  assert.equal(entries.filter((entry) => entry.type === 'selection.made').length, 1);
  const stopped = entries.find((entry) => entry.type === 'retry.stopped');
  assert.equal(stopped.data.classification, 'AUTH');
  h.feedback.dispose();
});

test('health feedback sink records ignored ambiguous failure without inventing health mutation', async () => {
  const h = setup({ adapters: { opencode: fail('assertion mismatch in requested task') } });
  h.health.recordSuccess('opencode');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['opencode'] }, body: 'work' }),
    (error) => error.code === 'AMBIGUOUS_FAILURE',
  );
  const feedback = h.trace.snapshot().entries.find((entry) => entry.type === 'health.feedback');
  assert.equal(feedback.data.outcome, 'IGNORED_UNKNOWN');
  assert.equal(feedback.data.health, null);
  h.feedback.dispose();
});

test('audit instrumentation is optional and Gate 11 result semantics remain unchanged', async () => {
  const registry = new AgentRegistry();
  const events = new EventBus({ onListenerError: () => {} });
  const state = new StateStore();
  const bus = new AgentBus({ registry, events, state });
  const health = new BackendHealthRegistry();
  registry.register('codex', ok('ok'));
  health.recordSuccess('codex');
  const feedback = attachExecutionHealthFeedback({ events, healthRegistry: health });
  const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health });
  const out = await executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
  assert.equal(out.status, 'completed');
  assert.equal(out.backend, 'codex');
  assert.equal(out.attempts.length, 1);
  feedback.dispose();
});
