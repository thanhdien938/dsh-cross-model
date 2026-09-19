import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { SCHEMA_VERSION, SCHEMA_V1_TABLES, migrationDefinitions } from '../src/persistence/sqlite/migrations.mjs';
import { PersistenceError, StoreClosedError, SchemaVersionError, MigrationError } from '../src/persistence/persistence-errors.mjs';

function makeTempDir(t) {
  return mkdtempSync(join(tmpdir(), 'dsh-p2g1-'));
}

async function openMigratedStore(t, dir) {
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function rawQuery(dbPath, sql, params = []) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(params);
  } finally {
    db.close();
  }
}

function rawRun(dbPath, sql, params = []) {
  const db = new Database(dbPath);
  try {
    return db.prepare(sql).run(params);
  } finally {
    db.close();
  }
}

test('new database starts at schema version 0', async (t) => {
  const dir = makeTempDir(t);
  const store = new SqlitePersistenceStore();
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.open({ path: join(dir, 'store.db') });
  assert.equal(await store.readSchemaVersion(), 0);
});

test('empty database migrates to schema v1', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  assert.equal(await store.readSchemaVersion(), SCHEMA_VERSION);
});

test('schema v1 contains all 22 required logical tables', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  const inspection = await store.inspectSchema();
  assert.equal(SCHEMA_V1_TABLES.length, 22);
  for (const table of SCHEMA_V1_TABLES) assert.ok(inspection.tables.includes(table), `missing table ${table}`);
  assert.equal(inspection.version, SCHEMA_VERSION);
});

test('schema v2 adds workflow step + peer hop durability columns', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  const workflowStepColumns = rawQuery(join(dir, 'store.db'), "SELECT name FROM pragma_table_info('workflow_steps')").map((row) => row.name);
  for (const column of ['body', 'context', 'expected_output']) {
    assert.ok(workflowStepColumns.includes(column), `missing workflow_steps.${column}`);
  }
  const peerHopColumns = rawQuery(join(dir, 'store.db'), "SELECT name FROM pragma_table_info('peer_hops')").map((row) => row.name);
  for (const column of ['source_task_id', 'source_run_id', 'source_result_id']) {
    assert.ok(peerHopColumns.includes(column), `missing peer_hops.${column}`);
  }
});

test('WAL journal mode is active', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  assert.equal((await store.inspectSchema()).journalMode, 'wal');
});

test('foreign keys are enabled', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  assert.equal((await store.inspectSchema()).foreignKeys, true);
});

test('transaction commits atomically', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.transaction((tx) => {
    tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['inst-1', '2026-08-18T00:00:00.000Z']);
    tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['inst-2', '2026-08-18T00:00:00.000Z']);
  });
  const rows = rawQuery(join(dir, 'store.db'), 'SELECT id FROM orchestrator_instances ORDER BY id');
  assert.deepEqual(rows.map((row) => row.id), ['inst-1', 'inst-2']);
});

test('thrown transaction rolls back all writes atomically', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await assert.rejects(
    () => store.transaction((tx) => {
      tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['inst-1', '2026-08-18T00:00:00.000Z']);
      tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['inst-2', '2026-08-18T00:00:00.000Z']);
      throw new Error('boom');
    }),
    /boom/,
  );
  const rows = rawQuery(join(dir, 'store.db'), 'SELECT id FROM orchestrator_instances ORDER BY id');
  assert.deepEqual(rows, []);
});

test('async transaction callbacks are rejected (cannot roll back atomically)', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await assert.rejects(
    () => store.transaction(async (tx) => { tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['x', 'now']); }),
    (error) => error instanceof PersistenceError && error.code === 'ASYNC_TRANSACTION_CALLBACK',
  );
  assert.deepEqual(rawQuery(join(dir, 'store.db'), 'SELECT id FROM orchestrator_instances'), []);
});

test('results.run_id uniqueness is enforced', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.transaction((tx) => {
    tx.execute('INSERT INTO tasks (id, envelope, created_at) VALUES (?, ?, ?)', ['task-1', '{}', 'now']);
    tx.execute('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)', ['run-1', 'task-1', 'completed', 'now']);
    tx.execute('INSERT INTO results (id, run_id, status, created_at) VALUES (?, ?, ?, ?)', ['res-1', 'run-1', 'completed', 'now']);
  });
  assert.throws(() => {
    rawRun(join(dir, 'store.db'), 'INSERT INTO results (id, run_id, status, created_at) VALUES (?, ?, ?, ?)', ['res-2', 'run-1', 'completed', 'now']);
  }, /UNIQUE constraint failed: results\.run_id/);
});

test('runs.task_id foreign key is enforced', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  assert.throws(() => {
    rawRun(join(dir, 'store.db'), 'INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)', ['run-1', 'missing-task', 'running', 'now']);
  }, /FOREIGN KEY constraint failed/);
});

test('workflow step (workflow_id, step_index) uniqueness is enforced', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.transaction((tx) => {
    tx.execute('INSERT INTO workflows (id, spec, status, created_at) VALUES (?, ?, ?, ?)', ['wf-1', '{}', 'created', 'now']);
    tx.execute('INSERT INTO workflow_steps (id, workflow_id, step_index, status, created_at) VALUES (?, ?, ?, ?, ?)', ['step-1', 'wf-1', 0, 'created', 'now']);
  });
  assert.throws(() => {
    rawRun(join(dir, 'store.db'), 'INSERT INTO workflow_steps (id, workflow_id, step_index, status, created_at) VALUES (?, ?, ?, ?, ?)', ['step-2', 'wf-1', 0, 'created', 'now']);
  }, /UNIQUE constraint failed: workflow_steps\.workflow_id, workflow_steps\.step_index/);
});

test('pm turn (pm_run_id, turn_index) uniqueness is enforced', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.transaction((tx) => {
    tx.execute('INSERT INTO pm_requests (id, objective, envelope, created_at) VALUES (?, ?, ?, ?)', ['req-1', 'objective', '{}', 'now']);
    tx.execute('INSERT INTO pm_runs (id, request_id, status, created_at) VALUES (?, ?, ?, ?)', ['pmrun-1', 'req-1', 'running', 'now']);
    tx.execute('INSERT INTO pm_turns (id, pm_run_id, turn_index, decision, created_at) VALUES (?, ?, ?, ?, ?)', ['turn-1', 'pmrun-1', 0, '{}', 'now']);
  });
  assert.throws(() => {
    rawRun(join(dir, 'store.db'), 'INSERT INTO pm_turns (id, pm_run_id, turn_index, decision, created_at) VALUES (?, ?, ?, ?, ?)', ['turn-2', 'pmrun-1', 0, '{}', 'now']);
  }, /UNIQUE constraint failed: pm_turns\.pm_run_id, pm_turns\.turn_index/);
});

test('audit entry (trace_id, sequence) uniqueness is enforced', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.transaction((tx) => {
    tx.execute('INSERT INTO audit_traces (trace_id, created_at) VALUES (?, ?)', ['trace-1', 'now']);
    tx.execute('INSERT INTO audit_entries (trace_id, sequence, type, data, at) VALUES (?, ?, ?, ?, ?)', ['trace-1', 1, 'one', '{}', 'now']);
  });
  assert.throws(() => {
    rawRun(join(dir, 'store.db'), 'INSERT INTO audit_entries (trace_id, sequence, type, data, at) VALUES (?, ?, ?, ?, ?)', ['trace-1', 1, 'two', '{}', 'now']);
  }, /UNIQUE constraint failed: audit_entries\.trace_id, audit_entries\.sequence/);
});

test('migration rerun is an idempotent no-op', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await store.migrate();
  await store.migrate();
  await store.migrate();
  assert.equal(await store.readSchemaVersion(), SCHEMA_VERSION);
  const rows = rawQuery(join(dir, 'store.db'), 'SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((row) => row.version), migrationDefinitions().map((definition) => definition.version));
});

test('migration checksum history exists and is stable', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  const inspection = await store.inspectSchema();
  const definitions = migrationDefinitions();
  assert.equal(inspection.migrations.length, definitions.length);
  assert.equal(inspection.migrations[0].version, definitions[0].version);
  assert.equal(inspection.migrations[0].name, definitions[0].name);
  assert.equal(inspection.migrations[0].checksum, definitions[0].checksum);
  assert.equal(inspection.migrations[1].version, definitions[1].version);
  assert.equal(inspection.migrations[1].name, definitions[1].name);
  assert.equal(inspection.migrations[1].checksum, definitions[1].checksum);
  assert.ok(inspection.migrations[0].checksum.length === 64);
  await store.close();
  const store2 = new SqlitePersistenceStore();
  await store2.open({ path: join(dir, 'store.db') });
  const reopened = await store2.inspectSchema();
  assert.equal(reopened.migrations[0].checksum, definitions[0].checksum);
  assert.equal(reopened.migrations[1].checksum, definitions[1].checksum);
  await store2.close();
});

test('migration checksum mismatch fails closed', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  rawRun(join(dir, 'store.db'), 'UPDATE schema_migrations SET checksum = ? WHERE version = 1', ['deadbeef']);
  await assert.rejects(() => store.migrate(), (error) => error instanceof MigrationError && error.code === 'MIGRATION_CHECKSUM_MISMATCH');
});

test('newer schema than runtime-supported fails closed', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  rawRun(
    join(dir, 'store.db'),
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    [SCHEMA_VERSION + 1, 'future', 'future-checksum', 'now'],
  );
  await assert.rejects(() => store.migrate(), (error) => error instanceof SchemaVersionError && error.code === 'NEWER_SCHEMA_UNSUPPORTED');
});

test('migration target newer than runtime-supported fails closed', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await assert.rejects(() => store.migrate(99), (error) => error.code === 'NEWER_SCHEMA_UNSUPPORTED');
});

test('migration to a lower version does not perform a destructive downgrade', async (t) => {
  const dir = makeTempDir(t);
  const store = await openMigratedStore(t, dir);
  await assert.rejects(() => store.migrate(0), (error) => error instanceof MigrationError && error.code === 'DOWNGRADE_NOT_SUPPORTED');
  assert.equal(await store.readSchemaVersion(), SCHEMA_VERSION);
});

test('database file can close and reopen; version and history survive object recreation', async (t) => {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'store.db');
  const first = new SqlitePersistenceStore();
  await first.open({ path: dbPath });
  await first.migrate();
  await first.close();
  assert.equal(first.isOpen, false);

  const second = new SqlitePersistenceStore();
  await second.open({ path: dbPath });
  assert.equal(await second.readSchemaVersion(), SCHEMA_VERSION);
  const inspection = await second.inspectSchema();
  assert.equal(inspection.migrations.length, migrationDefinitions().length);
  assert.equal(inspection.migrations[0].version, 1);
  assert.equal(inspection.migrations[0].checksum, migrationDefinitions()[0].checksum);
  await second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('close is idempotent-safe with deterministic semantics', async (t) => {
  const dir = makeTempDir(t);
  const store = new SqlitePersistenceStore();
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.open({ path: join(dir, 'store.db') });
  await store.migrate();
  assert.deepEqual(await store.close(), { closed: true, alreadyClosed: false });
  assert.deepEqual(await store.close(), { closed: false, alreadyClosed: true });
  await assert.rejects(() => store.readSchemaVersion(), (error) => error instanceof StoreClosedError && error.code === 'STORE_CLOSED');
  await assert.rejects(() => store.inspectSchema(), (error) => error.code === 'STORE_CLOSED');
});

test('test temp database and WAL/SHM artifacts are cleaned up', async (t) => {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'store.db');
  const store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  await store.migrate();
  assert.equal(existsSync(dbPath), true);
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});
