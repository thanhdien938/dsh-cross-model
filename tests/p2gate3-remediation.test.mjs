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
import {
  classifyDispatchAttempt,
} from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';

async function createDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g3-r1-'));
  const path = join(dir, 'store.db');
  const stores = [];
  t.after(async () => {
    for (const store of stores) {
      try {
        await store.close();
      } catch {
        // already closed by the test body
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, stores };
}

async function openAt(path, stores) {
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  stores.push(store);
  const repo = new AgentBusRepository({ store });
  const state = new DurableStateStore({ repository: repo });
  return { store, repo, state };
}

function classify(repo, attemptId, capabilities = {}) {
  const attempt = repo.getDispatchAttempt(attemptId);
  const run = repo.getRun(attempt.runId);
  const result = repo.getResultByRun(attempt.runId) ?? null;
  return classifyDispatchAttempt({ attempt, run, result, capabilities });
}

function countingAdapter(calls) {
  return {
    start: async () => {
      calls.push('start');
      return { output: 'never reached', stopReason: 'completed' };
    },
    dispose: async () => {},
  };
}

function makeBus(state, adapter) {
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', adapter);
  return { bus: new AgentBus({ registry, events, state }), events };
}

test('A. R1: NOT_JSON_FAITHFUL prepare failure through the durable path leaves zero rows + zero adapter calls', async (t) => {
  const { path, stores } = await createDb(t);
  const { store, state } = await openAt(path, stores);
  const calls = [];
  const { bus } = makeBus(state, countingAdapter(calls));
  await assert.rejects(
    () => bus.dispatch({ recipient: 'alpha', body: 'x', context: { when: new Date() } }),
    (error) => error?.code === 'NOT_JSON_FAITHFUL',
  );
  assert.equal(calls.length, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM tasks').c, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM runs').c, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM dispatch_attempts').c, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM bus_events').c, 0);
});

test('B. R1: injected startDispatch failure leaves coherent SAFE_TO_DISPATCH truth, zero adapter calls, no live leak', async (t) => {
  const { path, stores } = await createDb(t);
  const { store, state } = await openAt(path, stores);
  const calls = [];
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', countingAdapter(calls));
  const failingState = {
    hasDispatchDurability: true,
    createTask: (task) => state.createTask(task),
    createRun: (run) => state.createRun(run),
    prepareDispatch: (input) => state.prepareDispatch(input),
    startDispatch: () => {
      throw new Error('injected startDispatch failure');
    },
    updateRunStatus: (runId, patch) => state.updateRunStatus(runId, patch),
    terminalCommitSuccess: (input) => state.terminalCommitSuccess(input),
    terminalCommitFailure: (input) => state.terminalCommitFailure(input),
    getRun: (runId) => state.getRun(runId),
    appendEvent: (entry) => state.appendEvent(entry),
  };
  const bus = new AgentBus({ registry, events, state: failingState });

  await assert.rejects(() => bus.dispatch({ recipient: 'alpha', body: 'x' }), /injected startDispatch failure/);

  assert.equal(calls.length, 0);
  const attemptRow = store.get('SELECT id, run_id, phase FROM dispatch_attempts');
  assert.ok(attemptRow, 'attempt row must exist (intent was committed)');
  assert.equal(attemptRow.phase, ATTEMPT_PHASES.INTENT_COMMITTED);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM bus_events').c, 0);
  assert.equal(state.getRun(attemptRow.run_id).status, 'created');

  const diag = classify(state.repository, attemptRow.id);
  assert.equal(diag.classification, RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH);
  assert.equal(diag.autoReplayAllowed, true);

  // No controller/live-session leak observable through behavior: the run does
  // not claim to be running/live, so cancel must refuse instead of reaching an
  // abort path.
  await assert.rejects(() => bus.cancel(attemptRow.run_id), /cannot cancel run/);
});

test('C. R1: successful durable event sequence remains task.created -> task.dispatched -> agent.started -> result.created -> agent.completed', async (t) => {
  const { path, stores } = await createDb(t);
  const { state } = await openAt(path, stores);
  const { bus, events } = makeBus(state, {
    start: async () => ({ output: 'ok', stopReason: 'completed' }),
    dispose: async () => {},
  });
  const order = [];
  events.all((event) => order.push(event));
  const run = await bus.dispatch({ recipient: 'alpha', body: 'x' });
  assert.equal(run.status, 'completed');
  assert.equal(order.join(','), 'task.created,task.dispatched,agent.started,result.created,agent.completed');
  assert.equal(state.getDispatchAttemptForRun(run.id).phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
});