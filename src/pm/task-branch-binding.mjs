/**
 * P18-W4R2 — trusted local Git effects: task-branch binding.
 *
 * Implements the DSH-wide invariant frozen by the PM (docs/p18/
 * P18_W4R1_TRUSTED_LOCAL_GIT_EFFECTS_DESIGN.md §0, addendum commit
 * 044396d): READ SCOPE = REPOSITORY-WIDE, WRITE SCOPE = TASK-WIDE,
 * MERGE SCOPE = LOCAL-OWNER-ONLY, applied identically to SINGLE/COUNCIL/
 * DEBATE. This module owns exactly two things:
 *
 *   1. `prepareTaskBranch()` — derives `dsh/task-<task_id>` (never a
 *      caller-supplied name), fetches the configured remote, verifies a
 *      clean worktree, creates the branch from the verified remote base
 *      SHA (never local HEAD, so a locally-ahead base never contaminates
 *      the new branch), and returns the immutable task-branch binding
 *      record the caller persists once, durably (never re-derived).
 *   2. `verifyBoundBranch()` / `assertTaskBranchPublishable()` — the
 *      fail-closed gates production-pm-worker.mjs calls immediately before
 *      commit and immediately before push: if the checked-out branch (or
 *      the requested publish target) does not exactly match the durable
 *      binding, the Git lifecycle refuses closed with a typed
 *      TASK_BRANCH_BINDING_VIOLATION — DSH never silently switches back to
 *      the bound branch and continues, and never trusts a model's own
 *      report of what branch/SHA it left behind.
 *
 * Every operation reuses task-result-git-sync.mjs's `runGit()` (bounded,
 * argv-array, shell:false, timeout-guarded) — no raw shell string is ever
 * built from task_id/project_id/branch/remote.
 *
 * Never: reset, clean, stash, discard, or auto-commit pre-existing state.
 * `prepareTaskBranch()` refuses outright on a dirty workspace instead.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { runGit, GIT_TIMEOUT_MS, COMMIT_SHA_RE, REMOTE_NAME_RE } from './task-result-git-sync.mjs';

export class TaskBranchLifecycleError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskBranchLifecycleError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const TASK_BRANCH_PREFIX = 'dsh/task-';
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_LOOKING_LIKE_A_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

// main/master/release/*/production/* are refused at BOTH creation and
// publish time (design §5.1/§5.2/§6 "defense in depth against a logic
// error in either operation alone") — structurally unreachable given the
// fixed `dsh/task-` prefix, checked anyway.
const PROTECTED_BRANCH_RES = [/^main$/, /^master$/, /^release\//, /^production\//];
export function isProtectedBranch(name) {
  return typeof name === 'string' && PROTECTED_BRANCH_RES.some((re) => re.test(name));
}

// The caller never supplies this string — assert the operation's own
// schema has no such field, not merely that a supplied one is ignored
// (design §8.2's explicit test wording).
export function deriveTaskBranchName(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new TaskBranchLifecycleError('task_id is invalid', 'TASK_BRANCH_TASK_ID_INVALID', { taskId });
  }
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

/**
 * Resolve the remote's own configured default branch — the ONE
 * checkout-independent stand-in for "the project's base branch" this
 * module trusts when the caller does not supply `baseBranch` explicitly
 * (P18-W4R5). Never consults the local working tree's current or original
 * checkout. Returns the short branch name (e.g. `main`), or `null` if it
 * genuinely cannot be determined — the caller fails closed on `null`
 * rather than guessing.
 */
async function resolveConfiguredBaseBranch({ remote, opts }) {
  // Best-effort refresh: ask the remote itself which branch is its HEAD
  // (exactly what `git clone` does automatically) so a symref that was
  // never set, or has since gone stale, does not silently misresolve.
  // Non-fatal — a pre-existing/successfully-refreshed symref is read
  // below regardless of whether this step itself succeeded.
  await runGit(['remote', 'set-head', remote, '--auto'], opts);
  const symrefRes = await runGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], opts);
  if (!symrefRes.ok) return null;
  const shortRef = symrefRes.stdout.trim();
  const prefix = `${remote}/`;
  if (!shortRef.startsWith(prefix)) return null;
  const branch = shortRef.slice(prefix.length);
  return branch || null;
}

/**
 * Create (or, on replay, reuse) the one branch DSH binds to `taskId`.
 * Sequence (PM-mandated, verbatim): verify clean worktree -> fetch remote
 * refs -> resolve exact base_sha from the CONFIGURED base branch (the
 * caller's explicit override, or else the remote's own default branch —
 * NEVER the workspace's current/original checkout, P18-W4R5) -> create
 * dsh/task-<task_id> from the verified remote base SHA -> verify checkout
 * landed on it -> verify HEAD lands exactly on base_sha before returning.
 * Returns the immutable binding record; the caller persists it once and
 * never re-derives it. Tolerates the workspace currently being checked
 * out on any ref, including a leftover prior `dsh/task-*` branch — the
 * new task branch's base is never derived from that checkout.
 *
 * `expectedBaseSha`, when supplied, is the CALLER's own previously
 * recorded baseline (never trusted on faith) — if it no longer matches
 * the live-resolved remote base, this refuses with
 * TASK_BRANCH_BASE_SHA_DRIFT rather than silently proceeding on stale
 * information.
 */
export async function prepareTaskBranch({
  projectRepoPath,
  taskId,
  projectId = null,
  taskMode = null,
  remote = 'origin',
  baseBranch: requestedBaseBranch = null,
  expectedBaseSha = null,
  // P24.1G6A — when supplied, this task's base SHA was ALREADY resolved
  // and durably recorded by an admission orchestrator (src/pm/task-base-
  // admission.mjs), possibly in an earlier, crashed attempt. It is then
  // the SOLE authority for both branch creation and replay — never
  // re-derived from the (possibly since-advanced) live remote tip or from
  // merge-base topology reconstruction (§14 of the G6A migration: recovery
  // authority is the stored task base SHA, not fresh merge-base against
  // the current base branch). `expectedBaseSha`'s own live-drift-check
  // path below is entirely bypassed when this is set — the two are
  // mutually exclusive by construction, never combined.
  pinnedBaseSha = null,
  spawnImpl = nodeSpawn,
  timeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new TaskBranchLifecycleError('project repository path is required', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'PROJECT_PATH_MISSING' });
  }
  if (typeof remote !== 'string' || !REMOTE_NAME_RE.test(remote)) {
    throw new TaskBranchLifecycleError('Git remote name is invalid', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'REMOTE_NAME_INVALID' });
  }
  const taskBranch = deriveTaskBranchName(taskId);
  if (isProtectedBranch(taskBranch)) {
    // Structurally impossible given the fixed `dsh/task-` prefix — checked
    // anyway as defense in depth (design §8.1).
    throw new TaskBranchLifecycleError('derived task branch collides with a protected branch namespace', 'TASK_BRANCH_PROTECTED_NAME', { taskBranch });
  }
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], opts);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new TaskBranchLifecycleError('project working directory is not a git worktree', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'NOT_A_WORKTREE' });
  }

  // Capture the original checkout BEFORE anything else can change it — this
  // is always recorded as `original_checkout` for observability, but is
  // NEVER used to derive `base_branch` (P18-W4R5: the workspace may
  // legitimately be sitting on ANY ref — the true configured base branch,
  // a leftover prior `dsh/task-*` branch, anything — when PREPARE runs; the
  // checkout is where the workspace happens to be, not what the task should
  // be based on). See `resolveConfiguredBaseBranch()` below for the actual
  // source of `base_branch`.
  const originalCheckoutRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const originalCheckout = originalCheckoutRes.ok ? originalCheckoutRes.stdout.trim() : null;
  if (!originalCheckout || originalCheckout === 'HEAD') {
    throw new TaskBranchLifecycleError('cannot prepare a task branch from a detached HEAD', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'DETACHED_HEAD' });
  }

  const remoteCheck = await runGit(['remote', 'get-url', remote], opts);
  if (!remoteCheck.ok) {
    throw new TaskBranchLifecycleError(`remote is not configured: ${remote}`, 'TASK_BRANCH_PREPARE_FAILED', { reason: 'REMOTE_NOT_CONFIGURED' });
  }

  // Idempotent replay: the exact bound branch already exists locally
  // (a rerun/recovery reusing an already-prepared binding) — never a
  // second `git checkout -b` attempt on top of itself.
  const existsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${taskBranch}`], opts);
  const alreadyExists = existsRes.ok;

  // A dirty workspace refuses PREPARE outright, before execution ever
  // starts — never a silent stash/reset/clean/discard. Only checked for a
  // genuinely NEW preparation: a replay never re-derives cleanliness from
  // a working tree the task itself may already be mid-way through.
  if (!alreadyExists) {
    const status = await runGit(['status', '--porcelain'], opts);
    if (!status.ok) throw new TaskBranchLifecycleError('git status failed', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'STATUS_FAILED' });
    if (status.stdout.trim().length > 0) {
      throw new TaskBranchLifecycleError('workspace is dirty; refusing to prepare a task branch', 'TASK_BRANCH_WORKSPACE_DIRTY', {});
    }
  }

  // Repository-wide read (design §0.1) starts here: an ordinary fetch of
  // the configured remote makes every branch available for read via
  // refs/remotes/<remote>/* to every subsequent task-execution step —
  // never narrowed to just the base branch's own ref.
  const fetchRes = await runGit(['fetch', remote], opts);
  if (!fetchRes.ok) {
    throw new TaskBranchLifecycleError('could not fetch the configured remote', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'FETCH_FAILED' });
  }

  // P18-W4R5 — resolve `base_branch` from a source that is checkout-
  // independent by construction: the caller's own explicit override (a
  // recovery caller's already-durable binding), or else the REMOTE's own
  // configured default branch (`refs/remotes/<remote>/HEAD`) — never the
  // workspace's current or original checkout, which may legitimately be a
  // leftover `dsh/task-*` branch from a prior task. `set-head --auto`
  // (re)establishes the local HEAD symref from what the remote itself
  // reports as default (the same query `git clone` performs automatically)
  // rather than trusting whatever happened to be set locally at some past
  // clone time; its own failure is non-fatal here — a pre-existing symref,
  // if any, is still read below, and if neither resolves, this fails
  // closed rather than falling back to checkout state.
  const baseBranch = requestedBaseBranch ?? await resolveConfiguredBaseBranch({ remote, opts });
  if (!baseBranch) {
    throw new TaskBranchLifecycleError('could not determine the configured base branch; pass baseBranch explicitly', 'TASK_BRANCH_BASE_BRANCH_UNRESOLVED', { remote });
  }

  const remoteRef = `${remote}/${baseBranch}`;
  let baseSha;
  if (pinnedBaseSha) {
    if (!COMMIT_SHA_RE.test(pinnedBaseSha)) {
      throw new TaskBranchLifecycleError('pinned base SHA is not a valid commit SHA', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'PINNED_BASE_SHA_INVALID' });
    }
    const pinnedRes = await runGit(['rev-parse', '--verify', '--quiet', `${pinnedBaseSha}^{commit}`], opts);
    if (!pinnedRes.ok) {
      throw new TaskBranchLifecycleError('pinned base SHA does not resolve to a commit object in this repository', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'PINNED_BASE_SHA_UNRESOLVED', pinnedBaseSha });
    }
    baseSha = pinnedBaseSha;
    if (alreadyExists) {
      const checkoutRes = await runGit(['checkout', taskBranch], opts);
      if (!checkoutRes.ok) {
        throw new TaskBranchLifecycleError('could not check out the existing task branch', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'CHECKOUT_FAILED' });
      }
    } else {
      const createRes = await runGit(['checkout', '-b', taskBranch, baseSha], opts);
      if (!createRes.ok) {
        throw new TaskBranchLifecycleError('could not create the task branch', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'BRANCH_CREATE_FAILED' });
      }
    }
  } else {
    const baseShaRes = await runGit(['rev-parse', remoteRef], opts);
    const liveBaseSha = baseShaRes.ok ? baseShaRes.stdout.trim() : null;
    if (!liveBaseSha || !COMMIT_SHA_RE.test(liveBaseSha)) {
      throw new TaskBranchLifecycleError('could not resolve the remote base ref', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'BASE_REF_UNRESOLVED', remoteRef });
    }
    baseSha = liveBaseSha;
    if (alreadyExists) {
      // Recover the ORIGINAL creation point via merge-base rather than
      // trusting the (possibly since-advanced) live remote tip — stable
      // under a fast-forward-only remote history, exactly what a bound task
      // branch is created from. P18-W4R5: a failed/unresolved merge-base
      // means the existing `dsh/task-<task_id>` branch shares NO common
      // history with the configured remote base at all (e.g. a foreign or
      // hand-tampered branch occupying the name) — this fails closed with a
      // typed error rather than silently falling back to the live remote tip
      // as if the branch were legitimately based on it.
      const mergeBaseRes = await runGit(['merge-base', taskBranch, remoteRef], opts);
      if (!mergeBaseRes.ok || !COMMIT_SHA_RE.test(mergeBaseRes.stdout.trim())) {
        throw new TaskBranchLifecycleError('existing task branch shares no resolvable common history with the configured base; refusing to reuse it', 'TASK_BRANCH_BASE_ANCESTRY_UNRESOLVED', { taskBranch, remoteRef });
      }
      baseSha = mergeBaseRes.stdout.trim();
      if (expectedBaseSha && expectedBaseSha !== baseSha) {
        throw new TaskBranchLifecycleError('existing task branch does not match the expected base', 'TASK_BRANCH_BASE_SHA_DRIFT', { expected: expectedBaseSha, live: baseSha });
      }
      const checkoutRes = await runGit(['checkout', taskBranch], opts);
      if (!checkoutRes.ok) {
        throw new TaskBranchLifecycleError('could not check out the existing task branch', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'CHECKOUT_FAILED' });
      }
    } else {
      if (expectedBaseSha && expectedBaseSha !== liveBaseSha) {
        throw new TaskBranchLifecycleError('base ref has drifted since the caller last observed it', 'TASK_BRANCH_BASE_SHA_DRIFT', { expected: expectedBaseSha, live: liveBaseSha });
      }
      // Based on the verified REMOTE ref, never local HEAD — a locally-ahead
      // base branch never contaminates the new task branch (design §5.1).
      // Create from the immutable SHA just validated above, not the movable
      // remote-tracking name.  A concurrent fetch may advance remoteRef after
      // the task pins baseSha; that is legitimate and must not rebase this task.
      const createRes = await runGit(['checkout', '-b', taskBranch, baseSha], opts);
      if (!createRes.ok) {
        throw new TaskBranchLifecycleError('could not create the task branch', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'BRANCH_CREATE_FAILED' });
      }
    }
  }

  // Never trust the checkout command's own exit code alone.
  const verifyRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const observedBranch = verifyRes.ok ? verifyRes.stdout.trim() : null;
  if (observedBranch !== taskBranch) {
    throw new TaskBranchLifecycleError('checkout did not land on the prepared task branch', 'TASK_BRANCH_BINDING_VIOLATION', {
      expected_task_branch: taskBranch, observed_branch: observedBranch, stage: 'PREPARE',
    });
  }

  // P18-W4R5: for a genuinely NEW branch, HEAD must land exactly on
  // base_sha before the worker ever executes — the definitive proof that
  // creation actually happened from the resolved base and not from
  // whatever the workspace was previously on. (Not checked on replay: an
  // existing task branch legitimately carries commits beyond base_sha
  // already.)
  if (!alreadyExists) {
    const headShaRes = await runGit(['rev-parse', 'HEAD'], opts);
    const observedHeadSha = headShaRes.ok ? headShaRes.stdout.trim() : null;
    if (observedHeadSha !== baseSha) {
      throw new TaskBranchLifecycleError('new task branch HEAD does not match the resolved base SHA', 'TASK_BRANCH_BINDING_VIOLATION', {
        expected_task_branch: taskBranch, expected_base_sha: baseSha, observed_head_sha: observedHeadSha, stage: 'PREPARE',
      });
    }
  }

  return Object.freeze({
    task_id: taskId,
    project_id: projectId,
    task_mode: taskMode,
    base_branch: baseBranch,
    base_sha: baseSha,
    task_branch: taskBranch,
    remote,
    original_checkout: originalCheckout,
  });
}

/**
 * Fail-closed gate called immediately before execution, before commit, and
 * before push (PM mandate, verbatim). Never silently switches back to the
 * bound branch and continues — a mismatch is a durable, typed
 * TASK_BRANCH_BINDING_VIOLATION carrying expected_task_branch,
 * observed_branch, and stage for observability.
 */
export async function verifyBoundBranch({ projectRepoPath, binding, stage, spawnImpl = nodeSpawn, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (!binding || typeof binding.task_branch !== 'string' || !binding.task_branch) {
    throw new TaskBranchLifecycleError('no task branch binding exists', 'TASK_BRANCH_BINDING_MISSING', { stage });
  }
  const res = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  const observed = res.ok ? res.stdout.trim() : null;
  if (observed !== binding.task_branch) {
    throw new TaskBranchLifecycleError('checked-out branch does not match the bound task branch', 'TASK_BRANCH_BINDING_VIOLATION', {
      expected_task_branch: binding.task_branch, observed_branch: observed, stage,
    });
  }
  return Object.freeze({ verified: true, branch: observed, stage });
}

/**
 * Settlement checkpoint (PM mandate: "verify worktree clean" between the
 * materialization commit and push). A plain `git status --porcelain` read
 * — never mutates anything.
 */
export async function isWorktreeClean({ projectRepoPath, spawnImpl = nodeSpawn, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const res = await runGit(['status', '--porcelain'], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  if (!res.ok) throw new TaskBranchLifecycleError('git status failed', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'STATUS_FAILED' });
  return res.stdout.trim().length === 0;
}

/**
 * P22.6 — post-settlement runtime branch return.
 *
 * `prepareTaskBranch()` has always captured `original_checkout` — the
 * branch that was actually active in this worktree immediately before task-
 * branch preparation ever touched it (never re-derived, never guessed;
 * P18-W4R5's own "capture before anything else can change it" comment
 * above). For a runtime worktree, that IS the worktree's home branch
 * (`runtime/p22-live` in production today) — no separate home-branch
 * configuration is introduced (design §B: prefer the branch active before
 * preparation over a new hardcoded/config authority).
 *
 * This is the one function that returns a runtime worktree to that
 * captured branch after a Git-settled task reaches a terminal state
 * (success OR failure). It never merges the task branch back, never
 * deletes it, never touches the remote, and never destroys uncommitted
 * work — a dirty worktree or a missing home branch fails closed with a
 * typed error instead of forcing anything.
 */

/**
 * Best-effort, idempotent: if the worktree is ALREADY on `binding.
 * original_checkout`, this is a safe no-op (`alreadyHome: true`) — calling
 * it twice, or after some other path already restored the branch, is never
 * an error. Otherwise:
 *   1. refuse (fail closed) if the worktree is dirty — never reset/clean/
 *      force past unknown changes;
 *   2. refuse if the captured home branch no longer exists locally;
 *   3. perform a plain `git checkout <original_checkout>` (never `-B`,
 *      never `--force`, never a new branch);
 *   4. verify the checkout actually landed on that exact branch.
 *
 * @param {object} input
 * @param {string} input.projectRepoPath
 * @param {{ original_checkout?: string|null }} input.binding  the durable
 *        task-branch binding record `prepareTaskBranch()` returned/persisted
 * @returns {Promise<{ restored: boolean, branch: string, sha: string, alreadyHome: boolean }>}
 * @throws {TaskBranchLifecycleError} TASK_BRANCH_RESTORE_NO_HOME_CAPTURED |
 *         TASK_BRANCH_RESTORE_BLOCKED_DIRTY_WORKTREE |
 *         TASK_BRANCH_RESTORE_HOME_MISSING | TASK_BRANCH_RESTORE_CHECKOUT_FAILED |
 *         TASK_BRANCH_RESTORE_VERIFY_FAILED
 */
export async function restoreOriginalBranch({ projectRepoPath, binding, spawnImpl = nodeSpawn, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const homeBranch = binding?.original_checkout ?? null;
  if (typeof homeBranch !== 'string' || !homeBranch || homeBranch === 'HEAD') {
    throw new TaskBranchLifecycleError('no captured home branch to restore to', 'TASK_BRANCH_RESTORE_NO_HOME_CAPTURED', {});
  }
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  const currentRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const current = currentRes.ok ? currentRes.stdout.trim() : null;
  if (current === homeBranch) {
    const shaRes = await runGit(['rev-parse', 'HEAD'], opts);
    return Object.freeze({ restored: true, branch: homeBranch, sha: shaRes.ok ? shaRes.stdout.trim() : null, alreadyHome: true });
  }

  // Fail closed on ANY dirty state — never reset/clean/discard on the
  // owner's behalf (design §E, verbatim). This is checked BEFORE the
  // checkout is even attempted, exactly like prepareTaskBranch()'s own
  // dirty-workspace refusal above.
  const statusRes = await runGit(['status', '--porcelain'], opts);
  if (!statusRes.ok) {
    throw new TaskBranchLifecycleError('git status failed while attempting branch restore', 'TASK_BRANCH_RESTORE_STATUS_FAILED', { branch: homeBranch });
  }
  if (statusRes.stdout.trim().length > 0) {
    throw new TaskBranchLifecycleError('worktree is dirty; refusing to restore the original branch', 'TASK_BRANCH_RESTORE_BLOCKED_DIRTY_WORKTREE', { branch: homeBranch });
  }

  const existsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${homeBranch}`], opts);
  if (!existsRes.ok) {
    throw new TaskBranchLifecycleError('the captured home branch no longer exists locally', 'TASK_BRANCH_RESTORE_HOME_MISSING', { branch: homeBranch });
  }

  // Plain checkout only — never `-B` (which would move the branch pointer),
  // never `--force` (which would discard changes this function already
  // refused to run past above).
  const checkoutRes = await runGit(['checkout', homeBranch], opts);
  if (!checkoutRes.ok) {
    throw new TaskBranchLifecycleError('could not check out the original branch', 'TASK_BRANCH_RESTORE_CHECKOUT_FAILED', { branch: homeBranch });
  }

  const verifyRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const observed = verifyRes.ok ? verifyRes.stdout.trim() : null;
  if (observed !== homeBranch) {
    throw new TaskBranchLifecycleError('checkout did not land back on the original branch', 'TASK_BRANCH_RESTORE_VERIFY_FAILED', { expected: homeBranch, observed });
  }
  const shaRes = await runGit(['rev-parse', 'HEAD'], opts);
  return Object.freeze({ restored: true, branch: homeBranch, sha: shaRes.ok ? shaRes.stdout.trim() : null, alreadyHome: false });
}

/**
 * Publication authority (PM mandate, verbatim): task branch publication is
 * authorized only when the requested branch/remote are EXACTLY the bound
 * ones, the bound branch is inside the DSH task namespace, and it is not a
 * protected/base branch. Callers additionally pass no `--force`/
 * `--force-with-lease`/delete flag to pushTaskResult() — that capability is
 * structurally absent from task-result-git-sync.mjs, not merely refused
 * here by policy.
 */
export function assertTaskBranchPublishable({ binding, requestedBranch, requestedRemote }) {
  if (!binding || typeof binding.task_branch !== 'string' || !binding.task_branch) {
    throw new TaskBranchLifecycleError('no task branch binding exists', 'TASK_BRANCH_BINDING_MISSING', { stage: 'PUSH_REQUEST' });
  }
  if (typeof requestedBranch !== 'string' || !BRANCH_LOOKING_LIKE_A_REF_RE.test(requestedBranch) || requestedBranch !== binding.task_branch) {
    throw new TaskBranchLifecycleError('requested branch does not match the bound task branch', 'TASK_BRANCH_BINDING_VIOLATION', {
      expected_task_branch: binding.task_branch, observed_branch: requestedBranch ?? null, stage: 'PUSH_REQUEST',
    });
  }
  if (requestedRemote !== binding.remote) {
    throw new TaskBranchLifecycleError('requested remote does not match the bound remote', 'TASK_BRANCH_REMOTE_MISMATCH', {
      expected_remote: binding.remote, observed_remote: requestedRemote ?? null,
    });
  }
  if (!binding.task_branch.startsWith(TASK_BRANCH_PREFIX)) {
    throw new TaskBranchLifecycleError('bound branch is outside the DSH task namespace', 'TASK_BRANCH_NAMESPACE_VIOLATION', { branch: binding.task_branch });
  }
  if (isProtectedBranch(binding.task_branch)) {
    throw new TaskBranchLifecycleError('refusing to publish a protected branch', 'TASK_BRANCH_PROTECTED_NAME', { branch: binding.task_branch });
  }
  return true;
}
