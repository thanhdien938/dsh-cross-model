import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const desktopRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(desktopRoot, 'electron/preload/preload.ts'), 'utf8');
const rendererSource = readTree(path.join(desktopRoot, 'src'));

describe('Electron Security', () => {
  it('enforces the production BrowserWindow boundary', () => {
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
    expect(mainSource).toMatch(/sandbox:\s*true/);
    expect(mainSource).toMatch(/webSecurity:\s*true/);
    expect(mainSource).toMatch(/webviewTag:\s*false/);
  });

  it('sets a restrictive CSP', () => {
    expect(mainSource).toContain("default-src 'self'");
    expect(mainSource).toContain("script-src 'self'");
    expect(mainSource).toContain("connect-src 'self'");
  });
});

describe('Preload API Surface', () => {
  it('exposes only the closed desktop API', () => {
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('desktop'");
    expect(preloadSource).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer/);
    expect(preloadSource).not.toContain('send: ipcRenderer.send');
  });

  it('does not expose generic IPC or privileged handles', () => {
    expect(preloadSource).not.toContain('require(');
    expect(preloadSource).not.toContain("from 'fs'");
    expect(preloadSource).not.toContain("from 'child_process'");
    expect(preloadSource).not.toContain('better-sqlite3');
    expect(preloadSource).not.toMatch(/\bprocess\.env\b/);
  });

  it('keeps renderer code free of Node, database, and secret access', () => {
    expect(rendererSource).not.toMatch(/from ['"](?:fs|node:fs|child_process|node:child_process)['"]/);
    expect(rendererSource).not.toContain('better-sqlite3');
    expect(rendererSource).not.toMatch(/\bprocess\.env\b/);
    expect(rendererSource).not.toContain('ipcRenderer');
  });
});

describe('W3-A Login Terminal closed surface', () => {
  it('the preload Login Terminal API is closed (start/write/stop/status/onData/onExit only), never a generic exec', () => {
    expect(preloadSource).toMatch(/loginTerminal:\s*\{/);
    expect(preloadSource).not.toMatch(/loginTerminal[\s\S]{0,200}\bexec\b/);
    expect(preloadSource).not.toContain("ipcRenderer.invoke('exec'");
    expect(preloadSource).not.toContain("ipcRenderer.invoke('shell'");
  });

  it('main.ts never spawns a login terminal process with shell:true', () => {
    const loginServiceSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/loginTerminalService.ts'), 'utf8');
    expect(loginServiceSource).toMatch(/shell:\s*false/);
    expect(loginServiceSource).not.toMatch(/shell:\s*true/);
  });

  it('the login terminal closed argv table never contains a flag/argument, only the two bare subcommand names', () => {
    const loginServiceSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/loginTerminalService.ts'), 'utf8');
    const argsBlock = loginServiceSource.match(/const ARGS[\s\S]*?\};/)?.[0] ?? '';
    expect(argsBlock).toContain("['login']");
    expect(argsBlock).toContain("['logout']");
    expect(argsBlock).not.toMatch(/--/);
  });
});

describe('W3-B/W3-C closed read surfaces', () => {
  it('backends:capabilities and runs:list are read-only IPC, not generic owner/db passthrough', () => {
    expect(preloadSource).toMatch(/backends:\s*\{[\s\S]*?capabilities:/);
    expect(preloadSource).toMatch(/runs:\s*\{[\s\S]*?list:/);
  });
});

// R31-5: the execution-log surface must remain read-only — no stdin,
// shell prompt, command entry, arbitrary executable, or PTY task
// session. Login Terminal (asserted above) remains the only interactive
// CLI-auth surface.
describe('P6-W3-R3 execLogs closed read-only surface', () => {
  it('preload exposes exactly list/statuses on execLogs, nothing else', () => {
    const execLogsBlock = preloadSource.match(/execLogs:\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(execLogsBlock).toContain('list:');
    expect(execLogsBlock).toContain('statuses:');
    expect(execLogsBlock).not.toMatch(/\bwrite\s*:/);
    expect(execLogsBlock).not.toMatch(/\bsend\s*:/);
    expect(execLogsBlock).not.toMatch(/\bexec\s*:/);
    expect(execLogsBlock).not.toMatch(/\bspawn\s*:/);
    expect(execLogsBlock).not.toMatch(/\bretry\s*:/);
    expect(execLogsBlock).not.toMatch(/\bcancel\s*:/);
    expect(execLogsBlock).not.toMatch(/\bstdin\s*:/);
  });

  it('main.ts registers no execLogs IPC handler beyond list/statuses', () => {
    const execLogsHandlers = mainSource.match(/ipcMain\.handle\('execLogs:[^']*'/g) ?? [];
    expect(execLogsHandlers.sort()).toEqual(["ipcMain.handle('execLogs:list'", "ipcMain.handle('execLogs:statuses'"].sort());
  });

  it('the execution-log renderer component contains no input/textarea/PTY wiring', () => {
    const componentSource = fs.readFileSync(path.join(desktopRoot, 'src/components/BackendExecutionLogs.tsx'), 'utf8');
    expect(componentSource).not.toMatch(/<input/i);
    expect(componentSource).not.toMatch(/<textarea/i);
    expect(componentSource).not.toContain('execLogs.write');
    expect(componentSource).not.toContain('execLogs.send');
    expect(componentSource).not.toContain('execLogs.exec');
  });

  it('R31-4: the execution-log product inventory is sourced from the production registry, not a second hardcoded catalogue', () => {
    expect(mainSource).toContain('listSupportedProducts');
    expect(mainSource).toContain('backendExecutionLogService.setAllowedProducts');
    const componentSource = fs.readFileSync(path.join(desktopRoot, 'src/components/BackendExecutionLogs.tsx'), 'utf8');
    // P6.5 Part I: fetched once via the zero-CLI-probe backends:products
    // channel (not backends:capabilities, which is a real 4-backend
    // native CLI probe — polling it every 15s just for the product list
    // was a periodic-refresh source removed this pass).
    expect(componentSource).toContain('window.desktop.backends.products()');
    expect(componentSource).not.toMatch(/setInterval\([^)]*[Cc]apabilit/);
  });

  // R3.1.1: session-scoped log clearing is centralized on
  // RuntimeSupervisor's 'sessionStarting' event — the one seam both
  // runtime:start and runtime:restart (topbar Restart and Add Folder's
  // "Restart now" both call the same IPC channel) reach — rather than
  // duplicated per IPC handler (which is exactly how runtime:restart
  // previously bypassed clearing entirely: it calls
  // runtimeSupervisor.restart() directly, never runtime:start).
  it("R3.1.1: session-scoped log clearing happens exactly once, on RuntimeSupervisor's sessionStarting event, not duplicated in the runtime:start IPC handler", () => {
    const sessionStartingBlock = mainSource.match(/runtimeSupervisor\.on\('sessionStarting',[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(sessionStartingBlock).toContain('runtimeLogBuffer.clear()');
    expect(sessionStartingBlock).toContain('backendExecutionLogService.clear()');

    const runtimeStartBlock = mainSource.match(/ipcMain\.handle\('runtime:start',[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(runtimeStartBlock).not.toContain('runtimeLogBuffer.clear()');
    expect(runtimeStartBlock).not.toContain('backendExecutionLogService.clear()');
  });

  it('R3.1.1: RuntimeSupervisor emits sessionStarting before the real child process spawn, never after', () => {
    const supervisorSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/runtimeSupervisor.ts'), 'utf8');
    const emitIndex = supervisorSource.indexOf("this.emit('sessionStarting')");
    const spawnIndex = supervisorSource.indexOf("this.process = spawn(");
    expect(emitIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(emitIndex).toBeLessThan(spawnIndex);
  });
});

// P6-W3-R4 Part I: Connection Center V2's PM-profile editor and refresh
// surfaces stay closed, narrow, typed operations — never a generic
// exec/spawn/writeConfig(path, data) passthrough from the renderer, and
// the renderer never supplies an arbitrary executable path or config
// file path.
describe('P6-W3-R4 Connection Center V2 closed surfaces', () => {
  it('preload exposes only list/create/update on pmProfiles, no generic write', () => {
    const pmProfilesBlock = preloadSource.match(/pmProfiles:\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(pmProfilesBlock).toContain('list:');
    expect(pmProfilesBlock).toContain('create:');
    expect(pmProfilesBlock).toContain('update:');
    expect(pmProfilesBlock).not.toMatch(/\bwriteConfig\s*:/);
    expect(pmProfilesBlock).not.toMatch(/\bexec\s*:/);
    expect(pmProfilesBlock).not.toMatch(/\bspawn\s*:/);
    expect(pmProfilesBlock).not.toMatch(/\bdelete\s*:/);
    expect(pmProfilesBlock).not.toMatch(/\bpath\s*:/);
  });

  // P9-R0.4 Part D/X: deactivate/reactivate are a deliberate, reviewed
  // addition to this closed surface — SAFE lifecycle only (no delete, no
  // identity-editing handler exists).
  it('main.ts registers no pmProfiles IPC handler beyond list/create/update/deactivate/reactivate', () => {
    const pmProfilesHandlers = mainSource.match(/ipcMain\.handle\('pmProfiles:[^']*'/g) ?? [];
    expect(pmProfilesHandlers.sort()).toEqual(
      ["ipcMain.handle('pmProfiles:list'", "ipcMain.handle('pmProfiles:create'", "ipcMain.handle('pmProfiles:update'", "ipcMain.handle('pmProfiles:deactivate'", "ipcMain.handle('pmProfiles:reactivate'"].sort(),
    );
  });

  it('main.ts never registers a pmProfiles delete/remove IPC handler (Part E: no hard delete)', () => {
    expect(mainSource).not.toMatch(/ipcMain\.handle\('pmProfiles:(delete|remove)'/);
  });

  it('the PM profile config service never accepts a renderer-supplied file path — its constructor path args are fixed at construction time in main.ts', () => {
    const serviceSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/pmProfileConfigService.ts'), 'utf8');
    expect(serviceSource).not.toMatch(/create\([^)]*path/i);
    expect(serviceSource).not.toMatch(/update\([^)]*path/i);
    expect(mainSource).toMatch(/new PmProfileConfigService\(/);
  });

  it('the PM profile config service never exposes NATIVE_SESSION from this surface', () => {
    const serviceSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/pmProfileConfigService.ts'), 'utf8');
    expect(serviceSource).toContain("SUPPORTED_SESSION_KINDS = ['STATELESS']");
  });

  it('connections:onChanged is a push-only subscription, never a write channel', () => {
    const connectionsBlock = preloadSource.match(/connections:\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(connectionsBlock).toContain('onChanged:');
    expect(connectionsBlock).not.toMatch(/\bwrite\s*:/);
    expect(connectionsBlock).not.toMatch(/\bexec\s*:/);
  });
});

// P6-W3-R4.1 Part R41-3/R41-9(16): the new per-backend refresh surface
// (backends:capability) stays exactly as narrow as backends:capabilities —
// a product *name*, never an executable path, argv array, or arbitrary
// options object.
describe('P6-W3-R4.1 per-backend refresh closed surface', () => {
  it('preload exposes exactly capabilities/capability on backends, no generic exec', () => {
    const backendsBlock = preloadSource.match(/backends:\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(backendsBlock).toContain('capabilities:');
    expect(backendsBlock).toContain('capability:');
    expect(backendsBlock).not.toMatch(/\bexec\s*:/);
    expect(backendsBlock).not.toMatch(/\bspawn\s*:/);
    expect(backendsBlock).not.toMatch(/\bbinary\s*:/);
    expect(backendsBlock).not.toMatch(/\bargv\s*:/);
  });

  // P11-R1: `backends:apiProviderLive` is the one deliberate addition to
  // this closed set — same narrow shape as `backends:capability` (a single
  // string param, `providerId`, never an executable path/argv/options
  // object — the first test in this describe block already guards that no
  // exec/spawn/binary/argv surface exists on the `backends` preload block
  // at all), and it is the ONE explicit, owner-triggered, single-provider
  // live HTTP probe (never on a timer — see api-provider-readiness.mjs).
  // P11-R4.1 Part F-J: `backends:updateApiKey` is the ONE further addition
  // — two string params (`providerId`, `value`), never a generic env-var
  // setter; see the dedicated tests below for its provider allowlist and
  // secret-shape guarantees.
  it('main.ts registers only the closed capability and owner-triggered API discovery/update handlers', () => {
    const backendsHandlers = mainSource.match(/ipcMain\.handle\('backends:[^']*'/g) ?? [];
    expect(backendsHandlers.sort()).toEqual(["ipcMain.handle('backends:capabilities'", "ipcMain.handle('backends:capability'", "ipcMain.handle('backends:products'", "ipcMain.handle('backends:apiProviderLive'", "ipcMain.handle('backends:apiProviderModels'", "ipcMain.handle('backends:updateApiKey'"].sort());
  });
});

// P11-R4.1 Part F/H/I/AK: the trusted OpenRouter key-update surface — the
// renderer never receives the current key, the value is never echoed back
// in the result, the write path is scoped to 'openrouter' only, and the
// handler source contains no console logging of the value.
describe('P11-R4.1 Update API Key closed surface', () => {
  it('preload exposes updateApiKey as a two-string-argument call, no generic env setter', () => {
    const backendsBlock = preloadSource.match(/backends:\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(backendsBlock).toContain('updateApiKey:');
    expect(backendsBlock).not.toMatch(/setEnv|writeEnv|process\.env/);
  });

  it('backends:updateApiKey handler rejects every providerId except openrouter before writing, and never echoes the value in a returned object', () => {
    const handlerBlock = mainSource.match(/ipcMain\.handle\('backends:updateApiKey'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(handlerBlock).toMatch(/providerId\s*!==\s*'openrouter'/);
    expect(handlerBlock).not.toMatch(/console\.(log|info)\(/);
    // Every literal object this handler returns must never carry a `value`
    // field — the only success/error shapes are `{ok, code?, message?}`,
    // and the real update result is passed straight through from
    // apiKeyUpdateService (never wrapped with the raw args.value alongside).
    const returnedObjectLiterals = handlerBlock.match(/return\s*\{[^}]*\}/g) ?? [];
    for (const literal of returnedObjectLiterals) expect(literal).not.toMatch(/\bvalue\s*:/);
  });

  it('apiKeyUpdateService never logs or returns the secret value', () => {
    const serviceSource = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/apiKeyUpdateService.ts'), 'utf8');
    expect(serviceSource).not.toMatch(/console\.(log|info|warn|error)\([^)]*value/);
    // The only success shape is `{ ok: true }` — no key/value field ever
    // travels back out of updateOpenRouterKeyInEnvFile.
    expect(serviceSource).toMatch(/return\s*\{\s*ok:\s*true\s*\}/);
  });
});

function readTree(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? readTree(absolute) : fs.readFileSync(absolute, 'utf8');
  }).join('\n');
}
