import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProviderEntry, validateApiProvidersDoc, loadApiProviderConfig, getProviderConfig, resolveApiKey, ApiProviderConfigError } from '../src/pm/api-backend/api-provider-config.mjs';
import { ApiBackendError } from '../src/pm/api-backend/api-backend-errors.mjs';

const VALID = { protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'DSH_API_OPENROUTER_KEY' };

test('a strictly valid provider entry validates and normalizes a trailing slash off base_url', () => {
  const entry = validateProviderEntry('openrouter', { ...VALID, base_url: 'https://openrouter.ai/api/v1/' });
  assert.equal(entry.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(entry.protocol, 'openai-chat');
  assert.equal(entry.apiKeyEnv, 'DSH_API_OPENROUTER_KEY');
  assert.deepEqual(entry.headers, {});
});

test('an unsupported protocol is rejected', () => {
  assert.throws(() => validateProviderEntry('x', { ...VALID, protocol: 'anthropic-messages' }), ApiProviderConfigError);
});

test('a non-https base_url is rejected', () => {
  assert.throws(() => validateProviderEntry('x', { ...VALID, base_url: 'http://openrouter.ai/api/v1' }), ApiProviderConfigError);
});

test('a malformed base_url is rejected', () => {
  assert.throws(() => validateProviderEntry('x', { ...VALID, base_url: 'not-a-url' }), ApiProviderConfigError);
});

test('api_key_env must match the DSH_ secret-alias convention', () => {
  assert.throws(() => validateProviderEntry('x', { ...VALID, api_key_env: 'OPENROUTER_KEY' }), ApiProviderConfigError);
  assert.throws(() => validateProviderEntry('x', { ...VALID, api_key_env: 'dsh_lowercase_key' }), ApiProviderConfigError);
});

test('optional headers are accepted, but runtime-owned transport headers can never be set through them', () => {
  const entry = validateProviderEntry('x', { ...VALID, headers: { 'HTTP-Referer': 'https://example.invalid', 'X-OpenRouter-Title': 'DSH' } });
  assert.deepEqual(entry.headers, { 'HTTP-Referer': 'https://example.invalid', 'X-OpenRouter-Title': 'DSH' });
  assert.throws(() => validateProviderEntry('x', { ...VALID, headers: { Authorization: 'Bearer sneaky' } }), ApiProviderConfigError);
  assert.throws(() => validateProviderEntry('x', { ...VALID, headers: { authorization: 'Bearer sneaky' } }), ApiProviderConfigError);
  for (const name of ['Proxy-Authorization', 'Host', 'Content-Length', 'Content-Type', 'Connection', 'Transfer-Encoding', 'Trailer', 'Upgrade', 'Expect']) {
    assert.throws(() => validateProviderEntry('x', { ...VALID, headers: { [name]: 'sneaky' } }), ApiProviderConfigError);
  }
});

test('a provider id must be a bounded lowercase slug', () => {
  assert.throws(() => validateProviderEntry('Bad Id!', VALID), ApiProviderConfigError);
  assert.doesNotThrow(() => validateProviderEntry('xcode-best', VALID));
});

test('validateApiProvidersDoc accepts the P11-R0 three-provider example config shape', () => {
  const providers = validateApiProvidersDoc({
    api_providers: {
      openrouter: { protocol: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'DSH_API_OPENROUTER_KEY' },
      deepseek: { protocol: 'openai-chat', base_url: 'https://api.deepseek.com', api_key_env: 'DSH_API_DEEPSEEK_KEY' },
      'xcode-best': { protocol: 'openai-chat', base_url: 'https://api.xcode.best/v1', api_key_env: 'DSH_API_XCODE_BEST_KEY' },
    },
  });
  assert.deepEqual(Object.keys(providers).sort(), ['deepseek', 'openrouter', 'xcode-best']);
});

test('an empty/absent doc yields an empty provider registry, never an error', () => {
  assert.deepEqual(validateApiProvidersDoc(undefined), {});
  assert.deepEqual(validateApiProvidersDoc({}), {});
  assert.deepEqual(validateApiProvidersDoc({ api_providers: {} }), {});
});

test('loadApiProviderConfig with no path returns an empty registry without touching the filesystem — the zero-config default', async () => {
  assert.deepEqual(await loadApiProviderConfig({}), {});
});

test('loadApiProviderConfig loads and strictly validates a real file when a path is given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-p11-'));
  try {
    const path = join(dir, 'api-providers.yaml');
    await writeFile(path, 'api_providers:\n  openrouter:\n    protocol: openai-chat\n    base_url: https://openrouter.ai/api/v1\n    api_key_env: DSH_API_OPENROUTER_KEY\n', 'utf8');
    const providers = await loadApiProviderConfig({ path });
    assert.equal(providers.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadApiProviderConfig isolates one malformed provider while retaining valid siblings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-p11-'));
  try {
    const path = join(dir, 'api-providers.yaml');
    await writeFile(path, 'api_providers:\n  deepseek:\n    protocol: openai-chat\n    base_url: https://api.deepseek.com\n    api_key_env: DSH_API_DEEPSEEK_KEY\n  xcode-best:\n    protocol: not-a-real-protocol\n    base_url: https://api.xcode.best/v1\n    api_key_env: DSH_API_XCODE_BEST_KEY\n', 'utf8');
    const errors = [];
    const providers = await loadApiProviderConfig({ path, onInvalidProvider: (error) => errors.push(error) });
    assert.deepEqual(Object.keys(providers), ['deepseek']);
    assert.deepEqual(errors.map(({ id, code }) => ({ id, code })), [{ id: 'xcode-best', code: 'API_PROVIDER_CONFIG_INVALID' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getProviderConfig throws typed API_PROVIDER_CONFIG_INVALID for an unconfigured provider id', () => {
  assert.throws(() => getProviderConfig({}, 'openrouter'), (e) => e instanceof ApiBackendError && e.code === 'API_PROVIDER_CONFIG_INVALID');
});

test('resolveApiKey throws typed API_SECRET_MISSING when the env var is absent, and never returns an undefined/empty value silently', () => {
  const entry = validateProviderEntry('openrouter', VALID);
  assert.throws(() => resolveApiKey(entry, {}), (e) => e instanceof ApiBackendError && e.code === 'API_SECRET_MISSING');
  assert.throws(() => resolveApiKey(entry, { DSH_API_OPENROUTER_KEY: '' }), (e) => e instanceof ApiBackendError && e.code === 'API_SECRET_MISSING');
  assert.equal(resolveApiKey(entry, { DSH_API_OPENROUTER_KEY: 'sk-real-secret' }), 'sk-real-secret');
});

test('resolveApiKey never leaks the api_key_env NAME as if it were the secret VALUE, and the error never contains a plausible secret', () => {
  const entry = validateProviderEntry('openrouter', VALID);
  try {
    resolveApiKey(entry, {});
    assert.fail('expected to throw');
  } catch (error) {
    assert.equal(error.apiKeyEnv, 'DSH_API_OPENROUTER_KEY');
    assert.equal(JSON.stringify(error).includes('sk-'), false);
  }
});
