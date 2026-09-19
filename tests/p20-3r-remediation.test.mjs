/**
 * P20.3R — bounded remediation focused tests (R1–R8 + repair candidate
 * containment). Offline; NO live model calls. These prove the authority /
 * repair / containment / recovery gaps closed before P20.4 reuses the same
 * primitives for Council.
 *
 * Authority: docs/P20/P20_3R_SONNET_REMEDIATION_MASTER_PROMPT.md §4–§14.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { completeSingleReportArtifact } from '../src/pm/single-report-completion.mjs';
import {
  reconcileFailedInvocation,
  resumeSingleTaskFromDisk,
  verifySealedArtifactReference,
  runTaskFinalArtifactGate,
} from '../src/artifacts/artifact-recovery.mjs';
import {
  runInvocationArtifactGate,
  INTEGRITY_STATE,
  ArtifactIntegrityError,
  isReportEmpty,
} from '../src/artifacts/artifact-integrity.mjs';
import {
  classifyRepair,
  findMisplacedReportCandidates,
  relocateMisplacedReport,
} from '../src/artifacts/artifact-repair.mjs';
import {
  isWithin,
  isWithinReal,
  realCanonical,
  sameLexicalPath,
  PathIdentityError,
} from '../src/artifacts/artifact-path-identity.mjs';
import {
  buildInvocationRecord,
  validateInvocationRecord,
  INVOCATION_LIFECYCLE,
} from '../src/artifacts/artifact-schema.mjs';
import { finalizeReportExecutiveLog } from '../src/artifacts/report-executive-log.mjs';
import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { withTempRoot, makeStore, seedDelivered, reopenFromDisk, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const WIN = process.platform === 'win32';

/** A counting wrapper so a test can assert the repair backend was NEVER called. */
function spyBackend(inner) {
  const b = inner ?? fakeReportBackend({ text: '# repaired body\n\nok\n' });
  let calls = 0;
  return {
    get calls() { return calls; },
    async runReport(a) { calls += 1; return b.runReport(a); },
  };
}

const SINGLE = (store, over = {}) => ({
  store, taskId: over.taskId ?? 'task-R3R0001', taskSlug: 'p20.3r', createdAt: '2026-09-10T10:00:00Z',
  invocationId: over.invocationId ?? 'inv-r3r-1', executionId: over.executionId ?? 'exec-r3r-1',
  profileId: 'live1-fake', backend: 'fake', actorAlias: 'fake',
  instructions: 'go', reportBackend: over.reportBackend ?? fakeReportBackend({ text: '# report\n\nbody\n' }),
  startedAt: '2026-09-10T10:00:00Z', complete: true, ...over,
});

// ===================================================================
// R1 — TERMINAL TRUTH BEFORE ANY REPAIRABLE FILE FAILURE
// ===================================================================

test('R1: a settled non-success invocation + missing/empty report NEVER invokes a repair backend', async () => {
  for (const [terminalState, expectCode] of [
    ['TIMEOUT', INTEGRITY_STATE.EXECUTION_FAILED],
    ['PROVIDER_ERROR', INTEGRITY_STATE.EXECUTION_FAILED],
    ['CANCELLED', INTEGRITY_STATE.TASK_CANCELLED],
    ['UNKNOWN_OUTCOME', INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withTempRoot(async (dir) => {
      const s = await seedDelivered(dir);
      // the report is gone AND the execution is a known non-success
      writeFileSync(s.delivery.reportPath, ''); // 0 bytes -> would look like REPORT_EMPTY
      reconcileFailedInvocation({ invocation: s.invocation, terminalState });

      const spy = spyBackend();
      await assert.rejects(
        completeSingleReportArtifact({
          store: s.store, task: s.task, invocation: s.invocation,
          attemptOrdinal: s.attempt.ordinal, expected: s.expected, reportBackend: spy,
        }),
        (e) => e.code === expectCode || e.cause === expectCode,
        `terminalState=${terminalState}`,
      );
      assert.equal(spy.calls, 0, `no repair backend call for terminalState=${terminalState}`);
    });
  }
});

test('R1: a null terminal_state on a would-be-delivered attempt fails the gate closed (never accepted because a file exists)', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const metaPath = s.attempt.artifactJsonPath;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    delete meta.terminal_state;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const spy = spyBackend();
    await assert.rejects(
      completeSingleReportArtifact({
        store: s.store, task: s.task, invocation: s.invocation,
        attemptOrdinal: s.attempt.ordinal, expected: s.expected, reportBackend: spy,
      }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_METADATA_INVALID || e.cause === INTEGRITY_STATE.ARTIFACT_METADATA_INVALID,
    );
    assert.equal(spy.calls, 0);
  });
});

test('R1: a RUNNING invocation with a SUCCESS-looking attempt on disk cannot pass the Invocation Artifact Gate', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    // baseline: DELIVERED + SUCCESS passes
    assert.equal(
      runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }).state,
      INTEGRITY_STATE.ARTIFACT_PASS,
    );
    // rewind lifecycle to RUNNING on disk (crash / inconsistent state)
    const rec = JSON.parse(readFileSync(s.invocation.recordPath, 'utf8'));
    rec.lifecycle = 'RUNNING';
    writeFileSync(s.invocation.recordPath, `${JSON.stringify(rec, null, 2)}\n`);

    const re = reopenFromDisk(dir, { taskId: s.expected.taskId });
    const inv = re.task.openInvocationById(s.expected.invocationId);
    assert.throws(
      () => runInvocationArtifactGate({ store: re.store, invocation: inv, attemptOrdinal: s.attempt.ordinal, expected: s.expected }),
      (e) => e instanceof ArtifactIntegrityError
        && e.code !== INTEGRITY_STATE.ARTIFACT_PASS
        && [INTEGRITY_STATE.EXECUTION_FAILED, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID].includes(e.code),
    );
  });
});

test('R1: classifyRepair only treats REPORT_MISSING / REPORT_EMPTY as repair triggers', () => {
  const mk = (code) => new ArtifactIntegrityError('x', code);
  for (const code of [
    INTEGRITY_STATE.EXECUTION_FAILED, INTEGRITY_STATE.TASK_CANCELLED, INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME,
    INTEGRITY_STATE.REPORT_HASH_FAILED, INTEGRITY_STATE.REPORT_OVERSIZE, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID,
  ]) {
    assert.equal(classifyRepair(mk(code), []).action, 'NONE', code);
    assert.equal(classifyRepair(mk(code), ['/x/one.md']).action, 'NONE', code);
  }
});

// ===================================================================
// R2 — REPAIR PRESERVES P20.2R IDENTITY + CAPABILITY SAFETY
// ===================================================================

/** Truncate the seeded official report to 0 bytes so the gate emits REPORT_EMPTY -> Case B delivery repair. */
async function seedEmptyOfficialReport(dir, over = {}) {
  const s = await seedDelivered(dir, over);
  writeFileSync(s.delivery.reportPath, '');
  return s;
}

test('R2: a repair backend result from a different backend fails closed BEFORE any bytes are written', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedEmptyOfficialReport(dir);
    const wrong = spyBackend(fakeReportBackend({ text: '# body\n', overrideBinding: { backend: 'not-fake' } }));
    await assert.rejects(
      completeSingleReportArtifact({
        store: s.store, task: s.task, invocation: s.invocation,
        attemptOrdinal: s.attempt.ordinal, expected: s.expected,
        reportBackend: wrong, capabilityPolicy: undefined,
      }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED,
    );
    // no attempt-01 report materialized
    assert.equal(existsSync(join(s.attempt.path, '..', 'attempt-01', 'report.md')), false);
  });
});

test('R2: a repair backend result with a wrong profile_id or wrong execution_id fails closed', async () => {
  for (const bad of [{ profileId: 'other-profile' }, { executionId: 'exec-attacker' }]) {
    // eslint-disable-next-line no-await-in-loop
    await withTempRoot(async (dir) => {
      const s = await seedEmptyOfficialReport(dir);
      const wrong = spyBackend(fakeReportBackend({ text: '# body\n', overrideBinding: bad }));
      await assert.rejects(
        completeSingleReportArtifact({
          store: s.store, task: s.task, invocation: s.invocation,
          attemptOrdinal: s.attempt.ordinal, expected: s.expected, reportBackend: wrong,
        }),
        (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED,
        JSON.stringify(bad),
      );
    });
  }
});

test('R2: a repair delivery route that is UNPROVEN under the admitted capabilityPolicy stays disabled for a repair', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedEmptyOfficialReport(dir);
    // admitted policy where the fake backend materialization is UNPROVEN
    const unproven = {
      backends: {
        fake: {
          report_delivery: { VERBATIM_MATERIALIZATION: 'UNPROVEN', DIRECT_WRITE: 'UNPROVEN' },
          artifact_input: {},
        },
      },
    };
    const spy = spyBackend();
    await assert.rejects(
      completeSingleReportArtifact({
        store: s.store, task: s.task, invocation: s.invocation,
        attemptOrdinal: s.attempt.ordinal, expected: s.expected,
        reportBackend: spy, capabilityPolicy: unproven,
      }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED,
    );
    assert.equal(spy.calls, 0, 'the UNPROVEN route must be rejected before the backend is invoked');
  });
});

test('R2: a well-formed repair (same invocation / profile / backend, new execution_id) completes and its persisted identity matches', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedEmptyOfficialReport(dir);
    const spy = spyBackend(fakeReportBackend({ text: '# recovered report\n\ncomplete body\n' }));
    const out = await completeSingleReportArtifact({
      store: s.store, task: s.task, invocation: s.invocation,
      attemptOrdinal: s.attempt.ordinal, expected: s.expected, reportBackend: spy,
    });
    assert.equal(spy.calls, 1);
    assert.equal(out.integrity, INTEGRITY_STATE.ARTIFACT_PASS);
    assert.equal(out.repaired, true);
    assert.equal(out.sealedAttemptOrdinal, 1);
    // persisted repair attempt identity
    const meta1 = JSON.parse(readFileSync(join(s.attempt.path, '..', 'attempt-01', 'artifact.json'), 'utf8'));
    assert.equal(meta1.invocation_id, s.expected.invocationId);
    assert.equal(meta1.profile_id, s.expected.profileId);
    assert.equal(Number.isInteger(meta1.repair_of), true);
    // original empty attempt-00 evidence preserved (still 0 bytes)
    assert.equal(readFileSync(s.delivery.reportPath, 'utf8').length, 0);
  });
});

// ===================================================================
// R3 — CANONICAL UNICODE EMPTY SEMANTICS IN REPAIR
// ===================================================================

test('R3: isReportEmpty follows the frozen predicate, NOT JavaScript trim()', () => {
  // JS trim() strips U+FEFF; the frozen predicate does not treat it as White_Space.
  assert.equal('\uFEFF'.trim(), '');
  assert.equal(isReportEmpty(Buffer.from('\uFEFF', 'utf8')), false);
  assert.equal(isReportEmpty(Buffer.from('\u200B\u200C\u200D', 'utf8')), false);
  // genuine emptiness
  assert.equal(isReportEmpty(Buffer.alloc(0)), true);
  assert.equal(isReportEmpty(Buffer.from('   \n\t\r\n \u00a0', 'utf8')), true);
});

test('R3: REPORT_EMPTY is ALWAYS a bounded new delivery repair — a stray candidate never overwrites the empty official path', () => {
  const mk = (code) => new ArtifactIntegrityError('x', code);
  for (const candidates of [[], ['/x/one.md'], ['/x/one.md', '/x/two.md']]) {
    const plan = classifyRepair(mk(INTEGRITY_STATE.REPORT_EMPTY), candidates);
    assert.equal(plan.case, 'B');
    assert.equal(plan.action, 'DELIVERY_REPAIR');
  }
  // REPORT_MISSING keeps the 0/1/2+ mapping
  assert.equal(classifyRepair(mk(INTEGRITY_STATE.REPORT_MISSING), ['/x/one.md']).action, 'RELOCATE');
});

test('R3: REPORT_EMPTY -> one bounded repair; a second empty result -> ARTIFACT_REPAIR_FAILED with no recursion', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedEmptyOfficialReport(dir);
    const stillEmpty = spyBackend(fakeReportBackend({ text: '   \n\t  \n' })); // Unicode-whitespace only -> isReportEmpty(), not a report
    await assert.rejects(
      completeSingleReportArtifact({
        store: s.store, task: s.task, invocation: s.invocation,
        attemptOrdinal: s.attempt.ordinal, expected: s.expected, reportBackend: stillEmpty,
      }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED,
    );
    // at most ONE repair attempt was allocated
    assert.equal(existsSync(join(s.attempt.path, '..', 'attempt-02')), false);
  });
});

// ===================================================================
// R4 — SEALED CONSUMER PREFLIGHT BINDS FULL AUTHORITY
// ===================================================================

async function sealOne(dir, over = {}) {
  const store = makeStore(dir);
  const out = await runSingleReport(SINGLE(store, over));
  const manifest = JSON.parse(readFileSync(out.task.manifestPath, 'utf8'));
  return { store, out, finalRef: manifest.final_ref, manifest };
}

test('R4: adversarial mutations of a sealed ArtifactReference all fail closed', async () => {
  await withTempRoot(async (dir) => {
    const { store, finalRef } = await sealOne(dir);
    // sanity: the untouched sealed ref verifies
    assert.equal(verifySealedArtifactReference({ store, reference: finalRef }).verified, true);

    const cases = {
      'task_id changed': { ...finalRef, task_id: 'task-OTHERXX' },
      'invocation_id changed': { ...finalRef, invocation_id: 'inv-not-real' },
      'attempt_ordinal non-authoritative': { ...finalRef, attempt_ordinal: 7 },
      'artifact_relpath repointed': { ...finalRef, artifact_relpath: 'store.json' },
      'sha256 changed': { ...finalRef, sha256: 'f'.repeat(64) },
      'bytes changed': { ...finalRef, bytes: (finalRef.bytes ?? 0) + 1 },
    };
    for (const [label, reference] of Object.entries(cases)) {
      assert.throws(
        () => verifySealedArtifactReference({ store, reference }),
        (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED',
        label,
      );
    }
  });
});

test('R4: a caller-supplied invocation object cannot substitute for authority resolution — an UNSEALED reference still fails', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir); // DELIVERED, never sealed
    // hand-craft a "sealed-looking" reference for the delivered attempt
    const meta = JSON.parse(readFileSync(s.attempt.artifactJsonPath, 'utf8'));
    const forged = {
      schema_version: 'p20-artifact-1', kind: 'ArtifactReference', sealed: true,
      store_id: s.expected.storeId, project_id: s.expected.projectId,
      task_id: s.expected.taskId, invocation_id: s.expected.invocationId,
      attempt_ordinal: 0, artifact_relpath: meta.report_relpath,
      sha256: meta.report_sha256 ?? 'a'.repeat(64), bytes: meta.report_bytes ?? 1,
      sealed_at: '2026-09-10T10:00:09.000Z',
    };
    assert.throws(
      // even passing the real invocation object as a hint must not bypass SEALED/authoritative checks
      () => verifySealedArtifactReference({ store: s.store, reference: forged, invocation: s.invocation }),
      (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED',
    );
  });
});

test('R4: a post-seal symlink/reparse replacement of the sealed report fails the consumer verifier closed', async (t) => {
  await withTempRoot(async (dir) => {
    const { store, finalRef, out } = await sealOne(dir);
    const reportAbs = resolve(store.root, ...String(finalRef.artifact_relpath).split('/'));
    const outside = join(dir, 'evil.md');
    writeFileSync(outside, readFileSync(reportAbs)); // identical bytes, different location
    try {
      writeFileSync(reportAbs, ''); // remove original content path
    } catch { /* ignore */ }
    let linked = false;
    try {
      const { rmSync } = await import('node:fs');
      rmSync(reportAbs, { force: true });
      symlinkSync(outside, reportAbs);
      linked = true;
    } catch {
      t.skip('symlink not permitted on this platform/user');
      return;
    }
    if (linked) {
      assert.throws(
        () => verifySealedArtifactReference({ store, reference: finalRef }),
        (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED',
      );
    }
    assert.ok(out);
  });
});

// ===================================================================
// R5 — TASK FINAL GATE REUSES THE SAME FULL AUTHORITY CHECK
// ===================================================================

test('R5: runTaskFinalArtifactGate rejects a stage sealed_ref that belongs to another task', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const a = await runSingleReport(SINGLE(store, { taskId: 'task-AAAA0001', invocationId: 'inv-a-1', executionId: 'exec-a-1' }));
    const b = await runSingleReport(SINGLE(store, { taskId: 'task-BBBB0001', invocationId: 'inv-b-1', executionId: 'exec-b-1' }));
    const bManifest = JSON.parse(readFileSync(b.task.manifestPath, 'utf8'));

    // Corrupt task A's stage entry to point at task B's sealed ref.
    const aManifestPath = a.task.manifestPath;
    const aManifest = JSON.parse(readFileSync(aManifestPath, 'utf8'));
    aManifest.stages.single.sealed_ref = bManifest.stages.single.sealed_ref;
    writeFileSync(aManifestPath, `${JSON.stringify(aManifest, null, 2)}\n`);

    const re = reopenFromDisk(dir, { taskId: 'task-AAAA0001' });
    assert.throws(
      () => runTaskFinalArtifactGate({ store: re.store, task: re.task, stageKey: 'single' }),
      // P20.3R2 R11: a cross-task stage entry now fails the manifest schema at
      // read time (ARTIFACT_METADATA_INVALID) — a strictly stronger fail-closed
      // than the gate's own boundary check.
      (e) => [INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID].includes(e.code),
    );
  });
});

test('R5: runTaskFinalArtifactGate rejects a stage entry whose invocation_id != sealed_ref.invocation_id', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const a = await runSingleReport(SINGLE(store, { taskId: 'task-CCCC0001', invocationId: 'inv-c-1', executionId: 'exec-c-1' }));
    const p = a.task.manifestPath;
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.stages.single.invocation_id = 'inv-mismatch';
    writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
    const re = reopenFromDisk(dir, { taskId: 'task-CCCC0001' });
    assert.throws(
      () => runTaskFinalArtifactGate({ store: re.store, task: re.task, stageKey: 'single' }),
      // R11: an internally inconsistent stage entry (invocation_id != sealed_ref.invocation_id)
      // now fails the shared stage-entry contract at manifest read time.
      (e) => [INTEGRITY_STATE.ARTIFACT_SEAL_FAILED, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID].includes(e.code),
    );
  });
});

// ===================================================================
// R6 — RESTART RECOVERY RECONSTRUCTS FROM RECORDED SEALED FACTS
// ===================================================================

test('R6: resume after a crash rebuilds final_ref from the RECORDED seal.sealed_at (never new Date())', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const gate = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    finalizeReportExecutiveLog({ logPath: gate.executiveLogPath, finalization: { integrity_state: 'ARTIFACT_PASS', final_report_bytes: gate.bytes, final_report_sha256: gate.sha256, seal_version: 'p20.3-1' } });
    s.invocation.finalizeAttempt(s.attempt.ordinal, {
      integrity_state: 'ARTIFACT_PASS', report_bytes: gate.bytes, report_sha256: gate.sha256,
      terminal_state: 'SUCCESS', finished_at: '2026-09-10T10:00:05Z',
      finalized_at: '2026-09-10T10:00:06Z', executive_log_finalized: true,
    });
    const RECORDED_SEALED_AT = '2026-09-10T10:00:07.000Z';
    s.invocation.commitSeal({ ordinal: s.attempt.ordinal, sealVersion: 'p20.3-1', sealedAt: RECORDED_SEALED_AT });

    const re = reopenFromDisk(dir, { taskId: s.expected.taskId });
    const inv = re.task.openInvocationById(s.expected.invocationId);
    const r = resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocation: inv });
    assert.equal(r.action, 'FINALIZED_FROM_SEAL');
    assert.equal(r.finalRef.sealed_at, RECORDED_SEALED_AT);
    assert.equal(JSON.parse(readFileSync(re.task.manifestPath, 'utf8')).final_ref.sealed_at, RECORDED_SEALED_AT);
  });
});

test('R6: an existing manifest.final_ref is FULL-verified on resume — a drifted sealed report fails closed instead of ALREADY_COMPLETE', async () => {
  await withTempRoot(async (dir) => {
    const { store, finalRef } = await sealOne(dir);
    const reportAbs = resolve(store.root, ...String(finalRef.artifact_relpath).split('/'));
    writeFileSync(reportAbs, `${readFileSync(reportAbs, 'utf8')} drift`); // post-seal mutation

    const re = reopenFromDisk(dir, { taskId: 'task-R3R0001' });
    const inv = re.task.openInvocationById('inv-r3r-1');
    assert.throws(
      () => resumeSingleTaskFromDisk({ store: re.store, task: re.task, invocation: inv }),
      (e) => e.code === 'ARTIFACT_CONSUMER_VERIFY_FAILED' || e.code === INTEGRITY_STATE.REPORT_HASH_FAILED,
    );
  });
});

// ===================================================================
// R7 — SEALED SCHEMA + COMMIT PRECONDITIONS ARE SELF-CONSISTENT
// ===================================================================

function sealedRecordFixture() {
  const r = buildInvocationRecord({
    invocationId: 'inv-7', invocationKey: 'inv-7', storeId: 's1', projectId: 'live1-local',
    taskId: 'task-7777abcd', role: 'single', stage: 'single', profileId: 'pid', actorAlias: 'a',
    stageRelpath: 'tasks/x/single', createdAt: '2026-09-10T08:00:00.000Z',
  });
  r.lifecycle = INVOCATION_LIFECYCLE.SEALED;
  r.attempts = [0];
  r.latest_attempt_ordinal = 0;
  r.authoritative_attempt = 0;
  r.integrity_state = 'ARTIFACT_PASS';
  r.seal = { sealed_at: '2026-09-10T08:10:00.000Z', seal_version: 'p20.3-1', authoritative_attempt: 0, integrity_state: 'ARTIFACT_PASS' };
  return r;
}

test('R7: validateInvocationRecord enforces SEALED self-consistency', () => {
  assert.equal(validateInvocationRecord(sealedRecordFixture()).ok, true);

  const nullAuth = sealedRecordFixture(); nullAuth.authoritative_attempt = null;
  assert.equal(validateInvocationRecord(nullAuth).ok, false, 'SEALED + null authoritative_attempt');

  const noSeal = sealedRecordFixture(); delete noSeal.seal;
  assert.equal(validateInvocationRecord(noSeal).ok, false, 'SEALED + missing seal object');

  const sealMismatch = sealedRecordFixture(); sealMismatch.seal.authoritative_attempt = 1;
  assert.equal(validateInvocationRecord(sealMismatch).ok, false, 'seal ordinal mismatch');

  const absent = sealedRecordFixture(); absent.authoritative_attempt = 3; absent.seal.authoritative_attempt = 3;
  assert.equal(validateInvocationRecord(absent).ok, false, 'authoritative ordinal absent from attempts[]');

  const badParent = sealedRecordFixture(); badParent.integrity_state = 'REPORT_EMPTY';
  assert.equal(validateInvocationRecord(badParent).ok, false, 'parent integrity_state != ARTIFACT_PASS');

  const notSealedButSeal = sealedRecordFixture(); notSealedButSeal.lifecycle = INVOCATION_LIFECYCLE.DELIVERED;
  assert.equal(validateInvocationRecord(notSealedButSeal).ok, false, 'non-SEALED + seal object');
});

test('R7: attempt-history invariants — unique, strictly ascending, latest == max', () => {
  const dup = sealedRecordFixture(); dup.attempts = [0, 0]; dup.latest_attempt_ordinal = 0;
  assert.equal(validateInvocationRecord(dup).ok, false, 'duplicate attempts');
  const desc = sealedRecordFixture(); desc.attempts = [1, 0]; desc.latest_attempt_ordinal = 1; desc.authoritative_attempt = 0; desc.seal.authoritative_attempt = 0;
  assert.equal(validateInvocationRecord(desc).ok, false, 'not ascending');
  const wrongLatest = sealedRecordFixture(); wrongLatest.attempts = [0, 1]; wrongLatest.latest_attempt_ordinal = 0;
  assert.equal(validateInvocationRecord(wrongLatest).ok, false, 'latest != max(attempts)');
});

test('R7: commitSeal cannot become an authority bypass when called directly', async () => {
  // (a) unfinalized attempt -> fail
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    assert.throws(
      () => s.invocation.commitSeal({ ordinal: s.attempt.ordinal, sealVersion: 'p20.3-1' }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
  });
  // (b) terminal_state != SUCCESS -> fail even with finalization markers present
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const gate = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    finalizeReportExecutiveLog({ logPath: gate.executiveLogPath, finalization: { integrity_state: 'ARTIFACT_PASS' } });
    s.invocation.finalizeAttempt(s.attempt.ordinal, {
      integrity_state: 'ARTIFACT_PASS', report_bytes: gate.bytes, report_sha256: gate.sha256,
      terminal_state: 'TIMEOUT', finalized_at: '2026-09-10T10:00:06Z', executive_log_finalized: true,
    });
    assert.throws(
      () => s.invocation.commitSeal({ ordinal: s.attempt.ordinal, sealVersion: 'p20.3-1' }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_SEAL_FAILED,
    );
  });
  // (c) a properly finalized ARTIFACT_PASS / SUCCESS attempt -> seals
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const gate = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    finalizeReportExecutiveLog({ logPath: gate.executiveLogPath, finalization: { integrity_state: 'ARTIFACT_PASS' } });
    s.invocation.finalizeAttempt(s.attempt.ordinal, {
      integrity_state: 'ARTIFACT_PASS', report_bytes: gate.bytes, report_sha256: gate.sha256,
      terminal_state: 'SUCCESS', finalized_at: '2026-09-10T10:00:06Z', executive_log_finalized: true,
    });
    const sealed = s.invocation.commitSeal({ ordinal: s.attempt.ordinal, sealVersion: 'p20.3-1', sealedAt: '2026-09-10T10:00:07Z' });
    assert.equal(sealed.lifecycle, 'SEALED');
    assert.equal(sealed.authoritative_attempt, s.attempt.ordinal);
    assert.equal(sealed.seal.integrity_state, 'ARTIFACT_PASS');
  });
});

// ===================================================================
// R8 — PLATFORM-AWARE CONTAINMENT, NO MANUAL LOWER-CASE AUTHORITY
// ===================================================================

test('R8: isWithin — normal child, sibling-prefix trap, .. escape, cross-drive', () => {
  const root = WIN ? 'C:\\root' : '/root';
  assert.equal(isWithin(root, join(root, 'attempt-00', 'report.md')), true, 'normal child');
  assert.equal(isWithin(root, root), true, 'self');
  assert.equal(isWithin(join(root, 'attempt'), join(root, 'attempt-evil')), false, 'sibling prefix trap');
  assert.equal(isWithin(root, join(root, '..', 'etc', 'passwd')), false, '.. escape');
  assert.equal(isWithin(root, join(root, 'a', '..', '..', 'b')), false, 'traversal that climbs out');
  if (WIN) {
    assert.equal(isWithin('C:\\Root', 'c:\\root\\x'), true, 'win32 drive/case-insensitive');
    assert.equal(isWithin('C:\\root', 'D:\\root\\x'), false, 'cross-drive');
  }
});

test('R8: an unresolvable real path FAILS CLOSED (realCanonical throws PATH_REALPATH_FAILED, never returns the input)', () => {
  const missing = join(WIN ? 'C:\\' : '/', `p20-3r-nonexistent-${Math.random().toString(36).slice(2)}`, 'x');
  assert.throws(() => realCanonical(missing), (e) => e instanceof PathIdentityError && e.code === 'PATH_REALPATH_FAILED');
});

test('R8: sameLexicalPath compares resolved absolutes without realpath (reparse detection primitive)', () => {
  const a = WIN ? 'C:\\root\\a\\..\\b' : '/root/a/../b';
  const b = WIN ? 'C:\\root\\b' : '/root/b';
  assert.equal(sameLexicalPath(a, b), true);
  assert.equal(sameLexicalPath(b, join(b, 'c')), false);
});

test('R8: isWithinReal catches a symlink/junction escape (or fails closed when unresolvable)', async (t) => {
  await withTempRoot(async (dir) => {
    const attemptDir = join(dir, 'store', 'attempt-00');
    mkdirSync(attemptDir, { recursive: true });
    const outsideDir = join(dir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'loot.md'), '# outside\n');
    const link = join(attemptDir, 'link-out');
    try {
      symlinkSync(outsideDir, link, 'junction');
    } catch {
      try { symlinkSync(outsideDir, link); } catch { t.skip('symlink/junction not permitted'); return; }
    }
    assert.equal(isWithin(attemptDir, join(link, 'loot.md')), true, 'lexically it looks contained');
    assert.throws(
      () => { if (!isWithinReal(attemptDir, join(link, 'loot.md'))) throw new Error('escape'); },
      () => true,
      'the REAL path is outside -> rejected / fail closed',
    );
  });
});

// ===================================================================
// REPAIR CANDIDATE CONTAINMENT
// ===================================================================

test('repair containment: relocateMisplacedReport rejects a candidate outside the assigned attempt dir', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const attemptDir = s.attempt.path;
    const outside = join(dir, 'stray.md');
    writeFileSync(outside, '# stray\n');
    assert.throws(
      () => relocateMisplacedReport({ candidatePath: outside, expectedReportPath: join(attemptDir, 'relocated.md'), attemptDir }),
      (e) => e.code === INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE,
    );
  });
});

test('repair containment: findMisplacedReportCandidates never descends a directory symlink/junction out of the attempt', async (t) => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const attemptDir = s.attempt.path;
    const outsideDir = join(dir, 'attacker');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'planted.md'), '# planted body\n');
    const link = join(attemptDir, 'sub-link');
    try {
      symlinkSync(outsideDir, link, 'junction');
    } catch {
      try { symlinkSync(outsideDir, link); } catch { t.skip('symlink/junction not permitted'); return; }
    }
    const found = findMisplacedReportCandidates({ attemptDir, expectedReportName: 'report.md' });
    assert.equal(found.some((p) => p.replace(/\\/g, '/').endsWith('planted.md')), false, 'planted.md behind a symlink must NOT be a candidate');
  });
});
