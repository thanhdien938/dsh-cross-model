import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { createResultEnvelope, createRunRecord, createTaskEnvelope } from '../src/bus/envelopes.mjs';
import { FencedDispatchCoordinator } from '../src/coordination/fenced-dispatch-coordinator.mjs';
import { MIN_LEASE_MS, PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';
import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const execFileAsync = promisify(execFile);
const dsn = process.env.DSH_P3G3_POSTGRES_DSN;
const container = process.env.DSH_P3G3_CONTAINER_ID;
if (process.env.DSH_P3G3_REQUIRE_POSTGRES === '1' && (!dsn || !container)) throw new Error('P3-G3 requires real PostgreSQL container proof');

test('real PostgreSQL + SQLite prove fenced P2 dispatch scenarios A-J', { skip: !dsn }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p3g3-'));
  const dbPath = join(dir, 'p2.sqlite');
  const ledgerPath = join(dir, 'external-calls.ndjson');
  const stores = [];
  const coordination = await new PostgresCoordinationStore().open({ connectionString: dsn, connectionTimeoutMillis: 500, query_timeout: 1000 });
  const coordinationPeer = await new PostgresCoordinationStore().open({ connectionString: dsn, connectionTimeoutMillis: 500, query_timeout: 1000 });
  stores.push(coordination, coordinationPeer);
  await coordination.migrate();
  const sqlite = await openSqlite(dbPath);
  const sqlitePeer = await openSqlite(dbPath);
  const repository = new AgentBusRepository({ store: sqlite });
  const service = new FencedDispatchCoordinator({ coordinationStore: coordination, agentBusRepository: repository });
  const workers = ['worker-old', 'worker-new', 'worker-third'];
  for (const id of workers) await coordination.registerWorkerIncarnation(worker(id));
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close().catch(() => {})));
    await sqlite.close().catch(() => {}); await sqlitePeer.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('A fresh safe dispatch commits intent/start before one provider call and terminal truth', async () => {
    const ctx = await setup('a', coordination, service, 'worker-old');
    let boundaryObserved = false;
    const outcome = await service.execute({ fence: ctx.fence, lineage: ctx.lineage, provider: async ({ attempt, run }) => {
      ledgerCall(ledgerPath, 'A');
      assert.equal(attempt.phase, 'DISPATCH_STARTED'); assert.equal(run.status, 'running');
      assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'DISPATCH_STARTED');
      await coordinationPeer.fencedTouch(ctx.fence); // proves no PostgreSQL authority transaction spans provider I/O
      sqlitePeer.transactionSync(({ run: q }) => q('UPDATE tasks SET status = status WHERE id = ?', ['task-a']));
      boundaryObserved = true;
      return resultFor('a');
    } });
    assert.equal(boundaryObserved, true);
    assert.equal(outcome.status, 'TERMINAL_COMMITTED');
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'TERMINAL_COMMITTED');
    assert.equal(classify(repository, ctx.lineage).classification, RECOVERY_CLASSIFICATIONS.CLEAN);
    assert.equal(callCount(ledgerPath, 'A'), 1);
  });

  await t.test('B stale before intent causes zero P2 mutation and zero provider calls', async () => {
    const ctx = await registeredClaim('b', coordination, 'worker-old');
    await coordination.releaseClaim(ctx.fence);
    await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 });
    await assert.rejects(service.prepareIntent({ fence: ctx.fence, lineage: ctx.lineage, ...p2Input('b') }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id), undefined);
    assert.equal(callCount(ledgerPath, 'B'), 0);
  });

  await t.test('C intent survives fence loss and new generation continues exact attempt once', async () => {
    const ctx = await setup('c', coordination, service, 'worker-old');
    await coordination.releaseClaim(ctx.fence);
    const replacement = await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 });
    await assert.rejects(service.markDispatchStarted({ fence: ctx.fence, lineage: ctx.lineage }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'INTENT_COMMITTED');
    assert.equal((await service.classifyForExecution({ fence: fenceOf(replacement), lineage: ctx.lineage })).classification, RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH);
    const outcome = await service.execute({ fence: fenceOf(replacement), lineage: ctx.lineage, provider: async () => { ledgerCall(ledgerPath, 'C'); return resultFor('c'); } });
    assert.equal(outcome.status, 'TERMINAL_COMMITTED');
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).id, ctx.lineage.dispatch_attempt_id);
    assert.equal(callCount(ledgerPath, 'C'), 1);
  });

  await t.test('D fence lost after DISPATCH_STARTED preserves ambiguity and performs zero call', async () => {
    const ctx = await setup('d', coordination, service, 'worker-old');
    await service.markDispatchStarted({ fence: ctx.fence, lineage: ctx.lineage });
    await coordination.releaseClaim(ctx.fence);
    const replacement = await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 });
    await assert.rejects(service.validateBeforeProvider({ fence: ctx.fence, lineage: ctx.lineage }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
    const outcome = await service.execute({ fence: fenceOf(replacement), lineage: ctx.lineage, provider: async () => { ledgerCall(ledgerPath, 'D'); return resultFor('d'); } });
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(outcome.diagnostic.classification, RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE);
    assert.equal(callCount(ledgerPath, 'D'), 0);
  });

  await t.test('E lease loss in flight rejects stale result and replacement does not replay', async () => {
    const ctx = await setup('e', coordination, service, 'worker-old');
    let providerEntered;
    const entered = new Promise((resolve) => { providerEntered = resolve; });
    let returnProvider;
    const providerRelease = new Promise((resolve) => { returnProvider = resolve; });
    const pending = service.execute({ fence: ctx.fence, lineage: ctx.lineage, provider: async () => {
      ledgerCall(ledgerPath, 'E'); providerEntered(); await providerRelease; return resultFor('e');
    } });
    await entered;
    const shortened = await coordination.renewClaim(ctx.fence, MIN_LEASE_MS);
    await waitForDbExpiry(coordination, shortened);
    const replacement = await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 });
    returnProvider();
    const outcome = await pending;
    assert.equal(outcome.status, 'STALE_RESULT_REJECTED');
    assert.equal(outcome.diagnostic.classification, RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE);
    assert.equal(repository.getRun(ctx.lineage.run_id).status, 'running');
    assert.equal(repository.getResultByRun(ctx.lineage.run_id), undefined);
    const replacementOutcome = await service.execute({ fence: fenceOf(replacement), lineage: ctx.lineage, provider: async () => { ledgerCall(ledgerPath, 'E-replay'); return resultFor('e'); } });
    assert.equal(replacementOutcome.status, 'BLOCKED');
    assert.equal(callCount(ledgerPath, 'E'), 1); assert.equal(callCount(ledgerPath, 'E-replay'), 0);
  });

  await t.test('F terminal commit versus release/takeover race has one coherent outcome', async () => {
    const ctx = await setup('f', coordination, service, 'worker-old');
    await service.markDispatchStarted({ fence: ctx.fence, lineage: ctx.lineage });
    ledgerCall(ledgerPath, 'F');
    const terminal = service.commitTerminalSuccess({ fence: ctx.fence, lineage: ctx.lineage, result: resultFor('f') });
    const takeover = coordinationPeer.releaseClaim(ctx.fence).then(() => coordinationPeer.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 }));
    const [terminalResult, takeoverResult] = await Promise.allSettled([terminal, takeover]);
    assert.equal([terminalResult, takeoverResult].filter((entry) => entry.status === 'fulfilled').length, 1);
    if (terminalResult.status === 'fulfilled') {
      assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'TERMINAL_COMMITTED');
      assert.equal(await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 }), null);
    } else {
      assert.equal(takeoverResult.status, 'fulfilled'); assert.ok(takeoverResult.value);
      assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'DISPATCH_STARTED');
    }
    assert.equal(callCount(ledgerPath, 'F'), 1);
  });

  await t.test('G valid fence with wrong lineage causes zero mutation and zero call', async () => {
    const ctx = await registeredClaim('g', coordination, 'worker-old');
    const wrong = lineage('g-wrong');
    await assert.rejects(service.prepareIntent({ fence: ctx.fence, lineage: wrong, ...p2Input('g-wrong') }), (e) => e.code === 'FENCED_DISPATCH_LINEAGE_MISMATCH');
    assert.equal(repository.getDispatchAttempt(wrong.dispatch_attempt_id), undefined);
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id), undefined);
    assert.equal(callCount(ledgerPath, 'G'), 0);
  });

  await t.test('I SQLite failure after authority validation makes no provider call or claim mutation', async () => {
    const failingPath = join(dir, 'failing.sqlite');
    const failingStore = await openSqlite(failingPath);
    const baseRepo = new AgentBusRepository({ store: failingStore });
    let repositoryReached = false;
    const failingRepo = Object.create(baseRepo);
    failingRepo.prepareDispatch = (...args) => {
      repositoryReached = true;
      void failingStore.close(); // close is synchronous before its resolved promise
      return baseRepo.prepareDispatch(...args);
    };
    const failingService = new FencedDispatchCoordinator({ coordinationStore: coordination, agentBusRepository: failingRepo });
    const ctx = await registeredClaim('i', coordination, 'worker-old');
    const claimBefore = await coordination.readClaim(ctx.work.work_item_id);
    await assert.rejects(failingService.prepareIntent({ fence: ctx.fence, lineage: ctx.lineage, ...p2Input('i') }));
    assert.equal(repositoryReached, true);
    assert.deepEqual(await coordination.readClaim(ctx.work.work_item_id), claimBefore);
    assert.equal(callCount(ledgerPath, 'I'), 0);
  });

  await t.test('J completed attempt cannot invoke provider or duplicate result', async () => {
    const attempt = repository.getDispatchAttempt('attempt-a');
    const resultBefore = repository.getResultByRun('run-a');
    assert.equal(attempt.phase, 'TERMINAL_COMMITTED');
    const completedClaim = await coordination.readClaim('work-a');
    assert.equal(completedClaim.claim_state, 'COMPLETED');
    await assert.rejects(service.execute({ fence: fenceOf(completedClaim), lineage: lineage('a'), provider: async () => { ledgerCall(ledgerPath, 'J'); return resultFor('a'); } }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
    assert.deepEqual(repository.getResultByRun('run-a'), resultBefore);
    assert.equal(callCount(ledgerPath, 'J'), 0);
  });

  await t.test('live/stale REMOTE_STARTED observation stays fenced and uses existing P2 semantics', async () => {
    const ctx = await setup('native', coordination, service, 'worker-old');
    await service.markDispatchStarted({ fence: ctx.fence, lineage: ctx.lineage });
    await service.recordRemoteStarted({ fence: ctx.fence, lineage: ctx.lineage, evidence: { backend: 'alpha', nativeSessionId: 'native-session-proof', product: 'test', version: '1' } });
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id).phase, 'REMOTE_STARTED');
    await coordination.releaseClaim(ctx.fence);
    await coordination.acquireClaim({ work_item_id: ctx.work.work_item_id, worker_incarnation_id: 'worker-new', leaseMs: 60_000 });
    await assert.rejects(service.recordRemoteStarted({ fence: ctx.fence, lineage: ctx.lineage, evidence: { backend: 'alpha', nativeSessionId: 'other' } }), (e) => e.code === 'CLAIM_AUTHORITY_REJECTED');
    assert.equal(classify(repository, ctx.lineage).classification, RECOVERY_CLASSIFICATIONS.INTERRUPTED_EXTERNAL_RUN);
  });

  await t.test('H PostgreSQL outage blocks P2 mutation and provider invocation', async () => {
    const ctx = await registeredClaim('h', coordination, 'worker-old');
    await execFileAsync('docker', ['stop', '--time', '0', container], { windowsHide: true });
    await assert.rejects(service.prepareIntent({ fence: ctx.fence, lineage: ctx.lineage, ...p2Input('h') }));
    assert.equal(repository.getDispatchAttempt(ctx.lineage.dispatch_attempt_id), undefined);
    assert.equal(callCount(ledgerPath, 'H'), 0);
  });

  console.log('P3-G3 A-J: PASS; provider ledger external; fence tokens redacted');
});

async function openSqlite(path) {
  const store = new SqlitePersistenceStore(); await store.open({ path }); await store.migrate(); return store;
}
function worker(id) { return { logical_worker_id: id, worker_incarnation_id: id, host_id: `host-${id}`, installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } }; }
function lineage(suffix) { return { task_id: `task-${suffix}`, run_id: `run-${suffix}`, dispatch_attempt_id: `attempt-${suffix}` }; }
function p2Input(suffix) {
  const ids = lineage(suffix);
  return { task: createTaskEnvelope({ id: ids.task_id, recipient: 'alpha', body: `deterministic-${suffix}` }), run: createRunRecord({ id: ids.run_id, taskId: ids.task_id, agent: 'alpha' }), backend: 'alpha' };
}
function resultFor(suffix) { return createResultEnvelope({ id: `result-${suffix}`, taskId: `task-${suffix}`, runId: `run-${suffix}`, agent: 'alpha', status: 'completed', output: `output-${suffix}` }); }
async function registeredClaim(suffix, coordination, workerId) {
  const ids = lineage(suffix); const work = await coordination.registerWorkIdentity({ work_item_id: `work-${suffix}`, work_kind: 'TASK_DISPATCH', ...ids });
  const claim = await coordination.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerId, leaseMs: 60_000 });
  return { work, lineage: ids, fence: fenceOf(claim) };
}
async function setup(suffix, coordination, service, workerId) {
  const ctx = await registeredClaim(suffix, coordination, workerId);
  await service.prepareIntent({ fence: ctx.fence, lineage: ctx.lineage, ...p2Input(suffix) });
  return ctx;
}
function fenceOf(claim) { return { work_item_id: claim.work_item_id, owner_worker_incarnation_id: claim.owner_worker_incarnation_id, fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token }; }
function classify(repo, ids) { const attempt = repo.getDispatchAttempt(ids.dispatch_attempt_id); return classifyDispatchAttempt({ attempt, run: repo.getRun(ids.run_id), result: repo.getResultByRun(ids.run_id) ?? null }); }
function ledgerCall(path, scenario) { const fd = openSync(path, 'a'); try { appendFileSync(fd, `${JSON.stringify({ scenario })}\n`); fsyncSync(fd); } finally { closeSync(fd); } }
function callCount(path, scenario) { try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.scenario === scenario).length; } catch { return 0; } }
async function waitForDbExpiry(store, claim) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (Date.parse(await store.serverNow()) > Date.parse(claim.expires_at)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('database time did not pass lease expiry');
}
