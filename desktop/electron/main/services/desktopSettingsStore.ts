import fs from 'fs';
import path from 'path';

// M01/M02: GUI-owned bootstrap configuration, persisted outside the repo
// (Electron userData) so a packaged, double-clicked install can locate the
// canonical DSH checkout and its production config/env without any shell
// environment preparation. Only safe path *references* are ever stored —
// never secret values (those live in the .env file itself, read directly
// by the main process at runtime-spawn time; see main.ts).
export interface DesktopSettings {
  dshRepoRoot: string | null;
  productionConfigPath: string | null;
  envFilePath: string | null;
  relayRunner: RelayRunnerSettings;
}

export interface RelayRunnerSettings {
  enabled: boolean;
  runnerPath: string | null;
  autoStart: boolean;
}

// P0-2 remediation: the previous defaults (enabled/autoStart true, a
// hardcoded C:\actions-runner\dsh-relay path) belonged to one owner's
// machine and shipped as a PRODUCT default — every other install would
// have started life pointed at a nonexistent directory on someone else's
// disk. Product-safe defaults are fully inert: NOT CONFIGURED, zero
// runner startup behavior, until an owner explicitly configures a path
// (see RelayRunnerLifecycleManager#configureRunnerPath / the native
// folder-picker IPC in main.ts).
export const DEFAULT_RELAY_RUNNER_SETTINGS: RelayRunnerSettings = {
  enabled: false,
  runnerPath: null,
  autoStart: false,
};

const DEFAULTS: DesktopSettings = { dshRepoRoot: null, productionConfigPath: null, envFilePath: null, relayRunner: DEFAULT_RELAY_RUNNER_SETTINGS };

export class DesktopSettingsStore {
  private readonly filePath: string;
  private settings: DesktopSettings;

  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    this.filePath = path.join(userDataDir, 'dsh-desktop-settings.json');
    this.settings = this.load();
  }

  private load(): DesktopSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        dshRepoRoot: typeof raw.dshRepoRoot === 'string' ? raw.dshRepoRoot : null,
        productionConfigPath: typeof raw.productionConfigPath === 'string' ? raw.productionConfigPath : null,
        envFilePath: typeof raw.envFilePath === 'string' ? raw.envFilePath : null,
        relayRunner: {
          enabled: typeof raw.relayRunner?.enabled === 'boolean' ? raw.relayRunner.enabled : DEFAULT_RELAY_RUNNER_SETTINGS.enabled,
          runnerPath: typeof raw.relayRunner?.runnerPath === 'string' || raw.relayRunner?.runnerPath === null ? raw.relayRunner.runnerPath : DEFAULT_RELAY_RUNNER_SETTINGS.runnerPath,
          autoStart: typeof raw.relayRunner?.autoStart === 'boolean' ? raw.relayRunner.autoStart : DEFAULT_RELAY_RUNNER_SETTINGS.autoStart,
        },
      };
    } catch {
      return { ...DEFAULTS, relayRunner: { ...DEFAULT_RELAY_RUNNER_SETTINGS } };
    }
  }

  private persist(): void {
    // Atomic-ish write: temp file + rename, consistent with the same
    // pattern projectRegistry.ts uses for projects.yaml, so a crash
    // mid-write never leaves a half-written settings file.
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  get(): DesktopSettings {
    return { ...this.settings, relayRunner: { ...this.settings.relayRunner } };
  }

  setRepoRoot(value: string | null): void {
    this.settings = { ...this.settings, dshRepoRoot: value };
    this.persist();
  }

  setProductionConfigPath(value: string | null): void {
    this.settings = { ...this.settings, productionConfigPath: value };
    this.persist();
  }

  setEnvFilePath(value: string | null): void {
    this.settings = { ...this.settings, envFilePath: value };
    this.persist();
  }

  setRelayRunner(value: RelayRunnerSettings): void {
    this.settings = { ...this.settings, relayRunner: { ...value } };
    this.persist();
  }
}
