import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const desktopRoot = path.resolve(__dirname, '..');
const hookSource = fs.readFileSync(path.join(desktopRoot, 'src/lib/useDialogA11y.ts'), 'utf8');

describe('useDialogA11y focus stability invariants', () => {
  it('does not include onClose, canClose, or initialFocusRef in mount effect dependencies', () => {
    expect(hookSource).toMatch(/useEffect\(\(\) => \{[\s\S]*?openerRef\.current[\s\S]*?\}, \[\]\);/);
  });

  it('keeps keydown listener dependencies empty to prevent listener churn', () => {
    expect(hookSource).toMatch(/window\.addEventListener\('keydown', handleKeyDown, true\);[\s\S]*?\}, \[\]\);/);
  });

  it('uses ref-backed callbacks for onClose and canClose', () => {
    expect(hookSource).toContain('onCloseRef.current');
    expect(hookSource).toContain('canCloseRef.current');
  });

  it('restores focus to opener on unmount only', () => {
    expect(hookSource).toMatch(/return \(\) => \{[\s\S]*?openerRef\.current\.focus\(\);[\s\S]*?\};/);
  });
});
