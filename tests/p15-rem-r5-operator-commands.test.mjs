import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { snapshotSqliteDatabase } from '../scripts/sqlite-snapshot.mjs';
import { describePostgresTarget } from '../scripts/coordination-migrate.mjs';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-r5-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('P15-B-003 proves a SQLite WAL main-file-only copy can omit committed rows', (t) => {
  const directory = tempDir(t);
  const sourcePath = join(directory, 'source.sqlite');
  const naivePath = join(directory, 'naive.sqlite');
  const source = new Database(sourcePath);
  source.pragma('journal_mode = WAL');
  source.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  source.pragma('wal_checkpoint(TRUNCATE)');
  source.prepare('INSERT INTO records(value) VALUES (?)').run('committed-only-in-wal');
  assert.equal(existsSync(`${sourcePath}-wal`), true);

  copyFileSync(sourcePath, naivePath);
  const naive = new Database(naivePath, { readonly: true });
  assert.equal(naive.prepare('SELECT COUNT(*) AS count FROM records').get().count, 0);
  naive.close();
  source.close();
});

test('supported operator snapshot is self-contained and restorable with WAL-active writes and a live reader', async (t) => {
  const directory = tempDir(t);
  const sourcePath = join(directory, 'source.sqlite');
  const snapshotPath = join(directory, 'snapshot.sqlite');
  const source = new Database(sourcePath);
  const reader = new Database(sourcePath, { readonly: true });
  source.pragma('journal_mode = WAL');
  source.pragma('foreign_keys = ON');
  source.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL);
  `);
  source.pragma('wal_checkpoint(TRUNCATE)');
  source.prepare('INSERT INTO projects(id, name) VALUES (?, ?)').run(1, 'DSH');
  source.prepare('INSERT INTO tasks(id, project_id, title) VALUES (?, ?, ?)').run(1, 1, 'first');
  source.prepare('INSERT INTO tasks(id, project_id, title) VALUES (?, ?, ?)').run(2, 1, 'second');
  reader.exec('BEGIN');
  assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);

  const result = await snapshotSqliteDatabase({ sourcePath, destinationPath: snapshotPath });
  assert.equal(result.status, 'PASS');
  assert.equal(result.integrity, 'ok');
  assert.equal(result.foreignKeys, 'ok');
  assert.equal(result.journalMode, 'wal');
  assert.equal(existsSync(`${snapshotPath}-wal`), false);
  assert.equal(existsSync(`${snapshotPath}-shm`), false);

  const restored = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  t.after(() => restored.close());
  assert.deepEqual(restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), [
    { name: 'projects' },
    { name: 'tasks' },
  ]);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 1);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(restored.pragma('foreign_key_check'), []);
  restored.close();
  reader.close();
  source.close();
});

test('operator commands reject ambiguous/destructive inputs and never expose PostgreSQL passwords', async (t) => {
  const directory = tempDir(t);
  const sourcePath = join(directory, 'source.sqlite');
  const source = new Database(sourcePath);
  source.exec('CREATE TABLE records (id INTEGER PRIMARY KEY)');
  source.close();

  await assert.rejects(
    snapshotSqliteDatabase({ sourcePath, destinationPath: sourcePath }),
    (error) => error.code === 'SQLITE_SNAPSHOT_PATH_CONFLICT',
  );
  assert.deepEqual(describePostgresTarget('postgresql://operator:TOP_SECRET@db.internal:5433/dsh?sslmode=require'), {
    protocol: 'postgresql:',
    username: 'operator',
    host: 'db.internal',
    port: '5433',
    database: 'dsh',
  });
  assert.equal(JSON.stringify(describePostgresTarget('postgresql://operator:TOP_SECRET@db.internal/dsh')).includes('TOP_SECRET'), false);
});

test('PostgreSQL operator command fails clearly for missing and unreachable explicit targets', () => {
  const missing = spawnSync(process.execPath, ['scripts/coordination-migrate.mjs'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, 'COORDINATION_DSN_INPUT_REQUIRED');

  const unreachable = spawnSync(process.execPath, ['scripts/coordination-migrate.mjs', '--dsn-env', 'DSH_R5_UNREACHABLE_DSN'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_R5_UNREACHABLE_DSN: 'postgresql://operator:SECRET@127.0.0.1:1/dsh' },
    timeout: 15_000,
  });
  assert.equal(unreachable.status, 1);
  assert.equal(JSON.parse(unreachable.stderr).code, 'COORDINATION_CONNECTION_FAILED');
  assert.equal(unreachable.stderr.includes('SECRET'), false);
});

test('Desktop build configuration has no stale icon and dependency roles are explicit', () => {
  const desktopPackage = JSON.parse(readFileSync(resolve('desktop/package.json'), 'utf8'));
  assert.equal(desktopPackage.build.win.icon, undefined);
  assert.equal(desktopPackage.dependencies['better-sqlite3'], '9.6.0');
  assert.equal(desktopPackage.dependencies.pg, '8.16.3');
  assert.equal(desktopPackage.scripts['abi:check'].includes('check-native-abi-boundaries.mjs'), true);
});
