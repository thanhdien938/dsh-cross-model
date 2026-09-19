/**
 * P12-R5B Part I/J/K — safe operator reconciliation for a PM run whose last
 * turn is `ACTION_STARTED` with no durable outcome after an unplanned
 * runtime restart (`classifyPmTurnRecovery()`'s `ACTION_RECONCILE_REQUIRED`
 * — src/pm/durable-pm-runtime.mjs). That classification is the EXISTING
 * canonical guard against automatically replaying an action whose real-world
 * effect is unknown (Part J: "UNKNOWN EXTERNAL EFFECT -> NEVER AUTOMATICALLY
 * REPLAY") — this module never bypasses it, it gives an operator a bounded,
 * explicit, auditable way to satisfy it once a human has actually looked at
 * the evidence (docs/p12/06B_P12_R5B_TERMINALIZATION_AND_RECONCILIATION_
 * REMEDIATION_SONNET5.md records exactly that judgment for the two real
 * tasks this gate found).
 *
 * This is deliberately NOT a new lifecycle/orchestration engine: it reuses
 * the exact same durable primitive (`PmRepository#completeTurn`) that
 * `DurablePmRuntime` itself already uses to finalize a turn, writing the
 * SAME `normalizeDurableWorkflowOutcome`/`normalizeDurablePeerOutcome` shape
 * a genuinely-failed action already produces (durable-pm-runtime.mjs). Once
 * applied, `run.status !== 'running'` is true, so the very next attempt to
 * resume this PmRun (`DurablePmRuntime#continue()`'s FIRST check) returns
 * the already-terminal result immediately — it never re-examines the turn,
 * never calls `classifyPmTurnRecovery` again, and never crashes the runtime
 * a second time. `ProductionPmWorkHandler#execute()`'s own pre-existing
 * "already terminal -> adopt and release the claim" branch (Part H) then
 * completes the stale claim naturally on the next poll — no Postgres
 * work_items write is needed here at all.
 *
 * Never touches an `await_owner` turn (Part K/L: a real pending owner
 * interaction is a DIFFERENT, already-correct recovery path — answer it via
 * DECIDE_INTERACTION/REPLY_TO_INTERACTION, or REQUEST_CANCEL the task — this
 * tool refuses outright rather than guessing).
 */

import { PM_TURN_PHASES } from '../persistence/repositories/pm-repository.mjs';

export const RECONCILE_RESOLUTIONS = Object.freeze({
  // No independent evidence that the action's external effect occurred, and
  // none is expected to be found — treat it as if it never happened.
  ABANDON: 'ABANDON',
  // The operator has independently verified (out of band — e.g. real git
  // history, a real remote's state) that the effect definitely did NOT
  // happen. Functionally identical to ABANDON's durable outcome; kept as a
  // distinct, more specific audit-trail code (Part J's own suggested
  // vocabulary) rather than collapsing every reconciliation into one label.
  CONFIRM_NOT_APPLIED: 'CONFIRM_NOT_APPLIED',
  // The operator asserts the effect DID happen. Still never resurrects a
  // fabricated COMPLETED outcome with invented output/data — DSH has no
  // captured result to be faithful to (Part J/K: never fabricate side
  // effects or their absence). The run still terminates FAILED; the
  // resolution and operator's own assertion are preserved in the error code
  // and message for the audit trail.
  CONFIRM_APPLIED: 'CONFIRM_APPLIED',
});

export class ReconciliationRefusedError extends Error {
  constructor(message, code, extra = {}) { super(message); this.name = 'ReconciliationRefusedError'; this.code = code; Object.assign(this, extra); }
}

/**
 * Pure: given an already-loaded PmRun (`PmRepository#load()` shape),
 * determine whether it is genuinely eligible for this tool — fails closed
 * (never guesses) for anything else: already terminal, parked on a real
 * AWAIT_OWNER interaction, or any shape this tool was not built to touch.
 */
export function findReconcilableTurn(run) {
  if (!run) throw new ReconciliationRefusedError('PM run not found', 'PM_RUN_NOT_FOUND');
  if (run.status !== 'running') {
    throw new ReconciliationRefusedError(`PM run is already terminal (status=${run.status}) — nothing to reconcile`, 'PM_RUN_ALREADY_TERMINAL', { status: run.status });
  }
  const turn = run.turns.at(-1) ?? null;
  if (!turn || turn.phase !== PM_TURN_PHASES.ACTION_STARTED) {
    throw new ReconciliationRefusedError('the last PM turn is not a started, unresolved action — nothing to reconcile', 'PM_RUN_NOT_RECONCILE_ELIGIBLE', { phase: turn?.phase ?? null });
  }
  if (turn.decision?.type === 'await_owner') {
    throw new ReconciliationRefusedError('this run is parked awaiting a real owner interaction, not an ambiguous external action — answer it via DECIDE_INTERACTION/REPLY_TO_INTERACTION, or REQUEST_CANCEL the task; this tool never touches an AWAIT_OWNER turn', 'PM_RUN_AWAITING_OWNER_NOT_RECONCILE_TARGET', { interactionId: turn.actionId });
  }
  if (!['workflow', 'peer_exchange'].includes(turn.actionType)) {
    throw new ReconciliationRefusedError(`unexpected action type for reconciliation: ${turn.actionType}`, 'PM_RUN_NOT_RECONCILE_ELIGIBLE', { actionType: turn.actionType });
  }
  return turn;
}

/** Pure: the exact completeTurn()/completeRun() shapes — never a new outcome vocabulary. */
export function buildReconciliationOutcome(turn, { resolution, note = '', now }) {
  if (!Object.values(RECONCILE_RESOLUTIONS).includes(resolution)) {
    throw new ReconciliationRefusedError(`unknown reconciliation resolution: ${resolution}`, 'RECONCILE_RESOLUTION_INVALID', { resolution });
  }
  const codeByResolution = {
    ABANDON: 'ACTION_RECONCILED_ABANDONED',
    CONFIRM_NOT_APPLIED: 'ACTION_RECONCILED_NOT_APPLIED',
    CONFIRM_APPLIED: 'ACTION_RECONCILED_CONFIRMED_APPLIED_NO_RESULT_CAPTURED',
  };
  const code = codeByResolution[resolution];
  const boundedNote = String(note ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const message = `PM action reconciled by operator recovery tooling after an unplanned runtime restart left it without a durable outcome (resolution=${resolution}).${boundedNote ? ` ${boundedNote}` : ''}`;
  const error = Object.freeze({ name: 'PmActionReconciled', code, message });
  const outcome = Object.freeze(
    turn.actionType === 'workflow'
      ? { kind: 'workflow', status: 'failed', workflowId: turn.actionId, finalStepId: null, finalTaskId: null, finalRunId: null, finalResult: null, error }
      : { kind: 'peer_exchange', status: 'failed', conversationId: turn.actionId, hopCount: 0, finalResult: null, error },
  );
  const runPatch = Object.freeze({ status: 'failed', output: '', data: null, error, completedAt: now });
  return { outcome, runPatch };
}

/**
 * The actual durable write — reuses `PmRepository#completeTurn()` verbatim,
 * the SAME primitive `DurablePmRuntime` itself uses. Never calls
 * `workflowRunner.run()`/`peerRelay.exchange()` — no replay, ever.
 */
export function reconcilePendingAction({ pmRepository, pmRunId, resolution, note = '', now = new Date().toISOString() }) {
  const run = pmRepository.load(pmRunId);
  const turn = findReconcilableTurn(run);
  const { outcome, runPatch } = buildReconciliationOutcome(turn, { resolution, note, now });
  pmRepository.completeTurn(pmRunId, turn.turnIndex, outcome, runPatch);
  return Object.freeze({ pmRunId, turnIndex: turn.turnIndex, actionId: turn.actionId, actionType: turn.actionType, resolution, outcome, runPatch });
}
