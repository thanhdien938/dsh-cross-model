import { describe, it, expect } from 'vitest';
import { BackendExecutionRingBuffer } from '../electron/main/services/backendExecutionRingBuffer';

function evt(message: string, overrides: Record<string, unknown> = {}) {
  return { backendProduct: 'claude-code', message, ...overrides };
}

describe('BackendExecutionRingBuffer', () => {
  it('assigns a monotonic seq and returns entries in push order', () => {
    const buffer = new BackendExecutionRingBuffer();
    buffer.push(evt('one'));
    buffer.push(evt('two'));
    const { entries } = buffer.list();
    expect(entries.map((e) => e.message)).toEqual(['one', 'two']);
    expect(entries[1].seq).toBe(entries[0].seq + 1);
  });

  it('caps at max 2000 lines and drops the oldest on the 2001st push', () => {
    const buffer = new BackendExecutionRingBuffer(2000);
    for (let i = 0; i < 2000; i += 1) buffer.push(evt(`line ${i}`));
    expect(buffer.size).toBe(2000);
    const before = buffer.list();
    expect(before.truncated).toBe(false);
    expect(before.entries[0].message).toBe('line 0');

    buffer.push(evt('line 2000'));
    const after = buffer.list();
    expect(buffer.size).toBe(2000);
    expect(after.truncated).toBe(true);
    // oldest ("line 0") was dropped; newest is retained.
    expect(after.entries[0].message).toBe('line 1');
    expect(after.entries[after.entries.length - 1].message).toBe('line 2000');
  });

  it('bounds an individual oversized line instead of consuming unlimited memory', () => {
    const buffer = new BackendExecutionRingBuffer();
    buffer.push(evt('x'.repeat(50_000)));
    const { entries } = buffer.list();
    expect(entries[0].message.length).toBeLessThanOrEqual(4100);
    expect(entries[0].message.endsWith('…[truncated]')).toBe(true);
  });

  it('enforces a byte ceiling as defense-in-depth even under the 2000-line cap', () => {
    const buffer = new BackendExecutionRingBuffer(2000, 50_000); // tiny byte ceiling
    for (let i = 0; i < 2000; i += 1) buffer.push(evt('y'.repeat(200)));
    expect(buffer.size).toBeLessThan(2000);
    expect(buffer.list().truncated).toBe(true);
  });

  it('list(afterSeq) returns only newer entries — an incremental tail, not a full re-send', () => {
    const buffer = new BackendExecutionRingBuffer();
    for (let i = 0; i < 5; i += 1) buffer.push(evt(`line ${i}`));
    const first = buffer.list();
    const cursor = first.latestSeq;
    buffer.push(evt('line 5'));
    buffer.push(evt('line 6'));
    const tail = buffer.list({ afterSeq: cursor });
    expect(tail.entries.map((e) => e.message)).toEqual(['line 5', 'line 6']);
  });

  it('list(limit) bounds the returned window and clear() empties the buffer', () => {
    const buffer = new BackendExecutionRingBuffer();
    for (let i = 0; i < 10; i += 1) buffer.push(evt(`line ${i}`));
    expect(buffer.list({ limit: 3 }).entries).toHaveLength(3);
    buffer.clear();
    expect(buffer.list().entries).toHaveLength(0);
    expect(buffer.list().truncated).toBe(false);
  });

  it('a 10000-line steady stream still stays bounded at <= 2000 stored entries', () => {
    const buffer = new BackendExecutionRingBuffer(2000);
    for (let i = 0; i < 10_000; i += 1) buffer.push(evt(`line ${i}`));
    expect(buffer.size).toBeLessThanOrEqual(2000);
    const { entries } = buffer.list();
    expect(entries[entries.length - 1].message).toBe('line 9999');
  });

  // R31-3: the byte ceiling must react to real UTF-8 byte size, not
  // JavaScript's UTF-16-code-unit `string.length`.
  describe('byte accounting reacts to real UTF-8 size, not JS string.length', () => {
    it('an ASCII message: byte count equals character count', () => {
      const buffer = new BackendExecutionRingBuffer(2000, 100_000);
      // 100 ASCII chars == 100 UTF-8 bytes, so JS .length and real byte
      // size agree here — this is the baseline the Vietnamese case below
      // is compared against.
      for (let i = 0; i < 2000; i += 1) buffer.push(evt('a'.repeat(100)));
      expect(buffer.list().truncated).toBe(true);
      const asciiEntriesRetained = buffer.size;

      const buffer2 = new BackendExecutionRingBuffer(2000, 100_000);
      // Vietnamese text: each diacritic character is 2-3 UTF-8 bytes but
      // still 1 UTF-16 code unit, so JS .length undercounts real size.
      const vietnamese = 'Xin chào các bạn, đây là một dòng nhật ký thử nghiệm dài '.repeat(2).slice(0, 100);
      expect(vietnamese.length).toBe(100); // same JS length as the ASCII case above
      expect(Buffer.byteLength(vietnamese, 'utf8')).toBeGreaterThan(100); // but more real bytes
      for (let i = 0; i < 2000; i += 1) buffer2.push(evt(vietnamese));
      expect(buffer2.list().truncated).toBe(true);
      const vietnameseEntriesRetained = buffer2.size;

      // Same JS-length message, more real UTF-8 bytes -> the byte
      // ceiling bites sooner (fewer entries survive) for the Vietnamese
      // stream than for the same-length ASCII stream. A length-based
      // (not byte-based) ceiling would retain the same count for both.
      expect(vietnameseEntriesRetained).toBeLessThan(asciiEntriesRetained);
    });

    it('emoji/multibyte text trips the byte ceiling with far fewer entries than its JS length would suggest', () => {
      const emojiLine = '🔥'.repeat(50); // 50 JS UTF-16 code units (surrogate pairs) = 100 .length, but 200 UTF-8 bytes
      expect(emojiLine.length).toBe(100);
      expect(Buffer.byteLength(emojiLine, 'utf8')).toBe(200);

      const buffer = new BackendExecutionRingBuffer(5000, 50_000);
      let pushed = 0;
      for (let i = 0; i < 5000; i += 1) {
        buffer.push(evt(emojiLine));
        pushed += 1;
        if (buffer.list().truncated) break;
      }
      // (200 bytes + 256 overhead) per entry against a 50,000-byte
      // ceiling bites at roughly 109 entries — well under the 5000-entry
      // cap, proving the byte path (not the entry-count path) is what
      // truncated first.
      expect(buffer.size).toBeLessThan(200);
      expect(pushed).toBeLessThan(5000);
    });
  });

  // R31-9: a runtime restart clears buffer *content* but must never let a
  // stale renderer cursor silently hide the new session's events.
  describe('clear() preserves sequence monotonicity across a runtime restart', () => {
    it('seq does not restart at 1 after clear() — new entries always sort past any pre-clear cursor', () => {
      const buffer = new BackendExecutionRingBuffer();
      for (let i = 0; i < 10; i += 1) buffer.push(evt(`session1 line ${i}`));
      const preClearCursor = buffer.list().latestSeq;
      expect(preClearCursor).toBe(10);

      buffer.clear();
      expect(buffer.list().entries).toHaveLength(0);

      buffer.push(evt('session2 line 0'));
      const postClearEntry = buffer.list().entries[0];
      expect(postClearEntry.seq).toBeGreaterThan(preClearCursor);

      // The exact failure mode this guards: a renderer still polling with
      // its pre-restart cursor must see the new session's event, not an
      // empty result.
      const tail = buffer.list({ afterSeq: preClearCursor });
      expect(tail.entries.map((e) => e.message)).toEqual(['session2 line 0']);
    });
  });
});
