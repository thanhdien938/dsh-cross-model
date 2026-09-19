import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// P22.5 §G: static/structural checks that Composer.tsx communicates the
// API SINGLE-only product policy without ever using PROVEN/qualification/
// pending language, and never silently hides a configured API profile.
// This project has no jsdom/browser rendering infrastructure (see
// p14-r0c-composer-reachability.test.ts's identical limitation note) — a
// real visual verification remains an owner Desktop retest.

const desktopRoot = path.resolve(__dirname, '..');
const composerTsx = fs.readFileSync(path.resolve(desktopRoot, 'src/components/Composer.tsx'), 'utf8');

describe('P22.5 §G: Composer communicates API SINGLE-only policy without PROVEN/qualification language', () => {
  it('exports a single shared hint string for the API SINGLE-only explanation', () => {
    expect(composerTsx).toContain('export const API_SINGLE_ONLY_HINT');
    expect(composerTsx).toMatch(/Single tasks only/);
    expect(composerTsx).toMatch(/OpenCode/);
  });

  it('never phrases the API restriction as unproven/qualification-required/pending', () => {
    const hintMatch = composerTsx.match(/export const API_SINGLE_ONLY_HINT =\s*\n?\s*'([^']*)'/);
    expect(hintMatch).not.toBeNull();
    const hint = hintMatch![1];
    expect(hint).not.toMatch(/UNPROVEN|qualification|proof|pending|not yet tested/i);
  });

  it('the participant checklist disables (never removes) an API profile, keyed off p.product', () => {
    expect(composerTsx).toMatch(/const apiSingleOnly = p\.product === 'api'/);
    expect(composerTsx).toMatch(/disabled=\{!isArmed \|\| !p\.available \|\| apiSingleOnly\}/);
  });

  it('the Chair PM selector disables an API option only in COUNCIL mode, not for "PM for next task" (SINGLE)', () => {
    expect(composerTsx).toMatch(/const apiSingleOnly = mode === 'COUNCIL' && p\.product === 'api'/);
  });

  it('a stale API chair selection is cleared when switching into COUNCIL mode', () => {
    expect(composerTsx).toMatch(/chosen\?\.product === 'api'\) onPmProfileChange\(''\)/);
  });
});
