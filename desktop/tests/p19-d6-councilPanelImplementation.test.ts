import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P19-D6 (D6-D) — same documented ceiling as p19-d4-councilPanelDebate.test.ts:
// this project has no React-rendering test infrastructure (vitest.config.ts
// runs environment:'node', no jsdom/@testing-library/react). These are
// source-text assertions proving CouncilPanel.tsx actually reads and renders
// council-projection.mjs's `implementationParticipantId` field — not the
// rendered DOM.

const councilPanelSource = readFileSync(join(__dirname, '../src/components/CouncilPanel.tsx'), 'utf8');

describe('CouncilPanel implementation-participant identity (P19-D6)', () => {
  it('1. reads run.implementationParticipantId — the same normalized W4R6 scalar council-projection.mjs now exposes', () => {
    expect(councilPanelSource).toMatch(/run\.implementationParticipantId/);
  });

  it('2. marks the implementing participant inline, next to its status badge, never as a separate unlinked field', () => {
    expect(councilPanelSource).toMatch(/run\.implementationParticipantId === p\.profileId/);
  });

  it('3. the expanded detail always states the analysis-only-vs-execution-capable distinction in prose, for every run (not gated on debate.enabled — W4R6 applies to plain Council too)', () => {
    expect(councilPanelSource).toMatch(/All participants are analysis\/review only/);
    expect(councilPanelSource).toMatch(/Implementation participant: \$\{run\.implementationParticipantId\}/);
  });
});
