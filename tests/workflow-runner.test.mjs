import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { WorkflowRunner } from '../src/workflow/workflow-runner.mjs';

function newHarness() {
  const events = new EventBus({ onListenerError: () => {} });
  const state = new StateStore();
  const registry = new AgentRegistry();
  const bus = new AgentBus({ registry, events, state });
  const runner = new WorkflowRunner({ bus });
  return { events, state, registry, bus, runner };
}

function okAdapter(output, handoff) {
  return {
    start: async () => ({ output, stopReason: 'completed', ...(handoff !== undefined ? { handoff } : {}) }),
    cancel: async () => {},
    dispose: async () => {},
  };
}

function capturing(capture, output = 'ok') {
  const counts = { start: 0 };
  return {
    counts,
    start: async ({ task }) => {
      counts.start += 1;
      capture(task);
      return { output: typeof output === 'function' ? output(task) : `${output}-${counts.start}`, stopReason: 'completed' };
    },
    cancel: async () => {},
    dispose: async () => {},
  };
}

test('two arbitrary backends complete automatically (alpha -> bravo)', async () => {
  const { registry, runner } = newHarness();
  registry.register('alpha', okAdapter('A out'));
  registry.register('bravo', okAdapter('B out'));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'produce' },
      { recipient: 'bravo', body: 'consume', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.steps[1].status, 'completed');
  assert.equal(runner.getWorkflow(result.workflowId).status, 'completed');
});

test('no manual handoff is needed; runner derives step-1 context automatically', async () => {
  const { registry, runner } = newHarness();
  let bTask = null;
  registry.register('alpha', okAdapter('token-ABC123'));
  registry.register('bravo', capturing((task) => { bTask = task; }));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'produce token' },
      { recipient: 'bravo', body: 'use token', contextFromPrevious: true },
    ],
  });
  assert.ok(bTask, 'bravo was never dispatched');
  assert.equal(bTask.context.previousResult.output, 'token-ABC123');
  assert.equal(bTask.context.workflow.previousTaskId, result.steps[0].taskId);
  assert.equal(bTask.body, 'use token');
});

test('second step receives previous output in derived context', async () => {
  const { registry, runner } = newHarness();
  let bTask = null;
  registry.register('alpha', okAdapter('alpha-v1'));
  registry.register('bravo', capturing((task) => { bTask = task; }));
  await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.equal(bTask.context.previousResult.output, 'alpha-v1');
});

test('second step receives previous structured handoff unchanged', async () => {
  const { registry, runner } = newHarness();
  const handoff = { summary: 'alpha summary', nextContext: { round: 2 }, recommendations: ['x', 'y'] };
  let bTask = null;
  registry.register('alpha', okAdapter('alpha out', handoff));
  registry.register('bravo', capturing((task) => { bTask = task; }));
  await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.deepEqual(bTask.context.previousResult.handoff, handoff);
});

test('workflow/step/task/run/result ids correlate correctly', async () => {
  const { state, registry, runner } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  const wf = runner.getWorkflow(result.workflowId);
  const [s0, s1] = wf.steps;
  assert.equal(result.steps[0].id, s0.id);
  assert.equal(state.getRun(s0.runId).taskId, s0.taskId);
  assert.equal(state.getResultByRun(s0.runId).taskId, s0.taskId);
  assert.equal(state.getResultByRun(s0.runId).runId, s0.runId);
  assert.equal(s0.resultId, state.getResultByRun(s0.runId).id);
  assert.equal(result.finalTaskId, s1.taskId);
  assert.equal(result.finalRunId, s1.runId);
  assert.equal(result.finalResult.id, s1.resultId);
  assert.equal(result.finalResult.status, 'completed');
});

test('custom initial context survives step 0', async () => {
  const { registry, runner } = newHarness();
  const context0 = { topic: 'custom', nested: { a: 1, b: [2, 3] } };
  let aTask = null;
  registry.register('alpha', capturing((task) => { aTask = task; }, 'a'));
  registry.register('bravo', okAdapter('b'));
  await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a', context: context0 },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.deepEqual(aTask.context, context0);
});

test('explicit next-step context merges with derived handoff; explicit keys win', async () => {
  const { registry, runner } = newHarness();
  let bTask = null;
  registry.register('alpha', okAdapter('merge-me'));
  registry.register('bravo', capturing((task) => { bTask = task; }));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      {
        recipient: 'bravo',
        body: 'b',
        contextFromPrevious: true,
        context: { previousResult: { note: 'explicit wins' }, extra: true },
      },
    ],
  });
  assert.equal(bTask.context.workflow.workflowId, result.workflowId);
  assert.deepEqual(bTask.context.previousResult, { note: 'explicit wins' });
  assert.equal(bTask.context.extra, true);
});

test('first-step failure prevents any second dispatch', async () => {
  const { registry, runner } = newHarness();
  const started = { alpha: 0, bravo: 0 };
  registry.register('alpha', {
    start: async () => { started.alpha += 1; throw new Error('boom'); },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', {
    start: async () => { started.bravo += 1; return { output: 'b', stopReason: 'completed' }; },
    cancel: async () => {},
    dispose: async () => {},
  });
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'failed');
  assert.equal(started.bravo, 0);
  assert.equal(result.steps[1].status, 'skipped');
  assert.equal(result.finalResult, null);
});

test('failed workflow identifies the failing step with lineage', async () => {
  const { registry, runner } = newHarness();
  registry.register('alpha', {
    start: async () => { throw new Error('boom'); },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('bravo', okAdapter('b'));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.stepIndex, 0);
  assert.equal(result.error.stepId, result.steps[0].id);
  assert.equal(result.error.error.message, 'boom');
  assert.equal(runner.getWorkflow(result.workflowId).steps[0].status, 'failed');
  assert.equal(runner.getWorkflow(result.workflowId).steps[0].error.message, 'boom');
});

test('cancelling the active workflow reaches the AgentBus run and prevents later steps', async () => {
  const { bus, registry, runner } = newHarness();
  let wfId = null;
  let bravoRunId = null;
  const cancelCalls = { bravo: 0, charlie: 0 };
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', {
    start: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    cancel: async () => { cancelCalls.bravo += 1; },
    dispose: async () => {},
  });
  registry.register('charlie', {
    start: async () => { cancelCalls.charlie += 1; return { output: 'c', stopReason: 'completed' }; },
    cancel: async () => {},
    dispose: async () => {},
  });
  runner.events.on('workflow.created', (payload) => { wfId = payload.workflowId; });
  runner.events.on('agent.started', (payload) => {
    if (payload.agent === 'bravo') bravoRunId = payload.runId;
  });
  const pending = runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
      { recipient: 'charlie', body: 'c', contextFromPrevious: true },
    ],
  });
  await new Promise((resolve) => {
    const waitForRunning = () => {
      const record = bravoRunId ? bus.run(bravoRunId) : null;
      if (record && record.status === 'running') resolve();
      else setImmediate(waitForRunning);
    };
    waitForRunning();
  });
  await runner.cancel(wfId);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.steps[1].status, 'cancelled');
  assert.equal(result.steps[2].status, 'skipped');
  assert.equal(cancelCalls.bravo, 1);
  assert.equal(cancelCalls.charlie, 0);
});

test('transcript and event ordering are deterministic, and faulty observers do not corrupt state', async () => {
  const { registry, runner } = newHarness();
  registry.register('alpha', okAdapter('a'));
  registry.register('bravo', okAdapter('b'));
  runner.events.on('workflow.started', () => { throw new Error('faulty observer'); });
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  const events = runner.transcript(result.workflowId).map((entry) => entry.event);
  assert.deepEqual(events, [
    'workflow.created',
    'step.created',
    'step.created',
    'workflow.started',
    'step.started',
    'step.completed',
    'handoff.created',
    'step.started',
    'step.completed',
    'workflow.completed',
  ]);
});

test('backend names are arbitrary (no codex/claude/grok special-casing)', async () => {
  const { registry, runner } = newHarness();
  registry.register('waldo', okAdapter('waldo out'));
  registry.register('frank', okAdapter('frank out'));
  registry.register('nine-nine', okAdapter('nn out'));
  const result = await runner.run({
    steps: [
      { recipient: 'waldo', body: 'w' },
      { recipient: 'frank', body: 'f', contextFromPrevious: true },
      { recipient: 'nine-nine', body: 'n', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.steps.map((s) => s.recipient),
    ['waldo', 'frank', 'nine-nine'],
  );
});

test('a 3-step fake workflow works end-to-end with derived context at each hop', async () => {
  const { registry, runner } = newHarness();
  const received = [];
  registry.register('alpha', okAdapter('first'));
  registry.register('bravo', capturing((task) => { received.push(task.context?.previousResult?.output); }, 'second'));
  registry.register('charlie', capturing((task) => { received.push(task.context?.previousResult?.output); }, 'third'));
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
      { recipient: 'charlie', body: 'c', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(received, ['first', 'second-1']);
  assert.equal(result.finalResult.output, 'third-1');
});

test('structured handoff stays structured end-to-end through the workflow result', async () => {
  const { registry, runner } = newHarness();
  const handoffA = { summary: 'from alpha', nextContext: { step: 2 } };
  const handoffB = { summary: 'from bravo', recommendations: [1, 2, 3] };
  let bTask = null;
  registry.register('alpha', okAdapter('a out', handoffA));
  registry.register('bravo', {
    start: async ({ task }) => {
      bTask = task;
      return { output: 'b out', stopReason: 'completed', handoff: handoffB };
    },
    cancel: async () => {},
    dispose: async () => {},
  });
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'a' },
      { recipient: 'bravo', body: 'b', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(bTask.context.previousResult.handoff, handoffA);
  assert.deepEqual(result.finalResult.handoff, handoffB);
  assert.equal(result.finalResult.output, 'b out');
});

test('one-shot truthfulness: each step is an explicit fresh dispatch, never a continuation', async () => {
  const { registry, runner } = newHarness();
  const seen = [];
  const adapter = capturing((task) => { seen.push({ taskId: task.id, body: task.body }); });
  registry.register('alpha', adapter);
  const result = await runner.run({
    steps: [
      { recipient: 'alpha', body: 'step one' },
      { recipient: 'alpha', body: 'step two', contextFromPrevious: true },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(adapter.counts.start, 2);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].taskId, seen[1].taskId, 'each step must dispatch a fresh task');
  assert.notEqual(result.steps[0].runId, result.steps[1].runId, 'each step must run in a fresh run');
  assert.equal(seen[0].body, 'step one');
  assert.equal(seen[1].body, 'step two');
  assert.equal(runner.getWorkflow(result.workflowId).steps[0].dispatchedContext.workflow, undefined);
  assert.equal(runner.getWorkflow(result.workflowId).steps[1].dispatchedContext.previousResult.output, 'ok-1');
});

test('activeRunId hygiene: every started task reaches a terminal agent event and no run lingers running', async () => {
  const { bus, registry, runner } = newHarness();
  const started = new Map(); // taskId -> whether a terminal agent event arrived
  bus.events.all((event, payload) => {
    if (event === 'agent.started' && payload?.taskId) started.set(payload.taskId, false);
    if (['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event) && payload?.taskId) {
      started.set(payload.taskId, true);
    }
  });
  registry.register('ok', okAdapter('done'));
  registry.register('boom', {
    start: async () => { throw new Error('boom'); },
    cancel: async () => {},
    dispose: async () => {},
  });
  registry.register('hang', {
    start: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    cancel: async () => {},
    dispose: async () => {},
  });
  let hangWfId = null;
  runner.events.on('workflow.created', (p) => { hangWfId = p.workflowId; });

  // success path
  await runner.run({ steps: [{ recipient: 'ok', body: 'a' }] });
  // failure path
  await runner.run({ steps: [{ recipient: 'boom', body: 'b' }] });
  // cancellation path (exercise agent.cancelled)
  const pending = runner.run({ steps: [{ recipient: 'hang', body: 'c' }] });
  await new Promise((resolve) => setImmediate(resolve));
  await runner.cancel(hangWfId);
  await pending;

  assert.ok(started.size >= 3, 'expected at least three started tasks across the three lifecycle paths');
  for (const [taskId, terminalSeen] of started) {
    assert.equal(terminalSeen, true, `task ${taskId} never reached a terminal agent event (run mapping would linger)`);
  }
  const lingering = bus.listRuns({ status: 'running' });
  assert.equal(
    lingering.length,
    0,
    `no run may linger 'running' after terminal workflows (lingering=${lingering.map((r) => r.id)})`,
  );
});