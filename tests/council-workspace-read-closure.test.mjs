// =========================================================================
// DSH WORKSPACE_READ — final closure patch (this session's 6th and final
// pass over this branch): four narrower defects, all within the already-
// accepted architecture. NOT another broad audit — see docs/evidence/
// DSH_COUNCIL_WORKSPACE_READ_IMPLEMENTATION_20260906.md §26.
//
//  A. Packet-generation failure must NEVER fall back to live-disk evidence
//     validation — a real "READ production packet provider" result (success
//     OR failure) must produce `hashesByPath: {}`, never `null`. `null` is
//     reserved exclusively for a legacy/direct validateEvidence() caller
//     that never went through a packet provider at all.
//  B. An explicit workspace_evidence_paths manifest must fail CLOSED on any
//     post-admission drift (deleted/denied/not-a-file/unreadable) — the
//     whole packet build throws, never a partial success.
//  C. `chunkLimited` (the chunk-COUNT bound, distinct from the byte-level
//     MAX_FILE_BYTES bound) must also fail closed for an explicit manifest,
//     at both the admission layer and the packet-construction layer.
//  D. Binary detection must scan the FULL bounded read buffer, not just the
//     first ~8,192 bytes.
// =========================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, rmdirSync, statSync as realStatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readFileBounded, looksBinary, MAX_CHUNKS_PER_FILE,
} from '../src/pm/council/workspace-safe-reader.mjs';
import {
  buildWorkspaceEvidencePacket, packetHashesByPath, WorkspaceEvidencePacketError,
} from '../src/pm/council/workspace-evidence-packet.mjs';
import { validateEvidence } from '../src/pm/council/workspace-evidence-contract.mjs';
import { normalizeCouncilSpec, COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';
import { admitCouncilWorkspaceRequirement, CouncilWorkspaceAdmissionError } from '../src/pm/council/council-workspace-admission.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { WORKSPACE_CAPABILITY } from '../src/pm/council/workspace-capability.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-closure-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.env'), 'SECRET=must-not-leak\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function tryFileSymlink(targetAbs, linkAbs) {
  try { symlinkSync(targetAbs, linkAbs, 'file'); return true; }
  catch { return false; }
}

/** Fake handoff-shaped history entry — the exact shape #stepsSoFar() reads. */
function historyEntry(handoff) { return { decision: { type: 'workflow' }, outcome: { finalResult: { handoff } } }; }

// =========================================================================
// Section 6 / TEST A1-A3 — packet-failure provenance must never enable the
// live-disk fallback.
// =========================================================================

test('TEST A1: a packet-provider FAILURE produces workspaceEvidenceHashes === {} on the resulting participant_report spec, never null', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  const driver = new CouncilChairDriver({
    council, ownerTask: 'audit the repository',
    resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.TEXT_ONLY,
    loadEvidencePacket: async () => { throw new Error('packet build boom'); },
  });
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' };
  const reportDecision = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.notEqual(reportDecision.spec.workspaceEvidenceHashes, null);
  assert.deepEqual(reportDecision.spec.workspaceEvidenceHashes, {});
});

test('TEST A1b: a packet-provider SUCCESS that omits hashesByPath entirely is ALSO normalized to {}, never null (defense in depth against a malformed provider result)', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  const driver = new CouncilChairDriver({
    council, ownerTask: 'audit the repository',
    resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.TEXT_ONLY,
    loadEvidencePacket: async () => ({ text: 'some packet text, no hashesByPath field at all' }),
  });
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' };
  const reportDecision = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.notEqual(reportDecision.spec.workspaceEvidenceHashes, null);
  assert.deepEqual(reportDecision.spec.workspaceEvidenceHashes, {});
});

test('TEST A2: authoritativeHashes = {} rejects an otherwise-real, correctly-hashed, on-disk citation (PATH_NOT_IN_PACKET provenance, not live-disk coincidence)', () => {
  const dir = initFixture();
  try {
    const real = readFileBounded(dir, 'README.md');
    assert.equal(real.exists, true);
    const result = validateEvidence(
      [{ path: 'README.md', sha256: real.sha256, claim: 'contains the seed line' }],
      { repoPath: dir, authoritativeHashes: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST A3: a legacy direct validateEvidence() caller (authoritativeHashes omitted, repoPath supplied) still validates against live disk exactly as before — the closure patch does not break the pre-existing fallback', () => {
  const dir = initFixture();
  try {
    const real = readFileBounded(dir, 'README.md');
    const result = validateEvidence(
      [{ path: 'README.md', sha256: real.sha256, claim: 'contains the seed line' }],
      { repoPath: dir },
    );
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].hash_verified, 'MATCH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// Section 7 / TEST B1-B4 — post-admission explicit-manifest drift must fail
// closed at packet-construction time (defense in depth: admission already
// validated the SAME manifest against the SAME project before the council
// ever started).
// =========================================================================

test('TEST B1: a required manifest file DELETED after admission causes buildWorkspaceEvidencePacket() to throw (never a partial packet)', async () => {
  const dir = initFixture();
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'] });
    const admission = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) });
    assert.equal(admission.admitted, true);

    rmSync(join(dir, 'src', 'a.mjs'));

    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: council.workspace_evidence_paths }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
        && e.requestedPath === 'src/a.mjs'
        && e.reasonCode === 'WORKSPACE_READ_PATH_MISSING',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST B2: a required manifest path turned into a symlink to a denied real target AFTER admission causes buildWorkspaceEvidencePacket() to throw', async (t) => {
  const dir = initFixture();
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'] });
    const admission = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) });
    assert.equal(admission.admitted, true);

    rmSync(join(dir, 'src', 'a.mjs'));
    const created = tryFileSymlink(join(dir, '.env'), join(dir, 'src', 'a.mjs'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }

    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: council.workspace_evidence_paths }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
        && e.requestedPath === 'src/a.mjs'
        && e.reasonCode === 'WORKSPACE_READ_REALPATH_DENIED',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST B3: a required manifest path turned into a DIRECTORY after admission causes buildWorkspaceEvidencePacket() to throw', async () => {
  const dir = initFixture();
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'] });
    const admission = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) });
    assert.equal(admission.admitted, true);

    rmSync(join(dir, 'src', 'a.mjs'));
    mkdirSync(join(dir, 'src', 'a.mjs'));

    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: council.workspace_evidence_paths }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
        && e.requestedPath === 'src/a.mjs'
        && e.reasonCode === 'WORKSPACE_READ_NOT_A_FILE',
    );
  } finally {
    try { rmdirSync(join(dir, 'src', 'a.mjs')); } catch { /* best-effort cleanup ordering */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TEST B4: a genuine bounded-read I/O failure (not merely "missing") on a required manifest path causes buildWorkspaceEvidencePacket() to throw WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE — proven via the SAME fsImpl DI seam readFileBounded() already exposes for deterministic bounded-I/O testing (no real permission fault needed)', async () => {
  const dir = initFixture();
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'] });
    const admission = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) });
    assert.equal(admission.admitted, true);

    const failingFsImpl = {
      statSync: realStatSync,
      openSync: () => { throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }); },
      readSync: () => { throw new Error('unreachable — openSync already threw'); },
      closeSync: () => {},
    };

    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: council.workspace_evidence_paths, fsImpl: failingFsImpl }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
        && e.requestedPath === 'src/a.mjs'
        && e.reasonCode === 'EACCES',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// Section 7 / TEST C1-C2 — chunkLimited must fail closed for an explicit
// manifest, at both the admission layer and the packet-construction layer.
// =========================================================================

test('TEST C1a (admission layer): a required manifest file whose bounded text needs more chunks than the configured bound is rejected at admission, fail closed — forced via the maxChunks DI seam, not a giant artificial fixture', async () => {
  const dir = initFixture();
  try {
    // A real, small, ordinary text file — chunk-limited only because this
    // test injects an artificially tiny chunk-count bound (maxChunks: 1),
    // never because the fixture itself is huge.
    // ~5,800 chars — enough to need 2 chunks at the real MAX_EXCERPT_CHARS
    // (4,000 chars/chunk) default, so an injected maxChunks:1 genuinely
    // forces chunkLimited:true; still a tiny, ordinary text fixture, never
    // a giant one approaching MAX_FILE_BYTES.
    writeFileSync(join(dir, 'src', 'multiline.mjs'), Array.from({ length: 200 }, (_, i) => `line ${i} of this ordinary fixture file`).join('\n') + '\n');
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/multiline.mjs'] });

    // Sanity: with the real production bound this file is NOT chunk-limited.
    const admittedNormally = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) });
    assert.equal(admittedNormally.admitted, true);

    await assert.rejects(
      admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }), maxChunks: 1 }),
      (e) => e instanceof CouncilWorkspaceAdmissionError
        && e.code === 'COUNCIL_WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED'
        && e.offendingPaths.includes('src/multiline.mjs'),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST C1b (packet-construction layer): the SAME chunk-limited required file also fails closed at buildWorkspaceEvidencePacket() time, defense in depth — forced via the same maxChunks DI seam', async () => {
  const dir = initFixture();
  try {
    // ~5,800 chars — enough to need 2 chunks at the real MAX_EXCERPT_CHARS
    // (4,000 chars/chunk) default, so an injected maxChunks:1 genuinely
    // forces chunkLimited:true; still a tiny, ordinary text fixture, never
    // a giant one approaching MAX_FILE_BYTES.
    writeFileSync(join(dir, 'src', 'multiline.mjs'), Array.from({ length: 200 }, (_, i) => `line ${i} of this ordinary fixture file`).join('\n') + '\n');
    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/multiline.mjs'], maxChunks: 1 }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_CHUNK_LIMIT_EXCEEDED'
        && e.requestedPath === 'src/multiline.mjs',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST C2: the generic/anchor fallback mode (no explicit manifest) is UNCHANGED by this closure — it remains best-effort and never claims explicit completeness for a chunk-limited candidate', async () => {
  const dir = initFixture();
  writeFileSync(join(dir, 'README.md'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
  try {
    // Generic mode never accepts maxChunks/fsImpl overrides at all (no
    // evidencePaths manifest — the anchor-file reduce() path is untouched
    // by this closure) — it always builds successfully with whatever it
    // can safely include, exactly the pre-existing, still-accepted
    // best-effort contract for non-explicit evidence.
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir } });
    assert.equal(packet.evidence_source, 'GENERIC_ANCHORS');
    assert.ok(packet.files.find((f) => f.path === 'README.md' && f.exists === true));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// Section 7 / TEST D1-D2 — binary detection must scan the FULL bounded
// buffer, not just the first ~8,192 bytes.
// =========================================================================

test('TEST D1: a bounded file whose first 9,000 bytes are clean text but a LATER byte (within the same bounded read) is NUL is still classified binary — the full bounded buffer is scanned, not just the first 8,192 bytes', () => {
  const clean = Buffer.alloc(9000, 0x61); // 9000 'a' bytes — no NUL anywhere in the old 8192-byte scan window
  const withLateNul = Buffer.concat([clean, Buffer.from([0x00]), Buffer.alloc(500, 0x62)]);
  assert.equal(looksBinary(withLateNul), true);

  const dir = initFixture();
  try {
    writeFileSync(join(dir, 'src', 'late-nul.bin'), withLateNul);
    const read = readFileBounded(dir, 'src/late-nul.bin');
    assert.equal(read.binary, true);
    assert.equal(read.fullyVisible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TEST D2: a normal long UTF-8 text file (>8,192 bytes, no NUL anywhere) remains classified as text, never binary — the wider scan introduces no false positive', () => {
  const longText = Buffer.from(Array.from({ length: 3000 }, (_, i) => `line ${i} — some unicode: café, ✓, 中文`).join('\n'), 'utf8');
  assert.ok(longText.length > 8192, 'fixture must exceed the old 8192-byte scan window');
  assert.equal(looksBinary(longText), false);

  const dir = initFixture();
  try {
    writeFileSync(join(dir, 'src', 'long-clean.mjs'), longText);
    const read = readFileBounded(dir, 'src/long-clean.mjs');
    assert.equal(read.binary, false);
    assert.equal(read.exists, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
