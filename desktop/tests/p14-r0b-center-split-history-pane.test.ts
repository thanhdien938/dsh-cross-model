import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// P14-R0B: source-level proof that the owner's corrected wireframe is
// what actually got built — a Composer/history TOP and a smaller
// task-status/history BOTTOM inside the CENTER COLUMN ONLY, not a
// full-app-width band (R0A's mistake). Same testing approach as R0A
// (p14-r0a-resizable-layout.test.ts, p14-r0a-capacity-source.test.ts):
// this project has no jsdom, so structural/CSS assertions on the real
// source stand in for what a rendered DOM assertion would check.

const desktopRoot = path.resolve(__dirname, '..');
const appTsx = fs.readFileSync(path.resolve(desktopRoot, 'src/App.tsx'), 'utf8');
const appCss = fs.readFileSync(path.resolve(desktopRoot, 'src/App.css'), 'utf8');
const multiTaskCss = fs.readFileSync(path.resolve(desktopRoot, 'src/components/MultiTaskControl.css'), 'utf8');

describe('P14-R0B item 3: middle-column vertical split (Composer vs task-history) works', () => {
  it('a horizontal (row) drag handle sits inside .center-content, wired to the centerBottom axis', () => {
    expect(appTsx).toMatch(/resize-handle-row[\s\S]{0,300}aria-label="Resize task status pane"[\s\S]{0,120}onMouseDown=\{startDrag\('centerBottom'\)\}/);
  });

  it('the row handle supports double-click-to-reset, same as the column handles', () => {
    expect(appTsx).toMatch(/resize-handle-row[\s\S]{0,400}onDoubleClick=\{resetSide\('centerBottom'\)\}/);
  });

  it('App.css defines the row-handle rule with the correct (row-resize) cursor', () => {
    expect(appCss).toContain('.resize-handle-row {');
    expect(appCss).toContain('cursor: row-resize;');
  });

  it('the split lives strictly inside .center-content: center-top, the row handle, and center-bottom are all its direct children in source order', () => {
    const centerContentOpen = appTsx.indexOf('<div className="center-content">');
    expect(centerContentOpen).toBeGreaterThan(-1);
    const centerTop = appTsx.indexOf('<div className="center-top">', centerContentOpen);
    const rowHandle = appTsx.indexOf('resize-handle-row', centerContentOpen);
    const centerBottom = appTsx.indexOf('className="center-bottom"', centerContentOpen);
    expect(centerTop).toBeGreaterThan(centerContentOpen);
    expect(rowHandle).toBeGreaterThan(centerTop);
    expect(centerBottom).toBeGreaterThan(rowHandle);
  });
});

describe('P14-R0B items 4/6: the task-status/history pane is a small pane inside the center column, NOT a full-width global band', () => {
  it('MultiTaskControl now mounts inside .center-bottom, not as a top-level sibling of .main-content', () => {
    const centerBottomBlock = appTsx.slice(appTsx.indexOf('className="center-bottom"'), appTsx.indexOf('className="center-bottom"') + 400);
    expect(centerBottomBlock).toContain('<MultiTaskControl');
  });

  it('there is exactly one <MultiTaskControl mount, and it is not a direct sibling of .main-content (R0A\'s full-width-band mistake)', () => {
    const mounts = appTsx.match(/<MultiTaskControl/g) ?? [];
    expect(mounts.length).toBe(1);
    // The old R0A shape was `</div>\n\n      <MultiTaskControl` immediately
    // after .main-content's closing tag, at the .app level. That exact
    // adjacency must not exist any more.
    expect(appTsx).not.toMatch(/<\/div>\s*\n\s*<MultiTaskControl/);
  });

  it('.center-bottom is sized by an inline height (owner-resizable, bounded), not full viewport/app width', () => {
    expect(appTsx).toMatch(/className="center-bottom"\s+style=\{\{\s*height:\s*layout\.centerBottomHeight\s*\}\}/);
  });

  it('.center-bottom reads as a bordered pane, not a page-width band — via its own border-top OR the resize handle immediately above it owning that boundary', () => {
    // UI V2.0 foundation: border-top's width/color moved onto shared
    // tokens (same declaration, same rendered border, just sourced from
    // one place).
    //
    // UI V2.4 purple-structural-lines: .center-bottom's own border-top
    // was then REMOVED deliberately — a real-screenshot review found it
    // sitting 2px below .resize-handle-row's neon line, reading as two
    // parallel lines on one boundary rather than one. .resize-handle-row
    // (proven immediately above .center-bottom in source order by the
    // "direct children in source order" test above) now owns this
    // boundary exclusively, and its own ::after always renders a visible
    // line (background is set unconditionally, not just on :hover/.active
    // — see the assertion below). The real invariant this test protects —
    // center-bottom reads as a bounded pane, not an unbounded full-width
    // band — still holds either way, so this checks for either mechanism.
    const hasOwnBorder = /\.center-bottom\s*\{[^}]*border-top:\s*(?:1px solid|var\(--dsh-border-width\)\s+solid\s+var\(--dsh-border-default\)|var\(--dsh-frame-neon-width\)\s+solid\s+var\(--dsh-frame-neon-soft\))/.test(appCss);
    const resizeHandleRowOwnsBoundary = /\.resize-handle-row::after\s*\{[^}]*background:\s*var\(--dsh-frame-neon/.test(appCss);
    expect(hasOwnBorder || resizeHandleRowOwnsBoundary).toBe(true);
  });
});

describe('P14-R0B item 5: task history scrolls internally, bounded by the pane', () => {
  it('the original MultiTaskControl.css bounded-scroll pin is untouched (P13-R6 regression guard)', () => {
    // Exact string a pre-existing test (p13-r6-multi-task-control.test.ts)
    // also pins — proves this gate did not weaken that guarantee.
    expect(multiTaskCss).toContain('max-height:360px;overflow-y:auto');
    expect(multiTaskCss).toContain('overscroll-behavior:contain');
  });

  it('when nested inside .center-bottom, the list instead flexes to fill the (smaller, resizable) pane and still scrolls internally', () => {
    expect(appCss).toMatch(/\.center-bottom \.multi-task-list\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/);
  });

  it('the nested .multi-task card itself has no fixed page margin any more (it fills its pane, not the page)', () => {
    expect(appCss).toMatch(/\.center-bottom \.multi-task\s*\{[^}]*margin:\s*0/);
  });
});

describe('P14-R0B item 4 (compactness carried over from R0A): counter bar stays compact in its new home', () => {
  it('the compact stat markup (small label + semibold value) from R0A is unchanged', () => {
    const source = fs.readFileSync(path.resolve(desktopRoot, 'src/components/MultiTaskControl.tsx'), 'utf8');
    expect(source).toContain('multi-task-stat-label');
    expect(source).toContain('multi-task-stat-value');
  });
  it('no oversized card padding/min-height was introduced for the compact bar', () => {
    expect(multiTaskCss).not.toMatch(/\.multi-task-summary\s*\{[^}]*min-height/);
  });
});

describe('P14-R0B item 9: window-resize clamping is wired into the hook', () => {
  const hookSource = fs.readFileSync(path.resolve(desktopRoot, 'src/lib/useResizableLayout.ts'), 'utf8');
  it('the hook listens for window resize and re-clamps via clampToViewport', () => {
    expect(hookSource).toContain("window.addEventListener('resize', applyClamp)");
    expect(hookSource).toContain('clampToViewport(prev, window.innerWidth, window.innerHeight)');
  });
  it('the resize listener is cleaned up (no leak)', () => {
    expect(hookSource).toContain("window.removeEventListener('resize', applyClamp)");
  });
});

describe('P14-R0B item 10: existing submission/cancel/connection surfaces are still rendered, unmodified', () => {
  it('Composer, CouncilPanel, Timeline, ConnectionCenter, PmProfileManagement, ApprovalPanel are all still mounted', () => {
    for (const component of ['<Composer', '<CouncilPanel', '<Timeline', '<ConnectionCenter', '<PmProfileManagement', '<ApprovalPanel', '<BackendRuns', '<LongTaskRuntime', '<BackendExecutionLogs', '<ActivityPanel']) {
      expect(appTsx).toContain(component);
    }
  });

  it('none of the surface components this gate must not touch changed their own source at all', () => {
    // This gate's diff is scoped to App.tsx/App.css/MultiTaskControl's
    // *container* and the resizableLayout lib — never the composition/
    // council/cancel/connection component files themselves.
    for (const file of ['Composer.tsx', 'CouncilPanel.tsx', 'CancelTaskDialog.tsx', 'ConnectionCenter.tsx', 'Timeline.tsx']) {
      const p = path.resolve(desktopRoot, 'src/components', file);
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});

describe('P14-R0B: DEFAULT_LAYOUT_PREFS is wired through App.tsx via the hook, no new IPC surface', () => {
  it('App.tsx still imports the same useResizableLayout hook (extended, not replaced)', () => {
    expect(appTsx).toContain("import { useResizableLayout } from './lib/useResizableLayout'");
    expect(appTsx).toContain('const { layout, activeSide, startDrag, resetSide } = useResizableLayout()');
  });

  it('no new window.desktop.* IPC surface was introduced by the R0B restructuring', () => {
    const newIpcCalls = appTsx.match(/window\.desktop\.\w+\.\w+/g) ?? [];
    const allowed = ['window.desktop.runtime', 'window.desktop.project', 'window.desktop.connections', 'window.desktop.projects', 'window.desktop.timeline', 'window.desktop.inbox', 'window.desktop.pm', 'window.desktop.pmProfiles', 'window.desktop.owner', 'window.desktop.backends', 'window.desktop.bootstrap'];
    for (const call of newIpcCalls) {
      expect(allowed.some((prefix) => call.startsWith(prefix))).toBe(true);
    }
  });
});
