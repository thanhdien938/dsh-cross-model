import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
const exec = promisify(execFile); let container;
async function docker(...args) { return exec('docker', args, { windowsHide: true }); }
try {
  const password = randomBytes(24).toString('hex'); const name = `dsh-p3g4-${process.pid}-${Date.now()}`;
  container = (await docker('run', '--detach', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_gate4', '-p', '127.0.0.1::5432', 'postgres:18-alpine')).stdout.trim();
  const port = (await docker('port', container, '5432/tcp')).stdout.trim().match(/:(\d+)$/)?.[1]; if (!port) throw new Error('PostgreSQL port unavailable');
  const dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_gate4`; let ready = false;
  for (let i = 0; i < 60; i += 1) { const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 500 }); try { await client.connect(); await client.end(); ready = true; break; } catch { await client.end().catch(() => {}); await new Promise((r) => setTimeout(r, 100)); } }
  if (!ready) throw new Error('PostgreSQL did not become ready');
  const child = spawn(process.execPath, ['--test', 'tests/multi-process-workers.test.mjs'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, DSH_P3G4_POSTGRES_DSN: dsn, DSH_P3G4_CONTAINER_ID: container, DSH_P3G4_REQUIRE_POSTGRES: '1' } });
  const code = await new Promise((resolve) => child.once('exit', resolve)); if (code !== 0) process.exitCode = code ?? 1; else console.log('P3-GATE4 REAL MULTI-PROCESS POSTGRES + SQLITE PROOF: PASS');
} catch (error) { console.error(`P3-GATE4 REAL MULTI-PROCESS PROOF: FAIL (${error.message})`); process.exitCode = 1; }
finally { if (container) await docker('rm', '--force', container).catch(() => {}); }
