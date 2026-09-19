import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LAYOUT_PREFS,
  LayoutPrefs,
  clampToViewport,
  loadLayoutPrefs,
  nextCenterBottomHeight,
  nextLeftWidth,
  nextRightWidth,
  saveLayoutPrefs,
} from './resizableLayout';

// P14-R0B: 'centerBottom' is the horizontal (row) handle between Composer/
// history and the task-status/history pane, inside the center column only
// — distinct from 'left'/'right', which are the vertical (column) handles
// either side of it.
export type ResizeSide = 'left' | 'right' | 'centerBottom';

function valueFor(layout: LayoutPrefs, side: ResizeSide): number {
  if (side === 'left') return layout.leftWidth;
  if (side === 'right') return layout.rightWidth;
  return layout.centerBottomHeight;
}

function withValue(layout: LayoutPrefs, side: ResizeSide, value: number): LayoutPrefs {
  if (side === 'left') return { ...layout, leftWidth: value };
  if (side === 'right') return { ...layout, rightWidth: value };
  return { ...layout, centerBottomHeight: value };
}

// P14-R0A/R0B: thin React shell around resizableLayout.ts's pure math. Not
// unit-tested directly (this project has no DOM/rendering test infra —
// see resizableLayout.test.ts for the pure logic this delegates to);
// keeping all the actual width/height/clamp/persistence decisions in that
// framework-free module is what makes them testable at all.
export function useResizableLayout() {
  const [layout, setLayout] = useState<LayoutPrefs>(() => {
    try {
      return loadLayoutPrefs(window.localStorage);
    } catch {
      return DEFAULT_LAYOUT_PREFS;
    }
  });
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const dragRef = useRef<{ side: ResizeSide; start: number; startValue: number } | null>(null);
  const [activeSide, setActiveSide] = useState<ResizeSide | null>(null);

  const persist = useCallback(() => {
    try {
      saveLayoutPrefs(layoutRef.current, window.localStorage);
    } catch {
      // Persistence is a nicety — never block the UI on it.
    }
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.side === 'centerBottom') {
        const deltaY = e.clientY - drag.start;
        const height = nextCenterBottomHeight(drag.startValue, deltaY);
        setLayout((prev) => withValue(prev, 'centerBottom', height));
        return;
      }
      const deltaX = e.clientX - drag.start;
      const width = drag.side === 'left' ? nextLeftWidth(drag.startValue, deltaX) : nextRightWidth(drag.startValue, deltaX);
      setLayout((prev) => withValue(prev, drag.side, width));
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      setActiveSide(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persist();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persist]);

  // P14-R0B: re-clamp against the live window size on every resize, so a
  // shrunk OS window can never leave Projects/center/Connection Center (or
  // the task-status pane) in an invisible/negative/collapsed state. Also
  // runs once on mount, in case the persisted sizes (from a previous,
  // larger window) are already out of bounds for this launch's window.
  useEffect(() => {
    function applyClamp() {
      setLayout((prev) => {
        const next = clampToViewport(prev, window.innerWidth, window.innerHeight);
        if (next.leftWidth === prev.leftWidth && next.rightWidth === prev.rightWidth && next.centerBottomHeight === prev.centerBottomHeight) {
          return prev;
        }
        layoutRef.current = next;
        persist();
        return next;
      });
    }
    applyClamp();
    window.addEventListener('resize', applyClamp);
    return () => window.removeEventListener('resize', applyClamp);
  }, [persist]);

  const startDrag = useCallback(
    (side: ResizeSide) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = {
        side,
        start: side === 'centerBottom' ? e.clientY : e.clientX,
        startValue: valueFor(layoutRef.current, side),
      };
      setActiveSide(side);
      document.body.style.cursor = side === 'centerBottom' ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    },
    []
  );

  // A handle double-click restores that side to its documented default —
  // a quick, discoverable escape hatch from an awkward manual size.
  const resetSide = useCallback(
    (side: ResizeSide) => () => {
      const defaultValue = valueFor(DEFAULT_LAYOUT_PREFS, side);
      const next = withValue(layoutRef.current, side, defaultValue);
      layoutRef.current = next;
      setLayout(next);
      persist();
    },
    [persist]
  );

  return { layout, activeSide, startDrag, resetSide };
}
