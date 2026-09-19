import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT_PREFS,
  LAYOUT_BOUNDS,
  LAYOUT_STORAGE_KEY,
  MIN_CENTER_TOP_PX,
  MIN_CENTER_WIDTH_PX,
  clampCenterBottomHeight,
  clampLeftWidth,
  clampRightWidth,
  clampToViewport,
  loadLayoutPrefs,
  nextCenterBottomHeight,
  nextLeftWidth,
  nextRightWidth,
  parseLayoutPrefs,
  saveLayoutPrefs,
  serializeLayoutPrefs,
} from '../src/lib/resizableLayout';

// P14-R0A/R0B: this project has no jsdom/rendering test infra (see
// composerPushCheckbox.test.ts) — resizableLayout.ts is deliberately
// framework-free so its width/height math and persistence shape are
// provable without a DOM. useResizableLayout.ts (the React wiring around
// this) is intentionally left untested for the same reason P12-R5A left
// its own hooks untested.

function fakeStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    _dump: () => ({ ...store }),
  };
}

describe('clampLeftWidth / clampRightWidth / clampCenterBottomHeight', () => {
  it('clamps below the minimum', () => {
    expect(clampLeftWidth(10)).toBe(LAYOUT_BOUNDS.left.min);
    expect(clampRightWidth(10)).toBe(LAYOUT_BOUNDS.right.min);
    expect(clampCenterBottomHeight(10)).toBe(LAYOUT_BOUNDS.centerBottom.min);
  });
  it('clamps above the maximum', () => {
    expect(clampLeftWidth(9999)).toBe(LAYOUT_BOUNDS.left.max);
    expect(clampRightWidth(9999)).toBe(LAYOUT_BOUNDS.right.max);
    expect(clampCenterBottomHeight(9999)).toBe(LAYOUT_BOUNDS.centerBottom.max);
  });
  it('passes values already in range through unchanged', () => {
    expect(clampLeftWidth(350)).toBe(350);
    expect(clampRightWidth(400)).toBe(400);
    expect(clampCenterBottomHeight(300)).toBe(300);
  });
});

describe('nextLeftWidth / nextRightWidth / nextCenterBottomHeight (drag math)', () => {
  it('left pane grows as the pointer moves right (+delta)', () => {
    expect(nextLeftWidth(300, 50)).toBe(350);
  });
  it('left pane shrinks as the pointer moves left (-delta)', () => {
    expect(nextLeftWidth(300, -50)).toBe(250);
  });
  it('right pane grows as the pointer moves left (-delta), since it is pinned to the window edge', () => {
    expect(nextRightWidth(360, -50)).toBe(410);
  });
  it('right pane shrinks as the pointer moves right (+delta)', () => {
    expect(nextRightWidth(360, 50)).toBe(310);
  });
  it('a drag past the bound clamps rather than overshoots', () => {
    expect(nextLeftWidth(LAYOUT_BOUNDS.left.max, 1000)).toBe(LAYOUT_BOUNDS.left.max);
    expect(nextRightWidth(LAYOUT_BOUNDS.right.min, 1000)).toBe(LAYOUT_BOUNDS.right.min);
  });
  it('center-bottom pane grows as the pointer moves up (-deltaY), pinned to the bottom edge', () => {
    expect(nextCenterBottomHeight(240, -60)).toBe(300);
  });
  it('center-bottom pane shrinks as the pointer moves down (+deltaY)', () => {
    expect(nextCenterBottomHeight(240, 60)).toBe(180);
  });
  it('a center-bottom drag past its bound clamps rather than overshoots', () => {
    expect(nextCenterBottomHeight(LAYOUT_BOUNDS.centerBottom.max, -1000)).toBe(LAYOUT_BOUNDS.centerBottom.max);
    expect(nextCenterBottomHeight(LAYOUT_BOUNDS.centerBottom.min, 1000)).toBe(LAYOUT_BOUNDS.centerBottom.min);
  });
});

describe('parseLayoutPrefs', () => {
  it('returns the documented defaults for null/undefined/empty input', () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(parseLayoutPrefs(undefined)).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(parseLayoutPrefs('')).toEqual(DEFAULT_LAYOUT_PREFS);
  });
  it('returns the defaults for unparseable JSON rather than throwing', () => {
    expect(parseLayoutPrefs('{not json')).toEqual(DEFAULT_LAYOUT_PREFS);
  });
  it('returns the defaults for a JSON value that is not an object', () => {
    expect(parseLayoutPrefs('42')).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(parseLayoutPrefs('null')).toEqual(DEFAULT_LAYOUT_PREFS);
  });
  it('round-trips a valid, in-range value for all three fields', () => {
    expect(parseLayoutPrefs(JSON.stringify({ leftWidth: 320, rightWidth: 400, centerBottomHeight: 280 }))).toEqual({
      leftWidth: 320,
      rightWidth: 400,
      centerBottomHeight: 280,
    });
  });
  it('clamps an out-of-range stored value instead of trusting it verbatim', () => {
    expect(parseLayoutPrefs(JSON.stringify({ leftWidth: 5, rightWidth: 99999, centerBottomHeight: 1 }))).toEqual({
      leftWidth: LAYOUT_BOUNDS.left.min,
      rightWidth: LAYOUT_BOUNDS.right.max,
      centerBottomHeight: LAYOUT_BOUNDS.centerBottom.min,
    });
  });
  it('falls back per-field to the default for a non-numeric stored value, not the minimum', () => {
    expect(parseLayoutPrefs(JSON.stringify({ leftWidth: 'wide please', rightWidth: 400, centerBottomHeight: 280 }))).toEqual({
      leftWidth: LAYOUT_BOUNDS.left.default,
      rightWidth: 400,
      centerBottomHeight: 280,
    });
  });
  it('falls back centerBottomHeight to its own default when missing entirely (e.g. old v1-shaped JSON)', () => {
    expect(parseLayoutPrefs(JSON.stringify({ leftWidth: 320, rightWidth: 400 }))).toEqual({
      leftWidth: 320,
      rightWidth: 400,
      centerBottomHeight: LAYOUT_BOUNDS.centerBottom.default,
    });
  });
});

describe('serializeLayoutPrefs', () => {
  it('clamps on the way out too, so a caller can never persist an invalid size', () => {
    expect(JSON.parse(serializeLayoutPrefs({ leftWidth: -5, rightWidth: 1e6, centerBottomHeight: -5 }))).toEqual({
      leftWidth: LAYOUT_BOUNDS.left.min,
      rightWidth: LAYOUT_BOUNDS.right.max,
      centerBottomHeight: LAYOUT_BOUNDS.centerBottom.min,
    });
  });
});

describe('loadLayoutPrefs / saveLayoutPrefs (persistence)', () => {
  it('loads the defaults when nothing has been stored yet', () => {
    expect(loadLayoutPrefs(fakeStorage())).toEqual(DEFAULT_LAYOUT_PREFS);
  });
  it('saves under the documented (v2) storage key and loads it back unchanged', () => {
    const storage = fakeStorage();
    saveLayoutPrefs({ leftWidth: 340, rightWidth: 420, centerBottomHeight: 260 }, storage);
    expect(storage._dump()[LAYOUT_STORAGE_KEY]).toBeDefined();
    expect(LAYOUT_STORAGE_KEY).toBe('dsh-desktop-layout-v2');
    expect(loadLayoutPrefs(storage)).toEqual({ leftWidth: 340, rightWidth: 420, centerBottomHeight: 260 });
  });
  it('a storage that throws on read never propagates — falls back to defaults', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    };
    expect(loadLayoutPrefs(throwing)).toEqual(DEFAULT_LAYOUT_PREFS);
  });
  it('a storage that throws on write never propagates — save is a no-op, not a crash', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => saveLayoutPrefs(DEFAULT_LAYOUT_PREFS, throwing)).not.toThrow();
  });
});

describe('clampToViewport (P14-R0B: window-resize clamping)', () => {
  it('leaves an already-valid layout untouched on a roomy viewport', () => {
    expect(clampToViewport(DEFAULT_LAYOUT_PREFS, 1600, 900)).toEqual(DEFAULT_LAYOUT_PREFS);
  });

  it('shrinks left+right proportionally when they would leave less than the center minimum, never below either side’s own floor', () => {
    // 220 (left min) + 620 (right max) = 840; a 900px-wide window leaves
    // only 580px for both sides after MIN_CENTER_WIDTH_PX (320) -- both
    // must shrink, right (the larger requester) shrinking further, but
    // neither below its documented minimum.
    const wide = { leftWidth: 480, rightWidth: 620, centerBottomHeight: 240 };
    const result = clampToViewport(wide, 900, 900);
    expect(result.leftWidth + result.rightWidth).toBeLessThanOrEqual(900 - MIN_CENTER_WIDTH_PX);
    expect(result.leftWidth).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.left.min);
    expect(result.rightWidth).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.right.min);
  });

  it('falls back both sides to their documented minimum on an extremely narrow viewport, never negative', () => {
    const result = clampToViewport(DEFAULT_LAYOUT_PREFS, 400, 900);
    expect(result.leftWidth).toBe(LAYOUT_BOUNDS.left.min);
    expect(result.rightWidth).toBe(LAYOUT_BOUNDS.right.min);
    expect(result.leftWidth).toBeGreaterThan(0);
    expect(result.rightWidth).toBeGreaterThan(0);
  });

  it('takes the explicit no-room-at-all fallback (viewport narrower than the center minimum itself), still both sides at their floor, never invisible', () => {
    const result = clampToViewport(DEFAULT_LAYOUT_PREFS, 200, 900);
    expect(result.leftWidth).toBe(LAYOUT_BOUNDS.left.min);
    expect(result.rightWidth).toBe(LAYOUT_BOUNDS.right.min);
  });

  it('caps centerBottomHeight so the Composer/history area above it always keeps MIN_CENTER_TOP_PX, on a short viewport', () => {
    const result = clampToViewport({ leftWidth: 300, rightWidth: 360, centerBottomHeight: LAYOUT_BOUNDS.centerBottom.max }, 1600, 500);
    expect(result.centerBottomHeight).toBeLessThanOrEqual(500 - MIN_CENTER_TOP_PX);
    expect(result.centerBottomHeight).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.centerBottom.min);
  });

  it('never produces a centerBottomHeight below its documented minimum even on a very short viewport', () => {
    const result = clampToViewport(DEFAULT_LAYOUT_PREFS, 1600, 250);
    expect(result.centerBottomHeight).toBe(LAYOUT_BOUNDS.centerBottom.min);
  });

  it('ignores a non-finite or non-positive viewport dimension for that axis instead of collapsing it', () => {
    expect(clampToViewport(DEFAULT_LAYOUT_PREFS, NaN, NaN)).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(clampToViewport(DEFAULT_LAYOUT_PREFS, 0, 0)).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(clampToViewport(DEFAULT_LAYOUT_PREFS, -100, -100)).toEqual(DEFAULT_LAYOUT_PREFS);
  });

  it('still clamps each field to its own documented bounds first, regardless of viewport', () => {
    const result = clampToViewport({ leftWidth: 9999, rightWidth: -50, centerBottomHeight: 9999 }, 1600, 900);
    expect(result.leftWidth).toBeLessThanOrEqual(LAYOUT_BOUNDS.left.max);
    expect(result.rightWidth).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.right.min);
    expect(result.centerBottomHeight).toBeLessThanOrEqual(LAYOUT_BOUNDS.centerBottom.max);
  });
});
