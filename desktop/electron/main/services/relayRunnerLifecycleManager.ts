import fs from 'fs';
import path from 'path';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { DesktopSettingsStore, RelayRunnerSettings } from './desktopSettingsStore';
import { readRunnerRegistration, RunnerRegistrationResult } from './relayRunnerRegistrationReader';

export type RelayRunnerState =
  | 'UNCONFIGURED'
  | 'REGISTERED_OFFLINE'
  | 'STARTING'
  | 'RUNNING_ONLINE_UNVERIFIED'
  | 'ONLINE_IDLE'
  | 'ONLINE_BUSY'
  | 'DEGRADED'
  | 'STOPPING'
  | 'FAILED';
export type RelayRunnerOwnership = 'APP_OWNED' | 'EXTERNAL' | 'NONE';
export type RelayRunnerRegistration = 'REGISTERED' | 'NOT_CONFIGURED' | 'INVALID';

export interface RelayRunnerProcessIdentity {
  pid: number;
  parentPid: number | null;
  executablePath: string;
  commandLine: string | null;
  creationTime: string | null;
  ancestorPids?: number[];
}

export interface RelayRunnerStatus {
  state: RelayRunnerState;
  registration: RelayRunnerRegistration;
  ownership: RelayRunnerOwnership;
  enabled: boolean;
  autoStart: boolean;
  runnerPath: string | null;
  version: string | null;
  pid: number | null;
  lastChecked: string;
  lastError: { code: string; message: string } | null;
}

export interface RelayRunnerOperationResult {
  ok: boolean;
  status: RelayRunnerStatus;
  code?: string;
  message?: string;
}

export interface RelayRunnerProcessHandle {
  readonly pid: number;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  onCaptureError(listener: (error: Error) => void): void;
  requestGracefulStop(): void;
  forceKillTree(): void;
  detachForHandoff(): void;
}

export interface RelayRunnerLifecycleDependencies {
  pathExists(candidate: string): boolean;
  realpath(candidate: string): string;
  // P0-4: structural, non-secret registration proof — never raw file
  // content. See relayRunnerRegistrationReader.ts (the one place this ever
  // touches a filesystem read) for what it validates and why.
  readRegistration(resolvedRunnerPath: string): RunnerRegistrationResult;
  discoverExact(runnerPath: string): Promise<{ listeners: RelayRunnerProcessIdentity[]; version: string | null }>;
  // PM24-RUNNER: read-only, best-effort online-evidence for an EXTERNAL
  // (not-this-Electron-lifetime-owned) exact listener — see
  // readExternalRunnerDiagnosticEvidence()'s docstring above for what this
  // reads and why it is safe. Called only after discoverExact() has already
  // confirmed the exact PID/path match; never used to establish identity or
  // ownership itself, only health for an identity already proven.
  readExternalEvidence(resolvedRunnerPath: string): RelayRunnerExternalEvidence;
  spawnRunner(runnerPath: string): RelayRunnerProcessHandle;
  now(): Date;
  delay(ms: number): Promise<void>;
  // P1: a bounded, cancellable timer primitive — injected so the health
  // monitor's poll cadence and restart backoff are deterministic under
  // test (no real setTimeout) while production uses a plain self-
  // rescheduling setTimeout (never setInterval/a tight loop).
  scheduleTimer(callback: () => void, ms: number): { cancel(): void };
}

const REQUIRED_FILES = ['.runner', 'run.cmd', path.join('bin', 'Runner.Listener.exe'), path.join('bin', 'Runner.Worker.exe')] as const;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_LENGTH = 500;
const MAX_CAPTURE_GENERATIONS = 8;
const MAX_CAPTURE_SCAN_ENTRIES = 64;
const MAX_CAPTURE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_READ_BYTES_PER_TICK = 256 * 1024;
const CAPTURE_POLL_INTERVAL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
// P1: bounded poll cadence (one refresh per interval — never a tight
// WMI/CIM loop) and a stepped, capped restart backoff.
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 15_000;
const BASE_RESTART_BACKOFF_MS = 5_000;
const MAX_RESTART_BACKOFF_MS = 5 * 60_000;
const MAX_RESTART_RETRY_COUNT = 10;

export interface RelayRunnerHealth {
  lastChecked: string;
  lastSuccessfulOnlineEvidence: string | null;
  retryCount: number;
  nextRetryAt: string | null;
}

// P0-1: deny-by-default child environment. Electron main later loads the
// product .env into process.env (provider API keys, Telegram credentials,
// DSH secrets); without this allowlist both the spawned runner and the
// PowerShell discovery probe would silently inherit ALL of it. Only the
// narrow set of Windows variables the official runner shell surface and
// PowerShell itself genuinely need are forwarded — never a wildcard.
export const RUNNER_CHILD_ENV_ALLOWLIST = [
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)',
] as const;

// Exported so a unit test can plant fake secrets in a fabricated source
// object and prove they are dropped — the exact function both the runner
// supervisor and the discovery PowerShell child use to build their env.
export function buildRunnerChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set(RUNNER_CHILD_ENV_ALLOWLIST.map((key) => key.toLowerCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allow.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLocaleLowerCase('en-US') === path.normalize(right).toLocaleLowerCase('en-US');
}

// PM24-RUNNER: the ONLY three online-evidence patterns this class ever
// recognizes, shared verbatim between ingestLine() (APP_OWNED, driven by
// live captured stdout) and readExternalRunnerDiagnosticEvidence() below
// (EXTERNAL, driven by the runner's own on-disk _diag log) — one
// definition, never two independently-drifting copies. `CONNECTED_RE`
// widened (never narrowed) from the original `Connected to GitHub`-only
// match: a live read of the owner's actual installed runner (2.337.0,
// GitHub's current broker-based listener) proved that exact string is NEVER
// printed by this runner version at all — its real startup banner is
// `Current runner version: 'x.y.z'` (every successful session, first
// connect or reconnect) optionally preceded by `Runner reconnected.` (only
// when an earlier session had to be replaced). Without this widening,
// generationConnected could never become true for ANY runner — owned or
// external — against the CLI DSH actually ships against, so APP_OWNED
// runners were silently stuck at RUNNING_ONLINE_UNVERIFIED forever too,
// not only EXTERNAL ones. The original string is kept (never removed) for
// any older runner build that still emits it.
const CONNECTED_EVIDENCE_RE = /Connected to GitHub|Runner (?:re)?connected|Current runner version:/i;
const LISTENING_EVIDENCE_RE = /Listening for Jobs/i;
const JOB_STARTED_EVIDENCE_RE = /Running job:/i;
const JOB_COMPLETED_EVIDENCE_RE = /(completed with result|job .+ completed|job completed|finished job)/i;
const CONNECTION_DEGRADED_EVIDENCE_RE = /(connect.*(?:failed|timed out)|github.*unreachable|session.*error)/i;

const EXTERNAL_DIAG_LOG_NAME_RE = /^Runner_.*\.log$/i;
// Bounded tail read — the runner's own diagnostic log accumulates for the
// life of one Runner.Listener.exe generation (it rotates to a fresh file on
// every listener restart) and can grow large; this only ever needs the most
// recent evidence, never the full history, so a huge/runaway file is capped
// exactly like the owned-process output capture above (MAX_CAPTURE_FILE_BYTES).
const MAX_EXTERNAL_EVIDENCE_READ_BYTES = 512 * 1024;

export interface RelayRunnerExternalEvidence {
  connected: boolean;
  listening: boolean;
  busy: boolean;
}

// PM24-RUNNER: DSH only ever captures live stdout for a process IT spawned
// (WindowsRunnerProcessHandle above) — an EXTERNAL listener (started outside
// this Desktop lifetime, or DSH's OWN previously-owned listener rediscovered
// after an Electron restart lost its in-memory ownedProcess handle) has no
// such capture, so it was permanently unable to reach anything but
// RUNNING_ONLINE_UNVERIFIED regardless of real health — a false negative,
// not a true one. The official GitHub Actions runner writes the EXACT same
// human-readable state lines (`Listening for Jobs`, `Running job: ...`, `Job
// ... completed with result: ...`) to its own `_diag/Runner_*.log` file
// REGARDLESS of who started the process — this is safe, local, already-
// non-secret evidence (the SAME class of file this class already trusts for
// `.runner`'s registration proof) that requires no output-capture wiring at
// all. `_diag` rotates a fresh `Runner_<timestamp>-utc.log` on every listener
// process start, so the lexicographically newest one is always the log
// belonging to whatever exact listener PID discoverExact() just confirmed
// alive by path (this function is only ever called once that PID match is
// already established) — never a stale prior generation's log. Ownership
// classification itself is COMPLETELY unaffected by this function: it only
// ever answers "is THIS already-identified process healthy", never "who
// started it" — Start/Stop/Restart remain gated on ownership==='APP_OWNED'
// exactly as before (relayRunnerLifecycleManager.ts's stopImpl/restart).
export function readExternalRunnerDiagnosticEvidence(resolvedRunnerPath: string): RelayRunnerExternalEvidence {
  const none: RelayRunnerExternalEvidence = { connected: false, listening: false, busy: false };
  const diagDir = path.join(resolvedRunnerPath, '_diag');
  let entries: string[];
  try { entries = fs.readdirSync(diagDir).filter((name) => EXTERNAL_DIAG_LOG_NAME_RE.test(name)); }
  catch { return none; }
  if (entries.length === 0) return none;
  entries.sort();
  const latest = path.join(diagDir, entries[entries.length - 1]);
  let content: string;
  try {
    const size = fs.statSync(latest).size;
    const fd = fs.openSync(latest, 'r');
    try {
      const readLength = Math.min(size, MAX_EXTERNAL_EVIDENCE_READ_BYTES);
      const position = Math.max(0, size - readLength);
      const buffer = Buffer.allocUnsafe(readLength);
      fs.readSync(fd, buffer, 0, readLength, position);
      content = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return none; }
  // A single incremental pass, oldest-to-newest line — mirrors ingestLine's
  // own state machine exactly, just applied once to a static tail instead of
  // streamed live. A disconnect/error line invalidates any PRIOR connected/
  // listening evidence (the old session is gone) rather than being ignored,
  // so a runner mid-reconnect after a transient network blip is honestly
  // reported as unverified until a fresh Listening line actually reappears —
  // never a stale "was healthy 3 hours ago" false positive.
  let connected = false;
  let listening = false;
  let busy = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (CONNECTION_DEGRADED_EVIDENCE_RE.test(line)) { connected = false; listening = false; continue; }
    if (CONNECTED_EVIDENCE_RE.test(line)) connected = true;
    if (LISTENING_EVIDENCE_RE.test(line)) listening = true;
    if (JOB_STARTED_EVIDENCE_RE.test(line)) { busy = true; continue; }
    if (busy && JOB_COMPLETED_EVIDENCE_RE.test(line)) busy = false;
  }
  return { connected, listening, busy };
}

function sanitizeText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[REDACTED]')
    .replace(/((?:registration|access|refresh|github|jit)[_-]?token\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|code|client_secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return text.slice(0, MAX_LOG_LENGTH);
}

interface RunnerCaptureFiles {
  id: string;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
}

interface CaptureMetadata {
  schemaVersion: 1;
  rootPid: number | null;
  createdAt: string;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function cleanupRunnerOutputCaptures(captureRoot: string, isAlive: (pid: number) => boolean = processExists): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(captureRoot, { withFileTypes: true }).slice(0, MAX_CAPTURE_SCAN_ENTRIES); }
  catch { return; }
  const dead: Array<{ id: string; createdAt: number }> = [];
  for (const entry of entries) {
    const match = /^runner-([a-zA-Z0-9-]+)\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    try {
      const metadataPath = path.join(captureRoot, entry.name);
      if (fs.statSync(metadataPath).size > 1_024) continue;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Partial<CaptureMetadata>;
      if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.rootPid) || typeof metadata.createdAt !== 'string') continue;
      if (isAlive(metadata.rootPid!)) continue;
      dead.push({ id: match[1], createdAt: Date.parse(metadata.createdAt) || 0 });
    } catch {
      // Unknown metadata may belong to a generation that survived a
      // Desktop crash. Retain it rather than risking deletion in use.
    }
  }
  dead.sort((left, right) => right.createdAt - left.createdAt);
  for (const item of dead.slice(MAX_CAPTURE_GENERATIONS)) {
    for (const suffix of ['stdout.log', 'stderr.log', 'json']) {
      try { fs.unlinkSync(path.join(captureRoot, `runner-${item.id}.${suffix}`)); } catch { /* opportunistic */ }
    }
  }
}

function createRunnerCaptureFiles(captureRoot: string): RunnerCaptureFiles {
  fs.mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
  cleanupRunnerOutputCaptures(captureRoot);
  const id = `${Date.now()}-${randomUUID()}`;
  const stdoutPath = path.join(captureRoot, `runner-${id}.stdout.log`);
  const stderrPath = path.join(captureRoot, `runner-${id}.stderr.log`);
  const metadataPath = path.join(captureRoot, `runner-${id}.json`);
  fs.writeFileSync(stdoutPath, '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(stderrPath, '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(metadataPath, JSON.stringify({ schemaVersion: 1, rootPid: null, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return { id, stdoutPath, stderrPath, metadataPath };
}

class BoundedCaptureTail {
  private offset = 0;
  private closed = false;
  private failed = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly capturePath: string,
    private readonly onChunk: (chunk: string) => void,
    private readonly onFailure: (error: Error) => void,
  ) {
    fs.watchFile(capturePath, { persistent: false, interval: CAPTURE_POLL_INTERVAL_MS }, () => this.poll());
    setImmediate(() => this.poll());
  }

  poll(): void {
    if (this.closed || this.failed) return;
    try {
      const size = fs.statSync(this.capturePath).size;
      if (size > MAX_CAPTURE_FILE_BYTES) throw new Error('Runner output capture exceeded its bounded generation limit.');
      if (size < this.offset) this.offset = 0;
      let remaining = Math.min(size - this.offset, MAX_CAPTURE_READ_BYTES_PER_TICK);
      if (remaining <= 0) return;
      const fd = fs.openSync(this.capturePath, 'r');
      try {
        while (remaining > 0) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
          const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
          if (read <= 0) break;
          this.offset += read;
          remaining -= read;
          const decoded = this.decoder.write(buffer.subarray(0, read));
          if (decoded) this.onChunk(decoded);
        }
      } finally { fs.closeSync(fd); }
      if (this.offset < size) setImmediate(() => this.poll());
    } catch (error) {
      this.failed = true;
      this.onFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.poll();
    this.closed = true;
    fs.unwatchFile(this.capturePath);
    const final = this.decoder.end();
    if (final) this.onChunk(final);
  }
}

class WindowsRunnerProcessHandle implements RelayRunnerProcessHandle {
  readonly pid: number;
  private readonly stdoutListeners: Array<(chunk: string) => void> = [];
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly captureErrorListeners: Array<(error: Error) => void> = [];
  private readonly tails: BoundedCaptureTail[];
  private captureFailure: Error | null = null;
  private exitEvent: { code: number | null; signal: string | null } | null = null;
  private processError: Error | null = null;

  constructor(private readonly child: ChildProcess, captures: RunnerCaptureFiles) {
    if (!child.pid) throw new Error('Runner launcher did not return a PID');
    this.pid = child.pid;
    const captureError = (error: Error) => {
      if (this.captureFailure) return;
      this.captureFailure = error;
      for (const listener of this.captureErrorListeners) listener(error);
    };
    this.tails = [
      new BoundedCaptureTail(captures.stdoutPath, (chunk) => this.stdoutListeners.forEach((listener) => listener(chunk)), captureError),
      new BoundedCaptureTail(captures.stderrPath, (chunk) => this.stderrListeners.forEach((listener) => listener(chunk)), captureError),
    ];
    child.once('exit', (code, signal) => {
      // The supervisor can report the supervised cmd exit just before its
      // redirected file handles become observable to another reader.
      // Give the OS one bounded flush window, then drain before publishing
      // the generation exit so short-lived wrapper output is not lost.
      setTimeout(() => {
        this.tails.forEach((tail) => tail.close());
        this.exitEvent = { code, signal };
        for (const listener of this.exitListeners) listener(code, signal);
      }, CAPTURE_POLL_INTERVAL_MS);
    });
    child.once('error', (error) => {
      this.processError = error;
      this.errorListeners.forEach((listener) => listener(error));
    });
  }
  onStdout(listener: (chunk: string) => void): void { this.stdoutListeners.push(listener); }
  onStderr(listener: (chunk: string) => void): void { this.stderrListeners.push(listener); }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
    if (this.exitEvent) listener(this.exitEvent.code, this.exitEvent.signal);
  }
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
    if (this.processError) listener(this.processError);
  }
  onCaptureError(listener: (error: Error) => void): void {
    this.captureErrorListeners.push(listener);
    if (this.captureFailure) listener(this.captureFailure);
  }
  requestGracefulStop(): void {
    spawnSync('taskkill', ['/PID', String(this.pid), '/T'], { windowsHide: true, stdio: 'ignore', timeout: DEFAULT_STOP_TIMEOUT_MS });
  }
  forceKillTree(): void {
    spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: DEFAULT_STOP_TIMEOUT_MS });
  }
  detachForHandoff(): void {
    this.tails.forEach((tail) => tail.close());
    this.child.unref();
  }
}

async function discoverExactWindowsRunner(runnerPath: string): Promise<{ listeners: RelayRunnerProcessIdentity[]; version: string | null }> {
  if (process.platform !== 'win32') return { listeners: [], version: null };
  const listenerPath = path.join(runnerPath, 'bin', 'Runner.Listener.exe');
  const script = [
    "$target = [IO.Path]::GetFullPath($env:DSH_RUNNER_DISCOVERY_EXE)",
    "$all = @(Get-CimInstance Win32_Process)",
    "$byPid = @{}",
    "$all | ForEach-Object { $byPid[[int]$_.ProcessId] = $_ }",
    "$items = @($all | Where-Object { $_.Name -eq 'Runner.Listener.exe' -and $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } | ForEach-Object { $ancestors = @(); $parent = [int]$_.ParentProcessId; for ($i = 0; $i -lt 16 -and $parent -gt 0 -and $byPid.ContainsKey($parent); $i++) { $ancestors += $parent; $parent = [int]$byPid[$parent].ParentProcessId }; [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; ancestorPids = $ancestors; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine; creationTime = [string]$_.CreationDate } })",
    "$version = if (Test-Path -LiteralPath $target) { [Diagnostics.FileVersionInfo]::GetVersionInfo($target).ProductVersion } else { $null }",
    "[pscustomobject]@{ listeners = $items; version = $version } | ConvertTo-Json -Compress -Depth 4",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...buildRunnerChildEnv(), DSH_RUNNER_DISCOVERY_EXE: listenerPath },
  });
  if (result.error || result.status !== 0) throw new Error('Exact runner process inspection failed');
  const parsed = JSON.parse(result.stdout || '{}');
  const rawListeners = Array.isArray(parsed.listeners) ? parsed.listeners : parsed.listeners ? [parsed.listeners] : [];
  const listeners = rawListeners
    .filter((item: any) => Number.isInteger(item?.pid) && typeof item?.executablePath === 'string' && samePath(item.executablePath, listenerPath))
    .map((item: any) => ({
      pid: item.pid,
      parentPid: Number.isInteger(item.parentPid) ? item.parentPid : null,
      executablePath: item.executablePath,
      commandLine: typeof item.commandLine === 'string' ? item.commandLine : null,
      creationTime: typeof item.creationTime === 'string' ? item.creationTime : null,
      ancestorPids: Array.isArray(item.ancestorPids) ? item.ancestorPids.filter((pid: unknown) => Number.isInteger(pid)).slice(0, 16) : Number.isInteger(item.ancestorPids) ? [item.ancestorPids] : [],
    }));
  return { listeners, version: typeof parsed.version === 'string' && parsed.version.length <= 100 ? parsed.version : null };
}

export function spawnWindowsRunnerWithFileCapture(runnerPath: string, captureRoot?: string): RelayRunnerProcessHandle {
  const ownerLocalRoot = process.env.LOCALAPPDATA || process.env.TEMP;
  if (!captureRoot && !ownerLocalRoot) throw new Error('Owner-local runner output directory is unavailable.');
  const resolvedCaptureRoot = captureRoot ?? path.join(ownerLocalRoot!, 'DSH', 'runner-output');
  const captures = createRunnerCaptureFiles(resolvedCaptureRoot);
  // A detached DSH supervisor survives Electron, but it launches the
  // official wrapper as a normal hidden child. This avoids Node's
  // Windows DETACHED_PROCESS console boundary on Runner.Listener while
  // keeping the listener independent of Electron and anonymous pipes.
  const supervisorScript = [
    "const fs=require('node:fs')",
    "const {spawn}=require('node:child_process')",
    'const stdoutPath=process.env.DSH_RUNNER_STDOUT_FILE',
    'const stderrPath=process.env.DSH_RUNNER_STDERR_FILE',
    'delete process.env.DSH_RUNNER_STDOUT_FILE',
    'delete process.env.DSH_RUNNER_STDERR_FILE',
    'delete process.env.ELECTRON_RUN_AS_NODE',
    "const stdout=fs.openSync(stdoutPath,'a')",
    "const stderr=fs.openSync(stderrPath,'a')",
    "const child=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c','call run.cmd'],{cwd:process.cwd(),windowsHide:true,detached:false,stdio:['ignore',stdout,stderr],shell:false,env:process.env})",
    'fs.closeSync(stdout)',
    'fs.closeSync(stderr)',
    "child.once('error',()=>process.exit(1))",
    'child.once(\'exit\',(code)=>process.exit(Number.isInteger(code)?code:1))',
  ].join(';');
  const child = spawn(process.execPath, ['-e', supervisorScript], {
      cwd: runnerPath,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        ...buildRunnerChildEnv(),
        DSH_RUNNER_STDOUT_FILE: captures.stdoutPath,
        DSH_RUNNER_STDERR_FILE: captures.stderrPath,
        ELECTRON_RUN_AS_NODE: '1',
      },
  });
  if (child.pid) {
    try {
      fs.writeFileSync(captures.metadataPath, JSON.stringify({ schemaVersion: 1, rootPid: child.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* capture still functions; unknown metadata is retained safely */ }
  }
  return new WindowsRunnerProcessHandle(child, captures);
}

export const productionRelayRunnerDependencies: RelayRunnerLifecycleDependencies = {
  pathExists: (candidate) => fs.existsSync(candidate),
  realpath: (candidate) => fs.realpathSync.native(candidate),
  readRegistration: (resolvedRunnerPath) => readRunnerRegistration(resolvedRunnerPath),
  discoverExact: discoverExactWindowsRunner,
  readExternalEvidence: readExternalRunnerDiagnosticEvidence,
  spawnRunner: (runnerPath) => {
    // The shell surface is fixed. The configured path is used only as cwd;
    // renderer input can never become a command or argument. The child
    // environment is the P0-1 allowlist, never the full Electron process
    // environment — the runner never sees Telegram/provider/DSH secrets.
    return spawnWindowsRunnerWithFileCapture(runnerPath);
  },
  now: () => new Date(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  scheduleTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

export class RelayRunnerLifecycleManager extends EventEmitter {
  private status: RelayRunnerStatus;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private ownedProcess: RelayRunnerProcessHandle | null = null;
  private ownedListenerPid: number | null = null;
  private generation = 0;
  private generationConnected = false;
  private generationListening = false;
  private generationBusy = false;
  private generationCaptureHealthy = true;
  private autoStartAttempted = false;
  private logs: string[] = [];
  private lineRemainders: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private stopping = false;
  // P1 health monitor state — memory-only (never persisted as authority;
  // a restart of Desktop starts backoff fresh, which is the safe default).
  private monitoring = false;
  private healthTimer: { cancel(): void } | null = null;
  private retryCount = 0;
  private nextRetryAt: string | null = null;
  private lastSuccessfulOnlineEvidence: string | null = null;
  // Distinguishes "owner clicked Stop" from "process exited unexpectedly" —
  // both land on the same REGISTERED_OFFLINE/NONE state, but only the
  // latter is what P1's "safely restore an unexpectedly stopped runner"
  // requirement means. Set true by a Stop/Restart-initiated exit, cleared
  // the moment a new generation is successfully spawned.
  private lastExitWasManual = false;
  // P1 (final hold): true only for a generation that the health monitor
  // itself started and which has not yet reached stable current-
  // generation ONLINE evidence (Connected to GitHub + Listening for
  // Jobs). A generation that dies while this is true is an UNSTABLE
  // recovery — its death counts toward backoff even though spawnRunner()
  // itself reported success. Reset to false at the top of every fresh
  // start (manual or automated) and the moment stable evidence is
  // observed, so a manual Start/Restart's later crash is never
  // attributed to health-recovery backoff.
  private recoveryAwaitingStable = false;

  constructor(
    private readonly settingsStore: Pick<DesktopSettingsStore, 'get' | 'setRelayRunner'>,
    private readonly dependencies: RelayRunnerLifecycleDependencies = productionRelayRunnerDependencies,
    private readonly stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    private readonly healthPollIntervalMs = DEFAULT_HEALTH_POLL_INTERVAL_MS,
  ) {
    super();
    // The store migrates this field on disk, while a few integration mocks
    // still provide the legacy pre-runner shape. Fail safely to the same
    // typed defaults at this boundary rather than making Desktop boot depend
    // on every caller already having performed migration.
    const settings = settingsStore.get().relayRunner ?? { enabled: false, runnerPath: null, autoStart: false };
    this.status = this.makeStatus(settings);
  }

  private makeStatus(settings: RelayRunnerSettings): RelayRunnerStatus {
    return {
      state: 'UNCONFIGURED', registration: 'NOT_CONFIGURED', ownership: 'NONE',
      enabled: settings.enabled, autoStart: settings.autoStart, runnerPath: settings.runnerPath,
      version: null, pid: null, lastChecked: this.dependencies.now().toISOString(), lastError: null,
    };
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.lifecycleQueue = this.lifecycleQueue.then(operation, operation).then(
      (value) => { resolveResult(value); },
      (error) => { rejectResult(error); },
    );
    return result;
  }

  getStatus(): RelayRunnerStatus { return { ...this.status, lastError: this.status.lastError ? { ...this.status.lastError } : null }; }
  getLogs(): string[] { return [...this.logs]; }

  private transition(patch: Partial<RelayRunnerStatus>): void {
    this.status = { ...this.status, ...patch, lastChecked: this.dependencies.now().toISOString() };
    this.emit('statusChanged', this.getStatus());
  }

  private log(event: string, detail?: string): void {
    const line = `${this.dependencies.now().toISOString()} ${event}${detail ? ` ${sanitizeText(detail)}` : ''}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
  }

  async initialize(): Promise<RelayRunnerStatus> {
    return this.runExclusive(async () => {
      const status = await this.refreshImpl();
      if (status.enabled && status.autoStart && status.state === 'REGISTERED_OFFLINE' && !this.autoStartAttempted) {
        this.autoStartAttempted = true;
        return (await this.startImpl()).status;
      }
      return status;
    });
  }

  async refresh(): Promise<RelayRunnerStatus> { return this.runExclusive(() => this.refreshImpl()); }

  // Pure structural validation of ONE candidate directory — shared by
  // preflight() (validates the currently-configured path on every
  // refresh/start) and configureRunnerPath() (validates a candidate path
  // BEFORE it is ever allowed to become configuration). Never mutates
  // anything; has no path to the registration/reconfiguration script or
  // either credential file at all.
  private validateRunnerDirectory(candidatePath: string): { ok: true; resolvedPath: string } | { ok: false; code: string; message: string; resolvedPath?: string } {
    if (!path.isAbsolute(candidatePath)) {
      return { ok: false, code: 'RUNNER_PATH_NOT_ABSOLUTE', message: 'Runner path must be absolute.' };
    }
    if (!this.dependencies.pathExists(candidatePath)) {
      return { ok: false, code: 'RUNNER_PATH_MISSING', message: 'Configured runner directory does not exist.' };
    }
    let resolvedPath: string;
    try { resolvedPath = this.dependencies.realpath(candidatePath); }
    catch { return { ok: false, code: 'RUNNER_PATH_INVALID', message: 'Configured runner directory could not be resolved.' }; }
    if (!this.dependencies.pathExists(path.join(resolvedPath, '.runner'))) {
      return { ok: false, code: 'RUNNER_NOT_REGISTERED', message: 'The configured runner has no .runner registration file.', resolvedPath };
    }
    // P0-4: existence of `.runner` is not registration proof by itself —
    // require a coherent, bounded, non-secret registration identity
    // (agent name, pool id, server/repository endpoint shape). Malformed
    // JSON, missing identity fields, or oversized values all block start —
    // this file has no path to the registration/reconfiguration script at all.
    const registration = this.dependencies.readRegistration(resolvedPath);
    if (!registration.ok) {
      return { ok: false, code: registration.reason, message: 'The configured .runner registration file is malformed or incomplete.', resolvedPath };
    }
    for (const required of REQUIRED_FILES.slice(1)) {
      if (!this.dependencies.pathExists(path.join(resolvedPath, required))) {
        return { ok: false, code: 'RUNNER_INSTALLATION_INCOMPLETE', message: `Runner installation is missing ${required}.`, resolvedPath };
      }
    }
    return { ok: true, resolvedPath };
  }

  private preflight(): { ok: true; settings: RelayRunnerSettings; resolvedPath: string } | { ok: false; status: RelayRunnerStatus } {
    const settings = this.settingsStore.get().relayRunner ?? { enabled: false, runnerPath: null, autoStart: false };
    const base = this.makeStatus(settings);
    if (!settings.enabled || !settings.runnerPath) return { ok: false, status: base };
    const validation = this.validateRunnerDirectory(settings.runnerPath);
    if (!validation.ok) {
      const runnerPath = validation.resolvedPath ?? base.runnerPath;
      const state: RelayRunnerState = validation.code === 'RUNNER_NOT_REGISTERED' ? 'UNCONFIGURED' : 'FAILED';
      const registration: RelayRunnerRegistration = validation.code === 'RUNNER_NOT_REGISTERED' ? 'NOT_CONFIGURED' : 'INVALID';
      return { ok: false, status: { ...base, runnerPath, state, registration, lastError: { code: validation.code, message: validation.message } } };
    }
    return { ok: true, settings, resolvedPath: validation.resolvedPath };
  }

  private async refreshImpl(): Promise<RelayRunnerStatus> {
    const preflight = this.preflight();
    if (!preflight.ok) {
      this.status = { ...preflight.status, lastChecked: this.dependencies.now().toISOString() };
      this.emit('statusChanged', this.getStatus());
      return this.getStatus();
    }
    try {
      const discovery = await this.dependencies.discoverExact(preflight.resolvedPath);
      // P1 (final hold): more than one exact listener for this SAME
      // installation is unsafe to arbitrate — picking listeners[0] would
      // silently ignore the rest. Fail closed: ownership is permanently
      // forgotten (never picked, adopted, or reclaimed as APP_OWNED even
      // if a later poll happens to find our own former pid again), and
      // DEGRADED/NONE makes every other guard in this class fall out for
      // free — startImpl() requires REGISTERED_OFFLINE (fails
      // RUNNER_NOT_STARTABLE), stopImpl()/restart() require
      // ownership==='APP_OWNED' (fails RUNNER_NOT_APP_OWNED), and the
      // health monitor only ever considers REGISTERED_OFFLINE+NONE
      // (never fires). No special-casing needed in any of those methods.
      if (discovery.listeners.length > 1) {
        this.ownedProcess?.detachForHandoff();
        this.ownedProcess = null;
        this.ownedListenerPid = null;
        this.transition({
          enabled: preflight.settings.enabled, autoStart: preflight.settings.autoStart,
          state: 'DEGRADED', registration: 'REGISTERED', ownership: 'NONE', pid: null,
          version: discovery.version, runnerPath: preflight.resolvedPath,
          lastError: { code: 'RUNNER_MULTIPLE_LISTENERS', message: 'Multiple exact runner listener processes were discovered for this installation; lifecycle control is suspended until this resolves to zero or one.' },
        });
        this.log('runner_multiple_listeners', `count=${discovery.listeners.length}`);
        return this.getStatus();
      }
      // Every transition below also re-syncs enabled/autoStart from the
      // settings just re-read by preflight() — otherwise a settings
      // change (e.g. updateSettings toggling autoStart) would only take
      // effect in `status` the NEXT time preflight itself fails, leaving
      // the health monitor's autoStart gate silently stale while the
      // runner remains discoverable/online.
      const liveSettings = { enabled: preflight.settings.enabled, autoStart: preflight.settings.autoStart };
      const exact = discovery.listeners[0] ?? null;
      if (!exact) {
        if (this.ownedProcess && (this.status.state === 'STARTING' || this.status.state === 'STOPPING' || !this.generationCaptureHealthy)) {
          this.transition({ ...liveSettings, registration: 'REGISTERED', version: discovery.version, runnerPath: preflight.resolvedPath });
        } else {
          this.ownedProcess = null;
          this.ownedListenerPid = null;
          this.transition({ ...liveSettings, state: 'REGISTERED_OFFLINE', registration: 'REGISTERED', ownership: 'NONE', pid: null, version: discovery.version, runnerPath: preflight.resolvedPath, lastError: null });
        }
        return this.getStatus();
      }
      const isOwned = this.ownedProcess !== null && (this.ownedListenerPid === exact.pid || exact.parentPid === this.ownedProcess.pid || exact.pid === this.ownedProcess.pid || exact.ancestorPids?.includes(this.ownedProcess.pid));
      if (isOwned) this.ownedListenerPid = exact.pid;
      if (!isOwned && this.ownedProcess) {
        this.ownedProcess.detachForHandoff();
        this.ownedProcess = null;
        this.ownedListenerPid = null;
      }
      // PM24-RUNNER: an EXTERNAL exact listener (never owned by this
      // Electron lifetime — whether truly started outside DSH, or DSH's own
      // previously-owned listener rediscovered after a Desktop restart lost
      // its in-memory ownedProcess handle) is evaluated against the SAME
      // connected/listening/busy evidence model an APP_OWNED listener uses,
      // just sourced from its own on-disk _diag log instead of live-captured
      // stdout (see readExternalRunnerDiagnosticEvidence()'s docstring).
      // Reusing ONLINE_IDLE/ONLINE_BUSY here is deliberate (Part: "use
      // existing enums, never invent unnecessary new ones") — Start/Stop/
      // Restart stay gated purely on `ownership==='APP_OWNED'`
      // (stopImpl/restart below), completely independent of `state`, so an
      // EXTERNAL runner reaching ONLINE_IDLE here never grants any
      // destructive control it didn't already have.
      const evidence = isOwned
        ? { connected: this.generationConnected, listening: this.generationListening, busy: this.generationBusy }
        : this.dependencies.readExternalEvidence(preflight.resolvedPath);
      const state: RelayRunnerState = isOwned && !this.generationCaptureHealthy
        ? 'DEGRADED'
        : evidence.busy ? 'ONLINE_BUSY'
        : evidence.connected && evidence.listening ? 'ONLINE_IDLE'
        : 'RUNNING_ONLINE_UNVERIFIED';
      const lastError = isOwned && !this.generationCaptureHealthy
        ? { code: 'RUNNER_OUTPUT_CAPTURE_FAILED', message: 'Runner output capture failed; lifecycle control is suspended because job activity cannot be verified.' }
        : null;
      this.transition({ ...liveSettings, state, registration: 'REGISTERED', ownership: isOwned ? 'APP_OWNED' : 'EXTERNAL', pid: exact.pid, version: discovery.version, runnerPath: preflight.resolvedPath, lastError });
      this.log('runner_discovered', `pid=${exact.pid} ownership=${isOwned ? 'APP_OWNED' : 'EXTERNAL'}`);
    } catch (error) {
      this.transition({ enabled: preflight.settings.enabled, autoStart: preflight.settings.autoStart, state: 'DEGRADED', registration: 'REGISTERED', lastError: { code: 'RUNNER_DISCOVERY_FAILED', message: sanitizeText(error instanceof Error ? error.message : error) } });
    }
    return this.getStatus();
  }

  async start(): Promise<RelayRunnerOperationResult> { return this.runExclusive(() => this.startImpl()); }

  private async startImpl(): Promise<RelayRunnerOperationResult> {
    const refreshed = await this.refreshImpl();
    if (refreshed.ownership === 'EXTERNAL' || refreshed.ownership === 'APP_OWNED' || this.ownedProcess) {
      return { ok: false, status: refreshed, code: 'RUNNER_ALREADY_RUNNING', message: 'The configured runner is already running.' };
    }
    if (refreshed.state !== 'REGISTERED_OFFLINE') {
      return { ok: false, status: refreshed, code: 'RUNNER_NOT_STARTABLE', message: refreshed.lastError?.message ?? 'Runner is not registered and offline.' };
    }
    const runnerPath = refreshed.runnerPath!;
    this.generation += 1;
    const generation = this.generation;
    this.generationConnected = false;
    this.generationListening = false;
    this.generationBusy = false;
    this.generationCaptureHealthy = true;
    this.lineRemainders = { stdout: '', stderr: '' };
    this.logs = [];
    // Every fresh generation — manual or automated — starts this flag
    // clear. Only evaluateHealth's own call path re-arms it afterward, so
    // a manual Start/Restart's later crash is never mistaken for a failed
    // health-recovery attempt.
    this.recoveryAwaitingStable = false;
    this.transition({ state: 'STARTING', ownership: 'APP_OWNED', lastError: null });
    this.log('runner_starting', `path=${runnerPath}`);
    try {
      const child = this.dependencies.spawnRunner(runnerPath);
      this.ownedProcess = child;
      this.lastExitWasManual = false;
      this.transition({ pid: child.pid });
      this.log('runner_spawned', `rootPid=${child.pid} ownership=APP_OWNED`);
      child.onStdout((chunk) => this.ingestOutput(chunk, generation, 'stdout'));
      child.onStderr((chunk) => this.ingestOutput(chunk, generation, 'stderr'));
      child.onError((error) => this.handleProcessError(error, generation));
      child.onCaptureError((error) => this.handleCaptureError(error, generation));
      child.onExit((code, signal) => this.handleProcessExit(code, signal, generation));
      return { ok: true, status: this.getStatus() };
    } catch (error) {
      this.ownedProcess = null;
      const message = sanitizeText(error instanceof Error ? error.message : error);
      this.transition({ state: 'FAILED', ownership: 'NONE', pid: null, lastError: { code: 'RUNNER_SPAWN_FAILED', message } });
      this.log('runner_start_failed', message);
      return { ok: false, status: this.getStatus(), code: 'RUNNER_SPAWN_FAILED', message };
    }
  }

  private ingestOutput(chunk: string, generation: number, stream: 'stdout' | 'stderr'): void {
    if (generation !== this.generation) return;
    const combined = this.lineRemainders[stream] + chunk;
    const lines = combined.split(/\r?\n/);
    this.lineRemainders[stream] = lines.pop() ?? '';
    for (const rawLine of lines) this.ingestLine(rawLine, stream);
  }

  private ingestLine(rawLine: string, stream: 'stdout' | 'stderr'): void {
    const line = sanitizeText(rawLine.trim());
    if (!line) return;
    this.log(`runner_${stream}`, line);
    // P1 (final hold): a multiple-exact-listeners discovery forgets
    // ownership (ownedProcess = null) precisely so control stays fail-
    // closed. Stray output from a generation whose ownership was revoked
    // that way must never re-claim APP_OWNED/ONLINE_IDLE and quietly
    // override that DEGRADED/ambiguous status — the line is still logged
    // above, but it drives no further state transition.
    if (!this.ownedProcess || !this.generationCaptureHealthy) return;
    if (CONNECTED_EVIDENCE_RE.test(line)) this.generationConnected = true;
    if (LISTENING_EVIDENCE_RE.test(line)) this.generationListening = true;
    if (JOB_STARTED_EVIDENCE_RE.test(line)) {
      this.generationBusy = true;
      this.transition({ state: 'ONLINE_BUSY', ownership: 'APP_OWNED', lastError: null });
      this.log('runner_busy');
      return;
    }
    if (this.generationBusy && JOB_COMPLETED_EVIDENCE_RE.test(line)) {
      this.generationBusy = false;
      this.transition({ state: this.generationConnected && this.generationListening ? 'ONLINE_IDLE' : 'RUNNING_ONLINE_UNVERIFIED', ownership: 'APP_OWNED' });
      this.log('runner_idle');
      return;
    }
    if (CONNECTION_DEGRADED_EVIDENCE_RE.test(line)) {
      this.transition({ state: 'DEGRADED', lastError: { code: 'RUNNER_CONNECTION_DEGRADED', message: 'Runner reported a connection failure.' } });
      return;
    }
    if (this.generationConnected && this.generationListening && !this.generationBusy) {
      this.transition({ state: 'ONLINE_IDLE', ownership: 'APP_OWNED', lastError: null });
    } else if (this.generationConnected && this.status.state === 'STARTING') {
      this.transition({ state: 'RUNNING_ONLINE_UNVERIFIED', ownership: 'APP_OWNED' });
    }
  }

  private handleProcessError(error: Error, generation: number): void {
    if (generation !== this.generation) return;
    const message = sanitizeText(error.message);
    this.transition({ state: 'FAILED', ownership: 'NONE', pid: null, lastError: { code: 'RUNNER_PROCESS_ERROR', message } });
    this.log('runner_process_error', message);
  }

  private handleCaptureError(error: Error, generation: number): void {
    if (generation !== this.generation || !this.ownedProcess) return;
    this.generationCaptureHealthy = false;
    this.transition({ state: 'DEGRADED', ownership: 'APP_OWNED', lastError: { code: 'RUNNER_OUTPUT_CAPTURE_FAILED', message: 'Runner output capture failed; lifecycle control is suspended because job activity cannot be verified.' } });
    this.log('runner_output_capture_failed', sanitizeText(error.message));
  }

  private handleProcessExit(code: number | null, signal: string | null, generation: number): void {
    if (generation !== this.generation) return;
    const wasStopping = this.stopping;
    this.ownedProcess = null;
    this.ownedListenerPid = null;
    this.generationBusy = false;
    this.lastExitWasManual = wasStopping;
    this.transition(wasStopping
      ? { state: 'REGISTERED_OFFLINE', registration: 'REGISTERED', ownership: 'NONE', pid: null, lastError: null }
      : { state: 'FAILED', registration: 'REGISTERED', ownership: 'NONE', pid: null, lastError: { code: 'RUNNER_EXITED_UNEXPECTEDLY', message: `Runner exited unexpectedly (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).` } });
    this.log(wasStopping ? 'runner_stopped' : 'runner_exited_unexpectedly', `code=${code ?? 'unknown'} signal=${signal ?? 'none'}`);
  }

  async stop(): Promise<RelayRunnerOperationResult> { return this.runExclusive(() => this.stopImpl()); }

  private async stopImpl(): Promise<RelayRunnerOperationResult> {
    if (this.status.ownership !== 'APP_OWNED' || !this.ownedProcess) return { ok: false, status: this.getStatus(), code: 'RUNNER_NOT_APP_OWNED', message: 'Only a runner started by this Desktop lifetime can be stopped.' };
    if (!this.generationCaptureHealthy) return { ok: false, status: this.getStatus(), code: 'RUNNER_OUTPUT_UNVERIFIED', message: 'Runner output capture is unavailable, so active job state cannot be verified.' };
    if (this.status.state === 'ONLINE_BUSY' || this.generationBusy) return { ok: false, status: this.getStatus(), code: 'RUNNER_BUSY', message: 'An active relay job is protected from Stop/Restart.' };
    const child = this.ownedProcess;
    this.stopping = true;
    this.transition({ state: 'STOPPING' });
    this.log('runner_stopping', `rootPid=${child.pid}`);
    child.requestGracefulStop();
    const deadline = this.dependencies.now().getTime() + this.stopTimeoutMs;
    while (this.ownedProcess === child && this.dependencies.now().getTime() < deadline) await this.dependencies.delay(25);
    if (this.ownedProcess === child) {
      this.log('runner_stop_escalating', `rootPid=${child.pid}`);
      child.forceKillTree();
      const forceDeadline = this.dependencies.now().getTime() + this.stopTimeoutMs;
      while (this.ownedProcess === child && this.dependencies.now().getTime() < forceDeadline) await this.dependencies.delay(25);
    }
    this.stopping = false;
    if (this.ownedProcess === child) {
      this.transition({ state: 'FAILED', lastError: { code: 'RUNNER_STOP_TIMEOUT', message: 'Runner did not exit within the bounded stop timeout.' } });
      return { ok: false, status: this.getStatus(), code: 'RUNNER_STOP_TIMEOUT', message: this.status.lastError!.message };
    }
    return { ok: true, status: this.getStatus() };
  }

  async restart(): Promise<RelayRunnerOperationResult> {
    return this.runExclusive(async () => {
      if (this.status.state === 'ONLINE_BUSY' || this.generationBusy) return { ok: false, status: this.getStatus(), code: 'RUNNER_BUSY', message: 'An active relay job is protected from Stop/Restart.' };
      if (!this.generationCaptureHealthy) return { ok: false, status: this.getStatus(), code: 'RUNNER_OUTPUT_UNVERIFIED', message: 'Runner output capture is unavailable, so active job state cannot be verified.' };
      const stopped = await this.stopImpl();
      if (!stopped.ok) return stopped;
      return this.startImpl();
    });
  }

  // P0-3: the renderer may only ever toggle these two booleans. There is
  // no `runnerPath` field here at all — a compromised renderer has no
  // path value it could smuggle through this call. The runner directory
  // is set exclusively via configureRunnerPath(), which only main.ts's
  // native OS folder-picker IPC handler ever calls with an OS-selected
  // path (see main.ts's `relayRunner:pickFolder` handler).
  async updateSettings(input: unknown): Promise<RelayRunnerOperationResult> {
    return this.runExclusive(async () => {
      if (!input || typeof input !== 'object') return { ok: false, status: this.getStatus(), code: 'RUNNER_SETTINGS_INVALID', message: 'Runner settings payload is invalid.' };
      const value = input as Record<string, unknown>;
      if (typeof value.enabled !== 'boolean' || typeof value.autoStart !== 'boolean') {
        return { ok: false, status: this.getStatus(), code: 'RUNNER_SETTINGS_INVALID', message: 'Runner settings require enabled and autoStart.' };
      }
      if (this.status.ownership === 'APP_OWNED' && value.enabled !== this.status.enabled) {
        return { ok: false, status: this.getStatus(), code: 'RUNNER_SETTINGS_ACTIVE', message: 'Stop the app-owned idle runner before changing its enabled state.' };
      }
      const current = this.settingsStore.get().relayRunner ?? { enabled: false, runnerPath: null, autoStart: false };
      this.settingsStore.setRelayRunner({ enabled: value.enabled, autoStart: value.autoStart, runnerPath: current.runnerPath });
      this.autoStartAttempted = false;
      return { ok: true, status: await this.refreshImpl() };
    });
  }

  // P0-3/P0 (final hold): the ONLY way a runner path is ever persisted.
  // Called exclusively from main.ts after dialog.showOpenDialog resolves
  // an OS-selected directory — never with renderer-supplied text.
  //
  // VALIDATE BEFORE PERSIST: the candidate is fully structurally validated
  // (absolute, exists, realpath-resolvable, valid .runner registration,
  // run.cmd + both runner executables present) via the SAME
  // validateRunnerDirectory() helper preflight() uses, BEFORE any write to
  // Desktop settings. A candidate that fails any gate is never persisted —
  // the previously configured (working) path survives untouched — and the
  // call returns ok:false with a typed code/message. The registration/
  // reconfiguration script has no call site here, and no registration
  // file is ever modified.
  async configureRunnerPath(candidatePath: string): Promise<RelayRunnerOperationResult> {
    return this.runExclusive(async () => {
      if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
        return { ok: false, status: this.getStatus(), code: 'RUNNER_PATH_INVALID', message: 'No runner folder was selected.' };
      }
      const trimmed = candidatePath.trim();
      if (this.status.ownership === 'APP_OWNED') {
        return { ok: false, status: this.getStatus(), code: 'RUNNER_SETTINGS_ACTIVE', message: 'Stop the app-owned idle runner before changing its path.' };
      }
      const validation = this.validateRunnerDirectory(trimmed);
      if (!validation.ok) {
        return { ok: false, status: this.getStatus(), code: validation.code, message: validation.message };
      }
      const current = this.settingsStore.get().relayRunner ?? { enabled: false, runnerPath: null, autoStart: false };
      this.settingsStore.setRelayRunner({ enabled: current.enabled, autoStart: current.autoStart, runnerPath: trimmed });
      this.autoStartAttempted = false;
      return { ok: true, status: await this.refreshImpl() };
    });
  }

  // P1: bounded self-healing poll. One refresh per interval — never a
  // tight loop — followed by a single bounded, backed-off restart attempt
  // when evidence supports it. Idempotent: calling this while already
  // monitoring is a no-op.
  startHealthMonitor(): void {
    if (this.monitoring) return;
    this.monitoring = true;
    this.scheduleNextHealthTick();
  }

  stopHealthMonitor(): void {
    this.monitoring = false;
    this.healthTimer?.cancel();
    this.healthTimer = null;
  }

  getHealth(): RelayRunnerHealth {
    return {
      lastChecked: this.status.lastChecked,
      lastSuccessfulOnlineEvidence: this.lastSuccessfulOnlineEvidence,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt,
    };
  }

  private scheduleNextHealthTick(): void {
    if (!this.monitoring) return;
    this.healthTimer = this.dependencies.scheduleTimer(() => {
      // A runner health-tick failure must never surface as an unhandled
      // rejection and must never affect Desktop or DSH runtime startup.
      this.healthTick().catch((error) => {
        this.log('runner_health_tick_failed', sanitizeText(error instanceof Error ? error.message : error));
      });
    }, this.healthPollIntervalMs);
  }

  private async healthTick(): Promise<void> {
    // Routed through the SAME exclusive queue as Start/Stop/Restart/
    // Refresh, so a manual operation and a health tick can never race —
    // whichever is queued first completes before the next one begins,
    // which is what guarantees "concurrent monitor/manual/startup start
    // requests -> exactly one listener".
    await this.runExclusive(async () => {
      if (!this.monitoring) return;
      const status = await this.refreshImpl();
      await this.evaluateHealth(status);
    });
    this.scheduleNextHealthTick();
  }

  private computeBackoffMs(retryCount: number): number {
    const backoff = BASE_RESTART_BACKOFF_MS * Math.pow(2, Math.min(retryCount, MAX_RESTART_RETRY_COUNT));
    return Math.min(backoff, MAX_RESTART_BACKOFF_MS);
  }

  private async evaluateHealth(status: RelayRunnerStatus): Promise<void> {
    const now = this.dependencies.now();
    // Stable ONLINE evidence resets backoff — a runner that recovered and
    // stayed up should not still be penalized by an earlier failure run.
    // This is also the ONLY place recoveryAwaitingStable is cleared by
    // success, so an unstable recovery generation that reaches this point
    // has graduated and a later crash starts a fresh backoff series.
    if (status.ownership === 'APP_OWNED' && (status.state === 'ONLINE_IDLE' || status.state === 'ONLINE_BUSY')) {
      this.retryCount = 0;
      this.nextRetryAt = null;
      this.lastSuccessfulOnlineEvidence = now.toISOString();
      this.recoveryAwaitingStable = false;
      return;
    }
    // Only ever consider restarting a registered, confirmed-offline,
    // unowned runner. EXTERNAL ownership, STARTING/STOPPING transitions,
    // DEGRADED/FAILED-but-still-present listeners, and disabled/manual
    // configurations are all left completely untouched by design — exact
    // discovery (pid/parent/path match) means there is no ambiguous
    // identity state to fall into here; an unmatched listener is always
    // classified EXTERNAL, never "maybe ours". Crucially, this branch also
    // never fires while a just-started generation is merely still trying
    // to reach stable evidence (that generation is APP_OWNED and
    // RUNNING_ONLINE_UNVERIFIED, not REGISTERED_OFFLINE) — only a
    // CONFIRMED-dead generation reaches here.
    if (status.state !== 'REGISTERED_OFFLINE' || status.ownership !== 'NONE') return;
    if (!status.enabled || !status.autoStart) return;
    // A deliberate owner Stop/Restart is not an "unexpected" exit — never
    // reverse it out from under the owner just because autoStart is on.
    if (this.lastExitWasManual) return;
    // Crash-loop accounting: a generation the health monitor itself
    // started, which then died again before ever reaching stable evidence,
    // is a FAILED recovery cycle — even though its own spawnRunner() call
    // reported success at the time. Account for it here, on the tick that
    // observes the death, rather than at spawn time, and defer the actual
    // next attempt to a later tick so the freshly-computed backoff window
    // is actually honored (never retry again within the same tick).
    if (this.recoveryAwaitingStable) {
      this.recoveryAwaitingStable = false;
      this.retryCount = Math.min(this.retryCount + 1, MAX_RESTART_RETRY_COUNT);
      this.nextRetryAt = new Date(now.getTime() + this.computeBackoffMs(this.retryCount)).toISOString();
      this.log('runner_health_recovery_unstable', `retryCount=${this.retryCount} nextRetryAt=${this.nextRetryAt}`);
      return;
    }
    if (this.nextRetryAt && now.getTime() < new Date(this.nextRetryAt).getTime()) return;
    let result: RelayRunnerOperationResult;
    try {
      result = await this.startImpl();
    } catch (error) {
      result = { ok: false, status: this.getStatus(), code: 'RUNNER_HEALTH_RESTART_FAILED', message: sanitizeText(error instanceof Error ? error.message : error) };
    }
    if (!result.ok) {
      this.retryCount = Math.min(this.retryCount + 1, MAX_RESTART_RETRY_COUNT);
      this.nextRetryAt = new Date(this.dependencies.now().getTime() + this.computeBackoffMs(this.retryCount)).toISOString();
      this.log('runner_health_restart_deferred', `retryCount=${this.retryCount} nextRetryAt=${this.nextRetryAt}`);
    } else {
      // The spawn succeeded, but this generation has not yet proven
      // stability — mark it so a pre-stable death still counts as a
      // failed recovery cycle (see the recoveryAwaitingStable branch
      // above), never a free, unlimited-rate crash loop.
      this.recoveryAwaitingStable = true;
      this.log('runner_health_restart_attempted', 'autoStart recovery triggered by health monitor');
    }
  }

  async shutdown(): Promise<void> {
    this.stopHealthMonitor();
    await this.runExclusive(async () => {
      if (this.status.ownership === 'EXTERNAL' || !this.ownedProcess) {
        this.log('runner_shutdown_left_untouched', `ownership=${this.status.ownership}`);
        return;
      }
      if (this.status.state === 'ONLINE_BUSY' || this.generationBusy) {
        this.log('runner_shutdown_busy_handoff', 'App-owned busy runner left alive; next Desktop launch will observe it as EXTERNAL.');
        this.ownedProcess.detachForHandoff();
        return;
      }
      if (!this.generationCaptureHealthy) {
        this.log('runner_shutdown_unverified_handoff', 'Runner output capture unavailable; runner left alive and lifecycle ownership handed off.');
        this.ownedProcess.detachForHandoff();
        return;
      }
      await this.stopImpl();
    });
  }
}
