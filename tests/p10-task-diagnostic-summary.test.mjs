import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskSummaryMarkdown, buildCouncilEvidenceJson } from '../src/runtime/task-diagnostic-summary.mjs';

test('buildTaskSummaryMarkdown covers every documented section, even when sparse', () => {
  const md = buildTaskSummaryMarkdown({ taskId: 't1', projectId: 'p1', status: 'completed' });
  for (const heading of ['# DSH Task Diagnostic Summary', '## Execution Timeline', '## Terminal Result']) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /Task ID: t1/);
  assert.match(md, /status: completed/);
});

test('buildTaskSummaryMarkdown renders council participants with completed/failed annotations', () => {
  const md = buildTaskSummaryMarkdown({
    taskId: 't2', projectId: 'p1', taskMode: 'COUNCIL', chairProfileId: 'live1-claude-pm',
    participantProfileIds: ['a', 'b', 'c'], completedParticipants: ['a', 'b'], failedParticipants: ['c'],
    status: 'completed',
  });
  assert.match(md, /- a \(completed\)/);
  assert.match(md, /- b \(completed\)/);
  assert.match(md, /- c \(FAILED\)/);
});

test('buildTaskSummaryMarkdown discloses a degraded council explicitly', () => {
  const md = buildTaskSummaryMarkdown({
    taskId: 't3', taskMode: 'COUNCIL', degraded: true, status: 'completed',
    participantProfileIds: ['a', 'b', 'c'], completedParticipants: ['a', 'c'], failedParticipants: ['b'],
  });
  assert.match(md, /\*\*DEGRADED\*\*/);
  assert.match(md, /2 of 3 selected participants completed/);
  assert.doesNotMatch(md, /fewer than two/);
});

test('buildTaskSummaryMarkdown never omits error fields when present', () => {
  const md = buildTaskSummaryMarkdown({ taskId: 't4', status: 'failed', errorCode: 'COUNCIL_CHAIR_PLAN_FAILED', errorReason: 'chair failed to plan the council' });
  assert.match(md, /error_code: COUNCIL_CHAIR_PLAN_FAILED/);
  assert.match(md, /error_reason: chair failed to plan the council/);
});

test('buildCouncilEvidenceJson carries the canonical council fields and no secrets/reasoning', () => {
  const evidence = buildCouncilEvidenceJson({
    councilId: 'pmrun_1', chairProfileId: 'live1-claude-pm', participantProfileIds: ['a', 'b'],
    rounds: 2, strategy: 'independent_then_critique_then_synthesis', status: 'completed',
  });
  assert.deepEqual(evidence, {
    council_id: 'pmrun_1', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['a', 'b'],
    rounds: 2, strategy: 'independent_then_critique_then_synthesis', degraded: false,
    completed_participants: [], failed_participants: [], status: 'completed', chair_plan_repaired: false,
    chair_plan: { attempts: [], validated: null, participant_id_repair_used: false },
    structured_output: null,
  });
});
