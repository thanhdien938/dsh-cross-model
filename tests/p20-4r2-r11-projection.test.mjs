/**
 * P20.4R2 R11 — the final synthesis projection must FAIL CLOSED.
 *
 * The artifact Chair's final-output path used to be:
 *   try { output = resolveAndVerifySealedReference(finalRef).buffer.toString('utf8') }
 *   catch { output = `Council synthesis sealed as final_ref ${finalRef.sha256}` }
 * which masked a consumer verification failure occurring AFTER the final gate.
 *
 * The catch-all fallback is removed. The projection now
 * `resolveAndVerifySealedReference(final_ref)` + strict-UTF-8 decodes, and a
 * verification/decode failure THROWS `COUNCIL_ARTIFACT_FINAL_PROJECTION_VERIFY_FAILED`
 * — DurablePmRuntime does NOT commit a normal FINISH, there is no fallback
 * success string, and there is no provider replay.
 *
 * A DI/test-only seam (`__beforeFinalProjection`) corrupts the sealed synthesis
 * bytes on disk AFTER the gate has verified+committed them and BEFORE the
 * consumer projection re-verifies. Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { resolveAndVerifySealedReference } from '../src/artifacts/artifact-recovery.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const spec1 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

test('R11 — a post-final-gate corruption of the sealed synthesis makes the projection fail closed (no normal FINISH, no fallback string, 0 replay)', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const taskId = 'task-R11A';
    const pmRunId = 'r11'.repeat(41) + 'AA';
    const calls = [];
    let seamFired = 0;
    const r1 = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      calls, taskId,
      // AFTER the gate committed final_ref, BEFORE the consumer projection.
      beforeFinalProjection: ({ store, finalRef }) => {
        seamFired += 1;
        const v = resolveAndVerifySealedReference({ store, reference: finalRef });
        appendFileSync(v.path, '\n<post-final-gate tampering>\n'); // hash no longer matches
      },
    });
    const res = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });

    assert.equal(seamFired, 1, 'the projection seam ran exactly once (after the final gate)');
    // DurablePmRuntime did NOT commit a normal FINISH
    assert.equal(res.status, 'failed', 'the run fails closed rather than emitting a normal finish');
    assert.equal(res.output ?? '', '', 'no projected output');
    // no fallback "sealed as final_ref …" success string anywhere in the result
    assert.equal(/sealed as final_ref/i.test(JSON.stringify(res)), false, 'the catch-all success fallback is gone');
    // the typed failure is persisted
    const runRow = sqlite.get('SELECT status, output, error FROM pm_runs WHERE id=?', [pmRunId]);
    assert.equal(runRow.status, 'failed');
    assert.equal(runRow.output ?? '', '');
    assert.match(String(runRow.error), /COUNCIL_ARTIFACT_FINAL_PROJECTION_VERIFY_FAILED/);
    // ZERO provider replay — chair_plan + 2 reports + synthesis, nothing re-run
    assert.equal(calls.length, 4, 'exactly the normal stage count; the projection failure triggers no re-execution');
    assert.deepEqual(calls.map((c) => c.stage).sort(), ['chair-council-synthesis', 'chair-plan', 'participant-report', 'participant-report']);
  });
});

test('R11 — with no projection seam the run completes normally and output is the exact verified synthesis bytes', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec1();
    const taskId = 'task-R11B';
    const pmRunId = 'r11b'.repeat(31) + 'BB';
    const calls = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId });
    const res = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    const finalRef = res.data.final_ref;
    const v = resolveAndVerifySealedReference({ store: newArtifactStore(), reference: finalRef });
    assert.equal(res.output, new TextDecoder('utf-8', { fatal: true }).decode(v.buffer), 'output is the exact verified sealed synthesis bytes');
  });
});
