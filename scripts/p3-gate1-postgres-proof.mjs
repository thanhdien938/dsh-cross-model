import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const supplied = process.env.DSH_P3G1_POSTGRES_DSN;
let container;
let dsn = supplied;

async function docker(...args) { return exec('docker', args, { windowsHide: true }); }

try {
  if (!dsn) {
    const password = randomBytes(24).toString('hex');
    const name = `dsh-p3g1-${process.pid}-${Date.now()}`;
    const run = await docker('run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_gate1', '-p', '127.0.0.1::5432', 'postgres:18-alpine');
    container = run.stdout.trim();
    const portOutput = await docker('port', container, '5432/tcp');
    const port = portOutput.stdout.trim().match(/:(\d+)$/)?.[1];
    if (!port) throw new Error('disposable PostgreSQL port was not assigned');
    dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_gate1`;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { await docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'dsh_gate1'); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (!ready) throw new Error('disposable PostgreSQL did not become ready');
    ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 500 });
      try { await client.connect(); await client.end(); ready = true; break; }
      catch { await client.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (!ready) throw new Error('disposable PostgreSQL host endpoint did not become ready');
  }
  const child = spawn(process.execPath, ['--test', 'tests/coordination-identities.test.mjs', 'tests/postgres-coordination-store.test.mjs'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DSH_P3G1_POSTGRES_DSN: dsn, DSH_P3G1_REQUIRE_POSTGRES: '1' },
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) process.exitCode = code ?? 1;
  else console.log('P3-GATE1 POSTGRES REAL-STORE PROOF: PASS');
} catch (error) {
  console.error(`P3-GATE1 POSTGRES REAL-STORE PROOF: FAIL (${error.message})`);
  process.exitCode = 1;
} finally {
  if (container) await docker('rm', '--force', container).catch(() => {});
}
