import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { normalizeCouncilSpec, COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { WORKSPACE_CAPABILITY } from '../src/pm/council/workspace-capability.mjs';
import { readFileBounded } from '../src/pm/council/workspace-safe-reader.mjs';
import { buildWorkspaceEvidencePacket, renderWorkspaceEvidencePacketText, packetHashesByPath } from '../src/pm/council/workspace-evidence-packet.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { runCodexCliProcess } from '../src/session/codex-cli-session-bridge.mjs';
import { routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initRepoFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-int-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(dir, 'README.md'), 'evidence root fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

/** Fake handoff-shaped history entry — the exact shape #stepsSoFar()/#debateStepsSoFar() read, built directly (no full workflow-runner round trip needed for a pure prompt-shape assertion). */
function historyEntry(handoff) { return { decision: { type: 'workflow' }, outcome: { finalResult: { handoff } } }; }

// ---- CouncilChairDriver prompt-shape unit tests (DI seams only, no CouncilStepWorkflowRunner) ----

test('workspace_requirement:NONE (default): CouncilChairDriver never calls resolveWorkspaceCapability/loadEvidencePacket', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'] });
  let capabilityCalls = 0; let packetCalls = 0;
  const driver = new CouncilChairDriver({
    council, ownerTask: 'legacy analysis task',
    resolveWorkspaceCapability: () => { capabilityCalls += 1; return WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE; },
    loadEvidencePacket: async () => { packetCalls += 1; return { text: 'x' }; },
  });
  const chairPlanDecision = await driver.decide({ turn: 0, history: [] });
  assert.doesNotMatch(chairPlanDecision.spec.prompt, /WORKSPACE_READ/);
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'be harsh', synthesis_focus: 'be concise' };
  const reportDecision = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.match(reportDecision.spec.prompt, /Do not modify files\. Do not perform destructive actions\./); // pre-existing READ_ONLY_NOTICE, byte-for-byte
  assert.doesNotMatch(reportDecision.spec.prompt, /WORKSPACE_READ/);
  assert.equal(reportDecision.spec.workspaceRequirement, 'NONE');
  assert.equal(reportDecision.spec.workspaceMode, null);
  assert.equal(capabilityCalls, 0);
  assert.equal(packetCalls, 0);
});

test('workspace_requirement:READ + NATIVE participant: prompt grants native read-only inspection, requires evidence, embeds NO packet text', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  let packetCalls = 0;
  const driver = new CouncilChairDriver({
    council, ownerTask: 'audit the repository',
    resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE,
    loadEvidencePacket: async () => { packetCalls += 1; return { text: 'PACKET SHOULD NOT APPEAR' }; },
  });
  const planDecision = await driver.decide({ turn: 0, history: [] });
  // Final owner-review micro-patch, Blocker A: chair_plan is ALWAYS a
  // packet consumer for a READ council (every current product is TEXT_ONLY
  // for the chair role — see workspace-capability.mjs's Gap A remediation
  // — and even a hypothetical future native participant's own report step
  // still must not receive it, which this test still proves below).
  assert.match(planDecision.spec.prompt, /PACKET SHOULD NOT APPEAR/);
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' };
  const reportDecision = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.match(reportDecision.spec.prompt, /you must independently inspect the project repository/);
  assert.match(reportDecision.spec.prompt, /"evidence":\[/);
  assert.doesNotMatch(reportDecision.spec.prompt, /PACKET SHOULD NOT APPEAR/);
  assert.equal(reportDecision.spec.workspaceMode, WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE);
  assert.equal(packetCalls, 1, 'the chair always consumes the ONE cached packet for a READ council; a NATIVE participant\'s own step still never triggers a second build (proven above: the report prompt does not embed it) or a second call (the packet is cached, not rebuilt)');
});

test('workspace_requirement:READ + TEXT_ONLY participant: prompt embeds the (cached, single-build) evidence packet text and requires evidence', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], workspace_requirement: 'READ' });
  let packetCalls = 0;
  const driver = new CouncilChairDriver({
    council, ownerTask: 'audit the repository',
    resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.TEXT_ONLY,
    loadEvidencePacket: async () => { packetCalls += 1; return { text: 'CANONICAL PACKET TEXT 123' }; },
  });
  await driver.decide({ turn: 0, history: [] });
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus1', p2: 'focus2' }, critique_focus: 'x', synthesis_focus: 'y' };
  const r1 = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.match(r1.spec.prompt, /do NOT have native filesystem access/);
  assert.match(r1.spec.prompt, /CANONICAL PACKET TEXT 123/);
  const r1Handoff = { stepKind: COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, participantProfileId: 'p1', ok: true, analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] };
  const r2 = await driver.decide({ turn: 2, history: [historyEntry(planHandoff), historyEntry(r1Handoff)] });
  assert.match(r2.spec.prompt, /CANONICAL PACKET TEXT 123/);
  // Same packet, built exactly once and cached for every TEXT_ONLY step in this run.
  assert.equal(packetCalls, 1);
});

test('WORKSPACE_READ never implies execution/implementation capability — isImplementationParticipant stays false regardless of workspaceMode', async () => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' });
  const driver = new CouncilChairDriver({
    council, ownerTask: 'audit the repository',
    resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE,
    loadEvidencePacket: async () => ({ text: 'x' }),
  });
  await driver.decide({ turn: 0, history: [] });
  const planHandoff = { stepKind: COUNCIL_STEP_KINDS.CHAIR_PLAN, ok: true, participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' };
  const reportDecision = await driver.decide({ turn: 1, history: [historyEntry(planHandoff)] });
  assert.equal(reportDecision.spec.isImplementationParticipant, false);
});

// ---- Full end-to-end evidence-gating test (real CouncilStepWorkflowRunner + real repo fixture) ----

function fakeProfileRegistry(map) { return { get(id) { if (!map[id]) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return map[id]; } }; }

async function withRepository(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-sqlite-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    await fn(new PmRepository({ store }));
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('READ council: a participant report with NO evidence FAILS the step and cannot become a substantive PASS (reuses the existing degraded/failed-participant pipeline)', async () => withRepository(async (repository) => {
  const repoDir = initRepoFixture();
  try {
    const project = { id: 'proj-ws', repo_path: repoDir };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p_no_evidence'], rounds: 1, workspace_requirement: 'READ' });
    const profiles = fakeProfileRegistry({ chair: { id: 'chair', product: 'claude-code' }, p_no_evidence: { id: 'p_no_evidence', product: 'api' } });
    const resolveDriver = (profile) => ({
      name: `fake:${profile.id}`,
      async decide(input) {
        const { stepKind } = input.request.context;
        if (stepKind === 'chair_plan') {
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p_no_evidence: 'audit' }, critique_focus: 'x', synthesis_focus: 'y' } };
        }
        if (stepKind === 'participant_report') {
          // Mechanically well-formed, but ZERO repository evidence — exactly
          // T5's real failure mode. This must NOT count as a successful report.
          return { type: 'finish', output: 'looks fine', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
        }
        if (stepKind === 'chair_synthesis') {
          return { type: 'finish', output: 'SYNTHESIS', data: { type: 'council_synthesis' } };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
    const driver = new CouncilChairDriver({
      council, ownerTask: 'independently audit this repository',
      resolveWorkspaceCapability: (id) => (id === 'chair' ? WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE : WORKSPACE_CAPABILITY.TEXT_ONLY),
      loadEvidencePacket: async () => ({ text: 'packet text' }),
    });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
    const request = createPmRequest({ objective: 'independently audit this repository', context: { council } });
    repository.create(request, { id: 'pmrun_ws_1', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });

    // All round-1 participants fail evidence -> COUNCIL_ALL_PARTICIPANTS_FAILED
    // is thrown by the driver -> DurablePmRuntime catches it and terminalizes
    // the PmRun as `failed` (Part I: "ALL participants failing... throws",
    // caught by DurablePmRuntime's own decide()-error handling — never a
    // rejected resume() promise).
    const outcome = await runtime.resume('pmrun_ws_1');
    assert.equal(outcome.status, 'failed');
    const loaded = repository.load('pmrun_ws_1');
    const reportTurn = loaded.turns.find((t) => t.decision?.spec?.stepKind === 'participant_report');
    assert.equal(reportTurn.outcome.finalResult.status, 'failed');
    assert.match(reportTurn.outcome.finalResult.handoff.reason, /COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_EVIDENCE/);
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
}));

test('READ council: a participant report WITH valid, hash-verified evidence succeeds and the persisted evidence is sanitized (redacted claim, verified hash) — never the raw model-authored array', async () => withRepository(async (repository) => {
  const repoDir = initRepoFixture();
  try {
    const real = readFileBounded(repoDir, 'README.md');
    const project = { id: 'proj-ws2', repo_path: repoDir };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p_ok'], rounds: 1, workspace_requirement: 'READ' });
    const profiles = fakeProfileRegistry({ chair: { id: 'chair', product: 'claude-code' }, p_ok: { id: 'p_ok', product: 'codex' } });
    const resolveDriver = (profile) => ({
      name: `fake:${profile.id}`,
      async decide(input) {
        const { stepKind } = input.request.context;
        if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p_ok: 'audit' }, critique_focus: 'x', synthesis_focus: 'y' } };
        if (stepKind === 'participant_report') {
          return {
            type: 'finish', output: 'README confirms fixture content',
            data: {
              type: 'council_report', analysis: 'README.md contains the fixture line', recommendation: 'no action needed', risks: [], uncertainties: [],
              evidence: [{ path: 'README.md', sha256: real.sha256, line_start: 1, line_end: 1, claim: 'contains "evidence root fixture"' }],
            },
          };
        }
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTHESIS OK', data: { type: 'council_synthesis' } };
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: profiles, project });
    const driver = new CouncilChairDriver({
      council, ownerTask: 'independently audit this repository',
      resolveWorkspaceCapability: () => WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE,
      // Final closure patch (Defect A): #getEvidenceHashes() always reflects
      // a real "READ production packet provider" result once
      // workspace_requirement === READ, regardless of a given participant's
      // NATIVE/TEXT_ONLY capability — so this mock must return a real
      // hashesByPath (as the genuine packet builder would), not rely on the
      // now-closed "hashesByPath omitted -> live-disk fallback" loophole.
      loadEvidencePacket: async () => {
        const packet = await buildWorkspaceEvidencePacket({ project });
        return { text: renderWorkspaceEvidencePacketText(packet), hashesByPath: packetHashesByPath(packet) };
      },
    });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
    const request = createPmRequest({ objective: 'independently audit this repository', context: { council } });
    repository.create(request, { id: 'pmrun_ws_2', driver: driver.name, startedAt: '2026-09-06T00:00:00.000Z' });
    const result = await runtime.resume('pmrun_ws_2');
    assert.equal(result.status, 'completed');
    assert.equal(result.data.degraded, false);
    assert.deepEqual(result.data.completed_participants, ['p_ok']);

    const loaded = repository.load('pmrun_ws_2');
    const reportTurn = loaded.turns.find((t) => t.decision?.spec?.stepKind === 'participant_report');
    const persistedEvidence = reportTurn.outcome.finalResult.handoff.evidence;
    assert.equal(persistedEvidence.length, 1);
    assert.equal(persistedEvidence[0].hash_verified, 'MATCH');
    assert.equal(persistedEvidence[0].sha256, real.sha256);
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
}));

// ---- Codex sandbox invariant (native reader) — reuses the real bridge, never a second implementation ----

test('Codex bridge uses trusted execution and receives the correct project cwd', async () => {
  let capturedArgs = null; let capturedCwd = null;
  const spawnImpl = (binary, args, opts) => {
    capturedArgs = args; capturedCwd = opts.cwd;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    process.nextTick(() => { child.stdout.emit('data', ''); child.emit('close', 0); });
    return child;
  };
  await runCodexCliProcess({ binary: 'codex', cwd: '/some/project/root', prompt: 'inspect the repo', spawnImpl });
  assert.ok(capturedArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(capturedArgs.includes('--sandbox'), false);
  assert.equal(capturedCwd, '/some/project/root');
});

// ---- Telegram grammar wiring ----------------------------------------------

test('routeTelegramUpdate: --workspace-read folds onto payload.council.workspace_requirement (canonical form)', () => {
  const projects = [{ id: 'proj1' }];
  const route = routeTelegramUpdate(
    { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj1 --pm chair --debate p1,p2 --workspace-read audit the repo' } },
    { projects, projectId: 'proj1' },
  );
  assert.equal(route.operation, 'SUBMIT_TASK');
  assert.equal(route.payload.council.workspace_requirement, 'READ');
});

test('routeTelegramUpdate: --workspace-read without a council dispatch fails closed (FLAGS_INVALID), never silently ignored', () => {
  const projects = [{ id: 'proj1' }];
  const route = routeTelegramUpdate(
    { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj1 --pm chair --workspace-read do a normal task' } },
    { projects, projectId: 'proj1' },
  );
  assert.equal(route.read, 'FLAGS_INVALID');
  assert.match(route.detail, /--workspace-read requires a council dispatch/);
});

test('routeTelegramUpdate: legacy council dispatch with no --workspace-read carries no workspace_requirement key on the raw payload (byte-for-byte unaffected)', () => {
  const projects = [{ id: 'proj1' }];
  const route = routeTelegramUpdate(
    { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj1 --pm chair --debate p1,p2 review the architecture' } },
    { projects, projectId: 'proj1' },
  );
  assert.equal('workspace_requirement' in route.payload.council, false);
});

// ---- OwnerControlService admission-gate integration -----------------------

function fakeRepository() {
  return {
    async beginCommand(command) { return { status: 'ACCEPTED', created_at: '2026-09-06T00:00:00.000Z', command }; },
    async completeCommand(id, canonical) { return canonical; },
  };
}

test('OwnerControlService.mutate: SUBMIT_TASK council with workspace_requirement READ and a codex/claude-code profile mix is admitted against a real git project (reaches the canonical task controller)', async () => {
  const repoDir = initRepoFixture();
  try {
    const project = { id: 'proj1', repo_path: repoDir, autonomy: { effects: {} } };
    const pmProfiles = [{ id: 'chair', product: 'claude-code' }, { id: 'p1', product: 'codex' }];
    let submitted = null;
    const service = new OwnerControlService({
      repository: fakeRepository(), projects: [project], pmProfiles,
      taskController: { async submit(input) { submitted = input; return { id: 'task-1' }; } },
    });
    await service.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj1', payload: { body: 'audit', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' } } });
    assert.ok(submitted);
    assert.equal(submitted.council.workspace_requirement, 'READ');
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test('OwnerControlService.mutate: an explicit workspace_evidence_paths manifest is admitted when every path is safe, and rejected (COUNCIL_WORKSPACE_EVIDENCE_UNAVAILABLE) when one path is denied/missing', async () => {
  const repoDir = initRepoFixture();
  try {
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'deep.mjs'), 'export const deep = true;\n');
    const project = { id: 'proj1', repo_path: repoDir, autonomy: { effects: {} } };
    const pmProfiles = [{ id: 'chair', product: 'claude-code' }, { id: 'p1', product: 'api' }];
    let submitted = null;
    const service = new OwnerControlService({
      repository: fakeRepository(), projects: [project], pmProfiles,
      taskController: { async submit(input) { submitted = input; return { id: 'task-1' }; } },
    });
    await service.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj1', payload: { body: 'audit', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/deep.mjs'] } } });
    assert.ok(submitted);
    assert.deepEqual(submitted.council.workspace_evidence_paths, ['src/deep.mjs']);

    await assert.rejects(
      service.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj1', payload: { body: 'audit', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ', workspace_evidence_paths: ['src/deep.mjs', '.env'] } } }),
      (e) => e instanceof OwnerControlError && e.code === 'COUNCIL_WORKSPACE_EVIDENCE_UNAVAILABLE' && e.offendingPaths.includes('.env'),
    );
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test('OwnerControlService.mutate: SUBMIT_TASK council with workspace_requirement READ, a TEXT_ONLY profile, and a non-git project is REJECTED before reaching the task controller', async () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), 'dsh-ws-owner-nongit-'));
  try {
    const project = { id: 'proj1', repo_path: nonGitDir, autonomy: { effects: {} } };
    const pmProfiles = [{ id: 'chair', product: 'claude-code' }, { id: 'p1', product: 'api' }];
    let submitted = false;
    const service = new OwnerControlService({
      repository: fakeRepository(), projects: [project], pmProfiles,
      taskController: { async submit() { submitted = true; return { id: 'task-1' }; } },
    });
    await assert.rejects(
      service.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'proj1', payload: { body: 'audit', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1'], workspace_requirement: 'READ' } } }),
      (e) => e instanceof OwnerControlError && e.code === 'COUNCIL_WORKSPACE_READ_UNAVAILABLE',
    );
    assert.equal(submitted, false);
  } finally { rmSync(nonGitDir, { recursive: true, force: true }); }
});
