/**
 * P24.3C-R1 — orphaned `ALLOCATING` task-workspace reconciliation.
 *
 * Authority: reports/P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md's
 * `DSH_P6_TASK_WORKSPACE_REGISTRY` finding — a `task_workspace_registry` row
 * can be left in `ALLOCATING` forever when admission fails BEFORE a `tasks`
 * row is ever created (`performFreshAllocation()`'s own documented
 * "deliberately never overwrites to BLOCKED" contract). The ONLY existing
 * recovery path, `reconcileInterruptedAllocation()` inside
 * `ensureTaskWorkspace()`, only ever fires on a replay under the EXACT same
 * historical `task_id` — nothing resubmits a task under a specific past id
 * in ordinary operation, so that class of failure is permanently stuck.
 *
 * This module is a NARROW, read-mostly sweeper — never a general filesystem
 * scan, never a global cross-project loop (a caller decides which
 * `projectId` to inspect, e.g. at admission preflight for THAT project, or
 * at a bounded runtime-startup pass over each configured project). It
 * inspects ONLY durable `task_workspace_registry` rows already known to DSH
 * (`state = ALLOCATING`) and the SAME read-only Git facts
 * `task-workspace-manager.mjs` itself already trusts (branch existence,
 * `git worktree list` registration, on-disk path existence, exact pinned-SHA
 * equality) — it reuses that module's own `pathsEqual`/`listWorktrees`/
 * `branchNameFromRef`/`resolveRepositoryCommonDir` rather than a second,
 * potentially-drifted copy of the same identity logic.
 *
 * Safety rule (never violated): a row is ONLY ever auto-transitioned when
 * EVERY one of these is independently proven true —
 *   - no `tasks` row exists for this `task_id` (a real task owns recovery
 *     the moment one exists; this sweeper always defers to it)
 *   - the caller's live repository identity matches the row's own recorded
 *     `repository_common_dir`
 *   - no `git worktree list` registration claims the row's `workspace_path`
 *   - nothing exists on disk at `workspace_path`
 *   - EITHER the task branch never exists at all, OR it exists and its SHA
 *     is EXACTLY the row's own `pinned_base_sha` (a freshly-failed
 *     `worktree add -b` can only ever have left the branch pointing at the
 *     pin it was given — any other SHA means something else touched it,
 *     and this sweeper refuses to guess why)
 * Every other combination is left completely untouched (BLOCK/RETAIN) —
 * this module never deletes a branch, a worktree, or a directory, and never
 * force-removes anything. The one action it CAN take is a CAS-guarded
 * `ALLOCATING -> BLOCKED` transition with a typed `reason_code`, which makes
 * the row operator-visible/cleanable without inventing a second destructive
 * automation path.
 */

import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

import { runGit } from './task-result-git-sync.mjs';
import {
  TASK_WORKSPACE_STATE,
  workspacePersistenceSupported,
  resolveRepositoryCommonDir,
  pathsEqual,
  listWorktrees,
} from './task-workspace-manager.mjs';

export class TaskWorkspaceOrphanReconciliationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskWorkspaceOrphanReconciliationError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const ORPHAN_RECONCILIATION_CLASSIFICATION = Object.freeze({
  TASK_ROW_EXISTS_SKIPPED: 'TASK_ROW_EXISTS_SKIPPED',
  BLOCKED_REPOSITORY_IDENTITY_MISMATCH: 'BLOCKED_REPOSITORY_IDENTITY_MISMATCH',
  RETAINED_WORKTREE_REGISTERED: 'RETAINED_WORKTREE_REGISTERED',
  RETAINED_PATH_EXISTS: 'RETAINED_PATH_EXISTS',
  BLOCKED_BRANCH_AHEAD_OF_BASE: 'BLOCKED_BRANCH_AHEAD_OF_BASE',
  ORPHANED_SAFE_TO_BLOCK: 'ORPHANED_SAFE_TO_BLOCK',
});

/** The one typed `reason_code` this module ever writes onto a row it transitions. */
export const TASK_WORKSPACE_ORPHANED_ALLOCATION_REASON = 'TASK_WORKSPACE_ORPHANED_ALLOCATION';

function existsOnDisk(path) {
  try { return existsSync(path); } catch { return false; }
}

/**
 * @param {object} input
 * @param {object} input.taskRepository - durable repository; requires the
 *        schema-v10 workspace accessor pair, `listTaskWorkspacesByProjectState`,
 *        and `getOwnerTask` (all present on `AgentBusRepository`).
 * @param {string} input.projectId
 * @param {string} input.projectRepoPath - the REGISTERED user checkout for this project.
 * @param {boolean} [input.dryRun] - when true, classifies every row and
 *        performs NO durable write at all (§9/§10 — "run it in DRY-RUN /
 *        inspect mode first").
 * @returns {Promise<Array<{taskId:string, classification:string, mutated:boolean}>>}
 */
export async function reconcileOrphanedAllocatingTaskWorkspaces({
  taskRepository, projectId, projectRepoPath, spawnImpl = nodeSpawn, timeoutMs, dryRun = false,
} = {}) {
  if (!workspacePersistenceSupported(taskRepository) || typeof taskRepository.listTaskWorkspacesByProjectState !== 'function') {
    throw new TaskWorkspaceOrphanReconciliationError('durable workspace persistence with schema-v11 listing support is required', 'WORKSPACE_ORPHAN_PERSISTENCE_UNAVAILABLE', {});
  }
  if (typeof projectId !== 'string' || !projectId) {
    throw new TaskWorkspaceOrphanReconciliationError('project_id is required', 'WORKSPACE_ORPHAN_PROJECT_ID_MISSING', {});
  }
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new TaskWorkspaceOrphanReconciliationError('project repository path is required', 'WORKSPACE_ORPHAN_REPO_PATH_MISSING', {});
  }

  const rows = taskRepository.listTaskWorkspacesByProjectState(projectId, TASK_WORKSPACE_STATE.ALLOCATING);
  const results = [];
  if (rows.length === 0) return results;

  // Resolved ONCE for every row in this project — every row's own
  // `repository_common_dir` is compared against this single live fact.
  const liveCommonDir = await resolveRepositoryCommonDir({ repoPath: projectRepoPath, spawnImpl, timeoutMs });
  const liveEntries = await listWorktrees({ projectRepoPath, spawnImpl, timeoutMs });
  const opts = { cwd: projectRepoPath, timeoutMs, spawnImpl };

  for (const { taskId, record, revision } of rows) {
    // Class D — a real `tasks` row exists: normal task recovery owns this
    // workspace entirely; the sweeper must never interfere.
    const taskRow = typeof taskRepository.getOwnerTask === 'function' ? taskRepository.getOwnerTask(taskId) : null;
    if (taskRow) {
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.TASK_ROW_EXISTS_SKIPPED, mutated: false });
      continue;
    }

    // Class F — repository identity mismatch: BLOCK (no mutation, no further inspection).
    if (!pathsEqual(record.repository_common_dir, liveCommonDir)) {
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.BLOCKED_REPOSITORY_IDENTITY_MISMATCH, mutated: false });
      continue;
    }

    const registeredEntry = liveEntries.find((e) => e.path && pathsEqual(resolvePath(e.path), resolvePath(record.workspace_path)));
    // Class B — a worktree registration exists at this path: never
    // auto-reconciled here; left exactly as-is for exact-registration inspection.
    if (registeredEntry) {
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.RETAINED_WORKTREE_REGISTERED, mutated: false });
      continue;
    }
    // Class C — something occupies the derived path on disk: never deleted blindly.
    if (existsOnDisk(record.workspace_path)) {
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.RETAINED_PATH_EXISTS, mutated: false });
      continue;
    }

    const branchExistsRes = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${record.task_branch}`], opts);
    if (branchExistsRes.ok) {
      const branchShaRes = await runGit(['rev-parse', record.task_branch], opts);
      const branchSha = branchShaRes.ok ? branchShaRes.stdout.trim() : null;
      // Class E — the branch carries commits beyond (or simply different
      // from) the pinned base: a genuinely-orphaned fresh allocation can
      // only ever leave the branch exactly AT its own pin — anything else
      // means something unexplained touched it. BLOCK, do not guess.
      if (branchSha !== record.pinned_base_sha) {
        results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.BLOCKED_BRANCH_AHEAD_OF_BASE, mutated: false });
        continue;
      }
    }

    // Class A (proven-safe orphan): task row absent, repository identity
    // matches, no worktree registration, no on-disk path, and (if the
    // branch exists at all) it sits exactly at the pinned base. Never
    // delete the branch — transition the durable row to BLOCKED with a
    // typed, operator-cleanable reason instead (§8's stated preference).
    if (dryRun) {
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.ORPHANED_SAFE_TO_BLOCK, mutated: false });
      continue;
    }
    try {
      taskRepository.upsertTaskWorkspace(taskId, {
        expectedRevision: revision,
        record: { ...record, state: TASK_WORKSPACE_STATE.BLOCKED, reason_code: TASK_WORKSPACE_ORPHANED_ALLOCATION_REASON },
      });
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.ORPHANED_SAFE_TO_BLOCK, mutated: true });
    } catch (error) {
      // A CAS conflict here means the row moved under us (e.g. a genuine
      // replay reconciled it concurrently) — never retried, never forced;
      // simply report it as unmutated by this pass.
      results.push({ taskId, classification: ORPHAN_RECONCILIATION_CLASSIFICATION.ORPHANED_SAFE_TO_BLOCK, mutated: false, error: error.code ?? error.message });
    }
  }

  return results;
}
