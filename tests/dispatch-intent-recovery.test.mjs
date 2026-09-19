import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { DurableStateStore } from '../src/bus/durable-state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import {
  createTaskEnvelope,
  createRunRecord,
  createResultEnvelope,
  nowUtc,
} from '../src/bus/envelopes.mjs';
import {
  classifyDispatchAttempt,
} from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import {
  ATTEMPT_PHASES,
  RECOVERY_CLASSIFICATIONS,
} from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';

const { SAFE_TO_DISPATCH, AMBIGUOUS_EXTERNAL_ACCEPTANCE, AMBIGUOUS_RESULT_COMMIT, NATIVE_RECONCILE_REQUIRED, INTERRUPTED_EXTERNAL_RUN, CLEAN, OPERATOR_ACTION_REQUIRED } = RECOVERY_CLASSIFICATIONS;

async function createDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g3-'));
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

function fixtureTask(id) {
  return createTaskEnvelope({ id, recipient: 'alpha', body: 'task body' });
}

function fixtureRun(id, taskId) {
  return createRunRecord({ id, taskId, agent: 'alpha' });
}

function classify(repo, attemptId, capabilities = {}) {
  const attempt = repo.getDispatchAttempt(attemptId);
  const run = repo.getRun(attempt.runId);
  const result = repo.getResultByRun(attempt.runId) ?? null;
  return classifyDispatchAttempt({ attempt, run, result, capabilities });
}

function countingAdapter(calls, output = 'ok') {
  return {
    start: async () => {
      calls.push('start');
      return { output, stopReason: 'completed' };
    },
    dispose: async () => {},
  };
}

function makeBus(state, adapter) {
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', adapter);
  const bus = new AgentBus({ registry, events, state });
  return { events, registry, bus };
}

function assertInvalidTransition(fn) {
  assert.throws(fn, (error) => error?.code === 'INVALID_ATTEMPT_PHASE_TRANSITION');
}

test('1. durable prepare atomically records task + run + INTENT_COMMITTED attempt', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  const prepared = await repo.prepareDispatch({
    task: fixtureTask('task-1'),
    run: fixtureRun('run-1', 'task-1'),
    attemptId: 'attempt-1',
    backend: 'alpha',
  });
  assert.equal(prepared.attempt.phase, ATTEMPT_PHASES.INTENT_COMMITTED);
  assert.equal(repo.getTask('task-1').id, 'task-1');
  assert.equal(repo.getRun('run-1').status, 'created');
  const attempt = repo.getDispatchAttempt('attempt-1');
  assert.equal(attempt.phase, ATTEMPT_PHASES.INTENT_COMMITTED);
  assert.equal(attempt.runId, 'run-1');
  assert.equal(attempt.backend, 'alpha');
  assert.deepEqual(prepared.attempt.payload, {});
});

test('2. injected mid-transaction failure leaves none of the three rows partially committed', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  const taskA = fixtureTask('task-a');
  const runA = fixtureRun('run-a', 'task-a');
  repo.createTask(taskA);
  repo.createRun(runA);
  assert.throws(
    () => repo.prepareDispatch({ task: fixtureTask('task-b'), run: runA, attemptId: 'attempt-x', backend: 'alpha' }),
    (error) => error?.code === 'DUPLICATE_RUN',
  );
  assert.equal(repo.getTask('task-b'), undefined);
  assert.equal(repo.getDispatchAttempt('attempt-x'), undefined);
  assert.equal(repo.getRun('run-a').status, 'created');
});

test('3. attempt phase legal transitions are enforced deterministically', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  const full = await repo.prepareDispatch({ task: fixtureTask('task-3a'), run: fixtureRun('run-3a', 'task-3a'), attemptId: 'attempt-3a', backend: 'alpha' });
  repo.startDispatch(full.attempt.id);
  repo.recordNativeStart({ attemptId: full.attempt.id, backend: 'alpha', nativeSessionId: 'ns-3a' });
  assert.equal(repo.getDispatchAttempt('attempt-3a').phase, ATTEMPT_PHASES.REMOTE_STARTED);
  repo.terminalCommitFailure({ runId: 'run-3a', status: 'failed', error: new Error('boom') });
  assert.equal(repo.getDispatchAttempt('attempt-3a').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);

  const direct = await repo.prepareDispatch({ task: fixtureTask('task-3b'), run: fixtureRun('run-3b', 'task-3b'), attemptId: 'attempt-3b', backend: 'alpha' });
  repo.startDispatch(direct.attempt.id);
  repo.updateRunStatus('run-3b', { status: 'running', startedAt: nowUtc() });
  const result = createResultEnvelope({ taskId: 'task-3b', runId: 'run-3b', agent: 'alpha', status: 'completed', output: 'fin' });
  repo.terminalCommitSuccess({ runId: 'run-3b', result });
  assert.equal(repo.getDispatchAttempt('attempt-3b').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);

  const c = await repo.prepareDispatch({ task: fixtureTask('task-3c'), run: fixtureRun('run-3c', 'task-3c'), attemptId: 'attempt-3c', backend: 'alpha' });
  assertInvalidTransition(() => repo.transitionDispatchAttemptPhase(c.attempt.id, ATTEMPT_PHASES.REMOTE_STARTED));
  const d = await repo.prepareDispatch({ task: fixtureTask('task-3d'), run: fixtureRun('run-3d', 'task-3d'), attemptId: 'attempt-3d', backend: 'alpha' });
  const resultD = createResultEnvelope({ taskId: 'task-3d', runId: 'run-3d', agent: 'alpha', status: 'completed', output: 'fin' });
  assertInvalidTransition(() => repo.terminalCommitSuccess({ runId: 'run-3d', result: resultD }));
  assertInvalidTransition(() => repo.recordNativeStart({ attemptId: c.attempt.id, backend: 'alpha', nativeSessionId: 'ns-3c' }));
  const e = await repo.prepareDispatch({ task: fixtureTask('task-3e'), run: fixtureRun('run-3e', 'task-3e'), attemptId: 'attempt-3e', backend: 'alpha' });
  repo.startDispatch(e.attempt.id);
  assertInvalidTransition(() => repo.transitionDispatchAttemptPhase(e.attempt.id, ATTEMPT_PHASES.INTENT_COMMITTED));
});

test('4. terminal phase is immutable for every attempted transition', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-4'), run: fixtureRun('run-4', 'task-4'), attemptId: 'attempt-4', backend: 'alpha' });
  repo.startDispatch('attempt-4');
  repo.updateRunStatus('run-4', { status: 'running', startedAt: nowUtc() });
  const result = createResultEnvelope({ taskId: 'task-4', runId: 'run-4', agent: 'alpha', status: 'completed', output: 'fin' });
  repo.terminalCommitSuccess({ runId: 'run-4', result });
  assert.equal(repo.getDispatchAttempt('attempt-4').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assertInvalidTransition(() => repo.startDispatch('attempt-4'));
  assertInvalidTransition(() => repo.transitionDispatchAttemptPhase('attempt-4', ATTEMPT_PHASES.DISPATCH_STARTED));
  assertInvalidTransition(() => repo.recordNativeStart({ attemptId: 'attempt-4', backend: 'alpha', nativeSessionId: 'ns-4' }));
  assertInvalidTransition(() => repo.terminalCommitFailure({ runId: 'run-4', status: 'cancelled' }));
});

test('5. terminalCommitSuccess is one atomic write: run + result + TERMINAL_COMMITTED', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-5'), run: fixtureRun('run-5', 'task-5'), attemptId: 'attempt-5', backend: 'alpha' });
  repo.startDispatch('attempt-5');
  repo.updateRunStatus('run-5', { status: 'running', startedAt: nowUtc() });
  const result = createResultEnvelope({ taskId: 'task-5', runId: 'run-5', agent: 'alpha', status: 'completed', output: 'fin', artifacts: [{ name: 'a.txt' }] });
  const { run, attempt } = repo.terminalCommitSuccess({ runId: 'run-5', result });
  assert.equal(run.status, 'completed');
  assert.equal(attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assert.equal(repo.getRun('run-5').status, 'completed');
  assert.equal(repo.getResultByRun('run-5').output, 'fin');
  assert.equal(repo.getDispatchAttempt('attempt-5').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
});

test('6. terminalCommitFailure (failed) is atomic run + attempt, no fabricated result', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-6'), run: fixtureRun('run-6', 'task-6'), attemptId: 'attempt-6', backend: 'alpha' });
  repo.startDispatch('attempt-6');
  repo.updateRunStatus('run-6', { status: 'running', startedAt: nowUtc() });
  repo.terminalCommitFailure({ runId: 'run-6', status: 'failed', error: new Error('boom') });
  const run = repo.getRun('run-6');
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.error, { name: 'Error', message: 'boom' });
  assert.equal(run.error instanceof Error, false);
  assert.equal(repo.getResultByRun('run-6'), undefined);
  assert.equal(repo.getDispatchAttempt('attempt-6').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
});

test('7. terminalCommitFailure (cancelled) is atomic run + attempt', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-7'), run: fixtureRun('run-7', 'task-7'), attemptId: 'attempt-7', backend: 'alpha' });
  repo.startDispatch('attempt-7');
  repo.updateRunStatus('run-7', { status: 'running', startedAt: nowUtc() });
  repo.terminalCommitFailure({ runId: 'run-7', status: 'cancelled' });
  assert.equal(repo.getRun('run-7').status, 'cancelled');
  assert.equal(repo.getResultByRun('run-7'), undefined);
  assert.equal(repo.getDispatchAttempt('attempt-7').phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
});

test('8. result uniqueness and prior Gate 2 constraints remain intact', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-8'), run: fixtureRun('run-8', 'task-8'), attemptId: 'attempt-8', backend: 'alpha' });
  repo.startDispatch('attempt-8');
  repo.updateRunStatus('run-8', { status: 'running', startedAt: nowUtc() });
  const resultA = createResultEnvelope({ taskId: 'task-8', runId: 'run-8', agent: 'alpha', status: 'completed', output: 'a' });
  repo.addResult(resultA);
  const resultB = createResultEnvelope({ id: 'result-8b', taskId: 'task-8', runId: 'run-8', agent: 'alpha', status: 'completed', output: 'b' });
  assert.throws(() => repo.addResult(resultB), /result already recorded/);
  assert.throws(
    () => repo.terminalCommitSuccess({ runId: 'run-8', result: resultB }),
    (error) => error?.code === 'RESULT_ALREADY_RECORDED',
  );
  assert.equal(repo.getDispatchAttempt('attempt-8').phase, ATTEMPT_PHASES.DISPATCH_STARTED);
  assert.equal(repo.getResultByRun('run-8').output, 'a');
});

test('9. Window A survives reopen -> SAFE_TO_DISPATCH with zero adapter calls', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  a.repo.prepareDispatch({ task: fixtureTask('task-a'), run: fixtureRun('run-a', 'task-a'), attemptId: 'attempt-a', backend: 'alpha' });
  await a.store.close();

  const b = await openAt(path, stores);
  const diag = classify(b.repo, 'attempt-a');
  assert.equal(diag.classification, SAFE_TO_DISPATCH);
  assert.equal(diag.autoReplayAllowed, true);
  const calls = [];
  makeBus(b.state, countingAdapter(calls));
  assert.deepEqual(calls, []);
  assert.equal(b.state.listIncompleteDispatchAttempts().length, 1);
});

test('10. Window B survives reopen -> AMBIGUOUS_EXTERNAL_ACCEPTANCE with no auto replay', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  a.repo.prepareDispatch({ task: fixtureTask('task-b'), run: fixtureRun('run-b', 'task-b'), attemptId: 'attempt-b', backend: 'alpha' });
  a.repo.startDispatch('attempt-b');
  a.repo.updateRunStatus('run-b', { status: 'running', startedAt: nowUtc() });
  await a.store.close();

  const b = await openAt(path, stores);
  const diag = classify(b.repo, 'attempt-b');
  assert.equal(diag.classification, AMBIGUOUS_EXTERNAL_ACCEPTANCE);
  assert.equal(diag.autoReplayAllowed, false);
  const calls = [];
  makeBus(b.state, countingAdapter(calls));
  assert.deepEqual(calls, []);
  assert.equal(b.state.listIncompleteDispatchAttempts().length, 1);
});

test('11. REMOTE_STARTED + native reference + PROVED resume -> NATIVE_RECONCILE_REQUIRED', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-c'), run: fixtureRun('run-c', 'task-c'), attemptId: 'attempt-c', backend: 'alpha' });
  repo.startDispatch('attempt-c');
  repo.updateRunStatus('run-c', { status: 'running', startedAt: nowUtc() });
  repo.recordNativeStart({ attemptId: 'attempt-c', backend: 'alpha', nativeSessionId: 'ns-c', product: 'alpha-prod', version: '1.2.3' });
  const attempt = repo.getDispatchAttempt('attempt-c');
  assert.equal(attempt.phase, ATTEMPT_PHASES.REMOTE_STARTED);
  assert.equal(attempt.nativeReference.nativeSessionId, 'ns-c');
  const diag = classify(repo, 'attempt-c', { resumeExisting: 'PROVED' });
  assert.equal(diag.classification, NATIVE_RECONCILE_REQUIRED);
  assert.equal(diag.autoReplayAllowed, false);
  assert.equal(diag.nativeReconcileEligible, true);
});

test('12. REMOTE_STARTED without sufficient proof -> INTERRUPTED_EXTERNAL_RUN', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-12'), run: fixtureRun('run-12', 'task-12'), attemptId: 'attempt-12', backend: 'alpha' });
  repo.startDispatch('attempt-12');
  repo.updateRunStatus('run-12', { status: 'running', startedAt: nowUtc() });
  repo.recordNativeStart({ attemptId: 'attempt-12', backend: 'alpha', nativeSessionId: 'ns-12' });
  const diag = classify(repo, 'attempt-12', {});
  assert.equal(diag.classification, INTERRUPTED_EXTERNAL_RUN);
  assert.equal(diag.autoReplayAllowed, false);
  assert.equal(diag.nativeReconcileEligible, false);
});

test('13. UNKNOWN/ERROR/UNPROVEN resume evidence never qualifies native reconciliation', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-13'), run: fixtureRun('run-13', 'task-13'), attemptId: 'attempt-13', backend: 'alpha' });
  repo.startDispatch('attempt-13');
  repo.updateRunStatus('run-13', { status: 'running', startedAt: nowUtc() });
  repo.recordNativeStart({ attemptId: 'attempt-13', backend: 'alpha', nativeSessionId: 'ns-13' });
  for (const value of ['UNKNOWN', 'ERROR', 'UNPROVEN', 'UNVERIFIED', '', undefined, null, 42]) {
    const diag = classify(repo, 'attempt-13', { resumeExisting: value });
    assert.equal(diag.classification, INTERRUPTED_EXTERNAL_RUN, `evidence: ${String(value)}`);
    assert.equal(diag.nativeReconcileEligible, false);
  }
});

test('14. coherent terminal attempt -> CLEAN', async (t) => {
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  await repo.prepareDispatch({ task: fixtureTask('task-14'), run: fixtureRun('run-14', 'task-14'), attemptId: 'attempt-14', backend: 'alpha' });
  repo.startDispatch('attempt-14');
  repo.updateRunStatus('run-14', { status: 'running', startedAt: nowUtc() });
  const result = createResultEnvelope({ taskId: 'task-14', runId: 'run-14', agent: 'alpha', status: 'completed', output: 'fin' });
  repo.terminalCommitSuccess({ runId: 'run-14', result });
  const diag = classify(repo, 'attempt-14');
  assert.equal(diag.classification, CLEAN);
  assert.equal(diag.autoReplayAllowed, false);
  assert.equal(diag.nativeReconcileEligible, false);
  const failed = await (async () => {
    const p = await repo.prepareDispatch({ task: fixtureTask('task-14f'), run: fixtureRun('run-14f', 'task-14f'), attemptId: 'attempt-14f', backend: 'alpha' });
    repo.startDispatch(p.attempt.id);
    repo.updateRunStatus('run-14f', { status: 'running', startedAt: nowUtc() });
    repo.terminalCommitFailure({ runId: 'run-14f', status: 'cancelled' });
    return classify(repo, 'attempt-14f');
  })();
  assert.equal(failed.classification, CLEAN);
});

test('15. corrupted/incoherent attempts fail closed to OPERATOR_ACTION_REQUIRED, never fabricated completion', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  await a.repo.prepareDispatch({ task: fixtureTask('task-15'), run: fixtureRun('run-15', 'task-15'), attemptId: 'attempt-15', backend: 'alpha' });
  a.repo.startDispatch('attempt-15');
  a.repo.updateRunStatus('run-15', { status: 'running', startedAt: nowUtc() });
  a.repo.recordNativeStart({ attemptId: 'attempt-15', backend: 'alpha', nativeSessionId: 'ns-15' });
  const db = new Database(path, { readonly: false });
  db.prepare('UPDATE dispatch_attempts SET payload = ? WHERE id = ?').run('{oops', 'attempt-15');
  db.close();
  await a.store.close();

  const b = await openAt(path, stores);
  assert.equal(b.repo.getDispatchAttempt('attempt-15').corruptPayload, true);
  const corrupt = classify(b.repo, 'attempt-15', { resumeExisting: 'PROVED' });
  assert.equal(corrupt.classification, OPERATOR_ACTION_REQUIRED);
  assert.equal(corrupt.autoReplayAllowed, false);

  const unknown = classifyDispatchAttempt({ attempt: { id: 'attempt-z', runId: 'run-z', phase: 'PHASE_9' }, run: null, result: null, capabilities: {} });
  assert.equal(unknown.classification, OPERATOR_ACTION_REQUIRED);

  const nonTerminalRun = classifyDispatchAttempt({
    attempt: { id: 'attempt-nt', runId: 'run-nt', phase: ATTEMPT_PHASES.TERMINAL_COMMITTED },
    run: { id: 'run-nt', status: 'running' },
    result: null,
    capabilities: {},
  });
  assert.equal(nonTerminalRun.classification, OPERATOR_ACTION_REQUIRED);

  const completedNoResult = classifyDispatchAttempt({
    attempt: { id: 'attempt-cn', runId: 'run-cn', phase: ATTEMPT_PHASES.TERMINAL_COMMITTED },
    run: { id: 'run-cn', status: 'completed' },
    result: null,
    capabilities: {},
  });
  assert.equal(completedNoResult.classification, OPERATOR_ACTION_REQUIRED);

  const corruptIntent = classifyDispatchAttempt({
    attempt: { id: 'attempt-ci', runId: 'run-ci', phase: ATTEMPT_PHASES.INTENT_COMMITTED, corruptPayload: true },
    run: { id: 'run-ci', status: 'created' },
    result: null,
    capabilities: {},
  });
  assert.equal(corruptIntent.classification, OPERATOR_ACTION_REQUIRED);
});

test('16. durable real AgentBus success reaches TERMINAL_COMMITTED and classifies CLEAN', async (t) => {
  const { path, stores } = await createDb(t);
  const { store, state } = await openAt(path, stores);
  const calls = [];
  const { bus } = makeBus(state, countingAdapter(calls, 'durable output'));
  const run = await bus.dispatch({ recipient: 'alpha', body: 'x' });
  assert.equal(run.status, 'completed');
  assert.equal(state.getResultByRun(run.id).output, 'durable output');
  assert.deepEqual(calls, ['start']);
  const attempt = state.getDispatchAttemptForRun(run.id);
  assert.equal(attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  const diag = classify(state.repository, attempt.id);
  assert.equal(diag.classification, CLEAN);
  await store.close();
});

test('17. durable real AgentBus failure reaches TERMINAL_COMMITTED without success-result fabrication', async (t) => {
  const { path, stores } = await createDb(t);
  const { state } = await openAt(path, stores);
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', { start: async () => { throw new Error('boom'); }, dispose: async () => {} });
  const bus = new AgentBus({ registry, events, state });
  await assert.rejects(bus.dispatch({ recipient: 'alpha', body: 'x' }), /boom/);
  const attempt = state.getDispatchAttemptForRun(state.listRuns()[0].id);
  assert.equal(attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assert.equal(state.getRun(attempt.runId).status, 'failed');
  assert.equal(state.getResultByRun(attempt.runId), undefined);
  const diag = classify(state.repository, attempt.id);
  assert.equal(diag.classification, CLEAN);
});

test('18. durable real AgentBus cancellation reaches TERMINAL_COMMITTED', async (t) => {
  const { path, stores } = await createDb(t);
  const { state } = await openAt(path, stores);
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', {
    start: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    cancel: async () => {},
    dispose: async () => {},
  });
  const bus = new AgentBus({ registry, events, state });
  let runId;
  bus.events.once('agent.started', (payload) => { runId = payload.runId; });
  const pending = bus.dispatch({ recipient: 'alpha', body: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  await bus.cancel(runId);
  await assert.rejects(pending, /cancelled/);
  const attempt = state.getDispatchAttemptForRun(runId);
  assert.equal(attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assert.equal(state.getRun(runId).status, 'cancelled');
  assert.equal(state.getResultByRun(runId), undefined);
});

test('19. agent.started alone never creates REMOTE_STARTED evidence', async (t) => {
  const { path, stores } = await createDb(t);
  const { state } = await openAt(path, stores);
  let atStarted = null;
  let atAdapterStart = null;
  let atNativeRef = null;
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', {
    start: async ({ run }) => {
      const attempt = state.getDispatchAttemptForRun(run.id);
      atAdapterStart = attempt.phase;
      atNativeRef = attempt.nativeReference;
      return { output: 'ok' };
    },
    dispose: async () => {},
  });
  const bus = new AgentBus({ registry, events, state });
  events.on('agent.started', (payload) => {
    atStarted = state.getDispatchAttemptForRun(payload.runId).phase;
  });
  const run = await bus.dispatch({ recipient: 'alpha', body: 'x' });
  assert.equal(run.status, 'completed');
  assert.notEqual(atStarted, ATTEMPT_PHASES.REMOTE_STARTED);
  // R1 ordering: durable startDispatch happens before agent.started, so the
  // event observes the attempt already past intent (never INTENT_COMMITTED and
  // never REMOTE_STARTED).
  assert.equal(atStarted, ATTEMPT_PHASES.DISPATCH_STARTED);
  assert.equal(atAdapterStart, ATTEMPT_PHASES.DISPATCH_STARTED);
  assert.equal(atNativeRef, null);
  assert.equal(state.getDispatchAttemptForRun(run.id).phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
});

test('20. reopen/construction never auto-invokes the adapter for persisted incomplete attempts', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  a.repo.prepareDispatch({ task: fixtureTask('task-va'), run: fixtureRun('run-va', 'task-va'), attemptId: 'attempt-va', backend: 'alpha' });
  a.repo.prepareDispatch({ task: fixtureTask('task-wb'), run: fixtureRun('run-wb', 'task-wb'), attemptId: 'attempt-wb', backend: 'alpha' });
  a.repo.startDispatch('attempt-wb');
  a.repo.updateRunStatus('run-wb', { status: 'running', startedAt: nowUtc() });
  await a.store.close();

  const b = await openAt(path, stores);
  assert.equal(b.state.listIncompleteDispatchAttempts().length, 2);
  const calls = [];
  makeBus(b.state, countingAdapter(calls));
  assert.deepEqual(calls, []);
  assert.equal(classify(b.repo, 'attempt-va').classification, SAFE_TO_DISPATCH);
  assert.equal(classify(b.repo, 'attempt-wb').classification, AMBIGUOUS_EXTERNAL_ACCEPTANCE);
});

test('21. recovery protocol/classifier contain no provider-name branching', async (t) => {
  const files = [
    new URL('../src/persistence/recovery/dispatch-attempt-protocol.mjs', import.meta.url),
    new URL('../src/persistence/recovery/dispatch-recovery-classifier.mjs', import.meta.url),
  ];
  const forbidden = ['codex', 'claude', 'grok', 'gemini', 'mistral', 'opencode', 'anthropic', 'openai'];
  for (const url of files) {
    const text = readFileSync(fileURLToPath(url), 'utf8').toLowerCase();
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${url.pathname} must not mention provider "${token}"`);
    }
  }
  const { path, stores } = await createDb(t);
  const { repo } = await openAt(path, stores);
  const neutral = await repo.prepareDispatch({ task: fixtureTask('task-n'), run: fixtureRun('run-n', 'task-n'), attemptId: 'attempt-n', backend: 'alpha' });
  repo.startDispatch(neutral.attempt.id);
  repo.updateRunStatus('run-n', { status: 'running', startedAt: nowUtc() });
  repo.recordNativeStart({ attemptId: 'attempt-n', backend: 'alpha', nativeSessionId: 'ns-n' });
  const named = await repo.prepareDispatch({ task: fixtureTask('task-c'), run: fixtureRun('run-c', 'task-c'), attemptId: 'attempt-c', backend: 'codex' });
  repo.startDispatch(named.attempt.id);
  repo.updateRunStatus('run-c', { status: 'running', startedAt: nowUtc() });
  repo.recordNativeStart({ attemptId: 'attempt-c', backend: 'codex', nativeSessionId: 'ns-c' });
  const dNeutral = classify(repo, 'attempt-n', { resumeExisting: 'PROVED' });
  const dNamed = classify(repo, 'attempt-c', { resumeExisting: 'PROVED' });
  assert.equal(dNamed.classification, dNeutral.classification);
  assert.equal(dNamed.reason, dNeutral.reason);
});

test('22. Gate 2 restart reconstruction still passes for the complete lifecycle', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  const calls = [];
  const { bus } = makeBus(a.state, countingAdapter(calls, 'reopen output'));
  const run = await bus.dispatch({ recipient: 'alpha', body: 'x' });
  const taskBefore = a.state.getTask(run.taskId);
  const runBefore = a.state.getRun(run.id);
  const resultBefore = a.state.getResultByRun(run.id);
  const transcriptBefore = a.state.transcriptForTask(run.taskId);
  a.state.addMessage({ id: 'msg-22', taskId: run.taskId, runId: run.id, from: 'pm', to: 'alpha', kind: 'message', body: 'note', replyTo: null, conversationId: null, hopId: null, metadata: {}, createdAt: nowUtc() });
  await a.store.close();

  const b = await openAt(path, stores);
  assert.equal(b.state.taskCount, 1);
  assert.equal(b.state.runCount, 1);
  assert.deepEqual(b.state.getTask(run.taskId), taskBefore);
  assert.deepEqual(b.state.getRun(run.id), runBefore);
  assert.deepEqual(b.state.getResultByRun(run.id), resultBefore);
  assert.deepEqual(b.state.transcriptForTask(run.taskId), transcriptBefore);
  assert.equal(b.state.getDispatchAttemptForRun(run.id).phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assert.equal(classify(b.repo, b.state.getDispatchAttemptForRun(run.id).id).classification, CLEAN);
  assert.equal(b.state.messagesForTask(run.taskId)[0].body, 'note');
});

test('23. legacy in-memory AgentBus (no durability flag) behaves identically through the legacy path', async () => {
  const state = new StateStore();
  assert.equal(state.hasDispatchDurability, undefined);
  const events = new EventBus();
  const registry = new AgentRegistry();
  registry.register('alpha', { start: async () => ({ output: 'legacy', stopReason: 'completed' }), dispose: async () => {} });
  const bus = new AgentBus({ registry, events, state });
  const order = [];
  bus.events.all((event) => order.push(event));
  const run = await bus.dispatch({ recipient: 'alpha', body: 'x' });
  assert.equal(run.status, 'completed');
  assert.equal(bus.result(run.id).output, 'legacy');
  assert.equal(order.join(','), 'task.created,task.dispatched,agent.started,result.created,agent.completed');
});

test('Window D: injected terminal-commit failure leaves zero partial terminal truth; evidence is truthful', async (t) => {
  const { path, stores } = await createDb(t);
  const a = await openAt(path, stores);
  await a.repo.prepareDispatch({ task: fixtureTask('task-d'), run: fixtureRun('run-d', 'task-d'), attemptId: 'attempt-d', backend: 'alpha' });
  a.repo.startDispatch('attempt-d');
  a.repo.updateRunStatus('run-d', { status: 'running', startedAt: nowUtc() });
  const preResult = createResultEnvelope({ id: 'result-d', taskId: 'task-d', runId: 'run-d', agent: 'alpha', status: 'completed', output: 'pre-existing' });
  a.repo.addResult(preResult);
  const laterResult = createResultEnvelope({ id: 'result-d2', taskId: 'task-d', runId: 'run-d', agent: 'alpha', status: 'completed', output: 'late' });
  assert.throws(
    () => a.repo.terminalCommitSuccess({ runId: 'run-d', result: laterResult }),
    (error) => error?.code === 'RESULT_ALREADY_RECORDED',
  );
  assert.equal(a.repo.getRun('run-d').status, 'running');
  assert.equal(a.repo.getDispatchAttempt('attempt-d').phase, ATTEMPT_PHASES.DISPATCH_STARTED);
  assert.equal(a.repo.getResultByRun('run-d').id, 'result-d');
  const diag = classify(a.repo, 'attempt-d');
  assert.equal(diag.classification, AMBIGUOUS_RESULT_COMMIT);
  assert.equal(diag.autoReplayAllowed, false);
  await a.store.close();

  const b = await openAt(path, stores);
  const calls = [];
  makeBus(b.state, countingAdapter(calls));
  assert.deepEqual(calls, []);
  assert.equal(b.repo.getRun('run-d').status, 'running');
  assert.equal(b.repo.getDispatchAttempt('attempt-d').phase, ATTEMPT_PHASES.DISPATCH_STARTED);
  const afterDiag = classify(b.repo, 'attempt-d');
  assert.equal(afterDiag.classification, AMBIGUOUS_RESULT_COMMIT);
});