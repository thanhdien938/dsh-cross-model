/**
 * Persistence layer — project-owned persistence contract.
 *
 * Orchestration code depends on this contract, never on a concrete driver
 * (SQLite or otherwise). The contract is intentionally driver-neutral: no
 * `better-sqlite3` type or import may appear here or leak into callers.
 *
 * A conforming store exposes:
 *   - open({ path, ...options })          initialize/open the store.
 *   - close()                             close deterministically (idempotent-safe).
 *   - transaction(fn)                     run an atomic transaction.
 *   - migrate(targetVersion?)             apply migrations up to a version.
 *   - readSchemaVersion()                 current applied schema version (0 = none).
 *   - inspectSchema()                     integrity/schema inspection for tests + recovery.
 *
 * Transaction callbacks receive a driver-neutral execution context exposing
 * `execute(sql, params)` only. Async callbacks are rejected: SQLite transactions
 * are synchronous, and an async callback cannot be rolled back atomically.
 */

import { PersistenceError } from './persistence-errors.mjs';

export const PERSISTENCE_CONTRACT_METHODS = Object.freeze([
  'open',
  'close',
  'transaction',
  'migrate',
  'readSchemaVersion',
  'inspectSchema',
]);

/**
 * Assert a store satisfies the persistence contract.
 * @param {unknown} store
 * @returns {true} when the store conforms.
 * @throws {PersistenceError} with code `INVALID_PERSISTENCE_STORE` when it does not.
 */
export function assertPersistenceContract(store) {
  if (store === null || typeof store !== 'object') {
    throw new PersistenceError('persistence store must be an object', {
      code: 'INVALID_PERSISTENCE_STORE',
      missing: PERSISTENCE_CONTRACT_METHODS,
    });
  }
  const missing = PERSISTENCE_CONTRACT_METHODS.filter((name) => typeof store[name] !== 'function');
  if (missing.length > 0) {
    throw new PersistenceError(`persistence store missing required members: ${missing.join(', ')}`, {
      code: 'INVALID_PERSISTENCE_STORE',
      missing,
    });
  }
  return true;
}

/** @returns {boolean} whether `store` conforms to the persistence contract. */
export function isPersistenceStore(store) {
  try {
    assertPersistenceContract(store);
    return true;
  } catch {
    return false;
  }
}
