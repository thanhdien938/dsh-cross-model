import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderOwnerAck, renderTerminalResult, renderInteraction,
  renderLongTaskStarted, renderOwnerRead,
} from '../src/owner/telegram-owner-client.mjs';

// P18-W5 multimode correlation rendering (DSH-side gated fix, owner-
// authorized): the relay's frozen ACK-causal-correlation and task_id-based
// terminal correlation mechanism (P18-W4) works ONLY by parsing the literal
// Telegram text DSH renders -- there is no other channel. Before this
// change, renderOwnerAck()'s Council/Debate acceptance branch and
// renderTerminalResult()'s Council/Debate completed branch never emitted
// ANY "Task: <id>"/"Correlation: <id>" line at all, even though the
// underlying durable data (canonical.task_id, canonical.client_correlation_id,
// item.task_id) was already flowing through unconditionally -- a pure
// rendering-template gap, never a data-availability gap (see
// owner-task-controller.mjs:300 and this file's own
// OwnerTerminalResultNotifier.flush(), which have carried task_id/
// client_correlation_id through for Council exactly as they always have for
// SINGLE). This file proves the fix: Council/Debate now expose the SAME
// kind of authoritative, relay-parseable identity SINGLE already did,
// without changing any execution/authority/lifecycle semantics -- this is a
// presentation-layer change only.
//
// Scope explicitly EXCLUDES a terminal-message Correlation line: P18-W4's
// own terminal correlation design was deliberately task_id-only (result_
// collector.py's scan_terminal_candidates_by_task_id() "does NOT require
// any correlation marker anywhere in the message body" -- the correlation_id
// is only ever needed once, to recover the task_id from the ACK); SINGLE's
// own terminal render has never carried a Correlation line either. Adding
// one to Council/Debate's terminal only would be a new, asymmetric
// invariant with no relay-side consumer -- so, per this wave's own
// fail-closed/minimal-scope instruction, only Task: is added to the
// terminal side.

function ackResult(canonical) { return { canonical_result: canonical }; }

// ---- 1/2: SINGLE ACK -- existing behavior fully preserved ----------------

test('1: SINGLE ACK output is byte-for-byte unchanged when no correlation is supplied', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1' }), 'proj-a');
  assert.equal(ack, '✅ DSH task accepted\nProject: proj-a\nTask: task-abc123\nPM: pm-1');
});

test('2: SINGLE ACK with client correlation still renders exactly one Correlation: <id> line', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1', client_correlation_id: 'rel_marker001' }), 'proj-a');
  const matches = [...ack.matchAll(/^Correlation: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'rel_marker001');
});

// ---- 3/4: Council ACK ------------------------------------------------------

test('3: Council ACK contains exactly one authoritative Task: <task_id>', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-council001', pm_profile_id: 'chair-1',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2 },
  }), 'proj-a');
  assert.match(ack, /DSH council accepted/);
  const matches = [...ack.matchAll(/^Task: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'task-council001');
});

test('4: Council ACK with supplied correlation contains exactly one Correlation: <id>', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-council002', pm_profile_id: 'chair-1', client_correlation_id: 'rel_council002',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2 },
  }), 'proj-a');
  const matches = [...ack.matchAll(/^Correlation: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'rel_council002');
});

// ---- 5/6: Debate ACK (council + debate.enabled) ----------------------------

test('5: Debate ACK contains exactly one authoritative Task: <task_id>', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-debate001', pm_profile_id: 'chair-1',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2, debate: { enabled: true, max_rounds: 2 } },
  }), 'proj-a');
  assert.match(ack, /Debate:\nenabled, max 2 round\(s\)/);
  const matches = [...ack.matchAll(/^Task: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'task-debate001');
});

test('6: Debate ACK with supplied correlation contains exactly one Correlation: <id>', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-debate002', pm_profile_id: 'chair-1', client_correlation_id: 'rel_debate002',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2, debate: { enabled: true, max_rounds: 2 } },
  }), 'proj-a');
  const matches = [...ack.matchAll(/^Correlation: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'rel_debate002');
});

// ---- 7/8: Council FINAL terminal -------------------------------------------

test('7: Council FINAL completed terminal contains Task: <task_id>', () => {
  const text = renderTerminalResult({ runtime_facts: {
    status: 'completed', task_id: 'task-council-final-1', project_id: 'proj-a',
    output: 'chair synthesis', data: { type: 'council', chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 2, degraded: false },
  } });
  assert.match(text, /DSH council completed/);
  const matches = [...text.matchAll(/^Task: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'task-council-final-1');
});

test('7b: Council FINAL degraded-completion terminal also contains Task: <task_id>', () => {
  const text = renderTerminalResult({ runtime_facts: {
    status: 'completed', task_id: 'task-council-degraded-1', project_id: 'proj-a',
    output: 'partial synthesis', data: { type: 'council', chair_profile_id: 'chair-1', rounds: 2, degraded: true, completed_participants: ['p1'], failed_participants: ['p2'] },
  } });
  assert.match(text, /degraded participation/);
  const matches = [...text.matchAll(/^Task: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'task-council-degraded-1');
});

test('8: Council FINAL failed terminal already carries Task (generic single-PM shape, pre-existing -- council failures never enter the council-specific branch, only status===\'completed\' does)', () => {
  const text = renderTerminalResult({ runtime_facts: {
    status: 'failed', task_id: 'task-council-failed-1', pm_profile_id: 'chair-1', driver: 'council:chair-1',
    error: { message: 'all council participants failed round 1' }, data: null,
  } });
  assert.match(text, /❌ DSH task failed/);
  assert.match(text, /Task: task-council-failed-1/);
});

// ---- 9/10: Debate FINAL terminal (data.type === 'council_debate') ---------

test('9: Debate FINAL completed terminal contains Task: <task_id>', () => {
  const text = renderTerminalResult({ runtime_facts: {
    status: 'completed', task_id: 'task-debate-final-1', project_id: 'proj-a',
    output: 'debate conclusion', data: { type: 'council_debate', chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 2, debate: { rounds_run: 2 } },
  } });
  assert.match(text, /DSH council\/debate completed/);
  const matches = [...text.matchAll(/^Task: (.*)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'task-debate-final-1');
});

test('10: Debate FINAL failed/cancelled terminal already carries Task (generic single-PM shape, pre-existing)', () => {
  const failed = renderTerminalResult({ runtime_facts: {
    status: 'failed', task_id: 'task-debate-failed-1', pm_profile_id: 'chair-1', driver: 'council:chair-1',
    error: { message: 'debate round 1 aborted' }, data: null,
  } });
  assert.match(failed, /❌ DSH task failed/);
  assert.match(failed, /Task: task-debate-failed-1/);

  const cancelled = renderTerminalResult({ runtime_facts: {
    status: 'cancelled', task_id: 'task-debate-cancelled-1', pm_profile_id: 'chair-1', driver: 'council:chair-1',
    data: null,
  } });
  assert.match(cancelled, /⚪ DSH task cancelled/);
  assert.match(cancelled, /Task: task-debate-cancelled-1/);
});

// ---- 11: Correlation omitted when not supplied -----------------------------

test('11: Correlation is omitted entirely (Council and Debate ACK) when no client_correlation_id was supplied, Task still present', () => {
  const councilAck = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-council-nocorr', pm_profile_id: 'chair-1',
    council: { participant_profile_ids: ['p1'], rounds: 1 },
  }), 'proj-a');
  assert.equal(councilAck.includes('Correlation:'), false);
  assert.match(councilAck, /Task: task-council-nocorr/);

  const debateAck = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-debate-nocorr', pm_profile_id: 'chair-1',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2, debate: { enabled: true, max_rounds: 1 } },
  }), 'proj-a');
  assert.equal(debateAck.includes('Correlation:'), false);
  assert.match(debateAck, /Task: task-debate-nocorr/);
});

// ---- 12/13/14: no intermediate/progress message gains terminal-lookalike shape ----
//
// DSH has no Telegram-visible per-round/progress broadcast at all today for
// Council/Debate/implementation-participant execution (council-projection.mjs,
// the round/phase status source, is a pure DB-read projection consumed by
// Desktop polling -- it never calls this file's `send()`). The ONLY two
// Telegram messages a Council/Debate task ever produces are the acceptance
// ACK (renderOwnerAck) and the final terminal (renderTerminalResult via
// OwnerTerminalResultNotifier.flush()) -- both touched by this change, and
// both proven above to use exactly one Task: line each, never more than one
// and never on a mid-execution message that doesn't exist. These tests
// pin the two other message families that already exist near this codepath
// (LONG-task liveness notifications, AWAIT_OWNER interaction prompts) to
// prove neither one was accidentally widened into a false terminal
// lookalike by this change.

test('12/13/14: LONG-task liveness notifications remain structurally distinct from a Council/Debate final terminal', () => {
  const started = renderLongTaskStarted({ taskId: 'task-long-1', profileId: 'pm-1', product: 'codex' });
  assert.match(started, /^▶ LONG TASK STARTED/);
  assert.equal(started.includes('DSH council completed'), false);
  assert.equal(started.includes('DSH council/debate completed'), false);
  assert.equal(/^✅ DSH (council|task)/.test(started), false, 'a liveness event must never open with the terminal-acceptance/completion marker');
});

test('12/13/14b: an AWAIT_OWNER (PM-authored) interaction render is never mistaken for a system terminal -- always labeled untrusted prose', () => {
  const text = renderInteraction({ origin: 'PM', title: 'Round 1 update', prompt_text: 'participant progress note', runtime_facts: { task_id: 'task-progress-1' } });
  assert.match(text, /\[UNTRUSTED PM PROSE\]/);
  assert.equal(/^✅ DSH (council|task)/.test(text), false);
});

// ---- 15: no secret/token/env/credential/extra identifier leaked ----------

test('15: no raw task content, secret, token, env, or credential is exposed by the new identity lines', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-secret-check', pm_profile_id: 'chair-1', client_correlation_id: 'rel_secret_check',
    council: { participant_profile_ids: ['p1'], rounds: 1 },
  }), 'proj-a');
  for (const forbidden of [/token[=:]/i, /password[=:]/i, /secret[=:]/i, /BEGIN [A-Z ]*PRIVATE KEY/, /\.env/i]) {
    assert.equal(forbidden.test(ack), false, `ack must not match ${forbidden}`);
  }
  const terminal = renderTerminalResult({ runtime_facts: {
    status: 'completed', task_id: 'task-secret-check-2', project_id: 'proj-a',
    output: 'normal synthesis text', data: { type: 'council', chair_profile_id: 'chair-1', rounds: 1, degraded: false },
  } });
  for (const forbidden of [/token[=:]/i, /password[=:]/i, /secret[=:]/i, /BEGIN [A-Z ]*PRIVATE KEY/, /\.env/i]) {
    assert.equal(forbidden.test(terminal), false, `terminal must not match ${forbidden}`);
  }
});

// ---- 16: existing Telegram message chunking/bounds remain valid -----------

test('16: the Council FINAL terminal stays within the existing 3500-char bound even with the new Task line, real-sized synthesis', () => {
  const text = renderTerminalResult({ runtime_facts: {
    status: 'completed', task_id: 'task-bounds-check', project_id: 'proj-a',
    output: 'S'.repeat(5517), data: { type: 'council', chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'], rounds: 2, degraded: false },
  } });
  assert.ok(text.length <= 3500);
  assert.match(text, /Task: task-bounds-check/);
  assert.match(text, /\[TRUNCATED/);
});

test('16b: renderOwnerRead and REQUEST_CANCEL/DECIDE_INTERACTION acks are unaffected by this change', () => {
  assert.equal(renderOwnerRead('LIST', { a: 1 }), '{\n  "operation": "LIST",\n  "data": {\n    "a": 1\n  }\n}');
  const cancelAck = renderOwnerAck('REQUEST_CANCEL', ackResult({ task_id: 'task-cancel-1', cancellation: 'requested' }), 'proj-a');
  assert.equal(cancelAck, '⏳ Cancellation requested\nProject: proj-a\nTask: task-cancel-1\nStatus: requested\nWaiting for the runtime to confirm the outcome.');
});
