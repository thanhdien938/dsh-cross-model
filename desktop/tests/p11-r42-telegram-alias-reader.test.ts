import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPmProfileAliases } from '../electron/main/services/telegramAliasReader';

// P11-R4.2 Part E/F/N: Desktop's read-only view of the SAME
// telegram-aliases.yaml the running runtime reconciles into. Never writes
// to this file — alias assignment stays exclusively the runtime's job.

describe('readPmProfileAliases', () => {
  let dir: string;
  let aliasesPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alias-reader-'));
    aliasesPath = path.join(dir, 'telegram-aliases.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist (normal before the first-ever profile)', () => {
    expect(readPmProfileAliases(aliasesPath)).toBeNull();
  });

  it('returns null on malformed YAML rather than throwing', () => {
    fs.writeFileSync(aliasesPath, '{not: valid: yaml:::');
    expect(readPmProfileAliases(aliasesPath)).toBeNull();
  });

  it('returns an empty map when pm_profiles is absent', () => {
    fs.writeFileSync(aliasesPath, 'version: 1\nnext_pm_profile_alias: 1\n');
    expect(readPmProfileAliases(aliasesPath)).toEqual(new Map());
  });

  it('maps profile id -> alias number (as a string), reversed from the on-disk alias -> id shape', () => {
    fs.writeFileSync(aliasesPath, 'pm_profiles:\n  "1": live1-claude-pm\n  "16": live1-api-openai-gpt-5-6-luna-medium\n');
    const map = readPmProfileAliases(aliasesPath)!;
    expect(map.get('live1-claude-pm')).toBe('1');
    expect(map.get('live1-api-openai-gpt-5-6-luna-medium')).toBe('16');
    expect(map.get('unknown-profile')).toBeUndefined();
  });
});
