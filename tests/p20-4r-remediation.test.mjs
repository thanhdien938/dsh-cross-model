/**
 * P20.4R R3/R6/R7/R8 + §24 — focused remediation coverage that isn't in the
 * durable-integration suite. Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';

import { runArtifactCouncil, runCouncilArtifactStage } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { verifySealedArtifactReference } from '../src/artifacts/artifact-recovery.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

// ---- R8: open-invocation errors fail closed ---------------------------

test('R8: a corrupt invocation.json for a Council stage fails closed (RECONCILED_NO_REPLAY), ZERO provider call', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const b1 = councilBackends();
    // first: run a full council so stage invocations exist on disk
    await runArtifactCouncil({
      store, council: spec, ownerTask: 'x', constraints: [],
      taskId: 'task-R8CORRUPT', taskSlug: 'r8', createdAt: COUNCIL_CREATED_AT,
      aliasRegistry: aliasRegistryFor(spec), resolveReportBackend: b1, consumerInputTransport: 'VERBATIM_CONTENT',
    });
    // corrupt the chair-plan invocation.json
    const task = store.openTaskById('task-R8CORRUPT');
    const inv = task.openInvocationById('council:task-R8CORRUPT:chair-plan');
    writeFileSync(inv.recordPath, '{ this is not valid json');

    const b2 = councilBackends();
    const outcome = await runCouncilArtifactStage({
      store, task, taskId: 'task-R8CORRUPT', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: aliasRegistryFor(spec).get('live1-chair'),
      backend: 'fake', reportBackend: b2('live1-chair'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'plan',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.execution_state, 'RECONCILED_NO_REPLAY');
    assert.match(outcome.failure_code, /INVOCATION_OPEN_FAILED|RECORD_CORRUPT/);
    assert.equal(b2.seen.length, 0, 'no provider call on a corrupt durable record');
  });
});

test('R8: a genuinely-missing invocation is NOT an error — a fresh stage allocation proceeds', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const store2 = makeStore(dir);
    const task = store2.allocateTask({ taskId: 'task-R8FRESH', taskSlug: 'r8f', createdAt: COUNCIL_CREATED_AT, mode: 'council' });
    const b = councilBackends();
    const outcome = await runCouncilArtifactStage({
      store: store2, task, taskId: 'task-R8FRESH', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: aliasRegistryFor(spec).get('live1-chair'),
      backend: 'fake', reportBackend: b('live1-chair'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'plan',
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.execution_state, 'SEALED');
    assert.equal(b.seen.length, 1);
  });
});

// ---- R7: implementation_participant_id typed execution capability ----

test('R7: only the designated implementation participant\'s report may carry execution capability, and an unsupported route FAILS CLOSED before the provider call', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const task = store.allocateTask({ taskId: 'task-R7', taskSlug: 'r7', createdAt: COUNCIL_CREATED_AT, mode: 'council' });
    const be = councilBackends();
    // execution capability requested but the fake backend route does not support it
    const failClosed = await runCouncilArtifactStage({
      store, task, taskId: 'task-R7', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-alpha', actorAlias: aliasRegistryFor(spec).get('live1-alpha'),
      backend: 'fake', reportBackend: be('live1-alpha'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'report', executionCapable: true,
    });
    assert.equal(failClosed.ok, false);
    assert.equal(failClosed.failure_code, 'COUNCIL_ARTIFACT_IMPLEMENTATION_ROUTE_UNSUPPORTED');
    assert.equal(be.seen.length, 0, 'no provider call when the route cannot support the required capability');

    // execution capability on a non-report stage is forbidden
    const stageForbidden = await runCouncilArtifactStage({
      store, task, taskId: 'task-R7', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: aliasRegistryFor(spec).get('live1-chair'),
      backend: 'fake', reportBackend: be('live1-chair'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'plan', executionCapable: true,
    });
    assert.equal(stageForbidden.ok, false);
    assert.equal(stageForbidden.failure_code, 'COUNCIL_ARTIFACT_EXECUTION_CAPABILITY_STAGE_FORBIDDEN');

    // a fixture backend that DECLARES support: typed propagation succeeds
    const capable = be('live1-alpha');
    capable.supportsExecutionCapability = true;
    const ok = await runCouncilArtifactStage({
      store, task, taskId: 'task-R7', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'live1-alpha', actorAlias: aliasRegistryFor(spec).get('live1-alpha'),
      backend: 'fake', reportBackend: capable, consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'report', executionCapable: true,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.execution_state, 'SEALED');
  });
});

// ---- R6: workspace_requirement:READ source evidence on the artifact path ----

test('R6: a READ Council chair plan receives the admitted/redacted source packet as UNTRUSTED evidence (not a structured field)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1, workspace_requirement: 'READ', workspace_evidence_paths: ['src/x.mjs'] });
    let promptSeen = null;
    const backends = councilBackends({ onPrompt: ({ stage, prompt }) => { if (stage === 'chair-plan') promptSeen = prompt; } });
    const PACKET = '=== EVIDENCE PACKET ===\nsrc/x.mjs (sha256 abc):\n  const SECRET = "[REDACTED]";\n';
    const driver = new CouncilChairDriver({
      council: spec, ownerTask: 'audit', transportMode: 'artifact_v1',
      artifactCouncil: { store, taskId: 'task-R6READ', taskSlug: 'r6', createdAt: COUNCIL_CREATED_AT, aliasRegistry: aliasRegistryFor(spec), consumerInputTransport: 'VERBATIM_CONTENT' },
      resolveWorkspaceCapability: () => 'TEXT_ONLY',
      loadEvidencePacket: async () => ({ text: PACKET, hashesByPath: { 'src/x.mjs': 'abc' } }),
    });
    // turn 0 -> chair_plan spec with the packet as extraEvidence
    const decision = await driver.decide({ turn: 0, history: [] });
    assert.equal(decision.type, 'workflow');
    assert.equal(decision.spec.transport_version, 'artifact_v1');
    assert.equal(decision.spec.artifactStage, 'chair-plan');
    assert.ok(Array.isArray(decision.spec.extraEvidence) && decision.spec.extraEvidence.length === 1);
    assert.match(decision.spec.extraEvidence[0].label, /untrusted/i);
    assert.equal(decision.spec.extraEvidence[0].content, PACKET);

    // execute that stage through the offline executor and confirm the packet
    // reached the prompt as untrusted evidence, verbatim, and the report sealed.
    const outcome = await runCouncilArtifactStage({
      store, task: store.openTaskById('task-R6READ') ?? store.allocateTask({ taskId: 'task-R6READ', taskSlug: 'r6', createdAt: COUNCIL_CREATED_AT, mode: 'council' }),
      taskId: 'task-R6READ', createdAt: COUNCIL_CREATED_AT,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-chair', actorAlias: aliasRegistryFor(spec).get('live1-chair'),
      backend: 'fake', reportBackend: backends('live1-chair'), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: decision.spec.instructions, extraEvidence: decision.spec.extraEvidence,
    });
    assert.equal(outcome.ok, true);
    assert.match(promptSeen, /untrusted/i);
    assert.ok(promptSeen.includes(PACKET), 'the packet text is injected verbatim as evidence');
    assert.doesNotMatch(promptSeen, /"evidence"\s*:/); // no structured evidence field demanded
  });
});

// ---- §24: parser/canonicalizer bypass — dynamic, through the executor ----

test('§24 (dynamic): a semantically chaotic report still seals through the Council artifact executor; no parse error', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const chaos = 'no json\n{"decision":"A"} {"decision":"B"}\n```json\n{ bad,, }\n```\nrecommendation: X\nrecommendation: not X\n';
    const out = await runArtifactCouncil({
      store, council: spec, ownerTask: 'x', constraints: [],
      taskId: 'task-24DYN', taskSlug: 's', createdAt: COUNCIL_CREATED_AT,
      aliasRegistry: aliasRegistryFor(spec),
      resolveReportBackend: councilBackends({ plan: { default: { text: chaos } } }),
      consumerInputTransport: 'VERBATIM_CONTENT',
    });
    assert.equal(out.ok, true);
    for (const s of out.steps.filter((x) => x.step_kind === 'participant_report')) {
      const v = verifySealedArtifactReference({ store, reference: s.sealed_ref });
      assert.equal(v.buffer.toString('utf8'), chaos);
    }
  });
});
