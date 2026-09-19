import { createHash } from 'node:crypto';
import { stableJson } from '../owner/owner-contracts.mjs';

function bounded(value,label){if(typeof value!=='string'||!value||value.length>128)throw new TypeError(`${label} is invalid`);return value;}
export function profileFingerprint(profile){const { credentials,token,apiKey,secret,...safe }=profile;return createHash('sha256').update(stableJson(safe)).digest('hex');}
// P9-R0.4 Part D/R: the only two lifecycle states this wave supports.
// Deliberately NOT part of `profileFingerprint`'s input (see below) —
// ACTIVE/INACTIVE is owner-facing selectability, never execution identity.
const LIFECYCLE_STATUSES = ['ACTIVE', 'INACTIVE'];
// P11-R4.2 Part A/J: the ONE per-entry validate+build routine, shared by
// the constructor (every profile known at composition time) and admit()
// below (a single profile discovered later via a bounded hot-reload —
// see p5-production-composition.mjs's reloadPmProfiles()). Extracted
// verbatim from the constructor's original inline logic so a hot-admitted
// profile can NEVER be more (or less) strict than one present at process
// start — there is exactly one validation path, never a second one that
// could drift.
function buildRegistryEntry(raw, existingIds) {
  const base = { id: bounded(raw.id, 'profile id'), role_kind: raw.role_kind, session_kind: raw.session_kind, product: bounded(raw.product, 'product'), transport: bounded(raw.transport, 'transport'), model: raw.model ?? null, reasoning: raw.reasoning == null ? null : bounded(raw.reasoning, 'reasoning') };
  if (base.role_kind !== 'PM' || !['STATELESS', 'NATIVE_SESSION'].includes(base.session_kind)) throw new TypeError('invalid PM profile');
  const providerRaw = raw.provider ?? null;
  if (base.product === 'api') {
    if (!providerRaw) throw new TypeError('an api PM profile requires a provider id');
    if (base.transport !== 'http') throw new TypeError('an api PM profile transport must be http');
    if (base.session_kind !== 'STATELESS') throw new TypeError('an api PM profile session_kind must be STATELESS (P11-R0)');
  } else if (providerRaw != null) {
    throw new TypeError('provider is only valid for the api product');
  }
  const p = Object.freeze(providerRaw != null ? { ...base, provider: bounded(providerRaw, 'provider') } : base);
  if (existingIds.has(p.id)) throw new TypeError('duplicate PM profile');
  const status = raw.status ?? 'ACTIVE';
  if (!LIFECYCLE_STATUSES.includes(status)) throw new TypeError('invalid PM profile status');
  return Object.freeze({ ...p, fingerprint: profileFingerprint(p), status });
}
export class PmProfileRegistry {
  // P6-W3-R4 Part F2: `reasoning` is an optional, typed profile option —
  // null for a backend that has no configured reasoning-effort value
  // (either UNSUPPORTED/CLI_MANAGED, or simply left at the CLI's own
  // default). Bounded the same way `model`/`product`/`transport` already
  // are; never a free-form object, so this can never smuggle extra config.
  // P11-R0 Part A: `provider` is an OPTIONAL identity field, meaningful
  // only for `product:'api'` (spec: PM profile identity extends to
  // provider/model/reasoning/transport/session_kind for an API profile).
  // It is deliberately included in the frozen `base` object BELOW
  // `profileFingerprint`'s input ONLY when present (`raw.provider!=null`)
  // — every pre-existing (non-api) profile's object shape, and therefore
  // its `profileFingerprint()` hash, stays BYTE-FOR-BYTE UNCHANGED (the key
  // is entirely absent, not `provider:null`), which is what preserves every
  // already-pinned `pm_run` fingerprint across this change (P8 invariant —
  // see pm-profile-identity.mjs's identical care with executionIdentityKey).
  // P9-R0.4 Part F/G/R: `status` defaults to ACTIVE when omitted — every
  // profile that predates this field (every profile in every existing
  // pm-profiles.yaml) comes back ACTIVE with zero owner-facing config
  // rewrite. It is computed and attached to the stored entry AFTER
  // `profileFingerprint(p)` runs on `p` alone (the seven execution-
  // identity fields above) — so toggling status can never change a
  // profile's fingerprint, and a durable pm_run's pinned fingerprint
  // (assertPinned below) stays valid across any future deactivate/
  // reactivate (Part R: lifecycle state is not execution identity).
  constructor(profiles=[]){this.items=new Map();for(const raw of profiles){const entry=buildRegistryEntry(raw,new Set(this.items.keys()));this.items.set(entry.id,entry);}}
  get(id){const p=this.items.get(id);if(!p)throw Object.assign(new Error('PM profile is not registered'),{code:'PM_PROFILE_NOT_REGISTERED'});return p;}
  assertPinned(id,fingerprint){const p=this.get(id);if(p.fingerprint!==fingerprint)throw Object.assign(new Error('PM profile fingerprint mismatch'),{code:'PM_PROFILE_MISMATCH'});return p;}
  list(){return [...this.items.values()];}
  // P11-R4.2 Part A/D/J: admit exactly ONE newly-discovered profile into
  // this ALREADY-LIVE registry, mutating `this.items` in place — every
  // existing holder of this SAME registry instance (resolveDriver's
  // inspect/resolve closures, workflowRunnerForProject, createRuntime —
  // see p5-production-composition.mjs) sees it on their very next call,
  // with no need to swap object references anywhere. Uses the exact same
  // buildRegistryEntry() validation the constructor does — a hot-admitted
  // profile is never more permissive. Throws (never silently ignores) on
  // an invalid entry or a duplicate id — the caller (reloadPmProfiles)
  // catches this per-profile so one bad entry never blocks the others.
  // Never called for an id already present — see hasProfile() below,
  // which the caller uses to skip already-known ids before ever reaching
  // here (so "duplicate PM profile" here only ever means a genuine
  // same-tick race, not the normal re-admit-on-every-reload path).
  admit(raw){const entry=buildRegistryEntry(raw,new Set(this.items.keys()));this.items.set(entry.id,entry);return entry;}
  hasProfile(id){return this.items.has(id);}
}
