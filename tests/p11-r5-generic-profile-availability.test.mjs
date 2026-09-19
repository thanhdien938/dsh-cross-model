// P11-R5 Part C/D/E/G/AH — the ACTUAL generic "new profile shows
// unavailable" bug and its fix.
//
// Root cause (confirmed by reading the code): Desktop's Composer profile
// selector (Composer.tsx) renders `p.available ? '' : ' — unavailable'`
// and disables the <option>/<checkbox> when `!p.available`. That flag
// comes from main.ts's `pm:profiles`/`connections:list` IPC handlers,
// which both read `runtimeSupervisor.getReadiness().pmProfiles.backends`
// — the runtime's `pmBackendStatus` array. R4.2's reloadPmProfiles()
// admitted a new profile into profileRegistry/ownerService/adapter but
// NEVER touched `pmBackendStatus` — so a hot-admitted profile of ANY
// product was simply ABSENT from `backends`, and `pm:profiles` defaulted
// `available` to `false` for it (`availableById.get(p.id) ?? false`).
// This was never api/OpenRouter-specific; it affected all six backends
// identically. The fix: reloadPmProfiles() now pushes the SAME
// synchronous, non-network config-validity check (resolveDriver.inspect)
// the startup path already computes, onto the SAME `pmBackendStatus`
// array `readiness()`'s closure reads — no restart, no per-backend
// branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition, createProductionPmDriverResolver } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'p11-r5-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n    autonomy:\n      revision: 1\n      effects:\n        SUBMIT_TASK: ALLOW\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(join(root, 'config.yaml'), `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\n  project_id: p\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions:\n    - type: finish\n      output: ok\n`);
  return { root, path: join(root, 'config.yaml'), profilesPath: join(root, 'profiles.yaml'), env: { DSH_TEST_PG: 'postgresql://u:random-password@localhost/db', DSH_TEST_TG: 'random-token-value' } };
}

// `factories` (one trivial fake driver per product) makes
// createProductionPmDriverResolver().inspect() report `available:true`
// WITHOUT any real CLI probe or network call for that product — the
// SAME "is this backend class resolvable" branch every real CLI/backend
// takes, just fixture-substituted (Part G: "Use fixtures where live
// provider execution is unnecessary"). This proves the HOT-RELOAD
// wiring is product-agnostic; real CLI-probe/OpenRouter-registry
// behavior is already covered elsewhere (phase5-r2 R2.1 tests,
// p11-r4-openrouter-model-discovery.test.mjs).
const SIX_BACKEND_PRODUCTS = ['claude-code', 'codex', 'opencode', 'grok', 'antigravity', 'api'];
const fakeDriver = { decide: async () => ({ type: 'finish', output: 'ok' }) };
const factories = Object.fromEntries(SIX_BACKEND_PRODUCTS.map((product) => [product, () => fakeDriver]));

async function buildComposition(f) {
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const coordination = { assertReady: async () => true, close: async () => {}, registerCoordinatorIncarnation: async () => {}, acquireLeadership: async () => null, registerWorkIdentity: async () => {} };
  const owner = { close: async () => {}, beginCommand: async () => ({ status: 'PENDING', created_at: new Date().toISOString() }), claimNotifications: async () => [], completeCommand: async (id, canonical) => ({ command_id: id, status: 'COMPLETED', ...canonical }) };
  // scriptedDecisions covers the fixture's own baseline `pm` (product
  // 'scripted') profile — factories cover the six real products under
  // test, entirely separately (createProductionPmDriverResolver's
  // inspect() checks factories first, then 'scripted', then the real
  // registry — never conflated).
  const resolveDriver = createProductionPmDriverResolver({ factories, scriptedDecisions: config.pm.scriptedDecisions });
  return createP5ProductionComposition(config, { sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, resolvePmDriver: resolveDriver, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
}

function appendProfile(profilesPath, entry) {
  const doc = parse(readFileSync(profilesPath, 'utf8'));
  doc.pm_profiles.push(entry);
  writeFileSync(profilesPath, stringify(doc));
}

test('reloadPmProfiles makes a new profile available in readiness().pmProfiles.backends — generic, works for all six backend products', async (t) => {
  for (const product of SIX_BACKEND_PRODUCTS) {
    const f = fixture(t);
    const composition = await buildComposition(f);
    const raw = product === 'api'
      ? { id: `pm-${product}`, role_kind: 'PM', session_kind: 'STATELESS', product, provider: 'openrouter', transport: 'http', model: 'some/model', reasoning: 'medium' }
      : { id: `pm-${product}`, role_kind: 'PM', session_kind: 'STATELESS', product, transport: 'stdio', model: null };
    appendProfile(f.profilesPath, raw);

    const before = composition.readiness();
    assert.equal(before.pmProfiles.backends.some((b) => b.profile_id === `pm-${product}`), false, `${product}: must be absent before reload`);

    const result = await composition.reloadPmProfiles();
    assert.deepEqual(result.admitted, [`pm-${product}`], `${product}: must be admitted`);
    assert.deepEqual(result.rejected, [], `${product}: must not be rejected`);

    const after = composition.readiness();
    const entry = after.pmProfiles.backends.find((b) => b.profile_id === `pm-${product}`);
    assert.ok(entry, `${product}: must be present in readiness().pmProfiles.backends after reload`);
    assert.equal(entry.available, true, `${product}: must be reported available (config-valid, no restart)`);
    assert.equal(after.pmProfiles.count, before.pmProfiles.count + 1, `${product}: live count must grow`);
    assert.equal(after.pmProfiles.resolvable, true, `${product}: resolvable must stay true`);

    await composition.close();
  }
});

test('Part AH: a valid never-run profile is NOT unavailable — matches the exact flag Composer.tsx renders ("— unavailable"/disabled) as `available: true`', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'pm-codex-2', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: null });
  await composition.reloadPmProfiles();
  const entry = composition.readiness().pmProfiles.backends.find((b) => b.profile_id === 'pm-codex-2');
  // This is the EXACT field main.ts's pm:profiles IPC handler copies
  // straight into PmProfileOption.available, which Composer.tsx renders
  // as `p.available ? '' : ' — unavailable'` and `disabled={!p.available}`.
  assert.equal(entry.available, true);
  await composition.close();
});

test('Part AH: an invalid new profile is rejected with a typed reason, never silently marked available', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'pm-bad', role_kind: 'PM', session_kind: 'NOT_REAL', product: 'codex', transport: 'stdio' });
  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, []);
  assert.equal(result.rejected[0].code, 'PM_PROFILE_INVALID');
  assert.equal(composition.readiness().pmProfiles.backends.some((b) => b.profile_id === 'pm-bad'), false);
  await composition.close();
});

test('Part AH: a valid profile whose backend is currently unavailable is admitted but reported unavailable (distinct, not blocked)', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const coordination = { assertReady: async () => true, close: async () => {}, registerCoordinatorIncarnation: async () => {}, acquireLeadership: async () => null, registerWorkIdentity: async () => {} };
  const owner = { close: async () => {}, beginCommand: async () => ({ status: 'PENDING', created_at: new Date().toISOString() }), claimNotifications: async () => [], completeCommand: async () => {} };
  // No factory for 'codex' this time, and a backendRegistry stub that
  // always reports unresolvable — simulates "CLI not installed".
  const unavailableBackend = { inspect: (profile) => ({ available: false, code: 'PM_BACKEND_UNAVAILABLE', product: profile.product, transport: profile.transport, session_kind: profile.session_kind }), resolve: () => { throw new Error('must never be called'); }, list: () => [] };
  const resolveDriver = createProductionPmDriverResolver({ backendRegistry: unavailableBackend, scriptedDecisions: config.pm.scriptedDecisions });
  const composition = await createP5ProductionComposition(config, { sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, resolvePmDriver: resolveDriver, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  appendProfile(f.profilesPath, { id: 'pm-codex-down', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: null });

  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, ['pm-codex-down']); // structurally valid — admitted regardless
  assert.equal(composition.profileRegistry.hasProfile('pm-codex-down'), true); // identity/alias-eligible
  const entry = composition.readiness().pmProfiles.backends.find((b) => b.profile_id === 'pm-codex-down');
  assert.equal(entry.available, false); // but truthfully reported unavailable — a DISTINCT state
  assert.equal(entry.code, 'PM_BACKEND_UNAVAILABLE');
  await composition.close();
});

test('deferred providers (deepseek/xcode-best) are never reactivated by a reload — RELOAD_PM_PROFILES only admits what pm-profiles.yaml actually lists', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  // No deepseek/xcode-best entry is ever written to pm-profiles.yaml in
  // this fixture (they are provider-config-only concerns — see
  // config/api-providers.example.yaml — never PM profiles unless an
  // owner explicitly creates one, which P11 policy already refuses for
  // any product:'api' profile whose provider isn't 'openrouter' — see
  // pmProfileConfigService.ts's PM_PROFILE_PROVIDER_DEFERRED guard).
  appendProfile(f.profilesPath, { id: 'pm-or', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'x', reasoning: null });
  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, ['pm-or']);
  assert.equal(composition.readiness().pmProfiles.backends.some((b) => b.product === 'deepseek' || b.product === 'xcode-best'), false);
  await composition.close();
});
