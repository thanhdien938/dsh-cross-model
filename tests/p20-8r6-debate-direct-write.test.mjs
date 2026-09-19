/**
 * P20.8R6 — Debate DIRECT_WRITE migration.
 *
 * Authority: docs/P20/P20_8R6_DEBATE_DIRECT_WRITE_ALT_PROFILE_READINESS_MASTER_PROMPT.md
 *
 * Proves `runDebateArtifactStage()` (src/pm/council/council-artifact-
 * orchestrator.mjs) now resolves its report-delivery route from the SAME
 * `reportBackend.deliveryMechanism`/`directWriter` fact normal Council
 * (`runCouncilArtifactStage()`) already uses — never a hard-coded
 * `VERBATIM_MATERIALIZATION` literal — while the SEPARATE Debate typed
 * continuation-control channel stays entirely independent of report
 * delivery/content (never inferred from report.md).
 *
 * Offline only. No real CLI process is ever spawned; every report backend
 * below is a deterministic in-process fake, exactly like
 * tests/p20-8r2-direct-write.test.mjs and tests/p20-8r4-direct-write-
 * input-preflight.test.mjs already use for Council.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { buildReportBackendResult, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';
import { runDebateArtifactStage } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-12T00:00:00Z';

function policyProving({ delivery, notDeliveryState = CAPABILITY_STATE.UNSUPPORTED, input = 'VERBATIM_CONTENT', notInputState = CAPABILITY_STATE.UNSUPPORTED } = {}) {
  const otherDelivery = delivery === 'DIRECT_WRITE' ? 'VERBATIM_MATERIALIZATION' : 'DIRECT_WRITE';
  const otherInput = input === 'VERBATIM_CONTENT' ? 'NATIVE_ASSIGNED_READ' : 'VERBATIM_CONTENT';
  return {
    enforcement_version: 'test-p20-8r6-1',
    backends: {
      fake: {
        report_delivery: { [delivery]: CAPABILITY_STATE.PROVEN, [otherDelivery]: notDeliveryState },
        artifact_input: { [input]: CAPABILITY_STATE.PROVEN, [otherInput]: notInputState },
      },
    },
  };
}

/**
 * A counting DIRECT_WRITE fake backend that writes the assigned path itself
 * (mirrors cli-report-backends.mjs's real DIRECT_WRITE branch: the model
 * writes; DSH only confirms) and reuses the SAME shared production
 * `directWriter` (PROVIDER_DIRECT_WRITE_CONFIRMER) real DIRECT_WRITE
 * delivery uses. `continueDebate`, when not null, also populates the
 * SEPARATE typed-control channel (`debate_typed_control`) — never derived
 * from `text`.
 */
function directWriteBackend({ terminalState = TERMINAL_STATE.SUCCESS, text = 'DIRECT_WRITE debate report\n', continueDebate = null, typedControlProven = false } = {}) {
  let calls = 0;
  return {
    backend: 'fake',
    deliveryMechanism: 'DIRECT_WRITE',
    directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
    supportsDebateTypedControl: typedControlProven,
    get calls() { return calls; },
    async runReport({ request }) {
      calls += 1;
      const assignedPath = request.attempt.reportPath;
      mkdirSync(dirname(assignedPath), { recursive: true });
      writeFileSync(assignedPath, text);
      return buildReportBackendResult({
        backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState,
        safeDiagnostics: { direct_write: true },
        debateTypedControl: typeof continueDebate === 'boolean' ? continueDebate : null,
      });
    },
  };
}

// ---- 1 — Debate brief through DIRECT_WRITE (no sealed inputs) ----

test('§D.1 — Debate brief executes through a DIRECT_WRITE fake backend and seals', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-brief', taskSlug: 'r6-brief', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const backend = directWriteBackend({ text: 'debate brief body\n' });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-brief', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: backend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'brief it',
    });
    assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
    assert.equal(backend.calls, 1, 'the report backend must have been invoked exactly once');
    assert.ok(outcome.sealed_ref, 'a real sealed reference must exist');
    return outcome;
  });
});

// ---- 2 — Debate member response through DIRECT_WRITE, consuming a sealed input (§D.1/§D.2) ----

async function sealBrief(store, task, policy) {
  const backend = directWriteBackend({ text: 'debate brief body\n' });
  const outcome = await runDebateArtifactStage({
    store, task, taskId: task.taskId, createdAt: CREATED, round: 1, maxRounds: 2,
    artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
    reportBackend: backend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
    instructions: 'brief it',
  });
  assert.equal(outcome.ok, true, `brief must seal to set up this test, got ${JSON.stringify(outcome)}`);
  return outcome;
}

test('§D.1/§D.2 — Debate member response consumes the sealed brief through DIRECT_WRITE; the fake backend itself writes the file, DSH never materializes report bytes', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-resp', taskSlug: 'r6-resp', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const brief = await sealBrief(store, task, policy);

    const backend = directWriteBackend({ text: 'debate response body\n' });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-resp', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: backend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'respond',
      inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
    assert.equal(backend.calls, 1);
    assert.ok(outcome.sealed_ref);
    // §D.2 — DSH's own delivery confirmer never writes content (it is the
    // shared stateless PROVIDER_DIRECT_WRITE_CONFIRMER, () => ({})); the
    // fake backend above is what actually created the file.
    assert.equal(typeof backend.directWriter, 'function');
    assert.equal(backend.directWriter.expectPreExisting, true);
  });
});

// ---- 3 — Debate synthesis through DIRECT_WRITE, typed control captured + bound (§B, §D.6) ----

test('§B/§D.6 — Debate synthesis executes through DIRECT_WRITE AND captures/binds the separate typed continuation control, without inspecting report.md', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-synth', taskSlug: 'r6-synth', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const brief = await sealBrief(store, task, policy);
    const responseBackend = directWriteBackend({ text: 'response body\n' });
    const response = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-synth', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: responseBackend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'respond', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(response.ok, true);

    // The synthesis report text says nothing about continuation — proving
    // the captured control cannot possibly come from parsing report bytes.
    const synthBackend = directWriteBackend({
      text: 'purely a synthesis narrative, no machine-readable continuation marker anywhere\n',
      continueDebate: true,
      typedControlProven: true,
    });
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-synth', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: synthBackend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'synthesize',
      inputReferences: [
        { label: 'brief', reference: brief.sealed_ref },
        { label: 'response', reference: response.sealed_ref },
      ],
    });
    assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
    assert.equal(synthBackend.calls, 1);
    assert.ok(outcome.sealed_ref);
    assert.ok(outcome.typed_control, 'a typed_control record must be attached to a synthesis outcome');
    assert.equal(outcome.typed_control.continue_debate, true);
    // Same-execution identity binding (§B "preserve same-execution binding").
    assert.equal(outcome.typed_control.task_id, 'task-r6-synth');
    assert.equal(outcome.typed_control.round, 1);
    assert.equal(outcome.typed_control.profile_id, 'live1-chair');
    assert.equal(outcome.typed_control.actor_alias, 'chair');
    assert.equal(outcome.typed_control.stage, ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS);
    // Never a report-semantic key on the typed control (D0-locked contract).
    for (const forbidden of ['reason', 'analysis', 'synthesis', 'summary', 'brief', 'response', 'report']) {
      assert.equal(Object.prototype.hasOwnProperty.call(outcome.typed_control, forbidden), false, `typed_control must never carry ${forbidden}`);
    }
  });
});

// ---- 4 — DIRECT_WRITE not PROVEN: fail closed before the provider is ever called ----

test('§D.4 — DIRECT_WRITE not PROVEN: a Debate response with sealed inputs fails closed before the provider is called', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-nodw', taskSlug: 'r6-nodw', createdAt: CREATED, mode: 'council' });
    // Only VERBATIM_MATERIALIZATION is proven for the brief (chair-brief has
    // no sealed inputs, so this only matters for the response's own delivery
    // AND input-preflight route below).
    const noDwPolicy = policyProving({ delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' });
    // Seal the brief with a policy that DOES prove DIRECT_WRITE for setup
    // purposes only (isolating: the FAILURE under test is the response
    // stage, not brief sealing).
    const setupPolicy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const brief = await sealBrief(store, task, setupPolicy);

    const responseBackend = directWriteBackend();
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-nodw', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: responseBackend, capabilityPolicy: noDwPolicy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'respond', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false, 'must fail closed, never optimistically succeed');
    assert.equal(responseBackend.calls, 0, 'the report backend must NEVER be called when DIRECT_WRITE is not proven');
  });
});

// ---- 5 — VERBATIM_CONTENT input transport not PROVEN: fail closed before the provider is called ----

test('§D.5 — VERBATIM_CONTENT input transport not PROVEN: a Debate response with sealed inputs fails closed before the provider is called', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-noin', taskSlug: 'r6-noin', createdAt: CREATED, mode: 'council' });
    const setupPolicy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const brief = await sealBrief(store, task, setupPolicy);

    // DIRECT_WRITE proven (the real fact) but VERBATIM_CONTENT input is not.
    const noInputPolicy = policyProving({ delivery: 'DIRECT_WRITE', input: 'NATIVE_ASSIGNED_READ' });
    const responseBackend = directWriteBackend();
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-noin', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'live1-p1', actorAlias: 'p1', backend: 'fake',
      reportBackend: responseBackend, capabilityPolicy: noInputPolicy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'respond', inputReferences: [{ label: 'brief', reference: brief.sealed_ref }],
    });
    assert.equal(outcome.ok, false, 'must fail closed on the unproven input transport');
    assert.equal(responseBackend.calls, 0, 'the report backend must NEVER be called when the input transport is not proven');
  });
});

// ---- 6 — DELIVERED recovery completes via DIRECT_WRITE without replaying the provider ----

test('§D.7 — recovery from DELIVERED (crash after delivery, before seal) completes via DIRECT_WRITE without calling the provider again', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-crash', taskSlug: 'r6-crash', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' });
    const backend = directWriteBackend({ text: 'debate brief body\n' });

    // First call: stop right after delivery, before completeReportArtifact()
    // seals it — simulates a process crash between DELIVERED and SEALED.
    await assert.rejects(
      runDebateArtifactStage({
        store, task, taskId: 'task-r6-crash', createdAt: CREATED, round: 1, maxRounds: 2,
        artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
        reportBackend: backend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
        instructions: 'brief it',
        __afterDeliverHook: () => 'STOP_BEFORE_SEAL',
      }),
      (e) => e.__p20TestStopBeforeSeal === true,
    );
    assert.equal(backend.calls, 1, 'the provider ran exactly once before the simulated crash');

    // Second call: same identity, no hook — must recover from DELIVERED and
    // seal from disk, WITHOUT calling the provider again.
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-crash', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: backend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'brief it',
    });
    assert.equal(outcome.ok, true, `expected recovery to succeed, got ${JSON.stringify(outcome)}`);
    assert.equal(backend.calls, 1, 'the provider must NOT be called again on DELIVERED recovery');
    assert.ok(outcome.sealed_ref);
  });
});

// ---- 7 — legacy VERBATIM_MATERIALIZATION compatibility (byte-for-byte default) ----

test('§D.9 — a reportBackend with no deliveryMechanism field still defaults to VERBATIM_MATERIALIZATION (backward compatible)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-r6-legacy', taskSlug: 'r6-legacy', createdAt: CREATED, mode: 'council' });
    const policy = policyProving({ delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' });
    let calls = 0;
    const legacyBackend = {
      backend: 'fake', // no `deliveryMechanism` field at all — predates P20.8R6
      async runReport({ request }) {
        calls += 1;
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'legacy debate brief text\n', visibleOutputSource: 'FAKE' });
      },
    };
    const outcome = await runDebateArtifactStage({
      store, task, taskId: 'task-r6-legacy', createdAt: CREATED, round: 1, maxRounds: 2,
      artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, profileId: 'live1-chair', actorAlias: 'chair', backend: 'fake',
      reportBackend: legacyBackend, capabilityPolicy: policy, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'brief it',
    });
    assert.equal(outcome.ok, true, `the legacy VERBATIM_MATERIALIZATION-only route must keep working via the default parameter, got ${JSON.stringify(outcome)}`);
    assert.equal(calls, 1);
  });
});
