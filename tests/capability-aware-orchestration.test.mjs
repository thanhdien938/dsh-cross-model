import test from 'node:test';
import assert from 'node:assert/strict';

import { PmRuntime } from '../src/pm/pm-runtime.mjs';
import {
  CapabilitySelectionError,
  capabilitySnapshot,
  eligibleBackends,
  selectBackend,
} from '../src/orchestration/capability-selector.mjs';
import {
  createCapabilityAwarePmDriver,
  resolveCapabilityAwareDecision,
} from '../src/orchestration/capability-aware-pm-driver.mjs';

function harness() {
  const calls = { workflow: [], peer: [] };
  return {
    calls,
    workflowRunner: {
      async run(spec) {
        calls.workflow.push(spec);
        return {
          workflowId: 'wf_1', status: 'completed', finalStepId: 'step_1', finalTaskId: 'task_1', finalRunId: 'run_1',
          finalResult: { id: 'result_1', taskId: 'task_1', runId: 'run_1', agent: spec.steps.at(-1).recipient, status: 'completed', output: 'ok', artifacts: [], handoff: null },
          error: null,
        };
      },
    },
    peerRelay: {
      createConversation() { return { id: 'conv_1' }; },
      async exchange(input) {
        calls.peer.push(input);
        return { conversationId: input.conversationId, status: 'completed', hops: [], finalResult: { id: 'r', taskId: 't', runId: 'run', agent: input.routes.at(-1).to, status: 'completed', output: 'ok', artifacts: [], handoff: null } };
      },
    },
  };
}

test('resume-only selector sees all four proven backends', () => {
  assert.deepEqual(eligibleBackends({ requires: ['resume_existing'] }), ['claude-code', 'codex', 'grok', 'opencode']);
});

test('interrupt selector sees only Grok and OpenCode', () => {
  assert.deepEqual(eligibleBackends({ requires: ['interrupt_active_turn'] }), ['grok', 'opencode']);
});

test('concurrent-client selector sees only OpenCode', () => {
  assert.deepEqual(eligibleBackends({ requires: ['concurrent_client_safe'] }), ['opencode']);
});

test('UI live refresh has no proven backend', () => {
  assert.throws(() => selectBackend({ requires: ['ui_live_refresh'] }), (error) => error instanceof CapabilitySelectionError && error.code === 'NO_PROVEN_BACKEND');
});

test('ERROR and UNPROVEN never satisfy a requirement', () => {
  assert.deepEqual(eligibleBackends({ requires: ['interrupt_active_turn'] }), ['grok', 'opencode']);
  assert.equal(eligibleBackends({ requires: ['interrupt_active_turn'] }).includes('codex'), false);
  assert.equal(eligibleBackends({ requires: ['interrupt_active_turn'] }).includes('claude-code'), false);
});

test('preference only reorders eligible candidates', () => {
  assert.equal(selectBackend({ requires: ['interrupt_active_turn'], prefer: ['opencode', 'grok'] }).backend, 'opencode');
  assert.equal(selectBackend({ requires: ['interrupt_active_turn'], prefer: ['codex', 'grok'] }).backend, 'grok');
});

test('exclusion removes otherwise eligible backend', () => {
  assert.equal(selectBackend({ requires: ['interrupt_active_turn'], exclude: ['grok'] }).backend, 'opencode');
});

test('explicit endpoints pass through unchanged', () => {
  const decision = resolveCapabilityAwareDecision({ type: 'workflow', spec: { steps: [{ recipient: 'codex', body: 'x' }] } });
  assert.equal(decision.spec.steps[0].recipient, 'codex');
});

test('workflow selectors resolve to concrete backend names', () => {
  const decision = resolveCapabilityAwareDecision({ type: 'workflow', spec: { steps: [{ recipient: { requires: ['concurrent_client_safe'] }, body: 'x' }] } });
  assert.equal(decision.spec.steps[0].recipient, 'opencode');
});

test('peer endpoint selectors resolve independently', () => {
  const decision = resolveCapabilityAwareDecision({
    type: 'peer_exchange', body: 'x',
    routes: [{ from: { requires: ['resume_existing'], prefer: ['codex'] }, to: { requires: ['interrupt_active_turn'], prefer: ['grok'] } }],
  });
  assert.deepEqual(decision.routes, [{ from: 'codex', to: 'grok' }]);
});

test('wrapped PM receives a frozen capability snapshot', async () => {
  let observed;
  const wrapped = createCapabilityAwarePmDriver({
    name: 'observer',
    async decide(input) { observed = input.backendCapabilities; return { type: 'finish', output: 'ok' }; },
  });
  await wrapped.decide({});
  assert.deepEqual(Object.keys(observed).sort(), ['claude-code', 'codex', 'grok', 'opencode']);
  assert.equal(observed.opencode.capabilities.concurrent_client_safe, 'PROVED');
  assert.equal(Object.isFrozen(observed), true);
});

test('normal PmRuntime executes capability-resolved workflow without modification', async () => {
  let turn = 0;
  const wrapped = createCapabilityAwarePmDriver({
    name: 'cap-pm',
    async decide() {
      turn += 1;
      if (turn === 1) return { type: 'workflow', spec: { sender: 'pm', steps: [{ recipient: { requires: ['concurrent_client_safe'] }, body: 'do work' }] } };
      return { type: 'finish', output: 'done' };
    },
  });
  const h = harness();
  const runtime = new PmRuntime({ driver: wrapped, workflowRunner: h.workflowRunner, peerRelay: h.peerRelay });
  const result = await runtime.run({ objective: 'capability aware task' });
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.workflow[0].steps[0].recipient, 'opencode');
});

test('normal PmRuntime executes capability-resolved peer route', async () => {
  let turn = 0;
  const wrapped = createCapabilityAwarePmDriver({
    name: 'cap-peer-pm',
    async decide() {
      turn += 1;
      if (turn === 1) return {
        type: 'peer_exchange', body: 'review',
        routes: [{ from: { requires: ['resume_existing'], prefer: ['claude-code'] }, to: { requires: ['interrupt_active_turn'], prefer: ['opencode'] } }],
      };
      return { type: 'finish', output: 'done' };
    },
  });
  const h = harness();
  const runtime = new PmRuntime({ driver: wrapped, workflowRunner: h.workflowRunner, peerRelay: h.peerRelay });
  const result = await runtime.run({ objective: 'capability aware peer exchange' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.calls.peer[0].routes, [{ from: 'claude-code', to: 'opencode' }]);
});

test('unknown capability is rejected before execution', () => {
  assert.throws(() => selectBackend({ requires: ['telepathy'] }), (error) => error.code === 'UNKNOWN_CAPABILITY');
});

test('capability snapshot does not invent statuses outside matrix', () => {
  const snapshot = capabilitySnapshot();
  const statuses = new Set(Object.values(snapshot).flatMap((profile) => Object.values(profile.capabilities)));
  assert.deepEqual([...statuses].sort(), ['ERROR', 'PROVED', 'UNPROVEN']);
});
