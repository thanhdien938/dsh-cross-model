/**
 * Persistence layer — dispatch recovery classifier.
 *
 * A driver-neutral classifier that maps persisted dispatch truth (attempt + run
 * + result + native-session reference) plus caller-supplied capability evidence
 * into an immutable recovery diagnostic. It never queries the database itself;
 * callers pass persisted truth in. It never branches on provider names; the
 * capability evidence is input data, never inferred from backend identity.
 *
 * Minimum deterministic mapping (P2-Gate 3):
 *   1. INTENT_COMMITTED with the external boundary definitely not crossed
 *      -> SAFE_TO_DISPATCH.
 *   2. DISPATCH_STARTED with no terminal durable truth
 *      -> AMBIGUOUS_EXTERNAL_ACCEPTANCE.
 *   3. REMOTE_STARTED + durable native reference + proved resume_existing
 *      -> NATIVE_RECONCILE_REQUIRED.
 *   4. REMOTE_STARTED without the above -> INTERRUPTED_EXTERNAL_RUN.
 *   5. terminal run/result truth without TERMINAL_COMMITTED
 *      -> AMBIGUOUS_RESULT_COMMIT (normal atomic terminal commits make this
 *      state unreachable; the branch is retained as a defensive check for
 *      corrupt/foreign data).
 *   6. TERMINAL_COMMITTED with coherent terminal run/result truth -> CLEAN.
 *   7. corrupt/incoherent combinations -> OPERATOR_ACTION_REQUIRED.
 *
 * autoReplayAllowed is true ONLY for SAFE_TO_DISPATCH. Native reconciliation
 * is never executed by Gate 3; nativeReconcileEligible merely signals that a
 * later gate may attempt it.
 */

import {
  ATTEMPT_PHASES,
  RECOVERY_CLASSIFICATIONS,
} from './dispatch-attempt-protocol.mjs';

/** Typed error for malformed classifier input. */
export class DispatchRecoveryClassifierError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DispatchRecoveryClassifierError';
    this.code = 'INVALID_RECOVERY_INPUT';
    Object.assign(this, extra);
  }
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Serviceable resume-evidence values. Only `PROVED` ever qualifies; every
 * other value (UNPROVED, UNKNOWN, ERROR, UNVERIFIED, undefined, etc.) means
 * native reconciliation is not eligible.
 * @param {unknown} value
 * @returns {boolean}
 */
export function resumeEvidenceQualifies(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === 'PROVED';
}

function phaseLabel(attempt) {
  return typeof attempt?.phase === 'string' ? attempt.phase : typeof attempt?.phase === 'undefined' ? 'undefined' : String(attempt.phase);
}

/**
 * Classify an incomplete or terminal dispatch attempt from persisted truth.
 *
 * @param {object} input
 * @param {object} input.attempt - persisted dispatch attempt (id, runId, phase,
 *   optional nativeReference, optional corruptPayload flag).
 * @param {object|null|undefined} input.run - persisted RunRecord, or null/undefined.
 * @param {object|null|undefined} input.result - persisted ResultEnvelope, or null/undefined.
 * @param {object} [input.capabilities] - caller-supplied capability evidence,
 *   e.g. `{ resumeExisting: 'PROVED' }`. Never inferred from backend identity.
 * @returns {Readonly<{ attemptId: string, runId: string|null, phase: string,
 *   classification: string, reason: string, autoReplayAllowed: boolean,
 *   nativeReconcileEligible: boolean }>} a frozen diagnostic object.
 * @throws {DispatchRecoveryClassifierError} when inputs are not jury-shaped.
 */
export function classifyDispatchAttempt({ attempt, run, result, capabilities = {} } = {}) {
  if (attempt === null || typeof attempt !== 'object') {
    throw new DispatchRecoveryClassifierError('classifyDispatchAttempt requires a persisted dispatch attempt', {
      required: ['attempt'],
    });
  }
  if (typeof attempt.id !== 'string' || attempt.id === '') {
    throw new DispatchRecoveryClassifierError('dispatch attempt must carry a stable application-generated id');
  }
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new DispatchRecoveryClassifierError('capabilities evidence must be an object such as { resumeExisting }');
  }

  const runStatus = run && typeof run === 'object' ? run.status : null;
  const runIsTerminal = typeof runStatus === 'string' && TERMINAL_RUN_STATUSES.has(runStatus);
  const resultPresent = result !== null && result !== undefined;

  const phase = phaseLabel(attempt);
  const resumeExisting = capabilities.resumeExisting;
  const resumeProved = resumeEvidenceQualifies(resumeExisting);
  const nativeReference = attempt.nativeReference ?? null;
  const corruptPayload = attempt.corruptPayload === true;

  if (corruptPayload && phase !== ATTEMPT_PHASES.TERMINAL_COMMITTED) {
    return Object.freeze({
      attemptId: attempt.id,
      runId: attempt.runId ?? (run && typeof run === 'object' ? run.id : null) ?? null,
      phase: phase,
      classification: RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED,
      reason: `${phase} attempt carries a corrupt durable payload; persisted evidence cannot be trusted without operator inspection`,
      autoReplayAllowed: false,
      nativeReconcileEligible: false,
    });
  }

  let classification;
  let reason;

  switch (phase) {
    case ATTEMPT_PHASES.INTENT_COMMITTED: {
      if (runIsTerminal || resultPresent) {
        classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
        reason = 'intent-committed attempt carries terminal run/result truth that could not have been written atomically';
      } else {
        classification = RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH;
        reason = 'intent committed; external boundary definitely not crossed';
      }
      break;
    }

    case ATTEMPT_PHASES.DISPATCH_STARTED: {
      if (runIsTerminal || resultPresent) {
        classification = RECOVERY_CLASSIFICATIONS.AMBIGUOUS_RESULT_COMMIT;
        reason = 'terminal run/result truth exists without a TERMINAL_COMMITTED attempt';
      } else {
        classification = RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE;
        reason = 'dispatch started; no terminal durable truth';
      }
      break;
    }

    case ATTEMPT_PHASES.REMOTE_STARTED: {
      if (runIsTerminal || resultPresent) {
        classification = RECOVERY_CLASSIFICATIONS.AMBIGUOUS_RESULT_COMMIT;
        reason = 'remote started but terminal truth exists without a TERMINAL_COMMITTED attempt';
      } else if (nativeReference && resumeProved) {
        classification = RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED;
        reason = 'remote started with durable native reference and proved resumability; reconciliation required';
      } else {
        classification = RECOVERY_CLASSIFICATIONS.INTERRUPTED_EXTERNAL_RUN;
        reason = nativeReference
          ? 'remote started with native reference but resumability not proved'
          : 'remote started without a durable native session reference';
      }
      break;
    }

    case ATTEMPT_PHASES.TERMINAL_COMMITTED: {
      if (!run || typeof run !== 'object') {
        classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
        reason = 'terminal-committed attempt has no persisted run';
      } else if (!runIsTerminal) {
        classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
        reason = `terminal-committed attempt references nonterminal run status ${runStatus}`;
      } else if (runStatus === 'completed' && !resultPresent) {
        classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
        reason = 'completed run has no result in a terminal-committed attempt';
      } else if (runStatus !== 'completed' && resultPresent) {
        classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
        reason = `${runStatus} run carries a result in a terminal-committed attempt`;
      } else {
        classification = RECOVERY_CLASSIFICATIONS.CLEAN;
        reason = 'terminal committed with coherent terminal run/result truth';
      }
      break;
    }

    default: {
      classification = RECOVERY_CLASSIFICATIONS.OPERATOR_ACTION_REQUIRED;
      reason = `unknown dispatch attempt phase ${phase}`;
      break;
    }
  }

  return Object.freeze({
    attemptId: attempt.id,
    runId: attempt.runId ?? (run && typeof run === 'object' ? run.id : null) ?? null,
    phase: phase,
    classification,
    reason,
    autoReplayAllowed: classification === RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH,
    nativeReconcileEligible: classification === RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED,
  });
}