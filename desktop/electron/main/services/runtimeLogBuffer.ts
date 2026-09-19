// W3-E: a small bounded ring buffer for the runtime child process's own
// stdout/stderr. This is ephemeral, in-memory, per-Desktop-session
// evidence — never persisted, never canonical, never confused with the
// owner-facing timeline. It exists purely so "Runtime Process" has
// something real to show instead of always returning [].
export interface RuntimeLogEntry {
  timestamp: number;
  level: 'INFO' | 'ERROR';
  line: string;
}

const MAX_LINE_LENGTH = 4000;

export class RuntimeLogBuffer {
  private entries: RuntimeLogEntry[] = [];

  constructor(private readonly maxEntries = 500) {}

  push(raw: string): void {
    const isError = raw.startsWith('[ERROR]');
    const text = isError ? raw.slice('[ERROR] '.length) : raw;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.entries.push({ timestamp: Date.now(), level: isError ? 'ERROR' : 'INFO', line: line.slice(0, MAX_LINE_LENGTH) });
    }
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  list(limit = 200): RuntimeLogEntry[] {
    const bounded = Math.min(Math.max(1, limit), this.maxEntries);
    return this.entries.slice(-bounded);
  }

  clear(): void {
    this.entries = [];
  }
}
