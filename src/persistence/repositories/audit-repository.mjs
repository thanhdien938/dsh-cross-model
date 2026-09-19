/** Sole SQL owner for durable orchestration audit traces. */

import { PersistenceError } from '../persistence-errors.mjs';

const STORE_SEAM_METHODS = Object.freeze(['run', 'get', 'all', 'transactionSync']);

export class AuditPersistenceError extends PersistenceError {
  constructor(message, extra = {}) {
    super(message, extra);
    this.name = 'AuditPersistenceError';
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseData(value, traceId, sequence) {
  try {
    return deepFreeze(JSON.parse(value));
  } catch (error) {
    throw new AuditPersistenceError(`corrupt audit JSON for ${traceId} sequence ${sequence}`, {
      code: 'CORRUPT_AUDIT_DATA', traceId, sequence, cause: error,
    });
  }
}

function rowToEntry(row) {
  if (typeof row.type !== 'string' || row.type.trim() === '') {
    throw new AuditPersistenceError(`invalid audit type for ${row.trace_id} sequence ${row.sequence}`, {
      code: 'CORRUPT_AUDIT_HISTORY', traceId: row.trace_id, sequence: row.sequence,
    });
  }
  if (typeof row.at !== 'string' || row.at.trim() === '') {
    throw new AuditPersistenceError(`invalid audit timestamp for ${row.trace_id} sequence ${row.sequence}`, {
      code: 'CORRUPT_AUDIT_HISTORY', traceId: row.trace_id, sequence: row.sequence,
    });
  }
  return Object.freeze({
    traceId: row.trace_id,
    sequence: row.sequence,
    timestamp: row.at,
    type: row.type,
    data: parseData(row.data, row.trace_id, row.sequence),
  });
}

function requireType(type) {
  if (typeof type !== 'string' || type.trim() === '') throw new TypeError('audit trace type must be non-empty');
}

function requireTimestamp(timestamp) {
  const value = String(timestamp);
  if (value.trim() === '') throw new TypeError('audit timestamp must be non-empty');
  return value;
}

function serializeSafeData(data) {
  try {
    return JSON.stringify(data);
  } catch (error) {
    throw new AuditPersistenceError(`sanitized audit data is not serializable: ${error.message}`, {
      code: 'INVALID_AUDIT_DATA', cause: error,
    });
  }
}

export class AuditRepository {
  constructor({ store } = {}) {
    if (store === null || typeof store !== 'object') throw new TypeError('AuditRepository requires a persistence store');
    const missing = STORE_SEAM_METHODS.filter((name) => typeof store[name] !== 'function');
    if (missing.length > 0) throw new TypeError(`AuditRepository requires a store with repository seams; missing: ${missing.join(', ')}`);
    this.store = store;
  }

  createTrace(traceId, createdAt) {
    if (typeof traceId !== 'string' || traceId.trim() === '') throw new TypeError('traceId must be a non-empty string');
    try {
      this.store.run('INSERT INTO audit_traces (trace_id, sealed, created_at) VALUES (?, 0, ?)', [traceId, String(createdAt)]);
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
        throw new AuditPersistenceError(`audit trace already exists: ${traceId}`, {
          code: 'AUDIT_TRACE_EXISTS', traceId, cause: error,
        });
      }
      throw error;
    }
    return this.loadTrace(traceId);
  }

  loadTrace(traceId) {
    const trace = this.store.get('SELECT trace_id, sealed, created_at FROM audit_traces WHERE trace_id = ?', [traceId]);
    if (!trace) throw new AuditPersistenceError(`unknown audit trace: ${traceId}`, { code: 'UNKNOWN_AUDIT_TRACE', traceId });
    if (trace.sealed !== 0 && trace.sealed !== 1) {
      throw new AuditPersistenceError(`invalid sealed flag for audit trace ${traceId}`, {
        code: 'CORRUPT_AUDIT_HISTORY', traceId,
      });
    }
    const rows = this.store.all(
      'SELECT trace_id, sequence, type, data, at FROM audit_entries WHERE trace_id = ? ORDER BY sequence',
      [traceId],
    );
    const entries = rows.map(rowToEntry);
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].sequence !== index + 1) {
        throw new AuditPersistenceError(`non-contiguous audit sequence for ${traceId}`, {
          code: 'CORRUPT_AUDIT_HISTORY', traceId, expected: index + 1, found: entries[index].sequence,
        });
      }
    }
    const sealIndexes = entries.flatMap((entry, index) => entry.type === 'trace.sealed' ? [index] : []);
    if (trace.sealed === 1 && (sealIndexes.length !== 1 || sealIndexes[0] !== entries.length - 1)) {
      throw new AuditPersistenceError(`sealed audit trace ${traceId} has impossible seal history`, {
        code: 'CORRUPT_AUDIT_HISTORY', traceId,
      });
    }
    if (trace.sealed === 0 && sealIndexes.length > 0) {
      throw new AuditPersistenceError(`unsealed audit trace ${traceId} contains a seal entry`, {
        code: 'CORRUPT_AUDIT_HISTORY', traceId,
      });
    }
    return Object.freeze({
      traceId,
      sealed: trace.sealed === 1,
      createdAt: trace.created_at,
      entries: Object.freeze(entries),
    });
  }

  append(traceId, { type, data, timestamp }) {
    requireType(type);
    const at = requireTimestamp(timestamp);
    const dataJson = serializeSafeData(data);
    return this.store.transactionSync(({ get, run }) => {
      const trace = get('SELECT trace_id, sealed FROM audit_traces WHERE trace_id = ?', [traceId]);
      if (!trace) throw new AuditPersistenceError(`unknown audit trace: ${traceId}`, { code: 'UNKNOWN_AUDIT_TRACE', traceId });
      if (trace.sealed !== 0 && trace.sealed !== 1) throw new AuditPersistenceError(`invalid sealed flag for audit trace ${traceId}`, { code: 'CORRUPT_AUDIT_HISTORY', traceId });
      if (trace.sealed === 1) throw new AuditPersistenceError(`audit trace ${traceId} is sealed`, { code: 'AUDIT_TRACE_SEALED', traceId });
      const current = get('SELECT MAX(sequence) AS max_sequence FROM audit_entries WHERE trace_id = ?', [traceId]);
      const sequence = (current?.max_sequence ?? 0) + 1;
      run('INSERT INTO audit_entries (trace_id, sequence, type, data, at) VALUES (?, ?, ?, ?, ?)', [traceId, sequence, type, dataJson, at]);
      return Object.freeze({ traceId, sequence, timestamp: at, type, data });
    });
  }

  seal(traceId, { data, timestamp }) {
    const at = requireTimestamp(timestamp);
    const dataJson = serializeSafeData(data);
    return this.store.transactionSync(({ get, run }) => {
      const trace = get('SELECT trace_id, sealed FROM audit_traces WHERE trace_id = ?', [traceId]);
      if (!trace) throw new AuditPersistenceError(`unknown audit trace: ${traceId}`, { code: 'UNKNOWN_AUDIT_TRACE', traceId });
      if (trace.sealed !== 0 && trace.sealed !== 1) throw new AuditPersistenceError(`invalid sealed flag for audit trace ${traceId}`, { code: 'CORRUPT_AUDIT_HISTORY', traceId });
      if (trace.sealed === 1) return Object.freeze({ alreadySealed: true, entry: null });
      const current = get('SELECT MAX(sequence) AS max_sequence FROM audit_entries WHERE trace_id = ?', [traceId]);
      const sequence = (current?.max_sequence ?? 0) + 1;
      run('INSERT INTO audit_entries (trace_id, sequence, type, data, at) VALUES (?, ?, ?, ?, ?)', [traceId, sequence, 'trace.sealed', dataJson, at]);
      run('UPDATE audit_traces SET sealed = 1 WHERE trace_id = ?', [traceId]);
      return Object.freeze({
        alreadySealed: false,
        entry: Object.freeze({ traceId, sequence, timestamp: at, type: 'trace.sealed', data }),
      });
    });
  }

  countEntries(traceId) {
    return this.store.get('SELECT COUNT(*) AS count FROM audit_entries WHERE trace_id = ?', [traceId]).count;
  }

  maxSequence(traceId) {
    return this.store.get('SELECT MAX(sequence) AS max_sequence FROM audit_entries WHERE trace_id = ?', [traceId]).max_sequence ?? 0;
  }
}
