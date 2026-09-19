// Real-Postgres verification for the exact SQL desktop's readProjection.ts
// getBackendRuns() runs (src/... does not implement this query — it is
// TypeScript, compiled separately — so this script proves the query
// itself, copied verbatim, is correct against real schemas rather than
// merely compiling).
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

let container;
let root;
let composition;

try {
  const password = randomBytes(24).toString('hex');
  const name = `dsh-w3-runs-${process.pid}-${Date.now()}`;
  container = docker('run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_w3_runs', '-p', '127.0.0.1::5432', 'postgres:18-alpine').stdout.trim();
  const port = docker('port', container, '5432/tcp').stdout.trim().match(/:(\d+)$/)?.[1];
  const dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_w3_runs`;

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 500 });
    try { await client.connect(); await client.end(); ready = true; break; }
    catch { await client.end().catch(() => {}); await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  const bootstrap = await new PostgresCoordinationStore().open({ connectionString: dsn });
  await bootstrap.migrate();
  await bootstrap.close();

  root = mkdtempSync(join(tmpdir(), 'dsh-w3-runs-'));
  mkdirSync(join(root, 'repo-a'));

  const config = {
    mode: 'production',
    postgres: { connectionString: dsn },
    sqlitePath: join(root, 'state.db'),
    projects: [{ id: 'w3-runs-a', repo_path: join(root, 'repo-a'), path_missing: false, default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }],
    profiles: [{ id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' }],
    telegram: { token: 'x', ownerUserId: '1', ownerChatId: '2', projectId: null, pollIntervalMs: 5000 },
    coordinator: { logicalId: 'c', leaseMs: 30000, pollIntervalMs: 250 },
    worker: { logicalId: 'w', leaseMs: 30000, pollIntervalMs: 250 },
    pm: { scriptedDecisions: [{ type: 'finish', output: 'w3-run-output' }] },
  };
  composition = await createP5ProductionComposition(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });

  const commandId = randomUUID();
  const result = await composition.ownerService.mutate({ command_id: commandId, actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'w3-runs-a', payload: { body: 'W3 backend-runs verify' } });
  const worker = await composition.buildWorker();
  const outcome = await worker.runOnce();

  const results = {
    taskMaterialized: result.canonical_result?.status === 'MATERIALIZED',
    pmRunCompleted: outcome.status === 'WORK' && outcome.outcome.status === 'COMPLETED',
  };

  // The exact query from desktop/electron/main/services/readProjection.ts getBackendRuns().
  // P6-W3-R3 Part C added `request_id` to this SELECT (an existing column,
  // not a schema change) so Desktop can best-effort correlate a durable
  // pm_runs row with its still-in-memory BackendExecutionObserver events.
  const runs = composition.sqlite.all(
    `SELECT id, driver, status, output, error, pm_profile_id, request_id, started_at, completed_at FROM pm_runs ORDER BY COALESCE(completed_at, started_at) DESC LIMIT ?`,
    [50],
  );
  results.oneRunFound = runs.length === 1;
  results.runStatusCompleted = runs[0]?.status === 'completed';
  results.runOutputMatches = runs[0]?.output === 'w3-run-output';
  results.requestIdPresent = typeof runs[0]?.request_id === 'string' && runs[0].request_id.length > 0;

  const pgPool = new pg.Pool({ connectionString: dsn });
  const lineage = await pgPool.query(
    `SELECT project_id, canonical_result->>'task_id' AS task_id FROM dsh_coordination.owner_command WHERE operation = 'SUBMIT_TASK' AND status = 'COMPLETED' AND canonical_result->>'pm_run_id' = $1 LIMIT 1`,
    [runs[0]?.id],
  );
  results.lineageResolved = lineage.rows[0]?.project_id === 'w3-runs-a' && lineage.rows[0]?.task_id === result.canonical_result.task_id;

  // The exact query from readProjection.ts's resolveTaskLineageByRequestId()
  // (P6-W3-R3 Part B) — proves the runId (pm_runs.request_id) -> taskId
  // two-hop lookup the live execLogs:statuses IPC handler uses to backfill
  // BackendExecutionEvent's taskId, against real schemas.
  const runByRequestId = composition.sqlite.all(`SELECT id FROM pm_runs WHERE request_id = ? LIMIT 1`, [runs[0]?.request_id])[0];
  const taskLineage = await pgPool.query(
    `SELECT project_id, canonical_result->>'task_id' AS task_id FROM dsh_coordination.owner_command WHERE operation = 'SUBMIT_TASK' AND canonical_result->>'pm_run_id' = $1 LIMIT 1`,
    [runByRequestId?.id],
  );
  results.taskLineageByRequestIdResolved = taskLineage.rows[0]?.task_id === result.canonical_result.task_id;
  await pgPool.end();

  console.log(JSON.stringify(results, null, 2));
  const failed = Object.entries(results).filter(([, v]) => v !== true);
  if (failed.length) {
    console.error(`W3 BACKEND RUNS QUERY VERIFY: FAIL (${failed.map(([k]) => k).join(', ')})`);
    process.exitCode = 1;
  } else {
    console.log('W3 BACKEND RUNS QUERY VERIFY: PASS');
  }
} catch (error) {
  console.error(`W3 BACKEND RUNS QUERY VERIFY: FAIL (${error.message})`);
  process.exitCode = 1;
} finally {
  await composition?.close().catch(() => {});
  if (container) docker('rm', '--force', container);
  if (root) rmSync(root, { recursive: true, force: true });
}
