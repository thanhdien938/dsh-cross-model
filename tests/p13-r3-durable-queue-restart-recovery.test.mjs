// P13-R3: durable queue + restart/recovery -- see
// docs/p13/11_P13_R3_DURABLE_QUEUE_RESTART_RECOVERY_OPUS5.md.
// Still global=2, workspace=1 (unchanged from R1/R2). Tier 1 (pure/local).
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmWorker, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';

function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }

// A slightly richer fake than the P1/P2 ones: models real lease-expiry
// timing (Date.now()-based, not just a boolean flag) so a "crashed"
// worker's claims can be shown to remain untouchable until their lease
// genuinely elapses, then become legitimately reclaimable -- exactly
// today's real recovery semantics, unmodified by P13.
function leaseAwareCoordination({ candidates, leaseMs = 30000 }) {
  const claims = new Map(); // work_item_id -> { holder, expiresAt }
  const done = new Set();
  const acquireLog = [];
  return {
    acquireLog,
    listPmActionCandidates: async () => candidates.filter((w) => !done.has(w.work_item_id) && !(claims.has(w.work_item_id) && claims.get(w.work_item_id).expiresAt > Date.now())),
    // P13-R3: the complement -- every candidate with a real, unexpired
    // ACTIVE claim, regardless of which worker incarnation holds it.
    listActivePmActionWork: async () => candidates.filter((w) => claims.has(w.work_item_id) && claims.get(w.work_item_id).expiresAt > Date.now() && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id, leaseMs: requestedLeaseMs }) => {
      acquireLog.push({ work_item_id, worker_incarnation_id });
      if (done.has(work_item_id)) return null;
      const existing = claims.get(work_item_id);
      if (existing && existing.expiresAt > Date.now()) return null; // still leased to a live holder
      const generation = (existing?.generation ?? 0) + 1;
      claims.set(work_item_id, { holder: worker_incarnation_id, expiresAt: Date.now() + (requestedLeaseMs ?? leaseMs), generation });
      return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: generation, fencing_token: `fence-${generation}` };
    },
    renewClaim: async (fence) => { const c = claims.get(fence.work_item_id); if (!c || c.holder !== fence.owner_worker_incarnation_id) throw Object.assign(new Error('lost'), { code: 'CLAIM_AUTHORITY_REJECTED' }); c.expiresAt = Date.now() + leaseMs; },
    completeClaim: async (fence) => { const c = claims.get(fence.work_item_id); if (c) done.add(fence.work_item_id); },
    // Simulates the process dying: renewal simply stops (nothing calls
    // renewClaim again), so the claim's own expiresAt -- fixed at its last
    // real renewal -- is the ONLY thing that ever makes it reclaimable.
    _claims: claims, _done: done,
  };
}
function holdOpenHandler() {
  const gates = new Map();
  return { gates, execute: async ({ work: w }) => new Promise((resolve) => gates.set(w.work_item_id, () => resolve({ status: 'COMPLETED' }))) };
}

// ---- R3 required test matrix: A/B active, C/D queued ----------------------

test('A+B active, C queued (global capacity), D queued (workspace conflict with A) -- a normal drain never claims C or D', async () => {
  // D listed before C so that, once a slot frees up, D's OWN workspace-
  // specific rejection reason is observed directly rather than being
  // masked by C re-exhausting global capacity first in iteration order.
  const candidates = [work('a'), work('b'), work('d'), work('c')];
  const coordination = leaseAwareCoordination({ candidates });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' }, d: { workspace_id: 'ws-a' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'worker-1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  // Both C and D are refused GLOBAL_CAPACITY here -- A and B (this SAME
  // process's own slots) already exhaust the global limit before either
  // C's or D's own workspace status is even relevant; the distinct
  // WORKSPACE_CAPACITY reason for D specifically is proven separately
  // (below, once a global slot is actually free) and by
  // tests/p13-r2-queue-fairness-cancel.test.mjs's dedicated fairness
  // tests. No head-of-line blocking either way: BOTH are reached and
  // reported, neither silently dropped.
  assert.ok(first.rejected.some((r) => r.work_item_id === 'c' && r.reason === ADMISSION_REJECTED.GLOBAL_CAPACITY));
  assert.ok(first.rejected.some((r) => r.work_item_id === 'd' && r.reason === ADMISSION_REJECTED.GLOBAL_CAPACITY));

  // Free ONE global slot (B settles) -- NOW D's own workspace conflict
  // with A (still active) becomes the binding, reported reason, while C
  // (workspace-free) is admitted into the newly freed slot.
  handler.gates.get('b')();
  await first.started.find((s) => s.work_item_id === 'b').promise;
  const second = await worker.runOnce();
  assert.deepEqual(second.started.map((s) => s.work_item_id), ['c']);
  assert.ok(second.rejected.some((r) => r.work_item_id === 'd' && r.reason === ADMISSION_REJECTED.WORKSPACE_CAPACITY));

  // Normal drain: stop admitting, confirm D (still genuinely queued) is
  // never claimed merely because shutdown begins.
  worker.requestStop();
  const draining = await worker.runOnce();
  assert.equal(draining.status, 'DRAINING');
  assert.equal(coordination.acquireLog.some((c) => c.work_item_id === 'd'), false, 'a queued item must never be claimed merely because shutdown begins');
  assert.equal(coordination._done.has('d'), false);

  handler.gates.get('a')(); handler.gates.get('c')();
  await worker.drainActive({ gracePeriodMs: 1000, timeoutMs: 1000 });
});

// ---- restart: fresh in-process state, durable state authoritative --------

test('restart: a fresh ProductionPmWorker instance carries NO stale in-process state from a prior (crashed) instance', () => {
  const coordination = leaseAwareCoordination({ candidates: [] });
  const handler = { execute: async () => ({ status: 'COMPLETED' }) };
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'worker-restarted' });
  assert.equal(worker.activeCount(), 0);
  assert.deepEqual(worker.activeSnapshot(), []);
  assert.equal(worker.lastAdmissionSnapshot(), null, 'a freshly constructed worker has never ticked -- no stale admission projection can leak across a restart');
});

test('restart: C and D remain discoverable and are correctly admitted by a BRAND NEW worker instance, with no duplicate execution of A/B', async () => {
  const candidates = [work('a'), work('b'), work('c'), work('d')];
  const coordination = leaseAwareCoordination({ candidates, leaseMs: 30000 });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' }, d: { workspace_id: 'ws-a' } };

  // "Process 1": admits A and B, then the process dies (simulated by
  // simply discarding this worker instance -- its in-process slot table
  // disappears by design; nothing calls completeClaim/releaseClaim for
  // A/B, exactly like a real kill -9).
  const handler1 = holdOpenHandler();
  const worker1 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler1, workerIncarnationId: 'worker-incarnation-1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const tick1 = await worker1.runOnce();
  assert.deepEqual(tick1.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  // Process 1 "dies" here -- realWorker1 is simply abandoned, its gates
  // for a/b are never released, its renewal timers keep firing in the
  // background (a real kill -9 would stop them; this fake coordination
  // does not model that distinction, which is fine -- what matters is
  // that NOTHING calls completeClaim for a/b).
  assert.equal(coordination._done.has('a'), false);
  assert.equal(coordination._done.has('b'), false);

  // A and B's claims remain unexpired immediately after "the crash" --
  // process 2 must not be able to re-claim them yet (this is existing,
  // unmodified lease-fencing behavior, not new P13 logic).
  const handler2 = holdOpenHandler();
  const worker2 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler2, workerIncarnationId: 'worker-incarnation-2', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const tick2 = await worker2.runOnce();
  // A/B are excluded from discovery entirely (listPmActionCandidates()
  // already omits an unexpired ACTIVE item -- unchanged, existing
  // behavior); D is refused via the SEPARATE listActivePmActionWork()-
  // based restart-window reconciliation this gate adds (§P13-R3) --
  // without it, process 2 (whose OWN in-process activeByWorkspace starts
  // empty) would have no way to know ws-a is still occupied by A's
  // still-unexpired-but-abandoned claim, and would incorrectly admit D
  // into the same physical workspace.
  assert.deepEqual(tick2.started.map((s) => s.work_item_id), ['c'], 'only C is now claimable -- A/B are still leased to the dead process');
  assert.equal(coordination.acquireLog.some((c) => c.work_item_id === 'a' && c.worker_incarnation_id === 'worker-incarnation-2'), false, 'A is excluded from discovery entirely -- process 2 specifically never attempts to claim it while unexpired (worker-incarnation-1\'s own earlier, legitimate claim is a separate log entry)');
  assert.ok(tick2.rejected.some((r) => r.work_item_id === 'd' && r.reason === ADMISSION_REJECTED.WORKSPACE_CAPACITY), 'D must be refused for WORKSPACE_CAPACITY even though process 2 never itself admitted A');
  handler2.gates.get('c')();
  await tick2.started[0].promise;

  handler1.gates.get('a')(); handler1.gates.get('b')(); // cleanup only -- process 1's promises are never awaited by anything real
});
