// P15-B-002: UNKNOWN external occupancy must never be interpreted as ZERO.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmWorker, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';

function work(id) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}` }; }

function faultedCoordination(candidates) {
  const acquireLog = [];
  return {
    acquireLog,
    listActivePmActionWork: async () => { throw Object.assign(new Error('read failed for postgresql://user:secret@host/db'), { code: 'CONNECTION_LOST' }); },
    listPmActionCandidates: async () => candidates,
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => {
      acquireLog.push(work_item_id);
      return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: `fence-${work_item_id}` };
    },
    renewClaim: async () => {},
  };
}

test('P15-B-002 partial PostgreSQL occupancy-read failure fails closed for the entire tick', async () => {
  const candidates = [work('same-workspace'), work('separate-workspace')];
  const coordination = faultedCoordination(candidates);
  const diagnostics = [];
  const worker = new ProductionPmWorker({
    coordinationStore: coordination,
    handler: { execute: async () => ({ status: 'COMPLETED' }) },
    workerIncarnationId: 'worker-p15',
    resolveWorkIdentity: (item) => ({ workspace_id: item.work_item_id === 'same-workspace' ? 'occupied-workspace' : 'other-workspace' }),
    globalLimit: 2,
    diagnosticSink: (entry) => diagnostics.push(entry),
  });

  const result = await worker.runOnce();
  assert.deepEqual(coordination.acquireLog, [], 'claim writes remain healthy but must not be attempted');
  assert.deepEqual(result.rejected.map(({ work_item_id, reason }) => ({ work_item_id, reason })), [
    { work_item_id: 'same-workspace', reason: ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE },
    { work_item_id: 'separate-workspace', reason: ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE },
  ]);
  assert.equal(worker.activeCount(), 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'PM_OCCUPANCY_DISCOVERY_FAILED');
  assert.equal(diagnostics[0].policy, 'FAIL_CLOSED_FOR_TICK');
  assert.equal(JSON.stringify(diagnostics[0]).includes('secret'), false);
});

test('P15-B-002 repeated occupancy faults emit one bounded diagnostic, not one duplicate per tick', async () => {
  const coordination = faultedCoordination([work('candidate')]);
  const diagnostics = [];
  let now = 1_000;
  const worker = new ProductionPmWorker({
    coordinationStore: coordination,
    handler: { execute: async () => ({ status: 'COMPLETED' }) },
    workerIncarnationId: 'worker-p15-rate-limit',
    resolveWorkIdentity: () => ({ workspace_id: 'workspace' }),
    diagnosticSink: (entry) => diagnostics.push(entry),
    diagnosticRateLimitMs: 30_000,
    now: () => now,
  });

  await worker.runOnce();
  now += 250;
  await worker.runOnce();
  now += 250;
  await worker.runOnce();
  assert.equal(diagnostics.length, 1);
  now += 30_000;
  await worker.runOnce();
  assert.equal(diagnostics.length, 2);
});
