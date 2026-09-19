import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskEnvelope,
  createMessageEnvelope,
  createResultEnvelope,
  createRunRecord,
} from '../src/bus/envelopes.mjs';
import { InvalidEnvelopeError } from '../src/bus/errors.mjs';
import { StateStore } from '../src/bus/state-store.mjs';

test('task envelope: generated ids, defaults, and required fields', () => {
  const task = createTaskEnvelope({ recipient: 'alpha', body: 'Do the thing' });
  assert.match(task.id, /^task_/);
  assert.equal(task.sender, 'pm');
  assert.equal(task.type, 'task');
  assert.deepEqual(task.context, {});
  assert.equal(task.expectedOutput, null);
  assert.ok(!Number.isNaN(Date.parse(task.createdAt)));
});

test('task envelope: rejects a missing recipient or empty body', () => {
  assert.throws(() => createTaskEnvelope({ recipient: '', body: 'x' }), InvalidEnvelopeError);
  assert.throws(() => createTaskEnvelope({ recipient: 'alpha' }), InvalidEnvelopeError);
  assert.throws(() => createTaskEnvelope({ recipient: 'alpha', body: '   ' }), InvalidEnvelopeError);
});

test('message envelope: defaults and required fields', () => {
  const msg = createMessageEnvelope({ taskId: 'task_1', from: 'pm', to: 'alpha', body: 'note' });
  assert.match(msg.id, /^msg_/);
  assert.equal(msg.runId, null);
  assert.equal(msg.kind, 'message');
  assert.equal(msg.replyTo, null);
});

test('result envelope: validates status and correlates ids', () => {
  const result = createResultEnvelope({
    taskId: 'task_1',
    runId: 'run_1',
    agent: 'alpha',
    status: 'completed',
    output: 'done',
  });
  assert.match(result.id, /^result_/);
  assert.equal(result.taskId, 'task_1');
  assert.equal(result.runId, 'run_1');
  assert.equal(result.agent, 'alpha');
  assert.deepEqual(result.artifacts, []);
  assert.throws(
    () => createResultEnvelope({ taskId: 't', runId: 'r', agent: 'a', status: 'complete' }),
    InvalidEnvelopeError,
  );
});

test('run record: initial created state with generated id', () => {
  const run = createRunRecord({ taskId: 'task_1', agent: 'alpha' });
  assert.match(run.id, /^run_/);
  assert.equal(run.status, 'created');
  assert.equal(run.startedAt, null);
  assert.equal(run.completedAt, null);
  assert.equal(run.error, null);
});

test('state store: enforces explicit run transitions', () => {
  const state = new StateStore();
  const run = state.createRun(createRunRecord({ taskId: 't', agent: 'a' }));
  assert.equal(state.getRun(run.id).status, 'created');
  state.updateRunStatus(run.id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(state.getRun(run.id).status, 'running');
  state.updateRunStatus(run.id, { status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' });
  assert.equal(state.getRun(run.id).status, 'completed');
  assert.throws(() => state.updateRunStatus(run.id, { status: 'running' }), /already terminal/);
  assert.throws(() => state.updateRunStatus('nope', { status: 'running' }), /unknown run/);
  assert.throws(() => state.updateRunStatus(run.id, { status: 'weird' }), /invalid run status/);
});

test('state store: single result per run, sanitized errors, transcript ordering', () => {
  const state = new StateStore();
  const run = state.createRun(createRunRecord({ taskId: 't1', agent: 'a' }));
  state.addResult(createResultEnvelope({ taskId: 't1', runId: run.id, agent: 'a', status: 'completed', output: 'x' }));
  assert.throws(() => state.addResult(createResultEnvelope({ taskId: 't1', runId: run.id, agent: 'a', status: 'completed' })), /already recorded/);

  const run2 = state.createRun(createRunRecord({ taskId: 't2', agent: 'b' }));
  state.updateRunStatus(run2.id, { status: 'failed', error: new Error('boom') });
  const err = state.getRun(run2.id).error;
  assert.equal(err.message, 'boom');
  assert.equal(err instanceof Error, false);

  state.appendEvent({ taskId: 't1', runId: run.id, agent: 'a', event: 'task.created' });
  state.appendEvent({ taskId: 't1', runId: run.id, agent: 'a', event: 'agent.completed' });
  assert.deepEqual(
    state.transcriptForTask('t1').map((entry) => entry.event),
    ['task.created', 'agent.completed'],
  );
  assert.equal(state.listRuns({ status: 'failed' }).length, 1);
});
