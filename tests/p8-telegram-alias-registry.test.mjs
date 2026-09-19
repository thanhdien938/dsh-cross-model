import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramAliasRegistry, TelegramAliasError } from '../src/owner/telegram-alias-registry.mjs';

// P8-R0.1: TelegramAliasRegistry is now a pure LOOKUP over an
// already-reconciled mapping (see telegram-alias-reconciler.mjs for the
// allocation/stability/non-recycling logic). It no longer validates targets
// itself -- every mapping handed to it here is assumed already reconciled.

function registry(overrides = {}) {
  return new TelegramAliasRegistry({
    projects: { 1: 'live1-local', 2: 'dsh-p6-test-b', 3: 'dsh-p8-test-c' },
    pmProfiles: { 1: 'live1-claude-pm', 2: 'live1-opencode-pm', 3: 'live1-codex-pm', 4: 'live1-grok-pm' },
    ...overrides,
  });
}

test('project aliases resolve to their explicit canonical id', () => {
  const r = registry();
  assert.equal(r.resolveProject('3'), 'dsh-p8-test-c');
  assert.equal(r.resolveProject(3), 'dsh-p8-test-c');
});

test('PM aliases resolve to their explicit canonical id', () => {
  const r = registry();
  assert.equal(r.resolvePmProfile('1'), 'live1-claude-pm');
  assert.equal(r.resolvePmProfile('3'), 'live1-codex-pm');
});

test('reverse lookup (for display) returns the alias for a canonical id', () => {
  const r = registry();
  assert.equal(r.projectAliasFor('dsh-p8-test-c'), '3');
  assert.equal(r.pmAliasFor('live1-grok-pm'), '4');
  assert.equal(r.projectAliasFor('unregistered'), null);
});

test('unknown project alias refuses with a typed error (Part M)', () => {
  assert.throws(() => registry().resolveProject('9'), (e) => e instanceof TelegramAliasError && e.code === 'ALIAS_PROJECT_UNKNOWN');
});

test('unknown PM alias refuses with a typed error (Part M)', () => {
  assert.throws(() => registry().resolvePmProfile('9'), (e) => e instanceof TelegramAliasError && e.code === 'ALIAS_PM_UNKNOWN');
});

// ---- duplicate target allowed (documented, reverse lookup prefers first) --

test('two aliases may intentionally point at the same project/profile (duplicate target allowed)', () => {
  const r = registry({ projects: { 1: 'live1-local', 9: 'live1-local' } });
  assert.equal(r.resolveProject('1'), 'live1-local');
  assert.equal(r.resolveProject('9'), 'live1-local');
  assert.equal(r.projectAliasFor('live1-local'), '1');
});

// ---- listing (used by /aliases, /projects, /pms) ---------------------------

test('listProjectAliases/listPmAliases expose the full stable map for display', () => {
  const r = registry();
  assert.deepEqual(r.listProjectAliases(), [
    { alias: '1', project_id: 'live1-local' },
    { alias: '2', project_id: 'dsh-p6-test-b' },
    { alias: '3', project_id: 'dsh-p8-test-c' },
  ]);
  assert.equal(r.listPmAliases().length, 4);
});

test('an empty alias registry has no aliases and never resolves anything', () => {
  const r = new TelegramAliasRegistry();
  assert.equal(r.hasAliases(), false);
  assert.throws(() => r.resolveProject('1'), (e) => e.code === 'ALIAS_PROJECT_UNKNOWN');
});

// ---- Part "FAILURE POLICY": unavailable mode ------------------------------

test('TelegramAliasRegistry.unavailable() fails every lookup closed with a distinct code, never guesses', () => {
  const r = TelegramAliasRegistry.unavailable();
  assert.equal(r.available, false);
  assert.equal(r.hasAliases(), false);
  assert.deepEqual(r.listProjectAliases(), []);
  assert.deepEqual(r.listPmAliases(), []);
  assert.equal(r.projectAliasFor('live1-local'), null);
  assert.throws(() => r.resolveProject('1'), (e) => e instanceof TelegramAliasError && e.code === 'ALIAS_STATE_UNAVAILABLE');
  assert.throws(() => r.resolvePmProfile('1'), (e) => e instanceof TelegramAliasError && e.code === 'ALIAS_STATE_UNAVAILABLE');
});
