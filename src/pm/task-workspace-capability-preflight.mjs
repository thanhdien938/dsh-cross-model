/**
 * P24.3B-R1 Gap #4 — minimum fail-closed capability preflight for isolated
 * task-workspace activation (reports/
 * P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md §21
 * "Security fail-closed checklist"; this phase's own reports/
 * P24_3B_R1_QUALIFICATION_READINESS_CLOSURE_20260917.md).
 *
 * P24.3A's `TaskWorkspaceManager` proves a linked worktree does not
 * interfere with a dirty REGISTERED checkout — it says nothing about
 * whether the checkout produced *inside* that worktree is byte-stable and
 * confined to it. Three specific repository behaviors can violate that
 * without any worktree bug at all:
 *
 *   - a submodule whose checkout/update semantics this migration never
 *     qualified (§21 "Fail closed initially; no recursive submodule
 *     initialization/deletion");
 *   - a custom Git hook that can execute arbitrary code and mutate state
 *     outside the task worktree (§21 "reject unqualified external
 *     execution");
 *   - a configured clean/smudge/process filter that transforms checked-out
 *     content, silently breaking the "byte-stable task workspace" claim
 *     the whole isolation design rests on.
 *
 * This module is a NARROW, read-only, deterministic PREFLIGHT — it never
 * mutates the repository, never initializes/updates a submodule, never
 * disables/deletes a hook, and never emulates a filter. It only detects
 * and reports. Called ONCE, before any worktree allocation, ONLY when a
 * caller has opted a task into isolation (§8 test 27: legacy/shared-
 * worktree admission never runs this check — unchanged risk posture for
 * every task that predates this phase).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { runGit } from './task-result-git-sync.mjs';

export class TaskWorkspaceCapabilityError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskWorkspaceCapabilityError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Every stock Git installation ships these as `<hook-name>.sample` inside
// `hooks/` — inert, never executed. Anything else in that directory is an
// operator/repository-authored hook DSH has not qualified for `worktree
// add`/`commit`/`push`/checkout side effects a v1 task's own Git sequence
// invokes.
function isSampleHookFile(name) {
  return name.endsWith('.sample');
}

async function detectSubmodules({ repoPath, spawnImpl, timeoutMs }) {
  if (existsSync(resolvePath(repoPath, '.gitmodules'))) return true;
  // Defense in depth: a submodule can be registered in `.git/config`
  // without (or after removal of) a working-tree `.gitmodules` file —
  // `git config --get-regexp` reads the EFFECTIVE config, never the
  // working tree, so this catches that gap.
  const res = await runGit(['config', '--get-regexp', '^submodule\\.'], { cwd: repoPath, timeoutMs, spawnImpl });
  return res.ok && res.stdout.trim().length > 0;
}

async function detectCustomHooks({ repoPath, spawnImpl, timeoutMs }) {
  const hooksPathRes = await runGit(['rev-parse', '--git-path', 'hooks'], { cwd: repoPath, timeoutMs, spawnImpl });
  if (!hooksPathRes.ok) return false;
  const raw = hooksPathRes.stdout.trim();
  if (!raw) return false;
  const hooksDir = isAbsolute(raw) ? raw : resolvePath(repoPath, raw);
  let entries;
  try {
    entries = readdirSync(hooksDir, { withFileTypes: true });
  } catch {
    return false; // no hooks directory at all -- nothing to reject
  }
  return entries.some((entry) => entry.isFile() && !isSampleHookFile(entry.name));
}

// A `filter.<name>.*` definition existing in the EFFECTIVE config
// (local/global/SYSTEM) proves nothing about THIS repository on its own —
// a machine with Git LFS installed registers `filter.lfs.*` at the
// system level for every repository whether or not any of them actually
// use it. The repository only actually invokes a configured filter when
// its OWN `.gitattributes` assigns `filter=<name>` to some path — that
// assignment is the real, repository-scoped transform risk this preflight
// cares about; a globally-installed-but-unreferenced filter is not.
function gitattributesReferencesFilter(repoPath) {
  const path = resolvePath(repoPath, '.gitattributes');
  if (!existsSync(path)) return false;
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return false; }
  return /(?:^|\s)filter=\S/.test(content);
}

async function detectConfiguredFilters({ repoPath, spawnImpl, timeoutMs }) {
  if (!gitattributesReferencesFilter(repoPath)) return false;
  // The EFFECTIVE (local + global + system) filter configuration — a
  // clean/smudge/process filter runs regardless of which config level
  // defined it, so a narrower `--local`-only read would under-detect.
  const res = await runGit(['config', '--get-regexp', '^filter\\.'], { cwd: repoPath, timeoutMs, spawnImpl });
  return res.ok && res.stdout.trim().length > 0;
}

/**
 * Read-only preflight. Resolves to `Object.freeze({ok:true})` when the
 * repository has none of the three unqualified behaviors; throws a typed
 * `TaskWorkspaceCapabilityError` otherwise. Never mutates anything —
 * every check is a plain read (`git config --get-regexp`, `git rev-parse
 * --git-path`, a directory listing, an `existsSync`).
 */
export async function validateTaskWorkspaceRepositoryCapabilities({ repoPath, spawnImpl = nodeSpawn, timeoutMs } = {}) {
  if (typeof repoPath !== 'string' || !repoPath) {
    throw new TaskWorkspaceCapabilityError('repository path is required', 'TASK_WORKSPACE_CAPABILITY_PREFLIGHT_FAILED', {});
  }
  if (await detectSubmodules({ repoPath, spawnImpl, timeoutMs })) {
    throw new TaskWorkspaceCapabilityError(
      'repository has active submodule configuration; isolated task-workspace activation is not yet qualified for submodules',
      'TASK_WORKSPACE_SUBMODULE_UNSUPPORTED', {},
    );
  }
  if (await detectCustomHooks({ repoPath, spawnImpl, timeoutMs })) {
    throw new TaskWorkspaceCapabilityError(
      'repository has custom (non-sample) Git hooks; isolated task-workspace activation is not yet qualified for hook execution',
      'TASK_WORKSPACE_HOOK_UNSUPPORTED', {},
    );
  }
  if (await detectConfiguredFilters({ repoPath, spawnImpl, timeoutMs })) {
    throw new TaskWorkspaceCapabilityError(
      'repository has configured clean/smudge/process filters; isolated task-workspace activation cannot yet guarantee byte-stable checkout content',
      'TASK_WORKSPACE_FILTER_UNSUPPORTED', {},
    );
  }
  return Object.freeze({ ok: true });
}
