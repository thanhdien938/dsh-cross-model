// P13-R2.3 — Tier 2: real PostgreSQL proof of cancelUnclaimedWork().
// Deliberately a DEDICATED test DSN, never the real production
// DSH_POSTGRES_DSN (which the owner's real .runtime/live1/production.yaml
// uses) -- per the R1 architecture plan's own Tier 2 discipline
// (docs/p13/03_*.md §17). Skips honestly when unset, as every other P13
// Tier 2 test does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';

const dsn = process.env.DSH_P13_R2_POSTGRES_DSN;

async function setup(prefix) {
  const store = await new PostgresCoordinationStore().open({ connectionString: dsn });
  await store.migrate();
  const suffix = randomUUID();
  const workerId = `${prefix}-worker:${suffix}`;
  const coordinatorId = `${prefix}-coord:${suffix}`;
  const work = { work_item_id: `${prefix}-work:${suffix}`, work_kind: 'PM_ACTION', pm_run_id: `${prefix}-pm:${suffix}`, action_id: `${prefix}-action:${suffix}` };
  await store.registerWorkIdentity(work);
  await store.registerCoordinatorIncarnation({ logical_coordinator_id: `${prefix}-logical:${suffix}`, coordinator_incarnation_id: coordinatorId, host_id: 'localhost' });
  const leader = await store.acquireLeadership({ logical_coordinator_id: `${prefix}-logical:${suffix}`, coordinator_incarnation_id: coordinatorId, leaseMs: 30000 });
  const leaderFence = { logical_coordinator_id: leader.logical_coordinator_id, owner_coordinator_incarnation_id: leader.owner_coordinator_incarnation_id, leader_generation: leader.leader_generation, leadership_token: leader.leadership_token };
  return { store, work, leaderFence, workerId };
}

test('real PostgreSQL: cancelUnclaimedWork terminalizes a never-claimed item without ever acquiring a claim', { skip: !dsn }, async (t) => {
  const { store, work, leaderFence } = await setup('r2-cancel');
  t.after(() => store.close());
  const requested = await store.requestCancellation(leaderFence, work.work_item_id);
  assert.equal(requested.state, 'REQUESTED');
  const result = await store.cancelUnclaimedWork(work.work_item_id);
  assert.equal(result.state, 'CANCELLED');
  // Still readClaim() === null: no ACTIVE claim was ever created for it --
  // `claim_state` stays `READY` by design (see the method's own docstring
  // for why); `claim_eligible=false` alone is what removes it from
  // discovery, proven next.
  assert.equal(await store.readClaim(work.work_item_id), null);
  // Never appears as a candidate again.
  const candidates = await store.listPmActionCandidates({ limit: 50 });
  assert.equal(candidates.some((c) => c.work_item_id === work.work_item_id), false);
  // A registered worker's acquireClaim attempt (simulating a race with a
  // normal admission tick) must be refused -- claim_eligible=false blocks
  // it even though claim_state is still nominally 'READY'.
  await store.registerWorkerIncarnation({ logical_worker_id: 'r2-cancel-race-worker', worker_incarnation_id: 'r2-cancel-race-worker:1', host_id: 'localhost', installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } });
  const claimAttempt = await store.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: 'r2-cancel-race-worker:1', leaseMs: 5000 });
  assert.equal(claimAttempt, null, 'a cancelled-while-queued item must never become newly claimable');
});

test('real PostgreSQL: cancelUnclaimedWork refuses an item that was already claimed (no cancellation shortcut around a live executor)', { skip: !dsn }, async (t) => {
  const { store, work, leaderFence, workerId } = await setup('r2-cancel-claimed');
  t.after(() => store.close());
  await store.registerWorkerIncarnation({ logical_worker_id: 'r2-cancel-claimed-worker', worker_incarnation_id: workerId, host_id: 'localhost', installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } });
  const claim = await store.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs: 30000 });
  assert.ok(claim);
  await store.requestCancellation(leaderFence, work.work_item_id);
  const result = await store.cancelUnclaimedWork(work.work_item_id);
  assert.equal(result, null, 'an already-claimed item must never be torn down by the unclaimed-cancel path');
  const readBack = await store.readClaim(work.work_item_id);
  assert.equal(readBack.claim_state, 'ACTIVE', 'the real executor\'s claim must remain untouched');
});

test('real PostgreSQL: cancelUnclaimedWork is a safe no-op when no cancellation was ever requested', { skip: !dsn }, async (t) => {
  const { store, work } = await setup('r2-cancel-none');
  t.after(() => store.close());
  const result = await store.cancelUnclaimedWork(work.work_item_id);
  assert.equal(result, null);
  const claim = await store.readClaim(work.work_item_id);
  assert.equal(claim, null); // never claimed, still READY -- unaffected
});
