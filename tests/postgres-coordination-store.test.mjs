import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { COORDINATION_MIGRATIONS, COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';

const dsn = process.env.DSH_P3G1_POSTGRES_DSN;
const required = process.env.DSH_P3G1_REQUIRE_POSTGRES === '1';
if (required && !dsn) throw new Error('DSH_P3G1_POSTGRES_DSN is required; PostgreSQL proof cannot be skipped');

test('real PostgreSQL proves P3-G1 store, identity, transaction, schema, and security semantics', { skip: !dsn }, async (t) => {
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  const storeA = await new PostgresCoordinationStore().open({ connectionString: dsn });
  const storeB = await new PostgresCoordinationStore().open({ connectionString: dsn });
  t.after(async () => { await Promise.all([storeA.close(), storeB.close()]); await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE'); await admin.end(); });

  assert.equal(await storeA.readSchemaVersion(), 0);
  assert.equal(await storeA.migrate(), COORDINATION_SCHEMA_VERSION);
  assert.equal(await storeA.migrate(), COORDINATION_SCHEMA_VERSION);
  assert.equal(await storeA.assertReady(), true);
  assert.equal(await storeB.readSchemaVersion(), COORDINATION_SCHEMA_VERSION);
  const serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
  assert.equal(serverVersion.length > 0, true);
  console.log(`PostgreSQL reference server version: ${serverVersion}`);

  const profile = [{ backend: 'codex', product: 'cli', version: '1.0', transport: 'stdio', capabilities: { resume_existing: 'PROVED' } }];
  const base = { logical_worker_id: 'worker-alpha', worker_incarnation_id: 'worker-inc-1', host_id: 'host-a', installed_profiles: profile, capacity: { max_concurrency: 2, reported_in_use: 0 } };
  const first = await storeA.registerWorkerIncarnation(base);
  assert.equal(first.worker_incarnation_id, 'worker-inc-1');
  assert.deepEqual(await storeB.readWorkerIncarnation('worker-inc-1'), first);
  assert.deepEqual(await storeA.registerWorkerIncarnation(base), first);
  assert.deepEqual(await storeA.registerWorkerIncarnation({
    worker_incarnation_id: 'worker-inc-1', host_id: 'host-a', logical_worker_id: 'worker-alpha',
    capacity: { reported_in_use: 0, max_concurrency: 2 },
    installed_profiles: [{ capabilities: { resume_existing: 'PROVED' }, transport: 'stdio', version: '1.0', product: 'cli', backend: 'codex' }],
  }), first);
  await storeB.registerWorkerIncarnation({ ...base, worker_incarnation_id: 'worker-inc-2' });
  assert.equal((await storeA.listWorkerIncarnations('worker-alpha')).length, 2);
  await assert.rejects(storeA.registerWorkerIncarnation({ ...base, logical_worker_id: 'other' }), (e) => e.code === 'INCARNATION_ID_CONFLICT');
  await assert.rejects(storeA.registerWorkerIncarnation({ ...base, host_id: 'host-b' }), (e) => e.code === 'INCARNATION_ID_CONFLICT');
  await assert.rejects(storeA.registerWorkerIncarnation({ ...base, worker_incarnation_id: 'secret-inc', installed_profiles: [{ backend: 'codex', api_key: 'P3G1_RAW_SECRET_MARKER' }] }), (e) => e.code === 'INVALID_COORDINATION_INPUT');
  assert.equal(await storeB.readWorkerIncarnation('secret-inc'), null);
  const rejectedProfiles = [
    { backend: 'x', foo: () => {} }, { backend: 'x', foo: undefined },
    { backend: 'x', foo: Symbol('x') }, { backend: 'x', foo: 1n },
    { backend: 'x', foo: new Date() },
    { backend: 'x', capabilities: { resume_existing: { nested: () => {} } } },
    { backend: 'x', foo: NaN }, { backend: 'x', foo: Infinity }, { backend: 'x', foo: -Infinity },
    { backend: 'x', foo: new (class HiddenState {})() },
  ];
  const cyclicProfile = { backend: 'x' };
  cyclicProfile.self = cyclicProfile;
  rejectedProfiles.push(cyclicProfile);
  for (const [index, installed_profiles] of rejectedProfiles.entries()) {
    const worker_incarnation_id = `rejected-inc-${index}`;
    await assert.rejects(storeA.registerWorkerIncarnation({ ...base, worker_incarnation_id, installed_profiles }), (e) => e.code === 'INVALID_COORDINATION_INPUT' && !e.message.includes('P3G1_RAW_SECRET_MARKER'));
    assert.equal(await storeB.readWorkerIncarnation(worker_incarnation_id), null);
  }
  assert.match(first.started_at, /Z$/);
  assert.equal(first.started_at, first.last_heartbeat_at);
  const heartbeat = await storeA.heartbeatWorkerIncarnation('worker-inc-1', { max_concurrency: 2, reported_in_use: 1 });
  assert.equal(heartbeat.capacity.reported_in_use, 1);
  assert.equal(heartbeat.revision, first.revision + 1);
  assert.equal((await storeA.setWorkerLifecycle('worker-inc-1', 'DRAINING')).status, 'DRAINING');
  assert.equal((await storeA.readClaim('missing-work')), null);
  await assert.rejects(admin.query(`INSERT INTO dsh_coordination.worker_incarnations
    (worker_incarnation_id,logical_worker_id,host_id,status,installed_profiles,capacity,record_version)
    VALUES ('worker-inc-1','worker-alpha','host-a','ACTIVE','[]','{"max_concurrency":1,"reported_in_use":0}',1)`), (e) => e.code === '23505');

  const coordinator = await storeA.registerCoordinatorIncarnation({ logical_coordinator_id: 'coordinator-alpha', coordinator_incarnation_id: 'worker-inc-1', host_id: 'host-a' });
  assert.equal(coordinator.coordinator_incarnation_id, 'worker-inc-1');
  assert.equal('leader_generation' in coordinator, false);
  assert.deepEqual(await storeB.readCoordinatorIncarnation('worker-inc-1'), coordinator);
  assert.equal((await storeA.setCoordinatorLifecycle('worker-inc-1', 'DRAINING')).status, 'DRAINING');
  await storeA.registerCoordinatorIncarnation({ logical_coordinator_id: 'coordinator-alpha', coordinator_incarnation_id: 'coord-inc-2', host_id: 'host-a' });
  assert.equal((await storeB.listCoordinatorIncarnations('coordinator-alpha')).length, 2);
  await assert.rejects(storeA.registerCoordinatorIncarnation({ logical_coordinator_id: 'other', coordinator_incarnation_id: 'coord-inc-2', host_id: 'host-a' }), (e) => e.code === 'INCARNATION_ID_CONFLICT');
  await assert.rejects(storeA.registerCoordinatorIncarnation({ logical_coordinator_id: 'coordinator-alpha', coordinator_incarnation_id: 'coord-inc-2', host_id: 'host-b' }), (e) => e.code === 'INCARNATION_ID_CONFLICT');

  await assert.rejects(storeA.transaction(async (tx) => {
    await tx.registerWorkerIncarnation({ ...base, worker_incarnation_id: 'rollback-inc' });
    throw new Error('force rollback');
  }), (e) => e.code === 'COORDINATION_TRANSACTION_FAILED');
  assert.equal(await storeB.readWorkerIncarnation('rollback-inc'), null);

  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  let inserted;
  const staged = new Promise((resolve) => { inserted = resolve; });
  const pending = storeA.transaction(async (tx) => {
    await tx.registerWorkerIncarnation({ ...base, worker_incarnation_id: 'uncommitted-inc' });
    inserted(); await pause;
  });
  await staged;
  assert.equal(await storeB.readWorkerIncarnation('uncommitted-inc'), null);
  release(); await pending;
  assert.equal((await storeB.readWorkerIncarnation('uncommitted-inc')).worker_incarnation_id, 'uncommitted-inc');
  await assert.rejects(storeA.transaction(() => storeA.transaction(() => {})), (e) => e.code === 'NESTED_TRANSACTION_REJECTED');

  const before = Date.now();
  const originalNow = Date.now;
  let serverNow;
  try {
    Date.now = () => 0;
    serverNow = await storeA.serverNow();
  } finally {
    Date.now = originalNow;
  }
  assert.equal(Number.isFinite(Date.parse(serverNow)), true);
  assert.ok(Math.abs(Date.parse(serverNow) - before) < 60_000);
  const txTimes = await storeA.transaction(async (tx) => [await tx.serverNow(), await tx.serverNow()]);
  assert.notEqual(txTimes[0], undefined);

  const raw = await admin.query('SELECT installed_profiles::text AS profiles, capacity::text AS capacity FROM dsh_coordination.worker_incarnations WHERE worker_incarnation_id=$1', ['worker-inc-1']);
  const rawText = JSON.stringify(raw.rows);
  assert.equal(rawText.includes('password'), false);
  assert.equal(rawText.includes('api_key'), false);
  assert.equal(rawText.includes('P3G1_RAW_SECRET_MARKER'), false);
  assert.equal(rawText.includes('DSH_P3G1_POSTGRES_DSN'), false);

  await admin.query('UPDATE dsh_coordination.schema_migrations SET checksum=$1 WHERE version=1', ['0'.repeat(64)]);
  await assert.rejects(storeA.assertReady(), (e) => e.code === 'COORDINATION_SCHEMA_CHECKSUM_MISMATCH');
  await admin.query('UPDATE dsh_coordination.schema_migrations SET checksum=$1 WHERE version=1', [COORDINATION_MIGRATIONS[0].checksum]);
  const futureVersion = COORDINATION_SCHEMA_VERSION + 1;
  await admin.query("INSERT INTO dsh_coordination.schema_migrations(version,name,checksum) VALUES ($1,'future',$2)", [futureVersion, '1'.repeat(64)]);
  await assert.rejects(storeA.migrate(), (e) => e.code === 'UNKNOWN_COORDINATION_SCHEMA');
  assert.equal((await admin.query('SELECT count(*)::integer AS count FROM dsh_coordination.schema_migrations WHERE version=$1', [futureVersion])).rows[0].count, 1);
});

test('connection failure propagates without fallback', async () => {
  const store = new PostgresCoordinationStore();
  await assert.rejects(store.open({ connectionString: 'postgresql://invalid:invalid@127.0.0.1:1/absent', connectionTimeoutMillis: 300 }), (e) => e.code === 'COORDINATION_CONNECTION_FAILED');
  await assert.rejects(store.serverNow(), (e) => e.code === 'COORDINATION_STORE_CLOSED');
});
