import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKEND_FAILURE_CLASSIFICATION,
  BACKEND_HEALTH_STATUS,
  BackendHealthRegistry,
} from '../src/orchestration/backend-health-registry.mjs';
import { selectBackendWithHealth } from '../src/orchestration/health-aware-selector.mjs';
import { createHealthAwarePmDriver, resolveHealthAwareDecision } from '../src/orchestration/health-aware-pm-driver.mjs';

function registryAt(start = 1_000, cooldownMs = 1_000) {
  let now = start;
  const registry = new BackendHealthRegistry({ clock: () => now, cooldownMs });
  return { registry, advance(ms) { now += ms; } };
}

function healthy(registry, ...backends) {
  for (const backend of backends) registry.recordSuccess(backend);
}

test('all known backends are UNKNOWN initially', () => {
  const { registry } = registryAt();
  const snapshot = registry.snapshot();
  assert.deepEqual(Object.values(snapshot).map((entry) => entry.status), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
});

test('success records HEALTHY and degraded success records DEGRADED', () => {
  const { registry } = registryAt();
  assert.equal(registry.recordSuccess('codex').status, BACKEND_HEALTH_STATUS.HEALTHY);
  assert.equal(registry.recordSuccess('grok', { degraded: true }).status, BACKEND_HEALTH_STATUS.DEGRADED);
});

test('retryable upstream failure is unavailable during cooldown then UNKNOWN, never auto healthy', () => {
  const { registry, advance } = registryAt(10_000, 500);
  const failed = registry.recordFailure('opencode', {
    classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
    diagnostic: '503 Service temporarily unavailable',
  });
  assert.equal(failed.status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
  assert.equal(failed.retryable, true);
  assert.equal(registry.get('opencode').status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
  advance(500);
  assert.equal(registry.get('opencode').status, BACKEND_HEALTH_STATUS.UNKNOWN);
});

test('rate-limit and timeout use retryable cooldown semantics', () => {
  const { registry, advance } = registryAt(0, 50);
  registry.recordFailure('codex', { classification: BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT });
  registry.recordFailure('grok', { classification: BACKEND_FAILURE_CLASSIFICATION.TIMEOUT });
  assert.equal(registry.get('codex').retryable, true);
  assert.equal(registry.get('grok').retryable, true);
  advance(50);
  assert.equal(registry.get('codex').status, 'UNKNOWN');
  assert.equal(registry.get('grok').status, 'UNKNOWN');
});

test('auth/config/protocol failures remain unavailable until success', () => {
  const { registry, advance } = registryAt(0, 10);
  registry.recordFailure('codex', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH });
  registry.recordFailure('claude-code', { classification: BACKEND_FAILURE_CLASSIFICATION.CONFIG });
  registry.recordFailure('grok', { classification: BACKEND_FAILURE_CLASSIFICATION.PROTOCOL });
  advance(10_000);
  assert.equal(registry.get('codex').status, 'UNAVAILABLE');
  assert.equal(registry.get('claude-code').status, 'UNAVAILABLE');
  assert.equal(registry.get('grok').status, 'UNAVAILABLE');
  registry.recordSuccess('codex');
  assert.equal(registry.get('codex').status, 'HEALTHY');
});

test('diagnostic is bounded and snapshot is frozen', () => {
  const { registry } = registryAt();
  registry.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH, diagnostic: 'x'.repeat(900) });
  const snapshot = registry.snapshot();
  assert.ok(snapshot.opencode.diagnostic.length <= 500);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.opencode), true);
});

test('selector applies capability gate before health gate', () => {
  const { registry } = registryAt();
  healthy(registry, 'codex', 'claude-code', 'grok', 'opencode');
  assert.throws(
    () => selectBackendWithHealth({ requires: ['ui_live_refresh'] }, registry.snapshot()),
    (error) => error.code === 'NO_PROVEN_BACKEND',
  );
});

test('only HEALTHY or DEGRADED capability-eligible backends are usable', () => {
  const { registry } = registryAt();
  registry.recordSuccess('grok', { degraded: true });
  registry.recordSuccess('opencode');
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'] }, registry.snapshot());
  assert.equal(out.backend, 'opencode');
  assert.deepEqual(out.capabilityEligible, ['grok', 'opencode']);
});

test('HEALTHY outranks DEGRADED even when degraded backend is preferred', () => {
  const { registry } = registryAt();
  registry.recordSuccess('grok', { degraded: true });
  registry.recordSuccess('opencode');
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['grok'] }, registry.snapshot());
  assert.equal(out.backend, 'opencode');
});

test('prefer reorders candidates inside same health tier', () => {
  const { registry } = registryAt();
  healthy(registry, 'grok', 'opencode');
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['opencode'] }, registry.snapshot());
  assert.equal(out.backend, 'opencode');
});

test('preference cannot resurrect unhealthy backend', () => {
  const { registry } = registryAt();
  registry.recordSuccess('grok');
  registry.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE });
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['opencode'] }, registry.snapshot());
  assert.equal(out.backend, 'grok');
});

test('exclude still filters usable candidates', () => {
  const { registry } = registryAt();
  healthy(registry, 'grok', 'opencode');
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], exclude: ['grok'] }, registry.snapshot());
  assert.equal(out.backend, 'opencode');
});

test('no usable backend returns typed health diagnostics', () => {
  const { registry } = registryAt();
  registry.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE, diagnostic: '503' });
  assert.throws(
    () => selectBackendWithHealth({ requires: ['concurrent_client_safe'] }, registry.snapshot()),
    (error) => error.code === 'NO_USABLE_BACKEND' && error.capabilityEligible[0] === 'opencode' && error.health.opencode.status === 'UNAVAILABLE',
  );
});

test('explicit workflow backend string passes through unchanged', () => {
  const { registry } = registryAt();
  const decision = resolveHealthAwareDecision({ type: 'workflow', spec: { steps: [{ recipient: 'codex', body: 'x' }] } }, registry.snapshot());
  assert.equal(decision.spec.steps[0].recipient, 'codex');
});

test('workflow and peer selectors resolve to concrete healthy backends', () => {
  const { registry } = registryAt();
  healthy(registry, 'claude-code', 'grok', 'opencode');
  const workflow = resolveHealthAwareDecision({
    type: 'workflow', spec: { steps: [{ recipient: { requires: ['concurrent_client_safe'] }, body: 'x' }] },
  }, registry.snapshot());
  assert.equal(workflow.spec.steps[0].recipient, 'opencode');

  const peer = resolveHealthAwareDecision({
    type: 'peer_exchange', routes: [
      { from: { requires: ['resume_existing'], prefer: ['claude-code'] }, to: { requires: ['interrupt_active_turn'], prefer: ['grok'] } },
    ], body: 'review',
  }, registry.snapshot());
  assert.deepEqual(peer.routes, [{ from: 'claude-code', to: 'grok' }]);
});

test('wrapped PM receives frozen capability and health snapshots and resolves before return', async () => {
  const { registry } = registryAt();
  healthy(registry, 'opencode');
  let seen;
  const driver = {
    name: 'health-pm',
    async decide(input) {
      seen = input;
      return { type: 'workflow', spec: { steps: [{ recipient: { requires: ['concurrent_client_safe'] }, body: 'x' }] } };
    },
  };
  const wrapped = createHealthAwarePmDriver(driver, { healthRegistry: registry });
  const decision = await wrapped.decide({ objective: 'x' });
  assert.equal(decision.spec.steps[0].recipient, 'opencode');
  assert.equal(Object.isFrozen(seen.backendCapabilities), true);
  assert.equal(Object.isFrozen(seen.backendHealth), true);
  assert.equal(seen.backendHealth.opencode.status, 'HEALTHY');
});

test('health-aware routing contains no role vocabulary or provider role binding', async () => {
  const files = [
    new URL('../src/orchestration/backend-health-registry.mjs', import.meta.url),
    new URL('../src/orchestration/health-aware-selector.mjs', import.meta.url),
    new URL('../src/orchestration/health-aware-pm-driver.mjs', import.meta.url),
  ];
  const text = (await Promise.all(files.map(async (url) => (await import('node:fs/promises')).readFile(url, 'utf8')))).join('\n');
  assert.doesNotMatch(text, /\b(coder|reviewer|judge)\b/i);
});
