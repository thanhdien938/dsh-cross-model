// P13-R2 LIVE ACCEPTANCE (deterministic substitute -- see docs/p13/10_*.md
// "Live acceptance methodology" for why): the master brief's R2 scenario
// (A long, B medium, C short, three workspaces, global limit 2) proved end
// to end through the REAL createP5ProductionComposition()/buildWorker()
// wiring, with a fake in-memory coordination store standing in for
// Postgres (Tier 1 -- runs under plain `npm test`, zero real provider
// cost) -- the same substitution R1's own cross-workspace acceptance test
// used. A dedicated queued-cancel scenario is included per R2.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function coordinationFixture() {
  const work = new Map(); const claimed = new Set(); const done = new Set();
  const cancellations = new Map();
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { work.set(value.work_item_id, value); },
    registerWorkerIncarnation: async () => {},
    listPmActionCandidates: async () => [...work.values()].filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' }; },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
    // Minimal REQUEST_CANCEL wiring, mirroring the real coordination
    // store's contract closely enough for this composition-level proof:
    // a leadership fence is not modeled (this fixture's coordinator role
    // is never actually built/ticked in this test), so requestCancel()
    // is exercised directly against the fixture's own cancellation state
    // via readCancellation/cancelUnclaimedWork -- the same two methods
    // ProductionPmWorker's admission loop consults.
    readCancellation: async (workItemId) => cancellations.get(workItemId) ?? null,
    requestCancellationDirect: (workItemId) => { cancellations.set(workItemId, { work_item_id: workItemId, state: 'REQUESTED' }); },
    cancelUnclaimedWork: async (workItemId) => {
      const current = cancellations.get(workItemId);
      if (!current || current.state !== 'REQUESTED' || claimed.has(workItemId) || done.has(workItemId)) return null;
      done.add(workItemId);
      const updated = { ...current, state: 'CANCELLED' };
      cancellations.set(workItemId, updated);
      return updated;
    },
  };
}

async function buildLiveAcceptanceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'p13-r2-live-'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const gates = new Map();
  const invoked = [];
  const profile = { id: 'p13-r2-delay', role_kind: 'PM', session_kind: 'STATELESS', product: 'p13-r2-delay', transport: 'in-process' };
  const makeProject = (id, workspaceId) => ({ id, repo_path: join(root, id), workspace_id: workspaceId, default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } });
  const projectA = makeProject('project-a', 'workspace-A');
  const projectB = makeProject('project-b', 'workspace-B');
  const projectC = makeProject('project-c', 'workspace-C');
  for (const p of [projectA, projectB, projectC]) mkdirSync(p.repo_path);
  const coordination = coordinationFixture();
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [projectA, projectB, projectC], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: projectA.id, pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const composition = await createP5ProductionComposition(config, {
    sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: { close: async () => {}, claimNotifications: async () => [] },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
    pmDriverFactories: {
      'p13-r2-delay': (_profile, { project }) => ({
        name: 'p13-r2-delay',
        decide: async () => {
          invoked.push(project.repo_path);
          if (project.id === 'project-c') return { type: 'finish', output: 'short:done' }; // C never gates -- finishes immediately once admitted
          await new Promise((resolve) => gates.set(project.id, resolve));
          return { type: 'finish', output: `done:${project.id}` };
        },
      }),
    },
  });
  const submit = async (project, commandId) => composition.taskController.submit({ command: { command_id: commandId, payload: { body: `inspect ${project.id}` }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
  return { root, composition, coordination, gates, invoked, projectA, projectB, projectC, submit };
}

test('R2 live acceptance: A+B active (2/2), C queued behind global capacity, one settles, C is admitted automatically on the next tick', async () => {
  const fx = await buildLiveAcceptanceFixture();
  try {
    await fx.submit(fx.projectA, 'cmd-a');
    await fx.submit(fx.projectB, 'cmd-b');
    await fx.submit(fx.projectC, 'cmd-c');
    const worker = await fx.composition.buildWorker();

    const firstTick = await worker.runOnce();
    assert.equal(firstTick.status, 'WORK');
    assert.equal(firstTick.started.length, 2, 'global capacity (2) admits exactly A and B, never C, in this tick');
    assert.deepEqual(firstTick.started.map((s) => s.workspace_id).sort(), ['workspace-A', 'workspace-B']);
    assert.ok(firstTick.rejected.some((r) => r.reason === 'GLOBAL_CAPACITY'), 'C must be refused specifically for GLOBAL_CAPACITY, not silently dropped');

    for (let i = 0; i < 200 && fx.invoked.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(fx.invoked.length, 2, 'both A and B backends actually started');

    // A slot is still full -- another tick must not admit C yet.
    const stillFull = await worker.runOnce();
    assert.equal(stillFull.status, 'AT_CAPACITY');

    // B settles.
    fx.gates.get('project-b')();
    await firstTick.started.find((s) => s.workspace_id === 'workspace-B').promise;

    // C is now admitted automatically -- no owner intervention needed.
    const promoted = await worker.runOnce();
    assert.equal(promoted.status, 'WORK');
    assert.deepEqual(promoted.started.map((s) => s.workspace_id), ['workspace-C']);
    const cResult = await promoted.started[0].promise;
    assert.equal(cResult.outcome.result.status, 'completed');

    // A was never touched by B or C settling -- only 2 runs are terminal
    // so far (B, C); A's own promise still resolves after this point.
    assert.equal(fx.composition.pmRepository.listTerminalRuns({ limit: 50 }).length, 2);
    fx.gates.get('project-a')();
    await firstTick.started.find((s) => s.workspace_id === 'workspace-A').promise;
    assert.equal(fx.composition.pmRepository.listTerminalRuns({ limit: 50 }).length, 3);
  } finally {
    // Release every gate unconditionally FIRST -- if an assertion above
    // threw before a gate was released, composition.close()'s drain would
    // otherwise wait out the full (multi-minute) abort ceiling for a
    // handler that never listens for the abort signal in the first place,
    // turning a fast test failure into an apparent hang.
    for (const release of fx.gates.values()) release();
    await fx.composition.close({ drainGracePeriodMs: 50, drainTimeoutMs: 50 }).catch(() => {});
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('R2.3 live acceptance: a queued (never-claimed) task is cancelled through the canonical path -- no backend starts, capacity updates immediately', async () => {
  const fx = await buildLiveAcceptanceFixture();
  try {
    await fx.submit(fx.projectA, 'cmd-a2');
    await fx.submit(fx.projectB, 'cmd-b2');
    await fx.submit(fx.projectC, 'cmd-c2'); // will be the queued victim
    const worker = await fx.composition.buildWorker();
    const first = await worker.runOnce();
    assert.equal(first.started.length, 2);

    // Find C's registered work_item_id via the fixture's own registration
    // record (mirrors how the real coordination store's requestCancel()
    // path resolves a work item from a task id -- see p5-production-
    // composition.mjs's resolveWorkItem()).
    assert.equal(fx.composition.pmRepository.listTerminalRuns({ limit: 50 }).length, 0);
    const cTask = fx.composition.agentBusRepository.listOwnerTasks({ limit: 10 }).find((t) => t.projectId === 'project-c');
    assert.ok(cTask);
    // Resolve the exact same way OwnerTaskController's own resolveWorkItem
    // closure does (p5-production-composition.mjs) -- deterministic, pure,
    // no coordination round trip needed to find the id.
    const { pmWorkIdentity } = await import('../src/runtime/production-pm-worker.mjs');
    const { deterministicOwnerId } = await import('../src/owner/owner-contracts.mjs');
    const pmRunId = deterministicOwnerId('pmrun', cTask.context.ownerCommandId);
    const identity = pmWorkIdentity({ taskId: cTask.id, pmRunId });

    fx.coordination.requestCancellationDirect(identity.work_item_id);
    const secondTick = await worker.runOnce();
    assert.deepEqual(secondTick.cancelled, [{ work_item_id: identity.work_item_id }]);
    assert.equal(fx.invoked.includes(fx.projectC.repo_path), false, 'C\'s backend must never be invoked');
    assert.equal(fx.composition.pmRepository.load(pmRunId).status, 'cancelled');

    fx.gates.get('project-a')(); fx.gates.get('project-b')();
    await Promise.all(first.started.map((s) => s.promise));
  } finally {
    for (const release of fx.gates.values()) release();
    await fx.composition.close({ drainGracePeriodMs: 50, drainTimeoutMs: 50 }).catch(() => {});
    rmSync(fx.root, { recursive: true, force: true });
  }
});
