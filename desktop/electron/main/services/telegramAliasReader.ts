import fs from 'fs';
import { parse } from 'yaml';

// P11-R4.2 Part E/F/N: a deliberately tiny, read-only, always-fresh view of
// the SAME `telegram-aliases.yaml` DSH-managed state file the running
// runtime reconciles (src/owner/telegram-alias-reconciler.mjs) — this is
// the ONLY place Desktop reads alias state from, and it never writes to
// this file (alias assignment is exclusively the runtime's job, via the
// pmProfiles:create hot-reload trigger — see main.ts). Mirrors
// PmProfileStatusStore's fail-soft posture: any read/parse problem
// (missing file — normal before the first profile is ever created;
// mid-write; malformed YAML) resolves `null`, never throws — the caller
// (pmProfiles:list) must render "alias not yet known" rather than a hard
// error for a transient/expected miss.

export function readPmProfileAliases(telegramAliasesPath: string): Map<string, string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(telegramAliasesPath, 'utf8');
  } catch {
    return null;
  }
  let doc: any;
  try {
    doc = parse(raw);
  } catch {
    return null;
  }
  const entries = doc?.pm_profiles;
  if (!entries || typeof entries !== 'object') return new Map();
  const map = new Map<string, string>();
  for (const [alias, profileId] of Object.entries(entries)) {
    if (typeof profileId === 'string') map.set(profileId, String(alias));
  }
  return map;
}
