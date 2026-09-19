import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { DurableStateStore } from '../src/bus/durable-state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { PersistenceError } from '../src/persistence/persistence-errors.mjs';
import { BusError } from '../src/bus/errors.mjs';
import {
  createTaskEnvelope,
  createRunRecord,
  createResultEnvelope,
  createMessageEnvelope,
} from '../src/bus/envelopes.mjs';

async function openDurable(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g2-durable-'));
  const path = join(dir, 'store.db');
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  const repo = new AgentBusRepository({ store });
  const durable = new DurableStateStore({ repository: repo });
  const handles = [store];
  t.after(async () => {
    for (const handle of handles) {
      try {
        await handle.close();
      } catch {
        // best-effort close; never mask the test result
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, store, repo, durable, handles };
}

async function openSecond(t, opened) {
  const store = new SqlitePersistenceStore();
  await store.open({ path: opened.path });
  await store.migrate();
  opened.handles.push(store);
  return store;
}

function newBusWithDurable(durable, registry) {
  const events = new EventBus();
  const bus = new AgentBus({ registry, events, state: durable });
  return { events, bus };
}

const completedAdapter = { start: async () => ({ output: 'fake durable output', stopReason: 'completed', artifacts: [{ name: 'out.txt' }] }) };

test('DurableStateStore rejects invalid dependencies', async () => {
  assert.throws(() => new DurableStateStore(), /requires an AgentBus repository/);
  assert.throws(() => new DurableStateStore({}), /requires an AgentBus repository/);
  assert.throws(() => new DurableStateStore({ repository: { createTask() {} } }), /StateStore-facing methods; missing/);
  assert.throws(
    () => new DurableStateStore({ repository: { createTask() {}, createRun() {}, addMessage() {}, addResult() {}, appendEvent() {}, updateRunStatus() {}, getTask() {}, getRun() {}, getResultByRun() {}, messagesForTask() {}, transcriptForTask() {}, listRuns() {} } }),
    /countTasks\/countRuns/,
  );
});

test('AgentBus over a durable store persists the full lifecycle and reconstructs with brand-new objects', async (t) => {
  const opened = await openDurable(t);
  const registry = new AgentRegistry();
  registry.register('alpha', completedAdapter);
  const { bus } = newBusWithDurable(opened.durable, registry);

  const run = await bus.dispatch({ recipient: 'alpha', body: 'do durable work', context: { depth: 2 }, expectedOutput: 'yes' });
  bus.recordMessage({ from: 'pm', to: 'alpha', taskId: run.taskId, runId: run.id, body: 'note on completion' });

  const taskBefore = bus.task(run.taskId);
  const runBefore = bus.run(run.id);
  const resultBefore = bus.result(run.id);
  const messagesBefore = bus.messagesForTask(run.taskId);
  const transcriptBefore = bus.transcriptForTask(run.taskId);
  const runsBefore = bus.listRuns({ taskId: run.taskId });
  const taskCountBefore = opened.durable.taskCount;
  const runCountBefore = opened.durable.runCount;

  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  const registryB = new AgentRegistry();
  const eventsB = new EventBus();
  const busB = new AgentBus({ registry: registryB, events: eventsB, state: durableB });

  assert.deepEqual(busB.task(run.taskId), taskBefore);
  assert.deepEqual(busB.run(run.id), runBefore);
  assert.deepEqual(busB.result(run.id), resultBefore);
  assert.deepEqual(busB.messagesForTask(run.taskId), messagesBefore);
  assert.deepEqual(busB.transcriptForTask(run.taskId), transcriptBefore);
  assert.deepEqual(busB.listRuns({ taskId: run.taskId }), runsBefore);
  assert.equal(durableB.taskCount, taskCountBefore);
  assert.equal(durableB.runCount, runCountBefore);

  assert.equal(runBefore.status, 'completed');
  assert.equal(resultBefore.status, 'completed');
  assert.equal(resultBefore.output, 'fake durable output');
  assert.equal(resultBefore.stopReason, 'completed');
  assert.deepEqual(resultBefore.artifacts, [{ name: 'out.txt' }]);
});

test('failure/cancellation path persists sanitized state that reconstructs after reopen', async (t) => {
  const opened = await openDurable(t);
  const registry = new AgentRegistry();
  registry.register('gamma', { start: async () => { throw new Error('durable boom'); }, dispose: async () => {} });
  const { bus } = newBusWithDurable(opened.durable, registry);
  await assert.rejects(bus.dispatch({ recipient: 'gamma', body: 'x' }), /durable boom/);

  const failedBefore = opened.durable.listRuns({ status: 'failed' })[0];
  assert.equal(failedBefore.error.message, 'durable boom');
  assert.equal(failedBefore.error instanceof Error, false);

  await opened.store.close();
  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  const failedAfter = durableB.listRuns({ status: 'failed' })[0];
  assert.equal(failedAfter.status, 'failed');
  assert.equal(failedAfter.error.message, 'durable boom');
  assert.equal(failedAfter.error instanceof Error, false);
  assert.deepEqual(failedAfter, failedBefore);
});

test('messagesForTask creation ordering survives close/reopen with fresh objects', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-m', recipient: 'alpha', body: 'x' }));
  for (const index of [1, 2, 3]) {
    opened.durable.addMessage(createMessageEnvelope({
      id: `msg-${index}`,
      taskId: 'task-m',
      from: 'pm',
      to: 'alpha',
      body: `order ${index}`,
      createdAt: `2026-08-18T03:00:0${index}.000Z`,
    }));
  }
  const before = opened.durable.messagesForTask('task-m').map((message) => message.body);
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  assert.deepEqual(durableB.messagesForTask('task-m').map((message) => message.body), before);
});

test('transcriptForTask event ordering survives close/reopen with fresh objects', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-t', recipient: 'alpha', body: 'x' }));
  for (const event of ['task.created', 'task.dispatched', 'agent.started', 'result.created', 'agent.completed']) {
    opened.durable.appendEvent({ taskId: 'task-t', runId: 'run-t', agent: 'alpha', event });
  }
  const before = opened.durable.transcriptForTask('task-t');
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  assert.deepEqual(durableB.transcriptForTask('task-t'), before);
});

test('listRuns filters survive close/reopen', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-a', recipient: 'alpha', body: 'x' }));
  opened.durable.createTask(createTaskEnvelope({ id: 'task-b', recipient: 'beta', body: 'x' }));
  opened.durable.createRun(createRunRecord({ id: 'run-a1', taskId: 'task-a', agent: 'alpha' }));
  opened.durable.createRun(createRunRecord({ id: 'run-b1', taskId: 'task-b', agent: 'beta' }));
  opened.durable.createRun(createRunRecord({ id: 'run-a2', taskId: 'task-a', agent: 'alpha' }));
  opened.durable.updateRunStatus('run-a1', { status: 'running' });
  opened.durable.updateRunStatus('run-b1', { status: 'running' });
  opened.durable.updateRunStatus('run-b1', { status: 'completed', completedAt: '2026-08-18T00:00:00.000Z' });

  const filtersBefore = {
    byTask: opened.durable.listRuns({ taskId: 'task-a' }).map((run) => run.id),
    byAgent: opened.durable.listRuns({ agent: 'beta' }).map((run) => run.id),
    byStatus: opened.durable.listRuns({ status: 'running' }).map((run) => run.id),
    all: opened.durable.listRuns().map((run) => run.id),
  };
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  assert.deepEqual(durableB.listRuns({ taskId: 'task-a' }).map((run) => run.id), filtersBefore.byTask);
  assert.deepEqual(durableB.listRuns({ agent: 'beta' }).map((run) => run.id), filtersBefore.byAgent);
  assert.deepEqual(durableB.listRuns({ status: 'running' }).map((run) => run.id), filtersBefore.byStatus);
  assert.deepEqual(durableB.listRuns().map((run) => run.id), filtersBefore.all);
});

test('taskCount/runCount survive close/reopen', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-c', recipient: 'alpha', body: 'x' }));
  opened.durable.createRun(createRunRecord({ id: 'run-c', taskId: 'task-c', agent: 'alpha' }));
  opened.durable.createTask(createTaskEnvelope({ id: 'task-c2', recipient: 'beta', body: 'x' }));
  const countsBefore = { tasks: opened.durable.taskCount, runs: opened.durable.runCount };
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  assert.equal(durableB.taskCount, countsBefore.tasks);
  assert.equal(durableB.runCount, countsBefore.runs);
});

test('persisted running run is observable after reopen but causes ZERO automatic dispatch/replay/reclassify', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-live', recipient: 'alpha', body: 'x' }));
  opened.durable.createRun(createRunRecord({ id: 'run-live', taskId: 'task-live', agent: 'alpha' }));
  opened.durable.updateRunStatus('run-live', { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  opened.durable.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'task.created' });
  opened.durable.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'task.dispatched' });
  opened.durable.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'agent.started' });
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  const calls = [];
  const registryB = new AgentRegistry();
  registryB.register('alpha', {
    start: async () => { calls.push('start'); return { output: 'should never happen' }; },
    dispose: async () => { calls.push('dispose'); },
  });
  const { bus: busB } = newBusWithDurable(durableB, registryB);

  const visible = busB.listRuns({ status: 'running' });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'run-live');
  assert.equal(visible[0].status, 'running');
  assert.equal(busB.run('run-live').status, 'running');
  assert.equal(busB.transcriptForTask('task-live').map((entry) => entry.event).join(','), 'task.created,task.dispatched,agent.started');
  assert.deepEqual(calls, []);

  const persisted = await openSecond(t, opened);
  const inspectionRuns = persisted.all("SELECT id, status FROM runs WHERE id = 'run-live'");
  assert.equal(inspectionRuns.length, 1);
  assert.equal(inspectionRuns[0].status, 'running');
});

test('duplicate task id after reopen fails deterministically and leaves the original intact', async (t) => {
  const opened = await openDurable(t);
  const task = createTaskEnvelope({ id: 'task-d', recipient: 'alpha', body: 'original body' });
  opened.durable.createTask(task);
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  const duplicate = createTaskEnvelope({ id: 'task-d', recipient: 'beta', body: 'new body' });
  assert.throws(() => durableB.createTask(duplicate), (error) => error instanceof BusError && error.code === 'DUPLICATE_TASK');
  assert.equal(durableB.taskCount, 1);
  assert.deepEqual(durableB.getTask('task-d'), task);
});

test('non-JSON-faithful durable value fails before mutation and leaves valid durable state', async (t) => {
  const opened = await openDurable(t);
  const task = createTaskEnvelope({ id: 'task-bad', recipient: 'alpha', body: 'x' });
  task.context = { fn: () => 'no' };
  assert.throws(() => opened.durable.createTask(task), (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL');
  assert.equal(opened.durable.taskCount, 0);
  assert.equal(opened.durable.getTask('task-bad'), undefined);

  const clean = createTaskEnvelope({ id: 'task-good', recipient: 'alpha', body: 'x' });
  opened.durable.createTask(clean);
  assert.equal(opened.durable.taskCount, 1);
});

test('legacy in-memory StateStore output shape matches the durable store for the same scenario', async (t) => {
  const legacyState = new StateStore();
  const registryL = new AgentRegistry();
  registryL.register('alpha', completedAdapter);
  registryL.register('gamma', { start: async () => { throw new Error('legacy boom'); }, dispose: async () => {} });
  const busL = new AgentBus({ registry: registryL, events: new EventBus(), state: legacyState });
  const runL = await busL.dispatch({ recipient: 'alpha', body: 'x' });
  await assert.rejects(busL.dispatch({ recipient: 'gamma', body: 'x' }), /legacy boom/);

  const opened = await openDurable(t);
  const registryD = new AgentRegistry();
  registryD.register('alpha', completedAdapter);
  registryD.register('gamma', { start: async () => { throw new Error('durable boom'); }, dispose: async () => {} });
  const busD = new AgentBus({ registry: registryD, events: new EventBus(), state: opened.durable });
  const runD = await busD.dispatch({ recipient: 'alpha', body: 'x' });
  await assert.rejects(busD.dispatch({ recipient: 'gamma', body: 'x' }), /durable boom/);

  const normalize = (runs) => runs.map(({ agent, status, error }) => ({ agent, status, errorName: error?.name ?? null, hasError: error !== null }));
  assert.deepEqual(normalize(opened.durable.listRuns()), normalize(legacyState.listRuns()));

  const legacyEvents = legacyState.transcriptForTask(runL.taskId).map((entry) => entry.event);
  const durableEvents = opened.durable.transcriptForTask(runD.taskId).map((entry) => entry.event);
  assert.deepEqual(durableEvents, legacyEvents);
  assert.deepEqual(durableEvents, ['task.created', 'task.dispatched', 'agent.started', 'result.created', 'agent.completed']);

  const failedTaskId = opened.durable.listRuns({ status: 'failed' })[0].taskId;
  assert.deepEqual(
    opened.durable.transcriptForTask(failedTaskId).map((entry) => entry.event),
    ['task.created', 'task.dispatched', 'agent.started', 'agent.failed'],
  );

  const failedDurable = opened.durable.listRuns({ status: 'failed' })[0];
  const failedLegacy = legacyState.listRuns({ status: 'failed' })[0];
  assert.equal(failedDurable.error.name, failedLegacy.error.name);
  assert.equal(failedDurable.error instanceof Error, false);
  assert.equal(failedLegacy.error instanceof Error, false);
});

test('a ResultEnvelope with handoff round-trips through the durable store and reopen', async (t) => {
  const opened = await openDurable(t);
  opened.durable.createTask(createTaskEnvelope({ id: 'task-multipart', recipient: 'alpha', body: 'x' }));
  opened.durable.createRun(createRunRecord({ id: 'run-multipart', taskId: 'task-multipart', agent: 'alpha' }));
  opened.durable.updateRunStatus('run-multipart', { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  opened.durable.updateRunStatus('run-multipart', { status: 'completed', completedAt: '2026-08-18T00:00:01.000Z' });
  const result = createResultEnvelope({
    id: 'result-multipart',
    taskId: 'task-multipart',
    runId: 'run-multipart',
    agent: 'alpha',
    status: 'completed',
    output: 'out',
    stopReason: 'done',
    artifacts: ['a', { b: 2 }],
    handoff: { summary: 's', nextContext: { step: 3 }, recommendations: ['x'] },
    completedAt: '2026-08-18T00:00:01.000Z',
  });
  opened.durable.addResult(result);
  await opened.store.close();

  const storeB = await openSecond(t, opened);
  const durableB = new DurableStateStore({ repository: new AgentBusRepository({ store: storeB }) });
  assert.deepEqual(durableB.getResultByRun('run-multipart'), result);
});