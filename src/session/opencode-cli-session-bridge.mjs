import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {buildProviderChildEnv,providerExecutableNeedsShell,providerExecutablePolicy,reapOwnedChildProcess,resolveProviderExecutable,resolveProviderExecutableSync} from './provider-child-policy.mjs';
import { createStreamSummaryAccumulator } from './stream-summary.mjs';

export class OpenCodeSessionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'OpenCodeSessionError';
    this.code = extra.code ?? 'OPENCODE_SESSION_ERROR';
    Object.assign(this, extra);
  }
}

export const OPENCODE_BINARY_CANDIDATES = Object.freeze([
  join(homedir(), '.opencode', 'bin', 'opencode'),
  join(homedir(), '.local', 'bin', 'opencode'),
  join(homedir(), 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
]);

export function resolveOpenCodeExecutable() { return resolveProviderExecutableSync(providerExecutablePolicy({provider:'opencode',executableName:'opencode',knownCandidates:OPENCODE_BINARY_CANDIDATES})); }
export function resolveOpenCodeBinary() { return resolveOpenCodeExecutable().path ?? ''; }

export async function resolveOpenCodeBinaryAsync() {
  return (await resolveProviderExecutable(providerExecutablePolicy({provider:'opencode',executableName:'opencode',knownCandidates:OPENCODE_BINARY_CANDIDATES}))).path ?? '';
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenCodeSessionError(`${label} must be a non-empty string`, { code: 'INVALID_OPENCODE_INPUT' });
  }
  return value;
}

function parseJsonLines(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Keep CLI proof conservative: non-JSON lines are allowed as diagnostics,
      // but do not count toward stream_events.
    }
  }
  return events;
}

function findSessionId(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const key of ['sessionID', 'sessionId', 'session_id']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  if (value.session && typeof value.session.id === 'string') return value.session.id;
  for (const nested of Object.values(value)) {
    const found = findSessionId(nested, seen);
    if (found) return found;
  }
  return null;
}

export function summarizeOpenCodeRun({ stdout = '', stderr = '', code = null } = {}) {
  const events = parseJsonLines(stdout);
  const sessionId = events.map((event) => findSessionId(event)).find(Boolean) ?? null;
  return { code, stdout, stderr, events, sessionId };
}

export function extractOpenCodeAssistantText(summary) {
  const parts=[];
  for(const event of summary?.events??[]){
    if(event?.type==='text'&&event?.part?.type==='text'&&typeof event.part.text==='string'){
      const text=event.part.text.replace(/^[\u200B-\u200D\u2060\uFEFF]+|[\u200B-\u200D\u2060\uFEFF]+$/g,'');if(text.length)parts.push(text);
    }
  }
  if(parts.length===0)throw new OpenCodeSessionError('OpenCode assistant output is missing',{code:'OPENCODE_ASSISTANT_OUTPUT_MISSING'});
  return parts.join('');
}

// DSH-TIMEOUT-1 Part D (audit Finding T-3): see CODEX_CLI_DEFAULT_TIMEOUT_MS's
// identical docstring (codex-cli-session-bridge.mjs) — the ONE named source
// of truth for this bridge's own default, reused as both this function's
// default parameter and production-pm-backend-registry.mjs's forwarding
// floor.
export const OPENCODE_DEFAULT_TIMEOUT_MS = 180_000;

export function runOpenCodeProcess({
  binary = resolveOpenCodeBinary(),
  cwd = process.cwd(),
  prompt,
  sessionId = null,
  format = 'json',
  timeoutMs = OPENCODE_DEFAULT_TIMEOUT_MS,
  extraArgs = [],
  // P6-W3-R3 Part B: observation seam only, mirrors codex/grok's existing
  // `spawnImpl` injection point — defaults to the real spawn.
  spawnImpl = spawn,
} = {}) {
  requireString(prompt, 'prompt');
  const args = ['run'];
  if (sessionId !== null) args.push('--session', requireString(sessionId, 'sessionId'));
  if (format) args.push('--format', format);
  // P16-LIVE-004: live reproduction proved the OpenCode CLI does not
  // reliably resolve its own project root from the spawned process's OS
  // cwd alone (observed reading the wrong, unrelated directory even with
  // `cwd` correctly set on the child process) -- `--dir` is OpenCode's own
  // documented flag for this and reproduced correctly every time. Must
  // remain explicit even when the prompt is supplied through stdin.
  // Installed OpenCode 1.18.18 reads Bun.stdin.text() for non-TTY stdin
  // in its run handler and uses it as the message when no positional is
  // supplied. No '-' sentinel: that would become part of the message.
  args.push('--dir', cwd, ...extraArgs);

  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: providerExecutableNeedsShell(binary),
      env: buildProviderChildEnv({provider:'opencode'}),
    });
    const startedAt = Date.now();
    const streams = createStreamSummaryAccumulator();
    let stdout = '';
    let stderr = '';
    let settled = false;
    // DSH-TIMEOUT-1 Part E (Finding T-4): `child.kill()` replaced with
    // `reapOwnedChildProcess(child)` — see provider-child-policy.mjs's
    // docstring — reusing the SAME bounded owned-process-tree cleanup
    // owner-cancel/shutdown already gets. Also fixes a pre-existing gap
    // found while editing this exact callback: `settled` was checked but
    // never actually set `true` here (every sibling handler below already
    // does), so a 'close'/'error' event arriving after this timeout fired
    // would redundantly attempt its own settle (harmless — a Promise only
    // ever settles once — but wasted work, and now also a correctness
    // requirement for the `await` below to be race-safe against those
    // handlers exactly like claude-code-session-bridge.mjs's identical
    // pattern already is).
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await reapOwnedChildProcess(child);
      reject(new OpenCodeSessionError(`OpenCode process timeout after ${timeoutMs}ms`, {
        code: 'OPENCODE_TIMEOUT', timeoutMs, elapsedMs: Date.now() - startedAt,
        processPid: child?.pid ?? null, assistantOutputPresent: streams.snapshot().stdout_total_bytes > 0,
        terminationRequestedByDsh: true, streamSummary: streams.snapshot(),
      }));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; streams.stdout(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; streams.stderr(chunk); });
    child.stdin?.on?.('error', async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await reapOwnedChildProcess(child);
      reject(new OpenCodeSessionError('failed to send prompt to OpenCode', { code: 'OPENCODE_STDIN_FAILED', cause: error }));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new OpenCodeSessionError(`failed to spawn OpenCode: ${error.message}`, { code: 'OPENCODE_SPAWN_FAILED', cause: error }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const summary = summarizeOpenCodeRun({ stdout, stderr, code });
      if (code !== 0) {
        reject(new OpenCodeSessionError(`OpenCode exited ${code}: ${stderr.trim() || stdout.trim()}`, { code: 'OPENCODE_RUN_FAILED', summary }));
        return;
      }
      resolve(summary);
    });
    child.stdin?.end?.(prompt);
  });
}

export class OpenCodeCliSessionBridge {
  #runner;
  #cwd;
  #binary;

  constructor({ runner = runOpenCodeProcess, cwd = process.cwd(), binary = resolveOpenCodeBinary() } = {}) {
    this.#runner = runner;
    this.#cwd = cwd;
    this.#binary = binary;
  }

  get binary() { return this.#binary; }

  async createSession(prompt, options = {}) {
    const result = await this.#runner({ binary: this.#binary, cwd: this.#cwd, prompt, ...options });
    if (!result.sessionId) {
      throw new OpenCodeSessionError('OpenCode JSON output contained no native session id', { code: 'MISSING_OPENCODE_SESSION_ID', result });
    }
    return result;
  }

  async resume(sessionId, options = {}) {
    requireString(sessionId, 'sessionId');
    return { sessionId, resumed: true, options };
  }

  async sendNextTurn(sessionId, message, options = {}) {
    return this.#runner({ binary: this.#binary, cwd: this.#cwd, prompt: requireString(message, 'message'), sessionId: requireString(sessionId, 'sessionId'), ...options });
  }

  subscribeEvents(_sessionId, listener) {
    if (typeof listener !== 'function') throw new OpenCodeSessionError('listener must be a function', { code: 'INVALID_OPENCODE_INPUT' });
    // CLI mode emits events only for the duration of each run; callers consume
    // the returned `events` array. This method intentionally does not claim a
    // live subscription across processes.
    return () => {};
  }
}

export const OPENCODE_DOCUMENTED_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: true,
  send_next_turn: true,
  interrupt_active_turn: false,
  stream_events: true,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});

export const OPENCODE_UNPROVEN_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: false,
  send_next_turn: false,
  interrupt_active_turn: false,
  stream_events: false,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});
