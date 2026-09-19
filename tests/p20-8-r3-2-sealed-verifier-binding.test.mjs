/**
 * P20.8 PRE-R3 — R3-2: the ONE shared generic sealed verifier
 * (`resolveAndVerifySealedReference()`) must itself bind physical/logical
 * topology, never relying on a downstream specialized caller.
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §4.
 *
 * Mutates ONE field at a time in an authoritative attempt `artifact.json`
 * (report bytes/hash/relpath and the parent `invocation.json` left
 * untouched) and proves `resolveAndVerifySealedReference()` itself — called
 * directly, not through a specialized wrapper — fails closed. Also proves
 * positive sealed SINGLE/Council/Debate refs still verify, and that the
 * specialized P20.6R3 source-final topology checks are unchanged.
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { resolveAndVerifySealedReference } from '../src/artifacts/artifact-recovery.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';
import { completeSingle, makeStore, withTempRoot } from './fixtures/p20-6-context-helpers.mjs';

const readAttempt = (inv, ordinal) => JSON.parse(readFileSync(inv.attemptArtifactJsonPath(ordinal), 'utf8'));
const writeAttempt = (inv, ordinal, meta) => writeFileSync(inv.attemptArtifactJsonPath(ordinal), `${JSON.stringify(meta, null, 2)}\n`);

async function completeNoDebateCouncil({ newArtifactStore, newPmRepo, newStepState }, taskId) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const pmRunId = `r32${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'x');
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 32 });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  assert.equal(res.status, 'completed');
  const store = newArtifactStore();
  return { store, task: store.openTaskById(taskId) };
}

async function completeDebateRound1({ newArtifactStore, newPmRepo, newStepState }, taskId) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const debate = { debateTypedControl: true, continueDebate: () => false };
  const pmRunId = `r32d${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'y');
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 40, debate });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  assert.equal(res.status, 'completed');
  const store = newArtifactStore();
  return { store, task: store.openTaskById(taskId) };
}

// ---- profile_id / actor_alias — free-form fields, exercised on SINGLE ----

for (const field of ['profile_id', 'actor_alias']) {
  test(`R3-2: authoritative attempt.${field} mutated (ref/hash/parent invocation untouched) — resolveAndVerifySealedReference fails closed`, async () => {
    await withTempRoot(async (dir) => {
      const store = makeStore(dir);
      const { finalRef, task } = await completeSingle(store, { taskId: `task-R32-${field}` });

      // Baseline: the untouched sealed ref verifies.
      const before = resolveAndVerifySealedReference({ store, reference: finalRef });
      assert.equal(before.verified, true);

      const inv = task.openInvocationById(finalRef.invocation_id);
      const am = readAttempt(inv, finalRef.attempt_ordinal);
      const reportShaBefore = am.report_sha256;
      const reportBytesBefore = am.report_bytes;
      am[field] = field === 'profile_id' ? 'some-other-profile' : 'some-other-alias';
      writeAttempt(inv, finalRef.attempt_ordinal, am);

      assert.throws(
        () => resolveAndVerifySealedReference({ store, reference: finalRef }),
        (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED' && e.topologyMismatch === true && new RegExp(field).test(e.message),
      );
      // sanity: the mutation left report bytes/hash — and the parent
      // invocation.json — alone; ONLY the attempt's operational identity drifted.
      assert.equal(readAttempt(inv, finalRef.attempt_ordinal).report_sha256, reportShaBefore);
      assert.equal(readAttempt(inv, finalRef.attempt_ordinal).report_bytes, reportBytesBefore);
    });
  });
}

// ---- role / stage — exercised on a Council synthesis attempt drifted to ----
// ---- another schema-valid Chair stage (mirrors the accepted P20.6R3 R7-A) --

test('R3-2: authoritative attempt.stage drifted to another schema-valid Chair stage — resolveAndVerifySealedReference itself fails closed', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R32-STAGE';
    const { store, task } = await completeNoDebateCouncil(stores, taskId);
    const m = JSON.parse(readFileSync(task.manifestPath, 'utf8'));
    const synthEntry = m.stages['chair-council-synthesis'];
    const finalRef = synthEntry.sealed_ref;
    const inv = task.openInvocationById(synthEntry.invocation_id);

    const before = resolveAndVerifySealedReference({ store, reference: finalRef });
    assert.equal(before.verified, true);

    const am = readAttempt(inv, finalRef.attempt_ordinal);
    assert.equal(am.stage, 'chair-council-synthesis');
    am.stage = 'chair-plan'; // another schema-valid Chair stage — role unchanged
    writeAttempt(inv, finalRef.attempt_ordinal, am);

    assert.throws(
      () => resolveAndVerifySealedReference({ store, reference: finalRef }),
      (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED' && e.topologyMismatch === true && /stage/.test(e.message),
    );
  });
});

// ---- round — exercised on a Debate chair-synthesis attempt -----------------

test('R3-2: authoritative attempt.round drifted (same stage) — resolveAndVerifySealedReference itself fails closed', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R32-ROUND';
    const { store, task } = await completeDebateRound1(stores, taskId);
    const m = JSON.parse(readFileSync(task.manifestPath, 'utf8'));
    const synthEntry = m.stages['debate::round-01::chair-synthesis'];
    const finalRef = synthEntry.sealed_ref;
    const inv = task.openInvocationById(synthEntry.invocation_id);

    const before = resolveAndVerifySealedReference({ store, reference: finalRef });
    assert.equal(before.verified, true);

    const am = readAttempt(inv, finalRef.attempt_ordinal);
    assert.equal(am.round, 1);
    am.round = 2; // a schema-valid round number, but not the invocation's own round
    writeAttempt(inv, finalRef.attempt_ordinal, am);

    assert.throws(
      () => resolveAndVerifySealedReference({ store, reference: finalRef }),
      (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED' && e.topologyMismatch === true && /round/.test(e.message),
    );
  });
});
