/**
 * P20.1C — durable, app-owned artifact workspace/store.
 *
 * Authority:
 *   docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §4/§7/§22/§23
 *   docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §4/§10/§15
 *   docs/planning/P20_IMPLEMENTATION_PLAN_POST_SURVEY_PM_FREEZE.md §11 (P20.1C)
 *
 * This module allocates the deterministic on-disk skeleton for `artifact_v1`
 * tasks/invocations/attempts and writes ONLY app-owned transport metadata
 * (`store.json`, `task-manifest.json`, `invocation.json`). It is INACTIVE by
 * default: nothing constructs it unless a caller explicitly does, and it
 * performs no filesystem I/O until an allocate/ensure method is called, so
 * legacy execution creates no P20 directories (plan §11 P20.1D).
 *
 * It MUST NOT:
 *   - derive its root from `process.cwd()` (freeze §4.1);
 *   - overwrite another full task/invocation identity (freeze §22);
 *   - reuse an attempt directory (freeze §22.4);
 *   - create `report.md` / `executive.log` for an unexecuted attempt
 *     (freeze §7 "MUST NOT pretend an unexecuted report is delivered/sealed");
 *   - seal anything or select `authoritative_attempt` (freeze §19 — P20.3).
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
  rmSync, statSync, realpathSync, openSync, readSync, closeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  ARTIFACT_SCHEMA_VERSION,
  assertActorAlias,
  assertProjectIdSegment,
  assertSafeSegment,
  attemptDirName,
  invocationKey as computeInvocationKey,
  parseAttemptDirName,
  reportFileName,
  executiveLogFileName,
  stageDirSegments,
  taskFolderName,
  toStoreRelativePosix,
} from './artifact-paths.mjs';
import {
  INVOCATION_LIFECYCLE,
  TASK_STATE,
  buildArtifactMetadata,
  buildInvocationRecord,
  buildTaskManifest,
  validateArtifactMetadata,
  validateArtifactReference,
  validateInvocationRecord,
  validateTaskManifest,
  validateStageSealEntry,
  validateCouncilArtifactControl,
  canonicalArtifactRefIdentity,
} from './artifact-schema.mjs';
import { sameLexicalPath } from './artifact-path-identity.mjs';
import { validateDebateContinuationControl } from './debate-continuation-control.mjs';
import { ARTIFACT_STAGE } from './artifact-paths.mjs';

const STORE_IDENTITY_FILE = 'store.json';
const TASK_MANIFEST_FILE = 'task-manifest.json';
const INVOCATION_FILE = 'invocation.json';
const LOCK_DIR = '.lock';
const ATTEMPT_ALLOC_MAX_TRIES = 64;
// Bounded wait for another process that holds a just-created directory
// between its `mkdir` and its metadata `rename` (~ms in practice).
const CROSS_PROCESS_READ_RETRIES = 25;
const CROSS_PROCESS_READ_DELAY_MS = 10;
// P20.1R R4/R5: bounded cross-process advisory lock (a `mkdir`-exclusive
// directory). No external dependency; no infinite spin. A crashed holder's
// lock is reclaimed once it is older than LOCK_STALE_MS (explicit orphan
// behavior — a P20.3 recovery pass will reconcile any half-built skeleton).
const LOCK_ACQUIRE_RETRIES = 400;
const LOCK_ACQUIRE_DELAY_MS = 15; // ~6s ceiling
const LOCK_STALE_MS = 15_000;

/** Real (non-busy-spin) synchronous millisecond sleep. */
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireDirLock(lockPath) {
  for (let i = 0; i < LOCK_ACQUIRE_RETRIES; i += 1) {
    if (mkdirExclusive(lockPath)) {
      try { writeFileSync(join(lockPath, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`); } catch { /* advisory only */ }
      return;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* another process reclaimed it */ }
        continue;
      }
    } catch {
      continue; // lock vanished between our failed mkdir and stat — retry now
    }
    sleepSyncMs(LOCK_ACQUIRE_DELAY_MS);
  }
  throw new ArtifactStoreError(`timed out acquiring lock ${lockPath} (bounded, no infinite spin)`, 'ARTIFACT_LOCK_TIMEOUT', { lockPath });
}

function releaseDirLock(lockPath) {
  try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * P20.6 §8 — an explicit `previousTaskRefs` on `allocateTask()` binds
 * immutably. A reopen is idempotent ONLY when the supplied list is
 * byte-identical to the persisted list in exact order (canonical concrete
 * identity, not object key order). Any other difference — length, order, a
 * drifted seal fact, or a first-bind/rebind of context after the task
 * exists — fails closed with `ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH`. The
 * persisted refs are never mutated here.
 */
function assertSameOrderedPreviousTaskRefs({ taskId, persisted, supplied }) {
  const p = Array.isArray(persisted) ? persisted : [];
  const s = Array.isArray(supplied) ? supplied : [];
  const mismatch = (why) => {
    throw new ArtifactStoreError(
      `artifact task ${JSON.stringify(taskId)} is already bound to a different historical context; refusing to reopen under changed previous_task_refs (${why})`,
      'ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH',
      { taskId, persistedCount: p.length, suppliedCount: s.length },
    );
  };
  if (p.length !== s.length) mismatch(`persisted ${p.length} ref(s), caller supplied ${s.length}`);
  for (let i = 0; i < p.length; i += 1) {
    const pk = canonicalArtifactRefIdentity(p[i]);
    const sk = canonicalArtifactRefIdentity(s[i]);
    if (pk === null || sk === null || pk !== sk) mismatch(`previous_task_refs[${i}] differs`);
  }
}

/** Run `fn` while holding an exclusive lock at `lockPath`; always released. */
function withDirLock(lockPath, fn) {
  acquireDirLock(lockPath);
  try { return fn(); } finally { releaseDirLock(lockPath); }
}

export class ArtifactStoreError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactStoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- low-level durable write helpers ---------------------------------

/**
 * Atomic single-file write via a unique temp sibling + rename (the exact
 * pattern already used by src/runtime/task-diagnostic-log.mjs and
 * repo-history-materializer.mjs). Errors propagate — an authoritative
 * app-owned metadata write is never silently swallowed (plan §11 P20.1C
 * "no swallowed authoritative-write failure").
 *
 * NOTE: this makes ONE file's replacement atomic. It does not make a
 * multi-file task/invocation/attempt creation transactional (freeze §22 /
 * plan §11: "Do not claim multi-file transaction atomicity merely because
 * one rename is atomic"). Recovery-aware readers below tolerate a
 * partially created skeleton.
 */
function atomicWriteFileSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function writeJsonAtomic(path, value) {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * P20.4R2 R12 / P20.4R3 R16 — describe any drift between a task manifest's
 * top-level Council identity and its `council_control` block, or `null` when
 * they agree.
 *
 * With `requirePresent === false` (the pre-bind skeleton window, BEFORE the
 * first bind back-fills legitimately-absent fields) only a PRESENT, conflicting
 * value is drift.
 *
 * With `requirePresent === true` (the control is already persisted / this
 * manifest is bound) the full top-level identity MUST be present AND equal — a
 * missing `mode` / `chair_profile_id` / `participant_profile_ids` is drift too.
 */
function councilControlTopLevelDrift(manifest, control, { requirePresent = false } = {}) {
  if (!manifest || !control) return null;
  const modeAbsent = manifest.mode === undefined || manifest.mode === null;
  if (requirePresent && modeAbsent) return "mode is missing (must be 'council')";
  if (!modeAbsent && manifest.mode !== 'council') return `mode ${JSON.stringify(manifest.mode)} is not 'council'`;

  const chairAbsent = typeof manifest.chair_profile_id !== 'string' || !manifest.chair_profile_id;
  if (requirePresent && chairAbsent) return 'chair_profile_id is missing';
  if (!chairAbsent && manifest.chair_profile_id !== control.chair_profile_id) {
    return `chair_profile_id ${JSON.stringify(manifest.chair_profile_id)} != council_control.chair_profile_id ${JSON.stringify(control.chair_profile_id)}`;
  }

  const partsAbsent = !Array.isArray(manifest.participant_profile_ids) || manifest.participant_profile_ids.length === 0;
  if (requirePresent && partsAbsent) return 'participant_profile_ids is missing or empty';
  if (!partsAbsent && JSON.stringify(manifest.participant_profile_ids) !== JSON.stringify(control.participant_profile_ids)) {
    return 'participant_profile_ids do not deep-equal council_control.participant_profile_ids in owner order';
  }
  return null;
}

/**
 * P20.4R3 R15 — the manifest-visible reasons an artifact Council task counts
 * as "progressed" (so a missing `council_control` is an authority error, not a
 * pristine pre-bind skeleton). Invocation-directory progress lives outside the
 * manifest and is checked separately.
 */
function councilArtifactProgressReasons(manifest) {
  const reasons = [];
  if (!manifest || typeof manifest !== 'object') return reasons;
  const stageCount = manifest.stages && typeof manifest.stages === 'object' && !Array.isArray(manifest.stages)
    ? Object.keys(manifest.stages).length : 0;
  if (stageCount > 0) reasons.push(`${stageCount} stage seal entr${stageCount === 1 ? 'y' : 'ies'}`);
  if (manifest.final_ref !== null && manifest.final_ref !== undefined) reasons.push('final_ref');
  if (manifest.task_state !== undefined && manifest.task_state !== TASK_STATE.OPEN) reasons.push(`task_state=${JSON.stringify(manifest.task_state)}`);
  if (manifest.artifact_gate_state !== null && manifest.artifact_gate_state !== undefined) reasons.push(`artifact_gate_state=${JSON.stringify(manifest.artifact_gate_state)}`);
  return reasons;
}

/**
 * Exclusive directory allocation. Returns `true` when THIS call created the
 * directory, `false` when it already existed. Any error other than EEXIST
 * propagates.
 */
function mkdirExclusive(path) {
  try {
    mkdirSync(path); // non-recursive: atomic create-or-fail
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/** A path is a UNC / network root (`\\server\share`, `//server/share`). */
function isUncPath(p) {
  return /^[\\/]{2}[^\\/]/.test(p);
}

// P20.3R R8: the store's path identity/containment now delegates to the ONE
// shared platform-aware primitive (src/artifacts/artifact-path-identity.mjs)
// — NEVER a manual `toLowerCase()` of an arbitrary Unicode path string.
// `samePath` is used for store/task/invocation directory identity;
// `sameLexicalPath` is used by the reparse check below to compare a lexical
// resolved path against its realpath.

/**
 * Fail closed on a reparse/symlink/junction whose real target is not the
 * resolved logical path (integrity gate §10 #5/#6). A non-existent path is
 * left for the caller's own create step — realpath ENOENT is not an
 * escape.
 */
function assertNoReparseSurprise(path, label) {
  if (!existsSync(path)) return;
  let real;
  try {
    real = realpathSync.native ? realpathSync.native(path) : realpathSync(path);
  } catch (error) {
    throw new ArtifactStoreError(`cannot resolve real path of ${label} (failing closed): ${error.message}`, 'ARTIFACT_ROOT_REPARSE', { path, label });
  }
  // Compare the LEXICAL resolved path to its realpath — a difference means
  // the logical path traverses a symlink/junction/reparse point. (Uses
  // `sameLexicalPath`, not `samePath`, which would canonicalise both sides
  // and always report equal.)
  //
  // The comparison is anchored on `path`'s PARENT's realpath, not on `path`
  // itself: an ANCESTOR directory reached only through a Windows 8.3
  // short-name alias (e.g. `C:\Users\RUNNER~1\...` for `C:\Users\runneradmin\...`,
  // observed on GitHub-hosted Windows runners' %TEMP%) is not a
  // symlink/junction/reparse point — it is the same physical directory
  // under an alternate DOS-compatible name, and realpath() legitimately
  // expands it. Only when THIS path's own final segment resolves outside
  // its (already-canonical) parent is that a genuine reparse surprise.
  let parentReal;
  try {
    parentReal = realpathSync.native ? realpathSync.native(dirname(path)) : realpathSync(dirname(path));
  } catch (error) {
    throw new ArtifactStoreError(`cannot resolve real path of ${label}'s parent (failing closed): ${error.message}`, 'ARTIFACT_ROOT_REPARSE', { path, label });
  }
  const expected = join(parentReal, basename(path));
  if (!sameLexicalPath(real, expected)) {
    throw new ArtifactStoreError(`${label} resolves through a symlink/junction/reparse point (failing closed): ${path} -> ${real}`, 'ARTIFACT_ROOT_REPARSE', { path, real, label });
  }
}

// ---- hash / size utilities (handoff §P20.1 "hash/size utilities") ----

export function fileByteLength(path) {
  return statSync(path).size;
}

/** Full-file (never prefix) sha256, streamed through one descriptor. */
export function hashFileSha256(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    // eslint-disable-next-line no-cond-assign
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

// ---- root resolution ------------------------------------------------

/**
 * Resolve the absolute P20 store root from a TRUSTED runtime base — never
 * from `process.cwd()` (freeze §4.1). Default source-checkout form is
 * `<runtimeBase>/dsh-artifacts/<project_id>/`.
 *
 * @param {{ runtimeBase: string, projectId: string }} input
 * @returns {string} absolute store root
 */
export function resolveArtifactStoreRoot({ runtimeBase, projectId }) {
  if (typeof runtimeBase !== 'string' || runtimeBase.trim() === '') {
    throw new ArtifactStoreError('runtimeBase (trusted absolute path) is required', 'ARTIFACT_ROOT_BASE_MISSING');
  }
  // UNC detection must run before the host-native isAbsolute() check:
  // path.isAbsolute() only recognizes '\\server\share'/'//server/share' as
  // absolute on win32, so on a POSIX host the relative-path branch would
  // fire first and report the wrong, less specific reason for the same
  // unsupported input. isUncPath() is a pure string pattern, not
  // host-dependent, so this ordering is deterministic on every platform.
  if (isUncPath(runtimeBase)) {
    throw new ArtifactStoreError(`UNC/network artifact roots are unsupported in P20 v1: ${JSON.stringify(runtimeBase)}`, 'ARTIFACT_ROOT_UNC_UNSUPPORTED', { runtimeBase });
  }
  if (!isAbsolute(runtimeBase)) {
    throw new ArtifactStoreError(`runtimeBase must be absolute, got: ${JSON.stringify(runtimeBase)}`, 'ARTIFACT_ROOT_BASE_RELATIVE', { runtimeBase });
  }
  assertProjectIdSegment(projectId);
  return resolve(runtimeBase, 'dsh-artifacts', projectId);
}

// ---- ArtifactStore -------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.storeId   explicit configured store identity
 * @param {string} input.projectId DSH project identity
 * @param {string} [input.runtimeBase] trusted absolute runtime base
 * @param {string} [input.root] pre-resolved absolute store root (overrides runtimeBase)
 * @param {() => Date} [input.now] injectable clock for metadata timestamps
 *        (folder names always use caller-supplied `createdAt`, never this)
 */
export function createArtifactStore(input) {
  return new ArtifactStore(input);
}

export class ArtifactStore {
  #storeId; #projectId; #root; #now; #ensured = false;

  constructor({ storeId, projectId, runtimeBase, root, now } = {}) {
    if (typeof storeId !== 'string' || storeId.trim() === '') {
      throw new ArtifactStoreError('storeId is required and must be explicit', 'ARTIFACT_STORE_ID_MISSING');
    }
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new ArtifactStoreError('projectId is required', 'ARTIFACT_PROJECT_ID_MISSING');
    }
    assertProjectIdSegment(projectId);
    if (root !== undefined && root !== null && typeof root === 'string' && isUncPath(root)) {
      throw new ArtifactStoreError(`explicit store root must not be a UNC/network path, got: ${JSON.stringify(root)}`, 'ARTIFACT_ROOT_UNC_UNSUPPORTED', { root });
    }
    if (root !== undefined && root !== null && (typeof root !== 'string' || !isAbsolute(root))) {
      throw new ArtifactStoreError(`explicit store root must be an absolute path, got: ${JSON.stringify(root)}`, 'ARTIFACT_ROOT_RELATIVE', { root });
    }
    const resolvedRoot = root ? resolve(root) : resolveArtifactStoreRoot({ runtimeBase, projectId });
    if (!isAbsolute(resolvedRoot)) {
      throw new ArtifactStoreError('resolved store root is not absolute', 'ARTIFACT_ROOT_RELATIVE', { root: resolvedRoot });
    }
    if (isUncPath(resolvedRoot)) {
      throw new ArtifactStoreError('UNC/network artifact roots are unsupported in P20 v1', 'ARTIFACT_ROOT_UNC_UNSUPPORTED', { root: resolvedRoot });
    }
    this.#storeId = storeId;
    this.#projectId = projectId;
    this.#root = resolvedRoot;
    this.#now = typeof now === 'function' ? now : () => new Date();
  }

  get storeId() { return this.#storeId; }
  get projectId() { return this.#projectId; }
  get root() { return this.#root; }
  get tasksRoot() { return join(this.#root, 'tasks'); }
  get indexesRoot() { return join(this.#root, 'indexes'); }
  get latestRoot() { return join(this.#root, 'latest'); }

  #iso() { return this.#now().toISOString(); }

  /**
   * Create the store root + identity file if absent; if present, verify the
   * persisted identity matches (freeze §4.1 / §23 "store/project identity
   * mismatch rejection"; integrity state ARTIFACT_STORE_MISMATCH). Lazily
   * called by every allocate method — a store that is only constructed and
   * never used touches no disk.
   */
  ensureStore() {
    if (this.#ensured) return this;
    mkdirSync(this.#root, { recursive: true });
    assertNoReparseSurprise(this.#root, 'artifact store root');
    const identityPath = join(this.#root, STORE_IDENTITY_FILE);

    // P20.1R R5: first-creation is exclusive. Two processes racing to
    // establish identity are serialized by the store lock; exactly one
    // writes store.json. Every process then RE-READS and verifies the
    // persisted winner before proceeding — a loser whose configured
    // identity differs from the winner fails closed here, and no later
    // operation runs under an identity other than persisted store.json.
    withDirLock(join(this.#root, LOCK_DIR), () => {
      if (!existsSync(identityPath)) {
        writeJsonAtomic(identityPath, {
          schema_version: ARTIFACT_SCHEMA_VERSION,
          store_id: this.#storeId,
          project_id: this.#projectId,
          created_at: this.#iso(),
        });
      }
    });

    this.#verifyPersistedStoreIdentity(identityPath);
    this.#ensured = true;
    return this;
  }

  #verifyPersistedStoreIdentity(identityPath) {
    let existing;
    try {
      existing = readJson(identityPath);
    } catch (error) {
      throw new ArtifactStoreError(`store identity file is unreadable/corrupt: ${error.message}`, 'ARTIFACT_STORE_IDENTITY_CORRUPT', { path: identityPath });
    }
    if (existing.schema_version !== ARTIFACT_SCHEMA_VERSION) {
      throw new ArtifactStoreError(`store schema version ${existing.schema_version} is not understood by this binary (expected ${ARTIFACT_SCHEMA_VERSION})`, 'ARTIFACT_STORE_SCHEMA_MISMATCH', { path: identityPath, found: existing.schema_version });
    }
    if (existing.store_id !== this.#storeId || existing.project_id !== this.#projectId) {
      throw new ArtifactStoreError(
        `refusing to operate under an identity different from persisted store.json: found store=${existing.store_id} project=${existing.project_id}, this instance is store=${this.#storeId} project=${this.#projectId}`,
        'ARTIFACT_STORE_MISMATCH',
        { path: identityPath, found: existing, expected: { store_id: this.#storeId, project_id: this.#projectId } },
      );
    }
  }

  /**
   * Allocate (or idempotently reopen) one immutable task root.
   *
   * @param {object} input
   * @param {string} input.taskId    canonical full DSH task id (authority)
   * @param {string} input.taskSlug  create-time slug source text
   * @param {string} input.createdAt UTC task-creation ISO-8601 (drives the folder name)
   * @param {string} [input.mode]
   * @param {string} [input.sourceRevision]
   * @param {string} [input.workspaceId]
   * @param {string} [input.chairProfileId]
   * @param {string[]} [input.participantProfileIds]
   * @param {object} [input.admittedCapabilitySnapshot]
   * @param {object[]} [input.previousTaskRefs]
   * @returns {TaskWorkspace}
   */
  allocateTask(input) {
    this.ensureStore();
    const { taskId, taskSlug: slugText, createdAt } = input ?? {};
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new ArtifactStoreError('taskId is required', 'ARTIFACT_TASK_ID_MISSING');
    }
    if (typeof createdAt !== 'string') {
      throw new ArtifactStoreError('createdAt (ISO-8601) is required and drives the immutable folder name', 'ARTIFACT_TASK_CREATED_AT_MISSING');
    }
    mkdirSync(this.tasksRoot, { recursive: true });
    // P20.2 §6.2: first task binding is serialized across independent
    // processes by the tasks-root lock — otherwise two processes with the
    // SAME full task_id but DIFFERENT create-time presentation (slug /
    // createdAt) could each pass the identity scan and create two folders
    // for one identity. Bounded, dependency-free (P20.1R withDirLock).
    return withDirLock(join(this.tasksRoot, LOCK_DIR), () => this.#allocateTaskLocked({ taskId, slugText, createdAt, input }));
  }

  #allocateTaskLocked({ taskId, slugText, createdAt, input }) {
    // Freeze §5/§10: reopen is by FULL task identity, never by the passed
    // slug/createdAt. `task-slug` is immutable create-time metadata and
    // "MUST NOT be renamed based on a later model-generated title" — so a
    // caller that later passes different slug text for the same task_id
    // gets the ORIGINAL folder back, never a second one.
    // P20.1R §9: `strictCorrupt` — a task folder whose manifest is present
    // but unreadable must BLOCK a new folder for any task id (fail closed),
    // never be silently skipped so a duplicate full task_id gets created.
    const already = this.openTaskById(taskId, { strictCorrupt: true });
    if (already) {
      // P20.6 §8 — close the reopen binding hole. When the caller EXPLICITLY
      // supplies `previousTaskRefs` (a P20.6-aware caller), an idempotent
      // reopen is allowed ONLY when the persisted refs are byte-identical in
      // exact order; a different set/order — including a first-bind or rebind
      // of historical context after the task already exists / has progress —
      // fails closed. A caller that never passes `previousTaskRefs` (every
      // pre-P20.6 caller) is unaffected.
      if (input.previousTaskRefs !== undefined) {
        assertSameOrderedPreviousTaskRefs({
          taskId,
          persisted: already.manifest.previous_task_refs ?? [],
          supplied: input.previousTaskRefs ?? [],
        });
      }
      return already;
    }

    const folder = taskFolderName({ taskId, createdAt, taskSlug: slugText });
    const taskPath = join(this.tasksRoot, folder);
    const manifestPath = join(taskPath, TASK_MANIFEST_FILE);

    const created = mkdirExclusive(taskPath);
    assertNoReparseSurprise(taskPath, 'task root');

    if (created) {
      const manifest = buildTaskManifest({
        storeId: this.#storeId,
        projectId: this.#projectId,
        taskId,
        taskSlug: folder.split('__')[1],
        createdAt,
        mode: input.mode ?? null,
        sourceRevision: input.sourceRevision ?? null,
        workspaceId: input.workspaceId ?? null,
        chairProfileId: input.chairProfileId ?? null,
        participantProfileIds: input.participantProfileIds ?? [],
        admittedCapabilitySnapshot: input.admittedCapabilitySnapshot ?? null,
        previousTaskRefs: input.previousTaskRefs ?? [],
      });
      const check = validateTaskManifest(manifest);
      if (!check.ok) {
        throw new ArtifactStoreError(`internal: built task manifest failed validation: ${check.errors.join('; ')}`, 'ARTIFACT_MANIFEST_INVALID', { errors: check.errors });
      }
      writeJsonAtomic(manifestPath, manifest);
      return new TaskWorkspace(this, taskPath, manifest);
    }

    // Directory already existed — deterministic idempotent reopen, or a
    // genuine cross-identity collision (freeze §22.1).
    const manifest = this.#readTaskManifestWithRetry(manifestPath, folder);
    if (manifest.task_id !== taskId) {
      throw new ArtifactStoreError(
        `task folder ${folder} already belongs to a different task identity (${manifest.task_id}); refusing to overwrite`,
        'ARTIFACT_TASK_IDENTITY_COLLISION',
        { folder, existingTaskId: manifest.task_id, requestedTaskId: taskId },
      );
    }
    if (manifest.store_id !== this.#storeId || manifest.project_id !== this.#projectId) {
      throw new ArtifactStoreError(
        `task folder ${folder} was written under store=${manifest.store_id} project=${manifest.project_id}, not store=${this.#storeId} project=${this.#projectId}`,
        'ARTIFACT_STORE_MISMATCH',
        { folder, found: { store_id: manifest.store_id, project_id: manifest.project_id } },
      );
    }
    return new TaskWorkspace(this, taskPath, manifest);
  }

  /**
   * Deterministic reopen by full task identity: scan `tasks/` for a
   * manifest whose `task_id` matches. Returns null if none.
   *
   * @param {string} taskId
   * @param {{ strictCorrupt?: boolean }} [opts] when true, a present-but-
   *   unreadable manifest throws ARTIFACT_TASK_MANIFEST_CORRUPT instead of
   *   being skipped (P20.1R §9 — fail closed for allocateTask).
   */
  openTaskById(taskId, { strictCorrupt = false } = {}) {
    this.ensureStore();
    if (!existsSync(this.tasksRoot)) return null;
    for (const entry of readdirSync(this.tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === LOCK_DIR) continue;
      const manifestPath = join(this.tasksRoot, entry.name, TASK_MANIFEST_FILE);
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = readJson(manifestPath);
      } catch (error) {
        if (strictCorrupt) {
          throw new ArtifactStoreError(
            `task folder ${entry.name} has an unreadable/corrupt ${TASK_MANIFEST_FILE}; refusing to allocate anything until it is resolved: ${error.message}`,
            'ARTIFACT_TASK_MANIFEST_CORRUPT',
            { folder: entry.name, manifestPath },
          );
        }
        continue;
      }
      if (manifest.task_id !== taskId) continue;
      if (manifest.store_id !== this.#storeId || manifest.project_id !== this.#projectId) {
        throw new ArtifactStoreError(
          `task ${taskId} found under a mismatched store/project identity`,
          'ARTIFACT_STORE_MISMATCH',
          { taskId, found: { store_id: manifest.store_id, project_id: manifest.project_id } },
        );
      }
      return new TaskWorkspace(this, join(this.tasksRoot, entry.name), manifest);
    }
    return null;
  }

  #readTaskManifestWithRetry(manifestPath, folder) {
    let sawUnparseable = false;
    for (let i = 0; i < CROSS_PROCESS_READ_RETRIES; i += 1) {
      if (existsSync(manifestPath)) {
        try { return readJson(manifestPath); } catch { sawUnparseable = true; }
      }
      // Another process holds the create between its mkdir and its manifest
      // rename. Bounded wait; then we give up honestly.
      sleepSyncMs(CROSS_PROCESS_READ_DELAY_MS);
    }
    // P20.1R §9: fail closed, and say which — corrupt (present but never
    // parseable) vs missing (never appeared) — never "not found".
    if (sawUnparseable) {
      throw new ArtifactStoreError(
        `task folder ${folder} has an unreadable/corrupt ${TASK_MANIFEST_FILE}`,
        'ARTIFACT_TASK_MANIFEST_CORRUPT',
        { folder, manifestPath },
      );
    }
    throw new ArtifactStoreError(
      `task folder ${folder} exists but its ${TASK_MANIFEST_FILE} never appeared (partially-created / orphaned skeleton)`,
      'ARTIFACT_TASK_MANIFEST_MISSING',
      { folder, manifestPath },
    );
  }

  /** @internal used by workspace children */
  _iso() { return this.#iso(); }
  /** @internal */
  _identity() { return { store_id: this.#storeId, project_id: this.#projectId }; }
}

// ---- TaskWorkspace ------------------------------------------------

export class TaskWorkspace {
  #store; #path; #manifest;

  constructor(store, path, manifest) {
    this.#store = store;
    this.#path = path;
    this.#manifest = manifest;
  }

  get path() { return this.#path; }
  get taskId() { return this.#manifest.task_id; }
  get manifest() { return structuredClone(this.#manifest); }
  get manifestPath() { return join(this.#path, TASK_MANIFEST_FILE); }
  /** Store-relative POSIX path of this task root. */
  get storeRelpath() {
    return this.#path.slice(this.#store.root.length + 1).split(sep).join('/');
  }

  /**
   * Allocate (or idempotently reopen) one invocation directory for a
   * report-producing stage (freeze §7).
   *
   * @param {object} input
   * @param {string} input.invocationId stable logical stage id (authority)
   * @param {string} input.role   one of ARTIFACT_ROLE
   * @param {string} input.stage  one of ARTIFACT_STAGE
   * @param {string} input.profileId full configured backend/profile id
   * @param {string} input.actorAlias app-owned stable alias
   * @param {number|null} [input.round] debate round (1..99) when applicable
   * @param {number|null} [input.repairOf] prior attempt ordinal this invocation repairs
   * @returns {InvocationWorkspace}
   */
  allocateInvocation(input) {
    const { invocationId, profileId, actorAlias } = input ?? {};
    if (typeof invocationId !== 'string' || invocationId.trim() === '') {
      throw new ArtifactStoreError('invocationId is required', 'ARTIFACT_INVOCATION_ID_MISSING');
    }
    if (typeof profileId !== 'string' || profileId.trim() === '') {
      throw new ArtifactStoreError('profileId is required', 'ARTIFACT_PROFILE_ID_MISSING');
    }
    assertActorAlias(actorAlias, 'actorAlias'); // R6
    // P20.2 §6.2: first invocation binding is serialized across independent
    // processes by the task lock — otherwise two processes with the SAME
    // full invocation_id but a DIFFERENT stage/binding could each pass the
    // task-local scan and create two invocation directories for one id.
    return withDirLock(join(this.#path, LOCK_DIR), () => this.#allocateInvocationLocked(input ?? {}));
  }

  #allocateInvocationLocked(input) {
    const { invocationId, role, stage, profileId, actorAlias, round = null, repairOf = null } = input;
    // R3: stageDirSegments enforces the frozen role/stage(/round) matrix.
    const stageSegs = stageDirSegments({ role, stage, actorAlias, round });
    const key = computeInvocationKey(invocationId);
    assertSafeSegment(key, 'invocation key');
    const stageDir = join(this.#path, ...stageSegs);
    const invPath = join(stageDir, key);
    const invFile = join(invPath, INVOCATION_FILE);
    const stageRelpath = toStoreRelativePosix([...this.storeRelpath.split('/'), ...stageSegs]);
    const { store_id, project_id } = this.#store._identity();

    // The full immutable binding this invocation_id MUST carry (R2).
    const expectedBinding = {
      store_id,
      project_id,
      task_id: this.taskId,
      role,
      stage,
      round: round ?? null,
      profile_id: profileId,
      actor_alias: actorAlias,
      invocation_key: key,
      stage_relpath: stageRelpath,
    };

    // R2.2: one task MUST NOT contain the same full invocation_id in two
    // different stage paths. Task-local full-ID authority scan before we
    // create anything — a hit at a DIFFERENT path fails closed.
    const found = this.#findInvocationById(invocationId);
    if (found && resolve(found.path) !== resolve(invPath)) {
      throw new ArtifactStoreError(
        `invocation_id ${JSON.stringify(invocationId)} is already bound in this task at ${found.record.stage_relpath}/${found.record.invocation_key}; refusing to rebind it under ${stageRelpath}/${key}`,
        'ARTIFACT_INVOCATION_ID_REBOUND',
        { invocationId, existingRelpath: `${found.record.stage_relpath}/${found.record.invocation_key}`, requestedRelpath: `${stageRelpath}/${key}` },
      );
    }

    mkdirSync(stageDir, { recursive: true });
    const created = mkdirExclusive(invPath);
    assertNoReparseSurprise(invPath, 'invocation directory');

    if (created) {
      const record = buildInvocationRecord({
        invocationId,
        invocationKey: key,
        storeId: store_id,
        projectId: project_id,
        taskId: this.taskId,
        role,
        stage,
        round,
        profileId,
        actorAlias,
        stageRelpath,
        createdAt: this.#store._iso(),
        repairOf,
      });
      const check = validateInvocationRecord(record);
      if (!check.ok) {
        throw new ArtifactStoreError(`internal: built invocation record failed validation: ${check.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: check.errors });
      }
      writeJsonAtomic(invFile, record);
      return new InvocationWorkspace(this.#store, this, invPath, record);
    }

    // Directory already existed — reopen ONLY if the full immutable binding
    // matches (R2.1); otherwise fail closed, never silently return the old
    // invocation.
    const record = this.#readInvocationWithRetry(invFile, key);
    const rv = validateInvocationRecord(record);
    if (!rv.ok) {
      throw new ArtifactStoreError(`persisted invocation record is invalid: ${rv.errors.join('; ')}`, 'ARTIFACT_INVOCATION_RECORD_INVALID', { key, errors: rv.errors });
    }
    this.#assertInvocationBindingMatches(record, invocationId, expectedBinding, key);
    return new InvocationWorkspace(this.#store, this, invPath, record);
  }

  /**
   * R2 — a single logical invocation_id is bound to the full immutable
   * tuple. A same-id reopen whose binding differs is a fail-closed error,
   * not a silent old-record return.
   */
  #assertInvocationBindingMatches(record, invocationId, expected, key) {
    if (record.invocation_id !== invocationId) {
      throw new ArtifactStoreError(
        `invocation key ${key} already belongs to a different invocation identity (${record.invocation_id}); refusing to overwrite`,
        'ARTIFACT_INVOCATION_IDENTITY_COLLISION',
        { key, existingInvocationId: record.invocation_id, requestedInvocationId: invocationId },
      );
    }
    const mismatches = [];
    for (const [field, want] of Object.entries(expected)) {
      const have = record[field] ?? null;
      if (have !== want) mismatches.push(`${field}: on-disk=${JSON.stringify(have)} requested=${JSON.stringify(want)}`);
    }
    if (mismatches.length) {
      throw new ArtifactStoreError(
        `invocation ${invocationId} reopen rejected — immutable binding changed: ${mismatches.join('; ')}`,
        'ARTIFACT_INVOCATION_BINDING_MISMATCH',
        { invocationId, mismatches },
      );
    }
  }

  /**
   * Bounded recursive scan of this task tree for an `invocation.json` whose
   * `invocation_id` equals `invocationId`. Returns `{ path, record }` or
   * null. Unrelated unparseable invocation files are skipped (the target's
   * own corruption is caught in the reopen path).
   */
  #findInvocationById(invocationId, dir = this.#path, depth = 0) {
    if (depth > 12) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // Check this dir's invocation.json first.
    if (entries.some((e) => e.isFile() && e.name === INVOCATION_FILE)) {
      try {
        const rec = readJson(join(dir, INVOCATION_FILE));
        if (rec && rec.invocation_id === invocationId) return { path: dir, record: rec };
      } catch { /* unrelated corrupt file — skip */ }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === LOCK_DIR || e.name.startsWith('attempt-')) continue;
      const hit = this.#findInvocationById(invocationId, join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * P20.4R3 R15 — bounded task-local scan: does ANY `invocation.json` exist
   * anywhere under this task tree? Used by `bindCouncilControl()` to detect
   * Council artifact progress that lives OUTSIDE the manifest (invocation
   * directories are created before their first stage seal is recorded).
   */
  #hasAnyInvocationDir(dir = this.#path, depth = 0) {
    if (depth > 12) return false;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    if (entries.some((e) => e.isFile() && e.name === INVOCATION_FILE)) return true;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === LOCK_DIR || e.name.startsWith('attempt-')) continue;
      if (this.#hasAnyInvocationDir(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }

  /**
   * P20.3R R4 — durable, task-local resolution of an invocation by its FULL
   * `invocation_id` from persisted metadata. Returns an `InvocationWorkspace`
   * bound to the found directory, or throws `ARTIFACT_INVOCATION_RECORD_MISSING`.
   * The consumer verifier uses this instead of trusting a caller-supplied
   * invocation object.
   */
  openInvocationById(invocationId) {
    if (typeof invocationId !== 'string' || !invocationId) {
      throw new ArtifactStoreError('openInvocationById requires an invocation_id', 'ARTIFACT_INVOCATION_ID_MISSING');
    }
    const hit = this.#findInvocationById(invocationId);
    if (!hit) {
      throw new ArtifactStoreError(`no invocation ${JSON.stringify(invocationId)} in task ${this.taskId}`, 'ARTIFACT_INVOCATION_RECORD_MISSING', { invocationId, taskId: this.taskId });
    }
    return new InvocationWorkspace(this.#store, this, hit.path, hit.record);
  }

  #readInvocationWithRetry(invFile, key) {
    let sawUnparseable = false;
    for (let i = 0; i < CROSS_PROCESS_READ_RETRIES; i += 1) {
      if (existsSync(invFile)) {
        try { return readJson(invFile); } catch { sawUnparseable = true; }
      }
      sleepSyncMs(CROSS_PROCESS_READ_DELAY_MS);
    }
    if (sawUnparseable) {
      throw new ArtifactStoreError(
        `invocation directory ${key} has an unreadable/corrupt ${INVOCATION_FILE}`,
        'ARTIFACT_INVOCATION_RECORD_CORRUPT',
        { key, invFile },
      );
    }
    throw new ArtifactStoreError(
      `invocation directory ${key} exists but its ${INVOCATION_FILE} never appeared (partially-created / orphaned skeleton)`,
      'ARTIFACT_INVOCATION_RECORD_MISSING',
      { key, invFile },
    );
  }

  // ================= P20.3 — task-level fresh-disk authority =================

  #taskLock() { return join(this.#path, LOCK_DIR); }

  /** Locked fresh read + schema validation of task-manifest.json. Updates the cache. */
  freshManifest() {
    return withDirLock(this.#taskLock(), () => {
      let m;
      try { m = readJson(this.manifestPath); } catch (error) {
        throw new ArtifactStoreError(`task-manifest.json unreadable: ${error.message}`, 'ARTIFACT_TASK_MANIFEST_CORRUPT', { path: this.manifestPath });
      }
      const v = validateTaskManifest(m);
      if (!v.ok) throw new ArtifactStoreError(`task-manifest.json failed validation: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      this.#manifest = m;
      return structuredClone(m);
    });
  }

  /**
   * P20.4R R4 — bind the versioned app-owned Council control block to this
   * artifact_v1 Council task. Locked, fresh-read. First bind validates +
   * writes it; a later bind with a DIFFERENT control (roster / order /
   * rounds / chair / strategy / implementation participant / workspace
   * requirement / evidence paths / debate) fails closed with
   * `COUNCIL_ARTIFACT_CONTROL_MISMATCH` — a task_id can never be reopened
   * under a different normalized Council control. Idempotent for an equal
   * control. `topLevel` optionally back-fills `chair_profile_id` /
   * `participant_profile_ids` / `admitted_capability_snapshot` /
   * `source_revision` / `workspace_id` when they are still absent.
   *
   * P20.4R2 R12 — even on the idempotent (persisted-control-equal) return,
   * the top-level `mode` / `chair_profile_id` / `participant_profile_ids`
   * MUST agree with the bound control; a drifted/mutated top-level identity
   * fails closed with `COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH` — it is
   * never silently accepted.
   */
  bindCouncilControl({ control, topLevel = {} }) {
    const cv = validateCouncilArtifactControl(control);
    if (!cv.ok) {
      throw new ArtifactStoreError(`council_control is not a valid Council artifact control block: ${cv.errors.join('; ')}`, 'COUNCIL_ARTIFACT_CONTROL_INVALID', { errors: cv.errors });
    }
    return withDirLock(this.#taskLock(), () => {
      let m;
      try { m = readJson(this.manifestPath); } catch (error) {
        throw new ArtifactStoreError(`task-manifest.json unreadable during council-control bind: ${error.message}`, 'ARTIFACT_TASK_MANIFEST_CORRUPT', { path: this.manifestPath });
      }
      if (m.council_control) {
        if (JSON.stringify(m.council_control) !== JSON.stringify(control)) {
          throw new ArtifactStoreError('this artifact Council task is already bound to a different normalized Council control; refusing to reopen under a changed roster/order/rounds/chair', 'COUNCIL_ARTIFACT_CONTROL_MISMATCH', { taskId: m.task_id });
        }
        // R12/R16: persisted control matches — but the top-level identity must
        // be PRESENT and equal (not merely non-conflicting); a drifted OR
        // missing mode/chair/participants is a fail-closed condition on an
        // idempotent re-bind.
        const drift = councilControlTopLevelDrift(m, m.council_control, { requirePresent: true });
        if (drift) {
          throw new ArtifactStoreError(`task-manifest top-level Council identity has drifted from council_control: ${drift}`, 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH', { taskId: m.task_id });
        }
        this.#manifest = m;
        return structuredClone(m); // idempotent
      }

      // P20.4R3 R15 — no persisted council_control. A pristine skeleton may be
      // bound for the first time, but once ANY artifact Council progress
      // exists (manifest stage entries / final_ref / progressed task state, OR
      // an on-disk Council invocation directory) a missing council_control is
      // an authority error — never a silent "first bind" that could
      // re-authorize the task under changed control fields.
      const progress = councilArtifactProgressReasons(m).concat(this.#hasAnyInvocationDir() ? ['an existing Council invocation directory'] : []);
      if (progress.length > 0) {
        throw new ArtifactStoreError(
          `artifact Council task ${JSON.stringify(m.task_id)} has progress but no persisted council_control; refusing to (re-)bind (found: ${progress.join(', ')})`,
          'COUNCIL_ARTIFACT_CONTROL_MISSING_AFTER_PROGRESS',
          { taskId: m.task_id, progress },
        );
      }

      m.council_control = control;
      // R12: a pre-bind skeleton may carry a WRONG top-level identity (manual
      // mutation / corruption) — the first bind must not paper over it. Absent
      // fields are still allowed here (they are back-filled just below, BEFORE
      // the bound manifest is validated/persisted).
      const preDrift = councilControlTopLevelDrift(m, control, { requirePresent: false });
      if (preDrift) {
        throw new ArtifactStoreError(`task-manifest top-level Council identity conflicts with the control being bound: ${preDrift}`, 'COUNCIL_ARTIFACT_CONTROL_TOPLEVEL_MISMATCH', { taskId: m.task_id });
      }
      if (!m.chair_profile_id && typeof topLevel.chairProfileId === 'string') m.chair_profile_id = topLevel.chairProfileId;
      if ((!Array.isArray(m.participant_profile_ids) || m.participant_profile_ids.length === 0) && Array.isArray(topLevel.participantProfileIds)) {
        m.participant_profile_ids = [...topLevel.participantProfileIds];
      }
      if (m.admitted_capability_snapshot == null && topLevel.admittedCapabilitySnapshot != null) m.admitted_capability_snapshot = topLevel.admittedCapabilitySnapshot;
      if (m.source_revision == null && typeof topLevel.sourceRevision === 'string') m.source_revision = topLevel.sourceRevision;
      if (m.workspace_id == null && typeof topLevel.workspaceId === 'string') m.workspace_id = topLevel.workspaceId;
      m.updated_at = this.#store._iso();
      const v = validateTaskManifest(m);
      if (!v.ok) throw new ArtifactStoreError(`task-manifest.json invalid after council-control bind: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      writeJsonAtomic(this.manifestPath, m);
      this.#manifest = m;
      return structuredClone(m);
    });
  }

  /**
   * P20.3 §16 step 8 — record a stage's sealed invocation reference on the
   * task manifest. Locked, fresh-read, idempotent (a re-commit with an
   * equal entry is a no-op; a conflicting entry fails closed).
   *
   * P20.3R2 R11: the entry MUST satisfy the shared `validateStageSealEntry`
   * contract (bound to this manifest's identity) BEFORE any authoritative
   * task metadata is written — no internally inconsistent stage entry, no
   * cross-task/store/project `sealed_ref`.
   */
  commitStageSeal({ stageKey, entry }) {
    if (typeof stageKey !== 'string' || !stageKey) throw new ArtifactStoreError('commitStageSeal requires a stageKey', 'ARTIFACT_METADATA_INVALID');
    return withDirLock(this.#taskLock(), () => {
      let m;
      try { m = readJson(this.manifestPath); } catch (error) {
        throw new ArtifactStoreError(`task-manifest.json unreadable during stage seal: ${error.message}`, 'ARTIFACT_TASK_MANIFEST_CORRUPT', { path: this.manifestPath });
      }
      const sev = validateStageSealEntry(entry, { storeId: m.store_id, projectId: m.project_id, taskId: m.task_id });
      if (!sev.ok) {
        throw new ArtifactStoreError(`stage ${JSON.stringify(stageKey)} sealed entry is not a valid sealed stage entry: ${sev.errors.join('; ')}`, 'ARTIFACT_SEAL_FAILED', { stageKey, errors: sev.errors });
      }
      if (!m.stages || typeof m.stages !== 'object' || Array.isArray(m.stages)) m.stages = {};
      const existing = m.stages[stageKey];
      if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new ArtifactStoreError(`task manifest stage ${JSON.stringify(stageKey)} already sealed with a different reference`, 'ARTIFACT_FINAL_REF_CONFLICT', { stageKey });
      }
      m.stages[stageKey] = entry;
      m.updated_at = this.#store._iso();
      const v = validateTaskManifest(m);
      if (!v.ok) throw new ArtifactStoreError(`task-manifest.json invalid after stage seal: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      writeJsonAtomic(this.manifestPath, m);
      this.#manifest = m;
      return structuredClone(m);
    });
  }

  /**
   * P20.3 §23/§25 — the Task Final Artifact Gate commit. `finalRef` MUST be
   * a sealed ArtifactReference (`requireSealed:true`). Locked, fresh-read,
   * deterministic: an already-set `final_ref` must be byte-equal on
   * re-commit (deterministic reopen) or it fails closed.
   *
   * P20.3R2 R12: this public store method defends its OWN task/store/project
   * boundary — it does not rely on `runTaskFinalArtifactGate()` being the
   * only caller. `finalRef` must belong to this task/store/project, and for
   * a `COMPLETED` / `TASK_ARTIFACT_PASS` commit it must structurally equal
   * the sealed stage entry named by `expectedStageKey` (default `single`
   * for the P20.3 SINGLE topology; P20.4 supplies its own key).
   */
  commitFinalRef({ finalRef, taskState = TASK_STATE.COMPLETED, gateState = 'TASK_ARTIFACT_PASS', expectedStageKey = 'single' }) {
    const rv = validateArtifactReference(finalRef, { requireSealed: true });
    if (!rv.ok) throw new ArtifactStoreError(`final_ref is not a valid sealed ArtifactReference: ${rv.errors.join('; ')}`, 'ARTIFACT_SEAL_FAILED', { errors: rv.errors });
    if (!TASK_STATE || !Object.values(TASK_STATE).includes(taskState)) throw new ArtifactStoreError(`invalid taskState ${JSON.stringify(taskState)}`, 'ARTIFACT_METADATA_INVALID');
    return withDirLock(this.#taskLock(), () => {
      let m;
      try { m = readJson(this.manifestPath); } catch (error) {
        throw new ArtifactStoreError(`task-manifest.json unreadable during final-ref commit: ${error.message}`, 'ARTIFACT_TASK_MANIFEST_CORRUPT', { path: this.manifestPath });
      }

      // R12: task / store / project boundary self-protection.
      const { store_id: sId, project_id: pId } = this.#store._identity();
      if (finalRef.task_id !== m.task_id) {
        throw new ArtifactStoreError(`final_ref.task_id ${JSON.stringify(finalRef.task_id)} does not belong to task ${JSON.stringify(m.task_id)}`, 'ARTIFACT_FINAL_REF_CROSS_TASK', { finalRefTaskId: finalRef.task_id, taskId: m.task_id });
      }
      if (finalRef.store_id !== m.store_id || finalRef.store_id !== sId) {
        throw new ArtifactStoreError(`final_ref.store_id ${JSON.stringify(finalRef.store_id)} does not match the task/store`, 'ARTIFACT_FINAL_REF_CROSS_TASK', { finalRefStoreId: finalRef.store_id, storeId: sId, manifestStoreId: m.store_id });
      }
      if (finalRef.project_id !== m.project_id || finalRef.project_id !== pId) {
        throw new ArtifactStoreError(`final_ref.project_id ${JSON.stringify(finalRef.project_id)} does not match the task/store`, 'ARTIFACT_FINAL_REF_CROSS_TASK', { finalRefProjectId: finalRef.project_id, projectId: pId, manifestProjectId: m.project_id });
      }

      // R12: a task COMPLETED / TASK_ARTIFACT_PASS commit must correspond to
      // an existing, structurally valid sealed stage entry, and final_ref
      // must equal that stage's sealed reference.
      if (taskState === TASK_STATE.COMPLETED && gateState === 'TASK_ARTIFACT_PASS') {
        const stage = m.stages?.[expectedStageKey];
        if (!stage) {
          throw new ArtifactStoreError(`cannot complete task: manifest stage ${JSON.stringify(expectedStageKey)} has no sealed entry`, 'ARTIFACT_SEAL_FAILED', { expectedStageKey });
        }
        const sev = validateStageSealEntry(stage, { storeId: m.store_id, projectId: m.project_id, taskId: m.task_id });
        if (!sev.ok) {
          throw new ArtifactStoreError(`cannot complete task: stage ${JSON.stringify(expectedStageKey)} entry invalid: ${sev.errors.join('; ')}`, 'ARTIFACT_SEAL_FAILED', { expectedStageKey, errors: sev.errors });
        }
        if (JSON.stringify(stage.sealed_ref) !== JSON.stringify(finalRef)) {
          throw new ArtifactStoreError(`final_ref does not structurally equal the sealed stage ${JSON.stringify(expectedStageKey)} reference`, 'ARTIFACT_FINAL_REF_CONFLICT', { expectedStageKey });
        }
      }

      if (m.final_ref) {
        if (JSON.stringify(m.final_ref) !== JSON.stringify(finalRef)) {
          throw new ArtifactStoreError('task already has a different final_ref; refusing to overwrite sealed authority', 'ARTIFACT_FINAL_REF_CONFLICT', { existing: m.final_ref });
        }
        this.#manifest = m;
        return structuredClone(m); // idempotent
      }
      m.final_ref = finalRef;
      m.task_state = taskState;
      m.artifact_gate_state = gateState;
      m.updated_at = this.#store._iso();
      const v = validateTaskManifest(m);
      if (!v.ok) throw new ArtifactStoreError(`task-manifest.json invalid after final-ref commit: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      writeJsonAtomic(this.manifestPath, m);
      this.#manifest = m;
      return structuredClone(m);
    });
  }
}

// ---- InvocationWorkspace ---------------------------------------------

export class InvocationWorkspace {
  #store; #task; #path; #record;

  constructor(store, task, path, record) {
    this.#store = store;
    this.#task = task;
    this.#path = path;
    this.#record = record;
  }

  get path() { return this.#path; }
  get invocationId() { return this.#record.invocation_id; }
  get invocationKey() { return this.#record.invocation_key; }
  get record() { return structuredClone(this.#record); }
  get recordPath() { return join(this.#path, INVOCATION_FILE); }

  /** Ordinals of every attempt directory currently on disk, ascending. */
  listAttemptOrdinals() {
    if (!existsSync(this.#path)) return [];
    return readdirSync(this.#path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => parseAttemptDirName(e.name)) // `.lock` / files parse to null and are dropped
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
  }

  /**
   * Exclusively allocate the next monotonic attempt directory (freeze §7 /
   * §22.3/§22.4). Never reuses an existing attempt directory.
   *
   * P20.1R R4: the WHOLE allocation — pick ordinal, create the directory,
   * write `artifact.json`, update the parent `invocation.json` — runs under
   * a bounded cross-process directory lock, and the parent `attempts` list
   * is RE-DERIVED from the actual on-disk attempt directories (never from a
   * possibly-stale cached record). Two processes / two independently-opened
   * InvocationWorkspace objects therefore cannot lose an already-allocated
   * ordinal from the persisted history.
   *
   * It does NOT set lifecycle to DELIVERED/SEALED and does NOT set
   * `authoritative_attempt` (P20.3). No report or log file is created for
   * an unexecuted attempt (freeze §7) — their PATHS are returned only.
   *
   * @param {object} input
   * @param {string} [input.executionId] unique physical execution id (auto if absent)
   * @param {string} input.deliveryMechanism one of DELIVERY_MECHANISM
   * @param {string} [input.inputTransport] one of INPUT_TRANSPORT
   * @param {string} input.startedAt ISO-8601 invocation start (drives the filename timestamp)
   * @param {number|null} [input.repairOf] prior attempt ordinal this attempt repairs
   * @returns {AttemptWorkspace}
   */
  allocateAttempt(input) {
    const {
      executionId = `exec-${randomUUID()}`,
      deliveryMechanism,
      inputTransport = null,
      startedAt,
      repairOf = null,
    } = input ?? {};
    if (typeof startedAt !== 'string') {
      throw new ArtifactStoreError('startedAt (ISO-8601) is required and drives the report/log filename timestamp', 'ARTIFACT_ATTEMPT_STARTED_AT_MISSING');
    }

    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let ordinal = null;
      let attemptPath = null;
      for (let tries = 0; tries < ATTEMPT_ALLOC_MAX_TRIES; tries += 1) {
        const existing = this.listAttemptOrdinals();
        const next = existing.length ? existing[existing.length - 1] + 1 : 0;
        const candidate = join(this.#path, attemptDirName(next));
        if (mkdirExclusive(candidate)) {
          ordinal = next;
          attemptPath = candidate;
          break;
        }
        // A stale/orphan attempt dir from a crashed run: recompute and take
        // the next free ordinal — never reuse.
      }
      if (ordinal === null) {
        throw new ArtifactStoreError(`could not allocate a fresh attempt directory after ${ATTEMPT_ALLOC_MAX_TRIES} tries`, 'ARTIFACT_ATTEMPT_ALLOCATION_EXHAUSTED', { invocationId: this.invocationId });
      }
      assertNoReparseSurprise(attemptPath, 'attempt directory');

      const { store_id, project_id } = this.#store._identity();
      const alias = this.#record.actor_alias;
      const stage = this.#record.stage;
      const reportName = reportFileName({ startedAt, actorAlias: alias, stage });
      const logName = executiveLogFileName({ startedAt, actorAlias: alias, stage });
      const attemptRelBase = `${this.#record.stage_relpath}/${this.#record.invocation_key}/${attemptDirName(ordinal)}`;

      const metadata = buildArtifactMetadata({
        storeId: store_id,
        projectId: project_id,
        taskId: this.#record.task_id,
        invocationId: this.invocationId,
        executionId,
        attemptOrdinal: ordinal,
        role: this.#record.role,
        stage,
        round: this.#record.round,
        profileId: this.#record.profile_id,
        actorAlias: alias,
        deliveryMechanism,
        inputTransport,
        startedAt,
        reportRelpath: `${attemptRelBase}/${reportName}`,
        executiveLogRelpath: `${attemptRelBase}/${logName}`,
        repairOf,
      });
      const check = validateArtifactMetadata(metadata);
      if (!check.ok) {
        throw new ArtifactStoreError(`built artifact.json failed validation: ${check.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: check.errors });
      }
      writeJsonAtomic(join(attemptPath, 'artifact.json'), metadata);

      // R4: parent attempts/latest re-derived from the actual on-disk
      // attempt directories, from a FRESH read of invocation.json — never
      // from the cached #record. Lifecycle stays ASSIGNED; no authority.
      let parent;
      try {
        parent = readJson(this.recordPath);
      } catch (error) {
        throw new ArtifactStoreError(`parent ${INVOCATION_FILE} unreadable during attempt commit: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      parent.attempts = this.listAttemptOrdinals();
      parent.latest_attempt_ordinal = parent.attempts.length ? parent.attempts[parent.attempts.length - 1] : null;
      parent.updated_at = this.#store._iso();
      const rcheck = validateInvocationRecord(parent);
      if (!rcheck.ok) {
        throw new ArtifactStoreError(`internal: updated invocation record failed validation: ${rcheck.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: rcheck.errors });
      }
      writeJsonAtomic(this.recordPath, parent);
      this.#record = parent;

      return new AttemptWorkspace(attemptPath, { ordinal, executionId, reportName, logName, metadata });
    });
  }

  /**
   * P20.2 §18 — advance the invocation lifecycle. Only `ASSIGNED → RUNNING`
   * and `RUNNING → DELIVERED` are permitted here (idempotent re-entry to the
   * same state is a no-op). `SEALED` / `authoritative_attempt` / `final_ref`
   * are NOT set — P20.3 owns those. Fails closed from a terminal state.
   *
   * @param {'RUNNING'|'DELIVERED'} next
   */
  #advanceLifecycle(next) {
    const ALLOWED = { ASSIGNED: ['ASSIGNED', 'RUNNING'], RUNNING: ['RUNNING', 'DELIVERED'], DELIVERED: ['DELIVERED'] };
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable during lifecycle advance: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      if (rec.lifecycle === next) { this.#record = rec; return rec; }
      const allowedFrom = ALLOWED[rec.lifecycle];
      if (!allowedFrom || !allowedFrom.includes(next)) {
        throw new ArtifactStoreError(`cannot advance invocation lifecycle ${rec.lifecycle} -> ${next} in P20.2`, 'ARTIFACT_INVOCATION_LIFECYCLE_INVALID', { from: rec.lifecycle, to: next });
      }
      rec.lifecycle = next;
      rec.updated_at = this.#store._iso();
      const check = validateInvocationRecord(rec);
      if (!check.ok) throw new ArtifactStoreError(`invocation.json invalid after lifecycle advance: ${check.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: check.errors });
      writeJsonAtomic(this.recordPath, rec);
      this.#record = rec;
      return rec;
    });
  }

  /** ASSIGNED → RUNNING (call when the provider execution truthfully starts). */
  markRunning() { return this.#advanceLifecycle(INVOCATION_LIFECYCLE.RUNNING); }

  /**
   * P20.8 PRE-R3 R3-1 — the ONE atomic execution-ownership admission
   * boundary. Grants the right to call `reportBackend.runReport()` for
   * `attemptOrdinal`/`executionId` ONLY when this invocation has never
   * begun an execution (fresh-read lifecycle === ASSIGNED); every other
   * lifecycle — RUNNING (a concurrent claim already outstanding, or a prior
   * execution whose outcome is unresolved/UNKNOWN and was never reconciled),
   * DELIVERED, SEALED, FAILED, CANCELLED — is refused, fail closed, with NO
   * distinction that would let a caller "retry its way back in": an UNKNOWN
   * or in-flight outcome is NEVER auto-replayed, and a known terminal
   * FAILED/CANCELLED/DELIVERED/SEALED invocation never silently re-executes
   * either. Locked + fresh-read, so two concurrent callers racing for the
   * SAME invocation are strictly serialized by the SAME invocation `.lock`
   * `allocateAttempt()` already uses — exactly one may ever be granted.
   *
   * A bounded, explicitly-authorized DELIVERY repair (`runBoundedDeliveryRepair`
   * in report-stage-completion.mjs) never calls this — it re-invokes the
   * backend directly against an already-DELIVERED invocation, a distinct,
   * separately-bounded authority path this primitive does not touch.
   *
   * @param {object} input
   * @param {number} input.attemptOrdinal  the attempt this execution belongs to
   * @param {string} input.executionId     the physical execution id
   * @returns {object} the persisted invocation record (RUNNING, claim set)
   */
  claimRunning({ attemptOrdinal, executionId } = {}) {
    if (!Number.isInteger(attemptOrdinal) || attemptOrdinal < 0) {
      throw new ArtifactStoreError('claimRunning requires a non-negative attempt ordinal', 'ARTIFACT_INVOCATION_EXECUTION_CLAIM_INVALID', { attemptOrdinal });
    }
    if (typeof executionId !== 'string' || !executionId) {
      throw new ArtifactStoreError('claimRunning requires a non-empty execution_id', 'ARTIFACT_INVOCATION_EXECUTION_CLAIM_INVALID', { executionId });
    }
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable during execution claim: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      if (rec.lifecycle !== INVOCATION_LIFECYCLE.ASSIGNED) {
        const claim = rec.active_execution_claim ?? null;
        throw new ArtifactStoreError(
          `invocation ${this.invocationId} is not admissible for a new execution (lifecycle=${rec.lifecycle}`
          + `${claim ? `, existing claim attempt=${claim.attempt_ordinal} execution=${JSON.stringify(claim.execution_id)}` : ''}`
          + '); a concurrent, duplicate, or post-terminal execution is refused — an UNKNOWN or in-flight provider '
          + 'outcome is NEVER auto-replayed. Explicit manual recovery/reconciliation is required before another '
          + 'attempt may execute.',
          'ARTIFACT_INVOCATION_EXECUTION_NOT_ADMITTED',
          { invocationId: this.invocationId, lifecycle: rec.lifecycle, existingClaim: claim, requested: { attemptOrdinal, executionId } },
        );
      }
      rec.lifecycle = INVOCATION_LIFECYCLE.RUNNING;
      rec.active_execution_claim = { attempt_ordinal: attemptOrdinal, execution_id: executionId, claimed_at: this.#store._iso() };
      rec.updated_at = this.#store._iso();
      const check = validateInvocationRecord(rec);
      if (!check.ok) throw new ArtifactStoreError(`invocation.json invalid after execution claim: ${check.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: check.errors });
      writeJsonAtomic(this.recordPath, rec);
      this.#record = rec;
      return structuredClone(rec);
    });
  }

  /**
   * Record a TRUTHFUL delivery event onto one attempt's `artifact.json` and
   * advance the invocation to DELIVERED (P20.2 §18). Never seals, never sets
   * `authoritative_attempt`. Delivery byte count / observed sha256 are
   * transport evidence — NOT sealed authority.
   *
   * @param {object} input
   * @param {number} input.attemptOrdinal
   * @param {string} input.terminalState  one of TERMINAL_STATE (must be SUCCESS to advance)
   * @param {string} input.deliveryMechanism
   * @param {string} [input.inputTransport]
   * @param {string} input.finishedAt   ISO-8601
   * @param {number} input.reportBytes
   * @param {string} input.reportSha256
   * @param {string} [input.executiveLogRelpath]
   * @param {string} [input.providerFinishReason]
   */
  recordDelivery(input) {
    const {
      attemptOrdinal, terminalState, deliveryMechanism, inputTransport = null,
      finishedAt, reportBytes, reportSha256, executiveLogRelpath = null, providerFinishReason = null,
    } = input ?? {};
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      const attemptDir = join(this.#path, attemptDirName(attemptOrdinal));
      const artifactJsonPath = join(attemptDir, 'artifact.json');
      let meta;
      try { meta = readJson(artifactJsonPath); } catch (error) {
        throw new ArtifactStoreError(`attempt-${attemptOrdinal} artifact.json unreadable during delivery record: ${error.message}`, 'ARTIFACT_METADATA_INVALID', { path: artifactJsonPath });
      }
      if ('authoritative_attempt' in meta) {
        throw new ArtifactStoreError('artifact.json must never carry authoritative_attempt', 'ARTIFACT_METADATA_AUTHORITY_FORBIDDEN', { path: artifactJsonPath });
      }
      meta.finished_at = finishedAt;
      meta.terminal_state = terminalState;
      meta.delivery_mechanism = deliveryMechanism;
      if (inputTransport !== null) meta.input_transport = inputTransport;
      if (Number.isInteger(reportBytes)) meta.report_bytes = reportBytes;
      if (typeof reportSha256 === 'string') meta.report_sha256 = reportSha256;
      if (executiveLogRelpath) meta.executive_log_relpath = executiveLogRelpath;
      if (providerFinishReason !== null) meta.provider_finish_reason = providerFinishReason;
      const mc = validateArtifactMetadata(meta);
      if (!mc.ok) throw new ArtifactStoreError(`artifact.json invalid after delivery record: ${mc.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: mc.errors });
      writeJsonAtomic(artifactJsonPath, meta);

      // Advance the invocation to DELIVERED only on a truthful success.
      if (terminalState === 'SUCCESS') {
        let rec;
        try { rec = readJson(this.recordPath); } catch (error) {
          throw new ArtifactStoreError(`invocation.json unreadable during delivery record: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
        }
        if (rec.lifecycle === 'ASSIGNED' || rec.lifecycle === 'RUNNING') {
          rec.lifecycle = INVOCATION_LIFECYCLE.DELIVERED;
          // R3-1: the execution-ownership claim is resolved — a truthful
          // SUCCESS is a definitive outcome, never left dangling.
          rec.active_execution_claim = null;
          rec.updated_at = this.#store._iso();
          const rc = validateInvocationRecord(rec);
          if (!rc.ok) throw new ArtifactStoreError(`invocation.json invalid after delivery: ${rc.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: rc.errors });
          writeJsonAtomic(this.recordPath, rec);
          this.#record = rec;
        }
      }
      return structuredClone(meta);
    });
  }

  // ================= P20.3 — fresh-disk authority (§5) =================
  // Every method below acquires the invocation lock, FRESH-READS the
  // relevant JSON from disk, schema-validates it, operates on that fresh
  // record, and atomically writes app-owned metadata. A stale in-memory
  // snapshot is never sufficient to seal or select authority.

  /** Absolute path of one attempt's artifact.json. */
  attemptArtifactJsonPath(ordinal) {
    return join(this.#path, attemptDirName(ordinal), 'artifact.json');
  }

  /** Locked fresh read + schema validation of invocation.json. Updates the cache. */
  freshRecord() {
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      const v = validateInvocationRecord(rec);
      if (!v.ok) throw new ArtifactStoreError(`invocation.json failed validation: ${v.errors.join('; ')}`, 'ARTIFACT_INVOCATION_RECORD_INVALID', { errors: v.errors });
      this.#record = rec;
      return structuredClone(rec);
    });
  }

  /** Locked fresh read + schema validation of one attempt's artifact.json. */
  freshAttemptMetadata(ordinal) {
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      const p = this.attemptArtifactJsonPath(ordinal);
      let meta;
      try { meta = readJson(p); } catch (error) {
        throw new ArtifactStoreError(`attempt-${ordinal} artifact.json unreadable: ${error.message}`, 'ARTIFACT_METADATA_INVALID', { path: p });
      }
      const v = validateArtifactMetadata(meta);
      if (!v.ok) throw new ArtifactStoreError(`attempt-${ordinal} artifact.json failed validation: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      return meta;
    });
  }

  /**
   * P20.5 §20 — persist the app-owned `debate_continuation` MACHINE control
   * for a `debate-chair-synthesis` invocation into `invocation.json` (never
   * `artifact.json`, never report bytes). Locked, fresh-read, validate,
   * atomic write. Fail-closed:
   *   - only a `debate-chair-synthesis` invocation may carry it
   *   - the control's identity MUST match this invocation record
   *   - `control.attempt_ordinal` MUST be a recorded attempt of this invocation
   *   - once SEALED, it MUST bind to `authoritative_attempt`
   * Immutable once bound (§49): an equal re-commit is idempotent; a DIFFERENT
   * control fails closed (`ARTIFACT_DEBATE_CONTROL_CONFLICT`).
   */
  commitDebateContinuationControl({ control }) {
    const cv = validateDebateContinuationControl(control);
    if (!cv.ok) {
      throw new ArtifactStoreError(`debate_continuation control is not valid: ${cv.errors.join('; ')}`, 'ARTIFACT_DEBATE_CONTROL_INVALID', { errors: cv.errors });
    }
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable during debate-control commit: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      const v0 = validateInvocationRecord(rec);
      if (!v0.ok) throw new ArtifactStoreError(`invocation.json invalid before debate-control commit: ${v0.errors.join('; ')}`, 'ARTIFACT_INVOCATION_RECORD_INVALID', { errors: v0.errors });
      if (rec.stage !== ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS) {
        throw new ArtifactStoreError(`debate_continuation control is only valid for a debate-chair-synthesis invocation, not ${rec.stage}`, 'ARTIFACT_DEBATE_CONTROL_WRONG_STAGE', { stage: rec.stage });
      }
      const mm = [];
      for (const [f, cv2, iv] of [
        ['store_id', control.store_id, rec.store_id],
        ['project_id', control.project_id, rec.project_id],
        ['task_id', control.task_id, rec.task_id],
        ['invocation_id', control.invocation_id, rec.invocation_id],
        ['round', control.round, rec.round ?? null],
        ['profile_id', control.profile_id, rec.profile_id],
        ['actor_alias', control.actor_alias, rec.actor_alias],
        ['stage', control.stage, rec.stage],
      ]) {
        if (cv2 !== iv) mm.push(`${f}: control=${JSON.stringify(cv2)} invocation=${JSON.stringify(iv)}`);
      }
      if (mm.length) throw new ArtifactStoreError(`debate_continuation control identity does not match the invocation: ${mm.join('; ')}`, 'ARTIFACT_DEBATE_CONTROL_IDENTITY_MISMATCH', { mismatches: mm });
      if (!Array.isArray(rec.attempts) || !rec.attempts.includes(control.attempt_ordinal)) {
        throw new ArtifactStoreError(`debate_continuation control attempt_ordinal ${control.attempt_ordinal} is not a recorded attempt of this invocation`, 'ARTIFACT_DEBATE_CONTROL_BAD_ATTEMPT', { ordinal: control.attempt_ordinal, attempts: rec.attempts });
      }
      if (rec.lifecycle === INVOCATION_LIFECYCLE.SEALED && control.attempt_ordinal !== rec.authoritative_attempt) {
        throw new ArtifactStoreError(`debate_continuation control must bind to authoritative_attempt ${rec.authoritative_attempt} once SEALED, got ${control.attempt_ordinal}`, 'ARTIFACT_DEBATE_CONTROL_BAD_ATTEMPT');
      }
      // P20.5R R5 — fresh-read the TARGET attempt's artifact.json and verify
      // the control binds to that PHYSICAL execution, field by field, INCLUDING
      // execution_id. A delivery repair that made a new attempt/execution
      // authoritative must NOT be papered over by only rewriting attempt_ordinal
      // while retaining the original execution_id.
      let am;
      try { am = readJson(this.attemptArtifactJsonPath(control.attempt_ordinal)); }
      catch (error) { throw new ArtifactStoreError(`attempt-${control.attempt_ordinal} artifact.json unreadable during debate-control commit: ${error.message}`, 'ARTIFACT_DEBATE_CONTROL_BAD_ATTEMPT', { path: this.attemptArtifactJsonPath(control.attempt_ordinal) }); }
      const amv = validateArtifactMetadata(am);
      if (!amv.ok) throw new ArtifactStoreError(`attempt-${control.attempt_ordinal} artifact.json invalid during debate-control commit: ${amv.errors.join('; ')}`, 'ARTIFACT_DEBATE_CONTROL_BAD_ATTEMPT');
      const em = [];
      for (const [f, cvv, avv] of [
        ['store_id', control.store_id, am.store_id],
        ['project_id', control.project_id, am.project_id],
        ['task_id', control.task_id, am.task_id],
        ['invocation_id', control.invocation_id, am.invocation_id],
        ['attempt_ordinal', control.attempt_ordinal, am.attempt_ordinal],
        ['execution_id', control.execution_id, am.execution_id],
        ['round', control.round, am.round ?? null],
        ['profile_id', control.profile_id, am.profile_id],
        ['actor_alias', control.actor_alias, am.actor_alias],
        ['stage', control.stage, am.stage],
        ['role', control.role, am.role],
      ]) {
        if (cvv !== avv) em.push(`${f}: control=${JSON.stringify(cvv)} attempt=${JSON.stringify(avv)}`);
      }
      if (em.length) throw new ArtifactStoreError(`debate_continuation control does not bind to its target attempt's physical execution: ${em.join('; ')}`, 'ARTIFACT_DEBATE_CONTROL_EXECUTION_MISMATCH', { mismatches: em });
      if (rec.debate_continuation !== undefined && rec.debate_continuation !== null) {
        if (JSON.stringify(rec.debate_continuation) === JSON.stringify(control)) { return structuredClone(rec.debate_continuation); }
        throw new ArtifactStoreError('this invocation is already bound to a different debate_continuation control; refusing to overwrite', 'ARTIFACT_DEBATE_CONTROL_CONFLICT', { invocationId: rec.invocation_id });
      }
      rec.debate_continuation = structuredClone(control);
      rec.updated_at = this.#store._iso();
      const v = validateInvocationRecord(rec);
      if (!v.ok) throw new ArtifactStoreError(`invocation.json invalid after debate-control commit: ${v.errors.join('; ')}`, 'ARTIFACT_DEBATE_CONTROL_INVALID', { errors: v.errors });
      writeJsonAtomic(this.recordPath, rec);
      this.#record = rec;
      return structuredClone(rec.debate_continuation);
    });
  }

  /**
   * P20.5 §20/§21 — locked fresh read of the persisted `debate_continuation`
   * control, or `null` when none was durably captured. A present-but-corrupt
   * / identity-mismatched block throws `ARTIFACT_DEBATE_CONTROL_CORRUPT`
   * (recovery then fails closed — it never infers continuation from report.md).
   */
  freshDebateContinuationControl() {
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      const v = validateInvocationRecord(rec);
      if (!v.ok) throw new ArtifactStoreError(`invocation.json failed validation: ${v.errors.join('; ')}`, 'ARTIFACT_INVOCATION_RECORD_INVALID', { errors: v.errors });
      this.#record = rec;
      if (rec.debate_continuation === undefined || rec.debate_continuation === null) return null;
      // validateInvocationRecord already structurally validated + identity-bound
      // it; return a defensive clone.
      return structuredClone(rec.debate_continuation);
    });
  }

  /**
   * P20.3 §15 — finalize the OPERATIONAL fields on one attempt's
   * artifact.json (never `authoritative_attempt`, never semantic fields).
   * Locked, fresh-read, validate, atomic write.
   */
  finalizeAttempt(ordinal, fields = {}) {
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      const p = this.attemptArtifactJsonPath(ordinal);
      let meta;
      try { meta = readJson(p); } catch (error) {
        throw new ArtifactStoreError(`attempt-${ordinal} artifact.json unreadable during finalize: ${error.message}`, 'ARTIFACT_METADATA_INVALID', { path: p });
      }
      if ('authoritative_attempt' in meta) {
        throw new ArtifactStoreError('artifact.json must never carry authoritative_attempt', 'ARTIFACT_METADATA_AUTHORITY_FORBIDDEN', { path: p });
      }
      const allowed = ['integrity_state', 'report_bytes', 'report_sha256', 'finished_at', 'terminal_state', 'repair_of', 'size_policy_version', 'max_report_bytes', 'finalized_at', 'executive_log_finalized'];
      for (const [k, val] of Object.entries(fields)) {
        if (!allowed.includes(k)) throw new ArtifactStoreError(`finalizeAttempt: field ${JSON.stringify(k)} is not an allowed operational field`, 'ARTIFACT_METADATA_INVALID', { field: k });
        if (val !== undefined) meta[k] = val;
      }
      const v = validateArtifactMetadata(meta);
      if (!v.ok) throw new ArtifactStoreError(`artifact.json invalid after finalize: ${v.errors.join('; ')}`, 'ARTIFACT_METADATA_INVALID', { errors: v.errors });
      writeJsonAtomic(p, meta);
      return structuredClone(meta);
    });
  }

  /**
   * P20.3 §16 — commit the seal: DELIVERED → SEALED, select
   * `authoritative_attempt`, write the app-owned `seal` record. Locked,
   * fresh-read, deterministic. Idempotent for the SAME ordinal; a DIFFERENT
   * already-sealed ordinal fails closed (`ARTIFACT_SEAL_CONFLICT`). Seal is
   * only permitted from a DELIVERED invocation.
   *
   * P20.3R R7 — this is not an authority bypass even when called directly:
   * the target attempt's `artifact.json` is fresh-read and MUST already be
   * a finalized `ARTIFACT_PASS` / `SUCCESS` attempt (with a valid
   * `report_sha256` / `report_bytes`, a `finalized_at` marker, and an
   * `executive_log_finalized` marker proving executive-log finalization
   * happened FIRST). The `integrity_state` written into the seal is DERIVED
   * from that fresh attempt metadata, never taken from an arbitrary caller
   * argument.
   */
  commitSeal({ ordinal, sealVersion, sealedAt }) {
    if (!Number.isInteger(ordinal) || ordinal < 0) throw new ArtifactStoreError('commitSeal requires a non-negative attempt ordinal', 'ARTIFACT_SEAL_FAILED', { ordinal });
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable during seal: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      const v0 = validateInvocationRecord(rec);
      if (!v0.ok) throw new ArtifactStoreError(`invocation.json invalid before seal: ${v0.errors.join('; ')}`, 'ARTIFACT_INVOCATION_RECORD_INVALID', { errors: v0.errors });

      if (rec.lifecycle === INVOCATION_LIFECYCLE.SEALED) {
        if (rec.authoritative_attempt === ordinal) { this.#record = rec; return structuredClone(rec); } // idempotent
        throw new ArtifactStoreError(`invocation already SEALED with authoritative_attempt ${rec.authoritative_attempt}, cannot re-seal to ${ordinal}`, 'ARTIFACT_SEAL_CONFLICT', { existing: rec.authoritative_attempt, requested: ordinal });
      }
      if (rec.lifecycle !== INVOCATION_LIFECYCLE.DELIVERED) {
        throw new ArtifactStoreError(`cannot seal from lifecycle ${rec.lifecycle} (must be DELIVERED)`, 'ARTIFACT_SEAL_FAILED', { from: rec.lifecycle });
      }
      if (!Array.isArray(rec.attempts) || !rec.attempts.includes(ordinal)) {
        throw new ArtifactStoreError(`attempt ${ordinal} is not a recorded attempt of this invocation`, 'ARTIFACT_SEAL_FAILED', { ordinal, attempts: rec.attempts });
      }

      // R7: the target attempt must already be a FINALIZED, PASSED success.
      let am;
      try { am = readJson(this.attemptArtifactJsonPath(ordinal)); } catch (error) {
        throw new ArtifactStoreError(`attempt-${ordinal} artifact.json unreadable during seal: ${error.message}`, 'ARTIFACT_METADATA_INVALID');
      }
      const isHex = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
      if (am.invocation_id !== rec.invocation_id || am.attempt_ordinal !== ordinal) throw new ArtifactStoreError(`attempt-${ordinal} artifact.json does not belong to this invocation`, 'ARTIFACT_SEAL_FAILED');
      if (am.terminal_state !== 'SUCCESS') throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: terminal_state is ${am.terminal_state}, not SUCCESS`, 'ARTIFACT_SEAL_FAILED');
      if (am.integrity_state !== 'ARTIFACT_PASS') throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: integrity_state is ${am.integrity_state ?? 'unset'}, not ARTIFACT_PASS (attempt not finalized)`, 'ARTIFACT_SEAL_FAILED');
      if (!isHex(am.report_sha256)) throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: report_sha256 is missing/invalid`, 'ARTIFACT_SEAL_FAILED');
      if (!Number.isInteger(am.report_bytes) || am.report_bytes < 0) throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: report_bytes is missing/invalid`, 'ARTIFACT_SEAL_FAILED');
      if (typeof am.finalized_at !== 'string' || !am.finalized_at) throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: no finalized_at marker (attempt not finalized)`, 'ARTIFACT_SEAL_FAILED');
      if (am.executive_log_finalized !== true) throw new ArtifactStoreError(`cannot seal attempt-${ordinal}: executive.log was not finalized before seal`, 'ARTIFACT_SEAL_FAILED');

      rec.lifecycle = INVOCATION_LIFECYCLE.SEALED;
      rec.authoritative_attempt = ordinal;
      rec.integrity_state = 'ARTIFACT_PASS'; // derived from the fresh attempt metadata above
      rec.seal = { sealed_at: sealedAt ?? this.#store._iso(), seal_version: sealVersion ?? 'p20.3-1', authoritative_attempt: ordinal, integrity_state: 'ARTIFACT_PASS' };
      rec.updated_at = this.#store._iso();
      const v = validateInvocationRecord(rec);
      if (!v.ok) throw new ArtifactStoreError(`invocation.json invalid after seal: ${v.errors.join('; ')}`, 'ARTIFACT_SEAL_FAILED', { errors: v.errors });
      writeJsonAtomic(this.recordPath, rec);
      this.#record = rec;
      return structuredClone(rec);
    });
  }

  /**
   * P20.3 §21 — durable reconciliation of a known non-success execution:
   * DELIVERED/RUNNING/ASSIGNED → FAILED or CANCELLED. Attempt evidence is
   * preserved; NO seal, NO authoritative_attempt. A SEALED invocation is
   * never un-sealed (`ARTIFACT_SEAL_CONFLICT`).
   */
  settle({ terminalLifecycle, integrityState, reason, at }) {
    if (terminalLifecycle !== INVOCATION_LIFECYCLE.FAILED && terminalLifecycle !== INVOCATION_LIFECYCLE.CANCELLED) {
      throw new ArtifactStoreError('settle() terminalLifecycle must be FAILED or CANCELLED', 'ARTIFACT_INVOCATION_LIFECYCLE_INVALID', { terminalLifecycle });
    }
    return withDirLock(join(this.#path, LOCK_DIR), () => {
      let rec;
      try { rec = readJson(this.recordPath); } catch (error) {
        throw new ArtifactStoreError(`invocation.json unreadable during settle: ${error.message}`, 'ARTIFACT_INVOCATION_RECORD_CORRUPT', { path: this.recordPath });
      }
      if (rec.lifecycle === INVOCATION_LIFECYCLE.SEALED) {
        throw new ArtifactStoreError('cannot settle a SEALED invocation to a failure state', 'ARTIFACT_SEAL_CONFLICT', { lifecycle: rec.lifecycle });
      }
      if (rec.lifecycle === terminalLifecycle) { this.#record = rec; return structuredClone(rec); } // idempotent
      rec.lifecycle = terminalLifecycle;
      // R3-1: settling to a durable terminal state resolves (and clears) any
      // outstanding execution-ownership claim — it is never left dangling on
      // a FAILED/CANCELLED invocation, and claimRunning() already refuses
      // every non-ASSIGNED lifecycle regardless, so this is belt-and-braces.
      rec.active_execution_claim = null;
      rec.integrity_state = integrityState ?? (terminalLifecycle === INVOCATION_LIFECYCLE.CANCELLED ? 'TASK_CANCELLED' : 'EXECUTION_FAILED');
      rec.settlement = { reason: reason ?? null, at: at ?? this.#store._iso() };
      rec.updated_at = this.#store._iso();
      const v = validateInvocationRecord(rec);
      if (!v.ok) throw new ArtifactStoreError(`invocation.json invalid after settle: ${v.errors.join('; ')}`, 'ARTIFACT_INVOCATION_INVALID', { errors: v.errors });
      writeJsonAtomic(this.recordPath, rec);
      this.#record = rec;
      return structuredClone(rec);
    });
  }
}

// ---- AttemptWorkspace -----------------------------------------------

export class AttemptWorkspace {
  #path; #ordinal; #executionId; #reportName; #logName; #metadata;

  constructor(path, { ordinal, executionId, reportName, logName, metadata }) {
    this.#path = path;
    this.#ordinal = ordinal;
    this.#executionId = executionId;
    this.#reportName = reportName;
    this.#logName = logName;
    this.#metadata = metadata;
  }

  get path() { return this.#path; }
  get ordinal() { return this.#ordinal; }
  get executionId() { return this.#executionId; }
  /** Absolute path the LLM/materializer is expected to write (NOT created here). */
  get reportPath() { return join(this.#path, this.#reportName); }
  /** Absolute path DSH will write the executive log to (NOT created here). */
  get executiveLogPath() { return join(this.#path, this.#logName); }
  get artifactJsonPath() { return join(this.#path, 'artifact.json'); }
  get metadata() { return structuredClone(this.#metadata); }
}
