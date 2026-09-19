/**
 * P20.5R — Debate final authority / control repair closure.
 *   R1 typed_control placement contract
 *   R2 every roster response outcome required at the final gate
 *   R3 exact Debate roster == successful Council reporters (owner order)
 *   R4 re-verify the FULL Council prerequisite at the Debate final gate
 *   R5 same-execution control across a bounded delivery repair
 *   R6 complete early Debate capability/admission preflight
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { buildActorAliasRegistry } from '../src/artifacts/artifact-paths.mjs';
import {
  validateArtifactStepOutcome, buildArtifactStepSuccess, buildArtifactStepFailure,
} from '../src/pm/council/council-artifact-step-outcome.mjs';
import { verifyDebateArtifactTopology, CouncilArtifactOrchestrationError } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { debateStageInvocationId } from '../src/pm/council/debate-artifact-keys.mjs';
import {
  withStores, buildRuntime, artifactTurns, resetTurnToActionStarted, deleteTurnsFrom,
  reopenRun, stageKindOf, pmTurnOutcome, writePmTurnOutcome, debateGateInputsFromRun,
} from './fixtures/p20-durable-council-harness.mjs';

const SPEC = (over = {}) => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1, debate: { enabled: true, max_rounds: 1 }, ...over });
const DEBATE = (over = {}) => ({ debateTypedControl: true, continueDebate: () => false, ...over });
const REG = () => buildActorAliasRegistry(['c', 'p1', 'p2', 'p3']);

// ============================ R1 — placement contract ====================

const SYNTH_TC = {
  schema_version: 'p20.5-debate-continuation-1', transport_version: 'artifact_v1', control_kind: 'debate_continuation',
  store_id: 's', project_id: 'p', task_id: 't', invocation_id: 'i', attempt_ordinal: 0, execution_id: 'e',
  round: 1, profile_id: 'c', actor_alias: 'c', stage: 'debate-chair-synthesis', role: 'chair', continue_debate: true,
};

test('P20.5R R1 — validateArtifactStepOutcome rejects typed_control anywhere except a successful debate_synthesis', () => {
  // Council step + typed_control -> reject
  const council = { ...buildArtifactStepFailure({ stepKind: 'participant_report', profileId: 'p1', actorAlias: 'p1', failureCode: 'X' }), typed_control: SYNTH_TC };
  assert.equal(validateArtifactStepOutcome(council).ok, false);
  // debate_brief + typed_control -> reject
  const brief = { ...buildArtifactStepFailure({ stepKind: 'debate_brief', round: 1, profileId: 'c', actorAlias: 'c', failureCode: 'X' }), typed_control: SYNTH_TC };
  assert.equal(validateArtifactStepOutcome(brief).ok, false);
  // debate_response + typed_control -> reject
  const resp = { ...buildArtifactStepFailure({ stepKind: 'debate_response', round: 1, profileId: 'p1', actorAlias: 'p1', failureCode: 'X' }), typed_control: SYNTH_TC };
  assert.equal(validateArtifactStepOutcome(resp).ok, false);
  // FAILED debate_synthesis + typed_control -> reject
  const failedSynth = { ...buildArtifactStepFailure({ stepKind: 'debate_synthesis', round: 1, profileId: 'c', actorAlias: 'c', failureCode: 'X' }), typed_control: SYNTH_TC };
  const v = validateArtifactStepOutcome(failedSynth);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /typed_control is only permitted on a successful debate_synthesis/.test(e)));
  // a debate_synthesis with typed_control absent-or-null is fine at the shape
  // level (the same-execution binding is enforced by the binder/gate).
  const okNoTc = buildArtifactStepFailure({ stepKind: 'debate_synthesis', round: 1, profileId: 'c', actorAlias: 'c', failureCode: 'X' });
  assert.equal('typed_control' in okNoTc, false);
});

async function historyInjectTypedControl(taskId, targetStepKind) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE();
    const pmRunId = 'r1'.repeat(50) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null);

    const turns = artifactTurns(sqlite, pmRunId);
    const target = turns.find((row) => stageKindOf(row.decision) === targetStepKind);
    const synth = pmTurnOutcome(sqlite, pmRunId, turns.find((row) => stageKindOf(row.decision) === 'debate_synthesis').turn_index);
    const o = pmTurnOutcome(sqlite, pmRunId, target.turn_index);
    o.finalResult.handoff.typed_control = { ...synth.finalResult.handoff.typed_control }; // a VALID control, wrong placement
    writePmTurnOutcome(sqlite, pmRunId, target.turn_index, o);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'failed', `${targetStepKind} + typed_control fails closed`);
    assert.equal(calls2.length, 0, 'ZERO downstream provider calls');
    assert.match(JSON.stringify(res2.error ?? {}), /COUNCIL_ARTIFACT_DEBATE_HISTORY_/);
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null, 'no final_ref mutation');
  });
}

test('P20.5R R1 — a valid typed_control injected into a debate_brief PM-turn handoff -> fail closed, 0 downstream', async () => {
  await historyInjectTypedControl('task-R1B', 'debate_brief');
});
test('P20.5R R1 — a valid typed_control injected into a debate_response PM-turn handoff -> fail closed, 0 downstream', async () => {
  await historyInjectTypedControl('task-R1R', 'debate_response');
});
test('P20.5R R1 — a FAILED debate_synthesis PM-turn handoff carrying typed_control -> fail closed', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE();
    const pmRunId = 'r1s'.repeat(34) + 'FS';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-R1FS', maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    const turns = artifactTurns(sqlite, pmRunId);
    const synthT = turns.find((row) => stageKindOf(row.decision) === 'debate_synthesis');
    const o = pmTurnOutcome(sqlite, pmRunId, synthT.turn_index);
    const goodTc = { ...o.finalResult.handoff.typed_control };
    // turn the successful synthesis handoff into a FAILED one that still carries typed_control
    o.finalResult.handoff = { ...o.finalResult.handoff, ok: false, execution_state: 'EXECUTION_FAILED', failure_code: 'X', sealed_ref: null, typed_control: goodTc };
    writePmTurnOutcome(sqlite, pmRunId, synthT.turn_index, o);
    reopenRun(sqlite, pmRunId);
    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-R1FS', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'failed');
    assert.equal(calls2.length, 0);
    assert.equal(newArtifactStore().openTaskById('task-R1FS').freshManifest().final_ref, null);
  });
});

// ============================ R2 / R3 — final-gate roster ================

async function sealedDebateGateInputs(taskId, fn) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE();
    const pmRunId = 'r23'.repeat(34) + taskId.slice(-2);
    // maxTurns=10 -> all Council + round-1 Debate stages seal, but the FINISH
    // turn never runs, so final_ref is NOT committed.
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    const store = newArtifactStore();
    const task = store.openTaskById(taskId);
    assert.equal(task.freshManifest().final_ref, null, 'final_ref not committed yet');
    const reg = REG();
    const { councilGateArgs, roster, rounds } = await debateGateInputsFromRun(sqlite, pmRunId, { store, council, aliasRegistry: reg, maxReportBytes: undefined });
    await fn({ store, task, council, reg, councilGateArgs, roster, rounds, newArtifactStore });
  });
}

test('P20.5R R2 — final gate: remove a required roster member response outcome -> reject, no final_ref', async () => {
  await sealedDebateGateInputs('task-R2', ({ store, task, council, reg, councilGateArgs, roster, rounds }) => {
    const doctored = rounds.map((r) => ({ ...r, responses: new Map([...r.responses].filter(([id]) => id !== 'p2')) }));
    assert.ok(doctored[0].responses.size >= 1, 'still >=1 successful response');
    assert.throws(
      () => verifyDebateArtifactTopology({ store, task, council, roster, aliasRegistry: reg, rounds: doctored, councilGateArgs: { ...councilGateArgs, task } }),
      (e) => e instanceof CouncilArtifactOrchestrationError && e.code === 'DEBATE_ARTIFACT_FINAL_GATE_MISSING_RESPONSE_OUTCOME',
    );
    assert.equal(task.freshManifest().final_ref, null);
  });
});

test('P20.5R R2 — final gate: an extra response identity outside the roster -> reject', async () => {
  await sealedDebateGateInputs('task-R2X', ({ store, task, council, reg, councilGateArgs, roster, rounds }) => {
    const p1h = rounds[0].responses.get('p1');
    const doctored = rounds.map((r, i) => (i === 0 ? { ...r, responses: new Map([...r.responses, ['p9', { ...p1h, profile_id: 'p9' }]]) } : r));
    assert.throws(
      () => verifyDebateArtifactTopology({ store, task, council, roster, aliasRegistry: reg, rounds: doctored, councilGateArgs: { ...councilGateArgs, task } }),
      (e) => e.code === 'DEBATE_ARTIFACT_FINAL_GATE_EXTRA_RESPONSE',
    );
    assert.equal(task.freshManifest().final_ref, null);
  });
});

test('P20.5R R3 — final gate: caller roster omits a successful Council reporter -> reject, no final_ref', async () => {
  await sealedDebateGateInputs('task-R3', ({ store, task, council, reg, councilGateArgs, rounds }) => {
    assert.throws(
      () => verifyDebateArtifactTopology({ store, task, council, roster: ['p1', 'p3'], aliasRegistry: reg, rounds, councilGateArgs: { ...councilGateArgs, task } }),
      (e) => e.code === 'DEBATE_ARTIFACT_FINAL_GATE_ROSTER_MISMATCH',
    );
    assert.equal(task.freshManifest().final_ref, null);
  });
});

test('P20.5R R3 — final gate: caller roster in the wrong order -> reject', async () => {
  await sealedDebateGateInputs('task-R3O', ({ store, task, council, reg, councilGateArgs, rounds }) => {
    assert.throws(
      () => verifyDebateArtifactTopology({ store, task, council, roster: ['p1', 'p3', 'p2'], aliasRegistry: reg, rounds, councilGateArgs: { ...councilGateArgs, task } }),
      (e) => e.code === 'DEBATE_ARTIFACT_FINAL_GATE_ROSTER_MISMATCH',
    );
  });
});

// ============================ R4 — Council prereq re-verify ==============

test('P20.5R R4 — a Council prerequisite stage corrupted after Debate artifacts exist -> final Debate commit fails closed, no final_ref', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE();
    const pmRunId = 'r4'.repeat(50) + 'C4';
    // stop before the FINISH turn so final_ref is not committed yet
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-R4', maxTurns: 10, debate });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.equal(newArtifactStore().openTaskById('task-R4').freshManifest().final_ref, null);

    // corrupt a required Council prerequisite: hash-drift the sealed Council
    // chair-plan report on disk (a real post-hoc tampering).
    const store4 = newArtifactStore();
    const cpRef = store4.openTaskById('task-R4').freshManifest().stages['chair-plan'].sealed_ref;
    const cpFile = [store4.root, ...cpRef.artifact_relpath.split('/')].join('/');
    writeFileSync(cpFile, `${readFileSync(cpFile, 'utf8')}\n<post-hoc tampering of the Council chair plan>\n`);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-R4', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'failed', 'the Debate final gate re-verifies the Council prerequisite from fresh state');
    // Post-hoc disk tampering of a sealed Council report is caught fail-closed on
    // resume. In the full runtime the Council PM-turn history binder
    // (COUNCIL_ARTIFACT_HISTORY_REF_VERIFY_FAILED) re-hashes the sealed_ref target
    // and trips FIRST — before control ever reaches the Debate final gate — which
    // is strictly stronger. The direct-gate companion test below proves the
    // Debate final gate ITSELF re-verifies the Council prerequisite
    // (DEBATE_ARTIFACT_FINAL_GATE_COUNCIL_PREREQ_FAILED) when reached.
    assert.match(
      JSON.stringify(res2.error ?? {}),
      /DEBATE_ARTIFACT_FINAL_GATE_COUNCIL_PREREQ_FAILED|COUNCIL_ARTIFACT_HISTORY_REF_VERIFY_FAILED|ARTIFACT_CONSUMER_VERIFY_FAILED|COUNCIL_ARTIFACT_FINAL_GATE_/,
    );
    assert.equal(calls2.length, 0, 'no provider replay');
    assert.equal(newArtifactStore().openTaskById('task-R4').freshManifest().final_ref, null);
  });
});

test('P20.5R R4 — direct gate: a Council prerequisite report corrupted on disk -> verifyDebateArtifactTopology rethrows COUNCIL_PREREQ_FAILED, no final_ref', async () => {
  await sealedDebateGateInputs('task-R4D', ({ store, task, council, reg, councilGateArgs, roster, rounds }) => {
    // hash-drift the sealed Council chair-plan report on disk, then invoke the
    // Debate final gate directly: its R4 re-verification of the FULL Council
    // prerequisite (verifyCouncilArtifactTopology against fresh durable state)
    // must fail closed with DEBATE_ARTIFACT_FINAL_GATE_COUNCIL_PREREQ_FAILED.
    const cpRef = task.freshManifest().stages['chair-plan'].sealed_ref;
    const cpFile = [store.root, ...cpRef.artifact_relpath.split('/')].join('/');
    writeFileSync(cpFile, `${readFileSync(cpFile, 'utf8')}\n<post-hoc tampering of the Council chair plan>\n`);
    assert.throws(
      () => verifyDebateArtifactTopology({ store, task, council, roster, aliasRegistry: reg, rounds, councilGateArgs: { ...councilGateArgs, task } }),
      (e) => e instanceof CouncilArtifactOrchestrationError && e.code === 'DEBATE_ARTIFACT_FINAL_GATE_COUNCIL_PREREQ_FAILED',
    );
    assert.equal(task.freshManifest().final_ref, null);
  });
});

test('P20.5R R4 — completed-run idempotency is NOT weakened by the extra prerequisite re-verify', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE();
    const pmRunId = 'r4i'.repeat(34) + 'ID';
    const c1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c1, taskId: 'task-R4ID', maxTurns: 40, debate });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    for (const s of ['a', 'b']) {
      const c = [];
      // eslint-disable-next-line no-await-in-loop
      const r = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c, taskId: 'task-R4ID', maxTurns: 40, debate });
      // eslint-disable-next-line no-await-in-loop
      const res = await r.resume(pmRunId);
      assert.equal(res.status, 'completed', s);
      assert.equal(c.length, 0, s);
      assert.deepEqual(res.data.final_ref, first.data.final_ref);
      assert.equal(res.output, first.output);
    }
  });
});

// ============================ R5 — repair control binding ================

test('P20.5R R5 — a forced bounded repair of the Debate synthesis delivery -> explicit safe failure, NO persisted control, no final_ref', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC();
    const debate = DEBATE({ forceSynthesisRepair: true });
    const pmRunId = 'r5'.repeat(50) + 'C5';
    const calls = [];
    const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId: 'task-R5', maxTurns: 40, debate });
    const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'failed', 'the synthesis stage fails closed rather than persist a falsely-bound control');
    // The bounded delivery repair selects a NEW authoritative attempt whose
    // same-execution typed control channel cannot be preserved, so the synthesis
    // stage refuses to persist a control and returns a FAILED handoff
    // (DEBATE_ARTIFACT_SYNTHESIS_REPAIR_CONTROL_UNAVAILABLE). Because the repair
    // attempt was already sealed into the manifest by completeReportArtifact(),
    // the failed-handoff-with-sealed-stage-entry is additionally rejected
    // fail-closed by the Debate PM-turn history binder
    // (COUNCIL_ARTIFACT_DEBATE_HISTORY_FABRICATED_REF). Either way: run failed,
    // no final_ref, and — asserted below — NO debate_continuation was persisted.
    assert.match(
      JSON.stringify(res.error ?? {}),
      /DEBATE_ARTIFACT_SYNTHESIS_REPAIR_CONTROL_UNAVAILABLE|COUNCIL_DEBATE_SYNTHESIS_FAILED|COUNCIL_ARTIFACT_DEBATE_HISTORY_FABRICATED_REF/,
    );
    // the repair DID run (2 synthesis provider calls) but NO control was persisted
    assert.equal(calls.filter((x) => x.stage === 'debate-chair-synthesis').length, 2);
    const store = newArtifactStore();
    const inv = store.openTaskById('task-R5').openInvocationById(debateStageInvocationId({ taskId: 'task-R5', round: 1, artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS }));
    assert.equal(inv.freshDebateContinuationControl(), null, 'no debate_continuation persisted');
    assert.equal(store.openTaskById('task-R5').freshManifest().final_ref, null);
  });
});

test('P20.5R R5 — commitDebateContinuationControl fresh-reads the target attempt and rejects a control whose execution_id does not match', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const store = newArtifactStore();
    const taskId = 'task-R5U';
    const task = store.allocateTask({ taskId, taskSlug: 'd', createdAt: '2026-09-10T12:00:00.000Z', mode: 'council', chairProfileId: 'c', participantProfileIds: ['p1'] });
    const invocationId = debateStageInvocationId({ taskId, round: 1, artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS });
    const inv = task.allocateInvocation({ invocationId, role: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round: 1, profileId: 'c', actorAlias: 'chair' });
    const att = inv.allocateAttempt({ deliveryMechanism: 'VERBATIM_MATERIALIZATION', startedAt: '2026-09-10T12:00:00.000Z', executionId: 'exec-REAL' });
    inv.markRunning();
    inv.recordDelivery({ attemptOrdinal: att.ordinal, terminalState: 'SUCCESS', deliveryMechanism: 'VERBATIM_MATERIALIZATION', finishedAt: '2026-09-10T12:00:00.000Z', reportBytes: 5, reportSha256: 'a'.repeat(64) });
    const control = {
      schema_version: 'p20.5-debate-continuation-1', transport_version: 'artifact_v1', control_kind: 'debate_continuation',
      store_id: store.storeId, project_id: store.projectId, task_id: taskId, invocation_id: invocationId,
      attempt_ordinal: att.ordinal, execution_id: 'exec-WRONG', round: 1, profile_id: 'c', actor_alias: 'chair',
      stage: 'debate-chair-synthesis', role: 'chair', continue_debate: true,
    };
    assert.throws(() => inv.commitDebateContinuationControl({ control }), (e) => e.code === 'ARTIFACT_DEBATE_CONTROL_EXECUTION_MISMATCH');
    assert.equal(inv.freshDebateContinuationControl(), null);
  });
});

// ============================ R6 — complete early preflight =============

let r6n = 0;
const preflightZeroCalls = (label, { debate, resolveWorkspaceCapability, spec = SPEC(), consumerInputTransport } = {}) => test(`P20.5R R6 — ${label} -> zero Council/provider calls`, async () => {
  r6n += 1;
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const calls = [];
    const rt = buildRuntime({ council: spec, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId: `task-R6-${r6n}`, maxTurns: 40, debate, resolveWorkspaceCapability, consumerInputTransport });
    const res = await rt.run({ objective: 'x', pmRunId: `r6x${r6n}`.repeat(20).padEnd(120, 'z'), context: { council: spec, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'failed');
    assert.equal(calls.length, 0, 'the admission preflight ran BEFORE any provider call');
    assert.match(JSON.stringify(res.error ?? {}), /COUNCIL_ARTIFACT_DEBATE_(ADMISSION|TYPED_CONTROL)/);
  });
});

preflightZeroCalls('chair typed control unproven', { debate: { continueDebate: () => false /* no debateTypedControl */ } });
preflightZeroCalls('participant report delivery route unsupported', { debate: DEBATE({ backendProduct: { p2: 'claude-code' } }) });
// api: report delivery PROVEN, but NATIVE_ASSIGNED_READ input UNSUPPORTED -> the
// required artifact input transport is not admitted for that participant.
preflightZeroCalls('participant artifact input transport unsupported', { debate: DEBATE({ backendProduct: { p3: 'api' } }), consumerInputTransport: 'NATIVE_ASSIGNED_READ' });
preflightZeroCalls('workspace requirement unsupported for a roster member', {
  debate: DEBATE(),
  spec: SPEC({ workspace_requirement: 'READ' }),
  resolveWorkspaceCapability: (id) => { if (id === 'p2') throw Object.assign(new Error('no workspace route'), { code: 'X' }); return 'TEXT_ONLY'; },
});
