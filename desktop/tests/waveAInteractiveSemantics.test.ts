import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const desktopRoot = path.resolve(__dirname, '..');

function componentSource(name: string): string {
  return fs.readFileSync(path.join(desktopRoot, `src/components/${name}.tsx`), 'utf8');
}

describe('Wave A project-row semantics', () => {
  const source = componentSource('ProjectList');

  it('uses a native project-select button with pressed state', () => {
    expect(source).toMatch(/<button[\s\S]*?type="button"[\s\S]*?className="project-select-control"[\s\S]*?aria-pressed=\{selectedProject === project\.id\}/);
    expect(source).not.toContain('role="button"');
    expect(source).not.toContain('tabIndex={0}');
  });

  it('keeps ARM as a sibling rather than a descendant of the select button', () => {
    const selectStart = source.lastIndexOf('<button', source.indexOf('className="project-select-control"', source.indexOf('projects.map')));
    const selectEnd = source.indexOf('</button>', selectStart);
    const armStart = source.indexOf('className="btn btn-secondary project-arm-btn"');

    expect(selectStart).toBeGreaterThan(-1);
    expect(selectEnd).toBeGreaterThan(selectStart);
    expect(armStart).toBeGreaterThan(selectEnd);
    expect(source.slice(selectStart, selectEnd)).not.toContain('project-arm-btn');
  });

  it('keeps button content phrasing-only', () => {
    for (const match of source.matchAll(/<button\b(?:(?!<\/button>)[\s\S])*?<\/button>/g)) {
      expect(match[0]).not.toMatch(/<div\b/);
    }
  });
});

describe('Wave A busy-dialog close authority', () => {
  const busyDialogs = ['AddFolderDialog', 'PmProfileCreateDialog', 'CancelTaskDialog', 'UpdateApiKeyDialog'];

  it.each(busyDialogs)('%s guards Escape, backdrop, and cancel/close dismissal while busy', (name) => {
    const source = componentSource(name);
    expect(source).toMatch(/const requestClose = \(\) => \{\s*if \(!busy\) onClose\(\);\s*\};/);
    expect(source).toContain('useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !busy })');
    expect(source).toMatch(/className="(?:add-folder|pm-profile-create)-backdrop" onClick=\{requestClose\}/);
    expect(source).not.toMatch(/className="(?:add-folder|pm-profile-create)-backdrop" onClick=\{onClose\}/);
  });

  it.each(['CancelTaskDialog', 'UpdateApiKeyDialog'])('%s disables its dismiss action while the sensitive operation is busy', (name) => {
    const source = componentSource(name);
    expect(source).toMatch(/<button className="btn btn-secondary" onClick=\{requestClose\} disabled=\{busy\}>/);
  });

  it('keeps Login Terminal open while its CLI operation is running', () => {
    const source = componentSource('LoginTerminal');
    expect(source).toMatch(/const requestClose = \(\) => \{\s*if \(!running\) onClose\(\);\s*\};/);
    expect(source).toContain('useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !running })');
    expect(source).toContain('className="login-terminal-backdrop" onClick={requestClose}');
  });
});

describe('Wave A converted header button content models', () => {
  const headerComponents = ['ActivityPanel', 'BackendRuns', 'LongTaskRuntime', 'BackendExecutionLogs'];

  it.each(headerComponents)('%s has no div descendant inside a button', (name) => {
    const source = componentSource(name);
    expect(source).not.toMatch(/<button\b(?:(?!<\/button>)[\s\S])*?<div\b/);
  });
});
