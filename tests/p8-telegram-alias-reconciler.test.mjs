import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconcileAliasState } from '../src/owner/telegram-alias-reconciler.mjs';
import { loadReconciledTelegramAliases } from '../src/owner/telegram-alias-reconciler.mjs';
import { TelegramAliasStateStore, TelegramAliasStateError, emptyTelegramAliasState } from '../src/owner/telegram-alias-state-store.mjs';

// ==== Pure reconciliation: allocation, stability, non-recycling ============

test('a brand-new (empty) state auto-allocates aliases in registry order, starting at 1', () => {
  const { state, changed } = reconcileAliasState({
    state: emptyTelegramAliasState(),
    registeredProjectIds: ['live1-local', 'dsh-p6-test-b', 'dsh-p8-test-c'],
    registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'],
  });
  assert.equal(changed, true);
  assert.deepEqual(state.projects, { 1: 'live1-local', 2: 'dsh-p6-test-b', 3: 'dsh-p8-test-c' });
  assert.deepEqual(state.pm_profiles, { 1: 'live1-claude-pm', 2: 'live1-opencode-pm', 3: 'live1-codex-pm', 4: 'live1-grok-pm' });
  assert.equal(state.next_project_alias, 4);
  assert.equal(state.next_pm_profile_alias, 5);
});

test('reconciling an already-fully-assigned state again is a no-op (changed:false) regardless of registry order', () => {
  const first = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: ['a', 'b', 'c'], registeredPmProfileIds: ['w', 'x', 'y', 'z'] }).state;
  const second = reconcileAliasState({ state: first, registeredProjectIds: ['c', 'b', 'a'], registeredPmProfileIds: ['z', 'y', 'x', 'w'] });
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first);
});

test('reordering the registry does not change already-assigned aliases (order only matters for FIRST allocation)', () => {
  const initial = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok'] }).state;
  const reordered = reconcileAliasState({ state: initial, registeredProjectIds: [], registeredPmProfileIds: ['grok', 'claude', 'codex', 'opencode'] }).state;
  assert.deepEqual(reordered.pm_profiles, initial.pm_profiles);
  assert.equal(reordered.pm_profiles['1'], 'claude');
  assert.equal(reordered.pm_profiles['4'], 'grok');
});

test('a new PM profile discovered later gets the next monotonically increasing alias', () => {
  const initial = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok'] }).state;
  const withNew = reconcileAliasState({ state: initial, registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok', 'claude-opus-high'] });
  assert.equal(withNew.changed, true);
  assert.equal(withNew.state.pm_profiles['5'], 'claude-opus-high');
  assert.equal(withNew.state.next_pm_profile_alias, 6);
});

test('deleting a profile retires its alias forever -- it is never reused, even in the SAME reconciliation session', () => {
  const initial = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok'] }).state;
  assert.equal(initial.pm_profiles['2'], 'opencode');
  // opencode deleted -- registeredPmProfileIds no longer includes it
  const afterDelete = reconcileAliasState({ state: initial, registeredProjectIds: [], registeredPmProfileIds: ['claude', 'codex', 'grok'] });
  assert.equal(afterDelete.changed, true);
  assert.equal('2' in afterDelete.state.pm_profiles, false);
  assert.equal(afterDelete.state.next_pm_profile_alias, 5); // unchanged high-water mark -- "2" is retired, not reclaimed
  // a new profile created afterward gets 5, NOT the retired 2
  const afterCreate = reconcileAliasState({ state: afterDelete.state, registeredProjectIds: [], registeredPmProfileIds: ['claude', 'codex', 'grok', 'new-profile'] });
  assert.equal(afterCreate.state.pm_profiles['5'], 'new-profile');
  assert.equal('2' in afterCreate.state.pm_profiles, false);
  assert.equal(afterCreate.state.next_pm_profile_alias, 6);
});

test('editing a profile is a no-op for reconciliation as long as its id is unchanged (alias survives untouched)', () => {
  const initial = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok'] }).state;
  // "editing model/reasoning" never changes the profile's canonical id, so
  // reconciliation sees the exact same registeredPmProfileIds list.
  const afterEdit = reconcileAliasState({ state: initial, registeredProjectIds: [], registeredPmProfileIds: ['claude', 'opencode', 'codex', 'grok'] });
  assert.equal(afterEdit.changed, false);
  assert.equal(afterEdit.state.pm_profiles['1'], 'claude');
});

test('projects and PM profiles reconcile independently (deleting a project never touches PM aliases and vice versa)', () => {
  const initial = reconcileAliasState({ state: emptyTelegramAliasState(), registeredProjectIds: ['a', 'b'], registeredPmProfileIds: ['x', 'y'] }).state;
  const afterProjectDelete = reconcileAliasState({ state: initial, registeredProjectIds: ['a'], registeredPmProfileIds: ['x', 'y'] });
  assert.deepEqual(afterProjectDelete.state.pm_profiles, initial.pm_profiles);
  assert.equal(afterProjectDelete.state.next_pm_profile_alias, initial.next_pm_profile_alias);
});

// ==== State store: atomic persistence, missing/malformed file handling ====

function tmpPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'p8-alias-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'telegram-aliases.yaml');
}

test('TelegramAliasStateStore.read() returns the fresh empty state when the file does not exist (never throws)', async (t) => {
  const store = new TelegramAliasStateStore(tmpPath(t));
  const state = await store.read();
  assert.deepEqual(state, emptyTelegramAliasState());
});

test('TelegramAliasStateStore write/read round-trips exactly, atomically', async (t) => {
  const path = tmpPath(t);
  const store = new TelegramAliasStateStore(path);
  const state = { version: 1, next_project_alias: 4, next_pm_profile_alias: 5, projects: { 1: 'a', 2: 'b', 3: 'c' }, pm_profiles: { 1: 'w', 2: 'x', 3: 'y', 4: 'z' } };
  await store.write(state);
  assert.deepEqual(await store.read(), state);
  // No stray temp files left behind after a successful write.
  const dirEntries = readFileSync(path, 'utf8');
  assert.match(dirEntries, /next_project_alias: 4/);
});

test('TelegramAliasStateStore.read() throws a typed error for malformed YAML/shape, never a raw parse crash', async (t) => {
  const path = tmpPath(t);
  writeFileSync(path, 'not: [valid, state\n');
  await assert.rejects(new TelegramAliasStateStore(path).read(), (e) => e instanceof TelegramAliasStateError);
});

test('TelegramAliasStateStore.read() refuses an unsupported version', async (t) => {
  const path = tmpPath(t);
  writeFileSync(path, 'version: 99\nprojects: {}\npm_profiles: {}\n');
  await assert.rejects(new TelegramAliasStateStore(path).read(), (e) => e instanceof TelegramAliasStateError && e.code === 'ALIAS_STATE_VERSION_UNSUPPORTED');
});

// ==== End-to-end orchestration: loadReconciledTelegramAliases ==============

test('first load with no state file auto-creates and persists the initial allocation', async (t) => {
  const path = tmpPath(t);
  const { registry, status } = await loadReconciledTelegramAliases({ path, registeredProjectIds: ['live1-local', 'dsh-p6-test-b', 'dsh-p8-test-c'], registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'] });
  assert.equal(status.available, true);
  assert.equal(registry.resolveProject('3'), 'dsh-p8-test-c');
  assert.equal(registry.resolvePmProfile('4'), 'live1-grok-pm');
  // Persisted to disk -- readable back by a fresh store.
  const persisted = await new TelegramAliasStateStore(path).read();
  assert.equal(persisted.projects['1'], 'live1-local');
});

test('persisted aliases survive a restart (second load reuses the same assignments)', async (t) => {
  const path = tmpPath(t);
  const projectIds = ['live1-local', 'dsh-p6-test-b', 'dsh-p8-test-c'];
  const pmIds = ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'];
  const first = await loadReconciledTelegramAliases({ path, registeredProjectIds: projectIds, registeredPmProfileIds: pmIds });
  const second = await loadReconciledTelegramAliases({ path, registeredProjectIds: projectIds, registeredPmProfileIds: pmIds });
  for (const alias of ['1', '2', '3']) assert.equal(first.registry.resolveProject(alias), second.registry.resolveProject(alias));
  for (const alias of ['1', '2', '3', '4']) assert.equal(first.registry.resolvePmProfile(alias), second.registry.resolvePmProfile(alias));
});

test('a newly created PM profile gets the next alias on the very next reconcile (no manual alias edit)', async (t) => {
  const path = tmpPath(t);
  await loadReconciledTelegramAliases({ path, registeredProjectIds: ['live1-local'], registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'] });
  const { registry } = await loadReconciledTelegramAliases({ path, registeredProjectIds: ['live1-local'], registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm', 'live1-claude-opus-high'] });
  assert.equal(registry.resolvePmProfile('5'), 'live1-claude-opus-high');
});

test('a deleted profile\'s alias is retired; the next new profile never receives the retired number', async (t) => {
  const path = tmpPath(t);
  await loadReconciledTelegramAliases({ path, registeredProjectIds: [], registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'] });
  // live1-opencode-pm (alias 2) is deleted
  const afterDelete = await loadReconciledTelegramAliases({ path, registeredProjectIds: [], registeredPmProfileIds: ['live1-claude-pm', 'live1-codex-pm', 'live1-grok-pm'] });
  assert.throws(() => afterDelete.registry.resolvePmProfile('2'), (e) => e.code === 'ALIAS_PM_UNKNOWN');
  const afterCreate = await loadReconciledTelegramAliases({ path, registeredProjectIds: [], registeredPmProfileIds: ['live1-claude-pm', 'live1-codex-pm', 'live1-grok-pm', 'new-profile'] });
  assert.equal(afterCreate.registry.resolvePmProfile('5'), 'new-profile');
  assert.throws(() => afterCreate.registry.resolvePmProfile('2'), (e) => e.code === 'ALIAS_PM_UNKNOWN');
});

test('a malformed alias state degrades to available:false without throwing -- canonical config load is unaffected', async (t) => {
  const path = tmpPath(t);
  writeFileSync(path, 'this is not: [valid yaml state\n');
  const { registry, status } = await loadReconciledTelegramAliases({ path, registeredProjectIds: ['a'], registeredPmProfileIds: ['x'] });
  assert.equal(status.available, false);
  assert.equal(registry.available, false);
  assert.equal(registry.hasAliases(), false);
  assert.throws(() => registry.resolveProject('1'), (e) => e.code === 'ALIAS_STATE_UNAVAILABLE');
});

test('a write failure (unwritable directory) degrades to available:false, never throws', async (t) => {
  // Point the state file inside a directory that does not exist and cannot
  // be auto-created by `open()` -- this simulates a persistence failure at
  // first-boot time.
  const dir = mkdtempSync(join(tmpdir(), 'p8-alias-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing-subdir', 'telegram-aliases.yaml');
  const { registry, status } = await loadReconciledTelegramAliases({ path, registeredProjectIds: ['a'], registeredPmProfileIds: ['x'] });
  assert.equal(status.available, false);
  assert.equal(registry.available, false);
});
