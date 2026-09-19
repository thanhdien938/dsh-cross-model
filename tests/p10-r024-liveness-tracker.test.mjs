import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVENESS_STATE,
  computeLivenessState,
  BackendLivenessTracker,
  withBackendLiveness,
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_STALL_THRESHOLD_MS,
} from '../src/runtime/backend-liveness-tracker.mjs';
import { EXECUTION_STAGE } from '../src/pm/pm-execution-timeout-policy.mjs';

// ---- Part AP: the pure state table ----------------------------------------

test('a freshly spawned process (activity == now) is ACTIVE', () => {
  const state = computeLivenessState({ now: 1000, processStartedAt: 1000, lastActivityAt: 1000 });
  assert.equal(state, LIVENESS_STATE.ACTIVE);
});

test('quiet interval below the active window stays ACTIVE', () => {
  const state = computeLivenessState({ now: 1000 + DEFAULT_ACTIVE_WINDOW_MS - 1, processStartedAt: 1000, lastActivityAt: 1000 });
  assert.equal(state, LIVENESS_STATE.ACTIVE);
});

test('quiet interval beyond the active window but below the stall threshold is QUIET_RUNNING', () => {
  const now = 1000 + DEFAULT_STALL_THRESHOLD_MS - 1;
  const state = computeLivenessState({ now, processStartedAt: 1000, lastActivityAt: 1000 });
  assert.equal(state, LIVENESS_STATE.QUIET_RUNNING);
});

test('quiet interval beyond the stall threshold is STALLED', () => {
  const now = 1000 + DEFAULT_STALL_THRESHOLD_MS + 1;
  const state = computeLivenessState({ now, processStartedAt: 1000, lastActivityAt: 1000 });
  assert.equal(state, LIVENESS_STATE.STALLED);
});

test('a real new activity after STALLED returns to ACTIVE', () => {
  const stalled = computeLivenessState({ now: 1000 + DEFAULT_STALL_THRESHOLD_MS + 1, processStartedAt: 1000, lastActivityAt: 1000 });
  assert.equal(stalled, LIVENESS_STATE.STALLED);
  const recovered = computeLivenessState({ now: 1000 + DEFAULT_STALL_THRESHOLD_MS + 1, processStartedAt: 1000, lastActivityAt: 1000 + DEFAULT_STALL_THRESHOLD_MS + 1 });
  assert.equal(recovered, LIVENESS_STATE.ACTIVE);
});

test('exited always reports EXITED regardless of activity recency', () => {
  const state = computeLivenessState({ now: 1000, processStartedAt: 1000, lastActivityAt: 1000, exited: true });
  assert.equal(state, LIVENESS_STATE.EXITED);
});

test('process existence alone (no activity, before window elapses) does not fabricate ACTIVE beyond what real evidence supports — it derives from processStartedAt honestly', () => {
  // No lastActivityAt at all yet (e.g. a spawn event not yet observed) —
  // must never throw/NaN; falls back to QUIET_RUNNING, never a fabricated ACTIVE.
  const state = computeLivenessState({ now: 5000, processStartedAt: null, lastActivityAt: null });
  assert.equal(state, LIVENESS_STATE.QUIET_RUNNING);
});

// ---- Part AP: BackendLivenessTracker stateful wiring -----------------------

test('process starts -> ACTIVE according to the first (spawn) event', () => {
  const tracker = new BackendLivenessTracker({ now: () => 1000 });
  tracker.onSpawn('task-1', { pid: 42, timestamp: 1000 });
  const snapshot = tracker.getState('task-1', { now: 1000 });
  assert.equal(snapshot.state, LIVENESS_STATE.ACTIVE);
  assert.equal(snapshot.pid, 42);
});

test('stdout activity -> ACTIVE', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  tracker.onActivity('task-1', { kind: 'STDOUT_CHUNK', bytesDelta: 128, timestamp: 100_000 });
  const snapshot = tracker.getState('task-1', { now: 100_000 });
  assert.equal(snapshot.state, LIVENESS_STATE.ACTIVE);
  assert.equal(snapshot.lastActivityKind, 'STDOUT_CHUNK');
});

test('tool/parser event -> ACTIVE', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  tracker.onActivity('task-1', { kind: 'PARSER', timestamp: 50_000 });
  assert.equal(tracker.getState('task-1', { now: 50_000 }).state, LIVENESS_STATE.ACTIVE);
});

test('process exit -> EXITED, and activity afterward cannot revive it', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  tracker.onExit('task-1', { timestamp: 1000 });
  assert.equal(tracker.getState('task-1', { now: 1000 }).state, LIVENESS_STATE.EXITED);
  tracker.onActivity('task-1', { kind: 'STDOUT_CHUNK', timestamp: 1001 });
  assert.equal(tracker.getState('task-1', { now: 1001 }).state, LIVENESS_STATE.EXITED);
});

test('a bare process-alive check is never itself activity — state derives only from recorded activity timestamps', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  // Multiple getState() reads ("is it alive?") do not themselves count as
  // activity — the state still progresses to STALLED once the threshold
  // elapses with zero real activity in between.
  tracker.getState('task-1', { now: 1000 });
  tracker.getState('task-1', { now: 2000 });
  const stalled = tracker.getState('task-1', { now: DEFAULT_STALL_THRESHOLD_MS + 1 });
  assert.equal(stalled.state, LIVENESS_STATE.STALLED);
});

test('a poll timer tick alone is never counted as activity (checkTransition does not call onActivity)', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  for (let i = 0; i < 20; i += 1) tracker.checkTransition('task-1', { now: i * 1000 });
  const finalState = tracker.getState('task-1', { now: DEFAULT_STALL_THRESHOLD_MS + 1 });
  assert.equal(finalState.state, LIVENESS_STATE.STALLED);
});

test('checkTransition fires only on a REAL state change, never every call (Part AQ: no event spam)', () => {
  const tracker = new BackendLivenessTracker();
  tracker.onSpawn('task-1', { pid: 1, timestamp: 0 });
  const first = tracker.checkTransition('task-1', { now: 0 }); // ACTIVE (initial, from=null)
  assert.ok(first);
  assert.equal(first.to, LIVENESS_STATE.ACTIVE);
  const repeats = [tracker.checkTransition('task-1', { now: 1 }), tracker.checkTransition('task-1', { now: 2 })];
  assert.deepEqual(repeats, [null, null]);
  const toQuiet = tracker.checkTransition('task-1', { now: DEFAULT_ACTIVE_WINDOW_MS + 1 });
  assert.ok(toQuiet);
  assert.equal(toQuiet.from, LIVENESS_STATE.ACTIVE);
  assert.equal(toQuiet.to, LIVENESS_STATE.QUIET_RUNNING);
  const toStall = tracker.checkTransition('task-1', { now: DEFAULT_STALL_THRESHOLD_MS + 1 });
  assert.ok(toStall);
  assert.equal(toStall.to, LIVENESS_STATE.STALLED);
});

test('hard deadline is independent of liveness state — the tracker never computes or enforces a deadline itself', () => {
  const tracker = new BackendLivenessTracker();
  assert.equal(typeof tracker.deadline, 'undefined');
  assert.equal('hardDeadlineMs' in tracker, false);
});

// ---- withBackendLiveness(): observer decoration, gated to LONG stage ------

function fakeUnderlyingObserver(calls) {
  return {
    start(ctx) { calls.push(['start', ctx.stage]); },
    spawn(ctx, info) { calls.push(['spawn', ctx.stage, info.pid]); },
    stdoutChunk(ctx, info) { calls.push(['stdoutChunk', ctx.stage, info.length]); },
    stderrChunk(ctx) { calls.push(['stderrChunk', ctx.stage]); },
    exit(ctx, info) { calls.push(['exit', ctx.stage, info.exitCode]); },
    terminal(ctx, info) { calls.push(['terminal', ctx.stage, info.status]); },
    liveness(ctx, transition) { calls.push(['liveness', ctx.stage, transition.from, transition.to]); },
  };
}

test('every existing observer call is forwarded unchanged regardless of stage (byte-for-byte passthrough)', () => {
  const calls = [];
  const wrapped = withBackendLiveness(fakeUnderlyingObserver(calls));
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE, taskId: 'task-normal' };
  wrapped.start(ctx);
  wrapped.spawn(ctx, { pid: 7 });
  wrapped.stdoutChunk(ctx, { length: 10 });
  wrapped.exit(ctx, { exitCode: 0 });
  wrapped.terminal(ctx, { status: 'COMPLETED' });
  assert.deepEqual(calls, [
    ['start', EXECUTION_STAGE.OWNER_SINGLE],
    ['spawn', EXECUTION_STAGE.OWNER_SINGLE, 7],
    ['stdoutChunk', EXECUTION_STAGE.OWNER_SINGLE, 10],
    ['exit', EXECUTION_STAGE.OWNER_SINGLE, 0],
    ['terminal', EXECUTION_STAGE.OWNER_SINGLE, 'COMPLETED'],
  ]);
});

test('a NORMAL-stage execution never triggers a liveness() callout (liveness is scoped to LONG this wave)', () => {
  const calls = [];
  const wrapped = withBackendLiveness(fakeUnderlyingObserver(calls));
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE, taskId: 'task-normal' };
  wrapped.spawn(ctx, { pid: 1 });
  wrapped.stdoutChunk(ctx, { length: 1 });
  wrapped.exit(ctx, { exitCode: 0 });
  assert.equal(calls.some(([kind]) => kind === 'liveness'), false);
});

test('a LONG-stage execution feeds the tracker and emits a liveness() transition on spawn', () => {
  const calls = [];
  const wrapped = withBackendLiveness(fakeUnderlyingObserver(calls), { pollIntervalMs: 999_999 });
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE_LONG, taskId: 'task-long' };
  wrapped.spawn(ctx, { pid: 99 });
  const livenessCalls = calls.filter(([kind]) => kind === 'liveness');
  assert.equal(livenessCalls.length, 1);
  assert.equal(livenessCalls[0][3], LIVENESS_STATE.ACTIVE);
  wrapped.exit(ctx, { exitCode: 0 });
});

test('the poller is stopped on exit — no leaked timer keeps a completed LONG execution alive', () => {
  const calls = [];
  let created = 0;
  let cleared = 0;
  const fakeSetInterval = (fn, ms) => { created += 1; const id = { fn, ms }; return id; };
  const fakeClearInterval = () => { cleared += 1; };
  const wrapped = withBackendLiveness(fakeUnderlyingObserver(calls), { setIntervalImpl: fakeSetInterval, clearIntervalImpl: fakeClearInterval });
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE_LONG, taskId: 'task-long-2' };
  wrapped.spawn(ctx, { pid: 1 });
  assert.equal(created, 1);
  wrapped.exit(ctx, { exitCode: 0 });
  assert.equal(cleared, 1);
});

test('an observer method that throws never breaks execution (B4 philosophy preserved)', () => {
  const throwingObserver = { spawn() { throw new Error('boom'); }, liveness() { throw new Error('boom2'); } };
  const wrapped = withBackendLiveness(throwingObserver, { pollIntervalMs: 999_999 });
  const ctx = { stage: EXECUTION_STAGE.OWNER_SINGLE_LONG, taskId: 'task-throw' };
  assert.doesNotThrow(() => wrapped.spawn(ctx, { pid: 1 }));
});
