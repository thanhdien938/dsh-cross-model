/**
 * P20.8R2 — DIRECT_WRITE Phase 1 production route.
 *
 * Authority: docs/P20/P20_8R2_DIRECT_WRITE_PHASE1_E2E_MASTER_PROMPT.md §7.
 *
 * Offline. No real CLI process is ever spawned. Uses a deterministic fake
 * report backend that simulates "the model itself writes the assigned
 * file" — the SAME shared PROVIDER_DIRECT_WRITE_CONFIRMER production uses
 * as its `directWriter`, so these tests exercise the real production
 * delivery/completion code paths (deliverDirectWrite, completeReportArtifact,
 * completeSingleReportArtifact, runTaskFinalArtifactGate), not a parallel
 * test-only mechanism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';
import { buildReportBackendResult, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { runSingleReport, SingleReportOperationError } from '../src/pm/single-report-operation.mjs';
import { SingleArtifactDriver } from '../src/pm/single-artifact-driver.mjs';
import { deliverDirectWrite, ArtifactDeliveryError } from '../src/artifacts/artifact-delivery.mjs';
import { runCouncilArtifactStage } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-12T00:00:00Z';

/** A DIRECT_WRITE-proven capability policy for the 'fake' product only. */
function directWriteProvenPolicy() {
  return {
    enforcement_version: 'test-direct-write-1',
    backends: {
      ...DEFAULT_BACKEND_REPORT_POLICY.backends,
      fake: { report_delivery: { DIRECT_WRITE: CAPABILITY_STATE.PROVEN, VERBATIM_MATERIALIZATION: CAPABILITY_STATE.PROVEN }, artifact_input: { NATIVE_ASSIGNED_READ: CAPABILITY_STATE.PROVEN, VERBATIM_CONTENT: CAPABILITY_STATE.PROVEN } },
    },
  };
}

/**
 * Simulates a real DIRECT_WRITE CLI backend: `runReport()` writes the
 * ASSIGNED path itself (a side effect, exactly like the model's own Write
 * tool use) and returns a ReportBackendResult with `acceptedVisibleText:
 * null` — DSH never materializes content for this route.
 */
function fakeDirectWriteBackend({ text = 'DIRECT_WRITE report body\n', mode = 'write-assigned', terminalState = TERMINAL_STATE.SUCCESS } = {}) {
  return {
    backend: 'fake',
    deliveryMechanism: 'DIRECT_WRITE',
    directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
    lastPrompt: null,
    async runReport({ prompt, request }) {
      this.lastPrompt = prompt;
      const assignedPath = request.attempt.reportPath;
      if (mode === 'write-assigned') {
        mkdirSync(dirname(assignedPath), { recursive: true });
        writeFileSync(assignedPath, text);
      } else if (mode === 'write-wrong-path') {
        const wrongPath = `${assignedPath}.wrong-location`;
        mkdirSync(dirname(wrongPath), { recursive: true });
        writeFileSync(wrongPath, text);
      } else if (mode === 'write-empty') {
        mkdirSync(dirname(assignedPath), { recursive: true });
        writeFileSync(assignedPath, '');
      } else if (mode === 'no-write') {
        // model produced no file at all
      }
      return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState });
    },
  };
}

test('§7 — DIRECT_WRITE prompt/request receives the exact assigned absolute path', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend();
    await runSingleReport({
      store, taskId: 'task-dw-path', taskSlug: 'dw', createdAt: CREATED,
      invocationId: 'inv-dw-path', executionId: 'exec-dw-path', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter, deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: directWriteProvenPolicy(),
    });
    assert.match(backend.lastPrompt, /assigned_report_path \(write ONLY this exact file\):/);
    assert.match(backend.lastPrompt, /delivery_mechanism: DIRECT_WRITE/);
    // the exact path named in the prompt is the real absolute path on disk
    const m = backend.lastPrompt.match(/assigned_report_path \(write ONLY this exact file\): (.+)/);
    assert.ok(m, 'prompt must name the assigned path');
    assert.ok(readFileSync(m[1].trim(), 'utf8').length > 0);
  });
});

test('§7 — the DIRECT_WRITE adapter never materializes accepted_visible_text into report.md', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend({ text: 'exactly what the model wrote\n' });
    const out = await runSingleReport({
      store, taskId: 'task-dw-novtext', taskSlug: 'dw', createdAt: CREATED,
      invocationId: 'inv-dw-novtext', executionId: 'exec-dw-novtext', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter, deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: directWriteProvenPolicy(), complete: true,
    });
    assert.equal(out.result.accepted_visible_text, null, 'DIRECT_WRITE ReportBackendResult must never carry materialized text');
    const bytes = readFileSync(out.completion.finalRef.artifact_relpath ? `${store.root}/${out.completion.finalRef.artifact_relpath}` : out.attempt.reportPath, 'utf8');
    assert.equal(bytes, 'exactly what the model wrote\n', 'the sealed report must be EXACTLY the file the model wrote, byte for byte');
  });
});

test('§7 — a missing model-written file fails (DIRECT_WRITE, no fallback)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend({ mode: 'no-write' });
    await assert.rejects(runSingleReport({
      store, taskId: 'task-dw-missing', taskSlug: 'dw', createdAt: CREATED,
      invocationId: 'inv-dw-missing', executionId: 'exec-dw-missing', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter, deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: directWriteProvenPolicy(),
    }), (e) => {
      assert.match(String(e.code ?? e.message), /ARTIFACT_DIRECT_WRITE_REPORT_MISSING/);
      return true;
    });
  });
});

test('§7 — a file written to the wrong path fails (the assigned path still does not exist)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend({ mode: 'write-wrong-path' });
    await assert.rejects(runSingleReport({
      store, taskId: 'task-dw-wrongpath', taskSlug: 'dw', createdAt: CREATED,
      invocationId: 'inv-dw-wrongpath', executionId: 'exec-dw-wrongpath', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter, deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: directWriteProvenPolicy(),
    }), (e) => {
      assert.match(String(e.code ?? e.message), /ARTIFACT_DIRECT_WRITE_REPORT_MISSING/);
      return true;
    });
  });
});

test('§7 — an empty written file fails', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend({ mode: 'write-empty' });
    await assert.rejects(runSingleReport({
      store, taskId: 'task-dw-empty', taskSlug: 'dw', createdAt: CREATED,
      invocationId: 'inv-dw-empty', executionId: 'exec-dw-empty', profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
      instructions: 'go', reportBackend: backend, directWriter: backend.directWriter, deliveryMechanism: 'DIRECT_WRITE', capabilityPolicy: directWriteProvenPolicy(),
    }), (e) => {
      assert.match(String(e.code ?? e.message), /ARTIFACT_DIRECT_WRITE_REPORT_EMPTY/);
      return true;
    });
  });
});

test('§7 — a valid model-written file passes integrity/seal/final_ref (full SingleArtifactDriver pipeline)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeDirectWriteBackend({ text: '# Real Phase-1 report\n\nbody\n' });
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-dw-e2e', taskSlug: 'dw-e2e', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'produce the report',
      resolveReportBackend: () => backend,
      capabilityPolicy: directWriteProvenPolicy(),
    });
    const decision = await driver.decide({ turn: 0 });
    assert.equal(decision.type, 'finish');
    assert.ok(decision.data.final_ref, 'final_ref must be a real sealed reference');
    assert.equal(decision.output, '', 'DIRECT_WRITE finish output has no materialized text — final_ref is the authority');
    const reopened = store.openTaskById('task-dw-e2e');
    assert.equal(reopened.manifest.task_state, 'COMPLETED');
  });
});

test('§7 — Council artifact_v1 uses DIRECT_WRITE for a chair/member stage in the Phase-1 route', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const task = store.allocateTask({ taskId: 'task-dw-council', taskSlug: 'dw-council', createdAt: CREATED, mode: 'council' });
    const backend = fakeDirectWriteBackend({ text: '# Chair plan\n\nplan body\n' });
    const outcome = await runCouncilArtifactStage({
      store, task, taskId: 'task-dw-council', createdAt: CREATED,
      artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'live1-fake', actorAlias: 'fake', backend: 'fake',
      reportBackend: backend, capabilityPolicy: directWriteProvenPolicy(), consumerInputTransport: 'VERBATIM_CONTENT',
      instructions: 'plan it',
    });
    assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
    assert.ok(outcome.sealed_ref, 'a real sealed reference must exist');
  });
});

test('§7 — semantic report parser/canonicalizer is never imported by the DIRECT_WRITE report-plane modules', async () => {
  const files = [
    new URL('../src/pm/report-backends/cli-report-backends.mjs', import.meta.url),
    new URL('../src/pm/single-artifact-driver.mjs', import.meta.url),
    new URL('../src/runtime/p20-report-route-resolution.mjs', import.meta.url),
  ];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    // Only real import statements count — these files' own comments freely
    // discuss what they deliberately do NOT reach.
    assert.doesNotMatch(txt, /^\s*import[^\n]*(parseDecision|acceptPmOutput|canonicalizer|validateStepData)/im, `${f} must never IMPORT the semantic decision-plane parser`);
  }
});

test('§7 — legacy VERBATIM_MATERIALIZATION compatibility code still works when explicitly selected (P20 mode off equivalent)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'VERBATIM_MATERIALIZATION',
      async runReport({ request }) {
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'legacy materialized text\n', visibleOutputSource: 'FAKE' });
      },
    };
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-legacy-vm', taskSlug: 'legacy', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'go',
      resolveReportBackend: () => backend,
      capabilityPolicy: DEFAULT_BACKEND_REPORT_POLICY, // 'fake' VERBATIM_MATERIALIZATION is PROVEN by default
    });
    const decision = await driver.decide({ turn: 0 });
    assert.equal(decision.type, 'finish');
    assert.match(decision.output, /legacy materialized text/);
  });
});

test('deliverDirectWrite: expectPreExisting mode requires the file to already exist, never calls a synchronous writer to create it', () => {
  const attempt = { path: '/does/not/matter', reportPath: '/does/not/matter/report.md' };
  let called = 0;
  const writer = Object.assign(() => { called += 1; return {}; }, { expectPreExisting: true });
  assert.throws(() => deliverDirectWrite({ attempt, writer }), (e) => {
    assert.ok(e instanceof ArtifactDeliveryError);
    assert.equal(e.code, 'ARTIFACT_DIRECT_WRITE_REPORT_MISSING');
    return true;
  });
  assert.equal(called, 0, 'the confirmation writer must not even be called before the pre-existence check passes');
});
