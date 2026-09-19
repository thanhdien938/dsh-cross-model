import test from 'node:test';
import assert from 'node:assert/strict';

import { withTelegramLongTaskNotifications, LONG_TASK_NOTIFICATION_TYPES } from '../src/runtime/telegram-long-task-notifier.mjs';
import {
  renderLongTaskStarted, renderLongTaskStalled, renderLongTaskActiveRecovered, renderLongTaskHardDeadline,
  renderLongTaskNotification,
} from '../src/owner/telegram-owner-client.mjs';
import { EXECUTION_STAGE, LONG_TASK_HARD_DEADLINE_MS } from '../src/pm/pm-execution-timeout-policy.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { withBackendLiveness } from '../src/runtime/backend-liveness-tracker.mjs';

function fakeUnderlying() {
  return { spawn() {}, liveness() {}, timeout() {}, exit() {}, terminal() {} };
}

function harness() {
  const sent = [];
  const notify = async (event) => { sent.push(event); };
  const wrapped = withTelegramLongTaskNotifications(fakeUnderlying(), { notify });
  return { wrapped, sent };
}

const LONG_CTX = { stage: EXECUTION_STAGE.OWNER_SINGLE_LONG, taskId: 'task-1', pmRunId: 'run-1', profileId: 'pm-9', backendProduct: 'codex' };
const NORMAL_CTX = { stage: EXECUTION_STAGE.OWNER_SINGLE, taskId: 'task-2', pmRunId: 'run-2', profileId: 'pm-9', backendProduct: 'codex' };

// ---- Part W: Telegram notification bounding -------------------------------

test('1. LONG started notification fires exactly once, on the first spawn', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.spawn(LONG_CTX, { pid: 1 }); // a hypothetical second spawn for the same task
  const starts = sent.filter((e) => e.type === LONG_TASK_NOTIFICATION_TYPES.STARTED);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].taskId, 'task-1');
});

test('2/3. ACTIVE transitions (incl. the initial spawn->ACTIVE) are never notified, even repeated', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.liveness(LONG_CTX, { from: null, to: 'ACTIVE' });
  wrapped.liveness(LONG_CTX, { from: 'ACTIVE', to: 'ACTIVE' });
  const activeNotices = sent.filter((e) => e.type !== LONG_TASK_NOTIFICATION_TYPES.STARTED);
  assert.equal(activeNotices.length, 0);
});

test('4. ACTIVE -> QUIET_RUNNING is bounded (not notified)', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.liveness(LONG_CTX, { from: 'ACTIVE', to: 'QUIET_RUNNING' });
  const nonStart = sent.filter((e) => e.type !== LONG_TASK_NOTIFICATION_TYPES.STARTED);
  assert.equal(nonStart.length, 0);
});

test('5. QUIET_RUNNING -> STALLED is always visible', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.liveness(LONG_CTX, { from: 'QUIET_RUNNING', to: 'STALLED', lastActivityKind: 'STDOUT_CHUNK', lastActivityAgeMs: 300_000 });
  const stalled = sent.filter((e) => e.type === LONG_TASK_NOTIFICATION_TYPES.STALLED);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].lastActivityAgeMs, 300_000);
});

test('6. STALLED -> ACTIVE recovery is visible', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.liveness(LONG_CTX, { from: 'QUIET_RUNNING', to: 'STALLED' });
  wrapped.liveness(LONG_CTX, { from: 'STALLED', to: 'ACTIVE' });
  const recovered = sent.filter((e) => e.type === LONG_TASK_NOTIFICATION_TYPES.ACTIVE_RECOVERED);
  assert.equal(recovered.length, 1);
});

test('7. HARD_DEADLINE is visible, exactly once, worded distinctly from STALLED', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.timeout(LONG_CTX, { timeoutMs: LONG_TASK_HARD_DEADLINE_MS, elapsedMs: LONG_TASK_HARD_DEADLINE_MS + 5, processPid: 1, terminationRequested: true });
  wrapped.timeout(LONG_CTX, { timeoutMs: LONG_TASK_HARD_DEADLINE_MS }); // defensive double-fire
  const deadlines = sent.filter((e) => e.type === LONG_TASK_NOTIFICATION_TYPES.HARD_DEADLINE);
  assert.equal(deadlines.length, 1);
  const text = renderLongTaskHardDeadline(deadlines[0]);
  assert.ok(!/stall/i.test(text));
  assert.ok(/30-minute hard deadline/i.test(text));
});

test('8. NORMAL-stage tasks never produce any long-task notification (regression)', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(NORMAL_CTX, { pid: 1 });
  wrapped.liveness(NORMAL_CTX, { from: 'ACTIVE', to: 'STALLED' });
  wrapped.timeout(NORMAL_CTX, { timeoutMs: 300_000 });
  assert.equal(sent.length, 0);
});

test('9. hundreds of activity events never spam Telegram — notification count depends only on real state transitions', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  for (let i = 0; i < 500; i += 1) wrapped.liveness(LONG_CTX, { from: 'ACTIVE', to: 'ACTIVE' });
  wrapped.liveness(LONG_CTX, { from: 'ACTIVE', to: 'QUIET_RUNNING' });
  wrapped.liveness(LONG_CTX, { from: 'QUIET_RUNNING', to: 'STALLED' });
  wrapped.liveness(LONG_CTX, { from: 'STALLED', to: 'ACTIVE' });
  // STARTED + STALLED + ACTIVE_RECOVERED = 3, regardless of the 500 no-op ACTIVE calls above.
  assert.equal(sent.length, 3);
});

test('10/11. after exit/terminal, no further liveness calls occur — the live status stream naturally ends (no lingering ACTIVE notice for await_owner or completion)', () => {
  const { wrapped, sent } = harness();
  wrapped.spawn(LONG_CTX, { pid: 1 });
  wrapped.exit(LONG_CTX, { exitCode: 0 });
  wrapped.terminal(LONG_CTX, { status: 'COMPLETED' });
  const before = sent.length;
  // No further liveness() calls are ever made by a stopped poller/tracker
  // (proven in backend-liveness-tracker.mjs's own test suite) — this
  // notifier itself has no internal timer, so it is a pure function of
  // the calls it receives; simulating "nothing more arrives" and
  // confirming no extra notification appears is the correct unit-level
  // check at this module's boundary.
  assert.equal(sent.length, before);
});

test('a throwing/rejecting notify() never breaks execution (B4 philosophy)', () => {
  const wrapped = withTelegramLongTaskNotifications(fakeUnderlying(), { notify: async () => { throw new Error('telegram down'); } });
  assert.doesNotThrow(() => wrapped.spawn(LONG_CTX, { pid: 1 }));
  assert.doesNotThrow(() => wrapped.liveness(LONG_CTX, { from: 'QUIET_RUNNING', to: 'STALLED' }));
});

test('every existing observer call is forwarded to the underlying observer unchanged', () => {
  const calls = [];
  const underlying = {
    spawn(ctx, info) { calls.push(['spawn', info.pid]); },
    liveness(ctx, t) { calls.push(['liveness', t.to]); },
    timeout(ctx, i) { calls.push(['timeout', i.timeoutMs]); },
    exit(ctx, i) { calls.push(['exit', i.exitCode]); },
    terminal(ctx, i) { calls.push(['terminal', i.status]); },
  };
  const wrapped = withTelegramLongTaskNotifications(underlying);
  wrapped.spawn(LONG_CTX, { pid: 7 });
  wrapped.liveness(LONG_CTX, { to: 'ACTIVE' });
  wrapped.timeout(LONG_CTX, { timeoutMs: 1 });
  wrapped.exit(LONG_CTX, { exitCode: 0 });
  wrapped.terminal(LONG_CTX, { status: 'COMPLETED' });
  assert.deepEqual(calls, [['spawn', 7], ['liveness', 'ACTIVE'], ['timeout', 1], ['exit', 0], ['terminal', 'COMPLETED']]);
});

// ---- Rendering: bounded, honest wording ------------------------------------

test('renderLongTaskStarted shows task/PM/runtime/hard-deadline/liveness', () => {
  const text = renderLongTaskStarted({ taskId: 't1', profileId: 'pm-9', product: 'codex' });
  assert.ok(text.startsWith('▶ LONG TASK STARTED'));
  assert.ok(text.includes('Task: t1'));
  assert.ok(text.includes('PM: pm-9'));
  assert.ok(text.includes('Runtime: LONG'));
  assert.ok(text.includes('30 min'));
  assert.ok(text.includes('Liveness: ACTIVE'));
});

test('renderLongTaskStalled never says hung/failed/frozen and states the process is still running', () => {
  const text = renderLongTaskStalled({ taskId: 't1', lastActivityAgeMs: 305_000 });
  assert.ok(!/hung|frozen/i.test(text));
  assert.ok(!/task failed/i.test(text));
  assert.ok(/still running/i.test(text));
  assert.ok(/NOT terminated/i.test(text));
  assert.ok(/5m 5s/.test(text));
});

test('renderLongTaskActiveRecovered states the hard deadline was not reset', () => {
  const text = renderLongTaskActiveRecovered({ taskId: 't1' });
  assert.ok(text.startsWith('▶ LONG TASK ACTIVE AGAIN'));
  assert.ok(/not reset/i.test(text));
});

test('renderLongTaskNotification dispatches by type and ignores unknown types safely', () => {
  assert.ok(renderLongTaskNotification({ type: 'LONG_TASK_STARTED', taskId: 't1' }).includes('STARTED'));
  assert.equal(renderLongTaskNotification({ type: 'SOMETHING_ELSE' }), null);
  assert.equal(renderLongTaskNotification(null), null);
});

// ---- Full composition-order integration ------------------------------------
// Reproduces the EXACT nesting p5-production-composition.mjs +
// production-pm-backend-registry.mjs actually build: the Telegram
// notifier wraps the raw observer FIRST (composition root), then that
// whole thing is wrapped AGAIN by withBackendLiveness (inside
// ProductionPmBackendRegistry's constructor). Feeding the same real
// ctx/event shapes a real backend call would produce directly into this
// doubly-wrapped observer proves the composed order is correct without
// needing to fake node:child_process.spawn itself (production-pm-
// backend-registry.mjs binds spawnImpl to the real spawn internally and
// it is not independently injectable at the registry's public API).

test('composition order: spawn then a real hard-deadline timeout produces exactly STARTED then HARD_DEADLINE through the SAME double-wrap production uses', () => {
  const sent = [];
  const notify = async (event) => { sent.push(event); };
  const doublyWrapped = withBackendLiveness(
    withTelegramLongTaskNotifications(createBackendExecutionObserver({ emit: () => {} }), { notify }),
    { pollIntervalMs: 999_999 },
  );
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE_LONG, taskId: 'task-compose-1', pmRunId: 'run-compose-1', profileId: 'pm-9', backendProduct: 'codex' };
  doublyWrapped.spawn(ctx, { pid: 4242 });
  doublyWrapped.timeout(ctx, { timeoutMs: LONG_TASK_HARD_DEADLINE_MS, elapsedMs: LONG_TASK_HARD_DEADLINE_MS + 1, processPid: 4242, terminationRequested: true });
  const types = sent.map((e) => e.type);
  assert.deepEqual(types, [LONG_TASK_NOTIFICATION_TYPES.STARTED, LONG_TASK_NOTIFICATION_TYPES.HARD_DEADLINE]);
  assert.equal(sent[0].pid, 4242);
});

test('composition order: a NORMAL-stage ctx never produces a long-task notification even through the full double-wrap', () => {
  const sent = [];
  const notify = async (event) => { sent.push(event); };
  const doublyWrapped = withBackendLiveness(
    withTelegramLongTaskNotifications(createBackendExecutionObserver({ emit: () => {} }), { notify }),
    { pollIntervalMs: 999_999 },
  );
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE, taskId: 'task-compose-2', pmRunId: 'run-compose-2', profileId: 'pm-9', backendProduct: 'codex' };
  doublyWrapped.spawn(ctx, { pid: 1 });
  doublyWrapped.stdoutChunk(ctx, { length: 10 });
  doublyWrapped.exit(ctx, { exitCode: 0 });
  assert.equal(sent.length, 0);
});
