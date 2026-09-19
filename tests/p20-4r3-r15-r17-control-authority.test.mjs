/**
 * P20.4R3 R15/R16/R17 — persisted Council-control authority.
 *
 * R15  council_control is REQUIRED once artifact Council progress exists
 *      (manifest stage entries / final_ref / progressed task state, OR an
 *      on-disk Council invocation directory). A missing control after progress
 *      fails closed (COUNCIL_ARTIFACT_CONTROL_MISSING_AFTER_PROGRESS) — never a
 *      silent "first bind" that could re-authorize under changed
 *      rounds/strategy/implementation-participant/workspace/debate.
 * R16  a bound manifest MUST carry the FULL top-level Council identity, PRESENT
 *      and equal (mode / chair_profile_id / participant_profile_ids) — a
 *      missing field is drift, not "no drift".
 * R17  runCouncilFinalArtifactGate() REQUIRES council_control and a COMPLETE
 *      normalized-control match (chair, participants+order, rounds, strategy,
 *      implementation participant, workspace requirement + evidence paths,
 *      debate.enabled, debate.max_rounds) via the shared builder/comparator.
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { buildCouncilArtifactControl } from '../src/pm/council/council-artifact-control.mjs';
import { validateTaskManifest } from '../src/artifacts/artifact-schema.mjs';
import {
  runCouncilArtifactStage,
  runCouncilFinalArtifactGate,
  CouncilArtifactOrchestrationError,
} from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { councilStageKeyPlan } from '../src/pm/council/council-artifact-stage-keys.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

const readM = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeM = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);

function boundCouncilTask(dir, taskId, specOver = {}) {
  const store = makeStore(dir);
  const spec = council({ rounds: 1, ...specOver });
  const task = store.allocateTask({
    taskId, taskSlug: 'r3', createdAt: COUNCIL_CREATED_AT, mode: 'council',
    chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids],
  });
  task.bindCouncilControl({
    control: buildCouncilArtifactControl(spec),
    topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
  });
  return { store, spec, task };
}

async function sealChairPlan(store, task, spec) {
  return runCouncilArtifactStage({
    store, task, taskId: task.taskId, createdAt: COUNCIL_CREATED_AT, consumerInputTransport: 'VERBATIM_CONTENT',
    artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: spec.chair_profile_id,
    actorAlias: aliasRegistryFor(spec).get(spec.chair_profile_id), backend: 'fake',
    reportBackend: councilBackends()(spec.chair_profile_id), instructions: 'plan',
  });
}

// ============================ R15 ============================

test('R15 — a pristine skeleton with no council_control still allows a first bind', () => {
  withTempRoot((dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    store.allocateTask({ taskId: 'task-R15FRESH', taskSlug: 'r3', createdAt: COUNCIL_CREATED_AT, mode: 'council' });
    const bound = store.openTaskById('task-R15FRESH').bindCouncilControl({
      control: buildCouncilArtifactControl(spec),
      topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
    });
    assert.ok(bound.council_control);
    assert.equal(validateTaskManifest(bound).ok, true);
  });
});

test('R15 — manifest stage progress + council_control removed → freshManifest() and re-bind fail closed', async () => {
  await withTempRoot(async (dir) => {
    const { store, spec, task } = boundCouncilTask(dir, 'task-R15PROG');
    const cp = await sealChairPlan(store, task, spec);
    assert.equal(cp.ok, true);

    const m = readM(task.manifestPath);
    assert.ok(Object.keys(m.stages).length >= 1);
    delete m.council_control;
    writeM(task.manifestPath, m);

    // schema: manifest-visible progress + council_control gone
    const v = validateTaskManifest(readM(task.manifestPath));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /council_control is required once artifact Council progress exists/.test(e)));
    assert.throws(() => store.openTaskById('task-R15PROG').freshManifest(),
      (e) => e.name === 'ArtifactStoreError' && e.code === 'ARTIFACT_METADATA_INVALID');

    // store: a re-bind after progress is refused (never a silent first bind)
    assert.throws(
      () => store.openTaskById('task-R15PROG').bindCouncilControl({ control: buildCouncilArtifactControl(spec) }),
      (e) => e.code === 'COUNCIL_ARTIFACT_CONTROL_MISSING_AFTER_PROGRESS',
    );
  });
});

test('R15 — invocation-directory progress only (no manifest stage) + council_control removed → re-bind fails closed', async () => {
  await withTempRoot(async (dir) => {
    const { store, spec, task } = boundCouncilTask(dir, 'task-R15INV');
    await sealChairPlan(store, task, spec);

    // strip BOTH council_control AND the manifest stage entry: nothing visible
    // in the manifest, but the chair-plan invocation directory is still on disk.
    const m = readM(task.manifestPath);
    delete m.council_control;
    m.stages = {};
    writeM(task.manifestPath, m);

    // schema alone no longer objects (no manifest-visible progress) ...
    assert.equal(validateTaskManifest(readM(task.manifestPath)).ok, true);
    // ... but bindCouncilControl scans the task tree and refuses.
    assert.throws(
      () => store.openTaskById('task-R15INV').bindCouncilControl({
        control: buildCouncilArtifactControl(spec),
        topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
      }),
      (e) => e.code === 'COUNCIL_ARTIFACT_CONTROL_MISSING_AFTER_PROGRESS',
    );
  });
});

// ============================ R16 ============================

for (const [label, mutate] of [
  ['delete mode', (m) => { delete m.mode; }],
  ['null chair_profile_id', (m) => { m.chair_profile_id = null; }],
  ['delete chair_profile_id', (m) => { delete m.chair_profile_id; }],
  ['participant_profile_ids = []', (m) => { m.participant_profile_ids = []; }],
  ['delete participant_profile_ids', (m) => { delete m.participant_profile_ids; }],
]) {
  test(`R16 — bound manifest with ${label} → freshManifest() and idempotent re-bind fail closed`, () => {
    withTempRoot((dir) => {
      const { store, spec, task } = boundCouncilTask(dir, 'task-R16');
      const m = readM(task.manifestPath);
      mutate(m);
      writeM(task.manifestPath, m);

      assert.throws(() => store.openTaskById('task-R16').freshManifest(),
        (e) => e.name === 'ArtifactStoreError' && e.code === 'ARTIFACT_METADATA_INVALID');
      assert.throws(
        () => store.openTaskById('task-R16').bindCouncilControl({ control: buildCouncilArtifactControl(spec) }),
        (e) => e.code === 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH',
      );
    });
  });
}

// ============================ R17 ============================

async function sealAllStages(dir, taskId, specOver = {}) {
  const { store, spec, task } = boundCouncilTask(dir, taskId, specOver);
  const reg = aliasRegistryFor(spec);
  const be = councilBackends();
  const common = { store, task, taskId, createdAt: COUNCIL_CREATED_AT, consumerInputTransport: 'VERBATIM_CONTENT' };
  const chair = await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: spec.chair_profile_id, actorAlias: reg.get(spec.chair_profile_id), backend: 'fake', reportBackend: be(spec.chair_profile_id), instructions: 'plan' });
  const reports = new Map();
  for (const id of spec.participant_profile_ids) {
    // eslint-disable-next-line no-await-in-loop
    reports.set(id, await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: id, actorAlias: reg.get(id), backend: 'fake', reportBackend: be(id), instructions: 'report', inputReferences: [{ label: 'chair', reference: chair.sealed_ref }] }));
  }
  const synth = await runCouncilArtifactStage({ ...common, artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS, profileId: spec.chair_profile_id, actorAlias: reg.get(spec.chair_profile_id), backend: 'fake', reportBackend: be(spec.chair_profile_id), instructions: 'synth', inputReferences: [{ label: 'chair', reference: chair.sealed_ref }, ...spec.participant_profile_ids.map((id) => ({ label: id, reference: reports.get(id).sealed_ref }))] });
  const stageKeyPlan = councilStageKeyPlan({ rounds: 1, participantAliases: spec.participant_profile_ids.map((id) => reg.get(id)) });
  return { store, spec, task, chair, reports, synth, stageKeyPlan, reg };
}

const gateArgs = (x, councilOverride) => ({
  store: x.store, task: x.task,
  chairPlanOutcome: x.chair, reportOutcomes: x.reports, critiqueOutcomes: new Map(),
  synthesisOutcome: x.synth, council: councilOverride ?? x.spec, stageKeyPlan: x.stageKeyPlan,
  participants: x.spec.participant_profile_ids, aliasRegistry: x.reg,
});

test('R17 — happy path: full control match commits final_ref', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir, 'task-R17OK');
    const finalRef = runCouncilFinalArtifactGate(gateArgs(x));
    assert.deepEqual(finalRef, x.synth.sealed_ref);
  });
});

test('R17 — missing council_control → gate fails closed, no final_ref', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir, 'task-R17MISS');
    const m = readM(x.task.manifestPath);
    delete m.council_control;
    writeM(x.task.manifestPath, m);
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      (e) => /ARTIFACT_METADATA_INVALID|COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_(REQUIRED|MISMATCH)/.test(e.code));
    assert.equal(readM(x.task.manifestPath).final_ref, null, 'no final_ref committed');
  });
});

for (const [label, councilOverride] of [
  ['rounds mismatch', () => council({ rounds: 2 })],
  ['implementation participant mismatch', () => council({ rounds: 1, implementation_participant_id: 'live1-beta' })],
  ['workspace requirement mismatch', () => council({ rounds: 1, workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'] })],
  ['debate setting mismatch', () => council({ rounds: 1, debate: { max_rounds: 1 } })],
]) {
  test(`R17 — ${label} → COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_MISMATCH, no final_ref mutation`, async () => {
    await withTempRoot(async (dir) => {
      const x = await sealAllStages(dir, 'task-R17MM');
      const other = councilOverride();
      assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x, other)),
        (e) => e instanceof CouncilArtifactOrchestrationError && e.code === 'COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_MISMATCH');
      assert.equal(readM(x.task.manifestPath).final_ref, null, 'no final_ref committed');
    });
  });
}

test('R17 — persisted council_control.strategy tampered → gate fails closed, no final_ref', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir, 'task-R17STRAT');
    const m = readM(x.task.manifestPath);
    m.council_control = { ...m.council_control, strategy: 'some_other_strategy' };
    writeM(x.task.manifestPath, m);
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      (e) => /ARTIFACT_METADATA_INVALID|COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_(REQUIRED|MISMATCH)/.test(e.code));
    assert.equal(readM(x.task.manifestPath).final_ref, null, 'no final_ref committed');
  });
});
