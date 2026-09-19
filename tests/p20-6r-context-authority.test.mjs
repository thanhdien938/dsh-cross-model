/**
 * P20.6R — SINGLE Context Authority Closure (PM remediation R1–R4).
 *
 *   R1  a context-bound target NEVER runs context-free on reopen/resume,
 *       even when the caller omits selectors / passes [] / re-enters after a
 *       crash; a bound LATEST_FINAL is not re-resolved.
 *   R2  TASK_FINAL / LATEST_FINAL bind final_ref to the SOURCE task's own
 *       final authority (cross-task substitution, same-task wrong-stage
 *       substitution, corrupt newest LATEST candidate all fail closed).
 *   R3  Boundary B binds target store/project/task/mode BEFORE consuming refs.
 *   R4  the effective context input transport IS the recorded report-attempt
 *       input_transport (VERBATIM / NATIVE provenance, conflict, repair route).
 *
 * Offline; NO live model/API calls. Every adversarial case mutates the
 * ACTUAL authority copy it claims to test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { prepareContextForConsumption, ArtifactContextError } from '../src/artifacts/artifact-context.mjs';
import { resolveAndVerifyTaskFinalArtifact } from '../src/artifacts/artifact-recovery.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend, fakeReportBackend,
  TASK_FINAL, LATEST_FINAL, REF, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const CREATED = '2026-09-11T09:00:00Z';
const readManifest = (task) => JSON.parse(readFileSync(task.manifestPath, 'utf8'));
const writeManifest = (task, m) => writeFileSync(task.manifestPath, `${JSON.stringify(m, null, 2)}\n`);

/** Allocate a context-bound target task WITHOUT running its provider (crash window). */
async function bindTargetNoProvider(store, { targetId, selectors }) {
  const backend = countingBackend({ async runReport() { throw new Error('provider must not run during bind window'); } });
  await assert.rejects(runSingleReport({
    store, taskId: targetId, taskSlug: 'target', createdAt: TARGET_CREATED,
    invocationId: `inv-${targetId}-bind`, executionId: `exec-${targetId}-bind`,
    profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
    instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED,
    contextSelectors: selectors,
  }));
  assert.equal(backend.calls, 1, 'provider was reached exactly once and threw (bind persisted, no seal)');
}

async function reenterTarget(store, { targetId, selectors, text = '# target\n\ntarget body\n' }) {
  const backend = countingBackend(fakeReportBackend({ text }));
  const res = await runSingleReport({
    store, taskId: targetId, taskSlug: 'target', createdAt: TARGET_CREATED,
    invocationId: `inv-${targetId}-run`, executionId: `exec-${targetId}-run`,
    profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
    instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
    ...(selectors !== undefined ? { contextSelectors: selectors } : {}),
  });
  return { res, backend, prompt: backend.lastPrompt };
}

// ================= R1 — bound target never runs context-free =================

test('P20.6R R1-A — crash/restart bound task, selectors omitted: consumes exact persisted A, resolver not re-run', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-R1A-SRC', text: '# A\n\nR1A-MARKER-A body\n' });
    await bindTargetNoProvider(store, { targetId: 'task-R1A-TGT', selectors: [TASK_FINAL(A.taskId)] });
    assert.deepEqual(makeStore(dir).openTaskById('task-R1A-TGT').manifest.previous_task_refs.map((r) => r.task_id), [A.taskId]);

    // Break A's task authority so a RE-RESOLUTION of TASK_FINAL(A) would fail;
    // Boundary B (persisted concrete ref) must still succeed.
    const am = readManifest(A.task); am.task_state = 'OPEN'; writeManifest(A.task, am);

    const store2 = makeStore(dir); // fresh process/store object
    const { res, prompt } = await reenterTarget(store2, { targetId: 'task-R1A-TGT' /* no selectors */ });
    assert.equal(res.completion.finalRef.sha256 !== undefined, true, 'target completed');
    assert.match(prompt, /R1A-MARKER-A body/, 'the provider saw the exact persisted A content');
  });
});

test('P20.6R R1-B — bound task + contextSelectors: [] does NOT run context-free', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-R1B-SRC', text: '# A\n\nR1B-MARKER body\n' });
    await bindTargetNoProvider(store, { targetId: 'task-R1B-TGT', selectors: [TASK_FINAL(A.taskId)] });

    const { res, prompt } = await reenterTarget(makeStore(dir), { targetId: 'task-R1B-TGT', selectors: [] });
    assert.ok(res.completion.finalRef, 'completed via persisted context, not context-free');
    assert.match(prompt, /R1B-MARKER body/);
  });
});

test('P20.6R R1-C — bound LATEST_FINAL is not re-resolved when a newer task appears', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-R1C-A', createdAt: '2026-09-10T08:00:00Z', text: '# A\n\nR1C-A body marker\n' });
    await bindTargetNoProvider(store, { targetId: 'task-R1C-TGT', selectors: [LATEST_FINAL()] });
    assert.deepEqual(makeStore(dir).openTaskById('task-R1C-TGT').manifest.previous_task_refs.map((r) => r.task_id), [A.taskId]);

    // a newer completed task C — "latest" would now be C
    const C = await completeSingle(store, { taskId: 'task-R1C-C', createdAt: '2026-09-13T08:00:00Z', text: '# C\n\nR1C-C NEWER body\n' });
    assert.notEqual(C.taskId, A.taskId);

    // re-enter with no selectors -> still consumes A
    const noSel = await reenterTarget(makeStore(dir), { targetId: 'task-R1C-TGT' });
    assert.match(noSel.prompt, /R1C-A body marker/);
    assert.doesNotMatch(noSel.prompt, /R1C-C NEWER body/);

    // re-enter WITH [LATEST_FINAL()] now that latest moved -> fail closed, never silently rebind to C
    await assert.rejects(
      reenterTarget(makeStore(dir), { targetId: 'task-R1C-TGT', selectors: [LATEST_FINAL()] }),
      (e) => e.code === 'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
    );
    assert.deepEqual(makeStore(dir).openTaskById('task-R1C-TGT').manifest.previous_task_refs.map((r) => r.task_id), [A.taskId]);
  });
});

// ============ R2 — TASK_FINAL / LATEST_FINAL source-final authority ============

test('P20.6R R2-A — cross-task final_ref substitution: TASK_FINAL(A) fails closed, no target task, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-R2A-A' });
    const B = await completeSingle(store, { taskId: 'task-R2A-B' });

    // point A.final_ref at B's fully-valid sealed final ref, keep A COMPLETED/PASS
    const am = readManifest(A.task);
    am.final_ref = JSON.parse(JSON.stringify(B.finalRef));
    writeManifest(A.task, am);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId: 'task-R2A-A' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );

    const backend = countingBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-R2A-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
        invocationId: 'inv-r2a', executionId: 'exec-r2a',
        profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
        instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
        contextSelectors: [TASK_FINAL('task-R2A-A')],
      }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-R2A-TGT'), null);
  });
});

test('P20.6R R2-B — same-task wrong-stage substitution: TASK_FINAL(source) fails closed as wrong final topology', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
    const taskId = 'task-R2B-COUNCIL';
    const pmRunId = 'r2b6'.repeat(30) + 'BB';
    const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: [], taskId, maxTurns: 32 });
    const cres = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(cres.status, 'completed');

    const store = newArtifactStore();
    const task = store.openTaskById(taskId);
    const m = readManifest(task);
    assert.equal(m.mode, 'council');
    // the legitimate final stage is chair-council-synthesis; repoint final_ref
    // at a DIFFERENT valid sealed stage of the SAME task (chair-plan).
    const wrongStageKey = Object.keys(m.stages).find((k) => k === 'chair-plan');
    assert.ok(wrongStageKey, 'the council fixture sealed a chair-plan stage');
    assert.notDeepEqual(m.final_ref, m.stages[wrongStageKey].sealed_ref);
    m.final_ref = JSON.parse(JSON.stringify(m.stages[wrongStageKey].sealed_ref));
    writeManifest(task, m);

    assert.throws(
      () => resolveAndVerifyTaskFinalArtifact({ store, taskId }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED' && /not a legal FINAL stage/.test(e.message),
    );

    const backend = countingBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-R2B-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
        invocationId: 'inv-r2b', executionId: 'exec-r2b',
        profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
        instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
        contextSelectors: [TASK_FINAL(taskId)],
      }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-R2B-TGT'), null);
  });
});

test('P20.6R R2-C — LATEST_FINAL with a corrupted newest candidate fails closed; no silent fallback to an older task', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const OLD = await completeSingle(store, { taskId: 'task-R2C-OLD', createdAt: '2026-09-10T08:00:00Z' });
    const NEW = await completeSingle(store, { taskId: 'task-R2C-NEW', createdAt: '2026-09-13T08:00:00Z' });

    // corrupt the NEWEST candidate's final authority: cross-task final_ref,
    // still COMPLETED/PASS.
    const nm = readManifest(NEW.task);
    nm.final_ref = JSON.parse(JSON.stringify(OLD.finalRef));
    writeManifest(NEW.task, nm);

    const backend = countingBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-R2C-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
        invocationId: 'inv-r2c', executionId: 'exec-r2c',
        profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
        instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
        contextSelectors: [LATEST_FINAL()],
      }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED',
    );
    assert.equal(backend.calls, 0, 'no fallback to the older valid task');
    assert.equal(store.openTaskById('task-R2C-TGT'), null);
  });
});

// ================= R3 — Boundary B binds target identity =================

test('P20.6R R3 — a task workspace whose manifest != claimed targetTaskId cannot supply context refs', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-R3-A' });
    const B = await completeSingle(store, { taskId: 'task-R3-B' }); // a valid, unrelated SINGLE task

    // claim targetTaskId 'task-R3-C' while passing Task B's workspace
    assert.throws(
      () => prepareContextForConsumption({ store, task: B.task, targetTaskId: 'task-R3-C', consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' }),
      (e) => e instanceof ArtifactContextError && e.code === 'ARTIFACT_CONTEXT_BOUNDARY_B_TARGET_MISMATCH',
    );

    // wrong store identity via a real alternate store fixture
    const otherStore = makeStore(dir, { storeId: 'other-store-id' });
    assert.throws(
      () => prepareContextForConsumption({ store: otherStore, task: B.task, targetTaskId: 'task-R3-B', consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_BOUNDARY_B_TARGET_MISMATCH',
    );
  });
});

// ================= R4 — context input transport provenance =================

async function ctxRun(store, { targetId, transport, product = 'fake', repairBackend, inputTransport }) {
  const backend = repairBackend ?? countingBackend(fakeReportBackend({ text: '# target\n\ntarget body content\n' }));
  const src = await completeSingle(store, { taskId: `${targetId}-SRC`, text: '# prior\n\nR4-PRIOR-MARKER prior body\n' });
  const res = await runSingleReport({
    store, taskId: targetId, taskSlug: 't', createdAt: TARGET_CREATED,
    invocationId: `inv-${targetId}`, executionId: `exec-${targetId}`,
    profileId: 'live1-fake', backend: product, actorAlias: 'fake',
    instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
    contextSelectors: [TASK_FINAL(src.taskId)],
    contextInputTransport: transport,
    ...(inputTransport !== undefined ? { inputTransport } : {}),
  });
  return { res, backend, src };
}

test('P20.6R R4-A — VERBATIM_CONTENT provenance: artifact.json.input_transport === trusted prompt input_transport === VERBATIM_CONTENT', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { res, backend } = await ctxRun(store, { targetId: 'task-R4A', transport: 'VERBATIM_CONTENT' });
    const meta = res.invocation.freshAttemptMetadata(res.completion.sealedAttemptOrdinal);
    assert.equal(meta.input_transport, 'VERBATIM_CONTENT');
    assert.match(backend.lastPrompt, /input_transport: VERBATIM_CONTENT/);
    assert.match(backend.lastPrompt, /R4-PRIOR-MARKER prior body/, 'exact prior content was supplied');
  });
});

test('P20.6R R4-B — NATIVE_ASSIGNED_READ provenance: artifact.json + trusted prompt === NATIVE_ASSIGNED_READ, body absent', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { res, backend } = await ctxRun(store, { targetId: 'task-R4B', transport: 'NATIVE_ASSIGNED_READ' });
    const meta = res.invocation.freshAttemptMetadata(res.completion.sealedAttemptOrdinal);
    assert.equal(meta.input_transport, 'NATIVE_ASSIGNED_READ');
    assert.match(backend.lastPrompt, /input_transport: NATIVE_ASSIGNED_READ/);
    assert.match(backend.lastPrompt, /assigned_sealed_artifacts/);
    assert.doesNotMatch(backend.lastPrompt, /R4-PRIOR-MARKER prior body/, 'the prior body is not pasted for a native route');
  });
});

test('P20.6R R4-C — conflicting inputTransport vs contextInputTransport fails before target allocation / provider', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const src = await completeSingle(store, { taskId: 'task-R4C-SRC' });
    const backend = countingBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-R4C-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
        invocationId: 'inv-r4c', executionId: 'exec-r4c',
        profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
        instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
        contextSelectors: [TASK_FINAL(src.taskId)],
        contextInputTransport: 'VERBATIM_CONTENT',
        inputTransport: 'NATIVE_ASSIGNED_READ',
      }),
      (e) => e.code === 'SINGLE_REPORT_CONTEXT_TRANSPORT_CONFLICT',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-R4C-TGT'), null);
  });
});

test('P20.6R R4-D — a forced delivery repair re-admits the SAME effective context input transport (not null)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    // first synthesis delivery is whitespace -> REPORT_EMPTY -> bounded repair;
    // the repair re-invocation returns a real body.
    let n = 0;
    const repairBackend = countingBackend({
      async runReport(a) {
        n += 1;
        const text = n === 1 ? '   ' : '# repaired target\n\nrepaired body\n';
        return fakeReportBackend({ text }).runReport(a);
      },
    });
    const { res } = await ctxRun(store, { targetId: 'task-R4D', transport: 'VERBATIM_CONTENT', repairBackend });
    assert.equal(res.completion.repaired, true, 'a bounded delivery repair happened');
    const meta = res.invocation.freshAttemptMetadata(res.completion.sealedAttemptOrdinal);
    assert.equal(meta.input_transport, 'VERBATIM_CONTENT', 'the repaired authoritative attempt keeps context transport provenance');
    assert.notEqual(meta.input_transport, null);
  });
});
