/**
 * P20.4R2 R12 — the task-manifest top-level Council identity
 * (`mode` / `chair_profile_id` / `participant_profile_ids`) MUST agree with the
 * persisted `council_control` whenever the control block is present.
 *
 * Enforced in ONE shared rule, at two points:
 *   - validateTaskManifest()  → every manifest READ (freshManifest) fails closed
 *   - bindCouncilControl()     → the idempotent (control-equal) return, and the
 *     first bind against a pre-bind skeleton, both fail closed on a conflicting
 *     top-level identity (a legitimately-absent field may still be back-filled).
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { buildCouncilArtifactControl } from '../src/pm/council/council-artifact-control.mjs';
import { validateTaskManifest } from '../src/artifacts/artifact-schema.mjs';
import { withTempRoot, makeStore, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';
import { withStores, buildRuntime, reopenRun } from './fixtures/p20-durable-council-harness.mjs';

const SPEC = () => normalizeCouncilSpec({ chair_profile_id: 'chair-x', participant_profile_ids: ['alpha', 'beta', 'gamma'], rounds: 1 });
const TASK = 'task-R12';
const readM = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeM = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);

/** A council task with `council_control` bound and a coherent top-level identity. */
function boundCouncilTask(dir) {
  const store = makeStore(dir);
  const spec = SPEC();
  const task = store.allocateTask({
    taskId: TASK, taskSlug: 'r12', createdAt: COUNCIL_CREATED_AT, mode: 'council',
    chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids],
  });
  task.bindCouncilControl({
    control: buildCouncilArtifactControl(spec),
    topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
  });
  return { store, spec, task };
}

// ---- validateTaskManifest (pure) ------------------------------------

test('R12 schema — a coherent bound manifest validates', () => {
  withTempRoot((dir) => {
    const { task } = boundCouncilTask(dir);
    const v = validateTaskManifest(readM(task.manifestPath));
    assert.equal(v.ok, true, v.errors.join('; '));
  });
});

for (const [label, mutate, needle] of [
  ['chair top-level mismatch', (m) => { m.chair_profile_id = 'someone-else'; }, /chair_profile_id/],
  ['participant set mismatch', (m) => { m.participant_profile_ids = ['alpha', 'beta', 'delta']; }, /participant_profile_ids/],
  ['participant order mismatch', (m) => { m.participant_profile_ids = ['gamma', 'beta', 'alpha']; }, /participant_profile_ids/],
  ['wrong mode', (m) => { m.mode = 'solo'; }, /mode/],
]) {
  test(`R12 schema — ${label} fails validateTaskManifest`, () => {
    withTempRoot((dir) => {
      const { task } = boundCouncilTask(dir);
      const m = readM(task.manifestPath);
      mutate(m);
      const v = validateTaskManifest(m);
      assert.equal(v.ok, false, `expected ${label} to be rejected`);
      assert.ok(v.errors.some((e) => needle.test(e)), `errors mention the drifted field: ${v.errors.join('; ')}`);
    });
  });

  test(`R12 read — ${label} fails closed on freshManifest()`, () => {
    withTempRoot((dir) => {
      const { store, task } = boundCouncilTask(dir);
      const m = readM(task.manifestPath);
      mutate(m);
      writeM(task.manifestPath, m);
      assert.throws(() => store.openTaskById(TASK).freshManifest(),
        (e) => e.name === 'ArtifactStoreError' && e.code === 'ARTIFACT_METADATA_INVALID');
    });
  });
}

// ---- bindCouncilControl ------------------------------------------------

test('R12 bind — idempotent (control-equal) return fails closed on a drifted top-level chair', () => {
  withTempRoot((dir) => {
    const { store, spec, task } = boundCouncilTask(dir);
    const m = readM(task.manifestPath);
    m.chair_profile_id = 'tampered-chair';
    writeM(task.manifestPath, m);
    assert.throws(
      () => store.openTaskById(TASK).bindCouncilControl({ control: buildCouncilArtifactControl(spec) }),
      (e) => e.name === 'ArtifactStoreError' && e.code === 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH',
      'a matching control must NOT be a silent idempotent success when the top-level identity has drifted',
    );
  });
});

test('R12 bind — idempotent return fails closed on a drifted participant order', () => {
  withTempRoot((dir) => {
    const { store, spec, task } = boundCouncilTask(dir);
    const m = readM(task.manifestPath);
    m.participant_profile_ids = [...m.participant_profile_ids].reverse();
    writeM(task.manifestPath, m);
    assert.throws(
      () => store.openTaskById(TASK).bindCouncilControl({ control: buildCouncilArtifactControl(spec) }),
      (e) => e.code === 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH',
    );
  });
});

test('R12 bind — first bind against a skeleton with a CONFLICTING top-level chair fails closed', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const spec = SPEC();
    // skeleton carries a wrong top-level chair, no control yet
    store.allocateTask({
      taskId: TASK, taskSlug: 'r12', createdAt: COUNCIL_CREATED_AT, mode: 'council',
      chairProfileId: 'not-the-real-chair', participantProfileIds: [...spec.participant_profile_ids],
    });
    assert.throws(
      () => store.openTaskById(TASK).bindCouncilControl({
        control: buildCouncilArtifactControl(spec),
        topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
      }),
      (e) => e.code === 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH',
    );
    assert.equal(readM(store.openTaskById(TASK).manifestPath).council_control ?? null, null, 'no control was written');
  });
});

test('R12 bind — first bind may back-fill a legitimately ABSENT top-level identity', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const spec = SPEC();
    store.allocateTask({ taskId: TASK, taskSlug: 'r12', createdAt: COUNCIL_CREATED_AT, mode: 'council' });
    const bound = store.openTaskById(TASK).bindCouncilControl({
      control: buildCouncilArtifactControl(spec),
      topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
    });
    assert.equal(bound.chair_profile_id, spec.chair_profile_id);
    assert.deepEqual(bound.participant_profile_ids, spec.participant_profile_ids);
    assert.equal(validateTaskManifest(bound).ok, true);
  });
});

// ---- durable machine: drift must fail BEFORE any provider call --------

test('R12 durable — a top-level chair drift on disk fails the run closed before any provider execution / recovery reuse', async () => {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
    const taskId = 'task-R12D';
    const pmRunId = 'r12d'.repeat(31) + 'DD';

    // A first pass bounded to maxTurns=1 binds council_control + a coherent
    // top-level identity during the chair_plan turn, then stops.
    const c0 = [];
    const r0 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c0, taskId, maxTurns: 1 });
    const first = await r0.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'failed'); // PmMaxTurnsExceeded
    assert.equal(c0.filter((x) => x.stage === 'chair-plan').length, 1);

    const mPath = newArtifactStore().openTaskById(taskId).manifestPath;
    const m = readM(mPath);
    assert.ok(m.council_control, 'council_control was bound on the first pass');
    m.chair_profile_id = 'a-different-chair'; // drift the top-level identity on disk
    writeM(mPath, m);

    reopenRun(sqlite, pmRunId);
    const c1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: c1, taskId, maxTurns: 24 });
    const res = await r1.resume(pmRunId);
    assert.equal(res.status, 'failed', 'the drifted top-level identity fails the run closed');
    assert.equal(c1.length, 0, 'zero provider execution/recovery reuse — the failure is at bindCouncilControl, before any stage call');
    const runRow = sqlite.get('SELECT error FROM pm_runs WHERE id=?', [pmRunId]);
    assert.match(String(runRow.error), /COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH/);
  });
});
