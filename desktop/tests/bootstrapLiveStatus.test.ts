import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DesktopSettingsStore } from '../electron/main/services/desktopSettingsStore';
import { computeBootstrapStatus } from '../electron/main/services/envBootstrap';

// M08 regression: bootstrap:status must reflect CURRENT persisted
// settings on every call, not an immutable startup snapshot. This is the
// exact function main.ts's bootstrap:status IPC handler calls on every
// poll (and initializeServices() calls once at real startup) — not a
// reimplementation of it.

function makeValidRoot(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'p5-runtime.mjs'), '// stub');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
}

describe('computeBootstrapStatus is live, not a startup snapshot (M08)', () => {
  let dir: string;
  let root: string;
  let settingsDir: string;
  let store: DesktopSettingsStore;
  const originalEnvRoot = process.env.DSH_REPO_ROOT;
  const originalEnvConfig = process.env.DSH_CONFIG_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-live-'));
    root = path.join(dir, 'repo');
    settingsDir = path.join(dir, 'settings');
    fs.mkdirSync(root);
    makeValidRoot(root);
    delete process.env.DSH_REPO_ROOT;
    delete process.env.DSH_CONFIG_PATH;
    store = new DesktopSettingsStore(settingsDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalEnvRoot === undefined) delete process.env.DSH_REPO_ROOT;
    else process.env.DSH_REPO_ROOT = originalEnvRoot;
    if (originalEnvConfig === undefined) delete process.env.DSH_CONFIG_PATH;
    else process.env.DSH_CONFIG_PATH = originalEnvConfig;
  });

  it('1-3: starts MISSING, then the very next call after saving a valid repo root reports CONFIGURED — no restart required to see it', () => {
    const before = computeBootstrapStatus(store, {});
    expect(before.requiresFirstRun).toBe(true);
    expect(before.status.repoRoot.state).toBe('MISSING');

    store.setRepoRoot(root); // exactly what bootstrap:pickRepoRoot does

    const after = computeBootstrapStatus(store, {});
    expect(after.requiresFirstRun).toBe(false);
    expect(after.status.repoRoot.state).toBe('CONFIGURED');
    expect(after.status.repoRoot.path).toBe(root);
  });

  it('4-6: once repo root is CONFIGURED, saving a production config path is reflected on the next call', () => {
    store.setRepoRoot(root);
    const beforeConfig = computeBootstrapStatus(store, {});
    expect(beforeConfig.status.productionConfig.state).toBe('MISSING');

    const configPath = path.join(root, '.runtime', 'live1', 'production.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'mode: production\n');
    store.setProductionConfigPath(configPath);

    const afterConfig = computeBootstrapStatus(store, {});
    expect(afterConfig.status.productionConfig.state).toBe('CONFIGURED');
    expect(afterConfig.status.productionConfig.path).toBe(configPath);
  });

  it('7-9: saving an env file is reflected immediately, and required-name presence is computed from that exact file', () => {
    store.setRepoRoot(root);
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_DSN\ntelegram:\n  token_env: DSH_TEST_TOKEN\n');
    store.setProductionConfigPath(configPath);

    const beforeEnv = computeBootstrapStatus(store, {});
    expect(beforeEnv.status.envFile.state).toBe('NOT_CONFIGURED');
    expect(beforeEnv.status.requiredEnvNames).toEqual([
      { name: 'DSH_TEST_DSN', present: false },
      { name: 'DSH_TEST_TOKEN', present: false },
    ]);

    const envPath = path.join(root, 'secrets.env');
    fs.writeFileSync(envPath, 'DSH_TEST_DSN=postgresql://user:pw@host/db\n');
    store.setEnvFilePath(envPath);

    const afterEnv = computeBootstrapStatus(store, {});
    expect(afterEnv.status.envFile.state).toBe('CONFIGURED');
    expect(afterEnv.status.envFile.path).toBe(envPath);
    expect(afterEnv.status.requiredEnvNames).toEqual([
      { name: 'DSH_TEST_DSN', present: true },
      { name: 'DSH_TEST_TOKEN', present: false },
    ]);
  });

  it('10: secret VALUES are never present anywhere in the returned status, only presence booleans', () => {
    store.setRepoRoot(root);
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_DSN\n');
    store.setProductionConfigPath(configPath);
    const envPath = path.join(root, 'secrets.env');
    const secretValue = 'postgresql://user:VERY-SECRET-PASSWORD@host/db';
    fs.writeFileSync(envPath, `DSH_TEST_DSN=${secretValue}\n`);
    store.setEnvFilePath(envPath);

    const status = computeBootstrapStatus(store, {});
    const serialized = JSON.stringify(status);
    expect(serialized.includes('VERY-SECRET-PASSWORD')).toBe(false);
    expect(serialized.includes(secretValue)).toBe(false);
  });

  it('7b: never mutates the real process.env passed in, even though it inspects it for presence', () => {
    const realEnv: NodeJS.ProcessEnv = {};
    store.setRepoRoot(root);
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_DSN\n');
    store.setProductionConfigPath(configPath);
    const envPath = path.join(root, 'secrets.env');
    fs.writeFileSync(envPath, 'DSH_TEST_DSN=abc\n');
    store.setEnvFilePath(envPath);

    computeBootstrapStatus(store, realEnv);
    expect(realEnv).toEqual({}); // untouched — no repeated process.env mutation on a status poll
  });

  it('11: readyToStart becomes true only once repo root + config + every required env name are all satisfied (one restart is then sufficient)', () => {
    expect(computeBootstrapStatus(store, {}).status.readyToStart).toBe(false);
    store.setRepoRoot(root);
    expect(computeBootstrapStatus(store, {}).status.readyToStart).toBe(false);

    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_DSN\n');
    store.setProductionConfigPath(configPath);
    expect(computeBootstrapStatus(store, {}).status.readyToStart).toBe(false); // env still missing

    const envPath = path.join(root, 'secrets.env');
    fs.writeFileSync(envPath, 'DSH_TEST_DSN=abc\n');
    store.setEnvFilePath(envPath);
    expect(computeBootstrapStatus(store, {}).status.readyToStart).toBe(true);
  });

  it('12: persisted values survive a fresh DesktopSettingsStore instance (a new Desktop process)', () => {
    store.setRepoRoot(root);
    const reopened = new DesktopSettingsStore(settingsDir);
    const status = computeBootstrapStatus(reopened, {});
    expect(status.status.repoRoot.state).toBe('CONFIGURED');
  });

  it('13: an invalid repo root is still refused, never silently accepted', () => {
    const notARepo = path.join(dir, 'not-a-repo');
    fs.mkdirSync(notARepo);
    store.setRepoRoot(notARepo);
    const status = computeBootstrapStatus(store, {});
    expect(status.requiresFirstRun).toBe(true);
    expect(status.status.repoRoot.state).toBe('MISSING');
  });

  it('14: a missing production config is reflected honestly as MISSING, not silently ignored', () => {
    store.setRepoRoot(root);
    store.setProductionConfigPath(path.join(root, 'does-not-exist.yaml'));
    const status = computeBootstrapStatus(store, {});
    expect(status.status.productionConfig.state).toBe('MISSING');
    expect(status.status.readyToStart).toBe(false);
  });

  it('15: a missing required env name is reflected honestly, blocking readyToStart', () => {
    store.setRepoRoot(root);
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_TEST_DSN\ntelegram:\n  token_env: DSH_TEST_TOKEN\n');
    store.setProductionConfigPath(configPath);
    const envPath = path.join(root, 'secrets.env');
    fs.writeFileSync(envPath, 'DSH_TEST_DSN=abc\n'); // token still missing
    store.setEnvFilePath(envPath);

    const status = computeBootstrapStatus(store, {});
    expect(status.status.requiredEnvNames.find((n) => n.name === 'DSH_TEST_TOKEN')?.present).toBe(false);
    expect(status.status.readyToStart).toBe(false);
  });
});
