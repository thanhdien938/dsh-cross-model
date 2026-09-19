/**
 * P10-R0.2.4.1 — bounded, owner-visible Telegram notifications for a LONG
 * task's runtime/liveness transitions (Part B-I).
 *
 * This is a thin, additive BackendExecutionObserver decorator — exactly
 * the same shape as backend-liveness-tracker.mjs's `withBackendLiveness()`
 * — that PIGGYBACKS on the already-computed `liveness(ctx,{from,to,...})`
 * transition callout (Part AQ: that callout already fires only on a real
 * state change, never per byte-chunk) plus `spawn`/`timeout`, and turns a
 * narrow, explicit allowlist of those into ONE bounded `notify(event)`
 * call each — never a message per activity byte/event (Part I).
 *
 * Preferred policy (Part D), deliberately conservative:
 *   - LONG_TASK_STARTED   — once, on the first real PROCESS_SPAWN.
 *   - LONG_TASK_STALLED   — always, on a transition INTO STALLED.
 *   - LONG_TASK_ACTIVE_RECOVERED — only on STALLED -> ACTIVE (proves
 *     liveness recovery without restart, Part F).
 *   - LONG_TASK_HARD_DEADLINE — once, when the 30-minute ceiling fires.
 * ACTIVE (from spawn) and QUIET_RUNNING transitions are intentionally
 * NOT notified (Part D: "do not notify ACTIVE/QUIET_RUNNING repeatedly")
 * — this keeps notification count bounded by a small, fixed set of
 * owner-meaningful transitions, never by how many activity events a
 * backend happens to produce.
 *
 * `notify` is an injected `(event) => void|Promise<void>` — every call is
 * wrapped so a throwing/rejecting notifier can never affect real backend
 * execution (B4 philosophy, matches every other observer decorator in
 * this codebase).
 */

import { EXECUTION_STAGE } from '../pm/pm-execution-timeout-policy.mjs';

export const LONG_TASK_NOTIFICATION_TYPES = Object.freeze({
  STARTED: 'LONG_TASK_STARTED',
  STALLED: 'LONG_TASK_STALLED',
  ACTIVE_RECOVERED: 'LONG_TASK_ACTIVE_RECOVERED',
  HARD_DEADLINE: 'LONG_TASK_HARD_DEADLINE',
});

export function withTelegramLongTaskNotifications(underlying, { notify = async () => {} } = {}) {
  const isLong = (ctx) => ctx?.stage === EXECUTION_STAGE.OWNER_SINGLE_LONG;
  const started = new Set(); // taskId -> already sent LONG_TASK_STARTED
  const deadlined = new Set(); // taskId -> already sent LONG_TASK_HARD_DEADLINE

  function safeCall(fn) { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* never break execution */ } }
  function safeNotify(event) { safeCall(() => notify(event)); }

  return Object.freeze({
    ...underlying,
    start(ctx, ...rest) { underlying?.start?.(ctx, ...rest); },
    spawn(ctx, info = {}) {
      underlying?.spawn?.(ctx, info);
      if (!isLong(ctx) || !ctx?.taskId) return;
      // Part C: sent once per task — a second spawn for the SAME taskId
      // (an unusual case; LONG-stage today has no await_owner repair
      // path) never re-announces "started".
      if (started.has(ctx.taskId)) return;
      started.add(ctx.taskId);
      safeNotify({
        type: LONG_TASK_NOTIFICATION_TYPES.STARTED,
        taskId: ctx.taskId, pmRunId: ctx.pmRunId ?? null, profileId: ctx.profileId ?? null,
        product: ctx.backendProduct ?? null, pid: typeof info?.pid === 'number' ? info.pid : null,
      });
    },
    liveness(ctx, transition = {}) {
      underlying?.liveness?.(ctx, transition);
      if (!isLong(ctx) || !ctx?.taskId) return;
      const { from, to, lastActivityKind, lastActivityAgeMs, elapsedMs, pid } = transition;
      if (to === 'STALLED') {
        safeNotify({
          type: LONG_TASK_NOTIFICATION_TYPES.STALLED,
          taskId: ctx.taskId, pmRunId: ctx.pmRunId ?? null, profileId: ctx.profileId ?? null,
          product: ctx.backendProduct ?? null, pid: pid ?? null,
          lastActivityKind: lastActivityKind ?? null, lastActivityAgeMs: Number.isFinite(lastActivityAgeMs) ? lastActivityAgeMs : null,
        });
        return;
      }
      if (from === 'STALLED' && to === 'ACTIVE') {
        safeNotify({
          type: LONG_TASK_NOTIFICATION_TYPES.ACTIVE_RECOVERED,
          taskId: ctx.taskId, pmRunId: ctx.pmRunId ?? null, profileId: ctx.profileId ?? null,
          product: ctx.backendProduct ?? null, pid: pid ?? null, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
        });
      }
      // Every other transition (ACTIVE from spawn, QUIET_RUNNING, EXITED)
      // is deliberately silent — Part D.
    },
    timeout(ctx, info = {}) {
      underlying?.timeout?.(ctx, info);
      if (!isLong(ctx) || !ctx?.taskId) return;
      if (deadlined.has(ctx.taskId)) return;
      deadlined.add(ctx.taskId);
      // Part G/E: HARD_DEADLINE is a DISTINCT terminal notification, never
      // worded as a stall — the only timeout class reachable at this
      // stage is the 30-minute ceiling (EXECUTION_STAGE.OWNER_SINGLE_LONG
      // never resolves any other timeoutMs).
      safeNotify({
        type: LONG_TASK_NOTIFICATION_TYPES.HARD_DEADLINE,
        taskId: ctx.taskId, pmRunId: ctx.pmRunId ?? null, profileId: ctx.profileId ?? null,
        product: ctx.backendProduct ?? null, pid: typeof info?.processPid === 'number' ? info.processPid : null,
        configuredMs: Number.isFinite(info?.timeoutMs) ? info.timeoutMs : null,
        elapsedMs: Number.isFinite(info?.elapsedMs) ? info.elapsedMs : null,
        terminationRequested: info?.terminationRequested === true,
      });
    },
    stdoutChunk(ctx, ...rest) { underlying?.stdoutChunk?.(ctx, ...rest); },
    stderrChunk(ctx, ...rest) { underlying?.stderrChunk?.(ctx, ...rest); },
    exit(ctx, ...rest) { underlying?.exit?.(ctx, ...rest); },
    terminal(ctx, ...rest) { underlying?.terminal?.(ctx, ...rest); },
    parser(ctx, ...rest) { underlying?.parser?.(ctx, ...rest); },
    context(ctx, ...rest) { underlying?.context?.(ctx, ...rest); },
    toolDenied(ctx, ...rest) { underlying?.toolDenied?.(ctx, ...rest); },
    sandbox(ctx, ...rest) { underlying?.sandbox?.(ctx, ...rest); },
    awaitOwnerContract(ctx, ...rest) { underlying?.awaitOwnerContract?.(ctx, ...rest); },
    stdoutSummary(ctx, ...rest) { underlying?.stdoutSummary?.(ctx, ...rest); },
  });
}
