/**
 * P20.1B — versioned transport/orchestration metadata schemas.
 * Authority: docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §13–§16,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §3/§18.
 *
 * Offline, pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_SCHEMA_VERSION,
  DELIVERY_MECHANISM,
  INPUT_TRANSPORT,
  INVOCATION_LIFECYCLE,
  TERMINAL_STATE,
  TRANSPORT_VERSION,
  assertNoForbiddenSemanticKeys,
  buildArtifactMetadata,
  buildArtifactReference,
  buildInvocationRecord,
  buildTaskManifest,
  findForbiddenSemanticKeys,
  validateArtifactMetadata,
  validateArtifactReference,
  validateInvocationRecord,
  validateTaskManifest,
} from '../src/artifacts/artifact-schema.mjs';

const baseTaskArgs = {
  storeId: 'store-1',
  projectId: 'live1-local',
  taskId: 'task-abc123',
  taskSlug: 't5-cross-backend-council',
  createdAt: '2026-09-10T08:32:15.000Z',
  mode: 'council',
};

// ---- TaskManifest -------------------------------------------------

test('buildTaskManifest produces a valid versioned artifact_v1 manifest with future fields nulled', () => {
  const m = buildTaskManifest(baseTaskArgs);
  assert.equal(m.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(m.transport_version, TRANSPORT_VERSION.ARTIFACT_V1);
  assert.equal(m.task_state, 'OPEN');
  assert.equal(m.final_ref, null);
  assert.deepEqual(m.participant_profile_ids, []);
  assert.deepEqual(m.stages, {});
  const { ok, errors } = validateTaskManifest(m);
  assert.ok(ok, errors.join('; '));
});

test('validateTaskManifest rejects a wrong schema/transport version and missing identity', () => {
  assert.equal(validateTaskManifest({ ...buildTaskManifest(baseTaskArgs), schema_version: 999 }).ok, false);
  assert.equal(validateTaskManifest({ ...buildTaskManifest(baseTaskArgs), transport_version: 'legacy' }).ok, false);
  assert.equal(validateTaskManifest({ ...buildTaskManifest(baseTaskArgs), store_id: '' }).ok, false);
  assert.equal(validateTaskManifest(null).ok, false);
});

test('validateTaskManifest rejects a manifest carrying model-semantic fields', () => {
  const m = buildTaskManifest(baseTaskArgs);
  m.verdict = 'APPROVE';
  const { ok, errors } = validateTaskManifest(m);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /forbidden semantic keys/);
});

test('validateTaskManifest requires previous_task_refs to be sealed ArtifactReferences', () => {
  const m = buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [{ schema_version: 1, store_id: baseTaskArgs.storeId, project_id: baseTaskArgs.projectId, task_id: 'task-prior1', invocation_id: 'i', attempt_ordinal: 0, artifact_relpath: 'a/report.md' }] });
  assert.equal(validateTaskManifest(m).ok, false, 'unsealed ref must be rejected');
  const sealed = buildArtifactReference({ storeId: baseTaskArgs.storeId, projectId: baseTaskArgs.projectId, taskId: 'task-prior1', invocationId: 'i', attemptOrdinal: 0, artifactRelpath: 'a/report.md', sha256: 'a'.repeat(64), bytes: 10, sealedAt: '2026-09-10T00:00:00Z' }, { sealed: true });
  const m2 = buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [sealed] });
  assert.equal(validateTaskManifest(m2).ok, true);
});

test('P20.6 §18 — validateTaskManifest rejects a cross-store / self / duplicate previous_task_refs graph', () => {
  const mk = (over) => buildArtifactReference({
    storeId: baseTaskArgs.storeId, projectId: baseTaskArgs.projectId, taskId: 'task-prior1',
    invocationId: 'i', attemptOrdinal: 0, artifactRelpath: 'a/report.md',
    sha256: 'a'.repeat(64), bytes: 10, sealedAt: '2026-09-10T00:00:00Z', ...over,
  }, { sealed: true });
  // cross-store
  assert.equal(validateTaskManifest(buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [mk({ storeId: 'other-store' })] })).ok, false);
  // cross-project
  assert.equal(validateTaskManifest(buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [mk({ projectId: 'other-project' })] })).ok, false);
  // self-reference to the manifest's own task_id
  assert.equal(validateTaskManifest(buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [mk({ taskId: baseTaskArgs.taskId })] })).ok, false);
  // duplicate concrete refs (same canonical identity) — no silent dedupe
  assert.equal(validateTaskManifest(buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [mk({}), mk({})] })).ok, false);
  // two DISTINCT valid refs in order — accepted
  assert.equal(validateTaskManifest(buildTaskManifest({ ...baseTaskArgs, previousTaskRefs: [mk({ taskId: 'task-prior1' }), mk({ invocationId: 'i2', taskId: 'task-prior2' })] })).ok, true);
});

// ---- InvocationRecord ------------------------------------------

test('buildInvocationRecord starts ASSIGNED with no attempts and no authority', () => {
  const r = buildInvocationRecord({
    invocationId: 'inv-1', invocationKey: 'inv-1', storeId: 'store-1', projectId: 'live1-local',
    taskId: 'task-abc123', role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    stageRelpath: 'tasks/x/members/a/participant-report', createdAt: '2026-09-10T08:32:15.000Z',
  });
  assert.equal(r.lifecycle, INVOCATION_LIFECYCLE.ASSIGNED);
  assert.deepEqual(r.attempts, []);
  assert.equal(r.authoritative_attempt, null);
  assert.equal(validateInvocationRecord(r).ok, true);
});

test('validateInvocationRecord forbids authoritative_attempt until SEALED, and requires the full seal block (P20.3R R7)', () => {
  const r = buildInvocationRecord({
    invocationId: 'inv-1', invocationKey: 'inv-1', storeId: 'store-1', projectId: 'live1-local',
    taskId: 'task-abc123', role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    stageRelpath: 'tasks/x/members/a/participant-report', createdAt: '2026-09-10T08:32:15.000Z',
  });
  r.authoritative_attempt = 0;
  assert.equal(validateInvocationRecord(r).ok, false, 'ASSIGNED + authoritative_attempt must fail');

  // R7: SEALED without a self-consistent seal block still fails.
  r.lifecycle = INVOCATION_LIFECYCLE.SEALED;
  r.attempts = [0];
  r.latest_attempt_ordinal = 0;
  assert.equal(validateInvocationRecord(r).ok, false, 'SEALED with no seal object must fail');

  r.seal = { sealed_at: '2026-09-10T08:40:00.000Z', seal_version: 'p20.3-1', authoritative_attempt: 0, integrity_state: 'ARTIFACT_PASS' };
  r.integrity_state = 'ARTIFACT_PASS';
  assert.equal(validateInvocationRecord(r).ok, true, 'SEALED + full consistent seal block is allowed');

  // R7 negatives
  assert.equal(validateInvocationRecord({ ...r, authoritative_attempt: 5 }).ok, false, 'authoritative_attempt not in attempts[]');
  assert.equal(validateInvocationRecord({ ...r, seal: { ...r.seal, authoritative_attempt: 1 } }).ok, false, 'seal ordinal mismatch');
  assert.equal(validateInvocationRecord({ ...r, seal: { ...r.seal, integrity_state: 'NOPE' } }).ok, false, 'seal.integrity_state not ARTIFACT_PASS');
  assert.equal(validateInvocationRecord({ ...r, integrity_state: null }).ok, false, 'parent integrity_state not ARTIFACT_PASS');
  assert.equal(validateInvocationRecord({ ...r, lifecycle: 'DELIVERED' }).ok, false, 'non-SEALED with a seal object must fail');
});

test('validateInvocationRecord rejects a non-relative or backslash stage_relpath', () => {
  const base = buildInvocationRecord({
    invocationId: 'inv-1', invocationKey: 'inv-1', storeId: 'store-1', projectId: 'live1-local',
    taskId: 'task-abc123', role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    stageRelpath: 'ok/path', createdAt: '2026-09-10T08:32:15.000Z',
  });
  assert.equal(validateInvocationRecord({ ...base, stage_relpath: '/abs/path' }).ok, false);
  assert.equal(validateInvocationRecord({ ...base, stage_relpath: 'C:\\win\\path' }).ok, false);
  assert.equal(validateInvocationRecord({ ...base, stage_relpath: 'a\\b' }).ok, false);
  assert.equal(validateInvocationRecord({ ...base, stage_relpath: 'a/../b' }).ok, false);
});

// ---- artifact.json (freeze §13 / §7.1) -------------------------

test('artifact.json MUST NOT be able to select authoritative_attempt', () => {
  const meta = buildArtifactMetadata({
    storeId: 'store-1', projectId: 'live1-local', taskId: 'task-abc123', invocationId: 'inv-1', executionId: 'exec-1',
    attemptOrdinal: 0, role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    deliveryMechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT,
    reportRelpath: 'x/attempt-00/r.md', executiveLogRelpath: 'x/attempt-00/e.log',
  });
  assert.equal(validateArtifactMetadata(meta).ok, true);
  assert.ok(!('authoritative_attempt' in meta));
  meta.authoritative_attempt = 0;
  const { ok, errors } = validateArtifactMetadata(meta);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /authoritative_attempt/);
});

test('artifact.json rejects model-semantic fields (verdict/findings/recommendation/…) at any depth', () => {
  const meta = buildArtifactMetadata({
    storeId: 'store-1', projectId: 'live1-local', taskId: 'task-abc123', invocationId: 'inv-1', executionId: 'exec-1',
    attemptOrdinal: 0, role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE,
    reportRelpath: 'x/attempt-00/r.md', executiveLogRelpath: 'x/attempt-00/e.log',
  });
  for (const key of ['verdict', 'findings', 'recommendation_ranking', 'agreement_score', 'chair_judgment']) {
    const bad = structuredClone(meta);
    bad.nested = { deeper: { [key]: 'x' } };
    assert.equal(validateArtifactMetadata(bad).ok, false, `${key} nested must be rejected`);
  }
});

test('artifact.json byte/hash fields are optional (unavailable in P20.1) but typed when present', () => {
  const ok = buildArtifactMetadata({
    storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', executionId: 'e',
    attemptOrdinal: 0, role: 'member', stage: 'participant-report', profileId: 'pid', actorAlias: 'a',
    deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE,
    reportRelpath: 'x/r.md', executiveLogRelpath: 'x/e.log',
    reportBytes: 6285, reportSha256: 'a'.repeat(64), terminalState: TERMINAL_STATE.SUCCESS,
  });
  assert.equal(validateArtifactMetadata(ok).ok, true);
  assert.equal(validateArtifactMetadata({ ...ok, report_sha256: 'NOTHEX' }).ok, false);
  assert.equal(validateArtifactMetadata({ ...ok, report_bytes: -1 }).ok, false);
  assert.equal(validateArtifactMetadata({ ...ok, terminal_state: 'MADE_UP' }).ok, false);
});

// ---- ArtifactReference V1 (freeze §16) -----------------------

test('buildArtifactReference stays unsealed by default and only seals with explicit opt-in', () => {
  const unsealed = buildArtifactReference({ storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', attemptOrdinal: 1, artifactRelpath: 'tasks/x/r.md' });
  assert.equal(unsealed.sha256, null);
  assert.equal(unsealed.sealed_at, null);
  assert.equal(validateArtifactReference(unsealed).sealed, false);
  assert.equal(validateArtifactReference(unsealed, { requireSealed: true }).ok, false, 'P20.1 must not forge a sealed ref');

  const sealed = buildArtifactReference(
    { storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', attemptOrdinal: 1, artifactRelpath: 'tasks/x/r.md', sha256: 'b'.repeat(64), bytes: 42, sealedAt: '2026-09-10T01:39:11.000Z' },
    { sealed: true },
  );
  const v = validateArtifactReference(sealed, { requireSealed: true });
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.sealed, true);
});

test('ArtifactReference canonical path is store-relative POSIX, never an absolute host path', () => {
  const bad = buildArtifactReference({ storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', attemptOrdinal: 0, artifactRelpath: 'C:\\Users\\developer\\report.md' });
  assert.equal(validateArtifactReference(bad).ok, false);
  const bad2 = buildArtifactReference({ storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', attemptOrdinal: 0, artifactRelpath: '/abs/report.md' });
  assert.equal(validateArtifactReference(bad2).ok, false);
});

// ---- forbidden-key scanner --------------------------------------

test('findForbiddenSemanticKeys walks arrays and nested objects', () => {
  assert.deepEqual(findForbiddenSemanticKeys({ a: 1 }), []);
  assert.deepEqual(findForbiddenSemanticKeys({ list: [{ ok: 1 }, { findings: [] }] }), ['$.list[1].findings']);
  assert.throws(() => assertNoForbiddenSemanticKeys({ deep: { verdict: 'x' } }), (e) => e.code === 'ARTIFACT_SEMANTIC_KEY_FORBIDDEN');
});
