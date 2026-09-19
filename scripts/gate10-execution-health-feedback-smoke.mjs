#!/usr/bin/env node
import process from 'node:process';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { selectBackendWithHealth } from '../src/orchestration/health-aware-selector.mjs';

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` });
  }
}

const registry = new AgentRegistry();
const events = new EventBus();
const state = new StateStore();
const bus = new AgentBus({ registry, events, state });
const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
const feedback = [];
const subscription = attachExecutionHealthFeedback({ events, healthRegistry: health, onFeedback: (entry) => feedback.push(entry) });

registry.register('codex', {
  async start() { return { output: 'ok' }; },
}, { transport: 'fake' });
registry.register('grok', {
  async start() { throw Object.assign(new Error('503 Service temporarily unavailable'), { status: 503 }); },
}, { transport: 'fake' });
registry.register('opencode', {
  async start() { throw new Error('task assertion was false'); },
}, { transport: 'fake' });

await bus.dispatch({ recipient: 'codex', body: 'success path' });
try { await bus.dispatch({ recipient: 'grok', body: 'recognized provider failure' }); } catch {}
try { await bus.dispatch({ recipient: 'opencode', body: 'ambiguous task failure' }); } catch {}

check('successful AgentBus run automatically marks backend HEALTHY', () => {
  const status = health.get('codex').status;
  if (status !== 'HEALTHY') throw new Error(`expected HEALTHY, got ${status}`);
  return status;
});

check('recognized 503 AgentBus failure automatically marks backend UNAVAILABLE', () => {
  const entry = health.get('grok');
  if (entry.status !== 'UNAVAILABLE' || entry.classification !== 'UPSTREAM_UNAVAILABLE') {
    throw new Error(`unexpected ${entry.status}/${entry.classification}`);
  }
  return `${entry.status}:${entry.classification}`;
});

check('ambiguous task failure does not poison backend health', () => {
  const status = health.get('opencode').status;
  if (status !== 'UNKNOWN') throw new Error(`expected UNKNOWN, got ${status}`);
  return status;
});

check('health-aware selector immediately excludes failed backend', () => {
  const out = selectBackendWithHealth({ requires: ['resume_existing'], prefer: ['grok', 'codex'] }, health.snapshot());
  if (out.backend !== 'codex') throw new Error(`expected codex, got ${out.backend}`);
  return out.backend;
});

check('feedback audit distinguishes success/failure/ignored unknown', () => {
  const outcomes = feedback.map((entry) => entry.outcome);
  for (const required of ['SUCCESS_RECORDED', 'FAILURE_RECORDED', 'IGNORED_UNKNOWN']) {
    if (!outcomes.includes(required)) throw new Error(`missing ${required}`);
  }
  return outcomes.join(',');
});

subscription.dispose();
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
const passed = checks.filter((entry) => entry.ok).length;
console.log(`GATE 10: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
process.exitCode = passed === checks.length ? 0 : 1;
