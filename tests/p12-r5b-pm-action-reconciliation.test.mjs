// P12-R5B Part I/J/K/N — safe operator reconciliation for a PM run stuck
// ACTION_STARTED with no durable outcome (the real TEST 4 scenario). Uses
// the REAL PmRepository/SqlitePersistenceStore and the REAL
// ProductionPmWorkHandler/DurablePmRuntime to prove: (a) an unresolved
// workflow action really does crash a resume/execute() attempt with
// ACTION_RECONCILE_REQUIRED before remediation, (b) this tool never
// replays the action, (c) after reconciliation the run resumes cleanly as a
// normal already-terminal "adopted" claim, and (d) an AWAIT_OWNER turn
// (the real TEST 3 scenario) is refused outright, never silently touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime, DurablePmRecoveryError, PM_RECOVERY } from '../src/pm/durable-pm-runtime.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import {
  reconcilePendingAction, findReconcilableTurn, buildReconciliationOutcome,
  ReconciliationRefusedError, RECONCILE_RESOLUTIONS,
} from '../src/runtime/pm-action-reconciliation.mjs';

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p12-r5b-reconcile-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    await fn(new PmRepository({ store }));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A workflowRunner whose run() never settles — the exact live TEST 4
// symptom (the real backend call that never returned).
function neverCompletingWorkflowRunner() {
  return { run: () => new Promise(() => {}), result: () => null, cancel: () => {}, getWorkflow: () => null, transcript: () => [] };
}
const inertPeerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
function scriptedDriver(name, decisions) {
  let i = 0;
  return { name, async decide() { const d = decisions[Math.min(i, decisions.length - 1)]; i += 1; return d; } };
}

test('setup: a workflow action left ACTION_STARTED with no outcome really is classified ACTION_RECONCILE_REQUIRED (proves the bug this tool exists for)', async () => withStore(async (pmRepository) => {
  const runtime = new DurablePmRuntime({
    driver: scriptedDriver('stuck', [{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'do it' }] } }]),
    workflowRunner: neverCompletingWorkflowRunner(), peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4,
  });
  const prepared = runtime.prepare({ objective: 'x', context: {} });
  // Simulate "the process crashed mid-flight": run() is still in-flight
  // (never resolves) when we abandon this attempt entirely and ask a FRESH
  // runtime instance (no in-memory workflowRunner.result() cache) to resume
  // — exactly what a real restart looks like.
  void runtime.resume(prepared.pmRunId).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  const freshRuntime = new DurablePmRuntime({
    driver: scriptedDriver('stuck', [{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'do it' }] } }]),
    workflowRunner: neverCompletingWorkflowRunner(), peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4,
  });
  await assert.rejects(
    freshRuntime.resume(prepared.pmRunId),
    (error) => error instanceof DurablePmRecoveryError && error.code === PM_RECOVERY.ACTION_RECONCILE_REQUIRED,
  );
}));

test('findReconcilableTurn: refuses a run that is already terminal', async () => withStore(async (pmRepository) => {
  const runtime = new DurablePmRuntime({
    driver: scriptedDriver('d', [{ type: 'finish', output: 'done' }]),
    workflowRunner: neverCompletingWorkflowRunner(), peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4,
  });
  const prepared = runtime.prepare({ objective: 'x', context: {} });
  await runtime.resume(prepared.pmRunId);
  assert.throws(() => findReconcilableTurn(pmRepository.load(prepared.pmRunId)), (error) => error instanceof ReconciliationRefusedError && error.code === 'PM_RUN_ALREADY_TERMINAL');
}));

test('findReconcilableTurn: refuses an AWAIT_OWNER turn outright (the real TEST 3 shape) — never silently touched', async () => withStore(async (pmRepository) => {
  const ownerControl = { openInteraction: async () => ({ decision: null }) };
  const runtime = new DurablePmRuntime({
    driver: scriptedDriver('d', [{ type: 'await_owner', kind: 'QUESTION', title: 't', prompt: 'p', allowedResponses: ['CANCEL'] }]),
    workflowRunner: neverCompletingWorkflowRunner(), peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4, ownerControl,
  });
  const prepared = runtime.prepare({ objective: 'x', context: {} });
  const result = await runtime.resume(prepared.pmRunId);
  assert.equal(result.status, 'awaiting_owner');
  assert.throws(
    () => findReconcilableTurn(pmRepository.load(prepared.pmRunId)),
    (error) => error instanceof ReconciliationRefusedError && error.code === 'PM_RUN_AWAITING_OWNER_NOT_RECONCILE_TARGET',
  );
}));

test('buildReconciliationOutcome: rejects an unknown resolution', () => {
  assert.throws(
    () => buildReconciliationOutcome({ actionType: 'workflow', actionId: 'wf-1' }, { resolution: 'YOLO', now: '2026-01-01T00:00:00.000Z' }),
    (error) => error instanceof ReconciliationRefusedError && error.code === 'RECONCILE_RESOLUTION_INVALID',
  );
});

for (const resolution of Object.values(RECONCILE_RESOLUTIONS)) {
  test(`reconcilePendingAction(${resolution}): a stuck workflow action reaches a real, durable, DISTINCT terminal outcome — never fabricates success, never replays`, async () => withStore(async (pmRepository) => {
    const runner = neverCompletingWorkflowRunner();
    let replayed = false;
    runner.run = () => { replayed = true; return new Promise(() => {}); };
    const runtime = new DurablePmRuntime({
      driver: scriptedDriver('stuck', [{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'do it' }] } }]),
      workflowRunner: runner, peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4,
    });
    const prepared = runtime.prepare({ objective: 'x', context: {} });
    void runtime.resume(prepared.pmRunId).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replayed, true, 'sanity: the action really did start');
    replayed = false;

    const result = reconcilePendingAction({ pmRepository, pmRunId: prepared.pmRunId, resolution, note: 'no independent evidence of any external effect' });
    assert.equal(result.resolution, resolution);
    assert.equal(result.outcome.status, 'failed');
    assert.equal(replayed, false, 'reconciliation must NEVER call workflowRunner.run() again');

    const reloaded = pmRepository.load(prepared.pmRunId);
    assert.equal(reloaded.status, 'failed');
    assert.equal(reloaded.turns.at(-1).phase, 'TURN_COMPLETE');
    assert.match(reloaded.error.code, /^ACTION_RECONCILED_/);

    // The reconciled turn itself is preserved (never deleted) — its
    // outcome is now the honest reconciliation record, forming the
    // forensic trail (Part A: never delete durable evidence).
    assert.equal(reloaded.turns.length, 1);

    // A second reconciliation attempt now correctly refuses (already terminal).
    assert.throws(
      () => reconcilePendingAction({ pmRepository, pmRunId: prepared.pmRunId, resolution: 'ABANDON' }),
      (error) => error instanceof ReconciliationRefusedError && error.code === 'PM_RUN_ALREADY_TERMINAL',
    );
  }));
}

test('end-to-end: after reconciliation, ProductionPmWorkHandler.execute() adopts the now-terminal run cleanly — no crash, no replay, claim released', async () => withStore(async (pmRepository) => {
  const runner = neverCompletingWorkflowRunner();
  const runtime = new DurablePmRuntime({
    driver: scriptedDriver('stuck', [{ type: 'workflow', spec: { steps: [{ recipient: 'worker', body: 'do it' }] } }]),
    workflowRunner: runner, peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4,
  });
  const commandId = 'cmd-reconcile-e2e';
  const taskId = deterministicOwnerId('task', commandId);
  const prepared = runtime.prepare({ objective: 'x', context: { ownerCommandId: commandId, channel: 'LOCAL' }, pmRunId: deterministicOwnerId('pmrun', commandId) });
  void runtime.resume(prepared.pmRunId).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  reconcilePendingAction({ pmRepository, pmRunId: prepared.pmRunId, resolution: 'ABANDON', note: 'read-only council step, no external effect possible' });

  const project = { id: 'dsh-p6-test-b', repo_path: '/tmp/wherever', taskId };
  const taskRepository = { getOwnerTask: (id) => (id === taskId ? { id, projectId: project.id, pmProfileId: 'live1-claude-pm', context: {} } : null) };
  let completeClaimCalled = false;
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => { completeClaimCalled = true; } },
    pmRepository, ownerRepository: {}, taskRepository, projects: [project],
    createRuntime: () => runtime,
  });
  const work = { pm_run_id: prepared.pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId: prepared.pmRunId }).action_id };
  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.adopted, true);
  assert.equal(completeClaimCalled, true, 'the stale claim must be released — this is what actually unblocks the next restart');
}));
