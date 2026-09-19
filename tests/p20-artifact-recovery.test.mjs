/**
 * P20.3 §21/§22/§32 — durable FAILED/CANCELLED reconciliation, crash/restart
 * recovery from DISK (independent store/workspace reopen), idempotent
 * resumption, unknown-outcome-not-replayed, post-seal drift blocks consumer.
 * Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { INTEGRITY_STATE } from '../src/artifacts/artifact-integrity.mjs';
import {
  reconcileFailedInvocation,
  resumeSingleTaskFromDisk,
  verifySealedArtifactReference,
  runTaskFinalArtifactGate,
  commitInvocationSeal,
  ArtifactRecoveryError,
} from '../src/artifacts/artifact-recovery.mjs';
import { runInvocationArtifactGate } from '../src/artifacts/artifact-integrity.mjs';
import { completeSingleReportArtifact } from '../src/pm/single-report-completion.mjs';
import { withTempRoot, seedDelivered, makeStore } from './fixtures/p20-report-helpers.mjs';

function reopenInvocation(dir, expected) {
  const store = makeStore(dir);
  const task = store.openTaskById(expected.taskId);
  const invocation = task.allocateInvocation({
    invocationId: expected.invocationId, role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE,
    profileId: expected.profileId, actorAlias: expected.actorAlias,
  });
  return { store, task, invocation };
}

// ---- §21 durable failure / cancellation ---------------------------

test('§21: a known TIMEOUT/PROVIDER_ERROR settles the invocation to FAILED; CANCELLED settles to CANCELLED; evidence preserved; no seal', async () => {
  for (const [ts, lifecycle] of [['TIMEOUT', 'FAILED'], ['PROVIDER_ERROR', 'FAILED'], ['PROCESS_ERROR', 'FAILED'], ['CANCELLED', 'CANCELLED']]) {
    // eslint-disable-next-line no-await-in-loop
    await withTempRoot(async (dir) => {
      const s = await seedDelivered(dir);
      const r = reconcileFailedInvocation({ invocation: s.invocation, terminalState: ts, reason: `test ${ts}` });
      assert.equal(r.lifecycle, lifecycle);
      assert.equal(r.authoritative_attempt, null);
      assert.ok(r.integrity_state);
      // attempt evidence still there
      assert.ok(readFileSync(s.attempt.artifactJsonPath, 'utf8').length > 0);
      // idempotent
      const r2 = reconcileFailedInvocation({ invocation: s.invocation, terminalState: ts });
      assert.equal(r2.lifecycle, lifecycle);
    });
  }
});

test('§21: UNKNOWN_OUTCOME is NOT auto-replayed — it settles to a durable FAILED tagged UNKNOWN_PROVIDER_OUTCOME with replay:false', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const r = reconcileFailedInvocation({ invocation: s.invocation, terminalState: 'UNKNOWN_OUTCOME' });
    assert.equal(r.lifecycle, 'FAILED');
    assert.equal(r.integrity_state, INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME);
    assert.equal(r.replay, false);
  });
});

test('§21: settle() refuses to un-seal a SEALED invocation', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    await completeSingleReportArtifact({ store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    assert.throws(() => reconcileFailedInvocation({ invocation: s.invocation, terminalState: 'TIMEOUT' }), (e) => e.code === 'ARTIFACT_SEAL_CONFLICT');
  });
});

// ---- §22 / §32 crash + restart recovery from disk ---------------

test('§32: an UNSEALED attempt is never authority — reopening from disk does not fabricate a final_ref', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir); // DELIVERED, not sealed
    const re = reopenInvocation(dir, s.expected);
    const res = resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocation: re.invocation });
    assert.equal(res.action, 'NONE');
    assert.equal(res.finalRef, null);
    assert.equal(JSON.parse(readFileSync(re.task.manifestPath, 'utf8')).final_ref, null);
  });
});

test('§32 (crash point E): SEALED invocation but task-manifest not finalized => restart FINALIZES from the sealed authority, no model replay; idempotent', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    // Seal the invocation directly (simulating a crash right after the
    // invocation seal, before the task manifest final-ref commit).
    const gate = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    // finalize exec log + artifact.json + seal, but DO NOT touch the manifest.
    const { finalizeReportExecutiveLog } = await import('../src/artifacts/report-executive-log.mjs');
    finalizeReportExecutiveLog({ logPath: gate.executiveLogPath, finalization: { integrity_state: 'ARTIFACT_PASS', final_report_bytes: gate.bytes, final_report_sha256: gate.sha256, seal_version: 'p20.3-1' } });
    // P20.3R R7: the seal order marker — executive.log finalized FIRST, then
    // the attempt is finalized with a `finalized_at` + `executive_log_finalized`
    // marker; commitSeal fresh-reads and enforces both.
    s.invocation.finalizeAttempt(s.attempt.ordinal, { integrity_state: 'ARTIFACT_PASS', report_bytes: gate.bytes, report_sha256: gate.sha256, terminal_state: 'SUCCESS', finished_at: '2026-09-10T10:00:05Z', finalized_at: '2026-09-10T10:00:06Z', executive_log_finalized: true });
    s.invocation.commitSeal({ ordinal: s.attempt.ordinal, sealVersion: 'p20.3-1', sealedAt: '2026-09-10T10:00:07Z' });
    assert.equal(JSON.parse(readFileSync(s.task.manifestPath, 'utf8')).final_ref, null, 'manifest not yet finalized (crash point E)');

    // Restart: fresh store/workspace objects from disk.
    const re = reopenInvocation(dir, s.expected);
    const r1 = resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocation: re.invocation });
    assert.equal(r1.action, 'FINALIZED_FROM_SEAL');
    const m1 = JSON.parse(readFileSync(re.task.manifestPath, 'utf8'));
    assert.equal(m1.task_state, 'COMPLETED');
    assert.ok(m1.final_ref && m1.final_ref.sha256 === gate.sha256);

    // Restart AGAIN — idempotent, same final_ref.
    const re2 = reopenInvocation(dir, s.expected);
    const r2 = resumeSingleTaskFromDisk({ store: re2.store, task: re2.task, invocation: re2.invocation });
    assert.equal(r2.action, 'ALREADY_COMPLETE');
    assert.deepEqual(JSON.parse(readFileSync(re2.task.manifestPath, 'utf8')).final_ref, m1.final_ref);
  });
});

test('§32: exactly ONE authoritative_attempt — commitSeal is idempotent for the same ordinal and conflicts for a different one', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const gate = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    const { finalizeReportExecutiveLog } = await import('../src/artifacts/report-executive-log.mjs');
    finalizeReportExecutiveLog({ logPath: gate.executiveLogPath, finalization: { integrity_state: 'ARTIFACT_PASS' } });
    s.invocation.finalizeAttempt(0, { integrity_state: 'ARTIFACT_PASS', report_bytes: gate.bytes, report_sha256: gate.sha256, terminal_state: 'SUCCESS', finalized_at: '2026-09-10T10:00:06Z', executive_log_finalized: true });
    const a = s.invocation.commitSeal({ ordinal: 0, sealVersion: 'p20.3-1' });
    const b = s.invocation.commitSeal({ ordinal: 0, sealVersion: 'p20.3-1' });
    assert.equal(a.authoritative_attempt, 0);
    assert.equal(b.authoritative_attempt, 0);
    assert.throws(() => s.invocation.commitSeal({ ordinal: 1, sealVersion: 'p20.3-1' }), (e) => e.code === 'ARTIFACT_SEAL_CONFLICT');
  });
});

test('§32: post-seal hash drift blocks the consumer revalidation primitive', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const out = await completeSingleReportArtifact({ store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    // verify OK first
    const v = verifySealedArtifactReference({ store: s.store, reference: out.finalRef, invocation: s.invocation });
    assert.equal(v.verified, true);
    // drift the sealed report bytes
    appendFileSync(s.delivery.reportPath, ' drift');
    const re = reopenInvocation(dir, s.expected);
    assert.throws(
      () => verifySealedArtifactReference({ store: re.store, reference: out.finalRef, invocation: re.invocation }),
      (e) => e instanceof ArtifactRecoveryError && e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED',
    );
    // and the Task Final Artifact Gate would also fail closed on a fresh run
    assert.throws(() => runTaskFinalArtifactGate({ store: re.store, task: re.task, invocation: re.invocation }), (e) => e.code === INTEGRITY_STATE.REPORT_HASH_FAILED || e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED');
  });
});

test('§24: final task completion cannot precede seal — runTaskFinalArtifactGate refuses a DELIVERED (unsealed) invocation', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    assert.throws(
      () => runTaskFinalArtifactGate({ store: s.store, task: s.task, invocation: s.invocation }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
    assert.equal(JSON.parse(readFileSync(s.task.manifestPath, 'utf8')).task_state, 'OPEN');
  });
});

test('§16: commitInvocationSeal requires a PASSED gate result', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    assert.throws(
      () => commitInvocationSeal({ store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: 0, gateResult: { state: 'NOPE' }, stageKey: 'single' }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
  });
});
