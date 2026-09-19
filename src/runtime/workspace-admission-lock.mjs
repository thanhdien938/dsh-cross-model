/**
 * P24.1G6A §15/§16 — same-physical-workspace admission fencing.
 *
 * A minimal, in-process, async mutex keyed by `workspace_id` (falling back
 * to `repo_path` when no validated workspace identity is available — the
 * SAME conservative "UNVERIFIED" fallback `resolvePmWorkspaceIdentity()`
 * already uses, never `project.id`, so two project records that happen to
 * share one physical path still serialize against each other).
 *
 * This closes the concrete gap the G6 audit demonstrated: Git admission
 * mutation (fetch/resolve/branch-create/checkout) and worker execution on
 * the SAME shared physical workspace must never interleave, or a clean
 * checkout can be switched out from under an in-flight operation. It does
 * NOT implement a cross-process/distributed lock (a real deployment's
 * coordinator+worker roles run in the SAME Node process — the one
 * production composition this codebase actually ships — so an in-process
 * mutex is the correct minimum for that real deployment shape) and it does
 * NOT implement per-task isolated worktrees — both are explicitly larger
 * architecture changes this phase's stop-rule excludes. Different
 * workspace_ids always run fully in parallel; this is the ONE serialization
 * axis.
 */

export function createWorkspaceAdmissionLock() {
  const chains = new Map();
  return Object.freeze({
    /** Runs `fn()` only after every earlier `withLock()` call for the SAME `key` has fully settled (success or failure never blocks the next acquire); returns/rejects exactly as `fn()` does. */
    withLock(key, fn) {
      const lockKey = typeof key === 'string' && key ? key : '__unkeyed__';
      const prior = chains.get(lockKey) ?? Promise.resolve();
      const waited = prior.catch(() => {});
      const run = waited.then(() => fn());
      chains.set(lockKey, run.catch(() => {}));
      return run;
    },
  });
}
