// M04 real verification: the compiled desktop ReadProjection.getTimeline()
// must return only entries matching the requested category filter — never
// silently include every USER_GUI/USER_TELEGRAM row when a non-user
// category is requested (or vice versa). This drives the ACTUAL compiled
// desktop/dist-electron output against a real Postgres container and a
// real SQLite v6 file, not a reimplementation of the fix.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

let container;
let root;
let ReadProjection;
try {
  // Compile the desktop TS project so we exercise the real emitted JS.
  const buildResult = spawnSync('npx', ['tsc', '-p', 'tsconfig.electron.json'], { cwd: join(process.cwd(), 'desktop'), stdio: 'pipe', shell: true, encoding: 'utf8' });
  if (buildResult.status !== 0) throw new Error(`desktop tsc build failed: ${buildResult.stdout}\n${buildResult.stderr}`);
  ({ ReadProjection } = await import(pathToFileURL(join(process.cwd(), 'desktop', 'dist-electron', 'electron', 'main', 'services', 'readProjection.js')).href));

  const password = randomBytes(24).toString('hex');
  const name = `dsh-w3-timeline-${process.pid}-${Date.now()}`;
  container = docker('run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_w3_timeline', '-p', '127.0.0.1::5432', 'postgres:18-alpine').stdout.trim();
  const port = docker('port', container, '5432/tcp').stdout.trim().match(/:(\d+)$/)?.[1];
  const dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_w3_timeline`;

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

  const now = new Date();
  const ts = (secondsAgo) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

  // Two real owner_command rows: one LOCAL (GUI), one TELEGRAM.
  const directPool = new pg.Pool({ connectionString: dsn });
  await directPool.query(
    `INSERT INTO dsh_coordination.owner_command (command_id,actor_id,client_kind,operation,project_id,payload,payload_digest,status,canonical_result,created_at)
     VALUES ($1,'1','LOCAL','SUBMIT_TASK','p',$2::jsonb,$3,'COMPLETED','{}'::jsonb,$4)`,
    ['cmd-gui-1', JSON.stringify({ body: 'gui task' }), 'd'.repeat(64), ts(50)],
  );
  await directPool.query(
    `INSERT INTO dsh_coordination.owner_command (command_id,actor_id,client_kind,operation,project_id,payload,payload_digest,status,canonical_result,created_at)
     VALUES ($1,'1','TELEGRAM','SUBMIT_TASK','p',$2::jsonb,$3,'COMPLETED','{}'::jsonb,$4)`,
    ['cmd-tg-1', JSON.stringify({ body: 'telegram task' }), 'e'.repeat(64), ts(40)],
  );
  await directPool.end();

  root = mkdtempSync(join(tmpdir(), 'dsh-w3-timeline-'));
  mkdirSync(join(root, 'repo'));
  const sqlitePath = join(root, 'state.db');
  const sqlite = await new SqlitePersistenceStore().open({ path: sqlitePath });
  await sqlite.migrate();
  // Real bus_events rows spanning every non-user category timelineCategory() computes.
  const events = [
    ['pm.decision', 't1', ts(30)],           // -> PM
    ['agent.dispatch', 't1', ts(25)],        // -> AGENT
    ['approval.requested', 't1', ts(20)],    // -> APPROVAL
    ['task.completed', 't1', ts(15)],        // -> RESULT (via "completed", NOT a "result%" prefix — the exact prior mismatch)
    ['pm.terminal.result', 't1', ts(10)],    // -> RESULT (via "result")
    ['system.info', 't1', ts(5)],            // -> SYSTEM
  ];
  sqlite.run(`INSERT INTO tasks (id, envelope, created_at, project_id) VALUES ('t1', '{}', ?, 'p')`, [ts(60)]);
  for (const [event, taskId, at] of events) {
    sqlite.run(`INSERT INTO bus_events (task_id, event, payload, at) VALUES (?, ?, '{}', ?)`, [taskId, event, at]);
  }
  await sqlite.close();

  // Point ReadProjection at a real config fixture.
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    display_name: P\n    repo_path: ./repo\n`);
  writeFileSync(join(root, 'config.yaml'), `postgres:\n  dsn_env: DSH_W3_TIMELINE_DSN\nsqlite:\n  path: ${sqlitePath.replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\n`);
  process.env.DSH_CONFIG_PATH = join(root, 'config.yaml');
  process.env.DSH_W3_TIMELINE_DSN = dsn;

  const projection = new ReadProjection(root);
  await projection.initialize();

  const results = {};
  const categoryOf = async (category) => (await projection.getTimeline(null, { limit: 50, category })).map((e) => e.category);

  results.ALL = (await projection.getTimeline(null, { limit: 50 })).length === 8; // 2 owner_command + 6 bus_events
  results.USER = new Set(await categoryOf('USER')).size <= 2 && (await categoryOf('USER')).every((c) => c === 'USER_GUI' || c === 'USER_TELEGRAM') && (await categoryOf('USER')).length === 2;
  results.USER_GUI = JSON.stringify(await categoryOf('USER_GUI')) === JSON.stringify(['USER_GUI']);
  results.USER_TELEGRAM = JSON.stringify(await categoryOf('USER_TELEGRAM')) === JSON.stringify(['USER_TELEGRAM']);
  results.PM = JSON.stringify(await categoryOf('PM')) === JSON.stringify(['PM']);
  results.AGENT = JSON.stringify(await categoryOf('AGENT')) === JSON.stringify(['AGENT']);
  results.APPROVAL = JSON.stringify(await categoryOf('APPROVAL')) === JSON.stringify(['APPROVAL']);
  const resultCats = await categoryOf('RESULT');
  results.RESULT = resultCats.length === 2 && resultCats.every((c) => c === 'RESULT'); // both task.completed AND pm.terminal.result
  results.SYSTEM = JSON.stringify(await categoryOf('SYSTEM')) === JSON.stringify(['SYSTEM']);

  await projection.close();

  console.log(JSON.stringify(results, null, 2));
  const failed = Object.entries(results).filter(([, v]) => v !== true);
  if (failed.length) {
    console.error(`W3-R1 TIMELINE FILTER VERIFY: FAIL (${failed.map(([k]) => k).join(', ')})`);
    process.exitCode = 1;
  } else {
    console.log('W3-R1 TIMELINE FILTER VERIFY: PASS');
  }
} catch (error) {
  console.error(`W3-R1 TIMELINE FILTER VERIFY: FAIL (${error.stack})`);
  process.exitCode = 1;
} finally {
  if (container) docker('rm', '--force', container);
  if (root) rmSync(root, { recursive: true, force: true });
}
