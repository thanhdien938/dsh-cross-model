import { describe, it, expect } from 'vitest';
import { BackendExecutionLogService, EXEC_LOG_SENTINEL, sanitizeExecutionLogTextDesktop, splitLogicalLines } from '../electron/main/services/backendExecutionLogService';

function sentinelLine(event: Record<string, unknown>): string {
  return `${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}\n`;
}

const KNOWN_BACKEND_PRODUCTS = ['claude-code', 'opencode', 'codex', 'grok', 'antigravity'];

describe('BackendExecutionLogService', () => {
  it('routes sentinel-prefixed lines into the matching backend product buffer only', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'START claude-code' }));
    service.ingest(sentinelLine({ backendProduct: 'grok', phase: 'START', message: 'START grok' }));
    expect(service.list('claude-code').entries).toHaveLength(1);
    expect(service.list('grok').entries).toHaveLength(1);
    expect(service.list('codex').entries).toHaveLength(0);
    expect(service.list('opencode').entries).toHaveLength(0);
  });

  it('ignores non-sentinel lines (ordinary runtime log output) without error', () => {
    const service = new BackendExecutionLogService();
    service.ingest('plain runtime log line\nanother line\n');
    for (const product of KNOWN_BACKEND_PRODUCTS) expect(service.list(product).entries).toHaveLength(0);
  });

  it('ignores malformed JSON after the sentinel instead of throwing', () => {
    const service = new BackendExecutionLogService();
    expect(() => service.ingest(`${EXEC_LOG_SENTINEL} {not-json\n`)).not.toThrow();
  });

  it('ignores an event with an unknown/unrecognized backendProduct', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'some-future-backend', message: 'x' }));
    for (const product of KNOWN_BACKEND_PRODUCTS) expect(service.list(product).entries).toHaveLength(0);
  });

  it('a noisy claude-code stream never evicts recent grok history (per-backend isolation)', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'grok', phase: 'START', message: 'grok run start' }));
    for (let i = 0; i < 3000; i += 1) {
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: `noise ${i}` }));
    }
    const grokEntries = service.list('grok').entries;
    expect(grokEntries).toHaveLength(1);
    expect(grokEntries[0].message).toBe('grok run start');
    expect(service.list('claude-code').entries.length).toBeLessThanOrEqual(2000);
  });

  it('derives a running badge on START and a failed badge on a FAILED TERMINAL', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', projectId: 'dsh-p6-test-b', taskId: 'task-36', runId: 'pmreq-x', cwd: 'E:/repo-b', message: 'START' }));
    expect(service.status('claude-code')?.badge).toBe('running');
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'TERMINAL', status: 'FAILED', message: 'TERMINAL FAILED' }));
    const status = service.status('claude-code');
    expect(status?.badge).toBe('failed');
    expect(status?.projectId).toBe('dsh-p6-test-b');
    expect(status?.taskId).toBe('task-36');
    expect(status?.cwd).toBe('E:/repo-b');
  });

  it('derives a completed badge on a COMPLETED TERMINAL', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'opencode', phase: 'START', message: 'START' }));
    service.ingest(sentinelLine({ backendProduct: 'opencode', phase: 'TERMINAL', status: 'COMPLETED', message: 'TERMINAL COMPLETED' }));
    expect(service.status('opencode')?.badge).toBe('completed');
  });

  it('every backend starts idle before any event arrives', () => {
    const service = new BackendExecutionLogService();
    for (const product of KNOWN_BACKEND_PRODUCTS) expect(service.status(product)?.badge).toBe('idle');
  });

  it('strips a leading [ERROR] prefix (the same convention RuntimeLogBuffer uses for stderr) and still scans it, without polluting the stdout carry', () => {
    const service = new BackendExecutionLogService();
    service.ingest(`[ERROR] ${EXEC_LOG_SENTINEL} ${JSON.stringify({ backendProduct: 'codex', message: 'x' })}\n`);
    expect(service.list('codex').entries).toHaveLength(1);
  });

  it('re-sanitizes secret-shaped text at the Desktop boundary (defense-in-depth) even if it somehow arrived unredacted', () => {
    const service = new BackendExecutionLogService();
    const secret = 'sk-live-1234567890abcdefghijklmnop';
    service.ingest(sentinelLine({ backendProduct: 'claude-code', message: `Authorization: Bearer ${secret}` }));
    const message = service.list('claude-code').entries[0].message;
    expect(message.includes(secret)).toBe(false);
  });

  it('a PostgreSQL DSN credential canary never reaches the buffer', () => {
    const service = new BackendExecutionLogService();
    const secret = 'p6-canary-db-credential';
    service.ingest(sentinelLine({ backendProduct: 'grok', message: `connecting postgresql://postgres:${secret}@127.0.0.1:5432/dsh` }));
    const message = service.list('grok').entries[0].message;
    expect(message.includes(secret)).toBe(false);
  });

  // R31-7: sanitization must run on the whole reassembled message BEFORE
  // it is split into logical display lines, so a secret cannot dodge the
  // pattern by straddling a line-split boundary that only exists after
  // the split.
  it('a secret split across what becomes two logical lines is still fully redacted on both sides', () => {
    const service = new BackendExecutionLogService();
    const secret = 'p6-canary-multiline-secret-abc123';
    // The secret's key=value pair spans exactly where a newline sits —
    // sanitizing pre-split still sees the whole "token=<secret>" run as
    // one contiguous string.
    const message = `connecting with token=${secret}\nrequest completed`;
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'STDERR', message }));
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].message.includes(secret)).toBe(false);
    expect(entries[1].message.includes(secret)).toBe(false);
    expect(entries[1].message).toBe('request completed');
  });

  it('clear() resets every backend buffer and run state', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'x' }));
    service.clear();
    expect(service.list('claude-code').entries).toHaveLength(0);
    expect(service.status('claude-code')?.badge).toBe('idle');
  });

  // R311-2: a restart (which reaches clear() via RuntimeSupervisor's
  // 'sessionStarting' seam, see runtimeSupervisor.ts/main.ts) must
  // produce a genuinely fresh session across every backend, not just the
  // one that happened to be active.
  describe('R311-2: restart produces a fresh session across all backends', () => {
    it('session-1 content is gone and only session-2 content remains after clear(), for every backend that had activity', () => {
      const service = new BackendExecutionLogService();

      // SESSION 1
      service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'SESSION_ONE claude line' }));
      service.ingest(sentinelLine({ backendProduct: 'opencode', phase: 'START', message: 'SESSION_ONE opencode line' }));
      expect(service.list('claude-code', { afterSeq: 0 }).entries.map((e) => e.message)).toContain('SESSION_ONE claude line');
      expect(service.list('opencode', { afterSeq: 0 }).entries.map((e) => e.message)).toContain('SESSION_ONE opencode line');
      expect(service.status('claude-code')?.badge).toBe('running');

      // Restart lifecycle boundary.
      service.clear();

      // SESSION 2
      service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'SESSION_TWO claude line' }));

      const claudeAfterRestart = service.list('claude-code', { afterSeq: 0 }).entries.map((e) => e.message);
      expect(claudeAfterRestart).toContain('SESSION_TWO claude line');
      expect(claudeAfterRestart).not.toContain('SESSION_ONE claude line');

      // OpenCode had no session-2 activity yet — its session-1 content
      // must still be gone, not merely un-updated.
      expect(service.list('opencode', { afterSeq: 0 }).entries).toHaveLength(0);
      expect(service.status('opencode')?.badge).toBe('idle');
    });

    it('a stale renderer cursor from session 1 still returns session 2 data — never silently empty', () => {
      const service = new BackendExecutionLogService();
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: 'SESSION_ONE line 1' }));
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: 'SESSION_ONE line 2' }));
      const staleCursor = service.list('claude-code').latestSeq;
      expect(staleCursor).toBe(2);

      service.clear();
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: 'SESSION_TWO line 1' }));

      const tail = service.list('claude-code', { afterSeq: staleCursor });
      expect(tail.entries.map((e) => e.message)).toEqual(['SESSION_TWO line 1']);
      expect(tail.entries[0].seq).toBeGreaterThan(staleCursor);
    });

    it('the stdout carry buffer is reset on clear() — a fragment left over from the previous runtime process can never be completed by the next one', () => {
      const service = new BackendExecutionLogService();
      const event = { backendProduct: 'claude-code', phase: 'START', message: 'should never appear' };
      const fullLine = `${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}\n`;
      service.ingest(fullLine.slice(0, Math.floor(fullLine.length / 2))); // leaves a genuine partial record in the carry

      service.clear(); // simulates the runtime process being replaced mid-line

      // The old process's second half must never complete the new
      // process's (unrelated, coincidentally-matching) stream state.
      service.ingest(fullLine.slice(Math.floor(fullLine.length / 2)));
      expect(service.list('claude-code').entries).toHaveLength(0);

      // The service must still be able to parse a fresh, well-framed
      // event afterward — clear() must not wedge it.
      const secondLine = `${EXEC_LOG_SENTINEL} ${JSON.stringify({ backendProduct: 'claude-code', phase: 'START', message: 'fresh session event' })}\n`;
      service.ingest(secondLine);
      const entries = service.list('claude-code').entries;
      expect(entries[entries.length - 1].message).toBe('fresh session event');
    });
  });

  // R31-4: dynamic, registry-backed product inventory.
  describe('dynamic backend product inventory', () => {
    it('setAllowedProducts() adds coverage for a new product without dropping an already-registered one', () => {
      const service = new BackendExecutionLogService();
      service.ingest(sentinelLine({ backendProduct: 'fifth-backend', message: 'x' }));
      expect(service.list('fifth-backend').entries).toHaveLength(0); // not yet known

      service.setAllowedProducts(['fifth-backend']);
      service.ingest(sentinelLine({ backendProduct: 'fifth-backend', message: 'now known' }));
      expect(service.list('fifth-backend').entries).toHaveLength(1);

      // the original four are untouched
      service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'still works' }));
      expect(service.list('claude-code').entries).toHaveLength(1);
    });

    it('re-registering an already-known product does not reset its buffer', () => {
      const service = new BackendExecutionLogService();
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: 'before' }));
      service.setAllowedProducts(['claude-code', 'opencode', 'codex', 'grok']);
      expect(service.list('claude-code').entries.map((e) => e.message)).toEqual(['before']);
    });

    it('an unregistered product string can never allocate a buffer via ingest() alone (never renderer/IPC-authoritative)', () => {
      const service = new BackendExecutionLogService();
      service.ingest(sentinelLine({ backendProduct: 'anything-an-attacker-sends', message: 'x' }));
      service.ingest(sentinelLine({ backendProduct: '__proto__', message: 'x' }));
      expect(service.list('anything-an-attacker-sends').entries).toHaveLength(0);
      expect(service.status('anything-an-attacker-sends')).toBeNull();
    });

    it('constructor accepts an explicit initial product list (used with the real registry catalogue)', () => {
      const service = new BackendExecutionLogService(2000, ['only-one-product']);
      service.ingest(sentinelLine({ backendProduct: 'only-one-product', message: 'x' }));
      service.ingest(sentinelLine({ backendProduct: 'claude-code', message: 'x' }));
      expect(service.list('only-one-product').entries).toHaveLength(1);
      expect(service.list('claude-code').entries).toHaveLength(0);
    });
  });
});

describe('sanitizeExecutionLogTextDesktop', () => {
  it('redacts a bearer token', () => {
    const out = sanitizeExecutionLogTextDesktop('Authorization: Bearer abc.def-123_456');
    expect(out).not.toContain('abc.def-123_456');
  });

  it('redacts a Telegram-bot-token-shaped value', () => {
    const secret = '123456789:ABCDEFghijklmnopqrstuvwxyz0123456789';
    const out = sanitizeExecutionLogTextDesktop(`token ${secret}`);
    expect(out).not.toContain(secret);
  });

  it('leaves an ordinary cwd path untouched', () => {
    const line = 'CWD: E:/dev/dsh-p6-test-b';
    expect(sanitizeExecutionLogTextDesktop(line)).toBe(line);
  });
});

// R31-2: one observer event's message may be multiple human-readable
// lines; the owner's "2000 lines" requirement means logical display
// lines, not events.
describe('splitLogicalLines', () => {
  it('a single-line message stays one line', () => {
    expect(splitLogicalLines('PROCESS_EXIT code=0')).toEqual(['PROCESS_EXIT code=0']);
  });

  it('splits LF-joined lines, dropping only the trailing-newline split artifact', () => {
    expect(splitLogicalLines('warning A\nwarning B\nwarning C\n')).toEqual(['warning A', 'warning B', 'warning C']);
  });

  it('splits without a trailing newline the same way, keeping all real lines', () => {
    expect(splitLogicalLines('warning A\nwarning B\nwarning C')).toEqual(['warning A', 'warning B', 'warning C']);
  });

  it('preserves a genuine blank line in the middle of the message', () => {
    expect(splitLogicalLines('first\n\nthird')).toEqual(['first', '', 'third']);
  });

  it('handles CRLF the same as LF', () => {
    expect(splitLogicalLines('a\r\nb\r\nc\r\n')).toEqual(['a', 'b', 'c']);
  });

  it('an empty message produces exactly one empty logical line, not zero', () => {
    expect(splitLogicalLines('')).toEqual(['']);
  });
});

describe('BackendExecutionLogService — R31-2 logical-line normalization', () => {
  it('one STDERR event with 3 embedded newlines becomes 3 ring-buffer entries, each tagged STDERR', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'STDERR', eventKind: 'STDERR', stream: 'stderr', message: 'warning A\nwarning B\nwarning C' }));
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.message)).toEqual(['warning A', 'warning B', 'warning C']);
    for (const entry of entries) expect(entry.phase).toBe('STDERR');
  });

  it('every logical line from one event carries the same identity metadata', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({
      backendProduct: 'claude-code', phase: 'STDERR', eventKind: 'STDERR', stream: 'stderr',
      projectId: 'dsh-p6-test-b', profileId: 'live1-claude-pm', runId: 'pmreq-x', cwd: 'E:/repo-b', model: null,
      message: 'line 1\nline 2',
    }));
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.projectId).toBe('dsh-p6-test-b');
      expect(entry.profileId).toBe('live1-claude-pm');
      expect(entry.runId).toBe('pmreq-x');
      expect(entry.cwd).toBe('E:/repo-b');
    }
    // each is independently identifiable, not a malformed merge.
    expect(entries[0].seq).not.toBe(entries[1].seq);
  });

  it('a single-line START/PARSER/TERMINAL event still produces exactly one logical line', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'claude-code', phase: 'START', message: 'START claude-code project=dsh-p6-test-b' }));
    expect(service.list('claude-code').entries).toHaveLength(1);
  });

  it('a 3000-logical-line stderr burst (one event, many embedded newlines) retains only the newest 2000', () => {
    const service = new BackendExecutionLogService();
    const bigMessage = Array.from({ length: 3000 }, (_, i) => `stderr line ${i}`).join('\n');
    service.ingest(sentinelLine({ backendProduct: 'codex', phase: 'STDERR', message: bigMessage }));
    const result = service.list('codex');
    expect(result.entries.length).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
    expect(result.entries[result.entries.length - 1].message).toBe('stderr line 2999');
    expect(result.entries[0].message).toBe('stderr line 1000');
  });
});

// R31-1: stream framing — a single BackendExecutionObserver console.log()
// call is one NDJSON line, but Node's stdout 'data' event delivers
// arbitrary byte chunks with no guaranteed 1:1 relationship to that.
describe('BackendExecutionLogService — R31-1 NDJSON stream framing', () => {
  const event = { backendProduct: 'claude-code', phase: 'START', message: 'START claude-code' };
  const fullLine = `${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}\n`;

  it('1. one full event in one chunk parses exactly once', () => {
    const service = new BackendExecutionLogService();
    service.ingest(fullLine);
    expect(service.list('claude-code').entries).toHaveLength(1);
  });

  it('2. a sentinel split across two chunks still parses exactly once', () => {
    const service = new BackendExecutionLogService();
    const splitPoint = EXEC_LOG_SENTINEL.indexOf('BACK') + 4; // "##DSH_BACK" | "END_EXEC## {...}"
    service.ingest(fullLine.slice(0, splitPoint));
    service.ingest(fullLine.slice(splitPoint));
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('START claude-code');
  });

  it('3. the JSON body split at an arbitrary point still parses exactly once', () => {
    const service = new BackendExecutionLogService();
    const splitPoint = fullLine.indexOf('"backendProduct"') + 5;
    service.ingest(fullLine.slice(0, splitPoint));
    service.ingest(fullLine.slice(splitPoint));
    expect(service.list('claude-code').entries).toHaveLength(1);
  });

  it('4. every character supplied as an individual ingest() chunk still parses exactly once', () => {
    const service = new BackendExecutionLogService();
    for (const ch of fullLine) service.ingest(ch);
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('START claude-code');
  });

  it('5. two complete events in one chunk both parse', () => {
    const service = new BackendExecutionLogService();
    const secondEvent = { backendProduct: 'grok', phase: 'START', message: 'START grok' };
    service.ingest(fullLine + `${EXEC_LOG_SENTINEL} ${JSON.stringify(secondEvent)}\n`);
    expect(service.list('claude-code').entries).toHaveLength(1);
    expect(service.list('grok').entries).toHaveLength(1);
  });

  it('6. event 1 complete + event 2 partial in one chunk: event 1 parses immediately, event 2 completes on the next chunk', () => {
    const service = new BackendExecutionLogService();
    const secondEvent = { backendProduct: 'opencode', phase: 'START', message: 'START opencode' };
    const secondLine = `${EXEC_LOG_SENTINEL} ${JSON.stringify(secondEvent)}\n`;
    const secondSplit = Math.floor(secondLine.length / 2);

    service.ingest(fullLine + secondLine.slice(0, secondSplit));
    expect(service.list('claude-code').entries).toHaveLength(1);
    expect(service.list('opencode').entries).toHaveLength(0); // still incomplete — must not be dropped or mis-parsed

    service.ingest(secondLine.slice(secondSplit));
    expect(service.list('opencode').entries).toHaveLength(1);
    expect(service.list('opencode').entries[0].message).toBe('START opencode');
  });

  it('7. CRLF-terminated events parse correctly', () => {
    const service = new BackendExecutionLogService();
    const crlfLine = `${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}\r\n`;
    service.ingest(crlfLine);
    expect(service.list('claude-code').entries).toHaveLength(1);
  });

  it('8. a malformed complete line is dropped and the following valid line still parses', () => {
    const service = new BackendExecutionLogService();
    service.ingest(`${EXEC_LOG_SENTINEL} {this is not valid json}\n` + fullLine);
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('START claude-code');
  });

  it('9. an oversized unterminated carry is bounded and reset, and the service survives', () => {
    const service = new BackendExecutionLogService();
    // Never send a newline — the carry buffer would otherwise grow
    // without bound.
    service.ingest(`${EXEC_LOG_SENTINEL} {"backendProduct":"claude-code",`);
    service.ingest('x'.repeat(300_000)); // pushes the carry well past its cap without ever completing a line
    expect(() => service.ingest('more text without a newline\n')).not.toThrow();

    // The service must still be able to parse a fresh, well-framed event
    // afterward — the reset must not have wedged it. Sent as its own
    // chunk (not concatenated onto the still-open fragment above), the
    // same way a real subsequent stdout write would arrive.
    service.ingest(fullLine);
    const entries = service.list('claude-code').entries;
    expect(entries[entries.length - 1].message).toBe('START claude-code');
  });

  it('10. fragmented reconstruction never produces a duplicate event', () => {
    const service = new BackendExecutionLogService();
    const chunks = [fullLine.slice(0, 10), fullLine.slice(10, 25), fullLine.slice(25)];
    for (const chunk of chunks) service.ingest(chunk);
    expect(service.list('claude-code').entries).toHaveLength(1);
  });

  it('an interleaved runtime-stderr chunk between two halves of one stdout line does not corrupt the stdout-side partial record', () => {
    const service = new BackendExecutionLogService();
    const splitPoint = Math.floor(fullLine.length / 2);
    service.ingest(fullLine.slice(0, splitPoint)); // first half of the stdout line, no newline yet
    service.ingest('[ERROR] an unrelated runtime stderr warning, arrived out of band\n'); // interleaved stderr chunk
    service.ingest(fullLine.slice(splitPoint)); // second half completes the original stdout line
    const entries = service.list('claude-code').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('START claude-code');
  });

  // R311-5: the cap must protect only the remaining *unterminated tail*
  // after draining, never the total size of a perfectly frameable input
  // chunk. A single stdout `data` event can legitimately be very large
  // and still contain nothing but complete, valid records (e.g. a burst
  // flushed after a GUI disconnect).
  describe('R311-5: complete records are drained before the carry cap is enforced', () => {
    it('a single chunk far larger than MAX_CARRY_CHARS, containing thousands of complete valid records, is fully drained — no wholesale reset', () => {
      const service = new BackendExecutionLogService();
      const RECORD_COUNT = 3000; // well past the 200,000-char cap once joined
      let bigChunk = '';
      for (let i = 0; i < RECORD_COUNT; i += 1) {
        bigChunk += `${EXEC_LOG_SENTINEL} ${JSON.stringify({ backendProduct: 'claude-code', message: `record ${i}` })}\n`;
      }
      expect(bigChunk.length).toBeGreaterThan(200_000);

      service.ingest(bigChunk);

      const result = service.list('claude-code', { limit: 2000 });
      // All complete records were parsed and pushed — the ring buffer's
      // own 2000-line cap (not the carry cap) is what ultimately bounds
      // how many are retained, and it retains the newest.
      expect(result.entries).toHaveLength(2000);
      expect(result.entries[result.entries.length - 1].message).toBe(`record ${RECORD_COUNT - 1}`);
      expect(result.truncated).toBe(true); // by the 2000-line ring cap, not a carry-cap discard
    });

    it('a complete valid event immediately before an oversized unterminated tail is retained; only the tail is reset', () => {
      const service = new BackendExecutionLogService();
      const validEvent = `${EXEC_LOG_SENTINEL} ${JSON.stringify({ backendProduct: 'claude-code', message: 'kept before oversized tail' })}\n`;
      const oversizedUnterminatedTail = `${EXEC_LOG_SENTINEL} {"backendProduct":"claude-code","message":"${'x'.repeat(250_000)}`; // no trailing newline

      service.ingest(validEvent + oversizedUnterminatedTail);

      const entries = service.list('claude-code').entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('kept before oversized tail');

      // The service must still parse a fresh event afterward — the tail
      // reset must not have wedged it.
      const nextEvent = `${EXEC_LOG_SENTINEL} ${JSON.stringify({ backendProduct: 'claude-code', message: 'next event after reset' })}\n`;
      service.ingest(nextEvent);
      const afterReset = service.list('claude-code').entries;
      expect(afterReset[afterReset.length - 1].message).toBe('next event after reset');
    });
  });
});
