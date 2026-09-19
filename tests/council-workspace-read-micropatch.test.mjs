import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec, COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { resolveProfileCapabilities } from '../src/pm/council/workspace-capability.mjs';
import {
  readFileBounded, MAX_FILE_BYTES, isWorkspacePathAllowed, redactWorkspaceEvidenceContent,
} from '../src/pm/council/workspace-safe-reader.mjs';
import { buildWorkspaceEvidencePacket, renderWorkspaceEvidencePacketText, packetHashesByPath } from '../src/pm/council/workspace-evidence-packet.mjs';
import { validateEvidence } from '../src/pm/council/workspace-evidence-contract.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-micro-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function fakeProfileRegistry(map) { return { get(id) { if (!map[id]) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return map[id]; } }; }
async function withRepository(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-micro-sqlite-'));
  const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'x.db') }); await store.migrate(); await fn(new PmRepository({ store })); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

// Rather than reverse-engineer packet boundaries out of an assembled
// prompt string (fragile — each builder wraps the packet in different
// surrounding prose/sections), the tests below capture the actual
// `evidencePacketText` string returned by the driver's `loadEvidencePacket`
// DI seam (the SAME object #getEvidenceText() caches and hands to every
// stage) and assert each stage's full prompt CONTAINS that exact
// substring, unaltered — a direct, robust proof of the "byte-identical
// everywhere" invariant that does not depend on any builder's prose shape.

// =========================================================================
// §8 (patch) — chair packet propagation across all seven READ-required
// repository-reasoning stages, in one real Council+Debate run.
// =========================================================================

test('READ Council+Debate: every repository-reasoning stage (chair_plan, participant_report, participant_critique, chair_synthesis, debate_brief, debate_response, debate_synthesis) receives the SAME cached, byte-identical evidence packet; loadEvidencePacket is invoked exactly once', async () => withRepository(async (repository) => {
  const dir = initFixture();
  try {
    const project = { id: 'proj-micro', repo_path: dir };
    const council = normalizeCouncilSpec({
      chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 2,
      workspace_requirement: 'READ', workspace_evidence_paths: ['src/a.mjs'], debate: { enabled: true, max_rounds: 1 },
    });
    const profiles = fakeProfileRegistry({ chair: { id: 'chair', product: 'claude-code' }, p1: { id: 'p1', product: 'api' } });
    const capturedPrompts = {};
    const resolveDriver = (profile) => ({
      name: `fake:${profile.id}`,
      async decide(input) {
        const { stepKind } = input.request.context;
        capturedPrompts[stepKind] = input.request.objective;
        if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'audit' }, critique_focus: 'x', synthesis_focus: 'y' } };
        if (stepKind === 'participant_report') return { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [], evidence: [{ path: 'src/a.mjs', sha256: readFileBounded(dir, 'src/a.mjs').sha256, claim: 'exports a' }] } };
        if (stepKind === 'participant_critique') return { type: 'finish', output: 'ok', data: { type: 'council_critique', criticisms: [], agreements: [], revised_recommendation: 'r', remaining_disagreements: [] } };
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
        if (stepKind === 'debate_brief') return { type: 'finish', output: 'brief', data: { type: 'debate_brief', brief: 'b' } };
        if (stepKind === 'debate_response') return { type: 'finish', output: 'ok', data: { type: 'debate_response', response: 'r', evidence: [{ path: 'src/a.mjs', sha256: readFileBounded(dir, 'src/a.mjs').sha256, claim: 'exports a' }] } };
        if (stepKind === 'debate_synthesis') return { type: 'finish', output: 'FINAL', data: { type: 'debate_synthesis', continue_debate: false, reason: 'done', unresolved_questions: [] } };
        throw new Error(`unexpected ${stepKind}`);
      },
    });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
    let packetBuilds = 0;
    let knownPacketText = null;
    const driver = new CouncilChairDriver({
      council, ownerTask: 'audit the repository',
      resolveWorkspaceCapability: (id) => resolveProfileCapabilities(profiles.get(id)).workspaceCapability,
      loadEvidencePacket: async () => {
        packetBuilds += 1;
        const packet = await buildWorkspaceEvidencePacket({ project, evidencePaths: council.workspace_evidence_paths });
        knownPacketText = renderWorkspaceEvidencePacketText(packet);
        return { text: knownPacketText, hashesByPath: packetHashesByPath(packet) };
      },
    });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 32 });
    const request = createPmRequest({ objective: 'audit the repository', context: { council } });
    repository.create(request, { id: 'pmrun_micro', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
    const result = await runtime.resume('pmrun_micro');
    assert.equal(result.status, 'completed');

    const stageKinds = ['chair_plan', 'participant_report', 'participant_critique', 'chair_synthesis', 'debate_brief', 'debate_response', 'debate_synthesis'];
    for (const kind of stageKinds) assert.ok(capturedPrompts[kind], `${kind} was never dispatched`);

    assert.ok(knownPacketText, 'the packet was never built');
    for (const kind of stageKinds) {
      assert.ok(capturedPrompts[kind].includes(knownPacketText), `${kind}'s prompt does not contain the exact, byte-identical evidence packet text`);
    }

    // Item 9: exactly one real packet build for the whole run, despite 7
    // distinct stages each independently requesting it.
    assert.equal(packetBuilds, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('NONE mode: chair_plan and chair_synthesis prompts never embed a packet section, even when a packet provider is configured', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'] });
  let packetCalls = 0;
  const driver = new CouncilChairDriver({
    council, ownerTask: 'ordinary task',
    loadEvidencePacket: async () => { packetCalls += 1; return { text: 'SHOULD NEVER APPEAR' }; },
  });
  const planDecision = await driver.decide({ turn: 0, history: [] });
  assert.doesNotMatch(planDecision.spec.prompt, /Repository evidence packet/);
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' };
  const reportHandoff = { stepKind: COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, participantProfileId: 'p1', ok: true, analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] };
  const synthesisDecision = await driver.decide({ turn: 2, history: [{ decision: { type: 'workflow' }, outcome: { finalResult: { handoff: planHandoff } } }, { decision: { type: 'workflow' }, outcome: { finalResult: { handoff: reportHandoff } } }] });
  assert.doesNotMatch(synthesisDecision.spec.prompt, /Repository evidence packet/);
  assert.equal(packetCalls, 0);
});

test('legacy Council NONE regression: full run unaffected by the chair-packet-propagation change', async () => withRepository(async (repository) => {
  const project = { id: 'proj-legacy', repo_path: '/tmp/unused-for-none-mode' };
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  const profiles = fakeProfileRegistry({ chair: { id: 'chair' }, p1: { id: 'p1' } });
  const resolveDriver = (profile) => ({
    name: `fake:${profile.id}`,
    async decide(input) {
      const { stepKind } = input.request.context;
      if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' } };
      if (stepKind === 'participant_report') return { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
      throw new Error(`unexpected ${stepKind}`);
    },
  });
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
  const driver = new CouncilChairDriver({ council, ownerTask: 'ordinary task' });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'ordinary task', context: { council } });
  repository.create(request, { id: 'pmrun_legacy_council', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_legacy_council');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'SYNTHESIS');
}));

test('legacy Debate NONE regression: full run unaffected by the chair-packet-propagation change', async () => withRepository(async (repository) => {
  const project = { id: 'proj-legacy', repo_path: '/tmp/unused-for-none-mode' };
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const profiles = fakeProfileRegistry({ chair: { id: 'chair' }, p1: { id: 'p1' } });
  const resolveDriver = (profile) => ({
    name: `fake:${profile.id}`,
    async decide(input) {
      const { stepKind } = input.request.context;
      if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' } };
      if (stepKind === 'participant_report') return { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
      if (stepKind === 'debate_brief') return { type: 'finish', output: 'brief', data: { type: 'debate_brief', brief: 'b' } };
      if (stepKind === 'debate_response') return { type: 'finish', output: 'ok', data: { type: 'debate_response', response: 'r' } };
      if (stepKind === 'debate_synthesis') return { type: 'finish', output: 'FINAL', data: { type: 'debate_synthesis', continue_debate: false, reason: 'done', unresolved_questions: [] } };
      throw new Error(`unexpected ${stepKind}`);
    },
  });
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
  const driver = new CouncilChairDriver({ council, ownerTask: 'ordinary task' });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'ordinary task', context: { council } });
  repository.create(request, { id: 'pmrun_legacy_debate', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_legacy_debate');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'FINAL');
  assert.equal(result.data.type, 'council_debate');
}));

// =========================================================================
// §9 (patch) — true bounded I/O
// =========================================================================

test('14/16: readFileBounded never asks the underlying primitive to read more than maxBytes, even when stat reports a huge fake size, and the allocated buffer is bounded', () => {
  const dir = initFixture();
  try {
    let seenLength = null;
    let seenBufferLength = null;
    const fsImpl = {
      statSync: () => ({ isFile: () => true, size: 5_000_000_000 }), // 5GB fake size — never allocated/read
      openSync: () => 42,
      readSync: (fd, buffer, offset, length) => { seenLength = length; seenBufferLength = buffer.length; buffer.write('x'.repeat(length)); return length; },
      closeSync: () => {},
    };
    const result = readFileBounded(dir, 'README.md', { maxBytes: 1000, fsImpl });
    assert.equal(seenLength, 1000, 'readSync must never be asked for more than maxBytes, regardless of the real/fake file size');
    assert.equal(seenBufferLength, 1000, 'the allocated buffer must be bounded to maxBytes, never the full (fake, huge) file size');
    assert.equal(result.bytes, 5_000_000_000);
    assert.equal(result.bytesRead, 1000);
    assert.equal(result.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('15/17/20/21: real oversized/small/missing fixtures behave correctly with the refactored bounded reader', () => {
  const dir = initFixture();
  try {
    writeFileSync(join(dir, 'big.txt'), 'y'.repeat(MAX_FILE_BYTES + 12_345));
    const big = readFileBounded(dir, 'big.txt', { maxBytes: 2000 });
    assert.equal(big.bytes, MAX_FILE_BYTES + 12_345);
    assert.equal(big.bytesRead, 2000);
    assert.equal(big.truncated, true);
    assert.equal(big.excerpt.startsWith('y'.repeat(100)), true, 'excerpt derives only from the bytes actually read');

    const small = readFileBounded(dir, 'README.md');
    assert.equal(small.exists, true);
    assert.equal(small.truncated, false);

    const missing = readFileBounded(dir, 'does-not-exist.txt');
    assert.equal(missing.exists, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('18/19: the file descriptor is always closed, including when the read itself throws', () => {
  const dir = initFixture();
  let closeCalls = 0;
  const throwingFsImpl = {
    statSync: () => ({ isFile: () => true, size: 100 }),
    openSync: () => 7,
    readSync: () => { throw new Error('simulated read failure'); },
    closeSync: (fd) => { closeCalls += 1; assert.equal(fd, 7); },
  };
  try {
    assert.throws(() => readFileBounded(dir, 'README.md', { fsImpl: throwingFsImpl }), /simulated read failure/);
    assert.equal(closeCalls, 1, 'closeSync must be called even when readSync throws');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('22: denied path behavior is unaffected by the bounded-I/O refactor', () => {
  const dir = initFixture();
  try {
    assert.throws(() => readFileBounded(dir, '.env'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =========================================================================
// §10 (patch) — content secret redaction
// =========================================================================

function initConfigFixture() {
  const dir = initFixture();
  writeFileSync(join(dir, 'src', 'config.mjs'), [
    'export const publicValue = "safe";',
    'export const apiKey = "sk-example-secret-value";',
    'export const token = "ghp_exampleSecretValue";',
    'export const password = "hunter2pass";',
    '',
  ].join('\n'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add config fixture']);
  return dir;
}

test('23/24/25/26/27: an allowed path with secret-shaped content is included in the packet, public content survives, secret values do not, and a redaction marker is present', async () => {
  const dir = initConfigFixture();
  try {
    assert.equal(isWorkspacePathAllowed(dir, 'src/config.mjs').allowed, true);
    const packet = await buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: ['src/config.mjs'] });
    const entry = packet.files.find((f) => f.path === 'src/config.mjs');
    assert.ok(entry, 'src/config.mjs must be present in the packet');
    assert.equal(entry.exists, true);
    assert.match(entry.excerpt, /publicValue/);
    assert.doesNotMatch(entry.excerpt, /sk-example-secret-value/);
    assert.doesNotMatch(entry.excerpt, /ghp_exampleSecretValue/);
    assert.doesNotMatch(entry.excerpt, /hunter2pass/);
    assert.match(entry.excerpt, /\[REDACTED\]/);
    const rendered = renderWorkspaceEvidencePacketText(packet);
    assert.doesNotMatch(rendered, /sk-example-secret-value|ghp_exampleSecretValue|hunter2pass/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('28/29: sha256 identity is derived from the pre-redaction raw bytes, and evidence validation using that real hash still succeeds', () => {
  const dir = initConfigFixture();
  try {
    const read = readFileBounded(dir, 'src/config.mjs');
    // The hash must correspond to the REAL raw file bytes, not the
    // redacted display excerpt — re-derive independently via node:crypto
    // over the actual on-disk bytes to prove it.
    const rawBytes = readFileSync(join(dir, 'src', 'config.mjs'));
    const expectedHash = createHash('sha256').update(rawBytes.subarray(0, Math.min(rawBytes.length, MAX_FILE_BYTES))).digest('hex');
    assert.equal(read.sha256, expectedHash);
    assert.doesNotMatch(read.excerpt, /sk-example-secret-value/);

    const validated = validateEvidence([{ path: 'src/config.mjs', sha256: read.sha256, claim: 'defines publicValue and other constants' }], { repoPath: dir });
    assert.equal(validated.ok, true);
    assert.equal(validated.entries[0].hash_verified, 'MATCH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('30/31: .env and .runtime/... remain fully denied regardless of the content-redaction addition', async () => {
  const dir = initConfigFixture();
  try {
    mkdirSync(join(dir, '.runtime'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'SECRET=abc\n');
    writeFileSync(join(dir, '.runtime', 'secret.txt'), 'runtime secret\n');
    // Final closure patch (Defect B): an explicit manifest that names a
    // denied path is "FULL REQUESTED EVIDENCE OR FAIL" — the whole build
    // now throws instead of recording an `allowed:false` entry per denied
    // path and continuing. Each denied path is independently confirmed to
    // still be the failure cause.
    for (const deniedPath of ['.env', '.runtime/secret.txt']) {
      await assert.rejects(
        buildWorkspaceEvidencePacket({ project: { id: 'p', repo_path: dir }, evidencePaths: [deniedPath, 'src/config.mjs'] }),
        (e) => e.code === 'WORKSPACE_EVIDENCE_REQUIRED_PATH_UNAVAILABLE' && e.requestedPath === deniedPath,
      );
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('32: redactWorkspaceEvidenceContent redacts assignment-shape secrets (API_KEY=/TOKEN=/PASSWORD=/SECRET=) even when not sk-/ghp_-shaped', () => {
  const redacted = redactWorkspaceEvidenceContent('PASSWORD=hunter2pass\nSECRET_TOKEN: "abcd1234"\nAPI_KEY = plainlonglivedvalue');
  assert.doesNotMatch(redacted, /hunter2pass/);
  assert.doesNotMatch(redacted, /abcd1234/);
  assert.doesNotMatch(redacted, /plainlonglivedvalue/);
  assert.match(redacted, /\[REDACTED\]/);
});

// =========================================================================
// §11 (patch) — T5 fixture-level readiness: mixed profile classes, deep
// manifest, chair+participant packet parity, no leakage. Fake drivers only.
// =========================================================================

test('T5 fixture: chair=claude-code, participants=codex/api/antigravity-like, all TEXT_ONLY, explicit deep manifest — chair plan/synthesis and every participant report get the identical deep, secret-free packet', async () => withRepository(async (repository) => {
  const dir = initConfigFixture();
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'deep', 'orchestrator.mjs'), 'export function orchestrate() { return "deep-orchestration-logic"; }\n');
  writeFileSync(join(dir, '.env'), 'SECRET=must-not-leak\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'deep fixture']);
  try {
    const project = { id: 'proj-t5', repo_path: dir };
    const council = normalizeCouncilSpec({
      chair_profile_id: 'chair', participant_profile_ids: ['p_codex', 'p_api', 'p_antigravity'], rounds: 1,
      workspace_requirement: 'READ', workspace_evidence_paths: ['src/config.mjs', 'src/deep/orchestrator.mjs'],
    });
    const profiles = fakeProfileRegistry({
      chair: { id: 'chair', product: 'claude-code' },
      p_codex: { id: 'p_codex', product: 'codex' },
      p_api: { id: 'p_api', product: 'api' },
      p_antigravity: { id: 'p_antigravity', product: 'antigravity' },
    });
    for (const id of ['chair', 'p_codex', 'p_api', 'p_antigravity']) {
      assert.equal(resolveProfileCapabilities(profiles.get(id)).workspaceCapability, 'TEXT_ONLY', id);
    }
    const capturedPrompts = {};
    const resolveDriver = (profile) => ({
      name: `fake:${profile.id}`,
      async decide(input) {
        const { stepKind } = input.request.context;
        capturedPrompts[`${stepKind}:${profile.id}`] = input.request.objective;
        if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p_codex: 'audit', p_api: 'audit', p_antigravity: 'audit' }, critique_focus: 'x', synthesis_focus: 'y' } };
        if (stepKind === 'participant_report') {
          const real = readFileBounded(dir, 'src/deep/orchestrator.mjs');
          return { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [], evidence: [{ path: 'src/deep/orchestrator.mjs', sha256: real.sha256, claim: 'defines orchestrate()' }] } };
        }
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
        throw new Error(`unexpected ${stepKind}`);
      },
    });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
    let packetBuilds = 0;
    let knownPacketText = null;
    const driver = new CouncilChairDriver({
      council, ownerTask: 'independently audit the orchestration logic',
      resolveWorkspaceCapability: (id) => resolveProfileCapabilities(profiles.get(id)).workspaceCapability,
      loadEvidencePacket: async () => {
        packetBuilds += 1;
        const packet = await buildWorkspaceEvidencePacket({ project, evidencePaths: council.workspace_evidence_paths });
        knownPacketText = renderWorkspaceEvidencePacketText(packet);
        return { text: knownPacketText, hashesByPath: packetHashesByPath(packet) };
      },
    });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
    const request = createPmRequest({ objective: 'independently audit the orchestration logic', context: { council } });
    repository.create(request, { id: 'pmrun_t5_fixture', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
    const result = await runtime.resume('pmrun_t5_fixture');
    assert.equal(result.status, 'completed');
    assert.equal(result.data.degraded, false);
    assert.deepEqual(result.data.completed_participants.sort(), ['p_antigravity', 'p_api', 'p_codex']);

    assert.ok(knownPacketText, 'the packet was never built');
    assert.match(knownPacketText, /src\/deep\/orchestrator\.mjs/, 'packet is missing the deep requested file');
    assert.doesNotMatch(knownPacketText, /sk-example-secret-value|ghp_exampleSecretValue|hunter2pass|must-not-leak/, 'packet leaked secret content');

    const relevantKeys = ['chair_plan:chair', 'participant_report:p_codex', 'participant_report:p_api', 'participant_report:p_antigravity', 'chair_synthesis:chair'];
    for (const key of relevantKeys) {
      assert.ok(capturedPrompts[key].includes(knownPacketText), `${key} did not receive the exact, byte-identical evidence packet`);
    }
    assert.equal(packetBuilds, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));
