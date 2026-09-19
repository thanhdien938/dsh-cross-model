/**
 * P20.6 — SINGLE Context Chaining: selector / resolver / admission authority.
 *
 * Covers the test-matrix items that live at the context-authority boundary:
 *   C  missing required source            -> fail before target allocation
 *   D  source not complete / no final_ref -> fail before target allocation
 *   E  corrupt / hash-changed ref         -> fail at admission AND at consumption
 *   F  cross-project / cross-store        -> fail closed
 *   G  self-reference                     -> fail closed
 *   H  duplicate refs                     -> fail closed (NO silent dedupe)
 *   I  immutable target binding           -> ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH
 *   M  aggregate oversize                 -> fail closed, no truncate/summary
 *   TASK_FINAL / ARTIFACT_REF selectors resolve to concrete sealed refs
 *
 * Offline; NO live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import {
  resolveContextSelectors,
  admitArtifactContext,
  verifyPersistedContextRefs,
  validateContextSelector,
  ArtifactContextError,
} from '../src/artifacts/artifact-context.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend,
  REF, TASK_FINAL, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';

const reportAbs = (store, ref) => resolve(store.root, ...String(ref.artifact_relpath).split('/'));

async function runTarget(store, over = {}) {
  const backend = over.backend ?? countingBackend();
  const res = await runSingleReport({
    store,
    taskId: over.taskId ?? 'task-TARGET01',
    taskSlug: 'target', createdAt: TARGET_CREATED,
    invocationId: over.invocationId ?? 'inv-target-1',
    executionId: over.executionId ?? 'exec-target-1',
    profileId: 'live1-fake', backend: over.product ?? 'fake', actorAlias: 'fake',
    instructions: 'target task', reportBackend: backend,
    startedAt: TARGET_CREATED, complete: true,
    contextSelectors: over.contextSelectors,
    contextInputTransport: over.contextInputTransport,
    contextLimits: over.contextLimits,
  });
  return { res, backend };
}

// ---- selector structural validation -----------------------------------

test('P20.6 — validateContextSelector accepts the three internal forms and rejects paths / unknown kinds', () => {
  assert.equal(validateContextSelector({ kind: 'TASK_FINAL', task_id: 't' }).ok, true);
  assert.equal(validateContextSelector({ kind: 'LATEST_FINAL' }).ok, true);
  assert.equal(validateContextSelector({ kind: 'NOPE' }).ok, false);
  assert.equal(validateContextSelector({ kind: 'TASK_FINAL', task_id: '' }).ok, false);
  assert.equal(validateContextSelector({ kind: 'TASK_FINAL', task_id: 't', path: '/etc/passwd' }).ok, false);
  assert.equal(validateContextSelector({ kind: 'ARTIFACT_REF', reference: { not: 'a ref' } }).ok, false);
});

// ---- happy path: both selectors resolve to the concrete sealed final_ref

test('P20.6 — TASK_FINAL and ARTIFACT_REF selectors both resolve to the same concrete sealed final_ref', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef, taskId } = await completeSingle(store, { taskId: 'task-PRIORAA1' });

    const viaTaskFinal = resolveContextSelectors({ store, selectors: [TASK_FINAL(taskId)], targetTaskId: 'task-TARGET01' });
    const viaRef = resolveContextSelectors({ store, selectors: [REF(finalRef)], targetTaskId: 'task-TARGET01' });
    assert.deepEqual(viaTaskFinal[0], finalRef);
    assert.deepEqual(viaRef[0], finalRef);

    // admission with the offline fake consumer route succeeds
    const { prepared } = admitArtifactContext({ store, refs: viaRef, consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' });
    assert.equal(prepared.entries.length, 1);
    assert.equal(prepared.entries[0].transport, 'VERBATIM_CONTENT');
  });
});

// ---- C. missing required source -------------------------------------

test('P20.6 C — TASK_FINAL for a nonexistent source: fail before target allocation, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = countingBackend();
    await assert.rejects(
      runTarget(store, { backend, contextSelectors: [TASK_FINAL('task-DOES-NOT-EXIST')] }),
      (e) => e.code === 'ARTIFACT_CONTEXT_TASK_NOT_FOUND',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-TARGET01'), null, 'target task directory not created');
  });
});

// ---- D. source not complete ---------------------------------------

test('P20.6 D — TASK_FINAL for an OPEN (not gate-passed) source: fail before target allocation, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    // DELIVERED-only (no complete:true) => task stays OPEN, no final_ref.
    await runSingleReport({
      store, taskId: 'task-OPEN0001', taskSlug: 'open', createdAt: '2026-09-10T10:00:00Z',
      invocationId: 'inv-open-1', executionId: 'exec-open-1',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'x', reportBackend: countingBackend(), startedAt: '2026-09-10T10:00:00Z',
    });
    const backend = countingBackend();
    await assert.rejects(
      runTarget(store, { backend, contextSelectors: [TASK_FINAL('task-OPEN0001')] }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-TARGET01'), null);
  });
});

// ---- E. corrupt / hash-changed ref -------------------------------

test('P20.6 E — a prior report byte-drifted BEFORE admission: fail before target allocation, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef } = await completeSingle(store, { taskId: 'task-PRIORDR1' });
    const f = reportAbs(store, finalRef);
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n<post-hoc tampering>\n`);
    const backend = countingBackend();
    await assert.rejects(
      runTarget(store, { backend, contextSelectors: [REF(finalRef)] }),
      (e) => e.code === 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-TARGET01'), null);
  });
});

test('P20.6 E — a prior report byte-drifted AFTER admission but before consumption: Boundary B fails, 0 target provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef } = await completeSingle(store, { taskId: 'task-PRIORDR2' });

    // Boundary A: resolve + admit succeed, then the target task is allocated
    // with the persisted concrete ref.
    const refs = resolveContextSelectors({ store, selectors: [REF(finalRef)], targetTaskId: 'task-TGTB0001' });
    admitArtifactContext({ store, refs, consumerBackend: 'fake', requestedInputTransport: 'VERBATIM_CONTENT' });
    const task = store.allocateTask({ taskId: 'task-TGTB0001', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: refs });
    assert.equal(task.freshManifest().previous_task_refs.length, 1);

    // now drift the sealed prior report on disk
    const f = reportAbs(store, finalRef);
    writeFileSync(f, `${readFileSync(f, 'utf8')}DRIFT`);

    // Boundary B (fresh persisted manifest, full re-verify) must fail closed.
    assert.throws(
      () => verifyPersistedContextRefs({ store, targetTaskId: 'task-TGTB0001', refs: task.freshManifest().previous_task_refs }),
      (e) => e instanceof ArtifactContextError && e.code === 'ARTIFACT_CONTEXT_REF_VERIFY_FAILED',
    );
  });
});

// ---- F. cross-store / cross-project ------------------------------

test('P20.6 F — a concrete ref from another store or project fails closed, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef } = await completeSingle(store, { taskId: 'task-PRIORXP1' });
    for (const [over, code] of [
      [{ store_id: 'other-store' }, 'ARTIFACT_CONTEXT_CROSS_STORE'],
      [{ project_id: 'other-project' }, 'ARTIFACT_CONTEXT_CROSS_PROJECT'],
    ]) {
      const backend = countingBackend();
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        runTarget(store, { backend, contextSelectors: [REF({ ...finalRef, ...over })] }),
        (e) => e.code === code,
      );
      assert.equal(backend.calls, 0);
    }
    assert.equal(store.openTaskById('task-TARGET01'), null);
  });
});

// ---- G. self-reference ------------------------------------------

test('P20.6 G — a target task selecting a ref whose task_id is the target fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef } = await completeSingle(store, { taskId: 'task-PRIORSR1' });
    const selfRef = { ...finalRef, task_id: 'task-TARGET01' };
    assert.throws(
      () => resolveContextSelectors({ store, selectors: [REF(selfRef)], targetTaskId: 'task-TARGET01' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SELF_REFERENCE',
    );
    assert.throws(
      () => resolveContextSelectors({ store, selectors: [TASK_FINAL('task-TARGET01')], targetTaskId: 'task-TARGET01' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_SELF_REFERENCE',
    );
  });
});

// ---- H. duplicate refs ----------------------------------------

test('P20.6 H — the same concrete sealed ref twice fails closed and is NOT silently deduplicated', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef, taskId } = await completeSingle(store, { taskId: 'task-PRIORDUP' });
    assert.throws(
      () => resolveContextSelectors({ store, selectors: [REF(finalRef), REF(finalRef)], targetTaskId: 'task-TARGET01' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_DUPLICATE_REF',
    );
    // TASK_FINAL + the same concrete ARTIFACT_REF also collide
    assert.throws(
      () => resolveContextSelectors({ store, selectors: [TASK_FINAL(taskId), REF(finalRef)], targetTaskId: 'task-TARGET01' }),
      (e) => e.code === 'ARTIFACT_CONTEXT_DUPLICATE_REF',
    );
  });
});

// ---- I. immutable target binding -----------------------------

test('P20.6 I — reopening the target with different / reordered refs -> ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH; same exact refs -> idempotent', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const a = await completeSingle(store, { taskId: 'task-PRIOR-IA' });
    const b = await completeSingle(store, { taskId: 'task-PRIOR-IB' });

    const t1 = store.allocateTask({ taskId: 'task-BINDING1', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: [a.finalRef, b.finalRef] });
    const persisted = t1.freshManifest().previous_task_refs;
    assert.equal(persisted.length, 2);

    // same exact ordered refs -> idempotent reopen
    const t1b = store.allocateTask({ taskId: 'task-BINDING1', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: [a.finalRef, b.finalRef] });
    assert.deepEqual(t1b.freshManifest().previous_task_refs, persisted);

    // reordered -> mismatch
    assert.throws(
      () => store.allocateTask({ taskId: 'task-BINDING1', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: [b.finalRef, a.finalRef] }),
      (e) => e.code === 'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
    );
    // dropped -> mismatch
    assert.throws(
      () => store.allocateTask({ taskId: 'task-BINDING1', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: [a.finalRef] }),
      (e) => e.code === 'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
    );
    // manifest is unchanged after the rejected reopens
    assert.deepEqual(store.openTaskById('task-BINDING1').manifest.previous_task_refs, persisted);

    // a caller that never supplies previousTaskRefs still reopens unchanged
    const t1c = store.allocateTask({ taskId: 'task-BINDING1', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single' });
    assert.deepEqual(t1c.manifest.previous_task_refs, persisted);
  });
});

test('P20.6 I — first-binding historical context onto an already-existing no-context task fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const a = await completeSingle(store, { taskId: 'task-PRIOR-IC' });
    store.allocateTask({ taskId: 'task-NOCTX01', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single' });
    assert.throws(
      () => store.allocateTask({ taskId: 'task-NOCTX01', taskSlug: 't', createdAt: TARGET_CREATED, mode: 'single', previousTaskRefs: [a.finalRef] }),
      (e) => e.code === 'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
    );
  });
});

// ---- M. aggregate oversize ----------------------------------

test('P20.6 M — selected content exceeds the configured aggregate policy: fail closed, no truncate/summary, 0 provider calls', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { finalRef } = await completeSingle(store, { taskId: 'task-PRIORBIG', text: 'x'.repeat(4096) });
    const backend = countingBackend();
    await assert.rejects(
      runTarget(store, { backend, contextSelectors: [REF(finalRef)], contextLimits: { maxTotalInputBytes: 64 } }),
      (e) => e.code === 'ARTIFACT_CONTEXT_OVERSIZE',
    );
    assert.equal(backend.calls, 0);
    assert.equal(store.openTaskById('task-TARGET01'), null);
  });
});
