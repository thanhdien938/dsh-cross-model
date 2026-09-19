/**
 * P20.8 §6.3 — SINGLE artifact_v1 production driver.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §6.3, §12 (#6, #9, #10, #12, #16).
 *
 * Offline. No live provider/model calls — a deterministic fakeReportBackend
 * stands in for every backend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SingleArtifactDriver, SingleArtifactDriverError, singleArtifactInvocationId } from '../src/pm/single-artifact-driver.mjs';
import { TERMINAL_STATE, buildReportBackendResult, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-11T00:00:00Z';

function provenPolicy(product = 'fake') {
  return DEFAULT_BACKEND_REPORT_POLICY; // 'fake' is already fully PROVEN offline (report-backend-result fixture).
}

test('§6.3/#6 — a finish decision only ever follows a sealed Task Final Artifact Gate', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeReportBackend({ text: '# SINGLE artifact_v1 report\n\nbody\n' });
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-single-1', taskSlug: 'single-artifact', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'do the thing',
      resolveReportBackend: () => ({ backend: 'fake', runReport: backend.runReport.bind(backend) }),
      capabilityPolicy: provenPolicy(),
    });
    const decision = await driver.decide({ turn: 0, request: { id: 'req-1' }, history: [] });
    assert.equal(decision.type, 'finish');
    assert.match(decision.output, /SINGLE artifact_v1 report/);
    assert.equal(decision.data.transport_version, 'artifact_v1');
    assert.ok(decision.data.final_ref, 'final_ref must be present on a genuine finish');
    // The invocation id is deterministic from taskId, never random.
    assert.equal(decision.data.invocation_id, singleArtifactInvocationId('task-single-1'));

    // Reopening the sealed task from disk shows a real Task Final Artifact
    // Gate result — never a driver-fabricated ref.
    const reopened = store.openTaskById('task-single-1');
    assert.equal(reopened.manifest.task_state, 'COMPLETED');
    assert.ok(reopened.manifest.final_ref, 'task-manifest.json must carry the sealed final_ref');
  });
});

test('§12/#12 — provider success alone cannot produce a finish decision when sealing fails', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    // A backend result larger than the size policy allows fails the
    // Invocation Artifact Gate AFTER a truthful provider SUCCESS — proving
    // "provider success + artifact failure cannot become owner COMPLETED".
    const oversized = 'x'.repeat(50);
    const backend = {
      async runReport({ request }) {
        return buildReportBackendResult({
          backend: request.backend, profileId: request.profileId, executionId: request.executionId,
          terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: oversized, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE,
        });
      },
    };
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-single-oversize', taskSlug: 'single-oversize', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'go',
      resolveReportBackend: () => ({ backend: 'fake', runReport: backend.runReport }),
      capabilityPolicy: provenPolicy(), maxReportBytes: 8,
    });
    await assert.rejects(driver.decide({ turn: 0 }));
    // The task must never read COMPLETED from a failed seal attempt.
    let reopened = null;
    try { reopened = store.openTaskById('task-single-oversize'); } catch { /* may not even exist depending on failure point */ }
    if (reopened) assert.notEqual(reopened.manifest.task_state, 'COMPLETED');
  });
});

test('§16 — an UNPROVEN route never reaches the provider (assertReportRoute fails closed before any call)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    let calls = 0;
    const backend = { async runReport() { calls += 1; return buildReportBackendResult({ backend: 'claude-code', profileId: 'live1-claude-sonnet-medium', executionId: 'exec-x', terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'x', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT }); } };
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-single-unproven', taskSlug: 'single-unproven', createdAt: CREATED,
      profileId: 'live1-claude-sonnet-medium', actorAlias: 'claude', instructions: 'go',
      resolveReportBackend: () => ({ backend: 'claude-code', runReport: backend.runReport }),
      capabilityPolicy: DEFAULT_BACKEND_REPORT_POLICY, // claude-code VERBATIM_MATERIALIZATION is UNPROVEN by default
    });
    await assert.rejects(driver.decide({ turn: 0 }), (e) => {
      assert.match(String(e.code ?? e.message), /UNPROVEN|ARTIFACT_REPORT_DELIVERY/);
      return true;
    });
    assert.equal(calls, 0, 'the provider must never be called for an unproven route');
  });
});

test('a malformed resolveReportBackend() result is refused before any allocation', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-single-bad-resolver', taskSlug: 'x', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'go',
      resolveReportBackend: () => ({ notBackend: true }),
      capabilityPolicy: provenPolicy(),
    });
    await assert.rejects(driver.decide({ turn: 0 }), (e) => {
      assert.ok(e instanceof SingleArtifactDriverError);
      assert.equal(e.code, 'SINGLE_ARTIFACT_BAD_BACKEND');
      return true;
    });
  });
});

test('the driver refuses a call for any turn other than 0', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-single-extra-turn', taskSlug: 'x', createdAt: CREATED,
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'go',
      resolveReportBackend: () => ({ backend: 'fake', runReport: fakeReportBackend().runReport }),
      capabilityPolicy: provenPolicy(),
    });
    await assert.rejects(driver.decide({ turn: 1 }), (e) => e.code === 'SINGLE_ARTIFACT_EXTRA_TURN');
  });
});
