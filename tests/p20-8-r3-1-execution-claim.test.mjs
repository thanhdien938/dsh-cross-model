/**
 * P20.8 PRE-R3 — R3-1: SINGLE UNKNOWN_OUTCOME must never re-execute.
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §3.
 *
 * Proves the ONE atomic execution-ownership admission boundary
 * (`InvocationWorkspace.claimRunning()`, wired into `ReportInvoker.invokeReport()`
 * and `runSingleReport()`'s durable failure settlement) adversarially:
 *   R3-1A sequential UNKNOWN_OUTCOME re-entry (same task/invocation/execution)
 *   R3-1B concurrent same-invocation execution (barrier/latch backend)
 *   R3-1C restart-style fresh ArtifactStore objects
 *   R3-1D known-failure / sealed-success behaviour stays correct
 *
 * Offline. No live provider/model calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-10T09:00:00Z';

function countingBackend(terminalState, extra = {}) {
  const state = { calls: 0 };
  state.backend = {
    async runReport({ request }) {
      state.calls += 1;
      return buildReportBackendResult({
        backend: request.backend, profileId: request.profileId, executionId: request.executionId,
        terminalState, ...extra,
      });
    },
  };
  return state;
}

test('R3-1A: sequential UNKNOWN_OUTCOME re-entry never re-calls the backend', async () => {
  await withTempRoot(async (dir) => {
    const { backend, calls: getCalls } = (() => {
      const s = countingBackend(TERMINAL_STATE.UNKNOWN_OUTCOME);
      return { backend: s.backend, calls: () => s.calls };
    })();
    const args = {
      store: makeStore(dir), taskId: 'task-R311', taskSlug: 'r3-1a', createdAt: CREATED,
      invocationId: 'inv-r311', executionId: 'exec-r311', profileId: 'live1-fake', backend: 'fake',
      actorAlias: 'fake', instructions: 'go', reportBackend: backend, startedAt: CREATED,
    };

    await assert.rejects(runSingleReport(args), (e) => {
      assert.equal(e.terminalState, 'UNKNOWN_OUTCOME');
      return true;
    });
    assert.equal(getCalls(), 1, 'first call reaches the backend exactly once');

    // Second call: EXACT same task/invocation/execution. Never re-executes.
    await assert.rejects(runSingleReport(args), (e) => {
      assert.equal(e.code, 'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED');
      assert.match(e.message, /manual recovery|reconciliation/i);
      return true;
    });
    assert.equal(getCalls(), 1, 'backend call count remains 1 after a second call');

    // A third call is refused identically (no accidental one-shot allowance).
    await assert.rejects(runSingleReport(args), (e) => e.code === 'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED');
    assert.equal(getCalls(), 1);
  });
});

test('R3-1B: concurrent same-invocation execution — exactly one call reaches the backend', async () => {
  await withTempRoot(async (dir) => {
    let entered = 0;
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const backend = {
      async runReport({ request }) {
        entered += 1;
        if (entered === 1) await gate; // hold the winner open so a naive implementation could race the loser in
        return buildReportBackendResult({
          backend: request.backend, profileId: request.profileId, executionId: request.executionId,
          terminalState: TERMINAL_STATE.SUCCESS, providerFinishReason: 'stop',
          acceptedVisibleText: '# ok\n', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE,
        });
      },
    };
    const base = {
      store: makeStore(dir), taskId: 'task-R31B', taskSlug: 'r3-1b', createdAt: CREATED,
      invocationId: 'inv-r31b', profileId: 'live1-fake', backend: 'fake',
      actorAlias: 'fake', instructions: 'go', reportBackend: backend, startedAt: CREATED,
    };

    const p1 = runSingleReport({ ...base, executionId: 'exec-A' });
    const p2 = runSingleReport({ ...base, executionId: 'exec-B' });
    releaseFirst();
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert.equal(entered, 1, 'exactly one caller ever reached reportBackend.runReport()');
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, ['fulfilled', 'rejected'], 'one call succeeds, the other is refused admission');
    const rejected = r1.status === 'rejected' ? r1.reason : r2.reason;
    assert.equal(rejected.code, 'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED');
    const fulfilled = r1.status === 'fulfilled' ? r1.value : r2.value;
    assert.equal(fulfilled.unsealedCandidate.lifecycle, 'DELIVERED');
  });
});

test('R3-1C: restart-style fresh ArtifactStore objects — zero new backend calls', async () => {
  await withTempRoot(async (dir) => {
    const { backend, calls: getCalls } = (() => {
      const s = countingBackend(TERMINAL_STATE.UNKNOWN_OUTCOME);
      return { backend: s.backend, calls: () => s.calls };
    })();
    const args1 = {
      store: makeStore(dir), taskId: 'task-R31C', taskSlug: 'r3-1c', createdAt: CREATED,
      invocationId: 'inv-r31c', executionId: 'exec-r31c', profileId: 'live1-fake', backend: 'fake',
      actorAlias: 'fake', instructions: 'go', reportBackend: backend, startedAt: CREATED,
    };
    await assert.rejects(runSingleReport(args1));
    assert.equal(getCalls(), 1);

    // "Restart": a FRESH ArtifactStore object (no in-memory state) re-opening
    // the SAME on-disk store root, retrying the SAME invocation.
    const args2 = { ...args1, store: makeStore(dir) };
    await assert.rejects(runSingleReport(args2), (e) => e.code === 'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED');
    assert.equal(getCalls(), 1, 'a fresh-object retry after restart must not call the backend again');
  });
});

test('R3-1D: known-failure and sealed-success behaviour stay correct', async () => {
  // Sealed-success (unaffected happy path).
  await withTempRoot(async (dir) => {
    const out = await runSingleReport({
      store: makeStore(dir), taskId: 'task-R31D-OK', taskSlug: 'ok', createdAt: CREATED,
      invocationId: 'inv-r31d-ok', executionId: 'exec-ok', profileId: 'live1-fake', backend: 'fake',
      actorAlias: 'fake', instructions: 'go', reportBackend: fakeReportBackend({ text: '# ok\n' }), startedAt: CREATED,
    });
    assert.equal(out.unsealedCandidate.lifecycle, 'DELIVERED');
  });

  // A KNOWN terminal failure (TIMEOUT) settles durably to FAILED, and — per
  // requirement #4 — a known terminal FAILED invocation never silently
  // re-executes either, not only an UNKNOWN outcome.
  await withTempRoot(async (dir) => {
    const { backend, calls: getCalls } = (() => {
      const s = countingBackend(TERMINAL_STATE.TIMEOUT, { timedOut: true });
      return { backend: s.backend, calls: () => s.calls };
    })();
    const args = {
      store: makeStore(dir), taskId: 'task-R31D-FAIL', taskSlug: 'fail', createdAt: CREATED,
      invocationId: 'inv-r31d-fail', executionId: 'exec-fail', profileId: 'live1-fake', backend: 'fake',
      actorAlias: 'fake', instructions: 'go', reportBackend: backend, startedAt: CREATED,
    };
    await assert.rejects(runSingleReport(args), (e) => e.terminalState === 'TIMEOUT');
    assert.equal(getCalls(), 1);

    const task = args.store.openTaskById('task-R31D-FAIL');
    const inv = task.openInvocationById('inv-r31d-fail');
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.equal(rec.lifecycle, 'FAILED');
    assert.equal(rec.integrity_state, 'EXECUTION_FAILED');
    assert.equal(rec.active_execution_claim, null, 'claim is cleared once settled');

    await assert.rejects(runSingleReport(args), (e) => e.code === 'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED');
    assert.equal(getCalls(), 1, 'a known terminal FAILED invocation must never silently re-execute');
  });
});
