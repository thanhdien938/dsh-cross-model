import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_STATUS, VERIFICATION_STATUS, ARTIFACT_STATUS, LOCAL_GIT_STATUS, REMOTE_SYNC_STATUS, REVIEW_STATUS,
  executionStatusFromRunStatus, verificationStatusFromFinalData, buildTaskOutcome, computeTerminalMarker,
} from '../src/pm/task-outcome-model.mjs';

// P12-R2 — the independent six-dimension outcome model (docs/p12/01_P12_R0_*
// §6). Pure logic only; no I/O.

test('executionStatusFromRunStatus is a direct, lossless projection of pm_runs.status', () => {
  assert.equal(executionStatusFromRunStatus('completed'), EXECUTION_STATUS.PASSED);
  assert.equal(executionStatusFromRunStatus('failed'), EXECUTION_STATUS.FAILED);
  assert.equal(executionStatusFromRunStatus('cancelled'), EXECUTION_STATUS.CANCELLED);
  assert.equal(executionStatusFromRunStatus('running'), EXECUTION_STATUS.RUNNING);
  assert.equal(executionStatusFromRunStatus('anything-else'), EXECUTION_STATUS.RUNNING);
});

test('verificationStatusFromFinalData defaults to NOT_APPLICABLE — no backend populates this convention yet', () => {
  assert.equal(verificationStatusFromFinalData(null), VERIFICATION_STATUS.NOT_APPLICABLE);
  assert.equal(verificationStatusFromFinalData({}), VERIFICATION_STATUS.NOT_APPLICABLE);
  assert.equal(verificationStatusFromFinalData({ verification: {} }), VERIFICATION_STATUS.NOT_APPLICABLE);
  assert.equal(verificationStatusFromFinalData({ verification: { status: 'unrecognized' } }), VERIFICATION_STATUS.NOT_APPLICABLE);
});

test('verificationStatusFromFinalData reads the optional PASSED/FAILED convention when a driver populates it', () => {
  assert.equal(verificationStatusFromFinalData({ verification: { status: 'PASSED' } }), VERIFICATION_STATUS.PASSED);
  assert.equal(verificationStatusFromFinalData({ verification: { status: 'failed' } }), VERIFICATION_STATUS.FAILED);
});

test('computeTerminalMarker: CANCELLED overrides every other dimension', () => {
  const marker = computeTerminalMarker({
    executionStatus: EXECUTION_STATUS.CANCELLED,
    verificationStatus: VERIFICATION_STATUS.FAILED,
    artifactStatus: ARTIFACT_STATUS.FAILED,
    localGitStatus: LOCAL_GIT_STATUS.FAILED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.FAILED,
    degraded: true,
  });
  assert.equal(marker, 'CANCELLED');
});

test('computeTerminalMarker: BLOCKED_SOURCE/BLOCKED_CONTEXT never collapse to FAILED_EXECUTION', () => {
  assert.equal(computeTerminalMarker({ executionStatus: EXECUTION_STATUS.RUNNING, blockedSource: true }), 'BLOCKED_SOURCE');
  assert.equal(computeTerminalMarker({ executionStatus: EXECUTION_STATUS.RUNNING, blockedContext: true }), 'BLOCKED_CONTEXT');
});

test('computeTerminalMarker: plain execution failure is FAILED_EXECUTION regardless of other dimensions', () => {
  const marker = computeTerminalMarker({
    executionStatus: EXECUTION_STATUS.FAILED,
    artifactStatus: ARTIFACT_STATUS.MATERIALIZED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.VERIFIED,
  });
  assert.equal(marker, 'FAILED_EXECUTION');
});

test('computeTerminalMarker: verification failure after successful execution is FAILED_VERIFICATION, not COMPLETED', () => {
  const marker = computeTerminalMarker({ executionStatus: EXECUTION_STATUS.PASSED, verificationStatus: VERIFICATION_STATUS.FAILED });
  assert.equal(marker, 'FAILED_VERIFICATION');
});

test('computeTerminalMarker: successful execution with no warnings is bare COMPLETED', () => {
  const marker = computeTerminalMarker({
    executionStatus: EXECUTION_STATUS.PASSED,
    verificationStatus: VERIFICATION_STATUS.NOT_APPLICABLE,
    artifactStatus: ARTIFACT_STATUS.NOT_REQUESTED,
    localGitStatus: LOCAL_GIT_STATUS.NOT_REQUESTED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.NOT_REQUESTED,
  });
  assert.equal(marker, 'COMPLETED');
});

test('computeTerminalMarker: the canonical persistence-warning example from the P12 plan — push fails after everything else passed', () => {
  const marker = computeTerminalMarker({
    executionStatus: EXECUTION_STATUS.PASSED,
    verificationStatus: VERIFICATION_STATUS.PASSED,
    artifactStatus: ARTIFACT_STATUS.MATERIALIZED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.FAILED,
  });
  assert.equal(marker, 'COMPLETED_WITH_PERSISTENCE_WARNING');
});

test('computeTerminalMarker: degraded and persistence-warning suffixes compose independently, both at once', () => {
  const marker = computeTerminalMarker({
    executionStatus: EXECUTION_STATUS.PASSED,
    artifactStatus: ARTIFACT_STATUS.FAILED,
    degraded: true,
  });
  assert.equal(marker, 'COMPLETED_DEGRADED_WITH_PERSISTENCE_WARNING');
});

test('computeTerminalMarker: degraded alone (no persistence issue) is COMPLETED_DEGRADED', () => {
  const marker = computeTerminalMarker({ executionStatus: EXECUTION_STATUS.PASSED, degraded: true });
  assert.equal(marker, 'COMPLETED_DEGRADED');
});

test('buildTaskOutcome: assembles all six dimensions plus the computed terminal marker, without mutating execution_status on persistence failure', () => {
  const outcome = buildTaskOutcome({
    executionStatus: EXECUTION_STATUS.PASSED,
    verificationStatus: VERIFICATION_STATUS.PASSED,
    artifactStatus: ARTIFACT_STATUS.MATERIALIZED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.FAILED,
    reviewStatus: REVIEW_STATUS.NOT_REQUESTED,
  });
  assert.equal(outcome.execution_status, EXECUTION_STATUS.PASSED, 'a downstream persistence failure must never mutate execution_status');
  assert.equal(outcome.verification_status, VERIFICATION_STATUS.PASSED);
  assert.equal(outcome.remote_sync_status, REMOTE_SYNC_STATUS.FAILED);
  assert.equal(outcome.persistence_warning, true);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.terminal_marker, 'COMPLETED_WITH_PERSISTENCE_WARNING');
  assert.deepEqual(Object.keys(outcome).sort(), [
    'artifact_status', 'degraded', 'execution_status', 'local_git_status',
    'persistence_warning', 'remote_sync_status', 'review_status', 'terminal_marker', 'verification_status',
  ].sort());
});

test('buildTaskOutcome: is frozen — callers cannot mutate a computed outcome after the fact', () => {
  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED });
  assert.throws(() => { outcome.terminal_marker = 'TAMPERED'; }, TypeError);
});
