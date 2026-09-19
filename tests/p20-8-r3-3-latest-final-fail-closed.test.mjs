/**
 * P20.8 PRE-R3 — R3-3: LATEST_FINAL must fail closed when the newest task's
 * authority metadata is unreadable, never silently prefer an older task.
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §5.
 *
 *   R3-3A malformed newest manifest  — OLD valid completed + NEW newer task
 *         with invalid JSON manifest -> LATEST_FINAL FAILS, never returns OLD.
 *   R3-3B missing newest manifest    — newest canonical task folder exists on
 *         disk with NO task-manifest.json at all -> fail closed.
 *   R3-3C noncanonical junk          — a directory that is provably not a
 *         canonical task folder is never a blocker.
 *   R3-3D existing R6 cases          — malformed/missing/cross-task final_ref
 *         on an otherwise-readable newest completed manifest remain
 *         fail-closed (regression-covered by tests/p20-6r2-source-final-authority.test.mjs).
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { latestCompletedTaskId } from '../src/artifacts/artifact-index.mjs';
import { taskFolderName } from '../src/artifacts/artifact-paths.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import {
  withTempRoot, makeStore, completeSingle, countingBackend, LATEST_FINAL, TARGET_CREATED,
} from './fixtures/p20-6-context-helpers.mjs';

const OLD_CREATED = '2026-09-10T08:00:00Z';
const NEW_CREATED = '2026-09-10T09:00:00Z'; // strictly newer than OLD_CREATED

async function targetFailsClosed(store, { targetId, expectedCode }) {
  const backend = countingBackend();
  await assert.rejects(
    runSingleReport({
      store, taskId: targetId, taskSlug: 't', createdAt: TARGET_CREATED,
      invocationId: `inv-${targetId}`, executionId: `exec-${targetId}`,
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
      contextSelectors: [LATEST_FINAL()],
    }),
    (e) => (expectedCode ? e.code === expectedCode : true),
  );
  assert.equal(backend.calls, 0, '0 target provider calls');
  assert.equal(store.openTaskById(targetId), null, 'target task directory not created');
}

test('R3-3A: malformed newest manifest — LATEST_FINAL fails, never silently returns the OLD valid task', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { taskId: oldTaskId } = await completeSingle(store, { taskId: 'task-R33A-OLD', createdAt: OLD_CREATED });
    assert.equal(latestCompletedTaskId({ store }), oldTaskId, 'sanity: OLD resolves before the newer corrupt task exists');

    // A NEWER canonical task folder whose task-manifest.json is present but
    // unparseable JSON.
    const folder = taskFolderName({ taskId: 'task-R33A-NEW', createdAt: NEW_CREATED, taskSlug: 'new corrupt task' });
    const taskPath = join(store.tasksRoot, folder);
    mkdirSync(taskPath, { recursive: true });
    writeFileSync(join(taskPath, 'task-manifest.json'), '{ this is not valid JSON');

    assert.throws(
      () => latestCompletedTaskId({ store }),
      (e) => e.code === 'ARTIFACT_INDEX_LATEST_AMBIGUOUS',
    );
    await targetFailsClosed(store, { targetId: 'task-R33A-TGT', expectedCode: 'ARTIFACT_CONTEXT_LATEST_AMBIGUOUS' });
  });
});

test('R3-3B: missing newest manifest — a canonical task folder with no task-manifest.json fails closed', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { taskId: oldTaskId } = await completeSingle(store, { taskId: 'task-R33B-OLD', createdAt: OLD_CREATED });
    assert.equal(latestCompletedTaskId({ store }), oldTaskId);

    // A NEWER canonical task folder that exists on disk but has NO manifest
    // file at all (e.g. an interrupted/orphaned allocation).
    const folder = taskFolderName({ taskId: 'task-R33B-NEW', createdAt: NEW_CREATED, taskSlug: 'new missing manifest' });
    mkdirSync(join(store.tasksRoot, folder), { recursive: true });

    assert.throws(
      () => latestCompletedTaskId({ store }),
      (e) => e.code === 'ARTIFACT_INDEX_LATEST_AMBIGUOUS',
    );
    await targetFailsClosed(store, { targetId: 'task-R33B-TGT', expectedCode: 'ARTIFACT_CONTEXT_LATEST_AMBIGUOUS' });
  });
});

test('R3-3C: a noncanonical junk directory under tasks/ is never a false blocker', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const { taskId: oldTaskId } = await completeSingle(store, { taskId: 'task-R33C-OLD', createdAt: OLD_CREATED });

    // A directory that does NOT match the frozen task-folder naming
    // convention at all — provably not a canonical task folder. (No
    // manifest file: a corrupt-manifest directory here would instead trip
    // the UNRELATED, pre-existing `openTaskById(strictCorrupt:true)`
    // allocation guard — a different mechanism this test does not target.)
    mkdirSync(join(store.tasksRoot, 'not-a-task-folder-at-all'), { recursive: true });
    writeFileSync(join(store.tasksRoot, 'not-a-task-folder-at-all', 'peer.txt'), 'stray non-task directory');

    // Must resolve exactly as before — the junk directory never blocks discovery.
    assert.equal(latestCompletedTaskId({ store }), oldTaskId);

    const backend = countingBackend();
    const out = await runSingleReport({
      store, taskId: 'task-R33C-TGT', taskSlug: 't', createdAt: TARGET_CREATED,
      invocationId: 'inv-task-R33C-TGT', executionId: 'exec-task-R33C-TGT',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'x', reportBackend: backend, startedAt: TARGET_CREATED, complete: true,
      contextSelectors: [LATEST_FINAL()],
    });
    // The TARGET's own final_ref is its own (task-R33C-TGT); what proves
    // LATEST_FINAL actually resolved to the OLD task is the persisted
    // context binding it consumed.
    assert.equal(out.task.manifest.previous_task_refs[0]?.task_id, oldTaskId);
  });
});
