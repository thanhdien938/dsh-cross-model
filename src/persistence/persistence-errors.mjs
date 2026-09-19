/**
 * Persistence layer — typed error hierarchy.
 *
 * All persistence failures surface through these classes so orchestration and
 * recovery tooling can branch on stable `code` values instead of string
 * matching. Error codes are contract surface, not SQLite-specific.
 */

export class PersistenceError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PersistenceError';
    Object.assign(this, extra);
  }
}

export class PersistenceStoreError extends PersistenceError {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PersistenceStoreError';
    Object.assign(this, extra);
  }
}

export class StoreClosedError extends PersistenceError {
  constructor(message = 'persistence store is closed') {
    super(message);
    this.name = 'StoreClosedError';
    this.code = 'STORE_CLOSED';
  }
}

export class SchemaVersionError extends PersistenceError {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SchemaVersionError';
    Object.assign(this, extra);
  }
}

export class MigrationError extends PersistenceError {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'MigrationError';
    Object.assign(this, extra);
  }
}
