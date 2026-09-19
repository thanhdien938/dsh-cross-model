import { spawn as nodeSpawn } from 'node:child_process';

// P6-W3-R3 Part B — READ-ONLY execution-log observability shared by all
// four production PM backends (claude-code, opencode, codex, grok).
//
// This module is intentionally the *only* place that knows how to turn a
// backend CLI invocation into a BackendExecutionEvent. It never touches
// parser results, PM decisions, claim renewal, timeouts, or exit-code
// handling — every method here is a pure side-effecting sink, wrapped so a
// failure inside it can never throw back into the caller (B4: "If observer
// fails: task execution must continue"). It does not persist anything and
// is not canonical truth (B5/Part K docs) — it only turns real backend
// process lifecycle facts into sanitized, bounded, read-only log lines the
// Desktop app's per-backend ring buffers (desktop/electron/main/services/
// backendExecutionLogService.ts) can display.
//
// Wire format: one NDJSON line per event, prefixed with EXEC_LOG_SENTINEL,
// written to the runtime process's own stdout. The Desktop supervisor
// already pipes that stdout into RuntimeSupervisor's 'log' event
// (desktop/electron/main/services/runtimeSupervisor.ts) — reusing that
// existing channel means zero new process-boundary plumbing was needed to
// get events from the runtime child process to Desktop.

export const EXEC_LOG_SENTINEL = '##DSH_BACKEND_EXEC##';

const MAX_LINE_CHARS = 4000;

// B8: sanitize secret-shaped substrings out of raw process text before it
// ever reaches Desktop's IPC/renderer boundary. Substring-based (not
// whole-value, unlike sanitizeOperatorOutput in operator-control-service.mjs)
// because raw stdout/stderr lines mix safe diagnostic text with an
// occasionally-embedded credential, not one bare secret value per line.
const SENSITIVE_INLINE = Object.freeze([
  [/\b(authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi, '$1$2 [REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._\-=]+/gi, 'Bearer [REDACTED]'],
  [/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\b((?:api[_-]?key|apikey|token|secret|password|passwd|access[_-]?key|dsn|connection[_-]?string)\s*[:=]\s*)("?)[^\s"',}]+/gi, '$1$2[REDACTED]'],
  // Telegram bot tokens: <digits>:<35-ish char secret>.
  [/\b\d{6,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]'],
]);

export function sanitizeExecutionLogText(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [pattern, replacement] of SENSITIVE_INLINE) out = out.replace(pattern, replacement);
  return out;
}

export function boundExecutionLogLine(text) {
  const sanitized = sanitizeExecutionLogText(String(text ?? ''));
  return sanitized.length > MAX_LINE_CHARS ? `${sanitized.slice(0, MAX_LINE_CHARS)}…[truncated]` : sanitized;
}

// P10-R0.1.1 Part L: exported so a composition root can build a SECOND sink
// that both preserves this exact stdout-sentinel behavior (Desktop's ring
// buffer keeps working byte-for-byte) AND forwards a subset of the same
// events into a task-scoped diagnostic bundle when one is present — see
// p5-production-composition.mjs. Never a second independent "default"
// implementation to keep in sync.
export function defaultEmit(event) {
  try {
    // eslint-disable-next-line no-console -- this *is* the transport.
    console.log(`${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}`);
  } catch {
    // Never throw out of the transport either.
  }
}

/**
 * Create a BackendExecutionObserver. `emit(event)` receives one
 * BackendExecutionEvent (frozen plain object) per call; the default sink
 * writes an NDJSON line to stdout (see module docstring). Every method is
 * best-effort: an emit failure is swallowed, never rethrown.
 */
export function createBackendExecutionObserver({ emit } = {}) {
  const sink = typeof emit === 'function' ? emit : defaultEmit;

  function safeEmit(partial) {
    try {
      sink(Object.freeze({
        timestamp: new Date().toISOString(),
        backendProduct: null,
        profileId: null,
        projectId: null,
        taskId: null,
        pmRunId: null,
        runId: null,
        phase: null,
        stream: null,
        eventKind: null,
        message: '',
        cwd: null,
        model: null,
        pid: null,
        exitCode: null,
        // P23.1 §7 — additive default so every event carries the key
        // uniformly (present-but-null) even when the specific method
        // doesn't pass it, matching the existing convention for exitCode/
        // status/etc. above.
        signal: null,
        durationMs: null,
        parserOutcome: null,
        status: null,
        // P23.1 §6 — additive defaults for the TERMINAL event's new
        // structured fields (see `.terminal()` below); every other event
        // kind simply carries them as null.
        errorCode: null,
        terminalState: null,
        ...partial,
        message: boundExecutionLogLine(partial.message ?? ''),
      }));
    } catch {
      // B4: observer failures must never affect task execution.
    }
  }

  return Object.freeze({
    canonicalization(ctx, diagnostic) {
      safeEmit({...ctx,phase:'CANONICALIZATION',eventKind:'CANONICALIZATION',message:diagnostic.state,canonicalization:diagnostic});
    },
    canonicalizationUsage(ctx, usage) {
      safeEmit({...ctx,phase:'CANONICALIZATION_USAGE',eventKind:'CANONICALIZATION_USAGE',message:'canonicalizer token usage',...usage});
    },
    start(ctx) {
      safeEmit({ ...ctx, phase: 'START', eventKind: 'START', message: `START ${ctx.backendProduct} project=${ctx.projectId} profile=${ctx.profileId}` });
    },
    spawn(ctx, { pid } = {}) {
      safeEmit({ ...ctx, phase: 'PROCESS_SPAWN', eventKind: 'PROCESS_SPAWN', pid: typeof pid === 'number' ? pid : null, message: `PROCESS_SPAWN executable=${ctx.executable ?? ctx.backendProduct} mode=stdio pid=${pid ?? 'unknown'}` });
    },
    stdoutChunk(ctx, { length } = {}) {
      safeEmit({ ...ctx, phase: 'STDOUT_EVENT', eventKind: 'STDOUT_CHUNK', stream: 'stdout', message: `STDOUT_EVENT bytes=${length ?? 0}` });
    },
    stdoutSummary(ctx, { summary } = {}) {
      safeEmit({ ...ctx, phase: 'STDOUT_EVENT', eventKind: 'STDOUT_SUMMARY', stream: 'stdout', message: summary ?? '' });
    },
    stderrChunk(ctx, { text } = {}) {
      safeEmit({ ...ctx, phase: 'STDERR', eventKind: 'STDERR', stream: 'stderr', message: text ?? '' });
    },
    exit(ctx, { exitCode, signal } = {}) {
      // P23.1 §7 — `signal` (e.g. 'SIGTERM' for a DSH-initiated
      // reapOwnedChildProcess() kill) previously existed only inside the
      // free-text `message` string; it is now ALSO a first-class structured
      // field, additive next to the pre-existing `exitCode` — no existing
      // field renamed/removed, no consumer that reads only `exitCode`/
      // `message` is affected.
      safeEmit({ ...ctx, phase: 'PROCESS_EXIT', eventKind: 'PROCESS_EXIT', exitCode: exitCode ?? null, signal: signal ?? null, message: `PROCESS_EXIT code=${exitCode ?? 'null'}${signal ? ` signal=${signal}` : ''}` });
    },
    parser(ctx, { outcome, bytes, outputByteLength, firstChar, lastChar, firstCharClass, lastCharClass, fullJson, jsonFence, prefixClass, suffixClass, parseSubreason } = {}) {
      safeEmit({ ...ctx, phase: 'PARSER', eventKind: 'PARSER', parserOutcome: outcome ?? null,
        outputByteLength: Number.isFinite(outputByteLength) ? outputByteLength : (Number.isFinite(bytes) ? bytes : null),
        firstChar: typeof firstChar === 'string' ? firstChar : null, lastChar: typeof lastChar === 'string' ? lastChar : null,
        firstCharClass: firstCharClass ?? null, lastCharClass: lastCharClass ?? null,
        fullJson: typeof fullJson === 'boolean' ? fullJson : null, jsonFence: typeof jsonFence === 'boolean' ? jsonFence : null,
        prefixClass: prefixClass ?? null, suffixClass: suffixClass ?? null, parseSubreason: parseSubreason ?? null,
        message: `PARSER assistant_output_bytes=${Number.isFinite(outputByteLength) ? outputByteLength : (bytes ?? 0)} outcome=${outcome ?? 'UNKNOWN'}` });
    },
    terminal(ctx, { status, durationMs, error, terminalState } = {}) {
      // P23.1 §6 — `errorCode`/`terminalState` are now first-class
      // structured fields, additive next to the pre-existing free-text
      // `message` (byte-for-byte unchanged format) — so a durable consumer
      // (task-diagnostic-log.mjs's forwardBackendEventToTaskLog()) never
      // has to parse the human-readable string to recover them.
      safeEmit({ ...ctx, phase: 'TERMINAL', eventKind: 'TERMINAL', durationMs: durationMs ?? null, status: status ?? null, errorCode: error ?? null, terminalState: terminalState ?? null, message: `TERMINAL ${status ?? 'UNKNOWN'}${error ? ` ${error}` : ''} duration=${durationMs ?? '?'}ms` });
    },
    apiUsage(ctx, { provider, requestedModel, returnedModel, httpStatus, requestId, usage, requestFields, durationMs, streaming } = {}) {
      safeEmit({
        ...ctx, phase: 'API_USAGE', eventKind: 'API_USAGE', status: 'SUCCESS',
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        provider: provider ?? null, requestedModel: requestedModel ?? null,
        returnedModel: returnedModel ?? null, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
        providerRequestId: requestId ?? null, usage: usage && typeof usage === 'object' ? usage : null,
        requestFields: Array.isArray(requestFields) ? requestFields.filter((value) => typeof value === 'string').slice(0, 32) : null,
        streaming: streaming === true,
        message: `API_USAGE provider=${provider ?? 'unknown'} http_status=${Number.isInteger(httpStatus) ? httpStatus : 'unknown'} duration=${Number.isFinite(durationMs) ? durationMs : '?'}ms`,
      });
    },
    // P9-R0.1 Part L: purely observational, additive event kinds — used
    // today only by the Antigravity backend's context-fed prompt assembly
    // (production-pm-backend-registry.mjs). Never the raw context packet
    // text or a raw denied command line — only bounded booleans/counts and
    // sanitized tool-denial metadata (tool name + a fixed reason code).
    // P9-R0.3 Part I: `effortForwarded` (optional — other backends never
    // pass it, so it's simply absent from their CONTEXT lines) reports
    // whether --effort/-equivalent was actually sent this run, so
    // execution log never implies more than DSH really did.
    context(ctx, { projectFacts, councilEvidence, bytes, effortForwarded } = {}) {
      safeEmit({ ...ctx, phase: 'CONTEXT', eventKind: 'CONTEXT', message: `CONTEXT projectFacts=${Boolean(projectFacts)} councilEvidence=${Boolean(councilEvidence)} bytes=${Number.isFinite(bytes) ? bytes : 0}${effortForwarded === undefined ? '' : ` effortForwarded=${Boolean(effortForwarded)}`}` });
    },
    toolDenied(ctx, { tool, reason } = {}) {
      safeEmit({ ...ctx, phase: 'TOOL_DENIED', eventKind: 'TOOL_DENIED', message: `TOOL_DENIED tool=${tool ?? 'unknown'} reason=${reason ?? 'permission_denied'}` });
    },
    // P10-R0.2.1 Part M/N: a distinct, structured event for a backend
    // execution that was killed by DSH's own timeout policy (never a
    // generic exit/parse failure). `ctx.stage` — set by createCliPmDriver()
    // in production-pm-backend-registry.mjs from the caller's
    // `executionOptions.stage` (pm-execution-timeout-policy.mjs) — is what
    // lets Backend Execution and the task-scoped diagnostic bridge
    // (task-diagnostic-log.mjs's forwardBackendEventToTaskLog()) both show
    // WHICH timeout class fired without re-deriving it. Every numeric/
    // boolean field defaults to `null` rather than being omitted, so a
    // backend whose bridge doesn't yet report this depth (every backend
    // except claude-code today — Part E) still produces a well-shaped,
    // honestly-partial event instead of a differently-shaped one.
    timeout(ctx, { timeoutMs, elapsedMs, processPid, stdoutBytes, stderrBytes, assistantOutputPresent, terminationRequested } = {}) {
      safeEmit({
        ...ctx, phase: 'TIMEOUT', eventKind: 'TIMEOUT',
        pid: typeof processPid === 'number' ? processPid : null,
        durationMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
        stdoutBytes: Number.isFinite(stdoutBytes) ? stdoutBytes : null,
        stderrBytes: Number.isFinite(stderrBytes) ? stderrBytes : null,
        assistantOutputPresent: typeof assistantOutputPresent === 'boolean' ? assistantOutputPresent : null,
        terminationRequested: terminationRequested === true,
        message: `TIMEOUT stage=${ctx.stage ?? 'unknown'} product=${ctx.backendProduct ?? 'unknown'} timeout=${Number.isFinite(timeoutMs) ? timeoutMs : '?'}ms elapsed=${Number.isFinite(elapsedMs) ? elapsedMs : '?'}ms pid=${processPid ?? 'unknown'}`,
      });
    },
    // P10-R0.2.2 Part G/Q: Codex Windows sandbox readiness/execution
    // classification — a structural READY/DEGRADED/UNKNOWN readiness fact
    // (pre-execution, filesystem-only — codex-cli-session-bridge.mjs's
    // probeCodexWindowsSandboxHelper()) combined with a post-execution
    // OK/FAILED/NOT_ATTEMPTED classification read from the already-
    // captured stdout events (classifyCodexSandboxExecution()). Never
    // changes any PM decision outcome by itself (Part H) — purely
    // additive diagnostics attached alongside whatever the real parser/
    // normalizer already decided. Backend-specific (codex only today) but
    // stage-agnostic — fires for both SINGLE and COUNCIL codex calls.
    sandbox(ctx, { state, failureCode, helperResolution, helperExecution } = {}) {
      safeEmit({
        ...ctx, phase: 'CODEX_SANDBOX', eventKind: 'CODEX_SANDBOX',
        status: state ?? 'UNKNOWN',
        message: `CODEX_SANDBOX state=${state ?? 'UNKNOWN'} helper_resolution=${helperResolution ?? 'UNKNOWN'} helper_execution=${helperExecution ?? 'NOT_ATTEMPTED'}${failureCode ? ` failure_code=${failureCode}` : ''}`,
        sandboxState: state ?? 'UNKNOWN', sandboxFailureCode: failureCode ?? null,
        helperResolution: helperResolution ?? 'UNKNOWN', helperExecution: helperExecution ?? 'NOT_ATTEMPTED',
      });
    },
    // P10-R0.2.2 Part K/O: await_owner contract validation/repair
    // diagnostics — SINGLE-task-only (production-pm-backend-registry.mjs
    // gates this to `ctx.stage === 'single_pm'`). Structural facts only:
    // decision type, normalization OK/FAILED, a bounded (240-char)
    // validator reason string (never raw model text — normalizePmDecision's
    // own error messages are short, static, template strings — see
    // pm-contracts.mjs), token count/validity, and whether a repair was
    // attempted/its outcome. Never the owner-facing prompt/title text
    // itself.
    awaitOwnerContract(ctx, { decisionType, normalizationResult, normalizationError, allowedResponseCount, allowedResponseTokensValid, repairAttempted, repairResult } = {}) {
      safeEmit({
        ...ctx, phase: 'AWAIT_OWNER_CONTRACT', eventKind: 'AWAIT_OWNER_CONTRACT',
        status: normalizationResult ?? 'UNKNOWN',
        message: `AWAIT_OWNER_CONTRACT normalization=${normalizationResult ?? 'UNKNOWN'} repair_attempted=${Boolean(repairAttempted)} repair_result=${repairResult ?? 'NONE'}`,
        decisionType: decisionType ?? null, normalizationResult: normalizationResult ?? 'UNKNOWN',
        normalizationError: normalizationError ?? null, allowedResponseCount: Number.isFinite(allowedResponseCount) ? allowedResponseCount : null,
        allowedResponseTokensValid: typeof allowedResponseTokensValid === 'boolean' ? allowedResponseTokensValid : null,
        repairAttempted: repairAttempted === true, repairResult: repairResult ?? null,
      });
    },
    // PARSER-0: truthful layered diagnostics (src/pm/parser-0-diagnostics.mjs)
    // — a versioned, bounded, content-free fact set (fixed enums, booleans,
    // counts, byte lengths) emitted beside the unchanged public error codes.
    // Never raw assistant output, never hidden reasoning, never credentials
    // or full provider payloads. Purely additive and read-only: a missing
    // method on a custom observer is a no-op (the registry's observe() guard
    // already swallows that), and nothing branches on this event.
    layeredDiagnostic(ctx, diagnostic = {}) {
      const d = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
      safeEmit({
        ...ctx,
        phase: 'LAYERED_DIAGNOSTIC',
        eventKind: 'LAYERED_DIAGNOSTIC',
        diagnostic: d,
        message: `LAYERED_DIAGNOSTIC v=${d.diagnostic_version ?? 'unknown'} execution=${d.execution_state ?? 'unknown'} parser_attempted=${d.parser_attempted ?? 'unknown'} parser_state=${d.parser_state ?? 'unknown'} assistant_output_present=${d.assistant_output_present ?? 'unknown'}`,
      });
    },
    // P10-R0.2.4 Part W/AE: an activity-aware liveness STATE CHANGE only —
    // never fired per byte-chunk/per-poll-tick (Part AQ: no event spam).
    // `from`/`to` are backend-liveness-tracker.mjs's LIVENESS_STATE values;
    // fired only for LONG-runtime-class executions (Part S) by
    // withBackendLiveness()'s decorator — every other execution never
    // calls this method at all.
    liveness(ctx, { from, to, lastActivityKind, lastActivityAgeMs, elapsedMs, pid } = {}) {
      safeEmit({
        ...ctx, phase: 'BACKEND_LIVENESS_STATE', eventKind: 'BACKEND_LIVENESS_STATE',
        status: to ?? 'UNKNOWN',
        pid: typeof pid === 'number' ? pid : null,
        message: `BACKEND_LIVENESS_STATE ${from ?? 'NONE'} -> ${to ?? 'UNKNOWN'} last_activity=${lastActivityKind ?? 'unknown'} age_ms=${Number.isFinite(lastActivityAgeMs) ? lastActivityAgeMs : '?'} elapsed_ms=${Number.isFinite(elapsedMs) ? elapsedMs : '?'}`,
        livenessFrom: from ?? null, livenessTo: to ?? 'UNKNOWN',
        lastActivityKind: lastActivityKind ?? null,
        lastActivityAgeMs: Number.isFinite(lastActivityAgeMs) ? lastActivityAgeMs : null,
        durationMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      });
    },
  });
}

/**
 * Wrap a node:child_process-compatible spawn implementation so registry-
 * level code can observe PROCESS_SPAWN / stdout chunks / stderr chunks /
 * PROCESS_EXIT for any of the four CLI bridges — without altering their
 * own stdout/stderr accumulation or parsing in any way. This *adds* a
 * listener alongside each bridge's own `data`/`exit` listeners; it never
 * replaces them, consumes the stream exclusively, or changes backpressure
 * (Node allows multiple listeners on the same stream/event safely).
 */
export function withSpawnObservation(spawnImpl, observer, ctx) {
  if (!observer || typeof spawnImpl !== 'function') return spawnImpl;
  // Every individual callback is wrapped on its own — not just the
  // synchronous registration below — because a `data`/`exit` listener
  // that throws propagates synchronously out of the stream's own `emit`
  // call (Node invokes listeners synchronously), which could otherwise
  // disrupt the bridge's own stdout/stderr handling or crash the
  // process. A single outer try/catch around registration alone would
  // not catch that: it only protects the (non-throwing) act of calling
  // `.on(...)`/`.once(...)`, not the callback bodies invoked later.
  const guarded = (fn) => (...cbArgs) => { try { fn(...cbArgs); } catch { /* never break the real spawn */ } };
  return (...args) => {
    const child = spawnImpl(...args);
    try {
      guarded(() => observer.spawn(ctx, { pid: child?.pid }))();
      child?.stdout?.on?.('data', guarded((chunk) => observer.stdoutChunk(ctx, { length: Buffer.byteLength(String(chunk)) })));
      child?.stderr?.on?.('data', guarded((chunk) => observer.stderrChunk(ctx, { text: String(chunk) })));
      child?.once?.('exit', guarded((code, signal) => observer.exit(ctx, { exitCode: code, signal })));
    } catch {
      // Never let observation break the real spawn.
    }
    return child;
  };
}

/**
 * Bind the canonical execution AbortSignal to the exact child created by a
 * backend bridge. The bridge still owns parsing and normal timeout handling;
 * this wrapper only closes the process lifetime gap during owner cancel or
 * runtime shutdown. Escalation is scoped to that same ChildProcess object --
 * never a name-based or machine-wide process sweep.
 */
// R7.3: map each task AbortSignal to the exact provider processes it owns.
// This lets orchestration await OS reaping instead of merely requesting it.
const ownedTerminationBySignal = new WeakMap();
let activeOwnedProviderProcesses = 0;
export function activeOwnedProviderProcessCount() { return activeOwnedProviderProcesses; }

export function withReapedOwnedSpawnLifecycle(spawnImpl, signal, { gracefulAfterMs = 500, reapAfterMs = 5_000, taskkillSpawn } = {}) {
  if (typeof spawnImpl !== 'function' || !signal || typeof signal.addEventListener !== 'function') return spawnImpl;
  return (...args) => {
    const child = spawnImpl(...args);
    activeOwnedProviderProcesses += 1;
    let resolveReaped;
    let resolveSettlement;
    let finished = false;
    const reaped = new Promise((resolve) => { resolveReaped = resolve; });
    const settlement = new Promise((resolve) => { resolveSettlement = resolve; });
    let owned = ownedTerminationBySignal.get(signal);
    if (!owned) { owned = new Set(); ownedTerminationBySignal.set(signal, owned); }
    owned.add(settlement);
    const complete = () => {
      if (finished) return;
      finished = true;
      activeOwnedProviderProcesses = Math.max(0, activeOwnedProviderProcesses - 1);
      owned.delete(settlement);
      signal.removeEventListener('abort', terminate);
      try { child.__dshOwnershipState = 'CONFIRMED_EXITED'; } catch {}
      resolveReaped();
      resolveSettlement({ state: 'CONFIRMED_EXITED', pid: child?.pid ?? null });
    };
    const boundedWait = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
    const forceTree = () => new Promise((resolve) => {
      if (finished || child?.exitCode != null || child?.signalCode != null || !Number.isInteger(child?.pid)) return resolve();
      if (process.platform !== 'win32') {
        try { child.kill('SIGKILL'); } catch {}
        return resolve();
      }
      try {
        const killer = (taskkillSpawn ?? nodeSpawn)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.once?.('error', resolve);
        killer.once?.('close', resolve);
      } catch { resolve(); }
    });
    // DSH-TIMEOUT-1 Part E (Finding T-4): `terminate()` now has two possible
    // triggers — the pre-existing `signal` abort listener below (owner
    // cancel/shutdown) AND, new this wave, a bridge's OWN internal timeout
    // calling `child.__dshReapOwnedProcessTree()` directly (see this
    // property's assignment and provider-child-policy.mjs's
    // reapOwnedChildProcess() docstring). `inFlight` makes a second,
    // concurrent trigger converge on the SAME single execution — never a
    // second overlapping SIGTERM/taskkill sequence racing the first — while
    // still being a total no-op once `finished` is already true (the child
    // already exited/closed/errored on its own).
    let inFlight = null;
    function terminate() {
      if (finished) return Promise.resolve({ state: 'CONFIRMED_EXITED', pid: child?.pid ?? null });
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try { child?.kill?.('SIGTERM'); } catch {}
        await Promise.race([reaped, boundedWait(gracefulAfterMs)]);
        if (!finished) await Promise.race([forceTree(), boundedWait(reapAfterMs)]);
        await Promise.race([reaped, boundedWait(reapAfterMs)]);
        if (!finished) {
          const unresolved = { state: 'UNRESOLVED_OWNERSHIP', pid: child?.pid ?? null };
          try { child.__dshOwnershipState = unresolved.state; } catch {}
          resolveSettlement(unresolved);
          return unresolved;
        }
        try { child.__dshOwnershipState = 'CONFIRMED_EXITED'; } catch {}
        return { state: 'CONFIRMED_EXITED', pid: child?.pid ?? null };
      })();
      return inFlight;
    }
    child?.once?.('exit', complete);
    child?.once?.('close', complete);
    child?.once?.('error', complete);
    if (signal.aborted) void terminate();
    else signal.addEventListener('abort', terminate, { once: true });
    // DSH-TIMEOUT-1 Part E (Finding T-4): expose the SAME `terminate()`
    // primitive to the bridge that owns this exact child, so a bridge-level
    // timeout (each `*-session-bridge.mjs`'s own bounded `setTimeout`) can
    // request full owned-process-tree cleanup instead of a bare
    // `child.kill()` (immediate process only, on Windows no `/T` tree
    // flag). Only ever attached here — the one place a real production
    // spawn is wrapped with a live `signal` — so a direct/test caller with
    // its own unwrapped `spawnImpl` never sees this property and every
    // bridge's `reapOwnedChildProcess()` call falls back to the exact
    // prior `child.kill()` behavior for them, unchanged.
    try { child.__dshReapOwnedProcessTree = terminate; } catch { /* best-effort decoration only, never fails the real spawn */ }
    return child;
  };
}

export async function awaitOwnedSpawnReaping(signal) {
  const owned = signal && ownedTerminationBySignal.get(signal);
  if (owned?.size) {
    const results = await Promise.all([...owned]);
    const unresolved = results.find((result) => result?.state === 'UNRESOLVED_OWNERSHIP');
    if (unresolved) {
      const error = new Error('Owned provider process exit could not be confirmed.');
      error.code = 'PROCESS_OWNERSHIP_UNRESOLVED';
      error.ownershipState = unresolved.state;
      error.processPid = unresolved.pid;
      throw error;
    }
  }
}
