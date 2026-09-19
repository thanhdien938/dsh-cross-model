// P13-R2: queue/fairness/cancel-isolation/observability -- see
// docs/p13/10_P13_R2_QUEUE_FAIRNESS_CANCEL_OBSERVABILITY_OPUS5.md.
// Tier 1 (pure/local, no Postgres) unless noted.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmWorker, ADMISSION_REJECTED, describeQueueReason, reconcileQueuedCancellation } from '../src/runtime/production-pm-worker.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }

function fakeCoordination({ candidates = [], cancellations = {} } = {}) {
  const activelyClaimed = new Set(); const done = new Set(); const acquired = [];
  const cancellationStates = new Map(Object.entries(cancellations));
  const cancelUnclaimedCalls = [];
  return {
    acquired, cancelUnclaimedCalls,
    listPmActionCandidates: async () => candidates.filter((w) => !activelyClaimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { acquired.push(work_item_id); if (activelyClaimed.has(work_item_id) || done.has(work_item_id)) return null; activelyClaimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fence' }; },
    renewClaim: async () => {},
    completeWork: (id) => { activelyClaimed.delete(id); done.add(id); },
    readCancellation: async (workItemId) => cancellationStates.get(workItemId) ?? null,
    cancelUnclaimedWork: async (workItemId) => { cancelUnclaimedCalls.push(workItemId); const c = cancellationStates.get(workItemId); if (!c || c.state !== 'REQUESTED') return null; const updated = { ...c, state: 'CANCELLED' }; cancellationStates.set(workItemId, updated); done.add(workItemId); return updated; },
    setCancellation: (workItemId, state) => cancellationStates.set(workItemId, { work_item_id: workItemId, state }),
  };
}
function holdOpenHandler() {
  const gates = new Map();
  return { gates, execute: async ({ work: w, signal }) => new Promise((resolve, reject) => { gates.set(w.work_item_id, () => resolve({ status: 'COMPLETED' })); signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { code: 'PM_BACKEND_ABORTED' })), { once: true }); }) };
}

// ---- R2.5: pure label mapping -----------------------------------------------

test('describeQueueReason maps the canonical vocabulary to owner-facing labels, and degrades honestly for anything unknown', () => {
  assert.equal(describeQueueReason(ADMISSION_REJECTED.GLOBAL_CAPACITY), 'Waiting — global capacity');
  assert.equal(describeQueueReason(ADMISSION_REJECTED.WORKSPACE_CAPACITY), 'Waiting — workspace busy');
  assert.equal(describeQueueReason('BACKEND_CAPACITY'), 'Waiting — backend capacity');
  assert.equal(describeQueueReason('RESOURCE_PRESSURE'), 'Waiting — resource pressure');
  assert.equal(describeQueueReason('AWAIT_OWNER'), 'Awaiting owner');
  assert.equal(describeQueueReason('RUNNING'), 'Running');
  assert.equal(describeQueueReason('SOME_FUTURE_REASON'), 'Waiting — some_future_reason');
  assert.equal(describeQueueReason(undefined), 'Waiting — unknown');
});

// ---- R2.5: lastAdmissionSnapshot() -----------------------------------------

test('lastAdmissionSnapshot() is null before the first tick and reflects the most recent tick\'s admission/rejection/cancellation outcome', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-x' }, b: { workspace_id: 'ws-x' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  assert.equal(worker.lastAdmissionSnapshot(), null);
  await worker.runOnce();
  const snapshot = worker.lastAdmissionSnapshot();
  assert.deepEqual(snapshot.started.map((s) => s.work_item_id), ['a']);
  assert.deepEqual(snapshot.rejected, [{ work_item_id: 'b', reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: 'ws-x' }]);
  assert.equal(snapshot.cancelled.length, 0);
  assert.ok(typeof snapshot.at === 'number');
  coordination.completeWork = () => {}; // not used further
  handler.gates.get('a')();
});

// ---- R2.2: fairness / no head-of-line blocking -----------------------------

test('fairness: when a freed slot opens, the OLDER queued task (C) is admitted before a newer one (D) when both are otherwise equally eligible', async () => {
  // listPmActionCandidates already returns FIFO by created_at (postgres-
  // coordination-store.mjs) -- this proves the admission LOOP honors that
  // order rather than re-sorting or picking arbitrarily.
  const c = work('c'); const d = work('d');
  const coordination = fakeCoordination({ candidates: [c, d] }); // c listed before d = older
  const identities = { c: { workspace_id: 'ws-c' }, d: { workspace_id: 'ws-d' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 1 });
  const result = await worker.runOnce();
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['c'], 'the older candidate (C) must win the single free slot over the newer one (D)');
  handler.gates.get('c')();
});

test('fairness: a workspace-blocked older candidate never blocks a younger, eligible candidate from a different workspace (no head-of-line blocking)', async () => {
  const coordination = fakeCoordination({ candidates: [work('older-blocked'), work('younger-eligible')] });
  const identities = { 'older-blocked': { workspace_id: 'ws-busy' }, 'younger-eligible': { workspace_id: 'ws-free' } };
  const handler = holdOpenHandler();
  // ws-busy already has an active task occupying it.
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  worker.activeByWorkspace.set('ws-busy', 1); // simulate: an existing active slot already occupies ws-busy
  const result = await worker.runOnce();
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['younger-eligible']);
  assert.deepEqual(result.rejected, [{ work_item_id: 'older-blocked', reason: ADMISSION_REJECTED.WORKSPACE_CAPACITY, workspace_id: 'ws-busy' }]);
  handler.gates.get('younger-eligible')();
});

// ---- R2.3: cancel a QUEUED (never-claimed) task ----------------------------

function fakePmRepository(runs) {
  return {
    load: (id) => { const run = runs.get(id); if (!run) throw new Error('no such run'); return run; },
    completeRun: (id, patch) => { const run = runs.get(id); runs.set(id, { ...run, status: patch.status, completedAt: patch.completedAt }); },
  };
}

test('reconcileQueuedCancellation terminalizes a genuinely queued (zero-turn, running) PM run as cancelled and consumes the coordination row', async () => {
  const runs = new Map([['pm-a', { id: 'pm-a', status: 'running', turnCount: 0 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({ cancellations: { a: { work_item_id: 'a', state: 'REQUESTED' } } });
  const consumed = await reconcileQueuedCancellation({ work: work('a'), coordinationStore: coordination, pmRepository });
  assert.equal(consumed, true);
  assert.equal(runs.get('pm-a').status, 'cancelled');
  assert.deepEqual(coordination.cancelUnclaimedCalls, ['a']);
});

test('reconcileQueuedCancellation is a no-op (never throws, never mutates) when no cancellation was requested', async () => {
  const runs = new Map([['pm-a', { id: 'pm-a', status: 'running', turnCount: 0 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({});
  const consumed = await reconcileQueuedCancellation({ work: work('a'), coordinationStore: coordination, pmRepository });
  assert.equal(consumed, false);
  assert.equal(runs.get('pm-a').status, 'running');
});

test('reconcileQueuedCancellation refuses a candidate whose run is already non-running (leaves it to the existing adoption path)', async () => {
  const runs = new Map([['pm-a', { id: 'pm-a', status: 'failed', turnCount: 0 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({ cancellations: { a: { work_item_id: 'a', state: 'REQUESTED' } } });
  const consumed = await reconcileQueuedCancellation({ work: work('a'), coordinationStore: coordination, pmRepository });
  assert.equal(consumed, false);
  assert.equal(coordination.cancelUnclaimedCalls.length, 0);
});

test('reconcileQueuedCancellation refuses a candidate that already has a committed turn (not a "never claimed" item)', async () => {
  const runs = new Map([['pm-a', { id: 'pm-a', status: 'running', turnCount: 1 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({ cancellations: { a: { work_item_id: 'a', state: 'REQUESTED' } } });
  const consumed = await reconcileQueuedCancellation({ work: work('a'), coordinationStore: coordination, pmRepository });
  assert.equal(consumed, false);
});

test('R2.3 end-to-end via the real admission loop: a queued candidate with a pending cancellation never acquires a claim, is reported cancelled, and no backend starts', async () => {
  const runs = new Map([['pm-a', { id: 'pm-a', status: 'running', turnCount: 0 }], ['pm-b', { id: 'pm-b', status: 'running', turnCount: 0 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')], cancellations: { a: { work_item_id: 'a', state: 'REQUESTED' } } });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' } };
  let backendStarted = 0;
  const handler = { execute: async () => { backendStarted += 1; return { status: 'COMPLETED' }; } };
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2,
    resolveWorkIdentity: (w) => identities[w.work_item_id],
    resolveQueuedCancellation: (w) => reconcileQueuedCancellation({ work: w, coordinationStore: coordination, pmRepository }),
  });
  const result = await worker.runOnce();
  assert.deepEqual(result.cancelled, [{ work_item_id: 'a' }]);
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['b']);
  assert.equal(coordination.acquired.includes('a'), false, 'a cancelled-while-queued candidate must never reach acquireClaim');
  assert.equal(runs.get('pm-a').status, 'cancelled');
  await result.started[0].promise;
  assert.equal(backendStarted, 1, 'only b -- the un-cancelled candidate -- ever invoked the backend');
});

// ---- R2.4: cancel an ACTIVE task wakes its own AbortController -------------

test('R2.4: cancelling an ACTIVE task fires ITS OWN AbortController promptly; a different active task in a different workspace is completely unaffected', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const started = await worker.runOnce();
  assert.equal(started.started.length, 2);
  // Owner cancels A via the canonical, pre-existing path -- a plain
  // cancellation_requests row, nothing else.
  coordination.setCancellation('a', 'REQUESTED');
  // The next supervisor tick discovers and wakes it.
  await worker.runOnce();
  const aResult = await started.started.find((s) => s.work_item_id === 'a').promise;
  assert.equal(aResult.status, 'FAILED');
  assert.equal(aResult.error.code, 'PM_BACKEND_ABORTED');
  // B was never signalled and remains fully active until it settles on
  // its own -- proving per-task isolation, not a global cancellation flag.
  assert.equal(worker.activeCount(), 1, 'B\'s slot is untouched by A\'s cancellation');
  handler.gates.get('b')();
  const bResult = await started.started.find((s) => s.work_item_id === 'b').promise;
  assert.equal(bResult.status, 'WORK');
  assert.equal(bResult.outcome.status, 'COMPLETED');
});

// ---- R2.5: GLOBAL_CAPACITY is now an observable rejection reason --------

test('R2.5: a candidate refused purely for GLOBAL_CAPACITY is reported in rejected[] (and in lastAdmissionSnapshot()), even when the runtime is already full at tick start', async () => {
  const a = work('a'); const b = work('b'); const c = work('c');
  const coordination = fakeCoordination({ candidates: [a, b, c] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  assert.deepEqual(first.rejected, [{ work_item_id: 'c', reason: ADMISSION_REJECTED.GLOBAL_CAPACITY }]);
  // Already full at the START of the next tick -- status stays AT_CAPACITY
  // (backward compatible), but `rejected` is now populated too.
  const second = await worker.runOnce();
  assert.equal(second.status, 'AT_CAPACITY');
  assert.deepEqual(second.rejected, [{ work_item_id: 'c', reason: ADMISSION_REJECTED.GLOBAL_CAPACITY }]);
  assert.deepEqual(worker.lastAdmissionSnapshot().rejected, [{ work_item_id: 'c', reason: ADMISSION_REJECTED.GLOBAL_CAPACITY }]);
  handler.gates.get('a')(); handler.gates.get('b')();
});

test('R2.3: a queued cancellation is consumed even while the runtime is completely at global capacity -- cancel never waits on a free slot', async () => {
  const runs = new Map([['pm-c', { id: 'pm-c', status: 'running', turnCount: 0 }]]);
  const pmRepository = fakePmRepository(runs);
  const coordination = fakeCoordination({ candidates: [work('a'), work('b'), work('c')], cancellations: { c: { work_item_id: 'c', state: 'REQUESTED' } } });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2,
    resolveWorkIdentity: (w) => identities[w.work_item_id],
    resolveQueuedCancellation: (w) => reconcileQueuedCancellation({ work: w, coordinationStore: coordination, pmRepository }),
  });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  assert.deepEqual(first.cancelled, [{ work_item_id: 'c' }], 'c is cancelled in the SAME tick that fills capacity -- it never had to wait');
  assert.equal(runs.get('pm-c').status, 'cancelled');
  handler.gates.get('a')(); handler.gates.get('b')();
});

test('R2.4: wakeCancelledActiveSlots is a safe no-op against a coordination store that does not implement readCancellation (backward compatible)', async () => {
  const coordination = { listPmActionCandidates: async () => [work('a')], acquireClaim: async ({ work_item_id, worker_incarnation_id }) => ({ work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'f' }), renewClaim: async () => {} };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1' });
  await assert.doesNotReject(() => worker.runOnce());
  handler.gates.get('a')();
});
