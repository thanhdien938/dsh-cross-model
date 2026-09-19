import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChairPlanPrompt } from '../src/pm/council/council-prompts.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';

// P19-D5.1R2 — chair plan / implementation-participant alignment.
//
// Live incident (docs/p19/11_...md): task-9n-VhovYdRZ3z7-JcLHwVUCMRvigcsEn.
// The chair planned the SELECTED implementation participant
// (live1-claude-code-pm) as "read-only; no file edits" — contradicting the
// bypassPermissions capability CouncilChairDriver's own
// #isImplementationParticipant() had already granted it, because
// buildChairPlanPrompt() never told the chair which participant (if any)
// that was. The participant itself detected the contradiction and honored
// the chair's text, so no implementation ever happened despite the owner
// explicitly asking for one. These tests prove the fix: the chair is now
// structurally told, the text explicitly forbids the exact contradiction
// observed live, and the no-selection path is byte-for-byte unchanged.

// ---- buildChairPlanPrompt() — pure prompt-builder level -------------------

test('no implementation participant: buildChairPlanPrompt output is byte-for-byte identical whether the param is omitted or explicitly null', () => {
  const base = { ownerTask: 'do the thing', constraints: ['c1'], participantProfileIds: ['p1', 'p2'] };
  const omitted = buildChairPlanPrompt(base);
  const explicitNull = buildChairPlanPrompt({ ...base, implementationParticipantId: null });
  assert.equal(omitted, explicitNull);
  assert.equal(omitted.includes('Implementation participant'), false, 'no new section leaks in when nothing is selected');
  assert.equal(omitted.includes('sole Council participant authorized'), false);
});

test('no implementation participant: the pre-existing L1 shape assertions still hold (regression guard, unrelated to this wave)', () => {
  const prompt = buildChairPlanPrompt({ ownerTask: 'do the thing', constraints: [], participantProfileIds: ['p1', 'p2'] });
  assert.match(prompt, /"type":"finish"/);
  assert.match(prompt, /"type":"council_plan"/);
  assert.match(prompt, /"p1"/);
  assert.match(prompt, /"p2"/);
});

test('implementation participant selected: the prompt contains the exact selected canonical profile id', () => {
  const prompt = buildChairPlanPrompt({ ownerTask: 'do the thing', constraints: [], participantProfileIds: ['p1', 'impl'], implementationParticipantId: 'impl' });
  assert.match(prompt, /Implementation participant: impl/);
});

test('implementation participant selected: the chair receives an explicit implementation-role constraint, in both directions (assign it, do not mark it read-only)', () => {
  const prompt = buildChairPlanPrompt({ ownerTask: 'do the thing', constraints: [], participantProfileIds: ['p1', 'impl'], implementationParticipantId: 'impl' });
  assert.match(prompt, /sole Council participant authorized to perform task-required repository edits\/tests/);
  assert.match(prompt, /Do not assign it a read-only-only responsibility that conflicts with this role/);
  assert.match(prompt, /Other participants remain analysis\/review only/);
});

test('reproduces the exact live contradiction: with an implementation participant selected, the prompt explicitly forbids assigning it a conflicting read-only-only role — the exact gap task-9n-VhovYdRZ3z7-JcLHwVUCMRvigcsEn exposed', () => {
  const ownerTask = 'D5.1 live execution canary retry after failure-settlement remediation. Implement a tiny disposable Node.js utility and focused test in this repository.';
  const prompt = buildChairPlanPrompt({ ownerTask, constraints: [], participantProfileIds: ['live1-claude-code-pm', 'live1-antigravity-gemini-high'], implementationParticipantId: 'live1-claude-code-pm' });
  assert.match(prompt, /Implementation participant: live1-claude-code-pm/);
  assert.match(prompt, /Do not assign it a read-only-only responsibility/);
  // The exact live contradiction text must never be the ONLY guidance the
  // chair sees for the selected participant — the corrective sentence is
  // present precisely because that is what went wrong live.
  assert.match(prompt, /sole Council participant authorized to perform task-required repository edits\/tests/);
});

// ---- CouncilChairDriver wiring — the prompt actually dispatched -----------

function driverFor(implementationParticipantId) {
  const council = normalizeCouncilSpec({
    chair_profile_id: 'chair',
    participant_profile_ids: ['p1', 'p2'],
    ...(implementationParticipantId ? { implementation_participant_id: implementationParticipantId } : {}),
  });
  return new CouncilChairDriver({ council, ownerTask: 'Implement the tiny utility and its focused test.' });
}

test('CouncilChairDriver: turn 0 chair_plan prompt carries the implementation-participant section only when one is selected', async () => {
  const withSelection = await driverFor('p2').decide({ turn: 0, history: [] });
  assert.match(withSelection.spec.prompt, /Implementation participant: p2/);

  const withoutSelection = await driverFor(null).decide({ turn: 0, history: [] });
  assert.equal(withoutSelection.spec.prompt.includes('Implementation participant'), false);
});

test('CouncilChairDriver: turn 0 chair_plan prompt is byte-for-byte identical to the no-selection form when implementation_participant_id is null (structural, not just the prompt-builder unit test above)', async () => {
  const withoutSelection = await driverFor(null).decide({ turn: 0, history: [] });
  const directCall = buildChairPlanPrompt({ ownerTask: 'Implement the tiny utility and its focused test.', constraints: [], participantProfileIds: ['p1', 'p2'] });
  assert.equal(withoutSelection.spec.prompt, directCall);
});
