// P15-B-002 Tier 2: exact partial-failure shape against disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { ProductionPmWorker, ADMISSION_REJECTED } from '../src/runtime/production-pm-worker.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const dsn = process.env.DSH_P13_R2_POSTGRES_DSN;

function identity(prefix, kind) {
  return { work_item_id: `${prefix}-${kind}-work`, work_kind: 'PM_ACTION', pm_run_id: `${prefix}-${kind}-pm`, action_id: `${prefix}-${kind}-action` };
}

test('P15-B-002 real PostgreSQL ACTIVE occupant + faulted occupancy read + healthy claim path never double-admits', { skip: !dsn }, async (t) => {
  const store = await new PostgresCoordinationStore().open({ connectionString: dsn });
  t.after(() => store.close());
  await store.migrate();
  const prefix = `p15-b002-${randomUUID()}`;
  const occupant = identity(prefix, 'occupant');
  const sameWorkspace = identity(prefix, 'same');
  const separateWorkspace = identity(prefix, 'separate');
  for (const item of [occupant, sameWorkspace, separateWorkspace]) await store.registerWorkIdentity(item);
  const occupantWorker = `${prefix}-occupant-worker`;
  const candidateWorker = `${prefix}-candidate-worker`;
  for (const workerId of [occupantWorker, candidateWorker]) {
    await store.registerWorkerIncarnation({
      logical_worker_id: workerId,
      worker_incarnation_id: workerId,
      host_id: 'localhost',
      installed_profiles: [],
      capacity: { max_concurrency: 2, reported_in_use: 0 },
    });
  }
  const occupantClaim = await store.acquireClaim({ work_item_id: occupant.work_item_id, worker_incarnation_id: occupantWorker, leaseMs: 30000 });
  assert.ok(occupantClaim);

  let claimWriteAttempts = 0;
  const faultedStore = new Proxy(store, {
    get(target, property) {
      if (property === 'listActivePmActionWork') return async () => { throw Object.assign(new Error('simulated isolated occupancy read failure'), { code: 'SIMULATED_OCCUPANCY_READ_FAILURE' }); };
      if (property === 'listPmActionCandidates') return async () => [sameWorkspace, separateWorkspace];
      if (property === 'acquireClaim') return async (args) => { claimWriteAttempts += 1; return target.acquireClaim(args); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const diagnostics = [];
  const worker = new ProductionPmWorker({
    coordinationStore: faultedStore,
    handler: { execute: async () => ({ status: 'COMPLETED' }) },
    workerIncarnationId: candidateWorker,
    resolveWorkIdentity: (item) => ({ workspace_id: item.work_item_id === separateWorkspace.work_item_id ? 'workspace-other' : 'workspace-occupied' }),
    globalLimit: 2,
    diagnosticSink: (entry) => diagnostics.push(entry),
  });

  const tick = await worker.runOnce();
  assert.equal(claimWriteAttempts, 0, 'healthy claim-write path must not be used when occupancy truth is unknown');
  assert.deepEqual(tick.rejected.map((entry) => entry.reason), [ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE, ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE]);
  const active = await store.listActivePmActionWork({ limit: 50 });
  assert.equal(active.some((item) => item.work_item_id === occupant.work_item_id), true, 'occupying claim remains ACTIVE');
  assert.equal(active.some((item) => item.work_item_id === sameWorkspace.work_item_id), false, 'same-workspace candidate remains unclaimed');
  assert.equal(active.some((item) => item.work_item_id === separateWorkspace.work_item_id), false, 'FAIL_CLOSED_FOR_TICK also holds separate-workspace candidate');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'PM_OCCUPANCY_DISCOVERY_FAILED');

  const fenceFor = (claim) => ({ work_item_id: claim.work_item_id, owner_worker_incarnation_id: claim.owner_worker_incarnation_id, fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token });
  await store.completeClaim(fenceFor(occupantClaim));
  for (const item of [sameWorkspace, separateWorkspace]) {
    const cleanupClaim = await store.acquireClaim({ work_item_id: item.work_item_id, worker_incarnation_id: candidateWorker, leaseMs: 30000 });
    await store.completeClaim(fenceFor(cleanupClaim));
  }
});

test('P15-REM-R1 live PostgreSQL composition preserves P13 N=2 across distinct workspaces and queues the third', { skip: !dsn }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p15-r1-live-n2-'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.sqlite') });
  const store = await new PostgresCoordinationStore().open({ connectionString: dsn });
  await store.assertReady();
  const suffix = randomUUID();
  const gates = new Map();
  const invoked = [];
  const profile = { id: `p15-delay-${suffix}`, role_kind: 'PM', session_kind: 'STATELESS', product: 'p15-delay', transport: 'in-process' };
  const projects = ['a', 'b', 'c'].map((name) => {
    const repoPath = join(root, `repo-${name}`);
    mkdirSync(repoPath);
    return { id: `p15-${name}-${suffix}`, repo_path: repoPath, workspace_id: `workspace-${name}-${suffix}`, workspace_verified: true, default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  });
  const config = {
    postgres: { connectionString: dsn }, sqlitePath: join(root, 'state.sqlite'), projects, profiles: [profile],
    telegram: { token: 'fake', ownerUserId: '1', ownerChatId: '2', projectId: projects[0].id, pollIntervalMs: 10 },
    coordinator: { logicalId: `p15-c-${suffix}`, leaseMs: 5000, pollIntervalMs: 10 },
    worker: { logicalId: `p15-w-${suffix}`, leaseMs: 5000, pollIntervalMs: 10 }, pm: { scriptedDecisions: null },
  };
  let composition;
  try {
    composition = await createP5ProductionComposition(config, {
      sqliteStore: sqlite,
      coordinationStore: store,
      ownerRepository: { close: async () => {}, claimNotifications: async () => [] },
      fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
      pmDriverFactories: {
        'p15-delay': (_profile, { project }) => ({
          name: 'p15-delay',
          decide: async () => {
            invoked.push(project.id);
            await new Promise((resolveGate) => gates.set(project.id, resolveGate));
            return { type: 'finish', output: `done:${project.id}` };
          },
        }),
      },
    });
    for (const project of projects) {
      await composition.taskController.submit({ command: { command_id: `cmd-${project.id}`, payload: { body: `inspect ${project.id}` }, accepted_at: '2026-09-01T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
    }
    const worker = await composition.buildWorker();
    const first = await worker.runOnce();
    assert.equal(first.started.length, 2);
    assert.equal(first.rejected.filter((entry) => entry.reason === ADMISSION_REJECTED.GLOBAL_CAPACITY).length, 1);
    for (let attempt = 0; attempt < 200 && invoked.length < 2; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    assert.equal(invoked.length, 2, 'two real claims in distinct physical workspaces execute simultaneously');
    for (const release of gates.values()) release();
    await Promise.all(first.started.map((entry) => entry.promise));
  } finally {
    for (const release of gates.values()) release();
    await composition?.close({ drainGracePeriodMs: 50, drainTimeoutMs: 1000 }).catch(() => {});
    if (!composition) {
      try { await store.close(); } catch {}
      try { sqlite.close(); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});
