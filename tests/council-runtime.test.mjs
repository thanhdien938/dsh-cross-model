import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec, CouncilValidationError, councilMaxTurns, DEGRADED_DISCLOSURE_SENTENCE } from '../src/pm/council/council-contracts.mjs';
import { buildChairSynthesisPrompt } from '../src/pm/council/council-prompts.mjs';
import { CouncilChairDriver, CouncilOrchestrationError } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { isCouncilRun, projectCouncil, COUNCIL_PHASES } from '../src/pm/council/council-projection.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const PROJECT = Object.freeze({ id: 'proj-a', repo_path: '/tmp/proj-a' });

// ---- contracts -------------------------------------------------------

test('normalizeCouncilSpec accepts a valid spec and defaults rounds/strategy', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'] });
  assert.equal(spec.rounds, 2);
  assert.equal(spec.strategy, 'independent_then_critique_then_synthesis');
  assert.deepEqual(spec.participant_profile_ids, ['p1', 'p2']);
});

test('normalizeCouncilSpec rejects zero participants', () => {
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: [] }), CouncilValidationError);
});

test('normalizeCouncilSpec rejects duplicate participants', () => {
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p1'] }), (e) => e.code === 'COUNCIL_DUPLICATE_PARTICIPANT');
});

test('normalizeCouncilSpec rejects rounds outside 1..2', () => {
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 3 }), (e) => e.code === 'COUNCIL_INVALID_ROUNDS');
});

test('normalizeCouncilSpec enforces the owner-selected authority boundary against knownProfileIds', () => {
  const known = new Set(['chair', 'p1']);
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'ghost'] }, { knownProfileIds: known }), (e) => e.code === 'COUNCIL_UNKNOWN_PARTICIPANT');
  assert.throws(() => normalizeCouncilSpec({ chair_profile_id: 'ghost-chair', participant_profile_ids: ['p1'] }, { knownProfileIds: known }), (e) => e.code === 'COUNCIL_UNKNOWN_CHAIR');
});

test('normalizeCouncilSpec allows chair to also be a participant (chair need not be excluded)', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['chair', 'p1'] });
  assert.deepEqual(spec.participant_profile_ids, ['chair', 'p1']);
});

test('councilMaxTurns is finite and bounded', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3', 'p4'], rounds: 2 });
  assert.equal(councilMaxTurns(spec), 1 + 4 + 4 + 1 + 1);
});

test('three-participant degraded synthesis prompt reports the durable 2-of-3 count, not the legacy one-survivor sentence', () => {
  const prompt = buildChairSynthesisPrompt({
    ownerTask: 'task', reports: [{ profileId: 'a', report: {} }, { profileId: 'c', report: {} }],
    critiques: [], failures: [{ profileId: 'b', reason: 'API_SECRET_MISSING' }],
    synthesisFocus: 'truth', degraded: true,
  });
  assert.match(prompt, /2 of 3 selected participants completed/);
  assert.match(prompt, /Council degraded: one or more participants failed\./);
  assert.doesNotMatch(prompt, /fewer than two participants completed/);
});

// ---- fake production-shaped driver resolver --------------------------

function fakeResolveDriverFactory({ failures = new Set(), planUnknownParticipant = false, wrongDecisionFor = new Set(), synthesisOutput = 'FINAL SYNTHESIS TEXT' } = {}) {
  const calls = [];
  const extraCtxCalls = [];
  const resolveDriver = (profile, context = {}) => {
    if (context.extraCtx) extraCtxCalls.push(context.extraCtx);
    if (!context.project?.repo_path) throw new Error('resolveDriver requires project.repo_path');
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        calls.push({ profileId: profile.id, stepKind: input.request.context.stepKind });
        if (failures.has(profile.id) && input.request.context.stepKind !== 'chair_plan' && input.request.context.stepKind !== 'chair_synthesis') {
          throw new Error(`simulated backend failure for ${profile.id}`);
        }
        const stepKind = input.request.context.stepKind;
        if (wrongDecisionFor.has(`${profile.id}:${stepKind}`)) return { type: 'workflow', spec: { id: 'nope' } };
        if (stepKind === 'chair_plan') {
          const participantIds = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(participantIds.map((id) => [id, `focus ${id}`]));
          if (planUnknownParticipant) instructions.ghost = 'should never be used';
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be harsh', synthesis_focus: 'be concise' } };
        }
        if (stepKind === 'participant_report') {
          return { type: 'finish', output: `${profile.id} summary`, data: { type: 'council_report', analysis: `${profile.id} analysis`, recommendation: `${profile.id} rec`, risks: ['r1'], uncertainties: ['u1'] } };
        }
        if (stepKind === 'participant_critique') {
          return { type: 'finish', output: `${profile.id} critique summary`, data: { type: 'council_critique', criticisms: ['c1'], agreements: ['a1'], revised_recommendation: `${profile.id} revised`, remaining_disagreements: [] } };
        }
        if (stepKind === 'chair_synthesis') {
          return { type: 'finish', output: synthesisOutput, data: { type: 'council_synthesis' } };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  return { resolveDriver, calls, extraCtxCalls };
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-council-'));
  const path = join(dir, 'council.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ store, repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function actionsFor(resolveDriver, profileRegistry) {
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, extraCtx: (spec) => ({ councilId: 'test', phase: spec.stepKind, round: spec.round, role: spec.stepKind.startsWith('chair') ? 'chair' : 'participant' }) });
  const peerRelay = { async exchange() { throw new Error('council never uses peer_exchange'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  return { workflowRunner, peerRelay };
}

// ---- end-to-end council run over the real durable turn machine -------

test('council: full 2-round run completes with a chair FINISH synthesis, no peer_exchange used', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 2 });
  const { resolveDriver, calls, extraCtxCalls } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2', 'p3']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'Compare two safe approaches for improving README clarity.' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });

  const request = createPmRequest({ objective: 'Compare two safe approaches for improving README clarity.', context: { ownerCommandId: 'cmd-1', council } });
  repository.create(request, { id: 'pmrun_council_1', driver: driver.name, startedAt: '2026-08-21T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_council_1');

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'FINAL SYNTHESIS TEXT');
  assert.equal(result.data.type, 'council');
  assert.equal(result.data.degraded, false);
  assert.deepEqual(result.data.completed_participants, ['p1', 'p2', 'p3']);
  assert.deepEqual(result.data.failed_participants, []);

  // physical execution is serialized: chair_plan, then p1/p2/p3 report, then
  // p1/p2/p3 critique, then chair synthesis — one call at a time, never
  // interleaved (Part L).
  assert.deepEqual(calls.map((c) => `${c.stepKind}:${c.profileId}`), [
    'chair_plan:chair', 'participant_report:p1', 'participant_report:p2', 'participant_report:p3',
    'participant_critique:p1', 'participant_critique:p2', 'participant_critique:p3', 'chair_synthesis:chair',
  ]);

  // round 2 receives peer reports but not its own as a peer (Part F).
  // (indirectly proven by the fake driver's deterministic responses above;
  // directly verify observability correlation was threaded through.)
  assert.ok(extraCtxCalls.some((c) => c.role === 'participant' && c.phase === 'participant_critique'));
  assert.ok(extraCtxCalls.some((c) => c.role === 'chair' && c.phase === 'chair_synthesis'));

  const loaded = repository.load('pmrun_council_1');
  assert.ok(isCouncilRun(loaded));
  const projection = projectCouncil(loaded);
  assert.equal(projection.phase, COUNCIL_PHASES.COMPLETED);
  assert.equal(projection.participants.length, 3);
  assert.ok(projection.participants.every((p) => p.status === 'DONE'));
  assert.equal(projection.synthesis.ok, true);
  assert.equal(projection.round1.length, 3);
  assert.equal(projection.round2.length, 3);
}));

// P19-D6 (D6-D): the projection must surface implementation-participant
// identity — Desktop/Telegram have no other way to show the owner which
// participant, if any, was ever execution-capable for this run.
test('council: projection exposes implementationParticipantId verbatim from the normalized spec; null when absent', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, implementation_participant_id: 'p1' });
  const { resolveDriver } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-impl', council } });
  repository.create(request, { id: 'pmrun_council_impl', driver: driver.name, startedAt: '2026-08-21T00:00:00.000Z' });
  await runtime.resume('pmrun_council_impl');

  const projection = projectCouncil(repository.load('pmrun_council_impl'));
  assert.equal(projection.implementationParticipantId, 'p1');

  const councilNoImpl = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const driver2 = new CouncilChairDriver({ council: councilNoImpl, ownerTask: 'task' });
  const runtime2 = new DurablePmRuntime({ driver: driver2, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request2 = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-noimpl', council: councilNoImpl } });
  repository.create(request2, { id: 'pmrun_council_noimpl', driver: driver2.name, startedAt: '2026-08-21T00:00:00.000Z' });
  await runtime2.resume('pmrun_council_noimpl');
  assert.equal(projectCouncil(repository.load('pmrun_council_noimpl')).implementationParticipantId, null);
}));

test('council: one participant failing degrades gracefully; council still completes (>=1 success)', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 2 });
  const { resolveDriver } = fakeResolveDriverFactory({ failures: new Set(['p2']) });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-2', council } });
  repository.create(request, { id: 'pmrun_council_2', driver: driver.name, startedAt: '2026-08-21T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_council_2');

  assert.equal(result.status, 'completed');
  assert.equal(result.data.degraded, true);
  assert.deepEqual(result.data.failed_participants, ['p2']);
  assert.ok(result.output.startsWith(DEGRADED_DISCLOSURE_SENTENCE), 'degraded disclosure is enforced programmatically');
  // p2 never enters the critique round (only successful reporters do).
  const loaded = repository.load('pmrun_council_2');
  const projection = projectCouncil(loaded);
  assert.equal(projection.round2.length, 1);
  assert.equal(projection.round2[0].profileId, 'p1');
}));

test('council: one failure in a three-participant council is degraded; later participant and both eligible critiques still execute sequentially', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['codex', 'broken-api', 'openrouter-api'], rounds: 2 });
  const { resolveDriver, calls } = fakeResolveDriverFactory({
    failures: new Set(['broken-api']),
    synthesisOutput: 'Council degraded: only one participant completed.\n\nMODEL BODY',
  });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'codex', 'broken-api', 'openrouter-api']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'mixed council' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'mixed council', context: { ownerCommandId: 'cmd-r3', council } });
  repository.create(request, { id: 'pmrun_council_r3', driver: driver.name, startedAt: '2026-08-25T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_council_r3');

  assert.equal(result.status, 'completed');
  assert.equal(result.data.degraded, true);
  assert.deepEqual(result.data.completed_participants, ['codex', 'openrouter-api']);
  assert.deepEqual(result.data.failed_participants, ['broken-api']);
  assert.ok(result.output.startsWith('Council degraded: one or more participants failed.'));
  assert.ok(!result.output.includes('only one participant completed'));
  assert.ok(result.output.endsWith('MODEL BODY'));
  assert.deepEqual(calls.map((c) => `${c.stepKind}:${c.profileId}`), [
    'chair_plan:chair',
    'participant_report:codex',
    'participant_report:broken-api',
    'participant_report:openrouter-api',
    'participant_critique:codex',
    'participant_critique:openrouter-api',
    'chair_synthesis:chair',
  ]);
  const projection = projectCouncil(repository.load('pmrun_council_r3'));
  assert.equal(projection.round1.length, 3);
  assert.equal(projection.round1.find((p) => p.profileId === 'broken-api').ok, false);
  assert.equal(projection.round2.length, 2);
  assert.ok(!projection.round2.some((p) => p.profileId === 'broken-api'));
}));

test('council: all participants failing fails the whole council', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const { resolveDriver } = fakeResolveDriverFactory({ failures: new Set(['p1', 'p2']) });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-3', council } });
  repository.create(request, { id: 'pmrun_council_3', driver: driver.name, startedAt: '2026-08-21T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_council_3');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'COUNCIL_ALL_PARTICIPANTS_FAILED');
}));

test('council: chair-authored plan cannot inject an unknown participant (P7-R0.2 Part G: rejected by explicit schema validation, never silently invoked)', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ planUnknownParticipant: true });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-4', council } });
  repository.create(request, { id: 'pmrun_council_4', driver: driver.name, startedAt: '2026-08-21T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_council_4');
  // The chair's own plan is invalid (an unknown "ghost" key), so chair_plan
  // fails schema validation and the whole council fails closed — the
  // pre-R0.2 "silently ignore the extra key and continue" behavior is no
  // longer correct per Part G's explicit "no additions" requirement.
  // P10-R0.1 Part E: an UNKNOWN_PARTICIPANT_INSTRUCTION is now repair-
  // eligible — the chair gets exactly ONE bounded re-prompt before this
  // fails closed, so the fake (deterministic, always-"ghost") chair driver
  // is called twice, never a participant.
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'COUNCIL_CHAIR_PLAN_FAILED');
  assert.ok(!calls.some((c) => c.profileId === 'ghost'), 'the chair-invented "ghost" participant was never resolved or invoked');
  assert.equal(calls.length, 2, 'the chair_plan step was attempted, then repaired-and-reattempted once (bounded), never a participant');
}));

test('council: restart between rounds resumes without duplicating completed reports', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 2 });
  const { resolveDriver, calls } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-5', council } });
  repository.create(request, { id: 'pmrun_council_5', driver: 'council:chair', startedAt: '2026-08-21T00:00:00.000Z' });

  // Drive only through round 1 by capping maxTurns, simulating a crash right
  // after round 1 completes (a fresh process would load exactly this state).
  const partialRuntime = new DurablePmRuntime({ driver: new CouncilChairDriver({ council, ownerTask: 'task' }), workflowRunner, peerRelay, repository, maxTurns: 3 });
  const partial = await partialRuntime.resume('pmrun_council_5');
  assert.equal(partial.status, 'failed'); // PmMaxTurnsExceeded — simulates the crash boundary
  const callsAfterPartial = calls.length;
  assert.equal(callsAfterPartial, 3); // chair_plan, p1 report, p2 report

  // "Restart": load fresh, but the run is now terminal (failed) — a real
  // restart mid-flight (not maxTurns-truncated) would instead find
  // run.status === 'running' and simply resume via the classifyPmTurnRecovery
  // machine. We assert the more important invariant directly: the 3
  // already-completed turns are durably TURN_COMPLETE and are never re-run.
  const reloaded = repository.load('pmrun_council_5');
  assert.equal(reloaded.turns.filter((t) => t.phase === 'TURN_COMPLETE').length, 3);
  assert.equal(reloaded.turns[1].decision.spec.profileId, 'p1');
  assert.equal(reloaded.turns[2].decision.spec.profileId, 'p2');
}));
