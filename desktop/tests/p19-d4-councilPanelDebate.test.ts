import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P19-D4 — same documented ceiling as councilPanelScroll.test.ts: this
// project has no React-rendering test infrastructure (vitest.config.ts
// runs environment:'node', no jsdom/@testing-library/react). This proves
// the real stylesheet/source declarations exist for the new Debate
// progress badge/section CouncilPanel.tsx renders — not the actual
// rendered DOM, which is the practical ceiling this project's test setup
// already accepts for this component.

const councilCss = readFileSync(join(__dirname, '../src/components/CouncilPanel.css'), 'utf8');
const councilPanelSource = readFileSync(join(__dirname, '../src/components/CouncilPanel.tsx'), 'utf8');

function ruleBodyFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*{([^}]*)}`));
  if (!match) throw new Error(`selector not found: ${selector}`);
  return match[1];
}

describe('CouncilPanel Debate progress (P19-D4)', () => {
  it('1. .council-run-debate-badge and .council-detail-final-debate-report are real, declared rules', () => {
    expect(() => ruleBodyFor(councilCss, '.council-run-debate-badge')).not.toThrow();
    expect(() => ruleBodyFor(councilCss, '.council-detail-final-debate-report')).not.toThrow();
  });

  it('2. every DEBATE_ROUND_1/DEBATE_ROUND_2 phase (council-projection.mjs, D2) has an owner-facing label', () => {
    expect(councilPanelSource).toMatch(/DEBATE_ROUND_1:\s*'Debate/);
    expect(councilPanelSource).toMatch(/DEBATE_ROUND_2:\s*'Debate/);
  });

  it('3. every DEBATE_STATUS value (council-projection.mjs, D2) has an owner-facing label — never an unmapped raw enum string shown to the owner', () => {
    for (const status of ['NOT_ENABLED', 'PENDING', 'ROUND_1_IN_PROGRESS', 'ROUND_1_COMPLETE', 'ROUND_2_IN_PROGRESS', 'COMPLETE']) {
      expect(councilPanelSource).toMatch(new RegExp(`${status}:\\s*'`));
    }
  });

  it('4. the run header renders the Debate badge only when run.debate.enabled — never for a debate-disabled council (regression: no stray badge/section on ordinary Council runs)', () => {
    expect(councilPanelSource).toMatch(/run\.debate\.enabled\s*&&/);
  });

  it('5. the Final Debate Report is rendered from run.debate.finalReport.output — never from a second, independent synthesis field', () => {
    expect(councilPanelSource).toMatch(/run\.debate\.finalReport\.output/);
  });
});
