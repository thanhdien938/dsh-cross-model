/**
 * P20.8 §6.2 / §9 / §10 — production report-content-plane adapters for the
 * three live-authorized CLI backends (claude-code, opencode, antigravity).
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §6, §9, §10.
 *
 * These are NEW adapters, structurally separate from each backend's existing
 * PM-DECISION-plane driver in production-pm-backend-registry.mjs. They reuse
 * the SAME trusted CLI session bridges (spawn wiring, env allowlist,
 * executable resolution) — never a second process-spawn implementation —
 * but they:
 *   - never call parseDecision / normalizePmDecision / the canonicalizer;
 *   - capture each CLI's own EXACT accepted visible text for
 *     VERBATIM_MATERIALIZATION using the NEW extractOpenCodeReportText /
 *     extractAntigravityReportText below — deliberately NOT the same
 *     extractOpenCodeAssistantText / extractAntigravityAssistantText the
 *     decision plane uses, because those strip zero-width characters /
 *     `.trim()` the result and are therefore not byte-exact (§10);
 *   - always resolve to a ReportBackendResult (report-backend-result.mjs)
 *     — never throw for an ordinary timeout/process/parse failure. A
 *     truthful terminal_state is the report plane's only vocabulary; the
 *     caller (ReportInvoker / runSingleReport / runCouncilArtifactStage)
 *     decides delivery-eligibility and UNKNOWN_OUTCOME handling from that
 *     state, never from a thrown adapter exception.
 *
 * Claude's existing `runClaudeProcess()` non-streaming `--output-format
 * json` path already returns `parsed.result` completely unmodified (plain
 * `JSON.parse(stdout.trim()).result` — the outer `.trim()` only strips
 * whitespace AROUND the JSON envelope, never touches the decoded `result`
 * string itself), so no new Claude extractor is needed — see
 * claude-code-session-bridge.mjs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { runClaudeProcess, resolveClaudeBinary } from '../../session/claude-code-session-bridge.mjs';
import { runOpenCodeProcess, resolveOpenCodeBinary, OPENCODE_DEFAULT_TIMEOUT_MS } from '../../session/opencode-cli-session-bridge.mjs';
import { runAntigravityCliProcess, resolveAntigravityBinary, ANTIGRAVITY_DEFAULT_TIMEOUT_MS } from '../../session/antigravity-cli-session-bridge.mjs';
import { runCodexCliProcess, resolveCodexCliBinary, CODEX_CLI_DEFAULT_TIMEOUT_MS } from '../../session/codex-cli-session-bridge.mjs';
import { runGrokCliProcess, GROK_CLI_DEFAULT_TIMEOUT_MS } from '../../session/grok-cli-session-bridge.mjs';
import { resolveGrokBinary } from '../../session/grok-acp-client.mjs';
import { buildReportBackendResult, VISIBLE_OUTPUT_SOURCE, TERMINAL_STATE } from '../report-backend-result.mjs';
import { captureExecutionForensics } from './report-execution-forensics.mjs';
import { withReapedOwnedSpawnLifecycle, withSpawnObservation } from '../../runtime/backend-execution-observer.mjs';
import { observe } from '../production-pm-backend-registry.mjs';
import { ARTIFACT_STAGE } from '../../artifacts/artifact-paths.mjs';
import { parseStrictDebateControlEnvelope } from '../../artifacts/debate-continuation-control.mjs';

export class CliReportBackendError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CliReportBackendError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- P20.8R3 report-plane execution observability (wiring only) -------
//
// Reuses the EXACT decision-plane observer contract (backend-execution-
// observer.mjs's BackendExecutionObserver + withSpawnObservation()) and the
// EXACT guarded-call helper (`observe`, imported — not duplicated — from
// production-pm-backend-registry.mjs) so a report-plane CLI invocation
// surfaces through the SAME ##DSH_BACKEND_EXEC## sentinel / Desktop
// Backend Execution tabs / forwardBackendEventToTaskLog() path the
// decision plane already uses. `opts.observer`, when supplied by the
// resolver (p20-report-route-resolution.mjs, wired from
// p5-production-composition.mjs's execLogObserver), is the ONLY new input;
// every existing call site that omits it (every pre-R3 test) gets
// `observer === undefined`, and `observe()`/`withSpawnObservation()` are
// both no-ops for a falsy observer — byte-for-byte unchanged behavior.
//
// Never emits report Markdown, prompt text, hidden reasoning, or
// credentials: every observed field below is identity/lifecycle metadata
// (ids, stage, cwd, model, byte counts, exit codes) — the same bounded,
// sanitized shape the decision plane's own ctx already uses.

/**
 * Build the correlation `ctx` for one report-plane execution — the same
 * shape createCliPmDriver() (production-pm-backend-registry.mjs) builds
 * for a decision-plane decide() call, sourced from the app-owned
 * ReportInvocationRequest (never report text). `pmRunId` stays `null`
 * (never fabricated — P20 report executions have no PM decision-plane
 * run); the physical report `execution_id` is the correlatable `runId`.
 */
function reportExecutionCtx({ backendProduct, request, cwd, model }) {
  return {
    backendProduct,
    profileId: request?.profileId ?? null,
    projectId: request?.store?.projectId ?? null,
    taskId: request?.taskId ?? null,
    // P23.1 §6 — additive: lets a persisted BACKEND_TERMINAL diagnostic
    // event (task-diagnostic-log.mjs) name the exact invocation, not just
    // the profile/stage. Never read by any pre-existing observer consumer
    // that doesn't know about it.
    invocationId: request?.invocation?.invocationId ?? null,
    pmRunId: null,
    runId: request?.executionId ?? null,
    stage: request?.stage ?? null,
    role: request?.role ?? null,
    cwd: cwd ?? null,
    model: model ?? null,
  };
}

/**
 * §6 truthful terminal-badge mapping from an already-computed
 * ReportBackendResult. Never re-classifies PROVIDER_ERROR/PROCESS_ERROR/
 * UNKNOWN_OUTCOME/TIMEOUT itself — it only reads the terminal_state each
 * backend's own error-classification function above already produced.
 * The existing observer/UI vocabulary
 * (backendExecutionLogService.ts's applyRunState()) has no distinct
 * CANCELLED badge — only COMPLETED/DECIDED render as non-failed — so
 * TIMEOUT/CANCELLED/PROVIDER_ERROR/PROCESS_ERROR/UNKNOWN_OUTCOME all
 * surface as FAILED with a safe, visible error code attached.
 */
function reportTerminalObservation(result) {
  const state = result?.terminal_state;
  if (state === TERMINAL_STATE.SUCCESS && !result?.timed_out && !result?.cancelled) {
    return { status: 'COMPLETED', error: null, terminalState: state ?? null };
  }
  // P23.1 §6 — `terminalState` carries the REAL ReportBackendResult enum
  // (e.g. 'TIMEOUT'), additive alongside the existing coarse
  // COMPLETED/FAILED UI badge (`status`) — never a replacement for it, so
  // every pre-existing consumer of `.status`/`.error` is unaffected.
  return { status: 'FAILED', error: result?.safe_diagnostics?.error_code ?? state ?? 'UNKNOWN_OUTCOME', terminalState: state ?? null };
}

/**
 * Wrap the report backend's own `opts.spawnImpl` (or, absent one, the real
 * `node:child_process.spawn`) with the shared withSpawnObservation()
 * decorator so PROCESS_SPAWN/STDOUT_CHUNK/STDERR/PROCESS_EXIT fire through
 * the SAME observer for this one execution. Returns `opts.spawnImpl`
 * UNCHANGED (including `undefined`, so each bridge's own default
 * survives) when no observer is configured — zero behavior change for
 * every caller that doesn't pass one.
 */
function observedSpawnImpl({ observer, spawnImpl, ctx, executable, processSettlementOptions, signal }) {
  const observed = observer
    ? withSpawnObservation(spawnImpl ?? nodeSpawn, observer, { ...ctx, executable })
    : (spawnImpl ?? nodeSpawn);
  // P23.3: report-plane bridge timeouts use the established owned-process
  // reaper too. Its decorator exposes __dshReapOwnedProcessTree on the
  // exact child, so a bridge cannot reject until bounded exit/reap
  // settlement has completed and the next sequential participant cannot
  // be admitted while this provider process is still exiting.
  const ownership = signal ?? new AbortController().signal;
  return withReapedOwnedSpawnLifecycle(observed, ownership, processSettlementOptions);
}

// ---- exact-byte extractors (report plane only — never reused by decide()) ----

/**
 * The EXACT concatenated OpenCode assistant text, in event order, with
 * ZERO stripping/joining beyond straight concatenation of `event.part.text`
 * fields. §10: no `.trim()`, no zero-width stripping, no message
 * reconstruction. Throws CLI_REPORT_OUTPUT_MISSING (never returns '') when
 * no text event exists at all — a caller maps that to UNKNOWN_OUTCOME.
 */
export function extractOpenCodeReportText(summary) {
  const parts = [];
  for (const event of summary?.events ?? []) {
    if (event?.type === 'text' && event?.part?.type === 'text' && typeof event.part.text === 'string') {
      parts.push(event.part.text);
    }
  }
  if (parts.length === 0) {
    throw new CliReportBackendError('OpenCode produced no assistant text event', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'opencode' });
  }
  return parts.join('');
}

/**
 * Truthful terminal-fact classification for one Antigravity CLI run —
 * shared by the VERBATIM_MATERIALIZATION text extractor below AND the
 * DIRECT_WRITE adapter (which needs the SAME CANCELED/ERROR/non-SUCCESS
 * classification but must NOT require/inspect `result.response` text at
 * all — §0/§6: DIRECT_WRITE report content comes from the file the model
 * wrote, never from parsed response text). Throws the same typed errors
 * `antigravityErrorToResult()` below already classifies; returns nothing
 * on a genuine SUCCESS.
 */
export function classifyAntigravityTerminalOutcome(summary) {
  const result = summary?.result;
  if (!result || typeof result !== 'object') {
    throw new CliReportBackendError('Antigravity produced no terminal result event', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'antigravity' });
  }
  if (result.status === 'CANCELED') {
    throw new CliReportBackendError('Antigravity run was canceled', 'CLI_REPORT_CANCELLED', { backend: 'antigravity' });
  }
  if (result.status === 'ERROR') {
    throw new CliReportBackendError(`Antigravity run ended in error: ${result.error ?? 'unknown'}`, 'CLI_REPORT_PROVIDER_ERROR', { backend: 'antigravity', providerError: result.error ?? null });
  }
  if (result.status !== 'SUCCESS') {
    throw new CliReportBackendError(`Antigravity run ended with unexpected status: ${result.status}`, 'CLI_REPORT_UNKNOWN_STATUS', { backend: 'antigravity', status: result.status });
  }
}

/**
 * The EXACT Antigravity final `result.response`, with ZERO `.trim()` or
 * other normalization (§10). Reuses the SAME status/error classification
 * antigravity-cli-session-bridge.mjs's extractAntigravityAssistantText()
 * already performs (CANCELED/ERROR/non-SUCCESS all throw typed errors) —
 * only the final `.trim()` is removed, and only from the RETURNED value; a
 * local trimmed check is still used to detect a genuinely blank response.
 * VERBATIM_MATERIALIZATION only — DIRECT_WRITE uses
 * classifyAntigravityTerminalOutcome() directly and never calls this.
 */
export function extractAntigravityReportText(summary) {
  classifyAntigravityTerminalOutcome(summary);
  const text = summary.result.response;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CliReportBackendError('Antigravity final assistant output is missing', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'antigravity' });
  }
  return text;
}

/**
 * P22.4 §C — the EXACT concatenated Codex assistant text across every
 * `item.completed`/`agent_message` event, in event order, with ZERO
 * `.trim()`/joining beyond straight concatenation (§10 byte fidelity —
 * deliberately NOT reusing codex-cli-session-bridge.mjs's own
 * `extractCodexAssistantText()`, which `.trim()`s and only keeps the LAST
 * message). Throws CLI_REPORT_OUTPUT_MISSING (never '') when no assistant
 * message event exists at all.
 */
export function extractCodexReportText(summary) {
  const parts = [];
  for (const event of summary?.events ?? []) {
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      parts.push(event.item.text);
    }
  }
  if (parts.length === 0) {
    throw new CliReportBackendError('Codex produced no assistant message event', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'codex' });
  }
  return parts.join('');
}

/**
 * Task8-codex-fix §B — Codex Debate typed-control channel: the LAST
 * `item.completed`/`agent_message` event's text ONLY, in event order —
 * deliberately NEVER concatenated with any earlier assistant message.
 * This is the Codex-side equivalent of the single final-turn value
 * Claude's DIRECT_WRITE Debate control path already reads
 * (`value?.result` above, the Claude Code SDK's own last-message field);
 * Codex's CLI has no equivalent single field, so this reconstructs it by
 * taking the LAST agent_message event — the same selection
 * codex-cli-session-bridge.mjs's own decision-plane
 * `extractCodexAssistantText()` already makes (it also `.at(-1)`s, though
 * it additionally `.trim()`s, which this helper deliberately does not:
 * `parseStrictDebateControlEnvelope()` does its own `.trim()`, and no
 * other normalization is wanted here).
 *
 * Deliberately SEPARATE from, and never a replacement for,
 * `extractCodexReportText()` immediately above: that remains the
 * report-plane byte-fidelity extractor (concatenates EVERY agent_message
 * event, unchanged by this helper) — report bytes and Debate machine
 * control are two different channels from the same execution (see
 * debate-continuation-control.mjs's header comment) and must never be
 * conflated. This helper is used ONLY by the Codex DIRECT_WRITE
 * Debate-chair-synthesis typed-control call site below — every other
 * Codex report path (VERBATIM_MATERIALIZATION, ordinary DIRECT_WRITE
 * stages) keeps using `extractCodexReportText()` exactly as before.
 *
 * No substring search, no prefix scan, no prose stripping, no fallback to
 * report.md — the exact final agent_message text is returned as-is, and
 * `parseStrictDebateControlEnvelope()` (unchanged) still requires that
 * ENTIRE text to be exactly one bounded envelope; any prose before/after
 * it in that FINAL message still fails closed there, exactly as it does
 * today. Throws CLI_REPORT_OUTPUT_MISSING (never '') when no assistant
 * message event exists at all — a missing final message still fails
 * closed.
 */
export function extractCodexFinalAssistantTextForDebateControl(summary) {
  let last = null;
  for (const event of summary?.events ?? []) {
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      last = event.item.text;
    }
  }
  if (last === null) {
    throw new CliReportBackendError('Codex produced no assistant message event', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'codex' });
  }
  return last;
}

/**
 * P22.4 §E — the EXACT Grok `output.text` field, with ZERO `.trim()` (§10
 * byte fidelity — deliberately NOT reusing grok-cli-session-bridge.mjs's
 * own `extractGrokAssistantText()`, which `.trim()`s). Throws
 * CLI_REPORT_OUTPUT_MISSING (never '') when no output text exists at all.
 */
export function extractGrokReportText(summary) {
  const text = summary?.output?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CliReportBackendError('Grok produced no assistant output text', 'CLI_REPORT_OUTPUT_MISSING', { backend: 'grok' });
  }
  return text;
}

/**
 * P20.8R2 §5/§6 — the shared DIRECT_WRITE confirmation writer for every
 * production report backend. The real provider invocation already ran
 * (awaited, INSIDE runReport(), BEFORE this is ever called — see
 * report-invocation.mjs) and was expected to have written the assigned
 * file itself as a side effect of its own Write tool use; this writer
 * performs NO write of its own (DSH never writes report content — §0/§6)
 * and simply confirms that to deliverDirectWrite() via the
 * `expectPreExisting` marker (artifact-delivery.mjs). Fully stateless —
 * one shared instance for all three backends.
 */
export const PROVIDER_DIRECT_WRITE_CONFIRMER = Object.assign(
  () => ({}),
  { expectPreExisting: true },
);

// ---- shared error -> terminal-state classification --------------------

function claudeErrorToResult({ error, common, startedAt }) {
  const durationMs = Date.now() - startedAt;
  const code = error?.code ?? null;
  // P23.1 §3 — forensic audit finding: `ClaudeCodeSessionError` (any code)
  // may carry stdout/stderr/byte-counts/assistantOutputPresent/exit info
  // from the killed process — `captureExecutionForensics()` turns whatever
  // is actually present into safe, bounded, non-report facts. Computed
  // once, unconditionally, so no failure code path silently reverts to the
  // old error_code-only shape.
  const forensics = captureExecutionForensics(error);
  const safeDiagnosticsFor = (extra = {}) => ({ error_code: code, ...forensics.compact, ...extra, preview: forensics.preview });
  if (code === 'CLAUDE_TIMEOUT') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: safeDiagnosticsFor() });
  }
  if (code === 'CLAUDE_EXIT_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, processExitCode: error.exitCode ?? null, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: safeDiagnosticsFor({ signal: error.signal ?? null }) });
  }
  if (code === 'CLAUDE_SPAWN_FAILED' || code === 'CLAUDE_STDIN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROCESS_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: safeDiagnosticsFor() });
  }
  // CLAUDE_OUTPUT_PARSE_FAILED, or anything unrecognized: the process ran
  // but its outcome is not cleanly classifiable — never optimistically
  // SUCCESS (report-backend-result.mjs's own §9.1 rule).
  return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: safeDiagnosticsFor({ error_code: code ?? 'CLAUDE_REPORT_UNCLASSIFIED' }) });
}

function openCodeErrorToResult({ error, common, startedAt }) {
  const durationMs = Date.now() - startedAt;
  const code = error?.code ?? null;
  const forensics = captureExecutionForensics(error);
  const diagnostics = { error_code: code, ...forensics.compact, preview: forensics.preview };
  if (code === 'OPENCODE_TIMEOUT') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: diagnostics });
  }
  if (code === 'OPENCODE_RUN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, processExitCode: error.summary?.code ?? null, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'OPENCODE_SPAWN_FAILED' || code === 'OPENCODE_STDIN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROCESS_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CLI_REPORT_OUTPUT_MISSING') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code ?? 'OPENCODE_REPORT_UNCLASSIFIED' } });
}

function antigravityErrorToResult({ error, common, startedAt }) {
  const durationMs = Date.now() - startedAt;
  const code = error?.code ?? null;
  if (code === 'ANTIGRAVITY_TIMEOUT') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'ANTIGRAVITY_EXIT_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, processExitCode: error.exitCode ?? null, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'ANTIGRAVITY_SPAWN_FAILED' || code === 'ANTIGRAVITY_STDIN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROCESS_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CLI_REPORT_CANCELLED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.CANCELLED, cancelled: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CLI_REPORT_PROVIDER_ERROR') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code, providerError: error.providerError ?? null } });
  }
  if (code === 'CLI_REPORT_OUTPUT_MISSING' || code === 'CLI_REPORT_UNKNOWN_STATUS') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code ?? 'ANTIGRAVITY_REPORT_UNCLASSIFIED' } });
}

function codexErrorToResult({ error, common, startedAt }) {
  const durationMs = Date.now() - startedAt;
  const code = error?.code ?? null;
  const forensics = captureExecutionForensics(error);
  const diagnostics = { error_code: code, ...forensics.compact, preview: forensics.preview };
  if (code === 'CODEX_TIMEOUT') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: diagnostics });
  }
  if (code === 'CODEX_RUN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, processExitCode: error.exitCode ?? null, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CODEX_SPAWN_FAILED' || code === 'CODEX_STDIN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROCESS_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CLI_REPORT_OUTPUT_MISSING') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code ?? 'CODEX_REPORT_UNCLASSIFIED' } });
}

function grokErrorToResult({ error, common, startedAt }) {
  const durationMs = Date.now() - startedAt;
  const code = error?.code ?? null;
  if (code === 'GROK_TIMEOUT') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'GROK_RUN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROVIDER_ERROR, processExitCode: error.exitCode ?? null, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'GROK_SPAWN_FAILED') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.PROCESS_ERROR, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  if (code === 'CLI_REPORT_OUTPUT_MISSING') {
    return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code } });
  }
  return buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: code ?? 'GROK_REPORT_UNCLASSIFIED' } });
}

// ---- per-backend report adapters ---------------------------------------

/**
 * P20.8R2 §0/§3.1 — `opts.deliveryMechanism` selects the route: default
 * `'VERBATIM_MATERIALIZATION'` (unchanged from P20.8) or `'DIRECT_WRITE'`
 * (new — the assigned report path is embedded in `prompt` automatically
 * by buildReportPromptFromRequest()/renderReportPrompt(), the CLI runs
 * with write-capable `bypassPermissions`, and CLI text is never
 * materialized as the report — the file the model itself wrote is the
 * sole report authority, verified downstream by deliverDirectWrite()).
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} [opts.effort]
 * @param {string} opts.cwd  project.repo_path — the same cwd the decision plane uses
 * @param {string} [opts.binary]
 * @param {Function} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.permissionMode]  explicit override; defaults per deliveryMechanism below
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [opts.deliveryMechanism]
 */
export function createClaudeReportBackend(opts = {}) {
  const binary = opts.binary ?? resolveClaudeBinary();
  const directWrite = opts.deliveryMechanism === 'DIRECT_WRITE';
  const observer = opts.observer ?? null;
  return {
    backend: 'claude-code',
    deliveryMechanism: directWrite ? 'DIRECT_WRITE' : 'VERBATIM_MATERIALIZATION',
    directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    // P20.8R7 §4 — the ONLY backend/route this session implements the real
    // same-execution typed-control channel for, and ONLY meaningful for a
    // DIRECT_WRITE Debate chair-synthesis call (gated per-call below by
    // `request.stage`; every other stage/call for this SAME backend object
    // — chair-plan, participant-report, debate-brief/response, SINGLE — is
    // completely unaffected). `resolveDebateTypedControlStatus()`/
    // `assertDebateTypedControlAdmitted()` (debate-backend-capability.mjs)
    // read exactly this instance flag for real admission — the static,
    // product-level `PRODUCTION_DEBATE_BACKEND_MATRIX` documentation object
    // is deliberately left untouched (see the R7 report: that matrix is
    // per-PRODUCT, not per-route/per-stage, so marking it PROVEN there
    // would over-broaden the claim beyond what is actually proven here).
    supportsDebateTypedControl: directWrite,
    async runReport({ prompt, request }) {
      const common = { backend: 'claude-code', profileId: request.profileId, model: opts.model ?? null, executionId: request.executionId };
      const ctx = reportExecutionCtx({ backendProduct: 'claude-code', request, cwd: opts.cwd, model: opts.model });
      const startedAt = Date.now();
      observe(observer, 'start', ctx);
      const spawnImpl = observedSpawnImpl({ observer, spawnImpl: opts.spawnImpl, ctx, executable: binary, processSettlementOptions: opts.processSettlementOptions, signal: request.signal });
      const isDebateSynthesis = directWrite && request?.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
      let result;
      try {
        const value = await runClaudeProcess({
          binary, cwd: opts.cwd, prompt, model: opts.model ?? undefined, effort: opts.effort ?? undefined,
          // §2/§3.1 — Phase-1 "function first": Claude's own write-capable
          // mode (proven live in Gate A), used ONLY for this report-plane
          // DIRECT_WRITE call — the decision plane never opts into this.
          permissionMode: opts.permissionMode ?? (directWrite ? 'bypassPermissions' : 'plan'),
          spawnImpl, timeoutMs: opts.timeoutMs ?? undefined,
        });
        if (directWrite) {
          // §0/§6 — DSH does not materialize report content: the CLI's own
          // visible text is intentionally discarded as REPORT content here.
          // A clean async resolution (no thrown error) is the only success
          // signal; deliverDirectWrite() verifies the actual file
          // afterward. P20.8R7 §4 — for a Debate chair-synthesis call ONLY,
          // that SAME final visible text (`value.result`) is separately
          // read for the SEPARATE strict machine-control envelope — never
          // as report content, never from report.md bytes. Missing/
          // malformed/duplicated envelopes fail closed (UNKNOWN_OUTCOME)
          // BEFORE delivery ever runs (ReportInvoker.invokeReport() checks
          // reportDeliveryEligible() before calling deliverDirectWrite()),
          // so a bad envelope can never seal a report.
          let debateTypedControl = null;
          if (isDebateSynthesis) {
            try {
              debateTypedControl = parseStrictDebateControlEnvelope(value?.result);
            } catch (error) {
              result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true, error_code: error.code ?? 'CLAUDE_DEBATE_CONTROL_INVALID' } });
            }
          }
          if (!result) {
            result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true }, debateTypedControl });
          }
        } else {
          const text = value?.result;
          result = typeof text !== 'string'
            ? buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT, safeDiagnostics: { error_code: 'CLAUDE_REPORT_RESULT_MISSING' } })
            : buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT });
        }
      } catch (error) {
        result = claudeErrorToResult({ error, common, startedAt });
      }
      const terminal = reportTerminalObservation(result);
      observe(observer, 'terminal', ctx, { status: terminal.status, durationMs: result.duration_ms, error: terminal.error, terminalState: terminal.terminalState });
      return result;
    },
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {string} [opts.reasoning]  forwarded as `--variant`, matching the decision-plane registration
 * @param {string} opts.cwd
 * @param {string} [opts.binary]
 * @param {Function} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [opts.deliveryMechanism]
 */
export function createOpenCodeReportBackend(opts = {}) {
  const binary = opts.binary ?? resolveOpenCodeBinary();
  const directWrite = opts.deliveryMechanism === 'DIRECT_WRITE';
  const observer = opts.observer ?? null;
  return {
    backend: 'opencode',
    deliveryMechanism: directWrite ? 'DIRECT_WRITE' : 'VERBATIM_MATERIALIZATION',
    directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    // P22.4 §F — same-execution typed control, ONLY for a DIRECT_WRITE
    // Debate chair-synthesis call, identical mechanism/gate to Claude's
    // (see createClaudeReportBackend's identical comment above). The
    // audit (P22.3 §2) found OpenCode's chair lacked an admitted
    // typed-control route; this closes that gap using the exact same
    // strict envelope parser, never a new/looser one.
    supportsDebateTypedControl: directWrite,
    async runReport({ prompt, request }) {
      const common = { backend: 'opencode', profileId: request.profileId, model: opts.model ?? null, executionId: request.executionId };
      const ctx = reportExecutionCtx({ backendProduct: 'opencode', request, cwd: opts.cwd, model: opts.model });
      const startedAt = Date.now();
      observe(observer, 'start', ctx);
      const spawnImpl = observedSpawnImpl({ observer, spawnImpl: opts.spawnImpl, ctx, executable: binary, processSettlementOptions: opts.processSettlementOptions, signal: request.signal });
      const isDebateSynthesis = directWrite && request?.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
      const extraArgs = [
        ...(opts.model ? ['--model', opts.model] : []),
        ...(opts.reasoning ? ['--variant', opts.reasoning] : []),
        // §2/§3.2 — Phase-1 "function first": the simplest reliable
        // write-capable OpenCode CLI mode (`opencode run --help` ->
        // `--auto`), used ONLY for this report-plane DIRECT_WRITE call —
        // never for the decision plane. Explicitly temporary/broad per §2
        // rule 3; Phase 2 will scope it down.
        ...(directWrite ? ['--auto'] : []),
      ];
      let result;
      try {
        const value = await runOpenCodeProcess({
          binary, cwd: opts.cwd, prompt, extraArgs, spawnImpl,
          timeoutMs: opts.timeoutMs ?? OPENCODE_DEFAULT_TIMEOUT_MS,
        });
        if (directWrite) {
          let debateTypedControl = null;
          if (isDebateSynthesis) {
            try {
              debateTypedControl = parseStrictDebateControlEnvelope(extractOpenCodeReportText(value));
            } catch (error) {
              result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true, error_code: error.code ?? 'OPENCODE_DEBATE_CONTROL_INVALID' } });
            }
          }
          if (!result) {
            result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true }, debateTypedControl });
          }
        } else {
          const text = extractOpenCodeReportText(value);
          result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT });
        }
      } catch (error) {
        result = openCodeErrorToResult({ error, common, startedAt });
      }
      const terminal = reportTerminalObservation(result);
      observe(observer, 'terminal', ctx, { status: terminal.status, durationMs: result.duration_ms, error: terminal.error, terminalState: terminal.terminalState });
      return result;
    },
  };
}

/**
 * P22.4 §C — Codex report adapter. `runCodexCliProcess()` already always
 * runs with `--dangerously-bypass-approvals-and-sandbox` (the SAME native
 * write capability the generic decision-plane registration uses — see
 * production-pm-backend-registry.mjs), so DIRECT_WRITE here reuses that
 * already-shipped mode rather than a new one; the report path itself is
 * embedded in `prompt` upstream (report-invocation.mjs's prompt builder),
 * exactly as it is for Claude/OpenCode/Antigravity DIRECT_WRITE.
 *
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {string} [opts.reasoning]
 * @param {string} opts.cwd
 * @param {string} [opts.binary]
 * @param {Function} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [opts.deliveryMechanism]
 */
export function createCodexReportBackend(opts = {}) {
  const binary = opts.binary ?? resolveCodexCliBinary();
  const directWrite = opts.deliveryMechanism === 'DIRECT_WRITE';
  const observer = opts.observer ?? null;
  return {
    backend: 'codex',
    deliveryMechanism: directWrite ? 'DIRECT_WRITE' : 'VERBATIM_MATERIALIZATION',
    directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    // P22.4 §C/§I — same-execution typed control, ONLY for a DIRECT_WRITE
    // Debate chair-synthesis call, identical mechanism/gate to Claude's
    // (see createClaudeReportBackend's identical comment above).
    supportsDebateTypedControl: directWrite,
    async runReport({ prompt, request }) {
      const common = { backend: 'codex', profileId: request.profileId, model: opts.model ?? null, executionId: request.executionId };
      const ctx = reportExecutionCtx({ backendProduct: 'codex', request, cwd: opts.cwd, model: opts.model });
      const startedAt = Date.now();
      observe(observer, 'start', ctx);
      const spawnImpl = observedSpawnImpl({ observer, spawnImpl: opts.spawnImpl, ctx, executable: binary, processSettlementOptions: opts.processSettlementOptions, signal: request.signal });
      const isDebateSynthesis = directWrite && request?.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
      let result;
      try {
        const value = await runCodexCliProcess({
          binary, cwd: opts.cwd, prompt, model: opts.model ?? undefined, reasoning: opts.reasoning ?? undefined,
          spawnImpl, timeoutMs: opts.timeoutMs ?? CODEX_CLI_DEFAULT_TIMEOUT_MS,
        });
        if (directWrite) {
          let debateTypedControl = null;
          if (isDebateSynthesis) {
            try {
              // Task8-codex-fix §B — the SEPARATE final-assistant-message
              // control channel, never the concatenated report-plane text
              // (extractCodexReportText() above stays report-plane-only).
              debateTypedControl = parseStrictDebateControlEnvelope(extractCodexFinalAssistantTextForDebateControl(value));
            } catch (error) {
              result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true, error_code: error.code ?? 'CODEX_DEBATE_CONTROL_INVALID' } });
            }
          }
          if (!result) {
            result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true }, debateTypedControl });
          }
        } else {
          const text = extractCodexReportText(value);
          result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT });
        }
      } catch (error) {
        result = codexErrorToResult({ error, common, startedAt });
      }
      const terminal = reportTerminalObservation(result);
      observe(observer, 'terminal', ctx, { status: terminal.status, durationMs: result.duration_ms, error: terminal.error, terminalState: terminal.terminalState });
      return result;
    },
  };
}

/**
 * P22.4 §E — Grok report adapter. `runGrokCliProcess()` already always runs
 * with `--permission-mode bypassPermissions --sandbox off` (the SAME native
 * write capability the generic decision-plane registration uses), so
 * DIRECT_WRITE here reuses that already-shipped mode.
 *
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {string} [opts.reasoning]
 * @param {string} opts.cwd
 * @param {string} [opts.binary]
 * @param {Function} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [opts.deliveryMechanism]
 */
export function createGrokReportBackend(opts = {}) {
  const binary = opts.binary ?? resolveGrokBinary();
  const directWrite = opts.deliveryMechanism === 'DIRECT_WRITE';
  const observer = opts.observer ?? null;
  return {
    backend: 'grok',
    deliveryMechanism: directWrite ? 'DIRECT_WRITE' : 'VERBATIM_MATERIALIZATION',
    directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    supportsDebateTypedControl: directWrite,
    async runReport({ prompt, request }) {
      const common = { backend: 'grok', profileId: request.profileId, model: opts.model ?? null, executionId: request.executionId };
      const ctx = reportExecutionCtx({ backendProduct: 'grok', request, cwd: opts.cwd, model: opts.model });
      const startedAt = Date.now();
      observe(observer, 'start', ctx);
      const spawnImpl = observedSpawnImpl({ observer, spawnImpl: opts.spawnImpl, ctx, executable: binary, processSettlementOptions: opts.processSettlementOptions, signal: request.signal });
      const isDebateSynthesis = directWrite && request?.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
      let result;
      try {
        const value = await runGrokCliProcess({
          binary, cwd: opts.cwd, prompt, model: opts.model ?? undefined, reasoning: opts.reasoning ?? undefined,
          spawnImpl, timeoutMs: opts.timeoutMs ?? GROK_CLI_DEFAULT_TIMEOUT_MS,
        });
        if (directWrite) {
          let debateTypedControl = null;
          if (isDebateSynthesis) {
            try {
              debateTypedControl = parseStrictDebateControlEnvelope(extractGrokReportText(value));
            } catch (error) {
              result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true, error_code: error.code ?? 'GROK_DEBATE_CONTROL_INVALID' } });
            }
          }
          if (!result) {
            result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true }, debateTypedControl });
          }
        } else {
          const text = extractGrokReportText(value);
          result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT });
        }
      } catch (error) {
        result = grokErrorToResult({ error, common, startedAt });
      }
      const terminal = reportTerminalObservation(result);
      observe(observer, 'terminal', ctx, { status: terminal.status, durationMs: result.duration_ms, error: terminal.error, terminalState: terminal.terminalState });
      return result;
    },
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {string} opts.cwd
 * @param {string} [opts.binary]
 * @param {Function} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [opts.deliveryMechanism]
 */
export function createAntigravityReportBackend(opts = {}) {
  const binary = opts.binary ?? resolveAntigravityBinary();
  const directWrite = opts.deliveryMechanism === 'DIRECT_WRITE';
  const observer = opts.observer ?? null;
  return {
    backend: 'antigravity',
    deliveryMechanism: directWrite ? 'DIRECT_WRITE' : 'VERBATIM_MATERIALIZATION',
    directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    // P22.4 §F — see createOpenCodeReportBackend's identical comment above;
    // Antigravity's result event carries a single final `result.response`
    // (classifyAntigravityTerminalOutcome already validates SUCCESS/status
    // before this ever reads it), which is exactly the "entire final
    // response" shape parseStrictDebateControlEnvelope requires.
    supportsDebateTypedControl: directWrite,
    async runReport({ prompt, request }) {
      const common = { backend: 'antigravity', profileId: request.profileId, model: opts.model ?? null, executionId: request.executionId };
      const ctx = reportExecutionCtx({ backendProduct: 'antigravity', request, cwd: opts.cwd, model: opts.model });
      const startedAt = Date.now();
      observe(observer, 'start', ctx);
      const spawnImpl = observedSpawnImpl({ observer, spawnImpl: opts.spawnImpl, ctx, executable: binary, processSettlementOptions: opts.processSettlementOptions, signal: request.signal });
      const isDebateSynthesis = directWrite && request?.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
      let result;
      try {
        // P9-R0.3-established production decision: never forward `reasoning`
        // as --effort for Antigravity (see production-pm-backend-registry.mjs's
        // identical comment) — this report adapter follows the same rule.
        const value = await runAntigravityCliProcess({
          binary, cwd: opts.cwd, prompt, model: opts.model ?? undefined, spawnImpl,
          timeoutMs: opts.timeoutMs ?? ANTIGRAVITY_DEFAULT_TIMEOUT_MS,
          // §3.3 — the decision-plane's hard-coded `--mode plan` call site
          // (production-pm-backend-registry.mjs) never passes `mode`/
          // `dangerouslySkipPermissions` and is completely untouched. This
          // is the ONE new report-plane DIRECT_WRITE call site that opts
          // into a write-capable mode. A live probe proved `--mode
          // accept-edits` alone is insufficient in this headless/no-TTY
          // print-mode session (the edit tool's permission prompt has
          // nothing to answer it) — `--dangerously-skip-permissions` is
          // therefore required too, exactly as §2/§3.3's "broad/full is
          // explicitly allowed for this Phase 1 test" anticipates.
          mode: directWrite ? 'accept-edits' : 'plan',
          dangerouslySkipPermissions: directWrite,
        });
        if (directWrite) {
          classifyAntigravityTerminalOutcome(value);
          let debateTypedControl = null;
          if (isDebateSynthesis) {
            try {
              debateTypedControl = parseStrictDebateControlEnvelope(value?.result?.response);
            } catch (error) {
              result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.UNKNOWN_OUTCOME, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true, error_code: error.code ?? 'ANTIGRAVITY_DEBATE_CONTROL_INVALID' } });
            }
          }
          if (!result) {
            result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, safeDiagnostics: { direct_write: true }, debateTypedControl });
          }
        } else {
          const text = extractAntigravityReportText(value);
          result = buildReportBackendResult({ ...common, terminalState: TERMINAL_STATE.SUCCESS, durationMs: Date.now() - startedAt, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.CLI_ASSISTANT_TEXT });
        }
      } catch (error) {
        result = antigravityErrorToResult({ error, common, startedAt });
      }
      const terminal = reportTerminalObservation(result);
      observe(observer, 'terminal', ctx, { status: terminal.status, durationMs: result.duration_ms, error: terminal.error, terminalState: terminal.terminalState });
      return result;
    },
  };
}
