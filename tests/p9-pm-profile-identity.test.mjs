import test from 'node:test';
import assert from 'node:assert/strict';

import { executionIdentityKey, sameExecutionIdentity, findExecutionIdentityDuplicate } from '../src/pm/pm-profile-identity.mjs';

// P9-R0.4.1 Part A/T: the ONE pure helper for semantic execution-identity
// comparison. Owner-live proof this exists to catch: live1-antigravity-
// gemini-high and live1-antigravity-gemini-3-7-flash-high are two
// different canonical ids for the exact same
// PM/STATELESS/antigravity/stdio/gemini-3.7-flash-high/high identity.

const base = { role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'gemini-3.7-flash-high', reasoning: 'high' };

test('Part T1: same execution-identity fields under a different canonical id are equal', () => {
  const a = { id: 'live1-antigravity-gemini-high', ...base };
  const b = { id: 'live1-antigravity-gemini-3-7-flash-high', ...base };
  assert.equal(executionIdentityKey(a), executionIdentityKey(b));
  assert.equal(sameExecutionIdentity(a, b), true);
});

test('Part T2: a different model is a different identity', () => {
  assert.notEqual(executionIdentityKey(base), executionIdentityKey({ ...base, model: 'gemini-3.5-flash-medium' }));
});

test('Part T3: a different reasoning is a different identity', () => {
  assert.notEqual(executionIdentityKey(base), executionIdentityKey({ ...base, reasoning: 'medium' }));
});

test('Part T4: a different product is a different identity', () => {
  assert.notEqual(executionIdentityKey(base), executionIdentityKey({ ...base, product: 'claude-code' }));
});

test('Part T5: a different session_kind is a different identity', () => {
  assert.notEqual(executionIdentityKey(base), executionIdentityKey({ ...base, session_kind: 'NATIVE_SESSION' }));
});

test('Part T6: lifecycle status does not affect equality (Part S)', () => {
  const active = { ...base, id: 'a', status: 'ACTIVE' };
  const inactive = { ...base, id: 'b', status: 'INACTIVE' };
  assert.equal(sameExecutionIdentity(active, inactive), true);
});

test('Part T7: canonical id does not affect equality', () => {
  assert.equal(executionIdentityKey({ ...base, id: 'x' }), executionIdentityKey({ ...base, id: 'y' }));
});

test('a different transport is a different identity', () => {
  assert.notEqual(executionIdentityKey(base), executionIdentityKey({ ...base, transport: 'http' }));
});

test('fingerprint/alias/display-label fields are ignored entirely — passing them changes nothing', () => {
  const withExtras = { ...base, id: 'x', fingerprint: 'abc123', status: 'ACTIVE' };
  assert.equal(executionIdentityKey(withExtras), executionIdentityKey(base));
});

test('Part R: a null model is NOT a duplicate of any pinned model, including the CLI current default', () => {
  const unpinned = { role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: null, reasoning: 'medium' };
  const pinned = { ...unpinned, model: 'gpt-5.6-sol' };
  assert.notEqual(executionIdentityKey(unpinned), executionIdentityKey(pinned));
});

test('Part R: a null reasoning is NOT a duplicate of an explicit reasoning value', () => {
  assert.notEqual(executionIdentityKey({ ...base, reasoning: null }), executionIdentityKey({ ...base, reasoning: 'high' }));
});

test('findExecutionIdentityDuplicate returns the matching profile, or undefined when none matches', () => {
  const registry = [
    { id: 'live1-antigravity-gemini-high', ...base, status: 'ACTIVE' },
    { id: 'live1-antigravity-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'gemini-3.5-flash-medium', reasoning: 'medium', status: 'ACTIVE' },
  ];
  const match = findExecutionIdentityDuplicate({ ...base, id: 'candidate' }, registry);
  assert.equal(match?.id, 'live1-antigravity-gemini-high');
  const noMatch = findExecutionIdentityDuplicate({ ...base, model: 'gemini-3.7-flash-medium', id: 'candidate' }, registry);
  assert.equal(noMatch, undefined);
});

test('empty/missing profile list never throws', () => {
  assert.doesNotThrow(() => findExecutionIdentityDuplicate(base, undefined));
  assert.equal(findExecutionIdentityDuplicate(base, []), undefined);
});
