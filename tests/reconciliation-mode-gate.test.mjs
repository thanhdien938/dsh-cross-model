// DSH_RECONCILIATION_MODE safety gate — dry-run / default-off coverage.
//
// Production auto-reconciliation must be DEFAULT OFF with three explicit
// modes: disabled (default, no scan, no mutation), dry-run (scan/classify
// real durable state, zero durable mutation), enabled (pre-gate 30s
// leader-fenced auto-repair, only via explicit configuration). The mode is
// one bounded setting, validated fail-closed — never inferred from the
// environment by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { SqliteReconciliationRepository } from '../src/reconciliation/sqlite-reconciliation-repository.mjs';
import { StuckTaskReconciler, RECONCILIATION_CLASS } from '../src/reconciliation/stuck-task-reconciler.mjs';
import { resolveReconciliationMode, RECONCILIATION_MODE, DSH_RECONCILIATION_MODE_ENV } from '../src/reconciliation/reconciliation-mode.mjs';

test('reconciliation mode is one bounded setting: exact values only, default disabled, fail closed otherwise', () => {
  assert.equal(DSH_RECONCILIATION_MODE_ENV, 'DSH_RECONCILIATION_MODE');
  assert.equal(resolveReconciliationMode(undefined), RECONCILIATION_MODE.DISABLED);
  assert.equal(resolveReconciliationMode(null), RECONCILIATION_MODE.DISABLED);
  assert.equal(resolveReconciliationMode(''), RECONCILIATION_MODE.DISABLED);
  assert.equal(resolveReconciliationMode('disabled'), 'disabled');
  assert.equal(resolveReconciliationMode('dry-run'), 'dry-run');
  assert.equal(resolveReconciliationMode('enabled'), 'enabled');
  for (const invalid of ['ENABLED', 'Dry-Run', 'on', '1', 'true', 'mutate', 'auto', 'dryrun', ' disabled ']) {
    assert.throws(() => resolveReconciliationMode(invalid), TypeError, `expected fail-closed rejection of ${JSON.stringify(invalid)}`);
  }
});

test('config load: no env => disabled; invalid env value fails closed the whole config load', async (t) => {
  const f = configFixture(t);
  const plain = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(plain.reconciliation.mode, RECONCILIATION_MODE.DISABLED);
  await assert.rejects(() => loadP5ProductionConfig(f.path, { env: { ...f.env, [DSH_RECONCILIATION_MODE_ENV]: 'auto-repair' } }), TypeError);
  await assert.rejects(() => loadP5ProductionConfig(f.path, { env: { ...f.env, [DSH_RECONCILIATION_MODE_ENV]: 'ENABLED' } }), TypeError);
  const dryRun = await loadP5ProductionConfig(f.path, { env: { ...f.env, [DSH_RECONCILIATION_MODE_ENV]: 'dry-run' } });
  assert.equal(dryRun.reconciliation.mode, 'dry-run');
  const enabled = await loadP5ProductionConfig(f.path, { env: { ...f.env, [DSH_RECONCILIATION_MODE_ENV]: 'enabled' } });
  assert.equal(enabled.reconciliation.mode, 'enabled');
});

test('disabled (default, no config): the composition never instantiates the periodic reconciler and a coordinator tick mutates nothing', async (t) => {
  const harness = await compositionHarness(t, {});
  assert.equal(harness.composition.config.reconciliation.mode, 'disabled');
  const runtime = await harness.composition.buildCoordinator();
  assert.equal(runtime.reconciler, null);
  const seeded = await harness.seedStaleDescendants();
  const before = harness.snapshot(seeded);
  const tick = await runtime.runOnce();
  assert.equal(tick.status, 'LEADER');
  assert.deepEqual(harness.snapshot(seeded), before, 'disabled mode: zero durable reconciliation mutation');
  assert.equal(harness.composition.sqlite.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0);
  assert.equal(harness.composition.readiness().reconciliation.mode, 'disabled');
  assert.equal(harness.composition.readiness().reconciliation.periodicReconciler, 'NOT_CONSTRUCTED');
});

test('dry-run: real durable candidates are detected and reported with zero durable mutation', async (t) => {
  const harness = await compositionHarness(t, { mode: 'dry-run' });
  const runtime = await harness.composition.buildCoordinator();
  assert.notEqual(runtime.reconciler, null);
  const seeded = await harness.seedStaleDescendants();
  const before = harness.snapshot(seeded);
  const tick = await runtime.runOnce();
  assert.equal(tick.status, 'LEADER');
  assert.deepEqual(harness.snapshot(seeded), before, 'dry-run: no workflow/step/run/turn/pm settlement');
  assert.equal(harness.composition.sqlite.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0, 'dry-run writes no durable audit row');
  assert.equal(harness.candidates.length, 1, 'dry-run logged exactly one structured candidate');
  const outcome = harness.candidates[0];
  assert.equal(outcome.taskId, seeded.task);
  assert.equal(outcome.classification, RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS);
  assert.equal(outcome.result, 'WOULD_REPAIR');
  assert.equal(outcome.proposedRepair, 'RECONCILED_TERMINAL_PARENT');
  assert.equal(outcome.resourceImpact, 'NONE');
  assert.equal(outcome.wouldMutate, 'YES');
  assert.equal(harness.composition.readiness().reconciliation.mode, 'dry-run');
});

test('dry-run: blocked candidates report why (resource guard preserved) and still mutate nothing', async (t) => {
  const harness = await compositionHarness(t, { mode: 'dry-run', reconciliationResources: { activeClaim: true } });
  await harness.composition.buildCoordinator();
  const seeded = await harness.seedStaleDescendants();
  const before = harness.snapshot(seeded);
  await harness.runtime.runOnce();
  assert.equal(harness.candidates.length, 1);
  assert.equal(harness.candidates[0].classification, RECONCILIATION_CLASS.RECOVERY_REQUIRED);
  assert.equal(harness.candidates[0].result, 'NO_MUTATION');
  assert.equal(harness.candidates[0].wouldMutate, 'NO');
  assert.equal(harness.candidates[0].reason, 'ACTIVE_CLAIM');
  assert.equal(harness.candidates[0].proposedRepair, null);
  assert.deepEqual(harness.snapshot(seeded), before);
  assert.equal(harness.composition.sqlite.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0, 'blocked dry-run candidates write no audit row either');
});

test('enabled (explicit): the pre-gate leader-fenced auto-repair behavior is preserved end to end', async (t) => {
  const harness = await compositionHarness(t, { mode: 'enabled' });
  const runtime = await harness.composition.buildCoordinator();
  assert.notEqual(runtime.reconciler, null);
  const seeded = await harness.seedStaleDescendants();
  await harness.runtime.runOnce();
  assert.equal(harness.composition.sqlite.get('SELECT status FROM workflows WHERE id=?', [seeded.wf]).status, 'failed');
  assert.equal(harness.composition.sqlite.get('SELECT status FROM workflow_steps WHERE id=?', [seeded.step]).status, 'failed');
  assert.equal(harness.composition.sqlite.get('SELECT status FROM runs WHERE id=?', [seeded.runId]).status, 'failed');
  assert.equal(harness.composition.sqlite.get('SELECT phase FROM pm_turns WHERE pm_run_id=?', [seeded.pm]).phase, 'TURN_COMPLETE');
  assert.equal(harness.composition.sqlite.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 1);
  assert.equal(harness.composition.readiness().reconciliation.mode, 'enabled');
  assert.equal(harness.composition.readiness().reconciliation.periodicReconciler, 'CONSTRUCTED');
});

test('reconciler mode is validated fail-closed: disabled reconcilers cannot be constructed', () => {
  const source = { observe: async () => ({}), repair: async () => { throw new Error('must never run'); } };
  const guard = { observe: async () => ({}) };
  const leadership = { assertCurrent: async () => true };
  for (const invalid of [RECONCILIATION_MODE.DISABLED, 'auto', '', 'ENABLED']) {
    assert.throws(() => new StuckTaskReconciler({ source, resourceGuard: guard, leadershipGuard: leadership, mode: invalid }), TypeError);
  }
});

test('dry-run unit level: same fixture, revision re-check runs, repairs and audit projection never happen', async (t) => {
  const f = await sqliteFixture(t);
  const source = new SqliteReconciliationRepository({ store: f.store, clock: () => '2026-09-07T00:00:00.000Z' });
  const fence = Object.freeze({ logical_coordinator_id: 'coord', owner_coordinator_incarnation_id: 'coord:1', leader_generation: 7, leadership_token: 'x'.repeat(43) });
  let leadershipChecks = 0;
  const outcomes = [];
  const reconciler = new StuckTaskReconciler({
    source,
    resourceGuard: { observe: async () => ({ activeClaim: false, unexpiredLease: false, liveProviderProcess: false, workspaceOccupancy: false, activeProviderSlot: false, uncertainWorkerOwnership: false, openOwnerInteraction: null, resourceImpact: 'NONE' }) },
    leadershipGuard: { assertCurrent: async () => { leadershipChecks += 1; } },
    mode: RECONCILIATION_MODE.DRY_RUN,
    onCandidate: (outcome) => outcomes.push(outcome),
    workerIncarnationId: 'worker:fixture',
    clock: () => '2026-09-07T00:00:00.000Z',
  });
  const result = await reconciler.scan({ fence });
  assert.equal(result.scanned, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'WOULD_REPAIR');
  assert.equal(outcomes[0].wouldMutate, 'YES');
  assert.equal(leadershipChecks, 2, 'dry-run keeps leadership fencing: scan-start + would-repair recheck');
  assert.equal(f.store.get('SELECT status FROM workflows WHERE id=?', [f.wf]).status, 'running');
  assert.equal(f.store.get('SELECT status FROM workflow_steps WHERE id=?', [f.step]).status, 'running');
  assert.equal(f.store.get('SELECT status FROM runs WHERE id=?', [f.runId]).status, 'running');
  assert.equal(f.store.get('SELECT phase FROM pm_turns WHERE pm_run_id=?', [f.pm]).phase, 'ACTION_STARTED');
  assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0);
  // The RECOVERY_REQUIRED projection path (a durable audit write when enabled)
  // must also stay log-only in dry-run.
  const blocked = new StuckTaskReconciler({
    source,
    resourceGuard: { observe: async () => ({ activeClaim: true, unexpiredLease: false, liveProviderProcess: false, workspaceOccupancy: false, activeProviderSlot: false, uncertainWorkerOwnership: false, openOwnerInteraction: null, resourceImpact: 'CLAIM_HELD' }) },
    leadershipGuard: { assertCurrent: async () => true },
    mode: RECONCILIATION_MODE.DRY_RUN,
  });
  const second = await blocked.scan({ fence });
  assert.equal(second.scanned, 1);
  assert.equal(second.outcomes[0].classification, RECONCILIATION_CLASS.RECOVERY_REQUIRED);
  assert.equal(second.outcomes[0].wouldMutate, 'NO');
  assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0, 'no projection/audit mutation in dry-run');
  assert.equal(f.store.get('SELECT status FROM workflows WHERE id=?', [f.wf]).status, 'running');
});

test('enabled unit level: explicit enabled mode still performs the existing CAS repair with audit', async (t) => {
  const f = await sqliteFixture(t);
  const source = new SqliteReconciliationRepository({ store: f.store, clock: () => '2026-09-07T00:00:00.000Z' });
  const fence = Object.freeze({ logical_coordinator_id: 'coord', owner_coordinator_incarnation_id: 'coord:1', leader_generation: 7, leadership_token: 'x'.repeat(43) });
  const reconciler = new StuckTaskReconciler({
    source,
    resourceGuard: { observe: async () => ({ activeClaim: false, unexpiredLease: false, liveProviderProcess: false, workspaceOccupancy: false, activeProviderSlot: false, uncertainWorkerOwnership: false, openOwnerInteraction: null, resourceImpact: 'NONE' }) },
    leadershipGuard: { assertCurrent: async () => true },
    mode: RECONCILIATION_MODE.ENABLED,
    workerIncarnationId: 'worker:fixture',
    clock: () => '2026-09-07T00:00:00.000Z',
  });
  const result = await reconciler.scan({ fence });
  assert.equal(result.outcomes[0].result, 'REPAIRED');
  assert.equal(f.store.get('SELECT status FROM workflows WHERE id=?', [f.wf]).status, 'failed');
  assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 1);
});

test('dry-run: a leadership authority loss still fails closed with zero mutation', async (t) => {
  const f = await sqliteFixture(t);
  const source = new SqliteReconciliationRepository({ store: f.store, clock: () => '2026-09-07T00:00:00.000Z' });
  const fence = Object.freeze({ logical_coordinator_id: 'coord', owner_coordinator_incarnation_id: 'coord:1', leader_generation: 7, leadership_token: 'x'.repeat(43) });
  let checks = 0;
  const reconciler = new StuckTaskReconciler({
    source,
    resourceGuard: { observe: async () => ({ activeClaim: false, unexpiredLease: false, liveProviderProcess: false, workspaceOccupancy: false, activeProviderSlot: false, uncertainWorkerOwnership: false, openOwnerInteraction: null, resourceImpact: 'NONE' }) },
    leadershipGuard: { assertCurrent: async () => { checks += 1; if (checks === 2) throw Object.assign(new Error('lost leadership'), { code: 'LEADERSHIP_AUTHORITY_REJECTED' }); } },
    mode: RECONCILIATION_MODE.DRY_RUN,
  });
  await assert.rejects(reconciler.scan({ fence }), /lost leadership/);
  assert.equal(f.store.get('SELECT status FROM workflows WHERE id=?', [f.wf]).status, 'running');
  assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count, 0);
});

function configFixture(t, { cleanup = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recon-mode-'));
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n    autonomy:\n      revision: 1\n      effects:\n        SUBMIT_TASK: ALLOW\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(join(root, 'config.yaml'), `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\n  project_id: p\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions:\n    - type: finish\n      output: ok\n`);
  return { root, path: join(root, 'config.yaml'), env: { DSH_TEST_PG: 'postgresql://u:random-password@localhost/db', DSH_TEST_TG: 'random-token-value' } };
}

// A contract-accurate fake coordination store (p12-r5c pattern) that ALSO
// exposes the reconciliation observation surface, so buildCoordinator()'s
// gating decision is actually exercised (pre-gate, this exact fake would
// have constructed an auto-repairing reconciler unconditionally).
function fakeCoordination({ reconciliationResources = {} } = {}) {
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async () => {},
    registerCoordinatorIncarnation: async () => {},
    acquireLeadership: async ({ logical_coordinator_id, coordinator_incarnation_id }) => ({ logical_coordinator_id, owner_coordinator_incarnation_id: coordinator_incarnation_id, leader_generation: 1, leadership_token: 'fake-token' }),
    withLeadershipAuthority: async (_fence, fn) => fn(),
    restoreOwnerDecisionEligibility: async () => null,
    requestCancellation: async () => ({ state: 'REQUESTED' }),
    observeReconciliationResources: async () => ({ activeClaim: false, unexpiredLease: false, openOwnerInteraction: null, ambiguousProviderCompletion: false, uncertainExternalSideEffect: false, uncertainGitState: false, authorityDisagreement: false, uncertainWorkerOwnership: false, resourceImpact: 'NONE', ...reconciliationResources }),
    listStaleCancellationCandidates: async () => [],
    observeCancellationReconciliation: async () => null,
  };
}

const fakeOwnerRepository = () => ({ close: async () => {}, beginCommand: async () => {}, claimNotifications: async () => [], listDecidedAwaitingResumption: async () => [] });

async function compositionHarness(t, { mode, reconciliationResources } = {}) {
  const f = configFixture(t, { cleanup: false });
  let composition = null;
  t.after(async () => {
    if (composition) await composition.close().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  });
  const env = mode ? { ...f.env, [DSH_RECONCILIATION_MODE_ENV]: mode } : f.env;
  const config = await loadP5ProductionConfig(f.path, { env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const backend = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', openCodeBinary: 'opencode' });
  const candidates = [];
  composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: backend,
    sqliteStore: sqlite,
    coordinationStore: fakeCoordination({ reconciliationResources }),
    ownerRepository: fakeOwnerRepository(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
    onReconciliationCandidate: (outcome) => candidates.push(outcome),
  });
  const runtime = await composition.buildCoordinator();
  return {
    composition, runtime, candidates,
    async seedStaleDescendants() {
      const pm = 'pm-fixture', wf = 'wf-fixture', step = 'wf-fixture-step', task = 'task-fixture', runId = 'run-fixture', turn = 'turn-fixture', req = 'req-fixture', at = '2026-09-01T00:00:00.000Z';
      sqlite.run('INSERT INTO pm_requests(id,objective,context,envelope,created_at) VALUES(?,?,?,?,?)', [req, 'fixture', '{}', JSON.stringify({ id: req, objective: 'fixture', context: {}, createdAt: at }), at]);
      sqlite.run('INSERT INTO pm_runs(id,request_id,driver,status,output,started_at,completed_at,created_at,turn_count,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [pm, req, 'single:pm', 'failed', '', at, at, at, 1, 4]);
      sqlite.run('INSERT INTO pm_turns(id,pm_run_id,turn_index,decision,committed,created_at,phase,action_type,action_id,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [turn, pm, 0, JSON.stringify({ type: 'workflow', spec: { id: wf } }), 1, at, 'ACTION_STARTED', 'workflow', wf, 3]);
      sqlite.run('INSERT INTO workflows(id,spec,status,created_at,state_revision) VALUES(?,?,?,?,?)', [wf, JSON.stringify({ id: wf, sender: 'pm', steps: [] }), 'running', at, 5]);
      sqlite.run('INSERT INTO tasks(id,status,envelope,created_at) VALUES(?,?,?,?)', [task, 'dispatched', JSON.stringify({ id: task, body: 'fixture' }), at]);
      sqlite.run('INSERT INTO runs(id,task_id,status,created_at,state_revision) VALUES(?,?,?,?,?)', [runId, task, 'running', at, 6]);
      sqlite.run('INSERT INTO workflow_steps(id,workflow_id,step_index,status,task_id,run_id,created_at,state_revision) VALUES(?,?,?,?,?,?,?,?)', [step, wf, 0, 'running', task, runId, at, 8]);
      return { pm, wf, step, task, runId };
    },
    snapshot({ pm, wf, step, runId }) {
      return {
        pm: sqlite.get('SELECT status,state_revision FROM pm_runs WHERE id=?', [pm]),
        turn: sqlite.get('SELECT phase,state_revision FROM pm_turns WHERE pm_run_id=?', [pm]),
        workflow: sqlite.get('SELECT status,state_revision FROM workflows WHERE id=?', [wf]),
        step: sqlite.get('SELECT status,state_revision FROM workflow_steps WHERE id=?', [step]),
        run: sqlite.get('SELECT status,state_revision FROM runs WHERE id=?', [runId]),
        audit: sqlite.get('SELECT COUNT(*) count FROM reconciliation_audit').count,
      };
    },
  };
}

async function sqliteFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recon-gate-'));
  const store = new SqlitePersistenceStore();
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  await store.open({ path: join(dir, 'fixture.sqlite') });
  await store.migrate();
  const pm = 'pm-single', wf = 'wf-single', step = `${wf}-step`, task = `${wf}-task`, runId = `${wf}-run`, at = '2026-09-01T00:00:00.000Z';
  store.run('INSERT INTO pm_requests(id,objective,context,envelope,created_at) VALUES(?,?,?,?,?)', [`req-${pm}`, 'fixture', '{}', JSON.stringify({ id: `req-${pm}`, objective: 'fixture', context: {}, createdAt: at }), at]);
  store.run('INSERT INTO pm_runs(id,request_id,driver,status,output,started_at,completed_at,created_at,turn_count,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [pm, `req-${pm}`, 'single:pm', 'failed', '', at, at, at, 1, 4]);
  store.run('INSERT INTO pm_turns(id,pm_run_id,turn_index,decision,committed,created_at,phase,action_type,action_id,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [`turn-${pm}`, pm, 0, JSON.stringify({ type: 'workflow', spec: { id: wf } }), 1, at, 'ACTION_STARTED', 'workflow', wf, 3]);
  store.run('INSERT INTO workflows(id,spec,status,created_at,state_revision) VALUES(?,?,?,?,?)', [wf, JSON.stringify({ id: wf, sender: 'pm', steps: [] }), 'running', at, 5]);
  store.run('INSERT INTO tasks(id,status,envelope,created_at) VALUES(?,?,?,?)', [task, 'dispatched', JSON.stringify({ id: task, body: 'fixture' }), at]);
  store.run('INSERT INTO runs(id,task_id,status,created_at,state_revision) VALUES(?,?,?,?,?)', [runId, task, 'running', at, 6]);
  store.run('INSERT INTO workflow_steps(id,workflow_id,step_index,status,task_id,run_id,created_at,state_revision) VALUES(?,?,?,?,?,?,?,?)', [step, wf, 0, 'running', task, runId, at, 8]);
  return { store, pm, wf, step, task, runId };
}
