/**
 * P20.3C/§18–§20 — bounded, deterministic, NON-SEMANTIC artifact repair.
 *
 * Authority: docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §19–§23,
 * docs/P20/P20_3_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §18–§20, §31.
 *
 *   Case A — expected report missing, exactly ONE plausible misplaced .md
 *            candidate inside the attempt dir  -> app-side exact COPY to the
 *            expected path (original preserved) -> caller re-runs the full gate.
 *   Case B — zero candidates after an otherwise successful execution -> at
 *            most ONE delivery repair in a NEW attempt (same invocation_id,
 *            same profile/backend, new execution_id, repair_of set).
 *   Case C — 2+ candidates -> DSH never guesses -> at most ONE bounded
 *            delivery repair -> else ARTIFACT_REPAIR_FAILED.
 *
 * Candidate selection NEVER inspects headings, participant IDs, JSON shape,
 * verdicts, recommendations, or semantic similarity. No recursion. No model
 * call for Case A. Local materialization I/O retry (§19) is distinct from a
 * model repair and never re-invokes a backend.
 */

import { readdirSync, lstatSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INTEGRITY_STATE, ArtifactIntegrityError, REPORT_SIZE_POLICY } from './artifact-integrity.mjs';
import { isWithin, isWithinReal } from './artifact-path-identity.mjs';

export class ArtifactRepairError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactRepairError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 400;

/**
 * Deterministic, non-semantic scan of the assigned attempt directory for a
 * plausible misplaced report. A candidate is a NEW regular `.md` file
 * inside the attempt containment, not a symlink/junction, not the known
 * report/metadata/log file, within the size policy.
 *
 * @returns {string[]} absolute candidate paths (sorted)
 */
export function findMisplacedReportCandidates({ attemptDir, expectedReportName, maxReportBytes = REPORT_SIZE_POLICY.maxReportBytes }) {
  if (typeof attemptDir !== 'string' || !existsSync(attemptDir)) return [];
  const root = resolve(attemptDir);
  const known = new Set(['artifact.json']);
  if (expectedReportName) known.add(expectedReportName);
  const out = [];
  let seen = 0;

  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH || seen >= MAX_SCAN_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= MAX_SCAN_FILES) return;
      seen += 1;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow, never accept
      if (e.isDirectory()) {
        if (e.name === '.lock') continue;
        // §12: never descend a directory symlink/junction/reparse point.
        try {
          if (lstatSync(abs).isSymbolicLink()) continue;
          if (!isWithinReal(root, abs)) continue;
        } catch { continue; }
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.md$/i.test(e.name)) continue;
      if (e.name.endsWith('.executive.log')) continue;
      if (dir === root && known.has(e.name)) continue;
      // P20.3R R8/§12: platform-aware containment + real regular-file re-check;
      // and the REAL path must still land inside the attempt (no reparse escape).
      if (!isWithin(root, abs)) continue;
      let ls;
      try { ls = lstatSync(abs); } catch { continue; }
      if (ls.isSymbolicLink() || !ls.isFile()) continue;
      if (process.platform !== 'win32' && Number.isInteger(ls.nlink) && ls.nlink > 1) continue; // unsafe hardlink
      if (ls.size > maxReportBytes) continue;
      try { if (!isWithinReal(root, abs)) continue; } catch { continue; } // realpath escape / unresolvable => skip
      out.push(abs);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Case A — exactly one misplaced candidate is COPIED (never destructively
 * moved) to the app-assigned expected report path. The original candidate
 * is preserved as forensic evidence. The copy is exclusive/no-overwrite.
 *
 * P20.3R §12: both source and target are bound to the SAME assigned attempt
 * workspace (`attemptDir`) and re-verified with the shared platform-aware
 * containment primitive — the caller having been honest is not relied on.
 *
 * @returns {{ source: string, target: string }}
 */
export function relocateMisplacedReport({ candidatePath, expectedReportPath, attemptDir }) {
  if (typeof candidatePath !== 'string' || !existsSync(candidatePath)) {
    throw new ArtifactRepairError('candidatePath does not exist', INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { candidatePath });
  }
  if (typeof expectedReportPath !== 'string' || !expectedReportPath) {
    throw new ArtifactRepairError('expectedReportPath is required', INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED);
  }
  if (typeof attemptDir === 'string' && attemptDir) {
    if (!isWithin(attemptDir, candidatePath)) throw new ArtifactRepairError('repair candidate is outside the assigned attempt dir', INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE, { candidatePath, attemptDir });
    if (!isWithin(attemptDir, expectedReportPath)) throw new ArtifactRepairError('repair target is outside the assigned attempt dir', INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE, { expectedReportPath, attemptDir });
    try { if (!isWithinReal(attemptDir, candidatePath)) throw new Error('reparse'); }
    catch { throw new ArtifactRepairError('repair candidate resolves outside the attempt dir via a symlink/junction', INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE, { candidatePath }); }
  }
  if (existsSync(expectedReportPath)) {
    throw new ArtifactRepairError('expected report path already exists; refusing to overwrite during repair', INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { expectedReportPath });
  }
  try {
    copyFileSync(candidatePath, expectedReportPath, /* COPYFILE_EXCL */ 1);
  } catch (error) {
    throw new ArtifactRepairError(`misplaced-report copy failed: ${error.message}`, INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { candidatePath, expectedReportPath, cause: error.code ?? null });
  }
  return { source: candidatePath, target: expectedReportPath };
}

/**
 * §19 — bounded LOCAL materialization I/O retry. Only used when
 * VERBATIM_MATERIALIZATION already holds exact accepted visible bytes and
 * only the local write failed. NEVER calls a backend. NEVER loops
 * unbounded.
 *
 * @returns {{ wrote: boolean, tries: number }}
 */
export function retryLocalMaterialization({ expectedReportPath, acceptedVisibleText, maxTries = 3 }) {
  if (typeof acceptedVisibleText !== 'string') {
    throw new ArtifactRepairError('retryLocalMaterialization needs the exact accepted visible bytes', 'ARTIFACT_LOCAL_IO_RETRY_NO_BYTES');
  }
  const buf = Buffer.from(acceptedVisibleText, 'utf8');
  let lastError = null;
  for (let i = 1; i <= Math.max(1, maxTries); i += 1) {
    if (existsSync(expectedReportPath)) return { wrote: false, tries: i - 1 }; // someone/we already wrote it
    try {
      writeFileSync(expectedReportPath, buf, { flag: 'wx' });
      return { wrote: true, tries: i };
    } catch (error) {
      lastError = error;
    }
  }
  throw new ArtifactRepairError(`local materialization I/O retry exhausted: ${lastError?.message ?? 'unknown'}`, INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { cause: lastError?.code ?? null });
}

/**
 * Classify a repair situation given the integrity failure and the
 * candidate scan. Pure — decides WHICH bounded action is permitted, the
 * caller performs it.
 *
 * @param {ArtifactIntegrityError|Error} integrityError
 * @param {string[]} candidates
 * @returns {{ case: 'A'|'B'|'C'|'NONE', action: 'RELOCATE'|'DELIVERY_REPAIR'|'NONE', candidate?: string, reason: string }}
 */
export function classifyRepair(integrityError, candidates) {
  const code = integrityError instanceof ArtifactIntegrityError ? integrityError.code : integrityError?.code;
  // R1: ONLY REPORT_MISSING and REPORT_EMPTY are artifact-delivery repair
  // triggers. EXECUTION_FAILED / TASK_CANCELLED / UNKNOWN_PROVIDER_OUTCOME /
  // hash / oversize / path / metadata failures never enter repair.
  if (code !== INTEGRITY_STATE.REPORT_MISSING && code !== INTEGRITY_STATE.REPORT_EMPTY) {
    return { case: 'NONE', action: 'NONE', reason: `integrity failure ${code ?? 'unknown'} is not an artifact-delivery repair trigger` };
  }
  // R3: REPORT_EMPTY means the OFFICIAL path is occupied by empty bytes — a
  // Case A relocation (exclusive copy) would necessarily fail, and the empty
  // attempt evidence must be preserved. Always a bounded new delivery repair.
  if (code === INTEGRITY_STATE.REPORT_EMPTY) {
    return { case: 'B', action: 'DELIVERY_REPAIR', reason: 'expected report exists but is REPORT_EMPTY; one bounded new delivery-repair attempt (do not overwrite the empty original)' };
  }
  // REPORT_MISSING: the official path is free.
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 1) return { case: 'A', action: 'RELOCATE', candidate: list[0], reason: 'exactly one plausible misplaced report' };
  if (list.length === 0) return { case: 'B', action: 'DELIVERY_REPAIR', reason: 'zero candidates; one bounded delivery repair permitted' };
  return { case: 'C', action: 'DELIVERY_REPAIR', reason: `${list.length} candidates; DSH does not guess; one bounded delivery repair permitted` };
}

/**
 * Guard against recursion: a repair attempt (one whose artifact.json has a
 * `repair_of`) may NOT itself be repaired with another delivery repair.
 */
export function assertNotAlreadyRepairAttempt(attemptMetadata) {
  if (attemptMetadata && Number.isInteger(attemptMetadata.repair_of)) {
    throw new ArtifactRepairError('this attempt is already a delivery repair; no recursive artifact repair', INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { repair_of: attemptMetadata.repair_of });
  }
}

export const REPAIR_BOUND = Object.freeze({ maxDeliveryRepairAttempts: 1, recursive: false });
