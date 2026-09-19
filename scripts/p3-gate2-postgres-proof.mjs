import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
let container;
async function docker(...args) { return exec('docker', args, { windowsHide: true }); }

try {
  const password = randomBytes(24).toString('hex');
  const name = `dsh-p3g2-${process.pid}-${Date.now()}`;
  const run = await docker('run', '--detach', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_gate2', '-p', '127.0.0.1::5432', 'postgres:18-alpine');
  container = run.stdout.trim();
  const port = (await docker('port', container, '5432/tcp')).stdout.trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error('disposable PostgreSQL port was not assigned');
  const dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_gate2`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'dsh_gate2'); ready = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('disposable PostgreSQL did not become ready');
  let hostReady = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 500 });
    try { await client.connect(); await client.end(); hostReady = true; break; }
    catch { await client.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!hostReady) throw new Error('disposable PostgreSQL host endpoint did not become ready');
  const child = spawn(process.execPath, ['--test', 'tests/postgres-claim-lease-fencing.test.mjs'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DSH_P3G2_POSTGRES_DSN: dsn, DSH_P3G2_CONTAINER_ID: container, DSH_P3G2_REQUIRE_POSTGRES: '1' },
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) process.exitCode = code ?? 1;
  else console.log('P3-GATE2 POSTGRES CLAIM/LEASE/FENCING PROOF: PASS');
} catch (error) {
  console.error(`P3-GATE2 POSTGRES CLAIM/LEASE/FENCING PROOF: FAIL (${error.message})`);
  process.exitCode = 1;
} finally {
  if (container) await docker('rm', '--force', container).catch(() => {});
}
