import test from 'node:test';
import assert from 'node:assert/strict';
import { PmProfileRegistry, profileFingerprint } from '../src/pm/pm-profile-registry.mjs';
import { executionIdentityKey, sameExecutionIdentity } from '../src/pm/pm-profile-identity.mjs';

const CLAUDE_RAW = { id: 'local-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null, reasoning: null };
const API_RAW = { id: 'api-openrouter-canary', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', transport: 'http', provider: 'openrouter', model: 'openai/gpt-x', reasoning: null };

test('an api PM profile requires a provider id', () => {
  const { provider, ...missing } = API_RAW;
  assert.throws(() => new PmProfileRegistry([missing]), TypeError);
});

test('provider is only meaningful for the api product — rejected on every other product', () => {
  assert.throws(() => new PmProfileRegistry([{ ...CLAUDE_RAW, provider: 'openrouter' }]), TypeError);
});

test('an api PM profile transport must be http', () => {
  assert.throws(() => new PmProfileRegistry([{ ...API_RAW, transport: 'stdio' }]), TypeError);
});

test('an api PM profile session_kind must be STATELESS in P11-R0', () => {
  assert.throws(() => new PmProfileRegistry([{ ...API_RAW, session_kind: 'NATIVE_SESSION' }]), TypeError);
});

test('a well-formed api PM profile registers and round-trips its provider identity', () => {
  const registry = new PmProfileRegistry([API_RAW]);
  const profile = registry.get('api-openrouter-canary');
  assert.equal(profile.provider, 'openrouter');
  assert.equal(profile.product, 'api');
  assert.equal(profile.transport, 'http');
});

// P8 invariant regression: this change must NEVER alter the fingerprint of
// any PRE-EXISTING (non-api) profile — every already-pinned pm_run's
// fingerprint depends on this being byte-for-byte stable.
test('P8 REGRESSION GUARD: a non-api profile fingerprint is unchanged by the provider extension — no provider key leaks into it', () => {
  const registry = new PmProfileRegistry([CLAUDE_RAW]);
  const profile = registry.get('local-pm');
  const legacyShapeFingerprint = profileFingerprint({ id: CLAUDE_RAW.id, role_kind: CLAUDE_RAW.role_kind, session_kind: CLAUDE_RAW.session_kind, product: CLAUDE_RAW.product, transport: CLAUDE_RAW.transport, model: CLAUDE_RAW.model, reasoning: CLAUDE_RAW.reasoning });
  assert.equal(profile.fingerprint, legacyShapeFingerprint);
  assert.equal('provider' in profile, false);
});

test('an api profile fingerprint DOES vary with provider — two providers, same model/reasoning, are different execution identities', () => {
  const registry = new PmProfileRegistry([API_RAW, { ...API_RAW, id: 'api-deepseek-canary', provider: 'deepseek' }]);
  assert.notEqual(registry.get('api-openrouter-canary').fingerprint, registry.get('api-deepseek-canary').fingerprint);
});

test('executionIdentityKey: two api profiles with identical model/reasoning but different providers are NOT duplicates', () => {
  const a = { role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'shared-model', reasoning: null };
  const b = { ...a, provider: 'deepseek' };
  assert.equal(sameExecutionIdentity(a, b), false);
});

test('executionIdentityKey: identical api profiles (including provider) ARE duplicates regardless of id', () => {
  const a = { role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'shared-model', reasoning: null };
  const b = { ...a };
  assert.equal(sameExecutionIdentity(a, b), true);
  assert.equal(executionIdentityKey({ ...a, id: 'x' }), executionIdentityKey({ ...a, id: 'y' }));
});

test('duplicate profile ids are still rejected for api profiles', () => {
  assert.throws(() => new PmProfileRegistry([API_RAW, API_RAW]), TypeError);
});
