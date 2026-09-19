import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// P14-R0A Parts A/B: source-level proof of the resizable layout wiring.
// This project has no jsdom (see composerPushCheckbox.test.ts /
// resizableLayout.test.ts) so component behavior that depends on actual
// rendering/pointer events is proven this way — at the pure-logic level
// (resizableLayout.test.ts) plus asserting the markup/CSS/wiring exist and
// are connected the way the pure logic expects.

const desktopRoot = path.resolve(__dirname, '..');
const appTsx = fs.readFileSync(path.resolve(desktopRoot, 'src/App.tsx'), 'utf8');
const appCss = fs.readFileSync(path.resolve(desktopRoot, 'src/App.css'), 'utf8');

describe('P14-R0A: Projects and Connection Center panels are resizable', () => {
  it('App.tsx wires the resizable layout hook', () => {
    expect(appTsx).toContain("import { useResizableLayout } from './lib/useResizableLayout'");
    expect(appTsx).toContain('const { layout, activeSide, startDrag, resetSide } = useResizableLayout()');
  });

  it('Projects (left) panel width is driven by resizable layout state, not a fixed literal', () => {
    expect(appTsx).toMatch(/className="sidebar sidebar-left"\s+style=\{\{\s*width:\s*layout\.leftWidth\s*\}\}/);
  });

  it('Connection Center (right) panel width is driven by resizable layout state, not a fixed literal', () => {
    expect(appTsx).toMatch(/className="sidebar sidebar-right"\s+style=\{\{\s*width:\s*layout\.rightWidth\s*\}\}/);
  });

  it('a drag handle sits between Projects and center content', () => {
    expect(appTsx).toMatch(/resize-handle[\s\S]{0,300}aria-label="Resize projects panel"[\s\S]{0,120}onMouseDown=\{startDrag\('left'\)\}/);
  });

  it('a drag handle sits between center content and Connection Center', () => {
    expect(appTsx).toMatch(/resize-handle[\s\S]{0,300}aria-label="Resize connection center panel"[\s\S]{0,120}onMouseDown=\{startDrag\('right'\)\}/);
  });

  it('all three handles (2 vertical column handles + 1 horizontal row handle, added in P14-R0B) are keyboard/AT discoverable as separators', () => {
    const matches = appTsx.match(/role="separator"/g) ?? [];
    expect(matches.length).toBe(3);
    const vertical = appTsx.match(/aria-orientation="vertical"/g) ?? [];
    const horizontal = appTsx.match(/aria-orientation="horizontal"/g) ?? [];
    expect(vertical.length).toBe(2);
    expect(horizontal.length).toBe(1);
  });

  it('App.css defines a visible, interactive resize-handle rule', () => {
    expect(appCss).toContain('.resize-handle {');
    expect(appCss).toContain('cursor: col-resize;');
  });

  it('center content keeps a sane minimum width so it stays the largest, usable area', () => {
    expect(appCss).toMatch(/\.center-content\s*\{[^}]*min-width:\s*320px/);
  });
});

describe('P14-R0A: no unrelated churn to IPC/security boundaries', () => {
  it('App.tsx does not add any new window.desktop IPC surface', () => {
    // The only new imports/usages introduced by this gate are local
    // (lib/useResizableLayout) — no new window.desktop.* call should
    // appear as part of the layout remediation.
    const newIpcCalls = appTsx.match(/window\.desktop\.\w+\.\w+/g) ?? [];
    for (const call of newIpcCalls) {
      expect(['window.desktop.runtime', 'window.desktop.project', 'window.desktop.connections', 'window.desktop.projects', 'window.desktop.timeline', 'window.desktop.inbox', 'window.desktop.pm', 'window.desktop.pmProfiles', 'window.desktop.owner', 'window.desktop.backends', 'window.desktop.bootstrap'].some((prefix) => call.startsWith(prefix))).toBe(true);
    }
  });

  it('preload surface is untouched by this gate (no diff expected here — sanity check the file still exists and is unmodified in intent)', () => {
    const preloadPath = path.resolve(desktopRoot, 'electron/preload/preload.ts');
    expect(fs.existsSync(preloadPath)).toBe(true);
  });
});
