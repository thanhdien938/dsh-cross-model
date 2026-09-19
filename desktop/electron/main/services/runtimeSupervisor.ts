import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { RuntimeStatus } from '../types';
import { NamedPipeClient } from './namedPipeClient';

const SHUTDOWN_TIMEOUT_MS = 30000;
// P13-R7.1 (docs/p13/15A_*.md): a real R7 live defect -- normal Restart
// reported "Process exit timeout" even though the runtime process really
// did exit soon after. Root cause: this single SHUTDOWN_TIMEOUT_MS
// constant was reused for TWO structurally different waits --
// (1) the pipe SHUTDOWN command's acknowledgement (in practice near-
// instant: the control server acks with `{status:'DRAINING'}` and only
// THEN queues the real shutdown work -- src/runtime/local-runtime-
// control.mjs), and (2) waiting for the real OS process to actually
// exit, which must additionally cover the runtime's own drain grace
// period, its abort+confirm phase, and full store teardown. Sharing one
// 30s budget between both left (2) with, at best, the entire 30s and no
// margin for (1)'s round trip or any of the runtime-side work -- with a
// genuinely active task at shutdown time, exceeding it was structurally
// near-guaranteed even with no other race involved. Decoupled here;
// paired with scripts/p5-runtime.mjs's own reduced interactive-shutdown
// drain grace period (5s, was effectively 30s), EXIT_WAIT_TIMEOUT_MS's
// margin is generous for the normal case while remaining a bounded,
// finite wait -- a child that still cannot exit within it is a genuine
// stuck-process signal Desktop's existing Force Stop escape hatch
// already exists to handle, not something this fix needs to solve.
const EXIT_WAIT_TIMEOUT_MS = 45000;
const FORCE_KILL_DELAY_MS = 5000;

// P7-R0.4 Part H forensic finding: composition.readiness()'s `ready` boolean
// (src/runtime/p5-production-composition.mjs) is
// `postgres.reachable && sqlite.reachable && projects.length>0 &&
// pmProfiles.every(available) && telegram.token` — it does NOT require
// coordinator leadership. A live reproduction against the real production
// config reached ready:true in ~2s, so a genuinely slow composition build is
// not the ordinary case — but any ONE PM backend CLI probe reporting
// `available:false` at composition-build time (a transient probe hiccup,
// unrelated to Postgres/SQLite health) leaves that child's readiness false
// for its entire lifetime, with the pipe fully reachable and the child never
// exiting. The previous generic "did not become reachable" message was
// actively wrong in that case. This distills the LAST readiness report we
// actually received (already a safe, structured, owner-facing shape — the
// same fields the `readiness` CLI role prints) into one bounded, specific
// reason line, never a raw stack/env value.
function summarizeReadinessFailure(report: any): string {
  if (!report || typeof report !== 'object') return 'no readiness report was ever received';
  const reasons: string[] = [];
  if (report.postgres && report.postgres.reachable !== true) reasons.push('postgres unreachable');
  if (report.sqlite && report.sqlite.reachable !== true) reasons.push('sqlite unreachable');
  if (report.projects && (report.projects.valid !== true || !(report.projects.count > 0))) reasons.push('no projects configured');
  const backends = report.pmProfiles?.backends;
  if (Array.isArray(backends)) {
    for (const backend of backends) {
      if (backend && backend.available !== true) {
        reasons.push(`PM backend ${backend.profile_id ?? 'unknown'} unavailable${backend.code ? ` (${backend.code})` : ''}`);
      }
    }
  }
  if (report.telegram && report.telegram.token_present !== true) reasons.push('telegram token missing');
  return reasons.length > 0 ? reasons.join('; ') : 'readiness report never reported ready for an unspecified reason';
}

// P7-R0.4 Part I/K: a typed startup failure — distinct from a generic
// Error — carrying only safe, bounded evidence (never a raw child stdout/
// stderr line, never an env value). `.message` is deliberately already the
// exact bounded text the owner UX should show (App.tsx's error surfaces
// render `error.message`/`status.lastError` verbatim — no renderer change
// needed to get the improved text).
export class RuntimeStartupError extends Error {
  code: 'RUNTIME_EXITED_BEFORE_READY' | 'RUNTIME_READINESS_TIMEOUT';
  exitCode: number | null;
  signal: string | null;
  runtimeErrorCode: string | null;
  pipeReachable: boolean;
  readinessReason: string | null;
  constructor(code: 'RUNTIME_EXITED_BEFORE_READY' | 'RUNTIME_READINESS_TIMEOUT', details: { exitCode?: number | null; signal?: string | null; runtimeErrorCode?: string | null; pipeReachable?: boolean; readinessReport?: any } = {}) {
    const exitCode = details.exitCode ?? null;
    const signal = details.signal ?? null;
    const runtimeErrorCode = details.runtimeErrorCode ?? null;
    const pipeReachable = details.pipeReachable ?? false;
    const readinessReason = code === 'RUNTIME_READINESS_TIMEOUT' && pipeReachable ? summarizeReadinessFailure(details.readinessReport) : null;
    const message = code === 'RUNTIME_EXITED_BEFORE_READY'
      ? `Runtime failed before readiness.\n\nCode:\n${runtimeErrorCode ?? 'UNKNOWN'}\n\nExit:\n${exitCode ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`
      : pipeReachable
        ? `Runtime readiness timeout.\nThe control pipe is reachable and the child is still running, but it never reported ready.\n\nReason:\n${readinessReason}`
        : 'Runtime readiness timeout.\nChild is still running but the control pipe did not become reachable.';
    super(message);
    this.name = 'RuntimeStartupError';
    this.code = code;
    this.exitCode = exitCode;
    this.signal = signal;
    this.runtimeErrorCode = runtimeErrorCode;
    this.pipeReachable = pipeReachable;
    this.readinessReason = readinessReason;
  }
}

export class RuntimeSupervisor extends EventEmitter {
  private process: ChildProcess | null = null;
  private status: RuntimeStatus = {
    state: 'STOPPED',
    pid: null,
    uptime: 0,
    lastError: null,
  };
  private uptimeInterval: NodeJS.Timeout | null = null;
  private pipeClient: NamedPipeClient | null = null;
  private startTime: number = 0;
  private readinessReport: any = null;
  private controlCapability: string | null = null;
  // P7-R0.4 Part H/I/J: reset at the start of every startImpl() call.
  // `startupExitInfo` is set the instant the CURRENT startup attempt's
  // child process exits (by a dedicated 'exit' listener registered right
  // after spawn) so waitForReadiness() can fail fast instead of polling out
  // the full timeout against a pipe that can now never become reachable.
  // `lastRuntimeFailureCode` is the sanitized `code` field from the most
  // recent {"event":"p5.runtime.failed",...} structured line the child
  // printed this session — never the raw line itself.
  private startupExitInfo: { code: number | null; signal: string | null } | null = null;
  private lastRuntimeFailureCode: string | null = null;
  // P7-R0.4 Part H: true once ANY READINESS request over the control pipe
  // this startup attempt actually got a response (even ready:false) —
  // distinguishes "pipe never became reachable at all" from "pipe was
  // reachable and responsive the whole time, but composition.readiness()
  // never reported ready" (see summarizeReadinessFailure() above).
  private everConnectedDuringStartup: boolean = false;
  private controlPipeName: string | null = null;
  // M03: serializes every lifecycle transition (start/stop/restart/
  // forceStop), regardless of what triggered it — the topbar Restart
  // button, the Add Folder "Restart now" banner (which has no state-based
  // disabled guard of its own), a future tray restart, or a duplicate IPC
  // call. Only one transition runs at a time; a second call queues behind
  // the first rather than racing it. This is what makes "restart while a
  // restart is already in flight produces a lock conflict" structurally
  // impossible instead of merely unlikely.
  private lifecycleQueue: Promise<void> = Promise.resolve();

  // M02: the config path is resolved exactly once, by main.ts's
  // bootstrapRepoRootAndEnv() (env override > persisted Desktop setting >
  // dev fallback), and passed in here — RuntimeSupervisor must never
  // recompute its own independent guess (env-or-repoRoot-fallback only,
  // blind to the persisted setting), or it and the rest of the app could
  // silently disagree about which config file is "the" production config.
  constructor(
    private repoRoot: string,
    private configPath: string = process.env.DSH_CONFIG_PATH ? path.resolve(process.env.DSH_CONFIG_PATH) : path.join(repoRoot, 'local-config.production.yaml'),
    // P7-R0.4 Part R testability seam ONLY — production code never passes
    // these, so real behavior (30 attempts * 1000ms = 30s) is unchanged.
    // Tests can shrink both to exercise the readiness-timeout path in
    // milliseconds instead of 30 real seconds, against a real child process
    // (see tests/fixtures/runtime-lifecycle and runtimeRestartLifecycle.test.ts).
    private readinessMaxAttempts: number = 30,
    private readinessDelayMs: number = 1000,
    // P13-R7.1 testability seam ONLY, same pattern as readinessMaxAttempts/
    // readinessDelayMs above -- production code never passes this (real
    // behavior is the EXIT_WAIT_TIMEOUT_MS default). Tests can shrink it
    // to exercise a delayed-but-real child exit, or a genuine still-stuck
    // child, in milliseconds instead of real seconds.
    private exitWaitTimeoutMs: number = EXIT_WAIT_TIMEOUT_MS,
  ) {
    super();
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(fn, fn);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async initialize(): Promise<void> {
    // P15-B-001: launchers do not own singleton truth. The child runtime
    // acquires and recovers its canonical state-domain lease before
    // composition; initialize remains async for the existing main.ts API.
  }

  getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  getReadiness(): any {
    return this.readinessReport;
  }

  // Exposes the same authenticated pipe client used for PING/READINESS/
  // SHUTDOWN so OwnerCommandService can reuse it for owner mutations. The
  // capability itself is never exposed beyond this process-lifetime object.
  getPipeClient(): NamedPipeClient | null {
    return this.status.state === 'RUNNING' ? this.pipeClient : null;
  }

  async start(): Promise<void> {
    return this.runExclusive(() => this.startImpl());
  }

  private async startImpl(): Promise<void> {
    if (this.status.state === 'RUNNING' || this.status.state === 'STARTING') {
      throw new Error('Runtime is already running or starting');
    }

    this.updateStatus({ state: 'STARTING', lastError: null });

    try {
      const runtimeScript = path.join(this.repoRoot, 'scripts', 'p5-runtime.mjs');
      const configPath = this.configPath;

      if (!fs.existsSync(runtimeScript)) {
        throw new Error(`Runtime script not found: ${runtimeScript}`);
      }

      if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${configPath}`);
      }

      // Both values are process-lifetime only. The capability is inherited by
      // the runtime child and is never placed on its command line or sent IPC.
      this.controlCapability = crypto.randomBytes(32).toString('hex');
      this.controlPipeName = `\\\\.\\pipe\\dsh-runtime-control-${crypto.randomBytes(16).toString('hex')}`;

      // P6-W3-R3.1.1 — the ONE reliable "a genuinely new runtime child
      // process is about to exist" seam, regardless of which caller
      // reached here: start(), restart() (which is stopImpl() then
      // startImpl() — the same code path), or a future caller. Every
      // early guard above (already RUNNING/STARTING, lock unavailable,
      // missing runtime script/config) throws before this point, so a
      // rejected/no-op start attempt never fires it. Listeners (see
      // main.ts) clear session-scoped, ephemeral log presentation here —
      // exactly once per real process start, never duplicated across
      // individual IPC handlers.
      this.emit('sessionStarting');

      // Start runtime as separate process
      this.process = spawn('node', [
        runtimeScript,
        'all',
        '--config',
        configPath,
        '--control-pipe',
        this.controlPipeName,
      ], {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: {
          ...process.env,
          DSH_RUNTIME_CONTROL_AUTH: this.controlCapability,
        },
      });

      const pid = this.process.pid;
      if (!pid) {
        throw new Error('Failed to get process PID');
      }
      this.startTime = Date.now();
      // P7-R0.4 Part I: `state` stays STARTING here (pid now visible for the
      // UI's existing "starting…" affordance) — it previously jumped
      // straight to RUNNING at this point, before the child had proven
      // readiness at all. A child that exits immediately (e.g.
      // PM_BACKEND_UNAVAILABLE) used to still emit a real, if transient,
      // 'statusChanged' RUNNING event that any RUNNING-triggered lifecycle
      // listener (project projection reload, outbox replay) would react to
      // for a runtime that was never actually healthy. RUNNING is now only
      // ever reached once waitForReadiness() below actually confirms it.
      this.updateStatus({ pid });
      this.startupExitInfo = null;
      this.lastRuntimeFailureCode = null;
      this.everConnectedDuringStartup = false;

      // Start uptime tracking
      this.uptimeInterval = setInterval(() => {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        this.updateStatus({ uptime });
      }, 1000);

      // P7-R0.4 Part H/I: a SEPARATE, dedicated exit listener (Node invokes
      // every 'exit' listener; this one never replaces the existing
      // handleProcessExit() lifecycle listener below) records exit
      // evidence startup-code-reachable state so waitForReadiness() can
      // fail immediately instead of polling out the full timeout against a
      // pipe that can now never become reachable.
      this.process.once('exit', (code, signal) => {
        this.startupExitInfo = { code, signal };
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`Runtime process exited with code ${code}, signal ${signal}`);
        this.handleProcessExit(code, signal);
      });

      this.process.on('error', (error) => {
        console.error('Runtime process error:', error);
        this.updateStatus({
          state: 'ERROR',
          lastError: error.message,
          pid: null,
        });
      });

      // Capture output for logging. P7-R0.4 Part J: also scan each line for
      // the runtime child's own structured failure marker
      // ({"event":"p5.runtime.failed","code":"..."} — scripts/p5-runtime.mjs)
      // and remember only the sanitized `code` (never the raw line, which
      // could in principle carry other structured fields in the future) —
      // this is the ONE piece of evidence that turns a bare "readiness
      // timeout"/"exited before ready" into an actionable cause.
      if (this.process.stdout) {
        this.process.stdout.on('data', (data) => {
          const text = data.toString();
          this.emit('log', text);
          this.captureRuntimeFailureCode(text);
        });
      }

      if (this.process.stderr) {
        this.process.stderr.on('data', (data) => {
          const text = data.toString();
          this.emit('log', `[ERROR] ${text}`);
          this.captureRuntimeFailureCode(text);
        });
      }

      // Initialize pipe client
      this.pipeClient = new NamedPipeClient(this.controlPipeName, this.controlCapability);
      this.logLifecycle('runtime_spawn', { pid });

      // Wait for readiness
      const readinessStartedAt = Date.now();
      await this.waitForReadiness();
      this.updateStatus({ state: 'RUNNING', uptime: 0 });
      this.logLifecycle('runtime_ready', { pid, durationMs: Date.now() - readinessStartedAt });

    } catch (error: any) {
      this.cleanup();
      this.updateStatus({
        state: 'ERROR',
        lastError: error.message,
        pid: null,
      });
      if (error instanceof RuntimeStartupError) {
        this.logLifecycle(error.code === 'RUNTIME_EXITED_BEFORE_READY' ? 'runtime_exit_before_ready' : 'runtime_readiness_timeout', { exitCode: error.exitCode, signal: error.signal, errorCode: error.runtimeErrorCode, pipeReachable: error.pipeReachable, readinessReason: error.readinessReason });
      }
      throw error;
    }
  }

  // P7-R0.4 Part L: structured runtime lifecycle diagnostics, reusing the
  // existing 'log' event stream (already forwarded to RuntimeLogBuffer /
  // Desktop's Runtime Log viewer) rather than a second subsystem. Safe
  // fields only — pid/exitCode/signal/durationMs/projectCount/errorCode —
  // never a raw child line, env value, or credential.
  private logLifecycle(stage: string, fields: Record<string, unknown> = {}): void {
    try { this.emit('log', `##DSH_RUNTIME_LIFECYCLE## ${JSON.stringify({ timestamp: new Date().toISOString(), stage, ...fields })}\n`); }
    catch { /* observability must never break the lifecycle it describes */ }
  }

  async stop(): Promise<void> {
    return this.runExclusive(() => this.stopImpl());
  }

  // M03: throws on a failed/incomplete graceful shutdown instead of
  // silently swallowing the error. `state` stays STOPPING (not reverted to
  // RUNNING) so the UI's existing "Force Stop" affordance remains
  // available and honest, but — critically — `restartImpl()` below never
  // proceeds to `startImpl()` after a stop that didn't actually confirm
  // the child process exited. This is the literal fix for "do not call
  // start merely because the shutdown request returned": returning from
  // `pipeClient.shutdown()` only means the DRAINING acknowledgement was
  // received, not that the process exited — only `waitForExit()`
  // resolving (which only happens after the 'exit' event, which is also
  // when `cleanup()`'s lock release runs — see `start`'s exit handler)
  // proves that.
  private async stopImpl(): Promise<void> {
    if (this.status.state !== 'RUNNING') {
      throw new Error('Runtime is not running');
    }
    const pid = this.status.pid;

    this.updateStatus({ state: 'STOPPING' });

    if (this.pipeClient) {
      // Use in-band drain via named pipe
      await this.pipeClient.shutdown(SHUTDOWN_TIMEOUT_MS);
    }

    // Wait for graceful exit — this is also what guarantees the exit
    // handler's cleanup() has already completed
    // by the time this call resolves, since that handler was registered
    // before this one in start() and Node invokes 'exit' listeners
    // synchronously in registration order.
    //
    // P13-R7.1: deliberately `this.exitWaitTimeoutMs` (production default
    // EXIT_WAIT_TIMEOUT_MS), NOT `SHUTDOWN_TIMEOUT_MS` used just above for
    // the pipe ack -- see EXIT_WAIT_TIMEOUT_MS's own docstring for why
    // these are two independent budgets.
    try {
      await this.waitForExit(this.exitWaitTimeoutMs);
      this.logLifecycle('runtime_stop', { pid });
    } catch (error: any) {
      console.error('Graceful shutdown failed:', error);
      this.updateStatus({ lastError: `Shutdown timeout: ${error.message}` });
      throw error;
    }
  }

  async restart(): Promise<void> {
    return this.runExclusive(() => this.restartImpl());
  }

  private async restartImpl(): Promise<void> {
    this.logLifecycle('runtime_restart', { pid: this.status.pid });
    if (this.status.state === 'RUNNING') {
      await this.stopImpl();
    }
    // P7-R0.4 Part H: the old child's exit is already guaranteed by
    // stopImpl()'s waitForExit() above before this line is ever reached —
    // startImpl() below always spawns a genuinely new child only after the
    // old one is confirmed gone (ordering proof for Part R test 6).
    await this.startImpl();
  }

  async forceStop(): Promise<void> {
    return this.runExclusive(() => this.forceStopImpl());
  }

  private async forceStopImpl(): Promise<void> {
    if (!this.process || !this.process.pid) {
      this.cleanup();
      this.updateStatus({ state: 'STOPPED', pid: null });
      return;
    }

    try {
      // Kill process tree on Windows
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', this.process.pid.toString(), '/t', '/f'], {
          windowsHide: true,
        });
      } else {
        this.process.kill('SIGKILL');
      }

      await this.waitForExit(FORCE_KILL_DELAY_MS);
    } catch (error: any) {
      console.error('Force stop error:', error);
    } finally {
      this.cleanup();
      this.updateStatus({ state: 'STOPPED', pid: null });
    }
  }

  // P7-R0.4 Part I: previously this polled the SAME fixed number of
  // attempts regardless of whether the child had already exited — a child
  // that failed and exited within the first second (e.g.
  // PM_BACKEND_UNAVAILABLE) still made this wait out the FULL ~30s before
  // throwing the one generic "Runtime readiness timeout" message, which was
  // actively misleading (the child was long gone; the pipe was never going
  // to become reachable). `this.startupExitInfo` (set by the dedicated
  // exit listener in startImpl()) is checked before every attempt AND right
  // after every delay, so a child that has already exited is detected
  // within one poll interval, never the full timeout — and the two failure
  // classes are now structurally distinct, not collapsed into one message.
  private async waitForReadiness(): Promise<void> {
    const maxAttempts = this.readinessMaxAttempts;
    const delayMs = this.readinessDelayMs;

    const failIfExited = (): void => {
      const exitInfo = this.startupExitInfo;
      if (exitInfo) {
        throw new RuntimeStartupError('RUNTIME_EXITED_BEFORE_READY', { exitCode: exitInfo.code, signal: exitInfo.signal, runtimeErrorCode: this.lastRuntimeFailureCode });
      }
    };

    for (let i = 0; i < maxAttempts; i++) {
      failIfExited();

      try {
        if (!this.pipeClient) {
          throw new Error('Pipe client not initialized');
        }

        this.readinessReport = await this.pipeClient.readinessDetails();
        // A response was received at all — the pipe IS reachable, whether
        // or not `ready` is true yet.
        this.everConnectedDuringStartup = true;
        if (this.readinessReport?.ready === true) {
          console.log('Runtime is ready');
          return;
        }
      } catch (error) {
        // Not ready yet, continue waiting
      }

      failIfExited();

      await new Promise(resolve => setTimeout(resolve, delayMs));

      failIfExited();
    }

    throw new RuntimeStartupError('RUNTIME_READINESS_TIMEOUT', { pipeReachable: this.everConnectedDuringStartup, readinessReport: this.readinessReport });
  }

  // P7-R0.4 Part J: scans one stdout/stderr text chunk (which may contain
  // multiple newline-separated lines, or a partial line) for the runtime
  // child's structured failure marker and remembers only the sanitized
  // `code` field — never the raw line. Malformed/non-JSON/unrelated lines
  // are silently ignored (this is best-effort observability, never
  // authoritative over the real exit code/signal).
  private captureRuntimeFailureCode(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.event === 'p5.runtime.failed' && typeof parsed.code === 'string') {
          this.lastRuntimeFailureCode = parsed.code;
        }
      } catch {
        // not a structured line — ignore
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Process exit timeout'));
      }, timeoutMs);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private handleProcessExit(code: number | null, signal: string | null): void {
    this.cleanup();

    if (code === 0) {
      this.updateStatus({ state: 'STOPPED', pid: null });
    } else {
      this.updateStatus({ 
        state: 'ERROR',
        pid: null,
        lastError: `Process exited with code ${code}, signal ${signal}`,
      });
    }
  }

  private cleanup(): void {
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }

    if (this.pipeClient) {
      this.pipeClient.disconnect();
      this.pipeClient = null;
    }

    this.process = null;
    this.readinessReport = null;
    this.controlCapability = null;
    this.controlPipeName = null;
  }

  private updateStatus(updates: Partial<RuntimeStatus>): void {
    this.status = { ...this.status, ...updates };
    this.emit('statusChanged', this.getStatus());
  }
}
