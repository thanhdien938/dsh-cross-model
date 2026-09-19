import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isValidDshRepoRoot, resolveRepoRoot, setResolvedRepoRoot, getRepoRoot, DEV_FALLBACK_REPO_ROOT } from '../electron/main/repoRoot';

function makeValidRoot(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'p5-runtime.mjs'), '// stub');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
}

describe('isValidDshRepoRoot (M01)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reporoot-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a folder with scripts/p5-runtime.mjs, src/, and package.json', () => {
    makeValidRoot(dir);
    expect(isValidDshRepoRoot(dir)).toBe(true);
  });

  it('rejects a folder missing the runtime script (e.g. a packaged app resources dir)', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(isValidDshRepoRoot(dir)).toBe(false);
  });

  it('rejects a folder missing src/', () => {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'p5-runtime.mjs'), '// stub');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(isValidDshRepoRoot(dir)).toBe(false);
  });

  it('rejects a nonexistent folder without throwing', () => {
    expect(isValidDshRepoRoot(path.join(dir, 'does-not-exist'))).toBe(false);
  });
});

describe('resolveRepoRoot precedence (M01)', () => {
  let dir: string;
  const originalEnv = process.env.DSH_REPO_ROOT;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reporoot-precedence-'));
    delete process.env.DSH_REPO_ROOT;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.DSH_REPO_ROOT;
    else process.env.DSH_REPO_ROOT = originalEnv;
  });

  it('prefers the explicit DSH_REPO_ROOT env override over a persisted setting', () => {
    const envRoot = path.join(dir, 'env-root');
    const settingRoot = path.join(dir, 'setting-root');
    fs.mkdirSync(envRoot);
    fs.mkdirSync(settingRoot);
    makeValidRoot(envRoot);
    makeValidRoot(settingRoot);
    process.env.DSH_REPO_ROOT = envRoot;
    const result = resolveRepoRoot(settingRoot);
    expect(result.source).toBe('env');
    expect(result.root).toBe(envRoot);
    expect(result.requiresFirstRun).toBe(false);
  });

  it('falls back to the persisted setting when no env override is present', () => {
    const settingRoot = path.join(dir, 'setting-root');
    fs.mkdirSync(settingRoot);
    makeValidRoot(settingRoot);
    const result = resolveRepoRoot(settingRoot);
    expect(result.source).toBe('setting');
    expect(result.root).toBe(settingRoot);
  });

  it('an invalid persisted setting is rejected, not silently used', () => {
    const invalidRoot = path.join(dir, 'not-a-repo');
    fs.mkdirSync(invalidRoot);
    const result = resolveRepoRoot(invalidRoot);
    expect(result.source).not.toBe('setting');
  });

  it('with no env, no valid setting, and an invalid dev fallback, requiresFirstRun is true — packaged resources can never masquerade as the repo root', () => {
    // In the packaged/test environment the dev fallback (this compiled
    // file's own directory chain) is not a real DSH checkout, so with no
    // env/setting it must fail closed to FIRST-RUN REQUIRED rather than
    // silently using DEV_FALLBACK_REPO_ROOT unchecked.
    const result = resolveRepoRoot(null);
    if (isValidDshRepoRoot(DEV_FALLBACK_REPO_ROOT)) {
      expect(result.source).toBe('dev-fallback');
    } else {
      expect(result.requiresFirstRun).toBe(true);
      expect(result.root).toBeNull();
    }
  });

  it('restart remembers the configured root: resolving twice with the same persisted value is stable', () => {
    const settingRoot = path.join(dir, 'setting-root');
    fs.mkdirSync(settingRoot);
    makeValidRoot(settingRoot);
    const first = resolveRepoRoot(settingRoot);
    const second = resolveRepoRoot(settingRoot);
    expect(first).toEqual(second);
  });
});

describe('getRepoRoot / setResolvedRepoRoot', () => {
  it('throws loudly instead of guessing when no root was ever resolved', () => {
    setResolvedRepoRoot(null);
    expect(() => getRepoRoot()).toThrow();
  });

  it('returns the value main.ts resolved at startup', () => {
    setResolvedRepoRoot('C:/some/real/root');
    expect(getRepoRoot()).toBe('C:/some/real/root');
    setResolvedRepoRoot(null);
  });
});
