// P8-R0.1: a stable, explicit Telegram alias LOOKUP — presentation/routing
// sugar only (Part R), granting no new authority. Every alias resolves to a
// plain canonical id string, and that id still passes through the EXACT
// same OwnerControlService/OwnerTaskController authority path a canonical
// `@<project_id> --pm <profile_id>` command already used.
//
// R0.1 correction: this class is now purely a LOOKUP over an
// already-reconciled alias mapping (see telegram-alias-reconciler.mjs) — it
// no longer validates alias targets against a known-id set itself. That
// validation is the RECONCILER's job, performed once per reconciliation
// pass against the live project/PM-profile registries: a stale/deleted
// target is silently excluded from the mapping THERE (never reissuing its
// alias number), rather than this class throwing at construction. See
// docs/p8/03_DYNAMIC_ALIAS_RECONCILIATION.md.
function reverseFirst(map) {
  const out = new Map();
  for (const [alias, target] of map) if (!out.has(target)) out.set(target, alias);
  return out;
}

export class TelegramAliasError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TelegramAliasError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class TelegramAliasRegistry {
  // `projects`/`pmProfiles`: plain {alias: canonical_id} objects — already
  // reconciled (every target here is, at reconciliation time, a
  // currently-registered project/PM-profile id; a stale target is never
  // present). `available` (default true) is false only when alias state
  // could not be loaded/reconciled at all (Part "FAILURE POLICY") — in that
  // mode every lookup fails closed with ALIAS_STATE_UNAVAILABLE and every
  // listing is empty, but the object itself is still safely duck-typed for
  // every call site in telegram-owner-client.mjs (no null-checks needed
  // there beyond "is aliasing configured at all").
  constructor({ projects = {}, pmProfiles = {}, available = true } = {}) {
    this.available = available;
    this.projects = new Map(Object.entries(projects ?? {}));
    this.pmProfiles = new Map(Object.entries(pmProfiles ?? {}));
    this._projectReverse = reverseFirst(this.projects);
    this._pmReverse = reverseFirst(this.pmProfiles);
  }

  static unavailable() { return new TelegramAliasRegistry({ available: false }); }

  // Part M: unknown alias -> typed, fail-closed error. No fallback, no
  // guessing, no array-position lookup.
  resolveProject(alias) {
    if (!this.available) throw new TelegramAliasError('alias state is unavailable', 'ALIAS_STATE_UNAVAILABLE');
    const id = this.projects.get(String(alias));
    if (!id) throw new TelegramAliasError(`unknown project alias: ${alias}`, 'ALIAS_PROJECT_UNKNOWN', { alias: String(alias) });
    return id;
  }

  resolvePmProfile(alias) {
    if (!this.available) throw new TelegramAliasError('alias state is unavailable', 'ALIAS_STATE_UNAVAILABLE');
    const id = this.pmProfiles.get(String(alias));
    if (!id) throw new TelegramAliasError(`unknown PM alias: ${alias}`, 'ALIAS_PM_UNKNOWN', { alias: String(alias) });
    return id;
  }

  projectAliasFor(projectId) { return this.available ? (this._projectReverse.get(projectId) ?? null) : null; }
  pmAliasFor(pmProfileId) { return this.available ? (this._pmReverse.get(pmProfileId) ?? null) : null; }

  hasAliases() { return this.available && (this.projects.size > 0 || this.pmProfiles.size > 0); }
  listProjectAliases() { return this.available ? [...this.projects.entries()].map(([alias, project_id]) => Object.freeze({ alias, project_id })) : []; }
  listPmAliases() { return this.available ? [...this.pmProfiles.entries()].map(([alias, pm_profile_id]) => Object.freeze({ alias, pm_profile_id })) : []; }
}
