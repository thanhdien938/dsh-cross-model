import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTerminalResult } from '../src/owner/telegram-owner-client.mjs';
import { buildTaskOutcome, EXECUTION_STATUS, LOCAL_GIT_STATUS, REMOTE_SYNC_STATUS } from '../src/pm/task-outcome-model.mjs';

// P12-R2 — the Telegram terminal-result renderer surfaces dsh_outcome
// (persisted via pm-repository.mjs's recordTaskOutcome()) ONLY when it is
// genuinely noteworthy, never adding noise to a plain DIRECT task's message.

function singleItem(overrides = {}) {
  return { runtime_facts: { notification_kind: 'TERMINAL_PM_RESULT', task_id: 'task-1', status: 'completed', pm_profile_id: 'pm-a', output: 'done', data: null, ...overrides } };
}

test('a plain completed task with no outcome data renders exactly as before (no new noise)', () => {
  const text = renderTerminalResult(singleItem());
  assert.equal(text.includes('Outcome:'), false);
});

test('a plain COMPLETED outcome (nothing requested) does not add a suffix', () => {
  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED });
  const text = renderTerminalResult(singleItem({ data: { dsh_outcome: outcome } }));
  assert.equal(text.includes('Outcome:'), false, 'a boring COMPLETED-with-nothing-requested outcome must not clutter the message');
});

test('a persistence warning (push failed after everything else passed) IS surfaced, concisely', () => {
  const outcome = buildTaskOutcome({
    executionStatus: EXECUTION_STATUS.PASSED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.FAILED,
  });
  const text = renderTerminalResult(singleItem({ data: { dsh_outcome: outcome } }));
  assert.match(text, /Outcome: COMPLETED_WITH_PERSISTENCE_WARNING/);
  assert.match(text, /Local git: LOCAL_COMMIT_VERIFIED/);
  assert.match(text, /Remote sync: REMOTE_SYNC_FAILED/);
});

test('a successful git commit+push is surfaced too, even without any warning', () => {
  const outcome = buildTaskOutcome({
    executionStatus: EXECUTION_STATUS.PASSED,
    localGitStatus: LOCAL_GIT_STATUS.VERIFIED,
    remoteSyncStatus: REMOTE_SYNC_STATUS.VERIFIED,
  });
  const text = renderTerminalResult(singleItem({ data: { dsh_outcome: outcome } }));
  assert.match(text, /Outcome: COMPLETED/);
  assert.match(text, /Local git: LOCAL_COMMIT_VERIFIED/);
  assert.match(text, /Remote sync: REMOTE_PUSH_VERIFIED/);
});

test('the outcome suffix is never rendered for a non-completed status', () => {
  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.FAILED, localGitStatus: LOCAL_GIT_STATUS.FAILED });
  const text = renderTerminalResult(singleItem({ status: 'failed', data: { dsh_outcome: outcome }, error: { message: 'boom' } }));
  assert.equal(text.includes('Outcome:'), false);
});

test('a degraded council result still shows the existing degraded disclosure AND the new outcome suffix when both apply', () => {
  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED, degraded: true, remoteSyncStatus: REMOTE_SYNC_STATUS.FAILED });
  const item = {
    runtime_facts: {
      notification_kind: 'TERMINAL_PM_RESULT', task_id: 'task-2', status: 'completed', pm_profile_id: 'chair-1', output: 'synthesis text',
      data: {
        type: 'council', chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 2,
        degraded: true, failed_participants: ['p2'], completed_participants: ['p1'],
        dsh_outcome: outcome,
      },
    },
  };
  const text = renderTerminalResult(item);
  assert.match(text, /degraded participation/);
  assert.match(text, /Outcome: COMPLETED_DEGRADED_WITH_PERSISTENCE_WARNING/);
});
