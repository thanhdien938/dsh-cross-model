// P13-R3 — Tier 2: real PostgreSQL proof of listActivePmActionWork().
// Dedicated test DSN, never the owner's real production DSH_POSTGRES_DSN.
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
  const work = { work_item_id: `${prefix}-work:${suffix}`, work_kind: 'PM_ACTION', pm_run_id: `${prefix}-pm:${suffix}`, action_id: `${prefix}-action:${suffix}` };
  await store.registerWorkIdentity(work);
  await store.registerWorkerIncarnation({ logical_worker_id: `${prefix}-worker`, worker_incarnation_id: workerId, host_id: 'localhost', installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } });
  return { store, work, workerId };
}

test('real PostgreSQL: listActivePmActionWork returns an item with a real, unexpired ACTIVE claim, and excludes it once completed', { skip: !dsn }, async (t) => {
  const { store, work, workerId } = await setup('r3-active');
  t.after(() => store.close());
  assert.equal((await store.listActivePmActionWork({ limit: 50 })).some((w) => w.work_item_id === work.work_item_id), false, 'not active before any claim');
  const claim = await store.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs: 30000 });
  assert.ok(claim);
  const active = await store.listActivePmActionWork({ limit: 50 });
  assert.ok(active.some((w) => w.work_item_id === work.work_item_id), 'a real ACTIVE, unexpired claim must appear');
  const fence = { work_item_id: claim.work_item_id, owner_worker_incarnation_id: claim.owner_worker_incarnation_id, fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token };
  await store.completeClaim(fence);
  assert.equal((await store.listActivePmActionWork({ limit: 50 })).some((w) => w.work_item_id === work.work_item_id), false, 'a completed claim must disappear from the active list');
});

test('real PostgreSQL: listActivePmActionWork excludes an EXPIRED claim (a real crash+time-elapsed scenario)', { skip: !dsn }, async (t) => {
  const { store, work, workerId } = await setup('r3-expired');
  t.after(() => store.close());
  const claim = await store.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs: 50 });
  assert.ok(claim);
  assert.ok((await store.listActivePmActionWork({ limit: 50 })).some((w) => w.work_item_id === work.work_item_id));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await store.listActivePmActionWork({ limit: 50 })).some((w) => w.work_item_id === work.work_item_id), false, 'an expired claim must not be reported as still active');
  // ...and becomes legitimately reclaimable, exactly today's existing lease semantics.
  const reclaimed = await store.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs: 30000 });
  assert.ok(reclaimed);
});
