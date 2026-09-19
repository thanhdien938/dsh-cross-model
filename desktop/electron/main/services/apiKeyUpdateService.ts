import fs from 'fs';
import path from 'path';

// P11-R4.1 — trusted, main-process-only OpenRouter API key rotation.
//
// The Desktop renderer never sees the current key value (Part F/AL) and
// never round-trips a new one back after Save (Part I) — this file is the
// ONE place that ever reads or writes DSH_API_OPENROUTER_KEY, called only
// from main.ts's `backends:updateApiKey` IPC handler, which itself hard-
// rejects any providerId other than 'openrouter' before this is reached.
//
// This deliberately reuses the SAME `.env` file envBootstrap.ts already
// resolves for the session (main.ts passes the resolved path in) rather
// than inventing a second secret store (Part H) — production-pm-backend-
// registry.mjs's `apiEnv` defaults to `process.env` BY REFERENCE, so once
// this writes `process.env[OPENROUTER_KEY_ENV_NAME]`, the next
// capabilities()/model-discovery/dispatch call already sees it — no
// registry-singleton invalidation needed (confirmed by reading that
// constructor before relying on it here).

export const OPENROUTER_KEY_ENV_NAME = 'DSH_API_OPENROUTER_KEY';

export type ApiKeyUpdateResult = { ok: true } | { ok: false; code: string; message: string };

// Pure validation — never touches disk. Rejects empty/whitespace-only and
// anything that would break a single `KEY=value` .env line.
export function validateApiKeyValue(rawValue: unknown): { ok: true; value: string } | { ok: false; code: string; message: string } {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return { ok: false, code: 'API_KEY_VALUE_EMPTY', message: 'API key value must not be empty' };
  if (/[\r\n]/.test(value)) return { ok: false, code: 'API_KEY_VALUE_INVALID', message: 'API key value must be a single line (no line breaks)' };
  return { ok: true, value };
}

// Pure string transform, independently testable — replaces an existing
// `KEY=...` line (a real assignment, never a `# KEY=...` comment) or
// appends a new one, preserving every other line byte-for-byte (comments,
// blank lines, ordering, other secrets).
export function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.length ? content.split(/\r?\n/) : [];
  // Normalize away any trailing blank line(s) from the source content up
  // front (rather than only conditionally on the append branch) so the
  // result always ends in exactly one trailing newline regardless of
  // whether a line was replaced or appended.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pattern = new RegExp(`^${key}=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${key}=${value}`);
  return `${next.join('\n')}\n`;
}

// Atomic write — temp file + fsync + rename, mirroring
// PmProfileConfigService's writeAtomicWithBackup discipline. No backup/
// restore step is needed here (unlike the YAML profile writer): the
// candidate content is derived from the current on-disk content itself
// (upsertEnvLine only ever replaces the one target line or appends), so
// there is no separate "revalidate the whole file" step that could fail.
function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.env.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  const fd = fs.openSync(tmpPath, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath); // atomic on the same filesystem
}

// `envFilePath` must always be the path main.ts already resolved via
// envBootstrap.ts's `resolveEnvFilePath` (or, if none resolved yet, the
// same `<repoRoot>/.env` dev-fallback tier that resolver itself falls back
// to) — this function never derives its own path, so the write can never
// silently land somewhere the rest of the app doesn't read from.
export function updateOpenRouterKeyInEnvFile(envFilePath: string, rawValue: unknown): ApiKeyUpdateResult {
  const validated = validateApiKeyValue(rawValue);
  if (!validated.ok) return validated;
  try {
    fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
    const existing = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
    const next = upsertEnvLine(existing, OPENROUTER_KEY_ENV_NAME, validated.value);
    writeFileAtomic(envFilePath, next);
    // Take effect for the current process immediately — see file header.
    process.env[OPENROUTER_KEY_ENV_NAME] = validated.value;
    return { ok: true };
  } catch (error: any) {
    return { ok: false, code: 'API_KEY_UPDATE_WRITE_FAILED', message: `failed to persist API key: ${error?.message ?? 'unknown error'}` };
  }
}
