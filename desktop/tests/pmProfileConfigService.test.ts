import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';
import { PmProfileConfigService } from '../electron/main/services/pmProfileConfigService';
// P9-R0.4.1 Part A: the ONE real algorithm — imported directly here only to
// prove the constructor's inline default fallback (used when main.ts's
// dynamic import of this same module can't resolve) never drifts from it.
import { executionIdentityKey } from '../../src/pm/pm-profile-identity.mjs';

const SUPPORTED = ['claude-code', 'opencode', 'codex', 'grok'];
const SUPPORTED_WITH_ANTIGRAVITY = [...SUPPORTED, 'antigravity'];
const okValidator = async () => ({ ok: true });
const failValidator = async () => ({ ok: false, code: 'CONFIG_VALIDATION_FAILED', message: 'nope' });
// P9-R0.3 Part F: the same rule real production execution enforces
// (deriveAntigravityReasoningFromModel — src/session/antigravity-cli-
// session-bridge.mjs), duplicated here only as a deterministic test double
// so this suite never depends on a real ESM dynamic import succeeding.
const fakeDeriveAntigravityReasoning = (model: string | null) => {
  const match = model?.match(/-(low|medium|high)$/i);
  return match ? match[1].toLowerCase() : null;
};

describe('PmProfileConfigService', () => {
  let root: string;
  let profilesPath: string;
  let configPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pmprofiles-'));
    profilesPath = path.join(root, 'pm-profiles.yaml');
    configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(profilesPath, 'pm_profiles:\n  - id: live1-claude-pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: claude-code\n    transport: stdio\n');
    fs.writeFileSync(configPath, 'mode: production\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists existing profiles from the durable file without requiring a running runtime', () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('live1-claude-pm');
  });

  it('creates a Codex PM profile atomically and preserves the pre-existing Claude profile', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'live1-codex-pm', product: 'codex', model: 'gpt-5.6-sol' });
    expect(result.ok).toBe(true);
    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    expect(doc.pm_profiles).toHaveLength(2);
    expect(doc.pm_profiles.find((p: any) => p.id === 'live1-claude-pm')).toBeTruthy();
    const codex = doc.pm_profiles.find((p: any) => p.id === 'live1-codex-pm');
    expect(codex.product).toBe('codex');
    expect(codex.session_kind).toBe('STATELESS');
    expect(codex.transport).toBe('stdio');
    expect(codex.model).toBe('gpt-5.6-sol');
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  // P11-R5 Part U: "Create Variant" is not a separate code path — it is
  // the SAME create() called again with a different id/reasoning; the
  // source profile is never touched, and an identical re-attempt is
  // refused. Explicit Codex coverage for the R5 owner brief.
  it('Codex Create Variant: same model + different reasoning creates a NEW immutable profile, original untouched, exact duplicate refused', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const original = await service.create({ id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(original.ok).toBe(true);

    const variant = await service.create({ id: 'live1-codex-gpt-5-6-sol-pm-high', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' });
    expect(variant.ok).toBe(true);

    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    const originalEntry = doc.pm_profiles.find((p: any) => p.id === 'live1-codex-gpt-5-6-sol-pm');
    expect(originalEntry.reasoning).toBe('medium'); // untouched by the variant creation

    const duplicate = await service.create({ id: 'live1-codex-gpt-5-6-sol-pm-2', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
      expect(duplicate.existingProfileId).toBe('live1-codex-gpt-5-6-sol-pm');
    }
  });

  it('creates a Grok PM profile with a reasoning value', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'live1-grok-pm', product: 'grok', reasoning: 'high' });
    expect(result.ok).toBe(true);
    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    expect(doc.pm_profiles.find((p: any) => p.id === 'live1-grok-pm').reasoning).toBe('high');
  });

  it('refuses a duplicate profile id and never touches the file', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.create({ id: 'live1-claude-pm', product: 'claude-code' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_ID_DUPLICATE');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('refuses an unsupported product', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'x', product: 'not-a-real-backend' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_PRODUCT_UNSUPPORTED');
  });

  it('refuses NATIVE_SESSION — only STATELESS is exposed from this surface', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'x', product: 'codex', sessionKind: 'NATIVE_SESSION' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_SESSION_KIND_UNSUPPORTED');
  });

  it('rejects an invalid profile id shape', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: '  ', product: 'codex' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_ID_INVALID');
  });

  it('restores the exact prior file verbatim when production revalidation fails', async () => {
    const before = fs.readFileSync(profilesPath, 'utf8');
    const service = new PmProfileConfigService(profilesPath, configPath, failValidator, () => SUPPORTED);
    const result = await service.create({ id: 'live1-codex-pm', product: 'codex' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('CONFIG_VALIDATION_FAILED');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  // P8-R0.2: execution identity (product/model/reasoning/session_kind) is
  // immutable once a profile is created — a historical pm_profile_id must
  // go on meaning the same execution configuration forever. Changing
  // model/reasoning is a create-a-new-profile ("variant") decision, never
  // an in-place edit.
  it('refuses to change model on an existing profile — file untouched', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.update({ id: 'live1-claude-pm', model: 'claude-fable-5' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_IDENTITY_IMMUTABLE');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('refuses to change reasoning on an existing profile — file untouched', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.update({ id: 'live1-claude-pm', reasoning: 'high' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_IDENTITY_IMMUTABLE');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('refuses to change both model and reasoning together on an existing profile', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.update({ id: 'live1-claude-pm', model: 'opus', reasoning: 'max' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_IDENTITY_IMMUTABLE');
  });

  it('a no-op update (identical values) succeeds harmlessly and never mutates an unrelated profile', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-pm', product: 'codex', model: 'gpt-5.6-sol' });
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.update({ id: 'live1-claude-pm', model: null, reasoning: null });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    expect(doc.pm_profiles.find((p: any) => p.id === 'live1-codex-pm').model).toBe('gpt-5.6-sol');
  });

  it('returns a typed not-found error for an unknown profile id', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.update({ id: 'does-not-exist', model: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_NOT_FOUND');
  });

  it('creating a variant with a new id succeeds and leaves the original profile\'s execution identity untouched', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'live1-claude-sonnet-medium', product: 'claude-code', model: 'sonnet', reasoning: 'medium' });
    expect(result.ok).toBe(true);
    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    expect(doc.pm_profiles).toHaveLength(2);
    const original = doc.pm_profiles.find((p: any) => p.id === 'live1-claude-pm');
    expect(original.model ?? null).toBe(null);
    expect(original.reasoning ?? null).toBe(null);
    const variant = doc.pm_profiles.find((p: any) => p.id === 'live1-claude-sonnet-medium');
    expect(variant.model).toBe('sonnet');
    expect(variant.reasoning).toBe('medium');
    expect(variant.product).toBe('claude-code');
  });

  // P9-R0.3 Part F: the trusted, server-side Antigravity model/reasoning
  // guard — must reject BEFORE any write, matching the CLI's own live-
  // proven conflict-validation (docs/p9/06_MODEL_REASONING_SEMANTICS.md).
  it('accepts a matching Antigravity model/reasoning pair unchanged (the live1-antigravity-pm shape)', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const result = await service.create({ id: 'live1-antigravity-pm-2', product: 'antigravity', model: 'gemini-3.5-flash-medium', reasoning: 'medium' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.reasoning).toBe('medium');
  });
  it('auto-derives reasoning from a tiered Antigravity model when reasoning is omitted', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const result = await service.create({ id: 'live1-antigravity-high', product: 'antigravity', model: 'gemini-3.7-flash-high' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.reasoning).toBe('high');
  });
  it('rejects a contradictory Gemini model/reasoning pair BEFORE any write — no partial profile persisted', async () => {
    const before = fs.readFileSync(profilesPath, 'utf8');
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const result = await service.create({ id: 'live1-antigravity-bad', product: 'antigravity', model: 'gemini-3.7-flash-low', reasoning: 'high' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_ANTIGRAVITY_MODEL_REASONING_CONFLICT');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
    const doc = parse(fs.readFileSync(profilesPath, 'utf8'));
    expect(doc.pm_profiles.some((p: any) => p.id === 'live1-antigravity-bad')).toBe(false);
  });
  it('rejects a contradictory GPT-OSS model/reasoning pair the same way', async () => {
    const before = fs.readFileSync(profilesPath, 'utf8');
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const result = await service.create({ id: 'live1-antigravity-oss-bad', product: 'antigravity', model: 'gpt-oss-120b-medium', reasoning: 'low' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_ANTIGRAVITY_MODEL_REASONING_CONFLICT');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });
  it('never invents a reasoning tier for a Claude Antigravity model — no recognized suffix, no derivation, no rejection', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const omitted = await service.create({ id: 'live1-antigravity-claude', product: 'antigravity', model: 'claude-sonnet-4-6' });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error('unreachable');
    expect(omitted.profile.reasoning).toBe(null);
    // An explicit value passes through unmodified too — there is no
    // known tier to judge it against, so it is neither rejected nor
    // silently blanked (Part H: truthful representation, not invention).
    const explicit = await service.create({ id: 'live1-antigravity-claude-explicit', product: 'antigravity', model: 'claude-opus-4-6-thinking', reasoning: 'high' });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error('unreachable');
    expect(explicit.profile.reasoning).toBe('high');
  });
  it('non-Antigravity products are completely unaffected by the guard', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    const result = await service.create({ id: 'live1-codex-conflicting-looking', product: 'codex', model: 'gpt-5.6-sol-low', reasoning: 'high' });
    expect(result.ok).toBe(true);
  });

  // P9-R0.4.1 Part C/S supersedes this: two canonical ids with the exact
  // same execution configuration are now a semantic duplicate and refused
  // at create time — see the "semantic execution-identity duplicate"
  // describe block below for full coverage.
  it('a second profile with the exact same execution configuration is refused as a semantic duplicate', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-pm-a', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.create({ id: 'live1-codex-pm-b', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
    expect(result.existingProfileId).toBe('live1-codex-pm-a');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  // ==== P9-R0.4: PM profile lifecycle (deactivate/reactivate) ==============

  it('an existing (pre-R0.4) profile with no status key defaults to ACTIVE', () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    expect(service.list()[0].status).toBe('ACTIVE');
  });

  it('a newly created profile is ACTIVE by default', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.create({ id: 'live1-codex-pm', product: 'codex' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.status).toBe('ACTIVE');
    expect(service.list().find((p) => p.id === 'live1-codex-pm')?.status).toBe('ACTIVE');
  });

  it('deactivate flips ACTIVE -> INACTIVE and persists atomically', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const result = await service.deactivate('live1-claude-pm');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.status).toBe('INACTIVE');
    expect(service.list().find((p) => p.id === 'live1-claude-pm')?.status).toBe('INACTIVE');
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  it('reactivate flips INACTIVE -> ACTIVE and persists atomically', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.deactivate('live1-claude-pm');
    const result = await service.reactivate('live1-claude-pm');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.status).toBe('ACTIVE');
    expect(service.list().find((p) => p.id === 'live1-claude-pm')?.status).toBe('ACTIVE');
  });

  it('deactivate preserves every execution-identity field and the id unchanged', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-pm', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    const before = service.list().find((p) => p.id === 'live1-codex-pm')!;
    const result = await service.deactivate('live1-codex-pm');
    expect(result.ok).toBe(true);
    const after = service.list().find((p) => p.id === 'live1-codex-pm')!;
    expect(after.id).toBe(before.id);
    expect(after.product).toBe(before.product);
    expect(after.model).toBe(before.model);
    expect(after.reasoning).toBe(before.reasoning);
    expect(after.session_kind).toBe(before.session_kind);
    expect(after.transport).toBe(before.transport);
    expect(after.status).toBe('INACTIVE');
  });

  it('deactivating an already-INACTIVE profile is a harmless no-op that never touches the file', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.deactivate('live1-claude-pm');
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.deactivate('live1-claude-pm');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('reactivating an already-ACTIVE profile is a harmless no-op that never touches the file', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.reactivate('live1-claude-pm');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('deactivate/reactivate a nonexistent profile id returns a typed not-found error', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    const deactivateResult = await service.deactivate('does-not-exist');
    expect(deactivateResult.ok).toBe(false);
    if (deactivateResult.ok) throw new Error('unreachable');
    expect(deactivateResult.code).toBe('PM_PROFILE_NOT_FOUND');
    const reactivateResult = await service.reactivate('does-not-exist');
    expect(reactivateResult.ok).toBe(false);
    if (reactivateResult.ok) throw new Error('unreachable');
    expect(reactivateResult.code).toBe('PM_PROFILE_NOT_FOUND');
  });

  it('deactivating one profile never touches an unrelated profile', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-pm', product: 'codex' });
    await service.deactivate('live1-claude-pm');
    expect(service.list().find((p) => p.id === 'live1-codex-pm')?.status).toBe('ACTIVE');
  });

  it('a failed revalidation on deactivate restores the exact prior file verbatim', async () => {
    const before = fs.readFileSync(profilesPath, 'utf8');
    const service = new PmProfileConfigService(profilesPath, configPath, failValidator, () => SUPPORTED);
    const result = await service.deactivate('live1-claude-pm');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('CONFIG_VALIDATION_FAILED');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  // ==== P9-R0.4.1: semantic execution-identity duplicate guard ============
  // Owner-live proof: live1-antigravity-gemini-high and live1-antigravity-
  // gemini-3-7-flash-high are two different canonical ids for the exact
  // same antigravity/gemini-3.7-flash-high/high execution identity.

  it('rejects a create whose execution identity matches an ACTIVE existing profile — no write, no alias consumed', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    await service.create({ id: 'live1-antigravity-gemini-high', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.create({ id: 'live1-antigravity-gemini-3-7-flash-high', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
    expect(result.existingProfileId).toBe('live1-antigravity-gemini-high');
    expect(result.existingStatus).toBe('ACTIVE');
    // Part E: no partial write — the candidate id never appears anywhere.
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
    expect(service.list().some((p) => p.id === 'live1-antigravity-gemini-3-7-flash-high')).toBe(false);
  });

  it('rejects a create whose execution identity matches an INACTIVE existing profile too — reports existingStatus=INACTIVE (Part D)', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    await service.create({ id: 'live1-antigravity-gemini-high', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    await service.deactivate('live1-antigravity-gemini-high');
    const before = fs.readFileSync(profilesPath, 'utf8');
    const result = await service.create({ id: 'live1-antigravity-gemini-dup', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
    expect(result.existingProfileId).toBe('live1-antigravity-gemini-high');
    expect(result.existingStatus).toBe('INACTIVE');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(before);
  });

  it('duplicate comparison sees the POST-derivation identity — an omitted reasoning that Antigravity derivation fills in still collides (Part Q)', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    await service.create({ id: 'live1-antigravity-gemini-high', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    // reasoning OMITTED here — fakeDeriveAntigravityReasoning derives "high"
    // from the model slug, which must be what the duplicate guard compares.
    const result = await service.create({ id: 'live1-antigravity-gemini-high-2', product: 'antigravity', model: 'gemini-3.7-flash-high' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
    expect(result.existingProfileId).toBe('live1-antigravity-gemini-high');
  });

  it('a different model is never flagged as a duplicate', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning);
    await service.create({ id: 'live1-antigravity-gemini-high', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' });
    const result = await service.create({ id: 'live1-antigravity-gemini-medium', product: 'antigravity', model: 'gemini-3.5-flash-medium', reasoning: 'medium' });
    expect(result.ok).toBe(true);
  });

  it('a null model (inherit CLI default) is never a duplicate of a pinned model, even the CLI current default (Part R)', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-pm', product: 'codex', model: null, reasoning: 'medium' });
    const result = await service.create({ id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(result.ok).toBe(true);
  });

  it('the canonical id and lifecycle status never participate in the duplicate comparison', async () => {
    const service = new PmProfileConfigService(profilesPath, configPath, okValidator, () => SUPPORTED);
    await service.create({ id: 'live1-codex-alpha', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    // Same fields, different id -> still a duplicate regardless of what the
    // new id would have been.
    const result = await service.create({ id: 'live1-codex-beta', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PM_PROFILE_EXECUTION_IDENTITY_DUPLICATE');
  });

  // The constructor's inline default (used whenever main.ts's dynamic
  // import of pm-profile-identity.mjs can't resolve) must never drift from
  // the real, canonical algorithm — proven here by running the exact same
  // fixture set through a service using the DEFAULT and a service
  // EXPLICITLY injected with the real executionIdentityKey, and requiring
  // identical accept/reject outcomes on every one, including the Part R
  // null-vs-pinned-model boundary a drifted implementation would most
  // plausibly get wrong.
  it('the inline default duplicate-key algorithm matches src/pm/pm-profile-identity.mjs exactly', async () => {
    const fixtures: { id: string; product: string; model: string | null; reasoning: string | null }[] = [
      { id: 'a1', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' },
      { id: 'a2', product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' }, // duplicate of a1
      { id: 'c1', product: 'codex', model: null, reasoning: 'medium' },
      { id: 'c2', product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' }, // NOT a duplicate of c1 (Part R)
    ];
    for (const injected of [undefined, executionIdentityKey]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pmprofiles-drift-'));
      const pPath = path.join(dir, 'pm-profiles.yaml');
      const cPath = path.join(dir, 'config.yaml');
      fs.writeFileSync(pPath, 'pm_profiles: []\n');
      fs.writeFileSync(cPath, 'mode: production\n');
      const service = new PmProfileConfigService(pPath, cPath, okValidator, () => SUPPORTED_WITH_ANTIGRAVITY, fakeDeriveAntigravityReasoning, injected as any);
      const outcomes: boolean[] = [];
      for (const f of fixtures) outcomes.push((await service.create(f)).ok);
      expect(outcomes).toEqual([true, false, true, true]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
