/**
 * P20.5A — foundation: round-scoped Debate stage keys / invocation identities,
 * Debate step-identity + step-outcome round binding, the typed continuation
 * control contract + validator/binder, and the Council finalization split
 * (verifyCouncilArtifactTopology / commitCouncilFinalRef). Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import {
  debateStageKey, parseDebateStageKey, debateStageInvocationId,
  debateRoundStageKeyPlan, debateFinalStageKey, DebateArtifactKeyError,
} from '../src/pm/council/debate-artifact-keys.mjs';
import {
  expectedDebateArtifactStepIdentity, expectedArtifactStepIdentity,
} from '../src/pm/council/council-artifact-step-identity.mjs';
import {
  buildArtifactStepSuccess, buildArtifactStepFailure, validateArtifactStepOutcome,
  validateCouncilArtifactStepBinding, COUNCIL_ARTIFACT_STEP_KINDS, isDebateArtifactStepKind,
} from '../src/pm/council/council-artifact-step-outcome.mjs';
import {
  buildDebateContinuationControl, validateDebateContinuationControl,
  validateDebateContinuationControlBinding, assertDebateContinuationControlBinding,
  evaluateEffectiveContinuation, DebateContinuationControlError,
  DEBATE_CONTINUATION_SCHEMA_VERSION,
} from '../src/artifacts/debate-continuation-control.mjs';
import {
  runCouncilArtifactStage, verifyCouncilArtifactTopology, commitCouncilFinalRef,
  runCouncilFinalArtifactGate,
} from '../src/pm/council/council-artifact-orchestrator.mjs';
import { councilStageKeyPlan } from '../src/pm/council/council-artifact-stage-keys.mjs';
import { buildCouncilArtifactControl } from '../src/pm/council/council-artifact-control.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

// ================= Debate stage keys / invocation identity =================

test('P20.5A — debateStageKey: frozen round-scoped forms', () => {
  assert.equal(debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: 1 }), 'debate::round-01::chair-brief');
  assert.equal(debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round: 2 }), 'debate::round-02::chair-synthesis');
  assert.equal(debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round: 1, actorAlias: 'alpha' }), 'debate::round-01::response::alpha');
  assert.equal(debateFinalStageKey(2), 'debate::round-02::chair-synthesis');
});

test('P20.5A — debateStageKey: alias required for response, forbidden for chair stages', () => {
  assert.throws(() => debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round: 1 }),
    (e) => e instanceof DebateArtifactKeyError && e.code === 'DEBATE_KEY_ALIAS_REQUIRED');
  assert.throws(() => debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: 1, actorAlias: 'alpha' }),
    (e) => e.code === 'DEBATE_KEY_UNEXPECTED_ALIAS');
  assert.throws(() => debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: 0 }),
    (e) => e.code === 'DEBATE_KEY_BAD_ROUND');
});

test('P20.5A — parseDebateStageKey round-trips and rejects junk', () => {
  for (const key of ['debate::round-01::chair-brief', 'debate::round-02::chair-synthesis', 'debate::round-01::response::gamma']) {
    const p = parseDebateStageKey(key);
    assert.ok(p, key);
    assert.equal(debateStageKey({ artifactStage: p.artifactStage, round: p.round, actorAlias: p.actorAlias }), key);
  }
  assert.equal(parseDebateStageKey('debate::round-1::chair-brief'), null);
  assert.equal(parseDebateStageKey('debate::round-01::nope'), null);
  assert.equal(parseDebateStageKey('council::chair-plan'), null);
});

test('P20.5A — debateStageInvocationId is round-scoped and distinct across rounds (§10/§42)', () => {
  const r1 = debateStageInvocationId({ taskId: 'task-X', round: 1, artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS });
  const r2 = debateStageInvocationId({ taskId: 'task-X', round: 2, artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS });
  assert.equal(r1, 'debate:task-X:round-01:debate-chair-synthesis');
  assert.equal(r2, 'debate:task-X:round-02:debate-chair-synthesis');
  assert.notEqual(r1, r2);
  const mr1 = debateStageInvocationId({ taskId: 'task-X', round: 1, artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, actorAlias: 'alpha' });
  const mr2 = debateStageInvocationId({ taskId: 'task-X', round: 2, artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, actorAlias: 'alpha' });
  assert.equal(mr1, 'debate:task-X:round-01:debate-member-response:alpha');
  assert.notEqual(mr1, mr2);
});

test('P20.5A — debateRoundStageKeyPlan: brief + one response key per roster alias in owner order + synthesis', () => {
  const plan = debateRoundStageKeyPlan({ round: 1, rosterAliases: ['gamma', 'alpha', 'beta'] });
  assert.equal(plan.brief, 'debate::round-01::chair-brief');
  assert.deepEqual(plan.responses, ['debate::round-01::response::gamma', 'debate::round-01::response::alpha', 'debate::round-01::response::beta']);
  assert.equal(plan.synthesis, 'debate::round-01::chair-synthesis');
  assert.throws(() => debateRoundStageKeyPlan({ round: 1, rosterAliases: ['a', 'a'] }), (e) => e.code === 'DEBATE_KEY_DUP_ALIAS');
});

// ================= Debate step identity =================

test('P20.5A — expectedDebateArtifactStepIdentity carries round + stage/role/key', () => {
  const brief = expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF, round: 1, profileId: 'c', actorAlias: 'chair' });
  assert.deepEqual(brief, { stepKind: 'debate_brief', artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, stageKey: 'debate::round-01::chair-brief', round: 1, profileId: 'c', actorAlias: 'chair', role: 'chair' });
  const resp = expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE, round: 2, profileId: 'p1', actorAlias: 'alpha' });
  assert.equal(resp.stageKey, 'debate::round-02::response::alpha');
  assert.equal(resp.role, 'member');
  assert.equal(resp.round, 2);
  assert.equal(expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF, round: 0, profileId: 'c', actorAlias: 'chair' }), null);
  // unified resolver dispatches on step kind
  assert.equal(expectedArtifactStepIdentity({ stepKind: 'chair_plan', profileId: 'c', actorAlias: 'chair' }).artifactStage, ARTIFACT_STAGE.CHAIR_PLAN);
  assert.equal(expectedArtifactStepIdentity({ stepKind: 'debate_synthesis', round: 1, profileId: 'c', actorAlias: 'chair' }).stageKey, 'debate::round-01::chair-synthesis');
});

// ================= Step outcome round binding =================

test('P20.5A — a Council step outcome carries round:null; a Debate step outcome requires an integer round', () => {
  assert.equal(isDebateArtifactStepKind('debate_response'), true);
  assert.equal(isDebateArtifactStepKind('participant_report'), false);
  const councilFail = buildArtifactStepFailure({ stepKind: 'participant_report', profileId: 'p1', actorAlias: 'alpha', failureCode: 'X' });
  assert.equal(councilFail.round, null);
  assert.throws(() => buildArtifactStepFailure({ stepKind: 'participant_report', round: 1, profileId: 'p1', actorAlias: 'alpha', failureCode: 'X' }), (e) => e.code === 'COUNCIL_STEP_OUTCOME_BAD_ROUND');
  const debateFail = buildArtifactStepFailure({ stepKind: 'debate_response', round: 1, profileId: 'p1', actorAlias: 'alpha', failureCode: 'X' });
  assert.equal(debateFail.round, 1);
  assert.equal(validateArtifactStepOutcome(debateFail).ok, true);
  assert.throws(() => buildArtifactStepFailure({ stepKind: 'debate_response', profileId: 'p1', actorAlias: 'alpha', failureCode: 'X' }), (e) => e.code === 'COUNCIL_STEP_OUTCOME_BAD_ROUND');
  // shape validator catches a Debate outcome with a bad round
  const bad = { ...debateFail, round: 0 };
  assert.equal(validateArtifactStepOutcome(bad).ok, false);
});

test('P20.5A — validateCouncilArtifactStepBinding rejects a round mismatch', () => {
  const expected = expectedDebateArtifactStepIdentity({ stepKind: 'debate_response', round: 2, profileId: 'p1', actorAlias: 'alpha' });
  const handoff = {
    transport_version: 'artifact_v1', ok: false, step_kind: 'debate_response',
    artifact_stage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, stage_key: 'debate::round-01::response::alpha',
    round: 1, profile_id: 'p1', actor_alias: 'alpha', execution_state: 'EXECUTION_FAILED',
    sealed_ref: null, failure_code: 'X', reason: null, repair: { repaired: false, repair_kind: null },
  };
  const v = validateCouncilArtifactStepBinding({ handoff, expected });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /round 1 != expected 2/.test(e)));
});

// ================= Typed continuation control =================

const CTRL_EXPECTED = {
  storeId: 's1', projectId: 'live1-local', taskId: 'task-D',
  invocationId: 'debate:task-D:round-01:debate-chair-synthesis',
  attemptOrdinal: 0, executionId: 'exec-abc', round: 1,
  profileId: 'live1-chair', actorAlias: 'chair', role: 'chair',
};

test('P20.5A — buildDebateContinuationControl: machine-only record; non-boolean / bad identity fail closed', () => {
  const ok = buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: true });
  assert.equal(ok.schema_version, DEBATE_CONTINUATION_SCHEMA_VERSION);
  assert.equal(ok.control_kind, 'debate_continuation');
  assert.equal(ok.stage, ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS);
  assert.equal(ok.continue_debate, true);
  assert.equal(ok.round, 1);
  assert.equal(validateDebateContinuationControl(ok).ok, true);
  assert.throws(() => buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: 'true' }), (e) => e instanceof DebateContinuationControlError && e.code === 'DEBATE_CONTROL_NOT_BOOLEAN');
  assert.throws(() => buildDebateContinuationControl({ expected: { ...CTRL_EXPECTED, executionId: '' }, continueDebate: false }), (e) => e.code === 'DEBATE_CONTROL_BAD_IDENTITY');
});

test('P20.5A — validateDebateContinuationControl rejects report-semantic keys', () => {
  const base = buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: false });
  for (const k of ['reason', 'unresolved_questions', 'analysis', 'recommendation', 'summary', 'findings']) {
    const v = validateDebateContinuationControl({ ...base, [k]: 'leaked' });
    assert.equal(v.ok, false, k);
  }
});

test('P20.5A — control binding: identity + authoritative-attempt bind, mismatch fails closed', () => {
  const control = buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: true });
  const inv = { store_id: 's1', project_id: 'live1-local', task_id: 'task-D', invocation_id: CTRL_EXPECTED.invocationId, round: 1, profile_id: 'live1-chair', actor_alias: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, authoritative_attempt: 0 };
  const att = { store_id: 's1', project_id: 'live1-local', task_id: 'task-D', invocation_id: CTRL_EXPECTED.invocationId, attempt_ordinal: 0, execution_id: 'exec-abc', round: 1, profile_id: 'live1-chair', actor_alias: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS };
  assert.equal(validateDebateContinuationControlBinding({ control, expected: CTRL_EXPECTED, sealedInvocationRecord: inv, sealedAttemptMetadata: att }).ok, true);
  // control from another round
  const otherRound = { ...control, round: 2 };
  assert.equal(validateDebateContinuationControlBinding({ control: otherRound, expected: CTRL_EXPECTED, sealedInvocationRecord: inv, sealedAttemptMetadata: att }).ok, false);
  // control bound to a non-authoritative attempt
  const wrongAttempt = buildDebateContinuationControl({ expected: { ...CTRL_EXPECTED, attemptOrdinal: 1 }, continueDebate: true });
  assert.throws(() => assertDebateContinuationControlBinding({ control: wrongAttempt, expected: CTRL_EXPECTED, sealedInvocationRecord: inv, sealedAttemptMetadata: att }),
    (e) => e.code === 'DEBATE_CONTINUATION_CONTROL_BINDING_MISMATCH');
});

test('P20.5A — evaluateEffectiveContinuation: hard cap forces stop regardless of typed control', () => {
  const yes = buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: true });
  // round 1, max_rounds 2, hard cap 2 -> a round remains
  assert.deepEqual(evaluateEffectiveContinuation({ control: yes, round: 1, maxRounds: 2, hardCap: 2 }),
    { effectiveContinue: true, modelControlContinue: true, roundsRemaining: true, engineForcedStop: false });
  // round 1, max_rounds 1 -> engine forced stop
  assert.deepEqual(evaluateEffectiveContinuation({ control: yes, round: 1, maxRounds: 1, hardCap: 2 }),
    { effectiveContinue: false, modelControlContinue: true, roundsRemaining: false, engineForcedStop: true });
  // round 2, hard cap 2 -> engine forced stop
  assert.equal(evaluateEffectiveContinuation({ control: yes, round: 2, maxRounds: 2, hardCap: 2 }).engineForcedStop, true);
  // typed false -> plain stop, not engine-forced
  const no = buildDebateContinuationControl({ expected: CTRL_EXPECTED, continueDebate: false });
  assert.deepEqual(evaluateEffectiveContinuation({ control: no, round: 1, maxRounds: 2, hardCap: 2 }),
    { effectiveContinue: false, modelControlContinue: false, roundsRemaining: true, engineForcedStop: false });
});

// ================= Council finalization split (§15) =================

async function sealCouncil(dir, taskId) {
  const store = makeStore(dir);
  const spec = council({ rounds: 1 });
  const reg = aliasRegistryFor(spec);
  const be = councilBackends();
  const task = store.allocateTask({ taskId, taskSlug: 'fs', createdAt: COUNCIL_CREATED_AT, mode: 'council', chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] });
  task.bindCouncilControl({ control: buildCouncilArtifactControl(spec), topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] } });
  const common = { store, task, taskId, createdAt: COUNCIL_CREATED_AT, consumerInputTransport: 'VERBATIM_CONTENT' };
  const chair = await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: spec.chair_profile_id, actorAlias: reg.get(spec.chair_profile_id), backend: 'fake', reportBackend: be(spec.chair_profile_id), instructions: 'plan' });
  const reports = new Map();
  for (const id of spec.participant_profile_ids) {
    // eslint-disable-next-line no-await-in-loop
    reports.set(id, await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: id, actorAlias: reg.get(id), backend: 'fake', reportBackend: be(id), instructions: 'r', inputReferences: [{ label: 'c', reference: chair.sealed_ref }] }));
  }
  const synth = await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS, profileId: spec.chair_profile_id, actorAlias: reg.get(spec.chair_profile_id), backend: 'fake', reportBackend: be(spec.chair_profile_id), instructions: 's', inputReferences: [{ label: 'c', reference: chair.sealed_ref }, ...spec.participant_profile_ids.map((id) => ({ label: id, reference: reports.get(id).sealed_ref }))] });
  const stageKeyPlan = councilStageKeyPlan({ rounds: 1, participantAliases: spec.participant_profile_ids.map((id) => reg.get(id)) });
  return { store, task, spec, chair, reports, synth, stageKeyPlan, reg };
}

const gateArgs = (x) => ({ store: x.store, task: x.task, chairPlanOutcome: x.chair, reportOutcomes: x.reports, critiqueOutcomes: new Map(), synthesisOutcome: x.synth, council: x.spec, stageKeyPlan: x.stageKeyPlan, participants: x.spec.participant_profile_ids, aliasRegistry: x.reg });

test('P20.5A — verifyCouncilArtifactTopology verifies WITHOUT committing final_ref; commitCouncilFinalRef then commits', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealCouncil(dir, 'task-SPLIT1');
    const res = verifyCouncilArtifactTopology(gateArgs(x));
    assert.deepEqual(res.synthesisRef, x.synth.sealed_ref);
    assert.equal(res.degraded, false);
    // NOT completed yet
    const m1 = JSON.parse(readFileSync(x.task.manifestPath, 'utf8'));
    assert.equal(m1.final_ref, null);
    assert.equal(m1.task_state, 'OPEN');
    // idempotent re-verify still does not complete
    verifyCouncilArtifactTopology(gateArgs(x));
    assert.equal(JSON.parse(readFileSync(x.task.manifestPath, 'utf8')).final_ref, null);
    // now commit
    const finalRef = commitCouncilFinalRef({ task: x.task, synthesisRef: res.synthesisRef });
    assert.deepEqual(finalRef, x.synth.sealed_ref);
    const m2 = x.task.freshManifest();
    assert.equal(m2.task_state, 'COMPLETED');
    assert.equal(m2.artifact_gate_state, 'TASK_ARTIFACT_PASS');
    assert.deepEqual(m2.final_ref, x.synth.sealed_ref);
  });
});

test('P20.5A — runCouncilFinalArtifactGate wrapper still verifies + commits in one call', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealCouncil(dir, 'task-SPLIT2');
    const finalRef = runCouncilFinalArtifactGate(gateArgs(x));
    assert.deepEqual(finalRef, x.synth.sealed_ref);
    assert.equal(x.task.freshManifest().task_state, 'COMPLETED');
  });
});
