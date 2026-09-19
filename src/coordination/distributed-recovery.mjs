import { RECOVERY_CLASSIFICATIONS } from '../persistence/recovery/dispatch-attempt-protocol.mjs';

export const DISTRIBUTED_RECOVERY_ACTIONS = Object.freeze({
  EXECUTE_EXACT_INTENT: 'EXECUTE_EXACT_INTENT', BLOCK_AMBIGUOUS: 'BLOCK_AMBIGUOUS',
  ROUTE_NATIVE_RECONCILIATION: 'ROUTE_NATIVE_RECONCILIATION', NO_ACTION: 'NO_ACTION',
});

export class DistributedDispatchRecovery {
  constructor({ coordinationStore, dispatchCoordinator } = {}) { if (!coordinationStore || !dispatchCoordinator) throw new TypeError('distributed recovery dependencies are required'); this.coordination = coordinationStore; this.dispatch = dispatchCoordinator; }
  async recover({ work, workerIncarnationId, leaseMs, provider, capabilities = {} } = {}) {
    const claim = await this.coordination.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: workerIncarnationId, leaseMs });
    if (!claim) return Object.freeze({ action: DISTRIBUTED_RECOVERY_ACTIONS.NO_ACTION, reason: 'NO_AUTHORITY' });
    const fence = fenceOf(claim); const lineage = { task_id: work.task_id, run_id: work.run_id, dispatch_attempt_id: work.dispatch_attempt_id };
    let diagnostic;
    try { diagnostic = await this.dispatch.classifyForExecution({ fence, lineage, capabilities }); }
    catch (error) { if (error?.code === 'FENCED_DISPATCH_LINEAGE_MISMATCH') return Object.freeze({ action: DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, reason: error.code, fence }); throw error; }
    if (diagnostic.classification === RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH) return Object.freeze({ action: DISTRIBUTED_RECOVERY_ACTIONS.EXECUTE_EXACT_INTENT, diagnostic, outcome: await this.dispatch.execute({ fence, lineage, provider }) });
    if (diagnostic.classification === RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED) return Object.freeze({ action: DISTRIBUTED_RECOVERY_ACTIONS.ROUTE_NATIVE_RECONCILIATION, diagnostic, fence, lineage });
    return Object.freeze({ action: diagnostic.classification === RECOVERY_CLASSIFICATIONS.CLEAN ? DISTRIBUTED_RECOVERY_ACTIONS.NO_ACTION : DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, diagnostic, fence, lineage });
  }
}
function fenceOf(c) { return { work_item_id: c.work_item_id, owner_worker_incarnation_id: c.owner_worker_incarnation_id, fencing_generation: c.fencing_generation, fencing_token: c.fencing_token }; }
