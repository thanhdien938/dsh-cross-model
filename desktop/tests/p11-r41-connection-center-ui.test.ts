import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P11-R4.1 Part A-E/AD/AE: same source-inspection technique
// connectionCenterRefreshPolicy.test.ts already uses (no jsdom/
// @testing-library/react dependency in this repo — see that file's
// docstring). `ApiProviderList` is deliberately kept in the file (Part AG:
// "do not delete useful backend/provider code") but must no longer be
// MOUNTED anywhere the normal owner card renders — splitting the source on
// its own `export function ApiProviderList` definition isolates "every
// line that can actually render in the normal card" from "the component's
// own now-unmounted implementation", regardless of exact regex boundaries
// around the outer ConnectionCenter function.
const desktopRoot = path.resolve(__dirname, '..');
const connectionCenterSource = fs.readFileSync(path.join(desktopRoot, 'src/components/ConnectionCenter.tsx'), 'utf8');

// Comments (both `//` line comments and `/* */`/JSX `{/* */}` block
// comments) are stripped before the containment checks below — this file's
// own docstrings legitimately reference the removed UI text ("API
// Providers", "Check live", ...) to explain WHY it was removed/kept; that
// prose must never make these regression tests trip on itself. Only text
// that can actually reach the rendered DOM is checked.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const codeOnlySource = stripComments(connectionCenterSource);
// Split before READY_LABEL/READY_COLOR too — they exist solely to support
// ApiProviderList's rendering and are otherwise unused/unreferenced dead
// weight in the normal-card half of the file.
const [normalCardSource, apiProviderListSource] = codeOnlySource.split('const READY_LABEL');

describe('P11-R4.1 simplified api Connection Center card', () => {
  it('ApiProviderList is never mounted in the normal card', () => {
    expect(normalCardSource).not.toMatch(/<ApiProviderList/);
  });

  it('no per-provider debug detail (API Providers/Scope/Check live/Key present/Key missing) reaches the normal card', () => {
    expect(normalCardSource).not.toContain('API Providers');
    expect(normalCardSource).not.toContain('Scope:');
    expect(normalCardSource).not.toContain('Check live');
    expect(normalCardSource).not.toContain('Key present');
    expect(normalCardSource).not.toContain('Key missing');
  });

  it('deferred/test provider ids never appear in the normal card', () => {
    // Note: bare "INACTIVE" is deliberately NOT checked here — it also
    // appears legitimately in PmProfilePanel's lifecycle-status tag (any
    // product's deactivated profile), unrelated to API-provider debug
    // detail. `DEFERRED_POST_P11` (provider-scope-only) is the unambiguous
    // marker for that removed detail.
    for (const id of ['deepseek', 'xcode-best', 'deepseek-test-broken', 'openrouter-test-broken', 'DEFERRED_POST_P11']) {
      expect(normalCardSource).not.toContain(id);
    }
  });

  it('Update API Key is present, scoped to the api product, replacing Login/Logout for it', () => {
    expect(normalCardSource).toMatch(/cap\.product === 'api'[\s\S]{0,200}Update API Key/);
  });

  it('Refresh remains present and unconditional (every product, including api)', () => {
    expect(normalCardSource).toContain("onClick={() => onRefreshOne(cap.product)}");
    expect(normalCardSource).toMatch(/\{busy \? 'Refreshing…' : 'Refresh'\}/);
  });

  it('the debug ApiProviderList component itself still exists (kept, not deleted — Part AG)', () => {
    expect(apiProviderListSource).toBeDefined();
    expect(apiProviderListSource).toContain('Check live');
    expect(apiProviderListSource).toContain('API Providers');
  });
});
