// P13-R5: resource pressure governor -- prevents NEW admission when the
// local machine is under unsafe resource pressure, without ever
// interrupting an already-active task. See
// docs/p13/13_P13_R5_RESOURCE_PRESSURE_GOVERNOR_OPUS5.md. Tier 1
// (deterministic, injectable metrics -- no real RAM/CPU stress, per the
// master brief's own instruction).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResourcePressureGovernor, readSystemMemoryPressure } from '../src/runtime/resource-pressure-governor.mjs';
import { ProductionPmWorker, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';

function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }

function fakeCoordination({ candidates = [] } = {}) {
  const claimed = new Set(); const done = new Set(); const acquired = [];
  return {
    acquired,
    listPmActionCandidates: async () => candidates.filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    listActivePmActionWork: async () => candidates.filter((w) => claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { acquired.push(work_item_id); if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fence' }; },
    renewClaim: async () => {},
    completeWork: (id) => { claimed.delete(id); done.add(id); },
  };
}
function holdOpenHandler() {
  const gates = new Map();
  return { gates, execute: async ({ work: w }) => new Promise((resolve) => gates.set(w.work_item_id, () => resolve({ status: 'COMPLETED' }))) };
}

// ---- readSystemMemoryPressure() ---------------------------------------

test('readSystemMemoryPressure returns a real, bounded usedFraction', () => {
  const metrics = readSystemMemoryPressure();
  assert.equal(typeof metrics.usedFraction, 'number');
  assert.ok(metrics.usedFraction >= 0 && metrics.usedFraction <= 1, `usedFraction ${metrics.usedFraction} must be in [0,1]`);
  assert.equal(typeof metrics.freeBytes, 'number');
  assert.equal(typeof metrics.totalBytes, 'number');
  assert.ok(metrics.totalBytes > 0);
});

// ---- createResourcePressureGovernor: hysteresis ------------------------

test('governor requires recoveryWatermark strictly below highWatermark', () => {
  assert.throws(() => createResourcePressureGovernor({ highWatermark: 0.5, recoveryWatermark: 0.5 }), TypeError);
  assert.throws(() => createResourcePressureGovernor({ highWatermark: 0.5, recoveryWatermark: 0.6 }), TypeError);
});

test('governor allows admission while below the high watermark', () => {
  let fraction = 0.5;
  const governor = createResourcePressureGovernor({ readMetrics: () => ({ usedFraction: fraction }), highWatermark: 0.9, recoveryWatermark: 0.8 });
  assert.equal(governor.checkAdmission().allowed, true);
  fraction = 0.89;
  assert.equal(governor.checkAdmission().allowed, true);
});

test('governor denies admission once the high watermark is reached, and stays denied through the hysteresis band', () => {
  let fraction = 0.5;
  const governor = createResourcePressureGovernor({ readMetrics: () => ({ usedFraction: fraction }), highWatermark: 0.9, recoveryWatermark: 0.8 });
  fraction = 0.9;
  let check = governor.checkAdmission();
  assert.equal(check.allowed, false);
  assert.equal(check.pressureActive, true);
  // Drops back into the hysteresis band (below high, but still above
  // recovery) -- must remain denied, not oscillate back to allowed.
  fraction = 0.85;
  check = governor.checkAdmission();
  assert.equal(check.allowed, false, 'must not clear pressure until at/below the recovery watermark');
  assert.equal(check.pressureActive, true);
});

test('governor recovers only once the metric falls to/below the recovery watermark', () => {
  let fraction = 0.95;
  const governor = createResourcePressureGovernor({ readMetrics: () => ({ usedFraction: fraction }), highWatermark: 0.9, recoveryWatermark: 0.8 });
  assert.equal(governor.checkAdmission().allowed, false);
  fraction = 0.8;
  const check = governor.checkAdmission();
  assert.equal(check.allowed, true);
  assert.equal(check.pressureActive, false);
});

test('governor never oscillates admit/deny around a single boundary value held steady', () => {
  const fraction = 0.9; // exactly at the high watermark, held constant
  const governor = createResourcePressureGovernor({ readMetrics: () => ({ usedFraction: fraction }), highWatermark: 0.9, recoveryWatermark: 0.8 });
  const results = Array.from({ length: 5 }, () => governor.checkAdmission().allowed);
  assert.deepEqual(results, [false, false, false, false, false], 'once pressure activates at the boundary it must stay active, never flip-flop');
});

// ---- failure mode: fail-closed, non-sticky, never crashes --------------

test('a thrown readMetrics() fails closed for that tick only, and never crashes', () => {
  let shouldThrow = true;
  const governor = createResourcePressureGovernor({ readMetrics: () => { if (shouldThrow) throw new Error('boom'); return { usedFraction: 0.1 }; } });
  const first = governor.checkAdmission();
  assert.equal(first.allowed, false);
  assert.equal(first.metrics, null);
  assert.equal(first.error.message, 'boom');
  // Not sticky: a later successful read (well below the high watermark)
  // immediately un-blocks admission, with no separate "reset" needed.
  shouldThrow = false;
  const second = governor.checkAdmission();
  assert.equal(second.allowed, true);
  assert.equal(second.error, null);
});

test('a malformed readMetrics() return shape (no numeric usedFraction) is treated the same as a thrown error', () => {
  const governor = createResourcePressureGovernor({ readMetrics: () => ({ somethingElse: 1 }) });
  const check = governor.checkAdmission();
  assert.equal(check.allowed, false);
  assert.equal(check.error.name, 'InvalidMetricsShape');
});

// ---- wired into ProductionPmWorker's admission path --------------------

test('RESOURCE_PRESSURE blocks NEW admission but never touches an already-active slot', async () => {
  const a = work('a'); const b = work('b');
  const candidateList = [a, b];
  const coordination = fakeCoordination({ candidates: candidateList });
  const handler = holdOpenHandler();
  let pressureActive = false;
  const governor = { checkAdmission: () => ({ allowed: !pressureActive, pressureActive, metrics: { usedFraction: pressureActive ? 0.95 : 0.1 }, error: null }) };
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2,
    resolveWorkIdentity: (w) => ({ workspace_id: `ws-${w.work_item_id}` }),
    resourcePressureGovernor: governor,
  });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id), ['a', 'b'], 'both are admitted while pressure is clear');

  // Pressure kicks in on a later tick, after both settle -- a fresh
  // candidate (c) must be refused, and this in no way reaches back to
  // touch A/B's already-completed executions.
  handler.gates.get('a')(); handler.gates.get('b')();
  await Promise.all(first.started.map((s) => s.promise));
  pressureActive = true;
  candidateList.length = 0;
  candidateList.push(work('c'));
  const second = await worker.runOnce();
  assert.equal(worker.activeCount(), 0, 'no slot survives from the prior tick to be affected either way');
  assert.equal(second.status, 'IDLE', 'nothing started this tick -- IDLE/AT_CAPACITY ticks carry no `started` key at all');
  assert.ok(second.rejected.some((r) => r.work_item_id === 'c' && r.reason === ADMISSION_REJECTED.RESOURCE_PRESSURE));
  assert.equal(worker.lastAdmissionSnapshot().resourcePressure.pressureActive, true);
});

test('resource pressure is checked before global/workspace/backend capacity, but never blocks queued-cancellation', async () => {
  const a = work('a');
  const coordination = fakeCoordination({ candidates: [a] });
  coordination.readCancellation = async () => ({ state: 'REQUESTED' });
  let cancelled = false;
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler: holdOpenHandler(), workerIncarnationId: 'w1', globalLimit: 1,
    resolveWorkIdentity: (w) => ({ workspace_id: `ws-${w.work_item_id}` }),
    resolveQueuedCancellation: async () => { cancelled = true; return true; },
    resourcePressureGovernor: { checkAdmission: () => ({ allowed: false, pressureActive: true, metrics: { usedFraction: 0.99 }, error: null }) },
  });
  const tick = await worker.runOnce();
  assert.equal(cancelled, true, 'queued cancellation must still be consumed even while resource pressure is active');
  assert.deepEqual(tick.cancelled, [{ work_item_id: 'a' }]);
  assert.deepEqual(tick.rejected, [], 'the cancelled candidate must not ALSO appear as a RESOURCE_PRESSURE rejection');
});

test('backward compatible: with no resourcePressureGovernor configured, admission is entirely unaffected', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 1, resolveWorkIdentity: (w) => ({ workspace_id: `ws-${w.work_item_id}` }) });
  const result = await worker.runOnce();
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['a']);
  assert.equal(worker.lastAdmissionSnapshot().resourcePressure, null);
  handler.gates.get('a')();
});
