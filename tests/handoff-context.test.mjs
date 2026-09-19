import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffContext, mergeStepContext } from '../src/workflow/handoff-context.mjs';
import { createWorkflowRun } from '../src/workflow/workflow-contracts.mjs';
import { InvalidEnvelopeError } from '../src/bus/errors.mjs';

function sample() {
  const workflow = createWorkflowRun({
    sender: 'pm',
    steps: [
      { recipient: 'alpha', body: 'produce' },
      { recipient: 'bravo', body: 'review', contextFromPrevious: true },
    ],
  });
  const previousStep = workflow.steps[0];
  const nextStep = workflow.steps[1];
  previousStep.taskId = 'task_a';
  previousStep.runId = 'run_a';
  previousStep.resultId = 'result_a';
  const previousResult = {
    id: 'result_a',
    taskId: 'task_a',
    runId: 'run_a',
    agent: 'alpha',
    status: 'completed',
    output: 'alpha produced this',
    artifacts: [{ name: 'art.json' }],
    handoff: { summary: 'handoff data', nextContext: { step: 2 }, recommendations: ['a', 'b'] },
    completedAt: '2026-01-01T00:00:00.000Z',
  };
  return { workflow, previousStep, nextStep, previousResult };
}

test('handoff context: carries workflow and previousResult blocks with structural keys only', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const ctx = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  assert.deepEqual(Object.keys(ctx).sort(), ['previousResult', 'workflow']);
  assert.deepEqual(ctx.workflow, {
    workflowId: workflow.id,
    previousStepId: previousStep.id,
    previousTaskId: 'task_a',
    previousRunId: 'run_a',
    previousAgent: 'alpha',
  });
  assert.deepEqual(Object.keys(ctx.previousResult).sort(), ['artifacts', 'handoff', 'output', 'status']);
});

test('handoff context: previous normalized output is preserved as text', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const ctx = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  assert.equal(ctx.previousResult.output, 'alpha produced this');
});

test('handoff context: structured handoff is preserved as structure, not prose', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const ctx = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  assert.deepEqual(ctx.previousResult.handoff, previousResult.handoff);
  assert.ok(ctx.previousResult.handoff !== previousResult.handoff);
  assert.equal(typeof ctx.previousResult.handoff.recommendations, 'object');
});

test('handoff context: no role-specific or hidden field names appear', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const ctx = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  const flat = JSON.stringify(ctx);
  for (const banned of ['reviewerOutput', 'coderResult', 'judgeVerdict', 'env', 'session', 'auth', 'token']) {
    assert.ok(!flat.includes(banned), `handoff context must not contain "${banned}"`);
  }
});

test('handoff context: deterministic for the same inputs and JSON round-trips', () => {
  const a = sample();
  const ctxA = buildHandoffContext({ ...a });
  const ctxB = buildHandoffContext({ ...a });
  assert.deepEqual(ctxA, ctxB);
  assert.notEqual(ctxA.previousResult.handoff, a.previousResult.handoff);
  const round = JSON.parse(JSON.stringify(ctxA));
  assert.deepEqual(round, ctxA);
});

test('handoff context: rejects missing inputs clearly', () => {
  assert.throws(() => buildHandoffContext(), InvalidEnvelopeError);
  assert.throws(
    () => buildHandoffContext({ workflow: { id: 'wf' }, previousStep: {}, previousResult: {} }),
    InvalidEnvelopeError,
  );
});

test('handoff context merge: precedence is derived-base with explicit keys winning', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const derived = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  const explicit = { previousResult: { note: 'explicit wins' }, extra: 1 };
  const merged = mergeStepContext({ derived, explicit });
  assert.deepEqual(merged.workflow, derived.workflow);
  assert.deepEqual(merged.previousResult, { note: 'explicit wins' });
  assert.equal(merged.extra, 1);
});

test('handoff context merge: no explicit context leaves derived unchanged', () => {
  const { workflow, previousStep, nextStep, previousResult } = sample();
  const derived = buildHandoffContext({ workflow, previousStep, previousResult, nextStep });
  assert.deepEqual(mergeStepContext({ derived }), derived);
  assert.deepEqual(mergeStepContext({ derived: null }), {});
});