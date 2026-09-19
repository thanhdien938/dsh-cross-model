/**
 * P24.1G7A — single-final-settlement journal and crash-recovery evidence
 * helpers (reports/P24_1G7_SINGLE_SETTLEMENT_GIT_WORKFLOW_AUDIT_20260916.md
 * §"Proposed Settlement State Machine").
 *
 * One durable record per top-level owner `task_id` (never `pm_run_id` — a
 * task may span several PM turns/runs across an await-owner park/resume or
 * a worker crash; settlement is owned by the task, not any one run). The
 * record is persisted via `taskRepository.getGitSettlement()` /
 * `updateGitSettlement()` (agentbus-repository.mjs, schema v8) under a CAS
 * revision, exactly like `updateOwnerAutonomy()` already does for
 * `envelope_revision` — a stale write is rejected rather than silently
 * clobbering a concurrent/later transition.
 *
 * This module is deliberately silent about WHETHER a task should settle
 * (that remains production-pm-worker.mjs's call, driven by
 * `task.context.gitSync`) — it only remembers WHAT has already happened, so
 * that a crash between any two Git operations never causes a second
 * semantic commit or a blind second push.
 */

import { runGit, COMMIT_SHA_RE } from './task-result-git-sync.mjs';

export const GIT_SETTLEMENT_STATE = Object.freeze({
  UNSETTLED: 'UNSETTLED',
  PREPARING: 'PREPARING',
  COMMIT_CREATED: 'COMMIT_CREATED',
  PUSHING: 'PUSHING',
  REMOTE_VERIFIED: 'REMOTE_VERIFIED',
  SETTLED: 'SETTLED',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

const DEFAULT_RECORD = Object.freeze({
  state: GIT_SETTLEMENT_STATE.UNSETTLED,
  task_branch: null,
  task_base_sha: null,
  result_commit_sha: null,
  result_tree_sha: null,
  push_remote: null,
  push_branch: null,
  remote_verified_sha: null,
  commit_created_at: null,
  push_verified_at: null,
  push_attempt_consumed: false,
  error_code: null,
  updated_at: null,
});

// A repository that does not implement the journal methods at all (a bare
// test stub predating G7A) degrades to "no journal support" rather than
// throwing — the worker then always performs a fresh one-shot commit/push
// for that single execute() call (still exactly-one-commit within that
// call; it only loses cross-crash idempotency, which those stubs never
// exercised anyway). Real production composition always wires the real
// AgentBusRepository, which does implement both methods.
export function journalSupported(taskRepository) {
  return Boolean(taskRepository) && typeof taskRepository.getGitSettlement === 'function' && typeof taskRepository.updateGitSettlement === 'function';
}

/** Read the current journal (or the implicit UNSETTLED default), never throws for a supported repository with an unknown-but-existing task. */
export function loadGitSettlement(taskRepository, taskId) {
  if (!journalSupported(taskRepository)) return { record: DEFAULT_RECORD, revision: 0, supported: false };
  const { record, revision } = taskRepository.getGitSettlement(taskId);
  return { record: record ?? DEFAULT_RECORD, revision, supported: true };
}

/**
 * Apply `patch` on top of the current record and persist it under CAS,
 * retrying a bounded number of times on a revision conflict (only a
 * concurrent writer for the SAME task could conflict; ordinary single-writer
 * execution never does). No-op (returns the current snapshot) when the
 * repository does not support the journal at all.
 */
export function transitionGitSettlement(taskRepository, taskId, patch, { now = () => new Date().toISOString(), maxAttempts = 5 } = {}) {
  if (!journalSupported(taskRepository)) return { record: { ...DEFAULT_RECORD, ...(typeof patch === 'function' ? patch(DEFAULT_RECORD) : patch) }, revision: 0, supported: false };
  let attempt = 0;
  for (;;) {
    const { record: current, revision } = loadGitSettlement(taskRepository, taskId);
    const delta = typeof patch === 'function' ? patch(current) : patch;
    const next = { ...current, ...delta, updated_at: now() };
    try {
      const result = taskRepository.updateGitSettlement(taskId, { expectedRevision: revision, record: next });
      return { record: result.record, revision: result.revision, supported: true };
    } catch (error) {
      attempt += 1;
      if (error?.code !== 'GIT_SETTLEMENT_CAS_CONFLICT' || attempt >= maxAttempts) throw error;
    }
  }
}

const TASK_TRAILER_PREFIX = 'DSH-Task-Id:';

/** Deterministic, greppable identity trailer appended to the one result-commit message — never a second commit's worth of provenance. */
export function buildTaskCommitTrailer(taskId) {
  return `${TASK_TRAILER_PREFIX} ${taskId}`;
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True iff `message` carries the exact trailer for `taskId` (never a prefix/substring match against a different task id). */
export function messageCarriesTaskTrailer(message, taskId) {
  if (typeof message !== 'string' || typeof taskId !== 'string' || !taskId) return false;
  const re = new RegExp(`${escapeForRegex(TASK_TRAILER_PREFIX)}\\s+${escapeForRegex(taskId)}(\\s|$)`);
  return re.test(message);
}

/**
 * Resolve `ref`'s exact commit/tree SHA and full message, or `null` if `ref`
 * does not resolve at all (e.g. the branch/commit is genuinely absent) —
 * never throws for a missing ref, since "does this commit still exist" is
 * itself a legitimate recovery question, not an error.
 */
export async function resolveCommitDescriptor({ projectRepoPath, ref, spawnImpl, timeoutMs } = {}) {
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const shaRes = await runGit(['rev-parse', '--verify', '--quiet', ref], opts);
  if (!shaRes.ok) return null;
  const sha = shaRes.stdout.trim();
  if (!COMMIT_SHA_RE.test(sha)) return null;
  const treeRes = await runGit(['rev-parse', `${sha}^{tree}`], opts);
  const messageRes = await runGit(['show', '-s', '--format=%B', sha], opts);
  return Object.freeze({ sha, treeSha: treeRes.ok ? treeRes.stdout.trim() : null, message: messageRes.ok ? messageRes.stdout : '' });
}

const REMOTE_REF_ABSENT_RE = /couldn't find remote ref|fatal: [^\n]*not found in upstream/i;

/**
 * Fetch the exact remote `branch` and report its SHA — distinguishing
 * "branch genuinely absent on the remote" (safe to push for the first time)
 * from "could not determine" (network/transport failure — never treated as
 * absent, never treated as a match; the caller must fail closed rather than
 * guess). Never force/rewrite anything; this is a read-only fetch.
 */
export async function resolveRemoteBranchSha({ projectRepoPath, remote, branch, spawnImpl, timeoutMs } = {}) {
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const fetchRes = await runGit(['fetch', remote, branch], opts);
  if (!fetchRes.ok) {
    if (REMOTE_REF_ABSENT_RE.test(fetchRes.stderr ?? '')) return { determined: true, exists: false, sha: null };
    return { determined: false, exists: null, sha: null };
  }
  const shaRes = await runGit(['rev-parse', 'FETCH_HEAD'], opts);
  const sha = shaRes.ok ? shaRes.stdout.trim() : null;
  if (!sha || !COMMIT_SHA_RE.test(sha)) return { determined: false, exists: null, sha: null };
  return { determined: true, exists: true, sha };
}

/**
 * P24.1G6A §18 — the ONE settlement-side check the dynamic-base migration
 * adds: `ancestorSha` (the task's own immutable admission pin) must be an
 * ancestor of (or equal to) `descendantSha` (the result commit) before
 * that result is trusted. This deliberately does NOT fetch or compare
 * against the CURRENT remote base branch — base movement after admission
 * is expected and must never block settlement (§2/§19); this only
 * verifies the result against the task's OWN pin, entirely offline
 * against already-local objects.
 */
export async function verifyBaseIsAncestor({ projectRepoPath, ancestorSha, descendantSha, spawnImpl, timeoutMs } = {}) {
  if (!ancestorSha || !descendantSha) return true; // nothing to verify (e.g. unbound legacy path has no base pin at all)
  const res = await runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: projectRepoPath, timeoutMs, spawnImpl });
  return res.ok;
}

const TREE_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * P24.1G7B §8 — "compute staged tree identity where practical." Stages
 * everything currently dirty (`git add -A`, the exact same staging
 * `commitTaskResult()` itself performs) and reads the resulting tree
 * object WITHOUT creating a commit. Called BEFORE `commitTaskResult()` so
 * the intended tree is durably recorded (journal PREPARING) before the
 * commit exists at all — closing the crash window between "commit
 * created" and "journal write" that a purely post-commit read would leave
 * open. Returns `null` if the tree cannot be determined (never throws) —
 * the caller then falls back to a purely post-commit read.
 */
export async function computeStagedTreeSha({ projectRepoPath, spawnImpl, timeoutMs } = {}) {
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };
  const addRes = await runGit(['add', '-A'], opts);
  if (!addRes.ok) return null;
  const treeRes = await runGit(['write-tree'], opts);
  if (!treeRes.ok) return null;
  const tree = treeRes.stdout.trim();
  return TREE_SHA_RE.test(tree) ? tree : null;
}

export const COMMIT_REUSE_ACTION = Object.freeze({
  REUSE: 'REUSE',
  CREATE: 'CREATE',
  BLOCKED: 'BLOCKED',
});

/**
 * P24.1G7B §7/§9 — the ONE authority deciding whether an existing commit on
 * the task branch may be reused, or whether the branch is in a state that
 * must fail closed rather than either reusing OR blindly creating a new
 * commit on top of unexplained content. A `DSH-Task-Id:` trailer match
 * alone is no longer sufficient once durable tree evidence exists (§7,
 * verbatim) — this function is the enforcement point for that rule.
 *
 * Evidence precedence (never guesses when evidence conflicts):
 *   1. `journalRecord.result_commit_sha` set (a commit was durably
 *      confirmed already) -> the branch tip MUST be exactly that commit.
 *      Anything else -> BLOCKED (`RESULT_COMMIT_MOVED`) — §9 CASE 4.
 *   2. `journalRecord.result_tree_sha` set but no confirmed commit SHA yet
 *      (a pre-commit intended tree was durably recorded, then the process
 *      crashed before/while confirming the commit) -> the branch tip's
 *      OWN tree must equal that recorded tree. Mismatch -> BLOCKED
 *      (`RESULT_TREE_MISMATCH`) — §9 CASE 2, never a silent reuse.
 *   3. No durable tree/commit evidence at all (a task settled before this
 *      evidence existed, or a bare test stub with no journal support) ->
 *      the trailer match alone is the bounded legacy fallback — §9 CASE 5,
 *      "reconcile safely": accept it, and the caller backfills the journal
 *      with the discovered evidence so every LATER call gets the strict
 *      path.
 *   4. No trailer match at all: for a bound task, the tip must be exactly
 *      the pinned base commit (the only legitimate "nothing happened yet"
 *      state) — anything else is foreign/unexplained content already
 *      sitting on this exclusively-DSH-owned branch -> BLOCKED
 *      (`UNEXPECTED_BRANCH_CONTENT`) — §9 CASE 3. An unbound task has no
 *      base-pin concept to check against, so it always falls through to
 *      CREATE (byte-for-byte pre-G7B behavior for that legacy path).
 */
export async function resolveCommitReuseDecision({ projectRepoPath, taskBranchBinding, taskId, journalRecord, spawnImpl, timeoutMs } = {}) {
  const branchRef = taskBranchBinding ? taskBranchBinding.task_branch : 'HEAD';
  const tip = await resolveCommitDescriptor({ projectRepoPath, ref: branchRef, spawnImpl, timeoutMs });
  const trailerMatches = Boolean(tip && messageCarriesTaskTrailer(tip.message, taskId));
  const recordedCommitSha = journalRecord?.result_commit_sha ?? null;
  const recordedTreeSha = journalRecord?.result_tree_sha ?? null;

  if (recordedCommitSha) {
    if (tip && tip.sha === recordedCommitSha) {
      if (recordedTreeSha && tip.treeSha !== recordedTreeSha) {
        return Object.freeze({ action: COMMIT_REUSE_ACTION.BLOCKED, code: 'RESULT_TREE_MISMATCH', sha: tip.sha, treeSha: tip.treeSha });
      }
      return Object.freeze({ action: COMMIT_REUSE_ACTION.REUSE, sha: tip.sha, treeSha: tip.treeSha });
    }
    return Object.freeze({ action: COMMIT_REUSE_ACTION.BLOCKED, code: 'RESULT_COMMIT_MOVED', sha: tip?.sha ?? null, treeSha: tip?.treeSha ?? null });
  }

  if (trailerMatches) {
    if (recordedTreeSha) {
      if (tip.treeSha === recordedTreeSha) return Object.freeze({ action: COMMIT_REUSE_ACTION.REUSE, sha: tip.sha, treeSha: tip.treeSha });
      return Object.freeze({ action: COMMIT_REUSE_ACTION.BLOCKED, code: 'RESULT_TREE_MISMATCH', sha: tip.sha, treeSha: tip.treeSha });
    }
    // CASE 5 — no durable tree evidence exists yet (legacy task, or a
    // journal-unsupported stub): the trailer alone is the bounded fallback.
    return Object.freeze({ action: COMMIT_REUSE_ACTION.REUSE, sha: tip.sha, treeSha: tip.treeSha, backfilled: true });
  }

  if (taskBranchBinding && tip && tip.sha !== taskBranchBinding.base_sha) {
    return Object.freeze({ action: COMMIT_REUSE_ACTION.BLOCKED, code: 'UNEXPECTED_BRANCH_CONTENT', sha: tip.sha, treeSha: tip.treeSha });
  }
  return Object.freeze({ action: COMMIT_REUSE_ACTION.CREATE, sha: null, treeSha: null });
}
