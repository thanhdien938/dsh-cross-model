import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { parse } from 'yaml';
import { RuntimeSupervisor } from './services/runtimeSupervisor';
import { ReadProjection } from './services/readProjection';
import { OutboxStore } from './services/outboxStore';
import { OwnerCommandService, OwnerCommandInput } from './services/ownerCommandService';
import { ProjectRegistryService, createNodeConfigValidator } from './services/projectRegistry';
import { PmProfileConfigService } from './services/pmProfileConfigService';
import { AuthEvidenceStore } from './services/authEvidenceStore';
import { scanPmRunsForAuthEvidence } from './services/authEvidenceScanner';
import { LoginTerminalSession } from './services/loginTerminalService';
import { RuntimeLogBuffer } from './services/runtimeLogBuffer';
import { BackendExecutionLogService } from './services/backendExecutionLogService';
import { RuntimeStatus, Connection } from './types';
import { setResolvedRepoRoot, isValidDshRepoRoot } from './repoRoot';
import { importEsmModule } from './dynamicImport';
import { DesktopSettingsStore } from './services/desktopSettingsStore';
import { loadEnvFile, computeBootstrapStatus, BootstrapStatus } from './services/envBootstrap';
import { updateOpenRouterKeyInEnvFile } from './services/apiKeyUpdateService';
import { readPmProfileAliases } from './services/telegramAliasReader';
import { buildSubmitTaskPayload } from './services/submitTaskPayload';
import { errorResult } from './services/projectionResult';
import { RelayRunnerLifecycleManager, RelayRunnerStatus } from './services/relayRunnerLifecycleManager';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtimeSupervisor: RuntimeSupervisor | null = null;
let readProjection: ReadProjection | null = null;
let outboxStore: OutboxStore | null = null;
let ownerCommandService: OwnerCommandService | null = null;
let projectRegistry: ProjectRegistryService | null = null;
let pmProfileConfigService: PmProfileConfigService | null = null;
// R31-4-style: lazily resolved once, from the same static zero-I/O export
// listSupportedProducts() already uses for the execution-log allowlist —
// never a second hardcoded product list.
let listSupportedPmProducts: (() => Promise<string[]>) | null = null;
// P9-R0.4 Part A/B: the ONE canonical PM-profile display-label formatter
// (src/pm/pm-profile-display.mjs) — every profile-bearing IPC response
// (pmProfiles:list, pm:profiles) attaches `displayLabel` computed here so
// no renderer surface ever invents its own "backend · model · reasoning"
// string.
let formatPmProfileDisplayLabel: ((profile: { product: string; model?: string | null; reasoning?: string | null }) => Promise<string>) | null = null;
let authEvidenceStore: AuthEvidenceStore | null = null;
// Dynamically imported once: the root workspace's execution-failure
// classifier is an ESM (.mjs) module and desktop's electron main compiles
// to CommonJS, so it must be loaded via `import()` rather than `require`.
let classifyExecutionFailure: ((error: unknown) => { classification: string | null }) | null = null;
let activeLoginTerminal: LoginTerminalSession | null = null;
let pmBackendRegistry: { capabilities: (options?: { mode?: string }) => Promise<any[]>; capability: (product: string, options?: { mode?: string }) => Promise<any>; probeApiProviderLive?: (providerId: string) => Promise<unknown>; discoverApiProviderModels?: (providerId: string) => Promise<unknown> } | null = null;
// P11-R1: resolved once during initializeServices() (same config-parse
// pass as pmProfilesPath below), consumed lazily by getPmBackendRegistry()
// on its first real call. `null` (the default for every deployment that
// hasn't configured `api_providers_file`) means "no API providers" — never
// a startup failure (see loadApiProviderConfig()'s own optional-path
// contract, src/pm/api-backend/api-provider-config.mjs).
let apiProvidersPath: string | null = null;
// P11-R4.2 Part E/F/N: module-level, same lifetime/reassignment pattern as
// apiProvidersPath above — set once per bootstrap in initializeServices(),
// read fresh on every pmProfiles:list() call via telegramAliasReader.ts.
let telegramAliasesPathGlobal: string | null = null;
const runtimeLogBuffer = new RuntimeLogBuffer();
// P6-W3-R3 Part B: read-only, non-authoritative, per-backend execution-log
// ring buffers (see backendExecutionLogService.ts docstring). Fed from the
// exact same runtime 'log' stream RuntimeLogBuffer already consumes —
// no new process-boundary plumbing.
const backendExecutionLogService = new BackendExecutionLogService();
let desktopSettingsStore: DesktopSettingsStore | null = null;
let relayRunnerLifecycleManager: RelayRunnerLifecycleManager | null = null;
// M01/M02: computed once at startup from settings + env. When
// `requiresFirstRun` is true, no repo-root-dependent service is
// constructed at all — the renderer is expected to show the first-run
// bootstrap screen (driven by `bootstrap:status`) instead of the normal
// UI until the owner configures a valid root and restarts.
let bootstrapStatus: BootstrapStatus | null = null;
let requiresFirstRun = false;

// Selected vs. armed (W2-C): selection only changes the read-only view;
// exactly one project may be armed, and arming is never implicit. Every
// project-scoped write path checks this before dispatch, independent of
// whatever the renderer currently displays.
let armedProjectId: string | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    const window = mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // P7-R0.1: the main process must own IPC readiness — the renderer must
  // never be able to reach a preload-exposed channel before its handler is
  // registered. `createWindow()` starts loading the renderer immediately
  // (loadFile/loadURL), and App.tsx's top-level bootstrap gate calls
  // `window.desktop.bootstrap.status()` from a useEffect the instant it
  // mounts — so IPC handlers must exist BEFORE the window is created, not
  // "soon after". `initializeBootstrapState()` computes only the minimal,
  // synchronous state `bootstrap:status` needs to answer truthfully (no
  // file I/O beyond the same small settings read that handler already does
  // on every subsequent poll); `setupIpcHandlers()` registers every
  // channel next — every handler body closes over the module-level `let`
  // bindings below (runtimeSupervisor/readProjection/etc.) and resolves
  // them at CALL time, so registering the handler functions before those
  // services exist is safe by construction; the heavier async work in
  // `initializeServices()` continues to run only after the window is
  // already loading, exactly as it did before this fix — this preserves
  // P6.5 (nothing that used to run async before first paint became
  // synchronous or moved earlier).
  app.whenReady().then(boot);
}

// Named + exported purely so tests/startupIpcRace.test.ts can drive this
// exact sequence directly (repeatedly, with different mocked bootstrap-
// state/delay scenarios) without needing vi.resetModules() between runs —
// resetting the module registry inside one test file has been observed to
// corrupt native (.node) addon loading for OTHER test files that later
// share the same worker (better-sqlite3 in authEvidence.test.ts/
// outboxStore.test.ts). Behavior is unchanged: the real app still only
// ever calls this once, from app.whenReady().then(boot) above.
export async function boot() {
  initializeBootstrapState();
  setupIpcHandlers();
  createWindow();
  createTray();
  // Runner lifecycle is auxiliary: it initializes alongside, never ahead
  // of or as a prerequisite for the existing DSH runtime services.
  const runnerInitialization = initializeRelayRunnerService();
  await initializeServices();
  await runnerInitialization;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#F7F4EF',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  // Set CSP
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https:; " +
          "font-src 'self'; " +
          "connect-src 'self';"
        ],
      },
    });
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/index.html'));
  }

  mainWindow.on('close', (event) => {
    if (runtimeSupervisor && runtimeSupervisor.getStatus().state === 'RUNNING') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Create a simple tray icon (you should replace this with an actual icon file)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFZSURBVDiNpZO/S8NAGMWf76JJY2OTWqVYEQdx0MHBQXDQyT/AwcFRcHMRwT/BwUVwcnBwEBwcHBycXBwEB0UQBxGEDg5WaNNfaX7Y5hyS0lZb+uBguLvv4/HxHY4QQmCVMMYKhBCHMXZVSh0BGJZS3gPo6MFGS8uy7gGcA+gDaADYUErtAJiWUt4D+NKD+RljxwCOAAhCyAsAJ4RQSqkDQGutXwHM/g1Ya30F4BbAnRDiXGs9hHGnhJCvUko+hTEWRVHkxnFsWZbFwzAkhBCitU6UUjkAfQBNAG0ALQDPAN4AvGutGwAGOeestW4CaAPYBrAF4BDAPoAdADkAEwAjrfUEwBuAzwVxHMdWGIbF9rrd7l0QBP1UT4iqqn6/329VVfXBcZxKWVWVa9s2dV2X+r5P0zSlSZKQJElIHMdkZtZa65RSqpRSSqm0LOtvJZ8/8weNy47NU6pkTgAAAABJRU5ErkJggg=='
  );
  
  tray = new Tray(icon);
  
  updateTrayMenu();
  
  tray.on('click', () => {
    if (!mainWindow) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const status = runtimeSupervisor?.getStatus();
  const isRunning = status?.state === 'RUNNING';

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open DSH Desktop', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    { 
      label: `Runtime: ${status?.state || 'UNKNOWN'}`,
      enabled: false,
    },
    { 
      label: 'Stop Runtime',
      enabled: isRunning,
      click: async () => {
        try {
          await runtimeSupervisor?.stop();
        } catch (error) {
          console.error('Failed to stop runtime:', error);
        }
      }
    },
    { type: 'separator' },
    { 
      label: 'Exit Desktop', 
      click: async () => {
        if (isRunning) {
          const { dialog } = require('electron');
          const result = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Cancel', 'Stop Runtime and Exit'],
            defaultId: 0,
            title: 'Runtime is Running',
            message: 'DSH runtime is currently active. Exiting will stop all running tasks.',
          });

          if (result.response === 1) {
            await runtimeSupervisor?.forceStop();
            app.quit();
          }
        } else {
          app.quit();
        }
      }
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// P7-R0.1: the minimal, purely synchronous state `bootstrap:status` needs
// to answer correctly on its very first call — no file I/O beyond what that
// handler already repeats on every later poll (M08), no async work, no
// dependency on repoRoot/env/production config. Called once, before
// setupIpcHandlers()/createWindow(), so bootstrap:status is never answered
// from the (requiresFirstRun=false, bootstrapStatus=null) placeholder
// defaults declared above — its first real answer is already correct.
function initializeBootstrapState() {
  desktopSettingsStore = new DesktopSettingsStore(app.getPath('userData'));
  relayRunnerLifecycleManager = new RelayRunnerLifecycleManager(desktopSettingsStore);
  // M08: computeBootstrapStatus (envBootstrap.ts) reads settings live —
  // the exact same call the bootstrap:status IPC handler below makes on
  // every poll, so there is exactly one authoritative computation path,
  // not a startup-only copy and a separate live copy that could drift.
  const bootstrap = computeBootstrapStatus(desktopSettingsStore);
  requiresFirstRun = bootstrap.requiresFirstRun;
  bootstrapStatus = bootstrap.status;
}

async function initializeRelayRunnerService(): Promise<void> {
  if (!relayRunnerLifecycleManager) return;
  relayRunnerLifecycleManager.on('statusChanged', (status: RelayRunnerStatus) => {
    mainWindow?.webContents.send('relayRunner:statusChanged', status);
  });
  // Main-module integration tests exercise boot with mocked Electron but
  // intentionally do not control the host's real Windows runner. Focused
  // lifecycle tests inject complete fake filesystem/process adapters.
  if (process.env.VITEST) return;
  try {
    await relayRunnerLifecycleManager.initialize();
    // P1: self-healing starts only after the first real initialize() —
    // never ahead of it, and never if initialize() itself failed safely
    // below (a failed initial probe should not also start a monitor loop
    // against state that was never established).
    relayRunnerLifecycleManager.startHealthMonitor();
  } catch (error) {
    // Frozen failure boundary: runner inspection/startup can never prevent
    // Desktop or the DSH runtime from initializing.
    console.error('GitHub relay runner initialization failed safely:', error);
  }
}

async function initializeServices() {
  // Bootstrap state is already computed by initializeBootstrapState(),
  // called before this (and before the renderer window even loads) — see
  // the app.whenReady() ordering above.
  if (requiresFirstRun) {
    console.error('DSH repo root is not configured. Showing first-run bootstrap.');
    return;
  }

  // Non-null by construction: requiresFirstRun is only false once
  // initializeBootstrapState() has successfully computed a real
  // BootstrapStatus (see envBootstrap.ts's computeBootstrapStatus()).
  const status = bootstrapStatus!;
  const repoRoot = status.repoRoot.path!;
  setResolvedRepoRoot(repoRoot);
  // The one place .env actually gets merged into this process's real
  // env — once, at real service-initialization time, never repeated on a
  // status poll.
  const loadedEnv = loadEnvFile(status.envFile.path);
  for (const [key, value] of Object.entries(loadedEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  // May be null if productionConfig is MISSING; RuntimeSupervisor still
  // constructs (readiness/status remain queryable), but runtime:start is
  // already gated on bootstrapStatus.readyToStart above and will refuse
  // before ever reaching a missing config path.
  const productionConfigPath = status.productionConfig.path ?? path.join(repoRoot, 'local-config.production.yaml');
  runtimeSupervisor = new RuntimeSupervisor(repoRoot, productionConfigPath);
  readProjection = new ReadProjection(repoRoot, productionConfigPath, backendExecutionLogService);
  outboxStore = new OutboxStore(app.getPath('userData'));
  ownerCommandService = new OwnerCommandService(
    outboxStore,
    () => runtimeSupervisor?.getPipeClient() ?? null,
    () => armedProjectId,
  );

  authEvidenceStore = new AuthEvidenceStore(app.getPath('userData'));
  try {
    const classifierModule = await importEsmModule(path.join(repoRoot, 'src', 'orchestration', 'execution-failure-classifier.mjs'));
    classifyExecutionFailure = classifierModule.classifyExecutionFailure;
  } catch (error) {
    console.error('Failed to load execution failure classifier; auth evidence stays UNKNOWN-only:', error);
  }

  // R31-4: the one authoritative source for which products get an
  // execution-log buffer — a static, zero-I/O export (no CLI probing),
  // never a second hardcoded catalogue in Desktop or React. Falls back to
  // BackendExecutionLogService's built-in default set (identical to this
  // today) if the module can't be loaded for any reason; a product never
  // loses an already-registered buffer, this only ever adds coverage.
  try {
    const registryModule = await importEsmModule(path.join(repoRoot, 'src', 'pm', 'production-pm-backend-registry.mjs'));
    backendExecutionLogService.setAllowedProducts(registryModule.listSupportedProducts());
  } catch (error) {
    console.error('Failed to load supported backend product list; execution logs keep their built-in default set:', error);
  }

  const configPath = status.productionConfig.path;
  let projectsPath = configPath ?? repoRoot;
  // P6-W3-R4 Part D: resolved from the same production config parse Add
  // Folder already does for projects_file — one read, not a second file
  // I/O round trip. Falls back to a sibling pm-profiles.yaml next to the
  // config (or the repo root) if the key is absent, matching how
  // projectsPath already falls back.
  let pmProfilesPath = configPath ? path.join(path.dirname(configPath), 'pm-profiles.yaml') : repoRoot;
  // P11-R4.2 Part E/F/N: mirrors pm_profiles_file's resolution/fallback
  // exactly, including the SAME default (a sibling `telegram-aliases.yaml`)
  // src/runtime/p5-production-config.mjs's loadP5ProductionConfig() itself
  // falls back to when `telegram_aliases_file` is omitted — so Desktop
  // reads the identical file the running runtime reconciles into, never a
  // second/guessed location.
  telegramAliasesPathGlobal = configPath ? path.join(path.dirname(configPath), 'telegram-aliases.yaml') : null;
  if (configPath) {
    try {
      const config = parse(fs.readFileSync(configPath, 'utf8'));
      if (config?.projects_file) projectsPath = path.resolve(path.dirname(configPath), config.projects_file);
      if (config?.pm_profiles_file) pmProfilesPath = path.resolve(path.dirname(configPath), config.pm_profiles_file);
      if (config?.telegram_aliases_file) telegramAliasesPathGlobal = path.resolve(path.dirname(configPath), config.telegram_aliases_file);
      // P11-R1: OPTIONAL, mirrors pm_profiles_file above — absent by
      // default (apiProvidersPath stays null), never a config error on its
      // own; loadApiProviderConfig() degrades a null path to "no providers"
      // rather than throwing.
      if (config?.api_providers_file) apiProvidersPath = path.resolve(path.dirname(configPath), config.api_providers_file);
    } catch {
      // Config present but unreadable/invalid; Add Folder will fail closed
      // with a typed error, exactly like RuntimeSupervisor.start() already does.
    }
  }
  const fullConfigPathForValidation = configPath ?? path.join(repoRoot, 'local-config.production.yaml');
  const configValidator = createNodeConfigValidator('node', path.join(repoRoot, 'scripts', 'validate-p5-config.mjs'));
  projectRegistry = new ProjectRegistryService(projectsPath, fullConfigPathForValidation, configValidator);
  listSupportedPmProducts = async () => {
    try {
      const registryModule = await importEsmModule(path.join(repoRoot, 'src', 'pm', 'production-pm-backend-registry.mjs'));
      return registryModule.listSupportedProducts();
    } catch {
      // P11-R0: kept in sync with SUPPORTED in production-pm-backend-
      // registry.mjs — only reached if the dynamic import above fails.
      return ['claude-code', 'opencode', 'codex', 'grok', 'antigravity', 'api'];
    }
  };
  // P9-R0.3 Part F: the one real resolver for PmProfileConfigService's
  // trusted Antigravity model/reasoning guard — dynamically imports the
  // exact same pure function (deriveAntigravityReasoningFromModel)
  // production execution and Connection Center already derive from, so
  // the guard can never enforce a rule the CLI doesn't actually have.
  // Degrades to "no tier recognized" (never rejects, never invents) only
  // if the bridge module genuinely can't be loaded — the same fail-open-
  // to-permissive posture listSupportedPmProducts above already uses for
  // its own dynamic import.
  const deriveAntigravityReasoning = async (model: string | null): Promise<string | null> => {
    try {
      const bridgeModule = await importEsmModule(path.join(repoRoot, 'src', 'session', 'antigravity-cli-session-bridge.mjs'));
      return bridgeModule.deriveAntigravityReasoningFromModel(model);
    } catch {
      return null;
    }
  };
  // P9-R0.4.1 Part A: the one real resolver for PmProfileConfigService's
  // trusted create-time semantic-duplicate guard — dynamically imports the
  // exact same pure function (executionIdentityKey) tests/diagnostics use,
  // so "what counts as a duplicate" is never defined twice. Its default
  // parameter (see pmProfileConfigService.ts) is byte-for-byte the same
  // algorithm, so a failed dynamic import degrades to identical behavior
  // rather than skipping the guard.
  const computeExecutionIdentityKey = async (profile: { role_kind: string; session_kind: string; product: string; provider?: string | null; transport: string; model: string | null; reasoning: string | null }): Promise<string> => {
    try {
      const identityModule = await importEsmModule(path.join(repoRoot, 'src', 'pm', 'pm-profile-identity.mjs'));
      return identityModule.executionIdentityKey(profile);
    } catch {
      return JSON.stringify([profile.role_kind ?? null, profile.session_kind ?? null, profile.product ?? null, profile.provider ?? null, profile.transport ?? null, profile.model ?? null, profile.reasoning ?? null]);
    }
  };
  pmProfileConfigService = new PmProfileConfigService(pmProfilesPath, fullConfigPathForValidation, configValidator, () => listSupportedPmProducts!(), deriveAntigravityReasoning, computeExecutionIdentityKey);
  // P9-R0.4 Part A: same lazy-dynamic-import posture as
  // deriveAntigravityReasoning above — degrades to a plain, still-correct
  // fallback label (never throws, never blocks a profile from rendering)
  // only if the display-helper module genuinely can't be loaded.
  formatPmProfileDisplayLabel = async (profile) => {
    try {
      const displayModule = await importEsmModule(path.join(repoRoot, 'src', 'pm', 'pm-profile-display.mjs'));
      return displayModule.formatPmProfileLabel(profile);
    } catch {
      return `${profile.product} · ${profile.model ?? 'default/inherited'} · ${profile.reasoning ?? 'default/inherited'}`;
    }
  };

  await runtimeSupervisor.initialize();

  // P6-W3-R3.1.1: the one central lifecycle boundary for session-scoped,
  // ephemeral log presentation — fires exactly once per genuinely new
  // runtime child process, whether reached via runtime:start,
  // runtime:restart (topbar Restart and Add Folder's "Restart now" both
  // call the same IPC channel — see App.tsx's single handleRestart()),
  // or any future caller. Never fires on a rejected/no-op start attempt
  // (RuntimeSupervisor emits it only after every early guard has already
  // passed, immediately before the real spawn() call), so existing
  // evidence is never erased just because Start/Restart was clicked and
  // refused. Replaces the previous per-IPC-handler
  // runtimeLogBuffer.clear()/backendExecutionLogService.clear() pair,
  // which `runtime:restart` never reached at all (RuntimeSupervisor.
  // restart() calls stopImpl()/startImpl() directly, bypassing the
  // runtime:start IPC handler entirely) — the exact bug this centralizes
  // away rather than duplicating a second fix for.
  runtimeSupervisor.on('sessionStarting', () => {
    runtimeLogBuffer.clear();
    backendExecutionLogService.clear();
  });

  runtimeSupervisor.on('statusChanged', (status: RuntimeStatus) => {
    if (mainWindow) {
      mainWindow.webContents.send('runtime:statusChanged', status);
    }
    updateTrayMenu();
    // Whenever the pipe becomes reachable again (fresh start or a restart
    // after Add Folder), replay any outbox rows an earlier crash/disconnect
    // left incomplete, reusing their exact original command_id/payload.
    if (status.state === 'RUNNING') {
      void ownerCommandService?.replayIncomplete().catch(() => {});
    }
  });

  runtimeSupervisor.on('log', (log: string) => {
    runtimeLogBuffer.push(log);
    // Read-only side channel: scans the exact same text for
    // BackendExecutionObserver's sentinel-prefixed lines. Never mutates
    // `log`, never affects what RuntimeLogBuffer stores.
    backendExecutionLogService.ingest(log);
  });
}

// P7-R0.4 Part D: the single shared seam for refreshing the read-only
// project projection after an owner-driven, deterministic lifecycle event
// (Add Folder succeeding, or a runtime restart genuinely reaching
// readiness). Deliberately NOT a background watcher/poller — it only ever
// runs from an explicit, awaited call site, preserving the R4.2
// owner-driven-only refresh policy. Never throws: a reload failure keeps
// the prior in-memory project list (ReadProjection.reloadProjects()'s own
// keep-last-good-on-failure guarantee) and is only reported via the
// existing sanitized log path, never surfaced as an IPC rejection.
async function reloadProjectProjection(): Promise<void> {
  const reload = await readProjection?.reloadProjects();
  if (!reload) return;
  if (reload.ok) {
    console.error(`##DSH_RUNTIME_LIFECYCLE## ${JSON.stringify({ timestamp: new Date().toISOString(), stage: 'project_projection_reload_success', projectCount: reload.count })}`);
  } else {
    console.error(`##DSH_RUNTIME_LIFECYCLE## ${JSON.stringify({ timestamp: new Date().toISOString(), stage: 'project_projection_reload_failed', errorCode: reload.code })}`);
  }
}

function setupIpcHandlers() {
  // M01/M02 bootstrap. Available even when requiresFirstRun is true — this
  // is the one IPC surface the renderer can use before any other service
  // exists.
  // M08: always recomputed from current persisted settings — never the
  // immutable startup snapshot. A picker action (pickRepoRoot/
  // pickProductionConfig/pickEnvFile) only persists a setting; it is this
  // handler, called by the renderer's refresh() right afterward, that is
  // responsible for the next read reflecting it.
  ipcMain.handle('bootstrap:status', async () => {
    if (!desktopSettingsStore) return { requiresFirstRun, status: bootstrapStatus };
    const computed = computeBootstrapStatus(desktopSettingsStore);
    requiresFirstRun = computed.requiresFirstRun;
    bootstrapStatus = computed.status;
    return { requiresFirstRun, status: bootstrapStatus };
  });

  ipcMain.handle('bootstrap:pickRepoRoot', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select the DSH repository checkout' });
    if (result.canceled || !result.filePaths[0]) return null;
    const candidate = result.filePaths[0];
    if (!isValidDshRepoRoot(candidate)) {
      return { ok: false, code: 'INVALID_REPO_ROOT', message: 'That folder does not look like a DSH checkout (expected scripts/p5-runtime.mjs, src/, and package.json).' };
    }
    desktopSettingsStore?.setRepoRoot(candidate);
    return { ok: true, path: candidate, restartRequired: true };
  });

  ipcMain.handle('bootstrap:pickProductionConfig', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'YAML config', extensions: ['yaml', 'yml'] }], title: 'Select the production config file' });
    if (result.canceled || !result.filePaths[0]) return null;
    desktopSettingsStore?.setProductionConfigPath(result.filePaths[0]);
    return { ok: true, path: result.filePaths[0], restartRequired: true };
  });

  ipcMain.handle('bootstrap:pickEnvFile', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'showHiddenFiles'], title: 'Select the .env secrets file' });
    if (result.canceled || !result.filePaths[0]) return null;
    desktopSettingsStore?.setEnvFilePath(result.filePaths[0]);
    return { ok: true, path: result.filePaths[0], restartRequired: true };
  });

  // Bootstrap settings only take effect after initializeServices() runs
  // again from a clean process start — this is never silent (the renderer
  // only calls it from an explicit owner-clicked button), and is simpler
  // and safer than trying to hot-reinitialize every repo-root-dependent
  // service in place.
  ipcMain.handle('bootstrap:restartApp', async () => {
    app.relaunch();
    app.exit(0);
  });

  // Runtime operations
  ipcMain.handle('runtime:status', () => {
    return runtimeSupervisor?.getStatus();
  });

  ipcMain.handle('runtime:start', async () => {
    if (requiresFirstRun || !bootstrapStatus?.readyToStart) {
      throw new Error('DSH_BOOTSTRAP_REQUIRED');
    }
    // Session-scoped log clearing now happens exactly once, centrally, on
    // RuntimeSupervisor's 'sessionStarting' event (see initializeServices())
    // — the same seam runtime:restart reaches too.
    await runtimeSupervisor?.start();

    // Initialize read projection after runtime starts
    if (readProjection) {
      try {
        await readProjection.initialize();
      } catch (error) {
        console.error('Failed to initialize read projection:', error);
      }
    }
  });

  ipcMain.handle('runtime:stop', async () => {
    await runtimeSupervisor?.stop();
  });

  ipcMain.handle('runtime:restart', async () => {
    await runtimeSupervisor?.restart();
    // P7-R0.4 Part D/E: runtimeSupervisor.restart() only resolves once the
    // NEW child has genuinely reached readiness (RuntimeSupervisor emits
    // RUNNING only after waitForReadiness() succeeds — never on a
    // rejected/no-op restart, which throws before this line instead).
    // Reloading here, awaited, before this IPC call itself resolves, is
    // what makes the renderer's very next projects:list() call (App.tsx's
    // refreshData(), already invoked right after runtime.restart()) see the
    // fresh list deterministically — no race with a fire-and-forget
    // background reload. Mirrors runtime:start's existing
    // readProjection.initialize() call below, applied to restart via the
    // SAME reloadProjects() seam project:addFolder also uses — no
    // duplicated reload logic, one method, two call sites.
    await reloadProjectProjection();
  });

  ipcMain.handle('runtime:forceStop', async () => {
    await runtimeSupervisor?.forceStop();
  });

  // GitHub relay runner — a narrow typed lifecycle surface. There is no
  // generic command, path read, process query, or filesystem IPC.
  ipcMain.handle('relayRunner:getStatus', () => relayRunnerLifecycleManager?.getStatus() ?? null);
  ipcMain.handle('relayRunner:refresh', async () => relayRunnerLifecycleManager?.refresh() ?? null);
  ipcMain.handle('relayRunner:start', async () => relayRunnerLifecycleManager?.start() ?? null);
  ipcMain.handle('relayRunner:stop', async () => relayRunnerLifecycleManager?.stop() ?? null);
  ipcMain.handle('relayRunner:restart', async () => relayRunnerLifecycleManager?.restart() ?? null);
  ipcMain.handle('relayRunner:getLogs', () => relayRunnerLifecycleManager?.getLogs() ?? []);
  ipcMain.handle('relayRunner:updateSettings', async (_event, input: unknown) => relayRunnerLifecycleManager?.updateSettings(input) ?? null);
  ipcMain.handle('relayRunner:getHealth', () => relayRunnerLifecycleManager?.getHealth() ?? null);
  // P0-3: the ONLY way a runner path reaches the lifecycle manager. The
  // renderer sends no path value at all — it only requests that the
  // MAIN process show a native OS directory picker; the OS-selected path
  // is what gets validated and persisted, never renderer-supplied text.
  ipcMain.handle('relayRunner:pickFolder', async () => {
    if (!relayRunnerLifecycleManager) return null;
    if (!mainWindow) return { ok: false, status: relayRunnerLifecycleManager.getStatus(), code: 'RUNNER_PATH_PICK_UNAVAILABLE', message: 'No window is available to show the folder picker.' };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Select GitHub Actions runner folder',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, status: relayRunnerLifecycleManager.getStatus(), code: 'RUNNER_PATH_PICK_CANCELED', message: 'No folder was selected.' };
    }
    return relayRunnerLifecycleManager.configureRunnerPath(picked.filePaths[0]);
  });

  // Projects
  ipcMain.handle('projects:list', async () => {
    if (!readProjection) return [];
    try {
      return await readProjection.getProjects();
    } catch (error) {
      console.error('Failed to list projects:', error);
      return [];
    }
  });

  // Timeline
  // P15-REM-R3-G (P15-D-012): getTimeline() now returns a typed
  // ProjectionResult — pass it through verbatim.
  ipcMain.handle('timeline:get', async (_event, projectId: string | null, options: any) => {
    if (!readProjection) return errorResult([], 'PROJECTION_TIMELINE_UNAVAILABLE', new Error('runtime services are not initialized'));
    try {
      return await readProjection.getTimeline(projectId, options);
    } catch (error) {
      console.error('Failed to get timeline:', error);
      return errorResult([], 'PROJECTION_TIMELINE_UNAVAILABLE', error);
    }
  });

  // Owner interactions (approvals/questions). Global (projectId omitted) is
  // navigation-only in the renderer; project-scoped is the actionable view.
  //
  // P15-REM-R3-F (P15-D-014): getInbox() now returns a typed
  // ProjectionResult — pass it through verbatim rather than unwrapping to a
  // bare array, so a read failure is never indistinguishable from "no
  // approval pending" by the time it reaches the renderer. This handler's
  // OWN catch (an error thrown before getInbox() even ran, e.g. a
  // programming bug) is held to the exact same discipline — never `[]`.
  ipcMain.handle('inbox:list', async (_event, projectId: string | null) => {
    if (!readProjection) return errorResult([], 'PROJECTION_APPROVALS_UNAVAILABLE', new Error('runtime services are not initialized'));
    try {
      return await readProjection.getInbox(projectId);
    } catch (error) {
      console.error('Failed to get inbox:', error);
      return errorResult([], 'PROJECTION_APPROVALS_UNAVAILABLE', error);
    }
  });

  // Backend Runs inspector (W3-C).
  // P15-REM-R3-G (P14-A4-001): getBackendRuns() now returns a typed
  // ProjectionResult — pass it through verbatim.
  ipcMain.handle('runs:list', async (_event, projectId: string | null, options: any) => {
    if (!readProjection) return errorResult([], 'PROJECTION_BACKEND_RUNS_UNAVAILABLE', new Error('runtime services are not initialized'));
    try {
      return await readProjection.getBackendRuns(projectId, options ?? {});
    } catch (error) {
      console.error('Failed to list backend runs:', error);
      return errorResult([], 'PROJECTION_BACKEND_RUNS_UNAVAILABLE', error);
    }
  });

  // P15-REM-R3-G (P15-D-015): getMultiTaskStatus() now returns a typed
  // ProjectionResult — pass it through, never collapse to `null` (which
  // MultiTaskControl.tsx used to treat as "unmount the entire pane",
  // hiding every running/queued/awaiting-owner task from the owner on a
  // transient failure).
  const EMPTY_TASK_STATUS = { globalLimit: 0, activeCount: 0, queuedCount: 0, awaitOwnerCount: 0, observedAt: new Date(0).toISOString(), tasks: [] };
  ipcMain.handle('tasks:runtimeStatus', async () => {
    if (!readProjection) return errorResult(EMPTY_TASK_STATUS, 'PROJECTION_TASK_STATUS_UNAVAILABLE', new Error('runtime services are not initialized'));
    const pipe = runtimeSupervisor?.getPipeClient();
    if (!pipe) return errorResult(EMPTY_TASK_STATUS, 'PROJECTION_TASK_STATUS_UNAVAILABLE', new Error('runtime control pipe is not reachable'));
    try { return await readProjection.getMultiTaskStatus(await pipe.runtimeTaskStatus(), 30); }
    catch (error) { console.error('Failed to project runtime task status:', error); return errorResult(EMPTY_TASK_STATUS, 'PROJECTION_TASK_STATUS_UNAVAILABLE', error); }
  });

  // P7 Part M: Council panel — product-level surface, distinct from the
  // Backend Execution debug surface above. Read-only projection over the
  // same durable pm_runs a council already is.
  ipcMain.handle('council:list', async (_event, projectId: string | null, options: any) => {
    if (!readProjection) return errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE', new Error('runtime services are not initialized'));
    try {
      return await readProjection.getCouncilRuns(projectId, options ?? {});
    } catch (error) {
      console.error('Failed to list council runs:', error);
      return errorResult([], 'PROJECTION_COUNCIL_LIST_UNAVAILABLE', error);
    }
  });
  ipcMain.handle('council:get', async (_event, pmRunId: string) => {
    if (!readProjection) return errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE', new Error('runtime services are not initialized'));
    try {
      return await readProjection.getCouncil(pmRunId);
    } catch (error) {
      console.error('Failed to get council state:', error);
      return errorResult(null, 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE', error);
    }
  });

  // Connections
  ipcMain.handle('connections:list', async () => {
    const backends = runtimeSupervisor?.getReadiness()?.pmProfiles?.backends ?? [];

    // W2-O: opportunistically scan newly-terminal PM runs for auth evidence
    // on the same cadence the renderer already polls connections at. This
    // is at-least-once and idempotent (recordProven/recordFailed upsert by
    // profile_id), so re-scanning the same terminal runs on every poll is
    // harmless, not incorrect.
    if (readProjection && authEvidenceStore && classifyExecutionFailure) {
      try {
        const runs = await readProjection.getRecentTerminalPmRuns(50);
        scanPmRunsForAuthEvidence(runs, classifyExecutionFailure, authEvidenceStore);
      } catch (error) {
        console.error('Auth evidence scan failed (non-fatal):', error);
      }
    }

    // M07: this remains per-CONFIGURED-PROFILE health/auth truth — it is no
    // longer the enumeration source for Connection Center (that's
    // backends:capabilities, which always lists every product the
    // production registry supports, configured or not). The renderer
    // matches these by `backend` (product) to overlay onto each capability
    // card; a product with zero entries here still renders, just with
    // "no PM profile configured" instead of vanishing.
    return backends.map((backend: any): Connection => {
      const evidence = authEvidenceStore?.get(backend.profile_id);
      const authStatus = evidence ? `${evidence.state}(${evidence.timestamp})` : 'UNKNOWN';
      return {
        name: backend.profile_id,
        health: backend.available ? 'HEALTHY' : 'UNHEALTHY',
        cliInstalled: Boolean(backend.available),
        authStatus,
        backend: backend.product,
        profileId: backend.profile_id,
      };
    });
  });

  // Logs
  ipcMain.handle('logs:runtime', async (_event, options: any) => {
    return runtimeLogBuffer.list(options?.limit ?? 200);
  });

  // P6-W3-R3 Part B: READ-ONLY execution logs for the four production
  // backends. No stdin, no arbitrary command execution, no task control —
  // list() is a bounded, poll-friendly tail (afterSeq lets the renderer
  // ask for only what's new); statuses() drives the tab badges.
  ipcMain.handle('execLogs:list', async (_event, product: string, options: any) => {
    return backendExecutionLogService.list(product, options ?? {});
  });
  ipcMain.handle('execLogs:statuses', async () => {
    const statuses = backendExecutionLogService.statuses();
    // Best-effort only: BackendExecutionObserver only ever knows `runId`
    // (the PM request id); taskId is resolved here, live, via the same
    // two-hop SQLite→Postgres lineage join getBackendRuns() already uses
    // (see readProjection.ts's resolveTaskLineageByRequestId()) — never a
    // guess, and a lookup failure just leaves taskId as it was.
    if (readProjection) {
      for (const status of Object.values(statuses)) {
        if (status.taskId || !status.runId) continue;
        try {
          const lineage = await readProjection.resolveTaskLineageByRequestId(status.runId);
          if (lineage?.taskId) status.taskId = lineage.taskId;
        } catch {
          // Non-authoritative: leave taskId unresolved rather than fail this poll.
        }
      }
    }
    return statuses;
  });

  // P10-R0.2.4.1 Part J/K/M: owner-visible LONG-task runtime/liveness
  // projection — poll-only (mirrors execLogs:statuses' pattern exactly),
  // read from BackendExecutionLogService's already-parsed event stream.
  // No stdin, no task control, no raw event stream exposed to the
  // renderer.
  ipcMain.handle('longTasks:statuses', async () => {
    return backendExecutionLogService.getLongTaskStates();
  });

  // Project arming (W2-C) — selecting a project never implicitly arms it.
  // A project whose configured directory is currently missing can never be
  // armed (R1-A): this is what transitively blocks every project-scoped
  // write (submit/reply/decide/cancel all require armedProjectId to match),
  // without needing separate path-missing checks in each IPC handler below.
  ipcMain.handle('project:arm', async (_event, projectId: string) => {
    if (typeof projectId !== 'string' || !projectId) throw new Error('INVALID_OWNER_COMMAND');
    const projects = readProjection ? await readProjection.getProjects().catch(() => []) : [];
    const target = projects.find((p) => p.id === projectId);
    if (target?.state === 'PATH_MISSING') throw new Error('PROJECT_PATH_MISSING');
    armedProjectId = projectId;
    mainWindow?.webContents.send('project:armedChanged', armedProjectId);
    return armedProjectId;
  });
  ipcMain.handle('project:disarm', async () => {
    armedProjectId = null;
    mainWindow?.webContents.send('project:armedChanged', armedProjectId);
    return armedProjectId;
  });
  ipcMain.handle('project:getArmed', async () => armedProjectId);

  // Owner mutations (W2-A/W2-E/W2-G/W2-H). Each is a closed, named
  // operation — never a generic owner.mutate(anything) passthrough. Every
  // call goes through the durable outbox before it ever reaches the pipe.
  // P7 Part N: `council` (chair + >=1 participant + rounds) is optional and
  // additive — omitting it (every existing SINGLE-mode caller) is byte-for-
  // byte the pre-P7 payload. Validation (unknown/duplicate profile, zero
  // participants, invalid rounds) happens server-side in
  // OwnerControlService#validateBeforeAcceptance — this handler never
  // duplicates that logic, only forwards what the owner selected.
  // P12-R1: `taskFile` is optional and additive — omitting it (every
  // existing caller) is byte-for-byte the pre-P12 payload. It mirrors
  // Telegram's `--task-file <ref> <path>` directive exactly (same
  // {ref,path} shape); resolution against the project's own Git repository
  // happens runtime-side (src/runtime/local-runtime-control.mjs ->
  // src/owner/task-source-resolver.mjs), never here — this handler only
  // ever forwards what the owner selected, the same discipline the
  // `council` field above already follows. A `taskFile` + `council`
  // combination is refused server-side (TASK_FILE_COUNCIL_NOT_SUPPORTED),
  // not re-validated here.
  // P12-R5A: `lifecycle` is optional and additive — omitting it (every
  // pre-R5A caller) is byte-for-byte the existing payload. Folds onto
  // exactly the same payload.durability/payload.git/payload.review shapes
  // Telegram's applyLifecycleFlags() already produces
  // (telegram-owner-client.mjs) — this handler never re-implements
  // normalizeDurability()/normalizeGitSyncRequest()/normalizeReviewRequest()'s
  // validation, only forwards what the owner selected. Final push
  // authorization is NOT decided here — it is independently re-derived
  // and enforced runtime-side from the project's own durable autonomy
  // config (production-pm-worker.mjs's isPushAuthorized()), regardless of
  // what this payload claims — the renderer's checkbox is intent capture,
  // never the authority (Part G).
  ipcMain.handle('owner:submitTask', async (_event, args: { projectId: string; pmProfileId: string; body: string; council?: { participantProfileIds: string[]; rounds: number; implementationParticipantId?: string; debate?: { enabled: boolean; maxRounds?: 1 | 2 } }; taskFile?: { ref: string; path: string }; lifecycle?: { durability: 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE'; commitLocal?: boolean; pushRemote?: boolean; requestReview?: boolean; remoteName?: string } }) => {
    const payload = buildSubmitTaskPayload(args);
    return dispatchOwnerCommand({ operation: 'SUBMIT_TASK', projectId: args.projectId, payload });
  });
  ipcMain.handle('owner:replyToInteraction', async (_event, args: { projectId: string; interactionId: string; expectedRevision: number; text: string }) => {
    return dispatchOwnerCommand({ operation: 'REPLY_TO_INTERACTION', projectId: args.projectId, targetId: args.interactionId, expectedRevision: args.expectedRevision, payload: { text: args.text } });
  });
  ipcMain.handle('owner:decideInteraction', async (_event, args: { projectId: string; interactionId: string; expectedRevision: number; response: string }) => {
    return dispatchOwnerCommand({ operation: 'DECIDE_INTERACTION', projectId: args.projectId, targetId: args.interactionId, expectedRevision: args.expectedRevision, payload: { response: args.response } });
  });
  ipcMain.handle('owner:requestCancel', async (_event, args: { projectId: string; taskId: string; interactionId?: string; expectedRevision?: number }) => {
    return dispatchOwnerCommand({
      operation: 'REQUEST_CANCEL',
      projectId: args.projectId,
      targetId: args.taskId,
      expectedRevision: args.expectedRevision,
      payload: args.interactionId ? { interaction_id: args.interactionId } : {},
    });
  });

  ipcMain.handle('outbox:list', async (_event, limit?: number) => {
    return ownerCommandService?.listRecent(limit ?? 200) ?? [];
  });

  // PM profiles for the composer's Single/Chair/Participants selectors.
  // P9-R0.4 Part N/T/W: the identity/status half of each entry is read
  // FRESH off the durable pm-profiles.yaml (pmProfileConfigService.list())
  // every call — so a Desktop deactivate/reactivate is reflected here
  // immediately, with no restart required.
  //
  // P15-REM-R3-C (P15-D-003): the `available` half used to come from
  // `RuntimeSupervisor.getReadiness()` — a snapshot captured exactly ONCE,
  // during `waitForReadiness()` at startup, and never touched again for the
  // life of this Electron process. The runtime's OWN `pmBackendStatus`
  // (src/runtime/p5-production-composition.mjs) has been live-updated on
  // every hot profile create since P11-R5 (`reloadPmProfiles()` appends to
  // it) — Telegram/the runtime itself always saw a hot-created profile as
  // usable immediately; Desktop's `pm:profiles` simply never asked the
  // runtime again after startup, so it kept reporting the profile
  // `available:false` until a full restart replaced the cached snapshot.
  // Fix: query the SAME `READINESS` control-pipe operation fresh, on every
  // call — no new polling authority, no second live-status subsystem, just
  // asking the one canonical authority (the running process) instead of a
  // copy of its answer from minutes/hours ago. Falls back to the last-known
  // cached snapshot only when the runtime cannot be reached right now
  // (STOPPED/STARTING, or a transient pipe hiccup) — never silently treats
  // "can't ask" as "definitely unavailable" when a cached answer exists.
  // Part N: an INACTIVE profile is filtered out entirely — never shown
  // disabled, never mixed into the active list.
  ipcMain.handle('pm:profiles', async () => {
    let backends: any[] = [];
    try {
      const live = await runtimeSupervisor?.getPipeClient()?.readinessDetails();
      backends = live?.pmProfiles?.backends ?? runtimeSupervisor?.getReadiness()?.pmProfiles?.backends ?? [];
    } catch {
      backends = runtimeSupervisor?.getReadiness()?.pmProfiles?.backends ?? [];
    }
    const availableById = new Map(backends.map((backend: any) => [backend.profile_id, Boolean(backend.available)]));
    const entries = pmProfileConfigService?.list() ?? [];
    const active = entries.filter((p) => p.status === 'ACTIVE');
    return Promise.all(active.map(async (p) => ({
      id: p.id,
      product: p.product,
      model: p.model ?? null,
      sessionKind: p.session_kind,
      available: availableById.get(p.id) ?? false,
      displayLabel: formatPmProfileDisplayLabel ? await formatPmProfileDisplayLabel(p) : `${p.product} · ${p.model ?? 'default/inherited'} · ${p.reasoning ?? 'default/inherited'}`,
    })));
  });

  // Add Folder (W2-I/W2-J): native picker only; the renderer never sends an
  // arbitrary free-form path straight to a privileged write.
  ipcMain.handle('dialog:pickFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('project:addFolder', async (_event, args: { folderPath: string; displayName?: string; defaultPmProfileId: string; force?: boolean }) => {
    if (!projectRegistry) throw new Error('CONFIG_VALIDATION_FAILED');
    const result = await projectRegistry.addFolder(args);
    if (result.ok) {
      const runtimeState = runtimeSupervisor?.getStatus().state;
      // P7-R0.4 Part D: the canonical projects.yaml write already succeeded
      // and was already fully revalidated by addFolder() above — the
      // Desktop sidebar must not stay silently stale waiting for a restart
      // that only the LIVE RUNTIME actually needs (to route new task
      // submissions to the new project). Reload the read-only GUI
      // projection immediately so the sidebar can show the new project
      // right away; `restartRequired` (unchanged) still tells the owner a
      // restart is needed before they can actually ARM/submit to it.
      await reloadProjectProjection();
      return { ...result, restartRequired: runtimeState === 'RUNNING' || runtimeState === 'STARTING' };
    }
    return result;
  });

  // Login Terminal (W3-A): explicit user action only, one closed product
  // set, one closed `login`/`logout` argv, no renderer-supplied path or
  // args, bounded lifecycle (only one session at a time; killed on quit).
  ipcMain.handle('loginTerminal:start', async (_event, args: { product: string; mode: string }) => {
    if (activeLoginTerminal?.isRunning()) throw new Error('LOGIN_TERMINAL_ALREADY_RUNNING');
    const session = await LoginTerminalSession.start(args.product, args.mode);
    activeLoginTerminal = session;
    session.on('data', (chunk: string) => mainWindow?.webContents.send('loginTerminal:data', chunk));
    session.on('exit', (info: { code: number | null; signal: string | null; error?: string }) => {
      mainWindow?.webContents.send('loginTerminal:exit', info);
      // Deliberately does NOT touch authEvidenceStore here: an exit code
      // alone (even 0) never proves auth. Only a real terminal PM run,
      // scanned by scanPmRunsForAuthEvidence, can move UNKNOWN -> PROVEN.
      if (activeLoginTerminal === session) activeLoginTerminal = null;
      // P6-W3-R4 Part A4/B1: a successful login/logout exit is exactly the
      // moment the owner most needs Connection Center's auth card to stop
      // showing stale state — push a refresh signal immediately rather
      // than waiting for the next auto-refresh tick. `code === 0` only
      // gates *when* to nudge the renderer to re-probe; it is never
      // itself treated as auth evidence (see the comment above).
      // P6-W3-R4.1 Part R41-7: scoped to the one product that was just
      // logged in/out — the renderer refreshes only that backend's card,
      // never all four.
      if (info.code === 0) mainWindow?.webContents.send('connections:changed', { product: session.product });
    });
    return { product: session.product, mode: session.mode };
  });
  ipcMain.handle('loginTerminal:write', async (_event, data: string) => {
    activeLoginTerminal?.write(String(data ?? ''));
  });
  ipcMain.handle('loginTerminal:stop', async () => {
    activeLoginTerminal?.stop();
  });
  ipcMain.handle('loginTerminal:status', async () => {
    if (!activeLoginTerminal) return null;
    return { product: activeLoginTerminal.product, mode: activeLoginTerminal.mode, running: activeLoginTerminal.isRunning(), buffer: activeLoginTerminal.getBuffer() };
  });

  // Backend capability truth for Connection Center (W3-B/R4/R4.1), sourced
  // from the real production PM backend registry rather than a second
  // hardcoded frontend matrix. `mode: 'auto'` (the renderer's self-
  // scheduling periodic tick — see connectionRefreshCoordinator.ts) skips
  // each backend's heavier secondary spawn and reuses the registry's own
  // per-session static-fact cache (R41-5); `mode: 'full'` (the default —
  // every owner-initiated action) always re-probes everything.
  ipcMain.handle('backends:capabilities', async (_event, options?: { mode?: 'full' | 'auto' }) => {
    try {
      const registry = await getPmBackendRegistry();
      if (!registry) throw new Error('backend registry unavailable');
      return registry.capabilities({ mode: options?.mode ?? 'full' });
    } catch (error) {
      console.error('Failed to load backend capabilities:', error);
      return [];
    }
  });
  // P6.5 Part I: a static, zero-I/O product-name list — never a CLI probe.
  // BackendExecutionLogs.tsx previously polled the real backends:capabilities
  // (a genuine 4-backend native CLI probe) every 15s purely to read
  // `capabilities.map(c => c.product)`, which directly contradicted the
  // R4.2 "no periodic backend refresh" product decision and was a real
  // periodic-probing source docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md's
  // audit found. This is the same authoritative catalogue
  // listSupportedProducts() already is elsewhere (R31-4) — fetched once,
  // never polled.
  ipcMain.handle('backends:products', async () => {
    return listSupportedPmProducts ? listSupportedPmProducts() : ['claude-code', 'opencode', 'codex', 'grok', 'antigravity', 'api'];
  });
  // P6-W3-R4.1 Part R41-3: true per-backend refresh — probes exactly the
  // one requested product, never the other three. Unknown product fails
  // closed (registry.capability() returns a typed UNSUPPORTED/UNKNOWN
  // shape, never a throw).
  ipcMain.handle('backends:capability', async (_event, product: string, options?: { mode?: 'full' | 'auto' }) => {
    try {
      const registry = await getPmBackendRegistry();
      if (!registry) throw new Error('backend registry unavailable');
      return registry.capability(product, { mode: options?.mode ?? 'full' });
    } catch (error) {
      console.error(`Failed to load backend capability for ${product}:`, error);
      return null;
    }
  });
  // P11-R1 Part G/H: the ONE live network call this file ever makes for an
  // API provider — explicitly owner-triggered (one click, one provider),
  // never part of backends:capabilities/backends:capability above (both
  // stay zero-network for 'api', see ProductionPmBackendRegistry's
  // #buildApiCapability) and never on any timer. Distinguishes
  // KEY_PRESENT (env var set) from an actually-proven REACHABLE/
  // AUTH_FAILED/RATE_LIMITED/UNAVAILABLE result — see
  // api-provider-readiness.mjs's probeApiProviderReadiness (a bounded
  // GET {base_url}/models, no generation, no token spend).
  ipcMain.handle('backends:apiProviderLive', async (_event, providerId: string) => {
    try {
      const registry = await getPmBackendRegistry();
      if (!registry?.probeApiProviderLive) throw new Error('API provider live probe unavailable');
      return await registry.probeApiProviderLive(providerId);
    } catch (error) {
      console.error(`Failed to live-probe API provider ${providerId}:`, error);
      return null;
    }
  });
  ipcMain.handle('backends:apiProviderModels', async (_event, providerId: string) => {
    try {
      const registry = await getPmBackendRegistry();
      if (!registry?.discoverApiProviderModels) throw new Error('API model discovery unavailable');
      return await registry.discoverApiProviderModels(providerId);
    } catch { return { ok: false, code: 'API_MODEL_DISCOVERY_FAILED', message: 'OpenRouter model discovery is unavailable' }; }
  });
  // P11-R4.1 Part F-J: the ONE owner-facing credential-rotation call for
  // the `api` backend, replacing CLI-style Login/Logout (which do not
  // apply to an HTTP backend). Hard-scoped to 'openrouter' — the only
  // active production API provider (Part E) — before ever reaching
  // apiKeyUpdateService; the value is a one-way input (never echoed back
  // in the result, never logged) and is written ONLY to the same `.env`
  // file envBootstrap.ts already resolved for this session, never to
  // pm-profiles.yaml/SQLite/PostgreSQL/history/Telegram/logs.
  ipcMain.handle('backends:updateApiKey', async (_event, args: { providerId: string; value: string }) => {
    if (args?.providerId !== 'openrouter') {
      return { ok: false, code: 'API_KEY_UPDATE_PROVIDER_UNSUPPORTED', message: 'OpenRouter is the only API provider that supports key updates from Desktop' };
    }
    const envFilePath = bootstrapStatus?.envFile.path ?? (bootstrapStatus?.repoRoot.path ? path.join(bootstrapStatus.repoRoot.path, '.env') : null);
    if (!envFilePath) {
      return { ok: false, code: 'API_KEY_UPDATE_NO_REPO_ROOT', message: 'cannot persist an API key before a repo root is configured' };
    }
    // No pmBackendRegistry invalidation needed: ProductionPmBackendRegistry's
    // `apiEnv` defaults to `process.env` BY REFERENCE (confirmed by reading
    // production-pm-backend-registry.mjs's constructor), so the singleton
    // already sees this write on its very next read — rebuilding it here
    // would only re-run the (deliberately cached, see P6.5) CLI binary
    // resolution for no benefit.
    return updateOpenRouterKeyInEnvFile(envFilePath, args?.value);
  });

  // P6-W3-R4 Part D: durable PM profile editor, sourced directly from the
  // pm-profiles.yaml file the runtime consumes (never runtime readiness,
  // which only reflects the *last started* runtime's snapshot) — so the
  // list here is accurate even before the runtime has ever started, and
  // reflects a Save immediately, without waiting for a restart. A newly
  // CREATED profile's backend-CLI *availability* (used by pm:profiles'
  // `available` flag) still only becomes known after the next start/
  // restart, exactly as before this wave — P9-R0.4 only changes how
  // ACTIVE/INACTIVE lifecycle status is read (always fresh, see
  // pm:profiles above), never that. P6-W3-R4.1 Part R41-7: create/update
  // deliberately do NOT push connections:changed — the renderer already
  // awaits this exact IPC call and re-fetches pmProfiles:list() directly
  // on success (see App.tsx's refreshProfilesOnly()), so a push here would
  // be redundant. Critically, it also means saving a profile never
  // triggers a native CLI probe — config-state refresh stays separate from
  // connection probing.
  ipcMain.handle('pmProfiles:list', async () => {
    const entries = pmProfileConfigService?.list() ?? [];
    // P11-R4.2 Part E/F/N: a fresh, best-effort read of the SAME
    // telegram-aliases.yaml the running runtime reconciles into —
    // `null` (missing/malformed/not-yet-created file) decorates every
    // entry with `alias: null` ("not yet known"), never a hard failure of
    // this whole list.
    const aliasMap = telegramAliasesPathGlobal ? readPmProfileAliases(telegramAliasesPathGlobal) : null;
    return Promise.all(entries.map(async (p) => ({
      ...p,
      alias: aliasMap?.get(p.id) ?? null,
      displayLabel: formatPmProfileDisplayLabel ? await formatPmProfileDisplayLabel(p) : `${p.product} · ${p.model ?? 'default/inherited'} · ${p.reasoning ?? 'default/inherited'}`,
    })));
  });
  // P11-R4.2 Part A/E/J: after a successful durable write, best-effort
  // trigger the ALREADY-RUNNING runtime's bounded PM-profile+alias hot-
  // reload over the control pipe — see namedPipeClient.ts's
  // reloadPmProfiles() / src/runtime/local-runtime-control.mjs's
  // RELOAD_PM_PROFILES / p5-production-composition.mjs's
  // reloadPmProfiles(). This is deliberately best-effort: the profile is
  // already durably persisted either way (the write above already
  // succeeded), so a stopped runtime, an unreachable pipe, or a reload
  // that doesn't (yet) assign an alias never turns a successful create
  // into a reported failure — it only means `alias` stays absent on the
  // result (Part N: the renderer shows "not yet known", never fabricates
  // one). No runtime restart is ever triggered here — see
  // RuntimeSupervisor#getPipeClient(), which returns null unless the
  // runtime is already RUNNING.
  ipcMain.handle('pmProfiles:create', async (_event, args: { id: string; product: string; provider?: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => {
    if (!pmProfileConfigService) return { ok: false, code: 'PM_PROFILE_SERVICE_UNAVAILABLE', message: 'PM profile configuration is not available yet' };
    const result = await pmProfileConfigService.create(args);
    if (result.ok) {
      try {
        const reload = await runtimeSupervisor?.getPipeClient()?.reloadPmProfiles();
        const alias = reload?.aliasesAssigned?.[result.profile.id];
        if (alias) return { ...result, alias };
      } catch (error) {
        console.error('Failed to hot-reload PM profiles after create (profile is still durably persisted):', error);
      }
    }
    return result;
  });
  ipcMain.handle('pmProfiles:update', async (_event, args: { id: string; model?: string | null; sessionKind?: string; reasoning?: string | null }) => {
    if (!pmProfileConfigService) return { ok: false, code: 'PM_PROFILE_SERVICE_UNAVAILABLE', message: 'PM profile configuration is not available yet' };
    return pmProfileConfigService.update(args);
  });
  // P9-R0.4 Part D/H/I/X: SAFE lifecycle management only — no delete IPC
  // exists at all (Part E: no hard delete). Renderer sends only a bare
  // canonical id; every other guard (existence, atomic write, full-config
  // revalidation, identity-field preservation) lives in
  // PmProfileConfigService, not here.
  ipcMain.handle('pmProfiles:deactivate', async (_event, args: { id: string }) => {
    if (!pmProfileConfigService) return { ok: false, code: 'PM_PROFILE_SERVICE_UNAVAILABLE', message: 'PM profile configuration is not available yet' };
    return pmProfileConfigService.deactivate(args.id);
  });
  ipcMain.handle('pmProfiles:reactivate', async (_event, args: { id: string }) => {
    if (!pmProfileConfigService) return { ok: false, code: 'PM_PROFILE_SERVICE_UNAVAILABLE', message: 'PM profile configuration is not available yet' };
    return pmProfileConfigService.reactivate(args.id);
  });
}

// Lazily constructs the one `ProductionPmBackendRegistry` singleton this
// process uses for both backends:capabilities and backends:capability —
// sharing it (rather than constructing per-call) is what makes R41-5's
// per-product static-fact cache actually persist across calls for the
// Desktop session.
//
// P6.5 Part E: `ProductionPmBackendRegistry`'s own constructor defaults
// (`claudeBinary=resolveClaudeBinary()` etc.) resolve each product's
// binary via up to ~13 *synchronous* spawnSync `--version` probes total
// (2-4 path candidates x 2-4 Windows suffixes, per product) — cheap
// inside the separate runtime child process that also constructs this
// class, but a real multi-second Electron-main-event-loop freeze the one
// time Connection Center's IPC handlers construct this singleton, if left
// to those defaults. Fixed by resolving all four binaries here, in
// parallel, via each session bridge's new async resolver
// (resolveXBinaryAsync — see src/session/binary-resolution-async.mjs),
// then passing them as explicit constructor arguments — which skips the
// synchronous defaults entirely, since JS only evaluates a default
// parameter expression when the argument is omitted. The registry's own
// constructor default behavior is deliberately left untouched (the
// runtime child process's own registry construction still relies on it
// unchanged — see p5-production-composition.mjs — which is out of scope
// for this pass and does not run on Electron's main process anyway).
async function getPmBackendRegistry(): Promise<{ capabilities: (options?: { mode?: string }) => Promise<any[]>; capability: (product: string, options?: { mode?: string }) => Promise<any>; probeApiProviderLive?: (providerId: string) => Promise<unknown>; discoverApiProviderModels?: (providerId: string) => Promise<unknown> } | null> {
  if (!pmBackendRegistry) {
    const repoRoot = bootstrapStatus!.repoRoot.path!;
    const [{ ProductionPmBackendRegistry }, claudeBridge, openCodeBridge, codexBridge, grokBridge, antigravityBridge, apiProviderConfigModule] = await Promise.all([
      importEsmModule(path.join(repoRoot, 'src', 'pm', 'production-pm-backend-registry.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'session', 'claude-code-session-bridge.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'session', 'opencode-cli-session-bridge.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'session', 'codex-cli-session-bridge.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'session', 'grok-acp-client.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'session', 'antigravity-cli-session-bridge.mjs')),
      importEsmModule(path.join(repoRoot, 'src', 'pm', 'api-backend', 'api-provider-config.mjs')),
    ]);
    const [claudeBinary, openCodeBinary, codexBinary, grokBinary, antigravityBinary] = await Promise.all([
      claudeBridge.resolveClaudeBinaryAsync(),
      openCodeBridge.resolveOpenCodeBinaryAsync(),
      codexBridge.resolveCodexCliBinaryAsync(),
      grokBridge.resolveGrokBinaryAsync(),
      antigravityBridge.resolveAntigravityBinaryAsync(),
    ]);
    // P11-R1: real provider config (protocol/base_url/api_key_env — NEVER
    // a resolved secret, see api-provider-config.mjs) so Connection Center
    // shows real CONFIGURED/KEY_PRESENT truth instead of an always-empty
    // providers[] (R0's default when nothing is wired). A missing/absent
    // apiProvidersPath (every deployment that hasn't set api_providers_file)
    // degrades to `{}` — no providers, never a startup/IPC failure; a
    // PRESENT-but-malformed file also degrades to `{}` here (Connection
    // Center is read-only diagnostics, not a config validator — the real
    // fail-closed validation already happens at real runtime-config-load
    // time via validate-p5-config.mjs/loadP5ProductionConfig()).
    const apiProviders = await apiProviderConfigModule.loadApiProviderConfig({ path: apiProvidersPath }).catch((error: unknown) => {
      console.error('Failed to load API provider config for Connection Center (providers will show as unconfigured):', error);
      return {};
    });
    pmBackendRegistry = new ProductionPmBackendRegistry({ claudeBinary, openCodeBinary, codexBinary, grokBinary, antigravityBinary, apiProviders });
  }
  return pmBackendRegistry;
}

async function dispatchOwnerCommand(input: OwnerCommandInput) {
  if (!ownerCommandService) throw new Error('LOCAL_OWNER_PIPE_UNAVAILABLE');
  // Defense in depth, mirrored inside OwnerCommandService itself: any
  // project-scoped mutation is refused here too if it does not target the
  // currently armed project, independent of what the renderer displayed.
  if (input.projectId && input.projectId !== armedProjectId) {
    return { state: 'FAILED_TERMINAL', errorCode: 'PROJECT_NOT_ARMED' };
  }
  return ownerCommandService.submit(input);
}

app.on('window-all-closed', () => {
  // Don't quit on window close - app stays in tray
});

let desktopShutdownStarted = false;
app.on('before-quit', (event) => {
  if (desktopShutdownStarted) return;
  event.preventDefault();
  desktopShutdownStarted = true;
  void (async () => {
    // Bounded internally. EXTERNAL and APP_OWNED+BUSY runners are left
    // alive; only an idle process tree created in this lifetime is stopped.
    await relayRunnerLifecycleManager?.shutdown().catch((error) => {
      console.error('GitHub relay runner shutdown failed safely:', error);
    });
    if (readProjection) await readProjection.close();
    outboxStore?.close();
    authEvidenceStore?.close();
    activeLoginTerminal?.stop();
  })().finally(() => app.exit(0));
});
