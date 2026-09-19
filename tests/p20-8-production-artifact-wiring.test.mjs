/**
 * P20.8 §6/§7 — production composition activation of the P20 artifact
 * seams, and §7 transport admission at SUBMIT_TASK.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md
 * §6.1, §6.2, §6.3, §7, §12 (#1, #2, #3, #4, #5).
 *
 * Reuses the exact fake coordination/owner-store DI pattern already
 * established by tests/phase5-r2-production-composition.test.mjs — no new
 * test harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

function fakeStores() {
  return {
    coordination: { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} },
    owner: { close: async () => {}, claimNotifications: async () => [] },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  };
}

async function buildComposition(t, { projectIds = ['p1', 'p2'], extraDeps = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p20-8-compose-'));
  // Windows: the SQLite handle can lag well behind close() resolving — the
  // pre-existing phase5-r2-production-composition.test.mjs fixture avoids
  // this entirely by never deleting its temp dir; this file still tries
  // (to avoid leaking dozens of dirs across a full suite run) but treats a
  // stubborn Windows file-lock as non-fatal rather than failing the test.
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* best-effort only — a lingering Windows SQLite handle is not a P20.8 correctness signal */ } });
  for (const id of projectIds) mkdirSync(join(root, id), { recursive: true });
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const projects = projectIds.map((id) => ({ id, repo_path: join(root, id), default_pm_profile_id: 'pm-claude', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }));
  const profiles = [
    { id: 'pm-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' },
  ];
  const backend = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', openCodeBinary: 'opencode', claudeRunner: async () => ({ result: '{"type":"finish","output":"unused"}' }) });
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects, profiles,
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: projectIds[0], pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const { coordination, owner, fetchImpl } = fakeStores();
  const composition = await createP5ProductionComposition(config, { pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl, ...extraDeps });
  t.after(async () => { try { await composition.close(); } catch { /* drain may already be settled */ } });
  return { composition, projects, root };
}

test('#1/#2 — production artifact stores are project-scoped, never bound to project[0]', async (t) => {
  const { composition, projects } = await buildComposition(t, { projectIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], extraDeps: { enableProductionArtifactStores: true } });
  const stores = projects.map((p) => composition.resolveProjectArtifactStore(p.id));
  const roots = stores.map((s) => s.root);
  assert.equal(new Set(roots).size, roots.length, 'every project must resolve a DISTINCT store root');
  for (const [i, p] of projects.entries()) {
    assert.equal(stores[i].projectId, p.id, 'each store must be identity-bound to its own project id');
    assert.ok(stores[i].root.includes(p.id), 'store root path must be namespaced by project id');
  }
});

test('#1 — resolveProjectArtifactStore refuses an unconfigured project rather than silently defaulting', async (t) => {
  const { composition } = await buildComposition(t, { projectIds: ['p1', 'p2'], extraDeps: { enableProductionArtifactStores: true } });
  assert.throws(() => composition.resolveProjectArtifactStore('p-not-configured'), (e) => e.code === 'ARTIFACT_STORE_NOT_CONFIGURED');
});

test('#4 — a NEW task is stamped transport_version=artifact_v1 in durable context BEFORE any execution, when the resolver opts in', async (t) => {
  const { composition, projects } = await buildComposition(t, {
    projectIds: ['p1'],
    extraDeps: { resolveNewTaskTransportVersion: ({ council }) => (council ? null : 'artifact_v1') },
  });
  const project = projects[0];
  const profile = composition.profileRegistry.get('pm-claude');
  await assert.rejects(
    composition.taskController.submit({ command: { command_id: 'cmd-new', payload: { body: 'do the thing' }, accepted_at: '2026-09-11T00:00:00.000Z' }, project, profile }),
    (e) => e.code === 'SINGLE_ARTIFACT_WIRING_DISABLED', // wiring disabled in THIS composition — proves the stamp took effect and was enforced, not silently ignored
  );
  // Recover the deterministic task id the same way OwnerTaskController derives it.
  const { deterministicOwnerId } = await import('../src/owner/owner-contracts.mjs');
  const taskId = deterministicOwnerId('task', 'cmd-new');
  const persisted = composition.agentBusRepository.getOwnerTask(taskId);
  assert.equal(persisted.context.transport_version, 'artifact_v1', 'the durable context must carry the stamp even though execution itself was refused');
});

test('#3 — a task with no resolver (legacy) never gets a transport_version field at all', async (t) => {
  const { composition, projects } = await buildComposition(t, { projectIds: ['p1'] }); // no resolveNewTaskTransportVersion supplied
  const project = projects[0];
  const profile = composition.profileRegistry.get('pm-claude');
  await composition.taskController.submit({ command: { command_id: 'cmd-legacy', payload: { body: 'do the thing' }, accepted_at: '2026-09-11T00:00:00.000Z' }, project, profile });
  const { deterministicOwnerId } = await import('../src/owner/owner-contracts.mjs');
  const taskId = deterministicOwnerId('task', 'cmd-legacy');
  const persisted = composition.agentBusRepository.getOwnerTask(taskId);
  assert.equal(Object.hasOwn(persisted.context, 'transport_version'), false, 'a legacy task must keep the exact pre-P20.8 context shape');
});

test('#5 — Council artifact_v1 with production wiring disabled fails closed (no silent legacy fallback)', async (t) => {
  const { composition, projects } = await buildComposition(t, {
    projectIds: ['p1'],
    extraDeps: { resolveNewTaskTransportVersion: () => 'artifact_v1' }, // wiring stays OFF
  });
  const project = projects[0];
  const profile = composition.profileRegistry.get('pm-claude');
  const council = { chair_profile_id: 'pm-claude', participant_profile_ids: ['pm-claude'], kind: 'COUNCIL', rounds: 1, strategy: 'independent_then_critique_then_synthesis', workspace_requirement: 'NONE' };
  await assert.rejects(
    composition.taskController.submit({ command: { command_id: 'cmd-council', payload: { body: 'council task' }, accepted_at: '2026-09-11T00:00:00.000Z' }, project, profile, council }),
    (e) => e.code === 'COUNCIL_ARTIFACT_DEPS_MISSING',
  );
});
