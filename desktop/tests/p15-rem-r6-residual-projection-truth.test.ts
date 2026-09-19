import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const panelSource = readFileSync(join(__dirname, '../src/components/CouncilPanel.tsx'), 'utf8');
const mainSource = readFileSync(join(__dirname, '../electron/main/main.ts'), 'utf8');

describe('REM-R6 residual Council projection truth', () => {
  it('never maps Council IPC failure to a bare empty list or null detail', () => {
    expect(mainSource).toContain("errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE'");
    expect(mainSource).toContain("errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE'");
  });

  it('renders read failure before the genuine empty-state branch', () => {
    const errorIndex = panelSource.indexOf('Council status is unknown');
    const emptyIndex = panelSource.indexOf('No council runs yet for this project.');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(emptyIndex).toBeGreaterThan(-1);
    expect(panelSource).toContain('runs.length === 0 && !unavailable');
  });
});
