#!/usr/bin/env node
import process from 'node:process';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { RetryFailoverExecutor } from '../src/orchestration/retry-failover-executor.mjs';

const checks = [];
function check(name, fn) {
  try { checks.push({ name, ok: true, detail: fn() }); }
  catch (error) { checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` }); }
}

const registry = new AgentRegistry();
const events = new EventBus({ onListenerError: () => {} });
const state = new StateStore();
const bus = new AgentBus({ registry, events, state });
const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
const feedback = attachExecutionHealthFeedback({ events, healthRegistry: health });

registry.register('grok', { async start() { throw new Error('503 Service temporarily unavailable'); } });
registry.register('opencode', { async start() { return { output: 'OpenCode fallback completed' }; } });
registry.register('codex', { async start() { throw new Error('401 Unauthorized invalid credential'); } });
registry.register('claude-code', { async start() { return { output: 'must not run after auth failure' }; } });

for (const backend of ['grok', 'opencode', 'codex', 'claude-code']) health.recordSuccess(backend);

const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, maxAttempts: 3 });
const fallback = await executor.execute({
  selector: { requires: ['interrupt_active_turn'], prefer: ['grok', 'opencode'] },
  body: 'Gate 11 synthetic retryable failover',
});

check('retryable 503 fails over from Grok to OpenCode', () => {
  const sequence = fallback.attempts.map((attempt) => `${attempt.backend}:${attempt.status}`).join(' -> ');
  if (sequence !== 'grok:failed -> opencode:completed') throw new Error(sequence);
  return sequence;
});

check('Gate 10 feedback marks failed backend unavailable before reselection', () => {
  const status = health.get('grok').status;
  if (status !== 'UNAVAILABLE') throw new Error(`expected UNAVAILABLE, got ${status}`);
  return status;
});

check('fallback result is from health-qualified capable backend', () => {
  if (fallback.backend !== 'opencode' || fallback.result?.output !== 'OpenCode fallback completed') {
    throw new Error(`unexpected ${fallback.backend}/${fallback.result?.output}`);
  }
  return fallback.backend;
});

let authError = null;
try {
  await executor.execute({
    selector: { requires: ['resume_existing'], prefer: ['codex', 'claude-code'] },
    body: 'Gate 11 synthetic non-retryable auth stop',
  });
} catch (error) { authError = error; }

check('AUTH failure stops immediately with no failover', () => {
  if (authError?.code !== 'NON_RETRYABLE_FAILURE') throw new Error(`unexpected ${authError?.code}`);
  if (authError.attempts?.length !== 1 || authError.attempts[0].backend !== 'codex') throw new Error('expected one codex attempt');
  if (bus.listRuns({ agent: 'claude-code' }).length !== 0) throw new Error('claude-code should not run');
  return `${authError.code}:${authError.classification}`;
});

check('attempt ledger is bounded and frozen', () => {
  if (fallback.attempts.length !== 2 || !Object.isFrozen(fallback.attempts) || !fallback.attempts.every(Object.isFrozen)) {
    throw new Error('attempt ledger invariant failed');
  }
  return `${fallback.attempts.length} attempts`;
});

feedback.dispose();
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
const passed = checks.filter((entry) => entry.ok).length;
console.log(`GATE 11: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
process.exitCode = passed === checks.length ? 0 : 1;
