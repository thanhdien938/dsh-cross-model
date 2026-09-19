import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveProfileCapabilities, isNativeWorkspaceReader, WORKSPACE_CAPABILITY } from '../src/pm/council/workspace-capability.mjs';
import {
  resolveSafeRepoPath, listDirectoryBounded, readFileBounded, WorkspaceSafeReadError,
  MAX_FILE_BYTES, MAX_LIST_ENTRIES,
} from '../src/pm/council/workspace-safe-reader.mjs';
import { buildWorkspaceEvidencePacket, renderWorkspaceEvidencePacketText, WorkspaceEvidencePacketError } from '../src/pm/council/workspace-evidence-packet.mjs';
import { validateEvidence, redactEvidenceSecrets, MAX_EVIDENCE_ENTRIES } from '../src/pm/council/workspace-evidence-contract.mjs';
import { admitCouncilWorkspaceRequirement, CouncilWorkspaceAdmissionError } from '../src/pm/council/council-workspace-admission.mjs';
import { normalizeCouncilSpec, WORKSPACE_REQUIREMENT } from '../src/pm/council/council-contracts.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initRepoFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-read-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(dir, 'README.md'), 'hello world\nsecond line\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, '.env'), 'SECRET=abc123\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// ---- workspace-capability.mjs -----------------------------------------

// Owner-review remediation Gap A (native secret isolation): neither
// Codex's `--sandbox read-only` nor Claude Code's `--permission-mode plan`
// denylists secret-shaped paths, so DSH no longer trusts either with
// direct access to the real project repo for a workspace-read-required
// step — every currently-registered product routes through the bounded,
// hash-verified DSH evidence packet instead. See workspace-capability.mjs's
// file header for the full rationale.
test('resolveProfileCapabilities: EVERY currently-registered product (including codex/claude-code) is TEXT_ONLY — no native secret-isolation guarantee exists yet', () => {
  for (const product of ['codex', 'claude-code', 'antigravity', 'opencode', 'grok', 'api']) {
    assert.equal(resolveProfileCapabilities({ id: `p-${product}`, product }).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY, product);
    assert.equal(isNativeWorkspaceReader({ product }), false, product);
  }
});

test('resolveProfileCapabilities: WORKSPACE_READ_NATIVE remains a defined, selectable enum value for a future proven-safe backend, but resolves for none today', () => {
  assert.equal(typeof WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE, 'string');
  const anyNative = ['codex', 'claude-code', 'antigravity', 'opencode', 'grok', 'api']
    .some((product) => resolveProfileCapabilities({ product }).workspaceCapability === WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE);
  assert.equal(anyNative, false);
});

test('resolveProfileCapabilities: never inferred from a profile id/display name — only from .product', () => {
  const fakeNative = { id: 'live1-codex-looking-but-actually-api', product: 'api' };
  assert.equal(resolveProfileCapabilities(fakeNative).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY);
  const claudeNamedGemini = { id: 'my-gemini-alias', product: 'claude-code' };
  assert.equal(resolveProfileCapabilities(claudeNamedGemini).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY);
});

test('resolveProfileCapabilities: unknown/missing product fails closed to TEXT_ONLY, never WORKSPACE_MUTATE', () => {
  assert.equal(resolveProfileCapabilities({ id: 'x' }).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY);
  assert.equal(resolveProfileCapabilities(null).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY);
  assert.equal(resolveProfileCapabilities({ id: 'x', product: 'future-backend' }).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY);
});

test('resolveProfileCapabilities is a pure function of product (restart cannot silently grant a different capability)', () => {
  const a = resolveProfileCapabilities({ id: 'p1', product: 'codex' });
  const b = resolveProfileCapabilities({ id: 'p1', product: 'codex' });
  assert.deepEqual(a, b);
});

// ---- workspace-safe-reader.mjs -----------------------------------------

test('resolveSafeRepoPath refuses `..` escape from the project root', () => {
  const dir = initRepoFixture();
  try {
    assert.throws(() => resolveSafeRepoPath(dir, '../outside.txt'), WorkspaceSafeReadError);
    assert.throws(() => resolveSafeRepoPath(dir, '..\\..\\outside.txt'), WorkspaceSafeReadError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSafeRepoPath refuses an absolute/drive-letter path', () => {
  const dir = initRepoFixture();
  try {
    assert.throws(() => resolveSafeRepoPath(dir, 'C:\\Windows\\system.ini'), WorkspaceSafeReadError);
    assert.throws(() => resolveSafeRepoPath(dir, '/etc/passwd'), WorkspaceSafeReadError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSafeRepoPath refuses a symlink/junction that resolves outside the project root', () => {
  const dir = initRepoFixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-ws-outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'do not read me');
  const linkPath = join(dir, 'escape-link');
  try {
    try {
      symlinkSync(outsideDir, linkPath, 'junction');
    } catch {
      // Symlink/junction creation can require elevated privileges in some
      // CI/sandbox environments — this is a genuine environmental
      // limitation, not a reason to skip the safety assertion when it DID
      // succeed (below); when it fails to even create, there is nothing
      // further to assert.
      return;
    }
    assert.throws(() => resolveSafeRepoPath(dir, 'escape-link/secret.txt'), WorkspaceSafeReadError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('resolveSafeRepoPath denies known secret/credential-shaped paths, including .env', () => {
  const dir = initRepoFixture();
  try {
    assert.throws(() => resolveSafeRepoPath(dir, '.env'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, '.ssh/id_rsa'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, 'config/credentials.json'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, 'secrets.yaml'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, 'server.pem'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readFileBounded reads a real in-root fixture and hashes exactly what it read', () => {
  const dir = initRepoFixture();
  try {
    const result = readFileBounded(dir, 'README.md');
    assert.equal(result.exists, true);
    assert.equal(typeof result.sha256, 'string');
    assert.equal(result.sha256.length, 64);
    assert.equal(result.excerpt.includes('hello world'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readFileBounded enforces a bounded read size', () => {
  const dir = initRepoFixture();
  try {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 5000));
    const result = readFileBounded(dir, 'big.txt', { maxBytes: 1000 });
    assert.equal(result.truncated, true);
    assert.equal(result.bytesRead, 1000);
    assert.ok(result.bytes > 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listDirectoryBounded enforces a bounded entry count and never descends into .git/node_modules', () => {
  const dir = initRepoFixture();
  try {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(dir, `file-${i}.txt`), 'x');
    const listing = listDirectoryBounded(dir, { maxEntries: 5 });
    assert.equal(listing.entries.length <= 5, true);
    assert.equal(listing.truncated, true);
    const full = listDirectoryBounded(dir, { maxEntries: MAX_LIST_ENTRIES });
    assert.equal(full.entries.some((e) => e.path.startsWith('.git')), false);
    assert.equal(full.entries.some((e) => e.path === '.env'), false, '.env must never appear in a directory listing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- workspace-evidence-packet.mjs --------------------------------------

test('buildWorkspaceEvidencePacket produces bounded, deterministic project identity + anchor files, never .env', async () => {
  const dir = initRepoFixture();
  try {
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'proj-x', repo_path: dir } });
    assert.equal(packet.project.id, 'proj-x');
    assert.equal(packet.project.branch, 'main');
    assert.equal(typeof packet.project.head_commit_sha, 'string');
    assert.equal(packet.files.some((f) => f.path === 'README.md'), true);
    assert.equal(packet.files.some((f) => f.path === '.env'), false);
    assert.equal(packet.directory_listing.some((e) => e.path === '.env'), false);
    const text = renderWorkspaceEvidencePacketText(packet);
    assert.match(text, /README\.md/);
    assert.doesNotMatch(text, /SECRET=abc123/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildWorkspaceEvidencePacket fails closed for a non-git-repo project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-nongit-'));
  try {
    await assert.rejects(buildWorkspaceEvidencePacket({ project: { id: 'x', repo_path: dir } }), WorkspaceEvidencePacketError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- workspace-evidence-contract.mjs -------------------------------------

test('validateEvidence rejects a missing/empty evidence array (T5\'s exact failure mode)', () => {
  assert.equal(validateEvidence(undefined).ok, false);
  assert.equal(validateEvidence([]).ok, false);
  assert.equal(validateEvidence(null).reason, 'MISSING_EVIDENCE');
});

test('validateEvidence rejects malformed entries (missing path/sha256/claim, bad shape)', () => {
  assert.equal(validateEvidence([{ path: 'README.md' }]).ok, false); // no sha256/claim
  assert.equal(validateEvidence(['not-an-object']).ok, false);
  assert.equal(validateEvidence([{ path: 'README.md', sha256: 'not-hex', claim: 'x' }]).ok, false);
});

test('validateEvidence rejects a path that escapes the project root (../ or absolute)', () => {
  const r1 = validateEvidence([{ path: '../secret.txt', sha256: 'a'.repeat(64), claim: 'x' }]);
  assert.equal(r1.ok, false);
  const r2 = validateEvidence([{ path: '/etc/passwd', sha256: 'a'.repeat(64), claim: 'x' }]);
  assert.equal(r2.ok, false);
});

test('validateEvidence enforces a bounded entry count', () => {
  const many = Array.from({ length: MAX_EVIDENCE_ENTRIES + 1 }, (_, i) => ({ path: `f${i}.txt`, sha256: 'a'.repeat(64), claim: 'x' }));
  const r = validateEvidence(many);
  assert.equal(r.ok, false);
  assert.match(r.reason, /TOO_MANY_EVIDENCE_ENTRIES/);
});

test('validateEvidence verifies the real sha256 against disk and rejects a hash mismatch', () => {
  const dir = initRepoFixture();
  try {
    const real = readFileBounded(dir, 'README.md');
    const ok = validateEvidence([{ path: 'README.md', sha256: real.sha256, claim: 'says hello world' }], { repoPath: dir });
    assert.equal(ok.ok, true);
    assert.equal(ok.entries[0].hash_verified, 'MATCH');
    const mismatched = validateEvidence([{ path: 'README.md', sha256: 'f'.repeat(64), claim: 'says hello world' }], { repoPath: dir });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateEvidence refuses evidence citing a deny-listed/secret path even with a correct-looking hash', () => {
  const dir = initRepoFixture();
  try {
    const r = validateEvidence([{ path: '.env', sha256: 'a'.repeat(64), claim: 'contains a secret' }], { repoPath: dir });
    assert.equal(r.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('redactEvidenceSecrets strips secret-shaped substrings from a claim before it is ever persisted', () => {
  const redacted = redactEvidenceSecrets('token is ghp_abcdefghijklmnopqrstuvwxyz123456');
  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9]{20,}/);
  assert.match(redacted, /\[REDACTED\]/);
});

// ---- council-contracts.mjs workspace_requirement -------------------------

test('normalizeCouncilSpec defaults workspace_requirement to NONE (byte-for-byte pre-existing behavior)', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'] });
  assert.equal(spec.workspace_requirement, WORKSPACE_REQUIREMENT.NONE);
});

test('normalizeCouncilSpec accepts workspace_requirement:READ and rejects an invalid value', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  assert.equal(spec.workspace_requirement, 'READ');
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'MAYBE' }), (e) => e.code === 'COUNCIL_INVALID_WORKSPACE_REQUIREMENT');
});

test('workspace_requirement survives a durable JSON round-trip (restart/resume preservation)', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], workspace_requirement: 'READ' });
  const roundTripped = JSON.parse(JSON.stringify({ council: spec }));
  assert.equal(roundTripped.council.workspace_requirement, 'READ');
});

// ---- council-workspace-admission.mjs ------------------------------------

function resolverFor(map) { return (id) => map[id]; }

test('admission is a no-op for workspace_requirement:NONE (every pre-existing council)', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'] });
  const result = await admitCouncilWorkspaceRequirement({ council, project: null, resolveProfile: () => undefined });
  assert.equal(result.admitted, true);
  assert.equal(result.reason, 'NOT_REQUIRED');
});

// Gap A remediation: with today's real product catalogue, codex/claude-code
// are TEXT_ONLY (no proven secret isolation), so a READ council using them
// ALWAYS needs the evidence-packet route — the ALL_NATIVE admission
// shortcut is unreachable for any currently-registered product (it remains
// correct/dead code, ready for a future proven-safe native backend).
test('admission requires an inspectable project for a READ council even when every participant is codex/claude-code (no product is native post-Gap-A)', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  const profiles = { chair: { id: 'chair', product: 'claude-code' }, p1: { id: 'p1', product: 'codex' } };
  await assert.rejects(
    admitCouncilWorkspaceRequirement({ council, project: null, resolveProfile: resolverFor(profiles) }),
    (e) => e instanceof CouncilWorkspaceAdmissionError && e.reasonCode === 'PROJECT_REPO_PATH_MISSING',
  );
  const dir = initRepoFixture();
  try {
    const result = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: resolverFor(profiles) });
    assert.equal(result.admitted, true);
    assert.equal(result.reason, 'EVIDENCE_PACKET_FEASIBLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('admission REJECTS a READ council with a non-native (evidence-route) profile when the project has no repo_path', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  const profiles = { chair: { id: 'chair', product: 'claude-code' }, p1: { id: 'p1', product: 'api' } };
  await assert.rejects(
    admitCouncilWorkspaceRequirement({ council, project: {}, resolveProfile: resolverFor(profiles) }),
    (e) => e instanceof CouncilWorkspaceAdmissionError && e.code === 'COUNCIL_WORKSPACE_READ_UNAVAILABLE' && e.offendingProfileIds.includes('p1'),
  );
});

test('admission REJECTS a READ council with a non-native profile when the project is not an inspectable git repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-nongit2-'));
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
    const profiles = { chair: { id: 'chair', product: 'codex' }, p1: { id: 'p1', product: 'antigravity' } };
    await assert.rejects(
      admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: resolverFor(profiles) }),
      (e) => e instanceof CouncilWorkspaceAdmissionError && e.reasonCode === 'PROJECT_NOT_INSPECTABLE',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('admission ADMITS a READ council with an evidence-route profile (antigravity/opencode/grok/api) when the project IS an inspectable git repo — text-only profiles are never rejected outright once the evidence packet is feasible', async () => {
  const dir = initRepoFixture();
  try {
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], workspace_requirement: 'READ' });
    const profiles = { chair: { id: 'chair', product: 'claude-code' }, p1: { id: 'p1', product: 'api' }, p2: { id: 'p2', product: 'antigravity' } };
    const result = await admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: resolverFor(profiles) });
    assert.equal(result.admitted, true);
    assert.equal(result.reason, 'EVIDENCE_PACKET_FEASIBLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
