/**
 * P24.3B — production task-workspace ROUTING (reports/
 * P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md;
 * P24.3A's src/pm/task-workspace-manager.mjs).
 *
 * The ONE place that interprets `task.context.taskWorkspace` (the durable
 * binding P24.3A's manager produces and OwnerTaskController.submit()
 * stamps onto a NEW v1 task at admission time) into an actual execution
 * root. Every other production file that needs to know "where does this
 * task's mutable Git/provider cwd actually live" calls through here —
 * never re-reads `taskWorkspace` inline, never re-derives isolation
 * eligibility itself.
 *
 * Absence of `taskWorkspace` (every legacy task, and every v1 task before
 * this admission stamp existed) means exactly what it always meant:
 * `project.repo_path` is the execution root, byte-for-byte pre-P24.3
 * behavior. An unsupported `isolation_version` fails closed to the SAME
 * legacy fallback here (this module never mutates Git — a caller that
 * actually needs to validate/enforce the version, e.g. the workspace
 * manager itself, already does that at allocation/cleanup time); this
 * module's only job is "which path do reads/writes for THIS task use,"
 * not admission-time validation.
 */

const SUPPORTED_ISOLATION_VERSION = 1;

/**
 * @param {object|null} taskContext - `task.context` (production-pm-
 *   worker.mjs) or the `taskContext` parameter `createRuntime()` already
 *   receives (p5-production-composition.mjs) — the SAME durable object in
 *   both cases, never re-fetched.
 * @returns {{isolation_version:number, workspace_path:string, repository_common_dir:string}|null}
 */
export function resolveTaskWorkspaceBinding(taskContext) {
  const ws = taskContext?.taskWorkspace;
  if (!ws || typeof ws !== 'object') return null;
  if (ws.isolation_version !== SUPPORTED_ISOLATION_VERSION) return null;
  if (typeof ws.workspace_path !== 'string' || !ws.workspace_path) return null;
  return ws;
}

/** The absolute path every mutable Git operation (commit/push/verify/manifest/product-export/workspace_output) for this task must run against. */
export function resolveExecutionRepoPath(project, taskContext) {
  const binding = resolveTaskWorkspaceBinding(taskContext);
  return binding ? binding.workspace_path : project.repo_path;
}

/**
 * A project-shaped view whose `repo_path` is the task's execution root —
 * for callers that need to hand a whole `project` object to a provider
 * factory / report-backend resolver / evidence-packet reader (never for
 * identity, admission, occupancy, or any cache keyed by project identity —
 * see this module's own docstring and the audit's own "Never construct
 * {...project, repo_path: taskPath} as the long-term interface").
 *
 * This IS that one narrow, ephemeral exception the audit's own wording
 * anticipates: built FRESH on every call, never stored, never fed back
 * into `this.projects`/any project-identity-keyed Map — every field other
 * than `repo_path` (crucially `id`, `autonomy`, `workspace_id`) is
 * preserved verbatim, so a caller that only cares about identity/policy is
 * completely unaffected by which view it was handed.
 */
export function resolveExecutionProject(project, taskContext) {
  const binding = resolveTaskWorkspaceBinding(taskContext);
  if (!binding) return project;
  return Object.freeze({ ...project, repo_path: binding.workspace_path });
}

/** Stable cache key for a project-scoped resolver/runner that must never survive a repo_path change across tasks (the audit's "project-keyed cache" hazard) — legacy tasks always resolve to one stable key per project (today's behavior, unchanged); each v1 task gets its own key (its workspace path is unique per task), so a cached instance is never reused across a deleted/differing workspace. */
export function projectExecutionCacheKey(project, taskContext) {
  const repoPath = resolveExecutionRepoPath(project, taskContext);
  return `${project.id}::${repoPath}`;
}
