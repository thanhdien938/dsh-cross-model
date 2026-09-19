// P13-R7.1 (docs/p13/15A_*.md) Parts E-G: a real R7 live defect -- an
// owner Cancel on an ACTIVE task persisted `failed` / `PM_BACKEND_ABORTED`
// instead of canonical `cancelled`. Root cause: DurablePmRuntime's
// `#continue()` catch block (durable-pm-runtime.mjs) treated every
// exception caught from an in-flight `#driver.decide()` call identically
// as `failed`, regardless of whether the abort that produced it was a
// canonical owner cancellation or anything else (a plain shutdown-drain
// abort, or an unrelated backend failure). Fixed via a reason-tagged
// AbortSignal: PM_OWNER_CANCEL_ABORT_REASON, stamped ONLY by
// ProductionPmWorker's `#wakeCancelledActiveSlots()` after reading a
// REQUESTED cancellation from the canonical durable coordination store --
// never merely inferred from "some abort happened" (Part F's explicit
// requirement: "Do NOT map every PM_BACKEND_ABORTED to CANCELLED").
//
// These tests exercise DurablePmRuntime + the REAL raceWithWatchdog()
// (production-pm-backend-registry.mjs) -- the actual function that throws
// PM_BACKEND_ABORTED in production -- against a real SQLite PmRepository,
// matching tests/durable-pm-runtime.test.mjs's existing lightweight
// fixture style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime, PM_OWNER_CANCEL_ABORT_REASON } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { raceWithWatchdog } from '../src/pm/production-pm-backend-registry.mjs';

function actions() {
  return {
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
  };
}

// A driver whose decide() call genuinely races an external signal through
// the REAL raceWithWatchdog(), just like every production backend
// (production-pm-backend-registry.mjs's createCliPmDriver()) does -- never
// a hand-rolled abort-error shortcut that could accidentally diverge from
// the real production error shape/code.
function neverSettlingDriver() {
  return {
    name: 'never-settling-driver',
    async decide({ signal }) {
      return raceWithWatchdog(new Promise(() => {}), { timeoutMs: 60_000, signal });
    },
  };
}

function immediateDriver(decision) {
  return { name: 'immediate-driver', async decide({ signal }) { return raceWithWatchdog(Promise.resolve(decision), { timeoutMs: 60_000, signal }); } };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p13r71-'));
  const path = join(dir, 'pm.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function prepareRun(runtime, id = 'pmrun_cancel') {
  return runtime.prepare({ objective: 'do work', context: {}, pmRunId: id });
}

test('1. owner cancel on an active task -> backend abort -> canonical CANCELLED', () => fixture(async ({ repository }) => {
  const runtime = new DurablePmRuntime({ driver: neverSettlingDriver(), repository, ...actions() });
  prepareRun(runtime);
  const controller = new AbortController();
  const pending = runtime.executePrepared('pmrun_cancel', { signal: controller.signal });
  // Simulate the owner's cancel arriving while decide() is genuinely
  // in-flight -- exactly ProductionPmWorker's #wakeCancelledActiveSlots().
  controller.abort(PM_OWNER_CANCEL_ABORT_REASON);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, null);
}));

test('2. backend abort WITHOUT owner cancel (e.g. shutdown drain) -> stays FAILED / PM_BACKEND_ABORTED', () => fixture(async ({ repository }) => {
  const runtime = new DurablePmRuntime({ driver: neverSettlingDriver(), repository, ...actions() });
  prepareRun(runtime, 'pmrun_shutdown');
  const controller = new AbortController();
  const pending = runtime.executePrepared('pmrun_shutdown', { signal: controller.signal });
  // drainActive() fires this abort with NO reason at all.
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'PM_BACKEND_ABORTED');
}));

test('2b. an abort with an UNRELATED reason string also stays FAILED -- only the exact canonical reason maps to CANCELLED', () => fixture(async ({ repository }) => {
  const runtime = new DurablePmRuntime({ driver: neverSettlingDriver(), repository, ...actions() });
  prepareRun(runtime, 'pmrun_other_reason');
  const controller = new AbortController();
  const pending = runtime.executePrepared('pmrun_other_reason', { signal: controller.signal });
  controller.abort('SOME_OTHER_SUBSYSTEM_REASON');
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'PM_BACKEND_ABORTED');
}));

test('3. owner cancel arrives after the task is already terminal -- existing canonical idempotent behavior, unchanged', () => fixture(async ({ repository }) => {
  const runtime = new DurablePmRuntime({ driver: immediateDriver({ type: 'finish', output: 'done', data: null }), repository, ...actions() });
  prepareRun(runtime, 'pmrun_already_done');
  const first = await runtime.executePrepared('pmrun_already_done', {});
  assert.equal(first.status, 'completed');
  // A cancellation arriving after the run already reached a terminal
  // status must never resurrect it or throw -- resume() on an already-
  // terminal run is pre-existing, unchanged behavior (#continue()'s own
  // first line: `if (run.status !== 'running') return this.#result(run)`).
  const controller = new AbortController();
  controller.abort(PM_OWNER_CANCEL_ABORT_REASON);
  const second = await runtime.resume('pmrun_already_done', { signal: controller.signal });
  assert.equal(second.status, 'completed');
}));

test('4. owner cancel and normal success race -- exactly one terminal outcome, and a success that wins the race is never overwritten by a later-observed abort', () => fixture(async ({ repository }) => {
  // The underlying promise resolves successfully BEFORE the abort signal
  // fires -- raceWithWatchdog()'s settle() is idempotent (first caller
  // wins, the loser is a silent no-op), so success must win deterministically.
  let releaseSuccess;
  const success = new Promise((resolve) => { releaseSuccess = resolve; });
  const driver = { name: 'racing-driver', async decide({ signal }) { return raceWithWatchdog(success, { timeoutMs: 60_000, signal }); } };
  const runtime = new DurablePmRuntime({ driver, repository, ...actions() });
  prepareRun(runtime, 'pmrun_race');
  const controller = new AbortController();
  const pending = runtime.executePrepared('pmrun_race', { signal: controller.signal });
  releaseSuccess({ type: 'finish', output: 'won-the-race', data: null });
  // Give the resolved promise a microtask to actually settle raceWithWatchdog
  // before the (now-too-late) abort fires.
  await new Promise((r) => setImmediate(r));
  controller.abort(PM_OWNER_CANCEL_ABORT_REASON);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'won-the-race');
}));
