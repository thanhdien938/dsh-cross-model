// P13-R8: `concurrency:` is a new, purely optional benchmark config seam on
// production.yaml (src/runtime/p5-production-config.mjs's
// parseConcurrency()) letting the R8 benchmark configure R1's global limit,
// R4's per-backend limits, and R5's resource-pressure governor from a real
// config file instead of only from test-only JS deps. Omitting the section
// entirely must be byte-for-byte identical to pre-R8 behaviour -- every
// live deployment (including the owner's `live1`) that has not opted in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';

function writeConfig(root, extraYaml = '') {
  mkdirSync(join(root, 'repo-a'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: proj-a\n    repo_path: ./repo-a\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(
    join(root, 'config.yaml'),
    `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm:\n  scripted_decisions: []\n${extraYaml}`,
  );
  return { path: join(root, 'config.yaml'), env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } };
}

test('concurrency section absent yields the exact pre-R8 fallback shape (undefined/null/null)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.deepEqual(config.concurrency, { globalLimit: undefined, backendLimits: null, resourceGovernor: null });
});

test('concurrency.global_limit is parsed as a bounded integer', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-global-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  global_limit: 4\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.concurrency.globalLimit, 4);
  assert.equal(config.concurrency.backendLimits, null);
  assert.equal(config.concurrency.resourceGovernor, null);
});

test('concurrency.backend_limits is parsed as a {key: integer} map, keys allow the api:${provider} form', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-backend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  backend_limits:\n    claude-code: 2\n    "api:openrouter": 3\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.deepEqual(config.concurrency.backendLimits, { 'claude-code': 2, 'api:openrouter': 3 });
});

test('concurrency.resource_governor is parsed with 0.9/0.8 defaults when watermarks are omitted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-gov-defaults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  resource_governor:\n    enabled: true\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.deepEqual(config.concurrency.resourceGovernor, { enabled: true, highWatermark: 0.9, recoveryWatermark: 0.8 });
});

test('concurrency.resource_governor accepts explicit watermarks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-gov-explicit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  resource_governor:\n    enabled: true\n    high_watermark: 0.85\n    recovery_watermark: 0.7\n`);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.deepEqual(config.concurrency.resourceGovernor, { enabled: true, highWatermark: 0.85, recoveryWatermark: 0.7 });
});

test('concurrency.resource_governor rejects recovery_watermark >= high_watermark', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-gov-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  resource_governor:\n    enabled: true\n    high_watermark: 0.8\n    recovery_watermark: 0.8\n`);
  await assert.rejects(() => loadP5ProductionConfig(f.path, { env: f.env }), TypeError);
});

test('concurrency.global_limit rejects out-of-range values', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-global-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  global_limit: 0\n`);
  await assert.rejects(() => loadP5ProductionConfig(f.path, { env: f.env }), TypeError);
});

test('concurrency.backend_limits rejects a non-object value', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r8-conc-backend-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = writeConfig(root, `concurrency:\n  backend_limits: 3\n`);
  await assert.rejects(() => loadP5ProductionConfig(f.path, { env: f.env }), TypeError);
});
