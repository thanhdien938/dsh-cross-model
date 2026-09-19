/**
 * P20.5D §39 — the durable artifact-Debate crash matrix A–M on the REAL
 * offline machine. Every recoverable sealed/delivered stage is reused with
 * ZERO provider replay; a missing/corrupt typed control fails closed with
 * ZERO replay and ZERO prose inference. Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { debateStageInvocationId } from '../src/pm/council/debate-artifact-keys.mjs';
import {
  withStores, buildRuntime, artifactTurns, resetTurnToActionStarted,
  deleteTurnsFrom, reopenRun, setWorkflowRunning, stageKindOf,
} from './fixtures/p20-durable-council-harness.mjs';

const SPEC = (maxRounds = 1) => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1, debate: { enabled: true, max_rounds: maxRounds } });
const DEBATE = (over = {}) => ({ debateTypedControl: true, continueDebate: () => false, ...over });
const invPath = (store, taskId, round, stage, alias) => store.openTaskById(taskId).openInvocationById(debateStageInvocationId({ taskId, round, artifactStage: stage, actorAlias: alias })).recordPath;

// ---- A / C : DELIVERED before seal, restarted -> gate+seal from disk -----

async function deliveredBeforeSeal(taskId, { targetStage, targetStepKind, targetProfile, round = 1, maxRounds = 1 }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(maxRounds);
    const pmRunId = 'd5'.repeat(50) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 40,
      debate: DEBATE(),
      afterDeliverHook: ({ artifactStage, round: rr }) => (artifactStage === targetStage && rr === round ? 'STOP_BEFORE_SEAL' : null),
    });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'failed');

    const turns = artifactTurns(sqlite, pmRunId);
    const target = turns.find((row) => stageKindOf(row.decision) === targetStepKind);
    assert.ok(target, `found the ${targetStepKind} turn`);
    deleteTurnsFrom(sqlite, pmRunId, target.turn_index + 1);
    resetTurnToActionStarted(sqlite, pmRunId, target.turn_index);
    setWorkflowRunning(sqlite, target.action_id);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 40, debate: DEBATE() });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed', 'the Debate completes after DELIVERED-before-seal recovery');
    assert.equal(calls2.some((c) => c.stage === targetStage && c.round === round && c.profileId === targetProfile), false, `${targetStepKind} was NOT replayed`);
    const m = newArtifactStore().openTaskById(taskId).freshManifest();
    assert.equal(m.task_state, 'COMPLETED');
  });
}

test('R10 A — round1 debate brief DELIVERED before seal: resume gates+seals from disk, 0 replay', async () => {
  await deliveredBeforeSeal('task-DA', { targetStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, targetStepKind: 'debate_brief', targetProfile: 'c' });
});
test('R10 C — round1 debate response DELIVERED before seal: resume gates+seals from disk, 0 replay', async () => {
  await deliveredBeforeSeal('task-DC', { targetStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, targetStepKind: 'debate_response', targetProfile: 'p1' });
});
test('R10 F — round1 debate synthesis DELIVERED before seal (control captured first): resume seals from disk, 0 replay', async () => {
  await deliveredBeforeSeal('task-DF', { targetStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, targetStepKind: 'debate_synthesis', targetProfile: 'c' });
});

// ---- B / D / G : SEALED before workflow outcome, restarted -------------

async function sealedBeforeOutcome(taskId, { targetStepKind, round = 1, maxRounds = 1 }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(maxRounds);
    const pmRunId = 'd5b'.repeat(34) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 40, debate: DEBATE() });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'completed');

    const turns = artifactTurns(sqlite, pmRunId);
    const target = turns.find((row) => stageKindOf(row.decision) === targetStepKind);
    deleteTurnsFrom(sqlite, pmRunId, target.turn_index + 1);
    resetTurnToActionStarted(sqlite, pmRunId, target.turn_index);
    setWorkflowRunning(sqlite, target.action_id);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 40, debate: DEBATE() });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, `ZERO provider replay for ${targetStepKind} and every later already-sealed stage`);
    const stepRow = sqlite.get('SELECT dispatched_context FROM workflow_steps WHERE workflow_id=?', [target.action_id]);
    const handoff = JSON.parse(stepRow.dispatched_context).handoff;
    assert.equal(handoff.execution_state, 'RECOVERED_FROM_SEAL');
    if (targetStepKind === 'debate_synthesis') assert.ok(handoff.typed_control, 'recovered synthesis carries its bound typed control');
  });
}

test('R10 B — round1 debate brief SEALED, workflow row RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcome('task-DB', { targetStepKind: 'debate_brief' });
});
test('R10 D — round1 debate response SEALED, workflow row RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcome('task-DD', { targetStepKind: 'debate_response' });
});
test('R10 G — round1 debate synthesis SEALED + valid typed control, workflow row RUNNING: resume RECOVERED_FROM_SEAL, 0 replay', async () => {
  await sealedBeforeOutcome('task-DG', { targetStepKind: 'debate_synthesis' });
});

// ---- E : restart between responses ------------------------------------

test('R10 E — restart between debate responses: prior response reused, next owner-ordered response runs exactly once', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(1);
    const pmRunId = 'd5e'.repeat(34) + 'EE';
    const calls1 = [];
    // maxTurns bounded so: chair_plan(0) reports(1-3) council_synth(4) brief(5) p1-response(6) -> stop
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-DE', maxTurns: 7, debate: DEBATE() });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.deepEqual(calls1.filter((c) => c.stage === 'debate-member-response').map((c) => c.profileId), ['p1']);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-DE', maxTurns: 40, debate: DEBATE() });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.deepEqual(calls2.filter((c) => c.stage === 'debate-member-response').map((c) => c.profileId), ['p2', 'p3'], 'no p1 replay; owner order');
  });
});

// ---- H : crash after round1 synthesis CONTINUE, before round2 brief ----

test('R10 H — crash after round1 synthesis says CONTINUE, before round2 brief: round1 reused, round2 brief runs once', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(2);
    const debate = DEBATE({ continueDebate: ({ round }) => round === 1 });
    const pmRunId = 'd5h'.repeat(34) + 'HH';
    const calls1 = [];
    // stop right after round1 synthesis (turn 8): chair_plan(0) r(1-3) cs(4) brief(5) resp(6-8)... actually synth is turn 9
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-DH', maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.equal(calls1.filter((c) => c.stage === 'debate-chair-synthesis').length, 1);
    assert.equal(calls1.filter((c) => c.stage === 'debate-chair-brief').length, 1);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-DH', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(res2.data.debate.rounds_run, 2);
    assert.equal(calls2.filter((c) => c.round === 1).length, 0, 'no round-1 replay');
    assert.equal(calls2.filter((c) => c.stage === 'debate-chair-brief' && c.round === 2).length, 1);
  });
});

// ---- I : round2 restart reuse ----------------------------------------

test('R10 I — round2 partway then restart: round1 + round2-so-far reused, remainder runs once', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(2);
    const debate = DEBATE({ continueDebate: ({ round }) => round === 1 });
    const pmRunId = 'd5i'.repeat(34) + 'II';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-DI', maxTurns: 13, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    reopenRun(sqlite, pmRunId);
    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-DI', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(res2.data.debate.rounds_run, 2);
    assert.equal(calls2.filter((c) => c.round === 1).length, 0, 'no round-1 replay');
    const r2synth = calls2.filter((c) => c.stage === 'debate-chair-synthesis' && c.round === 2);
    assert.equal(r2synth.length, 1);
  });
});

// ---- J / K : final synthesis sealed / final_ref before FINISH ---------

test('R10 J/K — final debate synthesis SEALED + control persisted before PM FINISH: resume finishes, 0 provider calls, commits final_ref', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(1);
    const debate = DEBATE();
    const pmRunId = 'd5j'.repeat(34) + 'JJ';
    const calls1 = [];
    // stop before the FINISH turn: chair_plan(0) r(1-3) cs(4) brief(5) resp(6-8) synth(9) FINISH(10)
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-DJ', maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.equal(newArtifactStore().openTaskById('task-DJ').freshManifest().final_ref, null, 'final_ref not committed pre-FINISH');
    reopenRun(sqlite, pmRunId);
    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-DJ', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, 'ZERO provider calls on the FINISH-only resume');
    const m = newArtifactStore().openTaskById('task-DJ').freshManifest();
    assert.deepEqual(res2.data.final_ref, m.stages['debate::round-01::chair-synthesis'].sealed_ref);
    assert.equal(m.task_state, 'COMPLETED');
  });
});

// ---- L : fully completed run, second fresh resume idempotent ---------

test('R10 L — fully completed Debate run, second fresh-runtime resume: 0 provider calls, same output/final_ref', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(1);
    const debate = DEBATE();
    const pmRunId = 'd5l'.repeat(34) + 'LL';
    const c1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c1, taskId: 'task-DL', maxTurns: 40, debate });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    for (const suffix of ['a', 'b']) {
      const c = [];
      // eslint-disable-next-line no-await-in-loop
      const r = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c, taskId: 'task-DL', maxTurns: 40, debate });
      // eslint-disable-next-line no-await-in-loop
      const res = await r.resume(pmRunId);
      assert.equal(res.status, 'completed', suffix);
      assert.equal(c.length, 0, suffix);
      assert.deepEqual(res.data.final_ref, first.data.final_ref);
      assert.equal(res.output, first.output);
    }
  });
});

// ---- M : synthesis report seals but typed control missing/corrupt ----

test('R10 M — debate synthesis SEALED but its typed control is deleted from disk: resume fails closed, 0 replay, no final_ref', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(1);
    const debate = DEBATE();
    const pmRunId = 'd5m'.repeat(34) + 'MM';
    const calls1 = [];
    // stop before FINISH so final_ref isn't committed
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-DM', maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');

    // corrupt: strip the durable typed control off the sealed synthesis invocation.json
    const rp = invPath(newArtifactStore(), 'task-DM', 1, ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, null);
    const rec = JSON.parse(readFileSync(rp, 'utf8'));
    assert.ok(rec.debate_continuation, 'the control was persisted');
    delete rec.debate_continuation;
    writeFileSync(rp, `${JSON.stringify(rec, null, 2)}\n`);

    // reshape the synthesis turn into an unrecovered ACTION_STARTED + row running
    const turns = artifactTurns(sqlite, pmRunId);
    const synth = turns.find((row) => stageKindOf(row.decision) === 'debate_synthesis');
    resetTurnToActionStarted(sqlite, pmRunId, synth.turn_index);
    setWorkflowRunning(sqlite, synth.action_id);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-DM', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'failed', 'a sealed synthesis with no durable typed control fails closed');
    assert.equal(calls2.length, 0, 'ZERO provider replay; ZERO prose inference');
    // the root cause is the missing typed control; it surfaces as a typed
    // Debate authority failure (crash-handshake RECONCILED -> history rejects
    // the now-failed synthesis whose real stage entry still exists).
    assert.match(JSON.stringify(res2.error ?? {}), /CONTROL_MISSING|SYNTHESIS_CONTROL|DEBATE_HISTORY_FABRICATED_REF|COUNCIL_DEBATE_SYNTHESIS_FAILED/);
    assert.equal(newArtifactStore().openTaskById('task-DM').freshManifest().final_ref, null);
    // and it did NOT come from reading the report prose
    assert.equal(/continue/i.test(String(res2.error?.message ?? '')), false);
  });
});
