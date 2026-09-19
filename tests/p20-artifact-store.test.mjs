/**
 * P20.1C/D — durable, app-owned artifact workspace/store + inactive rollout seam.
 * Authority: docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §4/§7/§22/§23,
 * docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §4/§10/§15,
 * docs/planning/P20_IMPLEMENTATION_PLAN_POST_SURVEY_PM_FREEZE.md §11–§13.
 *
 * Offline. Every test uses an isolated mkdtemp root and never touches the
 * real .runtime/ or docs/P20/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import {
  ArtifactStore,
  ArtifactStoreError,
  createArtifactStore,
  fileByteLength,
  hashFileSha256,
  resolveArtifactStoreRoot,
} from '../src/artifacts/artifact-store.mjs';
import { DELIVERY_MECHANISM, INPUT_TRANSPORT } from '../src/artifacts/artifact-schema.mjs';
import { resolveTransportVersion, isArtifactV1Task, stampTransportVersion, ArtifactTransportError, TRANSPORT_VERSION } from '../src/artifacts/artifact-transport.mjs';

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p20-store-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

function freshStore(baseDir, over = {}) {
  return createArtifactStore({
    storeId: over.storeId ?? 'store-test',
    projectId: over.projectId ?? 'live1-local',
    root: over.root ?? join(baseDir, '.runtime', 'dsh-artifacts', over.projectId ?? 'live1-local'),
    now: over.now,
  });
}

const TASK = { taskId: 'task-LBGXGEhVZ5y1koA-yL7X_WiqdhO2EGmT', taskSlug: 'T5 Cross Backend Council', createdAt: '2026-09-10T08:32:15Z', mode: 'council' };

// ---- root resolution (freeze §4.1) --------------------------------

test('resolveArtifactStoreRoot derives <base>/dsh-artifacts/<project_id> from a trusted absolute base, never cwd', () => {
  withTempRoot((dir) => {
    const root = resolveArtifactStoreRoot({ runtimeBase: join(dir, '.runtime'), projectId: 'live1-local' });
    assert.equal(root, join(dir, '.runtime', 'dsh-artifacts', 'live1-local'));
    assert.ok(isAbsolute(root));
  });
});

test('resolveArtifactStoreRoot rejects a relative base, a UNC base, and an unsafe project id', () => {
  assert.throws(() => resolveArtifactStoreRoot({ runtimeBase: 'relative/base', projectId: 'p' }), (e) => e.code === 'ARTIFACT_ROOT_BASE_RELATIVE');
  assert.throws(() => resolveArtifactStoreRoot({ runtimeBase: '\\\\server\\share', projectId: 'p' }), (e) => e.code === 'ARTIFACT_ROOT_UNC_UNSUPPORTED');
  assert.throws(() => resolveArtifactStoreRoot({ runtimeBase: '//server/share', projectId: 'p' }), (e) => e.code === 'ARTIFACT_ROOT_UNC_UNSUPPORTED');
  assert.throws(() => resolveArtifactStoreRoot({ runtimeBase: process.cwd(), projectId: 'live1:local' }), (e) => e.code === 'ARTIFACT_PROJECT_ID_UNSAFE');
});

test('the store root does not depend on process.cwd()', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    const savedCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const t = store.allocateTask(TASK);
      assert.ok(t.path.startsWith(join(dir, '.runtime', 'dsh-artifacts', 'live1-local')));
    } finally {
      process.chdir(savedCwd);
    }
  });
});

// ---- inactivity / legacy default (plan §11 P20.1D) ---------------

test('constructing a store performs zero filesystem I/O until an allocate/ensure call', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    assert.equal(existsSync(store.root), false);
    assert.equal(existsSync(join(dir, '.runtime')), false);
  });
});

test('R1: transport version — absent is legacy, unknown/typo/future FAILS CLOSED', () => {
  // Absent / null => legacy (the ONLY authorized silent default).
  assert.equal(resolveTransportVersion(undefined), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({}), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ context: {} }), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ transport_version: null }), TRANSPORT_VERSION.LEGACY);
  // Explicit supported values.
  assert.equal(resolveTransportVersion({ transport_version: 'legacy' }), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ transport_version: 'artifact_v1' }), TRANSPORT_VERSION.ARTIFACT_V1);
  assert.equal(resolveTransportVersion({ context: { transport_version: 'artifact_v1' } }), TRANSPORT_VERSION.ARTIFACT_V1);
  assert.equal(isArtifactV1Task({ transport_version: 'artifact_v1' }), true);
  // Any other PRESENT value => deterministic typed refusal, never legacy.
  for (const bad of ['artifact_v2', 'something-else', 'artifcat_v1', 'LEGACY', 'Artifact_V1', '', 42, {}]) {
    assert.throws(
      () => resolveTransportVersion({ transport_version: bad }),
      (e) => e instanceof ArtifactTransportError && e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED',
      `top-level ${JSON.stringify(bad)} must refuse`,
    );
    assert.throws(
      () => resolveTransportVersion({ context: { transport_version: bad } }),
      (e) => e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED',
      `nested ${JSON.stringify(bad)} must refuse`,
    );
  }
  // An unsupported value cannot hide behind a valid one at the other level.
  assert.throws(() => resolveTransportVersion({ transport_version: 'legacy', context: { transport_version: 'artifact_v2' } }), (e) => e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED');
  // stamp uses the same typed refusal.
  assert.equal(stampTransportVersion({ a: 1 }, 'artifact_v1').transport_version, 'artifact_v1');
  assert.throws(() => stampTransportVersion({}, 'nope'), (e) => e instanceof ArtifactTransportError && e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED');
});

// ---- store identity (freeze §23) --------------------------------

test('ensureStore writes a store.json identity file and is idempotent', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    store.ensureStore();
    store.ensureStore();
    const identity = JSON.parse(readFileSync(join(store.root, 'store.json'), 'utf8'));
    assert.equal(identity.store_id, 'store-test');
    assert.equal(identity.project_id, 'live1-local');
  });
});

test('reopening a store dir under a mismatched store_id or project_id is refused (ARTIFACT_STORE_MISMATCH)', () => {
  withTempRoot((dir) => {
    const root = join(dir, 'shared-root');
    freshStore(dir, { root }).ensureStore();
    assert.throws(() => freshStore(dir, { root, storeId: 'other-store' }).ensureStore(), (e) => e.code === 'ARTIFACT_STORE_MISMATCH');
    assert.throws(() => freshStore(dir, { root, projectId: 'other-project' }).ensureStore(), (e) => e.code === 'ARTIFACT_STORE_MISMATCH');
  });
});

test('a corrupt store.json fails closed rather than being silently overwritten', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    mkdirSync(store.root, { recursive: true });
    writeFileSync(join(store.root, 'store.json'), '{ not json');
    assert.throws(() => store.ensureStore(), (e) => e.code === 'ARTIFACT_STORE_IDENTITY_CORRUPT');
  });
});

test('a store.json written by a newer schema version is refused by this binary', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    mkdirSync(store.root, { recursive: true });
    writeFileSync(join(store.root, 'store.json'), JSON.stringify({ schema_version: 99, store_id: 'store-test', project_id: 'live1-local' }));
    assert.throws(() => store.ensureStore(), (e) => e.code === 'ARTIFACT_STORE_SCHEMA_MISMATCH');
  });
});

// ---- task allocation (freeze §5 / §22) --------------------------

test('allocateTask creates the frozen immutable folder shape and a valid task-manifest.json', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    assert.equal(t.path.split(/[\\/]/).at(-1), '20260910_083215__t5-cross-backend-council__task-LBGXGEhV');
    const manifest = JSON.parse(readFileSync(t.manifestPath, 'utf8'));
    assert.equal(manifest.task_id, TASK.taskId);
    assert.equal(manifest.transport_version, 'artifact_v1');
    assert.equal(manifest.task_state, 'OPEN');
    assert.equal(manifest.task_slug, 't5-cross-backend-council');
  });
});

test('allocateTask reopen is by FULL task identity — a later different slug/createdAt returns the ORIGINAL folder', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    const a = store.allocateTask(TASK);
    const b = store.allocateTask({ taskId: TASK.taskId, taskSlug: 'A completely different later title', createdAt: '2027-05-05T05:05:05Z' });
    assert.equal(a.path, b.path);
    assert.deepEqual(readdirSync(store.tasksRoot).filter((n) => !n.startsWith('.')), [a.path.split(/[\\/]/).at(-1)]);
  });
});

test('openTaskById finds an existing task and returns null for an unknown id', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    store.allocateTask(TASK);
    assert.equal(store.openTaskById(TASK.taskId).taskId, TASK.taskId);
    assert.equal(store.openTaskById('task-does-not-exist'), null);
  });
});

test('a short-id hash clash with a DIFFERENT full task id is refused, never overwritten (ARTIFACT_TASK_IDENTITY_COLLISION)', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    const folderName = '20260910_083215__x__task-COLLIDE0';
    const taskDir = join(store.tasksRoot, folderName);
    store.ensureStore();
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'task-manifest.json'), JSON.stringify({
      schema_version: 1, transport_version: 'artifact_v1', store_id: 'store-test', project_id: 'live1-local',
      task_id: 'task-COLLIDE0different', task_slug: 'x', created_at: '2026-09-10T08:32:15Z',
      participant_profile_ids: [], previous_task_refs: [], stages: {}, task_state: 'OPEN',
    }));
    // A new task whose deterministic folder name is identical but whose
    // full id differs.
    assert.throws(
      () => store.allocateTask({ taskId: 'task-COLLIDE0other', taskSlug: 'x', createdAt: '2026-09-10T08:32:15Z' }),
      (e) => e.code === 'ARTIFACT_TASK_IDENTITY_COLLISION',
    );
    // The pre-existing manifest is untouched.
    assert.match(readFileSync(join(taskDir, 'task-manifest.json'), 'utf8'), /task-COLLIDE0different/);
  });
});

test('a task manifest written under a different store/project is refused on reopen', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    store.ensureStore();
    const folder = '20260910_083215__t5-cross-backend-council__task-LBGXGEhV';
    const taskDir = join(store.tasksRoot, folder);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'task-manifest.json'), JSON.stringify({
      schema_version: 1, transport_version: 'artifact_v1', store_id: 'SOME-OTHER-STORE', project_id: 'live1-local',
      task_id: TASK.taskId, task_slug: 't5-cross-backend-council', created_at: TASK.createdAt,
      participant_profile_ids: [], previous_task_refs: [], stages: {}, task_state: 'OPEN',
    }));
    assert.throws(() => store.allocateTask(TASK), (e) => e.code === 'ARTIFACT_STORE_MISMATCH');
  });
});

// ---- invocation allocation (freeze §7) -------------------------

test('allocateInvocation lays the frozen stage hierarchy and writes an ASSIGNED invocation.json', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({
      invocationId: 'inv-participant-antigravity',
      role: ARTIFACT_ROLE.MEMBER,
      stage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
      profileId: 'live1-antigravity-gemini-3-8-flash-high',
      actorAlias: 'antigravity-gemini-3-8-flash-high',
    });
    assert.ok(inv.path.replace(/\\/g, '/').endsWith('/members/antigravity-gemini-3-8-flash-high/participant-report/inv-participant-antigravity'));
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.equal(rec.lifecycle, 'ASSIGNED');
    assert.equal(rec.invocation_id, 'inv-participant-antigravity');
    assert.deepEqual(rec.attempts, []);
    assert.equal(rec.authoritative_attempt, null);
    assert.ok(!rec.stage_relpath.includes('\\'));
  });
});

test('allocateInvocation is idempotent for the same id and refuses a key clash with a different id', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const args = { invocationId: 'inv-chair-plan', role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'pid', actorAlias: 'chair' };
    const a = t.allocateInvocation(args);
    const b = t.allocateInvocation(args);
    assert.equal(a.path, b.path);

    // Force a written invocation.json whose key would collide but whose id differs.
    const rec = JSON.parse(readFileSync(a.recordPath, 'utf8'));
    rec.invocation_id = 'inv-chair-plan-DIFFERENT';
    writeFileSync(a.recordPath, JSON.stringify(rec));
    assert.throws(() => t.allocateInvocation(args), (e) => e.code === 'ARTIFACT_INVOCATION_IDENTITY_COLLISION');
  });
});

// ---- attempt allocation (freeze §7 / §22.3 / §22.4) ----------

test('attempts allocate monotonically attempt-00, attempt-01, … and never reuse a directory', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'claude-sonnet-low' });
    const a0 = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:36:42Z' });
    const a1 = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:40:00Z' });
    const a2 = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:41:00Z' });
    assert.deepEqual([a0.ordinal, a1.ordinal, a2.ordinal], [0, 1, 2]);
    assert.deepEqual(inv.listAttemptOrdinals(), [0, 1, 2]);
    assert.deepEqual(
      readdirSync(inv.path).filter((n) => n.startsWith('attempt-')).sort(),
      ['attempt-00', 'attempt-01', 'attempt-02'],
    );
    assert.notEqual(a0.executionId, a1.executionId);
  });
});

test('a pre-existing attempt-00 (another process won the race) is preserved; allocation takes attempt-01', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });
    mkdirSync(join(inv.path, 'attempt-00'));
    writeFileSync(join(inv.path, 'attempt-00', 'sentinel.txt'), 'other-process-evidence');
    const a = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, startedAt: '2026-09-10T08:40:00Z' });
    assert.equal(a.ordinal, 1);
    assert.equal(readFileSync(join(inv.path, 'attempt-00', 'sentinel.txt'), 'utf8'), 'other-process-evidence');
  });
});

test('concurrent allocateAttempt calls serialize deterministically with unique monotonic ordinals', async () => {
  await withTempRoot(async (dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      Promise.resolve().then(() => inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: `2026-09-10T08:4${i}:00Z` }))));
    const ordinals = results.map((r) => r.ordinal).sort((a, b) => a - b);
    assert.deepEqual(ordinals, [0, 1, 2, 3, 4, 5]);
    assert.equal(new Set(ordinals).size, 6);
  });
});

test('allocateAttempt writes artifact.json WITHOUT authoritative_attempt and creates no report/log file', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.PARTICIPANT_REPORT, profileId: 'pid', actorAlias: 'a' });
    const a = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, inputTransport: INPUT_TRANSPORT.VERBATIM_CONTENT, startedAt: '2026-09-10T08:36:42Z' });
    const meta = JSON.parse(readFileSync(a.artifactJsonPath, 'utf8'));
    assert.ok(!('authoritative_attempt' in meta));
    assert.equal(meta.delivery_mechanism, 'VERBATIM_MATERIALIZATION');
    assert.equal(meta.report_bytes, null);
    assert.equal(meta.report_sha256, null);
    // The report / executive log are NOT materialised for an unexecuted attempt.
    assert.equal(existsSync(a.reportPath), false);
    assert.equal(existsSync(a.executiveLogPath), false);
    assert.match(a.reportPath.replace(/\\/g, '/'), /\/attempt-00\/20260910_083642__a__participant-report__report\.md$/);
  });
});

test('allocateAttempt records the attempt on the parent invocation.json (attempts + latest ordinal), authority still null', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });
    inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:36:42Z' });
    inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:40:00Z' });
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.deepEqual(rec.attempts, [0, 1]);
    assert.equal(rec.latest_attempt_ordinal, 1);
    assert.equal(rec.lifecycle, 'ASSIGNED'); // no premature DELIVERED/SEALED
    assert.equal(rec.authoritative_attempt, null);
  });
});

// ---- containment / reparse fail-closed (integrity gate §10) --

test('a store root that resolves through a symlink/junction fails closed (ARTIFACT_ROOT_REPARSE)', () => {
  withTempRoot((dir) => {
    const realRoot = join(dir, 'real-artifacts');
    mkdirSync(realRoot, { recursive: true });
    const linkRoot = join(dir, 'linked-artifacts');
    try {
      symlinkSync(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // symlink/junction not permitted in this environment — skip
    }
    const store = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: linkRoot });
    assert.throws(() => store.ensureStore(), (e) => e instanceof ArtifactStoreError && e.code === 'ARTIFACT_ROOT_REPARSE');
  });
});

// ---- atomic write failure propagation (plan §11 P20.1C) -----

test('an authoritative metadata write failure is propagated, never swallowed', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    store.ensureStore();
    // Make `tasks` a FILE so mkdir/allocation under it fails with ENOTDIR.
    mkdirSync(store.root, { recursive: true });
    writeFileSync(store.tasksRoot, 'not a directory');
    assert.throws(() => store.allocateTask(TASK), (e) => e instanceof Error);
  });
});

test('a task folder that exists but never got its manifest is reported, not silently reused', () => {
  withTempRoot((dir) => {
    const store = freshStore(dir);
    store.ensureStore();
    const folder = '20260910_083215__t5-cross-backend-council__task-LBGXGEhV';
    mkdirSync(join(store.tasksRoot, folder), { recursive: true });
    assert.throws(() => store.allocateTask(TASK), (e) => e.code === 'ARTIFACT_TASK_MANIFEST_MISSING');
  });
});

// ---- hash / size utilities --------------------------------------

test('hashFileSha256 matches node:crypto over the same bytes', async () => {
  const { createHash } = await import('node:crypto');
  withTempRoot((dir) => {
    const p = join(dir, 'sample.bin');
    const bytes = Buffer.from('a'.repeat(200_000) + '✅ end', 'utf8');
    writeFileSync(p, bytes);
    assert.equal(hashFileSha256(p), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(fileByteLength(p), bytes.length);
  });
});

// ---- POSIX vs Windows relpath portability (freeze §18) ------

test('every persisted relpath is store-relative POSIX ("/" only) on this platform', () => {
  withTempRoot((dir) => {
    const t = freshStore(dir).allocateTask(TASK);
    const inv = t.allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round: 2, profileId: 'pid', actorAlias: 'a' });
    const a = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:36:42Z' });
    const meta = JSON.parse(readFileSync(a.artifactJsonPath, 'utf8'));
    for (const rel of [meta.report_relpath, meta.executive_log_relpath, JSON.parse(readFileSync(inv.recordPath, 'utf8')).stage_relpath]) {
      assert.ok(!rel.includes('\\'), rel);
      assert.ok(!isAbsolute(rel), rel);
      assert.ok(rel.includes('/'), rel);
      assert.ok(rel.includes('debate/round-02/members/a/response'), rel);
    }
  });
});

// ---- ArtifactStore constructor guards --------------------------

test('ArtifactStore requires an explicit storeId and a filesystem-safe projectId', () => {
  assert.throws(() => new ArtifactStore({ projectId: 'p', root: tmpdir() }), (e) => e.code === 'ARTIFACT_STORE_ID_MISSING');
  assert.throws(() => new ArtifactStore({ storeId: 's', projectId: 'has:colon', root: tmpdir() }), (e) => e.code === 'ARTIFACT_PROJECT_ID_UNSAFE');
  assert.throws(() => new ArtifactStore({ storeId: 's', projectId: 'p', root: 'relative/root' }), (e) => e.code === 'ARTIFACT_ROOT_RELATIVE');
});
