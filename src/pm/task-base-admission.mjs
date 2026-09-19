/**
 * P24.1G6A — dynamic per-task fresh base pinning (reports/
 * P24_1G6_PER_TASK_FRESH_BASE_PINNING_ARCHITECTURE_20260916.md; this
 * phase's own reports/P24_1G6A_DYNAMIC_PER_TASK_FRESH_BASE_PINNING_
 * IMPLEMENTATION_20260916.md).
 *
 * Owns Git BASE ADMISSION AUTHORITY only — the question "what commit does
 * THIS new task's branch get created from, and did anyone's assertion
 * disagree with that." It does not touch settlement (single-final-
 * settlement, schema v8's `git_settlement` journal, ancestry-at-push) —
 * that remains entirely production-pm-worker.mjs's `settleGitResult()`,
 * unchanged by this module.
 *
 * Every new Git-bound task now independently observes the CURRENT base of
 * its target repository at admission time (dynamic default) UNLESS the
 * project explicitly opts into `git_base_policy: pinned` (an
 * administrator-owned exact acceptance assertion — the pre-G6A default,
 * preserved verbatim for any project that already configured it, and the
 * one supported way to freeze a project's admissions to a reviewed
 * commit going forward). Either way, once observed, a task's base SHA is
 * immutable for its entire lifetime — a later admission for a NEW task
 * observes independently; nothing ever re-resolves an already-admitted
 * task's base.
 *
 * `prepareTaskBranch()` (task-branch-binding.mjs) remains the low-level
 * Git primitive this module calls — this module owns WHICH SHA becomes
 * `pinnedBaseSha`/`expectedBaseSha`, WHETHER that resolution is fresh or
 * replayed from a durable journal, and the typed admission-authority
 * error taxonomy. It never duplicates `prepareTaskBranch()`'s own Git
 * mutation logic.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { runGit, COMMIT_SHA_RE, REMOTE_NAME_RE } from './task-result-git-sync.mjs';
import { prepareTaskBranch as prepareTaskBranchImpl, deriveTaskBranchName } from './task-branch-binding.mjs';

export class BaseAdmissionError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'BaseAdmissionError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const GIT_ADMISSION_STATE = Object.freeze({
  UNPREPARED: 'UNPREPARED',
  BASE_OBSERVED: 'BASE_OBSERVED',
  BRANCH_BOUND: 'BRANCH_BOUND',
  ADMITTED: 'ADMITTED',
  BLOCKED: 'BLOCKED',
});

// A repository predating schema v9 (a bare test stub) degrades to "no
// journal support" — admission still resolves/pins/creates correctly for
// that single call, it only loses cross-crash replay (those stubs never
// exercised it anyway). The real AgentBusRepository always supports it.
export function admissionJournalSupported(taskRepository) {
  return Boolean(taskRepository) && typeof taskRepository.getGitAdmission === 'function' && typeof taskRepository.upsertGitAdmission === 'function';
}

function loadAdmission(taskRepository, taskId) {
  if (!admissionJournalSupported(taskRepository)) return { record: null, revision: 0, supported: false };
  const { record, revision } = taskRepository.getGitAdmission(taskId);
  return { record, revision, supported: true };
}

function writeAdmission(taskRepository, taskId, revision, record) {
  if (!admissionJournalSupported(taskRepository)) return { record, revision: 0 };
  return taskRepository.upsertGitAdmission(taskId, { expectedRevision: revision, record: { ...record, updated_at: new Date().toISOString() } });
}

/**
 * P24.1G6A §6/§7 — resolve a project's EFFECTIVE base policy from its
 * already-validated config record (`p5-production-config.mjs`'s
 * `projectGitBase()` already computed `git_base_policy`/
 * `git_base_legacy_pin` at load time; this function is the ONE place that
 * turns that into "what expected SHA, if any, does the PROJECT assert").
 * A dynamic project's `git_base_sha` (if a stale legacy value happens to
 * still be configured alongside an explicit `git_base_policy: dynamic`)
 * is deliberately NEVER surfaced as `projectExpectedSha` — informational
 * only, never a hidden CAS.
 */
export function resolveProjectBasePolicy(project) {
  const policy = project?.git_base_policy === 'pinned' ? 'pinned' : 'dynamic';
  const projectExpectedSha = policy === 'pinned' ? (project?.git_base_sha ?? null) : null;
  return Object.freeze({ policy, projectExpectedSha, legacyPin: Boolean(project?.git_base_legacy_pin) });
}

const REMOTE_REF_ABSENT_RE = /couldn't find remote ref|fatal: [^\n]*not found in upstream|remote ref does not exist/i;

/**
 * P24.1G6A §10/§11 — ONE bounded admission observation: resolve the
 * CURRENT, authoritative commit S for `baseBranch` on `remote`, via an
 * explicit ref fetch that FAILS if the branch is genuinely absent on the
 * remote right now — never trusting a pre-existing local remote-tracking
 * ref as proof of freshness (a `git fetch` without an explicit refspec
 * does not prune/update a branch the remote deleted). `git ls-remote` is
 * the authoritative existence+SHA read (talks to the remote directly, no
 * local cache involved); the explicit `git fetch <remote> <branch>`
 * immediately after makes the resulting commit object locally available
 * for branch creation. Resolved exactly once per call — the caller must
 * not call this twice within one admission and expect the same task to
 * use a second, later value.
 */
export async function resolveFreshBaseSha({ projectRepoPath, remote, baseBranch, spawnImpl = nodeSpawn, timeoutMs } = {}) {
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const lsRes = await runGit(['ls-remote', '--exit-code', remote, baseBranch], opts);
  if (!lsRes.ok) {
    if (lsRes.code === 2 || REMOTE_REF_ABSENT_RE.test(lsRes.stderr ?? '')) {
      throw new BaseAdmissionError(`base branch does not exist on the remote: ${remote}/${baseBranch}`, 'BASE_REF_NOT_FOUND', { remote, baseBranch });
    }
    throw new BaseAdmissionError(`could not query the remote for the base branch: ${remote}/${baseBranch}`, 'BASE_FETCH_FAILED', { remote, baseBranch });
  }
  const line = lsRes.stdout.split('\n').find((l) => l.trim().length > 0) ?? '';
  const [lsSha] = line.trim().split(/\s+/);
  if (!lsSha || !COMMIT_SHA_RE.test(lsSha)) {
    throw new BaseAdmissionError(`remote returned no resolvable commit for ${remote}/${baseBranch}`, 'BASE_REF_NOT_FOUND', { remote, baseBranch });
  }
  const fetchRes = await runGit(['fetch', remote, baseBranch], opts);
  if (!fetchRes.ok) {
    throw new BaseAdmissionError(`could not fetch the base branch object: ${remote}/${baseBranch}`, 'BASE_FETCH_FAILED', { remote, baseBranch });
  }
  const verifyRes = await runGit(['rev-parse', '--verify', '--quiet', `${lsSha}^{commit}`], opts);
  if (!verifyRes.ok) {
    throw new BaseAdmissionError(`fetched base object is not locally resolvable: ${remote}/${baseBranch}`, 'BASE_FETCH_FAILED', { remote, baseBranch, sha: lsSha });
  }
  return lsSha;
}

/** Durably pins the observed SHA to a dedicated ref so local object collection can never discard it while this task remains replayable — independent of any remote-tracking ref later moving away from it. Best-effort observability; never blocks admission on its own. */
async function retainObservedSha({ projectRepoPath, taskId, sha, spawnImpl, timeoutMs }) {
  try {
    await runGit(['update-ref', `refs/dsh-admission/${taskId}`, sha], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  } catch { /* retention ref is defense in depth, not the durable authority (the DB journal + task branch are) */ }
}

function normalizeShaOrThrow(value, code, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !COMMIT_SHA_RE.test(value)) {
    throw new BaseAdmissionError(`${label} must be an exact 40-character hexadecimal commit SHA`, code, { value });
  }
  return value.toLowerCase();
}

/**
 * P24.1G6A — the ONE admission authority. Returns the SAME shape
 * `prepareTaskBranch()` itself returns (durable per-task binding),
 * consumed identically by `OwnerTaskController.submit()`.
 *
 * @param {object} input
 * @param {object} input.taskRepository - durable admission journal (schema v9); gracefully degrades if unsupported
 * @param {string} input.taskId
 * @param {string} input.projectId
 * @param {string|null} input.taskMode
 * @param {{repo_path:string, git_base_branch?:string|null, git_base_sha?:string|null, git_base_policy?:string, workspace_id?:string}} input.project - the FRESHLY reloaded project record (already resolved by the caller, matching P22.7's own admission-time re-read discipline)
 * @param {string} input.remote - the effective remote for THIS task (admission observation and eventual push both use this exact value)
 * @param {string|null} [input.callerExpectedBaseSha] - typed per-task caller CAS (`payload.git.expected_base_sha`), independent of project policy
 * @param {Function} [input.materializeTaskBranch] - P24.3B: the low-level
 *   branch-MATERIALIZATION step this function calls once the base pin is
 *   resolved/validated/durably journaled. Defaults to
 *   `prepareTaskBranchImpl` — every existing caller that omits this gets
 *   byte-for-byte pre-P24.3 behavior (branch created/checked out directly
 *   in `project.repo_path`, the shared registered checkout). A caller that
 *   explicitly opts a NEW task into isolated-worktree execution (P24.3A's
 *   TaskWorkspaceManager) supplies its OWN callback here instead — same
 *   `{projectRepoPath,taskId,projectId,taskMode,remote,baseBranch,
 *   pinnedBaseSha,spawnImpl,timeoutMs}` input shape, returning the SAME
 *   binding shape `prepareTaskBranchImpl` does. This function's own base-
 *   pin resolution/validation/policy/journaling logic — the actual G6A
 *   authority — is 100% shared and unmodified either way; only WHO
 *   performs the branch-creation mechanics for an already-resolved pin
 *   changes. `admitTaskGitBinding` remains the ONE base authority; a
 *   `materializeTaskBranch` override never re-resolves or second-guesses
 *   `pinnedBaseSha`.
 */
export async function admitTaskGitBinding({
  taskRepository, taskId, projectId, taskMode, project, remote,
  callerExpectedBaseSha = null, spawnImpl = nodeSpawn, timeoutMs,
  materializeTaskBranch = prepareTaskBranchImpl,
} = {}) {
  if (typeof remote !== 'string' || !REMOTE_NAME_RE.test(remote)) {
    throw new BaseAdmissionError('Git remote name is invalid', 'TASK_BRANCH_PREPARE_FAILED', { reason: 'REMOTE_NAME_INVALID' });
  }
  const normalizedCallerSha = normalizeShaOrThrow(callerExpectedBaseSha, 'CALLER_EXPECTED_BASE_SHA_INVALID', 'caller expected_base_sha');
  const { policy, projectExpectedSha } = resolveProjectBasePolicy(project);

  // §8 — project pin and caller CAS are independent assertions; when BOTH
  // are present they must agree, or this rejects BEFORE any Git mutation
  // (never uses the internal project SHA as a hidden caller CAS, and
  // never lets caller CAS silently relax a project's pinned policy).
  if (policy === 'pinned' && normalizedCallerSha && projectExpectedSha && normalizedCallerSha !== projectExpectedSha) {
    throw new BaseAdmissionError('caller-supplied expected_base_sha contradicts this project\'s pinned base SHA', 'BASE_POLICY_CONFLICT', { projectExpectedSha, callerExpectedSha: normalizedCallerSha });
  }

  const taskBranch = deriveTaskBranchName(taskId);
  const { record: existing, revision } = loadAdmission(taskRepository, taskId);

  // §13 CASE C/D — already fully ADMITTED (this exact task_id was already
  // durably bound, in this call or an earlier one): replay using the
  // stored pin, never a fresh resolution, regardless of whether the
  // project's live base has since moved.
  if (existing?.state === GIT_ADMISSION_STATE.ADMITTED && existing.observed_base_sha) {
    const binding = await materializeTaskBranch({
      projectRepoPath: project.repo_path, taskId, projectId, taskMode,
      remote: existing.effective_remote ?? remote, baseBranch: existing.base_branch ?? undefined,
      pinnedBaseSha: existing.observed_base_sha, spawnImpl, timeoutMs,
    });
    return binding;
  }

  // §13 CASE B — a base was already durably observed (a prior attempt
  // crashed before branch creation completed) — reuse it verbatim, never
  // re-resolve. `existing.state` may be BASE_OBSERVED or BRANCH_BOUND
  // here; either way `observed_base_sha` is the sole authority.
  let observedSha = existing?.state && existing.state !== GIT_ADMISSION_STATE.UNPREPARED && existing.observed_base_sha ? existing.observed_base_sha : null;
  let baseBranch = existing?.base_branch ?? project.git_base_branch ?? null;
  let effectiveRevision = revision;

  // §13 CASE E — the task branch already exists in this worktree, but this
  // task_id has no trustworthy durable observation to explain it (no
  // journal record at all, or a supported repository whose record never
  // even reached BASE_OBSERVED). Never infer a base from current branch
  // topology (merge-base against whatever the base branch happens to be
  // NOW) — that is exactly the pre-G6A gap this phase closes. Fail closed
  // as an orphan requiring explicit reconciliation, never a silent fresh
  // re-observation that could disagree with whatever this branch was
  // actually created from.
  if (!observedSha) {
    const branchExistsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${taskBranch}`], { cwd: project.repo_path, timeoutMs, spawnImpl });
    if (branchExistsRes.ok) {
      throw new BaseAdmissionError('task branch already exists with no trustworthy durable base observation for this task', 'TASK_BASE_ORPHANED', { taskId, taskBranch });
    }
  }

  if (!observedSha) {
    // Fresh observation — the central immutable-observation rule (§11):
    // resolve exactly once, journal it BEFORE any irreversible branch
    // mutation, then never resolve again for this task_id.
    if (!baseBranch) {
      const symrefRes = await runGit(['remote', 'set-head', remote, '--auto'], { cwd: project.repo_path, timeoutMs, spawnImpl }).catch(() => ({ ok: false }));
      void symrefRes;
      const shortRefRes = await runGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd: project.repo_path, timeoutMs, spawnImpl });
      const shortRef = shortRefRes.ok ? shortRefRes.stdout.trim() : '';
      const prefix = `${remote}/`;
      baseBranch = shortRef.startsWith(prefix) ? shortRef.slice(prefix.length) : null;
    }
    if (!baseBranch) {
      throw new BaseAdmissionError('could not determine the configured base branch; pass baseBranch explicitly', 'BASE_REF_NOT_FOUND', { remote });
    }
    const freshSha = await resolveFreshBaseSha({ projectRepoPath: project.repo_path, remote, baseBranch, spawnImpl, timeoutMs });

    // §8/§22 — policy + caller CAS validated against the FRESH observation.
    if (policy === 'pinned' && projectExpectedSha && projectExpectedSha !== freshSha) {
      throw new BaseAdmissionError('fresh base does not match this project\'s pinned base SHA', 'PROJECT_PIN_BASE_SHA_DRIFT', { expected: projectExpectedSha, live: freshSha });
    }
    if (normalizedCallerSha && normalizedCallerSha !== freshSha) {
      throw new BaseAdmissionError('fresh base does not match the caller-supplied expected_base_sha', 'CALLER_EXPECTED_BASE_SHA_DRIFT', { expected: normalizedCallerSha, live: freshSha });
    }

    await retainObservedSha({ projectRepoPath: project.repo_path, taskId, sha: freshSha, spawnImpl, timeoutMs });
    const written = writeAdmission(taskRepository, taskId, effectiveRevision, {
      task_id: taskId, project_id: projectId, repo_path: project.repo_path, workspace_id: project.workspace_id ?? null,
      effective_remote: remote, base_branch: baseBranch, base_policy: policy,
      project_expected_sha: projectExpectedSha, caller_expected_sha: normalizedCallerSha,
      observed_base_sha: freshSha, task_branch: taskBranch, state: GIT_ADMISSION_STATE.BASE_OBSERVED, error_code: null,
    });
    observedSha = freshSha;
    effectiveRevision = written.revision;
  }

  // §13 CASE B/normal — create/bind the branch from the durably observed
  // SHA (never re-derived), then mark ADMITTED.
  let binding;
  try {
    binding = await materializeTaskBranch({
      projectRepoPath: project.repo_path, taskId, projectId, taskMode,
      remote, baseBranch, pinnedBaseSha: observedSha, spawnImpl, timeoutMs,
    });
  } catch (error) {
    writeAdmission(taskRepository, taskId, effectiveRevision, {
      task_id: taskId, project_id: projectId, repo_path: project.repo_path, workspace_id: project.workspace_id ?? null,
      effective_remote: remote, base_branch: baseBranch, base_policy: policy,
      project_expected_sha: projectExpectedSha, caller_expected_sha: normalizedCallerSha,
      observed_base_sha: observedSha, task_branch: taskBranch, state: GIT_ADMISSION_STATE.BLOCKED,
      error_code: error?.code ?? 'TASK_BRANCH_BINDING_CONFLICT',
    });
    throw error;
  }
  writeAdmission(taskRepository, taskId, effectiveRevision, {
    task_id: taskId, project_id: projectId, repo_path: project.repo_path, workspace_id: project.workspace_id ?? null,
    effective_remote: remote, base_branch: baseBranch, base_policy: policy,
    project_expected_sha: projectExpectedSha, caller_expected_sha: normalizedCallerSha,
    observed_base_sha: observedSha, task_branch: taskBranch, state: GIT_ADMISSION_STATE.ADMITTED, error_code: null,
  });
  return binding;
}
