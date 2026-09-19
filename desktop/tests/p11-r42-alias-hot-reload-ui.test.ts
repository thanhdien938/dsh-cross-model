import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P11-R4.2 Part E/F/N: source-level proof (same technique
// connectionCenterRefreshPolicy.test.ts / security.test.ts already use —
// no jsdom/@testing-library/react dependency in this repo) that:
//   - the Connection Center profile panel renders the freshly-read alias;
//   - pmProfiles:create best-effort triggers the running runtime's hot
//     reload over the control pipe, without ever turning a reload failure
//     into a create failure (the write already durably succeeded);
//   - pmProfiles:list decorates every entry with a fresh alias read.
const desktopRoot = path.resolve(__dirname, '..');
const connectionCenterSource = fs.readFileSync(path.join(desktopRoot, 'src/components/ConnectionCenter.tsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/main.ts'), 'utf8');

describe('P11-R4.2 Desktop shows the hot-reloaded alias', () => {
  it('ConnectionCenter renders an Alias row sourced from selected.alias, with an honest "not yet assigned" fallback', () => {
    expect(connectionCenterSource).toMatch(/Alias<\/span>\s*<span className="pm-profile-readonly">\{selected\.alias \?\? 'Not yet assigned'\}<\/span>/);
  });

  it('the bare PM alias is shown — never a fabricated project-alias-prefixed shorthand', () => {
    const aliasRowBlock = connectionCenterSource.match(/pm-profile-field-label">Alias[\s\S]{0,200}/)?.[0] ?? '';
    expect(aliasRowBlock).not.toMatch(/`2-\$\{/);
  });

  it('pmProfiles:create triggers the runtime hot-reload best-effort after a successful write', () => {
    const handlerBlock = mainSource.match(/ipcMain\.handle\('pmProfiles:create'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(handlerBlock).toContain('reloadPmProfiles()');
    expect(handlerBlock).toContain('runtimeSupervisor?.getPipeClient()');
    // Best-effort: a reload failure is caught and logged, never rethrown —
    // the durable write's own success/failure is the only thing this
    // handler's return value reports on failure.
    expect(handlerBlock).toMatch(/catch\s*\(error\)\s*\{/);
  });

  it('pmProfiles:list decorates every entry with a freshly-read alias, never a cached one', () => {
    const handlerBlock = mainSource.match(/ipcMain\.handle\('pmProfiles:list'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(handlerBlock).toContain('readPmProfileAliases(');
    expect(handlerBlock).toMatch(/alias:\s*aliasMap\?\.get\(p\.id\)\s*\?\?\s*null/);
  });
});
