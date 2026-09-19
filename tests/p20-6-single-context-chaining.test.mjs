/**
 * P20.6 — SINGLE Context Chaining end-to-end through `runSingleReport`.
 *
 *   A  A -> B -> C direct chaining; C consumes B only (no transitive A)
 *   B  explicit [A, B] -> consumer receives exactly A then B in order
 *   J  stable latest: resolve once, newer task later, target still consumes A
 *   K  VERBATIM_CONTENT is exact/full/untrusted (LF/CRLF/ws/unicode/emoji/ZWSP/fences/JSON)
 *   L  NATIVE_ASSIGNED_READ carries path/sha/bytes only; body NOT pasted; unproven route fails pre-provider
 *   N  parser/canonicalizer bypass — chaotic JSON in prior + new report, run still completes
 *   Q  legacy: a SINGLE report with NO context selectors is unchanged (previous_task_refs == [])
 *   R  restart: reopen target from disk -> consume the SAME persisted concrete refs, no re-resolution
 *
 * Offline; NO live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { prepareContextForConsumption } from '../src/artifacts/artifact-context.mjs';
import { findTaskHistoryEntry, buildTaskIndex } from '../src/runtime/task-context-index.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend, fakeReportBackend,
  TASK_FINAL, LATEST_FINAL, REF, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';

async function chainStep(store, { taskId, createdAt, selectors, text, transport, product, backend }) {
  const b = backend ?? countingBackend(fakeReportBackend({ text: text ?? `# ${taskId}\n\nbody of ${taskId}\n` }));
  const out = await runSingleReport({
    store, taskId, taskSlug: taskId.toLowerCase(), createdAt: createdAt ?? TARGET_CREATED,
    invocationId: `inv-${taskId}`, executionId: `exec-${taskId}`,
    profileId: 'live1-fake', backend: product ?? 'fake', actorAlias: 'fake',
    instructions: `run ${taskId}`, reportBackend: b, startedAt: createdAt ?? TARGET_CREATED,
    complete: true,
    contextSelectors: selectors,
    contextInputTransport: transport,
  });
  return { out, backend: b, manifest: out.completion.manifest, finalRef: out.completion.finalRef, prompt: b.lastPrompt };
}

// ---- A. A -> B -> C direct chaining --------------------------------

test('P20.6 A — A->B->C: C.previous_task_refs == [B], C consumes B only (no transitive A)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-CHAINA01', text: '# A\n\nAAA-UNIQUE-MARKER content of A\n' });
    const B = await chainStep(store, { taskId: 'task-CHAINB01', selectors: [TASK_FINAL(A.taskId)], text: '# B\n\nBBB-UNIQUE-MARKER content of B\n' });
    assert.equal(B.manifest.previous_task_refs.length, 1);
    assert.equal(B.manifest.previous_task_refs[0].task_id, A.taskId);

    const C = await chainStep(store, { taskId: 'task-CHAINC01', selectors: [TASK_FINAL('task-CHAINB01')], text: '# C\n\ncontent of C\n' });
    assert.equal(C.manifest.previous_task_refs.length, 1, 'exactly one direct dependency');
    assert.equal(C.manifest.previous_task_refs[0].task_id, 'task-CHAINB01');
    assert.match(C.prompt, /BBB-UNIQUE-MARKER/, 'C receives B');
    assert.doesNotMatch(C.prompt, /AAA-UNIQUE-MARKER/, 'C does NOT receive A transitively');
  });
});

// ---- B. explicit [A, B] ------------------------------------------

test('P20.6 B — C selects [A, B]: consumer receives exactly A then B in that order', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-EXPA0001', text: '# A\n\nAAA-MARK body\n' });
    const B = await completeSingle(store, { taskId: 'task-EXPB0001', text: '# B\n\nBBB-MARK body\n' });
    const C = await chainStep(store, { taskId: 'task-EXPC0001', selectors: [TASK_FINAL(A.taskId), TASK_FINAL(B.taskId)] });
    assert.deepEqual(C.manifest.previous_task_refs.map((r) => r.task_id), [A.taskId, B.taskId]);
    assert.ok(C.prompt.indexOf('AAA-MARK') < C.prompt.indexOf('BBB-MARK'), 'A appears before B');
    assert.doesNotMatch(C.prompt, /task-EXP.*UNRELATED/);
  });
});

// ---- J. stable latest ------------------------------------------

test('P20.6 J — LATEST_FINAL resolves once; a newer task later does not change the target', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-LATESTA1', createdAt: '2026-09-10T08:00:00Z', text: '# A\n\nAAA-LATEST body\n' });
    // B admits LATEST -> resolves to A, persists A's concrete final_ref.
    const B = await chainStep(store, { taskId: 'task-LATESTB1', createdAt: '2026-09-10T09:00:00Z', selectors: [LATEST_FINAL()] });
    assert.deepEqual(B.manifest.previous_task_refs.map((r) => r.task_id), [A.taskId]);

    // A newer completed task C appears; "latest" would now be C.
    const C = await completeSingle(store, { taskId: 'task-LATESTC1', createdAt: '2026-09-12T09:00:00Z', text: '# C\n\nCCC newer body\n' });
    assert.notEqual(C.taskId, A.taskId);

    // B resumed/executed later still consumes A — no re-resolution to latest.
    const reopened = makeStore(dir).openTaskById('task-LATESTB1');
    const ctx = prepareContextForConsumption({ store: makeStore(dir), task: reopened, consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' });
    assert.deepEqual(ctx.refs.map((r) => r.task_id), [A.taskId]);

    // Reopening B with a now-moved LATEST selector must NOT rewrite B's authority.
    await assert.rejects(
      chainStep(store, { taskId: 'task-LATESTB1', createdAt: '2026-09-10T09:00:00Z', selectors: [LATEST_FINAL()] }),
      (e) => e.code === 'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
    );
    assert.deepEqual(makeStore(dir).openTaskById('task-LATESTB1').manifest.previous_task_refs.map((r) => r.task_id), [A.taskId]);
  });
});

// ---- K. VERBATIM_CONTENT exactness ---------------------------

test('P20.6 K — VERBATIM_CONTENT delivers the prior report byte-exactly (LF/CRLF/ws/unicode/emoji/ZWSP/fences/JSON)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const priorBody = [
      '   leading spaces and a trailing tab\t',
      'LF line',
      'CRLF line\r',
      'unicode: café — naïve — 日本語',
      'emoji: 🧪🔬✅',
      'zero-width:[​‌‍]',
      '```json',
      '{"a":1}',
      '```',
      '```',
      '{ "b": 2, }   <- malformed on purpose',
      '```',
      'multiple json: {"x":1} then {"y":2}',
      '   ',
    ].join('\n');
    const P = await completeSingle(store, { taskId: 'task-VERBATIM1', text: priorBody });
    const T = await chainStep(store, { taskId: 'task-VERBATGT1', selectors: [TASK_FINAL(P.taskId)], transport: 'VERBATIM_CONTENT' });
    assert.ok(T.prompt.includes(priorBody), 'the exact prior bytes appear verbatim with no trim/normalisation');
    assert.equal(T.manifest.previous_task_refs[0].task_id, P.taskId);
  });
});

// ---- L. NATIVE_ASSIGNED_READ -------------------------------

test('P20.6 L — NATIVE_ASSIGNED_READ carries verified path/sha/bytes only; the prior body is NOT pasted', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const P = await completeSingle(store, { taskId: 'task-NATIVEP1', text: '# prior\n\nNATIVE-BODY-MARKER should not be inlined\n' });
    const T = await chainStep(store, { taskId: 'task-NATIVEGT1', selectors: [TASK_FINAL(P.taskId)], transport: 'NATIVE_ASSIGNED_READ' });
    assert.match(T.prompt, /assigned_sealed_artifacts/);
    assert.ok(T.prompt.includes(P.finalRef.sha256), 'prompt carries the verified sha256');
    assert.ok(T.prompt.includes(`bytes=${P.finalRef.bytes}`), 'prompt carries the verified byte count');
    assert.doesNotMatch(T.prompt, /NATIVE-BODY-MARKER/, 'the prior report body is never pasted');
  });
});

test('P20.6 L — an UNPROVEN native-read consumer route fails before the target provider, no target task', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const P = await completeSingle(store, { taskId: 'task-NATIVEP2' });
    const backend = countingBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-NATIVEBAD', taskSlug: 't', createdAt: TARGET_CREATED,
        invocationId: 'inv-nb', executionId: 'exec-nb',
        profileId: 'live1-fake', backend: 'api', actorAlias: 'fake',
        instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
        contextSelectors: [REF(P.finalRef)], contextInputTransport: 'NATIVE_ASSIGNED_READ',
      }),
      // P20.6R R4: the effective context input transport now drives the
      // pre-allocation report-route check, so an unproven native route trips
      // assertReportRoute (ARTIFACT_REPORT_INPUT_UNSUPPORTED) rather than the
      // context admission adapter (ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED). Both
      // are fail-closed BEFORE target allocation / any provider call.
      (e) => e.code === 'ARTIFACT_REPORT_INPUT_UNSUPPORTED' || e.code === 'ARTIFACT_CONTEXT_ROUTE_UNSUPPORTED',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-NATIVEBAD'), null);
  });
});

// ---- N. parser / canonicalizer bypass ----------------------

test('P20.6 N — chaotic/malformed JSON in prior + new report: the run completes, no semantic parse of report content', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const priorBody = '{"decision":"garbage"} {"not":"closed" \n```json\n{bad}\n``` trailing';
    const P = await completeSingle(store, { taskId: 'task-CHAOSP1', text: priorBody });
    const targetBody = 'result: {"multiple":1}{"json":2} and {broken';
    const T = await chainStep(store, { taskId: 'task-CHAOSGT1', selectors: [TASK_FINAL(P.taskId)], text: targetBody });
    // the new SINGLE report sealed exactly its own bytes; prior went in verbatim.
    assert.ok(T.finalRef.sha256 && T.finalRef.bytes === Buffer.byteLength(targetBody, 'utf8'));
    assert.ok(T.prompt.includes(priorBody));
    assert.equal(T.out.completion.integrity.state ?? T.out.completion.integrity, 'ARTIFACT_PASS');
  });
});

// ---- Q. legacy P12 unchanged ------------------------------

test('P20.6 Q — a SINGLE report with NO context selectors is unchanged (previous_task_refs == [])', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const S = await completeSingle(store, { taskId: 'task-NOCTXQ1' });
    assert.deepEqual(S.manifest.previous_task_refs, []);
    // the legacy docs/history discovery lane is untouched and still best-effort
    assert.equal(findTaskHistoryEntry(dir, 'anything'), null);
    assert.deepEqual(buildTaskIndex(dir), []);
  });
});

// ---- R. restart stability -------------------------------

test('P20.6 R — reopening the bound target from disk consumes the SAME persisted concrete refs (no re-resolution)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-RESTARTA', text: '# A\n\nRESTART-A body\n' });
    const B = await chainStep(store, { taskId: 'task-RESTARTB', selectors: [TASK_FINAL(A.taskId)] });
    const persisted = B.manifest.previous_task_refs;

    // fresh store objects, reopened purely from disk
    const store2 = makeStore(dir);
    const task2 = store2.openTaskById('task-RESTARTB');
    assert.deepEqual(task2.manifest.previous_task_refs, persisted);
    const ctx = prepareContextForConsumption({ store: store2, task: task2, consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' });
    assert.deepEqual(ctx.refs, persisted.map((r) => ({ ...r })));
    assert.match(ctx.rendered.evidence[0].content, /RESTART-A body/);
  });
});
