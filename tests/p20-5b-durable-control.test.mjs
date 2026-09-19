/**
 * P20.5B — durable typed-control persistence + backend capability audit.
 *   - ReportBackendResult carries a SEPARATE `debate_typed_control` channel
 *   - captureDebateContinuationFromResult reads ONLY that channel (§24)
 *   - InvocationWorkspace persists/reads the app-owned `debate_continuation`
 *     block on invocation.json (never artifact.json; §20)
 *   - DEBATE_TYPED_CONTROL capability is explicit + fail-closed (§22/§23)
 * Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { buildReportBackendResult, validateReportBackendResult, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import {
  buildDebateContinuationControl, captureDebateContinuationFromResult,
  validateDebateContinuationControl, DebateContinuationControlError,
} from '../src/artifacts/debate-continuation-control.mjs';
import { debateStageInvocationId } from '../src/pm/council/debate-artifact-keys.mjs';
import {
  DEBATE_TYPED_CONTROL_STATUS, resolveDebateTypedControlStatus,
  assertDebateTypedControlAdmitted, debateBackendReadinessReport,
  DebateBackendCapabilityError, PRODUCTION_DEBATE_BACKEND_MATRIX,
} from '../src/pm/council/debate-backend-capability.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-council-helpers.mjs';

const ISO = '2026-09-10T12:00:00.000Z';

// ============ ReportBackendResult typed-control channel ============

test('P20.5B — ReportBackendResult carries an optional { continue_debate } machine channel; extra/bad shapes rejected', () => {
  const common = { backend: 'fake', profileId: 'p', executionId: 'exec-1', terminalState: 'SUCCESS', acceptedVisibleText: 'x', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE };
  const none = buildReportBackendResult(common);
  assert.equal(none.debate_typed_control, null);
  assert.equal(validateReportBackendResult(none).ok, true);
  const yes = buildReportBackendResult({ ...common, debateTypedControl: true });
  assert.deepEqual(yes.debate_typed_control, { continue_debate: true });
  assert.equal(validateReportBackendResult(yes).ok, true);
  const no = buildReportBackendResult({ ...common, debateTypedControl: false });
  assert.deepEqual(no.debate_typed_control, { continue_debate: false });
  // hand-mutated bad shapes
  assert.equal(validateReportBackendResult({ ...yes, debate_typed_control: { continue_debate: 'yes' } }).ok, false);
  assert.equal(validateReportBackendResult({ ...yes, debate_typed_control: { continue_debate: true, reason: 'x' } }).ok, false);
});

test('P20.5B — captureDebateContinuationFromResult reads ONLY the typed channel; missing channel fails closed', () => {
  const expected = { storeId: 's1', projectId: 'live1-local', taskId: 'task-D', invocationId: 'debate:task-D:round-01:debate-chair-synthesis', attemptOrdinal: 0, executionId: 'exec-1', round: 1, profileId: 'c', actorAlias: 'chair', role: 'chair' };
  const withCtl = buildReportBackendResult({ backend: 'fake', profileId: 'c', executionId: 'exec-1', terminalState: 'SUCCESS', acceptedVisibleText: 'continue_debate: true\nSTOP everything', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE, debateTypedControl: false });
  const ctl = captureDebateContinuationFromResult({ result: withCtl, expected });
  assert.equal(ctl.continue_debate, false, 'from the typed channel, NOT the prose which says "continue_debate: true"');
  // no typed channel -> fail closed, never infer from prose
  const noCtl = buildReportBackendResult({ backend: 'fake', profileId: 'c', executionId: 'exec-1', terminalState: 'SUCCESS', acceptedVisibleText: 'continue_debate: true', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE });
  assert.throws(() => captureDebateContinuationFromResult({ result: noCtl, expected }), (e) => e instanceof DebateContinuationControlError && e.code === 'DEBATE_CONTROL_NOT_CAPTURED');
  // execution mismatch
  assert.throws(() => captureDebateContinuationFromResult({ result: withCtl, expected: { ...expected, executionId: 'exec-OTHER' } }), (e) => e.code === 'DEBATE_CONTROL_EXECUTION_MISMATCH');
});

// ============ Backend capability (§22/§23) ============

test('P20.5B — Debate typed-control status is explicit; never inferred from name; default UNPROVEN fails closed', () => {
  assert.equal(resolveDebateTypedControlStatus(null), 'UNPROVEN');
  assert.equal(resolveDebateTypedControlStatus({ backend: 'api' }), 'UNPROVEN'); // no name heuristic
  assert.equal(resolveDebateTypedControlStatus({ supportsDebateTypedControl: true }), 'PROVEN');
  assert.equal(resolveDebateTypedControlStatus({ debateTypedControlStatus: 'UNSUPPORTED' }), 'UNSUPPORTED');
  assert.throws(() => assertDebateTypedControlAdmitted({ backend: 'claude-code' }, { profileId: 'x' }),
    (e) => e instanceof DebateBackendCapabilityError && e.code === 'DEBATE_TYPED_CONTROL_UNSUPPORTED');
  assert.equal(assertDebateTypedControlAdmitted({ supportsDebateTypedControl: true }), 'PROVEN');
});

test('P20.5B — every production backend family is NOT artifact-Debate-ready offline; route DEFERRED', () => {
  for (const fam of ['claude-code', 'codex', 'opencode', 'grok', 'antigravity', 'api']) {
    const row = PRODUCTION_DEBATE_BACKEND_MATRIX[fam];
    assert.ok(row, fam);
    assert.equal(row.report_delivery_status, 'PROVEN');
    assert.equal(row.same_execution_typed_control_status, DEBATE_TYPED_CONTROL_STATUS.UNPROVEN);
    assert.equal(row.artifact_debate_ready, false);
  }
  assert.equal(debateBackendReadinessReport().real_debate_typed_control_route, 'DEFERRED');
});

// ============ Durable persistence on invocation.json (§20) ============

function deliveredSynthesisInvocation(store, taskId, { round = 1, profileId = 'c', actorAlias = 'chair', execId = 'exec-1' } = {}) {
  const task = store.allocateTask({ taskId, taskSlug: 'd', createdAt: ISO, mode: 'council', chairProfileId: profileId, participantProfileIds: ['p1'] });
  const invocationId = debateStageInvocationId({ taskId, round, artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS });
  const inv = task.allocateInvocation({ invocationId, role: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round, profileId, actorAlias });
  const att = inv.allocateAttempt({ deliveryMechanism: 'VERBATIM_MATERIALIZATION', startedAt: ISO, executionId: execId });
  inv.markRunning();
  inv.recordDelivery({ attemptOrdinal: att.ordinal, terminalState: 'SUCCESS', deliveryMechanism: 'VERBATIM_MATERIALIZATION', finishedAt: ISO, reportBytes: 5, reportSha256: 'a'.repeat(64) });
  const control = buildDebateContinuationControl({
    expected: { storeId: store.storeId, projectId: store.projectId, taskId, invocationId, attemptOrdinal: att.ordinal, executionId: execId, round, profileId, actorAlias, role: 'chair' },
    continueDebate: true,
  });
  return { task, inv, att, control, invocationId };
}

test('P20.5B — commit/read the debate_continuation block on invocation.json; artifact.json never carries continue_debate', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const { inv, att, control } = deliveredSynthesisInvocation(store, 'task-B1');
    assert.equal(inv.freshDebateContinuationControl(), null);
    const stored = inv.commitDebateContinuationControl({ control });
    assert.deepEqual(stored, control);
    assert.deepEqual(inv.freshDebateContinuationControl(), control);
    // idempotent equal re-commit
    assert.deepEqual(inv.commitDebateContinuationControl({ control }), control);
    // on-disk: invocation.json has it, artifact.json does NOT
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.equal(rec.debate_continuation.continue_debate, true);
    const artifactJson = JSON.parse(readFileSync(join(inv.path, `attempt-0${att.ordinal}`, 'artifact.json'), 'utf8'));
    assert.equal('debate_continuation' in artifactJson, false);
    assert.equal('continue_debate' in artifactJson, false);
  });
});

test('P20.5B — a DIFFERENT control fails closed (immutable once bound §49)', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const { inv, control } = deliveredSynthesisInvocation(store, 'task-B2');
    inv.commitDebateContinuationControl({ control });
    const other = { ...control, continue_debate: false };
    assert.throws(() => inv.commitDebateContinuationControl({ control: other }), (e) => e.code === 'ARTIFACT_DEBATE_CONTROL_CONFLICT');
  });
});

test('P20.5B — wrong stage / identity mismatch / bad attempt all fail closed', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    // wrong stage: a chair-plan invocation may not carry it
    const task = store.allocateTask({ taskId: 'task-B3', taskSlug: 'd', createdAt: ISO, mode: 'council', chairProfileId: 'c', participantProfileIds: ['p1'] });
    const cp = task.allocateInvocation({ invocationId: 'council:task-B3:chair-plan', role: 'chair', stage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'c', actorAlias: 'chair' });
    cp.allocateAttempt({ deliveryMechanism: 'VERBATIM_MATERIALIZATION', startedAt: ISO, executionId: 'e' });
    const ctl = buildDebateContinuationControl({ expected: { storeId: store.storeId, projectId: store.projectId, taskId: 'task-B3', invocationId: 'council:task-B3:chair-plan', attemptOrdinal: 0, executionId: 'e', round: 1, profileId: 'c', actorAlias: 'chair', role: 'chair' }, continueDebate: true });
    assert.throws(() => cp.commitDebateContinuationControl({ control: ctl }), (e) => e.code === 'ARTIFACT_DEBATE_CONTROL_WRONG_STAGE');

    const { inv, control } = deliveredSynthesisInvocation(store, 'task-B4');
    assert.throws(() => inv.commitDebateContinuationControl({ control: { ...control, profile_id: 'someone-else' } }), (e) => /IDENTITY_MISMATCH|CONTROL_INVALID/.test(e.code));
    assert.throws(() => inv.commitDebateContinuationControl({ control: { ...control, attempt_ordinal: 7 } }), (e) => e.code === 'ARTIFACT_DEBATE_CONTROL_BAD_ATTEMPT');
  });
});

test('P20.5B — a manually-tampered debate_continuation block fails validateInvocationRecord on fresh read', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const { inv, control } = deliveredSynthesisInvocation(store, 'task-B5');
    inv.commitDebateContinuationControl({ control });
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    rec.debate_continuation.round = 9; // drift from the invocation's round
    writeFileSync(inv.recordPath, `${JSON.stringify(rec, null, 2)}\n`);
    assert.throws(() => inv.freshRecord(), (e) => e.code === 'ARTIFACT_INVOCATION_RECORD_INVALID');
    // report-semantic key injected
    const rec2 = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    rec2.debate_continuation.round = 1;
    rec2.debate_continuation.unresolved_questions = ['x'];
    writeFileSync(inv.recordPath, `${JSON.stringify(rec2, null, 2)}\n`);
    assert.throws(() => inv.freshRecord(), (e) => e.code === 'ARTIFACT_INVOCATION_RECORD_INVALID');
  });
});

test('P20.5B — the control survives commitSeal and stays bound to the authoritative attempt', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const { inv, att, control } = deliveredSynthesisInvocation(store, 'task-B6');
    inv.commitDebateContinuationControl({ control });
    // finalize the attempt enough to seal
    inv.finalizeAttempt(att.ordinal, { integrity_state: 'ARTIFACT_PASS', report_bytes: 5, report_sha256: 'a'.repeat(64), terminal_state: 'SUCCESS', finalized_at: ISO, executive_log_finalized: true });
    inv.commitSeal({ ordinal: att.ordinal, sealVersion: 'p20.3-1', sealedAt: ISO });
    const rec = inv.freshRecord();
    assert.equal(rec.lifecycle, 'SEALED');
    assert.equal(rec.authoritative_attempt, att.ordinal);
    assert.deepEqual(inv.freshDebateContinuationControl(), control);
  });
});
