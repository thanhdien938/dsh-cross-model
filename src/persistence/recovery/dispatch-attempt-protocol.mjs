/**
 * Persistence layer — dispatch-attempt protocol truth.
 *
 * Single source for the accepted Phase 2 write-ahead dispatch-attempt phases
 * and their legal transitions, plus the recovery classification set. This
 * module is driver-neutral: no SQLite types, no provider names.
 *
 * Phases:
 *   INTENT_COMMITTED -> DISPATCH_STARTED -> REMOTE_STARTED? -> TERMINAL_COMMITTED
 *
 * Legal transition truth:
 *   - INTENT_COMMITTED -> DISPATCH_STARTED   (crossing the durable boundary)
 *   - DISPATCH_STARTED -> REMOTE_STARTED     (only via explicit native/session
 *     correlation after the external boundary was crossed)
 *   - DISPATCH_STARTED -> TERMINAL_COMMITTED (provider returned terminal outcome
 *     without a separately persisted remote-start correlation)
 *   - REMOTE_STARTED   -> TERMINAL_COMMITTED
 *   - TERMINAL_COMMITTED is immutable (only future explicit recovery/migration
 *     tooling may move it).
 *
 * INTENT_COMMITTED -> TERMINAL_COMMITTED is intentionally NOT legal: Gate 3
 * requires a durable DISPATCH_STARTED before any terminal commit so that
 * Window A (intent only) remains recoverable as SAFE_TO_DISPATCH and no local
 * lifecycle can fabricate a completion for work that never crossed the
 * external boundary.
 */

import { BusError } from '../../bus/errors.mjs';

export const ATTEMPT_PHASES = Object.freeze({
  INTENT_COMMITTED: 'INTENT_COMMITTED',
  DISPATCH_STARTED: 'DISPATCH_STARTED',
  REMOTE_STARTED: 'REMOTE_STARTED',
  TERMINAL_COMMITTED: 'TERMINAL_COMMITTED',
});

export const TERMINAL_ATTEMPT_PHASES = Object.freeze(new Set([ATTEMPT_PHASES.TERMINAL_COMMITTED]));

/**
 * Legal dispatch-attempt phase transitions. Terminal phase has no outgoing
 * transitions before explicit recovery/migration tooling.
 */
export const ATTEMPT_PHASE_TRANSITIONS = Object.freeze({
  [ATTEMPT_PHASES.INTENT_COMMITTED]: Object.freeze(new Set([ATTEMPT_PHASES.DISPATCH_STARTED])),
  [ATTEMPT_PHASES.DISPATCH_STARTED]: Object.freeze(new Set([ATTEMPT_PHASES.REMOTE_STARTED, ATTEMPT_PHASES.TERMINAL_COMMITTED])),
  [ATTEMPT_PHASES.REMOTE_STARTED]: Object.freeze(new Set([ATTEMPT_PHASES.TERMINAL_COMMITTED])),
  [ATTEMPT_PHASES.TERMINAL_COMMITTED]: Object.freeze(new Set()),
});

/**
 * @param {string} phase - phase value to validate.
 * @returns {boolean} whether `phase` is a known attempt phase.
 */
export function isAttemptPhase(phase) {
  return Object.values(ATTEMPT_PHASES).includes(phase);
}

/**
 * Assert a dispatch-attempt phase transition is legal. Throws a typed BusError
 * with code `INVALID_ATTEMPT_PHASE_TRANSITION` when it is not.
 * @param {string} attemptId - attempt identity used for error context.
 * @param {string} current - current phase.
 * @param {string} target - target phase.
 * @returns {true} when legal.
 */
export function assertLegalAttemptPhaseTransition(attemptId, current, target) {
  if (!isAttemptPhase(current) || !isAttemptPhase(target)) {
    throw new BusError(`invalid dispatch attempt phase: "${current}" -> "${target}"`, {
      code: 'INVALID_ATTEMPT_PHASE_TRANSITION',
      attemptId,
      current,
      target,
    });
  }
  const allowed = ATTEMPT_PHASE_TRANSITIONS[current];
  if (!allowed || !allowed.has(target)) {
    throw new BusError(`invalid dispatch attempt phase transition: ${current} -> ${target}`, {
      code: 'INVALID_ATTEMPT_PHASE_TRANSITION',
      attemptId,
      current,
      target,
    });
  }
  return true;
}

/** Recovery classification values produced by the classifier. */
export const RECOVERY_CLASSIFICATIONS = Object.freeze({
  CLEAN: 'CLEAN',
  SAFE_TO_DISPATCH: 'SAFE_TO_DISPATCH',
  AMBIGUOUS_EXTERNAL_ACCEPTANCE: 'AMBIGUOUS_EXTERNAL_ACCEPTANCE',
  NATIVE_RECONCILE_REQUIRED: 'NATIVE_RECONCILE_REQUIRED',
  INTERRUPTED_EXTERNAL_RUN: 'INTERRUPTED_EXTERNAL_RUN',
  AMBIGUOUS_RESULT_COMMIT: 'AMBIGUOUS_RESULT_COMMIT',
  RECONCILED: 'RECONCILED',
  OPERATOR_ACTION_REQUIRED: 'OPERATOR_ACTION_REQUIRED',
});