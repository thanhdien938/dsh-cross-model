/**
 * P24.3A — task-workspace-isolation FOUNDATION (reports/
 * P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md,
 * Option B: "a small explicit TaskWorkspaceManager"; this phase's own
 * reports/P24_3A_TASK_WORKSPACE_FOUNDATION_IMPLEMENTATION_20260917.md).
 *
 * Owns ONLY: deterministic workspace-path derivation, Git repository
 * identity verification, linked-worktree allocation/attachment, idempotent
 * recovery of an interrupted allocation, and conservative cleanup. It does
 * NOT own base selection (that remains task-base-admission.mjs's G6A
 * authority — this module receives an already-pinned `pinnedBaseSha` and
 * never re-resolves it), Git settlement/commit/push (git-settlement-
 * journal.mjs / task-result-git-sync.mjs, unchanged), or provider process
 * execution.
 *
 * FEATURE OFF BY CONSTRUCTION: nothing in production composition
 * (`src/runtime/p5-production-composition.mjs`, `src/runtime/production-
 * pm-worker.mjs`, `src/owner/owner-task-controller.mjs`) imports this
 * module. A durable `task_workspace_registry` row (schema v10) is created
 * only when a caller explicitly invokes `ensureTaskWorkspace()` — no
 * production call site does that yet. Legacy tasks (no row) are entirely
 * unaffected; this module never reads/writes `git_admission_journal` or
 * `tasks.git_settlement`.
 *
 * Every Git invocation reuses task-result-git-sync.mjs's `runGit()`
 * (bounded, argv-array, `shell:false`, timeout-guarded, owned-process
 * reaping) — no raw shell string is ever built from task_id/project_id/
 * branch/path.
 *
 * Never: reset, clean, stash, force-checkout the REGISTERED user checkout
 * (`projectRepoPath`). This module only ever runs `git worktree add`/
 * `git worktree remove`/read-only Git commands against it; it never
 * switches its HEAD or touches its index.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync, existsSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve as resolvePath, relative as relativePath, isAbsolute } from 'node:path';

import { runGit, COMMIT_SHA_RE } from './task-result-git-sync.mjs';
import { deriveTaskBranchName, isProtectedBranch } from './task-branch-binding.mjs';

export class TaskWorkspaceError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskWorkspaceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * §6/§13 of the task spec. `NONE`/`NOT_ALLOCATED` are the same durable
 * concept — "no row" already means NOT_ALLOCATED without a row existing at
 * all (identical convention to `GIT_ADMISSION_STATE.UNPREPARED` having no
 * row); the enum below is only the set of states a row can actually hold.
 */
export const TASK_WORKSPACE_STATE = Object.freeze({
  ALLOCATING: 'ALLOCATING',
  READY: 'READY',
  CLEANUP_PENDING: 'CLEANUP_PENDING',
  REMOVED: 'REMOVED',
  BLOCKED: 'BLOCKED',
});

// §13 — the ONE supported version this phase understands. An unknown
// version on a durable row (a future v2 record read by this old code, or a
// deliberately malformed row) fails closed rather than being silently
// treated as legacy or silently adopted.
export const WORKSPACE_ISOLATION_VERSION = 1;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_COMPONENT_LEN = 48;
// P24.3B-R2 Gate C2 — a deterministic, reproduced-on-this-Windows-stack
// defect: `git worktree add` fails with the cryptic, unhelpful
// `fatal: '$GIT_DIR' too big` well BEFORE the OS's own 260-character
// MAX_PATH classic limit — empirically, a total workspace path length
// around 210-220 characters already trips git's own internal buffer
// check when constructing the linked worktree's administrative
// `$GIT_DIR` (verified by direct `git worktree add` CLI probes on this
// exact Windows/git build, independent of any DSH code). `boundedPathComponent()`
// already caps each individual path SEGMENT; this is the complementary
// TOTAL-length guard for whatever `runtimeWorktreeRoot` an operator
// configures (never DSH's own IDs, which are already bounded) — fail
// closed with a clear, typed, actionable error before ever invoking git,
// rather than letting git's own ambiguous internal message surface.
const MAX_WORKSPACE_PATH_LEN = 200;

/** @returns {boolean} whether `taskRepository` supports the schema-v10 workspace accessor pair. */
export function workspacePersistenceSupported(taskRepository) {
  return Boolean(taskRepository) && typeof taskRepository.getTaskWorkspace === 'function' && typeof taskRepository.upsertTaskWorkspace === 'function';
}

/**
 * P24.3C-R1 — closes the confirmed observability gap (reports/
 * P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md `DSH_P6_RAW_STDERR`):
 * a failed `git worktree add`/`git worktree remove`'s bounded stderr used to
 * live ONLY on the in-memory thrown `TaskWorkspaceError`. Feature-detected
 * (schema v11's `recordTaskWorkspaceGitDiagnostic`) and strictly best-effort
 * — a diagnostic-write failure (or a caller whose `taskRepository` predates
 * schema v11, e.g. every existing test's `fakeWorkspaceRegistry()`) must
 * NEVER mask, replace, or delay the real allocation/cleanup failure it is
 * describing.
 */
function recordGitDiagnostic(taskRepository, taskId, diagnostic) {
  if (!taskRepository || typeof taskRepository.recordTaskWorkspaceGitDiagnostic !== 'function') return;
  try { taskRepository.recordTaskWorkspaceGitDiagnostic(taskId, diagnostic); } catch { /* best-effort only — never mask the real failure */ }
}

function safeIdentifierOrThrow(value, label, code) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new TaskWorkspaceError(`${label} is invalid`, code, { value });
  }
  return value;
}

function normalizeShaOrThrow(value, label, code) {
  if (typeof value !== 'string' || !COMMIT_SHA_RE.test(value)) {
    throw new TaskWorkspaceError(`${label} must be an exact 40-character hexadecimal commit SHA`, code, { value });
  }
  return value.toLowerCase();
}

// §12 Windows path-length risk: bound each derived path COMPONENT
// (never the identifier's identity/durable value, which is stored in full
// in the durable row regardless) rather than truncating silently — a
// component beyond the bound is replaced by a short prefix plus a
// collision-resistant hash of the FULL value, so two different identifiers
// sharing only a long common prefix never derive the same path.
function boundedPathComponent(value) {
  if (value.length <= MAX_PATH_COMPONENT_LEN) return value;
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return `${value.slice(0, 24)}~${digest}`;
}

function hasReparsePoint(p) {
  try {
    let cur = resolvePath(p);
    while (cur) {
      try {
        const st = lstatSync(cur);
        if (st.isSymbolicLink()) return true;
      } catch {
        // Not existing or not accessible
      }
      const parent = resolvePath(cur, '..');
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // ignore
  }
  return false;
}

export function canonicalizePath(p) {
  try {
    const resolved = resolvePath(p);
    if (process.platform !== 'win32') return resolved;

    let cur = resolved;
    const tail = [];
    while (cur && !existsSync(cur)) {
      const parent = resolvePath(cur, '..');
      if (parent === cur) break;
      tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
    if (hasReparsePoint(cur)) {
      return resolved;
    }
    let canonicalBase = cur;
    try {
      canonicalBase = realpathSync.native ? realpathSync.native(cur) : realpathSync(cur);
    } catch {
      canonicalBase = cur;
    }
    return tail.length > 0 ? resolvePath(canonicalBase, ...tail) : canonicalBase;
  } catch {
    return resolvePath(p);
  }
}

/**
 * §5 — deterministic workspace-path derivation. Uses ONLY canonical IDs
 * (never a display name), validates both against a bounded safe-component
 * regex (structurally rejects `..`, `/`, `\`, drive-letter injection, and
 * every other traversal primitive before it ever reaches a filesystem
 * call), and verifies the resolved candidate remains lexically UNDERNEATH
 * the resolved root — defense in depth even though the identifier regex
 * already makes escape impossible.
 */
export function deriveTaskWorkspacePath({ runtimeWorktreeRoot, projectId, taskId } = {}) {
  const safeProjectId = safeIdentifierOrThrow(projectId, 'project_id', 'WORKSPACE_PROJECT_ID_INVALID');
  const safeTaskId = safeIdentifierOrThrow(taskId, 'task_id', 'WORKSPACE_TASK_ID_INVALID');
  if (typeof runtimeWorktreeRoot !== 'string' || !runtimeWorktreeRoot) {
    throw new TaskWorkspaceError('runtime worktree root is required', 'WORKSPACE_ROOT_MISSING', {});
  }
  const resolvedRoot = canonicalizePath(runtimeWorktreeRoot);
  const candidate = resolvePath(resolvedRoot, boundedPathComponent(safeProjectId), boundedPathComponent(safeTaskId));
  const rel = relativePath(resolvedRoot, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new TaskWorkspaceError('derived workspace path escapes the runtime worktree root', 'WORKSPACE_PATH_TRAVERSAL', { projectId, taskId });
  }
  if (candidate.length > MAX_WORKSPACE_PATH_LEN) {
    throw new TaskWorkspaceError(
      `derived workspace path (${candidate.length} chars) exceeds the safe length bound (${MAX_WORKSPACE_PATH_LEN}); this Git/Windows stack fails worktree creation with an unhelpful internal error before reaching the OS path-length limit — shorten runtimeWorktreeRoot`,
      'WORKSPACE_PATH_TOO_LONG', { length: candidate.length, limit: MAX_WORKSPACE_PATH_LEN },
    );
  }
  return candidate;
}

// §7 — repository identity: linked worktrees of ONE repository share the
// same Git common directory; that is the trustworthy fact this module
// anchors identity to (never `project.repo_path`'s own realpath alone,
// which two different linked-worktree paths would report as different
// even though they belong to the same repository).
export async function resolveRepositoryCommonDir({ repoPath, spawnImpl = nodeSpawn, timeoutMs } = {}) {
  const opts = { cwd: repoPath, timeoutMs, spawnImpl };
  const res = await runGit(['rev-parse', '--git-common-dir'], opts);
  if (!res.ok) {
    throw new TaskWorkspaceError('could not resolve the git common directory', 'WORKSPACE_REPO_IDENTITY_UNRESOLVED', { repoPath });
  }
  const raw = res.stdout.trim();
  const absolute = isAbsolute(raw) ? raw : resolvePath(repoPath, raw);
  let real;
  try {
    real = realpathSync.native ? realpathSync.native(absolute) : realpathSync(absolute);
  } catch {
    throw new TaskWorkspaceError('git common directory does not exist on disk', 'WORKSPACE_REPO_IDENTITY_UNRESOLVED', { repoPath });
  }
  return resolvePath(real);
}

// Windows path comparisons are case-insensitive; POSIX are not. This is the
// ONE identity-equality primitive every path-shaped durable-field
// comparison in this module uses — never a raw `===` on a path string.
// Exported (P24.3C-R1) so task-workspace-orphan-reconciliation.mjs reuses
// this EXACT identity-equality primitive rather than a second, potentially
// drifted copy — the orphan sweeper must classify a row using precisely the
// same platform-aware comparison ensureTaskWorkspace()/cleanupTaskWorkspace()
// already trust.
export function pathsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (process.platform === 'win32') {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    const na = resolvePath(a);
    const nb = resolvePath(b);
    if (na.toLowerCase() === nb.toLowerCase()) return true;
    try {
      if (hasReparsePoint(na) || hasReparsePoint(nb)) return false;
      const ca = canonicalizePath(na);
      const cb = canonicalizePath(nb);
      return ca.toLowerCase() === cb.toLowerCase();
    } catch {
      return false;
    }
  }
  return a === b;
}

function existsOnDisk(path) {
  try { return existsSync(path); } catch { return false; }
}

// §9 — parses `git worktree list --porcelain -z` into structured entries.
// `-z` NUL-terminates every attribute line and separates entries with an
// EMPTY line (i.e. two consecutive NULs) instead of relying on a bare
// newline, which the porcelain format's own documentation recommends for
// scripts precisely because a worktree path may legitimately contain a
// literal newline (never true on Windows, but this module accepts any
// path the OS accepts).
function parseWorktreeListPorcelain(raw) {
  const tokens = raw.split('\0');
  const entries = [];
  let current = null;
  for (const line of tokens) {
    if (line === '') {
      if (current) { entries.push(current); current = null; }
      continue;
    }
    if (!current) current = {};
    const spaceIdx = line.indexOf(' ');
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
  }
  if (current) entries.push(current);
  return entries;
}

// Exported (P24.3C-R1) — same rationale as `pathsEqual` above.
export async function listWorktrees({ projectRepoPath, spawnImpl, timeoutMs }) {
  const res = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  if (!res.ok) {
    throw new TaskWorkspaceError('could not list git worktrees', 'WORKSPACE_WORKTREE_LIST_FAILED', {});
  }
  return parseWorktreeListPorcelain(res.stdout);
}

// Exported (P24.3C-R1) — same rationale as `pathsEqual` above.
export function branchNameFromRef(ref) {
  return typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

function freezeDescriptor(record, extra = {}) {
  return Object.freeze({ ...record, ...extra });
}

function persistWorkspaceState(taskRepository, taskId, expectedRevision, baseRecord, state, reasonCode) {
  return taskRepository.upsertTaskWorkspace(taskId, {
    expectedRevision,
    record: { ...baseRecord, state, reason_code: reasonCode ?? null },
  });
}

function blockAndThrow(taskRepository, taskId, revision, baseRecord, reasonCode, message, code, extra = {}) {
  persistWorkspaceState(taskRepository, taskId, revision, baseRecord, TASK_WORKSPACE_STATE.BLOCKED, reasonCode);
  throw new TaskWorkspaceError(message, code, extra);
}

/**
 * §8/§9/§16 — the ONE workspace-allocation authority: allocates a NEW
 * linked worktree, or safely reuses/recovers an existing one, for exactly
 * one task. Never chooses the base SHA (that is the caller's already-
 * resolved G6A pin) and never mutates `projectRepoPath`'s HEAD/index.
 *
 * @param {object} input
 * @param {object} input.taskRepository - durable workspace registry (schema v10); required (never falls back to an in-memory/no-op mode — §16 "mandatory: if unavailable, do not mutate Git")
 * @param {string} input.projectRepoPath - the REGISTERED user checkout; read-only to this call except for the initial `git worktree add`
 * @param {string} input.projectId - canonical project id (never a display name)
 * @param {string} input.taskId
 * @param {string} input.taskBranch - MUST equal `deriveTaskBranchName(taskId)`; caller-supplied only as a structural cross-check, never as an alternate source of truth
 * @param {string} input.pinnedBaseSha - the caller's already-resolved, immutable G6A base pin
 * @param {string} input.runtimeWorktreeRoot - the DSH-owned root all task workspaces live under
 * @returns {Promise<object>} the frozen durable workspace descriptor
 */
export async function ensureTaskWorkspace({
  taskRepository,
  projectRepoPath,
  projectId,
  taskId,
  taskBranch,
  pinnedBaseSha,
  runtimeWorktreeRoot,
  spawnImpl = nodeSpawn,
  timeoutMs,
} = {}) {
  if (!workspacePersistenceSupported(taskRepository)) {
    throw new TaskWorkspaceError('durable workspace persistence is required before any workspace git mutation', 'WORKSPACE_PERSISTENCE_UNAVAILABLE', {});
  }
  const safeProjectId = safeIdentifierOrThrow(projectId, 'project_id', 'WORKSPACE_PROJECT_ID_INVALID');
  const safeTaskId = safeIdentifierOrThrow(taskId, 'task_id', 'WORKSPACE_TASK_ID_INVALID');
  const normalizedSha = normalizeShaOrThrow(pinnedBaseSha, 'pinned_base_sha', 'WORKSPACE_PINNED_BASE_SHA_INVALID');

  const expectedBranch = deriveTaskBranchName(safeTaskId);
  if (taskBranch !== expectedBranch) {
    throw new TaskWorkspaceError('supplied task branch does not match the deterministic branch derived from task_id', 'WORKSPACE_TASK_BRANCH_MISMATCH', { expected: expectedBranch, observed: taskBranch });
  }
  if (isProtectedBranch(expectedBranch)) {
    // Structurally impossible given the fixed `dsh/task-` prefix — checked anyway as defense in depth, matching task-branch-binding.mjs's own convention.
    throw new TaskWorkspaceError('derived task branch collides with a protected branch namespace', 'WORKSPACE_TASK_BRANCH_PROTECTED', { taskBranch: expectedBranch });
  }

  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], opts);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new TaskWorkspaceError('project repository path is not a git worktree', 'WORKSPACE_PROJECT_NOT_A_WORKTREE', {});
  }

  const repositoryCommonDir = await resolveRepositoryCommonDir({ repoPath: projectRepoPath, spawnImpl, timeoutMs });

  const pinRes = await runGit(['rev-parse', '--verify', '--quiet', `${normalizedSha}^{commit}`], opts);
  if (!pinRes.ok) {
    throw new TaskWorkspaceError('pinned base sha does not resolve to a commit in this repository', 'WORKSPACE_PINNED_BASE_SHA_UNRESOLVED', { pinnedBaseSha: normalizedSha });
  }

  const workspacePath = deriveTaskWorkspacePath({ runtimeWorktreeRoot, projectId: safeProjectId, taskId: safeTaskId });

  const { record, revision } = taskRepository.getTaskWorkspace(safeTaskId);

  if (record) {
    assertRecordConsistentOrThrow(record, { repositoryCommonDir, workspacePath, taskBranch: expectedBranch, pinnedBaseSha: normalizedSha });

    if (record.state === TASK_WORKSPACE_STATE.READY) {
      await verifyReadyWorkspace({ projectRepoPath, workspacePath, taskBranch: expectedBranch, spawnImpl, timeoutMs });
      return freezeDescriptor(record, { task_id: safeTaskId, reused: true });
    }
    if (record.state === TASK_WORKSPACE_STATE.BLOCKED) {
      throw new TaskWorkspaceError('task workspace is blocked and requires operator attention', 'WORKSPACE_BLOCKED', { reason_code: record.reason_code });
    }
    if (record.state === TASK_WORKSPACE_STATE.REMOVED) {
      // §K / §RECOVERY_STATE_MACHINE row "When W is already REMOVED... A
      // previously settled W is not recreated solely to report success."
      throw new TaskWorkspaceError('task workspace was already removed; it is not recreated', 'WORKSPACE_ALREADY_REMOVED', {});
    }
    if (record.state === TASK_WORKSPACE_STATE.CLEANUP_PENDING) {
      throw new TaskWorkspaceError('task workspace cleanup is pending; refusing a new allocation', 'WORKSPACE_CLEANUP_PENDING', {});
    }
    if (record.state === TASK_WORKSPACE_STATE.ALLOCATING) {
      return await reconcileInterruptedAllocation({
        taskRepository, taskId: safeTaskId, revision, record, projectRepoPath,
        workspacePath, taskBranch: expectedBranch, pinnedBaseSha: normalizedSha, spawnImpl, timeoutMs,
      });
    }
    throw new TaskWorkspaceError('durable workspace record is in an unrecognized state', 'WORKSPACE_STATE_UNRECOGNIZED', { state: record.state });
  }

  // Fresh allocation: persist ALLOCATING BEFORE any Git mutation (§16
  // "mandatory... if unavailable, do not mutate Git" — the inverse holds
  // too: never mutate Git before this durable intent is recorded, so a
  // crash between this write and the `worktree add` below is always
  // recoverable via `reconcileInterruptedAllocation` on replay).
  const baseRecord = {
    project_id: safeProjectId,
    isolation_version: WORKSPACE_ISOLATION_VERSION,
    repository_common_dir: repositoryCommonDir,
    workspace_path: workspacePath,
    task_branch: expectedBranch,
    pinned_base_sha: normalizedSha,
    remote_config_fingerprint: null,
    state: TASK_WORKSPACE_STATE.ALLOCATING,
    reason_code: null,
  };
  taskRepository.upsertTaskWorkspace(safeTaskId, { expectedRevision: revision, record: baseRecord });

  return await performFreshAllocation({ taskRepository, taskId: safeTaskId, record: baseRecord, projectRepoPath, spawnImpl, timeoutMs });
}

function assertRecordConsistentOrThrow(record, { repositoryCommonDir, workspacePath, taskBranch, pinnedBaseSha }) {
  if (record.isolation_version !== WORKSPACE_ISOLATION_VERSION) {
    throw new TaskWorkspaceError('unsupported workspace isolation version', 'WORKSPACE_VERSION_UNSUPPORTED', { version: record.isolation_version });
  }
  if (!pathsEqual(record.repository_common_dir, repositoryCommonDir)) {
    throw new TaskWorkspaceError('durable workspace record belongs to a different repository', 'WORKSPACE_REPOSITORY_MISMATCH', {});
  }
  if (!pathsEqual(record.workspace_path, workspacePath)) {
    throw new TaskWorkspaceError('durable workspace record path does not match the deterministically derived path', 'WORKSPACE_PATH_MISMATCH', { recorded: record.workspace_path, derived: workspacePath });
  }
  if (record.task_branch !== taskBranch) {
    throw new TaskWorkspaceError('durable workspace record branch does not match the deterministic task branch', 'WORKSPACE_TASK_BRANCH_MISMATCH', { recorded: record.task_branch, derived: taskBranch });
  }
  if (record.pinned_base_sha !== pinnedBaseSha) {
    // §8/§10 — never silently adopt a foreign/newer pin onto an existing
    // allocation record. A genuinely different pin for the same task_id is
    // a caller programming error or tamper attempt, not a recoverable case.
    throw new TaskWorkspaceError('durable workspace record pin does not match the caller-supplied pin', 'WORKSPACE_PIN_MISMATCH', { recorded: record.pinned_base_sha, supplied: pinnedBaseSha });
  }
}

async function verifyReadyWorkspace({ projectRepoPath, workspacePath, taskBranch, spawnImpl, timeoutMs }) {
  const entries = await listWorktrees({ projectRepoPath, spawnImpl, timeoutMs });
  const entry = entries.find((e) => e.path && pathsEqual(resolvePath(e.path), resolvePath(workspacePath)));
  if (!entry) {
    throw new TaskWorkspaceError('durable workspace record is READY but no matching git worktree registration was found', 'WORKSPACE_REGISTRATION_MISSING', {});
  }
  if (branchNameFromRef(entry.branch) !== taskBranch) {
    throw new TaskWorkspaceError('registered worktree is bound to an unexpected branch', 'WORKSPACE_FOREIGN_REGISTRATION', { observed: entry.branch ?? null, expected: taskBranch });
  }
  return entry;
}

/**
 * §9 step 4: for a genuinely NEW branch+worktree, the single explicit
 * command form the audit recommends. On failure, the durable record is
 * deliberately LEFT at ALLOCATING (never overwritten to BLOCKED here) —
 * the audit's own probe proved `worktree add -b` is not crash-atomic (a
 * failed add can still leave the branch behind); the correct response to
 * that ambiguity is a typed refusal now and a `reconcileInterruptedAllocation`
 * on the NEXT call, which actually inspects what, if anything, survived.
 */
async function performFreshAllocation({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs }) {
  const { workspace_path: workspacePath, task_branch: taskBranch, pinned_base_sha: pinnedBaseSha } = record;
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const branchExistsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${taskBranch}`], opts);
  if (branchExistsRes.ok) {
    // A branch with this exact deterministic name already exists in the
    // repository despite no durable workspace record ever having existed
    // for this task_id (e.g. a legacy shared-worktree admission already
    // created it, or a foreign/hand-placed branch occupies the name).
    // Never silently reset/adopt it — require it to be a genuine ancestor
    // of the pin, then attach rather than re-create.
    return await attachExistingBranch({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs });
  }

  if (existsOnDisk(workspacePath)) {
    throw new TaskWorkspaceError('derived workspace path already exists on disk with no owning branch; refusing to overwrite', 'WORKSPACE_FOREIGN_PATH', { workspacePath });
  }

  const addRes = await runGit(['worktree', 'add', '-b', taskBranch, workspacePath, pinnedBaseSha], opts);
  if (!addRes.ok) {
    recordGitDiagnostic(taskRepository, taskId, {
      projectId: record.project_id, gitOperation: 'WORKTREE_ADD', errorCode: 'WORKSPACE_ALLOCATION_FAILED',
      exitCode: addRes.code ?? null, timedOut: Boolean(addRes.timedOut), boundedStderr: addRes.stderr ?? '', boundedStdout: addRes.stdout ?? '',
      workspacePath, taskBranch, pinnedBaseSha,
    });
    throw new TaskWorkspaceError('git worktree add failed; allocation left interruptible for recovery on replay', 'WORKSPACE_ALLOCATION_FAILED', { stderr: (addRes.stderr ?? '').slice(0, 500) });
  }

  return await finalizeReady({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs });
}

async function attachExistingBranch({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs }) {
  const { workspace_path: workspacePath, task_branch: taskBranch, pinned_base_sha: pinnedBaseSha } = record;
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const entries = await listWorktrees({ projectRepoPath, spawnImpl, timeoutMs });
  const foreignEntry = entries.find((e) => branchNameFromRef(e.branch) === taskBranch);
  if (foreignEntry && !pathsEqual(resolvePath(foreignEntry.path), resolvePath(workspacePath))) {
    return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'FOREIGN_BRANCH_OCCUPANCY',
      'existing task branch is already attached to a different worktree', 'WORKSPACE_FOREIGN_REGISTRATION', { observed_path: foreignEntry.path });
  }

  const branchShaRes = await runGit(['rev-parse', taskBranch], opts);
  const branchSha = branchShaRes.ok ? branchShaRes.stdout.trim() : null;
  if (branchSha !== pinnedBaseSha) {
    const ancestorRes = await runGit(['merge-base', '--is-ancestor', pinnedBaseSha, taskBranch], opts);
    if (!ancestorRes.ok) {
      return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'BRANCH_ANCESTRY_MISMATCH',
        'existing task branch shares no resolvable ancestry with the pinned base; refusing to adopt it', 'WORKSPACE_BRANCH_ANCESTRY_MISMATCH', { taskBranch, pinnedBaseSha });
    }
  }

  if (existsOnDisk(workspacePath)) {
    return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'PARTIAL_ALLOCATION_UNRESOLVED',
      'derived workspace path exists on disk but is not a registered worktree for the existing branch', 'WORKSPACE_PARTIAL_ALLOCATION_UNRESOLVED', {});
  }

  const addRes = await runGit(['worktree', 'add', workspacePath, taskBranch], opts);
  if (!addRes.ok) {
    recordGitDiagnostic(taskRepository, taskId, {
      projectId: record.project_id, gitOperation: 'WORKTREE_ADD_EXISTING_BRANCH', errorCode: 'WORKSPACE_ALLOCATION_FAILED',
      exitCode: addRes.code ?? null, timedOut: Boolean(addRes.timedOut), boundedStderr: addRes.stderr ?? '', boundedStdout: addRes.stdout ?? '',
      workspacePath, taskBranch, pinnedBaseSha,
    });
    throw new TaskWorkspaceError('git worktree add (existing branch) failed; allocation left interruptible for recovery on replay', 'WORKSPACE_ALLOCATION_FAILED', { stderr: (addRes.stderr ?? '').slice(0, 500) });
  }
  return await finalizeReady({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs });
}

/**
 * §10 cases B-F — recovery of an ALLOCATING record whose Git side effects
 * are unknown. Inventories the branch, the worktree registration, and the
 * physical path independently (never inferring one from another) before
 * deciding whether it is safe to retry, attach, or must block.
 */
async function reconcileInterruptedAllocation({ taskRepository, taskId, revision, record, projectRepoPath, workspacePath, taskBranch, spawnImpl, timeoutMs }) {
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const branchExistsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${taskBranch}`], opts);
  const branchExists = branchExistsRes.ok;
  const entries = await listWorktrees({ projectRepoPath, spawnImpl, timeoutMs });
  const registeredEntry = entries.find((e) => e.path && pathsEqual(resolvePath(e.path), resolvePath(workspacePath)));
  const pathExists = existsOnDisk(workspacePath);

  // Case A-equivalent replay: nothing survived the interruption — safe to
  // retry the fresh path from scratch (idempotent; performFreshAllocation
  // re-checks branch/path existence itself).
  if (!branchExists && !registeredEntry && !pathExists) {
    return await performFreshAllocation({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs });
  }

  // Case C: branch created AND correctly registered to our exact path —
  // the interruption happened AFTER `worktree add` succeeded but BEFORE
  // this module persisted READY. Validate and finalize; never re-add.
  if (branchExists && registeredEntry && pathsEqual(resolvePath(registeredEntry.path), resolvePath(workspacePath))) {
    if (branchNameFromRef(registeredEntry.branch) !== taskBranch) {
      return blockAndThrow(taskRepository, taskId, revision, record, 'FOREIGN_REGISTRATION',
        'registered worktree at the expected path is bound to an unexpected branch', 'WORKSPACE_FOREIGN_REGISTRATION', { observed: registeredEntry.branch ?? null });
    }
    return await finalizeReady({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs, skipCleanCheck: false });
  }

  // Case B: branch exists, but the worktree was never (or no longer)
  // registered at our path, and nothing occupies the path on disk —
  // attach the existing branch, after proving its ancestry, exactly like
  // a fresh allocation that discovered a pre-existing branch.
  if (branchExists && !registeredEntry && !pathExists) {
    return await attachExistingBranch({ taskRepository, taskId, record, projectRepoPath, spawnImpl, timeoutMs });
  }

  // Case: path exists on disk but is not a registered worktree — a
  // partial, uncommitted leftover from an interrupted `worktree add`.
  // §11 "retain unexplained partial files": never delete it automatically.
  if (pathExists && !registeredEntry) {
    return blockAndThrow(taskRepository, taskId, revision, record, 'PARTIAL_ALLOCATION_UNRESOLVED',
      'derived workspace path exists on disk with no matching worktree registration; retaining for operator inspection', 'WORKSPACE_PARTIAL_ALLOCATION_UNRESOLVED', {});
  }

  // Registered entry exists but points elsewhere / branch missing despite
  // an entry claiming it — every remaining combination is an unexplained,
  // foreign-looking state. Fail closed.
  return blockAndThrow(taskRepository, taskId, revision, record, 'UNEXPLAINED_ALLOCATION_STATE',
    'interrupted allocation is in an unexplained state; refusing to guess', 'WORKSPACE_ALLOCATION_UNEXPLAINED', {
      branchExists, hasRegisteredEntry: Boolean(registeredEntry), pathExists,
    });
}

async function finalizeReady({ taskRepository, taskId, record, spawnImpl, timeoutMs }) {
  const { workspace_path: workspacePath, task_branch: taskBranch } = record;
  const wtOpts = { cwd: workspacePath, timeoutMs, spawnImpl };

  const topLevelRes = await runGit(['rev-parse', '--show-toplevel'], wtOpts);
  const observedTop = topLevelRes.ok ? resolvePath(topLevelRes.stdout.trim()) : null;
  if (!pathsEqual(observedTop, resolvePath(workspacePath))) {
    return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'TOPLEVEL_MISMATCH',
      'new worktree top-level does not match the allocated path', 'WORKSPACE_VERIFICATION_FAILED', { observedTop });
  }
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], wtOpts);
  const observedBranch = branchRes.ok ? branchRes.stdout.trim() : null;
  if (observedBranch !== taskBranch) {
    return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'BRANCH_MISMATCH',
      'new worktree HEAD does not match the allocated task branch', 'WORKSPACE_VERIFICATION_FAILED', { observedBranch });
  }
  const cleanRes = await runGit(['status', '--porcelain'], wtOpts);
  if (!cleanRes.ok || cleanRes.stdout.trim().length > 0) {
    return blockAndThrow(taskRepository, taskId, currentRevision(taskRepository, taskId), record, 'NOT_CLEAN_AT_ALLOCATION',
      'new worktree is not clean immediately after allocation', 'WORKSPACE_VERIFICATION_FAILED', {});
  }

  const latestRevision = currentRevision(taskRepository, taskId);
  const written = persistWorkspaceState(taskRepository, taskId, latestRevision, record, TASK_WORKSPACE_STATE.READY, null);
  return freezeDescriptor(written.record, { task_id: taskId, reused: false });
}

function currentRevision(taskRepository, taskId) {
  return taskRepository.getTaskWorkspace(taskId).revision;
}

/**
 * §11/§20/§21 — conservative cleanup: removes only the linked worktree
 * (never the local task branch, never anything via `-f`/force, never
 * `git worktree prune`). Any dirty/untracked/ignored content, or any
 * removal failure (simulating, on Windows, a held file handle / AV/
 * indexer interference), leaves the workspace retained and durably marks
 * CLEANUP_PENDING or BLOCKED — cleanup failure never rewrites the task's
 * own execution outcome.
 */
export async function cleanupTaskWorkspace({ taskRepository, projectRepoPath, taskId, spawnImpl = nodeSpawn, timeoutMs } = {}) {
  if (!workspacePersistenceSupported(taskRepository)) {
    throw new TaskWorkspaceError('durable workspace persistence is required before any workspace cleanup', 'WORKSPACE_PERSISTENCE_UNAVAILABLE', {});
  }
  const safeTaskId = safeIdentifierOrThrow(taskId, 'task_id', 'WORKSPACE_TASK_ID_INVALID');
  const { record, revision } = taskRepository.getTaskWorkspace(safeTaskId);
  if (!record) {
    throw new TaskWorkspaceError('no durable workspace record exists for this task', 'WORKSPACE_NOT_FOUND', {});
  }
  if (record.state === TASK_WORKSPACE_STATE.REMOVED) {
    return freezeDescriptor(record, { task_id: safeTaskId, already_removed: true });
  }
  if (record.state !== TASK_WORKSPACE_STATE.READY && record.state !== TASK_WORKSPACE_STATE.CLEANUP_PENDING && record.state !== TASK_WORKSPACE_STATE.BLOCKED) {
    throw new TaskWorkspaceError('task workspace is not in a cleanup-eligible state', 'WORKSPACE_CLEANUP_NOT_ELIGIBLE', { state: record.state });
  }

  const repositoryCommonDir = await resolveRepositoryCommonDir({ repoPath: projectRepoPath, spawnImpl, timeoutMs });
  if (!pathsEqual(repositoryCommonDir, record.repository_common_dir)) {
    throw new TaskWorkspaceError('cleanup was requested against a different repository than the workspace was allocated in', 'WORKSPACE_REPOSITORY_MISMATCH', {});
  }

  // §11 — `git status --porcelain` alone is insufficient (the audit's own
  // probe: an ignored file was removed by an ordinary `worktree remove`
  // with no force flag). Ignored content is inspected explicitly and
  // treated as equally cleanup-blocking in this conservative phase-1
  // policy — no disposable-cache allowlist yet.
  const statusRes = await runGit(['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { cwd: record.workspace_path, timeoutMs, spawnImpl });
  if (!statusRes.ok || statusRes.stdout.trim().length > 0) {
    persistWorkspaceState(taskRepository, safeTaskId, revision, record, TASK_WORKSPACE_STATE.CLEANUP_PENDING, 'DIRTY_WORKSPACE');
    throw new TaskWorkspaceError('task workspace has unexpected dirty/untracked/ignored content; refusing automatic cleanup', 'WORKSPACE_CLEANUP_BLOCKED_DIRTY', {});
  }

  const pending = persistWorkspaceState(taskRepository, safeTaskId, revision, record, TASK_WORKSPACE_STATE.CLEANUP_PENDING, null);

  const removeRes = await runGit(['worktree', 'remove', record.workspace_path], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  if (!removeRes.ok) {
    // Never `--force`, never a recursive filesystem delete as a fallback —
    // a failed ordinary remove (simulated here as a fault-injected Git
    // failure standing in for a real Windows sharing violation / AV lock)
    // retains the workspace, BLOCKED, for retry or operator disposition.
    persistWorkspaceState(taskRepository, safeTaskId, pending.revision, record, TASK_WORKSPACE_STATE.BLOCKED, 'CLEANUP_REMOVE_FAILED');
    recordGitDiagnostic(taskRepository, safeTaskId, {
      projectId: record.project_id, gitOperation: 'WORKTREE_REMOVE', errorCode: 'WORKSPACE_CLEANUP_FAILED',
      exitCode: removeRes.code ?? null, timedOut: Boolean(removeRes.timedOut), boundedStderr: removeRes.stderr ?? '', boundedStdout: removeRes.stdout ?? '',
      workspacePath: record.workspace_path, taskBranch: record.task_branch, pinnedBaseSha: record.pinned_base_sha,
    });
    throw new TaskWorkspaceError('worktree removal failed; workspace retained, not force-removed', 'WORKSPACE_CLEANUP_FAILED', { stderr: (removeRes.stderr ?? '').slice(0, 500) });
  }

  // §11/§TASK_BRANCH_LOCAL_RETENTION_POLICY — the local task branch is
  // NEVER deleted by cleanup. This is a read-only sanity check, not an
  // action: `git worktree remove` alone does not touch `refs/heads/*`.
  const branchStillExistsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${record.task_branch}`], { cwd: projectRepoPath, timeoutMs, spawnImpl });

  const removed = persistWorkspaceState(taskRepository, safeTaskId, pending.revision, record, TASK_WORKSPACE_STATE.REMOVED, null);
  return freezeDescriptor(removed.record, { task_id: safeTaskId, branch_retained: branchStillExistsRes.ok });
}
