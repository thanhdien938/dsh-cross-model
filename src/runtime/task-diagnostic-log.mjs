/**
 * P10-R0.1 — task-scoped diagnostic log foundation (Part H-Q).
 *
 * This is OPERATIONAL/DEBUG evidence, never canonical business state (Part
 * H docstring in the spec this implements). It rides on the filesystem only
 * — no SQLite/Postgres schema change (Part S) — under the SAME
 * runtime-local data root DSH already uses for everything else that must
 * never be committed (`.runtime/<env>/...`, already 100% .gitignore'd via
 * the blanket `.runtime/` entry — Part H/Part R).
 *
 * Design (Part H-Q):
 *  - One bounded folder per accepted task: `<root>/<task_id>/`.
 *  - `events.jsonl` — chronological, sanitized, bounded NDJSON evidence
 *    (Part J/K). Appended with `event()`.
 *  - `summary.md` — human/AI-readable finalized summary (Part L), written
 *    with `finalizeSummary()`.
 *  - `council.json` — council-only structured evidence (Part M), written
 *    with `writeCouncilJson()`.
 *  - Every write is best-effort and NEVER throws back into the caller
 *    (Part P: "Logging failure must NOT cause the task itself to fail").
 *  - Every write is bounded (Part O): once `events.jsonl` would exceed its
 *    byte budget, a single `LOG_TRUNCATED` event is appended (never a
 *    silent stop) and further per-event writes for this task are skipped.
 *  - Secrets are redacted via the SAME sanitizer the durable audit trail
 *    already uses (`sanitizeAuditData` — src/orchestration/audit-sanitize.mjs),
 *    not a second bespoke redaction pass (Part N).
 *
 * This module is a pure sink: it never reads task/council state back to
 * make a decision, and nothing in the real task/council execution path
 * branches on whether a write here succeeded (matches the existing
 * `backend-execution-observer.mjs` philosophy exactly).
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeAuditData } from '../orchestration/audit-sanitize.mjs';
import { EXECUTION_STAGE } from '../pm/pm-execution-timeout-policy.mjs';

// ---- Part K: the lifecycle event vocabulary --------------------------------
export const TASK_LOG_EVENT_TYPES = Object.freeze({
  TASK_ACCEPTED: 'TASK_ACCEPTED',
  PM_RUN_CREATED: 'PM_RUN_CREATED',

  COUNCIL_PLAN_START: 'COUNCIL_PLAN_START',
  COUNCIL_PLAN_RESULT: 'COUNCIL_PLAN_RESULT',
  COUNCIL_PLAN_INVALID: 'COUNCIL_PLAN_INVALID',
  COUNCIL_PLAN_RETRY: 'COUNCIL_PLAN_RETRY',

  BACKEND_PROCESS_SPAWN: 'BACKEND_PROCESS_SPAWN',
  BACKEND_PROCESS_EXIT: 'BACKEND_PROCESS_EXIT',
  // P10-R0.2.1 Part K: a backend execution killed by DSH's own timeout
  // policy — distinct from BACKEND_PROCESS_EXIT (a normal, non-timeout
  // process end) and from the generic TASK_FAILED terminal event.
  BACKEND_TIMEOUT: 'BACKEND_TIMEOUT',
  // P23.1 §6 — forensic audit finding: the report-content plane's
  // `observer.terminal(...)` call (cli-report-backends.mjs) previously
  // reached ONLY the ephemeral `##DSH_BACKEND_EXEC##` console/Desktop
  // stream (backend-execution-observer.mjs's default sink) — never this
  // durable, task-scoped log — because 'TERMINAL' was absent from
  // FORWARDED_KINDS below. A COUNCIL/SINGLE report execution that ends in
  // TIMEOUT/PROVIDER_ERROR/etc. now leaves a durable trace here even when
  // the executive.log/report.md never materialize (P23.1's other fixes;
  // see report-invocation.mjs). Distinct from BACKEND_TIMEOUT above (a
  // DECISION-plane-only event today) — this covers every report-plane
  // terminal outcome, success or failure alike.
  BACKEND_TERMINAL: 'BACKEND_TERMINAL',
  // P10-R0.2.2 Part Q: Codex Windows sandbox readiness/execution
  // classification, forwarded from backend-execution-observer.mjs's
  // `sandbox()` event — see codex-cli-session-bridge.mjs's
  // probeCodexWindowsSandboxHelper()/classifyCodexSandboxExecution().
  CODEX_SANDBOX_STATE: 'CODEX_SANDBOX_STATE',
  // P10-R0.2.2 Part O: await_owner decision-contract validation/repair
  // evidence, forwarded from the `awaitOwnerContract()` observer event.
  AWAIT_OWNER_CONTRACT: 'AWAIT_OWNER_CONTRACT',
  API_EXECUTION_SUCCESS: 'API_EXECUTION_SUCCESS',

  // P10-R0.2.4 Part AE: long-task GIT_FILE dispatch/runtime evidence.
  // TASK_SOURCE_RESOLVED/LONG_TASK_RUNTIME_STARTED are emitted once, at
  // SUBMIT_TASK time (owner-task-controller.mjs) — never re-emitted per
  // resume/turn. BACKEND_LIVENESS_STATE is forwarded from the `liveness()`
  // observer event on a real state TRANSITION only (never per-chunk/
  // per-poll — Part AQ). HARD_DEADLINE_REACHED is forwarded alongside (not
  // instead of) BACKEND_TIMEOUT specifically when the timed-out execution
  // was the LONG owner SINGLE class (Part T/AG).
  TASK_SOURCE_RESOLVED: 'TASK_SOURCE_RESOLVED',
  LONG_TASK_RUNTIME_STARTED: 'LONG_TASK_RUNTIME_STARTED',
  BACKEND_LIVENESS_STATE: 'BACKEND_LIVENESS_STATE',
  HARD_DEADLINE_REACHED: 'HARD_DEADLINE_REACHED',

  // P10-R0.2.4.2 Part D/J/K/M: a `--task-file` dispatch that never reaches
  // canonical acceptance (task-source-resolver.mjs rejects the ref/path
  // BEFORE service.mutate() is ever called — see telegram-owner-client.mjs)
  // still gets a bounded, traceable diagnostic bundle under a distinct
  // `dispatch-<hash>` id (never a real `task-<hash>` id, never
  // PM_RUN_CREATED/BACKEND_PROCESS_SPAWN — Part K/M truthful semantics).
  // Written ONLY on a preflight failure (Part W #9/#10: zero new writes on
  // the success path, which already gets its own real task bundle).
  TASK_DISPATCH_RECEIVED: 'TASK_DISPATCH_RECEIVED',
  TASK_SOURCE_RESOLUTION_FAILED: 'TASK_SOURCE_RESOLUTION_FAILED',

  ROUND_START: 'ROUND_START',
  PARTICIPANT_START: 'PARTICIPANT_START',
  PARTICIPANT_RESULT: 'PARTICIPANT_RESULT',
  PARTICIPANT_FAILED: 'PARTICIPANT_FAILED',

  CRITIQUE_START: 'CRITIQUE_START',
  CRITIQUE_RESULT: 'CRITIQUE_RESULT',

  CHAIR_SYNTHESIS_START: 'CHAIR_SYNTHESIS_START',
  CHAIR_SYNTHESIS_RESULT: 'CHAIR_SYNTHESIS_RESULT',

  PARSER_RESULT: 'PARSER_RESULT',

  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_FAILED: 'TASK_FAILED',
  TASK_CANCELLED: 'TASK_CANCELLED',

  // Part Q — only ever emitted where real recovery evidence supports it;
  // never fabricated.
  RUNTIME_RESTART_OBSERVED: 'RUNTIME_RESTART_OBSERVED',
  TASK_RECOVERED_AFTER_RESTART: 'TASK_RECOVERED_AFTER_RESTART',

  // Part O — the bound-exceeded marker itself.
  LOG_TRUNCATED: 'LOG_TRUNCATED',
});

// Part O: explicit, small MVP bounds.
export const MAX_EVENTS_LOG_BYTES = 4 * 1024 * 1024; // 4 MB per task's events.jsonl
export const MAX_SUMMARY_BYTES = 256 * 1024; // 256 KB
export const MAX_COUNCIL_JSON_BYTES = 1024 * 1024; // 1 MB

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sanitizeTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new TypeError('taskId is invalid for a diagnostic log path');
  }
  return taskId;
}

/** Deterministic, path-traversal-safe folder for one task's diagnostic bundle. */
export function taskLogDir(runtimeRoot, taskId) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot) throw new TypeError('runtimeRoot is required');
  return join(runtimeRoot, sanitizeTaskId(taskId));
}

function safeAppendLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function currentFileBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * One task's diagnostic bundle. Stateless/cheap to construct — every method
 * resolves its own path and opens/closes the file per call (Part Q: this is
 * what makes the bundle trivially restart-safe — there is no in-memory
 * handle that a process restart could lose or leave corrupt).
 */
export class TaskDiagnosticLog {
  #dir; #eventsPath; #truncatedMarkerPath; #taskId; #projectId; #pmRunId; #taskMode; #onWarning;

  constructor({ runtimeRoot, taskId, projectId = null, pmRunId = null, taskMode = 'SINGLE', onWarning = null }) {
    this.#taskId = sanitizeTaskId(taskId);
    this.#dir = taskLogDir(runtimeRoot, this.#taskId);
    this.#eventsPath = join(this.#dir, 'events.jsonl');
    this.#truncatedMarkerPath = join(this.#dir, '.truncated');
    this.#projectId = projectId ?? null;
    this.#pmRunId = pmRunId ?? null;
    this.#taskMode = taskMode ?? 'SINGLE';
    this.#onWarning = typeof onWarning === 'function' ? onWarning : null;
  }

  get taskId() { return this.#taskId; }
  get dir() { return this.#dir; }

  /** Bind (or rebind) the pm_run_id once it becomes known — additive only. */
  withPmRunId(pmRunId) {
    return new TaskDiagnosticLog({ runtimeRoot: dirname(this.#dir), taskId: this.#taskId, projectId: this.#projectId, pmRunId, taskMode: this.#taskMode, onWarning: this.#onWarning });
  }

  #warn(stage, error) {
    if (!this.#onWarning) return;
    try { this.#onWarning({ stage, taskId: this.#taskId, message: error?.message ?? String(error ?? 'unknown') }); } catch { /* Part P: never throw from a warning sink either */ }
  }

  /**
   * Append one sanitized, chronological event (Part J/K). Never throws
   * (Part P) — returns `true`/`false` for callers that want to know, but no
   * caller in the real task/council path is required to check it.
   */
  event(eventType, fields = {}) {
    try {
      if (typeof eventType !== 'string' || !eventType) return false;
      if (eventType !== TASK_LOG_EVENT_TYPES.LOG_TRUNCATED && existsSync(this.#truncatedMarkerPath)) return false;
      const envelope = {
        timestamp: new Date().toISOString(),
        task_id: this.#taskId,
        project_id: this.#projectId,
        pm_run_id: this.#pmRunId,
        task_mode: this.#taskMode,
        event_type: eventType,
        ...sanitizeAuditData(fields && typeof fields === 'object' ? fields : {}),
      };
      const line = JSON.stringify(envelope);
      if (eventType !== TASK_LOG_EVENT_TYPES.LOG_TRUNCATED && currentFileBytes(this.#eventsPath) + line.length + 1 > MAX_EVENTS_LOG_BYTES) {
        this.#truncate();
        return false;
      }
      const ok = safeAppendLine(this.#eventsPath, line);
      if (!ok) this.#warn('events.jsonl append failed', new Error('append failed'));
      return ok;
    } catch (error) {
      this.#warn('event', error);
      return false;
    }
  }

  #truncate() {
    try {
      if (existsSync(this.#truncatedMarkerPath)) return;
      const marker = JSON.stringify({
        timestamp: new Date().toISOString(), task_id: this.#taskId, project_id: this.#projectId,
        pm_run_id: this.#pmRunId, task_mode: this.#taskMode, event_type: TASK_LOG_EVENT_TYPES.LOG_TRUNCATED,
        reason: 'EVENTS_LOG_BYTES_BOUND_EXCEEDED', max_bytes: MAX_EVENTS_LOG_BYTES,
      });
      // Always announce truncation, even though the file is already at its
      // bound — Part O forbids a silent stop, so this one line is exempt
      // from the size check that triggered it.
      safeAppendLine(this.#eventsPath, marker);
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(this.#truncatedMarkerPath, `${marker}\n`, 'utf8');
    } catch (error) {
      this.#warn('truncation marker', error);
    }
  }

  /** Part L — finalize the human/AI-readable summary. Bounded, atomic, non-fatal. */
  finalizeSummary(markdown) {
    try {
      const text = String(markdown ?? '');
      const bounded = text.length > MAX_SUMMARY_BYTES ? `${text.slice(0, MAX_SUMMARY_BYTES)}\n\n[TRUNCATED — summary exceeded ${MAX_SUMMARY_BYTES}-byte budget]` : text;
      atomicWrite(join(this.#dir, 'summary.md'), bounded);
      return true;
    } catch (error) {
      this.#warn('summary.md', error);
      return false;
    }
  }

  /** Part M — council-only structured evidence. Sanitized, bounded, atomic, non-fatal. */
  writeCouncilJson(data) {
    try {
      const sanitized = sanitizeAuditData(data ?? {});
      const json = JSON.stringify(sanitized, null, 2);
      const bounded = json.length > MAX_COUNCIL_JSON_BYTES ? `${json.slice(0, MAX_COUNCIL_JSON_BYTES)}\n/* TRUNCATED */` : json;
      atomicWrite(join(this.#dir, 'council.json'), bounded);
      return true;
    } catch (error) {
      this.#warn('council.json', error);
      return false;
    }
  }
}

/**
 * Build a bound "create a log for this task" factory from one runtime root
 * — the composition root's single place to decide where task bundles live
 * (default convention: sibling `logs/tasks` next to the runtime's SQLite
 * file — see docs/p10/03_TASK_DIAGNOSTIC_LOG_CONTRACT.md).
 */
export function createTaskDiagnosticLogFactory({ runtimeRoot, onWarning = null }) {
  return ({ taskId, projectId = null, pmRunId = null, taskMode = 'SINGLE' }) =>
    new TaskDiagnosticLog({ runtimeRoot, taskId, projectId, pmRunId, taskMode, onWarning });
}

/**
 * P10-R0.1.1 Part L: a pure, directly-testable bridge from ONE
 * BackendExecutionObserver event (src/runtime/backend-execution-observer.mjs)
 * to a task-scoped `BACKEND_PROCESS_SPAWN`/`BACKEND_PROCESS_EXIT` diagnostic
 * event, keyed by the `taskId` correlation field a council/single-mode
 * `extraCtx` already carries (p5-production-composition.mjs's
 * `createRuntime()`). Deliberately narrow — only PROCESS_SPAWN/PROCESS_EXIT
 * are forwarded (never stdout/stderr/context chunks, which stay
 * Backend-Execution-only) — this is a correlation projection, not a second
 * source of truth (Part L). Returns `true`/`false`; never throws (Part P —
 * its only caller wraps it anyway, but it is safe standalone too).
 */
export function forwardBackendEventToTaskLog(event, taskDiagnosticsFactory) {
  try {
    if (!event || !taskDiagnosticsFactory) return false;
    // P10-R0.2.1/R0.2.2: 'TIMEOUT'/'CODEX_SANDBOX'/'AWAIT_OWNER_CONTRACT'
    // (backend-execution-observer.mjs's new observer methods) are forwarded
    // alongside PROCESS_SPAWN/PROCESS_EXIT — still a narrow, explicit
    // allowlist (never stdout/stderr/context chunks), just longer.
    // P23.1 §6: 'TERMINAL' added — see BACKEND_TERMINAL docstring above.
    const FORWARDED_KINDS = new Set(['CANONICALIZATION', 'CANONICALIZATION_USAGE', 'PROCESS_SPAWN', 'PROCESS_EXIT', 'PARSER', 'TIMEOUT', 'TERMINAL', 'CODEX_SANDBOX', 'AWAIT_OWNER_CONTRACT', 'BACKEND_LIVENESS_STATE', 'API_USAGE']);
    if (!FORWARDED_KINDS.has(event.eventKind) && !(event.invocation_role === 'canonicalizer' && ['START','TERMINAL'].includes(event.eventKind))) return false;
    if (!event.taskId) return false;
    const taskLog = taskDiagnosticsFactory({
      taskId: event.taskId, projectId: event.projectId ?? null, pmRunId: event.pmRunId ?? null,
      taskMode: event.taskMode ?? (event.councilId ? 'COUNCIL' : 'SINGLE'),
    });
    if (event.invocation_role === 'canonicalizer' && ['START','TERMINAL'].includes(event.eventKind)) return taskLog.event('CANONICALIZER_INVOCATION', {profile_id:event.profileId,source_profile:event.source_profile,source_step:event.source_step,attempt_ordinal:1,invocation_role:'canonicalizer',state:event.eventKind,status:event.status,duration_ms:event.durationMs});
    if (event.eventKind === 'CANONICALIZATION' || event.eventKind === 'CANONICALIZATION_USAGE') {
      return taskLog.event(event.eventKind, {profile_id:event.profileId, source_profile:event.source_profile??event.profileId, invocation_role:event.invocation_role??'pm', canonicalization:event.canonicalization??null, token_usage:event.token_usage??null});
    }
    if (event.eventKind === 'TIMEOUT') {
      // P10-R0.2.1 Part K/N: structural evidence only — never the raw
      // stdout/stderr text the underlying bridge error may still carry
      // (createCliPmDriver()'s observe(observer,'timeout',...) call in
      // production-pm-backend-registry.mjs never reads those fields off
      // the error, so there is nothing raw to accidentally forward here).
      const wrote = taskLog.event('BACKEND_TIMEOUT', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null, process_pid: event.pid ?? null,
        attempt: event.attempt ?? null, stage: event.stage ?? event.phase ?? null,
        timeout_ms: event.timeoutMs ?? null, elapsed_ms: event.durationMs ?? null,
        stdout_bytes: event.stdoutBytes ?? null, stderr_bytes: event.stderrBytes ?? null,
        assistant_output_present: event.assistantOutputPresent ?? null,
        termination_requested: event.terminationRequested === true,
      });
      // P10-R0.2.4 Part T/AG: a DISTINCT event, additive to (never instead
      // of) BACKEND_TIMEOUT above, only when the timed-out execution was
      // the LONG owner SINGLE class — this is the one place "the 30-minute
      // absolute ceiling actually fired" becomes structurally queryable
      // without re-deriving it from `stage` on the generic BACKEND_TIMEOUT
      // event every time.
      if ((event.stage ?? event.phase) === EXECUTION_STAGE.OWNER_SINGLE_LONG) {
        taskLog.event('HARD_DEADLINE_REACHED', {
          timeout_kind: 'HARD_DEADLINE', configured_ms: event.timeoutMs ?? null, elapsed_ms: event.durationMs ?? null,
          process_pid: event.pid ?? null, stdout_bytes: event.stdoutBytes ?? null, stderr_bytes: event.stderrBytes ?? null,
          assistant_output_present: event.assistantOutputPresent ?? null, termination_requested: event.terminationRequested === true,
        });
      }
      return wrote;
    }
    if (event.eventKind === 'PARSER') {
      // SINGLE parity: structural facts only; never persist assistant text.
      // Council/Debate retain their existing direct PARSER_RESULT writer.
      if (event.taskMode !== 'SINGLE') return false;
      return taskLog.event('PARSER_RESULT', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null,
        stage: event.stage ?? event.phase ?? null, parser_outcome: event.parserOutcome ?? null,
        output_bytes: Number.isFinite(event.outputByteLength) ? event.outputByteLength : null,
        first_char: typeof event.firstChar === 'string' ? event.firstChar.slice(0, 1) : null,
        last_char: typeof event.lastChar === 'string' ? event.lastChar.slice(0, 1) : null,
        first_char_class: event.firstCharClass ?? null, last_char_class: event.lastCharClass ?? null,
        full_json_candidate: event.fullJson === true, json_fence_candidate: event.jsonFence === true,
        prefix_class: event.prefixClass ?? null, suffix_class: event.suffixClass ?? null,
        parse_subreason: event.parseSubreason ?? null,
      });
    }
    if (event.eventKind === 'BACKEND_LIVENESS_STATE') {
      return taskLog.event('BACKEND_LIVENESS_STATE', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null, process_pid: event.pid ?? null,
        stage: event.stage ?? null, from: event.livenessFrom ?? null, to: event.livenessTo ?? null,
        last_activity_kind: event.lastActivityKind ?? null, last_activity_age_ms: event.lastActivityAgeMs ?? null,
        elapsed_ms: event.durationMs ?? null,
      });
    }
    if (event.eventKind === 'CODEX_SANDBOX') {
      // P10-R0.2.2 Part Q: sandbox_state / sandbox_failure_code /
      // helper_resolution / helper_execution — structural facts only,
      // never a raw path dump beyond the already-sanitized executable/
      // resources paths this whole probe is built on (never a secret,
      // never a full env dump).
      return taskLog.event('CODEX_SANDBOX_STATE', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null, stage: event.stage ?? null,
        sandbox_state: event.sandboxState ?? null, sandbox_failure_code: event.sandboxFailureCode ?? null,
        helper_resolution: event.helperResolution ?? null, helper_execution: event.helperExecution ?? null,
      });
    }
    if (event.eventKind === 'AWAIT_OWNER_CONTRACT') {
      return taskLog.event('AWAIT_OWNER_CONTRACT', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null, stage: event.stage ?? null,
        decision_type: event.decisionType ?? null, normalization_result: event.normalizationResult ?? null,
        normalization_error: event.normalizationError ?? null, allowed_response_count: event.allowedResponseCount ?? null,
        allowed_response_tokens_valid: event.allowedResponseTokensValid ?? null,
        repair_attempted: event.repairAttempted === true, repair_result: event.repairResult ?? null,
      });
    }
    if (event.eventKind === 'TERMINAL') {
      // P23.1 §6 — durable terminal lifecycle evidence for the
      // report-content plane. `execution_id`/`invocation_id` let this be
      // correlated to the exact attempt even when no executive.log/
      // report.md exists (a non-SUCCESS terminal result). One event per
      // runReport() call (cli-report-backends.mjs calls observe(...,
      // 'terminal', ...) exactly once) — never duplicated per retry, since
      // each attempt/execution_id is itself distinct.
      return taskLog.event('BACKEND_TERMINAL', {
        execution_id: event.runId ?? null, invocation_id: event.invocationId ?? null,
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null, stage: event.stage ?? null,
        terminal_state: event.terminalState ?? null, ui_status: event.status ?? null, error_code: event.errorCode ?? null,
        duration_ms: Number.isFinite(event.durationMs) ? event.durationMs : null,
      });
    }
    if (event.eventKind === 'API_USAGE') {
      return taskLog.event('API_EXECUTION_SUCCESS', {
        profile_id: event.profileId ?? null, product: event.backendProduct ?? null,
        provider: event.provider ?? null, requested_model: event.requestedModel ?? null,
        returned_model: event.returnedModel ?? null, http_status: event.httpStatus ?? null,
        provider_request_id: event.providerRequestId ?? null, usage: event.usage ?? null,
        request_fields: event.requestFields ?? null,
        duration_ms: event.durationMs ?? null, streaming: event.streaming === true,
      });
    }
    return taskLog.event(event.eventKind === 'PROCESS_SPAWN' ? 'BACKEND_PROCESS_SPAWN' : 'BACKEND_PROCESS_EXIT', {
      profile_id: event.profileId ?? null, product: event.backendProduct ?? null, process_pid: event.pid ?? null,
      attempt: event.attempt ?? null, stage: event.phase ?? null, exit_code: event.exitCode ?? null,
      // P23.1 §7 — additive, structural: a DSH-initiated kill (e.g. a
      // timeout's reapOwnedChildProcess()) reports a real OS signal
      // (Windows: via taskkill's effect on the child's 'exit' event) that
      // was previously visible only inside the ephemeral console message
      // text, never in this durable event. `null` for a normal exit or for
      // a PROCESS_SPAWN event (no signal concept there) — never fabricated.
      signal: event.signal ?? null,
    });
  } catch {
    return false;
  }
}
