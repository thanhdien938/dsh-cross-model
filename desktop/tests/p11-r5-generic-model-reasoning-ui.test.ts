import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P11-R5 Part N/O/Q — source-level proof (same technique used throughout
// this repo's desktop tests — no jsdom/@testing-library/react dependency)
// that PmProfileCreateDialog now renders a real reasoning <select> (not
// just a free-text placeholder hint) whenever a backend's capability
// contract reports SUPPORTED with enumerated levels — generically, one
// shared branch, not a Codex-specific one — and truthfully labels a
// static/DSH-managed model catalogue as such.
const desktopRoot = path.resolve(__dirname, '..');
const dialogSource = fs.readFileSync(path.join(desktopRoot, 'src/components/PmProfileCreateDialog.tsx'), 'utf8');
// Comments legitimately explain WHY a shared branch also covers Codex —
// that prose must never make the "no per-backend branch in the actual
// code" check below trip on itself (same technique as R4.1's
// ConnectionCenter test).
const codeOnlyDialogSource = dialogSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('P11-R5/R5.1 generic (non-api, non-antigravity) reasoning select', () => {
  it('renders a <select> of effectiveReasoningLevels when selection is SUPPORTED with enumerated levels', () => {
    expect(dialogSource).toMatch(/capability\?\.reasoning\.selection === 'SUPPORTED' && Array\.isArray\(effectiveReasoningLevels\)/);
    expect(dialogSource).toMatch(/\{effectiveReasoningLevels\.map\(\(level\) => \(/);
  });

  it('effectiveReasoningLevels narrows to the selected model\'s own proven subset via a generic, backend-agnostic modelEffortLevels map, falling back to the product-wide list', () => {
    expect(dialogSource).toMatch(/const effectiveReasoningLevels = \(model && capability\?\.modelDiscovery\.modelEffortLevels\?\.\[model\]\) \|\| capability\?\.reasoning\.levels \|\| null;/);
  });

  it('falls back to manual entry only when levels are genuinely unenumerable (e.g. Grok) or unsupported', () => {
    // The pre-existing free-text branch must still exist as the final
    // fallback — never removed, only no longer reached when real levels
    // exist.
    expect(dialogSource).toMatch(/placeholder=\{effectiveReasoningLevels\?\.join\(' \/ '\) \?\? 'optional'\}/);
  });

  it('is one shared branch, not a per-backend special case — no literal "codex" string in the actual code (comments may explain it)', () => {
    expect(codeOnlyDialogSource.toLowerCase()).not.toContain('codex');
  });
});

describe('P11-R5.1 generic model dropdown labels and default-model wording', () => {
  it('renders modelLabels[id] as the option text when present, falling back to the raw id — generic, no per-backend branch', () => {
    expect(dialogSource).toMatch(/\{capability\.modelDiscovery\.modelLabels\?\.\[m\] \?\? m\}/);
  });

  it('labels the inherited/default option clearly rather than as a primary selectable model (Part U)', () => {
    expect(dialogSource).toContain('<option value="">Default / CLI-selected model</option>');
    expect(dialogSource).not.toContain('(unset — CLI default)');
  });

  it('clears an incompatible reasoning value when the model changes to one with a narrower proven effort set', () => {
    expect(dialogSource).toMatch(/const nextLevels = capability\?\.modelDiscovery\.modelEffortLevels\?\.\[nextModel\];/);
    expect(dialogSource).toMatch(/if \(Array\.isArray\(nextLevels\) && reasoning && !nextLevels\.includes\(reasoning\)\) setReasoning\(''\);/);
  });
});

describe('P11-R5 truthful model-discovery-source hint', () => {
  it('renders capability.modelDiscovery.source under the Model field for every non-api backend', () => {
    expect(dialogSource).toMatch(/!isApi && capability\?\.modelDiscovery\.supported && capability\.modelDiscovery\.source/);
    expect(dialogSource).toContain('{capability.modelDiscovery.source}');
  });
});
