import { RECOVERY_CLASSIFICATIONS } from '../persistence/recovery/dispatch-attempt-protocol.mjs';
import { nativeProfileFingerprint, sanitizeNativeEvidence } from './native-profile.mjs';

export const NATIVE_RECONCILIATION_RESULTS = Object.freeze({
  RECONCILED: 'RECONCILED',
  NATIVE_SESSION_MISSING: 'NATIVE_SESSION_MISSING',
  PROFILE_MISMATCH: 'PROFILE_MISMATCH',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  RECONCILE_FAILED: 'RECONCILE_FAILED',
  OPERATOR_ACTION_REQUIRED: 'OPERATOR_ACTION_REQUIRED',
});

function plan(record) {
  return Object.freeze({ mode: 'fresh_dispatch', backend: record.backend, truthfulContinuity: false, executed: false });
}

function response(record, status, extra = {}) {
  return Object.freeze({ recordId: record?.id ?? null, status, nativeSessionId: record?.nativeSessionId ?? null, freshFallbackPlan: record ? plan(record) : null, ...extra });
}

function requiredProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return ['backend', 'product', 'version', 'transport'].every((key) => typeof profile[key] === 'string' && profile[key].trim() !== '');
}

function normalizedBridgeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'ambiguous', diagnostic: 'bridge returned a non-object result' };
  if (value.status === 'resumed' && value.usable === true) return { kind: 'resumed', result: sanitizeNativeEvidence(value) };
  if (value.status === 'missing') return { kind: 'missing', result: sanitizeNativeEvidence(value) };
  if (value.status === 'failed') return { kind: 'failed', result: sanitizeNativeEvidence(value) };
  return { kind: 'ambiguous', result: sanitizeNativeEvidence(value), diagnostic: 'bridge result did not prove resumed, missing, or failed' };
}

export class NativeSessionReconciler {
  #repository; #profileResolver; #uncertainCommits = new Set();

  constructor({ repository, profileResolver } = {}) {
    if (!repository || typeof repository.get !== 'function' || typeof repository.startReconcile !== 'function' || typeof repository.commitResult !== 'function' || typeof repository.findByAttemptId !== 'function') throw new TypeError('NativeSessionReconciler requires NativeSessionRepository contract');
    if (typeof profileResolver !== 'function') throw new TypeError('NativeSessionReconciler requires profileResolver(backend)');
    this.#repository = repository; this.#profileResolver = profileResolver;
  }

  async reconcile(recordId) {
    const record = this.#repository.get(recordId);
    if (this.#uncertainCommits.has(record.id)) return response(record, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, { reason: 'native resume succeeded but durable result commit is ambiguous', commitAmbiguous: true });
    if (record.status === 'RESUME_STARTED') return response(record, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, { persisted: true, reason: 'native resume boundary was crossed without committed result', commitAmbiguous: true });
    if (record.status !== 'PENDING') return response(record, record.status, { persisted: true, result: record.result });

    let profile;
    try { profile = this.#profileResolver(record.backend); }
    catch (error) { return response(record, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, { reason: 'current profile could not be resolved', diagnostic: String(sanitizeNativeEvidence(error?.message ?? String(error))) }); }
    if (!requiredProfile(profile) || profile.backend !== record.backend) return response(record, NATIVE_RECONCILIATION_RESULTS.PROFILE_MISMATCH, { reason: 'current backend profile is missing or mismatched' });
    for (const key of ['product', 'version', 'transport']) {
      if (profile[key] !== record[key]) return response(record, NATIVE_RECONCILIATION_RESULTS.PROFILE_MISMATCH, { reason: `current ${key} differs from captured evidence`, field: key });
    }
    if (profile.capabilities?.resume_existing !== 'PROVED') return response(record, NATIVE_RECONCILIATION_RESULTS.CAPABILITY_UNAVAILABLE, { reason: 'current profile does not prove resume_existing' });
    if (!profile.bridge || typeof profile.bridge.resume !== 'function') return response(record, NATIVE_RECONCILIATION_RESULTS.CAPABILITY_UNAVAILABLE, { reason: 'current bridge lacks resume()' });
    if (nativeProfileFingerprint(profile) !== record.capabilityFingerprint) return response(record, NATIVE_RECONCILIATION_RESULTS.PROFILE_MISMATCH, { reason: 'current capability/profile fingerprint differs from captured evidence', field: 'capabilityFingerprint' });

    this.#repository.startReconcile(record.id, new Date().toISOString());
    let normalized;
    try { normalized = normalizedBridgeResult(await profile.bridge.resume(record.nativeReference)); }
    catch (error) { normalized = { kind: 'ambiguous', diagnostic: error?.message ?? String(error) }; }

    const mapping = {
      resumed: ['RECONCILED', NATIVE_RECONCILIATION_RESULTS.RECONCILED],
      missing: ['NATIVE_SESSION_MISSING', NATIVE_RECONCILIATION_RESULTS.NATIVE_SESSION_MISSING],
      failed: ['RECONCILE_FAILED', NATIVE_RECONCILIATION_RESULTS.RECONCILE_FAILED],
      ambiguous: ['OPERATOR_ACTION_REQUIRED', NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED],
    };
    const [storedStatus, publicStatus] = mapping[normalized.kind];
    try {
      const committed = this.#repository.commitResult(record.id, { status: storedStatus, result: normalized.result ?? { status: normalized.kind }, diagnostic: normalized.diagnostic ?? normalized.result?.diagnostic ?? null, reconciledAt: new Date().toISOString() });
      return response(committed, publicStatus, { persisted: true, result: committed.result });
    } catch (error) {
      if (normalized.kind === 'resumed') {
        this.#uncertainCommits.add(record.id);
        return response(record, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, { reason: 'native resume succeeded but durable result commit failed', commitAmbiguous: true, diagnostic: String(sanitizeNativeEvidence(error?.message ?? String(error))) });
      }
      throw error;
    }
  }

  async reconcileGate3({ attempt, recovery } = {}) {
    if (!recovery || recovery.classification !== RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED) {
      return Object.freeze({ status: recovery?.classification ?? NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, gate3Classification: recovery?.classification ?? null, reconcilerCalled: false, autoReplayAllowed: false });
    }
    const record = this.#repository.findByAttemptId(attempt?.id);
    if (!record) return Object.freeze({ status: NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, gate3Classification: recovery.classification, reconcilerCalled: true, autoReplayAllowed: false, reason: 'no canonical native record for dispatch attempt' });
    const lineageMismatch = record.dispatchAttemptId !== attempt?.id
      || record.runId !== attempt?.runId
      || (attempt?.taskId != null && record.taskId != null && record.taskId !== attempt.taskId);
    if (lineageMismatch) return Object.freeze({ status: NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED, gate3Classification: recovery.classification, reconcilerCalled: true, autoReplayAllowed: false, reason: 'native evidence lineage mismatch' });
    const result = await this.reconcile(record.id);
    return Object.freeze({ ...result, gate3Classification: recovery.classification, reconcilerCalled: true, autoReplayAllowed: false });
  }
}
