#!/usr/bin/env node
import process from 'node:process';
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g2-smoke-'));
const dbPath = join(dir, 'durable.db');

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` });
  }
}

async function openDurable() {
  const store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  await store.migrate();
  const repository = new AgentBusRepository({ store });
  const state = new DurableStateStore({ repository });
  return { store, repository, state };
}

function newHarness(state) {
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', { start: async () => ({ output: 'durable smoke output', stopReason: 'completed', artifacts: [{ name: 'smoke.txt' }] }) });
  const bus = new AgentBus({ registry, events, state });
  return { events, registry, bus };
}

const okAdapter = { start: async () => ({ output: 'legacy smoke output', stopReason: 'completed' }) };

async function main() {
  let durable;
  let reopenSnapshot = null;
  durable = await openDurable();

  await check('durable AgentBus success writes task/run/result', async () => {
    const { bus } = newHarness(durable.state);
    const run = await bus.dispatch({ recipient: 'alpha', body: 'durable task body' });
    if (run.status !== 'completed') throw new Error(`expected completed, got ${run.status}`);
    if (bus.result(run.id).output !== 'durable smoke output') throw new Error('result output missing');
    if (durable.state.taskCount !== 1 || durable.state.runCount !== 1) {
      throw new Error(`counts task=${durable.state.taskCount} run=${durable.state.runCount}`);
    }
    return `${durable.state.taskCount} task / ${durable.state.runCount} run`;
  });

  await check('message + transcript persisted', async () => {
    const run = durable.state.listRuns()[0];
    durable.state.addMessage({
      id: 'msg-smoke-1',
      taskId: run.taskId,
      runId: run.id,
      from: 'pm',
      to: 'alpha',
      kind: 'message',
      body: 'smoke note',
      replyTo: null,
      conversationId: null,
      hopId: null,
      metadata: { smoke: true },
      createdAt: new Date().toISOString(),
    });
    const messages = durable.state.messagesForTask(run.taskId);
    if (messages.length !== 1 || messages[0].id !== 'msg-smoke-1') throw new Error('message not persisted');
    const transcript = durable.state.transcriptForTask(run.taskId).map((entry) => entry.event);
    if (transcript.join(',') !== 'task.created,task.dispatched,agent.started,result.created,agent.completed') {
      throw new Error(`unexpected transcript: ${transcript.join(',')}`);
    }
    return `${messages.length} message / ${transcript.length} events`;
  });

  await check('close/discard/reopen with fresh objects', async () => {
    const taskBefore = durable.state.getTask(durable.state.listRuns()[0].taskId);
    const runBefore = durable.state.listRuns()[0];
    const resultBefore = durable.state.getResultByRun(runBefore.id);
    const messagesBefore = durable.state.messagesForTask(runBefore.taskId);
    const transcriptBefore = durable.state.transcriptForTask(runBefore.taskId);
    await durable.store.close();
    durable = await openDurable();
    const taskAfter = durable.state.getTask(runBefore.taskId);
    const runAfter = durable.state.getRun(runBefore.id);
    const resultAfter = durable.state.getResultByRun(runBefore.id);
    const messagesAfter = durable.state.messagesForTask(runBefore.taskId);
    const transcriptAfter = durable.state.transcriptForTask(runBefore.taskId);
    reopenSnapshot = { taskBefore, runBefore, resultBefore, messagesBefore, transcriptBefore, taskAfter: taskAfter, runAfter: runAfter, resultAfter: resultAfter, messagesAfter: messagesAfter, transcriptAfter: transcriptAfter };
    return 'fresh store/repository/DurableStateStore opened on same temp DB';
  });

  await check('same ids/status/result/message/transcript recovered', async () => {
    const snapshot = reopenSnapshot;
    if (!snapshot) throw new Error('reopen snapshot unavailable');
    if (snapshot.taskBefore.id !== snapshot.taskAfter.id) throw new Error('task id drifted');
    if (snapshot.runBefore.id !== snapshot.runAfter.id || snapshot.runBefore.status !== snapshot.runAfter.status) {
      throw new Error('run id/status drifted');
    }
    if (snapshot.resultBefore.id !== snapshot.resultAfter.id) throw new Error('result id drifted');
    if (JSON.stringify(snapshot.resultBefore) !== JSON.stringify(snapshot.resultAfter)) throw new Error('result payload drifted');
    if (JSON.stringify(snapshot.messagesBefore) !== JSON.stringify(snapshot.messagesAfter)) throw new Error('messages drifted');
    if (JSON.stringify(snapshot.transcriptBefore) !== JSON.stringify(snapshot.transcriptAfter)) throw new Error('transcript drifted');
    return `task=${snapshot.taskAfter.id} run=${snapshot.runAfter.id}/${snapshot.runAfter.status} result=${snapshot.resultAfter.id} msg=${snapshot.messagesAfter.length} tx=${snapshot.transcriptAfter.length}`;
  });

  await check('running-state fixture visible but zero automatic adapter dispatch on reopen', async () => {
    const runningTask = { id: 'task-live', sender: 'pm', recipient: 'alpha', type: 'task', body: 'live', context: {}, expectedOutput: null, createdAt: new Date().toISOString() };
    const runningRun = { id: 'run-live', taskId: 'task-live', agent: 'alpha', status: 'created', startedAt: null, completedAt: null, error: null };
    durable.state.createTask(runningTask);
    durable.state.createRun(runningRun);
    durable.state.updateRunStatus('run-live', { status: 'running', startedAt: new Date().toISOString() });
    durable.state.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'task.created' });
    durable.state.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'task.dispatched' });
    durable.state.appendEvent({ taskId: 'task-live', runId: 'run-live', agent: 'alpha', event: 'agent.started' });
    await durable.store.close();

    const after = await openDurable();
    const calls = [];
    const events = new EventBus();
    const registry = new AgentRegistry();
    registry.register('alpha', { start: async () => { calls.push('start'); return { output: 'never' }; }, dispose: async () => {} });
    new AgentBus({ registry, events, state: after.state });
    const visible = after.state.listRuns({ status: 'running' });
    if (visible.length !== 1 || visible[0].id !== 'run-live' || visible[0].status !== 'running') {
      throw new Error(`running state not observable: ${JSON.stringify(visible)}`);
    }
    if (calls.length !== 0) throw new Error(`unexpected automatic dispatch: ${calls.join(',')}`);
    await after.store.close();
    return `running run visible, adapter start calls = ${calls.length}`;
  });

  await check('legacy in-memory AgentBus smoke/regression remains valid', async () => {
    const registry = new AgentRegistry();
    registry.register('beta', okAdapter);
    const state = new StateStore();
    const events = new EventBus();
    const bus = new AgentBus({ registry, events, state });
    const order = [];
    bus.events.all((event) => order.push(event));
    const run = await bus.dispatch({ recipient: 'beta', body: 'legacy body' });
    if (run.status !== 'completed') throw new Error(`expected completed, got ${run.status}`);
    if (bus.result(run.id).output !== 'legacy smoke output') throw new Error('legacy result output missing');
    if (state.transcriptForTask(run.taskId).length !== 5) throw new Error('legacy transcript missing lifecycle events');
    if (order.join(',') !== 'task.created,task.dispatched,agent.started,result.created,agent.completed') {
      throw new Error(`legacy event order drifted: ${order.join(',')}`);
    }
    return `legacy StateStore ${state.taskCount} task / ${state.runCount} run`;
  });

  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail && typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : entry.detail}`);
  const passed = checks.filter((entry) => entry.ok).length;
  console.log(`P2-GATE2: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`P2-GATE2: fatal ${error.name}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });