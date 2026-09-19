/**
 * Council/Debate WORKSPACE_READ remediation — the admission gate (docs/
 * evidence/DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §13/§17):
 * "When workspace_requirement == READ, Council admission must evaluate
 * chair and every participant... Otherwise reject before expensive
 * execution... If Debate uses Council admission, reuse the same gate."
 *
 * Called from owner-control-service.mjs's SUBMIT_TASK validation — BEFORE
 * `beginCommand()`/`tasks.submit()` — the same point every other council
 * admission check (unknown/inactive profile) already fails closed at, so a
 * council/debate that cannot satisfy its own declared workspace_requirement
 * never reaches the durable PmRun/CouncilStepWorkflowRunner machinery at
 * all (never partially starts).
 *
 * A no-op (never called meaningfully) for `workspace_requirement === NONE`
 * — every pre-existing council/debate dispatch is completely unaffected
 * (Part 21 regression requirement: legacy Council/Debate byte-for-byte
 * unchanged).
 */

import { WORKSPACE_REQUIREMENT } from './council-contracts.mjs';
import { resolveProfileCapabilities, WORKSPACE_CAPABILITY } from './workspace-capability.mjs';
import { gatherGitFactsAsync } from '../git-facts-async.mjs';
import { isWorkspacePathAllowed, readFileBounded, MAX_TOTAL_PACKET_BYTES, MAX_CHUNKS_PER_FILE } from './workspace-safe-reader.mjs';

export class CouncilWorkspaceAdmissionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CouncilWorkspaceAdmissionError';
    this.code = 'COUNCIL_WORKSPACE_READ_UNAVAILABLE';
    Object.assign(this, extra);
  }
}

/**
 * Owner-review remediation Gap B (§10, "prefer A: admission rejects if any
 * required evidence path cannot be safely supplied"). Checks EVERY
 * explicitly owner-authored `workspace_evidence_paths` entry against the
 * REAL project using the ONE shared deny/root-confinement authority
 * (workspace-safe-reader.mjs's isWorkspacePathAllowed()) plus a real
 * existence check — never trusts council-contracts.mjs's earlier pure-shape
 * validation alone (defense in depth: the project wasn't even known yet at
 * that layer). An oversized file is NOT an offense here — readFileBounded()
 * already truncates it safely (Part: "oversized... rejected OR bounded";
 * this implementation bounds, since a truncated real excerpt is still
 * genuinely safe-to-supply evidence, unlike a missing/denied/escaping path).
 *
 * Final stabilization patch (§14): a binary file cannot be safely
 * represented as workspace evidence (workspace-safe-reader.mjs's
 * `readFileBounded()` never produces textual chunks for one) — an
 * explicitly required binary path is therefore also offending, fail-closed,
 * rather than silently admitted with no real content.
 *
 * Final closure patch (Defect C): a required file whose bounded, redacted
 * text needed MORE chunks than `MAX_CHUNKS_PER_FILE` (`chunkLimited`) is
 * tracked SEPARATELY from the other offending cases — it gets its own
 * typed rejection (`COUNCIL_WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED`)
 * rather than the generic "unavailable" one, since it is neither missing
 * nor denied, just too large for the chunk-count bound specifically. A
 * file merely truncated by `MAX_FILE_BYTES` (the byte-level bound) is NOT
 * an offense here — unchanged from before this closure.
 *
 * @returns {{ offendingPaths: string[], chunkLimitedPaths: string[], requiredBytes: number }}
 *   repo-relative paths (never absolute, never file content) — both empty
 *   when every manifest entry is safely, fully supplied — plus the total
 *   bounded bytes every SAFE, non-chunk-limited entry would need in the
 *   packet (used by the §7 budget check below).
 */
function offendingEvidencePaths(evidencePaths, projectRepoPath, { maxChunks = MAX_CHUNKS_PER_FILE } = {}) {
  const offending = [];
  const chunkLimited = [];
  let requiredBytes = 0;
  for (const path of evidencePaths) {
    const check = isWorkspacePathAllowed(projectRepoPath, path);
    if (!check.allowed) { offending.push(path); continue; }
    let read;
    // `maxChunks` defaults to the real production MAX_CHUNKS_PER_FILE bound
    // — it is a test-only DI seam (closure patch TEST C1) so a narrow test
    // can force `chunkLimited: true` deterministically without a giant
    // artificial fixture; production callers never override it.
    try { read = readFileBounded(projectRepoPath, path, { maxChunks }); } catch { read = { exists: false }; }
    if (!read.exists || read.notAFile) { offending.push(path); continue; }
    if (read.binary) { offending.push(path); continue; }
    if (read.chunkLimited) { chunkLimited.push(path); continue; }
    requiredBytes += read.bytesRead ?? 0;
  }
  return { offendingPaths: offending, chunkLimitedPaths: chunkLimited, requiredBytes };
}

/**
 * @param {object} council - a normalizeCouncilSpec() result (already
 *   validated: chair/participants are known, registered profile ids).
 * @param {{ repo_path?: string }} project
 * @param {(profileId: string) => object|undefined} resolveProfile - looks
 *   up a registered PM profile by id (e.g. `pmProfiles.get`).
 * @param {Function} [gitFacts] - DI seam for tests; defaults to the real
 *   async git probe (git-facts-async.mjs — reused, never duplicated).
 * @throws {CouncilWorkspaceAdmissionError} typed, human-readable, carries
 *   `offendingProfileIds` and/or `offendingPaths` (never file content).
 */
export async function admitCouncilWorkspaceRequirement({ council, project, resolveProfile, gitFacts = gatherGitFactsAsync, maxChunks = MAX_CHUNKS_PER_FILE } = {}) {
  if (!council || council.workspace_requirement !== WORKSPACE_REQUIREMENT.READ) return { admitted: true, reason: 'NOT_REQUIRED' };

  const allProfileIds = [council.chair_profile_id, ...council.participant_profile_ids];
  const capabilities = allProfileIds.map((id) => ({ profileId: id, ...resolveProfileCapabilities(resolveProfile(id)) }));
  const nonNative = capabilities.filter((c) => c.workspaceCapability !== WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE);

  // Gap A remediation: no currently-registered backend product resolves to
  // WORKSPACE_READ_NATIVE (workspace-capability.mjs) — every participant
  // routes through DSH's own evidence packet, so this branch is
  // structurally unreachable with today's product catalogue. It is kept
  // (not deleted) so a future proven-safe native backend is admitted
  // correctly the moment workspace-capability.mjs re-admits it, without
  // this gate needing a second change.
  const needsProject = nonNative.length > 0 || Boolean(council.workspace_evidence_paths);
  if (!needsProject) return { admitted: true, reason: 'ALL_NATIVE', capabilities };

  if (!project || typeof project.repo_path !== 'string' || !project.repo_path.trim()) {
    throw new CouncilWorkspaceAdmissionError(
      'workspace_requirement=READ requires an evidence packet for one or more selected profiles, but this project has no repo_path',
      { offendingProfileIds: nonNative.map((c) => c.profileId), reasonCode: 'PROJECT_REPO_PATH_MISSING' },
    );
  }
  let facts;
  try { facts = await gitFacts(project.repo_path); } catch { facts = { isGitRepo: false }; }
  if (!facts.isGitRepo) {
    throw new CouncilWorkspaceAdmissionError(
      'workspace_requirement=READ requires an evidence packet for one or more selected profiles, but the project is not an inspectable git repository',
      { offendingProfileIds: nonNative.map((c) => c.profileId), reasonCode: 'PROJECT_NOT_INSPECTABLE' },
    );
  }

  // Gap B remediation: an explicit owner-authored manifest is a hard
  // admission requirement, not an optional hint — every listed path must
  // be safely readable from THIS project before the (expensive) council
  // ever starts.
  if (council.workspace_evidence_paths) {
    const { offendingPaths, chunkLimitedPaths, requiredBytes } = offendingEvidencePaths(council.workspace_evidence_paths, project.repo_path, { maxChunks });
    if (offendingPaths.length) {
      throw new CouncilWorkspaceAdmissionError(
        'workspace_evidence_paths lists one or more paths that cannot be safely supplied (missing, escaping the project root, deny-listed, or binary)',
        { code: 'COUNCIL_WORKSPACE_EVIDENCE_UNAVAILABLE', offendingPaths },
      );
    }
    // Final closure patch (Defect C): a required file whose bounded text
    // needs more chunks than MAX_CHUNKS_PER_FILE cannot be fully
    // represented — fail closed rather than silently marking it partial
    // for an explicit owner requirement.
    if (chunkLimitedPaths.length) {
      throw new CouncilWorkspaceAdmissionError(
        'workspace_evidence_paths lists one or more paths that cannot be fully represented within the configured chunk-count bound',
        { code: 'COUNCIL_WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED', offendingPaths: chunkLimitedPaths },
      );
    }
    // Final stabilization patch (§7 of the brief): "For EXPLICIT owner
    // evidence paths: FULL REQUESTED EVIDENCE or FAIL, not silent partial
    // omission." Reject BEFORE the (expensive) council ever starts if the
    // manifest, in full, cannot fit the configured packet budget —
    // workspace-evidence-packet.mjs's buildManifestFiles() enforces the
    // SAME bound as a second, defense-in-depth guarantee (e.g. against
    // source drift growing a file between admission and execution).
    if (requiredBytes > MAX_TOTAL_PACKET_BYTES) {
      throw new CouncilWorkspaceAdmissionError(
        'workspace_evidence_paths cannot be fully represented within the configured packet byte budget',
        { code: 'COUNCIL_WORKSPACE_EVIDENCE_PACKET_LIMIT_EXCEEDED', requestedFileCount: council.workspace_evidence_paths.length, requiredBytesAtLeast: requiredBytes, configuredLimit: MAX_TOTAL_PACKET_BYTES },
      );
    }
  }

  return { admitted: true, reason: 'EVIDENCE_PACKET_FEASIBLE', capabilities };
}
