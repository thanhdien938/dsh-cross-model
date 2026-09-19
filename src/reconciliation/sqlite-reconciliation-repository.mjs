import { createHash } from 'node:crypto';
import { RECONCILIATION_CLASS } from './stuck-task-reconciler.mjs';

const TERMINAL = "('completed','failed','cancelled')";
const NONTERMINAL = "('created','running','pending','dispatched')";
const json = (value) => JSON.stringify(value);
const tokenOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** SQLite authority for PM/turn/workflow/step/run bookkeeping repairs. */
export class SqliteReconciliationRepository {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store?.all || !store?.transactionSync) throw new TypeError('opened SQLite store is required');
    this.store = store; this.clock = clock;
  }

  scanCandidates({ limit = 50 } = {}) {
    return this.store.all(`SELECT DISTINCT p.id AS pm_run_id
      FROM pm_runs p JOIN pm_turns t ON t.pm_run_id=p.id
      LEFT JOIN workflows w ON w.id=t.action_id
      LEFT JOIN workflow_steps s ON s.workflow_id=w.id
      LEFT JOIN runs r ON r.id=s.run_id
      WHERE p.status IN ${TERMINAL} AND t.action_type='workflow'
        AND (t.phase<>'TURN_COMPLETE' OR w.status IN ${NONTERMINAL} OR s.status IN ${NONTERMINAL} OR r.status IN ${NONTERMINAL})
      ORDER BY p.completed_at,p.id LIMIT ?`, [Math.min(200, Math.max(1, limit))])
      .map((row) => ({ kind: 'SQLITE_DESCENDANTS', id: row.pm_run_id }));
  }

  observe(candidate) {
    if (candidate.kind !== 'SQLITE_DESCENDANTS') throw new TypeError('unsupported reconciliation candidate');
    const parent = this.store.get('SELECT id,status,state_revision,completed_at FROM pm_runs WHERE id=?', [candidate.id]);
    if (!parent) throw new Error(`unknown PM run: ${candidate.id}`);
    const turns = this.store.all("SELECT id,action_id,phase,state_revision FROM pm_turns WHERE pm_run_id=? AND action_type='workflow' ORDER BY turn_index", [candidate.id]);
    const workflowIds = turns.map((row) => row.action_id).filter(Boolean);
    const placeholders = workflowIds.map(() => '?').join(',');
    const workflows = placeholders ? this.store.all(`SELECT id,status,state_revision FROM workflows WHERE id IN (${placeholders}) ORDER BY id`, workflowIds) : [];
    const steps = placeholders ? this.store.all(`SELECT id,workflow_id,status,task_id,run_id,state_revision FROM workflow_steps WHERE workflow_id IN (${placeholders}) ORDER BY workflow_id,step_index`, workflowIds) : [];
    const runIds = steps.map((row) => row.run_id).filter(Boolean);
    const runPlaceholders = runIds.map(() => '?').join(',');
    const runs = runPlaceholders ? this.store.all(`SELECT id,task_id,status,state_revision FROM runs WHERE id IN (${runPlaceholders}) ORDER BY id`, runIds) : [];
    const taskId = steps.find((row) => row.task_id)?.task_id ?? runs.find((row) => row.task_id)?.task_id ?? null;
    const rows = { parent, turns, workflows, steps, runs };
    const states = Object.fromEntries([
      [`pm:${parent.id}`, parent.status], ...turns.map((v) => [`turn:${v.id}`, v.phase]),
      ...workflows.map((v) => [`workflow:${v.id}`, v.status]), ...steps.map((v) => [`step:${v.id}`, v.status]), ...runs.map((v) => [`run:${v.id}`, v.status]),
    ]);
    const revisions = Object.fromEntries([
      [`pm:${parent.id}`, parent.state_revision], ...turns.map((v) => [`turn:${v.id}`, v.state_revision]),
      ...workflows.map((v) => [`workflow:${v.id}`, v.state_revision]), ...steps.map((v) => [`step:${v.id}`, v.state_revision]), ...runs.map((v) => [`run:${v.id}`, v.state_revision]),
    ]);
    return Object.freeze({ classification: RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS, taskId, lineage: { taskId, pmRunId: parent.id, turnIds: turns.map(v => v.id), workflowIds, stepIds: steps.map(v => v.id), runIds }, states, revisions, observationToken: tokenOf(rows), parentStatus: parent.status, rows });
  }

  repair({ candidate, expectedObservationToken, audit }) {
    return this.store.transactionSync(({ get, run }) => {
      const existing = get('SELECT reconciliation_id FROM reconciliation_audit WHERE idempotency_key=?', [audit.idempotencyKey]);
      if (existing) return { applied: false, idempotent: true, reconciliationId: existing.reconciliation_id };
      const before = this.observe(candidate);
      if (before.observationToken !== expectedObservationToken) return { applied: false, idempotent: false };
      const at = this.clock();
      const descendantStatus = before.parentStatus === 'cancelled' ? 'cancelled' : 'failed';
      const error = json({ name: 'ReconciliationError', code: 'RECONCILED_TERMINAL_PARENT', message: 'Stale non-terminal bookkeeping settled from authoritative terminal PM parent' });
      const outcome = json({ status: descendantStatus, error: { code: 'RECONCILED_TERMINAL_PARENT' }, reconciled: true });
      for (const row of before.rows.turns.filter(v => v.phase !== 'TURN_COMPLETE')) {
        if (run("UPDATE pm_turns SET phase='TURN_COMPLETE',outcome=?,completed_at=?,reconciliation_state='RECONCILED',reconciliation_reason='RECONCILED_TERMINAL_PARENT',state_revision=state_revision+1 WHERE id=? AND state_revision=? AND phase=?", [outcome, at, row.id, row.state_revision, row.phase]).changes !== 1) throw Object.assign(new Error('stale PM turn'), { code: 'RECONCILIATION_CAS_REJECTED' });
      }
      for (const row of before.rows.workflows.filter(v => ['created','running','pending','dispatched'].includes(v.status))) {
        if (run("UPDATE workflows SET status=?,completed_at=?,error=?,reconciliation_state='RECONCILED',reconciliation_reason='RECONCILED_TERMINAL_PARENT',state_revision=state_revision+1 WHERE id=? AND state_revision=? AND status=?", [descendantStatus, at, error, row.id, row.state_revision, row.status]).changes !== 1) throw Object.assign(new Error('stale workflow'), { code: 'RECONCILIATION_CAS_REJECTED' });
      }
      for (const row of before.rows.steps.filter(v => ['created','running','pending','dispatched'].includes(v.status))) {
        if (run("UPDATE workflow_steps SET status=?,error=?,reconciliation_state='RECONCILED',reconciliation_reason='RECONCILED_TERMINAL_PARENT',state_revision=state_revision+1 WHERE id=? AND state_revision=? AND status=?", [descendantStatus, error, row.id, row.state_revision, row.status]).changes !== 1) throw Object.assign(new Error('stale step'), { code: 'RECONCILIATION_CAS_REJECTED' });
      }
      for (const row of before.rows.runs.filter(v => ['created','running','pending','dispatched'].includes(v.status))) {
        if (run("UPDATE runs SET status=?,completed_at=?,error=?,reconciliation_state='RECONCILED',reconciliation_reason='RECONCILED_TERMINAL_PARENT',state_revision=state_revision+1 WHERE id=? AND state_revision=? AND status=?", [descendantStatus, at, error, row.id, row.state_revision, row.status]).changes !== 1) throw Object.assign(new Error('stale run'), { code: 'RECONCILIATION_CAS_REJECTED' });
      }
      const after = this.observe(candidate);
      run(`INSERT INTO reconciliation_audit (reconciliation_id,idempotency_key,task_id,affected_lineage,classification,before_states,before_revisions,after_states,after_revisions,evidence_timestamps,leader_generation,worker_incarnation,repair_reason,repair_result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [audit.reconciliationId,audit.idempotencyKey,audit.taskId,json(audit.lineage),audit.classification,json(audit.beforeStates),json(audit.beforeRevisions),json(after.states),json(after.revisions),json(audit.evidenceTimestamps),audit.leaderGeneration,audit.workerIncarnation,audit.repairReason,'APPLIED',at]);
      return { applied: true, idempotent: false, reconciliationId: audit.reconciliationId };
    });
  }

  recordProjection(record) {
    const id = `projection-${record.idempotencyKey}`; const at = this.clock();
    this.store.run(`INSERT OR IGNORE INTO reconciliation_audit (reconciliation_id,idempotency_key,task_id,affected_lineage,classification,before_states,before_revisions,after_states,after_revisions,evidence_timestamps,leader_generation,worker_incarnation,repair_reason,repair_result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,record.idempotencyKey,record.taskId,json(record.lineage),record.classification,json(record.states),json(record.revisions),json({ ...record.states, __projection: { resourceImpact: record.resourceImpact, safeAllowedActions: record.safeAllowedActions } }),json(record.revisions),json(record.evidenceTimestamps),record.leaderGeneration,record.workerIncarnation,record.reason,'NO_MUTATION',at]);
    return { reconciliationId: id };
  }
}
