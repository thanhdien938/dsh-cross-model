import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProductionConfigPath, resolveEnvFilePath, loadEnvFile, requiredEnvNames, buildBootstrapStatus } from '../electron/main/services/envBootstrap';

describe('resolveProductionConfigPath (M02)', () => {
  let dir: string;
  const originalEnv = process.env.DSH_CONFIG_PATH;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-envboot-'));
    delete process.env.DSH_CONFIG_PATH;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.DSH_CONFIG_PATH;
    else process.env.DSH_CONFIG_PATH = originalEnv;
  });

  it('prefers DSH_CONFIG_PATH env override (when it actually exists)', () => {
    const envConfig = path.join(dir, 'env-config.yaml');
    fs.writeFileSync(envConfig, 'mode: production\n');
    process.env.DSH_CONFIG_PATH = envConfig;
    const settingConfig = path.join(dir, 'setting-config.yaml');
    fs.writeFileSync(settingConfig, 'mode: production\n');
    const result = resolveProductionConfigPath(dir, settingConfig);
    expect(result.source).toBe('env');
    expect(result.path).toBe(path.resolve(envConfig));
  });

  it('falls back to a persisted setting when no env override exists (when it actually exists)', () => {
    const settingConfig = path.join(dir, 'setting-config.yaml');
    fs.writeFileSync(settingConfig, 'mode: production\n');
    const result = resolveProductionConfigPath(dir, settingConfig);
    expect(result.source).toBe('setting');
    expect(result.path).toBe(path.resolve(settingConfig));
  });

  it('M08 hardening: a persisted setting pointing at a file that does not exist is rejected, not blindly trusted as CONFIGURED', () => {
    const missingConfig = path.join(dir, 'does-not-exist.yaml');
    const result = resolveProductionConfigPath(dir, missingConfig);
    expect(result.path).toBeNull();
    expect(result.source).toBeNull();
  });

  it('M08 hardening: an env override pointing at a nonexistent file falls through to the next tier instead of being trusted blindly', () => {
    process.env.DSH_CONFIG_PATH = path.join(dir, 'does-not-exist.yaml');
    const settingConfig = path.join(dir, 'setting-config.yaml');
    fs.writeFileSync(settingConfig, 'mode: production\n');
    const result = resolveProductionConfigPath(dir, settingConfig);
    expect(result.source).toBe('setting');
  });

  it('falls back to <repoRoot>/local-config.production.yaml only if it actually exists — this is the exact M02 mismatch (real config lived at .runtime/live1/production.yaml)', () => {
    const noneResult = resolveProductionConfigPath(dir, null);
    expect(noneResult.path).toBeNull();

    fs.writeFileSync(path.join(dir, 'local-config.production.yaml'), 'mode: production\n');
    const withFallback = resolveProductionConfigPath(dir, null);
    expect(withFallback.source).toBe('dev-fallback');
  });
});

describe('resolveEnvFilePath (M02)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-envboot-env-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is optional: no env, no setting, no repo .env -> null path (NOT_CONFIGURED, not an error)', () => {
    const result = resolveEnvFilePath(dir, null);
    expect(result.path).toBeNull();
  });

  it('a persisted setting is used when the repo has no .env of its own (when it actually exists)', () => {
    const settingEnv = path.join(dir, 'custom.env');
    fs.writeFileSync(settingEnv, 'DSH_X=1\n');
    const result = resolveEnvFilePath(dir, settingEnv);
    expect(result.source).toBe('setting');
  });

  it('M08 hardening: a persisted .env setting pointing at a deleted/moved file is rejected, not blindly trusted', () => {
    const missingEnv = path.join(dir, 'deleted.env');
    const result = resolveEnvFilePath(dir, missingEnv);
    expect(result.path).toBeNull();
  });
});

describe('loadEnvFile', () => {
  it('parses real KEY=VALUE lines without mutating process.env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-envboot-load-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'DSH_TEST_SECRET=abc123\nDSH_TEST_OTHER=xyz\n');
    const before = process.env.DSH_TEST_SECRET;
    const loaded = loadEnvFile(envPath);
    expect(loaded).toEqual({ DSH_TEST_SECRET: 'abc123', DSH_TEST_OTHER: 'xyz' });
    expect(process.env.DSH_TEST_SECRET).toBe(before); // untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file returns an empty object, never throws', () => {
    expect(loadEnvFile('C:/does/not/exist/.env')).toEqual({});
    expect(loadEnvFile(null)).toEqual({});
  });
});

describe('requiredEnvNames', () => {
  it('reads the env var NAMES the production config declares, never a hardcoded list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-envboot-names-'));
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_CUSTOM_PG\ntelegram:\n  token_env: DSH_CUSTOM_TG\n');
    expect(requiredEnvNames(configPath)).toEqual(['DSH_CUSTOM_PG', 'DSH_CUSTOM_TG']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a missing/unreadable config returns an empty list, never throws', () => {
    expect(requiredEnvNames(null)).toEqual([]);
    expect(requiredEnvNames('C:/does/not/exist.yaml')).toEqual([]);
  });
});

describe('buildBootstrapStatus (M01/M02 combined readiness)', () => {
  it('readyToStart is true only when repo root + config are configured and every declared secret name is present', () => {
    const status = buildBootstrapStatus({
      repoRootPath: 'C:/repo',
      repoRootSource: 'setting',
      productionConfigResolution: { path: 'C:/repo/config.yaml', source: 'setting' },
      envFileResolution: { path: 'C:/repo/.env', source: 'dev-fallback' },
      mergedEnv: { DSH_POSTGRES_DSN: 'postgresql://x', DSH_TELEGRAM_BOT_TOKEN: 'token' } as any,
    });
    // requiredEnvNames() will read from the (nonexistent in this unit
    // test) config file and return [] since it can't be parsed — so
    // readyToStart depends only on repoRoot+config being present here.
    expect(status.repoRoot.state).toBe('CONFIGURED');
    expect(status.productionConfig.state).toBe('CONFIGURED');
    expect(status.readyToStart).toBe(true);
  });

  it('readyToStart is false when repo root is missing, regardless of everything else', () => {
    const status = buildBootstrapStatus({
      repoRootPath: null,
      repoRootSource: null,
      productionConfigResolution: { path: 'C:/repo/config.yaml', source: 'setting' },
      envFileResolution: { path: null, source: null },
      mergedEnv: {} as any,
    });
    expect(status.repoRoot.state).toBe('MISSING');
    expect(status.readyToStart).toBe(false);
  });

  it('never includes a secret value, only presence booleans', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-envboot-secret-'));
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'postgres:\n  dsn_env: DSH_SECRET_DSN\n');
    const status = buildBootstrapStatus({
      repoRootPath: dir,
      repoRootSource: 'setting',
      productionConfigResolution: { path: configPath, source: 'setting' },
      envFileResolution: { path: null, source: null },
      mergedEnv: { DSH_SECRET_DSN: 'postgresql://user:very-secret-password@host/db' } as any,
    });
    const serialized = JSON.stringify(status);
    expect(serialized.includes('very-secret-password')).toBe(false);
    expect(status.requiredEnvNames).toEqual([{ name: 'DSH_SECRET_DSN', present: true }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
