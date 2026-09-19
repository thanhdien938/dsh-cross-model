import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRunRecord, createTaskEnvelope } from '../src/bus/envelopes.mjs';
import { FencedDispatchCoordinator } from '../src/coordination/fenced-dispatch-coordinator.mjs';
import { createWorkerIncarnationId } from '../src/coordination/multi-process-worker.mjs';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const dsn = process.env.DSH_P3G4_POSTGRES_DSN;
const container = process.env.DSH_P3G4_CONTAINER_ID;
const execFileAsync = promisify(execFile);
if (process.env.DSH_P3G4_REQUIRE_POSTGRES === '1' && !dsn) throw new Error('P3-G4 requires real PostgreSQL proof');

test('real multi-process workers preserve G2/G3/P2 truth', { skip: !dsn, timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p3g4-')); const dbPath = join(dir, 'p2.sqlite'); const ledger = join(dir, 'ledger.ndjson');
  const coordination = await new PostgresCoordinationStore().open({ connectionString: dsn }); await coordination.migrate();
  const sqlite = await new SqlitePersistenceStore().open({ path: dbPath }); await sqlite.migrate(); const repo = new AgentBusRepository({ store: sqlite });
  const bootstrapId = createWorkerIncarnationId('bootstrap'); await coordination.registerWorkerIncarnation(workerIdentity('bootstrap', bootstrapId));
  const service = new FencedDispatchCoordinator({ coordinationStore: coordination, agentBusRepository: repo });
  t.after(async () => { await sqlite.close().catch(() => {}); await coordination.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

  await t.test('A/D one item and simultaneous 8-process race has one call and result', async () => {
    await prepare('race', coordination, service, bootstrapId);
    const barrier = join(dir, 'barrier-a'); const children = Array.from({ length: 8 }, (_, i) => spawnWorker(dir, dsn, dbPath, ledger, `race-${i}`, { startBarrier: barrier }));
    marker(barrier); const outputs = await Promise.all(children.map(waitChild));
    assert.equal(calls(ledger, 'work-race'), 1); assert.equal(repo.getResultByRun('run-race')?.id, 'result-work-race');
    assert.equal(outputs.flatMap((x) => x.work).filter((x) => x === 'work-race').length, 1);
  });

  await t.test('B 20 items and 4 processes yield one terminal result/call each', async () => {
    for (let i = 0; i < 20; i += 1) await prepare(`many-${i}`, coordination, service, bootstrapId);
    await Promise.all(Array.from({ length: 4 }, (_, i) => waitChild(spawnWorker(dir, dsn, dbPath, ledger, `many-worker-${i}`, { maxIdlePolls: 40 }))));
    for (let i = 0; i < 20; i += 1) { assert.equal(calls(ledger, `work-many-${i}`), 1); assert.equal(repo.getResultByRun(`run-many-${i}`)?.status, 'completed'); }
  });

  await t.test('C same logical process starts use distinct incarnations and cannot inherit fence', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) { const identityMarker = join(dir, `identity-${i}`); await waitChild(spawnWorker(dir, dsn, dbPath, ledger, 'same-logical', { identityMarker, maxIdlePolls: 1 })); ids.push(readFileSync(identityMarker, 'utf8')); }
    assert.equal(new Set(ids).size, 3);
    const work = await coordination.registerWorkIdentity(lineageInput('identity-fence')); const claim = await coordination.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: ids[0], leaseMs: 30_000 });
    const wrong = { work_item_id: claim.work_item_id, owner_worker_incarnation_id: ids[1], fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token };
    await assert.rejects(coordination.fencedTouch(wrong), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
  });

  await t.test('E idle stop creates no P2 or provider mutation', async () => {
    const before = ledgerRows(ledger).length; const ready = join(dir, 'idle-ready'); const stopFile = join(dir, 'idle-stop');
    const child = spawnWorker(dir, dsn, dbPath, ledger, 'idle', { identityMarker: ready, stopFile, maxIdlePolls: 1_000, pollIntervalMs: 10 });
    await waitFile(ready); marker(stopFile); await waitChild(child);
    assert.equal(ledgerRows(ledger).length, before); assert.equal(repo.getTask('task-idle'), undefined);
  });

  await t.test('F/G dead owner boundaries preserve safe intent versus dispatch ambiguity', async () => {
    await prepare('dead-safe', coordination, service, bootstrapId);
    const claimedMarker = join(dir, 'dead-safe-claimed'); const dead = spawnWorker(dir, dsn, dbPath, ledger, 'dead-owner', { claimedMarker, claimRelease: join(dir, 'never-release'), leaseMs: 100 });
    await waitFile(claimedMarker); const deadExit = waitChildRaw(dead); await forceKill(dead); await deadExit;
    const safeClaim = await coordination.readClaim('work-dead-safe'); await waitExpired(coordination, safeClaim);
    await waitChild(spawnWorker(dir, dsn, dbPath, ledger, 'replacement-safe', { maxIdlePolls: 10 }));
    assert.equal(calls(ledger, 'work-dead-safe'), 1);
    const ambiguous = await prepare('dead-ambiguous', coordination, service, bootstrapId, { release: false, leaseMs: 30_000 });
    await service.markDispatchStarted({ fence: fenceOf(ambiguous.claim), lineage: lineage('dead-ambiguous') }); await coordination.releaseClaim(fenceOf(ambiguous.claim));
    await waitChild(spawnWorker(dir, dsn, dbPath, ledger, 'replacement-ambiguous', { maxIdlePolls: 5 }));
    assert.equal(calls(ledger, 'work-dead-ambiguous'), 0); assert.equal(classification(repo, 'dead-ambiguous'), RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE);
  });

  await t.test('G provider in-flight process death remains ambiguous and is never blindly replayed', async () => {
    await prepare('inflight-death', coordination, service, bootstrapId);
    const entered = join(dir, 'provider-entered'); const dead = spawnWorker(dir, dsn, dbPath, ledger, 'inflight-owner', { providerEntered: entered, providerRelease: join(dir, 'never-provider-release'), leaseMs: 100 });
    await waitFile(entered); const deadExit = waitChildRaw(dead); await forceKill(dead); await deadExit;
    assert.equal(calls(ledger, 'work-inflight-death'), 1); assert.equal(classification(repo, 'inflight-death'), RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE);
    const old = await coordination.readClaim('work-inflight-death'); await waitExpired(coordination, old);
    await waitChild(spawnWorker(dir, dsn, dbPath, ledger, 'inflight-replacement', { maxIdlePolls: 5 }));
    assert.equal(calls(ledger, 'work-inflight-death'), 1); assert.equal(repo.getResultByRun('run-inflight-death'), undefined);
  });

  await t.test('I unavailable SQLite means claim alone produces no provider call', async () => {
    await coordination.registerWorkIdentity(lineageInput('sqlite-down'));
    const missingParent = join(dir, 'not-a-dir'); writeFileSync(missingParent, 'file');
    const child = spawnWorker(dir, dsn, join(missingParent, 'db.sqlite'), ledger, 'sqlite-down', { maxIdlePolls: 1 });
    assert.notEqual((await waitChildRaw(child)).code, 0); assert.equal(calls(ledger, 'work-sqlite-down'), 0);
  });

  assert.equal(await coordination.readSchemaVersion(), 4); assert.equal(await sqlite.readSchemaVersion(), 6);
  await t.test('H PostgreSQL outage grants zero new authority and starts zero provider calls', async () => {
    assert.ok(container); await prepare('postgres-down', coordination, service, bootstrapId);
    await execFileAsync('docker', ['stop', '--time', '0', container], { windowsHide: true });
    const child = spawnWorker(dir, dsn, dbPath, ledger, 'postgres-down', { maxIdlePolls: 1 });
    assert.notEqual((await waitChildRaw(child)).code, 0); assert.equal(calls(ledger, 'work-postgres-down'), 0);
  });
  console.log('P3-G4 REAL MULTI-PROCESS A-I: PASS; no parent authority; tokens redacted');
});

async function prepare(s, coordination, service, workerId, { release = true, leaseMs = 30_000 } = {}) { const work = await coordination.registerWorkIdentity(lineageInput(s)); const claim = await coordination.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs }); await service.prepareIntent({ fence: fenceOf(claim), lineage: lineage(s), task: createTaskEnvelope({ id: `task-${s}`, recipient: 'alpha', body: `task-${s}` }), run: createRunRecord({ id: `run-${s}`, taskId: `task-${s}`, agent: 'alpha' }), backend: 'alpha' }); if (release) await coordination.releaseClaim(fenceOf(claim)); return { work, claim }; }
function lineage(s) { return { task_id: `task-${s}`, run_id: `run-${s}`, dispatch_attempt_id: `attempt-${s}` }; }
function lineageInput(s) { return { work_item_id: `work-${s}`, work_kind: 'TASK_DISPATCH', ...lineage(s) }; }
function fenceOf(c) { return { work_item_id: c.work_item_id, owner_worker_incarnation_id: c.owner_worker_incarnation_id, fencing_generation: c.fencing_generation, fencing_token: c.fencing_token }; }
function workerIdentity(logical, incarnation) { return { logical_worker_id: logical, worker_incarnation_id: incarnation, host_id: 'test-host', installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } }; }
function spawnWorker(dir, postgresDsn, sqlitePath, ledgerPath, logicalWorkerId, extra = {}) { const cfg = join(dir, `cfg-${logicalWorkerId}-${Math.random().toString(16).slice(2)}.json`); writeFileSync(cfg, JSON.stringify({ sqlitePath, ledgerPath, logicalWorkerId, ...extra })); return spawn(process.execPath, ['scripts/fixtures/p3-gate4-worker.mjs', cfg], { cwd: process.cwd(), env: { ...process.env, DSH_P3G4_POSTGRES_DSN: postgresDsn }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
async function waitChild(child) { const r = await waitChildRaw(child); assert.equal(r.code, 0, r.stderr); return r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).find((x) => x.event === 'DONE'); }
function waitChildRaw(child) { return new Promise((resolve) => { let stdout = '', stderr = ''; child.stdout.on('data', (x) => { stdout += x; }); child.stderr.on('data', (x) => { stderr += x; }); child.once('exit', (code) => resolve({ code, stdout, stderr })); }); }
function marker(path) { const fd = openSync(path, 'w'); try { writeFileSync(fd, 'go'); fsyncSync(fd); } finally { closeSync(fd); } }
function ledgerRows(path) { if (!existsSync(path)) return []; return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function calls(path, work) { return ledgerRows(path).filter((x) => x.work_item_id === work).length; }
function classification(repo, s) { return classifyDispatchAttempt({ attempt: repo.getDispatchAttempt(`attempt-${s}`), run: repo.getRun(`run-${s}`), result: repo.getResultByRun(`run-${s}`) ?? null }).classification; }
async function waitExpired(store, claim) { while (Date.parse(await store.serverNow()) <= Date.parse(claim.expires_at)) await new Promise((r) => setTimeout(r, 5)); }
async function waitFile(path) { for (let i = 0; i < 400; i += 1) { if (existsSync(path)) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`marker not observed: ${path}`); }
async function forceKill(child) { if (process.platform === 'win32') await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL'); }
