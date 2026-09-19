import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateOpenRouterKeyInEnvFile, upsertEnvLine, validateApiKeyValue, OPENROUTER_KEY_ENV_NAME } from '../electron/main/services/apiKeyUpdateService';

// P11-R4.1 Part F-J/AI: direct unit coverage for the trusted, main-process-
// only OpenRouter key rotation path. `updateOpenRouterKeyInEnvFile` is the
// ONLY function in the codebase allowed to write DSH_API_OPENROUTER_KEY —
// these tests prove it round-trips correctly against a real temp `.env`,
// preserves everything else byte-for-byte, rejects malformed input, and
// never returns the secret value in its result.

describe('upsertEnvLine (pure string transform)', () => {
  it('replaces an existing KEY=value line, preserving every other line', () => {
    const before = '# comment\nDSH_API_OPENROUTER_KEY=old-value\nDSH_API_DEEPSEEK_KEY=untouched\n';
    const after = upsertEnvLine(before, 'DSH_API_OPENROUTER_KEY', 'new-value');
    expect(after).toBe('# comment\nDSH_API_OPENROUTER_KEY=new-value\nDSH_API_DEEPSEEK_KEY=untouched\n');
  });

  it('appends a new KEY=value line when absent, keeping existing content untouched', () => {
    const before = '# comment\nDSH_API_DEEPSEEK_KEY=untouched\n';
    const after = upsertEnvLine(before, 'DSH_API_OPENROUTER_KEY', 'brand-new');
    expect(after).toBe('# comment\nDSH_API_DEEPSEEK_KEY=untouched\nDSH_API_OPENROUTER_KEY=brand-new\n');
  });

  it('appends into a completely empty file', () => {
    expect(upsertEnvLine('', 'DSH_API_OPENROUTER_KEY', 'v1')).toBe('DSH_API_OPENROUTER_KEY=v1\n');
  });

  it('never touches a commented-out KEY= line — appends a real one instead', () => {
    const before = '# DSH_API_OPENROUTER_KEY=disabled\n';
    const after = upsertEnvLine(before, 'DSH_API_OPENROUTER_KEY', 'v2');
    expect(after).toBe('# DSH_API_OPENROUTER_KEY=disabled\nDSH_API_OPENROUTER_KEY=v2\n');
  });
});

describe('validateApiKeyValue', () => {
  it('rejects empty and whitespace-only values', () => {
    expect(validateApiKeyValue('').ok).toBe(false);
    expect(validateApiKeyValue('   ').ok).toBe(false);
  });
  it('rejects embedded newlines', () => {
    expect(validateApiKeyValue('sk-or-abc\nDSH_API_DEEPSEEK_KEY=hijacked').ok).toBe(false);
  });
  it('accepts and trims a normal single-line value', () => {
    const result = validateApiKeyValue('  sk-or-real-value  ');
    expect(result).toEqual({ ok: true, value: 'sk-or-real-value' });
  });
});

describe('updateOpenRouterKeyInEnvFile (integration against a real temp .env)', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apikey-'));
    envPath = path.join(dir, '.env');
    delete process.env[OPENROUTER_KEY_ENV_NAME];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[OPENROUTER_KEY_ENV_NAME];
  });

  it('creates the file when absent and writes only the OpenRouter key', () => {
    const result = updateOpenRouterKeyInEnvFile(envPath, 'sk-or-first');
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(envPath, 'utf8')).toBe('DSH_API_OPENROUTER_KEY=sk-or-first\n');
  });

  it('replaces an existing key and preserves unrelated lines byte-for-byte', () => {
    fs.writeFileSync(envPath, '# owner secrets\nDSH_API_OPENROUTER_KEY=old\nDSH_API_DEEPSEEK_KEY=deepseek-value\nTELEGRAM_BOT_TOKEN=abc\n');
    const result = updateOpenRouterKeyInEnvFile(envPath, 'sk-or-rotated');
    expect(result).toEqual({ ok: true });
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).toContain('DSH_API_OPENROUTER_KEY=sk-or-rotated');
    expect(content).toContain('DSH_API_DEEPSEEK_KEY=deepseek-value');
    expect(content).toContain('TELEGRAM_BOT_TOKEN=abc');
    expect(content).not.toContain('=old');
  });

  it('takes effect on process.env immediately, without a restart', () => {
    updateOpenRouterKeyInEnvFile(envPath, 'sk-or-live');
    expect(process.env[OPENROUTER_KEY_ENV_NAME]).toBe('sk-or-live');
  });

  it('rejects an empty value and never touches the file', () => {
    fs.writeFileSync(envPath, 'DSH_API_OPENROUTER_KEY=untouched\n');
    const result = updateOpenRouterKeyInEnvFile(envPath, '   ');
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('DSH_API_OPENROUTER_KEY=untouched\n');
    expect(process.env[OPENROUTER_KEY_ENV_NAME]).toBeUndefined();
  });

  it('never returns the secret value in its result, on success or failure', () => {
    const ok = updateOpenRouterKeyInEnvFile(envPath, 'sk-or-should-not-leak');
    expect(JSON.stringify(ok)).not.toContain('sk-or-should-not-leak');
    const failed = updateOpenRouterKeyInEnvFile(envPath, 'bad\nvalue');
    expect(JSON.stringify(failed)).not.toContain('bad\nvalue');
  });
});
