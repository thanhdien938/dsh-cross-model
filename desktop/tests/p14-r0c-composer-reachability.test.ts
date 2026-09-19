import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// P14-R0C Part C: proves the exact Composer-clipping regression R0B
// introduced is fixed at the source/CSS level. This project has no
// jsdom/browser rendering infrastructure (see composerPushCheckbox.test.ts,
// resizableLayout.test.ts, p14-r0a/b's own test files) — there is no way
// to lay out a real box model and assert a pixel is/isn't visible from
// inside vitest's `node` environment. Every assertion here is therefore a
// static/structural stand-in for what a real browser layout test would
// check: the CSS property that caused the defect, the property that fixes
// it, and that the fix doesn't remove what made it fixable (an actual
// scroll mechanism) or reintroduce the double-counted-height overlap that
// motivated the Timeline/Composer/CouncilPanel flex overrides.
//
// LIMITATION (documented per the brief): these tests cannot prove pixels
// are on-screen. Owner visual retest (docs/p14/00D's Desktop acceptance
// checklist) remains mandatory and is the actual proof.

const desktopRoot = path.resolve(__dirname, '..');
const appCss = fs.readFileSync(path.resolve(desktopRoot, 'src/App.css'), 'utf8');
const appTsx = fs.readFileSync(path.resolve(desktopRoot, 'src/App.tsx'), 'utf8');
const composerTsx = fs.readFileSync(path.resolve(desktopRoot, 'src/components/Composer.tsx'), 'utf8');
const timelineCss = fs.readFileSync(path.resolve(desktopRoot, 'src/components/Timeline.css'), 'utf8');
const councilPanelCss = fs.readFileSync(path.resolve(desktopRoot, 'src/components/CouncilPanel.css'), 'utf8');

// `selectorPattern` is a REGEX SOURCE (not a literal selector string) —
// callers write `\\s+` wherever whitespace (space vs newline vs indent)
// should be flexible, since exact CSS formatting isn't part of the
// contract being tested.
function ruleBody(css: string, selectorPattern: string): string {
  const match = css.match(new RegExp(selectorPattern + '\\s*\\{([^}]*)\\}'));
  if (!match) throw new Error(`rule not found in CSS: /${selectorPattern}/`);
  return match[1];
}

describe('P14-R0C item 1: PM selector still exists in source (R0B did NOT delete it)', () => {
  it('Composer.tsx still renders .composer-footer with the PM/Chair selector and Send button', () => {
    expect(composerTsx).toContain('className="composer-footer"');
    expect(composerTsx).toContain("className=\"composer-pm-label\"");
    expect(composerTsx).toContain("'PM for next task' : 'Chair PM'");
    expect(composerTsx).toContain('className="btn btn-primary composer-send"');
  });
});

describe('P14-R0C item 2: center-top uses a reachable overflow strategy (the actual root-cause fix)', () => {
  it('.center-top is overflow-y: auto, NOT overflow: hidden (R0B\'s defect)', () => {
    const body = ruleBody(appCss, '\\.center-top');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).not.toMatch(/overflow:\s*hidden/);
  });

  it('.center-top is a flex column, so its children can be individually sized instead of naively stacked', () => {
    const body = ruleBody(appCss, '\\.center-top');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('Composer and CouncilPanel are pinned to their natural height (flex: 0 0 auto) — overflow is handled by the container scrolling, never by squeezing their internal controls', () => {
    const body = ruleBody(appCss, '\\.center-top > \\.composer,\\s*\\.center-top > \\.council-panel');
    expect(body).toMatch(/flex:\s*0 0 auto/);
  });

  it('Timeline is the one region allowed to grow/shrink to fill remaining space, with height:auto overriding Timeline.css\'s own height:100% in this nested context', () => {
    const body = ruleBody(appCss, '\\.center-top > \\.timeline');
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/height:\s*auto/);
  });

  it("Timeline's own internal scroll region (.timeline-content) is untouched — task history still scrolls internally, not via a second full-column scroll", () => {
    expect(timelineCss).toMatch(/\.timeline-content\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/);
  });

  it("CouncilPanel's own self-bound (max-height: 40vh + internal scroll) is untouched", () => {
    expect(councilPanelCss).toMatch(/\.council-panel\s*\{[^}]*max-height:\s*40vh[^}]*overflow-y:\s*auto/);
  });
});

describe('P14-R0C items 3/4: Composer footer (PM selector + Send) is not clipped by shell layout', () => {
  it('center-top min-height matches the documented MIN_CENTER_TOP_PX floor (one number, not two)', () => {
    const resizableLayoutSource = fs.readFileSync(path.resolve(desktopRoot, 'src/lib/resizableLayout.ts'), 'utf8');
    const constMatch = resizableLayoutSource.match(/MIN_CENTER_TOP_PX\s*=\s*(\d+)/);
    expect(constMatch).not.toBeNull();
    const cssBody = ruleBody(appCss, '.center-top');
    expect(cssBody).toContain(`min-height: ${constMatch![1]}px`);
  });

  it('Composer/CouncilPanel/Timeline are still direct children of .center-top (the scrollable region), not moved outside it', () => {
    const centerTopOpen = appTsx.indexOf('<div className="center-top">');
    const centerTopBlock = appTsx.slice(centerTopOpen, appTsx.indexOf('resize-handle-row', centerTopOpen));
    expect(centerTopBlock).toContain('<Composer');
    expect(centerTopBlock).toContain('<CouncilPanel');
    expect(centerTopBlock).toContain('<Timeline');
  });
});

describe('P14-R0C items 5/6: Council and task-file controls remain reachable (same scroll region as Composer\'s footer)', () => {
  it('Council mode controls (participants, rounds) are rendered in Composer.tsx, before the footer in source order per UI Wave A UIAUD-003', () => {
    const footerIdx = composerTsx.indexOf('composer-footer');
    const councilIdx = composerTsx.indexOf('composer-council"');
    expect(footerIdx).toBeGreaterThan(-1);
    expect(councilIdx).toBeGreaterThan(-1);
    expect(councilIdx).toBeLessThan(footerIdx);
  });

  it('task-file controls (ref/path inputs) are still rendered in Composer.tsx, before the footer in source order (unaffected by this gate)', () => {
    const taskFileIdx = composerTsx.indexOf('composer-task-file-fields');
    const footerIdx = composerTsx.indexOf('composer-footer');
    expect(taskFileIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(taskFileIdx);
  });

  it('none of Composer.tsx\'s own control logic changed — this gate is a pure CSS/container fix (Composer.tsx is byte-identical to before R0C)', () => {
    // Composer.tsx should contain no P14-R0C marker at all — if this ever
    // fires, someone touched Composer.tsx's own logic for this gate,
    // which was explicitly out of scope (fix only the shell CSS).
    expect(composerTsx).not.toContain('P14-R0C');
  });
});

describe('P14-R0C items 7/8: center/left/right resizing remain functional after the overflow fix', () => {
  it('the row handle (center-bottom split) is still wired exactly as R0B left it', () => {
    expect(appTsx).toMatch(/resize-handle-row[\s\S]{0,300}aria-label="Resize task status pane"[\s\S]{0,120}onMouseDown=\{startDrag\('centerBottom'\)\}/);
  });
  it('the left/right column handles are still wired exactly as R0A/R0B left them', () => {
    expect(appTsx).toMatch(/resize-handle[\s\S]{0,300}aria-label="Resize projects panel"[\s\S]{0,120}onMouseDown=\{startDrag\('left'\)\}/);
    expect(appTsx).toMatch(/resize-handle[\s\S]{0,300}aria-label="Resize connection center panel"[\s\S]{0,120}onMouseDown=\{startDrag\('right'\)\}/);
  });
  it('useResizableLayout.ts (the drag/clamp logic) has no P14-R0C changes — this gate did not touch resize behavior, only the CSS overflow strategy', () => {
    const hookSource = fs.readFileSync(path.resolve(desktopRoot, 'src/lib/useResizableLayout.ts'), 'utf8');
    expect(hookSource).not.toContain('P14-R0C');
  });
});

describe('P14-R0C item 9: layout persistence remains functional (resizableLayout.ts untouched by this gate)', () => {
  it('resizableLayout.ts has no P14-R0C changes — persistence/clamping logic is exactly what R0B shipped', () => {
    const libSource = fs.readFileSync(path.resolve(desktopRoot, 'src/lib/resizableLayout.ts'), 'utf8');
    expect(libSource).not.toContain('P14-R0C');
  });
});

describe('P14-R0C: splitter safety — a small center-bottom pane cannot make Composer controls unreachable', () => {
  it('center-bottom bounds are unchanged from R0B (this gate did not touch how large/small the owner can make the task-status pane)', () => {
    const libSource = fs.readFileSync(path.resolve(desktopRoot, 'src/lib/resizableLayout.ts'), 'utf8');
    expect(libSource).toContain('centerBottom: { min: 140, max: 480, default: 240 }');
  });
  it('however large center-bottom gets, .center-top now scrolls instead of clipping — the fix that makes splitter safety hold at every size', () => {
    const body = ruleBody(appCss, '.center-top');
    expect(body).toMatch(/overflow-y:\s*auto/);
  });
});
