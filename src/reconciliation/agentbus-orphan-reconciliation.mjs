/**
 * P20.8 PRE-R3 R3-4.2 — bounded operator reconciliation of an EXISTING
 * orphan AgentBus run unreachable through PM-action reconciliation
 * (`SqliteReconciliationRepository` above locates runs via
 * `workflow_steps.run_id`, which is null for these — the exact historical
 * linkage hole the R3-4.1 fix closes for NEW dispatches; this module reaches
 * runs that already went orphan before that fix existed).
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §6.2/§6.3.
 *
 * Contract:
 *   - reuses ONLY repository state-machine transitions
 *     (`AgentBusRepository.updateRunStatus`) — never a raw SQL UPDATE. The
 *     read-only predicate gathering below issues SELECT-only queries against
 *     the SAME store seam `SqliteReconciliationRepository` already uses for
 *     its own cross-domain observation (no new persistence surface).
 *   - eligibility is an atomic, FRESH, all-or-nothing safety predicate; any
 *     ambiguity refuses (never a partial "best guess" repair).
 *   - the outcome is conservative: run -> failed, tagged
 *     ORPHAN_UNKNOWN_EXTERNAL_OUTCOME. No ResultEnvelope is fabricated, no
 *     replay, no claim the external side effect did or did not happen.
 *   - records ONE row in the EXISTING `reconciliation_audit` table/infra —
 *     no second ad-hoc audit store.
 *   - requires the EXACT run id and explicit `operatorAck: true`; there is
 *     no bulk/startup-wide sweep entry point in this module.
 */
import { RECONCILIATION_CLASS } from './stuck-task-reconciler.mjs';

export class OrphanReconciliationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'OrphanReconciliationError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const TERMINAL_WORKFLOW = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STEP = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const TERMINAL_TURN_PHASE = new Set(['TURN_COMPLETE']);
const TERMINAL_PM_RUN = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ATTEMPT_PHASE = 'TERMINAL_COMMITTED';

/**
 * Fresh, read-only fact-gathering for ONE candidate orphan run. Every fact
 * is read directly from durable state (never cached, never inferred from
 * absence-of-evidence as proof of anything).
 *
 * @param {object} input
 * @param {object} input.store - opened SQLite persistence store (`all`/`get`).
 * @param {import('../persistence/repositories/agentbus-repository.mjs').AgentBusRepository} input.agentBusRepository
 * @param {string} input.runId
 */
export function observeOrphanAgentBusRun({ store, agentBusRepository, runId }) {
  if (!store || typeof store.all !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('observeOrphanAgentBusRun requires an opened SQLite store');
  }
  if (!agentBusRepository || typeof agentBusRepository.getRun !== 'function') {
    throw new TypeError('observeOrphanAgentBusRun requires an AgentBusRepository');
  }
  if (typeof runId !== 'string' || !runId) {
    throw new TypeError('observeOrphanAgentBusRun requires an exact runId');
  }

  const run = agentBusRepository.getRun(runId);
  const runExists = Boolean(run);
  const runStatus = run?.status ?? null;
  const taskId = run?.taskId ?? null;

  const task = taskId ? agentBusRepository.getTask(taskId) : undefined;
  const taskExists = Boolean(task);

  const attempt = agentBusRepository.getDispatchAttemptForRun(runId);
  const dispatchAttempt = attempt ? { id: attempt.id, phase: attempt.phase } : null;

  const result = agentBusRepository.getResultByRun(runId);
  const hasResult = Boolean(result);

  // Any native session record correlated to this run/task — presence alone
  // (regardless of its own reconciliation_status) is treated as a
  // conflicting recovery path already being tracked elsewhere; maximally
  // conservative, matching "no ambiguity" throughout this module.
  let nativeSessions = [];
  try {
    nativeSessions = taskId
      ? store.all('SELECT id, reconciliation_status FROM native_sessions WHERE run_id = ? OR task_id = ?', [runId, taskId])
      : store.all('SELECT id, reconciliation_status FROM native_sessions WHERE run_id = ?', [runId]);
  } catch {
    // A schema without task_id/run_id columns (older migration state) — no
    // native-session evidence is discoverable either way; leave empty.
  }

  // Parent lineage: normal linkage (workflow_steps.run_id = runId) UNION the
  // historical linkage hole (same task_id, run_id still null — never a
  // DIFFERENT run_id, which would mean this run legitimately belongs to a
  // different step's lineage instead).
  const byRunId = store.all(
    'SELECT id, workflow_id, status, task_id, run_id FROM workflow_steps WHERE run_id = ?',
    [runId],
  );
  // Not restricted to `run_id IS NULL` — a step whose task_id matches but
  // whose run_id points elsewhere must be SURFACED as a candidate (so
  // eligibility can explicitly report STEP_LINKS_A_DIFFERENT_RUN), not
  // silently dropped into "no lineage found".
  const byTaskId = taskId
    ? store.all(
      'SELECT id, workflow_id, status, task_id, run_id FROM workflow_steps WHERE task_id = ?',
      [taskId],
    )
    : [];
  const stepsById = new Map();
  for (const s of [...byRunId, ...byTaskId]) stepsById.set(s.id, s);
  const linkedSteps = [...stepsById.values()];

  const workflowIds = [...new Set(linkedSteps.map((s) => s.workflow_id))];
  const workflows = workflowIds.length
    ? store.all(`SELECT id, status FROM workflows WHERE id IN (${workflowIds.map(() => '?').join(',')})`, workflowIds)
    : [];

  const turns = workflowIds.length
    ? store.all(
      `SELECT id, pm_run_id, phase, action_id FROM pm_turns WHERE action_type = 'workflow' AND action_id IN (${workflowIds.map(() => '?').join(',')})`,
      workflowIds,
    )
    : [];

  const pmRunIds = [...new Set(turns.map((t) => t.pm_run_id))];
  const pmRuns = pmRunIds.length
    ? store.all(`SELECT id, status FROM pm_runs WHERE id IN (${pmRunIds.map(() => '?').join(',')})`, pmRunIds)
    : [];

  // Any OTHER active (nonterminal) workflow_steps row directly linked to
  // this exact run_id — a run must never be claimed by more than one live
  // lineage.
  const otherNonterminalStepsReferencingRun = byRunId.filter((s) => !TERMINAL_STEP.has(s.status));

  return Object.freeze({
    runId,
    runExists,
    runStatus,
    taskId,
    taskExists,
    dispatchAttempt,
    hasResult,
    nativeSessions: nativeSessions.map((n) => ({ id: n.id, reconciliationStatus: n.reconciliation_status ?? null })),
    linkedSteps: linkedSteps.map((s) => ({ id: s.id, workflowId: s.workflow_id, status: s.status, taskId: s.task_id, runId: s.run_id })),
    workflows: workflows.map((w) => ({ id: w.id, status: w.status })),
    turns: turns.map((t) => ({ id: t.id, pmRunId: t.pm_run_id, phase: t.phase, workflowId: t.action_id })),
    pmRuns: pmRuns.map((p) => ({ id: p.id, status: p.status })),
    otherNonterminalStepsReferencingRun: otherNonterminalStepsReferencingRun.map((s) => ({ id: s.id, status: s.status })),
  });
}

/**
 * Pure fail-closed eligibility evaluation over fresh facts (§6.2/§6.3). Any
 * ambiguity refuses; there is no "old enough" heuristic anywhere here.
 *
 * `runtimeOwnershipProof` covers the facts this module cannot itself
 * observe (OS-level process/singleton ownership, coordination-layer
 * claims/leases, owner interactions) — the CALLER (an operator script/CLI,
 * outside this pure module) must have freshly and explicitly established
 * each one; their absence refuses just like any other unproven predicate.
 *
 * @param {ReturnType<typeof observeOrphanAgentBusRun>} facts
 * @param {{ noLiveRuntimeSingleton?: boolean, noLiveWorkerClaimOrLease?: boolean, noOpenOwnerInteraction?: boolean }} [proof]
 * @returns {{ eligible: boolean, refusals: string[] }}
 */
export function evaluateOrphanReconciliationEligibility(facts, proof = {}) {
  const refusals = [];

  if (!facts.runExists) {
    refusals.push('RUN_NOT_FOUND');
  } else if (facts.runStatus !== 'running') {
    refusals.push(`RUN_ALREADY_TERMINAL_OR_NOT_RUNNING:${facts.runStatus}`);
  }

  if (!facts.taskExists) refusals.push('OWNING_TASK_NOT_FOUND');
  if (facts.hasResult) refusals.push('RESULT_ALREADY_EXISTS');

  if (facts.dispatchAttempt && facts.dispatchAttempt.phase !== TERMINAL_ATTEMPT_PHASE) {
    refusals.push(`DISPATCH_ATTEMPT_INDICATES_RECOVERABLE_PATH:${facts.dispatchAttempt.phase}`);
  }
  if (Array.isArray(facts.nativeSessions) && facts.nativeSessions.length > 0) {
    refusals.push(`NATIVE_SESSION_INDICATES_ACTIVE_OR_AMBIGUOUS_OWNERSHIP:${facts.nativeSessions.map((n) => n.id).join(',')}`);
  }

  if (proof?.noLiveRuntimeSingleton !== true) refusals.push('RUNTIME_SINGLETON_OWNERSHIP_NOT_PROVEN_ABSENT');
  if (proof?.noLiveWorkerClaimOrLease !== true) refusals.push('WORKER_CLAIM_OR_LEASE_NOT_PROVEN_ABSENT');
  if (proof?.noOpenOwnerInteraction !== true) refusals.push('OPEN_OWNER_INTERACTION_NOT_PROVEN_ABSENT');

  if (facts.linkedSteps.length === 0) {
    refusals.push('NO_PARENT_WORKFLOW_STEP_LINEAGE_FOUND');
  } else {
    for (const step of facts.linkedSteps) {
      if (!TERMINAL_STEP.has(step.status)) refusals.push(`PARENT_STEP_NOT_TERMINAL:${step.id}:${step.status}`);
      if (step.runId !== null && step.runId !== facts.runId) refusals.push(`STEP_LINKS_A_DIFFERENT_RUN:${step.id}:${step.runId}`);
    }
    if (facts.workflows.length === 0) refusals.push('PARENT_WORKFLOW_NOT_FOUND');
    for (const wf of facts.workflows) {
      if (!TERMINAL_WORKFLOW.has(wf.status)) refusals.push(`PARENT_WORKFLOW_NOT_TERMINAL:${wf.id}:${wf.status}`);
    }
    if (facts.turns.length === 0) refusals.push('PARENT_TURN_NOT_FOUND');
    for (const turn of facts.turns) {
      if (!TERMINAL_TURN_PHASE.has(turn.phase)) refusals.push(`PARENT_TURN_NOT_TERMINAL:${turn.id}:${turn.phase}`);
    }
    if (facts.pmRuns.length === 0) refusals.push('PARENT_PM_RUN_NOT_FOUND');
    for (const pmRun of facts.pmRuns) {
      if (!TERMINAL_PM_RUN.has(pmRun.status)) refusals.push(`PARENT_PM_RUN_NOT_TERMINAL:${pmRun.id}:${pmRun.status}`);
    }
  }

  if (facts.otherNonterminalStepsReferencingRun.length > 0) {
    refusals.push('RUN_REFERENCED_BY_ANOTHER_NONTERMINAL_STEP');
  }

  return { eligible: refusals.length === 0, refusals };
}

/**
 * The bounded operator reconciliation write. Requires the EXACT run id and
 * `operatorAck: true`; never invoked by a startup sweep. Fresh-observes,
 * fresh-evaluates, and — only if eligible — performs ONE repository-owned
 * state transition (`updateRunStatus`, running -> failed) plus ONE durable
 * `reconciliation_audit` row, inside a single SQLite transaction so the two
 * writes commit atomically.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {import('../persistence/repositories/agentbus-repository.mjs').AgentBusRepository} input.agentBusRepository
 * @param {string} input.runId
 * @param {boolean} input.operatorAck - must be literal `true`.
 * @param {{ noLiveRuntimeSingleton?: boolean, noLiveWorkerClaimOrLease?: boolean, noOpenOwnerInteraction?: boolean }} [input.runtimeOwnershipProof]
 * @param {string} [input.reason]
 * @param {() => string} [input.now]
 * @throws {OrphanReconciliationError} ORPHAN_RECONCILIATION_ACK_REQUIRED | ORPHAN_RECONCILIATION_REFUSED
 */
export function reconcileOrphanAgentBusRun({
  store, agentBusRepository, runId, operatorAck, runtimeOwnershipProof, reason, now = () => new Date().toISOString(),
}) {
  if (typeof runId !== 'string' || !runId) {
    throw new OrphanReconciliationError('an exact runId is required', 'ORPHAN_RECONCILIATION_RUN_ID_REQUIRED');
  }
  if (operatorAck !== true) {
    throw new OrphanReconciliationError(
      'explicit operator acknowledgement is required (operatorAck: true) — never a startup-wide auto sweep',
      'ORPHAN_RECONCILIATION_ACK_REQUIRED',
      { runId },
    );
  }

  const facts = observeOrphanAgentBusRun({ store, agentBusRepository, runId });
  const { eligible, refusals } = evaluateOrphanReconciliationEligibility(facts, runtimeOwnershipProof);
  if (!eligible) {
    throw new OrphanReconciliationError(
      `orphan reconciliation refused for run ${runId}: ${refusals.join('; ')}`,
      'ORPHAN_RECONCILIATION_REFUSED',
      { runId, refusals, facts },
    );
  }

  const at = now();
  const errorPayload = {
    name: 'AgentBusOrphanReconciliationError',
    code: 'ORPHAN_UNKNOWN_EXTERNAL_OUTCOME',
    message: reason ?? 'Operator-reconciled orphan AgentBus run: unresolved (historically unlinked) execution settled to a '
      + 'durable FAILED terminal state. No ResultEnvelope was fabricated, no replay was performed, and no claim is made '
      + 'about whether the external side effect did or did not occur.',
  };

  return store.transactionSync(() => {
    // ONE repository-owned state-machine transition — never a raw SQL UPDATE.
    const updatedRun = agentBusRepository.updateRunStatus(runId, { status: 'failed', completedAt: at, error: errorPayload });

    const reconciliationId = `agentbus-orphan-${runId}`;
    const idempotencyKey = reconciliationId;
    const lineage = {
      runId,
      taskId: facts.taskId,
      stepIds: facts.linkedSteps.map((s) => s.id),
      workflowIds: facts.workflows.map((w) => w.id),
      turnIds: facts.turns.map((t) => t.id),
      pmRunIds: facts.pmRuns.map((p) => p.id),
    };
    store.run(
      `INSERT INTO reconciliation_audit (
         reconciliation_id, idempotency_key, task_id, affected_lineage, classification,
         before_states, before_revisions, after_states, after_revisions, evidence_timestamps,
         leader_generation, worker_incarnation, repair_reason, repair_result, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reconciliationId,
        idempotencyKey,
        facts.taskId,
        JSON.stringify(lineage),
        RECONCILIATION_CLASS.ORPHAN_UNKNOWN_EXTERNAL_OUTCOME,
        JSON.stringify({ run: facts.runStatus }),
        JSON.stringify({}),
        JSON.stringify({ run: updatedRun.status }),
        JSON.stringify({}),
        JSON.stringify({ observedAt: at }),
        0, // leader_generation: not a leader-election-gated auto-repair; operator-initiated
        null,
        reason ?? 'P20.8 PRE-R3 R3-4.2 operator orphan reconciliation',
        'APPLIED',
        at,
      ],
    );

    return { run: updatedRun, reconciliationId, facts };
  });
}
