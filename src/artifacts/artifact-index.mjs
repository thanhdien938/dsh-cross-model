/**
 * P20.6 §16/§17 — the rebuildable artifact DISCOVERY index.
 *
 * Authority: docs/P20/P20_6_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §16/§17,
 * P20_START_HERE.md ("Searchability requirement").
 *
 * The index derives ONLY from app-owned P20 metadata — `task-manifest.json`,
 * `invocation.json`, attempt `artifact.json`, and the sealed ArtifactReference
 * recorded on a task manifest's `stages` / `final_ref`. It NEVER reads
 * `report.md` and never interprets model content: a report body claiming
 * `{"task_id":"fake","latest":true,"stage":"chair"}` cannot affect any index
 * fact (§17). Persisted convenience output under `<store>/indexes/` is
 * app-owned, atomic, and fully reconstructable — deleting it and rebuilding
 * from canonical metadata reproduces equivalent records. A stale/corrupt
 * index is NEVER authority for context admission; every required context ends
 * at a full verification of a concrete sealed reference elsewhere.
 *
 * Pure filesystem read + Node stdlib. No clock in the records (a rebuild is
 * byte-stable), no network, no model output.
 */

import {
  existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { validateArtifactReference } from './artifact-schema.mjs';

export const ARTIFACT_INDEX_VERSION = 'p20.6-index-1';
const INDEX_FILE = 'artifact-index.json';
const LOCK_DIR = '.lock';
const MAX_SCAN_DEPTH = 12;

export class ArtifactIndexError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactIndexError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Bounded recursive scan for every `invocation.json` under a task root. */
function findInvocationFiles(dir, depth = 0, out = []) {
  if (depth > MAX_SCAN_DEPTH) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'invocation.json')) {
    out.push(join(dir, 'invocation.json'));
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === LOCK_DIR || e.name.startsWith('attempt-')) continue;
    findInvocationFiles(join(dir, e.name), depth + 1, out);
  }
  return out;
}

function sealedRefFromManifestStages(manifest, invocationId) {
  const stages = manifest && typeof manifest.stages === 'object' && manifest.stages ? manifest.stages : {};
  for (const [stageKey, entry] of Object.entries(stages)) {
    if (entry && entry.invocation_id === invocationId && entry.sealed_ref) {
      const rv = validateArtifactReference(entry.sealed_ref, { requireSealed: true });
      if (rv.ok) return { stage_key: stageKey, sealed_ref: entry.sealed_ref };
    }
  }
  return null;
}

/**
 * Build the deterministic, rebuildable index from canonical metadata only.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @returns {{ version: string, project_id: string, store_id: string,
 *            tasks: object[], invocations: object[], edges: object[] }}
 */
export function buildArtifactIndex({ store }) {
  if (!store || typeof store.tasksRoot !== 'string') {
    throw new ArtifactIndexError('an ArtifactStore is required', 'ARTIFACT_INDEX_NO_STORE');
  }
  const tasksRoot = store.tasksRoot;
  const tasks = [];
  const invocations = [];
  const edges = [];

  let taskDirs = [];
  try {
    taskDirs = readdirSync(tasksRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== LOCK_DIR)
      .map((e) => e.name);
  } catch { taskDirs = []; }

  for (const folder of taskDirs) {
    const taskPath = join(tasksRoot, folder);
    const manifest = readJsonOrNull(join(taskPath, 'task-manifest.json'));
    if (!manifest || typeof manifest.task_id !== 'string') continue;
    // Only surface tasks that belong to THIS store/project identity.
    if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) continue;

    const finalRefOk = manifest.final_ref && validateArtifactReference(manifest.final_ref, { requireSealed: true }).ok;
    tasks.push({
      folder,
      task_id: manifest.task_id,
      task_slug: manifest.task_slug ?? null,
      created_at: manifest.created_at ?? null,
      mode: manifest.mode ?? null,
      task_state: manifest.task_state ?? null,
      artifact_gate_state: manifest.artifact_gate_state ?? null,
      final_ref: finalRefOk ? manifest.final_ref : null,
      previous_task_refs: Array.isArray(manifest.previous_task_refs) ? manifest.previous_task_refs.map((r) => structuredClone(r)) : [],
    });

    (Array.isArray(manifest.previous_task_refs) ? manifest.previous_task_refs : []).forEach((ref, ordinal) => {
      if (ref && validateArtifactReference(ref, { requireSealed: true }).ok) {
        edges.push({
          target_task_id: manifest.task_id,
          ordinal,
          source_task_id: ref.task_id,
          source_invocation_id: ref.invocation_id,
          ref: structuredClone(ref),
        });
      }
    });

    for (const invFile of findInvocationFiles(taskPath)) {
      const rec = readJsonOrNull(invFile);
      if (!rec || typeof rec.invocation_id !== 'string') continue;
      const invDir = invFile.slice(0, -('/invocation.json'.length)).split(/[\\/]/).join('/');
      const attempts = [];
      for (const ord of Array.isArray(rec.attempts) ? rec.attempts : []) {
        const am = readJsonOrNull(join(invFile, '..', `attempt-${String(ord).padStart(2, '0')}`, 'artifact.json'));
        attempts.push({
          attempt_ordinal: ord,
          repair_of: am ? (am.repair_of ?? null) : null,
          terminal_state: am ? (am.terminal_state ?? null) : null,
          delivery_mechanism: am ? (am.delivery_mechanism ?? null) : null,
          input_transport: am ? (am.input_transport ?? null) : null,
          execution_id: am ? (am.execution_id ?? null) : null,
        });
      }
      const sealed = sealedRefFromManifestStages(manifest, rec.invocation_id);
      invocations.push({
        task_id: rec.task_id ?? manifest.task_id,
        invocation_id: rec.invocation_id,
        invocation_key: rec.invocation_key ?? null,
        stage_relpath: rec.stage_relpath ?? invDir,
        profile_id: rec.profile_id ?? null,
        actor_alias: rec.actor_alias ?? null,
        role: rec.role ?? null,
        stage: rec.stage ?? null,
        round: rec.round ?? null,
        lifecycle: rec.lifecycle ?? null,
        integrity_state: rec.integrity_state ?? null,
        authoritative_attempt: rec.authoritative_attempt ?? null,
        latest_attempt_ordinal: rec.latest_attempt_ordinal ?? null,
        repair_of: rec.repair_of ?? null,
        attempts,
        is_final_artifact: Boolean(finalRefOk && manifest.final_ref.invocation_id === rec.invocation_id),
        sealed_stage_key: sealed ? sealed.stage_key : null,
        sealed_ref: sealed ? structuredClone(sealed.sealed_ref) : null,
      });
    }
  }

  // Deterministic ordering — a rebuild is byte-stable regardless of readdir order.
  tasks.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.task_id.localeCompare(b.task_id) || a.folder.localeCompare(b.folder));
  invocations.sort((a, b) => a.task_id.localeCompare(b.task_id)
    || String(a.stage).localeCompare(String(b.stage))
    || String(a.actor_alias).localeCompare(String(b.actor_alias))
    || String(a.round ?? '').localeCompare(String(b.round ?? ''))
    || a.invocation_id.localeCompare(b.invocation_id));
  edges.sort((a, b) => a.target_task_id.localeCompare(b.target_task_id) || (a.ordinal - b.ordinal));

  return {
    version: ARTIFACT_INDEX_VERSION,
    store_id: store.storeId,
    project_id: store.projectId,
    tasks,
    invocations,
    edges,
  };
}

/** Atomic, app-owned persist of a convenience index under `<store>/indexes/`. */
export function writeArtifactIndex({ store, index }) {
  const dir = store.indexesRoot;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, INDEX_FILE);
  const tmp = join(dir, `.${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

/** Read the persisted convenience index, or null when absent/unreadable. Never authority. */
export function readArtifactIndex({ store }) {
  const target = join(store.indexesRoot, INDEX_FILE);
  if (!existsSync(target)) return null;
  return readJsonOrNull(target);
}

// P20.8 PRE-R3 R3-3 — the frozen task-folder naming convention
// (`taskFolderName()` in artifact-paths.mjs: `<UTC-compact-timestamp>__
// <slug>__<short-task-id>`, e.g. `20260910_090000__my-task__task-abc123`)
// embeds a canonical, fixed-width, zero-padded, lexicographically-sortable
// UTC ordering key DIRECTLY IN THE FOLDER NAME — an ordering fact that does
// NOT depend on task-manifest.json being readable. Only the LEADING
// timestamp + separator is required to recognise a canonical folder; a
// directory whose name does not start this way is provably not one (R3-3C)
// and is simply never ranked.
const CANONICAL_TASK_FOLDER_RE = /^(\d{8}_\d{6})__.+$/;

/** Every canonical task folder directly under `tasksRoot`, newest-first. */
function canonicalTaskFoldersNewestFirst(tasksRoot) {
  let entries;
  try { entries = readdirSync(tasksRoot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === LOCK_DIR) continue;
    const m = CANONICAL_TASK_FOLDER_RE.exec(e.name);
    if (!m) continue; // R3-3C: not a canonical task folder — never a blocker
    out.push({ folder: e.name, ts: m[1] });
  }
  // The embedded timestamp is fixed-width/zero-padded, so lexicographic
  // string order == chronological order; break ties on the full folder name
  // for a fully deterministic walk.
  out.sort((a, b) => (a.ts === b.ts ? b.folder.localeCompare(a.folder) : b.ts.localeCompare(a.ts)));
  return out;
}

/**
 * §9.3 — the newest COMPLETED + TASK_ARTIFACT_PASS task, derived from
 * authoritative task manifests. Returns `null` when none exists.
 *
 * P20.8 PRE-R3 R3-3 — this is the FAIL-CLOSED authority candidate walk, kept
 * DELIBERATELY separate from `buildArtifactIndex()` above (a best-effort
 * convenience projection that silently drops a task whose manifest cannot
 * be read — correct for a diagnostic/UI listing, WRONG for LATEST_FINAL
 * authority). It walks CANONICAL task folders strictly newest-first by their
 * folder-name-embedded timestamp. The FIRST canonical folder encountered
 * (newest-first) whose task-manifest.json cannot be read/parsed/carries no
 * valid task_id stops the walk and fails closed — LATEST_FINAL must never
 * silently prefer an older, readable task while a newer one's authority
 * metadata is corrupt or missing (R3-3A/R3-3B). A folder that reads cleanly
 * but belongs to a different store/project, or is not (yet) a completed
 * candidate, is skipped and the walk continues toward older folders.
 *
 * NOTE (P20.6R R2, preserved): this only *discovers the candidate* — it is
 * NOT the final authority. `LATEST_FINAL` resolution runs the shared
 * `resolveAndVerifyTaskFinalArtifact({ store, taskId })` proof on this
 * candidate and FAILS CLOSED if that candidate's final authority is
 * corrupt/cross-task/wrong-topology — it never silently falls back to an
 * older task. Candidate discovery is by claimed task_state/artifact_gate_state
 * ONLY; a malformed/missing `final_ref` on an otherwise-readable newest
 * COMPLETED manifest does NOT drop it from candidacy here (that is exactly
 * the corruption `resolveAndVerifyTaskFinalArtifact` must fail closed on,
 * not something this discovery step should hide by silently preferring an
 * older task).
 *
 * @throws {ArtifactIndexError} ARTIFACT_INDEX_LATEST_AMBIGUOUS when a newer,
 *         unrankable canonical task folder exists ahead of any usable
 *         completed candidate
 */
export function latestCompletedTaskId({ store }) {
  if (!store || typeof store.tasksRoot !== 'string') {
    throw new ArtifactIndexError('an ArtifactStore is required', 'ARTIFACT_INDEX_NO_STORE');
  }
  const folders = canonicalTaskFoldersNewestFirst(store.tasksRoot);
  for (const { folder, ts } of folders) {
    const manifestPath = join(store.tasksRoot, folder, 'task-manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new ArtifactIndexError(
        `LATEST_FINAL discovery: task folder ${JSON.stringify(folder)} (created ${ts}) has an unreadable/malformed `
        + 'task-manifest.json; refusing to silently prefer an older task — its true completion state cannot be established',
        'ARTIFACT_INDEX_LATEST_AMBIGUOUS',
        { folder, ts, cause: error?.code ?? null },
      );
    }
    if (typeof manifest.task_id !== 'string' || !manifest.task_id) {
      throw new ArtifactIndexError(
        `LATEST_FINAL discovery: task folder ${JSON.stringify(folder)} (created ${ts}) has a task-manifest.json with `
        + 'no valid task_id; refusing to rank it',
        'ARTIFACT_INDEX_LATEST_AMBIGUOUS',
        { folder, ts },
      );
    }
    // A folder belonging to a DIFFERENT store/project is not part of THIS
    // store's timeline at all (frozen naming is store-agnostic, so a
    // co-located foreign store's tasks can share the same tasksRoot) — skip
    // it and keep walking toward older folders; it is not an ambiguity for
    // THIS store.
    if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) continue;

    if (manifest.task_state === 'COMPLETED' && manifest.artifact_gate_state === 'TASK_ARTIFACT_PASS') {
      return manifest.task_id;
    }
    // Readable, but not (yet) a completed candidate — keep walking older.
  }
  return null;
}

/**
 * Discovery convenience: the newest completed task's *projected* final_ref
 * from the index. Not authority — kept for diagnostic/UI listing only. A
 * caller that needs a usable context ref MUST go through
 * `resolveAndVerifyTaskFinalArtifact`.
 */
export function latestCompletedFinalRef({ store }) {
  const { tasks } = buildArtifactIndex({ store });
  const completed = tasks.filter((t) => t.task_state === 'COMPLETED' && t.artifact_gate_state === 'TASK_ARTIFACT_PASS' && t.final_ref);
  if (completed.length === 0) return null;
  completed.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.task_id.localeCompare(a.task_id));
  return structuredClone(completed[0].final_ref);
}
