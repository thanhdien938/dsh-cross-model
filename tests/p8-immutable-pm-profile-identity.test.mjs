import test from 'node:test';
import assert from 'node:assert/strict';

import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { renderShorthandTaskAck } from '../src/owner/telegram-owner-client.mjs';
import { reconcileAliasState } from '../src/owner/telegram-alias-reconciler.mjs';
import { emptyTelegramAliasState } from '../src/owner/telegram-alias-state-store.mjs';

// P8-R0.2 core invariant: PM PROFILE IDENTITY IS IMMUTABLE. product/model/
// reasoning together define one stable execution configuration; a
// historical pm_profile_id must go on meaning that same configuration
// forever. A different model or reasoning is a DIFFERENT profile (a
// "variant"), never an in-place edit of the existing one.

// ==== Part T: historical durability, proven at the fingerprint layer ======

test('a profile\'s fingerprint is stable across future registry reloads that only ADD new profiles/variants', () => {
  const base = [{ id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null, reasoning: null }];
  const before = new PmProfileRegistry(base);
  const historicalFingerprint = before.get('live1-claude-pm').fingerprint;

  // Owner creates a variant elsewhere in pm-profiles.yaml; the runtime reloads.
  const withVariant = [...base, { id: 'live1-claude-sonnet-medium', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' }];
  const after = new PmProfileRegistry(withVariant);

  assert.equal(after.get('live1-claude-pm').fingerprint, historicalFingerprint);
  // A durable pm_run that pinned this fingerprint at submit time still
  // resolves cleanly against the reloaded registry (see
  // src/pm/durable-pm-runtime.mjs's use of assertPinned for resumption).
  assert.doesNotThrow(() => after.assertPinned('live1-claude-pm', historicalFingerprint));
});

test('a hypothetically mutated model/reasoning WOULD have produced a fingerprint mismatch — exactly the drift immutability prevents', () => {
  // This proves *why* PmProfileConfigService#update must refuse an
  // identity change: if it had been allowed (pre-P8-R0.2 behavior), a
  // historical pm_run's pinned fingerprint would silently stop matching
  // the live profile the next time the registry reloaded.
  const before = new PmProfileRegistry([{ id: 'x', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'high' }]);
  const historicalFingerprint = before.get('x').fingerprint;
  const hypotheticallyMutated = new PmProfileRegistry([{ id: 'x', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'opus', reasoning: 'high' }]);
  assert.throws(() => hypotheticallyMutated.assertPinned('x', historicalFingerprint), (e) => e.code === 'PM_PROFILE_MISMATCH');
});

test('two profiles with different reasoning for the same model are genuinely different fingerprints (Part B: reasoning is execution identity)', () => {
  const high = new PmProfileRegistry([{ id: 'a', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'high' }]).get('a');
  const medium = new PmProfileRegistry([{ id: 'b', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' }]).get('b');
  assert.notEqual(high.fingerprint, medium.fingerprint);
});

// ==== Part N: variant creation + alias reconciliation, end to end ========

test('Part N: creating a variant allocates a NEW alias; the original alias and profile are untouched', () => {
  const initial = reconcileAliasState({
    state: emptyTelegramAliasState(),
    registeredProjectIds: ['live1-local'],
    registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm'],
  }).state;
  assert.equal(initial.pm_profiles['1'], 'live1-claude-pm');

  // Owner creates live1-claude-sonnet-medium as a variant -- registry order
  // is unaffected, it is simply appended.
  const afterVariant = reconcileAliasState({
    state: initial,
    registeredProjectIds: ['live1-local'],
    registeredPmProfileIds: ['live1-claude-pm', 'live1-opencode-pm', 'live1-codex-pm', 'live1-grok-pm', 'live1-claude-sonnet-medium'],
  });
  assert.equal(afterVariant.state.pm_profiles['1'], 'live1-claude-pm'); // unchanged
  assert.equal(afterVariant.state.pm_profiles['5'], 'live1-claude-sonnet-medium'); // new
  assert.equal(afterVariant.state.next_pm_profile_alias, 6);
});

test('Part X#11: multiple claude-code variants coexist, each with its own stable alias and distinct execution identity', () => {
  const registry = new PmProfileRegistry([
    { id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null, reasoning: null },
    { id: 'live1-claude-sonnet-medium', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' },
    { id: 'live1-claude-opus-max', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'opus', reasoning: 'max' },
  ]);
  const ids = registry.list().map((p) => p.id);
  assert.deepEqual(ids, ['live1-claude-pm', 'live1-claude-sonnet-medium', 'live1-claude-opus-max']);
  const fingerprints = new Set(ids.map((id) => registry.get(id).fingerprint));
  assert.equal(fingerprints.size, 3); // all distinct despite sharing product=claude-code
});

// ==== Part L/M/18/19: shorthand and council ACKs show the canonical id ===

test('Part L: single-shorthand ack shows the canonical PM profile id, never just model/reasoning', () => {
  const text = renderShorthandTaskAck({
    project: { id: 'dsh-p6-test-b' },
    projectAlias: '2',
    pmProfile: { id: 'live1-codex-pm', product: 'codex', model: null, reasoning: 'medium' },
    pmAlias: '3',
    taskBody: 'report repository name and current branch',
  });
  assert.match(text, /PM:\n3 — live1-codex-pm/);
  assert.match(text, /Model:\ndefault\/inherited/);
  assert.match(text, /Reasoning:\nmedium/);
});

test('Part M: council ack shows the canonical PM profile id for chair AND every participant', () => {
  const text = renderShorthandTaskAck({
    project: { id: 'dsh-p6-test-b' },
    projectAlias: '2',
    pmProfile: { id: 'live1-claude-pm', product: 'claude-code', model: null, reasoning: null },
    pmAlias: '1',
    taskBody: 'Compare two safe README improvement approaches',
    council: { participantAliases: ['3', '4'], participantProfileIds: ['live1-codex-pm', 'live1-grok-pm'] },
  });
  assert.match(text, /PM:\n1 — live1-claude-pm/);
  assert.match(text, /Council:\n3 — live1-codex-pm\n4 — live1-grok-pm/);
});
