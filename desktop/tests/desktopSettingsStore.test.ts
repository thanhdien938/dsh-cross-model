import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DesktopSettingsStore } from '../electron/main/services/desktopSettingsStore';

describe('DesktopSettingsStore (M01/M02)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to all-null before anything is configured', () => {
    const store = new DesktopSettingsStore(dir);
    // P0-2: product-safe defaults are fully inert — no machine-specific
    // path, no auto-start — until an owner explicitly configures one.
    expect(store.get()).toEqual({ dshRepoRoot: null, productionConfigPath: null, envFilePath: null, relayRunner: { enabled: false, runnerPath: null, autoStart: false } });
  });

  it('persists the repo root and a fresh instance pointed at the same directory reads it back (restart remembers configured root)', () => {
    const store = new DesktopSettingsStore(dir);
    store.setRepoRoot('C:/real/dsh/checkout');
    const reopened = new DesktopSettingsStore(dir);
    expect(reopened.get().dshRepoRoot).toBe('C:/real/dsh/checkout');
  });

  it('persists production config and env file paths independently', () => {
    const store = new DesktopSettingsStore(dir);
    store.setProductionConfigPath('C:/real/dsh/.runtime/live1/production.yaml');
    store.setEnvFilePath('C:/real/dsh/.env');
    const reopened = new DesktopSettingsStore(dir);
    expect(reopened.get()).toEqual({
      dshRepoRoot: null,
      productionConfigPath: 'C:/real/dsh/.runtime/live1/production.yaml',
      envFilePath: 'C:/real/dsh/.env',
      relayRunner: { enabled: false, runnerPath: null, autoStart: false },
    });
  });

  it('never leaves a half-written settings file: writes go through a temp file + rename', () => {
    const store = new DesktopSettingsStore(dir);
    store.setRepoRoot('C:/a');
    store.setProductionConfigPath('C:/a/config.yaml');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('a corrupt settings file on disk is treated as defaults, not a crash', () => {
    fs.writeFileSync(path.join(dir, 'dsh-desktop-settings.json'), 'not valid json{{{');
    const store = new DesktopSettingsStore(dir);
    expect(store.get()).toEqual({ dshRepoRoot: null, productionConfigPath: null, envFilePath: null, relayRunner: { enabled: false, runnerPath: null, autoStart: false } });
  });

  it('P0-2: legacy settings missing relayRunner entirely migrate to safe disabled defaults', () => {
    fs.writeFileSync(path.join(dir, 'dsh-desktop-settings.json'), JSON.stringify({ dshRepoRoot: 'C:/x' }));
    const store = new DesktopSettingsStore(dir);
    expect(store.get().relayRunner).toEqual({ enabled: false, runnerPath: null, autoStart: false });
  });

  it('persists only typed runner settings and no registration or credential contents', () => {
    const store = new DesktopSettingsStore(dir);
    store.setRelayRunner({ enabled: false, runnerPath: 'D:\\runner', autoStart: false });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'dsh-desktop-settings.json'), 'utf8'));
    expect(raw.relayRunner).toEqual({ enabled: false, runnerPath: 'D:\\runner', autoStart: false });
    expect(JSON.stringify(raw)).not.toMatch(/credentials|registrationToken|runnerJson/i);
  });
});
