/**
 * P10-R0.2.4 — activity-aware backend liveness tracking (Part W-AB).
 *
 * Distinguishes process EXISTENCE from useful PROGRESS. `computeLivenessState()`
 * is a pure function of already-observed activity timestamps — trivially
 * unit-testable with a fake clock (Part AP), no timers, no I/O:
 *
 *   ACTIVE        — real activity evidence within `activeWindowMs`.
 *   QUIET_RUNNING — process alive, last real activity was longer ago than
 *                   `activeWindowMs` but not yet `stallThresholdMs`.
 *   STALLED       — no real activity for >= `stallThresholdMs`. This is an
 *                   OBSERVABILITY state only in this wave (Part AA/AB) — it
 *                   never triggers termination by itself; the separate,
 *                   independent hard deadline (pm-execution-timeout-
 *                   policy.mjs) is the only thing that ever kills a
 *                   process, and STALLED never extends or shortens it
 *                   (Part T/Y).
 *   EXITED        — the backend child process has exited.
 *
 * "Real activity evidence" (Part X) is deliberately narrow: a spawn, a
 * stdout/stderr byte chunk, a parser/terminal event — never a bare
 * `process.alive` check and never the liveness poller's own tick (Part Y —
 * `BackendLivenessTracker#tick()` below reads the clock, it never calls
 * `recordActivity()` on itself).
 *
 * `BackendLivenessTracker` is the stateful, per-execution-key wrapper used
 * by production code; `withBackendLiveness()` is the thin, additive
 * BackendExecutionObserver decorator that feeds it from the SAME
 * spawn/stdout/stderr/exit events backend-execution-observer.mjs already
 * emits for every backend (Part X: reuses real, already-observed evidence
 * — never a second parallel observation channel).
 */

import { EXECUTION_STAGE } from '../pm/pm-execution-timeout-policy.mjs';

export const LIVENESS_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  QUIET_RUNNING: 'QUIET_RUNNING',
  STALLED: 'STALLED',
  EXITED: 'EXITED',
});

// Part Z: no live-CLI probe evidence was collected in this wave (no owner
// authorization to spend real backend quota against Claude/Codex/OpenCode/
// Antigravity purely to time their quiet intervals — see this wave's docs
// for the honest limitation). Falling back to the task brief's own
// evidence-conservative recommendation (Part Z: "Recommended starting
// candidate only if evidence supports it: 5 minutes. Do NOT use 1-2
// minutes without evidence") rather than inventing a shorter number. Part
// AA/AB: because STALLED never triggers termination in this wave, an
// overly-conservative (long) threshold is the SAFE direction to be wrong
// in — it can only under-report STALLED, never kill a legitimately quiet
// backend.
export const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
// A short recency window: activity observed within this long ago still
// reads as ACTIVE (not just "not yet stalled").
export const DEFAULT_ACTIVE_WINDOW_MS = 15_000;
// Part AC/AQ: how often the background poller may re-check quiet
// executions for a QUIET_RUNNING -> STALLED transition. Coarse — this is a
// diagnostic re-check, never itself counted as activity (Part Y).
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Pure — Part AP's exact state table. `lastActivityAt`/`processStartedAt`
 * are epoch-ms; `now` defaults to `Date.now()` but tests always pass a
 * fake clock value explicitly.
 */
export function computeLivenessState({
  now,
  processStartedAt,
  lastActivityAt,
  exited = false,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
}) {
  if (exited) return LIVENESS_STATE.EXITED;
  const anchor = Number.isFinite(lastActivityAt) ? lastActivityAt : processStartedAt;
  if (!Number.isFinite(anchor)) return LIVENESS_STATE.QUIET_RUNNING;
  const age = Math.max(0, now - anchor);
  if (age < activeWindowMs) return LIVENESS_STATE.ACTIVE;
  if (age < stallThresholdMs) return LIVENESS_STATE.QUIET_RUNNING;
  return LIVENESS_STATE.STALLED;
}

/**
 * One execution's tracked liveness facts (Part Y — the activity clock).
 * Never mutated from outside this module; `BackendLivenessTracker` below
 * owns the map of these keyed by taskId.
 */
function freshRecord() {
  return {
    processStartedAt: null,
    lastActivityAt: null,
    lastActivityKind: null,
    lastActivityBytesDelta: null,
    lastStateChangeAt: null,
    lastState: null,
    pid: null,
    exited: false,
  };
}

export class BackendLivenessTracker {
  #records = new Map();
  #now;
  #activeWindowMs;
  #stallThresholdMs;

  constructor({ now = () => Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS, stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS } = {}) {
    this.#now = typeof now === 'function' ? now : () => now;
    this.#activeWindowMs = activeWindowMs;
    this.#stallThresholdMs = stallThresholdMs;
  }

  #record(taskId) {
    let r = this.#records.get(taskId);
    if (!r) { r = freshRecord(); this.#records.set(taskId, r); }
    return r;
  }

  /** Part Y: a real PROCESS_SPAWN — a genuine, one-time lifecycle fact, never a fake heartbeat. Resets any prior EXITED state for this taskId (a new spawn — e.g. an await_owner repair call — is a new execution). */
  onSpawn(taskId, { pid = null, timestamp = this.#now() } = {}) {
    if (!taskId) return;
    const r = this.#record(taskId);
    r.processStartedAt = timestamp;
    r.lastActivityAt = timestamp;
    r.lastActivityKind = 'PROCESS_SPAWN';
    r.lastActivityBytesDelta = null;
    r.pid = pid;
    r.exited = false;
  }

  /** Part X: real observed evidence only — stdout/stderr bytes, a parser/tool/terminal event. Never called for a bare timer tick or a process-alive check. */
  onActivity(taskId, { kind, bytesDelta = null, timestamp = this.#now() } = {}) {
    if (!taskId) return;
    const r = this.#record(taskId);
    if (r.exited) return; // Part W: activity cannot un-exit a finished execution.
    r.lastActivityAt = timestamp;
    r.lastActivityKind = kind ?? r.lastActivityKind;
    r.lastActivityBytesDelta = bytesDelta;
  }

  onExit(taskId, { timestamp = this.#now() } = {}) {
    if (!taskId) return;
    const r = this.#record(taskId);
    r.exited = true;
    r.lastStateChangeAt = timestamp;
  }

  /** Part Y: read-only snapshot; never mutates activity timestamps. */
  getState(taskId, { now = this.#now() } = {}) {
    const r = this.#records.get(taskId);
    if (!r) return null;
    const state = computeLivenessState({
      now, processStartedAt: r.processStartedAt, lastActivityAt: r.lastActivityAt, exited: r.exited,
      activeWindowMs: this.#activeWindowMs, stallThresholdMs: this.#stallThresholdMs,
    });
    return Object.freeze({
      state, pid: r.pid, processStartedAt: r.processStartedAt, lastActivityAt: r.lastActivityAt,
      lastActivityKind: r.lastActivityKind, lastActivityBytesDelta: r.lastActivityBytesDelta,
      lastActivityAgeMs: Number.isFinite(r.lastActivityAt) ? Math.max(0, now - r.lastActivityAt) : null,
      elapsedMs: Number.isFinite(r.processStartedAt) ? Math.max(0, now - r.processStartedAt) : null,
    });
  }

  /**
   * Part AE/AQ: recompute state and, if (and only if) it materially
   * changed since the last call, record the new state as `lastState` and
   * return the transition; otherwise returns `null` (Part AQ: no event
   * spam — a caller wires this to a diagnostic event ONLY on a real
   * `{from,to}` change, never on every tick).
   */
  checkTransition(taskId, { now = this.#now() } = {}) {
    const snapshot = this.getState(taskId, { now });
    if (!snapshot) return null;
    const r = this.#record(taskId);
    if (r.lastState === snapshot.state) return null;
    const from = r.lastState;
    r.lastState = snapshot.state;
    r.lastStateChangeAt = now;
    return Object.freeze({ from, to: snapshot.state, ...snapshot });
  }

  /** Bounded cleanup — call once an execution's diagnostics are no longer needed (Part AQ: this module never grows unbounded across a long-lived runtime process). */
  forget(taskId) { this.#records.delete(taskId); }
}

/**
 * Part X/AE: a thin, additive BackendExecutionObserver decorator. Every
 * method delegates to `underlying` FIRST, unchanged (byte-for-byte
 * existing behavior/timing preserved) — the liveness feed and the
 * `underlying.liveness(ctx,{...})` transition callout only ever fire
 * AFTER, and only for an execution whose `ctx.stage` is the LONG owner
 * SINGLE class (Part S: liveness tracking/visibility is scoped to LONG
 * tasks this wave — every other stage pays a single cheap string compare
 * and is otherwise untouched). A poller is started at spawn and stopped at
 * exit/terminal so a completed execution never leaves a dangling timer
 * (Part AQ); the poller's own tick is diagnostic-only and is NEVER itself
 * recorded as activity (Part Y).
 */
export function withBackendLiveness(underlying, {
  tracker = new BackendLivenessTracker(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const pollers = new Map();
  const isLong = (ctx) => ctx?.stage === EXECUTION_STAGE.OWNER_SINGLE_LONG;

  function emitTransitionIfAny(taskId, ctx) {
    const transition = tracker.checkTransition(taskId);
    if (transition) {
      try { underlying?.liveness?.(ctx, transition); } catch { /* observer failures never affect execution */ }
    }
  }

  // B4 philosophy: every underlying-observer call this decorator makes is
  // best-effort — a throwing custom/test observer must never break real
  // execution (production call sites already guard this too, e.g.
  // withSpawnObservation()'s `guarded()` — this is defense in depth so the
  // decorator is safe to call directly as well).
  function safeCall(fn) { try { fn(); } catch { /* never break execution */ } }

  function stopPoller(taskId) {
    const timer = pollers.get(taskId);
    if (timer) { try { clearIntervalImpl(timer); } catch { /* best-effort */ } pollers.delete(taskId); }
  }

  function startPoller(taskId, ctx) {
    stopPoller(taskId);
    let timer;
    try {
      timer = setIntervalImpl(() => emitTransitionIfAny(taskId, ctx), pollIntervalMs);
      timer?.unref?.(); // Part AQ: never keeps the process/tests alive.
    } catch { timer = null; }
    if (timer) pollers.set(taskId, timer);
  }

  const decorated = {
    ...underlying,
    start(ctx, ...rest) { safeCall(() => underlying?.start?.(ctx, ...rest)); },
    spawn(ctx, info = {}) {
      safeCall(() => underlying?.spawn?.(ctx, info));
      if (!isLong(ctx) || !ctx?.taskId) return;
      tracker.onSpawn(ctx.taskId, { pid: info?.pid ?? null });
      emitTransitionIfAny(ctx.taskId, ctx);
      startPoller(ctx.taskId, ctx);
    },
    stdoutChunk(ctx, info = {}) {
      safeCall(() => underlying?.stdoutChunk?.(ctx, info));
      if (!isLong(ctx) || !ctx?.taskId) return;
      tracker.onActivity(ctx.taskId, { kind: 'STDOUT_CHUNK', bytesDelta: info?.length ?? null });
      emitTransitionIfAny(ctx.taskId, ctx);
    },
    stderrChunk(ctx, info = {}) {
      safeCall(() => underlying?.stderrChunk?.(ctx, info));
      if (!isLong(ctx) || !ctx?.taskId) return;
      tracker.onActivity(ctx.taskId, { kind: 'STDERR_CHUNK' });
      emitTransitionIfAny(ctx.taskId, ctx);
    },
    parser(ctx, info = {}) {
      safeCall(() => underlying?.parser?.(ctx, info));
      if (!isLong(ctx) || !ctx?.taskId) return;
      tracker.onActivity(ctx.taskId, { kind: 'PARSER' });
      emitTransitionIfAny(ctx.taskId, ctx);
    },
    exit(ctx, info = {}) {
      safeCall(() => underlying?.exit?.(ctx, info));
      if (!isLong(ctx) || !ctx?.taskId) return;
      tracker.onExit(ctx.taskId);
      emitTransitionIfAny(ctx.taskId, ctx);
      stopPoller(ctx.taskId);
    },
    terminal(ctx, info = {}) {
      safeCall(() => underlying?.terminal?.(ctx, info));
      // Defense in depth: 'exit' always fires for a real stdio child, but
      // decide()'s own terminal event fires exactly once per decide() call
      // regardless — stopping here too guarantees no leaked poller even if
      // a test double never emits 'exit'.
      if (isLong(ctx) && ctx?.taskId) stopPoller(ctx.taskId);
    },
    timeout(ctx, info = {}) {
      safeCall(() => underlying?.timeout?.(ctx, info));
      if (isLong(ctx) && ctx?.taskId) stopPoller(ctx.taskId);
    },
    context(ctx, ...rest) { safeCall(() => underlying?.context?.(ctx, ...rest)); },
    toolDenied(ctx, ...rest) { safeCall(() => underlying?.toolDenied?.(ctx, ...rest)); },
    sandbox(ctx, ...rest) { safeCall(() => underlying?.sandbox?.(ctx, ...rest)); },
    awaitOwnerContract(ctx, ...rest) { safeCall(() => underlying?.awaitOwnerContract?.(ctx, ...rest)); },
    stdoutSummary(ctx, ...rest) { safeCall(() => underlying?.stdoutSummary?.(ctx, ...rest)); },
    liveness(ctx, ...rest) { safeCall(() => underlying?.liveness?.(ctx, ...rest)); },
    // Test/shutdown hygiene — never called by production code paths.
    __stopAllPollersForTest() { for (const taskId of [...pollers.keys()]) stopPoller(taskId); },
  };
  return Object.freeze(decorated);
}
