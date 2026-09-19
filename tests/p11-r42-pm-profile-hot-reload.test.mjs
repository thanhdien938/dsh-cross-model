// P11-R4.2 — bounded PM-profile + alias hot-reload, production path.
//
// Root cause this wave fixes: scripts/p5-runtime.mjs calls
// loadP5ProductionConfig() exactly ONCE; a PM profile Desktop writes to
// pm-profiles.yaml while that process is already running was previously
// invisible for the process's whole lifetime (OwnerControlService threw
// PM_PROFILE_UNAVAILABLE — genuinely unknown, not "inactive" — and no
// alias was ever reconciled for it). These tests exercise the EXACT
// production composition path (mirrors phase5-r2-production-composition
// .test.mjs's fixture) end to end: Desktop-style file write -> reload ->
// admitted into the SAME live registry/service/adapter instances -> real
// alias assigned via the SAME loadReconciledTelegramAliases() startup
// uses -> SUBMIT_TASK against the new profile succeeds -> no restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'p11-r42-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n    autonomy:\n      revision: 1\n      effects:\n        SUBMIT_TASK: ALLOW\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(join(root, 'config.yaml'), `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\n  project_id: p\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions:\n    - type: finish\n      output: ok\n`);
  return { root, path: join(root, 'config.yaml'), profilesPath: join(root, 'profiles.yaml'), aliasesPath: join(root, 'telegram-aliases.yaml'), env: { DSH_TEST_PG: 'postgresql://u:random-password@localhost/db', DSH_TEST_TG: 'random-token-value' } };
}

async function buildComposition(f) {
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const coordination = { assertReady: async () => true, close: async () => {}, registerCoordinatorIncarnation: async () => {}, acquireLeadership: async () => null, registerWorkIdentity: async () => {} };
  const owner = { close: async () => {}, beginCommand: async () => ({ status: 'PENDING', created_at: new Date().toISOString() }), claimNotifications: async () => [], completeCommand: async (id, canonical) => ({ command_id: id, status: 'COMPLETED', ...canonical }) };
  return createP5ProductionComposition(config, { sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
}

// Simulates Desktop's PmProfileConfigService.create() — append one raw
// entry to the SAME pm-profiles.yaml the composition already loaded from.
function appendProfile(profilesPath, entry) {
  const doc = parse(readFileSync(profilesPath, 'utf8'));
  doc.pm_profiles.push(entry);
  writeFileSync(profilesPath, stringify(doc));
}

test('a profile written to disk after startup is invisible until reloadPmProfiles runs (proves the bug this wave fixes)', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'pm2', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' });
  assert.equal(composition.profileRegistry.hasProfile('pm2'), false);
  await assert.rejects(
    composition.ownerService.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'pm2' } }),
    (e) => e.code === 'PM_PROFILE_UNAVAILABLE',
  );
  await composition.close();
});

test('reloadPmProfiles admits a new profile into the SAME live registry/service/adapter and assigns a real, non-hardcoded alias', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'pm2', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' });

  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, ['pm2']);
  assert.deepEqual(result.rejected, []);
  assert.equal(typeof result.aliasesAssigned.pm2, 'string');
  // Deterministic, never hardcoded — the fixture's ONLY registered profile
  // is `pm` (alias "1" once reconciled at startup); `pm2` is the very
  // NEXT id discovered, so it must get "2" — proving allocation is real
  // reconciliation, not a copy-pasted constant.
  assert.equal(result.aliasesAssigned.pm2, '2');

  // Same live registry instance — no object-reference swap needed.
  assert.equal(composition.profileRegistry.hasProfile('pm2'), true);
  assert.equal(composition.profileRegistry.get('pm2').id, 'pm2');

  // OwnerControlService now accepts SUBMIT_TASK for the newly admitted id
  // — it no longer throws PM_PROFILE_UNAVAILABLE (the pre-reload behavior
  // proven by the previous test) and reaches a real terminal task status.
  const outcome = await composition.ownerService.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'pm2' } });
  assert.equal(outcome.status, 'MATERIALIZED');

  // Telegram-facing catalogue and alias registry both refreshed.
  const list = await composition.ownerService.read('GET_PM_PROFILES');
  assert.ok(list.some((p) => p.id === 'pm2'));
  assert.equal(composition.adapter.pmProfiles.some((p) => p.id === 'pm2'), true);
  assert.equal(composition.adapter.aliasRegistry.pmAliasFor('pm2'), '2');
  assert.equal(composition.adapter.aliasRegistry.resolvePmProfile('2'), 'pm2');

  // Persisted to disk — the SAME file loadReconciledTelegramAliases()
  // itself manages; not an in-memory-only illusion.
  const persisted = parse(readFileSync(f.aliasesPath, 'utf8'));
  assert.equal(persisted.pm_profiles['2'], 'pm2');
  await composition.close();
});

test('reload is idempotent — a second call with no new profiles admits nothing and never reassigns an alias', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'pm2', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' });
  const first = await composition.reloadPmProfiles();
  assert.deepEqual(first.admitted, ['pm2']);
  const second = await composition.reloadPmProfiles();
  assert.deepEqual(second.admitted, []);
  assert.equal(composition.adapter.aliasRegistry.pmAliasFor('pm2'), '2');
  await composition.close();
});

test('an invalid new entry is rejected and reported without blocking a valid sibling in the same pass', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  appendProfile(f.profilesPath, { id: 'bad', role_kind: 'PM', session_kind: 'NOT_A_REAL_KIND', product: 'scripted', transport: 'in-process' });
  appendProfile(f.profilesPath, { id: 'pm2', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' });

  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, ['pm2']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, 'bad');
  assert.equal(result.rejected[0].code, 'PM_PROFILE_INVALID');
  assert.equal(composition.profileRegistry.hasProfile('bad'), false);
  assert.equal(composition.profileRegistry.hasProfile('pm2'), true);
  await composition.close();
});

test('an api/openrouter profile is admitted on identity alone — no live model-catalogue call is ever made (Part C/H)', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  // A model string that could never resolve against any real/cached
  // OpenRouter catalogue — proves admission never consults live discovery.
  appendProfile(f.profilesPath, { id: 'pm-api', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'z-ai/glm-5.2:free', reasoning: 'medium' });
  const result = await composition.reloadPmProfiles();
  assert.deepEqual(result.admitted, ['pm-api']);
  assert.deepEqual(result.rejected, []);
  const admittedProfile = composition.profileRegistry.get('pm-api');
  assert.equal(admittedProfile.model, 'z-ai/glm-5.2:free');
  assert.equal(admittedProfile.reasoning, 'medium');
  assert.equal(typeof result.aliasesAssigned['pm-api'], 'string');
  await composition.close();
});

test('reloadPmProfiles never touches an already-known profile\'s identity or alias, even if the file entry changed', async (t) => {
  const f = fixture(t);
  const composition = await buildComposition(f);
  await composition.reloadPmProfiles(); // no-op — `pm` was already known at startup
  const before = composition.profileRegistry.get('pm');
  const beforeAlias = composition.adapter.aliasRegistry.pmAliasFor('pm');
  // Tamper the on-disk entry the way a hand-edit never should — reload
  // must still skip it entirely (hasProfile('pm') is already true).
  const doc = parse(readFileSync(f.profilesPath, 'utf8'));
  doc.pm_profiles[0].model = 'a-different-model';
  writeFileSync(f.profilesPath, stringify(doc));
  await composition.reloadPmProfiles();
  const after = composition.profileRegistry.get('pm');
  assert.equal(after.model, before.model);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(composition.adapter.aliasRegistry.pmAliasFor('pm'), beforeAlias);
  await composition.close();
});
