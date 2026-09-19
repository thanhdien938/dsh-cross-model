// P12-R5C Part C — REQUEST_CANCEL's real production wiring.
//
// Audit finding: scripts/p5-runtime.mjs never supplied
// deps.requestCancellation/deps.resolveWorkItem to createP5ProductionComposition(),
// so OwnerTaskController.requestCancel() has always thrown
// CANCELLATION_UNAVAILABLE unconditionally in the real deployed runtime —
// regardless of task state or channel. Fixed by wiring two small adapters
// onto the EXISTING coordination.requestCancellation(leaderFence, workItemId)
// (PostgresCoordinationStore) and the EXISTING deterministic pmWorkIdentity()
// derivation (production-pm-worker.mjs — the same one startPm already uses
// to register this exact work identity) — no new cancellation engine.
//
// Uses createP5ProductionComposition() with a fully fake (but contract-
// accurate) coordinationStore/ownerRepository, exactly like the existing
// tests/phase5-r2-production-composition.test.mjs pattern — no live
// Postgres required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'p12-r5c-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n    autonomy:\n      revision: 1\n      effects:\n        SUBMIT_TASK: ALLOW\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(join(root, 'config.yaml'), `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\n  project_id: p\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions:\n    - type: finish\n      output: ok\n`);
  return { root, path: join(root, 'config.yaml'), env: { DSH_TEST_PG: 'postgresql://u:random-password@localhost/db', DSH_TEST_TG: 'random-token-value' } };
}

// A fully fake, contract-accurate coordination store: real leadership/
// authority sequencing (so ProductionCoordinatorRuntime's own real logic
// actually runs, unmocked), a capturing requestCancellation, and just
// enough for AwaitOwnerCloser's dependencies to be satisfied.
function fakeCoordination({ onRequestCancellation } = {}) {
  const registeredWork = [];
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { registeredWork.push(value); },
    registerCoordinatorIncarnation: async () => {},
    acquireLeadership: async ({ logical_coordinator_id, coordinator_incarnation_id }) => ({
      logical_coordinator_id, owner_coordinator_incarnation_id: coordinator_incarnation_id, leader_generation: 1, leadership_token: 'fake-token',
    }),
    withLeadershipAuthority: async (_fence, fn) => fn(),
    restoreOwnerDecisionEligibility: async () => null,
    requestCancellation: async (leaderFence, workItemId) => {
      onRequestCancellation?.(leaderFence, workItemId);
      return { state: 'REQUESTED' };
    },
    _registeredWork: registeredWork,
  };
}
const fakeOwnerRepository = () => ({ close: async () => {}, beginCommand: async () => {}, claimNotifications: async () => [], listDecidedAwaitingResumption: async () => [] });

test('P12-R5C: before the coordinator has ticked, REQUEST_CANCEL fails honestly with CANCELLATION_UNAVAILABLE (never a crash, never a silent no-op)', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const backend = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', openCodeBinary: 'opencode' });
  const composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: fakeCoordination(), ownerRepository: fakeOwnerRepository(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  });
  const project = config.projects[0];
  await composition.taskController.submit({
    command: { command_id: 'cmd-r5c-1', accepted_at: '2026-01-01T00:00:00.000Z', payload: { body: 'objective' } },
    project, profile: composition.profileRegistry.get('pm'),
  });
  const taskId = composition.agentBusRepository.listOwnerTasks({ limit: 5 })[0].id;

  await assert.rejects(
    composition.taskController.requestCancel({ taskId }),
    (error) => error.code === 'CANCELLATION_UNAVAILABLE',
  );
  await composition.close();
});

test('P12-R5C: once the coordinator has ticked (a real leadership fence exists), REQUEST_CANCEL reaches the real coordination.requestCancellation() with the exact work identity startPm already registered', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const backend = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', openCodeBinary: 'opencode' });
  const calls = [];
  const coordination = fakeCoordination({ onRequestCancellation: (fence, workItemId) => calls.push({ fence, workItemId }) });
  const composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: fakeOwnerRepository(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  });
  const project = config.projects[0];
  await composition.taskController.submit({
    command: { command_id: 'cmd-r5c-2', accepted_at: '2026-01-01T00:00:00.000Z', payload: { body: 'objective' } },
    project, profile: composition.profileRegistry.get('pm'),
  });
  const taskId = composition.agentBusRepository.listOwnerTasks({ limit: 5 })[0].id;

  // Exactly one real coordinator tick — mirrors what scripts/p5-runtime.mjs's
  // role='all' does continuously; this test drives it once, deterministically.
  const coordinatorRuntime = await composition.buildCoordinator();
  const tick = await coordinatorRuntime.runOnce();
  assert.equal(tick.status, 'LEADER', 'sanity: the fake coordination store must actually grant leadership for this test to prove anything');

  const result = await composition.taskController.requestCancel({ taskId });
  assert.equal(result.status, 'CANCEL_REQUESTED');
  assert.equal(result.cancellation, 'REQUESTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fence.leader_generation, 1);
  // The SAME work_item_id startPm() already registered via
  // coordination.registerWorkIdentity() for this exact task/pmRun.
  assert.equal(calls[0].workItemId, coordination._registeredWork[0].work_item_id);
  await composition.close();
});

test('P12-R5C: an unknown task id fails closed with TASK_NOT_FOUND, never CANCELLATION_UNAVAILABLE or a crash', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const backend = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', openCodeBinary: 'opencode' });
  const composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: fakeCoordination(), ownerRepository: fakeOwnerRepository(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  });
  await assert.rejects(
    composition.taskController.requestCancel({ taskId: 'task-does-not-exist' }),
    (error) => error.code === 'TASK_NOT_FOUND',
  );
  await composition.close();
});
