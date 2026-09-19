#!/usr/bin/env node
/**
 * P2-Gate 3 smoke — dispatch intent + recovery.
 *
 * Fixed denominator of 7 checks against a real temp SQLite file, no external
 * provider calls:
 *   1. durable normal dispatch writes intent and ends terminal/CLEAN.
 *   2. injected Window A -> SAFE_TO_DISPATCH.
 *   3. injected Window B -> AMBIGUOUS_EXTERNAL_ACCEPTANCE.
 *   4. agent.started is not REMOTE_STARTED evidence.
 *   5. synthetic remote + native + PROVED -> NATIVE_RECONCILE_REQUIRED.
 *   6. remote without proof -> INTERRUPTED_EXTERNAL_RUN.
 *   7. reopen incomplete attempts causes zero automatic adapter calls.
 */
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
import { createTaskEnvelope, createRunRecord } from '../src/bus/envelopes.mjs';
import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g3-smoke-'));
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

function classify(repo, attemptId, capabilities = {}) {
  const attempt = repo.getDispatchAttempt(attemptId);
  const run = repo.getRun(attempt.runId);
  const result = repo.getResultByRun(attempt.runId) ?? null;
  return classifyDispatchAttempt({ attempt, run, result, capabilities });
}

function makeTask(id) {
  return createTaskEnvelope({ id, recipient: 'alpha', body: 'smoke body' });
}

function makeRun(id, taskId) {
  return createRunRecord({ id, taskId, agent: 'alpha' });
}

async function main() {
  let first = await openDurable();

  await check('1. durable normal dispatch writes intent and ends terminal/CLEAN', async () => {
    const events = new EventBus();
    const registry = new AgentRegistry();
    const calls = [];
    registry.register('alpha', {
      start: async () => {
        calls.push('start');
        return { output: 'durable smoke output', stopReason: 'completed' };
      },
      dispose: async () => {},
    });
    const bus = new AgentBus({ registry, events, state: first.state });
    const run = await bus.dispatch({ recipient: 'alpha', body: 'smoke normal dispatch' });
    if (run.status !== 'completed') throw new Error(`expected completed, got ${run.status}`);
    const attempt = first.state.getDispatchAttemptForRun(run.id);
    if (attempt.phase !== ATTEMPT_PHASES.TERMINAL_COMMITTED) throw new Error(`expected TERMINAL_COMMITTED, got ${attempt.phase}`);
    const diag = classify(first.repository, attempt.id);
    if (diag.classification !== RECOVERY_CLASSIFICATIONS.CLEAN) throw new Error(`expected CLEAN, got ${diag.classification}`);
    return `run=${run.id} attempt=${attempt.phase} classification=${diag.classification} adapterCalls=${calls.length}`;
  });

  await check('4. agent.started is not REMOTE_STARTED evidence', async () => {
    let atStarted = null;
    let atStart = null;
    const events = new EventBus();
    const registry = new AgentRegistry();
    registry.register('alpha', {
      start: async ({ run }) => {
        const attempt = first.state.getDispatchAttemptForRun(run.id);
        atStart = attempt.phase;
        return { output: 'inspected' };
      },
      dispose: async () => {},
    });
    const bus = new AgentBus({ registry, events, state: first.state });
    events.on('agent.started', (payload) => {
      atStarted = first.state.getDispatchAttemptForRun(payload.runId).phase;
    });
    const run = await bus.dispatch({ recipient: 'alpha', body: 'smoke agent.started' });
    if (atStarted === ATTEMPT_PHASES.REMOTE_STARTED) throw new Error('agent.started carried REMOTE_STARTED evidence');
    if (atStart !== ATTEMPT_PHASES.DISPATCH_STARTED) throw new Error(`at adapter start expected DISPATCH_STARTED, got ${atStart}`);
    if (first.state.getDispatchAttemptForRun(run.id).nativeReference !== null) throw new Error('nativeReference unexpectedly present');
    if (first.state.getDispatchAttemptForRun(run.id).phase !== ATTEMPT_PHASES.TERMINAL_COMMITTED) throw new Error('attempt not terminal after success');
    return `atStarted=${atStarted} atAdapterStart=${atStart} final=${first.state.getDispatchAttemptForRun(run.id).phase}`;
  });

  await check('2. injected Window A -> SAFE_TO_DISPATCH', async () => {
    first.repository.prepareDispatch({ task: makeTask('task-wa'), run: makeRun('run-wa', 'task-wa'), attemptId: 'attempt-wa', backend: 'alpha' });
    const diag = classify(first.repository, 'attempt-wa');
    if (diag.classification !== RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH) throw new Error(`expected SAFE_TO_DISPATCH, got ${diag.classification}`);
    if (diag.autoReplayAllowed !== true) throw new Error('SAFE_TO_DISPATCH must allow replay');
    return `phase=${diag.phase} classification=${diag.classification} autoReplayAllowed=${diag.autoReplayAllowed}`;
  });

  await check('3. injected Window B -> AMBIGUOUS_EXTERNAL_ACCEPTANCE', async () => {
    first.repository.prepareDispatch({ task: makeTask('task-wb'), run: makeRun('run-wb', 'task-wb'), attemptId: 'attempt-wb', backend: 'alpha' });
    first.repository.startDispatch('attempt-wb');
    first.repository.updateRunStatus('run-wb', { status: 'running', startedAt: new Date().toISOString() });
    const diag = classify(first.repository, 'attempt-wb');
    if (diag.classification !== RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE) {
      throw new Error(`expected AMBIGUOUS_EXTERNAL_ACCEPTANCE, got ${diag.classification}`);
    }
    if (diag.autoReplayAllowed !== false) throw new Error('ambiguous attempts must not auto replay');
    return `phase=${diag.phase} classification=${diag.classification} autoReplayAllowed=${diag.autoReplayAllowed}`;
  });

  await check('5. synthetic remote + native + PROVED -> NATIVE_RECONCILE_REQUIRED', async () => {
    first.repository.prepareDispatch({ task: makeTask('task-r'), run: makeRun('run-r', 'task-r'), attemptId: 'attempt-r', backend: 'alpha' });
    first.repository.startDispatch('attempt-r');
    first.repository.updateRunStatus('run-r', { status: 'running', startedAt: new Date().toISOString() });
    first.repository.recordNativeStart({ attemptId: 'attempt-r', backend: 'alpha', nativeSessionId: 'ns-smoke-1', product: 'alpha-prod', version: '1.0.0' });
    const diag = classify(first.repository, 'attempt-r', { resumeExisting: 'PROVED' });
    if (diag.classification !== RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED) {
      throw new Error(`expected NATIVE_RECONCILE_REQUIRED, got ${diag.classification}`);
    }
    if (diag.autoReplayAllowed !== false || diag.nativeReconcileEligible !== true) {
      throw new Error(`eligibility flags wrong: ${JSON.stringify(diag)}`);
    }
    return `phase=${diag.phase} classification=${diag.classification} nativeReconcileEligible=${diag.nativeReconcileEligible}`;
  });

  await check('6. remote without proof -> INTERRUPTED_EXTERNAL_RUN', async () => {
    const diag = classify(first.repository, 'attempt-r', {});
    if (diag.classification !== RECOVERY_CLASSIFICATIONS.INTERRUPTED_EXTERNAL_RUN) {
      throw new Error(`expected INTERRUPTED_EXTERNAL_RUN, got ${diag.classification}`);
    }
    if (diag.nativeReconcileEligible !== false || diag.autoReplayAllowed !== false) {
      throw new Error(`eligibility flags wrong: ${JSON.stringify(diag)}`);
    }
    return `phase=${diag.phase} classification=${diag.classification}`;
  });

  const incompleteBefore = first.state.listIncompleteDispatchAttempts().length;
  await first.store.close();

  const second = await openDurable();

  await check('7. reopen incomplete attempts causes zero automatic adapter calls', async () => {
    const calls = [];
    const events = new EventBus();
    const registry = new AgentRegistry();
    registry.register('alpha', {
      start: async () => {
        calls.push('start');
        return { output: 'never dispatched' };
      },
      dispose: async () => {},
    });
    const bus = new AgentBus({ registry, events, state: second.state });
    if (calls.length !== 0) throw new Error(`construction dispatched automatically: ${calls.join(',')}`);
    const incomplete = second.state.listIncompleteDispatchAttempts();
    if (incomplete.length !== incompleteBefore) {
      throw new Error(`incomplete attempts drifted: before=${incompleteBefore} after=${incomplete.length}`);
    }
    if (classify(second.repository, 'attempt-wa').classification !== RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH) {
      throw new Error('Window A did not survive reopen as SAFE_TO_DISPATCH');
    }
    if (classify(second.repository, 'attempt-wb').classification !== RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE) {
      throw new Error('Window B did not survive reopen as AMBIGUOUS_EXTERNAL_ACCEPTANCE');
    }
    return `incomplete=${incomplete.length} adapterCalls=${calls.length}`;
  });

  await second.store.close();
  await first.store.close();

  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail && typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : entry.detail}`);
  const passed = checks.filter((entry) => entry.ok).length;
  console.log(`P2-GATE3: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`P2-GATE3: fatal ${error.name}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });