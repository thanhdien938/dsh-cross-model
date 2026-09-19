/**
 * P20.8 PRE-R3 — R3-4.1: AgentBus dispatch durability recurrence fix.
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §6.1.
 *
 * Root cause (Astra PRE-R2 audit): production composition
 * (`createProductionPmWorkflowRunner()`) constructed `AgentBus` directly over
 * the raw `AgentBusRepository`, which implements the full dispatch-durability
 * protocol (prepareDispatch/startDispatch/terminalCommitSuccess/
 * terminalCommitFailure) but never advertised `hasDispatchDurability`, so
 * `AgentBus.dispatch()` silently took its legacy path. Separately,
 * `WorkflowRunner` only wrote `workflow_steps.run_id` at step
 * completion/failure — never the moment the run actually began — so a crash
 * during a long-running adapter call left `run_id = null` even though a real
 * AgentBus run existed. This test proves BOTH fixes:
 *   1. production composition now wraps `agentBusRepository` in
 *      `DurableStateStore` (durable write-ahead intent before any adapter call);
 *   2. `WorkflowRunner` durably persists `workflow_steps.run_id` synchronously
 *      on `agent.started`, BEFORE the adapter call is awaited.
 *
 * The mandatory recurrence test: crash at the exact boundary that
 * historically left task linkage while step.run_id was null (an adapter call
 * left permanently in flight) — after "restart" (a fresh repository/store
 * handle over the SAME db file), no invisible RUNNING AgentBus run may
 * remain undiscoverable: a durable dispatch attempt/run link is always
 * findable, and reopening never auto-replays the adapter.
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { createProductionPmWorkflowRunner } from '../src/workflow/production-pm-workflow-runner.mjs';
import { ATTEMPT_PHASES } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';

async function openDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-r34-'));
  const path = join(dir, 'store.db');
  const stores = [];
  // A single combined after-hook: close every opened store FIRST, then
  // remove the directory — avoids a Windows EBUSY unlink race that a
  // separately-registered rmSync hook (racing store.close() ordering) hits.
  t.after(async () => {
    for (const store of stores) {
      try { await store.close(); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, stores };
}

function fakeProfileRegistryAndProject() {
  const profile = { id: 'worker-profile', product: 'fake', transport: 'stdio' };
  return {
    profileRegistry: { list: () => [profile], get: (id) => (id === profile.id ? profile : null) },
    project: { default_pm_profile_id: profile.id },
  };
}

async function pollUntil(fn, { tries = 400, delayMs = 5 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const v = fn();
    if (v) return v;
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  throw new Error('pollUntil: condition never became true');
}

test('R3-4 composition wiring: production composition advertises dispatch durability end-to-end', async (t) => {
  const { path, stores } = await openDb(t);
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  stores.push(store);

  const { profileRegistry, project } = fakeProfileRegistryAndProject();
  const resolveDriver = () => ({ decide: async () => ({ type: 'finish', output: 'ok' }) });
  const runnerApi = createProductionPmWorkflowRunner({
    store, agentBusRepository: new AgentBusRepository({ store }), profileRegistry, resolveDriver, project,
  });

  const result = await runnerApi.run({ steps: [{ recipient: 'worker', body: 'do it' }] });
  assert.equal(result.status, 'completed');

  const attempts = store.all('SELECT * FROM dispatch_attempts');
  assert.equal(attempts.length, 1, 'the durable write-ahead path was actually taken (not the legacy path)');
  assert.equal(attempts[0].phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);

  const steps = store.all('SELECT * FROM workflow_steps WHERE workflow_id = ?', [result.workflowId]);
  assert.equal(steps.length, 1);
  assert.ok(steps[0].run_id, 'the step is durably linked to its AgentBus run');
});

test('R3-4.1 recurrence: crash boundary (in-flight adapter call) still leaves a durable run_id + dispatch attempt, no auto-replay on restart', async (t) => {
  const { path, stores } = await openDb(t);
  const store = new SqlitePersistenceStore();
  await store.open({ path });
  await store.migrate();
  stores.push(store);

  const { profileRegistry, project } = fakeProfileRegistryAndProject();
  let released;
  const gate = new Promise((resolve) => { released = resolve; });
  let decideCalls = 0;
  const resolveDriver = () => ({
    decide: async () => {
      decideCalls += 1;
      await gate; // simulate a long-running in-flight adapter call — the historical crash window
      return { type: 'finish', output: 'ok' };
    },
  });
  const runnerApi = createProductionPmWorkflowRunner({
    store, agentBusRepository: new AgentBusRepository({ store }), profileRegistry, resolveDriver, project,
  });

  const runPromise = runnerApi.run({ id: 'wf-r34-recur', steps: [{ recipient: 'worker', body: 'do it' }] });

  // THE CRASH BOUNDARY: poll until the durable linkage appears — the adapter
  // call is still hanging (never resolved), exactly mirroring what a
  // restarted process would find on disk after a real crash at this point.
  const stepRow = await pollUntil(() => {
    const row = store.get('SELECT * FROM workflow_steps WHERE workflow_id = ?', ['wf-r34-recur']);
    return row?.run_id ? row : null;
  });
  assert.equal(stepRow.status, 'running');
  assert.equal(decideCalls, 1, 'the adapter has been called exactly once so far (still in flight)');

  const attempt = store.get('SELECT * FROM dispatch_attempts WHERE run_id = ?', [stepRow.run_id]);
  assert.ok(attempt, 'a durable dispatch_attempt ledger row exists — recovery has real evidence, not "no dispatch-attempt ledger found"');
  assert.equal(attempt.phase, ATTEMPT_PHASES.DISPATCH_STARTED, 'crossed the durable dispatch boundary before the adapter call resolved');

  const runRow = store.get('SELECT * FROM runs WHERE id = ?', [stepRow.run_id]);
  assert.equal(runRow.status, 'running');

  // "Restart": a completely FRESH repository/store handle over the SAME db
  // file independently recovers the SAME evidence — never by re-running the
  // adapter.
  const freshStore = new SqlitePersistenceStore();
  await freshStore.open({ path });
  stores.push(freshStore);
  const freshRepo = new AgentBusRepository({ store: freshStore });
  const freshAttempt = freshRepo.getDispatchAttemptForRun(stepRow.run_id);
  assert.ok(freshAttempt, 'a fresh repository handle independently recovers the dispatch attempt via run_id linkage');
  assert.equal(freshAttempt.phase, ATTEMPT_PHASES.DISPATCH_STARTED);
  const incomplete = freshRepo.listIncompleteDispatchAttempts();
  assert.ok(incomplete.some((a) => a.id === freshAttempt.id), 'the in-flight attempt is discoverable as incomplete for typed recovery');
  assert.equal(decideCalls, 1, 'reopening a fresh handle never auto-replayed the adapter');

  // Let the original in-flight call finish and confirm the terminal write lands.
  released();
  const result = await runPromise;
  assert.equal(result.status, 'completed');
  const finalAttempt = store.get('SELECT * FROM dispatch_attempts WHERE run_id = ?', [stepRow.run_id]);
  assert.equal(finalAttempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
  assert.equal(decideCalls, 1, 'still exactly one adapter call across the whole crash-boundary + resume sequence — no replay');
});
