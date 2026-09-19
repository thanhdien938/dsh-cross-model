import { describe, it, expect } from 'vitest';
import { RuntimeLogBuffer } from '../electron/main/services/runtimeLogBuffer';

describe('RuntimeLogBuffer', () => {
  it('splits multi-line chunks into individual entries and tags ERROR-prefixed lines', () => {
    const buffer = new RuntimeLogBuffer();
    buffer.push('line one\nline two\n');
    buffer.push('[ERROR] something broke\n');
    const entries = buffer.list();
    expect(entries.map((e) => e.line)).toEqual(['line one', 'line two', 'something broke']);
    expect(entries[2].level).toBe('ERROR');
    expect(entries[0].level).toBe('INFO');
  });

  it('bounds the buffer instead of growing unboundedly', () => {
    const buffer = new RuntimeLogBuffer(50);
    for (let i = 0; i < 500; i += 1) buffer.push(`line ${i}`);
    expect(buffer.list(1000)).toHaveLength(50);
    // Keeps the most recent lines, not the oldest.
    expect(buffer.list(1)[0].line).toBe('line 499');
  });

  it('bounds an individual line length', () => {
    const buffer = new RuntimeLogBuffer();
    buffer.push('x'.repeat(10000));
    expect(buffer.list()[0].line.length).toBeLessThanOrEqual(4000);
  });

  it('list() respects the requested limit and clear() empties the buffer', () => {
    const buffer = new RuntimeLogBuffer();
    for (let i = 0; i < 10; i += 1) buffer.push(`line ${i}`);
    expect(buffer.list(3)).toHaveLength(3);
    buffer.clear();
    expect(buffer.list()).toHaveLength(0);
  });

  it('ignores blank lines', () => {
    const buffer = new RuntimeLogBuffer();
    buffer.push('\n\n  \nreal line\n');
    expect(buffer.list().map((e) => e.line)).toEqual(['real line']);
  });
});
