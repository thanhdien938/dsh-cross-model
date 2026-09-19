import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';

const dsn = process.env.DSH_CI_POSTGRES_DSN;

function runMigration(connectionString) {
  return spawnSync(process.execPath, ['scripts/coordination-migrate.mjs', '--dsn-env', 'DSH_R5_OPERATOR_DSN'], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_R5_OPERATOR_DSN: connectionString },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('P15-B-008 supported command bootstraps a fresh PostgreSQL schema and is idempotent', { skip: !dsn }, async (t) => {
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  const store = await new PostgresCoordinationStore().open({ connectionString: dsn });
  t.after(async () => {
    await store.close();
    await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
    await admin.end();
  });

  await assert.rejects(store.assertReady(), (error) => error.code === 'COORDINATION_SCHEMA_NOT_READY');
  const first = runMigration(dsn);
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.status, 'PASS');
  assert.equal(firstResult.schemaVersion, COORDINATION_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(firstResult.target), ['protocol', 'username', 'host', 'port', 'database']);
  assert.equal(Object.hasOwn(firstResult.target, 'password'), false);
  assert.equal(first.stdout.includes(dsn), false);
  assert.equal(await store.assertReady(), true);

  await admin.query("INSERT INTO dsh_coordination.schema_migrations(version,name,checksum) SELECT version,name,checksum FROM dsh_coordination.schema_migrations WHERE false");
  const before = await admin.query('SELECT version,name,checksum,applied_at FROM dsh_coordination.schema_migrations ORDER BY version');
  const second = runMigration(dsn);
  assert.equal(second.status, 0, second.stderr);
  const after = await admin.query('SELECT version,name,checksum,applied_at FROM dsh_coordination.schema_migrations ORDER BY version');
  assert.deepEqual(after.rows, before.rows);
});

test('PostgreSQL bootstrap reports a typed permission failure', { skip: !dsn }, async (t) => {
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  const role = `dsh_r5_no_ddl_${process.pid}`;
  const password = `r5-${process.pid}-secret`;
  await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
  await admin.query(`REVOKE CREATE ON DATABASE ${pg.escapeIdentifier(database)} FROM PUBLIC`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO ${pg.escapeIdentifier(role)}`);
  t.after(async () => {
    await admin.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
    await admin.query(`DROP OWNED BY ${pg.escapeIdentifier(role)}`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(role)}`);
    await admin.query(`GRANT CREATE ON DATABASE ${pg.escapeIdentifier(database)} TO PUBLIC`);
    await admin.end();
  });

  const restricted = new URL(dsn);
  restricted.username = role;
  restricted.password = password;
  const result = runMigration(restricted.href);
  assert.notEqual(result.status, 0);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'FAIL');
  assert.equal(failure.code, 'COORDINATION_MIGRATION_PERMISSION_DENIED');
  assert.equal(result.stderr.includes(password), false);
});
