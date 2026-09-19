/**
 * P24.3B-R2 — a genuinely disposable, self-contained local PostgreSQL
 * cluster for qualification tests that need the REAL
 * `PostgresCoordinationStore` implementation, without depending on any
 * shared/named/operator-managed instance and its credentials (DSH's own
 * docs/operations/POSTGRES_BOOTSTRAP.md deliberately never stores a
 * coordination DSN/password anywhere — that is correct operator security
 * posture, not a gap to route around).
 *
 * Provisions a fresh `initdb` data directory under the OS temp root, on a
 * random high port, listening on `127.0.0.1` only, with `--auth=trust`
 * (safe for a cluster that: never listens beyond loopback, lives for the
 * duration of one test file, and is deleted afterward — exactly the
 * disposable-CI-database pattern, never used for anything durable).
 *
 * Not a *.test.mjs file, so it is never discovered as a test.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function randomPort() {
  return 20000 + Math.floor(Math.random() * 30000);
}

export function isDisposablePostgresAvailable() {
  try {
    execFileSync('initdb', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{dsn:string, stop: () => Promise<void>}>}
 */
export async function startDisposablePostgres({ database = 'dsh_r2_qualification' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-r2-pg-'));
  const dataDir = join(root, 'data');
  const port = randomPort();
  const commonArgs = { stdio: 'ignore', windowsHide: true };

  execFileSync('initdb', ['-D', dataDir, '-U', 'dsh_test', '--auth=trust', '--no-locale', '-E', 'UTF8'], commonArgs);
  appendFileSync(join(dataDir, 'postgresql.conf'), `\nport = ${port}\nlisten_addresses = '127.0.0.1'\n`);
  execFileSync('pg_ctl', ['-D', dataDir, '-l', join(root, 'server.log'), '-w', 'start'], commonArgs);
  try {
    execFileSync('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'dsh_test', database], commonArgs);
  } catch (error) {
    try { execFileSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'immediate'], commonArgs); } catch { /* best-effort */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  const dsn = `postgresql://dsh_test@127.0.0.1:${port}/${database}`;
  let stopped = false;
  return {
    dsn,
    port,
    async stop() {
      if (stopped) return;
      stopped = true;
      try { execFileSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast'], commonArgs); } catch { /* best-effort */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}
