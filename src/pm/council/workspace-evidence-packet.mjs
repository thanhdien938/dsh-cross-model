/**
 * Council/Debate WORKSPACE_READ remediation — the DSH-owned, bounded,
 * auditable repository evidence packet for TEXT_ONLY-capability
 * participants (docs/evidence/DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_
 * 20260906.md §16/§17). The packet is built ONCE per council/debate run by
 * DSH itself (never by a model) and shared, byte-identical, with every
 * TEXT_ONLY participant/chair-step that needs it — never a per-participant
 * variant (same discipline as council-prompts.mjs's canonical debate
 * brief: "every participant will receive this exact text").
 *
 * Content is deliberately generic/deterministic, never task-text-derived
 * (Part 12: "DSH must NOT infer... from natural-language task text") — it
 * is: real git identity facts (reused from git-facts-async.mjs, never a
 * second git-probing implementation) plus a bounded top-of-repo directory
 * listing plus a fixed, small, well-known anchor-file set
 * (README.md/package.json/CLAUDE.md) that exists in most real projects and
 * is safe/generic to read for every task, never chosen per-task.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { gatherGitFactsAsync } from '../git-facts-async.mjs';
import { listDirectoryBounded, readFileBounded, isWorkspacePathAllowed, MAX_TOTAL_PACKET_BYTES, MAX_CHUNKS_PER_FILE } from './workspace-safe-reader.mjs';

export class WorkspaceEvidencePacketError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WorkspaceEvidencePacketError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Fixed, deterministic anchor-file order — never task-derived, never
// reordered based on what a participant "seems to need".
const ANCHOR_FILES = Object.freeze(['README.md', 'package.json', 'CLAUDE.md', 'AGENTS.md']);
const MAX_ANCHOR_FILES = 4;
const MAX_LIST_ENTRIES_FOR_PACKET = 200;

function runGitHead(repoPath, { timeoutMs = 3000, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try { child = spawnImpl('git', ['rev-parse', 'HEAD'], { cwd: repoPath, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolvePromise(null); return; }
    let stdout = '';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best-effort */ } finish(null); }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => { if (stdout.length < 256) stdout += String(chunk).slice(0, 256 - stdout.length); });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? stdout.trim() : null));
  });
}

function fileEntryFromRead(read) {
  return {
    path: read.path, allowed: true, exists: true, bytes: read.bytes, bytes_read: read.bytesRead, sha256: read.sha256,
    sha256_scope: read.sha256_scope, truncated: read.truncated, binary: read.binary, chunks: read.chunks,
    chunk_count: read.chunkCount, chunk_limited: read.chunkLimited, fully_visible: read.fullyVisible,
    excerpt: read.excerpt,
  };
}

/**
 * Owner-review remediation Gap B ("TEXT_ONLY evidence packet is too generic
 * for T5") — reads each explicitly owner-authored `evidencePaths` entry via
 * the SAME shared deny/root-confinement authority
 * (workspace-safe-reader.mjs's isWorkspacePathAllowed()) as every other
 * caller. A path council-workspace-admission.mjs's admission gate already
 * rejected can never reach here in the normal flow — this is defense in
 * depth, never the primary safety boundary.
 *
 * Final stabilization patch (§7) — an EXPLICIT, owner-authored manifest is
 * a hard completeness promise, not a best-effort hint: "FULL REQUESTED
 * EVIDENCE OR FAIL", never silent partial omission.
 *
 * Final closure patch (Defect B/C) — the prior implementation still
 * recorded a per-file `allowed:false`/`exists:false` entry and CONTINUED
 * for a manifest path that became unavailable AFTER admission already
 * approved it (deleted, turned into a denied symlink target, became a
 * directory, a read error, or is binary) — the packet build SUCCEEDED
 * with an incomplete result, exactly the "explicit manifest can become
 * partial after admission" defect this closure fixes. Every one of those
 * cases — plus a required file whose bounded text needed more chunks than
 * `MAX_CHUNKS_PER_FILE` (Defect C) — now THROWS
 * `WorkspaceEvidencePacketError('WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
 * | 'WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED')` instead, aborting the
 * WHOLE packet build — never a partial success for an explicit manifest.
 * `requestedPath`/`reasonCode` are the only metadata carried; never file
 * content. A file merely truncated by `MAX_FILE_BYTES` (byte-level
 * bound) is UNCHANGED — that remains an accepted, explicitly-marked-
 * partial outcome by the existing bounded-read contract (this closure
 * does not redesign `MAX_FILE_BYTES` semantics); only the CHUNK-COUNT
 * bound (`chunkLimited`) fails closed here.
 *
 * council-workspace-admission.mjs performs the SAME checks before the
 * council ever starts — this function is a second, defense-in-depth
 * guarantee (e.g. against source drift in the gap between admission and
 * execution), never the only place any of this is enforced.
 */
function requiredPathUnavailable(path, reasonCode) {
  return new WorkspaceEvidencePacketError(
    'an explicitly required workspace_evidence_paths entry cannot be safely supplied',
    'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE',
    { requestedPath: path, reasonCode },
  );
}

function buildManifestFiles(repoPath, evidencePaths, { maxChunks = MAX_CHUNKS_PER_FILE, fsImpl } = {}) {
  let totalBytes = 0;
  const files = [];
  for (const path of evidencePaths) {
    const check = isWorkspacePathAllowed(repoPath, path);
    if (!check.allowed) throw requiredPathUnavailable(path, check.code);
    let read;
    // `maxChunks`/`fsImpl` default to production values — both are
    // test-only DI seams (closure patch TEST C1/B4) so a narrow test can
    // force `chunkLimited: true`, or a genuine bounded-read I/O failure,
    // deterministically without a giant artificial fixture; production
    // callers never override either.
    try { read = readFileBounded(repoPath, path, { maxChunks, fsImpl }); }
    catch (error) { throw requiredPathUnavailable(path, error?.code ?? 'WORKSPACE_READ_ERROR'); }
    // readFileBounded() reports "not a file" (e.g. a directory) as
    // `exists:false, notAFile:true` — check notAFile FIRST so that more
    // specific reason survives instead of being masked by the generic
    // "missing" one.
    if (read.notAFile) throw requiredPathUnavailable(path, 'WORKSPACE_READ_NOT_A_FILE');
    if (!read.exists) throw requiredPathUnavailable(path, 'WORKSPACE_READ_PATH_MISSING');
    if (read.binary) throw requiredPathUnavailable(path, 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED');
    if (read.chunkLimited) {
      throw new WorkspaceEvidencePacketError(
        'an explicitly required workspace_evidence_paths entry could not be fully represented within the configured chunk-count bound',
        'WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED',
        { requestedPath: path },
      );
    }
    if (totalBytes + (read.bytesRead ?? 0) > MAX_TOTAL_PACKET_BYTES) {
      throw new WorkspaceEvidencePacketError(
        'the explicit workspace_evidence_paths manifest cannot be fully represented within the configured packet byte budget',
        'WORKSPACE_EVIDENCE_PACKET_LIMIT_EXCEEDED',
        { requestedFileCount: evidencePaths.length, requiredBytesAtLeast: totalBytes + (read.bytesRead ?? 0), configuredLimit: MAX_TOTAL_PACKET_BYTES },
      );
    }
    totalBytes += read.bytesRead ?? 0;
    files.push(fileEntryFromRead(read));
  }
  return files;
}

/**
 * @param {{ project: { id?: string, repo_path: string }, evidencePaths?: string[]|null, spawnImpl?: Function, gitFacts?: Function }} deps
 *   `evidencePaths` — the council's own `workspace_evidence_paths` (owner-
 *   authored, never task-text-derived). When present, these EXPLICIT files
 *   take priority over the generic anchor-file set (Part 9: "Explicit
 *   paths must take priority for audit usefulness") — the generic anchors
 *   are used ONLY as the fallback when no manifest was supplied, exactly
 *   the pre-Gap-B behavior. `maxChunks`/`fsImpl` are test-only DI seams
 *   (final closure patch TEST C1/B4) — both default to the real production
 *   values and are never overridden by any production caller.
 * @returns {Promise<object>} a frozen, deterministic (aside from
 *   generated_at) evidence packet. Throws WorkspaceEvidencePacketError if
 *   the project's repo_path is not usable at all (the admission gate is
 *   the caller that turns this into a typed rejection; a per-participant
 *   runtime caller instead renders the failure honestly into the prompt —
 *   see council-chair-driver.mjs's #getEvidenceText()).
 */
export async function buildWorkspaceEvidencePacket({ project, evidencePaths = null, spawnImpl = nodeSpawn, gitFacts = gatherGitFactsAsync, clock = () => new Date().toISOString(), maxChunks = MAX_CHUNKS_PER_FILE, fsImpl } = {}) {
  if (!project || typeof project.repo_path !== 'string' || !project.repo_path.trim()) {
    throw new WorkspaceEvidencePacketError('project.repo_path is required to build a workspace evidence packet', 'WORKSPACE_EVIDENCE_NO_PROJECT');
  }
  const facts = await gitFacts(project.repo_path, { spawnImpl });
  if (!facts.isGitRepo) {
    throw new WorkspaceEvidencePacketError('project repo_path is not an inspectable git repository', 'WORKSPACE_EVIDENCE_NOT_A_REPO', { repoPath: project.repo_path });
  }
  const headSha = await runGitHead(project.repo_path, { spawnImpl });

  const listing = listDirectoryBounded(project.repo_path, { maxEntries: MAX_LIST_ENTRIES_FOR_PACKET, maxDepth: 2 });

  const hasManifest = Array.isArray(evidencePaths) && evidencePaths.length > 0;
  const files = hasManifest
    ? buildManifestFiles(project.repo_path, evidencePaths, { maxChunks, fsImpl })
    : ANCHOR_FILES.slice(0, MAX_ANCHOR_FILES).reduce((acc, name) => {
        if (acc.totalBytes >= MAX_TOTAL_PACKET_BYTES) return acc;
        let read;
        try { read = readFileBounded(project.repo_path, name); } catch { return acc; }
        if (!read.exists) return acc;
        if (acc.totalBytes + (read.bytesRead ?? 0) > MAX_TOTAL_PACKET_BYTES) return acc;
        acc.totalBytes += read.bytesRead ?? 0;
        acc.files.push(fileEntryFromRead(read));
        return acc;
      }, { files: [], totalBytes: 0 }).files;

  return Object.freeze({
    // Final stabilization patch: schema_version 3 — files now carry
    // chunks/chunk_count/chunk_limited/fully_visible/sha256_scope/binary
    // in addition to every pre-existing field (additive, never removed —
    // §22 backward compatibility).
    schema_version: 3,
    generated_at: clock(),
    project: Object.freeze({
      id: project.id ?? null,
      repo_root: facts.root ?? project.repo_path,
      branch: facts.branch,
      head_commit_sha: headSha,
      dirty_count: facts.dirtyCount,
    }),
    bounds: Object.freeze({
      max_list_entries: MAX_LIST_ENTRIES_FOR_PACKET, max_list_depth: 2,
      max_anchor_files: MAX_ANCHOR_FILES, max_total_bytes: MAX_TOTAL_PACKET_BYTES,
    }),
    evidence_source: hasManifest ? 'EXPLICIT_MANIFEST' : 'GENERIC_ANCHORS',
    directory_listing: listing.entries,
    directory_listing_truncated: listing.truncated,
    files: Object.freeze(files),
    denial_policy_note: 'Secret/credential-shaped paths (.env, .ssh, private keys, DSH runtime/session state, etc.) are always excluded from this packet regardless of the requested/anchor file list above.',
  });
}

/**
 * Final stabilization patch (§18 of the brief: "evidence validation must
 * match what model saw") — the AUTHORITATIVE `path -> sha256` map for
 * every real, non-binary, non-denied file this exact packet included.
 * `council-chair-driver.mjs` threads this (never a fresh live-filesystem
 * read) into `workspace-evidence-contract.mjs`'s `validateEvidence()` for
 * `participant_report`/`debate_response` steps, so a participant's cited
 * hash is checked against what it was ACTUALLY shown, not against
 * whatever the repository happens to contain at validation time (which
 * could have drifted — see the stabilization report's source-drift
 * section). A plain object (not a Map) — durable-turn-context-safe and
 * trivially serializable.
 */
export function packetHashesByPath(packet) {
  const map = {};
  if (!packet) return map;
  for (const f of packet.files) if (f.exists === true && f.sha256) map[f.path] = f.sha256;
  return map;
}

/**
 * Final stabilization patch (§6 of the brief) — a file is `FULL_FILE_VISIBLE`
 * only when DSH read the entire real file AND every chunk needed to show
 * that whole bounded text was actually included (never merely because it
 * has SOME excerpt/chunks). Reused by both the renderer below and any
 * future caller (e.g. a T5 fixture assertion) that needs the same
 * true/false without re-deriving it from raw fields.
 */
export function isFileFullyVisible(f) {
  return f.exists === true && f.fully_visible === true;
}

/**
 * Render a packet into bounded prompt text — the SAME rendering for every
 * participant/chair stage that receives this packet (never per-stage
 * variance). Final stabilization patch (§5/§6/§10 of the brief): renders
 * EVERY chunk of a file (not just the first ~4,000 chars), with explicit
 * deterministic chunk headers and an explicit FULL/PARTIAL visibility
 * marker per file so a model can never truthfully claim to have reviewed
 * an entire file the packet itself marks partial.
 */
export function renderWorkspaceEvidencePacketText(packet) {
  if (!packet) return '(no repository evidence packet is available for this task)';
  const lines = [
    `project_id: ${packet.project.id ?? 'UNKNOWN'}`,
    `repo_root: ${packet.project.repo_root}`,
    `branch: ${packet.project.branch ?? 'UNKNOWN'}`,
    `head_commit_sha: ${packet.project.head_commit_sha ?? 'UNKNOWN'}`,
    `generated_at: ${packet.generated_at}`,
    '',
    `## Directory listing (bounded, depth<=${packet.bounds.max_list_depth}, max ${packet.bounds.max_list_entries} entries${packet.directory_listing_truncated ? ', TRUNCATED' : ''})`,
  ];
  for (const entry of packet.directory_listing) lines.push(`- ${entry.type === 'dir' ? `${entry.path}/` : `${entry.path} (${entry.bytes ?? 0} bytes)`}`);
  const usable = packet.files.filter((f) => f.exists === true && f.sha256);
  const unusable = packet.files.filter((f) => !(f.exists === true && f.sha256));
  if (packet.evidence_source === 'EXPLICIT_MANIFEST') {
    lines.push('', '## Requested evidence files (owner-authored manifest — cite these EXACT path/sha256 pairs in your evidence field)');
  } else {
    lines.push('', '## Files (generic anchors — cite these EXACT path/sha256 pairs in your evidence field)');
  }
  if (!usable.length) {
    lines.push('(no requested/anchor file is usable for this project)');
  }
  for (const f of usable) {
    if (f.binary) {
      lines.push(`### ${f.path}`, `sha256: ${f.sha256}`, `bytes: ${f.bytes}`, 'FULL_FILE_VISIBLE: NO (binary file — content not represented)', '');
      continue;
    }
    const visible = isFileFullyVisible(f);
    lines.push(
      `### ${f.path}`,
      `sha256: ${f.sha256}`,
      `sha256_scope: ${f.sha256_scope}`,
      `bytes: ${f.bytes}`,
      `bytes_read: ${f.bytes_read}`,
      `truncated_by_max_bytes: ${f.truncated ? 'YES' : 'NO'}`,
      `chunks: ${f.chunk_count}`,
      `FULL_FILE_VISIBLE: ${visible ? 'YES' : 'NO'}`,
    );
    if (!visible) {
      lines.push('NOTE: this file was NOT fully supplied — do not claim to have reviewed the entire file.');
    }
    for (const chunk of f.chunks) {
      lines.push('', `--- CHUNK ${chunk.index}/${chunk.count} [chars ${chunk.char_start}..${chunk.char_end}] ---`, '```', chunk.text, '```');
    }
    lines.push('');
  }
  if (unusable.length) {
    lines.push('## Requested files NOT available in this packet (do not cite these — do not fabricate content for them)');
    for (const f of unusable) lines.push(`- ${f.path} (${f.exists === false ? 'not found' : f.allowed === false ? `denied: ${f.reason}` : f.omitted ?? 'unavailable'})`);
  }
  return lines.join('\n');
}
