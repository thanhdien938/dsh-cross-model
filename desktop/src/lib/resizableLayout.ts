// P14-R0A/R0B: pure layout math for the Desktop shell's resizable Projects
// / center / Connection Center columns, and (R0B) the Composer / task-
// status-history split inside the center column itself. Deliberately
// framework-free (no React, no DOM) so it can be exercised directly under
// vitest's `node` environment (this project has no jsdom — see
// composerPushCheckbox.test.ts for the established precedent of testing a
// component's pure logic this way rather than rendering it).
//
// The React wiring (drag tracking, localStorage I/O, window-resize
// clamping) lives in useResizableLayout.ts, which is a thin,
// untested-by-design shell around these functions — exactly the split
// P12-R5A used for the same reason (no rendering test infra here).

export interface LayoutPrefs {
  leftWidth: number;
  rightWidth: number;
  // P14-R0B: height (px) of the task-status/history pane at the bottom of
  // the CENTER column only — never the whole app. See App.tsx's
  // `.center-top` / `.center-bottom` split.
  centerBottomHeight: number;
}

// Bounds are deliberately generous enough that the Projects list and
// Connection Center's labels/controls stay readable at the minimum, and
// the center content never gets crowded out at the maximum (center has no
// explicit max of its own — it is whatever space is left after left/right
// take their share, and CSS gives it a sane min-width separately).
export const LAYOUT_BOUNDS = {
  left: { min: 220, max: 480, default: 300 },
  right: { min: 260, max: 620, default: 360 },
  // P14-R0B: the lower middle-column pane (counter bar + task list). Small
  // by design — the owner's explicit complaint was this region dominating
  // the screen — but never so small the counter bar's own three stats
  // clip.
  centerBottom: { min: 140, max: 480, default: 240 },
} as const;

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  leftWidth: LAYOUT_BOUNDS.left.default,
  rightWidth: LAYOUT_BOUNDS.right.default,
  centerBottomHeight: LAYOUT_BOUNDS.centerBottom.default,
};

// P14-R0B: bumped from v1 (R0A) — the stored shape gained
// `centerBottomHeight`. Rather than silently reinterpret old v1 JSON
// (which never had that field) under the same key, this is a clean
// version cutover: v1 data is simply never read again and every viewer
// gets the new documented defaults once, the same way a first launch
// would. Deliberate, not an oversight — see the R0B doc's Persistence
// section.
export const LAYOUT_STORAGE_KEY = 'dsh-desktop-layout-v2';

// The center column never shrinks below this (matches App.css's
// `.center-content { min-width: 320px }`) — used by clampToViewport so a
// narrow window shrinks Projects/Connection Center first, never the
// primary workspace.
export const MIN_CENTER_WIDTH_PX = 320;
// However short the window gets, the Composer/history area above the
// horizontal handle keeps at least this much room — the task-status pane
// can shrink but never eats the whole center column.
export const MIN_CENTER_TOP_PX = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampLeftWidth(value: number): number {
  return clamp(value, LAYOUT_BOUNDS.left.min, LAYOUT_BOUNDS.left.max);
}

export function clampRightWidth(value: number): number {
  return clamp(value, LAYOUT_BOUNDS.right.min, LAYOUT_BOUNDS.right.max);
}

export function clampCenterBottomHeight(value: number): number {
  return clamp(value, LAYOUT_BOUNDS.centerBottom.min, LAYOUT_BOUNDS.centerBottom.max);
}

// The left sidebar's resize handle sits on its right edge: dragging the
// pointer right grows it. The right sidebar's handle sits on its left
// edge: dragging the pointer right *shrinks* it (the pane is measured from
// its own right edge, which is pinned to the window edge).
export function nextLeftWidth(startWidth: number, deltaX: number): number {
  return clampLeftWidth(startWidth + deltaX);
}

export function nextRightWidth(startWidth: number, deltaX: number): number {
  return clampRightWidth(startWidth - deltaX);
}

// The center row-handle sits above the task-status/history pane: dragging
// the pointer UP (negative deltaY) grows the pane below it (it is measured
// from its own bottom edge, pinned to the bottom of the center column) —
// same "measured from the pinned far edge" convention as the right
// sidebar above.
export function nextCenterBottomHeight(startHeight: number, deltaY: number): number {
  return clampCenterBottomHeight(startHeight - deltaY);
}

function safeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

// Never throws: corrupt, missing, or partially-shaped stored JSON falls
// back to the documented defaults rather than a squished min pane.
export function parseLayoutPrefs(raw: string | null | undefined): LayoutPrefs {
  if (!raw) return DEFAULT_LAYOUT_PREFS;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT_PREFS;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_LAYOUT_PREFS;
  return {
    leftWidth: safeNumber(parsed.leftWidth, LAYOUT_BOUNDS.left.default, LAYOUT_BOUNDS.left.min, LAYOUT_BOUNDS.left.max),
    rightWidth: safeNumber(parsed.rightWidth, LAYOUT_BOUNDS.right.default, LAYOUT_BOUNDS.right.min, LAYOUT_BOUNDS.right.max),
    centerBottomHeight: safeNumber(
      parsed.centerBottomHeight,
      LAYOUT_BOUNDS.centerBottom.default,
      LAYOUT_BOUNDS.centerBottom.min,
      LAYOUT_BOUNDS.centerBottom.max
    ),
  };
}

export function serializeLayoutPrefs(prefs: LayoutPrefs): string {
  return JSON.stringify({
    leftWidth: clampLeftWidth(prefs.leftWidth),
    rightWidth: clampRightWidth(prefs.rightWidth),
    centerBottomHeight: clampCenterBottomHeight(prefs.centerBottomHeight),
  });
}

// Minimal storage shape so callers can pass `window.localStorage` (or a
// mock in tests) without this module ever referencing `window` itself —
// this file has no DOM dependency at all.
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadLayoutPrefs(storage: PrefsStorage): LayoutPrefs {
  try {
    return parseLayoutPrefs(storage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    // Persistence is a nicety (per the brief: "nice to have, not
    // mandatory") — a storage failure (private mode, quota, disabled
    // site data) must never block the panel from rendering.
    return DEFAULT_LAYOUT_PREFS;
  }
}

export function saveLayoutPrefs(prefs: LayoutPrefs, storage: PrefsStorage): void {
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, serializeLayoutPrefs(prefs));
  } catch {
    // ignore — see loadLayoutPrefs
  }
}

// P14-R0B: re-clamp a layout against the CURRENT window size, called on
// every `resize` event (and once after load). Two independent concerns:
//
//  1. Width: if Projects + Connection Center would leave the center
//     column less than MIN_CENTER_WIDTH_PX, both sidebars are shrunk
//     proportionally (never below their own documented minimums) rather
//     than letting the center column collapse or overflow invisibly.
//  2. Height: the task-status/history pane is capped so the Composer/
//     history area above it always keeps at least MIN_CENTER_TOP_PX, no
//     matter how short the window gets.
//
// Non-finite or non-positive viewport dimensions (e.g. a test harness
// that never sets them) are treated as "unknown" and skipped for that
// axis — this function only ever narrows toward the already-clamped
// per-field bounds, never produces a wider/taller value than clamped
// input, and never divides by zero.
export function clampToViewport(prefs: LayoutPrefs, viewportWidth: number, viewportHeight: number): LayoutPrefs {
  let leftWidth = clampLeftWidth(prefs.leftWidth);
  let rightWidth = clampRightWidth(prefs.rightWidth);
  let centerBottomHeight = clampCenterBottomHeight(prefs.centerBottomHeight);

  if (Number.isFinite(viewportWidth) && viewportWidth > 0) {
    const availableForSides = viewportWidth - MIN_CENTER_WIDTH_PX;
    const combined = leftWidth + rightWidth;
    if (availableForSides > 0 && combined > availableForSides) {
      const scale = availableForSides / combined;
      leftWidth = Math.max(LAYOUT_BOUNDS.left.min, Math.floor(leftWidth * scale));
      rightWidth = Math.max(LAYOUT_BOUNDS.right.min, Math.floor(rightWidth * scale));
    } else if (availableForSides <= 0) {
      // Window narrower than the center column's own floor plus nothing
      // left for sidebars at all — fall back to each sidebar's documented
      // minimum. Still never negative/invisible, just as small as the
      // bounds allow.
      leftWidth = LAYOUT_BOUNDS.left.min;
      rightWidth = LAYOUT_BOUNDS.right.min;
    }
  }

  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    const maxBottom = Math.max(LAYOUT_BOUNDS.centerBottom.min, viewportHeight - MIN_CENTER_TOP_PX);
    centerBottomHeight = clampCenterBottomHeight(Math.min(centerBottomHeight, maxBottom));
  }

  return { leftWidth, rightWidth, centerBottomHeight };
}
