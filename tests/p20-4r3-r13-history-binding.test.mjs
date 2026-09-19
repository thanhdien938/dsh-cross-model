/**
 * P20.4R3 R13 — a PM-turn history handoff is a SECOND durable projection of a
 * step outcome (distinct from workflow_steps.dispatched_context, which the
 * runner's #reconstructArtifactOutcome fully binds — R9). Before ANY successful
 * prior artifact handoff from `pm_turns` history is admitted into
 * chairPlan/reports/critiques/synthesis state (and its sealed_ref handed to a
 * downstream critique/synthesis provider), CouncilChairDriver.#artifactStepsSoFar
 * now binds it to app-owned authority EXACTLY as strongly as the workflow row:
 * council_control + expected identity + resolveAndVerifySealedReference +
 * manifest stage entry + validateCouncilArtifactStepBinding.
 *
 * These tests tamper `pm_turns.outcome` / the DurablePmRuntime history ITSELF
 * (not workflow_steps.dispatched_context), on the real durable P20.4 machine,
 * and prove: typed fail-closed, ZERO downstream provider calls, no re-emission
 * loop, no final_ref mutation. Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  withStores, buildRuntime, artifactTurns, reopenRun, stageKindOf,
  pmTurnOutcome, writePmTurnOutcome,
} from './fixtures/p20-durable-council-harness.mjs';

const COUNCIL = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1 });

/**
 * Bounded first pass (maxTurns=3): chair_plan(0) + p1 report(1) + p2 report(2)
 * are durably committed; p3 report and the chair synthesis have NEVER run.
 * `mutate(handoff, ctx)` tampers ONE thing in the chosen prior report turn's
 * PM-turn history outcome. Resume and assert the bad history is rejected
 * BEFORE the never-before-run downstream stages execute.
 */
async function historyTamperFailsClosed(taskId, { turnStep = 'p1', mutate, expectCode = /COUNCIL_ARTIFACT_HISTORY_/ }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = COUNCIL();
    const pmRunId = 'r13'.repeat(40) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 3 });
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'failed'); // PmMaxTurnsExceeded after 3 committed turns
    assert.deepEqual(calls1.map((c) => `${c.stage}/${c.profileId}`), ['chair-plan/c', 'participant-report/p1', 'participant-report/p2']);

    const turns = artifactTurns(sqlite, pmRunId);
    const reportTurns = turns.filter((t) => stageKindOf(t.decision) === 'participant_report');
    assert.equal(reportTurns.length, 2, 'p3 report / synthesis never ran');
    const targetTurnIndex = turnStep === 'p2' ? reportTurns[1].turn_index : reportTurns[0].turn_index;

    const o = pmTurnOutcome(sqlite, pmRunId, targetTurnIndex);
    assert.equal(o.finalResult.handoff.transport_version, 'artifact_v1');
    assert.equal(o.finalResult.handoff.profile_id, turnStep);
    const p2Outcome = pmTurnOutcome(sqlite, pmRunId, reportTurns[1].turn_index);
    mutate(o.finalResult.handoff, { p2SealedRef: p2Outcome.finalResult.handoff.sealed_ref });
    writePmTurnOutcome(sqlite, pmRunId, targetTurnIndex, o);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 24 });
    const res2 = await r2.resume(pmRunId);

    assert.equal(res2.status, 'failed', 'tampered PM-turn history fails the run closed');
    assert.equal(calls2.length, 0, 'ZERO downstream provider calls — the bad history is rejected before p3/synthesis run');
    const runRow = sqlite.get('SELECT error FROM pm_runs WHERE id=?', [pmRunId]);
    assert.match(String(runRow.error), expectCode, 'a typed Council history-authority error');
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null, 'no final_ref mutation');
  });
}

test('R13 A — report PM-turn sealed_ref replaced by another valid ref (wrong profile/stage) → fail closed, 0 downstream', async () => {
  await historyTamperFailsClosed('task-R13A', {
    mutate: (h, { p2SealedRef }) => { h.sealed_ref = p2SealedRef; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH/,
  });
});

test('R13 B — report PM-turn actor_alias changed (sealed_ref still valid) → typed fail closed, 0 downstream', async () => {
  await historyTamperFailsClosed('task-R13B', {
    mutate: (h) => { h.actor_alias = 'not-p1-alias'; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH/,
  });
});

test('R13 C — report PM-turn stage_key changed → typed fail closed, 0 downstream', async () => {
  await historyTamperFailsClosed('task-R13C', {
    mutate: (h) => { h.stage_key = 'participant-report::WRONG'; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH/,
  });
});

test('R13 D — report PM-turn participantProfileId != profile_id → typed fail closed', async () => {
  await historyTamperFailsClosed('task-R13D', {
    mutate: (h) => { h.participantProfileId = 'p2'; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH/,
  });
});

test('R13 E — successful report PM-turn handoff missing sealed_ref → typed fail closed', async () => {
  await historyTamperFailsClosed('task-R13E', {
    mutate: (h) => { h.sealed_ref = null; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_HANDOFF_INVALID/,
  });
});

test('R13 F — completed report PM-turn outcome has a missing/malformed handoff → typed fail closed, no re-emission loop', async () => {
  await historyTamperFailsClosed('task-R13F', {
    mutate: (h) => { for (const k of Object.keys(h)) delete h[k]; h.garbage = true; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_HANDOFF_INVALID/,
  });
});

test('R13 G — failed/skipped-shaped report PM-turn handoff carrying a fabricated sealed_ref → typed fail closed', async () => {
  await historyTamperFailsClosed('task-R13G', {
    // ok:false but keeps a non-null sealed_ref (a fabricated ref on a failure
    // handoff) — the shared shape validator rejects it.
    mutate: (h) => { h.ok = false; h.execution_state = 'EXECUTION_FAILED'; h.failure_code = 'FAKE'; },
    expectCode: /COUNCIL_ARTIFACT_HISTORY_HANDOFF_INVALID/,
  });
});

test('R13 — a fully valid PM-turn history still resumes and completes (no false positives)', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = COUNCIL();
    const taskId = 'task-R13OK';
    const pmRunId = 'r13ok'.repeat(24) + 'OK';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 3 });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 24 });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    // chair_plan + p1 + p2 reused from durable history (bound, not replayed);
    // only p3 report + synthesis run.
    assert.deepEqual(calls2.map((c) => `${c.stage}/${c.profileId}`), ['participant-report/p3', 'chair-council-synthesis/c']);
    assert.deepEqual(res2.data.completed_participants, ['p1', 'p2', 'p3']);
  });
});
