/**
 * P22.1 — opt-in GitHub review completeness for P20 tasks.
 *
 * Authority: docs/P22/P22_0_AUTOMATIC_TASK_GITHUB_REVIEW_BRANCH_AUDIT.md
 * "RECOMMENDED_P20_REVIEW_MECHANISM: B" — a small DSH-owned manifest at
 * `docs/task-review/<task_id>.json` containing app identity, base/source
 * SHA, branch/remote identity, transport/topology and the canonical sealed
 * `final_ref` plus its byte count/hash. This is review METADATA, never a
 * new artifact authority, never a copy of the model-authored report, and
 * never semantic interpretation of model output.
 *
 * Owner decision (P22.1 task prompt, verbatim): KEEP EXISTING PUSH OPT-IN
 * SEMANTICS. This module does not decide WHETHER or WHEN to run — the
 * caller (production-pm-worker.mjs) invokes it only when the owner already
 * requested `push`, and only when the completed task's `result.data`
 * carries a verified/sealed P20 `final_ref`. This module itself never
 * inspects gitSync/push flags, never decides Git lifecycle timing, and
 * never runs `git` — the existing `commitTaskResult()` / `pushTaskResult()`
 * (task-result-git-sync.mjs) remain the ONE Git implementation; this is a
 * plain, deterministic file writer whose output those helpers pick up as
 * an ordinary dirty file (`git add -A`), exactly like any other task-owned
 * change.
 *
 * Determinism / idempotency: the manifest is a pure function of its
 * verified inputs — no timestamps, no random ordering — so re-running
 * settlement for the same completed task (a crash-recovery replay, for
 * example) produces byte-identical content. If a manifest already exists
 * at this path and disagrees with the freshly computed canonical facts,
 * this fails closed with `TASK_REVIEW_MANIFEST_CONFLICT` rather than
 * silently overwriting what could be a corrupted or foreign file.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assertWithinProjectRoot } from '../runtime/repo-history-materializer.mjs';
import { validateArtifactReference } from '../artifacts/artifact-schema.mjs';

export class TaskReviewManifestError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TaskReviewManifestError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Same canonical task-id charset already used by artifact-paths.mjs /
// repo-history-id.mjs (`CANONICAL_TASK_ID_RE`) — a task_id that reaches
// this module has already passed through those same-shaped checks
// upstream; this is defense in depth, not a new policy.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_DIR_RELPATH = 'docs/task-review';
export const TASK_REVIEW_MANIFEST_SCHEMA_VERSION = 'p22.1-1';
export const TASK_REVIEW_TASK_MODES = Object.freeze(['SINGLE', 'COUNCIL', 'DEBATE']);

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isShaHex(v) { return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v); }

function jsonDeepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonDeepEqual(a[k], b[k]));
}

function taskReviewManifestRelPath(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new TaskReviewManifestError('task_id is invalid', 'TASK_REVIEW_MANIFEST_TASK_ID_INVALID', { taskId });
  }
  return `${REVIEW_DIR_RELPATH}/${taskId}.json`;
}

/**
 * Build the deterministic manifest object. Pure — no I/O, no timestamps.
 * `finalRef` MUST already be a verified/sealed ArtifactReference (freeze
 * §16) — this is the one gate that makes this a "P20 task" manifest at
 * all; a caller with no sealed final_ref must never call this.
 */
export function buildTaskReviewManifest({
  taskId, projectId, taskMode, branch = null, baseSha = null,
  artifactTransport = null, finalRef = null, topology = null, workspaceOutput = null,
}) {
  if (!isNonEmptyString(taskId)) throw new TaskReviewManifestError('taskId is required', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'taskId' });
  if (!isNonEmptyString(projectId)) throw new TaskReviewManifestError('projectId is required', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'projectId' });
  if (!TASK_REVIEW_TASK_MODES.includes(taskMode)) throw new TaskReviewManifestError(`taskMode must be one of ${TASK_REVIEW_TASK_MODES.join(', ')}`, 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'taskMode', taskMode });
  if (branch !== null && !isNonEmptyString(branch)) throw new TaskReviewManifestError('branch must be a non-empty string or null', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'branch' });
  if (baseSha !== null && !isShaHex(baseSha)) throw new TaskReviewManifestError('baseSha must be a 40-hex commit SHA or null', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'baseSha' });

  const refCheck = validateArtifactReference(finalRef, { requireSealed: true });
  if (!refCheck.ok) {
    throw new TaskReviewManifestError(`final_ref is not a verified/sealed ArtifactReference: ${refCheck.errors.join('; ')}`, 'TASK_REVIEW_MANIFEST_FINAL_REF_UNSEALED', { errors: refCheck.errors });
  }
  if (finalRef.task_id !== taskId) {
    throw new TaskReviewManifestError('final_ref.task_id does not belong to this task', 'TASK_REVIEW_MANIFEST_FINAL_REF_CROSS_TASK', { finalRefTaskId: finalRef.task_id, taskId });
  }
  if (finalRef.project_id !== projectId) {
    throw new TaskReviewManifestError('final_ref.project_id does not match this task/project', 'TASK_REVIEW_MANIFEST_FINAL_REF_CROSS_TASK', { finalRefProjectId: finalRef.project_id, projectId });
  }

  const manifest = {
    schema_version: TASK_REVIEW_MANIFEST_SCHEMA_VERSION,
    task_id: taskId,
    project_id: projectId,
    task_mode: taskMode,
    branch,
    base_sha: baseSha,
    artifact_transport: artifactTransport ?? null,
    final_ref: finalRef,
    report_sha256: finalRef.sha256,
    report_bytes: finalRef.bytes,
  };
  if (topology !== null && topology !== undefined) {
    if (typeof topology !== 'object' || Array.isArray(topology)) {
      throw new TaskReviewManifestError('topology must be a plain object when present', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'topology' });
    }
    manifest.topology = topology;
  }
  // P24.1G2 — refs/path/hash/status ONLY (never full report content, per
  // the caller's own docstring at the write site). Present only when a
  // typed workspace_output was actually requested for this task; absent
  // for every pre-P24.1G2 task, byte-for-byte unaffected.
  if (workspaceOutput !== null && workspaceOutput !== undefined) {
    if (typeof workspaceOutput !== 'object' || Array.isArray(workspaceOutput)) {
      throw new TaskReviewManifestError('workspaceOutput must be a plain object when present', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'workspaceOutput' });
    }
    manifest.workspace_output = workspaceOutput;
  }
  return manifest;
}

function canonicalManifestJson(manifest) { return `${JSON.stringify(manifest, null, 2)}\n`; }

// Same tmp-write-then-rename idiom as repo-history-materializer.mjs's own
// (unexported) `atomicWriteFile` — no second persistence framework, just
// the same 3-line pattern this codebase already uses for every other
// generated repository file.
function atomicWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * Idempotently write `docs/task-review/<task_id>.json` into the project
 * repository. Refs/hashes only — never stages `.runtime`, never copies
 * `report.md` bytes, never parses model output.
 *
 * Returns `{ path, relPath, written, manifest }` — `written:false` means an
 * identical manifest already existed (a genuine no-op replay, not a
 * failure).
 */
export function writeTaskReviewManifest({ projectRepoPath, ...manifestInput }) {
  if (typeof projectRepoPath !== 'string' || !projectRepoPath) {
    throw new TaskReviewManifestError('projectRepoPath is required', 'TASK_REVIEW_MANIFEST_INVALID_INPUT', { field: 'projectRepoPath' });
  }
  const manifest = buildTaskReviewManifest(manifestInput);
  const relPath = taskReviewManifestRelPath(manifest.task_id);
  const fullPath = assertWithinProjectRoot(projectRepoPath, join(projectRepoPath, relPath), 'task review manifest path');

  if (existsSync(fullPath)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
      throw new TaskReviewManifestError(`existing task review manifest is not valid JSON: ${error.message}`, 'TASK_REVIEW_MANIFEST_CORRUPT', { relPath });
    }
    if (!jsonDeepEqual(existing, manifest)) {
      throw new TaskReviewManifestError('existing task review manifest does not match the canonical verified facts for this task', 'TASK_REVIEW_MANIFEST_CONFLICT', { relPath });
    }
    return Object.freeze({ path: fullPath, relPath, written: false, manifest });
  }

  atomicWriteFile(fullPath, canonicalManifestJson(manifest));
  return Object.freeze({ path: fullPath, relPath, written: true, manifest });
}
