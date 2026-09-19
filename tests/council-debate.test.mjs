import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec, CouncilValidationError, councilMaxTurns } from '../src/pm/council/council-contracts.mjs';
import { buildDebateResponsePrompt, buildDebateBriefPrompt, buildDebateSynthesisPrompt } from '../src/pm/council/council-prompts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const PROJECT = Object.freeze({ id: 'proj-debate', repo_path: '/tmp/proj-debate' });

// =========================================================================
// P19-D1 — normalized contract tests (docs/p19/00_...md §8, docs/p19/
// 01_...md scope item 1)
// =========================================================================

test('normalizeCouncilSpec: debate absent defaults to {enabled:false, max_rounds:2} — byte-for-byte pre-P19 shape otherwise unaffected', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'] });
  assert.deepEqual(spec.debate, { enabled: false, max_rounds: 2 });
  // Every pre-existing field is present and unaffected.
  assert.equal(spec.rounds, 2);
  assert.equal(spec.strategy, 'independent_then_critique_then_synthesis');
});

test('normalizeCouncilSpec: debate.enabled=false is accepted explicitly and normalizes the same as absent', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: false } });
  assert.deepEqual(spec.debate, { enabled: false, max_rounds: 2 });
});

test('normalizeCouncilSpec: debate.enabled=true with max_rounds=1 is accepted', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true, max_rounds: 1 } });
  assert.deepEqual(spec.debate, { enabled: true, max_rounds: 1 });
});

test('normalizeCouncilSpec: debate.enabled=true with max_rounds=2 is accepted', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true, max_rounds: 2 } });
  assert.deepEqual(spec.debate, { enabled: true, max_rounds: 2 });
});

test('normalizeCouncilSpec: debate.enabled=true defaults max_rounds to 2 when omitted', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true } });
  assert.deepEqual(spec.debate, { enabled: true, max_rounds: 2 });
});

test('normalizeCouncilSpec: debate.max_rounds=0 fails closed', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true, max_rounds: 0 } }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_ROUNDS',
  );
});

test('normalizeCouncilSpec: debate.max_rounds=3 fails closed (hard cap is 2, never owner-overridable)', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true, max_rounds: 3 } }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_ROUNDS',
  );
});

test('normalizeCouncilSpec: malformed debate block (non-object) fails closed', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: 'yes please' }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_SPEC',
  );
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: [1, 2] }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_SPEC',
  );
});

test('normalizeCouncilSpec: debate.enabled non-boolean fails closed', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: 'true' } }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_ENABLED',
  );
});

test('normalizeCouncilSpec: unknown debate field fails closed (strict-field semantics, mirrors chair_plan\'s own participant_instructions discipline)', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], debate: { enabled: true, max_rounds: 2, extra_field: 'nope' } }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_DEBATE_FIELDS',
  );
});

test('councilMaxTurns: still finite/bounded with debate enabled — 4 participants, 2 council rounds, 2 debate rounds', () => {
  const spec = normalizeCouncilSpec({
    chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3', 'p4'], rounds: 2, debate: { enabled: true, max_rounds: 2 },
  });
  const councilTurns = 1 + 4 + 4 + 1 + 1; // chair_plan + report*4 + critique*4 + synthesis + finish(counted as +1 slack)
  const debateTurns = 2 * (1 + 4 + 1); // (brief + response*4 + synthesis) * 2 rounds
  assert.equal(councilMaxTurns(spec), councilTurns + debateTurns);
  assert.ok(councilMaxTurns(spec) <= 32, 'still bounded by the hard 32-turn ceiling');
});

// =========================================================================
// Structural prompt-builder tests — same-round input freeze (docs/p19/
// 00_...md §5, docs/p19/01_...md scope item 3)
// =========================================================================

test('buildDebateResponsePrompt never surfaces a same-round peer response, even if a caller mistakenly passes one', () => {
  const prompt = buildDebateResponsePrompt({
    ownerTask: 'task', canonicalSynthesis: 'synthesis', debateBrief: 'brief', round: 1, participantProfileId: 'p1',
    // Not part of this function's real parameter contract — proves the
    // extra field can never leak into the rendered text even if a future
    // caller mistakenly threads one through (the destructuring below the
    // hood simply ignores it).
    peerResponses: [{ profileId: 'p2', response: 'SENTINEL_SAME_ROUND_PEER_RESPONSE_TEXT' }],
    sameRoundTranscript: 'SENTINEL_ACCUMULATED_TRANSCRIPT_TEXT',
  });
  assert.doesNotMatch(prompt, /SENTINEL_SAME_ROUND_PEER_RESPONSE_TEXT/);
  assert.doesNotMatch(prompt, /SENTINEL_ACCUMULATED_TRANSCRIPT_TEXT/);
  // Only the canonical inputs the plan names are present.
  assert.match(prompt, /synthesis/);
  assert.match(prompt, /brief/);
});

test('buildDebateBriefPrompt round 2 does not replay round 1 verbatim — it carries unresolved_questions, not the round-1 evidence text', () => {
  const round1 = buildDebateBriefPrompt({
    ownerTask: 'task', canonicalSynthesis: 'synth', round: 1, maxRounds: 2,
    reports: [{ profileId: 'p1', report: { recommendation: 'SENTINEL_ROUND1_RECOMMENDATION', risks: [], uncertainties: [] } }],
  });
  const round2 = buildDebateBriefPrompt({
    ownerTask: 'task', canonicalSynthesis: 'synth2', round: 2, maxRounds: 2,
    unresolvedQuestions: ['SENTINEL_UNRESOLVED_QUESTION'],
  });
  assert.match(round1, /SENTINEL_ROUND1_RECOMMENDATION/);
  assert.doesNotMatch(round2, /SENTINEL_ROUND1_RECOMMENDATION/, 'round 2 brief must not simply replay round 1 verbatim');
  assert.match(round2, /SENTINEL_UNRESOLVED_QUESTION/);
});

test('buildDebateSynthesisPrompt tells the chair the final round is engine-forced', () => {
  const finalRound = buildDebateSynthesisPrompt({ ownerTask: 't', canonicalSynthesis: 's', debateBrief: 'b', responses: [], round: 2, maxRounds: 2 });
  const nonFinalRound = buildDebateSynthesisPrompt({ ownerTask: 't', canonicalSynthesis: 's', debateBrief: 'b', responses: [], round: 1, maxRounds: 2 });
  assert.match(finalRound, /FINAL allowed debate round/);
  assert.doesNotMatch(nonFinalRound, /FINAL allowed debate round/);
});

// =========================================================================
// End-to-end fixture orchestration (docs/p19/01_...md test matrix)
// =========================================================================

// `round` is threaded to `resolveDriver()`'s own `context.extraCtx` (the
// `extraCtx: (spec) => ({..., round: spec.round})` callback every caller
// below supplies to CouncilStepWorkflowRunner) — NOT into
// `request.context` (council-step-workflow-runner.mjs's #decideOnce()
// only puts `{council, stepKind, profileId, participantProfileIds}`
// there). This fake driver reads it from the `context` closure it's
// resolved with, exactly like it already reads `context.executionOptions`.
function fakeResolveDriverFactory({ debateContinueByRound = {}, debateFailFor = new Set(), synthesisOutput = 'FINAL SYNTHESIS TEXT' } = {}) {
  const calls = [];
  const promptsByCall = [];
  const resolveDriver = (profile, context = {}) => {
    if (!context.project?.repo_path) throw new Error('resolveDriver requires project.repo_path');
    const round = context.extraCtx?.round;
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        calls.push({ profileId: profile.id, stepKind, round, permissionMode: context.executionOptions?.permissionMode ?? null });
        promptsByCall.push({ profileId: profile.id, stepKind, round, prompt: input.request.objective });
        if (stepKind === 'chair_plan') {
          const participantIds = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(participantIds.map((id) => [id, `focus ${id}`]));
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
        if (stepKind === 'debate_brief') {
          return { type: 'finish', output: 'brief ready', data: { type: 'debate_brief', brief: `ROUND ${round} CANONICAL BRIEF` } };
        }
        if (stepKind === 'debate_response') {
          if (debateFailFor.has(`${profile.id}:${round}`)) throw new Error(`simulated debate response failure for ${profile.id} round ${round}`);
          return { type: 'finish', output: `${profile.id} round ${round} summary`, data: { type: 'debate_response', response: `${profile.id} response for round ${round}` } };
        }
        if (stepKind === 'debate_synthesis') {
          const continueDebate = debateContinueByRound[round] ?? false;
          return {
            type: 'finish',
            output: `DEBATE REPORT ROUND ${round}`,
            data: { type: 'debate_synthesis', continue_debate: continueDebate, reason: `round ${round} reason`, unresolved_questions: continueDebate ? [`unresolved after round ${round}`] : [] },
          };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  return { resolveDriver, calls, promptsByCall };
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-council-debate-'));
  const path = join(dir, 'council.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ store, repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function actionsFor(resolveDriver, profileRegistry, stepState = null) {
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, extraCtx: (spec) => ({ councilId: 'test', phase: spec.stepKind, round: spec.round }), stepState });
  const peerRelay = { async exchange() { throw new Error('council never uses peer_exchange'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  return { workflowRunner, peerRelay };
}

test('debate: council without a debate block at all follows exactly the pre-P19 path (no debate_* calls, data.type stays "council")', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  const { resolveDriver, calls } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-nd', council } });
  repository.create(request, { id: 'pmrun_nodebate', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_nodebate');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.type, 'council');
  assert.ok(!calls.some((c) => c.stepKind.startsWith('debate_')), 'no debate step was ever emitted');
}));

test('debate: debate.enabled=false follows exactly the pre-P19 path', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: false } });
  const { resolveDriver, calls } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-nd2', council } });
  repository.create(request, { id: 'pmrun_debate_off', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_debate_off');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.type, 'council');
  assert.ok(!calls.some((c) => c.stepKind.startsWith('debate_')));
}));

test('debate: Council Report (chair_synthesis) always completes before the first debate step', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: {} });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 16 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-order', council } });
  repository.create(request, { id: 'pmrun_order', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_order');
  assert.equal(result.status, 'completed');
  const firstDebateIndex = calls.findIndex((c) => c.stepKind.startsWith('debate_'));
  const synthesisIndex = calls.findIndex((c) => c.stepKind === 'chair_synthesis');
  assert.ok(synthesisIndex >= 0 && firstDebateIndex > synthesisIndex, 'chair_synthesis must complete before any debate step is emitted');
}));

test('debate: max_rounds=1 — round 1 STOP produces FinalDebateReport with no round-2 calls, engine forces stop even if the model says continue', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: true } }); // model says continue, but max_rounds=1
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-r1', council } });
  repository.create(request, { id: 'pmrun_r1only', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_r1only');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.type, 'council_debate');
  assert.equal(result.data.debate.rounds_run, 1);
  assert.equal(result.data.debate.final_continue_debate, true, 'the raw model value is preserved for transparency');
  assert.equal(result.data.debate.engine_forced_stop, true, 'the engine, not the model, produced the stop');
  assert.equal(result.output, 'DEBATE REPORT ROUND 1');
  assert.ok(!calls.some((c) => c.round === 2), 'no round 2 debate step was ever emitted');
}));

test('debate: max_rounds=2, round 1 continue -> enters round 2; round 2 always stops regardless of model continuation prose', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: true, 2: true } }); // round 2 ALSO says continue
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-r2', council } });
  repository.create(request, { id: 'pmrun_r2', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_r2');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.debate.rounds_run, 2, 'round 1 continued into round 2');
  assert.equal(result.data.debate.final_continue_debate, true, 'round 2 synthesis really did say continue=true');
  assert.equal(result.data.debate.engine_forced_stop, true, 'engine forced the stop at round 2 regardless');
  assert.equal(result.output, 'DEBATE REPORT ROUND 2');
  // Full ordered sequence: council, then debate round 1 (brief, p1, p2, synthesis), then round 2 (brief, p1, p2, synthesis).
  const debateSeq = calls.filter((c) => c.stepKind.startsWith('debate_')).map((c) => c.stepKind);
  assert.deepEqual(debateSeq, [
    'debate_brief', 'debate_response', 'debate_response', 'debate_synthesis',
    'debate_brief', 'debate_response', 'debate_response', 'debate_synthesis',
  ]);
}));

test('debate: round 1 STOP produces final debate completion without ever reaching round 2', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-stop', council } });
  repository.create(request, { id: 'pmrun_stop', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_stop');
  assert.equal(result.data.debate.rounds_run, 1);
  assert.equal(result.data.debate.engine_forced_stop, false, 'the model itself said stop — the engine did not need to override it');
  assert.ok(!calls.some((c) => c.round === 2));
}));

test('debate: Round 1 participants receive the identical, frozen canonical brief; no participant sees a same-round peer response', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const { resolveDriver, promptsByCall } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2', 'p3']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-freeze', council } });
  repository.create(request, { id: 'pmrun_freeze', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_freeze');
  assert.equal(result.status, 'completed');

  const responsePrompts = promptsByCall.filter((c) => c.stepKind === 'debate_response');
  assert.equal(responsePrompts.length, 3);
  // Every participant's Round 1 response prompt carries the SAME canonical
  // brief text (frozen once, before participant 1 begins) — the sections
  // that vary (own profile id framing) are trimmed out by only comparing
  // the debate-brief line itself.
  const briefLine = (p) => p.prompt.split('\n').find((l) => l.includes('CANONICAL BRIEF'));
  assert.equal(briefLine(responsePrompts[0]), briefLine(responsePrompts[1]));
  assert.equal(briefLine(responsePrompts[1]), briefLine(responsePrompts[2]));
  // No participant's prompt contains another participant's profile id in a
  // "response" context (p2/p3 never appear as content inside p1's prompt).
  assert.doesNotMatch(responsePrompts[0].prompt, /p2 response for round|p3 response for round/);
  assert.doesNotMatch(responsePrompts[1].prompt, /p1 response for round|p3 response for round/);
  assert.doesNotMatch(responsePrompts[2].prompt, /p1 response for round|p2 response for round/);
}));

test('debate: only successful round-1 council reporters are debated (Part H — a failed participant is never fabricated into a debate response)', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const resolveDriver = (profile) => {
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        if (stepKind === 'chair_plan') {
          const ids = input.request.context.participantProfileIds ?? [];
          return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: Object.fromEntries(ids.map((id) => [id, 'focus'])), critique_focus: 'x', synthesis_focus: 'y' } };
        }
        if (stepKind === 'participant_report') {
          if (profile.id === 'p2') throw new Error('simulated p2 report failure');
          return { type: 'finish', output: 'p1 summary', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
        }
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTH', data: { type: 'council_synthesis' } };
        if (stepKind === 'debate_brief') return { type: 'finish', output: 'brief', data: { type: 'debate_brief', brief: 'B' } };
        if (stepKind === 'debate_response') return { type: 'finish', output: 'resp', data: { type: 'debate_response', response: `${profile.id} responded` } };
        if (stepKind === 'debate_synthesis') return { type: 'finish', output: 'DEBATE REPORT', data: { type: 'debate_synthesis', continue_debate: false, reason: 'done', unresolved_questions: [] } };
        throw new Error(`unexpected ${stepKind}`);
      },
    };
  };
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-fail', council } });
  repository.create(request, { id: 'pmrun_fail', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_fail');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.data.completed_participants, ['p1']);
  assert.deepEqual(result.data.failed_participants, ['p2']);
}));

test('debate: every debate_brief/debate_response/debate_synthesis step stays permissionMode "plan", even when implementation_participant_id names a debate participant', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({
    chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1,
    implementation_participant_id: 'p1', debate: { enabled: true, max_rounds: 1 },
  });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-plan', council } });
  repository.create(request, { id: 'pmrun_plan', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_plan');
  assert.equal(result.status, 'completed');
  // p1's OWN participant_report step is legitimately execution-capable (W4R6, unchanged).
  const p1Report = calls.find((c) => c.stepKind === 'participant_report' && c.profileId === 'p1');
  assert.equal(p1Report.permissionMode, 'bypassPermissions');
  // But every debate_* step — including p1's own debate_response — stays plan.
  const debateCalls = calls.filter((c) => c.stepKind.startsWith('debate_'));
  assert.ok(debateCalls.length > 0);
  for (const c of debateCalls) assert.equal(c.permissionMode, 'plan', `${c.stepKind} for ${c.profileId} must stay plan (W4R6 execution capability is not reused inside Debate in D1)`);
}));

test('debate: chair failing to produce a valid debate brief fails the whole run closed (typed error, never silently skipped)', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const resolveDriver = (profile) => ({
    name: `fake:${profile.id}`,
    async decide(input) {
      const stepKind = input.request.context.stepKind;
      if (stepKind === 'chair_plan') return { type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'focus' }, critique_focus: 'x', synthesis_focus: 'y' } };
      if (stepKind === 'participant_report') return { type: 'finish', output: 'r', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'SYNTH', data: { type: 'council_synthesis' } };
      if (stepKind === 'debate_brief') return { type: 'finish', output: 'bad brief', data: { type: 'not_a_brief' } }; // wrong data.type -> validation failure
      throw new Error(`unexpected ${stepKind}`);
    },
  });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-badbrief', council } });
  repository.create(request, { id: 'pmrun_badbrief', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_badbrief');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'COUNCIL_DEBATE_BRIEF_FAILED');
}));

// =========================================================================
// Recovery / idempotency (docs/p19/01_...md scope item "Persistence/
// recovery invariants") — a REAL durable stepState (DurableWorkflowState/
// WorkflowRepository), a FRESH CouncilStepWorkflowRunner instance, and a
// FRESH CouncilChairDriver, simulating a genuine process restart (never
// reusing the in-memory #results Map a same-process retry would).
// =========================================================================

function freshRunner(resolveDriver, profileRegistry, stepState) {
  return new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, extraCtx: (spec) => ({ phase: spec.stepKind, round: spec.round }), stepState });
}

test('debate: restart mid-round-1 (after the brief and one response) does not duplicate already-completed debate steps', async () => fixture(async ({ store, repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const stepState = new DurableWorkflowState({ repository: new WorkflowRepository({ store }) });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } });
  const profileRegistry = fakeProfileRegistry(['chair', 'p1', 'p2']);
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };

  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-restart1', council } });
  repository.create(request, { id: 'pmrun_restart1', driver: 'council:chair', startedAt: '2026-09-03T00:00:00.000Z' });

  // "Process 1": cap maxTurns to stop right after chair_plan(1) + p1
  // report(1) + p2 report(1) + chair_synthesis(1) + debate_brief(1) +
  // ONE debate_response(1) = 6 turns, simulating a crash mid-round-1.
  const runnerA = freshRunner(resolveDriver, profileRegistry, stepState);
  const runtimeA = new DurablePmRuntime({ driver: new CouncilChairDriver({ council, ownerTask: 'task' }), workflowRunner: runnerA, peerRelay, repository, maxTurns: 6 });
  const partial = await runtimeA.resume('pmrun_restart1');
  assert.equal(partial.status, 'failed'); // PmMaxTurnsExceeded — simulates the crash boundary
  const callsAfterPartial = calls.length;
  assert.equal(callsAfterPartial, 6);

  // "Process 2": genuinely fresh CouncilStepWorkflowRunner instance (its
  // own empty in-memory #results Map) reusing the SAME durable stepState
  // and repository — the only thing a real restart can reuse. A real
  // restart would find run.status==='running'; here maxTurns already
  // terminalized it, so mark it running again to simulate resumability
  // (the durable step rows themselves are the invariant under test, not
  // DurablePmRuntime's own run-status bookkeeping).
  const loaded = repository.load('pmrun_restart1');
  const completedTurns = loaded.turns.filter((t) => t.phase === 'TURN_COMPLETE');
  assert.equal(completedTurns.length, 6);
  const completedStepKinds = completedTurns.map((t) => t.decision?.spec?.stepKind).filter(Boolean);
  assert.deepEqual(completedStepKinds, ['chair_plan', 'participant_report', 'participant_report', 'chair_synthesis', 'debate_brief', 'debate_response']);

  // Directly prove the runner-level guarantee: re-run() the EXACT already-
  // completed debate_brief/debate_response specs against a FRESH runner
  // instance sharing the same durable stepState — must never re-invoke the
  // backend (Invariant #9 / REM-R2-I, reused verbatim for debate steps).
  const runnerB = freshRunner(resolveDriver, profileRegistry, stepState);
  const briefTurn = completedTurns[4];
  const responseTurn = completedTurns[5];
  const callsBeforeReplay = calls.length;
  await runnerB.run(briefTurn.decision.spec);
  await runnerB.run(responseTurn.decision.spec);
  assert.equal(calls.length, callsBeforeReplay, 'a fresh runner instance never re-invokes an already-durably-completed debate step');
}));

test('debate: restart between debate rounds (round 1 complete, round 2 pending) resumes at round 2 without duplicating round 1', async () => fixture(async ({ store, repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const stepState = new DurableWorkflowState({ repository: new WorkflowRepository({ store }) });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: true, 2: false } });
  const profileRegistry = fakeProfileRegistry(['chair', 'p1']);
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };

  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-restart2', council } });
  repository.create(request, { id: 'pmrun_restart2', driver: 'council:chair', startedAt: '2026-09-03T00:00:00.000Z' });

  // Round 1 fully completes: chair_plan(1) + report(1) + synthesis(1) +
  // debate_brief(1) + debate_response(1) + debate_synthesis(1) = 6 turns.
  const runnerA = freshRunner(resolveDriver, profileRegistry, stepState);
  const runtimeA = new DurablePmRuntime({ driver: new CouncilChairDriver({ council, ownerTask: 'task' }), workflowRunner: runnerA, peerRelay, repository, maxTurns: 6 });
  const partial = await runtimeA.resume('pmrun_restart2');
  assert.equal(partial.status, 'failed'); // maxTurns boundary simulates the crash
  const callsAfterRound1 = calls.length;
  assert.equal(callsAfterRound1, 6);

  // "Process 2": fresh runner + fresh driver, real durable repository/
  // stepState, no cap this time — must resume exactly at round 2 (brief),
  // never re-running any round-1 step.
  const runnerB = freshRunner(resolveDriver, profileRegistry, stepState);
  const runtimeB = new DurablePmRuntime({ driver: new CouncilChairDriver({ council, ownerTask: 'task' }), workflowRunner: runnerB, peerRelay, repository, maxTurns: 20 });
  // A genuine mid-flight restart requires run.status === 'running'; force
  // that directly (the maxTurns cap above terminalized it to 'failed'
  // purely to create a deterministic crash point in this fixture — real
  // production code never does this, it is fixture-only scaffolding to
  // reach the "running, mid-round, fresh process" state under test).
  store.run('UPDATE pm_runs SET status = ? WHERE id = ?', ['running', 'pmrun_restart2']);
  const result = await runtimeB.resume('pmrun_restart2');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.debate.rounds_run, 2);
  // Exactly round 2's 3 steps (brief + 1 response (single participant) +
  // synthesis) — never round 1 again.
  assert.equal(calls.length - callsAfterRound1, 3, 'exactly round 2 (brief + 1 response + synthesis), not round 1 again');
  const round1CallsAfterResume = calls.slice(callsAfterRound1).filter((c) => c.round === 1);
  assert.deepEqual(round1CallsAfterResume, [], 'round 1 was never re-invoked after resuming at round 2');
  const round2CallsAfterResume = calls.slice(callsAfterRound1).filter((c) => c.round === 2);
  assert.equal(round2CallsAfterResume.length, 3);
}));

test('debate: final completion is idempotent — resuming an already-completed debate run replays no new backend calls', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-idem', council } });
  repository.create(request, { id: 'pmrun_idem', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const first = await runtime.resume('pmrun_idem');
  assert.equal(first.status, 'completed');
  const callsAfterFirst = calls.length;
  const second = await runtime.resume('pmrun_idem'); // DurablePmRuntime's own #continue() early-returns for a non-running run
  assert.deepEqual(second, first);
  assert.equal(calls.length, callsAfterFirst, 'no new backend call happened on the idempotent re-resume');
}));
