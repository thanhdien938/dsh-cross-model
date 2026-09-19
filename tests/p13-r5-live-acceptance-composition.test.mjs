// P13-R5 LIVE ACCEPTANCE (deterministic substitute -- same methodology and
// justification as tests/p13-r2-live-acceptance-composition.test.mjs and
// tests/p13-r4-live-acceptance-composition.test.mjs): the master brief's
// resource-pressure scenario proved through the REAL
// createP5ProductionComposition()/buildWorker() wiring, zero real
// provider cost and zero real RAM/CPU stress -- `deps.resourcePressureGovernor`
// is injected with a deterministic, hand-controlled metrics reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createResourcePressureGovernor } from '../src/runtime/resource-pressure-governor.mjs';

function coordinationFixture() {
  const work = new Map(); const claimed = new Set(); const done = new Set();
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { work.set(value.work_item_id, value); },
    registerWorkerIncarnation: async () => {},
    listPmActionCandidates: async () => [...work.values()].filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    listActivePmActionWork: async () => [...work.values()].filter((w) => claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' }; },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
  };
}

test('R5 live acceptance: an active resource-pressure governor queues NEW admission without disturbing an already-active task, through the REAL composition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r5-live-'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const gates = new Map();
  const invoked = [];
  const profile = { id: 'p13-r5-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'fixture' };
  const makeProject = (id, workspaceId) => ({ id, repo_path: join(root, id), workspace_id: workspaceId, default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } });
  const projectA = makeProject('project-a', 'workspace-A');
  const projectB = makeProject('project-b', 'workspace-B');
  for (const p of [projectA, projectB]) mkdirSync(p.repo_path);
  const coordination = coordinationFixture();
  let fraction = 0.1; // starts well clear of any threshold
  const resourcePressureGovernor = createResourcePressureGovernor({ readMetrics: () => ({ usedFraction: fraction }), highWatermark: 0.9, recoveryWatermark: 0.8 });
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
      resourcePressureGovernor,
      pmDriverFactories: {
        'claude-code': (_profile, { project }) => ({ name: 'claude-code', decide: async () => { invoked.push(project.id); await new Promise((resolve) => gates.set(project.id, resolve)); return { type: 'finish', output: `done:${project.id}` }; } }),
      },
    });
    const submit = async (project, commandId) => composition.taskController.submit({ command: { command_id: commandId, payload: { body: `inspect ${project.id}` }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
    await submit(projectA, 'cmd-a');
    const worker = await composition.buildWorker();
    const tick = await worker.runOnce();
    assert.deepEqual(tick.started.map((s) => s.workspace_id), ['workspace-A'], 'A starts while resource pressure is clear');
    for (let i = 0; i < 200 && invoked.length < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(invoked, ['project-a']);

    // Pressure kicks in -- a NEW task (B) must be refused, but A (already
    // active) is never touched: it is never re-invoked, never aborted, and
    // its own settlement promise from the tick above is untouched by
    // anything below. (The specific RESOURCE_PRESSURE reason is already
    // proven at the ProductionPmWorker unit level --
    // tests/p13-r5-resource-pressure-governor.test.mjs; this tick reports
    // `status:'IDLE'` through CompositeProductionWorker, which -- like
    // every existing pre-R5 IDLE tick -- drops the per-worker `rejected`
    // detail once nothing in the whole composite tick is active, so the
    // behavioral proof here is what actually reached the driver.)
    fraction = 0.95;
    await submit(projectB, 'cmd-b');
    const underPressure = await worker.runOnce();
    assert.equal(underPressure.status, 'IDLE');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(invoked, ['project-a'], 'B must never reach the driver while pressure is active -- A is not re-invoked either');

    // Pressure recovers -- B becomes admissible on a later tick with no
    // separate reset or restart required.
    fraction = 0.5;
    gates.get('project-a')();
    await tick.started[0].promise;
    const recovered = await worker.runOnce();
    assert.deepEqual(recovered.started.map((s) => s.workspace_id), ['workspace-B'], 'B is admitted automatically once resource pressure clears');
    gates.get('project-b')();
    await recovered.started[0].promise;
  } finally {
    for (const release of gates.values()) release();
    await composition?.close({ drainGracePeriodMs: 50, drainTimeoutMs: 50 }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
