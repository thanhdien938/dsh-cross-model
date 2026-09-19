import { createHash } from 'node:crypto';
import { RECONCILIATION_CLASS } from './stuck-task-reconciler.mjs';

const token = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Cross-checks the SQLite semantic parent, but mutates only PostgreSQL under its leader fence. */
export class PostgresCancellationReconciliationRepository {
  constructor({ coordinationStore, sqliteStore } = {}) { this.coordination = coordinationStore; this.sqlite = sqliteStore; }
  scanCandidates(options) { return this.coordination.listStaleCancellationCandidates(options); }
  async observe(candidate) {
    const coordination = await this.coordination.observeCancellationReconciliation(candidate.id);
    if (!coordination) throw new Error(`unknown cancellation: ${candidate.id}`);
    const parent = coordination.pmRunId ? this.sqlite.get('SELECT id,status,state_revision FROM pm_runs WHERE id=?', [coordination.pmRunId]) : null;
    const cancelled = parent?.status === 'cancelled';
    const rows = { coordination, parent };
    return Object.freeze({
      classification: RECONCILIATION_CLASS.TERMINAL_TASK_STALE_CANCELLATION_REQUEST,
      taskId: coordination.taskId, lineage: { taskId: coordination.taskId, pmRunId: coordination.pmRunId, workItemId: coordination.workItemId },
      states: { task: parent?.status ?? 'UNKNOWN', workItem: coordination.claimState, cancellation: coordination.cancellationState },
      revisions: { task: parent?.state_revision ?? null, workItem: coordination.workRevision, cancellation: coordination.cancellationRevision },
      observationToken: token(rows), ambiguous: !cancelled || coordination.claimState !== 'COMPLETED',
      ambiguityReason: !cancelled ? 'TASK_NOT_PROVABLY_CANCELLED' : 'WORK_ITEM_NOT_TERMINAL', rows,
    });
  }
  repair({ candidate, expectedObservationToken, audit, fence }) {
    return this.observe(candidate).then((current) => current.observationToken !== expectedObservationToken
      ? { applied: false, idempotent: false }
      : this.coordination.reconcileTerminalCancellation(fence, { expected: current.rows.coordination, audit }));
  }
}
