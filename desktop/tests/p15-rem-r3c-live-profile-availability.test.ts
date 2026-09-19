import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// P15-REM-R3-C (P15-D-003, docs/p15-rem/04_*.md): a real end-to-end proof
// that Desktop's `pm:profiles` IPC handler now queries the runtime's LIVE
// readiness on every call, instead of RuntimeSupervisor's cached
// startup-time snapshot. Reuses the exact main.ts boot harness technique
// startupIpcRace.test.ts already established (mock `electron` + every
// service main.ts constructs, capture real `ipcMain.handle` callbacks, call
// them directly) — the ONE difference here is a fully-controllable
// RuntimeSupervisor stub whose `getReadiness()` (stale) and
// `getPipeClient()->readinessDetails()` (live) can be set to DIFFERENT
// values per test, so the fix (not just the pre-existing merge logic) is
// what each assertion actually proves.

let order: string[];
let ipcHandlers: Map<string, (...args: any[]) => any>;

// Controllable per-test RuntimeSupervisor state.
let cachedReadiness: any;
let livePipeClient: { readinessDetails: () => Promise<any> } | null;
let pmProfileEntries: any[];

function resetAllSharedState() {
  order = [];
  ipcHandlers = new Map();
  cachedReadiness = { pmProfiles: { backends: [] } };
  livePipeClient = null;
  pmProfileEntries = [];
}

vi.mock('electron', () => {
  const app = {
    requestSingleInstanceLock: () => true,
    getPath: () => '/tmp/dsh-r3c-live-profile-test',
    on: () => {},
    whenReady: () => Promise.resolve(),
    relaunch: () => {},
    exit: () => {},
    quit: () => {},
  };
  class BrowserWindow {
    webContents = { session: { webRequest: { onHeadersReceived: (_cb: Function) => {} } }, openDevTools: () => {}, send: () => {} };
    constructor() { order.push('window:created'); }
    loadFile() { order.push('window:loadFile'); return Promise.resolve(); }
    loadURL() { order.push('window:loadURL'); return Promise.resolve(); }
    on() {}
    isMinimized() { return false; }
    isVisible() { return true; }
    restore() {}
    show() {}
    hide() {}
    focus() {}
  }
  const ipcMain = {
    handle: (channel: string, fn: (...args: any[]) => any) => { ipcHandlers.set(channel, fn); order.push(`handle:${channel}`); },
  };
  class Tray { constructor() {} setContextMenu() {} on() {} }
  const Menu = { buildFromTemplate: () => ({}) };
  const nativeImage = { createFromDataURL: () => ({}) };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) };
  return { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog };
});

vi.mock('../electron/main/services/envBootstrap', () => ({
  computeBootstrapStatus: () => ({
    requiresFirstRun: false,
    status: { repoRoot: { state: 'CONFIGURED', path: '/fake/repo', source: 'setting' }, productionConfig: { state: 'CONFIGURED', path: '/fake/repo/local-config.production.yaml', source: 'dev-fallback' }, envFile: { state: 'NOT_CONFIGURED', path: null, source: null }, requiredEnvNames: [], readyToStart: true },
  }),
  loadEnvFile: () => ({}),
}));

vi.mock('../electron/main/services/desktopSettingsStore', () => ({
  DesktopSettingsStore: class { get() { return {}; } setRepoRoot() {} setProductionConfigPath() {} setEnvFilePath() {} },
}));

// The one service under test: getReadiness()/getPipeClient() are driven by
// the module-level `cachedReadiness`/`livePipeClient` variables above, read
// fresh on every call — exactly like the real RuntimeSupervisor's own
// fields, just fully test-controllable instead of populated by a real pipe.
vi.mock('../electron/main/services/runtimeSupervisor', () => ({
  RuntimeSupervisor: class {
    constructor() {}
    on() {}
    getStatus() { return { state: 'RUNNING', pid: 123, uptime: 1, lastError: null }; }
    getReadiness() { return cachedReadiness; }
    getPipeClient() { return livePipeClient; }
    async initialize() { order.push('services:initialize:start'); order.push('services:initialize:done'); }
    async start() {}
    async stop() {}
    async restart() {}
    async forceStop() {}
  },
}));

vi.mock('../electron/main/services/readProjection', () => ({ ReadProjection: class { constructor() {} async initialize() {} async close() {} async getProjects() { return []; } } }));
vi.mock('../electron/main/services/outboxStore', () => ({ OutboxStore: class { constructor() {} } }));
vi.mock('../electron/main/services/ownerCommandService', () => ({ OwnerCommandService: class { constructor() {} async replayIncomplete() {} } }));
vi.mock('../electron/main/services/projectRegistry', () => ({ ProjectRegistryService: class { constructor() {} }, createNodeConfigValidator: () => (() => ({ valid: true })) }));
vi.mock('../electron/main/services/pmProfileConfigService', () => ({ PmProfileConfigService: class { constructor() {} list() { return pmProfileEntries; } } }));
vi.mock('../electron/main/services/authEvidenceStore', () => ({ AuthEvidenceStore: class { constructor() {} } }));

let boot: () => Promise<void>;

beforeAll(async () => {
  resetAllSharedState();
  const mod = await import('../electron/main/main');
  boot = mod.boot;
  await vi.waitFor(() => expect(order.length).toBeGreaterThan(0));
});

beforeEach(() => {
  resetAllSharedState();
});

async function bootMain() {
  order = [];
  await boot();
  await vi.waitFor(() => expect(order).toContain('services:initialize:done'));
}

describe('P15-REM-R3-C (P15-D-003): pm:profiles queries live runtime readiness, not a stale startup snapshot', () => {
  it('a hot-created profile absent from the cached snapshot but present in a live readiness query is reported available', async () => {
    pmProfileEntries = [{ id: 'pm-hot-created', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', status: 'ACTIVE' }];
    // RED shape: the cached snapshot (what getReadiness() alone would have
    // reported, pre-fix) has NO entry for this profile at all — exactly
    // what a startup-time-only snapshot looks like for a profile that did
    // not exist yet when the runtime started.
    cachedReadiness = { pmProfiles: { backends: [] } };
    // GREEN shape: the runtime's live pmBackendStatus (queried fresh via
    // the pipe, per REM-R2's already-fixed reloadPmProfiles() push) DOES
    // know about it.
    livePipeClient = { readinessDetails: async () => ({ ready: true, pmProfiles: { backends: [{ profile_id: 'pm-hot-created', available: true }] } }) };

    await bootMain();
    const handler = ipcHandlers.get('pm:profiles')!;
    const result = await handler();
    expect(result).toEqual([expect.objectContaining({ id: 'pm-hot-created', available: true })]);
  });

  it('RED regression guard: if the handler only ever consulted the cached snapshot, the same profile would report unavailable', async () => {
    // This test documents the exact pre-fix mechanism by exercising the
    // cached snapshot ALONE (no live pipe client at all — the STOPPED/
    // unreachable shape) — proving the fallback path still correctly
    // reports "unavailable" for a profile genuinely absent from every known
    // source, i.e. the merge logic itself is unchanged; only the PRIMARY
    // source changed from cached to live.
    pmProfileEntries = [{ id: 'pm-hot-created', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', status: 'ACTIVE' }];
    cachedReadiness = { pmProfiles: { backends: [] } };
    livePipeClient = null; // runtime unreachable right now -> falls back to cached
    await bootMain();
    const handler = ipcHandlers.get('pm:profiles')!;
    const result = await handler();
    expect(result).toEqual([expect.objectContaining({ id: 'pm-hot-created', available: false })]);
  });

  it('a hot-removed/disabled profile is absent from BOTH the definition list and the availability map (converges with Telegram)', async () => {
    // pmProfileConfigService.list() is already read fresh every call
    // (pre-existing, unchanged) — a profile no longer ACTIVE never reaches
    // the returned array regardless of what readiness reports.
    pmProfileEntries = [];
    cachedReadiness = { pmProfiles: { backends: [{ profile_id: 'pm-removed', available: true }] } };
    livePipeClient = { readinessDetails: async () => ({ ready: true, pmProfiles: { backends: [{ profile_id: 'pm-removed', available: true }] } }) };
    await bootMain();
    const handler = ipcHandlers.get('pm:profiles')!;
    const result = await handler();
    expect(result).toEqual([]);
  });

  it('a live pipe query that throws (transient control-pipe hiccup) falls back to the last-known cached snapshot rather than reporting every profile unavailable', async () => {
    pmProfileEntries = [{ id: 'pm-x', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', status: 'ACTIVE' }];
    cachedReadiness = { pmProfiles: { backends: [{ profile_id: 'pm-x', available: true }] } };
    livePipeClient = { readinessDetails: async () => { throw new Error('pipe hiccup'); } };
    await bootMain();
    const handler = ipcHandlers.get('pm:profiles')!;
    const result = await handler();
    expect(result).toEqual([expect.objectContaining({ id: 'pm-x', available: true })]);
  });

  it('a backend genuinely unavailable (auth failure / CLI missing) converges to unavailable via the live query', async () => {
    pmProfileEntries = [{ id: 'pm-broken', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS', status: 'ACTIVE' }];
    cachedReadiness = { pmProfiles: { backends: [{ profile_id: 'pm-broken', available: true }] } }; // stale: it WAS available at startup
    livePipeClient = { readinessDetails: async () => ({ ready: false, pmProfiles: { backends: [{ profile_id: 'pm-broken', available: false, code: 'PM_BACKEND_AUTH_FAILED' }] } }) };
    await bootMain();
    const handler = ipcHandlers.get('pm:profiles')!;
    const result = await handler();
    expect(result).toEqual([expect.objectContaining({ id: 'pm-broken', available: false })]);
  });
});
