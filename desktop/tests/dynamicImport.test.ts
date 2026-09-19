import { describe, it, expect } from 'vitest';
import path from 'path';
import { execFileSync } from 'child_process';

// Regression guard for a real bug this pass found and fixed: TypeScript's
// CommonJS module emit downlevels `await import('...')` into
// `Promise.resolve().then(() => require('...'))`, which throws
// ERR_REQUIRE_ESM for a pure-ESM .mjs target. `tsc --noEmit` type-checks
// happily and vitest's own esbuild-based transform never exhibits the bug
// either (it preserves real dynamic import), so neither the normal
// compile check nor the rest of this test suite would catch a regression
// here. This test actually compiles electron/ with the real project
// tsconfig and *runs* the emitted JS end to end against a real target
// module, the same way the previous version of this codebase's dynamic
// imports were silently broken until this was caught.
describe('importEsmModule survives the real tsc CommonJS emit', () => {
  it('loads a real .mjs module through the actual compiled dist-electron output', () => {
    const desktopRoot = path.resolve(__dirname, '..');
    execFileSync('npx', ['tsc', '-p', 'tsconfig.electron.json'], { cwd: desktopRoot, stdio: 'pipe', shell: true });

    const script = `
      const { DEV_FALLBACK_REPO_ROOT } = require(${JSON.stringify(path.join(desktopRoot, 'dist-electron/electron/main/repoRoot.js'))});
      const { importEsmModule } = require(${JSON.stringify(path.join(desktopRoot, 'dist-electron/electron/main/dynamicImport.js'))});
      const path = require('path');
      importEsmModule(path.join(DEV_FALLBACK_REPO_ROOT, 'src', 'runtime', 'operator-control-service.mjs'))
        .then((mod) => { console.log(JSON.stringify({ ok: typeof mod.sanitizeOperatorOutput === 'function' })); })
        .catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e) })); process.exitCode = 1; });
    `;
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const parsed = JSON.parse(output.trim().split('\n').pop() ?? '{}');
    expect(parsed.ok).toBe(true);
  }, 30000);
});
