import fs from 'fs';
import path from 'path';
import { parse, stringify } from 'yaml';
import { ConfigValidator } from './projectRegistry';

// P6-W3-R4 Part D: durable, atomic CRUD for the local PM-profile
// configuration file the DSH runtime already consumes (pm_profiles_file —
// see src/runtime/p5-production-config.mjs / src/pm/pm-profile-registry
// .mjs). Mirrors ProjectRegistryService's W2-J write discipline exactly:
// temp file + fsync -> pre-swap backup -> atomic rename -> revalidate the
// *whole* production config through the same validator Add Folder already
// uses -> restore the backup verbatim on any validation failure. A
// candidate pm-profiles.yaml is never accepted here unless the real
// runtime would also accept it, and a failed write never leaves a
// half-written or invalid file on disk.
//
// Deliberately narrower than the runtime's own PmProfileRegistry
// constructor validation (src/pm/pm-profile-registry.mjs): this service
// also refuses an unsupported `product` and any `session_kind` other than
// STATELESS (Part D2 — NATIVE_SESSION is never exposed from this owner-
// facing surface), on top of the id/duplicate/required-field checks the
// runtime validator already performs.

// P9-R0.4 Part D/F/G: `status` is the one lifecycle field this wave adds.
// Optional on the wire (a pre-R0.4 pm-profiles.yaml has no `status` key at
// all on any entry) and always normalized to 'ACTIVE' when absent — see
// normalizeStatus() below — so every existing profile stays selectable
// after upgrade with zero config rewrite (Part G).
export type PmProfileLifecycleStatus = 'ACTIVE' | 'INACTIVE';

export interface PmProfileYamlEntry {
  id: string;
  role_kind?: string;
  session_kind: string;
  product: string;
  provider?: string;
  transport: string;
  model?: string | null;
  reasoning?: string | null;
  status?: PmProfileLifecycleStatus;
}

export interface CreatePmProfileRequest {
  id: string;
  product: string;
  provider?: string;
  model?: string | null;
  sessionKind?: string;
  reasoning?: string | null;
}

export interface UpdatePmProfileRequest {
  id: string;
  model?: string | null;
  reasoning?: string | null;
  sessionKind?: string;
}

// P9-R0.4.1 Part C: on PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE, the failure
// carries the id/status of the already-registered equivalent profile so
// the owner can Reactivate it instead of hand-picking a new id and
// retrying blind.
export type PmProfileWriteResult =
  | { ok: true; profile: PmProfileYamlEntry }
  | { ok: false; code: string; message: string; existingProfileId?: string; existingStatus?: PmProfileLifecycleStatus };

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// D2: the only session kind this owner-facing surface may ever write.
// NATIVE_SESSION stays a runtime-internal concept until it is actually
// supported end-to-end — extending this list is a deliberate, separate
// decision, never an incidental one.
const SUPPORTED_SESSION_KINDS = ['STATELESS'];

export class PmProfileConfigService {
  constructor(
    private readonly profilesYamlPath: string,
    private readonly fullConfigPath: string,
    private readonly validateConfig: ConfigValidator,
    private readonly listSupportedProducts: () => Promise<string[]> | string[],
    // P9-R0.3 Part F: the SAME pure derivation
    // (deriveAntigravityReasoningFromModel — src/session/antigravity-cli-
    // session-bridge.mjs) production execution and Connection Center both
    // already rely on, injected here so this trusted write path can never
    // drift from what the CLI actually enforces. Defaults to "no tier
    // recognized" only if the caller genuinely can't resolve the bridge —
    // degrading to "accept anything" would be the wrong failure direction
    // for a guard, but a hard dependency on ESM dynamic import succeeding
    // at construction time is worse than degrading safely; see
    // main.ts's wiring for the real resolver.
    private readonly deriveAntigravityReasoning: (model: string | null) => Promise<string | null> | string | null = () => null,
    // P9-R0.4.1 Part A: the SAME pure execution-identity comparison
    // (executionIdentityKey — src/pm/pm-profile-identity.mjs) the create-
    // time duplicate guard below uses to detect a semantically-identical
    // profile under a NEW canonical id — never a second, hand-rolled copy
    // of that comparison. Same "degrade to the identical inline algorithm
    // rather than hard-fail construction" posture as
    // deriveAntigravityReasoning above; see main.ts's wiring for the real
    // ESM-dynamic-import resolver. The default is kept byte-for-byte
    // identical to pm-profile-identity.mjs's real implementation (proven
    // by a regression test) — it exists only so this constructor never
    // hard-depends on a dynamic import succeeding.
    private readonly computeExecutionIdentityKey: (profile: {
      role_kind: string;
      session_kind: string;
      product: string;
      provider?: string | null;
      transport: string;
      model: string | null;
      reasoning: string | null;
    }) => Promise<string> | string = (profile) => JSON.stringify([profile.role_kind ?? null, profile.session_kind ?? null, profile.product ?? null, profile.provider ?? null, profile.transport ?? null, profile.model ?? null, profile.reasoning ?? null]),
  ) {}

  list(): PmProfileYamlEntry[] {
    // Part G: normalize every entry's `status` to 'ACTIVE' when the YAML
    // key is absent — every caller (Management UI, Composer/Chair/
    // Participants selector merge in main.ts, tests) can rely on `status`
    // always being present and valid, never `undefined`.
    return (this.readDocument().pm_profiles ?? []).map((p) => ({ ...p, status: normalizeStatus(p.status) }));
  }

  async create(request: CreatePmProfileRequest): Promise<PmProfileWriteResult> {
    const id = String(request.id ?? '').trim();
    if (!PROFILE_ID_PATTERN.test(id)) {
      return { ok: false, code: 'PM_PROFILE_ID_INVALID', message: 'profile id must start with a letter/digit and contain only letters, digits, . _ : - (max 128 chars)' };
    }
    const products = await Promise.resolve(this.listSupportedProducts());
    if (!products.includes(request.product)) {
      return { ok: false, code: 'PM_PROFILE_PRODUCT_UNSUPPORTED', message: `product must be one of: ${products.join(', ')}` };
    }
    const sessionKind = request.sessionKind ?? 'STATELESS';
    if (!SUPPORTED_SESSION_KINDS.includes(sessionKind)) {
      return { ok: false, code: 'PM_PROFILE_SESSION_KIND_UNSUPPORTED', message: `session kind must be one of: ${SUPPORTED_SESSION_KINDS.join(', ')}` };
    }
    const existing = this.list();
    // D1: never silently overwrite an existing id.
    if (existing.some((p) => p.id === id)) {
      return { ok: false, code: 'PM_PROFILE_ID_DUPLICATE', message: `a PM profile with id "${id}" already exists` };
    }

    const model = normalizeOptionalString(request.model);
    const provider = normalizeOptionalString(request.provider);
    if (request.product === 'api' && provider !== 'openrouter') return { ok: false, code: 'PM_PROFILE_PROVIDER_DEFERRED', message: 'OpenRouter is the only active production API provider for P11' };
    if (request.product !== 'api' && provider !== null) return { ok: false, code: 'PM_PROFILE_PROVIDER_INVALID', message: 'provider is only valid for API profiles' };
    let reasoning = normalizeOptionalString(request.reasoning);
    // P9-R0.3 Part F/G: trusted, server-side guard — never rely on
    // renderer UX alone. For Antigravity, a model slug that carries a
    // recognized reasoning tier (every current Gemini/GPT-OSS slug) makes
    // that tier authoritative: an explicit, DIFFERENT reasoning value is
    // rejected BEFORE any write (Part L: no partial profile, no alias
    // allocated — this returns before writeEntries() is ever called);
    // an omitted reasoning is auto-filled with the derived tier (Part G —
    // consistent with P8 identity rules since this happens once, at
    // creation, before the profile is ever frozen/persisted, never as an
    // in-place mutation of an existing profile). A model with NO
    // recognized tier (every current Claude slug) is left completely
    // alone — Part H: never invent a tier from "(Thinking)" or anything
    // else; whatever reasoning value (or none) the owner supplied passes
    // through unchanged, since there is no evidence to judge it against.
    if (request.product === 'antigravity') {
      const derivedTier = await Promise.resolve(this.deriveAntigravityReasoning(model));
      if (derivedTier) {
        if (reasoning !== null && reasoning !== derivedTier) {
          return {
            ok: false,
            code: 'PM_PROFILE_ANTIGRAVITY_MODEL_REASONING_CONFLICT',
            message: `model "${model}" encodes reasoning tier "${derivedTier}" but reasoning "${reasoning}" was requested — Antigravity's model slug is its native execution identity, so they must match; create the profile with reasoning "${derivedTier}" (or omit it) instead`,
          };
        }
        reasoning = derivedTier;
      }
    }

    // P9-R0.4.1 Part C/D/Q/S: trusted, server-side semantic-duplicate
    // guard — runs AFTER model/reasoning normalization and the Antigravity
    // derivation/conflict guard above (Part Q: duplicate comparison must
    // see the FINAL normalized identity, e.g. an omitted reasoning that
    // Antigravity derivation just filled in), BEFORE any write (Part E: no
    // config write, no alias reconciliation allocation on rejection).
    // Compares ONLY execution-identity fields (never id/status — Part S:
    // an ACTIVE and an INACTIVE profile with identical fields are still
    // duplicates) against every currently-registered profile, active or
    // inactive alike, so recreating a deactivated duplicate under a new id
    // is refused exactly like recreating an active one (Part D).
    const transport = request.product === 'api' ? 'http' : 'stdio';
    const candidateKey = await Promise.resolve(this.computeExecutionIdentityKey({ role_kind: 'PM', session_kind: sessionKind, product: request.product, provider, transport, model, reasoning }));
    let duplicate: PmProfileYamlEntry | undefined;
    for (const p of existing) {
      const key = await Promise.resolve(this.computeExecutionIdentityKey({ role_kind: p.role_kind ?? 'PM', session_kind: p.session_kind, product: p.product, provider: p.provider ?? null, transport: p.transport, model: p.model ?? null, reasoning: p.reasoning ?? null }));
      if (key === candidateKey) {
        duplicate = p;
        break;
      }
    }
    if (duplicate) {
      return {
        ok: false,
        code: 'PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE',
        message: `Equivalent PM profile already exists: ${duplicate.id}`,
        existingProfileId: duplicate.id,
        existingStatus: duplicate.status,
      };
    }

    const entry: PmProfileYamlEntry = {
      id,
      role_kind: 'PM',
      session_kind: sessionKind,
      product: request.product,
      ...(provider ? { provider } : {}),
      transport,
      model,
      reasoning,
      // P9-R0.4 Part Q: every newly-created profile — including a Create
      // Variant of an INACTIVE source profile — is ACTIVE by default. The
      // source profile itself is never touched by this method.
      status: 'ACTIVE',
    };
    return this.writeEntries([...existing, entry], entry);
  }

  // P8-R0.2 Part B/G: a PM profile's EXECUTION IDENTITY —
  // product/model/reasoning/session_kind (id/product/transport were already
  // immutable; model/reasoning/session_kind now join them) — is read-only
  // once the profile has been created. A profile is a stable execution
  // configuration a historical pm_profile_id must go on meaning forever
  // (durable pm_runs/pm_turns rows persist pm_profile_id — see
  // src/pm/pm-profile-registry.mjs), not a mutable label around a backend.
  // Different model or different reasoning is a DIFFERENT profile — the
  // owner-facing flow for that is "Create Variant" (a new canonical id via
  // create()), never an in-place edit here. This is enforced here, in the
  // config SERVICE, independent of whatever the renderer does or doesn't
  // disable — a stale/old-version renderer that still submits an identity
  // change is refused exactly the same way. A request that (redundantly)
  // submits the SAME model/reasoning/session_kind the profile already has
  // is a harmless no-op success (nothing to persist, nothing changed) —
  // this method does not forbid *calling* update(), only forbid it from
  // ever *changing* an execution-identity field.
  async update(request: UpdatePmProfileRequest): Promise<PmProfileWriteResult> {
    const existing = this.list();
    const current = existing.find((p) => p.id === request.id);
    if (!current) {
      return { ok: false, code: 'PM_PROFILE_NOT_FOUND', message: `no PM profile with id "${request.id}"` };
    }
    const nextSessionKind = request.sessionKind ?? current.session_kind;
    const nextModel = request.model === undefined ? current.model ?? null : normalizeOptionalString(request.model);
    const nextReasoning = request.reasoning === undefined ? current.reasoning ?? null : normalizeOptionalString(request.reasoning);
    if (nextSessionKind !== current.session_kind || nextModel !== (current.model ?? null) || nextReasoning !== (current.reasoning ?? null)) {
      return {
        ok: false,
        code: 'PM_PROFILE_IDENTITY_IMMUTABLE',
        message: `PM profile "${request.id}" execution identity (product/model/reasoning/session kind) is immutable once created — create a new profile (a "variant") for a different model or reasoning instead of editing this one`,
      };
    }
    // No-op: the request asked for exactly what is already stored. Nothing
    // to write — never touches the file for a call that changes nothing.
    return { ok: true, profile: current };
  }

  // P9-R0.4 Part D/H/I: SAFE lifecycle management — deactivate/reactivate
  // toggle ONLY `status`, going through the exact same atomic write +
  // full-config revalidate + restore-on-failure discipline as create()
  // (writeEntries below). Every other field on the entry — id, role_kind,
  // session_kind, product, transport, model, reasoning — is copied through
  // completely unchanged, so this can never accidentally touch execution
  // identity (Part R) or the alias reserved for this id (aliases are keyed
  // by canonical id, never touched by this service at all — Part E/I: no
  // alias is freed, recycled, or reassigned by a status flip).
  async deactivate(id: string): Promise<PmProfileWriteResult> {
    return this.setStatus(id, 'INACTIVE');
  }

  async reactivate(id: string): Promise<PmProfileWriteResult> {
    return this.setStatus(id, 'ACTIVE');
  }

  private async setStatus(id: string, status: PmProfileLifecycleStatus): Promise<PmProfileWriteResult> {
    const existing = this.list();
    const current = existing.find((p) => p.id === id);
    if (!current) {
      return { ok: false, code: 'PM_PROFILE_NOT_FOUND', message: `no PM profile with id "${id}"` };
    }
    // Idempotent no-op (Part H/I): already in the requested state — nothing
    // to persist, never touches the file.
    if (current.status === status) {
      return { ok: true, profile: current };
    }
    const next: PmProfileYamlEntry = { ...current, status };
    const entries = existing.map((p) => (p.id === id ? next : p));
    return this.writeEntries(entries, next);
  }

  private async writeEntries(entries: PmProfileYamlEntry[], written: PmProfileYamlEntry): Promise<PmProfileWriteResult> {
    const doc = this.readDocument();
    const candidate = { ...doc, pm_profiles: entries };
    const backup = this.writeAtomicWithBackup(stringify(candidate));
    const validation = await this.validateConfig(this.fullConfigPath);
    if (!validation.ok) {
      this.restoreBackup(backup.backupPath);
      return { ok: false, code: validation.code ?? 'CONFIG_VALIDATION_FAILED', message: validation.message ?? 'configuration failed revalidation' };
    }
    this.discardBackup(backup.backupPath);
    return { ok: true, profile: written };
  }

  private readDocument(): { pm_profiles?: PmProfileYamlEntry[] } {
    if (!fs.existsSync(this.profilesYamlPath)) return { pm_profiles: [] };
    return (parse(fs.readFileSync(this.profilesYamlPath, 'utf8')) ?? { pm_profiles: [] }) as { pm_profiles?: PmProfileYamlEntry[] };
  }

  private writeAtomicWithBackup(content: string): { backupPath: string | null } {
    const dir = path.dirname(this.profilesYamlPath);
    const tmpPath = path.join(dir, `.pm-profiles.yaml.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, content, 'utf8');
    const fd = fs.openSync(tmpPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    let backupPath: string | null = null;
    if (fs.existsSync(this.profilesYamlPath)) {
      backupPath = path.join(dir, `.pm-profiles.yaml.bak-${process.pid}-${Date.now()}`);
      fs.copyFileSync(this.profilesYamlPath, backupPath);
    }
    fs.renameSync(tmpPath, this.profilesYamlPath); // atomic on the same filesystem
    return { backupPath };
  }

  private restoreBackup(backupPath: string | null): void {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, this.profilesYamlPath);
      fs.unlinkSync(backupPath);
    } else if (!backupPath) {
      fs.rmSync(this.profilesYamlPath, { force: true });
    }
  }

  private discardBackup(backupPath: string | null): void {
    if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Part G: an absent/unrecognized `status` on disk (every pre-R0.4 entry)
// normalizes to ACTIVE — never INACTIVE by default, never a throw.
function normalizeStatus(value: unknown): PmProfileLifecycleStatus {
  return value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
}
