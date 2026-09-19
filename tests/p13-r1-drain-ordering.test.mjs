// P13-R1.1 D4/§13 (docs/p13/05_*.md): close() must stop admitting, then
// confirm real settlement of any in-flight PM execution -- first by
// granting a short grace period, then by firing that execution's own
// AbortController and awaiting proof it actually settled -- and only THEN
// close the shared SQLite/Postgres stores. If settlement can never be
// confirmed (an execution that does not consume the abort signal at all),
// close() now refuses to close stores rather than closing them anyway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function coordinationFixture() {
  const work = new Map(); const claimed = new Set(); const done = new Set();
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { work.set(value.work_item_id, value); },
    registerWorkerIncarnation: async () => {},
    listPmActionCandidates: async () => [...work.values()].filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { if (claimed.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' }; },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
  };
}

function spyClose(target) {
  const state = { closed: false };
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop === 'close') return async (...args) => { state.closed = true; return obj.close(...args); };
      const value = Reflect.get(obj, prop);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  return { proxy, state };
}

async function buildDrainFixture({ leaseMs, decide, sqliteSpyTarget }) {
  const root = mkdtempSync(join(tmpdir(), 'p13-r1-drain-'));
  const repoPath = join(root, 'repo'); mkdirSync(repoPath);
  const realSqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const sqliteSpy = spyClose(sqliteSpyTarget ? sqliteSpyTarget(realSqlite) : realSqlite);
  const coordination = coordinationFixture();
  const coordinationSpy = spyClose(coordination);
  const owner = { close: async () => {}, claimNotifications: async () => [] };
  const ownerSpy = spyClose(owner);
  const profile = { id: 'p13-drain', role_kind: 'PM', session_kind: 'STATELESS', product: 'p13-drain', transport: 'in-process' };
  const project = { id: 'project-drain', repo_path: repoPath, workspace_id: 'workspace-drain', default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [project], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: project.id, pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const composition = await createP5ProductionComposition(config, {
    sqliteStore: sqliteSpy.proxy, coordinationStore: coordinationSpy.proxy, ownerRepository: ownerSpy.proxy,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
    pmDriverFactories: { 'p13-drain': () => ({ name: 'p13-drain', decide }) },
  });
  await composition.taskController.submit({ command: { command_id: 'cmd-drain', payload: { body: 'inspect' }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
  return { root, composition, sqliteSpy, ownerSpy, coordinationSpy };
}

test('close() waits for an execution that settles naturally within the grace period before closing stores', async () => {
  let releaseHandler;
  const fixture = await buildDrainFixture({ leaseMs: 5000, decide: async () => { await new Promise((resolve) => { releaseHandler = resolve; }); return { type: 'finish', output: 'done' }; } });
  try {
    const worker = await fixture.composition.buildWorker();
    const started = await worker.runOnce();
    assert.equal(started.status, 'WORK');
    const closePromise = fixture.composition.close();
    // Give close() every opportunity to (incorrectly) race ahead while the
    // handler is still gated open.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fixture.sqliteSpy.state.closed, false, 'SQLite must not close while a PM execution is still active');
    assert.equal(fixture.ownerSpy.state.closed, false, 'the owner store must not close while a PM execution is still active');
    assert.equal(fixture.coordinationSpy.state.closed, false, 'coordination must not close while a PM execution is still active');
    releaseHandler();
    await closePromise;
    assert.equal(fixture.sqliteSpy.state.closed, true);
    assert.equal(fixture.ownerSpy.state.closed, true);
    assert.equal(fixture.coordinationSpy.state.closed, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an execution that respects the shutdown abort signal settles quickly once fired, and stores close only after that real settlement', async () => {
  let sawAbort = false;
  const fixture = await buildDrainFixture({
    leaseMs: 20, // short grace period so the test does not wait long for phase 1 to elapse
    decide: ({ signal } = {}) => new Promise((resolve, reject) => {
      // Mirrors production-pm-backend-registry.mjs's raceWithWatchdog(): a
      // real backend call rejects promptly once the signal aborts, rather
      // than waiting for the underlying process. This proves
      // ProductionPmWorker actually supplies a LIVE, per-slot
      // AbortController down to handler.execute() -- the whole point of
      // this remediation.
      signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { code: 'PM_BACKEND_ABORTED' })); }, { once: true });
    }),
  });
  try {
    const worker = await fixture.composition.buildWorker();
    const started = await worker.runOnce();
    assert.equal(started.status, 'WORK');
    const before = Date.now();
    await fixture.composition.close();
    assert.ok(Date.now() - before < 2000, 'abort must unblock the execution quickly, not require waiting out the drain ceiling');
    assert.equal(sawAbort, true, 'the shutdown signal must actually reach the in-flight execution');
    assert.equal(fixture.sqliteSpy.state.closed, true);
    assert.equal(fixture.ownerSpy.state.closed, true);
    assert.equal(fixture.coordinationSpy.state.closed, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an execution that does NOT consume the shutdown abort signal at all: close() refuses to close stores rather than closing them blindly', async () => {
  const fixture = await buildDrainFixture({
    leaseMs: 20,
    // Deliberately never resolves and never looks at `signal` -- simulates
    // a hung/abort-unaware execution (see docs/p13/05_*.md "Known
    // limitations" for exactly which real production code paths this
    // still describes today).
    decide: () => new Promise(() => {}),
  });
  try {
    const worker = await fixture.composition.buildWorker();
    const started = await worker.runOnce();
    assert.equal(started.status, 'WORK');
    const before = Date.now();
    await assert.rejects(
      () => fixture.composition.close({ drainGracePeriodMs: 20, drainTimeoutMs: 50 }),
      (error) => error.code === 'DRAIN_SETTLEMENT_UNCONFIRMED' && error.remaining === 1,
    );
    assert.ok(Date.now() - before < 2000, 'close() must still respect the (test-shortened) drain bound, never hang indefinitely on its own');
    assert.equal(fixture.sqliteSpy.state.closed, false, 'stores must NOT close while settlement could not be confirmed');
    assert.equal(fixture.ownerSpy.state.closed, false);
    assert.equal(fixture.coordinationSpy.state.closed, false);
  } finally {
    // The whole point of this test is that composition.close() did NOT
    // close the SQLite store -- close it directly now so Windows will
    // release its file handle and the temp directory can be removed.
    await fixture.sqliteSpy.proxy.close().catch(() => {});
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
