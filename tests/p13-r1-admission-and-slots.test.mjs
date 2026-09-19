// P13-R1: Tier 1 (pure/local, no Postgres/SQLite) proofs for
// ProductionPmWorker's admission model, slot table, and promise safety --
// see docs/p13/04_P13_R1_BOUNDED_CROSS_WORKSPACE_PARALLELISM_IMPLEMENTATION_
// OPUS5.md for the full contract these tests hold to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionPmWorker, resolvePmWorkspaceIdentity, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }

// A real coordination store stops listing a work item once it holds an
// unexpired ACTIVE claim (postgres-coordination-store.mjs's
// `listPmActionCandidates`). This fake mirrors that: an item disappears
// from discovery the moment it is claimed, reappears once the test
// simulates the claim going away (`releaseClaim`, e.g. PARKED/expiry), and
// disappears PERMANENTLY once the test simulates the underlying pm_run
// reaching a terminal status (`completeWork`) -- exactly the admit-then-
// claim/durable-queue contract §5.1/§6.1 describe.
function fakeCoordination({ candidates, claims = {} } = {}) {
  const acquired = [];
  const activelyClaimed = new Set();
  const done = new Set(); // a completed/terminal pm_run never reappears (mirrors pm_runs.status != 'running')
  return {
    acquired,
    listPmActionCandidates: async () => candidates.filter((w) => !activelyClaimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id, leaseMs }) => {
      acquired.push(work_item_id);
      if (claims[work_item_id] === false) return null; // simulate lost race
      activelyClaimed.add(work_item_id);
      return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fence', leaseMs };
    },
    renewClaim: async () => {},
    // test-only escape hatches simulating what the real store does once a
    // handler settles: PARKED (AWAIT_OWNER) leaves the claim released but
    // the item stays ineligible until AwaitOwnerCloser restores it (never
    // called here, so simply never re-listing it already matches that);
    // a genuinely completed/failed run's work item never reappears at all.
    releaseClaim: (work_item_id) => activelyClaimed.delete(work_item_id),
    completeWork: (work_item_id) => { activelyClaimed.delete(work_item_id); done.add(work_item_id); },
  };
}

function holdOpenHandler() {
  const gates = new Map();
  return {
    gates,
    execute: async ({ work: w }) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      gates.set(w.work_item_id, release);
      await gate;
      return { status: 'COMPLETED' };
    },
  };
}

// ---- Invariant 1/D1: admission happens BEFORE claim -----------------------

test('admission is evaluated before acquireClaim: a WORKSPACE_CAPACITY refusal never calls acquireClaim', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-x' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const result = await worker.runOnce();
  assert.equal(result.status, 'WORK');
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['a']);
  assert.deepEqual(result.rejected, [{ work_item_id: 'b', reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: 'ws-x' }]);
  assert.deepEqual(coordination.acquired, ['a'], 'b must never reach acquireClaim once refused locally');
  handler.gates.get('a')();
});

test('a claim lost to another holder consumes no slot and is reported CLAIM_LOST', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')], claims: { a: false } });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'IDLE');
  assert.deepEqual(result.rejected, [{ work_item_id: 'a', reason: ADMISSION_REJECTED.CLAIM_LOST }]);
  assert.equal(worker.activeCount(), 0);
});

test('unresolvable identity is refused IDENTITY_UNRESOLVED and never claimed', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: () => null });
  const result = await worker.runOnce();
  assert.equal(result.status, 'IDLE');
  assert.deepEqual(result.rejected, [{ work_item_id: 'a', reason: ADMISSION_REJECTED.IDENTITY_UNRESOLVED }]);
  assert.deepEqual(coordination.acquired, []);
});

// ---- Invariant 2: global capacity ------------------------------------------

test('R1 proof: two DIFFERENT workspaces are active simultaneously under globalLimit 2', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-y' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const result = await worker.runOnce();
  assert.equal(result.status, 'WORK');
  assert.deepEqual(result.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  assert.equal(worker.activeCount(), 2, 'both hold an active slot at the same time -- neither waited for the other');
  handler.gates.get('a')(); handler.gates.get('b')();
  await Promise.all(result.started.map((s) => s.promise));
  assert.equal(worker.activeCount(), 0);
});

test('a third candidate waits when global capacity (2) is already full', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b'), work('c')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-y' }, c: { workspace_id: 'ws-z' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  try {
    const result = await worker.runOnce();
    assert.equal(result.status, 'WORK');
    assert.deepEqual(result.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
    assert.deepEqual(coordination.acquired.sort(), ['a', 'b'], 'c must never reach acquireClaim while capacity is full');
    assert.equal(worker.activeCount(), 2);
    const atCapacity = await worker.runOnce();
    assert.equal(atCapacity.status, 'AT_CAPACITY');
    handler.gates.get('a')();
    await result.started.find((s) => s.work_item_id === 'a').promise;
    coordination.completeWork('a'); // simulates completeClaim()/lease expiry making 'a' re-eligible for discovery
    // c remains eligible and is admitted on a later tick once a slot frees up.
    const next = await worker.runOnce();
    assert.equal(next.status, 'WORK');
    assert.deepEqual(next.started.map((s) => s.work_item_id), ['c']);
  } finally {
    handler.gates.get('b')?.(); handler.gates.get('c')?.();
  }
});

// ---- Invariant 3: same workspace serializes ---------------------------------

test('same workspace never runs two active tasks concurrently; the second is admitted only after the first settles', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-shared' }, b: { workspace_id: 'ws-shared' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  try {
    const first = await worker.runOnce();
    assert.equal(first.status, 'WORK');
    assert.deepEqual(first.started.map((s) => s.work_item_id), ['a']);
    assert.equal(worker.activeCount(), 1, 'one free global slot remains, but the workspace is occupied');
    const stillWaiting = await worker.runOnce();
    assert.equal(stillWaiting.status, 'IDLE');
    assert.deepEqual(stillWaiting.rejected, [{ work_item_id: 'b', reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: 'ws-shared' }]);
    handler.gates.get('a')();
    await first.started[0].promise;
    coordination.completeWork('a');
    const afterSettle = await worker.runOnce();
    assert.equal(afterSettle.status, 'WORK');
    assert.deepEqual(afterSettle.started.map((s) => s.work_item_id), ['b']);
  } finally {
    handler.gates.get('b')?.();
  }
});

// ---- resolvePmWorkspaceIdentity: canonical identity, never project.id -----

function fakePmRepository(runs) { return { load: (id) => { const run = runs[id]; if (!run) throw new Error('no such run'); return run; } }; }
function fakeTaskRepository(tasks) { return { getOwnerTask: (id) => tasks[id] ?? null }; }

test('resolvePmWorkspaceIdentity derives workspace_id from the project record, never from project.id', () => {
  const run = { id: 'pmrun-1', request: { context: { ownerCommandId: 'cmd-1' } } };
  const taskId = 'task-a'; // does not need to match deterministicOwnerId for this pure unit test's fakes
  const pmRepository = { load: () => run };
  const taskRepository = { getOwnerTask: () => ({ projectId: 'proj-a' }) };
  const projects = new Map([['proj-a', { id: 'proj-a', workspace_id: 'ws-canonical' }]]);
  const identity = resolvePmWorkspaceIdentity({ work: work('a'), pmRepository, taskRepository, projects });
  assert.equal(identity.workspace_id, 'ws-canonical');
  assert.notEqual(identity.workspace_id, 'proj-a');
});

test('resolvePmWorkspaceIdentity: two DIFFERENT project ids sharing one workspace_id resolve identically', () => {
  const pmRepository = { load: (id) => ({ id, request: { context: { ownerCommandId: `cmd-${id}` } } }) };
  const taskIdFor = (runId) => deterministicOwnerId('task', `cmd-${runId}`);
  const tasksByTaskId = { [taskIdFor('pm-A')]: { projectId: 'project-A' }, [taskIdFor('pm-B')]: { projectId: 'project-B' } };
  const taskRepository = { getOwnerTask: (taskId) => tasksByTaskId[taskId] ?? null };
  const projects = new Map([
    ['project-A', { id: 'project-A', workspace_id: 'SAME-PHYSICAL-PATH' }],
    ['project-B', { id: 'project-B', workspace_id: 'SAME-PHYSICAL-PATH' }],
  ]);
  const a = resolvePmWorkspaceIdentity({ work: work('A'), pmRepository, taskRepository, projects });
  const b = resolvePmWorkspaceIdentity({ work: work('B'), pmRepository, taskRepository, projects });
  assert.equal(a.workspace_id, b.workspace_id);
  assert.notEqual(a.project_id, b.project_id);
});

test('resolvePmWorkspaceIdentity falls back to repo_path (never project.id) when workspace_id is absent, and refuses when neither exists', () => {
  const pmRepository = { load: () => ({ id: 'r', request: { context: { ownerCommandId: 'c' } } }) };
  const taskRepository = { getOwnerTask: () => ({ projectId: 'p' }) };
  const withPath = resolvePmWorkspaceIdentity({ work: work('a'), pmRepository, taskRepository, projects: new Map([['p', { id: 'p', repo_path: 'E:/repo-x' }]]) });
  assert.equal(withPath.workspace_id, 'unverified:E:/repo-x');
  const withNeither = resolvePmWorkspaceIdentity({ work: work('a'), pmRepository, taskRepository, projects: new Map([['p', { id: 'p' }]]) });
  assert.equal(withNeither, null);
});

test('resolvePmWorkspaceIdentity refuses cleanly (never throws) for an unknown pm_run_id or task', () => {
  assert.equal(resolvePmWorkspaceIdentity({ work: work('a'), pmRepository: { load: () => { throw new Error('missing'); } }, taskRepository: fakeTaskRepository({}), projects: new Map() }), null);
  assert.equal(resolvePmWorkspaceIdentity({ work: work('a'), pmRepository: fakePmRepository({ 'pm-a': { id: 'pm-a', request: { context: {} } } }), taskRepository: fakeTaskRepository({}), projects: new Map() }), null);
});

// ---- Invariant 6: unhandled rejection protection ---------------------------

test('a handler that rejects never produces a process-level unhandledRejection, and the slot settles FAILED exactly once', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = { execute: async () => { throw Object.assign(new Error('boom'), { code: 'BACKEND_EXPLODED' }); } };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await worker.runOnce();
    assert.equal(result.status, 'WORK');
    // Deliberately do NOT await/catch result.started[0].promise here -- the
    // whole point of this test is that leaving it unconsumed must still be
    // safe. Give the microtask/macrotask queue a full turn to prove it.
    await delay(20);
    assert.equal(unhandled, null, 'the tracked settlement promise must never be an unhandled rejection');
    const settled = await result.started[0].promise;
    assert.equal(settled.status, 'FAILED');
    assert.equal(settled.error.code, 'BACKEND_EXPLODED');
    assert.equal(worker.activeCount(), 0, 'the slot is released exactly once on failure');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('lost claim authority during successful settlement never produces an unhandledRejection', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  coordination.renewClaim = async () => { throw Object.assign(new Error('stale fence'), { code: 'CLAIM_AUTHORITY_REJECTED' }); };
  const handler = { execute: async () => { await delay(40); return { status: 'COMPLETED' }; } };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', leaseMs: 30 });
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await worker.runOnce();
    assert.equal(result.status, 'WORK');
    await delay(60); // deliberately leave the tracked promise unconsumed
    assert.equal(unhandled, null, 'settlement callback failures must resolve FAILED, never reject process-wide');
    const settled = await result.started[0].promise;
    assert.equal(settled.status, 'FAILED');
    assert.equal(settled.error.code, 'PM_CLAIM_AUTHORITY_LOST');
    assert.equal(worker.activeCount(), 0, 'the failed settlement releases its process-local slot');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---- Invariant 7 / §7: PARKED (AWAIT_OWNER) releases the slot -------------

test('a handler returning PARKED releases the slot immediately, freeing global capacity while the owner interaction is open', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-y' } };
  let releaseB;
  const handler = {
    execute: async ({ work: w }) => {
      if (w.work_item_id === 'a') return { status: 'PARKED', pmRunId: 'pm-a', interactionId: 'i-a' };
      await new Promise((resolve) => { releaseB = resolve; });
      return { status: 'COMPLETED' };
    },
  };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 1 });
  const first = await worker.runOnce();
  assert.equal(first.status, 'WORK');
  const settled = await first.started[0].promise;
  assert.equal(settled.outcome.status, 'PARKED');
  assert.equal(worker.activeCount(), 0, 'AWAIT_OWNER must not hold a global execution slot while the owner decides');
  const second = await worker.runOnce();
  assert.equal(second.status, 'WORK');
  assert.deepEqual(second.started.map((s) => s.work_item_id), ['b']);
  releaseB();
  await second.started[0].promise;
});

// ---- Failure isolation ------------------------------------------------------

test('failure isolation: task A rejecting does not affect task B, and the worker survives', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-y' } };
  let releaseB;
  const handler = {
    execute: async ({ work: w }) => {
      if (w.work_item_id === 'a') throw Object.assign(new Error('a failed'), { code: 'TASK_A_ERROR' });
      await new Promise((resolve) => { releaseB = resolve; });
      return { status: 'COMPLETED' };
    },
  };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const result = await worker.runOnce();
  const a = await result.started.find((s) => s.work_item_id === 'a').promise;
  assert.equal(a.status, 'FAILED');
  assert.equal(a.error.code, 'TASK_A_ERROR');
  assert.equal(worker.activeCount(), 1, 'B is unaffected and still holds its own slot after A failed');
  releaseB();
  const b = await result.started.find((s) => s.work_item_id === 'b').promise;
  assert.equal(b.status, 'WORK');
  assert.equal(b.outcome.status, 'COMPLETED');
});

// ---- CompositeProductionWorker fairness ------------------------------------

test('CompositeProductionWorker ticks every wrapped worker every round -- a promptly-returning PM worker never starves the other', async () => {
  const { CompositeProductionWorker } = await import('../src/runtime/production-pm-worker.mjs');
  let pmTicks = 0, otherTicks = 0;
  const pmWorker = { requestStop() {}, runOnce: async () => { pmTicks += 1; return { status: 'WORK', started: [], rejected: [] }; } };
  const otherWorker = { requestStop() {}, runOnce: async () => { otherTicks += 1; return { status: 'IDLE' }; } };
  const composite = new CompositeProductionWorker(pmWorker, otherWorker);
  for (let i = 0; i < 5; i += 1) await composite.runOnce();
  assert.equal(pmTicks, 5); assert.equal(otherTicks, 5, 'the second worker must be ticked every round, not starved by the first');
});

test('CompositeProductionWorker returns a single worker\'s own result verbatim when only it is active (backward compatible shape)', async () => {
  const { CompositeProductionWorker } = await import('../src/runtime/production-pm-worker.mjs');
  const pmResult = { status: 'WORK', work_item_id: 'a', outcome: { status: 'COMPLETED' } };
  const pmWorker = { requestStop() {}, runOnce: async () => pmResult };
  const otherWorker = { requestStop() {}, runOnce: async () => ({ status: 'IDLE' }) };
  const composite = new CompositeProductionWorker(pmWorker, otherWorker);
  const result = await composite.runOnce();
  assert.equal(result, pmResult);
});

test('CompositeProductionWorker aggregates when MORE THAN ONE wrapped worker is active in the same tick', async () => {
  const { CompositeProductionWorker } = await import('../src/runtime/production-pm-worker.mjs');
  const pmResult = { status: 'WORK', work_item_id: 'a' };
  const taskResult = { status: 'WORK', work_item_id: 'b' };
  const composite = new CompositeProductionWorker({ requestStop() {}, runOnce: async () => pmResult }, { requestStop() {}, runOnce: async () => taskResult });
  const result = await composite.runOnce();
  assert.equal(result.status, 'WORK');
  assert.deepEqual(result.results, [pmResult, taskResult]);
});

test('CompositeProductionWorker reports DRAINING only once every wrapped worker is draining', async () => {
  const { CompositeProductionWorker } = await import('../src/runtime/production-pm-worker.mjs');
  const composite = new CompositeProductionWorker({ requestStop() {}, runOnce: async () => ({ status: 'DRAINING' }) }, { requestStop() {}, runOnce: async () => ({ status: 'DRAINING' }) });
  assert.equal((await composite.runOnce()).status, 'DRAINING');
});

// ---- D4: bounded drain ------------------------------------------------------

test('drainActive() (grace phase) waits for every active slot to settle naturally and reports remaining=0, aborted=0', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-y' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  await worker.runOnce();
  assert.equal(worker.activeCount(), 2);
  const drainPromise = worker.drainActive({ gracePeriodMs: 2000, timeoutMs: 2000 });
  await delay(10);
  handler.gates.get('a')(); handler.gates.get('b')();
  const outcome = await drainPromise;
  assert.deepEqual(outcome, { settled: true, remaining: 0, aborted: 0 }, 'both settled within the grace period -- no abort was ever needed');
});

test('drainActive() aborts a slot still active past the grace period, and reports unsettled/aborted when it never consumes the signal', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = holdOpenHandler(); // ignores `signal` entirely -- the abort-unaware case
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  await worker.runOnce();
  const outcome = await worker.drainActive({ gracePeriodMs: 10, timeoutMs: 30 });
  assert.deepEqual(outcome, { settled: false, remaining: 1, aborted: 1 }, 'the grace period elapsed, the slot was aborted, but it never settled -- drain must say so honestly');
  handler.gates.get('a')();
});

test('a slot that DOES consume the abort signal settles quickly once fired, well within the confirm bound', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = { execute: async ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'FAILED' }), { once: true })) };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  await worker.runOnce();
  const outcome = await worker.drainActive({ gracePeriodMs: 10, timeoutMs: 2000 });
  assert.deepEqual(outcome, { settled: true, remaining: 0, aborted: 1 }, 'aborted, then confirmed settled -- never just assumed');
});

test('drainActive() stops claim renewal for a still-active, abort-unaware slot once its full bound expires (§13 step 5)', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  let renewals = 0;
  coordination.renewClaim = async () => { renewals += 1; };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', leaseMs: 30 });
  await worker.runOnce();
  const before = await delay(60).then(() => renewals);
  assert.ok(before >= 1, 'renewal is actually ticking before drain');
  await worker.drainActive({ gracePeriodMs: 10, timeoutMs: 10 });
  const afterDrainTimeout = await delay(80).then(() => renewals);
  await delay(80);
  assert.equal(renewals, afterDrainTimeout, 'renewal must stop once the full drain bound (grace + confirm) expires -- no more ticks after that point');
  handler.gates.get('a')();
});

test('drainActive() is a no-op when nothing is active', async () => {
  const coordination = fakeCoordination({ candidates: [] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  assert.deepEqual(await worker.drainActive(), { settled: true, remaining: 0, aborted: 0 });
});

// ---- Backward compatibility: no identity resolver / default limit ---------

test('with no resolveWorkIdentity and the default globalLimit=1, behavior is single-flight (pre-P13 shape) but non-blocking', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'WORK');
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['a'], 'only one item is ever admitted at globalLimit=1');
  assert.equal(worker.activeCount(), 1);
  handler.gates.get('a')();
  await result.started[0].promise;
});
