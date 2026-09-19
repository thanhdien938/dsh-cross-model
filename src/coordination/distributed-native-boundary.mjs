import { nativeProfileFingerprint, sanitizeNativeEvidence } from '../session/native-profile.mjs';
import { RECOVERY_CLASSIFICATIONS } from '../persistence/recovery/dispatch-attempt-protocol.mjs';

export class DistributedNativeBoundary {
  constructor({ coordinationStore, repository, profileResolver } = {}) { if (!coordinationStore || !repository || typeof profileResolver !== 'function') throw new TypeError('distributed native boundary dependencies are required'); this.coordination = coordinationStore; this.repository = repository; this.profileResolver = profileResolver; }
  async reconcile({ fence, lineage, recovery } = {}) {
    if (recovery?.classification !== RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED) return outcome('BLOCKED_CLASSIFICATION');
    const record = this.repository.findByAttemptId(lineage?.dispatch_attempt_id);
    if (!record || record.taskId !== lineage.task_id || record.runId !== lineage.run_id || record.dispatchAttemptId !== lineage.dispatch_attempt_id) return outcome('OPERATOR_ACTION_REQUIRED');
    if (record.status === 'RESUME_STARTED') return outcome('OPERATOR_ACTION_REQUIRED', { resumeRepeated: false });
    if (record.status !== 'PENDING') return outcome(record.status);
    const profile = this.profileResolver(record.backend);
    if (!profile || profile.backend !== record.backend || profile.product !== record.product || profile.version !== record.version || profile.transport !== record.transport || nativeProfileFingerprint(profile) !== record.capabilityFingerprint) return outcome('PROFILE_MISMATCH');
    if (profile.capabilities?.resume_existing !== 'PROVED' || typeof profile.bridge?.resume !== 'function') return outcome('CAPABILITY_UNAVAILABLE');
    await this.coordination.withClaimAuthority(fence, (work) => { assertLineage(work, lineage); this.repository.startReconcile(record.id, new Date().toISOString()); });
    let bridgeResult;
    try { bridgeResult = await profile.bridge.resume(record.nativeReference); }
    catch (error) { bridgeResult = { status: 'ambiguous', diagnostic: sanitizeNativeEvidence(error?.message ?? String(error)) }; }
    const mapping = bridgeResult?.status === 'resumed' && bridgeResult.usable === true ? ['RECONCILED', 'RECONCILED'] : bridgeResult?.status === 'missing' ? ['NATIVE_SESSION_MISSING', 'NATIVE_SESSION_MISSING'] : bridgeResult?.status === 'failed' ? ['RECONCILE_FAILED', 'RECONCILE_FAILED'] : ['OPERATOR_ACTION_REQUIRED', 'OPERATOR_ACTION_REQUIRED'];
    try {
      await this.coordination.withClaimAuthority(fence, (work) => { assertLineage(work, lineage); this.repository.commitResult(record.id, { status: mapping[0], result: sanitizeNativeEvidence(bridgeResult), reconciledAt: new Date().toISOString() }); });
      return outcome(mapping[1], { resumeCalled: true });
    } catch (error) {
      if (error?.code === 'CLAIM_AUTHORITY_REJECTED') return outcome('STALE_NATIVE_RESULT_REJECTED', { resumeCalled: true });
      throw error;
    }
  }
}

export class DistributedCancellationBoundary {
  constructor({ coordinationStore } = {}) { if (!coordinationStore) throw new TypeError('distributed cancellation boundary requires coordination store'); this.coordination = coordinationStore; }
  request({ leaderFence, workItemId }) { return this.coordination.requestCancellation(leaderFence, workItemId); }
  async interrupt({ fence, capability, interrupt } = {}) {
    const request = await this.coordination.readCancellation(fence.work_item_id);
    if (!request || request.state !== 'REQUESTED') return outcome('NO_CANCELLATION_REQUEST');
    if (capability !== 'PROVED' || typeof interrupt !== 'function') { await this.coordination.startCancellation(fence); await this.coordination.completeCancellation(fence, 'UNSUPPORTED'); return outcome('UNSUPPORTED', { interruptCalled: false }); }
    await this.coordination.startCancellation(fence);
    let result; try { result = await interrupt(); } catch { result = { status: 'ambiguous' }; }
    const terminal = result?.status === 'cancelled' && result?.observed === true ? 'CANCELLED' : 'AMBIGUOUS';
    try { await this.coordination.completeCancellation(fence, terminal); return outcome(terminal, { interruptCalled: true }); }
    catch (error) { if (error?.code === 'CLAIM_AUTHORITY_REJECTED') return outcome('STALE_INTERRUPT_RESULT_REJECTED', { interruptCalled: true }); throw error; }
  }
}
function assertLineage(work, l) { if (work?.task_id !== l.task_id || work?.run_id !== l.run_id || work?.dispatch_attempt_id !== l.dispatch_attempt_id) throw Object.assign(new Error('native lineage mismatch'), { code: 'NATIVE_LINEAGE_MISMATCH' }); }
function outcome(status, extra = {}) { return Object.freeze({ status, ...extra }); }
