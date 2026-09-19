import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec, councilMaxTurns } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

/**
 * P19-D3-REMEDIATE — regression coverage for the real live-canary defect
 * (docs/p19/06_P19_D3_LIVE_DEBATE_CANARY_REPORT.md): `DurablePmRuntime`'s
 * `historyLimit` (default 12, durable-pm-runtime.mjs) truncates the turn
 * history handed to `driver.decide()` independently of `maxTurns`, and
 * `p5-production-composition.mjs`'s council branch never overrode it —
 * only `maxTurns:councilMaxTurns(council)` was passed. `CouncilChairDriver`
 * is a deterministic state machine (#stepsSoFar()/#debateStepsSoFar())
 * that requires the FULL turn history, not a bounded LLM-context window;
 * once completed turns exceed the limit, `chair_plan` (turn 0) falls out
 * of what the driver can see, throwing `COUNCIL_CHAIR_PLAN_MISSING`.
 *
 * Uses the EXACT shape the real live canary ran: 3 participants,
 * council `rounds:2`, `debate:{enabled:true,max_rounds:2}` — the smallest
 * real configuration that needs more than 12 completed turns (13, to
 * reach Round-1 debate synthesis; up to 18 for a full 2-round debate).
 * `councilMaxTurns()` for this exact spec is computed once below and
 * asserted, so this file stays correct even if that formula changes.
 */

const PROJECT = Object.freeze({ id: 'proj-d3-remediate', repo_path: '/tmp/proj-d3-remediate' });
const D3_SHAPE_SPEC = normalizeCouncilSpec({
  chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 2,
  debate: { enabled: true, max_rounds: 2 },
});

test('sanity: the D3-shaped spec needs a turn budget > 12 (this is the exact configuration that hit the live defect)', () => {
  const budget = councilMaxTurns(D3_SHAPE_SPEC);
  assert.ok(budget > 12, `councilMaxTurns for the D3 shape (${budget}) must exceed the old default historyLimit (12) for this regression suite to be meaningful`);
  // Real completed turns for a full 2-round council + 2-round debate run:
  // chair_plan(1) + reports(3) + critiques(3) + synthesis(1) = 8 council,
  // + (brief(1)+responses(3)+synthesis(1))*2 rounds = 10 debate = 18 total.
  assert.ok(budget >= 18, 'councilMaxTurns must accommodate the full 18-turn run, not just reach round-1 debate synthesis');
});

function fakeResolveDriverFactory({ debateContinueByRound = {} } = {}) {
  const calls = [];
  const resolveDriver = (profile, context = {}) => {
    if (!context.project?.repo_path) throw new Error('resolveDriver requires project.repo_path');
    const round = context.extraCtx?.round;
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        calls.push({ profileId: profile.id, stepKind, round });
        if (stepKind === 'chair_plan') {
          const participantIds = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(participantIds.map((id) => [id, `focus ${id}`]));
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be harsh', synthesis_focus: 'be concise' } };
        }
        if (stepKind === 'participant_report') return { type: 'finish', output: `${profile.id} summary`, data: { type: 'council_report', analysis: `${profile.id} analysis`, recommendation: `${profile.id} rec`, risks: [], uncertainties: [] } };
        if (stepKind === 'participant_critique') return { type: 'finish', output: `${profile.id} critique`, data: { type: 'council_critique', criticisms: [], agreements: [], revised_recommendation: `${profile.id} revised`, remaining_disagreements: [] } };
        if (stepKind === 'chair_synthesis') return { type: 'finish', output: 'FINAL SYNTHESIS TEXT', data: { type: 'council_synthesis' } };
        if (stepKind === 'debate_brief') return { type: 'finish', output: 'brief ready', data: { type: 'debate_brief', brief: `ROUND ${round} CANONICAL BRIEF` } };
        if (stepKind === 'debate_response') return { type: 'finish', output: `${profile.id} round ${round} summary`, data: { type: 'debate_response', response: `${profile.id} response for round ${round}` } };
        if (stepKind === 'debate_synthesis') {
          const continueDebate = debateContinueByRound[round] ?? false;
          return { type: 'finish', output: `DEBATE REPORT ROUND ${round}`, data: { type: 'debate_synthesis', continue_debate: continueDebate, reason: `round ${round} reason`, unresolved_questions: continueDebate ? [`unresolved after round ${round}`] : [] } };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  return { resolveDriver, calls };
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d3-remediate-'));
  const path = join(dir, 'council.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function actionsFor(resolveDriver, profileRegistry) {
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, extraCtx: (spec) => ({ round: spec.round }) });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  return { workflowRunner, peerRelay };
}

// ---- Bug reproduction: WITHOUT the fix (historyLimit left at the -------
// ---- DurablePmRuntime default, 12), the exact D3 shape fails exactly ---
// ---- the way the live canary did. -------------------------------------

test('BUG REPRODUCTION (pre-fix shape, historyLimit omitted -> default 12): the exact D3 configuration loses chair_plan and fails with COUNCIL_CHAIR_PLAN_MISSING at the former live-canary boundary', async () => fixture(async ({ repository }) => {
  const { resolveDriver } = fakeResolveDriverFactory({ debateContinueByRound: { 1: false } }); // round 1 STOP -- reproduces at the earliest possible point (turn 13), exactly like the live run
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2', 'p3']));
  const driver = new CouncilChairDriver({ council: D3_SHAPE_SPEC, ownerTask: 'D3 shape reproduction' });
  // Deliberately mirrors the UNFIXED p5-production-composition.mjs call
  // site: maxTurns generously large (so maxTurns itself is never the
  // limiting factor), historyLimit OMITTED (defaults to 12) -- this is
  // exactly the bug, isolated from the maxTurns dimension.
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 32 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-bug', council: D3_SHAPE_SPEC } });
  repository.create(request, { id: 'pmrun_bug', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_bug');

  assert.equal(result.status, 'failed', 'the unfixed configuration must reproduce a real failure, not silently succeed');
  assert.equal(result.error?.code, 'COUNCIL_CHAIR_PLAN_MISSING', 'must fail with the EXACT error code observed live, not some other failure');
  const completedTurns = repository.load('pmrun_bug').turns.filter((t) => t.phase === 'TURN_COMPLETE').length;
  assert.equal(completedTurns, 13, 'must fail at the EXACT turn count the live canary failed at (13: council 8 + debate round-1 brief/3-responses/synthesis 5)');
}));

// ---- The fix: historyLimit === maxTurns === councilMaxTurns(council) --

test('FIX (historyLimit = maxTurns = councilMaxTurns(council), matching p5-production-composition.mjs): the exact D3 configuration runs a full 2-round debate to completion, history never loses chair_plan, no COUNCIL_CHAIR_PLAN_MISSING at the former boundary', async () => fixture(async ({ repository }) => {
  // Round 1 continues (forcing the run past the former 13-turn failure
  // boundary into round 2), round 2 is engine-forced to stop regardless.
  const { resolveDriver, calls } = fakeResolveDriverFactory({ debateContinueByRound: { 1: true, 2: true } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2', 'p3']));
  const driver = new CouncilChairDriver({ council: D3_SHAPE_SPEC, ownerTask: 'D3 shape fixed' });
  // This is the EXACT fix applied at p5-production-composition.mjs:165 --
  // one shared value computed once, passed to both fields.
  const sharedTurnBudget = councilMaxTurns(D3_SHAPE_SPEC);
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: sharedTurnBudget, historyLimit: sharedTurnBudget });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-fixed', council: D3_SHAPE_SPEC } });
  repository.create(request, { id: 'pmrun_fixed', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume('pmrun_fixed');

  assert.equal(result.status, 'completed', `must complete successfully, never fail with COUNCIL_CHAIR_PLAN_MISSING or anything else (got: ${JSON.stringify(result.error)})`);
  assert.equal(result.data.type, 'council_debate');
  assert.equal(result.data.debate.rounds_run, 2, 'must reach round 2, past the former failure boundary');
  assert.equal(result.data.debate.engine_forced_stop, true, 'round 2 must still be engine-forced regardless of the fix -- the fix is scoped to history/turn budget, never the debate round cap');

  // "History remains available beyond turn 12": the completed run has 19
  // durable turns (8 council + 5+5 debate workflow steps + the final
  // `finish` decision itself, also a committed turn), all of which
  // chair_plan reconstruction depended on remaining visible for the
  // entire run.
  const completedTurns = repository.load('pmrun_fixed').turns.filter((t) => t.phase === 'TURN_COMPLETE').length;
  assert.equal(completedTurns, 19);
  assert.ok(completedTurns > 12, 'history must remain available well beyond the old 12-turn default');

  // chair_plan itself was never lost -- proven by the run reaching
  // chair_synthesis, debate round 1, AND debate round 2 at all (each of
  // those steps requires CouncilChairDriver to have successfully
  // reconstructed steps.chairPlan from history on every decide() call
  // after turn 12).
  assert.ok(calls.some((c) => c.stepKind === 'chair_plan'));
  assert.ok(calls.some((c) => c.stepKind === 'debate_synthesis' && c.round === 2));
}));

// ---- SINGLE is unaffected: no behavioral coupling exists between the ---
// ---- council branch's historyLimit and any SINGLE-task construction. --
// p5-production-composition.mjs's SINGLE branch (line ~181, unmodified
// by this fix) never set historyLimit before and still doesn't -- this
// is confirmed by the fix being scoped entirely inside the `if(council)`
// branch (see the diff), and by the existing SINGLE regression suite
// (p10-r021-council-and-single-wiring.test.mjs and the rest of the
// portable suite) staying green, unchanged, run as part of this same
// wave's regression gate -- not duplicated here.
