#!/usr/bin/env node
import process from 'node:process';

import { PmRuntime } from '../src/pm/pm-runtime.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import {
  BACKEND_FAILURE_CLASSIFICATION,
  BackendHealthRegistry,
} from '../src/orchestration/backend-health-registry.mjs';
import { selectBackendWithHealth } from '../src/orchestration/health-aware-selector.mjs';
import { createHealthAwarePmDriver } from '../src/orchestration/health-aware-pm-driver.mjs';

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` });
  }
}

let now = 10_000;
const health = new BackendHealthRegistry({ clock: () => now, cooldownMs: 1_000 });
health.recordSuccess('codex');
health.recordSuccess('claude-code');
health.recordSuccess('grok');
health.recordFailure('opencode', {
  classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
  diagnostic: 'synthetic 503 Service temporarily unavailable',
});

check('concurrent_client_safe has no usable backend while OpenCode is unavailable', () => {
  try {
    selectBackendWithHealth({ requires: ['concurrent_client_safe'] }, health.snapshot());
  } catch (error) {
    if (error.code !== 'NO_USABLE_BACKEND') throw error;
    return error.code;
  }
  throw new Error('expected NO_USABLE_BACKEND');
});

check('interrupt falls back from preferred unavailable OpenCode to healthy Grok', () => {
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['opencode'] }, health.snapshot());
  if (out.backend !== 'grok') throw new Error(`expected grok, got ${out.backend}`);
  return out.backend;
});

health.recordSuccess('opencode');
check('successful observation restores preferred OpenCode eligibility', () => {
  const out = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['opencode'] }, health.snapshot());
  if (out.backend !== 'opencode') throw new Error(`expected opencode, got ${out.backend}`);
  return out.backend;
});

health.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.TIMEOUT });
now += 1_000;
check('cooldown expiry returns UNKNOWN rather than HEALTHY', () => {
  const status = health.get('opencode').status;
  if (status !== 'UNKNOWN') throw new Error(`expected UNKNOWN, got ${status}`);
  return status;
});

health.recordSuccess('opencode');

const calls = { workflow: [], peer: [] };
const workflowRunner = {
  async run(spec) {
    calls.workflow.push(spec);
    return {
      workflowId: 'wf_gate9', status: 'completed', finalStepId: 's1', finalTaskId: 't1', finalRunId: 'r1',
      finalResult: { id: 'result1', taskId: 't1', runId: 'r1', agent: spec.steps[0].recipient, status: 'completed', output: 'workflow-ok', artifacts: [], handoff: null },
      error: null,
    };
  },
};
const peerRelay = {
  createConversation() { return { id: 'conv_gate9' }; },
  async exchange(input) {
    calls.peer.push(input);
    return {
      conversationId: input.conversationId, status: 'completed', hops: [{ status: 'completed' }],
      finalResult: { id: 'result2', taskId: 't2', runId: 'r2', agent: input.routes.at(-1).to, status: 'completed', output: 'peer-ok', artifacts: [], handoff: null },
    };
  },
};

const underlying = createScriptedPmDriver({
  name: 'gate9-scripted-pm',
  decisions: [
    { type: 'workflow', spec: { sender: 'pm', steps: [{ recipient: { requires: ['concurrent_client_safe'] }, body: 'work' }] } },
    { type: 'peer_exchange', routes: [{ from: { requires: ['resume_existing'], prefer: ['claude-code'] }, to: { requires: ['interrupt_active_turn'], prefer: ['opencode'] } }], body: 'review' },
    { type: 'finish', output: 'gate9-ok' },
  ],
});
const wrapped = createHealthAwarePmDriver(underlying, { healthRegistry: health });
const runtime = new PmRuntime({ driver: wrapped, workflowRunner, peerRelay, maxTurns: 4 });
const result = await runtime.run({ objective: 'Gate 9 deterministic smoke' });

check('PmRuntime workflow receives concrete health-qualified backend', () => {
  const backend = calls.workflow[0]?.steps?.[0]?.recipient;
  if (backend !== 'opencode') throw new Error(`expected opencode, got ${backend}`);
  return backend;
});

check('PmRuntime peer routes receive concrete health-qualified endpoints', () => {
  const route = calls.peer[0]?.routes?.[0];
  if (route?.from !== 'claude-code' || route?.to !== 'opencode') throw new Error(`unexpected route ${JSON.stringify(route)}`);
  return `${route.from}->${route.to}`;
});

check('PmRuntime completes through health-aware PM wrapper', () => {
  if (result.status !== 'completed' || result.output !== 'gate9-ok') throw new Error(`unexpected result ${result.status}/${result.output}`);
  return `${result.status}:${result.output}`;
});

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
const passed = checks.filter((entry) => entry.ok).length;
console.log(`GATE 9: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
process.exitCode = passed === checks.length ? 0 : 1;
