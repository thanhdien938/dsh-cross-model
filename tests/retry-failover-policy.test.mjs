import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import {
  RetryFailoverExecutor,
  RetryFailoverError,
  isRetryableClassification,
} from '../src/orchestration/retry-failover-executor.mjs';
import { BACKEND_FAILURE_CLASSIFICATION } from '../src/orchestration/backend-health-registry.mjs';

function setup({ adapters = {}, maxAttempts = 3 } = {}) {
  const registry = new AgentRegistry();
  const events = new EventBus({ onListenerError: () => {} });
  const state = new StateStore();
  const bus = new AgentBus({ registry, events, state });
  const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
  for (const [name, adapter] of Object.entries(adapters)) registry.register(name, adapter);
  const feedback = attachExecutionHealthFeedback({ events, healthRegistry: health });
  const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, maxAttempts });
  return { registry, events, state, bus, health, feedback, executor };
}

function ok(output) {
  return { async start() { return { output }; } };
}
function fail(message) {
  return { async start() { throw new Error(message); } };
}

test('retryable classification set is exactly Gate 9 retryable infrastructure classes', () => {
  for (const value of [
    BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
    BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
    BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
    BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
  ]) assert.equal(isRetryableClassification(value), true);
  for (const value of [
    BACKEND_FAILURE_CLASSIFICATION.AUTH,
    BACKEND_FAILURE_CLASSIFICATION.CONFIG,
    BACKEND_FAILURE_CLASSIFICATION.PROTOCOL,
    BACKEND_FAILURE_CLASSIFICATION.UNKNOWN_FAILURE,
  ]) assert.equal(isRetryableClassification(value), false);
});

test('retryable 503 fails over to next healthy eligible backend', async () => {
  const h = setup({ adapters: { grok: fail('503 Service temporarily unavailable'), opencode: ok('fallback-ok') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  const out = await h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' });
  assert.equal(out.backend, 'opencode');
  assert.deepEqual(out.attempts.map((a) => [a.backend, a.status]), [['grok', 'failed'], ['opencode', 'completed']]);
  assert.equal(out.attempts[0].classification, BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE);
  h.feedback.dispose();
});

test('429, timeout, and transient transport permit bounded failover', async () => {
  for (const message of ['429 Too Many Requests', 'ETIMEDOUT', 'ECONNRESET']) {
    const h = setup({ adapters: { grok: fail(message), opencode: ok('ok') } });
    h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
    const out = await h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' });
    assert.equal(out.backend, 'opencode');
    assert.equal(out.attempts.length, 2);
    h.feedback.dispose();
  }
});

test('AUTH failure stops immediately and does not fail over', async () => {
  const h = setup({ adapters: { grok: fail('401 Unauthorized invalid credential'), opencode: ok('must-not-run') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' }),
    (error) => error instanceof RetryFailoverError && error.code === 'NON_RETRYABLE_FAILURE' && error.attempts.length === 1,
  );
  assert.equal(h.bus.listRuns({ agent: 'opencode' }).length, 0);
  h.feedback.dispose();
});

test('CONFIG and PROTOCOL failures stop immediately', async () => {
  for (const message of ['ENOENT executable not found', 'JSON-RPC protocol error invalid schema']) {
    const h = setup({ adapters: { grok: fail(message), opencode: ok('must-not-run') } });
    h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
    await assert.rejects(
      () => h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' }),
      (error) => error.code === 'NON_RETRYABLE_FAILURE' && error.attempts.length === 1,
    );
    h.feedback.dispose();
  }
});

test('ambiguous task failure stops and is never retried', async () => {
  const h = setup({ adapters: { grok: fail('assertion mismatch in requested task'), opencode: ok('must-not-run') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' }),
    (error) => error.code === 'AMBIGUOUS_FAILURE' && error.attempts[0].classification === null,
  );
  assert.equal(h.bus.listRuns({ agent: 'opencode' }).length, 0);
  h.feedback.dispose();
});

test('maxAttempts bounds retry chain', async () => {
  const h = setup({ adapters: { grok: fail('503 Service unavailable'), opencode: fail('429 rate limit') }, maxAttempts: 2 });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' }),
    (error) => error.code === 'RETRY_EXHAUSTED' && error.attempts.length === 2,
  );
  h.feedback.dispose();
});

test('fresh health snapshot is used after each failure', async () => {
  const h = setup({ adapters: { grok: fail('503 Service unavailable'), opencode: ok('ok') } });
  h.health.recordSuccess('grok'); h.health.recordSuccess('opencode');
  const out = await h.executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'work' });
  assert.equal(h.health.get('grok').status, 'UNAVAILABLE');
  assert.equal(out.attempts[1].backend, 'opencode');
  h.feedback.dispose();
});

test('capability gate is preserved during failover', async () => {
  const h = setup({ adapters: { opencode: fail('503 Service unavailable'), grok: ok('not-capable-for-concurrency') } });
  h.health.recordSuccess('opencode'); h.health.recordSuccess('grok');
  await assert.rejects(
    () => h.executor.execute({ selector: { requires: ['concurrent_client_safe'] }, body: 'work' }),
    (error) => error.code === 'NO_USABLE_BACKEND' && error.attempts.length === 1,
  );
  assert.equal(h.bus.listRuns({ agent: 'grok' }).length, 0);
  h.feedback.dispose();
});

test('success completes without unnecessary retry', async () => {
  const h = setup({ adapters: { codex: ok('first-ok'), 'claude-code': ok('unused') } });
  h.health.recordSuccess('codex'); h.health.recordSuccess('claude-code');
  const out = await h.executor.execute({ selector: { requires: ['resume_existing'], prefer: ['codex'] }, body: 'work' });
  assert.equal(out.backend, 'codex');
  assert.equal(out.attempts.length, 1);
  h.feedback.dispose();
});

test('pre-aborted signal returns cancelled without dispatch', async () => {
  const h = setup({ adapters: { codex: ok('unused') } });
  h.health.recordSuccess('codex');
  const controller = new AbortController(); controller.abort();
  const out = await h.executor.execute({ selector: { requires: ['resume_existing'] }, body: 'work', signal: controller.signal });
  assert.equal(out.status, 'cancelled');
  assert.equal(out.attempts.length, 0);
  assert.equal(h.bus.listRuns().length, 0);
  h.feedback.dispose();
});

test('attempt records and result are frozen audit data', async () => {
  const h = setup({ adapters: { codex: ok('ok') } });
  h.health.recordSuccess('codex');
  const out = await h.executor.execute({ selector: { requires: ['resume_existing'] }, body: 'work' });
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.attempts), true);
  assert.equal(Object.isFrozen(out.attempts[0]), true);
  h.feedback.dispose();
});
