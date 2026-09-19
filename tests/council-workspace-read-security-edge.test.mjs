import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveSafeRepoPath, isWorkspacePathAllowed, listDirectoryBounded, readFileBounded,
  redactWorkspaceEvidenceContent, WorkspaceSafeReadError,
} from '../src/pm/council/workspace-safe-reader.mjs';
import { redactEvidenceSecrets, validateEvidence } from '../src/pm/council/workspace-evidence-contract.mjs';
import { buildWorkspaceEvidencePacket, WorkspaceEvidencePacketError } from '../src/pm/council/workspace-evidence-packet.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { admitCouncilWorkspaceRequirement, CouncilWorkspaceAdmissionError } from '../src/pm/council/council-workspace-admission.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-secedge-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.runtime'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'SECRET=must-not-leak\n');
  writeFileSync(join(dir, '.runtime', 'secret.txt'), 'runtime secret payload\n');
  writeFileSync(join(dir, 'credentials.json'), '{"password":"hunter2"}\n');
  writeFileSync(join(dir, 'src', 'allowed.mjs'), 'export const allowed = true;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

/** Attempts a real file symlink; returns true on success, false on any failure (permissions, unsupported, etc.) — never throws. */
function tryFileSymlink(targetAbs, linkAbs) {
  try { symlinkSync(targetAbs, linkAbs, 'file'); return true; }
  catch { return false; }
}

// =========================================================================
// §6 (patch) — HTTP Bearer credential redaction
// =========================================================================

test('1: `Bearer abcdefghijklmnop` is redacted', () => {
  const out = redactWorkspaceEvidenceContent('Bearer abcdefghijklmnop');
  assert.doesNotMatch(out, /abcdefghijklmnop/);
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('2: `Authorization: Bearer abcdefghijklmnop` is redacted', () => {
  const out = redactWorkspaceEvidenceContent('Authorization: Bearer abcdefghijklmnop');
  assert.doesNotMatch(out, /abcdefghijklmnop/);
  assert.equal(out, 'Authorization: Bearer [REDACTED]');
});

test('3: lowercase/mixed-case bearer is handled case-insensitively', () => {
  const lower = redactWorkspaceEvidenceContent('authorization = "bearer abcdefghijklmnop"');
  assert.doesNotMatch(lower, /abcdefghijklmnop/);
  assert.match(lower, /bearer \[REDACTED\]/);
  const upper = redactWorkspaceEvidenceContent('BEARER ABCDEFGHIJKLMNOP');
  assert.doesNotMatch(upper, /ABCDEFGHIJKLMNOP/);
});

test('4: a JWT-like Bearer token is redacted', () => {
  const out = redactWorkspaceEvidenceContent('Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('5: ordinary harmless prose containing "bearer" without an adjacent token-like value is not destroyed', () => {
  const prose = 'Please bring your ID; the bearer of this note may enter, and the bearer is responsible for it.';
  const out = redactWorkspaceEvidenceContent(prose);
  assert.equal(out, prose);
});

test('6/7: sha256 identity remains based on raw pre-redaction bytes, and evidence validation with the real hash still succeeds', () => {
  const dir = initFixture();
  try {
    writeFileSync(join(dir, 'src', 'auth.mjs'), 'export const header = "Authorization: Bearer abcdefghijklmnop";\n');
    const read = readFileBounded(dir, 'src/auth.mjs');
    assert.doesNotMatch(read.excerpt, /abcdefghijklmnop/);
    assert.match(read.excerpt, /Bearer \[REDACTED\]/);
    const validated = validateEvidence([{ path: 'src/auth.mjs', sha256: read.sha256, claim: 'defines an Authorization header constant' }], { repoPath: dir });
    assert.equal(validated.ok, true);
    assert.equal(validated.entries[0].hash_verified, 'MATCH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8: participant-authored evidence claim redaction delegates through the same canonical authority and also redacts Bearer credentials', () => {
  const claim = redactEvidenceSecrets('the header reads Authorization: Bearer abcdefghijklmnop');
  assert.doesNotMatch(claim, /abcdefghijklmnop/);
  assert.match(claim, /Bearer \[REDACTED\]/);
});

// =========================================================================
// §7 (patch) — realpath deny bypass via symlink/junction to an in-repo
// denied target
// =========================================================================

test('9/10/11: direct .env / .runtime/secret.txt / credentials.json remain denied (unchanged baseline)', () => {
  const dir = initFixture();
  try {
    assert.throws(() => resolveSafeRepoPath(dir, '.env'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, '.runtime/secret.txt'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
    assert.throws(() => resolveSafeRepoPath(dir, 'credentials.json'), (e) => e.code === 'WORKSPACE_READ_PATH_DENIED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12/13/14/15: an in-repo symlink alias to a denied real target is denied (WORKSPACE_READ_REALPATH_DENIED); a symlink to an ALLOWED real target remains readable', (t) => {
  const dir = initFixture();
  try {
    const links = [
      { link: 'src/env-link', target: join(dir, '.env') },
      { link: 'src/runtime-link', target: join(dir, '.runtime', 'secret.txt') },
      { link: 'src/credentials-link', target: join(dir, 'credentials.json') },
      { link: 'src/allowed-link', target: join(dir, 'src', 'allowed.mjs') },
    ];
    let allCreated = true;
    for (const { link, target } of links) {
      if (!tryFileSymlink(target, join(dir, link))) { allCreated = false; break; }
    }
    if (!allCreated) { t.skip('file symlinks are not creatable in this environment'); return; }

    assert.throws(() => resolveSafeRepoPath(dir, 'src/env-link'), (e) => e.code === 'WORKSPACE_READ_REALPATH_DENIED' && e.realRelativePath === '.env');
    assert.throws(() => resolveSafeRepoPath(dir, 'src/runtime-link'), (e) => e.code === 'WORKSPACE_READ_REALPATH_DENIED' && e.realRelativePath === '.runtime/secret.txt');
    assert.throws(() => resolveSafeRepoPath(dir, 'src/credentials-link'), (e) => e.code === 'WORKSPACE_READ_REALPATH_DENIED' && e.realRelativePath === 'credentials.json');

    // 15: an allowed in-repo symlink (real target is itself safe) remains readable.
    const allowedRead = readFileBounded(dir, 'src/allowed-link');
    assert.equal(allowedRead.exists, true);
    assert.match(allowedRead.excerpt, /allowed = true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('16: a symlink resolving OUTSIDE the project root remains denied by the pre-existing escape rule (unaffected by this patch)', (t) => {
  const dir = initFixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-ws-secedge-outside-'));
  try {
    writeFileSync(join(outsideDir, 'secret-outside.txt'), 'do not read me\n');
    const created = tryFileSymlink(join(outsideDir, 'secret-outside.txt'), join(dir, 'src', 'outside-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    assert.throws(() => resolveSafeRepoPath(dir, 'src/outside-link'), (e) => e.code === 'WORKSPACE_READ_SYMLINK_ESCAPE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('17: the evidence packet cannot include content through a denied in-repo alias', async (t) => {
  const dir = initFixture();
  try {
    const created = tryFileSymlink(join(dir, '.env'), join(dir, 'src', 'env-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    // Final closure patch (Defect B): an explicitly required path that
    // resolves to a denied real target is "unavailable" — the whole
    // explicit-manifest packet build now throws rather than silently
    // recording an `allowed:false` entry and continuing.
    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/env-link'] }),
      (e) => e instanceof WorkspaceEvidencePacketError
        && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE'
        && e.requestedPath === 'src/env-link'
        && e.reasonCode === 'WORKSPACE_READ_REALPATH_DENIED',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('18: evidence validation cannot accept a path resolving to a denied real target', (t) => {
  const dir = initFixture();
  try {
    const created = tryFileSymlink(join(dir, '.env'), join(dir, 'src', 'env-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    const result = validateEvidence([{ path: 'src/env-link', sha256: 'a'.repeat(64), claim: 'contains a secret via alias' }], { repoPath: dir });
    assert.equal(result.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('19: admission rejects a required workspace_evidence_paths entry that resolves to a denied real target', async (t) => {
  const dir = initFixture();
  try {
    const created = tryFileSymlink(join(dir, 'credentials.json'), join(dir, 'src', 'credentials-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/credentials-link'] });
    await assert.rejects(
      admitCouncilWorkspaceRequirement({ council, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) }),
      (e) => e instanceof CouncilWorkspaceAdmissionError && e.offendingPaths.includes('src/credentials-link'),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// §4 (patch) — directory listing must not surface a denied real target
// =========================================================================

test('directory listing omits a symlink alias whose real target is denied, and still lists an allowed alias', (t) => {
  const dir = initFixture();
  try {
    const created = tryFileSymlink(join(dir, '.env'), join(dir, 'src', 'env-link'))
      && tryFileSymlink(join(dir, 'src', 'allowed.mjs'), join(dir, 'src', 'allowed-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    const listing = listDirectoryBounded(dir, { maxEntries: 500, maxDepth: 3 });
    assert.equal(listing.entries.some((e) => e.path === 'src/env-link'), false, 'a denied-real-target alias must not appear in the listing');
    assert.equal(listing.entries.some((e) => e.path === '.env'), false);
    assert.equal(listing.entries.some((e) => e.path === 'src/allowed-link'), true, 'a safe alias should still be listed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// §5 (patch) — one policy authority: isWorkspacePathAllowed() agrees with
// resolveSafeRepoPath() for the realpath-deny case too.
// =========================================================================

test('isWorkspacePathAllowed() (the shared non-throwing authority) agrees with resolveSafeRepoPath() on a denied real-target alias', (t) => {
  const dir = initFixture();
  try {
    const created = tryFileSymlink(join(dir, '.env'), join(dir, 'src', 'env-link'));
    if (!created) { t.skip('file symlinks are not creatable in this environment'); return; }
    const check = isWorkspacePathAllowed(dir, 'src/env-link');
    assert.equal(check.allowed, false);
    assert.equal(check.code, 'WORKSPACE_READ_REALPATH_DENIED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
