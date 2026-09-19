import test from 'node:test';
import assert from 'node:assert/strict';

import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { buildChairPlanPrompt, buildChairPlanRepairPrompt } from '../src/pm/council/council-prompts.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };

// The exact owner-observed failure (P10-R0.1 OWNER LIVE FAILURE): the chair
// returned `live1-opencode-pm_note` instead of the canonical
// `live1-opencode-pm`. This reproduces that EXACT malformed key with a fake
// chair driver, never a real backend, per Part T.
const ALLOWED = ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'];

function chairPlanSpec(overrides = {}) {
  return {
    id: 'council:chair_plan:0', kind: 'council_step', stepKind: 'chair_plan', round: 0,
    profileId: 'live1-claude-pm',
    prompt: buildChairPlanPrompt({ ownerTask: 'P10 T1 miniqueue', constraints: [], participantProfileIds: ALLOWED }),
    participantProfileIds: ALLOWED,
    ...overrides,
  };
}

function planPayload(instructions) {
  return { type: 'finish', output: 'council plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be thorough', synthesis_focus: 'converge' } };
}

const VALID_INSTRUCTIONS = Object.fromEntries(ALLOWED.map((id) => [id, `focus for ${id}`]));
// Matches the EXACT owner-observed shape: the chair returned every correct
// id AND one extra mangled key (`_note` suffix) — an UNKNOWN_PARTICIPANT_
// INSTRUCTION, not a missing one (the owner's console showed only the
// UNKNOWN reason, with no accompanying "missing" complaint).
const MANGLED_INSTRUCTIONS = { ...VALID_INSTRUCTIONS, 'live1-opencode-pm_note': 'focus for opencode (mangled key)' };

test('T1: first chair plan with the exact live-observed mangled id (live1-opencode-pm_note) is rejected, never fuzzy-matched', async () => {
  let calls = 0;
  const resolveDriver = () => ({
    name: 'fake-chair',
    async decide() { calls += 1; return planPayload(MANGLED_INSTRUCTIONS); },
  });
  const events = [];
  const taskLog = { event: (type, fields) => events.push({ type, fields }) };
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog });
  const outcome = await runner.run(chairPlanSpec());

  // Both attempts (original + bounded repair) saw the SAME malformed
  // response here (a stubborn chair), so the plan fails closed after
  // exactly the repair bound — never a third attempt.
  assert.equal(calls, 2, 'exactly one repair re-prompt happened, no more');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /^COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION:live1-opencode-pm_note$/);
  assert.equal(outcome.finalResult.handoff.repaired, true);

  const invalidEvents = events.filter((e) => e.type === 'COUNCIL_PLAN_INVALID');
  assert.equal(invalidEvents.length, 2, 'one invalid event before repair, one after');
  assert.deepEqual(invalidEvents[0].fields.invalid_profile_ids, ['live1-opencode-pm_note']);
  assert.deepEqual(invalidEvents[0].fields.allowed_profile_ids, ALLOWED);
  assert.equal(invalidEvents[1].fields.after_repair, true);
  assert.ok(events.some((e) => e.type === 'COUNCIL_PLAN_RETRY'));
  // No fuzzy match: the canonical id never silently substitutes for the
  // mangled one anywhere in the diagnostic trail.
  assert.ok(!events.some((e) => JSON.stringify(e.fields).includes('"live1-opencode-pm":"focus')));
});

test('T2: a corrected repair (chair fixes the id on its second attempt) is accepted and participants may proceed', async () => {
  let calls = 0;
  const resolveDriver = () => ({
    name: 'fake-chair',
    async decide() {
      calls += 1;
      return calls === 1 ? planPayload(MANGLED_INSTRUCTIONS) : planPayload(VALID_INSTRUCTIONS);
    },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run(chairPlanSpec());

  assert.equal(calls, 2);
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.repaired, true);
  assert.deepEqual(outcome.finalResult.handoff.participant_instructions, VALID_INSTRUCTIONS);
});

test('T3: the repair prompt states the allowed ids verbatim and never silently substitutes/renames', () => {
  const prompt = buildChairPlanRepairPrompt({
    originalPrompt: buildChairPlanPrompt({ ownerTask: 'x', constraints: [], participantProfileIds: ALLOWED }),
    participantProfileIds: ALLOWED,
    invalidReason: 'COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION:live1-opencode-pm_note',
  });
  for (const id of ALLOWED) assert.ok(prompt.includes(id));
  assert.match(prompt, /copy these EXACTLY/i);
  assert.match(prompt, /Do not introduce any other participant id/i);
  assert.match(prompt, /live1-opencode-pm_note/); // states what was wrong, does not hide it
});

test('T4: a second invalid repair result fails closed with no third attempt (no unbounded retry)', async () => {
  let calls = 0;
  const stillMangled = { ...VALID_INSTRUCTIONS, 'live1-antigravity-gemini-high-v2': 'x' }; // a DIFFERENT mangling on the repair attempt
  const resolveDriver = () => ({
    name: 'fake-chair',
    async decide() {
      calls += 1;
      return calls === 1 ? planPayload(MANGLED_INSTRUCTIONS) : planPayload(stillMangled);
    },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run(chairPlanSpec());

  assert.equal(calls, 2, 'bounded to exactly one repair attempt, never a third');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /UNKNOWN_PARTICIPANT_INSTRUCTION:live1-antigravity-gemini-high-v2/);
});

test('T5: unknown participant is rejected — no prefix/suffix/case-normalizing fuzzy match', async () => {
  for (const badKey of ['live1-opencode-pm-note', 'LIVE1-OPENCODE-PM', 'opencode-pm', 'live1-opencode-pm ']) {
    const instructions = { ...VALID_INSTRUCTIONS };
    delete instructions['live1-opencode-pm'];
    instructions[badKey] = 'x';
    const resolveDriver = () => ({ name: 'fake', async decide() { return planPayload(instructions); } });
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
    const outcome = await runner.run(chairPlanSpec());
    assert.equal(outcome.finalResult.handoff.ok, false, `expected rejection for mangled key: ${badKey}`);
  }
});

test('T6: duplicate participant in the owner-selected set is rejected upstream (council-contracts), never reaches the chair step', async () => {
  const { normalizeCouncilSpec, CouncilValidationError } = await import('../src/pm/council/council-contracts.mjs');
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-opencode-pm', 'live1-opencode-pm'] }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_DUPLICATE_PARTICIPANT',
  );
});

test('T7: missing a required participant instruction is rejected (and is repair-eligible, matching Part D/E)', async () => {
  const instructions = { ...VALID_INSTRUCTIONS };
  delete instructions['live1-opencode-pm'];
  let calls = 0;
  const resolveDriver = () => ({ name: 'fake', async decide() { calls += 1; return planPayload(instructions); } });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run(chairPlanSpec());
  assert.equal(calls, 2, 'missing-instruction is repair-eligible');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /MISSING_PARTICIPANT_INSTRUCTION:live1-opencode-pm/);
});

test('T8: participants are never spawned before a valid chair plan — CouncilChairDriver never advances past turn 0 on a failed plan', async () => {
  const { CouncilChairDriver, CouncilOrchestrationError } = await import('../src/pm/council/council-chair-driver.mjs');
  const driver = new CouncilChairDriver({
    council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2, strategy: 'independent_then_critique_then_synthesis' },
    ownerTask: 'P10 T1',
  });
  const failedChairPlanHistory = [{
    decision: { type: 'workflow' },
    outcome: { finalResult: { handoff: { stepKind: 'chair_plan', ok: false, reason: 'COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION:live1-opencode-pm_note' } } },
  }];
  await assert.rejects(
    driver.decide({ turn: 1, history: failedChairPlanHistory }),
    (e) => e instanceof CouncilOrchestrationError && e.code === 'COUNCIL_CHAIR_PLAN_FAILED',
  );
});

test('T9: a missing critique_focus/synthesis_focus (content, not identifier) is NOT repair-eligible — fails on the first attempt', async () => {
  let calls = 0;
  const resolveDriver = () => ({
    name: 'fake',
    async decide() { calls += 1; return { type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: VALID_INSTRUCTIONS, synthesis_focus: 'x' } }; }, // missing critique_focus
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run(chairPlanSpec());
  assert.equal(calls, 1, 'content-quality failures are never repair-retried');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /MISSING_CRITIQUE_FOCUS/);
});
