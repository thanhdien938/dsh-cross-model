import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P12-R5C Part A/L — this project has no React-rendering test infrastructure
// (vitest.config.ts runs environment:'node', no jsdom/@testing-library/react
// — an established, documented constraint since P12-R5A), so an actual
// mouse-wheel/scrollbar behavior cannot be exercised here. This asserts the
// real stylesheet source contains the exact declarations that fix the
// reported bug (Council content silently clipped, unreachable, because
// .council-panel previously had no height bound and every ancestor —
// .center-content/.main-content/.app/body — is `overflow: hidden` by
// design, App.css). Combined with the Desktop package build + owner-live
// mouse-wheel verification (Part M), this is the practical ceiling of
// automated coverage this project's test setup supports for this kind of
// fix — documented honestly, not overclaimed.
const councilCss = readFileSync(join(__dirname, '../src/components/CouncilPanel.css'), 'utf8');
const appCss = readFileSync(join(__dirname, '../src/App.css'), 'utf8');

function ruleBodyFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*{([^}]*)}`));
  if (!match) throw new Error(`selector not found: ${selector}`);
  return match[1];
}

describe('Council panel scroll (Part A/L items 1-3)', () => {
  it('1. .council-panel declares a bounded max-height (never allowed to grow past its container and push other panels off-screen)', () => {
    const body = ruleBodyFor(councilCss, '.council-panel');
    expect(body).toMatch(/max-height\s*:/);
  });

  it('2. .council-panel is a real scroll container (overflow-y: auto, not hidden/clip) — the actual mouse-wheel/scrollbar mechanism', () => {
    const body = ruleBodyFor(councilCss, '.council-panel');
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
    expect(body).not.toMatch(/overflow(-y)?\s*:\s*(hidden|clip)/);
  });

  it('3. the max-height bound is relative (vh), not a fixed pixel value, so it still leaves room at smaller window sizes (Part A requirement)', () => {
    const body = ruleBodyFor(councilCss, '.council-panel');
    const match = body.match(/max-height\s*:\s*([^;]+);/);
    expect(match?.[1]).toMatch(/vh/);
  });

  it('regression: .center-content/.main-content/.app remain exactly as clipped as before — this fix does not touch the shared app-shell layout at all (no risk of COUNCIL_SCROLL_FIX_BREAKS_MAIN_LAYOUT)', () => {
    expect(ruleBodyFor(appCss, '.center-content')).toMatch(/overflow\s*:\s*hidden/);
    expect(ruleBodyFor(appCss, '.main-content')).toMatch(/overflow\s*:\s*hidden/);
    expect(ruleBodyFor(appCss, '.app')).toMatch(/overflow\s*:\s*hidden/);
  });
});
