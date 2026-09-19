/**
 * P10-R0.2 — pure extraction of council/single-task structure from
 * `result.history` (`DurablePmRuntime`'s own `{turn, decision, outcome}[]`
 * shape — production-pm-worker.mjs already reads this same array for
 * `finalizeTaskDiagnostics()`). No filesystem, no clock, no model call.
 *
 * This is the SAME durable data every `pm_turns.outcome` row already holds
 * (src/persistence/repositories/pm-repository.mjs) — never a second source
 * of truth, never re-derived from the runtime-diagnostic
 * `.runtime/<env>/logs/tasks/<task_id>/` bundle (Part R).
 *
 * P10-R0.2.3 Part B/C: `buildSingleExecutionEntries()` below is the ONE
 * addition this wave makes here — SINGLE (non-council) tasks only (Part R:
 * `buildExecutionEntries()` above, council's own builder, is completely
 * untouched). It is still a pure projection function (no filesystem, no
 * clock, no model call) but, unlike `buildExecutionEntries()`, it also
 * reads the OPTIONAL `events` array (a task's already-durable events.jsonl,
 * read by the caller — repo-history-materializer.mjs) strictly as
 * OPERATIONAL enrichment (PID/sandbox/exit evidence) never as a second
 * source of SEMANTIC truth (Part B) — every semantic fact (decision type,
 * terminal status, task/pm_run identity) still comes from `history`/the
 * caller's own durable parameters, exactly like every other builder in
 * this module.
 */

import { EXECUTION_STAGE } from '../pm/pm-execution-timeout-policy.mjs';

function handoffOf(turn) { return turn?.outcome?.finalResult?.handoff ?? null; }

/** The one `chair_plan` step, or null if the council never reached/validated it. */
export function extractChairPlan(history) {
  const turn = (history ?? []).find((h) => handoffOf(h)?.stepKind === 'chair_plan');
  return turn ? { turn, handoff: handoffOf(turn) } : null;
}

/** All steps of a given kind (`participant_report` / `participant_critique`), in turn order — never deduped, never reordered. */
export function extractParticipantSteps(history, stepKind) {
  return (history ?? [])
    .filter((h) => handoffOf(h)?.stepKind === stepKind)
    .map((turn) => ({ turn, handoff: handoffOf(turn), profileId: handoffOf(turn)?.participantProfileId ?? null }));
}

export function extractChairSynthesis(history) {
  const turn = (history ?? []).find((h) => handoffOf(h)?.stepKind === 'chair_synthesis');
  return turn ? { turn, handoff: handoffOf(turn) } : null;
}

/**
 * P19-D2 (docs/p19/00_...md §11 / docs/p19/03_...md) — pure extraction of
 * Debate round structure from the SAME `history` array every extractor
 * above already reads. A round appears in the returned array ONLY when at
 * least one `debate_brief`/`debate_response`/`debate_synthesis` handoff for
 * it exists in `history` — a round the debate never reached is simply
 * absent (never a placeholder/empty entry), which is what lets the
 * materializer honor "no Debate/Round-2/ directory when Round 2 never
 * ran" without any extra bookkeeping. Sorted by round number; `responses`
 * preserves turn (dispatch) order, never re-sorted or deduped.
 */
export function extractDebateRounds(history) {
  const rounds = new Map();
  const roundState = (r) => {
    if (!rounds.has(r)) rounds.set(r, { round: r, brief: null, responses: [], synthesis: null });
    return rounds.get(r);
  };
  for (const h of history ?? []) {
    const handoff = handoffOf(h);
    if (!handoff?.stepKind) continue;
    if (handoff.stepKind === 'debate_brief') roundState(handoff.round).brief = { turn: h, handoff };
    else if (handoff.stepKind === 'debate_response') roundState(handoff.round).responses.push({ turn: h, handoff, profileId: handoff.participantProfileId ?? null });
    else if (handoff.stepKind === 'debate_synthesis') roundState(handoff.round).synthesis = { turn: h, handoff };
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

/** Part Z: never model-derived — a plain deterministic regex over durable text DSH already stored (owner task text and/or chair synthesis output), so a marker like `P10-T1-MARKER=ORBIT-417` is preserved by simple string matching, not by asking a model to "remember" it. */
const MARKER_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-MARKER=[A-Za-z0-9._-]+\b/g;
export function findMarkers(text) {
  const matches = String(text ?? '').match(MARKER_RE);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Part N — chronological execution-log entries from `history`, generic over
 * SINGLE (arbitrary decision types) and COUNCIL (council_step handoffs).
 * `stagePids` is an OPTIONAL `Map<turnIndex, number>` of opportunistic PID
 * evidence (repo-history-materializer.mjs's `correlateStagePids()`) — a
 * missing entry is never fatal (Part R/AK item 25).
 */
export function buildExecutionEntries({ history, stagePids = new Map(), taskAcceptedAt = null }) {
  const entries = [];
  if (taskAcceptedAt) entries.push({ heading: 'TASK_ACCEPTED', timestamp: taskAcceptedAt, fields: {} });
  for (const h of history ?? []) {
    const handoff = handoffOf(h);
    const pid = stagePids.get(h.turn) ?? null;
    if (handoff && handoff.stepKind) {
      const label = {
        chair_plan: 'CHAIR PLAN', participant_report: 'PARTICIPANT REPORT',
        participant_critique: 'PARTICIPANT CRITIQUE', chair_synthesis: 'CHAIR SYNTHESIS',
      }[handoff.stepKind] ?? handoff.stepKind.toUpperCase();
      const fields = { profile: handoff.participantProfileId ?? '(chair)', round: h.decision?.spec?.round ?? null, result: handoff.ok ? 'ok' : `failed: ${handoff.reason ?? 'unknown'}` };
      if (handoff.stepKind === 'chair_plan') {
        fields.structured_output_requested = handoff.structured_output?.requested ?? null;
        fields.structured_output_present = handoff.structured_output?.present ?? null;
        fields.repaired = handoff.repaired === true;
      }
      if (pid !== null) fields.process_pid = pid;
      entries.push({ heading: `TURN ${h.turn}: ${label}`, timestamp: h.outcome?.completedAt ?? null, fields });
    } else {
      entries.push({ heading: `TURN ${h.turn}: ${h.decision?.type ?? 'unknown'}`, timestamp: null, fields: { result: h.outcome?.status ?? 'unknown' } });
    }
  }
  return entries;
}

// P10-R0.2.3 Part C/D/E/H/J: SINGLE-task ExecutionLog.md entries, enriched
// with the safe operational evidence DSH already durably/diagnostically
// owns. Never a raw events.jsonl dump (Part D/U) — only a small, fixed set
// of semantic fields per event kind, each already individually sanitized
// upstream (task-diagnostic-log.mjs's own field allowlists — no raw
// prompt/stdout/stderr/CoT/secrets ever reach `events` in the first
// place). `events` is optional and best-effort (Part R/AK item 25): an
// empty/missing array simply omits the operational sections below,
// exactly like a missing `stagePids` entry already does for
// `buildExecutionEntries()`.
const SINGLE_PROCESS_EVENT_KINDS = Object.freeze(['BACKEND_PROCESS_SPAWN', 'CODEX_SANDBOX_STATE', 'BACKEND_TIMEOUT', 'BACKEND_PROCESS_EXIT']);

export function buildSingleExecutionEntries({
  taskId, pmRunId, submittedVia = null, taskAcceptedAt = null, taskCompletedAt = null, status = null,
  profileId = null, profile = null, history = [], events = [], historyPathRel = null,
}) {
  const entries = [];
  entries.push({
    heading: 'TASK_ACCEPTED', timestamp: taskAcceptedAt,
    fields: { task_id: taskId ?? null, pm_run_id: pmRunId ?? null, source: submittedVia ?? 'UNKNOWN', mode: 'SINGLE' },
  });
  entries.push({
    heading: 'PM', timestamp: null,
    fields: {
      profile_id: profileId ?? 'UNKNOWN', product: profile?.product ?? null, model: profile?.model ?? null,
      reasoning: profile?.reasoning ?? null, session_kind: profile?.session_kind ?? null, transport: profile?.transport ?? null,
    },
  });

  // P10-R0.2.4 Part AU: a concise LONG-runtime summary — never a raw dump
  // of every liveness state change (that stays diagnostic-only, in
  // .runtime/'s events.jsonl); only the runtime-class decision, the hard
  // deadline that applied, and the LAST observed liveness state (if any
  // liveness event was ever recorded for this task).
  const { taskSource, runtimeClass, hardDeadlineMs } = extractTaskSourceAndRuntimeClass(events);
  if (runtimeClass === 'LONG') {
    const livenessEvents = (Array.isArray(events) ? events : []).filter((e) => e?.event_type === 'BACKEND_LIVENESS_STATE');
    const lastLiveness = livenessEvents.length ? livenessEvents[livenessEvents.length - 1] : null;
    const hardDeadlineEvents = (Array.isArray(events) ? events : []).filter((e) => e?.event_type === 'HARD_DEADLINE_REACHED');
    entries.push({
      heading: 'LONG_TASK_RUNTIME', timestamp: null,
      fields: {
        runtime_class: 'LONG', hard_deadline_ms: hardDeadlineMs ?? null,
        last_liveness_state: lastLiveness?.to ?? 'NOT RECORDED',
        last_liveness_at: lastLiveness?.timestamp ?? null,
        hard_deadline_reached: hardDeadlineEvents.length > 0,
      },
    });
    if (hardDeadlineEvents.length) {
      const hd = hardDeadlineEvents[hardDeadlineEvents.length - 1];
      entries.push({
        heading: 'HARD_DEADLINE_REACHED', timestamp: hd.timestamp ?? null,
        fields: { configured_ms: hd.configured_ms ?? null, elapsed_ms: hd.elapsed_ms ?? null, process_pid: hd.process_pid ?? null, termination_requested: hd.termination_requested === true },
      });
    }
  }
  void taskSource; // Task.md already carries the full task-source section (Part P) — never duplicated here.

  // Part E/F/H/I: pairs SPAWN[i]/CODEX_SANDBOX_STATE[i]/BACKEND_TIMEOUT[i]/
  // EXIT[i] by chronological ORDER within this task's own events.jsonl
  // (never by re-deriving a stage/attempt correlation key — Part R's
  // `correlateStagePids()` already documents why the diagnostic log's own
  // `stage` field on a SPAWN/EXIT event is unusable for that: it is always
  // the literal string "PROCESS_SPAWN"/"PROCESS_EXIT"). Correct for the
  // common SINGLE case (one spawn/exit pair); still evidence-honest (never
  // fabricated, never misattributed across tasks — `events` is already
  // scoped to exactly one task_id file) for the rarer multi-attempt case
  // (e.g. an await_owner repair spawning a second process).
  const byKind = (kind) => (Array.isArray(events) ? events : []).filter((e) => e?.event_type === kind);
  const spawnEvents = byKind('BACKEND_PROCESS_SPAWN');
  const sandboxEvents = byKind('CODEX_SANDBOX_STATE');
  const timeoutEvents = byKind('BACKEND_TIMEOUT');
  const exitEvents = byKind('BACKEND_PROCESS_EXIT');
  const pairCount = Math.max(spawnEvents.length, exitEvents.length);
  for (let i = 0; i < pairCount; i += 1) {
    const spawn = spawnEvents[i] ?? null;
    if (spawn) {
      entries.push({
        heading: 'BACKEND_PROCESS_SPAWN', timestamp: spawn.timestamp ?? null,
        fields: { product: spawn.product ?? null, process_pid: spawn.process_pid ?? 'NOT RECORDED', execution_kind: EXECUTION_STAGE.OWNER_SINGLE },
      });
    }
    const sandbox = sandboxEvents[i] ?? null;
    if (sandbox) {
      entries.push({
        heading: 'CODEX SANDBOX', timestamp: sandbox.timestamp ?? null,
        fields: {
          state: sandbox.sandbox_state ?? 'UNKNOWN', helper_resolution: sandbox.helper_resolution ?? 'UNKNOWN',
          helper_execution: sandbox.helper_execution ?? 'UNKNOWN', failure_code: sandbox.sandbox_failure_code ?? 'none',
        },
      });
    }
    const timeout = timeoutEvents[i] ?? null;
    if (timeout) {
      entries.push({
        heading: 'BACKEND_TIMEOUT', timestamp: timeout.timestamp ?? null,
        fields: {
          configured_timeout_ms: timeout.timeout_ms ?? null, elapsed_ms: timeout.elapsed_ms ?? null,
          termination_requested: timeout.termination_requested === true,
        },
      });
    }
    const exit = exitEvents[i] ?? null;
    if (exit) {
      entries.push({ heading: 'BACKEND_PROCESS_EXIT', timestamp: exit.timestamp ?? null, fields: { exit_code: exit.exit_code ?? null } });
    }
  }

  // Part C "PM RESULT" — the same durable per-turn facts the OLD builder
  // already showed (decision type / outcome status), never the raw
  // assistant output itself (Plan.md already carries that, bounded).
  for (const h of history ?? []) {
    entries.push({
      heading: `PM RESULT — TURN ${h.turn}`, timestamp: h.outcome?.completedAt ?? null,
      fields: { decision_type: h.decision?.type ?? 'unknown', result: h.outcome?.status ?? 'unknown' },
    });
  }

  entries.push({ heading: 'TASK_COMPLETED', timestamp: taskCompletedAt, fields: { status: status ?? 'unknown' } });

  // Part J: a concise REPOSITORY HANDOFF fact — synthesized rather than
  // read back from a not-yet-written HANDOFF_MATERIALIZATION_COMPLETED
  // event (that event is only logged by production-pm-worker.mjs AFTER
  // materializeTaskHistory() — which is what builds THIS file — already
  // returns; see repo-history-materializer.mjs's call site). Reaching this
  // point means materialization is genuinely proceeding to completion —
  // a throw anywhere before the atomic marker write means this file is
  // never durably committed at all (Part V of the original P10-R0.2 doc).
  if (historyPathRel) {
    entries.push({
      heading: 'REPOSITORY HANDOFF', timestamp: null,
      fields: { materialization: 'COMPLETED', history_path: historyPathRel, idempotent: 'NO' },
    });
  }

  return entries;
}

export { SINGLE_PROCESS_EVENT_KINDS };

// P10-R0.2.4 Part P: pure extraction of GIT_FILE task-source provenance +
// runtime class from a task's own already-durable events.jsonl (the SAME
// `events` array buildSingleExecutionEntries() above already reads) —
// never a second source of truth, never re-derived from Telegram/owner
// text. `TASK_SOURCE_RESOLVED`/`LONG_TASK_RUNTIME_STARTED` are emitted
// exactly once, at SUBMIT_TASK acceptance time (owner-task-controller.mjs)
// — the FIRST occurrence is authoritative (there is never more than one
// for a given task).
export function extractTaskSourceAndRuntimeClass(events = []) {
  const arr = Array.isArray(events) ? events : [];
  const sourceEvent = arr.find((e) => e?.event_type === 'TASK_SOURCE_RESOLVED') ?? null;
  const runtimeEvent = arr.find((e) => e?.event_type === 'LONG_TASK_RUNTIME_STARTED') ?? null;
  const taskSource = sourceEvent
    ? { type: sourceEvent.type ?? 'GIT_FILE', requestedRef: sourceEvent.requested_ref ?? null, resolvedCommitSha: sourceEvent.resolved_commit_sha ?? null, path: sourceEvent.path ?? null, contentSha256: sourceEvent.content_sha256 ?? null, contentBytes: sourceEvent.content_bytes ?? null }
    : null;
  return { taskSource, runtimeClass: runtimeEvent ? 'LONG' : (taskSource ? 'LONG' : 'NORMAL'), hardDeadlineMs: runtimeEvent?.hard_deadline_ms ?? null };
}

// P10-R0.2.3 Part S: a small summary-level extraction for Walkthrough.md's
// "Process / Session Evidence" section — the FIRST observed spawn/sandbox
// fact only (a pointer, not the detailed per-attempt record ExecutionLog.md
// already carries). Native session id/reuse are never inferred from PID or
// session_kind (Part G) — always `null`/`'UNKNOWN'` here, honestly, since
// DSH does not currently capture native session identity for any
// production CLI backend.
export function extractSingleProcessEvidence(events = []) {
  const arr = Array.isArray(events) ? events : [];
  const spawn = arr.find((e) => e?.event_type === 'BACKEND_PROCESS_SPAWN') ?? null;
  const sandbox = arr.find((e) => e?.event_type === 'CODEX_SANDBOX_STATE') ?? null;
  if (!spawn && !sandbox) return null;
  return {
    processObserved: Boolean(spawn),
    processPid: spawn?.process_pid ?? null,
    nativeSessionId: null,
    nativeSessionReuse: 'UNKNOWN',
    sandboxState: sandbox?.sandbox_state ?? null,
  };
}
