import test from 'node:test';
import assert from 'node:assert/strict';

import { extractChairPlan, extractParticipantSteps, extractChairSynthesis, findMarkers, buildExecutionEntries } from '../src/runtime/repo-history-extract.mjs';

function councilTurn(turn, stepKind, participantProfileId, extra = {}) {
  return {
    turn, decision: { type: 'workflow', spec: { round: extra.round ?? 1 } },
    outcome: { completedAt: `2026-01-01T00:0${turn}:00.000Z`, finalResult: { handoff: { stepKind, participantProfileId, ok: true, ...extra } } },
  };
}

const HISTORY = [
  councilTurn(0, 'chair_plan', 'chair-1', { round: 0 }),
  councilTurn(1, 'participant_report', 'p1', { round: 1, analysis: 'a1' }),
  councilTurn(2, 'participant_report', 'p2', { round: 1, analysis: 'a2' }),
  councilTurn(3, 'participant_critique', 'p1', { round: 2, criticisms: ['c1'] }),
  councilTurn(4, 'participant_critique', 'p2', { round: 2, criticisms: ['c2'] }),
  councilTurn(5, 'chair_synthesis', 'chair-1', { round: 2, output: 'final P10-T1-MARKER=ORBIT-417' }),
];

test('extractChairPlan finds exactly the chair_plan step', () => {
  const r = extractChairPlan(HISTORY);
  assert.equal(r.turn.turn, 0);
  assert.equal(r.handoff.stepKind, 'chair_plan');
});

test('extractChairPlan returns null when no chair_plan step exists (council never reached it)', () => {
  assert.equal(extractChairPlan([]), null);
});

test('extractParticipantSteps returns each report/critique in turn order, correctly attributed per profile', () => {
  const reports = extractParticipantSteps(HISTORY, 'participant_report');
  assert.deepEqual(reports.map((r) => r.profileId), ['p1', 'p2']);
  assert.equal(reports[0].handoff.analysis, 'a1');
  assert.equal(reports[1].handoff.analysis, 'a2');

  const critiques = extractParticipantSteps(HISTORY, 'participant_critique');
  assert.deepEqual(critiques.map((c) => c.profileId), ['p1', 'p2']);
  assert.deepEqual(critiques[0].handoff.criticisms, ['c1']);
  assert.deepEqual(critiques[1].handoff.criticisms, ['c2']);
});

test('extractParticipantSteps never mixes up two participants', () => {
  const reports = extractParticipantSteps(HISTORY, 'participant_report');
  const p1 = reports.find((r) => r.profileId === 'p1');
  const p2 = reports.find((r) => r.profileId === 'p2');
  assert.notEqual(p1.handoff.analysis, p2.handoff.analysis);
});

test('extractChairSynthesis finds the synthesis step', () => {
  const s = extractChairSynthesis(HISTORY);
  assert.match(s.handoff.output, /ORBIT-417/);
});

test('findMarkers extracts a MARKER=value token deterministically, without invoking any model', () => {
  assert.deepEqual(findMarkers('CHAIR SYNTHESIS ... P10-T1-MARKER=ORBIT-417 ... more text'), ['P10-T1-MARKER=ORBIT-417']);
  assert.deepEqual(findMarkers('no markers here'), []);
});

test('findMarkers dedupes repeated markers', () => {
  assert.deepEqual(findMarkers('P10-T1-MARKER=ORBIT-417 twice: P10-T1-MARKER=ORBIT-417'), ['P10-T1-MARKER=ORBIT-417']);
});

test('buildExecutionEntries produces chronological entries with TASK_ACCEPTED first', () => {
  const entries = buildExecutionEntries({ history: HISTORY, taskAcceptedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(entries[0].heading, 'TASK_ACCEPTED');
  assert.equal(entries[1].heading, 'TURN 0: CHAIR PLAN');
  assert.equal(entries[entries.length - 1].heading, 'TURN 5: CHAIR SYNTHESIS');
  // strictly increasing turn order
  const turnNumbers = entries.slice(1).map((e) => Number(e.heading.match(/^TURN (\d+):/)[1]));
  assert.deepEqual(turnNumbers, [...turnNumbers].sort((a, b) => a - b));
});

test('buildExecutionEntries includes a process pid when opportunistic evidence is supplied, and is non-fatal when absent', () => {
  const withPid = buildExecutionEntries({ history: HISTORY, stagePids: new Map([[0, 29612]]) });
  assert.equal(withPid[0].fields.process_pid, 29612);
  const withoutPid = buildExecutionEntries({ history: HISTORY });
  assert.equal(withoutPid[0].fields.process_pid, undefined);
});

test('buildExecutionEntries never invents a retry that did not happen, and represents one that did', () => {
  const repairedHistory = [councilTurn(0, 'chair_plan', 'chair-1', { round: 0, repaired: true })];
  const entries = buildExecutionEntries({ history: repairedHistory });
  assert.equal(entries[0].fields.repaired, true);
  const cleanEntries = buildExecutionEntries({ history: HISTORY });
  assert.equal(cleanEntries[0].fields.repaired, false);
});

test('buildExecutionEntries represents structured-output chair evidence when present', () => {
  const swHistory = [councilTurn(0, 'chair_plan', 'chair-1', { round: 0, structured_output: { requested: true, present: true } })];
  const entries = buildExecutionEntries({ history: swHistory });
  assert.equal(entries[0].fields.structured_output_requested, true);
  assert.equal(entries[0].fields.structured_output_present, true);
});

test('buildExecutionEntries handles a non-council (SINGLE) generic decision without stepKind', () => {
  const single = [{ turn: 0, decision: { type: 'finish' }, outcome: { status: 'completed' } }];
  const entries = buildExecutionEntries({ history: single });
  assert.equal(entries[0].heading, 'TURN 0: finish');
  assert.equal(entries[0].fields.result, 'completed');
});
