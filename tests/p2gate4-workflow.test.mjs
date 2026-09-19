import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { WorkflowState } from '../src/workflow/workflow-state.mjs';
import { WorkflowRunner } from '../src/workflow/workflow-runner.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { createWorkflowRun } from '../src/workflow/workflow-contracts.mjs';
import { createId } from '../src/bus/envelopes.mjs';
import { PersistenceError } from '../src/persistence/persistence-errors.mjs';
import { BusError } from '../src/bus/errors.mjs';

async function openWorkflow(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g4-wf-'));
  const path = join(dir, 'store.db');
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  const repo = new WorkflowRepository({ store });
  const state = new DurableWorkflowState({ repository: repo });
  const handles = [{ kind: 'store', value: store }, { kind: 'dir', value: dir }];
  t.after(async () => {
    for (const { kind, value } of handles) {
      if (kind === 'store') {
        try {
          await value.close();
        } catch {
          // best-effort close; never mask the test result
        }
      }
    }
    for (const { kind, value } of handles) {
      if (kind === 'dir') rmSync(value, { recursive: true, force: true });
    }
  });
  return { dir, path, store, repo, state, handles };
}

async function reopenWorkflow(t, opened) {
  const store = new SqlitePersistenceStore();
  await store.open({ path: opened.path });
  await store.migrate();
  opened.handles.push({ kind: 'store', value: store });
  const repo = new WorkflowRepository({ store });
  const state = new DurableWorkflowState({ repository: repo });
  return { store, repo, state };
}

function sampleRun() {
  return createWorkflowRun({
    sender: 'pm',
    steps: [
      { recipient: 'alpha', body: 'step one', context: { depth: 1 }, contextFromPrevious: true, expectedOutput: 'e1' },
      { recipient: 'beta', body: 'step two' },
      { recipient: 'gamma', body: 'step three', contextFromPrevious: true },
    ],
  });
}

test('1. workflow repository/state create and read parity with legacy WorkflowState', async (t) => {
  const opened = await openWorkflow(t);
  const run = sampleRun();
  const legacy = new WorkflowState();
  legacy.createWorkflow(run);
  opened.state.createWorkflow(run);
  assert.deepEqual(opened.state.getWorkflow(run.id), legacy.getWorkflow(run.id));
  assert.deepEqual(opened.state.listSteps(run.id), legacy.listSteps(run.id));
  assert.deepEqual(opened.state.listWorkflows(), legacy.listWorkflows());
  assert.equal(opened.state.getStep(run.id, run.steps[1].id).body, 'step two');
});

test('2. workflow/step legal and illegal transitions match legacy behavior', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);
  const stepId = run.steps[0].id;

  const legacy = new WorkflowState();
  legacy.createWorkflow(sampleRun());
  const legacyWorkflowId = legacy.listWorkflows()[0].id;
  const legacyStepId = legacy.listSteps(legacyWorkflowId)[0].id;

  // legal transitions
  state.updateWorkflowStatus(run.id, { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  legacy.updateWorkflowStatus(legacyWorkflowId, { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  state.updateStepStatus(run.id, stepId, { status: 'running' });
  legacy.updateStepStatus(legacyWorkflowId, legacyStepId, { status: 'running' });
  state.updateStepStatus(run.id, stepId, { status: 'completed', taskId: 'task_x', runId: 'run_x', resultId: 'result_x' });
  legacy.updateStepStatus(legacyWorkflowId, legacyStepId, { status: 'completed', taskId: 'task_x', runId: 'run_x', resultId: 'result_x' });
  assert.equal(state.getStep(run.id, stepId).status, 'completed');

  const sameRejection = (fnA, fnB) => {
    let a = null;
    let b = null;
    try {
      fnA();
    } catch (error) {
      a = error;
    }
    try {
      fnB();
    } catch (error) {
      b = error;
    }
    assert.ok(a instanceof BusError, 'durable must throw a BusError');
    assert.ok(b instanceof BusError, 'legacy must throw a BusError');
    assert.equal(a.message, b.message);
  };

  // illegal step transition: fresh created step -> completed
  sameRejection(
    () => state.updateStepStatus(run.id, run.steps[1].id, { status: 'completed' }),
    () => legacy.updateStepStatus(legacyWorkflowId, legacy.listSteps(legacyWorkflowId)[1].id, { status: 'completed' }),
  );
  // terminal step is immutable
  sameRejection(
    () => state.updateStepStatus(run.id, stepId, { status: 'running' }),
    () => legacy.updateStepStatus(legacyWorkflowId, legacyStepId, { status: 'running' }),
  );
  // illegal workflow transition: running -> created
  sameRejection(
    () => state.updateWorkflowStatus(run.id, { status: 'created' }),
    () => legacy.updateWorkflowStatus(legacyWorkflowId, { status: 'created' }),
  );
});

test('3. workflow spec + all step fields round-trip faithfully (incl. updates)', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);

  state.updateWorkflowStatus(run.id, { status: 'running', startedAt: '2026-08-18T00:01:00.000Z' });
  state.updateStepStatus(run.id, run.steps[0].id, { status: 'running' });
  state.updateStepStatus(run.id, run.steps[0].id, {
    status: 'completed',
    taskId: 'task_abc',
    runId: 'run_abc',
    resultId: 'result_abc',
  });
  state.updateStepStatus(run.id, run.steps[1].id, {
    status: 'running',
    dispatchedContext: { derived: { previous: 'run_abc' }, extra: 7 },
  });

  const reopened = await reopenWorkflow(t, opened);
  const before = opened.state.getWorkflow(run.id);
  const after = reopened.state.getWorkflow(run.id);
  assert.deepEqual(after, before);
  assert.equal(after.steps[0].status, 'completed');
  assert.equal(after.steps[0].taskId, 'task_abc');
  assert.equal(after.steps[0].runId, 'run_abc');
  assert.equal(after.steps[0].resultId, 'result_abc');
  assert.equal(after.steps[1].status, 'running');
  assert.deepEqual(after.steps[1].dispatchedContext, { derived: { previous: 'run_abc' }, extra: 7 });
  assert.equal(after.steps[2].body, 'step three');
  assert.equal(after.steps[2].contextFromPrevious, true);
});

test('4. workflow step terminal transition + lineage fields are atomic (no partial write)', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);
  state.updateWorkflowStatus(run.id, { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  state.updateStepStatus(run.id, run.steps[0].id, { status: 'running', taskId: 'task_w1' });

  await assert.rejects(
    async () => state.updateStepStatus(run.id, run.steps[0].id, {
      status: 'completed',
      taskId: 'task_w2',
      runId: 'run_w2',
      resultId: 'result_w2',
      dispatchedContext: { when: new Date('2026-08-18T00:00:00.000Z') }, // Date is NOT JSON-faithful
    }),
    (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL',
  );

  const step = state.getStep(run.id, run.steps[0].id);
  assert.equal(step.status, 'running', 'status must not have been committed');
  assert.equal(step.taskId, 'task_w1', 'lineage must not have been partially committed');
  assert.equal(step.runId, null);
  assert.equal(step.resultId, null);
});

test('5. workflow transcript ordering survives close/reopen', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);
  state.appendEvent({ workflowId: run.id, event: 'workflow.created', at: '2026-08-18T00:00:00.000Z' });
  state.appendEvent({ workflowId: run.id, event: 'step.created', stepId: run.steps[0].id, at: '2026-08-18T00:00:00.001Z' });
  state.appendEvent({ workflowId: run.id, event: 'step.created', stepId: run.steps[1].id, at: '2026-08-18T00:00:00.002Z' });
  state.appendEvent({ workflowId: run.id, event: 'workflow.completed', at: '2026-08-18T00:00:00.003Z' });

  const reopened = await reopenWorkflow(t, opened);
  const after = reopened.state.transcript(run.id);
  assert.deepEqual(
    after.map((entry) => entry.event),
    ['workflow.created', 'step.created', 'step.created', 'workflow.completed'],
  );
  assert.equal(after.map((entry) => entry.at).join(','), '2026-08-18T00:00:00.000Z,2026-08-18T00:00:00.001Z,2026-08-18T00:00:00.002Z,2026-08-18T00:00:00.003Z');
  assert.deepEqual(opened.state.transcript(run.id), after);
});

test('6. fresh object reopen reconstructs workflow + steps + transcript deep-equivalent', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);
  state.updateWorkflowStatus(run.id, { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  state.updateStepStatus(run.id, run.steps[0].id, { status: 'running' });
  state.updateStepStatus(run.id, run.steps[0].id, { status: 'completed', taskId: 'task_1', runId: 'run_1', resultId: 'result_1' });
  state.updateStepStatus(run.id, run.steps[1].id, { status: 'skipped' });
  state.updateWorkflowStatus(run.id, { status: 'failed', completedAt: '2026-08-18T00:00:00.500Z', error: { stepIndex: 1, stepId: run.steps[1].id, runId: null, error: { name: 'Error', message: 'boom', code: 'X' } } });
  state.appendEvent({ workflowId: run.id, event: 'workflow.created', at: '2026-08-18T00:00:00.000Z' });
  state.appendEvent({ workflowId: run.id, event: 'workflow.failed', at: '2026-08-18T00:00:00.500Z' });

  const before = state.getWorkflow(run.id);
  const transcriptBefore = state.transcript(run.id);
  assert.equal(before.status, 'failed');
  assert.deepEqual(before.error, { stepIndex: 1, stepId: run.steps[1].id, runId: null, error: { name: 'Error', message: 'boom', code: 'X' } });

  const reopened = await reopenWorkflow(t, opened);
  assert.deepEqual(reopened.state.getWorkflow(run.id), before);
  assert.deepEqual(reopened.state.transcript(run.id), transcriptBefore);
  assert.equal(opened.repo.countWorkflows(), 1);
});

test('7. nonterminal workflow/step survives reopen unchanged and causes zero adapter calls', async (t) => {
  const opened = await openWorkflow(t);
  const { state } = opened;
  const run = sampleRun();
  state.createWorkflow(run);
  state.updateWorkflowStatus(run.id, { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  state.updateStepStatus(run.id, run.steps[0].id, { status: 'running', taskId: 'task_pending', runId: 'run_pending' });
  state.appendEvent({ workflowId: run.id, event: 'step.started', stepId: run.steps[0].id, at: '2026-08-18T00:00:00.000Z' });

  const before = state.getWorkflow(run.id);
  const reopened = await reopenWorkflow(t, opened);
  assert.deepEqual(reopened.state.getWorkflow(run.id), before);

  const calls = [];
  const bus = {
    dispatch: async () => {
      calls.push('dispatch');
      throw new Error('never reached');
    },
    events: new EventBus(),
  };
  const runner = new WorkflowRunner({ bus, state: reopened.state });
  assert.equal(calls.length, 0, 'constructing runner/hydrating durable state must not dispatch');
  assert.equal(reopened.state.getWorkflow(run.id).status, 'running');
  assert.equal(reopened.state.getStep(run.id, run.steps[0].id).status, 'running');
  await opened.store.close();
});

test('17. NOT_JSON_FAITHFUL workflow payload fails before any mutation', async (t) => {
  const opened = await openWorkflow(t);
  const run = sampleRun();
  run.steps[0].context = { when: new Date('2026-08-18T00:00:00.000Z') };
  await assert.rejects(
    async () => opened.state.createWorkflow(run),
    (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL',
  );
  assert.equal(opened.store.get('SELECT COUNT(*) AS c FROM workflows').c, 0);
  assert.equal(opened.store.get('SELECT COUNT(*) AS c FROM workflow_steps').c, 0);
  assert.equal(opened.store.get('SELECT COUNT(*) AS c FROM workflow_events').c, 0);
});

test('16w. duplicate/stable-id workflow constraints fail deterministically', async (t) => {
  const opened = await openWorkflow(t);
  const run = sampleRun();
  opened.state.createWorkflow(run);
  await assert.rejects(
    async () => opened.state.createWorkflow(run),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_WORKFLOW',
  );

  // facade-level: two steps with the same index map to DUPLICATE_STEP_INDEX
  const collision = sampleRun();
  collision.steps[1].index = collision.steps[0].index;
  await assert.rejects(
    async () => opened.state.createWorkflow(collision),
    (error) => error instanceof BusError && error.code === 'DUPLICATE_STEP_INDEX',
  );
  assert.equal(opened.store.get('SELECT COUNT(*) AS c FROM workflows').c, 1, 'collision workflow must not persist');

  // schema-level: a raw insert into a taken (workflow_id, step_index) slot is
  // rejected by the UNIQUE index itself, so no duplicate rows can ever exist
  await assert.rejects(
    async () => opened.store.run(
      'INSERT INTO workflow_steps (id, workflow_id, step_index, recipient, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [createId('step'), run.id, 0, 'alpha', 'created', '2026-08-18T00:00:00.000Z'],
    ),
    (error) => error && /UNIQUE constraint failed/.test(String(error.message ?? error)),
  );
  assert.equal(opened.store.get('SELECT COUNT(*) AS c FROM workflow_steps').c, run.steps.length, 'no step rows may leak');
});