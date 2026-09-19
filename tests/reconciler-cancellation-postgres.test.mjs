// REAL PostgreSQL regression for the stuck-task reconciler's cancellation
// CAS repair (`PostgresCoordinationStore#reconcileTerminalCancellation`).
// Exercises the ACTUAL SQL (no fake store): a live regression shipped where
// the UPDATE...FROM SET clause used an unqualified `revision=revision+1`,
// which throws PG 42702 ("column reference revision is ambiguous") because
// both cancellation_requests and work_items expose `revision` in the join
// scope. Runs against the disposable test PostgreSQL like every other
// postgres-gated file; skips when its DSN is not provided.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';

const dsn = process.env.DSH_RECON_CANCELLATION_POSTGRES_DSN;
const required = process.env.DSH_RECON_CANCELLATION_REQUIRE_POSTGRES === '1';
if (required && !dsn) throw new Error('DSH_RECON_CANCELLATION_POSTGRES_DSN is required; real-postgres proof cannot be skipped');

const SCHEMA = 'dsh_coordination';
const fence = Object.freeze({ logical_coordinator_id: 'coord-recon-test', owner_coordinator_incarnation_id: 'coord-recon-test:inc-1', leader_generation: 7, leadership_token: 'F'.repeat(43) });
const token43 = 'E'.repeat(43);

function cancellationRowOf(row) {
  return { work_item_id: row.work_item_id, state: row.state, revision: Number(row.revision), updated_at: row.updated_at };
}

async function seedWorkItem(client, { work_item_id, pm_run_id, action_id, work_revision }) {
  await client.query(`INSERT INTO ${SCHEMA}.worker_incarnations
    (worker_incarnation_id,logical_worker_id,host_id,status,installed_profiles,capacity,record_version)
    VALUES ('worker-recon-test','worker-recon','test-host','ACTIVE','[]','{"max_concurrency":1,"reported_in_use":0}',1)
    ON CONFLICT (worker_incarnation_id) DO NOTHING`);
  // Exactly the live PM_ACTION shape: task_id NULL (the task id is resolved
  // from owner_command.canonical_result by observeCancellationReconciliation,
  // and lives in the audit fixture here).
  await client.query(`INSERT INTO ${SCHEMA}.work_items
    (work_item_id,work_kind,pm_run_id,action_id,record_version,
     claim_state,owner_worker_incarnation_id,fencing_generation,fencing_token,acquired_at,renewed_at,expires_at,revision)
    VALUES ($1,'PM_ACTION',$2,$3,1,
            'COMPLETED','worker-recon-test',2,$4,statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '30 seconds',$5)`,
    [work_item_id, pm_run_id, action_id, token43, work_revision]);
  await client.query(`INSERT INTO ${SCHEMA}.cancellation_requests
    (work_item_id,requested_by_logical_coordinator_id,requested_by_leader_generation,state,requested_at,updated_at)
    VALUES ($1,'coord-recon-test',5,'REQUESTED',statement_timestamp(),statement_timestamp())`, [work_item_id]);
}

function auditFor(idempotencyKey, taskId) {
  return {
    reconciliationId: `11111111-1111-4111-8111-${idempotencyKey.slice(0, 12)}`,
    idempotencyKey, taskId,
    lineage: { taskId, pmRunId: `pmrun-for-${idempotencyKey.slice(0, 8)}`, workItemId: null },
    classification: 'TERMINAL_TASK_STALE_CANCELLATION_REQUEST',
    beforeStates: { task: 'cancelled', workItem: 'COMPLETED', cancellation: 'REQUESTED' },
    beforeRevisions: { task: 4, workItem: 11, cancellation: 1 },
    evidenceTimestamps: { observedAt: '2026-09-07T00:00:00.000Z', verifiedAt: '2026-09-07T00:00:00.000Z' },
    leaderGeneration: 7,
    workerIncarnation: null,
    repairReason: 'RECONCILED_TERMINAL_TASK_CANCELLATION',
  };
}

test('real PostgreSQL: reconcileTerminalCancellation CAS repair settles REQUESTED cancellation exactly once, idempotently, without touching the work item or any task outcome', { skip: !dsn }, async (t) => {
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  const store = await new PostgresCoordinationStore().open({ connectionString: dsn });
  // open() only connects — it never migrates (by design, see its own
  // implementation). Having just dropped the schema above, every table
  // this test relies on (coordinator_incarnations, work_items,
  // cancellation_requests, ...) needs a real migrate() call before use,
  // exactly like every other real-PostgreSQL test file in this suite does.
  await store.migrate();
  t.after(async () => { await store.close(); await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await admin.end(); });

  // Coordinator leadership fixture the runtime fence must match (withLeadershipAuthority).
  await store.registerCoordinatorIncarnation({ logical_coordinator_id: fence.logical_coordinator_id, coordinator_incarnation_id: fence.owner_coordinator_incarnation_id, host_id: 'test-host' });
  await admin.query(`INSERT INTO ${SCHEMA}.coordinator_leadership
    (logical_coordinator_id,owner_coordinator_incarnation_id,leader_generation,leadership_token,acquired_at,renewed_at,expires_at)
    VALUES ($1,$2,$3,$4,statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '60 seconds')`,
    [fence.logical_coordinator_id, fence.owner_coordinator_incarnation_id, fence.leader_generation, fence.leadership_token]);

  // Fixture A: terminal 'cancelled' task + COMPLETED claim + REQUESTED cancellation (the live stale shape).
  await seedWorkItem(admin, { work_item_id: 'pmwork-recon-test-a', pm_run_id: 'pmrun-recon-test-a', action_id: 'pmaction-recon-test-a', work_revision: 11 });
  // Fixture B: same shape, kept pristine for stale-revision fail-closed cases.
  await seedWorkItem(admin, { work_item_id: 'pmwork-recon-test-b', pm_run_id: 'pmrun-recon-test-b', action_id: 'pmaction-recon-test-b', work_revision: 13 });

  const workItemBefore = (await admin.query(`SELECT * FROM ${SCHEMA}.work_items WHERE work_item_id='pmwork-recon-test-a'`)).rows[0];

  // 1. Applied: REQUESTED -> CANCELLED, revision increments exactly once.
  const auditA = auditFor('a'.repeat(64), 'task-recon-test-a');
  const applied = await store.reconcileTerminalCancellation(fence, { expected: { workItemId: 'pmwork-recon-test-a', cancellationRevision: 1, workRevision: 11 }, audit: auditA });
  assert.equal(applied.applied, true);
  assert.equal(applied.idempotent, false);
  const afterA = cancellationRowOf((await admin.query(`SELECT * FROM ${SCHEMA}.cancellation_requests WHERE work_item_id='pmwork-recon-test-a'`)).rows[0]);
  assert.equal(afterA.state, 'CANCELLED');
  assert.equal(afterA.revision, 2, 'revision increments exactly once');
  assert.equal(afterA.updated_at > workItemBefore.renewed_at, true, 'updated_at bumped');

  // 2. Work item remains unchanged (no claim/lease/fencing/task-outcome rewrite).
  const workItemAfter = (await admin.query(`SELECT * FROM ${SCHEMA}.work_items WHERE work_item_id='pmwork-recon-test-a'`)).rows[0];
  for (const column of ['work_kind', 'task_id', 'pm_run_id', 'action_id', 'claim_state', 'owner_worker_incarnation_id', 'fencing_generation', 'fencing_token', 'touch_revision']) {
    assert.deepEqual(workItemAfter[column], workItemBefore[column], `work_items.${column} unchanged`);
  }
  assert.equal(Number(workItemAfter.revision), Number(workItemBefore.revision), 'work_items.revision unchanged');
  assert.equal(workItemAfter.acquired_at.toISOString(), workItemBefore.acquired_at.toISOString());
  assert.equal(workItemAfter.expires_at.toISOString(), workItemBefore.expires_at.toISOString());

  // 3. Audit row inserted exactly once with the bounded shape (no task-outcome fields).
  const auditRowsA = (await admin.query(`SELECT * FROM ${SCHEMA}.reconciliation_audit WHERE idempotency_key=$1`, [auditA.idempotencyKey])).rows;
  assert.equal(auditRowsA.length, 1);
  assert.equal(auditRowsA[0].classification, 'TERMINAL_TASK_STALE_CANCELLATION_REQUEST');
  assert.equal(auditRowsA[0].repair_result, 'APPLIED');
  assert.equal(auditRowsA[0].task_id, 'task-recon-test-a');
  assert.deepEqual(auditRowsA[0].after_states, { cancellation: 'CANCELLED' });
  assert.deepEqual(Object.keys(auditRowsA[0].after_states), ['cancellation'], 'no task outcome rewrite in after_states');
  assert.deepEqual(auditRowsA[0].before_states, { task: 'cancelled', workItem: 'COMPLETED', cancellation: 'REQUESTED' });

  // 4. Rerun is idempotent (no second audit row, no further revision bump).
  const rerun = await store.reconcileTerminalCancellation(fence, { expected: { workItemId: 'pmwork-recon-test-a', cancellationRevision: 1, workRevision: 11 }, audit: auditA });
  assert.equal(rerun.applied, false);
  assert.equal(rerun.idempotent, true);
  assert.equal(rerun.reconciliationId, auditRowsA[0].reconciliation_id);
  assert.equal((await admin.query(`SELECT COUNT(*)::int n FROM ${SCHEMA}.reconciliation_audit WHERE idempotency_key=$1`, [auditA.idempotencyKey])).rows[0].n, 1);
  assert.equal(cancellationRowOf((await admin.query(`SELECT * FROM ${SCHEMA}.cancellation_requests WHERE work_item_id='pmwork-recon-test-a'`)).rows[0]).revision, 2);

  // 5. Stale revision fails closed (both CAS dimensions), no mutation, no audit row.
  const auditB = auditFor('b'.repeat(64), 'task-recon-test-b');
  const staleCancellation = await store.reconcileTerminalCancellation(fence, { expected: { workItemId: 'pmwork-recon-test-b', cancellationRevision: 999, workRevision: 13 }, audit: auditB });
  assert.equal(staleCancellation.applied, false);
  assert.equal(staleCancellation.idempotent, false);
  const staleWork = await store.reconcileTerminalCancellation(fence, { expected: { workItemId: 'pmwork-recon-test-b', cancellationRevision: 1, workRevision: 999 }, audit: { ...auditB, reconciliationId: '22222222-2222-4222-8222-222222222222' } });
  assert.equal(staleWork.applied, false);
  assert.equal(staleWork.idempotent, false);
  const afterB = cancellationRowOf((await admin.query(`SELECT * FROM ${SCHEMA}.cancellation_requests WHERE work_item_id='pmwork-recon-test-b'`)).rows[0]);
  assert.equal(afterB.state, 'REQUESTED');
  assert.equal(afterB.revision, 1);
  assert.equal((await admin.query(`SELECT COUNT(*)::int n FROM ${SCHEMA}.reconciliation_audit WHERE idempotency_key=$1`, [auditB.idempotencyKey])).rows[0].n, 0);

  // 6. No provider execution / no claim side effects anywhere: total work_items,
  //    claim states, and fencing generations are exactly as seeded; no ACTIVE claims.
  const workItems = (await admin.query(`SELECT work_item_id,claim_state,fencing_generation,revision FROM ${SCHEMA}.work_items ORDER BY work_item_id`)).rows;
  assert.deepEqual(workItems.map((r) => [r.work_item_id, r.claim_state, Number(r.fencing_generation)]), [
    ['pmwork-recon-test-a', 'COMPLETED', 2],
    ['pmwork-recon-test-b', 'COMPLETED', 2],
  ]);
  assert.equal((await admin.query(`SELECT COUNT(*)::int n FROM ${SCHEMA}.reconciliation_audit`)).rows[0].n, 1);

  // 7. A non-current fence fails closed before any mutation (leadership fencing preserved).
  await assert.rejects(
    store.reconcileTerminalCancellation({ ...fence, leader_generation: 6 }, { expected: { workItemId: 'pmwork-recon-test-b', cancellationRevision: 1, workRevision: 13 }, audit: auditB }),
    (e) => e.code === 'LEADERSHIP_AUTHORITY_REJECTED',
  );
  assert.equal(cancellationRowOf((await admin.query(`SELECT * FROM ${SCHEMA}.cancellation_requests WHERE work_item_id='pmwork-recon-test-b'`)).rows[0]).revision, 1);
  assert.equal((await admin.query(`SELECT COUNT(*)::int n FROM ${SCHEMA}.reconciliation_audit`)).rows[0].n, 1);
});
