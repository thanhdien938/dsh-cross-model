/**
 * P12-R2 — independent task outcome-dimension model (docs/p12/01_P12_R0_*
 * §6). Pure, no I/O. Every dimension is a thin, explicitly-named projection
 * over data the caller already owns — this module never becomes a second
 * source of truth: it derives, it never persists or decides anything on its
 * own.
 *
 * Deliberately avoids bare `FAILED`/`COMPLETED`/`DEGRADED` for any NEW value
 * here — those words are already heavily overloaded elsewhere in the
 * codebase (pm_runs.status, workflow/step status, council phase,
 * BACKEND_HEALTH_STATUS.DEGRADED, council's own boolean `degraded` fact —
 * see docs/p12/01_P12_R0_*_SONNET5.md §1.6). Every new enum value below is a
 * compound, unambiguous name.
 */

export const EXECUTION_STATUS = Object.freeze({
  RUNNING: 'EXECUTION_RUNNING',
  PASSED: 'EXECUTION_PASSED',
  FAILED: 'EXECUTION_FAILED',
  CANCELLED: 'EXECUTION_CANCELLED',
});

export const VERIFICATION_STATUS = Object.freeze({
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PASSED: 'VERIFICATION_PASSED',
  FAILED: 'VERIFICATION_FAILED',
});

export const ARTIFACT_STATUS = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  MATERIALIZED: 'ARTIFACTS_MATERIALIZED',
  PARTIAL: 'ARTIFACT_MATERIALIZATION_PARTIAL',
  FAILED: 'ARTIFACT_MATERIALIZATION_FAILED',
});

export const LOCAL_GIT_STATUS = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  VERIFIED: 'LOCAL_COMMIT_VERIFIED',
  // P12-R5B Part J/K: a REAL, DSH-verified distinction from VERIFIED above —
  // task-result-git-sync.mjs's commitTaskResult() already reports
  // `committed:false` truthfully when the working tree was clean (nothing
  // for the backend to have written), but production-pm-worker.mjs used to
  // collapse that into the SAME 'LOCAL_COMMIT_VERIFIED' value as a real new
  // commit, so an owner reading only local_git_status could not tell "a
  // change was committed" apart from "nothing changed to commit" — exactly
  // the gap that let a model's own prose ("I created the file") stand in
  // for verified evidence when nothing had actually been git-committed.
  // Never a failure (a task that legitimately made no repo changes, e.g. a
  // read-only query, is not an error) — a distinct, honest fact.
  VERIFIED_NO_CHANGES: 'LOCAL_GIT_VERIFIED_NO_CHANGES',
  FAILED: 'LOCAL_GIT_FAILED',
});

export const REMOTE_SYNC_STATUS = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  VERIFIED: 'REMOTE_PUSH_VERIFIED',
  FAILED: 'REMOTE_SYNC_FAILED',
});

// R4 will populate/consume this; R2 only ever produces NOT_REQUESTED.
export const REVIEW_STATUS = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  ACCEPTED: 'ACCEPTED',
  REMEDIATION_REQUESTED: 'REMEDIATION_REQUESTED',
  BLOCKED_REMOTE: 'REVIEW_BLOCKED_REMOTE',
});

/** Direct rename-projection of the existing pm_runs.status vocabulary — never a second source of truth, never diverges from it. */
export function executionStatusFromRunStatus(runStatus) {
  switch (runStatus) {
    case 'completed': return EXECUTION_STATUS.PASSED;
    case 'failed': return EXECUTION_STATUS.FAILED;
    case 'cancelled': return EXECUTION_STATUS.CANCELLED;
    default: return EXECUTION_STATUS.RUNNING;
  }
}

/**
 * Convention-based, additive-only verification read: `finish.data` was
 * already a free-form plain object before P12 (pm-contracts.mjs) — no
 * schema change. If a PM driver ever populates
 * `data.verification: {status:'PASSED'|'FAILED'}` this reads it; otherwise
 * (every driver today) this is NOT_APPLICABLE. Never invented/guessed from
 * prose.
 */
export function verificationStatusFromFinalData(finalData) {
  const raw = finalData && typeof finalData === 'object' ? finalData.verification : null;
  const status = raw && typeof raw === 'object' && typeof raw.status === 'string' ? raw.status.toUpperCase() : null;
  if (status === 'PASSED') return VERIFICATION_STATUS.PASSED;
  if (status === 'FAILED') return VERIFICATION_STATUS.FAILED;
  return VERIFICATION_STATUS.NOT_APPLICABLE;
}

/**
 * Assemble the six independent dimensions into one bounded outcome record.
 * `degraded` (council's own pre-existing, programmatic boolean fact — never
 * recomputed here) and the artifact/git/sync statuses are supplied by the
 * caller, who is the only one with access to that data.
 */
export function buildTaskOutcome({
  executionStatus,
  verificationStatus = VERIFICATION_STATUS.NOT_APPLICABLE,
  artifactStatus = ARTIFACT_STATUS.NOT_REQUESTED,
  localGitStatus = LOCAL_GIT_STATUS.NOT_REQUESTED,
  remoteSyncStatus = REMOTE_SYNC_STATUS.NOT_REQUESTED,
  reviewStatus = REVIEW_STATUS.NOT_REQUESTED,
  degraded = false,
  blockedSource = false,
  blockedContext = false,
} = {}) {
  const terminalMarker = computeTerminalMarker({
    executionStatus, verificationStatus, artifactStatus, localGitStatus, remoteSyncStatus, degraded, blockedSource, blockedContext,
  });
  const persistenceWarning = isPersistenceWarning({ artifactStatus, localGitStatus, remoteSyncStatus });
  return Object.freeze({
    execution_status: executionStatus,
    verification_status: verificationStatus,
    artifact_status: artifactStatus,
    local_git_status: localGitStatus,
    remote_sync_status: remoteSyncStatus,
    review_status: reviewStatus,
    degraded: Boolean(degraded),
    persistence_warning: persistenceWarning,
    terminal_marker: terminalMarker,
  });
}

function isPersistenceWarning({ artifactStatus, localGitStatus, remoteSyncStatus }) {
  return artifactStatus === ARTIFACT_STATUS.FAILED || artifactStatus === ARTIFACT_STATUS.PARTIAL
    || localGitStatus === LOCAL_GIT_STATUS.FAILED
    || remoteSyncStatus === REMOTE_SYNC_STATUS.FAILED;
}

/**
 * P12-R0 §6.2 precedence, exactly: CANCELLED overrides everything;
 * BLOCKED_SOURCE/BLOCKED_CONTEXT next (execution never began); then
 * FAILED_EXECUTION; then FAILED_VERIFICATION; otherwise COMPLETED with
 * `_DEGRADED`/`_WITH_PERSISTENCE_WARNING` suffixes composed independently —
 * never collapsed into a single undifferentiated failure state (P12
 * principle 2.5).
 */
export function computeTerminalMarker({
  executionStatus, verificationStatus, artifactStatus, localGitStatus, remoteSyncStatus,
  degraded = false, blockedSource = false, blockedContext = false,
} = {}) {
  if (executionStatus === EXECUTION_STATUS.CANCELLED) return 'CANCELLED';
  if (blockedSource) return 'BLOCKED_SOURCE';
  if (blockedContext) return 'BLOCKED_CONTEXT';
  if (executionStatus === EXECUTION_STATUS.FAILED) return 'FAILED_EXECUTION';
  if (executionStatus === EXECUTION_STATUS.PASSED && verificationStatus === VERIFICATION_STATUS.FAILED) return 'FAILED_VERIFICATION';
  let marker = 'COMPLETED';
  if (degraded) marker += '_DEGRADED';
  if (isPersistenceWarning({ artifactStatus, localGitStatus, remoteSyncStatus })) marker += '_WITH_PERSISTENCE_WARNING';
  return marker;
}
