/**
 * P20.4R3 R14 — a `completed` artifact_v1 workflow row can NEVER bypass handoff
 * validation. CouncilStepWorkflowRunner.#reconstructArtifactOutcome() had a
 * generic `if (existing.status === 'completed' && step.dispatchedContext)
 * return dispatchedContext` passthrough; for an artifact row whose
 * dispatchedContext exists but whose handoff is missing / null / malformed /
 * has a non-boolean `ok`, that bypassed the R9 structural + binding policy.
 *
 * It is removed: any such row becomes a typed, idempotent
 * RECONCILED_NO_REPLAY failure (COUNCIL_ARTIFACT_STEP_HANDOFF_INVALID) — never
 * an unvalidated success, never a legacy-reconstruction fall-through, never a
 * provider replay, never a re-emission loop. Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  withStores, buildRuntime, artifactTurns, resetTurnToActionStarted, reopenRun,
  stageKindOf, stepDispatchedContext, writeStepDispatchedContext,
} from './fixtures/p20-durable-council-harness.mjs';

const COUNCIL = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

/**
 * Bounded first pass (maxTurns=4): chair_plan + p1 + p2 reports + chair
 * synthesis all seal, but the FINISH turn never runs so final_ref is never
 * committed. Then the synthesis turn is reset to an unrecovered ACTION_STARTED
 * and its completed workflow row's dispatched_context.handoff is corrupted.
 * A fresh resume must fail closed with a typed no-replay failure, zero provider
 * calls, no final_ref, and be idempotent on a second resume.
 */
async function completedRowInvalidHandoffFailsClosed(taskId, corrupt) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = COUNCIL();
    const pmRunId = 'r14'.repeat(40) + taskId.slice(-2);
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId, maxTurns: 4 });
    assert.equal((await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } })).status, 'failed');
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null);

    const turns = artifactTurns(sqlite, pmRunId);
    const synth = turns.find((t) => stageKindOf(t.decision) === 'chair_synthesis');
    assert.ok(synth, 'chair synthesis turn sealed on the bounded first pass');
    const dc = stepDispatchedContext(sqlite, synth.action_id);
    assert.equal(dc.handoff.ok, true);
    corrupt(dc); // mutate dispatched_context (its .handoff) in place
    writeStepDispatchedContext(sqlite, synth.action_id, dc);
    resetTurnToActionStarted(sqlite, pmRunId, synth.turn_index);
    reopenRun(sqlite, pmRunId);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId, maxTurns: 24 });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'failed', 'a completed artifact row with an invalid handoff fails closed');
    assert.equal(calls2.length, 0, 'zero provider replay');
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null, 'no final_ref');
    const err2 = String(sqlite.get('SELECT error FROM pm_runs WHERE id=?', [pmRunId]).error);
    assert.match(err2, /COUNCIL_ARTIFACT_(STEP_HANDOFF_INVALID|STEP_BINDING_MISMATCH|HISTORY_FABRICATED_REF|SYNTHESIS_FAILED)/, 'typed fail-closed');

    // idempotent — a SECOND fresh resume behaves identically, no replay, no loop
    reopenRun(sqlite, pmRunId);
    const calls3 = [];
    const r3 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls3, taskId, maxTurns: 24 });
    const res3 = await r3.resume(pmRunId);
    assert.equal(res3.status, 'failed');
    assert.equal(calls3.length, 0, 'still zero replay on the second resume');
    assert.equal(newArtifactStore().openTaskById(taskId).freshManifest().final_ref, null);
  });
}

test('R14 — completed row + dispatchedContext but NO handoff → typed no-replay failure, idempotent', async () => {
  await completedRowInvalidHandoffFailsClosed('task-R14NH', (dc) => { delete dc.handoff; });
});

test('R14 — completed row + handoff = null → typed no-replay failure, idempotent', async () => {
  await completedRowInvalidHandoffFailsClosed('task-R14NL', (dc) => { dc.handoff = null; });
});

test('R14 — completed row + handoff.ok = "yes" (non-boolean) → typed no-replay failure, idempotent', async () => {
  await completedRowInvalidHandoffFailsClosed('task-R14OY', (dc) => { dc.handoff.ok = 'yes'; });
});

test('R14 — completed row + malformed transport_version/identity → typed no-replay failure, idempotent', async () => {
  await completedRowInvalidHandoffFailsClosed('task-R14MT', (dc) => { dc.handoff.transport_version = 'legacy'; dc.handoff.step_kind = 'not_a_kind'; });
});
