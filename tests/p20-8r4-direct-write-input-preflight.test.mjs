/**
 * P20.8R4 — DIRECT_WRITE input preflight route fix.
 *
 * Authority: docs/P20/P20_8R4_DIRECT_WRITE_INPUT_PREFLIGHT_ROUTE_FIX_MASTER_PROMPT.md
 *
 * Root cause reproduced here: `prepareArtifactInputs()` used to hard-code
 * `requestedDelivery: 'VERBATIM_MATERIALIZATION'` when checking whether a
 * consumer may accept a sealed artifact input — even when that consumer's
 * REAL production report delivery is DIRECT_WRITE (P20.8R2+). A capability
 * policy that proves DIRECT_WRITE but not VERBATIM_MATERIALIZATION (exactly
 * what a real, narrowly-proven production policy looks like) then made
 * input preflight fail closed with an unproven-route error BEFORE the
 * report backend was ever called — the live owner failure this fixes.
 *
 * The default `fake` product's DEFAULT_BACKEND_REPORT_POLICY entry proves
 * BOTH mechanisms, which is exactly why the pre-existing test suite never
 * caught this — every test below therefore uses a custom, narrower policy
 * that proves only ONE mechanism at a time, on purpose.
 *
 * Offline only. No live provider calls — every report backend below is a
 * deterministic in-process fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { buildReportBackendResult, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';
import { runCouncilArtifactStage } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';
import { completeSingle, countingBackend, fakeReportBackend, TASK_FINAL } from './fixtures/p20-6-context-helpers.mjs';

const CREATED = '2026-09-12T00:00:00Z';

/**
 * A policy where 'fake' proves EXACTLY the two mechanisms named, and
 * nothing else — the real-world shape a narrowly-proven production policy
 * has (e.g. DIRECT_WRITE proven, VERBATIM_MATERIALIZATION never proven for
 * a CLI backend). `state` defaults to UNSUPPORTED for the mechanism NOT
 * named PROVEN, matching how a real capability record looks before that
 * fact is ever proven.
 */
function policyProving({ delivery, notDeliveryState = CAPABILITY_STATE.UNSUPPORTED, input = 'VERBATIM_CONTENT', notInputState = CAPABILITY_STATE.UNSUPPORTED } = {}) {
  const otherDelivery = delivery === 'DIRECT_WRITE' ? 'VERBATIM_MATERIALIZATION' : 'DIRECT_WRITE';
  const otherInput = input === 'VERBATIM_CONTENT' ? 'NATIVE_ASSIGNED_READ' : 'VERBATIM_CONTENT';
  return {
    enforcement_version: 'test-p20-8r4-1',
    backends: {
      fake: {
        report_delivery: { [delivery]: CAPABILITY_STATE.PROVEN, [otherDelivery]: notDeliveryState },
        artifact_input: { [input]: CAPABILITY_STATE.PROVEN, [otherInput]: notInputState },
      },
    },
  };
}

/**
 * A counting DIRECT_WRITE fake backend that actually writes the assigned
 * path itself (a side effect, exactly like the model's own Write tool use
 * — mirrors tests/p20-8r2-direct-write.test.mjs's fakeDirectWriteBackend())
 * and reuses the SAME shared production `directWriter`
 * (PROVIDER_DIRECT_WRITE_CONFIRMER) real DIRECT_WRITE delivery uses.
 */
function directWriteBackend({ terminalState = TERMINAL_STATE.SUCCESS, text = 'DIRECT_WRITE report body\n' } = {}) {
  let calls = 0;
  let lastPrompt = null;
  return {
    backend: 'fake',
    deliveryMechanism: 'DIRECT_WRITE',
    directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
    get calls() { return calls; },
    get lastPrompt() { return lastPrompt; },
    async runReport({ prompt, request }) {
      calls += 1;
      lastPrompt = prompt ?? null;
      const assignedPath = request.attempt.reportPath;
      mkdirSync(dirname(assignedPath), { recursive: true });
      writeFileSync(assignedPath, text);
      return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState, safeDiagnostics: { direct_write: true } });
    },
  };
}

// ---- 1/2/3 — DIRECT_WRITE + VERBATIM_CONTENT both PROVEN: the participant reaches the backend and seals ----

test('§4.1-3 — a DIRECT_WRITE+VERBATIM_CONTENT participant with a sealed chair input reaches the report backend (call count 1) and seals successfully', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r4-ok', taskSlug: 'r4-ok', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const common = { store, task, taskId: 'task-r4-ok', createdAt: CREATED, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT' };

    // Chair-plan has no sealed inputs — always reaches the backend regardless of this fix.
    const chairBackend = directWriteBackend();
    const chair = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: chairBackend, instructions: 'plan',
    });
    assert.equal(chair.ok, true, `chair-plan must succeed, got ${JSON.stringify(chair)}`);
    assert.equal(chairBackend.calls, 1);

    // Participant DOES have a sealed input reference — this is the exact
    // pre-provider preflight gate P20.8R4 fixes.
    const participantBackend = directWriteBackend();
    const participant = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: participantBackend, instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref }],
    });
    assert.equal(participant.ok, true, `participant must succeed, got ${JSON.stringify(participant)}`);
    assert.ok(participant.sealed_ref, 'a real sealed reference must exist');
    assert.equal(participantBackend.calls, 1, 'the report backend must have been invoked exactly once');
  });
});

// ---- 4 — DIRECT_WRITE not PROVEN: fail closed BEFORE any provider call ----

test('§4.4 — DIRECT_WRITE not PROVEN: the participant fails closed before the provider is ever called', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r4-nodw', taskSlug: 'r4-nodw', createdAt: CREATED, mode: 'council' });
    // Only VERBATIM_MATERIALIZATION is proven — DIRECT_WRITE is UNSUPPORTED.
    const policy = policyProving({ delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' });
    const common = { store, task, taskId: 'task-r4-nodw', createdAt: CREATED, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT' };

    const chairBackend = directWriteBackend();
    // Chair-plan has no sealed inputs, but its OWN report call still asserts
    // the route (via ReportInvoker) — DIRECT_WRITE is unproven here too, so
    // it must ALSO fail closed. This isolates that the participant failure
    // below is specifically the INPUT preflight, not a duplicate of this.
    const chair = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: chairBackend, instructions: 'plan',
    });
    assert.equal(chair.ok, false);
    assert.equal(chairBackend.calls, 0);

    const participantBackend = directWriteBackend();
    const participant = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: participantBackend, instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref ?? { fabricated: true } }],
    }).catch((e) => ({ ok: false, thrown: e }));
    assert.equal(participant.ok, false, 'must fail closed, never optimistically succeed');
    assert.equal(participantBackend.calls, 0, 'the report backend must NEVER be called when DIRECT_WRITE is not proven');
  });
});

// ---- 5 — VERBATIM_CONTENT input transport not PROVEN: fail closed BEFORE any provider call ----

test('§4.5 — VERBATIM_CONTENT input transport not PROVEN: the participant fails closed before the provider is ever called', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r4-noin', taskSlug: 'r4-noin', createdAt: CREATED, mode: 'council' });
    // DIRECT_WRITE is proven (the real production fact), but VERBATIM_CONTENT
    // input transport is not (NATIVE_ASSIGNED_READ is proven instead).
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'NATIVE_ASSIGNED_READ' });
    const common = { store, task, taskId: 'task-r4-noin', createdAt: CREATED, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT' };

    const chairBackend = directWriteBackend();
    const chair = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: chairBackend, instructions: 'plan',
    });
    assert.equal(chair.ok, true, 'chair-plan has no sealed inputs so it is unaffected by the input-transport gap');
    assert.equal(chairBackend.calls, 1);

    const participantBackend = directWriteBackend();
    const participant = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: participantBackend, instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref }],
    });
    assert.equal(participant.ok, false, 'must fail closed on the unproven input transport');
    assert.equal(participantBackend.calls, 0, 'the report backend must NEVER be called when the input transport is not proven');
  });
});

// ---- 6 — existing VERBATIM_MATERIALIZATION input-transport behavior is unchanged (default parameter path) ----

test('§4.6 — omitting requestedDelivery still defaults to VERBATIM_MATERIALIZATION (backward compatible)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r4-legacy', taskSlug: 'r4-legacy', createdAt: CREATED, mode: 'council' });
    // Only VERBATIM_MATERIALIZATION is proven for 'fake' here.
    const policy = policyProving({ delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' });
    const common = { store, task, taskId: 'task-r4-legacy', createdAt: CREATED, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT' };
    const legacyBackend = {
      backend: 'fake', deliveryMechanism: 'VERBATIM_MATERIALIZATION',
      calls: 0,
      async runReport({ request }) {
        this.calls += 1;
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'legacy chair plan\n', visibleOutputSource: 'FAKE' });
      },
    };
    const chair = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: legacyBackend, instructions: 'plan',
    });
    assert.equal(chair.ok, true);
    const participantBackend = { ...legacyBackend, calls: 0, async runReport(a) { this.calls += 1; return legacyBackend.runReport(a); } };
    const participant = await runCouncilArtifactStage({
      ...common, artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: participantBackend, instructions: 'report',
      inputReferences: [{ label: 'chair', reference: chair.sealed_ref }],
    });
    assert.equal(participant.ok, true, 'the legacy VERBATIM_MATERIALIZATION-only route must keep working via the default parameter');
    assert.equal(participantBackend.calls, 1);
  });
});

// ---- 7 — chair-plan / no-input behavior is unaffected by this fix ----

test('§4.7 — chair-plan (no sealed inputs) behavior is unaffected by the requestedDelivery fix, under a DIRECT_WRITE-only-proven policy', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r4-chair', taskSlug: 'r4-chair', createdAt: CREATED, mode: 'council' });
    // Only DIRECT_WRITE proven, nothing else — chair-plan never touches
    // prepareArtifactInputs() at all (inputReferences.length === 0), so it
    // must succeed exactly as before regardless of this fix.
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const backend = directWriteBackend();
    const chair = await runCouncilArtifactStage({
      store, task, taskId: 'task-r4-chair', createdAt: CREATED, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: backend, instructions: 'plan',
    });
    assert.equal(chair.ok, true);
    assert.equal(backend.calls, 1);
    assert.ok(chair.sealed_ref);
  });
});

// ---- SINGLE Context Chaining: the same fix applies to admitArtifactContext()/prepareContextForConsumption() ----

test('§3 — SINGLE context chaining: a DIRECT_WRITE-only-proven target consuming prior context reaches the report backend', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const prior = await completeSingle(store, { taskId: 'task-r4-single-prior', text: '# prior\n\nPRIOR-UNIQUE-MARKER body\n' });

    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const target = directWriteBackend();
    const out = await runSingleReport({
      store, taskId: 'task-r4-single-target', taskSlug: 'r4-target', createdAt: CREATED,
      invocationId: 'inv-r4-target', executionId: 'exec-r4-target',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'consume prior', reportBackend: target, deliveryMechanism: 'DIRECT_WRITE',
      directWriter: target.directWriter, capabilityPolicy: policy,
      contextSelectors: [TASK_FINAL(prior.taskId)], contextInputTransport: 'VERBATIM_CONTENT',
    });
    assert.equal(target.calls, 1, 'the report backend must have been invoked exactly once');
    assert.match(target.lastPrompt, /PRIOR-UNIQUE-MARKER/, 'the prior task content must have been admitted as evidence');
    assert.ok(out, 'runSingleReport must resolve, never throw, on the fixed route');
  });
});

test('§3 — SINGLE context chaining: DIRECT_WRITE not PROVEN still fails closed before the provider is called', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const prior = await completeSingle(store, { taskId: 'task-r4-single-prior2', text: '# prior\n\nother body\n' });

    // Only VERBATIM_MATERIALIZATION proven — the target's real deliveryMechanism is DIRECT_WRITE.
    const policy = policyProving({ delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' });
    const target = directWriteBackend();
    await assert.rejects(
      runSingleReport({
        store, taskId: 'task-r4-single-target2', taskSlug: 'r4-target2', createdAt: CREATED,
        invocationId: 'inv-r4-target2', executionId: 'exec-r4-target2',
        profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
        instructions: 'consume prior', reportBackend: target, deliveryMechanism: 'DIRECT_WRITE',
        directWriter: target.directWriter, capabilityPolicy: policy,
        contextSelectors: [TASK_FINAL(prior.taskId)], contextInputTransport: 'VERBATIM_CONTENT',
      }),
    );
    assert.equal(target.calls, 0, 'the report backend must NEVER be called when the route is not proven');
  });
});

test('§6 — existing VERBATIM_MATERIALIZATION SINGLE context-chaining tests remain green (sanity — same fixture, no policy override)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const prior = await completeSingle(store, { taskId: 'task-r4-legacy-prior', text: '# prior\n\nLEGACY-MARKER body\n' });
    const target = countingBackend(fakeReportBackend({ text: 'legacy target body\n' }));
    await runSingleReport({
      store, taskId: 'task-r4-legacy-target', taskSlug: 'r4-legacy-target', createdAt: CREATED,
      invocationId: 'inv-r4-legacy-target', executionId: 'exec-r4-legacy-target',
      profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'consume prior', reportBackend: target,
      contextSelectors: [TASK_FINAL(prior.taskId)], contextInputTransport: 'VERBATIM_CONTENT',
    });
    assert.equal(target.calls, 1);
    assert.match(target.lastPrompt, /LEGACY-MARKER/);
  });
});
