// P13-R4 LIVE ACCEPTANCE (deterministic substitute -- same methodology and
// justification as tests/p13-r2-live-acceptance-composition.test.mjs):
// the master brief's R4 scenario proved through the REAL
// createP5ProductionComposition()/buildWorker() wiring, zero real
// provider cost. global=2, Claude limit=1 (a TEST VALUE for this proof
// only, wired via deps.backendConcurrencyLimits -- never a chosen
// product default).
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
    listActivePmActionWork: async () => [...work.values()].filter((w) => claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => { if (claimed.has(work_item_id) || done.has(work_item_id)) return null; claimed.add(work_item_id); return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' }; },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
  };
}

test('R4 live acceptance: a per-backend limit queues a same-backend task without blocking a different backend, through the REAL composition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r4-live-'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const gates = new Map();
  const invoked = [];
  const claudeProfile = { id: 'p13-r4-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'fixture' };
  const claudeProfile2 = { id: 'p13-r4-claude-2', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'fixture' };
  const codexProfile = { id: 'p13-r4-codex', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'fixture' };
  const makeProject = (id, workspaceId, defaultProfileId) => ({ id, repo_path: join(root, id), workspace_id: workspaceId, default_pm_profile_id: defaultProfileId, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } });
  const projectA = makeProject('project-a', 'workspace-A', claudeProfile.id);
  const projectB = makeProject('project-b', 'workspace-B', claudeProfile2.id);
  const projectC = makeProject('project-c', 'workspace-C', codexProfile.id);
  for (const p of [projectA, projectB, projectC]) mkdirSync(p.repo_path);
  const coordination = coordinationFixture();
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [projectA, projectB, projectC], profiles: [claudeProfile, claudeProfile2, codexProfile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: projectA.id, pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  let composition;
  try {
    composition = await createP5ProductionComposition(config, {
      sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: { close: async () => {}, claimNotifications: async () => [] },
      fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
      backendConcurrencyLimits: { 'claude-code': 1 }, // TEST VALUE for this proof only
      pmDriverFactories: {
        'claude-code': (_profile, { project }) => ({ name: 'claude-code', decide: async () => { invoked.push(project.id); await new Promise((resolve) => gates.set(project.id, resolve)); return { type: 'finish', output: `done:${project.id}` }; } }),
        codex: (_profile, { project }) => ({ name: 'codex', decide: async () => { invoked.push(project.id); await new Promise((resolve) => gates.set(project.id, resolve)); return { type: 'finish', output: `done:${project.id}` }; } }),
      },
    });
    const submit = async (project, profile, commandId) => composition.taskController.submit({ command: { command_id: commandId, payload: { body: `inspect ${project.id}` }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
    await submit(projectA, claudeProfile, 'cmd-a');
    await submit(projectB, claudeProfile2, 'cmd-b');
    await submit(projectC, codexProfile, 'cmd-c');
    const worker = await composition.buildWorker();
    const tick = await worker.runOnce();
    assert.deepEqual(tick.started.map((s) => s.workspace_id).sort(), ['workspace-A', 'workspace-C'], 'A (claude-code) and C (codex) both start -- B (also claude-code) never blocks C');
    assert.ok(tick.rejected.some((r) => r.reason === 'BACKEND_CAPACITY'), 'B must be refused specifically for BACKEND_CAPACITY');
    for (let i = 0; i < 200 && invoked.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(invoked.sort(), ['project-a', 'project-c']);

    gates.get('project-a')();
    await tick.started.find((s) => s.workspace_id === 'workspace-A').promise;
    const promoted = await worker.runOnce();
    assert.deepEqual(promoted.started.map((s) => s.workspace_id), ['workspace-B'], 'B is admitted automatically once A (the same backend) settles');
    gates.get('project-b')(); gates.get('project-c')();
    await Promise.all(promoted.started.map((s) => s.promise));
    await tick.started.find((s) => s.workspace_id === 'workspace-C').promise;
  } finally {
    for (const release of gates.values()) release();
    await composition?.close({ drainGracePeriodMs: 50, drainTimeoutMs: 50 }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
