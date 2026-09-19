import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadP5ProductionConfig, publicP5Config } from '../src/runtime/p5-production-config.mjs';

function fixture(t, { projectOrder = ['a', 'b', 'c'], profileOrder = ['pm-claude', 'pm-opencode', 'pm-codex', 'pm-grok'], telegramAliasesFile = undefined, root: sharedRoot = null } = {}) {
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), 'p8-alias-config-'));
  if (!sharedRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  if (!existsSync(join(root, 'repo'))) mkdirSync(join(root, 'repo'));
  const projectEntry = (id) => `  - id: ${id}\n    repo_path: ./repo\n    default_pm_profile_id: pm-claude\n    autonomy: {revision: 1, effects: {}}\n`;
  writeFileSync(join(root, 'projects.yaml'), `projects:\n${projectOrder.map(projectEntry).join('')}`);
  const profileEntries = {
    'pm-claude': '  - id: pm-claude\n    role_kind: PM\n    session_kind: STATELESS\n    product: claude-code\n    transport: stdio\n    model: sonnet\n    reasoning: high\n',
    'pm-opencode': '  - id: pm-opencode\n    role_kind: PM\n    session_kind: STATELESS\n    product: opencode\n    transport: stdio\n',
    'pm-codex': '  - id: pm-codex\n    role_kind: PM\n    session_kind: STATELESS\n    product: codex\n    transport: stdio\n',
    'pm-grok': '  - id: pm-grok\n    role_kind: PM\n    session_kind: STATELESS\n    product: grok\n    transport: stdio\n',
  };
  writeFileSync(join(root, 'profiles.yaml'), 'pm_profiles:\n' + profileOrder.map((id) => profileEntries[id]).join(''));
  const configLines = [
    'mode: production',
    'postgres:\n  dsn_env: DSH_TEST_PG',
    'sqlite:\n  path: ./state.db',
    'projects_file: ./projects.yaml',
    'pm_profiles_file: ./profiles.yaml',
    ...(telegramAliasesFile !== undefined ? [`telegram_aliases_file: ${telegramAliasesFile}`] : []),
    'telegram:\n  token_env: DSH_TEST_TG\n  user_id: "1"\n  chat_id: "2"\n  poll_interval_ms: 1000',
    'coordinator:\n  logical_id: c\n  lease_ms: 30000\n  poll_interval_ms: 250',
    'worker:\n  logical_id: w\n  lease_ms: 30000\n  poll_interval_ms: 250',
  ];
  const configPath = join(root, 'config.yaml');
  writeFileSync(configPath, configLines.join('\n') + '\n');
  return { root, path: configPath, env: { DSH_TEST_PG: 'postgresql://example.invalid/dsh', DSH_TEST_TG: 'opaque-test-token' } };
}

// ==== Part "FIRST BOOT": no telegram_aliases_file -> default path, auto-created, auto-allocated ====

test('omitting telegram_aliases_file defaults to telegram-aliases.yaml next to the config, auto-created and reconciled', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.telegramAliasesStatus.available, true);
  assert.equal(config.telegramAliases.resolveProject('1'), 'a');
  assert.equal(config.telegramAliases.resolvePmProfile('1'), 'pm-claude');
  assert.equal(existsSync(join(f.root, 'telegram-aliases.yaml')), true);
});

test('an explicit telegram_aliases_file pointing at a not-yet-existing path is auto-created too', async (t) => {
  const f = fixture(t, { telegramAliasesFile: './nested/telegram-aliases.yaml' });
  mkdirSync(join(f.root, 'nested'));
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.telegramAliasesStatus.available, true);
  assert.equal(existsSync(join(f.root, 'nested', 'telegram-aliases.yaml')), true);
});

test('the auto-allocated baseline matches the real current registry with no fictional profiles', async (t) => {
  const f = fixture(t, { projectOrder: ['live1-local', 'dsh-p6-test-b', 'dsh-p8-test-c'], profileOrder: ['pm-claude', 'pm-opencode', 'pm-codex', 'pm-grok'] });
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.deepEqual(config.telegramAliases.listProjectAliases(), [
    { alias: '1', project_id: 'live1-local' },
    { alias: '2', project_id: 'dsh-p6-test-b' },
    { alias: '3', project_id: 'dsh-p8-test-c' },
  ]);
  assert.deepEqual(config.telegramAliases.listPmAliases().map((v) => v.pm_profile_id), ['pm-claude', 'pm-opencode', 'pm-codex', 'pm-grok']);
});

// ==== publicP5Config never leaks secrets, alias status is safe to expose ===

test('publicP5Config exposes alias mapping and status but never a secret', async (t) => {
  const f = fixture(t);
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  const pub = JSON.stringify(publicP5Config(config));
  assert.equal(pub.includes(f.env.DSH_TEST_TG), false);
  assert.match(pub, /"pm_profile_id":"pm-claude"/);
  assert.match(pub, /"available":true/);
});

// ==== Part "FAILURE POLICY": malformed alias state degrades gracefully ====

test('a malformed alias state file does not fail config load -- it degrades to available:false', async (t) => {
  const f = fixture(t, { telegramAliasesFile: './telegram-aliases.yaml' });
  writeFileSync(join(f.root, 'telegram-aliases.yaml'), 'not: [valid\n');
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.telegramAliasesStatus.available, false);
  assert.equal(config.telegramAliases.available, false);
  assert.equal(config.telegramAliases.hasAliases(), false);
  // Canonical config (projects/profiles/telegram) is entirely unaffected.
  assert.equal(config.projects.length, 3);
  assert.equal(config.profiles.length, 4);
});

// ==== Part U #7/#8: reordering never changes an already-assigned alias =====

test('reordering projects.yaml/profiles.yaml does not change what an alias resolves to (same shared alias-state file)', async (t) => {
  const sharedRoot = mkdtempSync(join(tmpdir(), 'p8-alias-shared-'));
  t.after(() => rmSync(sharedRoot, { recursive: true, force: true }));
  const first = fixture(t, { root: sharedRoot, projectOrder: ['a', 'b', 'c'] });
  const original = await loadP5ProductionConfig(first.path, { env: first.env });
  const second = fixture(t, { root: sharedRoot, projectOrder: ['c', 'b', 'a'] });
  const reordered = await loadP5ProductionConfig(second.path, { env: second.env });
  for (const alias of ['1', '2', '3']) assert.equal(original.telegramAliases.resolveProject(alias), reordered.telegramAliases.resolveProject(alias));
  assert.equal(reordered.telegramAliases.resolveProject('3'), 'c');
});

test('reordering PM profiles does not change what a PM alias resolves to (same shared alias-state file)', async (t) => {
  const sharedRoot = mkdtempSync(join(tmpdir(), 'p8-alias-shared-'));
  t.after(() => rmSync(sharedRoot, { recursive: true, force: true }));
  const first = fixture(t, { root: sharedRoot, profileOrder: ['pm-claude', 'pm-opencode', 'pm-codex', 'pm-grok'] });
  const original = await loadP5ProductionConfig(first.path, { env: first.env });
  const second = fixture(t, { root: sharedRoot, profileOrder: ['pm-grok', 'pm-codex', 'pm-opencode', 'pm-claude'] });
  const reordered = await loadP5ProductionConfig(second.path, { env: second.env });
  for (const alias of ['1', '2', '3', '4']) assert.equal(original.telegramAliases.resolvePmProfile(alias), reordered.telegramAliases.resolvePmProfile(alias));
});

// ==== A newly-created PM profile is picked up on the next config reload ===

test('a PM profile created after the first reconcile gets a fresh alias on the next load; existing aliases are untouched', async (t) => {
  const sharedRoot = mkdtempSync(join(tmpdir(), 'p8-alias-shared-'));
  t.after(() => rmSync(sharedRoot, { recursive: true, force: true }));
  const first = fixture(t, { root: sharedRoot, profileOrder: ['pm-claude', 'pm-opencode', 'pm-codex', 'pm-grok'] });
  const before = await loadP5ProductionConfig(first.path, { env: first.env });
  assert.equal(before.telegramAliases.resolvePmProfile('1'), 'pm-claude');

  // Simulate Desktop "Create PM Profile": append a new profile to profiles.yaml.
  writeFileSync(join(sharedRoot, 'profiles.yaml'), 'pm_profiles:\n' +
    '  - id: pm-claude\n    role_kind: PM\n    session_kind: STATELESS\n    product: claude-code\n    transport: stdio\n    model: sonnet\n    reasoning: high\n' +
    '  - id: pm-opencode\n    role_kind: PM\n    session_kind: STATELESS\n    product: opencode\n    transport: stdio\n' +
    '  - id: pm-codex\n    role_kind: PM\n    session_kind: STATELESS\n    product: codex\n    transport: stdio\n' +
    '  - id: pm-grok\n    role_kind: PM\n    session_kind: STATELESS\n    product: grok\n    transport: stdio\n' +
    '  - id: pm-claude-opus-high\n    role_kind: PM\n    session_kind: STATELESS\n    product: claude-code\n    transport: stdio\n    model: opus\n    reasoning: high\n');
  const after = await loadP5ProductionConfig(first.path, { env: first.env });
  assert.equal(after.telegramAliases.resolvePmProfile('5'), 'pm-claude-opus-high');
  assert.equal(after.telegramAliases.resolvePmProfile('1'), 'pm-claude'); // untouched
});

// ==== Editing model/reasoning never changes the alias ======================

test('editing model/reasoning on an existing PM profile leaves its alias unchanged', async (t) => {
  const sharedRoot = mkdtempSync(join(tmpdir(), 'p8-alias-shared-'));
  t.after(() => rmSync(sharedRoot, { recursive: true, force: true }));
  const first = fixture(t, { root: sharedRoot });
  await loadP5ProductionConfig(first.path, { env: first.env });
  // Edit pm-claude: sonnet/high -> opus/max (id unchanged).
  writeFileSync(join(sharedRoot, 'profiles.yaml'), 'pm_profiles:\n' +
    '  - id: pm-claude\n    role_kind: PM\n    session_kind: STATELESS\n    product: claude-code\n    transport: stdio\n    model: opus\n    reasoning: max\n' +
    '  - id: pm-opencode\n    role_kind: PM\n    session_kind: STATELESS\n    product: opencode\n    transport: stdio\n' +
    '  - id: pm-codex\n    role_kind: PM\n    session_kind: STATELESS\n    product: codex\n    transport: stdio\n' +
    '  - id: pm-grok\n    role_kind: PM\n    session_kind: STATELESS\n    product: grok\n    transport: stdio\n');
  const after = await loadP5ProductionConfig(first.path, { env: first.env });
  assert.equal(after.telegramAliases.resolvePmProfile('1'), 'pm-claude');
  assert.equal(after.profiles.find((p) => p.id === 'pm-claude').model, 'opus');
  assert.equal(after.profiles.find((p) => p.id === 'pm-claude').reasoning, 'max');
});
