#!/usr/bin/env node
import process from 'node:process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { SCHEMA_VERSION, SCHEMA_V1_TABLES, migrationDefinitions } from '../src/persistence/sqlite/migrations.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g1-smoke-'));
const dbPath = join(dir, 'smoke.db');

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` });
  }
}

async function main() {
  const store = new SqlitePersistenceStore();

  await check('store opens a real temp file', async () => {
    await store.open({ path: dbPath });
    if (!store.isOpen) throw new Error('store not open');
    return store.path;
  });

  await check('schema 0 -> v1 with all 22 logical tables', async () => {
    const before = await store.readSchemaVersion();
    if (before !== 0) throw new Error(`expected 0, got ${before}`);
    await store.migrate();
    const inspection = await store.inspectSchema();
    if (inspection.version !== SCHEMA_VERSION) throw new Error(`expected v${SCHEMA_VERSION}, got v${inspection.version}`);
    if (inspection.tables.length !== SCHEMA_V1_TABLES.length) throw new Error(`expected ${SCHEMA_V1_TABLES.length} tables, got ${inspection.tables.length}`);
    for (const table of SCHEMA_V1_TABLES) {
      if (!inspection.tables.includes(table)) throw new Error(`missing table ${table}`);
    }
    return `v${inspection.version}/${inspection.tables.length} tables`;
  });

  await check('WAL + foreign keys are active', async () => {
    const inspection = await store.inspectSchema();
    if (inspection.journalMode !== 'wal') throw new Error(`journal=${inspection.journalMode}`);
    if (inspection.foreignKeys !== true) throw new Error('foreign_keys off');
    return `${inspection.journalMode}/fk=${inspection.foreignKeys}`;
  });

  await check('thrown transaction rolls back atomically', async () => {
    try {
      await store.transaction((tx) => {
        tx.execute('INSERT INTO orchestrator_instances (id, created_at) VALUES (?, ?)', ['smoke-1', 'now']);
        throw new Error('smoke rollback');
      });
    } catch (error) {
      if (error.message !== 'smoke rollback') throw error;
    }
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe.prepare('SELECT id FROM orchestrator_instances WHERE id = ?').all(['smoke-1']);
      if (rows.length !== 0) throw new Error('write survived rollback');
      return 'rolled back';
    } finally {
      probe.close();
    }
  });

  await check('close/reopen retains v1 migration truth', async () => {
    const firstChecksum = (await store.inspectSchema()).migrations[0]?.checksum;
    await store.close();
    const reopened = new SqlitePersistenceStore();
    await reopened.open({ path: dbPath });
    const inspection = await reopened.inspectSchema();
    if (inspection.version !== SCHEMA_VERSION) throw new Error(`version ${inspection.version}`);
    if (inspection.migrations[0]?.checksum !== migrationDefinitions()[0].checksum) throw new Error('checksum drifted');
    if (firstChecksum !== inspection.migrations[0].checksum) throw new Error('checksum changed across reopen');
    await reopened.close();
    return `v${inspection.version}/${inspection.migrations.length} migration`;
  });

  await check('newer-schema fail-closed path is deterministic', async () => {
    const futurePath = join(dir, 'future.db');
    const future = new SqlitePersistenceStore();
    await future.open({ path: futurePath });
    await future.migrate();
    await future.close();
    const tamper = new Database(futurePath);
    tamper.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(SCHEMA_VERSION + 1, 'future', 'future-checksum', 'now');
    tamper.close();
    const reader = new SqlitePersistenceStore();
    await reader.open({ path: futurePath });
    let thrown = null;
    try {
      await reader.migrate();
    } catch (error) {
      thrown = error;
    }
    await reader.close();
    if (thrown?.code !== 'NEWER_SCHEMA_UNSUPPORTED') throw new Error(`expected NEWER_SCHEMA_UNSUPPORTED, got ${thrown?.code ?? 'no throw'}`);
    return thrown.code;
  });

  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
  const passed = checks.filter((entry) => entry.ok).length;
  console.log(`P2-GATE1: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`P2-GATE1: fatal ${error.name}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
