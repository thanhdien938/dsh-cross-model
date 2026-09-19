/**
 * P15-REM-R2-C — the ONE authoritative failure-settlement boundary around PM
 * work execution (P15-C-006, docs/p15-rem/03_*.md).
 *
 * Before this module: a typed failure thrown by `DurablePmRuntime#resume()`/
 * `#executePrepared()` (or by `ProductionPmWorkHandler#execute()`'s own
 * lineage/project checks, before the runtime is even reached) propagated
 * straight out of `execute()`. `ProductionPmWorker#runOnce()`'s settlement
 * `.then(success, error=>{...})` handler (src/runtime/production-pm-worker.mjs)
 * already never let that become an unhandled rejection — it frees the
 * process-local slot and resolves to `{status:'FAILED', error}` — but it
 * never touched the Postgres coordination claim itself. Neither
 * `completeClaim()` nor `releaseClaim()` was ever called, so the claim sat
 * `claim_state='ACTIVE'` until its lease naturally expired, at which point
 * ANY worker's next poll would reclaim the exact same work item and hit the
 * exact same typed failure again — a silent, unbounded lease-reclaim/retry
 * loop (confirmed live in docs/p12/06B_*.md's TEST 4 incident: "EVERY
 * subsequent start hits the exact same crash").
 *
 * This module classifies every typed failure that can escape `execute()`'s
 * risky section and durably settles it exactly once:
 *   - the CLAIM is always completed (`claim_state='COMPLETED'` — never
 *     retried again, regardless of disposition);
 *   - the PM_RUN is durably terminalized when — and only when — doing so is
 *     safe (see disposition table below);
 *   - a structured, sanitized diagnostic event is emitted (best-effort,
 *     never affects the real settlement).
 *
 * No new lifecycle engine, no new schema: every write here reuses
 * `PmRepository#completeTurn()`/`#completeRun()` (the SAME durable primitives
 * `DurablePmRuntime` itself already uses to finalize a turn/run) and, for
 * `ACTION_RECONCILE_REQUIRED` specifically, the EXISTING P12-R5B operator
 * reconciliation tool (`pm-action-reconciliation.mjs`) — applied
 * automatically instead of requiring a human to run a script first.
 */

import { PM_TURN_PHASES } from '../persistence/repositories/pm-repository.mjs';
import { toSanitizedError } from '../bus/errors.mjs';
import { RECONCILE_RESOLUTIONS, reconcilePendingAction, ReconciliationRefusedError } from './pm-action-reconciliation.mjs';

export const PM_WORK_FAILURE_DISPOSITION = Object.freeze({
  // The pm_run itself cannot proceed (a real config/identity problem for
  // THIS run specifically) — durably fail it, atomically completing whatever
  // turn is pending so `PmRepository#load()`'s own terminal-run invariant
  // never breaks.
  TERMINAL_RUN: 'TERMINAL_RUN',
  // The WORK ITEM's own identity/reference is untrustworthy or the pm_run is
  // already someone else's legitimate terminal/in-flight state — never
  // fabricate a pm_run mutation from unverifiable evidence; only the claim is
  // settled.
  TERMINAL_CLAIM_ONLY: 'TERMINAL_CLAIM_ONLY',
  // The action's real-world outcome is unknown after a restart — apply the
  // existing, safe ABANDON reconciliation automatically (never CONFIRM_*,
  // which requires an operator's own out-of-band judgment).
  RECONCILE_ABANDON: 'RECONCILE_ABANDON',
});

export const PM_WORK_FAILURE_CLASS = Object.freeze({
  TERMINAL_USER_CONFIG: 'TERMINAL_USER_CONFIG',
  TERMINAL_INTERNAL: 'TERMINAL_INTERNAL',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
});

// PROJECT_REFUSED / PM_DRIVER_MISMATCH / PM_PROFILE_UNAVAILABLE /
// PM_PROFILE_MISMATCH: the pm_run identity itself is known-good (it loaded),
// but its configuration can no longer execute — this run genuinely cannot
// proceed and never will without an owner/config fix. Fail it durably.
const TERMINAL_RUN_CODES = new Set(['PROJECT_REFUSED', 'PM_DRIVER_MISMATCH', 'PM_PROFILE_UNAVAILABLE', 'PM_PROFILE_MISMATCH']);

// PM_WORK_LINEAGE_INVALID / PM_RUN_ALREADY_ADVANCED and the PmRepository
// identity-guard codes: the WORK ITEM's own claim on this pm_run is what is
// untrustworthy (stale/duplicate/racing adoption, unknown/corrupt
// reference) — the underlying pm_run may well be someone else's legitimate,
// still-progressing state. Never mutate it from here; only stop retrying
// this specific claim.
const TERMINAL_CLAIM_ONLY_CODES = new Set([
  'PM_WORK_LINEAGE_INVALID', 'PM_RUN_ALREADY_ADVANCED',
  'UNKNOWN_PM_RUN', 'PM_RUN_TERMINAL', 'PM_RUN_ID_CONFLICT', 'UNKNOWN_PM_TURN', 'CORRUPT_PM_STATE',
]);

/** Pure: map a typed failure's `.code` to a settlement disposition. Unknown/unclassified codes fail closed as TERMINAL_RUN — see file header — never left unsettled. */
export function classifyPmWorkFailure(error) {
  const code = error?.code ?? null;
  if (code === 'ACTION_RECONCILE_REQUIRED') {
    return Object.freeze({ disposition: PM_WORK_FAILURE_DISPOSITION.RECONCILE_ABANDON, classification: PM_WORK_FAILURE_CLASS.RECONCILIATION_REQUIRED, code });
  }
  if (TERMINAL_RUN_CODES.has(code)) {
    return Object.freeze({ disposition: PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, classification: PM_WORK_FAILURE_CLASS.TERMINAL_USER_CONFIG, code });
  }
  if (TERMINAL_CLAIM_ONLY_CODES.has(code)) {
    return Object.freeze({ disposition: PM_WORK_FAILURE_DISPOSITION.TERMINAL_CLAIM_ONLY, classification: PM_WORK_FAILURE_CLASS.TERMINAL_INTERNAL, code });
  }
  // Fail-closed default: an error this module has never seen before is
  // exactly the kind of thing that used to loop forever. Never leave it
  // unsettled — terminalize the run generically rather than silently
  // rely on lease expiry.
  return Object.freeze({ disposition: PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, classification: PM_WORK_FAILURE_CLASS.TERMINAL_INTERNAL, code: code ?? 'PM_WORK_EXECUTION_FAILED' });
}

function findPendingTurn(run) {
  const last = run.turns.at(-1) ?? null;
  return last && last.phase !== PM_TURN_PHASES.TURN_COMPLETE ? last : null;
}

/**
 * TERMINAL_RUN: durably fail the pm_run, atomically completing whatever turn
 * is pending (if any) so `PmRepository#load()`'s "terminal run has incomplete
 * turn" corruption guard is never violated. Never touches a turn parked on a
 * REAL owner interaction (`await_owner`) — that is a different, already-
 * correct recovery path (matches `pm-action-reconciliation.mjs`'s own
 * refusal rule); the claim is still completed by the caller regardless, so
 * this specific work item is never retried even when the run itself is left
 * untouched.
 */
export function settleTerminalPmRunFailure({ pmRepository, pmRunId, error, now = new Date().toISOString() }) {
  let run;
  try { run = pmRepository.load(pmRunId); } catch { return { pmRunTouched: false, reason: 'RUN_UNAVAILABLE' }; }
  if (run.status !== 'running') return { pmRunTouched: false, reason: 'ALREADY_TERMINAL' };
  const pending = findPendingTurn(run);
  const sanitized = toSanitizedError(error);
  if (pending?.decision?.type === 'await_owner') return { pmRunTouched: false, reason: 'AWAIT_OWNER_PENDING' };
  if (!pending) {
    pmRepository.completeRun(pmRunId, { status: 'failed', output: '', data: null, error: sanitized, completedAt: now });
    return { pmRunTouched: true, reason: 'RUN_COMPLETED_NO_PENDING_TURN' };
  }
  // A decision committed but not yet marked ACTION_STARTED (a real, if rare,
  // restart window — see #processCommitted's own handling of this shape) —
  // promote it first so completeTurn()'s phase guard matches, exactly the
  // same promotion DurablePmRuntime's own normal path already performs.
  if (pending.phase === PM_TURN_PHASES.DECISION_COMMITTED && pending.decision?.type !== 'finish') {
    pmRepository.markActionStarted(pmRunId, pending.turnIndex);
  }
  const outcome = pending.actionType === 'workflow'
    ? { kind: 'workflow', status: 'failed', workflowId: pending.actionId, finalStepId: null, finalTaskId: null, finalRunId: null, finalResult: null, error: sanitized }
    : pending.actionType === 'peer_exchange'
      ? { kind: 'peer_exchange', status: 'failed', conversationId: pending.actionId, hopCount: 0, finalResult: null, error: sanitized }
      : { kind: pending.decision?.type ?? 'unknown', status: 'failed', error: sanitized };
  pmRepository.completeTurn(pmRunId, pending.turnIndex, outcome, { status: 'failed', output: '', data: null, error: sanitized, completedAt: now });
  return { pmRunTouched: true, reason: 'RUN_TERMINALIZED_VIA_PENDING_TURN' };
}

/**
 * The single settlement entry point `ProductionPmWorkHandler#execute()`
 * calls from its outer catch. Never throws for a classification/settlement
 * failure of its own (best-effort inner try/catches) — the ONE thing this
 * function must never do is leave the caller unable to complete the claim.
 */
export function settlePmWorkFailure({ pmRepository, pmRunId, error, now = new Date().toISOString(), taskLog = null }) {
  const { disposition, classification, code } = classifyPmWorkFailure(error);
  let pmRunOutcome = null;
  if (disposition === PM_WORK_FAILURE_DISPOSITION.RECONCILE_ABANDON) {
    try {
      const applied = reconcilePendingAction({ pmRepository, pmRunId, resolution: RECONCILE_RESOLUTIONS.ABANDON, note: 'automatic settlement after ACTION_RECONCILE_REQUIRED (P15-REM-R2-C)', now });
      pmRunOutcome = { pmRunTouched: true, reason: 'RECONCILED_ABANDON_AUTOMATIC', ...applied };
    } catch (reconcileError) {
      // The reconcile tool's own eligibility guard refused (e.g. raced to
      // already-terminal, or genuinely an AWAIT_OWNER turn — never touched,
      // matching its own established rule). The claim is still completed by
      // the caller below either way; this work item is never retried.
      pmRunOutcome = { pmRunTouched: false, reason: reconcileError instanceof ReconciliationRefusedError ? reconcileError.code : 'RECONCILE_REFUSED' };
    }
  } else if (disposition === PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN) {
    pmRunOutcome = settleTerminalPmRunFailure({ pmRepository, pmRunId, error, now });
  } else {
    pmRunOutcome = { pmRunTouched: false, reason: 'CLAIM_ONLY' };
  }
  try {
    taskLog?.event('PM_WORK_FAILURE_SETTLED', {
      pm_run_id: pmRunId, code, classification, disposition,
      pm_run_touched: Boolean(pmRunOutcome?.pmRunTouched), settlement_reason: pmRunOutcome?.reason ?? null,
    });
  } catch { /* never let diagnostics affect the real settlement */ }
  return Object.freeze({ disposition, classification, code, pmRunOutcome });
}
