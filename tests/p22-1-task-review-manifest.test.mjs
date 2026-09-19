import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeTaskReviewManifest, buildTaskReviewManifest, TaskReviewManifestError,
  TASK_REVIEW_MANIFEST_SCHEMA_VERSION,
} from '../src/pm/task-review-manifest.mjs';
import { buildArtifactReference, ARTIFACT_SCHEMA_VERSION } from '../src/artifacts/artifact-schema.mjs';

// P22.1 — unit-level coverage of the review-manifest writer in isolation
// (no ProductionPmWorkHandler, no PM run, no runtime), covering: schema
// shape, path safety, idempotent replay, and fail-closed corruption
// detection. Integration through the real settlement path is covered by
// tests/p22-1-production-pm-worker-review-manifest.test.mjs.

function sealedFinalRef({ taskId = 'task-abc', projectId = 'proj-1', sha256 = 'a'.repeat(64), bytes = 1234, artifactRelpath = null } = {}) {
  return buildArtifactReference({
    storeId: 'store-p20-v1', projectId, taskId, invocationId: 'inv-1', attemptOrdinal: 0,
    artifactRelpath: artifactRelpath ?? `${taskId}/inv-1/attempt-0/report.md`, sha256, bytes, sealedAt: '2026-09-13T00:00:00.000Z',
  }, { sealed: true });
}

function withTempRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p22-1-manifest-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('buildTaskReviewManifest: refuses an unsealed final_ref', () => {
  const unsealed = buildArtifactReference({
    storeId: 's', projectId: 'p', taskId: 't', invocationId: 'i', attemptOrdinal: 0, artifactRelpath: 't/i/attempt-0/report.md',
  }, { sealed: false });
  assert.throws(
    () => buildTaskReviewManifest({ taskId: 't', projectId: 'p', taskMode: 'SINGLE', finalRef: unsealed }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_FINAL_REF_UNSEALED',
  );
});

test('buildTaskReviewManifest: refuses a malformed (non-object) final_ref — P22.1-R1 fail-closed, never silently skipped', () => {
  for (const malformed of ['not-a-ref', 42, true, ['array'], {}]) {
    assert.throws(
      () => buildTaskReviewManifest({ taskId: 't', projectId: 'p', taskMode: 'SINGLE', finalRef: malformed }),
      (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_FINAL_REF_UNSEALED',
      `expected fail-closed for ${JSON.stringify(malformed)}`,
    );
  }
});

test('buildTaskReviewManifest: refuses a final_ref belonging to a different task (cross-task)', () => {
  const foreign = sealedFinalRef({ taskId: 'someone-elses-task' });
  assert.throws(
    () => buildTaskReviewManifest({ taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef: foreign }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_FINAL_REF_CROSS_TASK',
  );
});

test('buildTaskReviewManifest: refuses a final_ref belonging to a different project', () => {
  const foreign = sealedFinalRef({ taskId: 'task-abc', projectId: 'someone-elses-project' });
  assert.throws(
    () => buildTaskReviewManifest({ taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef: foreign }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_FINAL_REF_CROSS_TASK',
  );
});

test('buildTaskReviewManifest: rejects an invalid taskMode (never silently flattens Debate/Council)', () => {
  assert.throws(
    () => buildTaskReviewManifest({ taskId: 'task-abc', projectId: 'proj-1', taskMode: 'BOGUS', finalRef: sealedFinalRef() }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_INVALID_INPUT',
  );
});

test('buildTaskReviewManifest: produces the minimum refs/hashes-only shape, no report semantics', () => {
  const finalRef = sealedFinalRef();
  const manifest = buildTaskReviewManifest({
    taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE',
    branch: 'dsh/task-task-abc', baseSha: 'b'.repeat(40), artifactTransport: 'artifact_v1', finalRef,
  });
  assert.equal(manifest.schema_version, TASK_REVIEW_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.task_id, 'task-abc');
  assert.equal(manifest.project_id, 'proj-1');
  assert.equal(manifest.task_mode, 'SINGLE');
  assert.equal(manifest.branch, 'dsh/task-task-abc');
  assert.equal(manifest.base_sha, 'b'.repeat(40));
  assert.equal(manifest.artifact_transport, 'artifact_v1');
  assert.deepEqual(manifest.final_ref, finalRef);
  assert.equal(manifest.report_sha256, finalRef.sha256);
  assert.equal(manifest.report_bytes, finalRef.bytes);
  assert.equal(manifest.topology, undefined);
  // Refs/hashes only: schema_version pinned above from artifact-schema.mjs
  // itself, never re-derived — the manifest's own final_ref must be the
  // EXACT sealed object, not a re-serialized/interpreted copy.
  assert.equal(finalRef.schema_version, ARTIFACT_SCHEMA_VERSION);
});

test('buildTaskReviewManifest: records Council/Debate topology truthfully when supplied', () => {
  const manifest = buildTaskReviewManifest({
    taskId: 'task-abc', projectId: 'proj-1', taskMode: 'DEBATE', finalRef: sealedFinalRef(),
    topology: { chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 1, strategy: 'default', debate: { enabled: true, rounds_run: 2, max_rounds: 3 } },
  });
  assert.equal(manifest.task_mode, 'DEBATE');
  assert.deepEqual(manifest.topology, { chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 1, strategy: 'default', debate: { enabled: true, rounds_run: 2, max_rounds: 3 } });
});

test('writeTaskReviewManifest: writes docs/task-review/<task_id>.json inside the project repo, path-safe', () => withTempRepo((root) => {
  const finalRef = sealedFinalRef();
  const outcome = writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  assert.equal(outcome.written, true);
  assert.equal(outcome.relPath, 'docs/task-review/task-abc.json');
  const onDisk = JSON.parse(readFileSync(join(root, 'docs', 'task-review', 'task-abc.json'), 'utf8'));
  assert.deepEqual(onDisk, outcome.manifest);
  assert.equal(readFileSync(outcome.path, 'utf8').endsWith('\n'), true);
}));

test('writeTaskReviewManifest: rejects a path-unsafe task_id rather than escaping docs/task-review', () => withTempRepo((root) => {
  const maliciousTaskId = '../../etc/passwd';
  assert.throws(
    () => writeTaskReviewManifest({
      projectRepoPath: root, taskId: maliciousTaskId, projectId: 'proj-1', taskMode: 'SINGLE',
      finalRef: sealedFinalRef({ taskId: maliciousTaskId, artifactRelpath: 'x/inv-1/attempt-0/report.md' }),
    }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_TASK_ID_INVALID',
  );
}));

test('writeTaskReviewManifest: idempotent replay — same verified inputs produce byte-identical content, second call is a no-op', () => withTempRepo((root) => {
  const finalRef = sealedFinalRef();
  const first = writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  const bytesAfterFirst = readFileSync(first.path, 'utf8');
  const second = writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  assert.equal(second.written, false, 'replay with identical facts is a genuine no-op, not a failure');
  assert.equal(readFileSync(second.path, 'utf8'), bytesAfterFirst, 'byte-identical on replay');
}));

test('writeTaskReviewManifest: fails closed when an existing manifest disagrees with the freshly computed canonical facts', () => withTempRepo((root) => {
  const finalRef = sealedFinalRef();
  writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  // A different sealed report (different sha256/bytes) for the SAME task_id
  // — simulates either corruption or a genuinely conflicting replay.
  const conflicting = sealedFinalRef({ sha256: 'c'.repeat(64), bytes: 9999 });
  assert.throws(
    () => writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef: conflicting }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_CONFLICT',
  );
}));

test('writeTaskReviewManifest: fails closed on a corrupted (non-JSON) existing manifest file', () => withTempRepo((root) => {
  mkdirSync(join(root, 'docs', 'task-review'), { recursive: true });
  writeFileSync(join(root, 'docs', 'task-review', 'task-abc.json'), 'not json{{{', 'utf8');
  assert.throws(
    () => writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef: sealedFinalRef() }),
    (err) => err instanceof TaskReviewManifestError && err.code === 'TASK_REVIEW_MANIFEST_CORRUPT',
  );
}));

test('writeTaskReviewManifest: harmless key-order difference on disk is NOT treated as a conflict (semantic, not byte, comparison)', () => withTempRepo((root) => {
  const finalRef = sealedFinalRef();
  const manifest = buildTaskReviewManifest({ taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  mkdirSync(join(root, 'docs', 'task-review'), { recursive: true });
  // Same facts, deliberately reordered top-level keys.
  const reordered = { task_id: manifest.task_id, schema_version: manifest.schema_version, ...manifest };
  writeFileSync(join(root, 'docs', 'task-review', 'task-abc.json'), `${JSON.stringify(reordered, null, 2)}\n`, 'utf8');
  const outcome = writeTaskReviewManifest({ projectRepoPath: root, taskId: 'task-abc', projectId: 'proj-1', taskMode: 'SINGLE', finalRef });
  assert.equal(outcome.written, false);
}));
