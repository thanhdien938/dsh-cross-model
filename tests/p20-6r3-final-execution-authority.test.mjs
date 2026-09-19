/**
 * P20.6R3 — Final Source Authority Chain Closure (PM remediation R7-R8,
 * follow-up to P20.6R2).
 *
 *   R7-A  Council: the authoritative final attempt's artifact.json is
 *         drifted to another schema-valid Chair stage (chair-plan) while
 *         final_ref / manifest stage entry / invocation.json / report
 *         bytes-hash stay untouched -> reject.
 *   R7-B  Debate: the authoritative final attempt's artifact.json stage is
 *         drifted to another Chair Debate stage (debate-chair-brief), same
 *         round, while everything else stays untouched -> reject.
 *   R8-A  Debate: debate_continuation.execution_id is drifted away from the
 *         authoritative artifact.json.execution_id (continue_debate/report/
 *         invocation seal untouched) -> reject via the accepted P20.5
 *         same-execution binding primitive.
 *   R8-B  Debate: debate_continuation.role is drifted (not cross-file bound
 *         by pure schema) -> reject via the same binding primitive.
 *   R8-C  a normal completed Debate source's valid terminal control still
 *         resolves successfully via TASK_FINAL — no regression.
 *
 * Offline; NO live model/API calls. Every case mutates the ACTUAL authority
 * copy (task-manifest.json / invocation.json / attempt artifact.json) it
 * claims to corrupt, and leaves the sealed report bytes/hash untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { resolveAndVerifyTaskFinalArtifact } from '../src/artifacts/artifact-recovery.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  countingBackend, TASK_FINAL, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const readManifest = (task) => JSON.parse(readFileSync(task.manifestPath, 'utf8'));
const writeManifest = (task, m) => writeFileSync(task.manifestPath, `${JSON.stringify(m, null, 2)}\n`);
const readInvocation = (inv) => JSON.parse(readFileSync(inv.recordPath, 'utf8'));
const writeInvocation = (inv, rec) => writeFileSync(inv.recordPath, `${JSON.stringify(rec, null, 2)}\n`);
const readAttempt = (inv, ordinal) => JSON.parse(readFileSync(inv.attemptArtifactJsonPath(ordinal), 'utf8'));
const writeAttempt = (inv, ordinal, meta) => writeFileSync(inv.attemptArtifactJsonPath(ordinal), `${JSON.stringify(meta, null, 2)}\n`);

async function completeNoDebateCouncil({ newArtifactStore, newPmRepo, newStepState }, taskId) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const pmRunId = `r7a${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'x');
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 32 });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  assert.equal(res.status, 'completed');
  const store = newArtifactStore();
  return { store, task: store.openTaskById(taskId) };
}

async function completeDebateRound1({ newArtifactStore, newPmRepo, newStepState }, taskId, { maxRounds = 1, continueDebate = () => false } = {}) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: maxRounds } });
  const debate = { debateTypedControl: true, continueDebate };
  const pmRunId = `r7b${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'y');
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 40, debate });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  assert.equal(res.status, 'completed');
  const store = newArtifactStore();
  return { store, task: store.openTaskById(taskId) };
}

async function targetFailsClosed(store, { targetId, selectors, expectedCode }) {
  const backend = countingBackend();
  await assert.rejects(
    runSingleReport({
      store, taskId: targetId, taskSlug: 't', createdAt: TARGET_CREATED,
      invocationId: `inv-${targetId}`, executionId: `exec-${targetId}`,
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
      contextSelectors: selectors,
    }),
    (e) => e.code === expectedCode,
  );
  assert.equal(backend.calls, 0, '0 target provider calls');
  assert.equal(store.openTaskById(targetId), null, 'target task directory not created');
}

// ======================= R7 — attempt-metadata topology binding ============

test('P20.6R3 R7-A — Council: authoritative attempt drifted to a valid chair-plan stage (final_ref/manifest/invocation/report bytes untouched) is rejected', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R7A-COUNCIL';
    const { store, task } = await completeNoDebateCouncil(stores, taskId);
    const m = readManifest(task);
    const synthEntry = m.stages['chair-council-synthesis'];
    const inv = task.openInvocationById(synthEntry.invocation_id);
    const rec = readInvocation(inv);
    const ordinal = rec.authoritative_attempt;
    const am = readAttempt(inv, ordinal);
    assert.equal(am.stage, 'chair-council-synthesis');
    const reportShaBefore = am.report_sha256;
    const reportBytesBefore = am.report_bytes;

    // Drift ONLY the authoritative attempt's operational topology to another
    // schema-valid Chair combination. Report ref/hash/bytes untouched.
    am.stage = 'chair-plan';
    writeAttempt(inv, ordinal, am);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R7A-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });

    // sanity: the mutation really did leave the report bytes/hash alone
    assert.equal(readAttempt(inv, ordinal).report_sha256, reportShaBefore);
    assert.equal(readAttempt(inv, ordinal).report_bytes, reportBytesBefore);
  });
});

test('P20.6R3 R7-B — Debate: authoritative attempt drifted to a valid chair-brief stage (same round) is rejected', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R7B-DEBATE';
    const { store, task } = await completeDebateRound1(stores, taskId);
    const m = readManifest(task);
    const synthEntry = m.stages['debate::round-01::chair-synthesis'];
    const inv = task.openInvocationById(synthEntry.invocation_id);
    const rec = readInvocation(inv);
    const ordinal = rec.authoritative_attempt;
    const am = readAttempt(inv, ordinal);
    assert.equal(am.stage, 'debate-chair-synthesis');
    assert.equal(am.round, 1);

    am.stage = 'debate-chair-brief'; // another Chair Debate stage, same round — schema-valid
    writeAttempt(inv, ordinal, am);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R7B-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});

// ======================= R8 — same-execution Debate control binding ========

test('P20.6R3 R8-A — Debate: debate_continuation.execution_id drifted from the authoritative artifact.json.execution_id is rejected', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R8A-DEBATE';
    const { store, task } = await completeDebateRound1(stores, taskId);
    const m = readManifest(task);
    const synthEntry = m.stages['debate::round-01::chair-synthesis'];
    const inv = task.openInvocationById(synthEntry.invocation_id);
    const rec = readInvocation(inv);
    const ordinal = rec.authoritative_attempt;
    const am = readAttempt(inv, ordinal);
    assert.equal(rec.debate_continuation.continue_debate, false, 'a valid/STOP terminal control');
    assert.equal(rec.debate_continuation.execution_id, am.execution_id, 'sanity: originally bound');

    rec.debate_continuation.execution_id = 'exec-DRIFTED-0000';
    writeInvocation(inv, rec);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R8A-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });

    // sanity: the report/attempt/seal were never touched
    assert.equal(readAttempt(inv, ordinal).execution_id, am.execution_id);
  });
});

test('P20.6R3 R8-B — Debate: debate_continuation.role drifted (not cross-file bound by pure schema) is rejected via the accepted binding primitive', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R8B-DEBATE';
    const { store, task } = await completeDebateRound1(stores, taskId);
    const m = readManifest(task);
    const synthEntry = m.stages['debate::round-01::chair-synthesis'];
    const inv = task.openInvocationById(synthEntry.invocation_id);
    const rec = readInvocation(inv);
    assert.equal(rec.debate_continuation.role, 'chair');

    rec.debate_continuation.role = 'member'; // structurally accepted by pure schema (role is not format-checked there)
    writeInvocation(inv, rec);
    // confirm the mutation actually reaches the source-final check, i.e. the
    // durable store itself still considers this invocation.json readable.
    assert.doesNotThrow(() => task.openInvocationById(synthEntry.invocation_id).record);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R8B-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});

test('P20.6R3 R8-C — a normal completed Debate source with a valid terminal control resolves successfully via TASK_FINAL (no regression)', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R8C-DEBATE';
    const { store } = await completeDebateRound1(stores, taskId);

    const { manifest, finalRef, stageKey } = resolveAndVerifyTaskFinalArtifact({ store, taskId });
    assert.equal(stageKey, 'debate::round-01::chair-synthesis');
    assert.deepEqual(finalRef, manifest.final_ref);

    const backend = countingBackend();
    const res = await runSingleReport({
      store, taskId: 'task-R8C-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
      invocationId: 'inv-r8c', executionId: 'exec-r8c',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
      contextSelectors: [TASK_FINAL(taskId)],
    });
    assert.equal(backend.calls, 1);
    assert.ok(res.completion.finalRef);
    assert.equal(res.completion.manifest.previous_task_refs[0].task_id, taskId);
  });
});
