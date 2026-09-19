import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { PostgresCoordinationStore, MAX_LEASE_MS, MIN_LEASE_MS } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { COORDINATION_MIGRATIONS, COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';

const exec = promisify(execFile);
const dsn = process.env.DSH_P3G2_POSTGRES_DSN;
const container = process.env.DSH_P3G2_CONTAINER_ID;
const required = process.env.DSH_P3G2_REQUIRE_POSTGRES === '1';
if (required && (!dsn || !container)) throw new Error('P3-G2 requires a disposable real PostgreSQL container for outage proof');

const workerInput = (id, logical = `logical-${id}`) => ({
  logical_worker_id: logical, worker_incarnation_id: id, host_id: `host-${id}`,
  installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 },
});
const taskWork = (id) => ({ work_item_id: id, work_kind: 'TASK_DISPATCH', task_id: `task-${id}`, run_id: `run-${id}`, dispatch_attempt_id: `attempt-${id}` });
const fenceOf = (claim) => ({ work_item_id: claim.work_item_id, owner_worker_incarnation_id: claim.owner_worker_incarnation_id, fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token });

async function waitForDbExpiry(store, claim) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (Date.parse(await store.serverNow()) > Date.parse(claim.expires_at)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('database time did not pass lease expiry');
}

test('real PostgreSQL proves atomic claim, DB-time lease, fencing, takeover, and outage semantics', { skip: !dsn }, async (t) => {
  let admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  const stores = [];
  const makeStore = async () => {
    const store = await new PostgresCoordinationStore().open({ connectionString: dsn, connectionTimeoutMillis: 500, query_timeout: 1000 });
    stores.push(store); return store;
  };
  const store = await makeStore();
  t.after(async () => {
    await Promise.all(stores.map((item) => item.close().catch(() => {})));
    await admin.end().catch(() => {});
  });

  // Explicit v1 -> v2 migration proof.
  await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  await admin.query('CREATE SCHEMA dsh_coordination');
  await admin.query(`CREATE TABLE dsh_coordination.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT statement_timestamp())`);
  await admin.query(COORDINATION_MIGRATIONS[0].sql);
  await admin.query('INSERT INTO dsh_coordination.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)', [1, COORDINATION_MIGRATIONS[0].name, COORDINATION_MIGRATIONS[0].checksum]);
  assert.equal(await store.readSchemaVersion(), 1);
  assert.equal(await store.migrate(), COORDINATION_SCHEMA_VERSION);

  // Fresh current schema and concurrent migration proof.
  await admin.query('DROP SCHEMA dsh_coordination CASCADE');
  const migrationPeer = await makeStore();
  assert.deepEqual(await Promise.all([store.migrate(), migrationPeer.migrate()]), [COORDINATION_SCHEMA_VERSION, COORDINATION_SCHEMA_VERSION]);
  assert.equal(await store.migrate(), COORDINATION_SCHEMA_VERSION);
  assert.equal(await store.assertReady(), true);
  assert.equal(await store.readSchemaVersion(), COORDINATION_SCHEMA_VERSION);
  console.log(`PostgreSQL reference server version: ${(await admin.query('SHOW server_version')).rows[0].server_version}`);

  const otherKinds = [
    { work_item_id: 'workflow-work', work_kind: 'WORKFLOW_STEP', workflow_id: 'workflow-1', step_id: 'step-1' },
    { work_item_id: 'peer-work', work_kind: 'PEER_HOP', conversation_id: 'conversation-1', hop_id: 'hop-1' },
    { work_item_id: 'pm-work', work_kind: 'PM_ACTION', pm_run_id: 'pm-run-1', action_id: 'action-1' },
  ];
  for (const identity of otherKinds) {
    const durable = await store.registerWorkIdentity(identity);
    assert.deepEqual(await store.readWorkItem(identity.work_item_id), durable);
    assert.equal(await store.readClaim(identity.work_item_id), null);
  }

  const raceStores = await Promise.all(Array.from({ length: 24 }, () => makeStore()));
  await Promise.all(raceStores.map((item, index) => item.registerWorkerIncarnation(workerInput(`initial-worker-${index}`))));
  const registered = await store.registerWorkIdentity(taskWork('initial-race'));
  assert.deepEqual(await store.registerWorkIdentity(taskWork('initial-race')), registered);
  await assert.rejects(store.registerWorkIdentity({ ...taskWork('initial-race'), run_id: 'conflicting-run' }), (e) => e.code === 'WORK_ITEM_ID_CONFLICT');
  assert.equal(await store.readClaim('initial-race'), null);
  const initialResults = await Promise.all(raceStores.map((item, index) => item.acquireClaim({ work_item_id: 'initial-race', worker_incarnation_id: `initial-worker-${index}`, leaseMs: 10_000 })));
  const initialWinners = initialResults.filter(Boolean);
  assert.equal(initialWinners.length, 1);
  const initial = initialWinners[0];
  assert.equal(initial.fencing_generation, 1);
  assert.match(initial.fencing_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await store.readClaim('initial-race')).claim_state, 'ACTIVE');

  const initialFence = fenceOf(initial);
  const wrongWorker = { ...initialFence, owner_worker_incarnation_id: initial.owner_worker_incarnation_id === 'initial-worker-0' ? 'initial-worker-1' : 'initial-worker-0' };
  const wrongGeneration = { ...initialFence, fencing_generation: initial.fencing_generation + 1 };
  const wrongToken = { ...initialFence, fencing_token: 'A'.repeat(43) };
  const beforeWrong = await store.readClaim('initial-race');
  for (const bad of [wrongWorker, wrongGeneration, wrongToken]) await assert.rejects(store.fencedTouch(bad), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED' && !e.message.includes(initial.fencing_token));
  assert.deepEqual(await store.readClaim('initial-race'), beforeWrong);

  const originalNow = Date.now;
  let renewed;
  try { Date.now = () => Number.MAX_SAFE_INTEGER; renewed = await store.renewClaim(initialFence, 20_000); }
  finally { Date.now = originalNow; }
  assert.equal(renewed.fencing_generation, initial.fencing_generation);
  assert.equal(renewed.fencing_token, initial.fencing_token);
  assert.ok(Date.parse(renewed.renewed_at) >= Date.parse(initial.renewed_at));
  assert.ok(Date.parse(renewed.expires_at) > Date.parse(initial.expires_at));
  await assert.rejects(store.renewClaim(wrongOwner(initialFence), 10_000), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  assert.throws(() => store.renewClaim(initialFence, 0), (e) => e.code === 'INVALID_LEASE_DURATION');
  assert.throws(() => store.acquireClaim({ work_item_id: 'initial-race', worker_incarnation_id: initial.owner_worker_incarnation_id, leaseMs: '1000' }), (e) => e.code === 'INVALID_LEASE_DURATION');

  // Expiry and 12-way takeover race.
  await store.registerWorkIdentity(taskWork('takeover-race'));
  await store.registerWorkerIncarnation(workerInput('old-worker'));
  const old = await store.acquireClaim({ work_item_id: 'takeover-race', worker_incarnation_id: 'old-worker', leaseMs: MIN_LEASE_MS });
  const takeoverStores = raceStores.slice(0, 12);
  await waitForDbExpiry(store, old);
  await assert.rejects(store.renewClaim(fenceOf(old), 1000), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  const takeoverResults = await Promise.all(takeoverStores.map((item, index) => item.acquireClaim({ work_item_id: 'takeover-race', worker_incarnation_id: `initial-worker-${index}`, leaseMs: 10_000 })));
  const takeoverWinners = takeoverResults.filter(Boolean);
  assert.equal(takeoverWinners.length, 1);
  const takeover = takeoverWinners[0];
  assert.equal(takeover.fencing_generation, old.fencing_generation + 1);
  assert.notEqual(takeover.fencing_token, old.fencing_token);
  await assert.rejects(store.fencedTouch(fenceOf(old)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  await assert.rejects(store.releaseClaim(fenceOf(old)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  await assert.rejects(store.completeClaim(fenceOf(old)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  const touched = await store.fencedTouch(fenceOf(takeover));
  assert.equal(touched.touch_revision, takeover.touch_revision + 1);

  // Release creates no authority and next claim advances generation.
  await store.registerWorkIdentity(taskWork('release-work'));
  const releaseFirst = await store.acquireClaim({ work_item_id: 'release-work', worker_incarnation_id: 'initial-worker-0', leaseMs: 10_000 });
  const released = await store.releaseClaim(fenceOf(releaseFirst));
  assert.equal(released.claim_state, 'RELEASED');
  await assert.rejects(store.releaseClaim(fenceOf(releaseFirst)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  const releaseSecond = await store.acquireClaim({ work_item_id: 'release-work', worker_incarnation_id: 'initial-worker-1', leaseMs: 10_000 });
  assert.equal(releaseSecond.fencing_generation, releaseFirst.fencing_generation + 1);
  assert.notEqual(releaseSecond.fencing_token, releaseFirst.fencing_token);
  await assert.rejects(store.fencedTouch(fenceOf(releaseFirst)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');

  // Completed is terminal and cannot be reclaimed.
  await store.registerWorkIdentity(taskWork('complete-work'));
  const completing = await store.acquireClaim({ work_item_id: 'complete-work', worker_incarnation_id: 'initial-worker-2', leaseMs: 10_000 });
  const completed = await store.completeClaim(fenceOf(completing));
  assert.equal(completed.claim_state, 'COMPLETED');
  await assert.rejects(store.completeClaim(fenceOf(completing)), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  assert.equal(await store.acquireClaim({ work_item_id: 'complete-work', worker_incarnation_id: 'initial-worker-3', leaseMs: 10_000 }), null);

  // Same logical worker name grants a new incarnation no inherited authority.
  await store.registerWorkerIncarnation(workerInput('same-inc-old', 'same-logical'));
  await store.registerWorkerIncarnation(workerInput('same-inc-new', 'same-logical'));
  await store.registerWorkIdentity(taskWork('same-logical-work'));
  const sameOld = await store.acquireClaim({ work_item_id: 'same-logical-work', worker_incarnation_id: 'same-inc-old', leaseMs: 10_000 });
  assert.equal(await store.acquireClaim({ work_item_id: 'same-logical-work', worker_incarnation_id: 'same-inc-new', leaseMs: 10_000 }), null);
  await assert.rejects(store.fencedTouch({ ...fenceOf(sameOld), owner_worker_incarnation_id: 'same-inc-new' }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');

  for (const invalidLease of [0, -1, NaN, Infinity, -Infinity, '1000', MAX_LEASE_MS + 1]) {
    assert.throws(() => store.acquireClaim({ work_item_id: 'same-logical-work', worker_incarnation_id: 'same-inc-new', leaseMs: invalidLease }), (e) => e.code === 'INVALID_LEASE_DURATION');
  }
  assert.throws(() => store.acquireClaim({ work_item_id: 'same-logical-work', worker_incarnation_id: 'same-inc-new', leaseMs: 1000, expires_at: 'caller-time' }), (e) => e.code === 'INVALID_CLAIM_REQUEST');

  // Real store outage: all authority mutations fail; restart reveals zero mutation.
  await store.registerWorkIdentity(taskWork('outage-unclaimed'));
  await store.registerWorkIdentity(taskWork('outage-active'));
  const outageClaim = await store.acquireClaim({ work_item_id: 'outage-active', worker_incarnation_id: 'initial-worker-4', leaseMs: 60_000 });
  const outageBefore = await store.readClaim('outage-active');
  await admin.end();
  await exec('docker', ['stop', '--time', '0', container], { windowsHide: true });
  const outageResults = await Promise.allSettled([
    store.acquireClaim({ work_item_id: 'outage-unclaimed', worker_incarnation_id: 'initial-worker-5', leaseMs: 10_000 }),
    store.renewClaim(fenceOf(outageClaim), 10_000), store.fencedTouch(fenceOf(outageClaim)),
  ]);
  assert.deepEqual(outageResults.map((result) => result.status), ['rejected', 'rejected', 'rejected']);
  await exec('docker', ['start', container], { windowsHide: true });
  const restartedPort = (await exec('docker', ['port', container, '5432/tcp'], { windowsHide: true })).stdout.trim().match(/:(\d+)$/)?.[1];
  if (!restartedPort) throw new Error('PostgreSQL restart port was not assigned');
  const restartedUrl = new URL(dsn);
  restartedUrl.port = restartedPort;
  const restartedDsn = restartedUrl.toString();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await exec('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'dsh_gate2'], { windowsHide: true }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  admin = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = new pg.Client({ connectionString: restartedDsn });
    try { await candidate.connect(); admin = candidate; break; }
    catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!admin) throw new Error('PostgreSQL did not accept host connections after restart');
  const verifier = await new PostgresCoordinationStore().open({ connectionString: restartedDsn, connectionTimeoutMillis: 500, query_timeout: 1000 });
  stores.push(verifier);
  assert.equal(await verifier.readClaim('outage-unclaimed'), null);
  assert.deepEqual(await verifier.readClaim('outage-active'), outageBefore);

  const raw = JSON.stringify((await admin.query(`SELECT work_item_id, claim_state, owner_worker_incarnation_id, fencing_generation, length(fencing_token) AS token_length FROM dsh_coordination.work_items ORDER BY work_item_id`)).rows);
  assert.equal(raw.includes(initial.fencing_token), false);
  assert.equal(raw.includes('password'), false);
  console.log('P3-G2 race proof: initial=24 contenders/1 winner; takeover=12 contenders/1 winner; tokens redacted');
});

function wrongOwner(fence) {
  return { ...fence, owner_worker_incarnation_id: fence.owner_worker_incarnation_id === 'initial-worker-0' ? 'initial-worker-1' : 'initial-worker-0' };
}
