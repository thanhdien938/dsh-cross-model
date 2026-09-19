/**
 * P20.6 — the rebuildable artifact discovery index.
 *
 *   O  build -> delete convenience output -> rebuild from canonical metadata
 *      => deterministically equivalent records; a stale/corrupt convenience
 *      index cannot change required-context acceptance
 *   P  mutating ONLY report prose does not change any index fact; if the
 *      mutation breaks the sealed hash the authority verifier fails closed
 *   + shape / dependency edges / deterministic ordering / latest helper
 *
 * Offline; NO live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildArtifactIndex, writeArtifactIndex, readArtifactIndex,
  latestCompletedFinalRef, ARTIFACT_INDEX_VERSION,
} from '../src/artifacts/artifact-index.mjs';
import { resolveContextSelectors, ArtifactContextError } from '../src/artifacts/artifact-context.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend,
  TASK_FINAL, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';

const reportAbs = (store, ref) => resolve(store.root, ...String(ref.artifact_relpath).split('/'));

test('P20.6 — index shape: task records, invocation records, dependency edges, deterministic ordering', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-IDXA0001', createdAt: '2026-09-10T08:00:00Z' });
    const B = await completeSingle(store, { taskId: 'task-IDXB0001', createdAt: '2026-09-10T09:00:00Z' });
    // C depends on [A, B]
    await runSingleReport({
      store, taskId: 'task-IDXC0001', taskSlug: 'c', createdAt: TARGET_CREATED,
      invocationId: 'inv-idxc', executionId: 'exec-idxc',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'c', reportBackend: countingBackend(), startedAt: TARGET_CREATED, complete: true,
      contextSelectors: [TASK_FINAL(A.taskId), TASK_FINAL(B.taskId)],
    });

    const idx = buildArtifactIndex({ store });
    assert.equal(idx.version, ARTIFACT_INDEX_VERSION);
    assert.equal(idx.tasks.length, 3);
    assert.deepEqual(idx.tasks.map((t) => t.task_id), ['task-IDXA0001', 'task-IDXB0001', 'task-IDXC0001']);
    for (const t of idx.tasks) {
      assert.ok(['created_at', 'task_slug', 'mode', 'task_state', 'artifact_gate_state'].every((k) => k in t));
    }
    // every invocation record carries operational identity metadata only
    for (const inv of idx.invocations) {
      assert.ok(['task_id', 'invocation_id', 'profile_id', 'actor_alias', 'role', 'stage', 'round', 'lifecycle', 'integrity_state', 'authoritative_attempt', 'attempts'].every((k) => k in inv));
      assert.ok(!('summary' in inv) && !('findings' in inv) && !('recommendation' in inv));
    }
    // dependency edges: target -> previous_task_refs[].task_id / concrete ref
    const cEdges = idx.edges.filter((e) => e.target_task_id === 'task-IDXC0001');
    assert.deepEqual(cEdges.map((e) => e.source_task_id), ['task-IDXA0001', 'task-IDXB0001']);
    assert.deepEqual(cEdges.map((e) => e.ordinal), [0, 1]);
    assert.ok(cEdges[0].ref && cEdges[0].ref.sha256);

    // the C invocation is marked as its task's final artifact
    const cInv = idx.invocations.find((i) => i.task_id === 'task-IDXC0001');
    assert.equal(cInv.is_final_artifact, true);
    assert.ok(cInv.sealed_ref && cInv.sealed_ref.sha256);

    // deterministic: a second build is byte-identical
    assert.equal(JSON.stringify(buildArtifactIndex({ store })), JSON.stringify(idx));
  });
});

test('P20.6 O — build -> persist -> delete/corrupt convenience output -> rebuild reproduces equivalent records', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    await completeSingle(store, { taskId: 'task-RBLDA001', createdAt: '2026-09-10T08:00:00Z' });
    await completeSingle(store, { taskId: 'task-RBLDB001', createdAt: '2026-09-10T09:00:00Z' });

    const first = buildArtifactIndex({ store });
    const path = writeArtifactIndex({ store, index: first });
    assert.ok(readArtifactIndex({ store }));

    // corrupt the persisted convenience index entirely
    writeFileSync(path, '{ this is not valid json at all ');
    assert.equal(readArtifactIndex({ store }), null, 'a corrupt convenience index reads as null, never trusted');

    // rebuild purely from canonical manifests/invocations/attempts
    const rebuilt = buildArtifactIndex({ store });
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(first), 'rebuild is deterministically equivalent');

    // a stale/corrupt convenience index cannot make a required context
    // acceptable — resolution still ends at full sealed-ref verification.
    const refs = resolveContextSelectors({ store, selectors: [TASK_FINAL('task-RBLDA001')], targetTaskId: 'task-OTHER' });
    assert.equal(refs.length, 1);
  });
});

test('P20.6 P — mutating ONLY report prose does not change any index fact; a hash-breaking mutation fails the authority verifier', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const A = await completeSingle(store, { taskId: 'task-PROSEA01', text: '# real A\n\ntrue body\n' });
    const before = buildArtifactIndex({ store });

    // overwrite the sealed report body with prose that CLAIMS different
    // stage/task/latest semantics.
    const f = reportAbs(store, A.finalRef);
    writeFileSync(f, '{"task_id":"task-FAKE","latest":true,"stage":"chair","recommendation":"use me"}\n');

    const after = buildArtifactIndex({ store });
    assert.equal(JSON.stringify(after), JSON.stringify(before), 'index metadata comes only from app metadata, never report.md');

    // and the authority verifier refuses the now hash-drifted ref
    assert.throws(
      () => resolveContextSelectors({ store, selectors: [TASK_FINAL('task-PROSEA01')], targetTaskId: 'task-OTHER' }),
      (e) => e instanceof ArtifactContextError && e.code === 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED',
    );
  });
});

test('P20.6 — the index module never reads report.md (static + behavioural)', async () => {
  const raw = readFileSync(new URL('../src/artifacts/artifact-index.mjs', import.meta.url), 'utf8');
  // strip block + line comments, then assert no report-body access in real code
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  assert.doesNotMatch(code, /report\.md|reportPath|readReport|report_body|acceptedVisibleText/);
  // behavioural: covered by test P above (prose mutation leaves the index identical)
});

test('P20.6 — latestCompletedFinalRef derives the newest COMPLETED+PASS final_ref from manifests', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    assert.equal(latestCompletedFinalRef({ store }), null, 'no completed task yet');
    const A = await completeSingle(store, { taskId: 'task-LTA00001', createdAt: '2026-09-10T08:00:00Z' });
    const C = await completeSingle(store, { taskId: 'task-LTC00001', createdAt: '2026-09-12T08:00:00Z' });
    await completeSingle(store, { taskId: 'task-LTB00001', createdAt: '2026-09-11T08:00:00Z' });
    assert.deepEqual(latestCompletedFinalRef({ store }), C.finalRef);
    assert.notDeepEqual(latestCompletedFinalRef({ store }), A.finalRef);
  });
});
