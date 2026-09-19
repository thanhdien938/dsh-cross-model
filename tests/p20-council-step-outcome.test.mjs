/**
 * P20.4 §14 — versioned artifact_v1 Council step outcome contract. Pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { buildArtifactReference } from '../src/artifacts/artifact-schema.mjs';
import {
  buildArtifactStepSuccess,
  buildArtifactStepFailure,
  validateArtifactStepOutcome,
  sanitizeStepReason,
  COUNCIL_STEP_EXECUTION_STATE,
  COUNCIL_ARTIFACT_STEP_KINDS,
  CouncilArtifactStepOutcomeError,
} from '../src/pm/council/council-artifact-step-outcome.mjs';

const sealedRef = () => buildArtifactReference({
  storeId: 's1', projectId: 'live1-local', taskId: 'task-abcd1234', invocationId: 'inv-x',
  attemptOrdinal: 0, artifactRelpath: 'tasks/t/members/alpha/participant-report/inv-x/attempt-00/x.md',
  sha256: 'a'.repeat(64), bytes: 42, sealedAt: '2026-09-10T10:00:00.000Z',
}, { sealed: true });

test('a successful outcome carries only app-owned facts + a valid sealed_ref', () => {
  const o = buildArtifactStepSuccess({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT,
    artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
    stageKey: 'participant-report::alpha',
    profileId: 'live1-fake', actorAlias: 'alpha',
    sealedRef: sealedRef(),
  });
  assert.equal(o.transport_version, 'artifact_v1');
  assert.equal(o.ok, true);
  assert.equal(o.execution_state, COUNCIL_STEP_EXECUTION_STATE.SEALED);
  assert.equal(o.sealed_ref.sha256, 'a'.repeat(64));
  assert.equal(o.failure_code, null);
  assert.deepEqual(o.repair, { repaired: false, repair_kind: null });
  assert.equal(validateArtifactStepOutcome(o).ok, true);
});

test('RECOVERED_FROM_SEAL is an allowed successful state; repair facts are bounded', () => {
  const o = buildArtifactStepSuccess({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_PLAN, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN,
    stageKey: 'chair-plan', profileId: 'live1-chair', actorAlias: 'chair',
    sealedRef: sealedRef(), executionState: COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL,
    repair: { repaired: true, repairKind: 'DELIVERY_REPAIR_EMPTY_REPORT' },
  });
  assert.equal(o.execution_state, 'RECOVERED_FROM_SEAL');
  assert.deepEqual(o.repair, { repaired: true, repair_kind: 'DELIVERY_REPAIR_EMPTY_REPORT' });
  assert.equal(validateArtifactStepOutcome(o).ok, true);
});

test('a failed outcome never carries a sealed_ref and always carries a failure_code', () => {
  const o = buildArtifactStepFailure({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE,
    profileId: 'live1-fake', actorAlias: 'beta',
    failureCode: 'REPORT_EXECUTION_TIMEOUT', reason: 'provider timed out\n\nsecret: xyz',
  });
  assert.equal(o.ok, false);
  assert.equal(o.sealed_ref, null);
  assert.equal(o.failure_code, 'REPORT_EXECUTION_TIMEOUT');
  assert.equal(o.execution_state, COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED);
  assert.equal(o.reason.includes('\n'), false, 'reason is single-line/sanitized');
  assert.equal(validateArtifactStepOutcome(o).ok, true);
});

test('SKIPPED / RECONCILED_NO_REPLAY are failure-family states', () => {
  const skipped = buildArtifactStepFailure({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE, profileId: 'p', actorAlias: 'g',
    failureCode: 'COUNCIL_CRITIQUE_SKIPPED_ROUND1_FAILED', executionState: COUNCIL_STEP_EXECUTION_STATE.SKIPPED,
  });
  assert.equal(validateArtifactStepOutcome(skipped).ok, true);
  const reconciled = buildArtifactStepFailure({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT, profileId: 'p', actorAlias: 'g',
    failureCode: 'COUNCIL_STEP_RECONCILE_REQUIRED', executionState: COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY,
  });
  assert.equal(validateArtifactStepOutcome(reconciled).ok, true);
});

test('the builder sanitizes by construction — an illegal repair key is dropped, not copied', () => {
  const o = buildArtifactStepSuccess({
    stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
    stageKey: 'participant-report::alpha', profileId: 'p', actorAlias: 'alpha', sealedRef: sealedRef(),
    repair: { repaired: true, repairKind: 'DELIVERY_REPAIR_ZERO_CANDIDATE', recommendation: 'ship it' },
  });
  assert.deepEqual(o.repair, { repaired: true, repair_kind: 'DELIVERY_REPAIR_ZERO_CANDIDATE' });
  assert.equal(validateArtifactStepOutcome(o).ok, true);
});

test('validateArtifactStepOutcome / assertNoSemanticLeak reject a hand-crafted semantic leak', () => {
  const leaky = {
    transport_version: 'artifact_v1', ok: false, step_kind: 'participant_report',
    execution_state: 'EXECUTION_FAILED', profile_id: 'p', actor_alias: 'a', sealed_ref: null,
    failure_code: 'X', reason: null, repair: { repaired: false, repair_kind: null },
    artifact_stage: null, stage_key: null,
    diagnostics: { recommendation: 'do X' }, // forbidden key nested
  };
  const v = validateArtifactStepOutcome(leaky);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('forbidden semantic keys')));
});

test('validateArtifactStepOutcome rejects a fabricated ref on a failed step and a missing ref on a success', () => {
  const badFail = { transport_version: 'artifact_v1', ok: false, step_kind: 'participant_report', execution_state: 'EXECUTION_FAILED', profile_id: 'p', actor_alias: 'a', sealed_ref: sealedRef(), failure_code: 'X', reason: null, repair: { repaired: false, repair_kind: null }, artifact_stage: null, stage_key: null };
  assert.equal(validateArtifactStepOutcome(badFail).ok, false);
  const badOk = { transport_version: 'artifact_v1', ok: true, step_kind: 'chair_plan', execution_state: 'SEALED', profile_id: 'p', actor_alias: 'a', sealed_ref: null, failure_code: null, reason: null, repair: { repaired: false, repair_kind: null }, artifact_stage: 'chair-plan', stage_key: 'chair-plan' };
  assert.equal(validateArtifactStepOutcome(badOk).ok, false);
});

test('sanitizeStepReason bounds length and strips control chars', () => {
  assert.equal(sanitizeStepReason(null), null);
  assert.equal(sanitizeStepReason('a\nb\tc'), 'a b c');
  assert.equal(sanitizeStepReason('x'.repeat(500)).length, 241);
});
