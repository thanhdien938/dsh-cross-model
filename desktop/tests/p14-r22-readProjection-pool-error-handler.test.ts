import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import Database from 'better-sqlite3';
import { ReadProjection } from '../electron/main/services/readProjection';

// P14-R2.2 (docs/p14/audit/04_R22_ELECTRON_POSTGRES_TERMINATION_FORENSIC.md):
// the owner observed a native Electron "A JavaScript error occurred in the
// main process" crash dialog with the underlying error "terminating
// connection due to administrator command" immediately after an R2.1
// disposable-PostgreSQL teardown. Root cause: node-postgres re-emits a
// socket-level failure on an idle checked-in client as an 'error' event on
// the Pool itself; an EventEmitter with no 'error' listener throws
// synchronously, which in Electron main surfaces as an uncaught exception.
// ReadProjection's pgPool (desktop/electron/main/services/readProjection.ts)
// had no such listener, unlike the runtime process's two Pool owners
// (src/coordination/postgres/postgres-coordination-store.mjs,
// src/owner/postgres-owner-repository.mjs), which both already carry one.
//
// This test requires a REAL, reachable PostgreSQL server (set
// DSH_R22_TEST_DSN) because the defect is only observable against real
// backend-termination semantics — a fake/unreachable DSN never produces the
// admin-termination 'error' event this test proves is now handled. It is
// gated exactly like this repo's other real-Postgres-only proofs (e.g.
// tests/postgres-coordination-store.test.mjs's DSH_P3G1_POSTGRES_DSN) and
// skips cleanly with no DSN configured, consistent with the established
// TEST_ENVIRONMENT limitation already recorded for this project's
// clean-worktree/no-DSN CI runs.
const dsn = process.env.DSH_R22_TEST_DSN;

describe.skipIf(!dsn)('ReadProjection — PostgreSQL pool administrator-termination handling (P14-R22)', () => {
  let dir: string;
  let configPath: string;
  let projectsPath: string;
  let sqlitePath: string;
  const appName = 'dsh_r22_read_projection_test';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r22-pool-error-'));
    configPath = path.join(dir, 'local-config.production.yaml');
    projectsPath = path.join(dir, 'projects.yaml');
    sqlitePath = path.join(dir, 'state.sqlite');
    fs.writeFileSync(
      configPath,
      ['projects_file: projects.yaml', 'postgres:', '  dsn_env: DSH_R22_POOL_DSN', 'sqlite:', '  path: state.sqlite', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(projectsPath, 'projects: []\n', 'utf8');
    new Database(sqlitePath).close(); // real, empty, valid sqlite file
    // application_name lets the test find and terminate EXACTLY the pool's
    // own backend connection, never any other real session on the server.
    const withAppName = new URL(dsn as string);
    withAppName.searchParams.set('application_name', appName);
    process.env.DSH_R22_POOL_DSN = withAppName.toString();
  });

  afterEach(() => {
    delete process.env.DSH_R22_POOL_DSN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not crash the process when PostgreSQL administratively terminates an idle pooled connection', async () => {
    const projection = new ReadProjection(dir, configPath);
    await projection.initialize();

    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => { uncaught = err; };
    process.once('uncaughtException', onUncaught);

    try {
      // Force the pool to open a real backend connection and check it back
      // in as idle — mirrors a normal Desktop IPC read (e.g. getInbox()
      // during idle-between-polls, exactly the state the owner's Desktop
      // was in when PostgreSQL was administratively terminated).
      await projection.getInbox(null);

      // Locate and terminate EXACTLY this pool's own backend connection —
      // never another real session — reproducing "terminating connection
      // due to administrator command" via the standard PostgreSQL
      // administrator mechanism (pg_terminate_backend).
      const admin = new pg.Client({ connectionString: dsn });
      await admin.connect();
      const target = await admin.query(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [appName],
      );
      expect(target.rows.length).toBeGreaterThan(0);
      await admin.query('SELECT pg_terminate_backend($1)', [target.rows[0].pid]);
      await admin.end();

      // Give the async socket-close/error event a tick to fire.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The defect this test guards against: an unhandled 'error' event on
      // the Pool throws synchronously and would have surfaced here as an
      // uncaughtException in this very process.
      expect(uncaught).toBeNull();

      // Part I requirement 3: an unexpected connection loss is recoverable,
      // not a silent permanent failure — the pool transparently opens a
      // fresh connection on the next query.
      // P15-REM-R3-F (P15-D-014): getInbox() now returns a typed
      // ProjectionResult — the pool's transparent self-heal must still
      // reach a real, successful 'OK'/'EMPTY' read, never 'ERROR'.
      const inboxAfterTermination = await projection.getInbox(null);
      expect(Array.isArray(inboxAfterTermination.data)).toBe(true);
      expect(inboxAfterTermination.status).not.toBe('ERROR');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await projection.close();
    }
  });
});
