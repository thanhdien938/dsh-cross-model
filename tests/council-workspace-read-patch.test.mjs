import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec, CouncilValidationError, COUNCIL_STEP_KINDS, MAX_WORKSPACE_EVIDENCE_PATHS } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { resolveProfileCapabilities, WORKSPACE_CAPABILITY } from '../src/pm/council/workspace-capability.mjs';
import { isWorkspacePathAllowed, readFileBounded } from '../src/pm/council/workspace-safe-reader.mjs';
import { buildWorkspaceEvidencePacket, renderWorkspaceEvidencePacketText, WorkspaceEvidencePacketError } from '../src/pm/council/workspace-evidence-packet.mjs';
import { validateEvidence } from '../src/pm/council/workspace-evidence-contract.mjs';
import { admitCouncilWorkspaceRequirement, CouncilWorkspaceAdmissionError } from '../src/pm/council/council-workspace-admission.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

// The exact §16 fixture: src/a.mjs, src/deep/b.mjs, .env, .runtime/secret.txt, credentials.json.
function initDeepFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-patch-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  mkdirSync(join(dir, '.runtime'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'deep', 'b.mjs'), 'export const deepValue = "B";\n');
  writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=super-secret-value\n');
  writeFileSync(join(dir, '.runtime', 'secret.txt'), 'runtime session secret\n');
  writeFileSync(join(dir, 'credentials.json'), '{"password":"hunter2"}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function historyEntry(handoff) { return { decision: { type: 'workflow' }, outcome: { finalResult: { handoff } } }; }
function fakeProfileRegistry(map) { return { get(id) { if (!map[id]) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return map[id]; } }; }
async function withRepository(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-patch-sqlite-'));
  const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'x.db') }); await store.migrate(); await fn(new PmRepository({ store })); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

// =========================================================================
// §14 — native secret isolation / single-deny-authority matrix
// =========================================================================

test('1-4: the shared deny authority refuses .env, .runtime, credential files, and PEM/private-key material', () => {
  const dir = initDeepFixture();
  try {
    assert.equal(isWorkspacePathAllowed(dir, '.env').allowed, false);
    assert.equal(isWorkspacePathAllowed(dir, '.runtime/secret.txt').allowed, false);
    assert.equal(isWorkspacePathAllowed(dir, 'credentials.json').allowed, false);
    writeFileSync(join(dir, 'server.pem'), 'not a real key\n');
    assert.equal(isWorkspacePathAllowed(dir, 'server.pem').allowed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: ONE shared deny authority — the evidence packet builder and the evidence-contract validator both refuse the SAME denied path via isWorkspacePathAllowed()', async () => {
  const dir = initDeepFixture();
  try {
    // Packet route: final closure patch (Defect B) — an explicit manifest
    // that includes even ONE denied path is "FULL REQUESTED EVIDENCE OR
    // FAIL": the whole packet build now throws rather than silently
    // continuing with the denied path marked unusable.
    await assert.rejects(
      buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['.env', 'src/a.mjs'] }),
      (e) => e instanceof WorkspaceEvidencePacketError && e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE' && e.requestedPath === '.env',
    );
    // A manifest of ONLY the safe path still builds fine and never leaks the denied file's content.
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/a.mjs'] });
    assert.ok(packet.files.find((f) => f.path === 'src/a.mjs' && f.exists === true));
    const text = renderWorkspaceEvidencePacketText(packet);
    assert.doesNotMatch(text, /SECRET_TOKEN/);

    // Evidence-contract route: the SAME denied path is refused when a
    // participant tries to cite it, even with a plausible-looking hash.
    const result = validateEvidence([{ path: '.env', sha256: 'a'.repeat(64), claim: 'contains a secret' }], { repoPath: dir });
    assert.equal(result.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('11/17: no product resolves to NATIVE post-Gap-A — every backend, including codex/claude-code, routes workspace-read through the evidence packet', () => {
  for (const product of ['codex', 'claude-code', 'antigravity', 'opencode', 'grok', 'api']) {
    assert.equal(resolveProfileCapabilities({ product }).workspaceCapability, WORKSPACE_CAPABILITY.TEXT_ONLY, product);
  }
});

// =========================================================================
// §15 — explicit evidence manifest contract
// =========================================================================

test('13/14: workspace_evidence_paths is persisted and survives a durable JSON round-trip unchanged', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs', 'src/deep/b.mjs'] });
  assert.deepEqual(spec.workspace_evidence_paths, ['src/a.mjs', 'src/deep/b.mjs']);
  const roundTripped = JSON.parse(JSON.stringify({ council: spec }));
  assert.deepEqual(roundTripped.council.workspace_evidence_paths, ['src/a.mjs', 'src/deep/b.mjs']);
});

test('15: path order is preserved deterministically (never reordered/sorted)', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['z.mjs', 'a.mjs', 'm.mjs'] });
  assert.deepEqual(spec.workspace_evidence_paths, ['z.mjs', 'a.mjs', 'm.mjs']);
});

test('16: duplicate workspace_evidence_paths entries are rejected (fail closed, never silently deduped) — same discipline as duplicate participants', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs', 'src/a.mjs'] }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_DUPLICATE_WORKSPACE_EVIDENCE_PATH',
  );
});

test('17/18: absolute paths and ".." are rejected at normalize-time', () => {
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['/etc/passwd'] }), (e) => e.code === 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH');
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['../secret.txt'] }), (e) => e.code === 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH');
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['C:\\Windows\\system.ini'] }), (e) => e.code === 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH');
});

test('19: a shape-safe but denied path (e.g. .env) passes normalize-time shape validation but is rejected at admission time', async () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['.env'] });
  assert.deepEqual(spec.workspace_evidence_paths, ['.env']); // shape-valid — no fs access yet
  const dir = initDeepFixture();
  try {
    await assert.rejects(
      admitCouncilWorkspaceRequirement({ council: spec, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) }),
      (e) => e instanceof CouncilWorkspaceAdmissionError && e.code === 'COUNCIL_WORKSPACE_EVIDENCE_UNAVAILABLE' && e.offendingPaths.includes('.env'),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('20: too many workspace_evidence_paths is rejected', () => {
  const many = Array.from({ length: MAX_WORKSPACE_EVIDENCE_PATHS + 1 }, (_, i) => `src/f${i}.mjs`);
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: many }),
    (e) => e.code === 'COUNCIL_TOO_MANY_WORKSPACE_EVIDENCE_PATHS',
  );
});

test('21: an oversized requested file is safely bounded (truncated), never a hard failure', async () => {
  const dir = initDeepFixture();
  try {
    writeFileSync(join(dir, 'big.mjs'), 'x'.repeat(500_000));
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['big.mjs'] });
    const entry = packet.files.find((f) => f.path === 'big.mjs');
    assert.equal(entry.exists, true);
    assert.equal(entry.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('22: a missing required manifest path fails admission closed (Part 10 policy A)', async () => {
  const dir = initDeepFixture();
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/does-not-exist.mjs'] });
  try {
    await assert.rejects(
      admitCouncilWorkspaceRequirement({ council: spec, project: { repo_path: dir }, resolveProfile: () => ({ product: 'api' }) }),
      (e) => e instanceof CouncilWorkspaceAdmissionError && e.offendingPaths.includes('src/does-not-exist.mjs'),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('23/24/25: a deep source file is packetized with real hash/content — API and Antigravity receive the SAME byte-identical deep packet', async () => {
  const dir = initDeepFixture();
  try {
    const real = readFileBounded(dir, 'src/deep/b.mjs');
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/a.mjs', 'src/deep/b.mjs'] });
    const deepEntry = packet.files.find((f) => f.path === 'src/deep/b.mjs');
    assert.equal(deepEntry.exists, true);
    assert.equal(deepEntry.sha256, real.sha256);
    assert.match(deepEntry.excerpt, /deepValue/);

    // Antigravity and API are both TEXT_ONLY — both get the packet built
    // from the SAME evidencePaths, rendered identically (renderWorkspaceEvidencePacketText
    // is a pure function of the packet; no per-backend branching exists).
    const textForApi = renderWorkspaceEvidencePacketText(packet);
    const textForAntigravity = renderWorkspaceEvidencePacketText(packet);
    assert.equal(textForApi, textForAntigravity);
    assert.match(textForApi, /src\/deep\/b\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('26: a codex/claude-code-backed participant gets the identical evidence-packet route/content as an api/antigravity participant (no differential native access)', async () => withRepository(async (repository) => {
  const dir = initDeepFixture();
  try {
    const project = { id: 'proj-patch', repo_path: dir };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p_codex', 'p_api'], rounds: 1, workspace_requirement: 'READ', workspace_evidence_paths: ['src/deep/b.mjs'] });
    const profiles = fakeProfileRegistry({ chair: { id: 'chair', product: 'claude-code' }, p_codex: { id: 'p_codex', product: 'codex' }, p_api: { id: 'p_api', product: 'api' } });
    const seenPrompts = {};
    const resolveDriver = (profile) => ({
      name: `fake:${profile.id}`,
      async decide(input) {
        const { stepKind } = input.request.context;
        if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p_codex: 'audit', p_api: 'audit' }, critique_focus: 'x', synthesis_focus: 'y' } };
        if (stepKind === 'participant_report') {
          // Capture the FIRST (packet-bearing) objective only — the bounded
          // semantic repair (contract-hardening) legitimately issues a second
          // decide call for a MISSING_EVIDENCE response, and that repair
          // prompt deliberately never re-sends the packet.
          if (!seenPrompts[profile.id]) seenPrompts[profile.id] = input.request.objective;
          return { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
        }
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
        throw new Error(`unexpected ${stepKind}`);
      },
    });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
    const driver = new CouncilChairDriver({
      council, ownerTask: 'deep audit',
      resolveWorkspaceCapability: (id) => resolveProfileCapabilities(profiles.get(id)).workspaceCapability,
      loadEvidencePacket: async () => ({ text: renderWorkspaceEvidencePacketText(await buildWorkspaceEvidencePacket({ project, evidencePaths: council.workspace_evidence_paths })) }),
    });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
    const request = createPmRequest({ objective: 'deep audit', context: { council } });
    repository.create(request, { id: 'pmrun_patch_26', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
    await runtime.resume('pmrun_patch_26');

    assert.match(seenPrompts.p_codex, /src\/deep\/b\.mjs/);
    assert.match(seenPrompts.p_api, /src\/deep\/b\.mjs/);
    // Both prompts embed the identical packet text — codex gets no
    // differential/native access.
    const packetTextInCodex = seenPrompts.p_codex.split('## Requested evidence files')[1];
    const packetTextInApi = seenPrompts.p_api.split('## Requested evidence files')[1];
    assert.equal(packetTextInCodex, packetTextInApi);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('27: evidence citing a path OUTSIDE the manifest is rejected even if otherwise valid/hash-verified', () => {
  const dir = initDeepFixture();
  try {
    const real = readFileBounded(dir, 'src/a.mjs');
    const result = validateEvidence(
      [{ path: 'src/a.mjs', sha256: real.sha256, claim: 'valid but not in the manifest' }],
      { repoPath: dir, allowedPaths: new Set(['src/deep/b.mjs']) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('28: evidence INSIDE the manifest with a matching hash is accepted', () => {
  const dir = initDeepFixture();
  try {
    const real = readFileBounded(dir, 'src/deep/b.mjs');
    const result = validateEvidence(
      [{ path: 'src/deep/b.mjs', sha256: real.sha256, claim: 'exports deepValue' }],
      { repoPath: dir, allowedPaths: new Set(['src/deep/b.mjs']) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].hash_verified, 'MATCH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('29: a hash mismatch inside the manifest is still rejected', () => {
  const dir = initDeepFixture();
  try {
    const result = validateEvidence(
      [{ path: 'src/deep/b.mjs', sha256: 'f'.repeat(64), claim: 'exports deepValue' }],
      { repoPath: dir, allowedPaths: new Set(['src/deep/b.mjs']) },
    );
    assert.equal(result.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('30: workspace_evidence_paths cannot be supplied under workspace_requirement:NONE — never leaks into NONE mode', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_evidence_paths: ['src/a.mjs'] }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_WORKSPACE_EVIDENCE_PATHS_REQUIRE_READ',
  );
});

test('31/32: legacy Council/Debate (workspace_requirement:NONE, no manifest) is completely unaffected by this patch', () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], debate: { enabled: true } });
  assert.equal(council.workspace_requirement, 'NONE');
  assert.equal(council.workspace_evidence_paths, null);
});

// =========================================================================
// §16 — fixture-based integration (no live canary)
// =========================================================================

test('fixture: explicit src/deep/b.mjs is packetized; .env and .runtime/secret.txt cannot be selected; evidence hash verifies', async () => {
  const dir = initDeepFixture();
  try {
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/deep/b.mjs'] });
    const deepEntry = packet.files.find((f) => f.path === 'src/deep/b.mjs');
    assert.equal(deepEntry.exists, true);
    assert.match(deepEntry.excerpt, /deepValue/);

    assert.equal(isWorkspacePathAllowed(dir, '.env').allowed, false);
    assert.equal(isWorkspacePathAllowed(dir, '.runtime/secret.txt').allowed, false);

    const validated = validateEvidence(
      [{ path: 'src/deep/b.mjs', sha256: deepEntry.sha256, claim: 'confirms deepValue export' }],
      { repoPath: dir, allowedPaths: new Set(['src/deep/b.mjs']) },
    );
    assert.equal(validated.ok, true);
    assert.equal(validated.entries[0].hash_verified, 'MATCH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Telegram grammar ------------------------------------------------

test('parseOwnerFlags: --workspace-evidence requires --workspace-read', () => {
  assert.throws(() => parseOwnerFlags('--workspace-evidence src/a.mjs audit'), /--workspace-evidence requires --workspace-read/);
});

test('parseOwnerFlags: --workspace-evidence rejects an empty list and too many paths', () => {
  assert.throws(() => parseOwnerFlags('--workspace-read --workspace-evidence , audit'), /non-empty/);
  const many = Array.from({ length: MAX_WORKSPACE_EVIDENCE_PATHS + 1 }, (_, i) => `f${i}.mjs`).join(',');
  assert.throws(() => parseOwnerFlags(`--workspace-read --workspace-evidence ${many} audit`), /at most/);
});

test('routeTelegramUpdate: --workspace-evidence folds onto payload.council.workspace_evidence_paths', () => {
  const projects = [{ id: 'proj1' }];
  const route = routeTelegramUpdate(
    { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj1 --pm chair --debate p1,p2 --workspace-read --workspace-evidence src/a.mjs,src/deep/b.mjs audit these files' } },
    { projects, projectId: 'proj1' },
  );
  assert.equal(route.operation, 'SUBMIT_TASK');
  assert.equal(route.payload.council.workspace_requirement, 'READ');
  assert.deepEqual(route.payload.council.workspace_evidence_paths, ['src/a.mjs', 'src/deep/b.mjs']);
});

test('routeTelegramUpdate: legacy dispatch with neither flag carries no workspace_evidence_paths key (byte-for-byte unaffected)', () => {
  const projects = [{ id: 'proj1' }];
  const route = routeTelegramUpdate(
    { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj1 --pm chair --debate p1,p2 review the architecture' } },
    { projects, projectId: 'proj1' },
  );
  assert.equal('workspace_evidence_paths' in route.payload.council, false);
});
