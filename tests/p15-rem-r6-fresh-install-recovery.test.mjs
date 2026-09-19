import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { snapshotSqliteDatabase } from '../scripts/sqlite-snapshot.mjs';

const dsn = process.env.DSH_CI_POSTGRES_DSN;

test('REM-R6 zero-state bootstrap, fake-provider run, snapshot, and restart preserve durable result', { skip: !dsn }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p15-rem-r6-fresh-'));
  const repoPath = join(root, 'repo');
  const sqlitePath = join(root, 'state.sqlite');
  const snapshotPath = join(root, 'state.snapshot.sqlite');
  mkdirSync(repoPath);

  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  const bootstrap = await new PostgresCoordinationStore().open({ connectionString: dsn });
  await bootstrap.migrate();
  await bootstrap.close();

  const profile = { id: 'rem-r6-fake', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' };
  const project = { id: 'rem-r6-project', repo_path: repoPath, default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    mode: 'production',
    postgres: { connectionString: dsn },
    sqlitePath,
    projects: [project],
    profiles: [profile],
    telegram: { token: 'disposable-no-secret-token', ownerUserId: '1', ownerChatId: '2', projectId: project.id, pollIntervalMs: 10 },
    coordinator: { logicalId: `rem-r6-coord-${randomUUID()}`, leaseMs: 5_000, pollIntervalMs: 10 },
    worker: { logicalId: `rem-r6-worker-${randomUUID()}`, leaseMs: 1_000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: [{ type: 'finish', output: 'REM-R6 durable result' }] },
  };

  let first;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await first?.close();
    await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
    await admin.end();
    rmSync(root, { recursive: true, force: true });
  });

  first = await createP5ProductionComposition(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  assert.equal(first.readiness().ready, true);
  const submitted = await first.ownerService.mutate({
    command_id: `rem-r6-command-${randomUUID()}`,
    actor_id: '1',
    client_kind: 'LOCAL',
    operation: 'SUBMIT_TASK',
    project_id: project.id,
    payload: { body: 'minimal disposable task', pm_profile_id: profile.id },
  });
  const taskId = submitted.canonical_result.task_id;
  const pmRunId = submitted.canonical_result.pm_run_id;
  const worker = await first.buildWorker();
  const started = await worker.runOnce();
  assert.equal(started.status, 'WORK');
  const settled = await started.started[0].promise;
  assert.equal(settled.outcome.status, 'COMPLETED');
  assert.equal(first.pmRepository.load(pmRunId).output, 'REM-R6 durable result');

  await first.close();
  first = null;
  const snapshot = await snapshotSqliteDatabase({ sourcePath: sqlitePath, destinationPath: snapshotPath });
  assert.equal(snapshot.status, 'PASS');
  assert.equal(snapshot.selfContained, true);

  restarted = await createP5ProductionComposition({ ...config, sqlitePath: snapshotPath }, { fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  assert.equal(restarted.readiness().ready, true);
  assert.equal(restarted.agentBusRepository.getOwnerTask(taskId).id, taskId);
  const recovered = restarted.pmRepository.load(pmRunId);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.output, 'REM-R6 durable result');
  assert.equal((await (await restarted.buildWorker()).runOnce()).status, 'IDLE');
  assert.equal((await restarted.coordination.listPmActionCandidates({})).length, 0);
});
