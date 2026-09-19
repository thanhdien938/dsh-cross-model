/**
 * Persistence layer — SQLite reference store.
 *
 * This is the first reference implementation of the persistence contract. It
 * is a substrate only: no AgentBus/Workflow/Peer/PM runtime state is wired in
 * yet. Orchestration code must consume it through the persistence contract in
 * `../persistence-contract.mjs`, never through this driver directly.
 *
 * SQLite-specific semantics proven here:
 *   - WAL journal mode + foreign_keys=ON on open.
 *   - one logical local writer assumption (no distributed locking).
 *   - real transaction rollback: a throwing callback rolls back every write.
 *   - explicit database directory creation.
 *   - deterministic close semantics (idempotent-safe).
 *   - fail-closed schema migration/version behavior.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { PersistenceError, PersistenceStoreError, StoreClosedError, SchemaVersionError, MigrationError } from '../persistence-errors.mjs';
import { assertPersistenceContract } from '../persistence-contract.mjs';
import { SCHEMA_VERSION, MIGRATION_BOOTSTRAP_SQL, migrationDefinitions } from './migrations.mjs';

export class SqlitePersistenceStore {
  #db = null;
  #path = null;

  /** @returns {boolean} whether the store currently holds an open database. */
  get isOpen() {
    return this.#db !== null;
  }

  /** @returns {string|null} the database path this store is bound to. */
  get path() {
    return this.#path;
  }

  #requireOpen() {
    if (this.#db === null) throw new StoreClosedError();
  }

  /**
   * Open (or create) the SQLite database at an explicit caller path.
   * @param {object} options
   * @param {string} options.path - absolute path to the database file.
   * @param {string} [options.journalMode='WAL']
   * @param {boolean} [options.foreignKeys=true]
   * @param {number} [options.busyTimeoutMs=5000]
   */
  async open({ path, journalMode = 'WAL', foreignKeys = true, busyTimeoutMs = 5000 } = {}) {
    if (this.#db !== null) throw new PersistenceStoreError('persistence store is already open', { code: 'STORE_ALREADY_OPEN' });
    if (typeof path !== 'string' || path.trim() === '') {
      throw new PersistenceStoreError('persistence store requires an explicit database path', { code: 'INVALID_DATABASE_PATH' });
    }
    if (typeof journalMode !== 'string' || journalMode === '') {
      throw new PersistenceStoreError('journalMode must be a non-empty string', { code: 'INVALID_JOURNAL_MODE' });
    }
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new PersistenceStoreError('busyTimeoutMs must be a non-negative integer', { code: 'INVALID_BUSY_TIMEOUT' });
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new PersistenceStoreError(`cannot create database directory: ${error.message}`, { code: 'DATABASE_DIRECTORY_CREATE_FAILED', cause: error });
    }

    let db;
    try {
      db = new Database(path);
      db.pragma(`journal_mode = ${journalMode}`);
      if (foreignKeys) db.pragma('foreign_keys = ON');
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      db.exec(MIGRATION_BOOTSTRAP_SQL);
    } catch (error) {
      try { db?.close(); } catch {}
      throw new PersistenceStoreError(`cannot open sqlite database at "${path}": ${error.message}`, {
        code: 'DATABASE_OPEN_FAILED',
        cause: error,
      });
    }

    this.#db = db;
    this.#path = path;
    return this;
  }

  /**
   * Close the database. Idempotent-safe: closing an already-closed store
   * resolves deterministically instead of throwing.
   * @returns {Promise<{ closed: boolean }>}
   */
  async close() {
    if (this.#db === null) return Object.freeze({ closed: false, alreadyClosed: true });
    this.#db.close();
    this.#db = null;
    this.#path = null;
    return Object.freeze({ closed: true, alreadyClosed: false });
  }

  /**
   * Run an atomic transaction. The callback receives a driver-neutral context
   * with a narrow `execute(sql, params)` primitive. If the callback throws,
   * every write in the transaction is rolled back. Async callbacks are
   * rejected because they cannot be rolled back atomically.
   * @template T
   * @param {(ctx: { execute: (sql: string, params?: unknown[]) => unknown }) => T} fn
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    this.#requireOpen();
    if (typeof fn !== 'function') throw new PersistenceError('transaction requires a function callback', { code: 'INVALID_TRANSACTION_CALLBACK' });
    const execute = (sql, params = []) => this.#db.prepare(sql).run(params);
    const runner = this.#db.transaction(() => {
      const result = fn(Object.freeze({ execute }));
      if (result !== null && result !== undefined && typeof result.then === 'function') {
        throw new PersistenceError('transaction callback must be synchronous; async callbacks cannot be rolled back atomically', {
          code: 'ASYNC_TRANSACTION_CALLBACK',
        });
      }
      return result;
    });
    return runner();
  }

  /**
   * Apply migrations up to `targetVersion` (defaults to the runtime-supported
   * schema version). Fail-closed rules:
   *   - unknown newer schema than the runtime supports -> NEWER_SCHEMA_UNSUPPORTED.
   *   - recorded migration checksum differs from the runtime definition -> MIGRATION_CHECKSUM_MISMATCH.
   *   - a target below the applied schema -> DOWNGRADE_NOT_SUPPORTED (no destructive downgrade).
   *   - re-running an already-applied migration is an idempotent no-op after checksum verification.
   * @param {number} [targetVersion]
   * @returns {Promise<number>} the schema version now applied.
   */
  async migrate(targetVersion = SCHEMA_VERSION) {
    this.#requireOpen();
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      throw new SchemaVersionError('migration target must be a non-negative integer', { code: 'INVALID_MIGRATION_TARGET' });
    }
    if (targetVersion > SCHEMA_VERSION) {
      throw new SchemaVersionError(`runtime supports schema v${SCHEMA_VERSION}; target v${targetVersion} is newer`, {
        code: 'NEWER_SCHEMA_UNSUPPORTED',
        supported: SCHEMA_VERSION,
        target: targetVersion,
      });
    }

    const current = await this.readSchemaVersion();
    if (current > SCHEMA_VERSION) {
      throw new SchemaVersionError(`database schema v${current} is newer than runtime-supported v${SCHEMA_VERSION}`, {
        code: 'NEWER_SCHEMA_UNSUPPORTED',
        supported: SCHEMA_VERSION,
        found: current,
      });
    }
    if (targetVersion < current) {
      throw new MigrationError(`migration target v${targetVersion} is lower than applied v${current}; destructive downgrade is not supported`, {
        code: 'DOWNGRADE_NOT_SUPPORTED',
        current,
        target: targetVersion,
      });
    }

    const definitions = migrationDefinitions();
    const byVersion = new Map(definitions.map((definition) => [definition.version, definition]));
    const recorded = this.#recordedMigrations();

    for (const row of recorded) {
      const definition = byVersion.get(row.version);
      if (!definition) {
        throw new MigrationError(`recorded migration v${row.version} is unknown to this runtime`, { code: 'UNKNOWN_RECORDED_MIGRATION', version: row.version });
      }
      if (definition.checksum !== row.checksum) {
        throw new MigrationError(`recorded migration v${row.version} checksum mismatch (expected ${definition.checksum}, found ${row.checksum})`, {
          code: 'MIGRATION_CHECKSUM_MISMATCH',
          version: row.version,
          expected: definition.checksum,
          found: row.checksum,
        });
      }
    }

    if (current >= targetVersion) return targetVersion;

    const pending = definitions
      .filter((definition) => definition.version > current && definition.version <= targetVersion)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return current;

    try {
      const run = this.#db.transaction(() => {
        const insert = this.#db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
        for (const definition of pending) {
          definition.up(this.#db);
          insert.run(definition.version, definition.name, definition.checksum, new Date().toISOString());
        }
      });
      run();
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new MigrationError(`migration to v${targetVersion} failed: ${error.message}`, { code: 'MIGRATION_FAILED', cause: error });
    }

    return targetVersion;
  }

  /** @returns {Promise<number>} the applied schema version (0 for an empty database). */
  async readSchemaVersion() {
    this.#requireOpen();
    const row = this.#db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return row?.version ?? 0;
  }

  /** @returns {object[]} recorded migration history rows. */
  #recordedMigrations() {
    this.#requireOpen();
    return this.#db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
  }

  /** @returns {string[]} table names excluding SQLite system tables. */
  #listTables() {
    this.#requireOpen();
    return this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
  }

  /**
   * Project-owned repository composition seam. Executes a write and returns
   * the driver-neutral run result. Synchronous because better-sqlite3 is
   * synchronous and project-owned repositories are synchronous peers of the
   * legacy in-memory StateStore. Callers must not import the driver API.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {object}
   */
  run(sql, params = []) {
    this.#requireOpen();
    return this.#db.prepare(sql).run(params);
  }

  /**
   * Repository composition seam. Reads at most one row.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {object|undefined}
   */
  get(sql, params = []) {
    this.#requireOpen();
    return this.#db.prepare(sql).get(params);
  }

  /**
   * Repository composition seam. Reads all matching rows.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {object[]}
   */
  all(sql, params = []) {
    this.#requireOpen();
    return this.#db.prepare(sql).all(params);
  }

  /**
   * Synchronous atomic transaction for project-owned repositories. The
   * callback receives a narrow `{ run, get, all }` context (no driver API).
   * If the callback throws, every write rolls back. Async callbacks are
   * rejected, mirroring {@link transaction}.
   * @template T
   * @param {(ctx: { run: Function, get: Function, all: Function }) => T} fn
   * @returns {T}
   */
  transactionSync(fn) {
    this.#requireOpen();
    if (typeof fn !== 'function') throw new PersistenceError('transactionSync requires a function callback', { code: 'INVALID_TRANSACTION_CALLBACK' });
    const reader = this.#db.prepare.bind(this.#db);
    const context = (sql, params = []) => reader(sql).run(params);
    const get = (sql, params = []) => reader(sql).get(params);
    const all = (sql, params = []) => reader(sql).all(params);
    return this.#db.transaction(() => fn(Object.freeze({ run: context, get, all })))();
  }

  /**
   * Integrity/schema inspection used by tests and recovery tooling.
   * @returns {Promise<object>} frozen inspection snapshot.
   */
  async inspectSchema() {
    this.#requireOpen();
    return Object.freeze({
      version: await this.readSchemaVersion(),
      journalMode: this.#db.pragma('journal_mode', { simple: true }),
      foreignKeys: this.#db.pragma('foreign_keys', { simple: true }) === 1,
      tables: Object.freeze(this.#listTables()),
      migrations: Object.freeze(this.#recordedMigrations().map((row) => Object.freeze({ ...row }))),
    });
  }

  /** @returns {boolean} whether this store satisfies the persistence contract. */
  get contract() {
    return assertPersistenceContract(this);
  }
}
