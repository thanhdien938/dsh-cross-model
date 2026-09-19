/**
 * P20.3R2 — task-manifest / recovery authority binding (R9–R13). Offline;
 * NO live model/API calls. Closes the four PM-audit task-manifest / recovery
 * binding gaps before P20.4 reuses the same primitives for many Chair/Member
 * stage references.
 *
 * Authority: docs/P20/P20_3R2_SONNET_REMEDIATION_MASTER_PROMPT.md §4–§8, §11.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import {
  resumeSingleTaskFromDisk,
  verifySealedArtifactReference,
  runTaskFinalArtifactGate,
} from '../src/artifacts/artifact-recovery.mjs';
import { INTEGRITY_STATE } from '../src/artifacts/artifact-integrity.mjs';
import { validateStageSealEntry } from '../src/artifacts/artifact-schema.mjs';
import { withTempRoot, makeStore, seedDelivered, reopenFromDisk, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const CONSUMER_FAIL = 'ARTIFACT_CONSUMER_VERIFY_FAILED';

const SINGLE = (store, over = {}) => ({
  store, taskId: over.taskId ?? 'task-R3R20001', taskSlug: 'p20.3r2', createdAt: '2026-09-10T10:00:00Z',
  invocationId: over.invocationId ?? 'inv-r3r2-1', executionId: over.executionId ?? 'exec-r3r2-1',
  profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
  instructions: 'go', reportBackend: over.reportBackend ?? fakeReportBackend({ text: '# report\n\nbody\n' }),
  startedAt: '2026-09-10T10:00:00Z', complete: over.complete ?? true, ...over,
});

async function sealOne(dir, over = {}) {
  const store = makeStore(dir);
  const out = await runSingleReport(SINGLE(store, over));
  const manifest = JSON.parse(readFileSync(out.task.manifestPath, 'utf8'));
  return { store, out, manifest, finalRef: manifest.final_ref, manifestPath: out.task.manifestPath };
}
const rewrite = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);

// ===================================================================
// R9 — RECOVERY BINDS TASK <-> INVOCATION BEFORE RECONSTRUCTING AUTHORITY
// ===================================================================

test('R9: recovery for Task A with Task B\'s invocation id / workspace FAILS CLOSED — A is never finalized from B', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    // Task A: delivered, NOT sealed, NOT finalized.
    await runSingleReport(SINGLE(store, { taskId: 'task-AAAA2222', invocationId: 'inv-a-2', executionId: 'exec-a-2', complete: false }));
    // Task B: sealed + completed.
    await runSingleReport(SINGLE(store, { taskId: 'task-BBBB2222', invocationId: 'inv-b-2', executionId: 'exec-b-2', complete: true }));

    const re = reopenFromDisk(dir, { taskId: 'task-AAAA2222' });
    const bTask = re.store.openTaskById('task-BBBB2222');
    const bInv = bTask.openInvocationById('inv-b-2');

    for (const call of [
      () => resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocationId: 'inv-b-2' }),
      () => resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocation: bInv }),
    ]) {
      assert.throws(call, (e) => [INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID].includes(e.code));
    }

    // Task A stays untouched.
    const am = JSON.parse(readFileSync(re.task.manifestPath, 'utf8'));
    assert.equal(am.final_ref, null);
    assert.equal(am.task_state, 'OPEN');
    assert.equal(am.stages.single ?? null, null);
  });
});

test('R9: recovery for an unfinished Task A with A\'s own delivered invocation is a no-op (NONE) — nothing fabricated', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir); // DELIVERED, not sealed
    const re = reopenFromDisk(dir, { taskId: s.expected.taskId });
    const r = resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocationId: s.expected.invocationId });
    assert.equal(r.action, 'NONE');
    assert.equal(r.finalRef, null);
    assert.equal(JSON.parse(readFileSync(re.task.manifestPath, 'utf8')).final_ref, null);
  });
});

test('R9: recovery binds the task manifest identity to the store before any authority work', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const re = reopenFromDisk(dir, { taskId: s.expected.taskId });
    // A manifest whose recorded store/project identity no longer matches the
    // store it is being resumed under must fail closed (defense-in-depth
    // beyond the store.json identity gate).
    const mp = re.task.manifestPath;
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.project_id = 'live1-somewhere-else';
    rewrite(mp, m);
    assert.throws(
      () => resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocationId: s.expected.invocationId }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH,
    );
  });
});

// ===================================================================
// R10 — SEALED REFERENCE BINDS sealed_at + FINALIZATION FACTS
// ===================================================================

test('R10: a forged reference.sealed_at (still a valid timestamp) fails the full consumer verifier', async () => {
  await withTempRoot(async (dir) => {
    const { store, finalRef } = await sealOne(dir);
    assert.equal(verifySealedArtifactReference({ store, reference: finalRef }).verified, true);
    assert.notEqual(finalRef.sealed_at, '2000-01-01T00:00:00.000Z');
    assert.throws(
      () => verifySealedArtifactReference({ store, reference: { ...finalRef, sealed_at: '2000-01-01T00:00:00.000Z' } }),
      (e) => e.code === CONSUMER_FAIL,
    );
  });
});

test('R10: the consumer verifier requires the authoritative attempt to retain finalized_at', async () => {
  await withTempRoot(async (dir) => {
    const { store, finalRef, out } = await sealOne(dir);
    const p = out.attempt.artifactJsonPath;
    const meta = JSON.parse(readFileSync(p, 'utf8'));
    delete meta.finalized_at;
    rewrite(p, meta);
    assert.throws(() => verifySealedArtifactReference({ store, reference: finalRef }), (e) => e.code === CONSUMER_FAIL);
  });
});

test('R10: the consumer verifier requires executive_log_finalized === true on the authoritative attempt', async () => {
  await withTempRoot(async (dir) => {
    const { store, finalRef, out } = await sealOne(dir);
    const p = out.attempt.artifactJsonPath;
    for (const bad of [false, undefined]) {
      const meta = JSON.parse(readFileSync(p, 'utf8'));
      if (bad === undefined) delete meta.executive_log_finalized; else meta.executive_log_finalized = bad;
      rewrite(p, meta);
      assert.throws(() => verifySealedArtifactReference({ store, reference: finalRef }), (e) => e.code === CONSUMER_FAIL, `bad=${bad}`);
    }
  });
});

// ===================================================================
// R11 — SHARED STAGE-ENTRY STRUCTURAL CONTRACT
// ===================================================================

test('R11: validateStageSealEntry — positive case (a real sealed stage entry validates)', async () => {
  await withTempRoot(async (dir) => {
    const { manifest } = await sealOne(dir);
    const entry = manifest.stages.single;
    const id = { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id };
    const v = validateStageSealEntry(entry, id);
    assert.equal(v.ok, true, v.errors.join('; '));
  });
});

test('R11: validateStageSealEntry — every listed negative case fails', async () => {
  await withTempRoot(async (dir) => {
    const { manifest } = await sealOne(dir);
    const good = manifest.stages.single;
    const id = { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id };
    const clone = () => JSON.parse(JSON.stringify(good));

    const negatives = {
      'invocation_id != sealed_ref.invocation_id': (e) => { e.invocation_id = 'inv-not-matching'; },
      'attempt_ordinal != sealed_ref.attempt_ordinal': (e) => { e.attempt_ordinal = good.attempt_ordinal + 1; },
      'integrity_state != ARTIFACT_PASS': (e) => { e.integrity_state = 'REPORT_EMPTY'; },
      'sealed_ref.task_id from another task': (e) => { e.sealed_ref = { ...e.sealed_ref, task_id: 'task-SOMEELSE' }; },
      'sealed_ref.store_id mismatch': (e) => { e.sealed_ref = { ...e.sealed_ref, store_id: 'store-evil' }; },
      'sealed_ref.project_id mismatch': (e) => { e.sealed_ref = { ...e.sealed_ref, project_id: 'proj-evil' }; },
      'unsafe invocation_relpath (traversal)': (e) => { e.invocation_relpath = '../../etc/passwd'; },
      'unsafe invocation_relpath (absolute)': (e) => { e.invocation_relpath = '/abs/path'; },
      'unsealed sealed_ref': (e) => { e.sealed_ref = { ...e.sealed_ref, sha256: null, bytes: null, sealed_at: null }; },
    };
    for (const [label, mutate] of Object.entries(negatives)) {
      const e = clone();
      mutate(e);
      assert.equal(validateStageSealEntry(e, id).ok, false, label);
    }
  });
});

test('R11: commitStageSeal refuses an internally inconsistent stage entry before writing task metadata', async () => {
  await withTempRoot(async (dir) => {
    const { out, manifest } = await sealOne(dir, { taskId: 'task-STAGE001', invocationId: 'inv-stg-1', executionId: 'exec-stg-1' });
    const good = manifest.stages.single;
    assert.throws(
      () => out.task.commitStageSeal({ stageKey: 'single-2', entry: { ...good, integrity_state: 'REPORT_EMPTY' } }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
    assert.throws(
      () => out.task.commitStageSeal({ stageKey: 'single-3', entry: { ...good, sealed_ref: { ...good.sealed_ref, task_id: 'task-OTHER' } } }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
    // unchanged: only the real 'single' stage exists
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(out.task.manifestPath, 'utf8')).stages), ['single']);
  });
});

// ===================================================================
// R12 — commitFinalRef DEFENDS ITS OWN TASK/STORE BOUNDARY
// ===================================================================

test('R12: Task A.commitFinalRef(Task B ref) is rejected — no cross-task final authority', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const a = await runSingleReport(SINGLE(store, { taskId: 'task-FRA00001', invocationId: 'inv-fra-1', executionId: 'exec-fra-1', complete: false }));
    const b = await runSingleReport(SINGLE(store, { taskId: 'task-FRB00001', invocationId: 'inv-frb-1', executionId: 'exec-frb-1', complete: true }));
    const bRef = JSON.parse(readFileSync(b.task.manifestPath, 'utf8')).final_ref;
    assert.throws(
      () => a.task.commitFinalRef({ finalRef: bRef, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: 'single' }),
      (e) => e.code === 'ARTIFACT_FINAL_REF_CROSS_TASK',
    );
    assert.equal(JSON.parse(readFileSync(a.task.manifestPath, 'utf8')).final_ref, null);
  });
});

test('R12: a COMPLETED commit whose final_ref differs from the selected sealed stage ref is rejected', async () => {
  await withTempRoot(async (dir) => {
    const { out, manifest, manifestPath } = await sealOne(dir, { taskId: 'task-FRC00001', invocationId: 'inv-frc-1', executionId: 'exec-frc-1' });
    // Reset to a pre-final-ref state that still has a valid sealed stage entry.
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const stageRef = m.stages.single.sealed_ref;
    m.final_ref = null;
    m.task_state = 'OPEN';
    m.artifact_gate_state = null;
    rewrite(manifestPath, m);

    const mutated = { ...stageRef, sha256: 'a'.repeat(64) }; // structurally sealed, but != the stage ref
    assert.throws(
      () => out.task.commitFinalRef({ finalRef: mutated, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: 'single' }),
      (e) => e.code === 'ARTIFACT_FINAL_REF_CONFLICT',
    );
    // the correct stage ref is accepted
    const done = out.task.commitFinalRef({ finalRef: stageRef, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: 'single' });
    assert.deepEqual(done.final_ref, stageRef);
    assert.ok(manifest); // referenced
  });
});

test('R12: a COMPLETED / TASK_ARTIFACT_PASS commit with no selected sealed stage entry is rejected', async () => {
  await withTempRoot(async (dir) => {
    const { out, manifestPath } = await sealOne(dir, { taskId: 'task-FRD00001', invocationId: 'inv-frd-1', executionId: 'exec-frd-1' });
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const ref = m.final_ref; // valid sealed ref for THIS task
    m.stages = {};
    m.final_ref = null;
    m.task_state = 'OPEN';
    m.artifact_gate_state = null;
    rewrite(manifestPath, m);
    assert.throws(
      () => out.task.commitFinalRef({ finalRef: ref, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: 'single' }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
  });
});

// ===================================================================
// R13 — ALREADY_COMPLETE VERIFIES TASK-LEVEL TOPOLOGY, NOT ONLY BYTES
// ===================================================================

test('R13: a consistent completed task resumes as ALREADY_COMPLETE', async () => {
  await withTempRoot(async (dir) => {
    const { store, manifestPath } = await sealOne(dir, { taskId: 'task-TOP00001', invocationId: 'inv-top-1', executionId: 'exec-top-1' });
    const re = reopenFromDisk(dir, { taskId: 'task-TOP00001' });
    const r = resumeSingleTaskFromDisk({ store: re.store, task: re.task });
    assert.equal(r.action, 'ALREADY_COMPLETE');
    assert.ok(r.finalRef && r.finalRef.sha256);
    assert.ok(store && manifestPath);
  });
});

test('R13: final_ref present but topology inconsistent -> fail closed, never ALREADY_COMPLETE', async () => {
  const mutations = {
    'missing stage entry': (m) => { delete m.stages.single; },
    'different stage sealed_ref': (m) => { m.stages.single.sealed_ref = { ...m.stages.single.sealed_ref, sha256: 'b'.repeat(64) }; },
    'task_state OPEN': (m) => { m.task_state = 'OPEN'; },
    'wrong artifact_gate_state': (m) => { m.artifact_gate_state = 'NOT_A_PASS'; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    // eslint-disable-next-line no-await-in-loop
    await withTempRoot(async (dir) => {
      const { manifestPath } = await sealOne(dir, { taskId: 'task-TOP00009', invocationId: 'inv-top-9', executionId: 'exec-top-9' });
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      mutate(m);
      rewrite(manifestPath, m);
      const re = reopenFromDisk(dir, { taskId: 'task-TOP00009' });
      assert.throws(
        () => resumeSingleTaskFromDisk({ store: re.store, task: re.task }),
        (e) => [INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED, 'ARTIFACT_CONSUMER_VERIFY_FAILED'].includes(e.code),
        label,
      );
    });
  }
});
