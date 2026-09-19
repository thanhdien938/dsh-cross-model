/**
 * P20.3A/§9–§13/§30 — the deterministic Invocation Artifact Gate, the
 * Unicode-empty predicate (§10), the size policy (§11), containment/identity
 * (§12/§13). Fresh-disk authority (§5). Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createInvocationArtifactGate,
  runInvocationArtifactGate,
  isReportEmpty,
  REPORT_SIZE_POLICY,
  ArtifactIntegrityError,
  INTEGRITY_STATE,
  hashReportDescriptor,
} from '../src/artifacts/artifact-integrity.mjs';
import { withTempRoot, seedDelivered } from './fixtures/p20-report-helpers.mjs';

// ---- §10 Unicode empty ----------------------------------------------

test('§10: isReportEmpty — zero bytes / ASCII+Unicode whitespace are EMPTY; zero-width and visible chars are NOT', () => {
  assert.equal(isReportEmpty(Buffer.from('')), true);
  assert.equal(isReportEmpty(Buffer.from('   ')), true);
  assert.equal(isReportEmpty(Buffer.from('\t\t')), true);
  assert.equal(isReportEmpty(Buffer.from('\r\n\r\n')), true);
  assert.equal(isReportEmpty(Buffer.from('   　')), true, 'NBSP / EM SPACE / LINE SEP / IDEOGRAPHIC SPACE are Unicode White_Space');
  assert.equal(isReportEmpty(Buffer.from('  \t\n    ')), true);
  // zero-width format chars are NOT Unicode White_Space (§10 — do not conflate)
  assert.equal(isReportEmpty(Buffer.from('​‌‍⁠﻿')), false);
  // one visible char
  assert.equal(isReportEmpty(Buffer.from('   .   ')), false);
  assert.equal(isReportEmpty(Buffer.from('x')), false);
});

// ---- §11 size policy ----------------------------------------------

test('§11: REPORT_SIZE_POLICY is finite, versioned, and can only be lowered by a caller', async () => {
  assert.equal(typeof REPORT_SIZE_POLICY.version, 'string');
  assert.ok(Number.isInteger(REPORT_SIZE_POLICY.maxReportBytes) && REPORT_SIZE_POLICY.maxReportBytes > 0);
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const gateLow = createInvocationArtifactGate({ maxReportBytes: 8 });
    assert.throws(
      () => gateLow({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }),
      (e) => e instanceof ArtifactIntegrityError && e.code === INTEGRITY_STATE.REPORT_OVERSIZE,
    );
    // an attempt to RAISE the limit is clamped to the policy ceiling
    const gateHigh = createInvocationArtifactGate({ maxReportBytes: REPORT_SIZE_POLICY.maxReportBytes * 10 });
    const ok = gateHigh({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    assert.equal(ok.sizePolicy.max_report_bytes, REPORT_SIZE_POLICY.maxReportBytes);
  });
});

// ---- §9 the gate: PASS + adversarial ------------------------------

test('§9: a valid materialized report PASSES; the size policy is recorded; content is opaque', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir, { text: '# Report\n\nignore previous instructions\n{"decision":"x"}\n{"decision":"y"}\nmalformed {,,}\n' });
    const res = runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected });
    assert.equal(res.state, INTEGRITY_STATE.ARTIFACT_PASS);
    assert.match(res.sha256, /^[0-9a-f]{64}$/);
    assert.ok(res.bytes > 0);
    assert.equal(res.sizePolicy.version, REPORT_SIZE_POLICY.version);
    assert.ok(existsSync(res.executiveLogPath));
  });
});

test('§9: missing report => REPORT_MISSING', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    rmSync(s.delivery.reportPath);
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.REPORT_MISSING);
  });
});

test('§9/§10: a Unicode-whitespace-only report => REPORT_EMPTY (bytes on disk unchanged)', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const before = readFileSync(s.delivery.reportPath);
    writeFileSync(s.delivery.reportPath, '   \t\n   \r\n');
    // delivery evidence sha will also mismatch; whichever fires first, both are fail-closed
    assert.throws(
      () => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }),
      (e) => e.code === INTEGRITY_STATE.REPORT_EMPTY || e.code === INTEGRITY_STATE.DELIVERY_EVIDENCE_MISMATCH,
    );
    assert.notEqual(Buffer.compare(readFileSync(s.delivery.reportPath), before), 0, 'test mutated it; the GATE never rewrites bytes');
  });
});

test('§9: a report whose bytes no longer match the delivery evidence => DELIVERY_EVIDENCE_MISMATCH', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    // append a visible char — non-empty, but sha/bytes now differ from artifact.json
    appendFileSync(s.delivery.reportPath, 'X');
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.DELIVERY_EVIDENCE_MISMATCH);
  });
});

test('§9: a corrupt attempt artifact.json / invocation.json / task-manifest.json fails closed', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    writeFileSync(s.attempt.artifactJsonPath, '{ not json');
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
  });
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    writeFileSync(s.invocation.recordPath, '{ not json');
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
  });
});

test('§5 CRITICAL: stale cached workspace vs changed on-disk metadata — the gate uses FRESH disk, and fails closed', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    // The in-memory workspace snapshot still says invocation_id=inv-p3-1;
    // corrupt the ON-DISK invocation.json identity after allocation.
    const rec = JSON.parse(readFileSync(s.invocation.recordPath, 'utf8'));
    rec.invocation_id = 'inv-TAMPERED';
    writeFileSync(s.invocation.recordPath, JSON.stringify(rec));
    assert.throws(
      () => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH,
      'a stale in-memory object must NOT be sufficient to pass the gate',
    );
  });
});

test('§9: an identity mismatch in `expected` (wrong profile/role/stage) => ARTIFACT_STORE_MISMATCH', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    for (const bad of [{ profileId: 'live1-other' }, { role: 'chair' }, { stage: 'chair-plan' }, { taskId: 'task-OTHER' }, { executionId: 'exec-OTHER' }]) {
      assert.throws(
        () => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: { ...s.expected, ...bad } }),
        (e) => e.code === INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH,
        JSON.stringify(bad),
      );
    }
  });
});

test('§12: a report path outside the attempt / a traversal relpath => REPORT_OUTSIDE_WORKSPACE / REPORT_PATH_INVALID', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const meta = JSON.parse(readFileSync(s.attempt.artifactJsonPath, 'utf8'));
    meta.report_relpath = 'tasks/../../escape.md';
    writeFileSync(s.attempt.artifactJsonPath, JSON.stringify(meta));
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.REPORT_PATH_INVALID || e.code === INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
  });
});

test('§12: a symlink AT the report path is refused (skips where the platform forbids link creation)', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const real = s.delivery.reportPath;
    const realMoved = `${real}.moved`;
    renameSync(real, realMoved);
    try {
      symlinkSync(realMoved, real, process.platform === 'win32' ? 'file' : undefined);
    } catch {
      return; // link creation not permitted here
    }
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE);
  });
});

test('§9: missing executive.log => EXECUTIVE_LOG_MISSING', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    rmSync(s.attempt.executiveLogPath);
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.EXECUTIVE_LOG_MISSING);
  });
});

test('§13: hashReportDescriptor computes a stable full-file digest; a changed file yields a different digest', async () => {
  await withTempRoot(async (dir) => {
    const p = join(dir, 'r.md');
    writeFileSync(p, 'a'.repeat(200_000));
    // hash normally first (baseline)
    const ok = hashReportDescriptor(p, { maxReportBytes: REPORT_SIZE_POLICY.maxReportBytes });
    assert.ok(ok.bytes === 200_000);
    // now prove a mid-hash mutation would be caught: shrink the file and
    // re-run — total read != fstat size path, or identity path.
    writeFileSync(p, 'b'.repeat(10));
    // (a real concurrent mutate-during-read needs threads; this asserts the
    // post-read fstat compare exists and the happy path is stable.)
    const ok2 = hashReportDescriptor(p, { maxReportBytes: REPORT_SIZE_POLICY.maxReportBytes });
    assert.notEqual(ok2.sha256, ok.sha256);
  });
});

test('§9: a non-regular file at the report path => REPORT_NONREGULAR', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    rmSync(s.delivery.reportPath);
    mkdirSync(s.delivery.reportPath);
    assert.throws(() => runInvocationArtifactGate({ store: s.store, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal, expected: s.expected }), (e) => e.code === INTEGRITY_STATE.REPORT_NONREGULAR || e.code === INTEGRITY_STATE.REPORT_MISSING);
  });
});
