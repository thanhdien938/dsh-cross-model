import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PersistenceError } from '../src/persistence/persistence-errors.mjs';
import { BusError, UnknownRunError, UnknownTaskError } from '../src/bus/errors.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import {
  createTaskEnvelope,
  createRunRecord,
  createResultEnvelope,
  createMessageEnvelope,
} from '../src/bus/envelopes.mjs';

async function openRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g2-repo-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const repo = new AgentBusRepository({ store });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, repo };
}

function rawGet(dbPath, sql, params = []) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(params);
  } finally {
    db.close();
  }
}

test('repository contract rejects invalid store dependencies', async (t) => {
  assert.throws(() => new AgentBusRepository(), /requires a persistence store/);
  assert.throws(() => new AgentBusRepository({}), /requires a persistence store/);
  assert.throws(() => new AgentBusRepository({ store: null }), /requires a persistence store/);
});

test('repository contract rejects a store missing repository seams', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g2-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  const { transaction, ...partialStore } = store;
  assert.throws(() => new AgentBusRepository({ store: partialStore }), /repository seams; missing/);
  await store.close();
});

test('createTask/getTask round-trips a full TaskEnvelope faithfully', async (t) => {
  const { repo } = await openRepo(t);
  const task = createTaskEnvelope({
    id: 'task-1',
    sender: 'pm',
    recipient: 'alpha',
    body: 'do the thing',
    context: { depth: 3, tags: ['a', 'b'], nested: { ok: true } },
    expectedOutput: 'a result',
    createdAt: '2026-08-18T01:02:03.000Z',
  });
  repo.createTask(task);
  assert.deepEqual(repo.getTask('task-1'), task);
  assert.equal(repo.getTask('missing'), undefined);
});

test('duplicate task id fails deterministically and leaves valid durable state', async (t) => {
  const { repo } = await openRepo(t);
  const task = createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' });
  repo.createTask(task);
  const duplicate = createTaskEnvelope({ id: 'task-1', recipient: 'beta', body: 'y' });
  assert.throws(() => repo.createTask(duplicate), (error) => error instanceof BusError && error.code === 'DUPLICATE_TASK');
  assert.equal(repo.countTasks(), 1);
  assert.deepEqual(repo.getTask('task-1'), task);
});

test('createRun/getRun round-trips a RunRecord in created state', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const run = createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' });
  repo.createRun(run);
  assert.deepEqual(repo.getRun('run-1'), run);
  assert.equal(repo.getRun('missing'), undefined);
});

test('createRun requires the owning task to exist (FK)', async (t) => {
  const { repo } = await openRepo(t);
  assert.throws(
    () => repo.createRun(createRunRecord({ id: 'run-1', taskId: 'task-missing', agent: 'alpha' })),
    UnknownTaskError,
  );
  assert.equal(repo.countRuns(), 0);
});

test('run transition rules match the legacy StateStore', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));

  const scenarios = [
    { from: 'created', to: 'running' },
    { from: 'created', to: 'failed' },
    { from: 'created', to: 'cancelled' },
    { from: 'created', to: 'completed' },
    { from: 'running', to: 'completed' },
    { from: 'running', to: 'failed' },
    { from: 'running', to: 'cancelled' },
    { from: 'running', to: 'created' },
  ];

  function legacyOutcome(state, runId, status) {
    try {
      state.updateRunStatus(runId, { status });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code };
    }
  }

  function durableOutcome(repoStore, runId, status) {
    try {
      repoStore.updateRunStatus(runId, { status });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code };
    }
  }

  for (const scenario of scenarios) {
    const legacy = new StateStore();
    const task = createTaskEnvelope({ id: `task-${scenario.from}-${scenario.to}`, recipient: 'alpha', body: 'x' });
    legacy.createTask(task);
    const legacyRun = createRunRecord({ id: `run-${scenario.from}-${scenario.to}`, taskId: task.id, agent: 'alpha' });
    legacy.createRun(legacyRun);
    if (scenario.from === 'running') legacy.updateRunStatus(legacyRun.id, { status: 'running' });
    const legacyOutcomeResult = legacyOutcome(legacy, legacyRun.id, scenario.to);

    const durableTask = createTaskEnvelope({ id: `dtask-${scenario.from}-${scenario.to}`, recipient: 'alpha', body: 'x' });
    repo.createTask(durableTask);
    const durableRun = createRunRecord({ id: `drun-${scenario.from}-${scenario.to}`, taskId: durableTask.id, agent: 'alpha' });
    repo.createRun(durableRun);
    if (scenario.from === 'running') repo.updateRunStatus(durableRun.id, { status: 'running' });
    const durableOutcomeResult = durableOutcome(repo, durableRun.id, scenario.to);

    assert.equal(durableOutcomeResult.ok, legacyOutcomeResult.ok, `parity ok for ${scenario.from}->${scenario.to}`);
    if (!legacyOutcomeResult.ok) {
      assert.equal(durableOutcomeResult.code, legacyOutcomeResult.code, `parity code for ${scenario.from}->${scenario.to}`);
    }
  }
});

test('terminal run cannot transition again', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const run = createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' });
  repo.createRun(run);
  repo.updateRunStatus('run-1', { status: 'running' });
  repo.updateRunStatus('run-1', { status: 'completed', completedAt: '2026-08-18T00:00:00.000Z' });
  for (const status of ['running', 'failed', 'cancelled', 'completed']) {
    assert.throws(() => repo.updateRunStatus('run-1', { status }), /already terminal/);
  }
  assert.equal(repo.getRun('run-1').status, 'completed');
});

test('invalid run status is rejected', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  repo.createRun(createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' }));
  assert.throws(() => repo.updateRunStatus('run-1', { status: 'zombie' }), /invalid run status/);
  assert.equal(repo.getRun('run-1').status, 'created');
});

test('updateRunStatus for an unknown run fails with UnknownRunError', async (t) => {
  const { repo } = await openRepo(t);
  assert.throws(() => repo.updateRunStatus('ghost', { status: 'running' }), UnknownRunError);
});

test('addResult round-trips a full ResultEnvelope and enforces one result per run', async (t) => {
  const { dir, repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const run = createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' });
  repo.createRun(run);
  repo.updateRunStatus('run-1', { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  repo.updateRunStatus('run-1', { status: 'completed', completedAt: '2026-08-18T00:00:01.000Z' });
  const result = createResultEnvelope({
    id: 'result-1',
    taskId: 'task-1',
    runId: 'run-1',
    agent: 'alpha',
    status: 'completed',
    output: 'final output',
    stopReason: 'stop', 
    artifacts: [{ name: 'report.md' }, { name: 'stats.json' }],
    handoff: { summary: 'done', nextContext: { step: 2 } },
    completedAt: '2026-08-18T00:00:01.000Z',
  });
  repo.addResult(result);
  assert.deepEqual(repo.getResultByRun('run-1'), result);

  const second = createResultEnvelope({ id: 'result-2', runId: 'run-1', taskId: 'task-1', agent: 'alpha', status: 'completed', output: 'again' });
  assert.throws(() => repo.addResult(second), /result already recorded for run "run-1"/);
  assert.deepEqual(repo.getResultByRun('run-1'), result);

  const row = rawGet(join(dir, 'store.db'), 'SELECT handoff FROM results WHERE run_id = ?', ['run-1']);
  assert.deepEqual(JSON.parse(row.handoff), result);
});

test('addResult for an unknown run is rejected before a row is written', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const result = createResultEnvelope({ id: 'result-1', taskId: 'task-1', runId: 'run-nope', agent: 'alpha', status: 'completed' });
  assert.throws(() => repo.addResult(result), UnknownRunError);
});

test('addMessage round-trips reply/conversation/hop/metadata fields', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const message = createMessageEnvelope({
    id: 'msg-1',
    taskId: 'task-1',
    runId: null,
    from: 'pm',
    to: 'alpha',
    kind: 'message',
    body: 'please refine',
    replyTo: 'msg-0',
    conversationId: 'conv-77',
    hopId: 'hop-3',
    metadata: { tone: 'firm', tags: ['x', 'y'] },
    createdAt: '2026-08-18T02:00:00.000Z',
  });
  repo.addMessage(message);
  assert.deepEqual(repo.messagesForTask('task-1'), [message]);
  const duplicate = createMessageEnvelope({ id: 'msg-1', taskId: 'task-1', from: 'pm', to: 'alpha', body: 'again' });
  assert.throws(() => repo.addMessage(duplicate), (error) => error instanceof BusError && error.code === 'DUPLICATE_MESSAGE');
});

test('messagesForTask preserves durable creation order', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  for (const index of [1, 2, 3]) {
    repo.addMessage(createMessageEnvelope({
      id: `msg-${index}`,
      taskId: 'task-1',
      from: 'pm',
      to: 'alpha',
      body: `message ${index}`,
      createdAt: `2026-08-18T03:00:0${index}.000Z`,
    }));
  }
  assert.deepEqual(repo.messagesForTask('task-1').map((message) => message.body), ['message 1', 'message 2', 'message 3']);
});

test('transcriptForTask preserves durable event ordering and legacy shape', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  for (const event of ['task.created', 'task.dispatched', 'agent.started', 'result.created', 'agent.completed']) {
    repo.appendEvent({ taskId: 'task-1', runId: 'run-1', agent: 'alpha', event });
  }
  const entries = repo.transcriptForTask('task-1');
  assert.deepEqual(entries.map((entry) => entry.event), ['task.created', 'task.dispatched', 'agent.started', 'result.created', 'agent.completed']);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['agent', 'at', 'event', 'runId', 'taskId']);
  }
});

test('appendEvent rejects an empty event name', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  assert.throws(() => repo.appendEvent({ taskId: 'task-1', event: '   ' }), /event name must be a non-empty string/);
  assert.equal(repo.transcriptForTask('task-1').length, 0);
});

test('listRuns filters by taskId/agent/status', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-a', recipient: 'alpha', body: 'x' }));
  repo.createTask(createTaskEnvelope({ id: 'task-b', recipient: 'beta', body: 'x' }));
  repo.createRun(createRunRecord({ id: 'run-a1', taskId: 'task-a', agent: 'alpha' }));
  repo.createRun(createRunRecord({ id: 'run-b1', taskId: 'task-b', agent: 'beta' }));
  repo.createRun(createRunRecord({ id: 'run-a2', taskId: 'task-a', agent: 'alpha' }));
  repo.updateRunStatus('run-a1', { status: 'running' });
  repo.updateRunStatus('run-b1', { status: 'running' });
  repo.updateRunStatus('run-b1', { status: 'completed', completedAt: '2026-08-18T00:00:00.000Z' });

  assert.deepEqual(repo.listRuns({ taskId: 'task-a' }).map((run) => run.id), ['run-a1', 'run-a2']);
  assert.deepEqual(repo.listRuns({ agent: 'beta' }).map((run) => run.id), ['run-b1']);
  assert.deepEqual(repo.listRuns({ status: 'running' }).map((run) => run.id), ['run-a1']);
  assert.deepEqual(repo.listRuns({ taskId: 'task-a', status: 'created' }).map((run) => run.id), ['run-a2']);
  assert.equal(repo.listRuns().length, 3);
});

test('taskCount/runCount reflect durable rows', async (t) => {
  const { repo } = await openRepo(t);
  assert.equal(repo.countTasks(), 0);
  assert.equal(repo.countRuns(), 0);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  repo.createTask(createTaskEnvelope({ id: 'task-2', recipient: 'beta', body: 'x' }));
  repo.createRun(createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' }));
  assert.equal(repo.countTasks(), 2);
  assert.equal(repo.countRuns(), 1);
});

test('sanitized run error persists as plain data, not an Error instance', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  repo.createRun(createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' }));
  repo.updateRunStatus('run-1', { status: 'running' });
  repo.updateRunStatus('run-1', { status: 'failed', completedAt: '2026-08-18T00:00:00.000Z', error: new Error('boom') });
  const failed = repo.getRun('run-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error instanceof Error, false);
  assert.equal(failed.error.message, 'boom');
  assert.equal(failed.error.name, 'Error');
});

test('non-JSON-faithful value fails before any durable mutation', async (t) => {
  const { repo } = await openRepo(t);
  const task = createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' });
  task.context = { fn: () => 'oops' };
  assert.throws(() => repo.createTask(task), (error) => error instanceof PersistenceError && error.code === 'NOT_JSON_FAITHFUL');
  assert.equal(repo.countTasks(), 0);
  assert.equal(repo.getTask('task-1'), undefined);
});

test('failed local mutation leaves no half-applied row/payload', async (t) => {
  const { repo } = await openRepo(t);
  repo.createTask(createTaskEnvelope({ id: 'task-1', recipient: 'alpha', body: 'x' }));
  const run = createRunRecord({ id: 'run-1', taskId: 'task-1', agent: 'alpha' });
  repo.createRun(run);
  repo.updateRunStatus('run-1', { status: 'running', startedAt: '2026-08-18T00:00:00.000Z' });
  assert.throws(() => repo.updateRunStatus('run-1', { status: 'created' }), /invalid run status transition: running -> created/);
  const after = repo.getRun('run-1');
  assert.equal(after.status, 'running');
  assert.equal(after.startedAt, '2026-08-18T00:00:00.000Z');
});

test('assertComplete passes for a full repository', async (t) => {
  const { repo } = await openRepo(t);
  assert.equal(repo.assertComplete(), true);
});