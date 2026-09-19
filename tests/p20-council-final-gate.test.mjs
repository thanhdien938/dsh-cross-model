/**
 * P20.4 §29 — the Council Final Artifact Gate: it reuses the P20.3 full
 * sealed-reference verifier, rejects cross-task / mismatched / fabricated
 * stage refs, requires chair-plan + >=1 report + synthesis sealed, and
 * commits `final_ref = chair-council-synthesis sealed_ref` under the
 * expected final stage key. No live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  runCouncilArtifactStage,
  runCouncilFinalArtifactGate,
  CouncilArtifactOrchestrationError,
} from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { buildCouncilArtifactControl } from '../src/pm/council/council-artifact-control.mjs';
import { councilStageKeyPlan } from '../src/pm/council/council-artifact-stage-keys.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

const TASK = 'task-FGATE01';
const rewrite = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);

// Seal all four stages of a 2-participant / 1-round council manually so the
// final gate can be driven directly with tampered inputs.
async function sealAllStages(dir, over = {}) {
  const store = makeStore(dir);
  const spec = council({ rounds: 1 });
  const reg = aliasRegistryFor(spec);
  const backends = over.backends ?? councilBackends();
  const task = store.allocateTask({
    taskId: TASK, taskSlug: 'fg', createdAt: COUNCIL_CREATED_AT, mode: 'council',
    chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids],
  });
  // P20.4R3 R17 — the final gate requires a bound council_control.
  task.bindCouncilControl({
    control: buildCouncilArtifactControl(spec),
    topLevel: { chairProfileId: spec.chair_profile_id, participantProfileIds: [...spec.participant_profile_ids] },
  });
  const common = { store, task, taskId: TASK, createdAt: COUNCIL_CREATED_AT, consumerInputTransport: 'VERBATIM_CONTENT' };

  const chair = await runCouncilArtifactStage({
    ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN,
    profileId: 'live1-chair', actorAlias: reg.get('live1-chair'), backend: 'fake',
    reportBackend: backends('live1-chair'), instructions: 'plan',
  });
  const reports = new Map();
  for (const id of spec.participant_profile_ids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
      profileId: id, actorAlias: reg.get(id), backend: 'fake',
      reportBackend: backends(id), instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref }],
    });
    reports.set(id, r);
  }
  const synth = await runCouncilArtifactStage({
    ...common, artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
    profileId: 'live1-chair', actorAlias: reg.get('live1-chair'), backend: 'fake',
    reportBackend: backends('live1-chair'), instructions: 'synth',
    inputReferences: [
      { label: 'chair', reference: chair.sealed_ref },
      ...spec.participant_profile_ids.map((id) => ({ label: id, reference: reports.get(id).sealed_ref })),
    ],
  });
  const stageKeyPlan = councilStageKeyPlan({ rounds: 1, participantAliases: spec.participant_profile_ids.map((id) => reg.get(id)) });
  return { store, task, spec, chair, reports, synth, stageKeyPlan };
}

const gateArgs = (x) => ({
  store: x.store, task: x.task,
  chairPlanOutcome: x.chair, reportOutcomes: x.reports, critiqueOutcomes: new Map(),
  synthesisOutcome: x.synth, council: x.spec, stageKeyPlan: x.stageKeyPlan,
  participants: x.spec.participant_profile_ids,
});

test('§29: the happy path commits final_ref = synthesis sealed_ref under the chair-council-synthesis key', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const finalRef = runCouncilFinalArtifactGate(gateArgs(x));
    assert.deepEqual(finalRef, x.synth.sealed_ref);
    const m = x.task.freshManifest();
    assert.equal(m.task_state, 'COMPLETED');
    assert.equal(m.artifact_gate_state, 'TASK_ARTIFACT_PASS');
    assert.deepEqual(m.final_ref, x.synth.sealed_ref);
    // idempotent
    assert.deepEqual(runCouncilFinalArtifactGate(gateArgs(x)), x.synth.sealed_ref);
  });
});

test('§29: a synthesis step outcome whose sealed_ref differs from the manifest stage entry is rejected', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const tampered = { ...x, synth: { ...x.synth, sealed_ref: { ...x.synth.sealed_ref, sha256: 'b'.repeat(64) } } };
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(tampered)),
      (e) => e instanceof CouncilArtifactOrchestrationError && e.code === 'COUNCIL_ARTIFACT_FINAL_GATE_REF_MISMATCH');
    assert.equal(x.task.freshManifest().final_ref, null);
  });
});

test('§29: a cross-task sealed_ref in a stage entry fails the reused P20.3 verifier / manifest schema', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const m = JSON.parse(readFileSync(x.task.manifestPath, 'utf8'));
    m.stages['chair-council-synthesis'].sealed_ref = { ...m.stages['chair-council-synthesis'].sealed_ref, task_id: 'task-OTHERXX' };
    rewrite(x.task.manifestPath, m);
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      // freshManifest() now rejects the internally inconsistent stage entry (R11),
      // a strictly stronger fail-closed than the gate's own checks.
      (e) => /COUNCIL_ARTIFACT_FINAL_GATE|ARTIFACT_METADATA_INVALID/.test(e.code) || e.name === 'ArtifactStoreError');
  });
});

test('§29: a failed report step with a fabricated manifest stage entry is rejected', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    // mark beta's report as failed in the outcome map, but leave its (real) stage entry present
    const betaId = x.spec.participant_profile_ids[1];
    x.reports.set(betaId, { ...x.reports.get(betaId), ok: false, sealed_ref: null, execution_state: 'EXECUTION_FAILED', failure_code: 'X' });
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      (e) => e.code === 'COUNCIL_ARTIFACT_FINAL_GATE_FABRICATED_REF');
  });
});

test('§29: a post-seal reparse / hash drift of a stage report fails the reused full verifier', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    const { resolveAndVerifySealedReference } = await import('../src/artifacts/artifact-recovery.mjs');
    const v = resolveAndVerifySealedReference({ store: x.store, reference: x.chair.sealed_ref });
    writeFileSync(v.path, `${readFileSync(v.path, 'utf8')} drift`);
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED' || /FINAL_GATE/.test(e.code));
  });
});

test('§29: no successful sealed participant report -> gate refuses (does not require every participant)', async () => {
  await withTempRoot(async (dir) => {
    const x = await sealAllStages(dir);
    for (const id of x.spec.participant_profile_ids) {
      x.reports.set(id, { ...x.reports.get(id), ok: false, sealed_ref: null, execution_state: 'EXECUTION_FAILED', failure_code: 'X' });
      const m = JSON.parse(readFileSync(x.task.manifestPath, 'utf8'));
      delete m.stages['participant-report::' + aliasRegistryFor(x.spec).get(id)];
      rewrite(x.task.manifestPath, m);
    }
    assert.throws(() => runCouncilFinalArtifactGate(gateArgs(x)),
      (e) => e.code === 'COUNCIL_ARTIFACT_FINAL_GATE_NO_REPORT');
  });
});
