import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChairPlanPrompt, buildParticipantReportPrompt, buildParticipantCritiquePrompt, buildChairSynthesisPrompt,
} from '../src/pm/council/council-prompts.mjs';
import { normalizeCouncilSpec, CouncilValidationError, COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { resolveExecutionOptions, PM_PERMISSION_MODE } from '../src/pm/pm-execution-timeout-policy.mjs';

// P18-W4R6-R1 — the live canary (docs/p18/ W4R6 report) proved the
// execution-AUTHORIZATION mechanism (implementation_participant_id ->
// isImplementationParticipant -> bypassPermissions) is correct, but the
// designated participant never actually edited a file: council-prompts.mjs
// unconditionally injected the legacy P7 READ_ONLY_NOTICE into every
// council prompt, including that participant's own report step, so the
// real Claude turn complied with what its prompt said rather than what the
// CLI transport flag allowed. This suite proves the fix: the notice is now
// conditional on the SAME typed signal the permission-mode decision itself
// already uses — never a second, parallel derivation, never prompt-text
// inference.

const READ_ONLY_FRAGMENT = 'Do not modify files. Do not perform destructive actions. Do not execute tools beyond read-only analysis. Return analysis only.';
const IMPLEMENTATION_FRAGMENT = 'DESIGNATED IMPLEMENTATION PARTICIPANT';

// ---- 1/2/3: buildParticipantReportPrompt() itself, pure -------------------

test('buildParticipantReportPrompt: isImplementationParticipant true omits READ_ONLY_NOTICE and includes the scoped implementation notice', () => {
  const prompt = buildParticipantReportPrompt({
    ownerTask: 'do the tiny task', constraints: [], instructions: 'implement it', participantProfileId: 'impl-1', isImplementationParticipant: true,
  });
  assert.equal(prompt.includes(READ_ONLY_FRAGMENT), false, 'READ_ONLY_NOTICE must not appear for the designated implementer');
  assert.match(prompt, new RegExp(IMPLEMENTATION_FRAGMENT));
  assert.match(prompt, /you may edit files required by the task/i);
  assert.match(prompt, /run relevant project tests\/build commands/i);
  assert.match(prompt, /inspect repository-wide read-only Git context/i);
});

test('buildParticipantReportPrompt: isImplementationParticipant false (and the default, omitted) keeps READ_ONLY_NOTICE byte-for-byte and never includes the implementation notice', () => {
  const argsBase = { ownerTask: 'do the tiny task', constraints: [], instructions: 'review only', participantProfileId: 'p-a' };
  const explicitFalse = buildParticipantReportPrompt({ ...argsBase, isImplementationParticipant: false });
  const omitted = buildParticipantReportPrompt(argsBase);
  for (const prompt of [explicitFalse, omitted]) {
    assert.match(prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(prompt.includes(IMPLEMENTATION_FRAGMENT), false);
  }
  assert.equal(explicitFalse, omitted, 'explicit false must be identical to omitting the flag entirely');
});

// ---- implementation prompt still forbids the Git lifecycle ----------------

test('buildParticipantReportPrompt: the implementation notice explicitly forbids Git lifecycle management and states DSH owns it', () => {
  const prompt = buildParticipantReportPrompt({
    ownerTask: 'x', constraints: [], instructions: 'implement', participantProfileId: 'impl-1', isImplementationParticipant: true,
  });
  for (const phrase of [
    /do not checkout\/switch\/create a branch/i,
    /do not commit/i,
    /do not push/i,
    /do not merge/i,
    /do not reset\/clean\/stash/i,
    /DSH owns branch creation, commit, push, and publication/i,
  ]) {
    assert.match(prompt, phrase, `implementation notice must forbid: ${phrase}`);
  }
});

// ---- 4/5/6: every other council prompt builder is unchanged ---------------

test('buildChairPlanPrompt: unchanged — still carries READ_ONLY_NOTICE, no implementation notice, no new parameter accepted', () => {
  const prompt = buildChairPlanPrompt({ ownerTask: 'x', constraints: [], participantProfileIds: ['a', 'b'] });
  assert.match(prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(prompt.includes(IMPLEMENTATION_FRAGMENT), false);
});

test('buildParticipantCritiquePrompt: unchanged — still carries READ_ONLY_NOTICE regardless of who is the designated implementer', () => {
  const prompt = buildParticipantCritiquePrompt({
    ownerTask: 'x', ownReport: { recommendation: 'r', analysis: 'a' }, peerReports: [], critiqueFocus: 'f', participantProfileId: 'impl-1',
  });
  assert.match(prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(prompt.includes(IMPLEMENTATION_FRAGMENT), false);
});

test('buildChairSynthesisPrompt: unchanged — still carries READ_ONLY_NOTICE', () => {
  const prompt = buildChairSynthesisPrompt({
    ownerTask: 'x', constraints: [], reports: [], critiques: [], failures: [], synthesisFocus: 'f', degraded: false,
  });
  assert.match(prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(prompt.includes(IMPLEMENTATION_FRAGMENT), false);
});

// ---- 7: invalid implementation participant still fails closed -------------

test('normalizeCouncilSpec: an invalid implementation_participant_id still fails closed (unchanged by this round)', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['a', 'b'], implementation_participant_id: 'ghost' }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_UNKNOWN_IMPLEMENTATION_PARTICIPANT',
  );
});

// ---- 8: permission mode still resolves exactly as W4R6 proved -------------

test('resolveExecutionOptions: permission-mode derivation is completely untouched by this round', () => {
  assert.equal(resolveExecutionOptions(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT).permissionMode, PM_PERMISSION_MODE.PLAN);
  assert.equal(resolveExecutionOptions(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, { executionCapable: true }).permissionMode, PM_PERMISSION_MODE.EXECUTE);
});

// ---- end-to-end via the REAL CouncilChairDriver: prompt content matches ---
// the isImplementationParticipant flag threaded to CouncilStepWorkflowRunner,
// for every step kind in sequence, never drifting.

function completedEntry(stepKind, round, participantProfileId, extra) {
  return { decision: { type: 'workflow' }, outcome: { finalResult: { handoff: { stepKind, round, participantProfileId, ok: true, ...extra } } } };
}

test('CouncilChairDriver end-to-end: the implementation notice appears ONLY on the designated participant\'s own report step, and isImplementationParticipant never drifts from the prompt it produced', async () => {
  const council = normalizeCouncilSpec({
    chair_profile_id: 'chair-x', participant_profile_ids: ['p-a', 'p-b'], rounds: 2, implementation_participant_id: 'p-b',
  });
  const driver = new CouncilChairDriver({ council, ownerTask: 'create a tiny utility and a focused test' });
  const history = [];

  // turn 0: chair_plan
  const chairPlanDecision = await driver.decide({ turn: 0, history });
  assert.equal(chairPlanDecision.spec.isImplementationParticipant, false);
  assert.match(chairPlanDecision.spec.prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(chairPlanDecision.spec.prompt.includes(IMPLEMENTATION_FRAGMENT), false);
  history.push(completedEntry('chair_plan', 0, 'chair-x', {
    participant_instructions: { 'p-a': 'review the design', 'p-b': 'implement the utility and test' },
    critique_focus: 'verify the edit and test actually ran', synthesis_focus: 'confirm completion',
  }));

  // turn 1: participant_report for p-a (non-designated) — must stay READ_ONLY.
  const reportA = await driver.decide({ turn: 1, history });
  assert.equal(reportA.spec.stepKind, 'participant_report');
  assert.equal(reportA.spec.profileId, 'p-a');
  assert.equal(reportA.spec.isImplementationParticipant, false);
  assert.match(reportA.spec.prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(reportA.spec.prompt.includes(IMPLEMENTATION_FRAGMENT), false);
  history.push(completedEntry('participant_report', 1, 'p-a', { recommendation: 'looks fine', analysis: 'a', risks: [], uncertainties: [] }));

  // turn 2: participant_report for p-b (the designated implementer) — must
  // get the implementation notice, no READ_ONLY_NOTICE.
  const reportB = await driver.decide({ turn: 1, history });
  assert.equal(reportB.spec.stepKind, 'participant_report');
  assert.equal(reportB.spec.profileId, 'p-b');
  assert.equal(reportB.spec.isImplementationParticipant, true);
  assert.equal(reportB.spec.prompt.includes(READ_ONLY_FRAGMENT), false);
  assert.match(reportB.spec.prompt, new RegExp(IMPLEMENTATION_FRAGMENT));
  history.push(completedEntry('participant_report', 1, 'p-b', { recommendation: 'implemented', analysis: 'a', risks: [], uncertainties: [] }));

  // turn 3/4: participant_critique for both — critique is NEVER eligible for
  // execution capability, even for the designated implementer's own turn.
  const critiqueA = await driver.decide({ turn: 2, history });
  assert.equal(critiqueA.spec.stepKind, 'participant_critique');
  assert.equal(critiqueA.spec.isImplementationParticipant, false);
  assert.match(critiqueA.spec.prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  history.push(completedEntry('participant_critique', 2, critiqueA.spec.profileId, { revised_recommendation: 'r', criticisms: [], agreements: [], remaining_disagreements: [] }));

  const critiqueB = await driver.decide({ turn: 2, history });
  assert.equal(critiqueB.spec.stepKind, 'participant_critique');
  assert.equal(critiqueB.spec.isImplementationParticipant, false, 'even the designated implementer stays read-only during critique');
  assert.match(critiqueB.spec.prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(critiqueB.spec.prompt.includes(IMPLEMENTATION_FRAGMENT), false);
  history.push(completedEntry('participant_critique', 2, critiqueB.spec.profileId, { revised_recommendation: 'r', criticisms: [], agreements: [], remaining_disagreements: [] }));

  // turn 5: chair_synthesis — chair-only, never execution-capable.
  const synthesis = await driver.decide({ turn: 2, history });
  assert.equal(synthesis.spec.stepKind, 'chair_synthesis');
  assert.equal(synthesis.spec.isImplementationParticipant, false);
  assert.match(synthesis.spec.prompt, new RegExp(READ_ONLY_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(synthesis.spec.prompt.includes(IMPLEMENTATION_FRAGMENT), false);
});
