// P9-R0.4 Part J/W: a deliberately tiny, read-only, always-fresh view of
// ONE mutable field — `status` — on the same durable pm-profiles.yaml file
// PmProfileRegistry already loads once at runtime-composition time.
//
// Why this exists: PmProfileRegistry (and everything built from it —
// OwnerControlService's `pmProfiles` map, the council chair/participant
// validation set) is a frozen SNAPSHOT taken once when the production
// runtime process starts (see p5-production-composition.mjs). Execution
// IDENTITY (product/model/reasoning/session_kind) is deliberately meant to
// be fixed for the process lifetime that way. Lifecycle STATE is not
// identity (Part R) and the owner reasonably expects a deactivate/
// reactivate flip from Desktop's PM Profile Management surface to take
// effect immediately — not after a full runtime restart. This store closes
// that gap narrowly: it re-reads the one `status` field, fresh, off disk,
// on demand — never any other field, never a second copy of profile
// identity, never a cache to go stale.
//
// Fails soft: any read/parse problem (missing file, mid-write, malformed
// YAML) resolves `undefined` (getStatus) / `null` (getAllStatuses) rather
// than throwing — the caller (OwnerControlService) falls back to the
// frozen snapshot's own `status` in that case, so a transient disk hiccup
// degrades to "last known state", never a hard failure of an unrelated
// owner command.
//
// P9-R0.4.2: also the ONE fresh-lifecycle source Telegram's read
// projections (/profiles, /pms, /aliases) reuse via
// OwnerControlService#read('GET_PM_PROFILES') — getAllStatuses() below,
// never a second independent lifecycle store.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export class PmProfileStatusStore {
  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('PM profile status store path is required');
    this.path = path;
  }

  // Shared by getStatus()/getAllStatuses() — one read+parse, never thrown
  // out of this class; resolves `null` on any read/parse problem (missing
  // file, mid-write, malformed YAML).
  async #readEntries() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch { return null; }
    let doc;
    try { doc = parse(raw); }
    catch { return null; }
    return Array.isArray(doc?.pm_profiles) ? doc.pm_profiles : [];
  }

  // Returns 'ACTIVE' | 'INACTIVE' | undefined (unknown id, or the read/
  // parse itself failed). Used by the SUBMIT_TASK execution gate
  // (OwnerControlService#assertProfileActive) — one id at a time, since a
  // council checks a small, known set of ids sequentially.
  async getStatus(id) {
    const entries = await this.#readEntries();
    if (!entries) return undefined;
    const entry = entries.find((p) => p && p.id === id);
    if (!entry) return undefined;
    return entry.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  }

  // P9-R0.4.2 Part B/L: one read for EVERY profile's current status, used
  // by read/list projections that need the whole catalogue fresh at once
  // (Telegram's /profiles, /pms, /aliases via OwnerControlService's
  // GET_PM_PROFILES) — a single bounded local file read per request,
  // never N separate reads for N profiles. Returns a `Map<id, 'ACTIVE' |
  // 'INACTIVE'>`, or `null` if the read/parse itself failed (Part G
  // failure policy: the caller must not treat `null` as "every profile is
  // ACTIVE").
  async getAllStatuses() {
    const entries = await this.#readEntries();
    if (!entries) return null;
    const map = new Map();
    for (const p of entries) {
      if (p && typeof p.id === 'string') map.set(p.id, p.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
    }
    return map;
  }
}
