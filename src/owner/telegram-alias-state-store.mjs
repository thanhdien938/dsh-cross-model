// P8-R0.1: durable storage for the Telegram alias PROJECTION — a small,
// DSH-MANAGED YAML file recording which stable numeric alias was already
// handed out to which canonical project/PM-profile id, plus the next
// not-yet-used alias number for each axis (the "high-water mark" that makes
// alias non-reuse possible — see telegram-alias-reconciler.mjs).
//
// This is NOT operator-authored declarative config (that was P8-R0's
// mistake — see docs/p8/03_DYNAMIC_ALIAS_RECONCILIATION.md). The owner
// never hand-writes this file; DSH creates and updates it automatically as
// projects/PM profiles are added, edited, or removed.
import { readFile, rename, unlink, open } from 'node:fs/promises';
import { parse, stringify } from 'yaml';

export const TELEGRAM_ALIAS_STATE_VERSION = 1;

export class TelegramAliasStateError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TelegramAliasStateError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function emptyTelegramAliasState() {
  return { version: TELEGRAM_ALIAS_STATE_VERSION, next_project_alias: 1, next_pm_profile_alias: 1, projects: {}, pm_profiles: {} };
}

function validateShape(doc) {
  if (doc == null) return emptyTelegramAliasState();
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new TelegramAliasStateError('telegram alias state must be a plain object', 'ALIAS_STATE_MALFORMED');
  if (doc.version !== TELEGRAM_ALIAS_STATE_VERSION) throw new TelegramAliasStateError(`unsupported telegram alias state version: ${doc.version}`, 'ALIAS_STATE_VERSION_UNSUPPORTED');
  const next = (v) => { if (!Number.isInteger(v) || v < 1) throw new TelegramAliasStateError('alias high-water mark is invalid', 'ALIAS_STATE_MALFORMED'); return v; };
  const map = (v, label) => { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) throw new TelegramAliasStateError(`${label} must be a plain object`, 'ALIAS_STATE_MALFORMED'); return v; };
  return {
    version: TELEGRAM_ALIAS_STATE_VERSION,
    next_project_alias: next(doc.next_project_alias ?? 1),
    next_pm_profile_alias: next(doc.next_pm_profile_alias ?? 1),
    projects: map(doc.projects, 'projects'),
    pm_profiles: map(doc.pm_profiles, 'pm_profiles'),
  };
}

export class TelegramAliasStateStore {
  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('telegram alias state path is required');
    this.path = path;
  }

  // Returns the parsed+validated state, or the fresh empty state (Part
  // "FIRST BOOT"/"missing file") if the file does not exist yet — never
  // throws for a missing file. Throws TelegramAliasStateError for a file
  // that exists but is malformed/unsupported-version — the caller (the
  // reconciler) is responsible for treating that as "alias state
  // unavailable" rather than failing the whole runtime (Part "FAILURE
  // POLICY").
  async read() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return emptyTelegramAliasState(); throw new TelegramAliasStateError(`unable to read telegram alias state: ${error.message}`, 'ALIAS_STATE_IO_ERROR'); }
    let doc;
    try { doc = parse(raw); } catch (error) { throw new TelegramAliasStateError(`telegram alias state is not valid YAML: ${error.message}`, 'ALIAS_STATE_MALFORMED'); }
    return validateShape(doc);
  }

  // Atomic write: temp file in the same directory -> fsync -> rename. A
  // crash mid-write leaves either the old file intact or the new one fully
  // written — never a half-written/corrupt state file (Part "ATOMICITY").
  async write(state) {
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(stringify(state), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw new TelegramAliasStateError(`unable to persist telegram alias state: ${error.message}`, 'ALIAS_STATE_IO_ERROR');
    }
  }
}
