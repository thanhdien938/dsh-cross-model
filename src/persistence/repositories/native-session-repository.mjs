/** Sole SQL owner for durable native-session reconciliation evidence. */
import { PersistenceError } from '../persistence-errors.mjs';
import { assertJsonFaithful, parseDurable, serializeDurable } from './json-durable.mjs';
import { sanitizeNativeEvidence } from '../../session/native-profile.mjs';

export const NATIVE_RECONCILIATION_STATUSES = Object.freeze(['PENDING', 'RESUME_STARTED', 'RECONCILED', 'NATIVE_SESSION_MISSING', 'RECONCILE_FAILED', 'OPERATOR_ACTION_REQUIRED']);
const TERMINAL = new Set(NATIVE_RECONCILIATION_STATUSES.filter((status) => status !== 'PENDING' && status !== 'RESUME_STARTED'));

export class NativeSessionPersistenceError extends PersistenceError {
  constructor(message, extra = {}) { super(message, extra); this.name = 'NativeSessionPersistenceError'; }
}

function corrupt(message, extra = {}) { throw new NativeSessionPersistenceError(message, { code: 'CORRUPT_NATIVE_SESSION', ...extra }); }
function required(value, label) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`); return value; }
function parse(json, label) { try { return parseDurable(json, label); } catch (cause) { throw new NativeSessionPersistenceError(`corrupt ${label}`, { code: 'CORRUPT_NATIVE_SESSION', cause }); } }

export class NativeSessionRepository {
  constructor({ store, knownBackends } = {}) {
    if (!store || typeof store.run !== 'function' || typeof store.get !== 'function' || typeof store.transactionSync !== 'function') throw new TypeError('NativeSessionRepository requires a persistence store');
    if (!Array.isArray(knownBackends) || knownBackends.length === 0) throw new TypeError('NativeSessionRepository requires knownBackends');
    this.store = store; this.knownBackends = new Set(knownBackends);
  }

  capture(record) {
    required(record.id, 'native record id'); required(record.backend, 'backend'); required(record.nativeSessionId, 'nativeSessionId');
    required(record.product, 'product'); required(record.version, 'version'); required(record.transport, 'transport'); required(record.capabilityFingerprint, 'capabilityFingerprint');
    if (!this.knownBackends.has(record.backend)) throw new NativeSessionPersistenceError(`unknown native backend: ${record.backend}`, { code: 'UNKNOWN_NATIVE_BACKEND' });
    assertJsonFaithful(record.nativeReference ?? { nativeSessionId: record.nativeSessionId }, 'native reference');
    assertJsonFaithful(record.lineage ?? {}, 'native lineage');
    const reference = sanitizeNativeEvidence(record.nativeReference ?? { nativeSessionId: record.nativeSessionId });
    if (reference.nativeSessionId !== undefined && reference.nativeSessionId !== record.nativeSessionId) throw new NativeSessionPersistenceError('native session id resembles unsafe credential material', { code: 'SENSITIVE_NATIVE_REFERENCE' });
    this.store.run('INSERT INTO native_sessions (id, record_version, backend, native_session_id, product, version, created_at, last_seen_at, lineage, native_reference, task_id, run_id, dispatch_attempt_id, transport, capability_fingerprint, reconciliation_status, reconciliation_result, diagnostic, reconciled_at, revision) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)', [record.id, record.backend, record.nativeSessionId, record.product, record.version, record.capturedAt, record.capturedAt, serializeDurable(sanitizeNativeEvidence(record.lineage ?? {}), 'native lineage'), serializeDurable(reference, 'native reference'), record.taskId ?? null, record.runId ?? null, record.dispatchAttemptId ?? null, record.transport, record.capabilityFingerprint, 'PENDING']);
    return this.get(record.id);
  }

  get(id) {
    const row = this.store.get('SELECT * FROM native_sessions WHERE id = ?', [id]);
    if (!row) throw new NativeSessionPersistenceError(`unknown native session record: ${id}`, { code: 'UNKNOWN_NATIVE_SESSION_RECORD' });
    return this.#hydrate(row);
  }

  findByAttemptId(attemptId) {
    const row = this.store.get('SELECT * FROM native_sessions WHERE dispatch_attempt_id = ?', [attemptId]);
    return row ? this.#hydrate(row) : null;
  }

  startReconcile(id, startedAt) {
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT reconciliation_status FROM native_sessions WHERE id = ?', [id]);
      if (!row) throw new NativeSessionPersistenceError(`unknown native session record: ${id}`, { code: 'UNKNOWN_NATIVE_SESSION_RECORD' });
      if (row.reconciliation_status !== 'PENDING') throw new NativeSessionPersistenceError(`native reconciliation already crossed boundary: ${row.reconciliation_status}`, { code: 'NATIVE_RECONCILIATION_ALREADY_STARTED' });
      run('UPDATE native_sessions SET reconciliation_status = ?, last_seen_at = ?, revision = revision + 1 WHERE id = ?', ['RESUME_STARTED', startedAt, id]);
      return this.get(id);
    });
  }

  commitResult(id, { status, result = null, diagnostic = null, reconciledAt } = {}) {
    if (!TERMINAL.has(status)) throw new TypeError(`invalid terminal reconciliation status: ${status}`);
    const safeResult = sanitizeNativeEvidence(result);
    const safeDiagnostic = diagnostic === null ? null : String(sanitizeNativeEvidence(String(diagnostic))).slice(0, 500);
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT reconciliation_status, reconciliation_result FROM native_sessions WHERE id = ?', [id]);
      if (!row) throw new NativeSessionPersistenceError(`unknown native session record: ${id}`, { code: 'UNKNOWN_NATIVE_SESSION_RECORD' });
      if (TERMINAL.has(row.reconciliation_status)) {
        if (row.reconciliation_status !== status) throw new NativeSessionPersistenceError('conflicting native reconciliation finalization', { code: 'NATIVE_RECONCILIATION_CONFLICT' });
        return this.get(id);
      }
      if (row.reconciliation_status !== 'RESUME_STARTED') corrupt(`invalid reconciliation result transition: ${row.reconciliation_status}`);
      run('UPDATE native_sessions SET reconciliation_status = ?, reconciliation_result = ?, diagnostic = ?, reconciled_at = ?, last_seen_at = ?, revision = revision + 1 WHERE id = ?', [status, safeResult === null ? null : serializeDurable(safeResult, 'native reconciliation result'), safeDiagnostic, reconciledAt, reconciledAt, id]);
      return this.get(id);
    });
  }

  #hydrate(row) {
    if (!this.knownBackends.has(row.backend)) corrupt(`unknown native backend: ${row.backend}`);
    for (const [value, label] of [[row.native_session_id, 'native session id'], [row.product, 'product'], [row.version, 'version'], [row.transport, 'transport'], [row.capability_fingerprint, 'capability fingerprint']]) required(value, label);
    if (!NATIVE_RECONCILIATION_STATUSES.includes(row.reconciliation_status)) corrupt(`invalid reconciliation status: ${row.reconciliation_status}`);
    if (!Number.isInteger(row.revision) || row.revision < 1) corrupt(`invalid native revision: ${row.revision}`);
    if (typeof row.native_reference !== 'string') corrupt('missing structured native reference');
    const nativeReference = parse(row.native_reference, 'native reference');
    if (!nativeReference || typeof nativeReference !== 'object' || Array.isArray(nativeReference)) corrupt('invalid structured native reference');
    if (nativeReference.nativeSessionId !== undefined && nativeReference.nativeSessionId !== row.native_session_id) corrupt('native reference/session mismatch');
    const result = row.reconciliation_result === null ? null : parse(row.reconciliation_result, 'native reconciliation result');
    if (row.reconciliation_status === 'PENDING' && (row.reconciliation_result !== null || row.reconciled_at !== null)) corrupt('pending native record carries terminal evidence');
    if (row.reconciliation_status === 'RESUME_STARTED' && (row.reconciliation_result !== null || row.reconciled_at !== null)) corrupt('started native reconciliation carries uncommitted terminal evidence');
    if (TERMINAL.has(row.reconciliation_status) && result !== null && (typeof result !== 'object' || Array.isArray(result))) corrupt('terminal native record carries invalid result evidence');
    if (row.reconciliation_status === 'RECONCILED' && (result?.status !== 'resumed' || result?.usable !== true || row.reconciled_at === null)) corrupt('reconciled native record lacks positive usable evidence');
    if (row.reconciliation_status === 'NATIVE_SESSION_MISSING' && result !== null && result?.status !== 'missing') corrupt('missing native session carries contradictory terminal evidence');
    if (row.reconciliation_status === 'RECONCILE_FAILED' && result !== null && result?.status !== 'failed') corrupt('failed native reconciliation carries contradictory terminal evidence');
    if (row.reconciliation_status === 'OPERATOR_ACTION_REQUIRED' && result?.status === 'resumed' && result?.usable === true) corrupt('operator-required native reconciliation carries positive usable evidence');
    if (TERMINAL.has(row.reconciliation_status) && row.reconciled_at === null) corrupt('terminal native record lacks timestamp');
    return Object.freeze({ id: row.id, backend: row.backend, nativeSessionId: row.native_session_id, nativeReference: Object.freeze(nativeReference), product: row.product, version: row.version, transport: row.transport, capabilityFingerprint: row.capability_fingerprint, taskId: row.task_id, runId: row.run_id, dispatchAttemptId: row.dispatch_attempt_id, capturedAt: row.created_at, updatedAt: row.last_seen_at, status: row.reconciliation_status, result, diagnostic: row.diagnostic, reconciledAt: row.reconciled_at, revision: row.revision });
  }
}
