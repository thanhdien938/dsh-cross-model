import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PmRuntime } from '../src/pm/pm-runtime.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';

function harness({ workflowStatus = 'completed', peerStatus = 'completed' } = {}) {
  const calls = { workflow: [], peer: [], createConversation: 0 };
  const workflowRunner = {
    async run(spec) {
      calls.workflow.push(spec);
      return {
        workflowId: `wf_${calls.workflow.length}`,
        status: workflowStatus,
        finalStepId: 'step_final',
        finalTaskId: 'task_final',
        finalRunId: 'run_final',
        finalResult: {
          id: 'result_final',
          taskId: 'task_final',
          runId: 'run_final',
          agent: 'backend-x',
          status: 'completed',
          output: 'workflow-output',
          artifacts: [],
          handoff: { ok: true },
        },
        error: workflowStatus === 'completed' ? null : { name: 'WorkflowError', message: 'workflow failed' },
      };
    },
  };
  const peerRelay = {
    createConversation() {
      calls.createConversation += 1;
      return { id: `conv_${calls.createConversation}` };
    },
    async exchange(input) {
      calls.peer.push(input);
      return {
        conversationId: input.conversationId,
        status: peerStatus,
        hops: [{ status: peerStatus }],
        finalResult: {
          id: 'peer_result',
          taskId: 'peer_task',
          runId: 'peer_run',
          agent: 'backend-y',
          status: 'completed',
          output: 'peer-output',
          artifacts: [],
          handoff: null,
        },
      };
    },
  };
  return { calls, workflowRunner, peerRelay };
}

function runtimeFor(driver, options = {}) {
  const h = harness(options);
  return { runtime: new PmRuntime({ driver, workflowRunner: h.workflowRunner, peerRelay: h.peerRelay, maxTurns: options.maxTurns, historyLimit: options.historyLimit }), ...h };
}

test('workflow decision delegates to WorkflowRunner then finish completes PM run', async () => {
  const driver = createScriptedPmDriver({
    name: 'pm-alpha',
    decisions: [
      { type: 'workflow', spec: { sender: 'pm', steps: [{ recipient: 'waldo', body: 'do work' }] } },
      ({ history }) => ({ type: 'finish', output: history[0].outcome.finalResult.output, data: { source: 'workflow' } }),
    ],
  });
  const { runtime, calls } = runtimeFor(driver);
  const result = await runtime.run({ objective: 'complete task' });
  assert.equal(result.status, 'completed');
  assert.equal(result.driver, 'pm-alpha');
  assert.equal(result.output, 'workflow-output');
  assert.deepEqual(result.data, { source: 'workflow' });
  assert.equal(result.turns, 2);
  assert.equal(calls.workflow.length, 1);
  assert.equal(calls.peer.length, 0);
});

test('peer_exchange creates conversation when omitted and delegates to PeerRelay', async () => {
  const driver = createScriptedPmDriver({
    name: 'pm-peer',
    decisions: [
      { type: 'peer_exchange', routes: [{ from: 'alpha', to: 'bravo' }], body: 'review this', maxHops: 3 },
      { type: 'finish', output: 'done' },
    ],
  });
  const { runtime, calls } = runtimeFor(driver);
  const result = await runtime.run({ objective: 'peer exchange' });
  assert.equal(result.status, 'completed');
  assert.equal(calls.createConversation, 1);
  assert.equal(calls.peer.length, 1);
  assert.equal(calls.peer[0].conversationId, 'conv_1');
  assert.equal(calls.peer[0].maxHops, 3);
  assert.deepEqual(calls.peer[0].routes, [{ from: 'alpha', to: 'bravo' }]);
});

test('explicit conversation id is preserved without creating another conversation', async () => {
  const driver = createScriptedPmDriver({
    name: 'pm-peer-explicit',
    decisions: [
      { type: 'peer_exchange', conversationId: 'conv_existing', routes: [{ from: 'one', to: 'two' }], body: 'hello' },
      { type: 'finish', output: 'ok' },
    ],
  });
  const { runtime, calls } = runtimeFor(driver);
  const result = await runtime.run({ objective: 'reuse conversation' });
  assert.equal(result.status, 'completed');
  assert.equal(calls.createConversation, 0);
  assert.equal(calls.peer[0].conversationId, 'conv_existing');
});

test('two different PM drivers are swappable over identical runtime capabilities', async () => {
  const driverA = createScriptedPmDriver({ name: 'planner-a', decisions: [{ type: 'finish', output: 'A' }] });
  const driverB = createScriptedPmDriver({ name: 'planner-b', decisions: [{ type: 'finish', output: 'B' }] });
  const a = runtimeFor(driverA).runtime;
  const b = runtimeFor(driverB).runtime;
  assert.deepEqual(a.capabilities, b.capabilities);
  const [ra, rb] = await Promise.all([
    a.run({ objective: 'same objective' }),
    b.run({ objective: 'same objective' }),
  ]);
  assert.equal(ra.driver, 'planner-a');
  assert.equal(rb.driver, 'planner-b');
  assert.equal(ra.output, 'A');
  assert.equal(rb.output, 'B');
});

test('invalid decision fails before orchestration infrastructure executes', async () => {
  const driver = createScriptedPmDriver({ name: 'bad-pm', decisions: [{ type: 'unknown-action' }] });
  const { runtime, calls } = runtimeFor(driver);
  const result = await runtime.run({ objective: 'reject bad decision' });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /unsupported pm decision type/i);
  assert.equal(calls.workflow.length, 0);
  assert.equal(calls.peer.length, 0);
});

test('workflow terminal failure stops PM loop', async () => {
  const driver = createScriptedPmDriver({
    name: 'workflow-fail-pm',
    decisions: [
      { type: 'workflow', spec: { steps: [{ recipient: 'x', body: 'fail' }] } },
      { type: 'finish', output: 'must-not-run' },
    ],
  });
  const { runtime } = runtimeFor(driver, { workflowStatus: 'failed' });
  const result = await runtime.run({ objective: 'failure' });
  assert.equal(result.status, 'failed');
  assert.equal(result.turns, 1);
  assert.equal(result.history.length, 1);
});

test('peer terminal cancellation propagates as cancelled PM run', async () => {
  const driver = createScriptedPmDriver({
    name: 'peer-cancel-pm',
    decisions: [{ type: 'peer_exchange', routes: [{ from: 'x', to: 'y' }], body: 'go' }],
  });
  const { runtime } = runtimeFor(driver, { peerStatus: 'cancelled' });
  const result = await runtime.run({ objective: 'cancel' });
  assert.equal(result.status, 'cancelled');
});

test('maxTurns stops a driver that never finishes', async () => {
  const driver = {
    name: 'looping-pm',
    async decide() {
      return { type: 'workflow', spec: { steps: [{ recipient: 'backend', body: 'again' }] } };
    },
  };
  const { runtime, calls } = runtimeFor(driver, { maxTurns: 2 });
  const result = await runtime.run({ objective: 'bounded loop' });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /did not finish within 2 turns/i);
  assert.equal(calls.workflow.length, 2);
  assert.equal(result.turns, 2);
});

test('aborted signal cancels before asking driver for a decision', async () => {
  let called = 0;
  const driver = { name: 'abort-pm', async decide() { called += 1; return { type: 'finish', output: 'no' }; } };
  const { runtime } = runtimeFor(driver);
  const controller = new AbortController();
  controller.abort();
  const result = await runtime.run({ objective: 'abort', signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.turns, 0);
  assert.equal(called, 0);
});

test('history passed to PM driver is explicitly bounded', async () => {
  const observed = [];
  const driver = {
    name: 'history-pm',
    async decide({ turn, history }) {
      observed.push(history.length);
      if (turn < 4) return { type: 'workflow', spec: { steps: [{ recipient: 'z', body: `step-${turn}` }] } };
      return { type: 'finish', output: 'done' };
    },
  };
  const { runtime } = runtimeFor(driver, { historyLimit: 2, maxTurns: 6 });
  const result = await runtime.run({ objective: 'bounded history' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(observed, [0, 1, 2, 2, 2]);
  assert.equal(result.history.length, 2);
});

test('peer decision contract rejects malformed routes', () => {
  assert.throws(
    () => normalizePmDecision({ type: 'peer_exchange', routes: [{ from: '', to: 'b' }], body: 'x' }),
    /non-empty string/i,
  );
});

test('src/pm core contains no provider-specific adapter/model imports', async () => {
  const files = ['../src/pm/pm-contracts.mjs', '../src/pm/pm-runtime.mjs', '../src/pm/scripted-pm-driver.mjs'];
  for (const relative of files) {
    const content = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /subagent-(codex|claude)|createDshSubagentAdapter|provider\s*===\s*['"](?:codex|claude-code|grok)/i);
  }
});
