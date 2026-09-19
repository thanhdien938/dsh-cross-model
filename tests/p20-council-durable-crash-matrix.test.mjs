/**
 * P20.4R2 R10 — the FULL A–J durable crash matrix, each point exercised
 * separately on the REAL machine: DurablePmRuntime + CouncilChairDriver +
 * CouncilStepWorkflowRunner + DurableWorkflowState/WorkflowRepository +
 * PmRepository (SQLite) + a real P20 artifact store. Every letter maps to one
 * test that asserts the exact physical pre-restart state it creates and a
 * ZERO provider replay count. Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { buildActorAliasRegistry } from '../src/artifacts/artifact-paths.mjs';
import { verifySealedArtifactReference } from '../src/artifacts/artifact-recovery.mjs';
import {
  withStores, buildRuntime, artifactTurns, resetTurnToActionStarted,
  deleteTurnsFrom, reopenRun, setWorkflowRunning, stageKindOf,
} from './fixtures/p20-durable-council-harness.mjs';

const spec1 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
const spec2 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 2 });

// ============================================================
// A / C / G — real DELIVERED-before-seal, restarted
// ============================================================

async function deliveredBeforeSealCase(t, { targetStage, targetStepKind, taskId }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const pmRunId = 'x'.repeat(120) + t;
    const calls1 = [];
    const r1 = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      calls: calls1, taskId,
      afterDeliverHook: ({ artifactStage }) => (artifactStage === targetStage ? 'STOP_BEFORE_SEAL' : null),
    });
    // The run terminates `failed` because the seam threw after delivery — but
    // the target stage's P20 invocation is genuinely DELIVERED (not sealed)
    // on disk: report.md + executive delivery evidence exist, no seal.
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'failed');

    // Confirm the physical pre-restart artifact state for the TARGET stage.
    const store = newArtifactStore();
    const task = store.openTaskById(taskId);
    const isPart = targetStage === 'participant-report' || targetStage === 'participant-critique';
    const alias = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]).get(isPart ? 'p1' : council.chair_profile_id);
    const invId = `council:${taskId}:${targetStage}` + (isPart ? `:${alias}` : '');
    const inv = task.openInvocationById(invId);
    const rec = inv.freshRecord();
    assert.equal(rec.lifecycle, 'DELIVERED', 'invocation is genuinely DELIVERED (not sealed)');
    assert.equal(rec.seal ?? null, null, 'no seal record yet');
    const preOrdinal = Number.isInteger(rec.latest_attempt_ordinal) ? rec.latest_attempt_ordinal : 0;
    const preExecId = inv.freshAttemptMetadata(preOrdinal).execution_id;
    assert.equal(inv.freshAttemptMetadata(preOrdinal).terminal_state, 'SUCCESS');
    assert.equal(typeof preExecId, 'string');
    assert.equal(task.freshManifest().stages[isPart ? `${targetStage}::${alias}` : targetStage] ?? null, null, 'no stage seal entry yet');

    // Reshape the durable PM state into a genuine mid-crash: the target turn
    // is the LAST committed turn -> reset it to ACTION_STARTED, its workflow
    // row to running, the run to running. Later Council stages genuinely
    // never happened yet (the process died during this stage), so they DO
    // run fresh after resume — the crash-point property under test is that
    // the TARGET stage seals from disk with NO provider call for it.
    const turns = artifactTurns(sqlite, pmRunId);
    const target = turns.find((row) => stageKindOf(row.decision) === targetStepKind);
    assert.ok(target, `found the ${targetStepKind} turn`);
    deleteTurnsFrom(sqlite, pmRunId, target.turn_index + 1);
    resetTurnToActionStarted(sqlite, pmRunId, target.turn_index);
    setWorkflowRunning(sqlite, target.action_id);
    reopenRun(sqlite, pmRunId);

    // Fresh object graph -> resume().
    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed', 'the Council completes after DELIVERED-before-seal recovery');
    // ZERO provider replay FOR THE TARGET (stage, profile): it was gated +
    // sealed from the persisted attempt, not re-executed.
    const targetProfile = isPart ? 'p1' : council.chair_profile_id;
    assert.equal(
      calls2.some((c) => c.stage === targetStage && c.profileId === targetProfile),
      false,
      `the ${targetStepKind} stage was NOT replayed`,
    );
    // the recovered target stage's workflow step handoff is SEALED (gated + sealed from disk)
    const stepRow = sqlite.get('SELECT dispatched_context FROM workflow_steps WHERE workflow_id=?', [target.action_id]);
    const handoff = JSON.parse(stepRow.dispatched_context).handoff;
    assert.equal(handoff.transport_version, 'artifact_v1');
    assert.equal(handoff.ok, true);
    assert.equal(handoff.execution_state, 'SEALED');
    // sealDeliveredStageFromDisk used the SAME persisted attempt execution_id
    const postStore = newArtifactStore();
    const postRec = postStore.openTaskById(taskId).openInvocationById(invId).freshRecord();
    assert.equal(postRec.lifecycle, 'SEALED');
    assert.equal(postStore.openTaskById(taskId).openInvocationById(invId).freshAttemptMetadata(postRec.authoritative_attempt).execution_id, preExecId);
    // final_ref committed + verifies
    const m = postStore.openTaskById(taskId).freshManifest();
    assert.equal(m.task_state, 'COMPLETED');
    assert.equal(verifySealedArtifactReference({ store: newArtifactStore(), reference: m.final_ref }).verified, true);
  });
}

test('R10 A — chair_plan DELIVERED before seal: resume gates+seals from disk, 0 provider replay', async (t) => {
  await deliveredBeforeSealCase('01', { targetStage: 'chair-plan', targetStepKind: 'chair_plan', taskId: 'task-CMA' });
  assert.ok(true);
});
test('R10 C — participant_report DELIVERED before seal: resume gates+seals from disk, 0 provider replay', async (t) => {
  await deliveredBeforeSealCase('02', { targetStage: 'participant-report', targetStepKind: 'participant_report', taskId: 'task-CMC' });
  assert.ok(true);
});
test('R10 G — chair_synthesis DELIVERED before seal: resume gates+seals from disk, 0 provider replay', async (t) => {
  await deliveredBeforeSealCase('03', { targetStage: 'chair-council-synthesis', targetStepKind: 'chair_synthesis', taskId: 'task-CMG' });
  assert.ok(true);
});

// ============================================================
// B / D / F / H — SEALED before workflow outcome, restarted
// ============================================================

async function sealedBeforeOutcomeCase(t, { targetStepKind, taskId, twoRounds = false }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = twoRounds ? spec2() : spec1();
    const pmRunId = 'y'.repeat(120) + t;
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');

    // The target stage's P20 invocation IS sealed on disk (a normal run). Now
    // reshape only THAT stage's durable rows into a genuine SEALED-before-
    // workflow-outcome crash: workflow row running / dispatched_context NULL,
    // its turn ACTION_STARTED, drop every LATER turn, run running.
    const turns = artifactTurns(sqlite, pmRunId);
    const idx = turns.findIndex((row) => stageKindOf(row.decision) === targetStepKind);
    assert.ok(idx >= 0, `found the ${targetStepKind} turn`);
    const target = turns[idx];
    deleteTurnsFrom(sqlite, pmRunId, target.turn_index + 1);
    resetTurnToActionStarted(sqlite, pmRunId, target.turn_index);
    setWorkflowRunning(sqlite, target.action_id);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, `ZERO provider replay for ${targetStepKind} and every later already-sealed stage`);
    const stepRow = sqlite.get('SELECT dispatched_context FROM workflow_steps WHERE workflow_id=?', [target.action_id]);
    const handoff = JSON.parse(stepRow.dispatched_context).handoff;
    assert.equal(handoff.execution_state, 'RECOVERED_FROM_SEAL', 'the SEALED stage is recovered without replay');
    assert.ok(handoff.sealed_ref);
    assert.deepEqual(res2.data.final_ref, newArtifactStore().openTaskById(taskId).freshManifest().stages['chair-council-synthesis'].sealed_ref);
  });
}

test('R10 B — chair_plan SEALED, workflow row still RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcomeCase('01', { targetStepKind: 'chair_plan', taskId: 'task-CMB' });
});
test('R10 D — participant_report SEALED, workflow row still RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcomeCase('02', { targetStepKind: 'participant_report', taskId: 'task-CMD' });
});
test('R10 F — participant_critique SEALED (rounds=2), workflow row still RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcomeCase('03', { targetStepKind: 'participant_critique', taskId: 'task-CMF', twoRounds: true });
});
test('R10 H — chair_synthesis SEALED, workflow row still RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcomeCase('04', { targetStepKind: 'chair_synthesis', taskId: 'task-CMH' });
});

// ============================================================
// E — between participant turns after one durable success
// ============================================================

test('R10 E — restart between participant turns: prior report reused, next owner-ordered participant runs exactly once, no prior replay', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1 });
    const pmRunId = 'z'.repeat(120) + 'E1';
    // First runtime is bounded to maxTurns=2 -> it durably commits chair_plan
    // (turn 0) + p1's participant_report (turn 1), then stops. p2/p3/synthesis
    // never ran and have NO artifact invocation on disk — a genuine
    // between-participant-turns crash state.
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-CME', maxTurns: 2 });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'failed'); // PmMaxTurnsExceeded
    const reportCalls1 = calls1.filter((c) => c.stage === 'participant-report').map((c) => c.profileId);
    assert.deepEqual(reportCalls1, ['p1'], 'only p1 report ran on the bounded first pass');
    const store1 = newArtifactStore().openTaskById('task-CME');
    const aliasReg = buildActorAliasRegistry(['c', 'p1', 'p2', 'p3']);
    assert.throws(() => store1.openInvocationById(`council:task-CME:participant-report:${aliasReg.get('p2')}`), (e) => e.code === 'ARTIFACT_INVOCATION_RECORD_MISSING');

    reopenRun(sqlite, pmRunId); // status back to running; keep the 2 committed turns

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-CME', maxTurns: 24 });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    // chair_plan + p1 report were reused from durable history / seal; p2 then
    // p3 run exactly once in owner order; no p1 replay.
    const reportCalls2 = calls2.filter((c) => c.stage === 'participant-report').map((c) => c.profileId);
    assert.deepEqual(reportCalls2, ['p2', 'p3'], 'no p1 replay; next owner-ordered participants run exactly once');
    assert.deepEqual(res2.data.completed_participants, ['p1', 'p2', 'p3']);
  });
});

// ============================================================
// I — final_ref committed, PM FINISH turn not committed
// ============================================================

test('R10 I — final_ref committed but PM FINISH turn not completed: resume completes FINISH from the committed decision, 0 provider calls, same final_ref/output', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const pmRunId = 'w'.repeat(120) + 'I1';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-CMI' });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    // final_ref is already committed on disk (the driver commits it inside the
    // turn that returns `finish`).
    const finalRef1 = newArtifactStore().openTaskById('task-CMI').freshManifest().final_ref;
    assert.ok(finalRef1 && finalRef1.sha256);

    // Reset ONLY the FINISH turn to DECISION_COMMITTED (decision persisted,
    // turn not completed) + run running. Its `output`/`data` are already in
    // the committed decision.
    const finishTurn = sqlite.get("SELECT turn_index, decision FROM pm_turns WHERE pm_run_id=? ORDER BY turn_index DESC LIMIT 1", [pmRunId]);
    assert.match(String(finishTurn.decision), /"type":"finish"/);
    sqlite.run("UPDATE pm_turns SET phase='DECISION_COMMITTED', outcome=NULL, completed_at=NULL WHERE pm_run_id=? AND turn_index=?", [pmRunId, finishTurn.turn_index]);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-CMI' });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, 'ZERO provider calls');
    assert.deepEqual(res2.data.final_ref, first.data.final_ref, 'same final_ref');
    assert.equal(res2.output, first.output, 'same exact verified synthesis projection');
    assert.deepEqual(res2.data.final_ref, finalRef1);
  });
});

// ============================================================
// J — fully completed run, second restart
// ============================================================

test('R10 J — fully completed run, second fresh-runtime resume: 0 provider calls, same output/final_ref', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec2();
    const pmRunId = 'v'.repeat(120) + 'J1';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-CMJ' });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    assert.ok(calls1.length > 0);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-CMJ' });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0);
    assert.equal(res2.output, first.output);
    assert.deepEqual(res2.data.final_ref, first.data.final_ref);

    const calls3 = [];
    const r3 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls3, taskId: 'task-CMJ' });
    const res3 = await r3.resume(pmRunId);
    assert.equal(calls3.length, 0);
    assert.deepEqual(res3.data.final_ref, first.data.final_ref);
  });
});
