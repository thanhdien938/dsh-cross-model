// P6-W3-R3 Part B6/B7 — a small bounded ring buffer for one backend
// product's execution-log entries. Mirrors RuntimeLogBuffer's shape
// (ephemeral, in-memory, per-Desktop-session, never persisted, never
// canonical — see that file's docstring) but adds the two extra
// requirements the owner specified for backend execution logs
// specifically: a hard 2000-line cap *and* a byte ceiling as
// defense-in-depth, plus an explicit truncation flag the UI can render as
// "[... older execution log lines discarded ...]".
export interface BackendExecutionLogEntry {
  seq: number;
  timestamp: string;
  backendProduct: string;
  profileId: string | null;
  projectId: string | null;
  taskId: string | null;
  pmRunId: string | null;
  runId: string | null;
  phase: string | null;
  stream: string | null;
  eventKind: string | null;
  message: string;
  cwd: string | null;
  model: string | null;
  pid: number | null;
  exitCode: number | null;
  durationMs: number | null;
  parserOutcome: string | null;
  status: string | null;
}

export interface RawBackendExecutionEvent {
  timestamp?: string;
  backendProduct?: string;
  profileId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  pmRunId?: string | null;
  runId?: string | null;
  phase?: string | null;
  stream?: string | null;
  eventKind?: string | null;
  message?: string;
  cwd?: string | null;
  model?: string | null;
  pid?: number | null;
  exitCode?: number | null;
  durationMs?: number | null;
  parserOutcome?: string | null;
  status?: string | null;
}

const MAX_LINE_CHARS = 4000;
const DEFAULT_MAX_ENTRIES = 2000;
// R31-3: this is a defense-in-depth ceiling, not an exact accounting of
// every byte held in memory (the fixed-shape identity fields — ids,
// timestamps, phase, etc. — are not individually measured; a flat
// METADATA_OVERHEAD_BYTES stands in for them rather than paying for a
// real JSON.stringify()+Buffer.byteLength() per push() on a hot path).
// What it MUST be honest about is the part that actually varies and can
// be attacker/input-controlled: the message text. That part is measured
// in real UTF-8 bytes (Buffer.byteLength(message, 'utf8')), not
// JavaScript's `string.length` (UTF-16 code units) — a 4000-character
// Vietnamese or emoji-heavy message can be 8000+ UTF-8 bytes, and a
// ceiling that only counted `.length` would silently admit roughly
// double the memory it claims to bound. Named `estimated*` throughout,
// not `total`/`exact`, to keep that honest.
const DEFAULT_MAX_ESTIMATED_BYTES = 4 * 1024 * 1024;
const METADATA_OVERHEAD_BYTES = 256;

function estimatedEntryBytes(entry: BackendExecutionLogEntry): number {
  return Buffer.byteLength(entry.message, 'utf8') + METADATA_OVERHEAD_BYTES;
}

export class BackendExecutionRingBuffer {
  private entries: BackendExecutionLogEntry[] = [];
  private nextSeq = 1;
  private truncated = false;
  private estimatedTotalBytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxEstimatedBytes = DEFAULT_MAX_ESTIMATED_BYTES,
  ) {}

  push(raw: RawBackendExecutionEvent): BackendExecutionLogEntry {
    const message = String(raw.message ?? '');
    const bounded = message.length > MAX_LINE_CHARS ? `${message.slice(0, MAX_LINE_CHARS)}…[truncated]` : message;
    const entry: BackendExecutionLogEntry = {
      seq: this.nextSeq++,
      timestamp: raw.timestamp ?? new Date().toISOString(),
      backendProduct: raw.backendProduct ?? 'unknown',
      profileId: raw.profileId ?? null,
      projectId: raw.projectId ?? null,
      taskId: raw.taskId ?? null,
      pmRunId: raw.pmRunId ?? null,
      runId: raw.runId ?? null,
      phase: raw.phase ?? null,
      stream: raw.stream ?? null,
      eventKind: raw.eventKind ?? null,
      message: bounded,
      cwd: raw.cwd ?? null,
      model: raw.model ?? null,
      pid: typeof raw.pid === 'number' ? raw.pid : null,
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
      parserOutcome: raw.parserOutcome ?? null,
      status: raw.status ?? null,
    };
    this.entries.push(entry);
    this.estimatedTotalBytes += estimatedEntryBytes(entry);
    while (this.entries.length > this.maxEntries || this.estimatedTotalBytes > this.maxEstimatedBytes) {
      const dropped = this.entries.shift();
      if (dropped) this.estimatedTotalBytes -= estimatedEntryBytes(dropped);
      this.truncated = true;
    }
    return entry;
  }

  // afterSeq: only entries with seq > afterSeq (a cheap incremental tail,
  // so Desktop can poll "what's new since I last asked" instead of
  // re-sending the whole 2000-line buffer every poll).
  list(options: { afterSeq?: number; limit?: number } = {}): { entries: BackendExecutionLogEntry[]; truncated: boolean; latestSeq: number } {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(1, options.limit ?? this.maxEntries), this.maxEntries);
    const filtered = afterSeq > 0 ? this.entries.filter((e) => e.seq > afterSeq) : this.entries;
    return {
      entries: filtered.slice(-limit),
      truncated: this.truncated,
      latestSeq: this.entries.length > 0 ? this.entries[this.entries.length - 1].seq : afterSeq,
    };
  }

  get size(): number {
    return this.entries.length;
  }

  // R31-9: deliberately does NOT reset `nextSeq`. A runtime restart (see
  // main.ts's `runtime:start` handler) clears buffer *content*, but a
  // renderer polling with a stale cursor from before the restart
  // (`afterSeq: 800`, say) must still see the new session's events. If
  // seq restarted at 1 here, every post-restart entry would have
  // seq <= 800 and list({ afterSeq: 800 }) would silently return nothing
  // forever, hiding the entire new session — this is the smallest
  // reliable fix: seq stays monotonic for this buffer's whole process
  // lifetime, so a new event's seq is always > any cursor issued before
  // it, restart or not.
  clear(): void {
    this.entries = [];
    this.truncated = false;
    this.estimatedTotalBytes = 0;
  }
}
