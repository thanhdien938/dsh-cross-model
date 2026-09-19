/**
 * P20.4R2 R9 — the durable `artifact_v1` Council handoff must be FULLY bound to
 * app-owned authority before it is reused. One shared structural binding helper
 * (`validateCouncilArtifactStepBinding` / `assertCouncilArtifactStepBinding`)
 * is wired into:
 *   - CouncilStepWorkflowRunner.#reconstructArtifactOutcome  (durable resume)
 *   - runCouncilFinalArtifactGate                            (final gate)
 *
 * These tests tamper ONE duplicated-identity field at a time in a durable
 * handoff and prove: fail closed, ZERO provider replay, no incorrect final_ref
 * commit. Failed/skipped handoff tampering is covered too. Offline; no live
 * model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  runCouncilArtifactStage,
  runCouncilFinalArtifactGate,
  CouncilArtifactOrchestrationError,
} from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { buildCouncilArtifactControl } from '../src/pm/council/council-artifact-control.mjs';
import { councilStageKeyPlan } from '../src/pm/council/council-artifact-stage-keys.mjs';
import {
  validateCouncilArtifactStepBinding,
  assertCouncilArtifactStepBinding,
  CouncilArtifactStepOutcomeError,
} from '../src/pm/council/council-artifact-step-outcome.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';
import {
  withStores, buildRuntime, artifactTurns, resetTurnToActionStarted,
  deleteTurnsFrom, reopenRun, stageKindOf, stepDispatchedContext, writeStepDispatchedContext,
} from './fixtures/p20-durable-council-harness.mjs';

// =====================================================================
// Part 1 — DURABLE RECONSTRUCTION PATH (#reconstructArtifactOutcome)
// =====================================================================

const spec1 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

/**
 * Run a full council to completion, then reshape the durable rows so that the
 * chair-synthesis turn is an unrecovered ACTION_STARTED turn whose completed
 * workflow row carries a handoff with exactly ONE tampered identity field.
 * Resume with a fresh runtime and assert the tamper fails closed with zero
 * provider replay and no new/incorrect final_ref commit.
 */
async function synthesisHandoffTamperFailsClosed(taskId, mutate) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const pmRunId = 'r9'.repeat(60) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    const goodFinalRef = newArtifactStore().openTaskById(taskId).freshManifest().final_ref;
    assert.ok(goodFinalRef && goodFinalRef.sha256);

    const turns = artifactTurns(sqlite, pmRunId);
    const synth = turns.find((row) => stageKindOf(row.decision) === 'chair_synthesis');
    const p1Report = turns.find((row) => stageKindOf(row.decision) === 'participant_report');
    assert.ok(synth && p1Report);
    const finishTurn = turns[turns.length - 1];
    assert.match(String(finishTurn.decision), /"type":"finish"/);

    // drop the FINISH turn; reset synthesis to an unrecovered ACTION_STARTED
    deleteTurnsFrom(sqlite, pmRunId, finishTurn.turn_index);
    const dc = stepDispatchedContext(sqlite, synth.action_id);
    assert.equal(dc.handoff.transport_version, 'artifact_v1');
    assert.equal(dc.handoff.ok, true);
    mutate(dc.handoff, { p1ReportHandoff: stepDispatchedContext(sqlite, p1Report.action_id).handoff });
    writeStepDispatchedContext(sqlite, synth.action_id, dc);
    resetTurnToActionStarted(sqlite, pmRunId, synth.turn_index);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId });
    const res2 = await r2.resume(pmRunId);

    // fail closed — the tampered handoff is NEVER reused as a successful outcome
    assert.equal(res2.status, 'failed', 'tampered durable synthesis handoff fails closed');
    // zero provider replay — synthesis is reconstructed as a typed failure, not
    // re-executed; every earlier stage is reused from durable history
    assert.equal(calls2.length, 0, 'zero provider replay on a tampered durable handoff');
    // no incorrect final_ref commit — the only committed final_ref is the
    // correct run-1 synthesis ref; the failed resume commits nothing new
    const m2 = newArtifactStore().openTaskById(taskId).freshManifest();
    assert.deepEqual(m2.final_ref, goodFinalRef, 'final_ref unchanged / not re-committed from a tampered handoff');
  });
}

test('R9 durable — tamper step_kind → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9SK', (h) => { h.step_kind = 'participant_report'; });
});
test('R9 durable — tamper artifact_stage → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9AS', (h) => { h.artifact_stage = 'participant-report'; });
});
test('R9 durable — tamper stage_key → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9GK', (h) => { h.stage_key = 'chair-council-synthesis-TAMPERED'; });
});
test('R9 durable — tamper profile_id → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9PI', (h) => { h.profile_id = 'p1'; });
});
test('R9 durable — tamper actor_alias → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9AA', (h) => { h.actor_alias = 'not-the-chair-alias'; });
});
test('R9 durable — tamper execution_state → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9ES', (h) => { h.execution_state = 'EXECUTION_FAILED'; });
});
test('R9 durable — tamper sealed_ref (another participant’s) → fail closed, 0 replay', async () => {
  await synthesisHandoffTamperFailsClosed('task-R9SR', (h, { p1ReportHandoff }) => { h.sealed_ref = p1ReportHandoff.sealed_ref; });
});

test('R9 durable — tamper participantProfileId on a participant_report handoff → fail closed, 0 replay', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const taskId = 'task-R9PP';
    const pmRunId = 'r9pp'.repeat(30) + 'PP';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    const goodFinalRef = newArtifactStore().openTaskById(taskId).freshManifest().final_ref;

    const turns = artifactTurns(sqlite, pmRunId);
    const reports = turns.filter((row) => stageKindOf(row.decision) === 'participant_report');
    assert.equal(reports.length, 2);
    const p2 = reports[1];
    // p2's report is the last surviving turn -> a genuine unrecovered
    // ACTION_STARTED mid-crash (drop synthesis + FINISH after it).
    deleteTurnsFrom(sqlite, pmRunId, p2.turn_index + 1);
    const dc = stepDispatchedContext(sqlite, p2.action_id);
    assert.equal(dc.handoff.profile_id, 'p2');
    dc.handoff.participantProfileId = 'p1'; // the legacy-compat key must not disagree with profile_id
    writeStepDispatchedContext(sqlite, p2.action_id, dc);
    resetTurnToActionStarted(sqlite, pmRunId, p2.turn_index);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId });
    const res2 = await r2.resume(pmRunId);
    // fail closed — a participantProfileId that disagrees with profile_id makes
    // p2's durable report a typed failure; its real sealed stage entry then
    // makes the final gate reject the run (fabricated-ref fail-closed).
    assert.equal(res2.status, 'failed', 'a participantProfileId that disagrees with profile_id fails closed');
    // zero replay of the tampered step or any earlier reused stage — only the
    // chair synthesis (never run pre-crash) legitimately executes once
    assert.equal(calls2.filter((c) => c.profileId === 'p2').length, 0, 'the tampered p2 report is NOT replayed');
    assert.ok(calls2.every((c) => c.stage === 'chair-council-synthesis'), 'no chair_plan / p1 replay');
    assert.deepEqual(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, goodFinalRef, 'no incorrect final_ref commit');
  });
});

// =====================================================================
// Part 2 — FINAL GATE (runCouncilFinalArtifactGate) direct binding
// =====================================================================

const TASK = 'task-R9GATE';
const rewrite = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);

async function sealAllStages(dir) {
  const store = makeStore(dir);
  const spec = council({ rounds: 1 });
  const reg = aliasRegistryFor(spec);
  const backends = councilBackends();
  const task = store.allocateTask({
    taskId: TASK, taskSlug: 'fg', createdAt: COUNCIL_CREATED_AT, mode: 'council',
    chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids],
  });
  // P20.4R3 R17 — the final gate now requires a bound council_control.
  task.bindCouncilControl({
    control: buildCouncilArtifactControl(spec),
    topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
  });
  const common = { store, task, taskId: TASK, createdAt: COUNCIL_CREATED_AT, consumerInputTransport: 'VERBATIM_CONTENT' };
  const chair = await runCouncilArtifactStage({
    ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN,
    profileId: 'live1-chair', actorAlias: reg.get('live1-chair'), backend: 'fake',
    reportBackend: backends('live1-chair'), instructions: 'plan',
  });
  const reports = new Map();
  for (const id of spec.participant_profile_ids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
      profileId: id, actorAlias: reg.get(id), backend: 'fake',
      reportBackend: backends(id), instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref }],
    });
    reports.set(id, r);
  }
  const synth = await runCouncilArtifactStage({
    ...common, artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
    profileId: 'live1-chair', actorAlias: reg.get('live1-chair'), backend: 'fake',
    reportBackend: backends('live1-chair'), instructions: 'synth',
    inputReferences: [
      { label: 'chair', reference: chair.sealed_ref },
      ...spec.participant_profile_ids.map((id) => ({ label: id, reference: reports.get(id).sealed_ref })),
    ],
  });
  const stageKeyPlan = councilStageKeyPlan({ rounds: 1, participantAliases: spec.participant_profile_ids.map((id) => reg.get(id)) });
  return { store, task, spec, chair, reports, synth, stageKeyPlan, reg };
}

const gateArgs = (x) => ({
  store: x.store, task: x.task,
  chairPlanOutcome: x.chair, reportOutcomes: x.reports, critiqueOutcomes: new Map(),
  synthesisOutcome: x.synth, council: x.spec, stageKeyPlan: x.stageKeyPlan,
  participants: x.spec.participant_profile_ids, aliasRegistry: x.reg,
});

const gateFailsClosed = (x, args) => {
  assert.throws(() => runCouncilFinalArtifactGate(args ?? gateArgs(x)),
    (e) => e instanceof CouncilArtifactOrchestrationError && /COUNCIL_ARTIFACT_FINAL_GATE_/.test(e.code));
  assert.equal(x.task.freshManifest().final_ref, null, 'no final_ref committed on a fail-closed gate');
};

test('R9 final gate — happy path binds and commits final_ref = synthesis sealed_ref', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const finalRef = runCouncilFinalArtifactGate(gateArgs(x));
    assert.deepEqual(finalRef, x.synth.sealed_ref);
    assert.equal(x.task.freshManifest().artifact_gate_state, 'TASK_ARTIFACT_PASS');
  });
});

test('R9 final gate — tamper synthesis step_kind → COUNCIL_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, step_kind: 'participant_report' } });
  });
});
test('R9 final gate — tamper synthesis artifact_stage → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, artifact_stage: 'participant-report' } });
  });
});
test('R9 final gate — tamper synthesis stage_key → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, stage_key: 'chair-council-synthesis-X' } });
  });
});
test('R9 final gate — tamper synthesis profile_id → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, profile_id: 'live1-alpha' } });
  });
});
test('R9 final gate — tamper synthesis actor_alias → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, actor_alias: 'wrong-alias' } });
  });
});
test('R9 final gate — tamper synthesis execution_state → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, execution_state: 'EXECUTION_FAILED' } });
  });
});
test('R9 final gate — synthesis sealed_ref from another participant → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const otherRef = x.reports.get(x.spec.participant_profile_ids[0]).sealed_ref;
    gateFailsClosed(x, { ...gateArgs(x), synthesisOutcome: { ...x.synth, sealed_ref: otherRef } });
  });
});
test('R9 final gate — tamper report participantProfileId → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const betaId = x.spec.participant_profile_ids[1];
    const reportOutcomes = new Map(x.reports);
    reportOutcomes.set(betaId, { ...x.reports.get(betaId), participantProfileId: x.spec.participant_profile_ids[0] });
    gateFailsClosed(x, { ...gateArgs(x), reportOutcomes });
  });
});

test('R9 final gate — FAILED report handoff with a tampered identity field → fail closed', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const betaId = x.spec.participant_profile_ids[1];
    // beta's report is a failed/skipped handoff: no sealed_ref, and its stage
    // entry is removed so it is not a "fabricated ref" case — but its identity
    // fields are tampered and must still bind.
    const m = JSON.parse(readFileSync(x.task.manifestPath, 'utf8'));
    delete m.stages['participant-report::' + x.reg.get(betaId)];
    rewrite(x.task.manifestPath, m);
    const reportOutcomes = new Map(x.reports);
    reportOutcomes.set(betaId, {
      transport_version: 'artifact_v1', ok: false, step_kind: 'participant_report',
      artifact_stage: 'participant-report', stage_key: 'participant-report::WRONG',
      profile_id: betaId, actor_alias: x.reg.get(betaId), participantProfileId: betaId,
      execution_state: 'EXECUTION_FAILED', sealed_ref: null, failure_code: 'X', reason: null,
      repair: { repaired: false, repair_kind: null },
    });
    gateFailsClosed(x, { ...gateArgs(x), reportOutcomes });
  });
});

// =====================================================================
// Part 3 — the pure binding helper contract
// =====================================================================

const goodExpected = {
  stepKind: 'chair_synthesis', artifactStage: 'chair-council-synthesis',
  stageKey: 'chair-council-synthesis', profileId: 'c', actorAlias: 'chair', role: 'CHAIR',
};
const goodFailedHandoff = {
  transport_version: 'artifact_v1', ok: false, step_kind: 'chair_synthesis',
  artifact_stage: 'chair-council-synthesis', stage_key: 'chair-council-synthesis',
  profile_id: 'c', actor_alias: 'chair', execution_state: 'EXECUTION_FAILED',
  sealed_ref: null, failure_code: 'X', reason: null, repair: { repaired: false, repair_kind: null },
};

test('R9 helper — a well-formed failed handoff that matches the expected identity validates', () => {
  const v = validateCouncilArtifactStepBinding({ handoff: goodFailedHandoff, expected: goodExpected });
  assert.equal(v.ok, true, v.errors.join('; '));
});
test('R9 helper — a failed handoff with a mismatched stage_key does not validate', () => {
  const v = validateCouncilArtifactStepBinding({ handoff: { ...goodFailedHandoff, stage_key: 'other' }, expected: goodExpected });
  assert.equal(v.ok, false);
});
test('R9 helper — a failed handoff carrying a non-null sealed_ref does not validate', () => {
  const v = validateCouncilArtifactStepBinding({ handoff: { ...goodFailedHandoff, sealed_ref: { sha256: 'a'.repeat(64) } }, expected: goodExpected });
  assert.equal(v.ok, false);
});
test('R9 helper — assert form throws COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH', () => {
  assert.throws(
    () => assertCouncilArtifactStepBinding({ handoff: { ...goodFailedHandoff, profile_id: 'nope' }, expected: goodExpected }),
    (e) => e instanceof CouncilArtifactStepOutcomeError && e.code === 'COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH',
  );
});
