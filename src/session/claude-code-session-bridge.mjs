import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {buildProviderChildEnv,providerExecutablePolicy,reapOwnedChildProcess,resolveProviderExecutable,resolveProviderExecutableSync} from './provider-child-policy.mjs';
import { createStreamSummaryAccumulator } from './stream-summary.mjs';

export class ClaudeCodeSessionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ClaudeCodeSessionError';
    Object.assign(this, extra);
  }
}

// P18-W4R3: the installed CLI's own documented `--permission-mode` choices
// (2.1.235 `claude --help`), read directly rather than assumed. Validated
// here, before ever spawning, so an unrecognized/malformed value (a typo,
// a future CLI removing a mode, an unrelated caller passing garbage) fails
// closed with a typed, no-subprocess error instead of either silently
// reaching the CLI's own argv rejection or — worse — being misread as a
// real permission mode. `plan` (read-only) and `bypassPermissions`
// (empirically verified execution-capable — see pm-execution-timeout-
// policy.mjs's PM_PERMISSION_MODE docstring) are the two values DSH's own
// orchestration ever selects; the other four remain valid for any other
// caller of this general-purpose bridge.
export const KNOWN_CLAUDE_PERMISSION_MODES = Object.freeze(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);

export const CLAUDE_BINARY_CANDIDATES = Object.freeze([
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
]);

export function resolveClaudeExecutable() {
  return resolveProviderExecutableSync(providerExecutablePolicy({provider:'claude-code',executableName:'claude',knownCandidates:CLAUDE_BINARY_CANDIDATES}));
}
export function resolveClaudeBinary() {
  return resolveClaudeExecutable().path ?? '';
}

// P6.5 Part C/E: async, non-blocking counterpart to resolveClaudeBinary()
// above — same candidate search, no synchronous spawn. Used only by
// Electron main (Connection Center's registry construction) and the
// Login Terminal's binary resolution; the runtime child process keeps
// using the synchronous resolver unchanged (see binary-resolution-async
// .mjs's docstring for why that's safe).
export async function resolveClaudeBinaryAsync() {
  return (await resolveProviderExecutable(providerExecutablePolicy({provider:'claude-code',executableName:'claude',knownCandidates:CLAUDE_BINARY_CANDIDATES}))).path ?? '';
}

export const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 120_000;

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClaudeCodeSessionError(`${label} must be a non-empty string`, { code: 'INVALID_CLAUDE_SESSION_INPUT' });
  }
  return value;
}

function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function runClaudeProcess({
  binary = resolveClaudeBinary() || 'claude',
  cwd = process.cwd(),
  prompt,
  resume = null,
  ephemeral = false,
  stream = false,
  permissionMode = 'plan',
  model,
  // P6-W3-R4 Part F2: DSH's typed profile.reasoning value, passed through
  // verbatim to Claude Code's own documented --effort flag (accepted
  // values: low, medium, high, xhigh, max — see pm-reasoning-capability
  // .mjs). Never invented, never applied to a backend that doesn't support
  // it.
  effort,
  timeoutMs = CLAUDE_CODE_DEFAULT_TIMEOUT_MS,
  // P10-R0.1.2 Part B-D: OPTIONAL native structured-output request, live-
  // proven against the owner's installed CLI (2.1.235) — see
  // docs/p10/05_CLAUDE_NATIVE_STRUCTURED_OUTPUT_PILOT_SONNET5.md. A plain
  // JSON-Schema object; `null`/omitted (the default) means the CLI
  // invocation is BYTE-FOR-BYTE UNCHANGED from before this wave — no new
  // flag, no behavior change for any existing caller.
  jsonSchema = null,
  // P6-W3-R3 Part B: purely an observation seam (mirrors the existing
  // codex/grok bridges' `spawnImpl` injection point) — defaults to the
  // real node:child_process spawn, so behavior is unchanged unless a
  // caller wraps it (e.g. withSpawnObservation() in
  // production-pm-backend-registry.mjs, or a test double).
  spawnImpl = spawn,
} = {}) {
  requireString(binary, 'binary');
  requireString(prompt, 'prompt');
  if (resume !== null) requireString(resume, 'resume');
  requireString(permissionMode, 'permissionMode');
  if (!KNOWN_CLAUDE_PERMISSION_MODES.includes(permissionMode)) {
    throw new ClaudeCodeSessionError(`unknown Claude permission mode: ${permissionMode}`, {
      code: 'CLAUDE_PERMISSION_MODE_UNKNOWN', permissionMode, knownModes: KNOWN_CLAUDE_PERMISSION_MODES,
    });
  }

  const args = ['-p'];
  if (ephemeral) args.push('--no-session-persistence','--tools','');
  if (resume) args.push('--resume', resume);
  args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', requireString(model, 'model'));
  if (effort) args.push('--effort', requireString(effort, 'effort'));
  if (stream) args.push('--output-format', 'stream-json', '--verbose');
  else args.push('--output-format', 'json');
  // P10-R0.1.2 Part C/G: the exact live-proven flag, one argv element per
  // array slot (spawn() with an argument array never invokes a shell —
  // node:child_process.spawn's default `shell:false` — so a schema
  // containing quotes/braces/newlines is never a shell-interpolation
  // hazard, unlike string-concatenated argv would be).
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // DSH T5 ENAMETOOLONG: Claude Code's print mode accepts its text input
    // from stdin when no positional prompt is supplied. Keep argv limited
    // to bounded control flags and stream the potentially large model
    // prompt through the child's pipe. The former positional argv transport
    // exceeded Windows' process command-line limit for a full multi-file
    // WORKSPACE_READ packet, so ChildProcess.spawn threw ENAMETOOLONG before
    // a process (and therefore before PROCESS_SPAWN) existed.
    const child = spawnImpl(binary, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: buildProviderChildEnv({provider:'claude-code'}) });
    // P10-R0.2.1 Part I/J: captured once, synchronously, right after spawn
    // — `child.pid` is set by Node before `spawn()` returns for a real
    // child_process, and a test double's fake child may set it the same
    // way. `null` (never `undefined`) when genuinely unknown, so a
    // timeout's diagnostic payload always has a stable, typed shape.
    const pid = typeof child?.pid === 'number' ? child.pid : null;
    let stdout = '';
    let stderr = '';
    const streams = createStreamSummaryAccumulator();
    const events = [];
    let settled = false;

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      // Part J: Node's `child.kill()` on Windows uses TerminateProcess, not
      // a real POSIX signal — the eventual 'close'/'exit' handlers below
      // are the only place that ever legitimately learns a real
      // signal/exit code, and by the time they might fire this call has
      // already settled (Part V: never re-resolve/re-reject after
      // `settled` is true). Rather than invent a SIGTERM this process
      // never actually confirmed, the timeout error reports what DSH
      // itself knows for certain right now: it requested termination.
      //
      // DSH-TIMEOUT-1 Part E (Finding T-4): `reapOwnedChildProcess()`
      // reuses the SAME bounded SIGTERM -> grace -> `taskkill /T /F`
      // (Windows, full owned process tree) / SIGKILL (POSIX) -> reap-wait
      // sequence owner-cancel/shutdown already gets (production only —
      // withReapedOwnedSpawnLifecycle() attaches it; every direct/test
      // caller with its own bare spawnImpl falls back to the exact prior
      // `child.kill()` behavior). Bounded (~5.5s worst case) — this still
      // never waits indefinitely for a real exit confirmation, so
      // `observedSignal`/`observedExitCode` below stay honestly `null`.
      await reapOwnedChildProcess(child);
      const elapsedMs = Date.now() - startedAt;
      reject(new ClaudeCodeSessionError(`claude process timed out after ${timeoutMs}ms`, {
        code: 'CLAUDE_TIMEOUT', stderr, stdout,
        timeoutMs, elapsedMs, processPid: pid,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        assistantOutputPresent: stdout.trim() !== '',
        terminationRequestedByDsh: true,
        observedSignal: null,
        observedExitCode: null,
        streamSummary: streams.snapshot(),
      }));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin?.on?.('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeCodeSessionError(`failed to send prompt to claude: ${error.message}`, {
        code: 'CLAUDE_STDIN_FAILED', cause: error,
      }));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      streams.stdout(chunk);
      if (stream) {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const parsed = parseJsonLine(line);
          if (parsed) events.push(parsed);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; streams.stderr(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeCodeSessionError(`failed to start claude: ${error.message}`, {
        code: 'CLAUDE_SPAWN_FAILED', cause: error,
      }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ClaudeCodeSessionError(`claude exited with code ${code}${signal ? ` signal ${signal}` : ''}`, {
          code: 'CLAUDE_EXIT_FAILED', exitCode: code, signal, stderr, stdout,
        }));
        return;
      }
      try {
        if (stream) {
          const allEvents = events.length > 0
            ? events
            : stdout.split(/\r?\n/).filter(Boolean).map(parseJsonLine).filter(Boolean);
          const resultEvent = [...allEvents].reverse().find((event) => event?.type === 'result') ?? null;
          resolve({
            sessionId: resultEvent?.session_id ?? resultEvent?.sessionId ?? null,
            result: resultEvent?.result ?? null,
            events: allEvents,
            stdout,
            stderr,
          });
        } else {
          const parsed = JSON.parse(stdout.trim());
          // P10-R0.1.2 Part H: `structuredOutput` is additive — every
          // existing caller reading only `.result`/`.sessionId`/`.raw` is
          // completely unaffected. Live-proven envelope field name:
          // `structured_output` (docs/p10/05_CLAUDE_NATIVE_STRUCTURED_OUTPUT_PILOT_SONNET5.md).
          const structuredOutput = parsed?.structured_output ?? null;
          if (jsonSchema && structuredOutput === null) {
            // Part H/C item 7 (live-proven): a schema the model genuinely
            // cannot satisfy still exits 0 with `is_error:false` and a
            // free-form `result` explaining why — no `structured_output`
            // key at all. This is a DISTINCT, typed failure from a
            // malformed-outer-JSON transport error (which the JSON.parse
            // above would already have thrown) — never silently falls
            // through to treating prose as the decision text.
            // `settled`/`clearTimeout` already happened at the top of this
            // close handler (line above the `try` block) — no need to redo.
            reject(new ClaudeCodeSessionError('claude did not return the requested structured output', {
              code: 'CLAUDE_STRUCTURED_OUTPUT_MISSING', stdout, stderr,
            }));
            return;
          }
          resolve({
            sessionId: parsed?.session_id ?? parsed?.sessionId ?? null,
            result: parsed?.result ?? null,
            structuredOutput,
            raw: parsed,
            stdout,
            stderr,
          });
        }
      } catch (error) {
        reject(new ClaudeCodeSessionError(`failed to parse claude output: ${error.message}`, {
          code: 'CLAUDE_OUTPUT_PARSE_FAILED', stdout, stderr, cause: error,
        }));
      }
    });
    // Attach every stream/process error handler before writing. A real
    // ChildProcess always has stdin because stdio[0] is `pipe`; optional
    // chaining retains compatibility with minimal observation test doubles.
    child.stdin?.end?.(prompt);
  });
}

export class ClaudeCodeSessionBridge {
  #runner;
  #defaults;

  constructor({ runner = runClaudeProcess, ...defaults } = {}) {
    if (typeof runner !== 'function') throw new TypeError('ClaudeCodeSessionBridge requires a runner function');
    this.#runner = runner;
    this.#defaults = defaults;
  }

  async createSession(prompt, options = {}) {
    const out = await this.#runner({ ...this.#defaults, ...options, prompt: requireString(prompt, 'prompt'), resume: null, stream: false });
    if (!out?.sessionId) {
      throw new ClaudeCodeSessionError('claude returned no session id for a new session', { code: 'MISSING_SESSION_ID', output: out });
    }
    return out;
  }

  async resume(sessionId, options = {}) {
    requireString(sessionId, 'sessionId');
    if (options.prompt === undefined) return { sessionId, resumed: true };
    return this.sendNextTurn(sessionId, options.prompt, options);
  }

  async sendNextTurn(sessionId, message, options = {}) {
    const out = await this.#runner({
      ...this.#defaults,
      ...options,
      prompt: requireString(message, 'message'),
      resume: requireString(sessionId, 'sessionId'),
      stream: false,
    });
    if (out?.sessionId && out.sessionId !== sessionId) {
      throw new ClaudeCodeSessionError(`resumed Claude session changed id: ${sessionId} -> ${out.sessionId}`, {
        code: 'SESSION_ID_CHANGED', expected: sessionId, actual: out.sessionId,
      });
    }
    return { ...out, sessionId: out?.sessionId ?? sessionId };
  }

  async streamTurn(sessionId, message, options = {}) {
    const out = await this.#runner({
      ...this.#defaults,
      ...options,
      prompt: requireString(message, 'message'),
      resume: requireString(sessionId, 'sessionId'),
      stream: true,
    });
    if (out?.sessionId && out.sessionId !== sessionId) {
      throw new ClaudeCodeSessionError(`streamed Claude session changed id: ${sessionId} -> ${out.sessionId}`, {
        code: 'SESSION_ID_CHANGED', expected: sessionId, actual: out.sessionId,
      });
    }
    return { ...out, sessionId: out?.sessionId ?? sessionId };
  }
}

export const CLAUDE_DOCUMENTED_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: true,
  send_next_turn: true,
  interrupt_active_turn: false,
  stream_events: true,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});

export const CLAUDE_UNPROVEN_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: false,
  send_next_turn: false,
  interrupt_active_turn: false,
  stream_events: false,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});
