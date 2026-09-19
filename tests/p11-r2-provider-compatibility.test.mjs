import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadP5ProductionConfig, publicP5Config } from '../src/runtime/p5-production-config.mjs';
import { runApiBackendRequest } from '../src/pm/api-backend/api-backend-adapter.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { ApiBackendError } from '../src/pm/api-backend/api-backend-errors.mjs';
import { startFakeOpenAiServer, errorStatusFixture, malformedJsonFixture, hangFixture } from './lib/fake-openai-server.mjs';

const PROVIDER_FIXTURES = Object.freeze([
  ['openrouter', 'https://openrouter.ai/api/v1', 'DSH_API_OPENROUTER_KEY'],
  ['deepseek', 'https://api.deepseek.com', 'DSH_API_DEEPSEEK_KEY'],
  ['xcode-best', 'https://api.xcode.best/v1', 'DSH_API_XCODE_BEST_KEY'],
]);

test('production startup isolates one invalid API provider while retaining valid DeepSeek and xcode.best siblings', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p11-r2-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  writeFileSync(join(root, 'api-providers.yaml'), `api_providers:\n  deepseek:\n    protocol: openai-chat\n    base_url: https://api.deepseek.com\n    api_key_env: DSH_API_DEEPSEEK_KEY\n  xcode-best:\n    protocol: openai-chat\n    base_url: https://api.xcode.best/v1\n    api_key_env: DSH_API_XCODE_BEST_KEY\n  broken-provider:\n    protocol: anthropic-messages\n    base_url: https://example.invalid\n    api_key_env: DSH_API_BROKEN_KEY\n`);
  writeFileSync(join(root, 'config.yaml'), `mode: production\npostgres:\n  dsn_env: DSH_TEST_PG\nsqlite:\n  path: ${join(root, 'state.db').replaceAll('\\', '/')}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\napi_providers_file: ./api-providers.yaml\ntelegram:\n  token_env: DSH_TEST_TG\n  user_id: '1'\n  chat_id: '2'\ncoordinator:\n  logical_id: c\nworker:\n  logical_id: w\npm: {}\n`);
  const config = await loadP5ProductionConfig(join(root, 'config.yaml'), { env: { DSH_TEST_PG: 'postgresql://u:p@localhost/db', DSH_TEST_TG: 'token' } });
  assert.deepEqual(Object.keys(config.apiProviders).sort(), ['deepseek', 'xcode-best']);
  assert.deepEqual(config.apiProviderConfigErrors.map(({ id, code }) => ({ id, code })), [{ id: 'broken-provider', code: 'API_PROVIDER_CONFIG_INVALID' }]);
  const serialized = JSON.stringify(publicP5Config(config));
  assert.match(serialized, /broken-provider/);
  assert.doesNotMatch(serialized, /DSH_API_(?:DEEPSEEK|XCODE_BEST)_KEY/);
});

for (const [providerId, baseUrl, apiKeyEnv] of PROVIDER_FIXTURES) {
  test(`${providerId} uses the generic typed HTTP/error normalization matrix`, async (t) => {
    const provider = validateProviderEntry(providerId, { protocol: 'openai-chat', base_url: baseUrl, api_key_env: apiKeyEnv });
    const env = { [apiKeyEnv]: 'fixture-key' };
    const cases = [
      [401, 'API_AUTH_FAILED'], [402, 'API_BILLING_FAILED'], [403, 'API_FORBIDDEN'],
      [404, 'API_MODEL_NOT_FOUND'], [429, 'API_RATE_LIMITED'], [500, 'API_PROVIDER_UNAVAILABLE'],
    ];
    for (const [status, expectedCode] of cases) {
      await t.test(`HTTP ${status} -> ${expectedCode}`, async () => {
        const server = await startFakeOpenAiServer(errorStatusFixture(status, `${providerId} fixture failure`));
        try {
          await assert.rejects(
            runApiBackendRequest({ providerId, model: 'fixture-model', prompt: 'p', providers: { [providerId]: { ...provider, baseUrl: server.baseUrl } }, env, fetchImpl: fetch }),
            (error) => error instanceof ApiBackendError && error.code === expectedCode,
          );
        } finally { await server.close(); }
      });
    }
    await t.test('malformed response -> API_RESPONSE_INVALID', async () => {
      const server = await startFakeOpenAiServer(malformedJsonFixture());
      try {
        await assert.rejects(
          runApiBackendRequest({ providerId, model: 'fixture-model', prompt: 'p', providers: { [providerId]: { ...provider, baseUrl: server.baseUrl } }, env, fetchImpl: fetch }),
          (error) => error instanceof ApiBackendError && error.code === 'API_RESPONSE_INVALID',
        );
      } finally { await server.close(); }
    });
    await t.test('deadline -> API_TIMEOUT', async () => {
      const server = await startFakeOpenAiServer(hangFixture());
      try {
        await assert.rejects(
          runApiBackendRequest({ providerId, model: 'fixture-model', prompt: 'p', providers: { [providerId]: { ...provider, baseUrl: server.baseUrl } }, env, fetchImpl: fetch, timeoutMs: 50 }),
          (error) => error instanceof ApiBackendError && error.code === 'API_TIMEOUT',
        );
      } finally { await server.close(); }
    });
  });
}
