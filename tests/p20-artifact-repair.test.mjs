/**
 * P20.3C/§18–§20/§31 — bounded, deterministic, non-semantic artifact repair.
 * 0 / 1 / 2+ candidate cases; repair_of linkage; old attempt preserved; no
 * overwrite; no recursion; local I/O retry never calls a model. Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  findMisplacedReportCandidates,
  relocateMisplacedReport,
  classifyRepair,
  assertNotAlreadyRepairAttempt,
  retryLocalMaterialization,
  REPAIR_BOUND,
  ArtifactRepairError,
} from '../src/artifacts/artifact-repair.mjs';
import { ArtifactIntegrityError, INTEGRITY_STATE, runInvocationArtifactGate } from '../src/artifacts/artifact-integrity.mjs';
import { completeSingleReportArtifact } from '../src/pm/single-report-completion.mjs';
import { withTempRoot, seedDelivered, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const err = (code) => new ArtifactIntegrityError('x', code);

test('§18 / P20.3R R3: only REPORT_MISSING uses 0/1/2+ candidate mapping; REPORT_EMPTY ALWAYS bounded delivery repair, never relocation', () => {
  // REPORT_MISSING: 0 -> B (delivery repair), 1 -> A (relocate), 2+ -> C (delivery repair)
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_MISSING), []).case, 'B');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_MISSING), ['/x/one.md']).case, 'A');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_MISSING), ['/x/one.md', '/x/two.md']).case, 'C');

  // R3: an EMPTY official report is a delivery failure, not a "missing file" —
  // it must NEVER be silently overwritten by relocating a stray candidate.
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_EMPTY), []).case, 'B');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_EMPTY), ['/x/one.md']).case, 'B');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_EMPTY), ['/x/one.md', '/x/two.md']).case, 'B');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_EMPTY), ['/x/one.md']).action, 'DELIVERY_REPAIR');

  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_HASH_FAILED), []).action, 'NONE');
  assert.equal(classifyRepair(err(INTEGRITY_STATE.REPORT_OVERSIZE), ['/x/a.md']).action, 'NONE');
  assert.equal(classifyRepair(err('EXECUTION_FAILED'), []).action, 'NONE');
});

test('§18: findMisplacedReportCandidates is non-semantic, bounded, ignores known files + symlinks + oversize', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    const attemptDir = s.attempt.path;
    const expectedName = s.delivery.reportPath.split(/[\\/]/).pop();
    // no misplaced candidate yet
    assert.deepEqual(findMisplacedReportCandidates({ attemptDir, expectedReportName: expectedName }), []);
    // add a plausible misplaced .md, plus decoys the scan must ignore
    writeFileSync(join(attemptDir, 'stray-output.md'), '# a real body\n');
    writeFileSync(join(attemptDir, 'notes.txt'), 'not markdown');
    mkdirSync(join(attemptDir, 'sub'), { recursive: true });
    writeFileSync(join(attemptDir, 'sub', 'deep.md'), '# deep body\n');
    const found = findMisplacedReportCandidates({ attemptDir, expectedReportName: expectedName });
    assert.deepEqual(found.map((p) => p.split(/[\\/]/).pop()).sort(), ['deep.md', 'stray-output.md']);
    // oversize candidate ignored
    writeFileSync(join(attemptDir, 'huge.md'), 'x'.repeat(50));
    assert.equal(findMisplacedReportCandidates({ attemptDir, expectedReportName: expectedName, maxReportBytes: 10 }).some((p) => p.endsWith('huge.md')), false);
  });
});

test('§31 case 1: exactly one misplaced candidate => deterministic exact COPY + full re-gate seals; original preserved', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir, { text: '# will be misplaced\n\nbody\n' });
    // simulate a misplaced delivery: move the real report to a wrong name,
    // and clear the delivery-evidence sha so the gate first sees REPORT_MISSING.
    const stray = join(s.attempt.path, 'model-wrote-here.md');
    require_move(s.delivery.reportPath, stray);
    const meta = JSON.parse(readFileSync(s.attempt.artifactJsonPath, 'utf8'));
    delete meta.report_sha256; delete meta.report_bytes;
    writeFileSync(s.attempt.artifactJsonPath, JSON.stringify(meta, null, 2));

    const out = await completeSingleReportArtifact({
      store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal,
      expected: s.expected, reportBackend: fakeReportBackend({ text: 'unused' }),
    });
    assert.equal(out.repaired, true);
    assert.equal(out.repairKind, 'RELOCATE_MISPLACED');
    assert.equal(out.integrity, INTEGRITY_STATE.ARTIFACT_PASS);
    // original stray candidate preserved as forensic evidence
    assert.ok(existsSync(stray), 'original misplaced candidate must be preserved');
    assert.ok(existsSync(s.delivery.reportPath), 'canonical copy exists at the expected path');
    assert.equal(readFileSync(stray, 'utf8'), readFileSync(s.delivery.reportPath, 'utf8'));
    // sealed at the SAME attempt (relocation is an in-attempt repair, not a new attempt)
    const inv = JSON.parse(readFileSync(s.invocation.recordPath, 'utf8'));
    assert.equal(inv.lifecycle, 'SEALED');
    assert.equal(inv.authoritative_attempt, s.attempt.ordinal);
  });
});

test('§31 case 0: zero candidates => ONE bounded delivery repair in a NEW attempt (repair_of set, old attempt preserved)', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir, { text: '# original\n' });
    // delete the report AND clear delivery evidence -> gate sees REPORT_MISSING, no candidate
    rmSync(s.delivery.reportPath);
    const meta = JSON.parse(readFileSync(s.attempt.artifactJsonPath, 'utf8'));
    delete meta.report_sha256; delete meta.report_bytes;
    writeFileSync(s.attempt.artifactJsonPath, JSON.stringify(meta, null, 2));

    const repairBody = '# REPAIRED complete report\n\nfull body here\n';
    const out = await completeSingleReportArtifact({
      store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal,
      expected: s.expected, reportBackend: fakeReportBackend({ text: repairBody }),
    });
    assert.equal(out.repaired, true);
    assert.equal(out.repairKind, 'DELIVERY_REPAIR_ZERO_CANDIDATE');
    assert.equal(out.sealedAttemptOrdinal, s.attempt.ordinal + 1);
    // new attempt dir with repair_of; old attempt dir preserved
    assert.ok(existsSync(join(s.invocation.path, 'attempt-00')), 'prior attempt preserved');
    const newMeta = JSON.parse(readFileSync(join(s.invocation.path, 'attempt-01', 'artifact.json'), 'utf8'));
    assert.equal(newMeta.repair_of, 0);
    assert.notEqual(newMeta.execution_id, meta.execution_id);
    const inv = JSON.parse(readFileSync(s.invocation.recordPath, 'utf8'));
    assert.equal(inv.lifecycle, 'SEALED');
    assert.equal(inv.authoritative_attempt, 1);
    assert.deepEqual(inv.attempts, [0, 1]);
  });
});

test('§31: no recursive repair — a repair attempt cannot itself be repaired', () => {
  assert.throws(() => assertNotAlreadyRepairAttempt({ repair_of: 0 }), (e) => e instanceof ArtifactRepairError && e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED);
  assert.doesNotThrow(() => assertNotAlreadyRepairAttempt({ repair_of: null }));
});

test('§31: a second integrity failure after one repair => ARTIFACT_REPAIR_FAILED (bounded, no loop)', async () => {
  await withTempRoot(async (dir) => {
    const s = await seedDelivered(dir);
    rmSync(s.delivery.reportPath);
    const meta = JSON.parse(readFileSync(s.attempt.artifactJsonPath, 'utf8'));
    delete meta.report_sha256; delete meta.report_bytes;
    writeFileSync(s.attempt.artifactJsonPath, JSON.stringify(meta, null, 2));
    // repair backend that also produces nothing usable (empty body) -> repair fails, bounded
    await assert.rejects(
      completeSingleReportArtifact({
        store: s.store, task: s.task, invocation: s.invocation, attemptOrdinal: s.attempt.ordinal,
        expected: s.expected, reportBackend: fakeReportBackend({ text: '   ' }),
      }),
      (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED,
    );
    assert.equal(REPAIR_BOUND.maxDeliveryRepairAttempts, 1);
    assert.equal(REPAIR_BOUND.recursive, false);
  });
});

test('§19: retryLocalMaterialization writes the exact bytes and NEVER calls a backend', async () => {
  await withTempRoot(async (dir) => {
    const p = join(dir, 'r.md');
    const body = '# exact bytes\r\n  spaced  \n🚀';
    const out = retryLocalMaterialization({ expectedReportPath: p, acceptedVisibleText: body, maxTries: 3 });
    assert.equal(out.wrote, true);
    assert.equal(Buffer.compare(readFileSync(p), Buffer.from(body, 'utf8')), 0);
    // idempotent: if the file already exists it does not rewrite / does not throw
    const out2 = retryLocalMaterialization({ expectedReportPath: p, acceptedVisibleText: body });
    assert.equal(out2.wrote, false);
  });
});

test('§18: relocateMisplacedReport never overwrites an existing expected report', async () => {
  await withTempRoot(async (dir) => {
    const cand = join(dir, 'c.md');
    const target = join(dir, 't.md');
    writeFileSync(cand, 'candidate');
    writeFileSync(target, 'already here');
    assert.throws(() => relocateMisplacedReport({ candidatePath: cand, expectedReportPath: target }), (e) => e.code === INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED);
    assert.equal(readFileSync(target, 'utf8'), 'already here');
  });
});

// tiny local move helper (avoid re-importing fs.renameSync at top for one call)
import { renameSync as require_move } from 'node:fs';
