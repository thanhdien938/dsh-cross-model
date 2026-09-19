// P13-R4: backend/provider concurrency limits -- a second, independent
// admission dimension alongside global/workspace capacity. See
// docs/p13/12_P13_R4_BACKEND_CONCURRENCY_LIMITS_OPUS5.md. Tier 1.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmWorker, ADMISSION_REJECTED, resolvePmBackendIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

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

// ---- resolvePmBackendIdentity -----------------------------------------

function fakePmRepo(runs) { return { load: (id) => { const r = runs.get(id); if (!r) throw new Error('no run'); return r; } }; }
function fakeTaskRepo(tasks) { return { getOwnerTask: (id) => tasks.get(id) ?? null }; }

test('resolvePmBackendIdentity resolves a plain product as the backend key', () => {
  const runs = new Map([['pm-a', { id: 'pm-a', request: { context: { ownerCommandId: 'cmd-a' } } }]]);
  const taskId = deterministicOwnerId('task', 'cmd-a');
  const tasks = new Map([[taskId, { pmProfileId: 'live1-claude-pm', context: {} }]]);
  const profileRegistry = { get: (id) => ({ id, product: 'claude-code' }) };
  const identity = resolvePmBackendIdentity({ work: work('a'), pmRepository: fakePmRepo(runs), taskRepository: fakeTaskRepo(tasks), profileRegistry });
  assert.equal(identity.backend_key, 'claude-code');
  assert.equal(identity.profile_id, 'live1-claude-pm');
});

test('resolvePmBackendIdentity keys the generic "api" product by its underlying provider, never a shared "api" pool', () => {
  const runs = new Map([['pm-a', { id: 'pm-a', request: { context: { ownerCommandId: 'cmd-a' } } }]]);
  const taskId = deterministicOwnerId('task', 'cmd-a');
  const tasks = new Map([[taskId, { pmProfileId: 'p11-openrouter', context: {} }]]);
  const profileRegistry = { get: (id) => ({ id, product: 'api', provider: 'openrouter' }) };
  const identity = resolvePmBackendIdentity({ work: work('a'), pmRepository: fakePmRepo(runs), taskRepository: fakeTaskRepo(tasks), profileRegistry });
  assert.equal(identity.backend_key, 'api:openrouter');
});

test('resolvePmBackendIdentity resolves a COUNCIL task via council.chair_profile_id, never a participant profile', () => {
  const runs = new Map([['pm-a', { id: 'pm-a', request: { context: { ownerCommandId: 'cmd-a' } } }]]);
  const taskId = deterministicOwnerId('task', 'cmd-a');
  const tasks = new Map([[taskId, { pmProfileId: 'should-be-ignored', context: { council: { chair_profile_id: 'live1-claude-chair', participant_profile_ids: ['live1-codex-p1'] } } }]]);
  const profileRegistry = { get: (id) => (id === 'live1-claude-chair' ? { id, product: 'claude-code' } : { id, product: 'codex' }) };
  const identity = resolvePmBackendIdentity({ work: work('a'), pmRepository: fakePmRepo(runs), taskRepository: fakeTaskRepo(tasks), profileRegistry });
  assert.equal(identity.backend_key, 'claude-code');
  assert.equal(identity.profile_id, 'live1-claude-chair');
});

test('resolvePmBackendIdentity refuses cleanly (never throws) when the run/task/profile cannot be resolved', () => {
  assert.equal(resolvePmBackendIdentity({ work: work('a'), pmRepository: { load: () => { throw new Error('x'); } }, taskRepository: fakeTaskRepo(new Map()), profileRegistry: { get: () => { throw new Error('x'); } } }), null);
  const runs = new Map([['pm-a', { id: 'pm-a', request: { context: {} } }]]); // no ownerCommandId
  assert.equal(resolvePmBackendIdentity({ work: work('a'), pmRepository: fakePmRepo(runs), taskRepository: fakeTaskRepo(new Map()), profileRegistry: { get: () => null } }), null);
});

// ---- R4 required scenario --------------------------------------------
// global=2, Claude limit=1: A(Claude,ws-a) active, B(Claude,ws-b) queued
// for BACKEND_CAPACITY, C(Codex,ws-c) starts with no head-of-line
// blocking. After A settles, B becomes eligible.

test('R4 required scenario: a per-backend limit queues a second same-backend task without blocking a different backend, and releases it once the first settles', async () => {
  const a = work('a'); const b = work('b'); const c = work('c');
  const coordination = fakeCoordination({ candidates: [a, b, c] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' } };
  const backends = { a: { backend_key: 'claude-code' }, b: { backend_key: 'claude-code' }, c: { backend_key: 'codex' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2,
    resolveWorkIdentity: (w) => identities[w.work_item_id],
    resolveBackendIdentity: (w) => backends[w.work_item_id],
    backendConcurrencyLimits: { 'claude-code': 1 },
  });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id).sort(), ['a', 'c'], 'A (Claude) and C (Codex) both start -- B never blocks C (no head-of-line blocking across backends)');
  assert.ok(first.rejected.some((r) => r.work_item_id === 'b' && r.reason === ADMISSION_REJECTED.BACKEND_CAPACITY && r.backend_key === 'claude-code'));
  assert.equal(coordination.acquired.includes('b'), false, 'B must never reach acquireClaim while backend capacity is full');

  // A settles -- B becomes eligible on the next tick.
  handler.gates.get('a')();
  await first.started.find((s) => s.work_item_id === 'a').promise;
  coordination.completeWork('a');
  const second = await worker.runOnce();
  assert.deepEqual(second.started.map((s) => s.work_item_id), ['b']);
  handler.gates.get('b')(); handler.gates.get('c')();
});

test('backward compatible: with no resolveBackendIdentity/backendConcurrencyLimits configured, backend capacity is never enforced', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2, resolveWorkIdentity: (w) => identities[w.work_item_id] });
  const result = await worker.runOnce();
  assert.deepEqual(result.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  handler.gates.get('a')(); handler.gates.get('b')();
});

test('a configured limit for a backend that never actually appears is a harmless no-op', async () => {
  const coordination = fakeCoordination({ candidates: [work('a')] });
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({
    coordinationStore: coordination, handler, workerIncarnationId: 'w1', globalLimit: 2,
    resolveWorkIdentity: (w) => ({ workspace_id: `ws-${w.work_item_id}` }),
    resolveBackendIdentity: () => ({ backend_key: 'grok' }),
    backendConcurrencyLimits: { 'claude-code': 1 },
  });
  const result = await worker.runOnce();
  assert.deepEqual(result.started.map((s) => s.work_item_id), ['a']);
  handler.gates.get('a')();
});

// ---- restart safety, mirroring R3's workspace fix ----------------------

test('backend capacity survives a fast restart: a fresh worker instance still respects a still-unexpired claim held by a PRIOR incarnation', async () => {
  const a = work('a'); const b = work('b');
  const coordination = fakeCoordination({ candidates: [a, b] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' } };
  const backends = { a: { backend_key: 'claude-code' }, b: { backend_key: 'claude-code' } };
  const handler1 = holdOpenHandler();
  const worker1 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler1, workerIncarnationId: 'worker-1', globalLimit: 2, resolveWorkIdentity: (w) => identities[w.work_item_id], resolveBackendIdentity: (w) => backends[w.work_item_id], backendConcurrencyLimits: { 'claude-code': 1 } });
  const tick1 = await worker1.runOnce();
  assert.deepEqual(tick1.started.map((s) => s.work_item_id), ['a']);
  // "process 1" abandoned -- worker2 is a completely fresh instance with
  // an empty activeByBackend, sharing only the durable coordination
  // backend.
  const handler2 = holdOpenHandler();
  const worker2 = new ProductionPmWorker({ coordinationStore: coordination, handler: handler2, workerIncarnationId: 'worker-2', globalLimit: 2, resolveWorkIdentity: (w) => identities[w.work_item_id], resolveBackendIdentity: (w) => backends[w.work_item_id], backendConcurrencyLimits: { 'claude-code': 1 } });
  const tick2 = await worker2.runOnce();
  assert.equal(tick2.status, 'IDLE', 'B must not be admitted -- A\'s still-unexpired claim already occupies the claude-code backend pool, even though worker2 never itself admitted A');
  assert.ok(tick2.rejected.some((r) => r.work_item_id === 'b' && r.reason === ADMISSION_REJECTED.BACKEND_CAPACITY));
  // Cleanup: release A and let worker1's own renewal timer stop, so this
  // test does not leave a dangling setTimeout chain alive after it ends.
  handler1.gates.get('a')();
  await tick1.started[0].promise;
  await worker1.drainActive({ gracePeriodMs: 10, timeoutMs: 10 });
});
