/**
 * P20.6R2 — Source-Final Topology Binding + Latest Corrupt-Candidate
 * Fail-Closed (PM remediation R5-R6, follow-up to P20.6R).
 *
 *   R5-A  a legal Council final key (chair-council-synthesis) whose entry was
 *         moved to point at a valid but non-final sealed invocation
 *         (chair-plan) -> reject (the KEY is legal, the RESOLVED invocation
 *         is not what that key means).
 *   R5-B  a legal Debate final key whose entry was moved to point at a valid
 *         but non-synthesis Debate invocation (chair-brief, same round/role)
 *         -> reject (stage mismatch).
 *   R5-C  a Debate final synthesis at round 1 whose bound typed continuation
 *         control truthfully requests further rounds under a (mutated)
 *         max_rounds=2 -> not a legal terminal final -> reject.
 *   R6-A  the newest COMPLETED/PASS task has a malformed final_ref -> LATEST
 *         still selects it as candidate (no silent filter), then fails
 *         closed; no fallback to an older valid task.
 *   R6-B  the newest COMPLETED/PASS task has final_ref = null -> same.
 *   R6-C  the prior cross-task-corruption case remains rejected after the R6
 *         candidate-discovery change.
 *
 * Offline; NO live model/API calls. Every case mutates the ACTUAL authority
 * copy (task-manifest.json / invocation.json) it claims to corrupt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { resolveAndVerifyTaskFinalArtifact } from '../src/artifacts/artifact-recovery.mjs';
import { latestCompletedTaskId } from '../src/artifacts/artifact-index.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend,
  TASK_FINAL, LATEST_FINAL, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const readManifest = (task) => JSON.parse(readFileSync(task.manifestPath, 'utf8'));
const writeManifest = (task, m) => writeFileSync(task.manifestPath, `${JSON.stringify(m, null, 2)}\n`);
const readInvocation = (inv) => JSON.parse(readFileSync(inv.recordPath, 'utf8'));
const writeInvocation = (inv, rec) => writeFileSync(inv.recordPath, `${JSON.stringify(rec, null, 2)}\n`);

/** A completed no-Debate Council task on the durable machine. */
async function completeNoDebateCouncil({ newArtifactStore, newPmRepo, newStepState }, taskId) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const pmRunId = `r6a${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'x');
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 32 });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  assert.equal(res.status, 'completed');
  const store = newArtifactStore();
  return { store, task: store.openTaskById(taskId) };
}

/** A completed 1-round Debate Council task on the durable machine. */
async function completeDebateRound1({ newArtifactStore, newPmRepo, newStepState }, taskId, { maxRounds = 1 } = {}) {
  const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: maxRounds } });
  const debate = { debateTypedControl: true, continueDebate: () => false };
  const pmRunId = `r6b${taskId}`.repeat(6).slice(0, 96).padEnd(120, 'y');
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

// ============================ R5-A — Council key spoof ====================

test('P20.6R2 R5-A — a legal chair-council-synthesis key pointing at a valid chair-plan invocation is rejected', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R5A-COUNCIL';
    const { store, task } = await completeNoDebateCouncil(stores, taskId);
    const m = readManifest(task);
    assert.equal(m.mode, 'council');
    const chairPlan = JSON.parse(JSON.stringify(m.stages['chair-plan']));
    assert.notDeepEqual(m.final_ref, chairPlan.sealed_ref);

    // move the valid chair-plan sealed entry under the LEGAL final key, and
    // remove its original occurrence so exactly one stage entry matches.
    delete m.stages['chair-plan'];
    m.stages['chair-council-synthesis'] = chairPlan;
    m.final_ref = JSON.parse(JSON.stringify(chairPlan.sealed_ref));
    writeManifest(task, m);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R5A-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});

// ============================ R5-B — Debate key spoof ======================

test('P20.6R2 R5-B — a legal Debate final key pointing at a valid chair-brief (same round/role, wrong stage) is rejected', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R5B-DEBATE';
    const { store, task } = await completeDebateRound1(stores, taskId, { maxRounds: 1 });
    const m = readManifest(task);
    assert.equal(m.council_control.debate.enabled, true);
    const briefKey = 'debate::round-01::chair-brief';
    const synthKey = 'debate::round-01::chair-synthesis';
    assert.ok(m.stages[briefKey] && m.stages[synthKey]);
    const brief = JSON.parse(JSON.stringify(m.stages[briefKey]));
    assert.notDeepEqual(brief.sealed_ref, m.stages[synthKey].sealed_ref);

    delete m.stages[briefKey];
    m.stages[synthKey] = brief; // legal FINAL key, but this entry is really the chair-brief invocation
    m.final_ref = JSON.parse(JSON.stringify(brief.sealed_ref));
    writeManifest(task, m);

    // P20.6R3 R7 restated the legal-topology message generically (still the
    // same ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED family, still fails
    // BEFORE any Debate terminal-control evaluation runs).
    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' && /not a legal final for this task/.test(e.message),
    );
    await targetFailsClosed(store, { targetId: 'task-R5B-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});

// ============================ R5-C — premature terminal ====================

test('P20.6R2 R5-C — a round-1 Debate synthesis whose typed control truthfully requests round 2 under max_rounds=2 is not a legal terminal final', async () => {
  await withStores(async (stores) => {
    const taskId = 'task-R5C-DEBATE';
    const { store, task } = await completeDebateRound1(stores, taskId, { maxRounds: 1 });
    const m = readManifest(task);
    const synthKey = 'debate::round-01::chair-synthesis';
    const synthEntry = m.stages[synthKey];
    assert.ok(synthEntry);

    // bounded on-disk adversarial mutation: the persisted council control now
    // claims 2 rounds were possible, and the bound typed control on the
    // ACTUAL sealed synthesis invocation truthfully says "continue".
    m.council_control.debate.max_rounds = 2;
    writeManifest(task, m);

    const inv = task.openInvocationById(synthEntry.invocation_id);
    const rec = readInvocation(inv);
    assert.equal(rec.debate_continuation.round, 1);
    rec.debate_continuation.continue_debate = true;
    writeInvocation(inv, rec);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' && /not a legal terminal final/.test(e.message),
    );
    await targetFailsClosed(store, { targetId: 'task-R5C-TGT', selectors: [TASK_FINAL(taskId)], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});

// ============================ R6 — latest candidate discovery =============

test('P20.6R2 R6-A — the newest COMPLETED/PASS candidate with a malformed final_ref is still selected (not filtered out), then fails closed with no fallback', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const OLD = await completeSingle(store, { taskId: 'task-R6A-OLD', createdAt: '2026-09-10T08:00:00Z' });
    const NEW = await completeSingle(store, { taskId: 'task-R6A-NEW', createdAt: '2026-09-13T08:00:00Z' });

    const nm = readManifest(NEW.task);
    nm.final_ref = { schema_version: 1, not: 'a valid sealed reference' }; // structurally invalid, non-sealed
    writeManifest(NEW.task, nm);

    // candidate discovery must still pick NEW — it is not silently filtered
    // out merely because its projected final_ref failed to validate.
    assert.equal(latestCompletedTaskId({ store }), 'task-R6A-NEW');

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId: 'task-R6A-NEW' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    await targetFailsClosed(store, { targetId: 'task-R6A-TGT', selectors: [LATEST_FINAL()], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
    assert.notEqual(OLD.taskId, 'task-R6A-NEW', 'sanity: OLD is a distinct, still-valid task that was NOT silently chosen');
  });
});

test('P20.6R2 R6-B — the newest COMPLETED/PASS candidate with final_ref = null is still selected, then fails closed with no fallback', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const OLD = await completeSingle(store, { taskId: 'task-R6B-OLD', createdAt: '2026-09-10T08:00:00Z' });
    const NEW = await completeSingle(store, { taskId: 'task-R6B-NEW', createdAt: '2026-09-13T08:00:00Z' });

    const nm = readManifest(NEW.task);
    nm.final_ref = null;
    writeManifest(NEW.task, nm);

    assert.equal(latestCompletedTaskId({ store }), 'task-R6B-NEW');
    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId: 'task-R6B-NEW' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE',
    );
    await targetFailsClosed(store, { targetId: 'task-R6B-TGT', selectors: [LATEST_FINAL()], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE' });
    assert.notEqual(OLD.taskId, 'task-R6B-NEW');
  });
});

test('P20.6R2 R6-C — the prior cross-task LATEST corruption remains rejected after the R6 candidate-discovery change', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const OLD = await completeSingle(store, { taskId: 'task-R6C-OLD', createdAt: '2026-09-10T08:00:00Z' });
    const NEW = await completeSingle(store, { taskId: 'task-R6C-NEW', createdAt: '2026-09-13T08:00:00Z' });

    const nm = readManifest(NEW.task);
    nm.final_ref = JSON.parse(JSON.stringify(OLD.finalRef)); // structurally valid, but belongs to OLD
    writeManifest(NEW.task, nm);

    assert.equal(latestCompletedTaskId({ store }), 'task-R6C-NEW');
    await targetFailsClosed(store, { targetId: 'task-R6C-TGT', selectors: [LATEST_FINAL()], expectedCode: 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' });
  });
});
