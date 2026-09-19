// P13-R7.1 (docs/p13/15A_*.md) Part G (cases 5-6) + Part J (combined
// restart + active-cancel interaction). Part G cases 1-4 (owner-cancel
// terminal-outcome precedence itself) live in
// tests/p13-r71-active-cancel-semantics.test.mjs -- this file covers
// slot-level isolation/auto-promotion (still at the ProductionPmWorker
// admission layer, matching p13-r2-queue-fairness-cancel.test.mjs's own
// established style) and the full, real, end-to-end restart-while-
// cancelling scenario through the REAL createP5ProductionComposition()/
// buildWorker() wiring (same zero-real-provider-cost methodology R2/R4/R5
// already established).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProductionPmWorker, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

function work(id, extra = {}) { return { work_item_id: id, work_kind: 'PM_ACTION', pm_run_id: `pm-${id}`, action_id: `action-${id}`, ...extra }; }

function fakeCoordination({ candidates = [], cancellations = {} } = {}) {
  const claimed = new Set(); const done = new Set(); const acquired = [];
  const cancellationStates = new Map(Object.entries(cancellations));
  return {
    acquired,
    listPmActionCandidates: async () => candidates.filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { acquired.push(work_item_id); if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fence' }; },
    renewClaim: async () => {},
    completeWork: (id) => { claimed.delete(id); done.add(id); },
    readCancellation: async (workItemId) => cancellationStates.get(workItemId) ?? null,
    setCancellation: (workItemId, state) => cancellationStates.set(workItemId, { work_item_id: workItemId, state }),
  };
}
function holdOpenHandler() {
  const gates = new Map(); const reasons = new Map();
  return { gates, reasons, execute: async ({ work: w, signal }) => new Promise((resolve, reject) => { gates.set(w.work_item_id, () => resolve({ status: 'COMPLETED' })); signal?.addEventListener?.('abort', () => { reasons.set(w.work_item_id, signal.reason); reject(Object.assign(new Error('aborted'), { code: 'PM_BACKEND_ABORTED' })); }, { once: true }); }) };
}

// ---- Part G case 5: cancel A while B is active -- B completely unaffected

test('5. owner cancel of active A while B is also active -- B is never signalled, never touched', async () => {
  const coordination = fakeCoordination({ candidates: [work('a'), work('b')] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const first = await worker.runOnce();
  assert.equal(first.started.length, 2);
  coordination.setCancellation('a', 'REQUESTED');
  await worker.runOnce();
  const aResult = await first.started.find((s) => s.work_item_id === 'a').promise;
  assert.equal(aResult.error.code, 'PM_BACKEND_ABORTED');
  assert.equal(handler.reasons.get('a'), 'PM_OWNER_CANCEL_REQUESTED', 'A was aborted with the canonical owner-cancel reason');
  assert.equal(handler.reasons.has('b'), false, 'B was never signalled at all');
  assert.equal(worker.activeCount(), 1, "B's slot is completely untouched");
  handler.gates.get('b')();
  const bResult = await first.started.find((s) => s.work_item_id === 'b').promise;
  assert.equal(bResult.outcome.status, 'COMPLETED');
});

// ---- Part G case 6: cancel frees a slot -- queued C auto-promotes

test('6. owner cancel of active A frees its slot -- a queued C is auto-promoted on the very next tick', async () => {
  const a = work('a'); const b = work('b'); const c = work('c');
  const coordination = fakeCoordination({ candidates: [a, b, c] });
  const identities = { a: { workspace_id: 'ws-a' }, b: { workspace_id: 'ws-b' }, c: { workspace_id: 'ws-c' } };
  const handler = holdOpenHandler();
  const worker = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'w1', resolveWorkIdentity: (w) => identities[w.work_item_id], globalLimit: 2 });
  const first = await worker.runOnce();
  assert.deepEqual(first.started.map((s) => s.work_item_id).sort(), ['a', 'b']);
  assert.ok(first.rejected.some((r) => r.work_item_id === 'c' && r.reason === ADMISSION_REJECTED.GLOBAL_CAPACITY));
  coordination.setCancellation('a', 'REQUESTED');
  await worker.runOnce(); // wakes A's cancellation
  await first.started.find((s) => s.work_item_id === 'a').promise.catch(() => {}); // A settles (rejects) and releases its slot
  const promoted = await worker.runOnce();
  assert.deepEqual(promoted.started.map((s) => s.work_item_id), ['c'], 'C is admitted the moment A\'s cancellation frees capacity -- no restart, no manual intervention');
  handler.gates.get('b')(); handler.gates.get('c')();
});

// ---- Part J: combined restart + active-cancel interaction, through the
// REAL composition (composition.close() IS what a Desktop Restart
// triggers via scripts/p5-runtime.mjs's shutdown path).

function coordinationFixture() {
  const items = new Map(); const claimed = new Set(); const done = new Set();
  const cancellationStates = new Map();
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { items.set(value.work_item_id, value); },
    registerWorkerIncarnation: async () => {},
    listPmActionCandidates: async () => [...items.values()].filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    listActivePmActionWork: async () => [...items.values()].filter((w) => claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' }; },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
    readCancellation: async (workItemId) => cancellationStates.get(workItemId) ?? null,
    setCancellation: (workItemId, state) => cancellationStates.set(workItemId, { work_item_id: workItemId, state }),
  };
}

test('Part J: A active + B active, owner cancels A, a normal Restart-equivalent close() happens near that transition -- no timeout race, no duplicate runtime, A reaches CANCELLED, B drains per normal shutdown, durable state stays recoverable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r71-partj-'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const gates = new Map();
  const invoked = [];
  const profile = { id: 'p13-r71-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'fixture' };
  const makeProject = (id, workspaceId) => ({ id, repo_path: join(root, id), workspace_id: workspaceId, default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } });
  const projectA = makeProject('project-a', 'workspace-A');
  const projectB = makeProject('project-b', 'workspace-B');
  for (const p of [projectA, projectB]) mkdirSync(p.repo_path);
  const coordination = coordinationFixture();
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [projectA, projectB], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: projectA.id, pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  let composition;
  try {
    composition = await createP5ProductionComposition(config, {
      sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: { close: async () => {}, claimNotifications: async () => [] },
      fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
      pmDriverFactories: {
        'claude-code': (_profile, { project }) => ({
          name: 'claude-code',
          decide: async ({ signal }) => new Promise((resolve, reject) => {
            invoked.push(project.id);
            gates.set(project.id, () => resolve({ type: 'finish', output: `done:${project.id}` }));
            signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('backend execution aborted (shutdown/cancellation requested)'), { code: 'PM_BACKEND_ABORTED' })), { once: true });
          }),
        }),
      },
    });
    const submit = async (project, commandId) => composition.taskController.submit({ command: { command_id: commandId, payload: { body: `inspect ${project.id}` }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
    await submit(projectA, 'cmd-a');
    await submit(projectB, 'cmd-b');
    const pmRunIdA = deterministicOwnerId('pmrun', 'cmd-a');
    const pmRunIdB = deterministicOwnerId('pmrun', 'cmd-b');
    const worker = await composition.buildWorker();
    const tick = await worker.runOnce();
    assert.deepEqual(tick.started.map((s) => s.workspace_id).sort(), ['workspace-A', 'workspace-B']);
    for (let i = 0; i < 200 && invoked.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(invoked.sort(), ['project-a', 'project-b']);

    // Owner cancels A -- the canonical work_item_id for A's pm_run is the
    // SAME deterministic identity production-pm-worker.mjs's
    // pmWorkIdentity() derives; recover it from the tick's own started list.
    const aWorkItemId = tick.started.find((s) => s.workspace_id === 'workspace-A').work_item_id;
    coordination.setCancellation(aWorkItemId, 'REQUESTED');
    await worker.runOnce(); // wakes A's cancellation -- fires its abort with the canonical reason

    // A normal Restart is requested NEAR that transition -- exactly what
    // scripts/p5-runtime.mjs's shutdown path calls in production. A's
    // abort is already in flight; this must not race, hang, or duplicate
    // anything, and must confirm real settlement of BOTH slots before
    // closing shared stores (D4's own drain-then-close contract).
    await composition.close({ drainGracePeriodMs: 10, drainTimeoutMs: 5000 });

    // "durable state remains recoverable": reopen the SAME SQLite file
    // fresh (composition.close() already closed the original handle) --
    // exactly the read a genuinely restarted process would perform.
    const reopened = new SqlitePersistenceStore();
    await reopened.open({ path: join(root, 'state.db') });
    try {
      const pmRepository = new PmRepository({ store: reopened });
      // A reached canonical CANCELLED -- never FAILED/PM_BACKEND_ABORTED --
      // even though a restart-equivalent close() raced in immediately
      // after the cancel began settling.
      const aRun = pmRepository.load(pmRunIdA);
      assert.equal(aRun.status, 'cancelled');
      // B was aborted purely by the shutdown drain (no owner cancellation
      // requested for it) -- normal shutdown contract, unchanged.
      const bRun = pmRepository.load(pmRunIdB);
      assert.equal(bRun.status, 'failed');
      assert.equal(bRun.error?.code, 'PM_BACKEND_ABORTED');
    } finally {
      await reopened.close();
    }
    // No duplicate execution: each backend was invoked exactly once.
    assert.deepEqual(invoked.sort(), ['project-a', 'project-b']);
  } finally {
    for (const release of gates.values()) release();
    rmSync(root, { recursive: true, force: true });
  }
});
