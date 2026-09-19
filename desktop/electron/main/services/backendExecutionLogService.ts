import { BackendExecutionRingBuffer, BackendExecutionLogEntry, RawBackendExecutionEvent } from './backendExecutionRingBuffer';

// P6-W3-R3 Part B — the runtime child process (scripts/p5-runtime.mjs,
// spawned by RuntimeSupervisor) already streams its combined stdout/stderr
// to Desktop as plain text via the 'log' event (see runtimeSupervisor.ts
// and main.ts's `runtimeLogBuffer.push(log)`). BackendExecutionObserver
// (src/runtime/backend-execution-observer.mjs) writes one sentinel-
// prefixed NDJSON line per backend execution event into that same stdout
// — reusing the existing process-boundary channel instead of adding a new
// one. This service scans that same raw text for the sentinel, routes
// matching lines into one ring buffer per backend product, and leaves
// every other line untouched for RuntimeLogBuffer to keep handling
// exactly as before (this service only *reads* the chunk; it never
// mutates or consumes it).
export const EXEC_LOG_SENTINEL = '##DSH_BACKEND_EXEC##';

// R31-4: the fallback set used only until the runtime's real product
// catalogue (src/pm/production-pm-backend-registry.mjs's
// `listSupportedProducts()`, a static zero-I/O export) has been resolved
// once at startup (see main.ts) and passed in via `setAllowedProducts()`.
// Kept in sync with that module today; if it ever drifts this is a safe
// floor, not the authority — `setAllowedProducts()` is the authority.
const FALLBACK_BACKEND_PRODUCTS = ['claude-code', 'opencode', 'codex', 'grok', 'antigravity'];

export type BackendProduct = string;

// P10-R0.2.4.1 Part J/K/M/N: a narrow, owner-visible projection of ONE
// LONG (runtime_class=LONG) task's runtime/liveness state, fed from the
// SAME already-parsed BackendExecutionObserver event stream this service
// already ingests (never a second event channel, never log-text parsing
// in the renderer — Part M). Ephemeral/in-memory only, exactly like
// BackendExecutionRingBuffer — never a substitute for the durable
// pm_runs/task_diagnostic-log record. `hardDeadlineMs` mirrors the fixed
// production constant `LONG_TASK_HARD_DEADLINE_MS` (src/pm/pm-execution-
// timeout-policy.mjs) — duplicated here deliberately (same convention as
// FALLBACK_BACKEND_PRODUCTS above): this TS project cannot import a
// plain-ESM .mjs module across the Electron main-process boundary, and
// the value is a stable, already-owner-documented constant, not a
// runtime-computed one.
export const LONG_TASK_STAGE = 'single_pm_long';
export const LONG_TASK_HARD_DEADLINE_MS = 1_800_000;
export type LongTaskLivenessState = 'ACTIVE' | 'QUIET_RUNNING' | 'STALLED' | 'EXITED';

export interface LongTaskRuntimeState {
  taskId: string;
  pmRunId: string | null;
  projectId: string | null;
  profileId: string | null;
  product: string | null;
  pid: number | null;
  startedAt: string | null;
  hardDeadlineMs: number;
  liveness: LongTaskLivenessState | null;
  lastActivityKind: string | null;
  lastActivityAgeMs: number | null;
  // Part O: the age snapshot above is only as fresh as the last observed
  // transition — `snapshotAt` lets the renderer extrapolate a display-only
  // "age now" (snapshotAgeMs + (now - snapshotAt)) without a second main-
  // process timer. The renderer's clock never drives any real policy.
  snapshotAt: string;
  sandboxState: string | null;
  processExited: boolean;
  exitCode: number | null;
  hardDeadlineReached: boolean;
  updatedAt: string;
}

function freshLongTaskState(event: RawLongTaskEvent, timestamp: string): LongTaskRuntimeState {
  return {
    taskId: String(event.taskId), pmRunId: event.pmRunId ?? null, projectId: event.projectId ?? null,
    profileId: event.profileId ?? null, product: event.backendProduct ?? null, pid: null,
    startedAt: timestamp, hardDeadlineMs: LONG_TASK_HARD_DEADLINE_MS, liveness: null,
    lastActivityKind: null, lastActivityAgeMs: null, snapshotAt: timestamp, sandboxState: null,
    processExited: false, exitCode: null, hardDeadlineReached: false, updatedAt: timestamp,
  };
}

// R31-3-style bound: a long-lived Desktop session must never accumulate
// an unbounded number of historical long-task entries — oldest-updated
// (never the currently active one) is evicted first once the cap is hit.
const MAX_LONG_TASK_STATES = 25;

// The subset of RawBackendExecutionEvent's fields this projection reads,
// plus the R0.2.4 liveness/timeout/sandbox fields that exist on the wire
// but were never added to RawBackendExecutionEvent's shape above (that
// interface stays the ring buffer's own fixed-field contract — untouched
// by this wave, Part V "no semantic change" for the existing log view).
interface RawLongTaskEvent extends RawBackendExecutionEvent {
  stage?: string | null;
  eventKind?: string | null;
  livenessFrom?: string | null;
  livenessTo?: string | null;
  lastActivityKind?: string | null;
  lastActivityAgeMs?: number | null;
  sandboxState?: string | null;
  terminationRequested?: boolean;
}

export type BackendRunBadge = 'idle' | 'running' | 'completed' | 'failed';

export interface BackendRunState {
  badge: BackendRunBadge;
  runId: string | null;
  projectId: string | null;
  taskId: string | null;
  profileId: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

function freshRunState(): BackendRunState {
  return { badge: 'idle', runId: null, projectId: null, taskId: null, profileId: null, cwd: null, model: null, startedAt: null, updatedAt: null };
}

// B8 defense-in-depth: BackendExecutionObserver already sanitizes at the
// point of emission (src/runtime/backend-execution-observer.mjs). This is
// an independent, standalone re-check at the Desktop main/IPC/renderer
// boundary — deliberately not a shared import of the same regex table, so
// a single sanitizer bug can't silently disable both layers at once.
// R31-7: this runs on the fully-reassembled event message (after framing,
// before per-line splitting) so a secret cannot straddle a line-split
// boundary and dodge the pattern.
const SENSITIVE_INLINE: Array<[RegExp, string]> = [
  [/\b(authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi, '$1$2 [REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
  [/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\b((?:api[_-]?key|apikey|token|secret|password|passwd|access[_-]?key|dsn|connection[_-]?string)\s*[:=]\s*)("?)[^\s"',}]+/gi, '$1$2[REDACTED]'],
  [/\b\d{6,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]'],
];

export function sanitizeExecutionLogTextDesktop(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SENSITIVE_INLINE) out = out.replace(pattern, replacement);
  return out;
}

function sanitizeEntry(event: RawBackendExecutionEvent): RawBackendExecutionEvent {
  return {
    ...event,
    message: typeof event.message === 'string' ? sanitizeExecutionLogTextDesktop(event.message) : event.message,
    cwd: typeof event.cwd === 'string' ? event.cwd : event.cwd, // cwd is a path, not a secret — passed through unredacted (B2/Part C require it visible)
  };
}

// R31-2: one observer event's `message` may itself be several
// human-readable lines (e.g. a multi-line STDERR chunk: "warning A\n
// warning B\nwarning C"). The owner's "2000 lines" requirement means 2000
// *logical display lines*, not 2000 events — so this splits one event's
// message into the logical lines the UI will actually render, each
// becoming its own ring-buffer entry (with identical identity metadata).
// A lone trailing newline is a split artifact, not a meaningful blank
// line, and is dropped; a genuine blank line in the middle of the
// message is preserved.
const LINE_SPLIT = /\r\n|\r|\n/;

export function splitLogicalLines(message: string): string[] {
  if (message === '') return [''];
  const hadTrailingNewline = LINE_SPLIT.test(message.slice(-2));
  const parts = message.split(LINE_SPLIT);
  if (hadTrailingNewline && parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length > 0 ? parts : [''];
}

// R31-1: a single BackendExecutionObserver `console.log()` call in the
// runtime process is one NDJSON line, but Node's stdout `data` event
// delivers arbitrary byte chunks with no guaranteed relationship to that
// — a chunk boundary can land in the middle of the sentinel, in the
// middle of the JSON, or carry several complete records at once. Without
// reassembly, a split record's two halves each individually fail to
// parse and are silently dropped, so a critical START/PARSER/TERMINAL
// event can vanish depending on nothing but OS/pipe buffering timing.
// This carry buffer defers processing any text after the last newline
// until a future ingest() call completes it.
//
// Only stdout-sourced text participates in the carry buffer. Runtime
// stderr chunks (RuntimeSupervisor's `[ERROR] ` convention, see
// runtimeSupervisor.ts) are a logically separate OS pipe/stream — Node
// delivers stdout and stderr via two independent 'data' listeners that
// both funnel into the same 'log' event, so a stderr chunk can arrive
// interleaved between two halves of one stdout line. Never appending
// stderr text into the stdout carry is what keeps a stdout-side partial
// record intact across such an interleaving instead of corrupting it.
// BackendExecutionObserver's default sink only ever writes to stdout
// (console.log), so a sentinel line can only ever originate there;
// stderr chunks are still scanned for any complete line they happen to
// contain, defensively, but never contribute to or drain the carry.
const MAX_CARRY_CHARS = 200_000; // generous vs. a single bounded (~4000-char) event line; bounds worst-case memory from a stream that never sends a newline

export class BackendExecutionLogService {
  private readonly buffers = new Map<BackendProduct, BackendExecutionRingBuffer>();
  private readonly runStates = new Map<BackendProduct, BackendRunState>();
  private allowedProducts: Set<BackendProduct>;
  private carry = '';
  // P10-R0.2.4.1: keyed by taskId, insertion order preserved (Map
  // iteration order) so eviction can drop the oldest entry cheaply.
  private readonly longTaskStates = new Map<string, LongTaskRuntimeState>();

  constructor(
    private readonly maxEntriesPerBackend = 2000,
    allowedProducts: readonly string[] = FALLBACK_BACKEND_PRODUCTS,
  ) {
    this.allowedProducts = new Set();
    for (const product of allowedProducts) this.registerProduct(product);
  }

  private registerProduct(product: string): void {
    if (this.allowedProducts.has(product)) return;
    this.allowedProducts.add(product);
    if (!this.buffers.has(product)) {
      this.buffers.set(product, new BackendExecutionRingBuffer(this.maxEntriesPerBackend));
      this.runStates.set(product, freshRunState());
    }
  }

  // R31-4: the *only* way the set of valid products changes — always
  // called with the real production registry's static, zero-I/O product
  // catalogue (src/pm/production-pm-backend-registry.mjs's
  // `listSupportedProducts()`, via main.ts), never with renderer-/IPC-
  // supplied strings. A product already known is left untouched (its
  // buffer/state is preserved, not reset); this only ever adds coverage,
  // it never removes an already-registered product's buffer.
  setAllowedProducts(products: readonly string[]): void {
    for (const product of products) this.registerProduct(product);
  }

  private isKnownProduct(value: unknown): value is BackendProduct {
    return typeof value === 'string' && this.allowedProducts.has(value);
  }

  // Accepts a raw stdout/stderr chunk exactly as RuntimeSupervisor's 'log'
  // event delivers it (already includes an `[ERROR] ` prefix convention
  // for stderr, same as RuntimeLogBuffer handles).
  ingest(rawChunk: string): void {
    const isStderr = rawChunk.startsWith('[ERROR] ');
    const text = isStderr ? rawChunk.slice('[ERROR] '.length) : rawChunk;

    if (isStderr) {
      // Scanned independently for any complete line it happens to
      // contain (defensive; sentinel content never actually appears
      // here — see the class docstring) but never touches `this.carry`.
      for (const line of text.split(LINE_SPLIT)) this.processLine(line);
      return;
    }

    // R311-5: complete, newline-terminated records are drained BEFORE
    // the cap is enforced — MAX_CARRY_CHARS protects only the remaining
    // *unterminated tail*, never the total size of a perfectly frameable
    // input chunk. A single large stdout `data` event can legitimately
    // contain thousands of complete records (e.g. a burst flushed after
    // a GUI disconnect); checking the cap first would have discarded all
    // of them, including ones that were never actually a framing risk.
    this.carry += text;
    this.drainCarry();
    if (this.carry.length > MAX_CARRY_CHARS) {
      console.error('BackendExecutionLogService: carry buffer exceeded cap without a newline — resetting (framing safety)');
      this.carry = '';
    }
  }

  private drainCarry(): void {
    let match: RegExpExecArray | null;
    const newlineMatcher = /\r\n|\r|\n/g;
    let lastIndex = 0;
    while ((match = newlineMatcher.exec(this.carry))) {
      this.processLine(this.carry.slice(lastIndex, match.index));
      lastIndex = newlineMatcher.lastIndex;
    }
    this.carry = this.carry.slice(lastIndex);
  }

  private processLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith(EXEC_LOG_SENTINEL)) return;
    const jsonText = trimmed.slice(EXEC_LOG_SENTINEL.length).trim();
    let event: RawBackendExecutionEvent;
    try {
      event = JSON.parse(jsonText);
    } catch {
      return; // malformed *complete* line — dropped; later lines are unaffected
    }
    if (!this.isKnownProduct(event.backendProduct)) return;
    const sanitized = sanitizeEntry(event);
    // P10-R0.2.4.1 Part J: fed from the SAME already-parsed event, before
    // this line is split into ring-buffer display entries — never a
    // second parse of the raw text.
    this.applyLongTaskState(sanitized as RawLongTaskEvent);
    const buffer = this.buffers.get(event.backendProduct as BackendProduct)!;
    const logicalLines = splitLogicalLines(typeof sanitized.message === 'string' ? sanitized.message : '');
    for (const lineText of logicalLines) {
      const entry = buffer.push({ ...sanitized, message: lineText });
      this.applyRunState(event.backendProduct as BackendProduct, entry);
    }
  }

  private applyRunState(product: BackendProduct, entry: BackendExecutionLogEntry): void {
    const state = this.runStates.get(product)!;
    if (entry.phase === 'START') {
      this.runStates.set(product, {
        badge: 'running',
        runId: entry.runId,
        projectId: entry.projectId,
        taskId: entry.taskId,
        profileId: entry.profileId,
        cwd: entry.cwd,
        model: entry.model,
        startedAt: entry.timestamp,
        updatedAt: entry.timestamp,
      });
      return;
    }
    if (entry.phase === 'TERMINAL') {
      const badge: BackendRunBadge = entry.status === 'COMPLETED' || entry.status === 'DECIDED' ? 'completed' : 'failed';
      this.runStates.set(product, { ...state, badge, updatedAt: entry.timestamp });
      return;
    }
    // Any other phase for the current run just bumps updatedAt/cwd/model if
    // they were not yet known (never regresses an already-terminal badge).
    this.runStates.set(product, { ...state, cwd: state.cwd ?? entry.cwd, model: state.model ?? entry.model, updatedAt: entry.timestamp });
  }

  // P10-R0.2.4.1 Part J/K/S: projects ONLY LONG-stage events
  // (`stage === 'single_pm_long'`) into `longTaskStates`; every NORMAL
  // task event is a no-op here (Part L — no clutter for normal tasks).
  // `processExited`/`liveness` are kept DISTINCT from any canonical task
  // status (Part S) — this service never learns "completed"/"failed"/
  // "await_owner" at all; it only ever reports backend PROCESS facts.
  private applyLongTaskState(event: RawLongTaskEvent): void {
    if (event.stage !== LONG_TASK_STAGE) return;
    const taskId = typeof event.taskId === 'string' ? event.taskId : null;
    if (!taskId) return;
    const timestamp = event.timestamp ?? new Date().toISOString();
    const existing = this.longTaskStates.get(taskId);
    const base = existing ?? freshLongTaskState(event, timestamp);
    if (!existing) {
      this.longTaskStates.set(taskId, base);
      this.evictLongTaskStatesIfNeeded();
    }
    const next: LongTaskRuntimeState = { ...base, updatedAt: timestamp };
    // Backfill identity fields opportunistically — never regress an
    // already-known value to null (mirrors applyRunState's own pattern).
    next.pmRunId = base.pmRunId ?? event.pmRunId ?? null;
    next.projectId = base.projectId ?? event.projectId ?? null;
    next.profileId = base.profileId ?? event.profileId ?? null;
    next.product = base.product ?? event.backendProduct ?? null;

    switch (event.eventKind) {
      case 'PROCESS_SPAWN':
        next.pid = typeof event.pid === 'number' ? event.pid : base.pid;
        if (!base.startedAt) next.startedAt = timestamp;
        break;
      case 'BACKEND_LIVENESS_STATE':
        next.liveness = (event.livenessTo as LongTaskLivenessState | undefined) ?? base.liveness;
        next.lastActivityKind = event.lastActivityKind ?? base.lastActivityKind;
        next.lastActivityAgeMs = typeof event.lastActivityAgeMs === 'number' ? event.lastActivityAgeMs : base.lastActivityAgeMs;
        next.snapshotAt = timestamp;
        break;
      case 'CODEX_SANDBOX':
        next.sandboxState = event.sandboxState ?? base.sandboxState;
        break;
      case 'TIMEOUT':
        // Part G/AG: the ONLY timeout class that can ever reach this
        // stage is the hard 30-minute deadline (EXECUTION_STAGE.
        // OWNER_SINGLE_LONG never resolves any other timeoutMs) — never
        // conflated with STALLED, which is a separate, non-terminating
        // liveness state.
        next.hardDeadlineReached = true;
        break;
      case 'PROCESS_EXIT':
        next.processExited = true;
        next.liveness = 'EXITED';
        next.exitCode = typeof event.exitCode === 'number' ? event.exitCode : base.exitCode;
        break;
      default:
        break;
    }
    this.longTaskStates.set(taskId, next);
  }

  private evictLongTaskStatesIfNeeded(): void {
    while (this.longTaskStates.size > MAX_LONG_TASK_STATES) {
      const oldestKey = this.longTaskStates.keys().next().value;
      if (oldestKey === undefined) break;
      this.longTaskStates.delete(oldestKey);
    }
  }

  // Newest-updated first — the renderer's primary interest is "what is
  // currently running/most-recently-changed", not full history.
  getLongTaskStates(): LongTaskRuntimeState[] {
    return [...this.longTaskStates.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  getLongTaskState(taskId: string): LongTaskRuntimeState | null {
    const state = this.longTaskStates.get(taskId);
    return state ? { ...state } : null;
  }

  list(product: string, options: { afterSeq?: number; limit?: number } = {}): { entries: BackendExecutionLogEntry[]; truncated: boolean; latestSeq: number } {
    if (!this.isKnownProduct(product)) return { entries: [], truncated: false, latestSeq: 0 };
    return this.buffers.get(product)!.list(options);
  }

  status(product: string): BackendRunState | null {
    if (!this.isKnownProduct(product)) return null;
    return { ...this.runStates.get(product)! };
  }

  statuses(): Record<string, BackendRunState> {
    const out: Record<string, BackendRunState> = {};
    for (const product of this.allowedProducts) out[product] = { ...this.runStates.get(product)! };
    return out;
  }

  // Part C (Backend Run Details): best-effort enrichment only — `runId`
  // here is BackendExecutionObserver's ctx.runId, which is set to the PM
  // request id (pm_requests.id), the same value the durable `pm_runs.
  // request_id` column carries. ReadProjection.getBackendRuns() can match
  // on that to backfill cwd/model/exitCode/parserOutcome for a run whose
  // ephemeral execution-log entries are still in memory. This is
  // intentionally best-effort and never a substitute for the durable
  // pm_runs summary — a run from before the current runtime session (or
  // one whose entries were pushed out of the 2000-line ring) simply
  // returns nulls, exactly like today.
  findByRunId(product: string, runId: string | null): { cwd: string | null; model: string | null; exitCode: number | null; parserOutcome: string | null; status: string | null } | null {
    if (!runId || !this.isKnownProduct(product)) return null;
    const { entries } = this.buffers.get(product)!.list();
    const matching = entries.filter((e) => e.runId === runId);
    if (matching.length === 0) return null;
    const withField = <K extends keyof BackendExecutionLogEntry>(key: K) => matching.map((e) => e[key]).find((v) => v !== null && v !== undefined) ?? null;
    return {
      cwd: withField('cwd') as string | null,
      model: withField('model') as string | null,
      exitCode: withField('exitCode') as number | null,
      parserOutcome: withField('parserOutcome') as string | null,
      status: withField('status') as string | null,
    };
  }

  // R31-9: clears buffer *content* and run status for a fresh runtime
  // session, but deliberately never resets any buffer's `nextSeq` — see
  // BackendExecutionRingBuffer.clear()'s docstring. Also resets the
  // stdout carry, since a partial record from the previous runtime
  // process's stdout can never be meaningfully completed by the next
  // one's.
  clear(): void {
    for (const product of this.allowedProducts) {
      this.buffers.get(product)!.clear();
      this.runStates.set(product, freshRunState());
    }
    this.carry = '';
    // P10-R0.2.4.1: a restarted runtime process means any in-flight long
    // task's real state is unknowable from here on — clear rather than
    // show a frozen, misleadingly-current-looking snapshot.
    this.longTaskStates.clear();
  }
}
