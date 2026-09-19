import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadP5ProductionConfig, publicP5Config } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function fixture(t, { includeTelegram = false, telegramLines = '', envOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p25-tg-optional-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'projects.yaml'), `projects:\n  - id: p1\n    repo_path: ./repo\n    default_pm_profile_id: pm-claude\n    autonomy: {revision: 1, effects: {}}\n`);
  writeFileSync(join(root, 'profiles.yaml'), `pm_profiles:\n  - id: pm-claude\n    role_kind: PM\n    session_kind: STATELESS\n    product: scripted\n    transport: in-process\n`);
  const configLines = [
    'mode: production',
    'postgres:\n  dsn_env: DSH_TEST_PG',
    'sqlite:\n  path: ./state.db',
    'projects_file: ./projects.yaml',
    'pm_profiles_file: ./profiles.yaml',
    ...(includeTelegram ? [
      'telegram:',
      '  token_env: DSH_TEST_TG',
      '  user_id: "12345678"',
      '  chat_id: "12345678"',
      '  poll_interval_ms: 1000',
    ] : (telegramLines ? [telegramLines] : [])),
    'coordinator:\n  logical_id: c\n  lease_ms: 30000\n  poll_interval_ms: 250',
    'worker:\n  logical_id: w\n  lease_ms: 30000\n  poll_interval_ms: 250',
    'pm:\n  scripted_decisions:\n    - type: finish\n      output: ok',
  ];
  const configPath = join(root, 'config.yaml');
  writeFileSync(configPath, configLines.join('\n') + '\n');
  const env = {
    DSH_TEST_PG: 'postgresql://example.invalid/dsh',
    ...envOverrides,
  };
  return { root, path: configPath, env };
}

test('NO TELEGRAM CONFIG → runtime/config accepted without Telegram secret', async (t) => {
  const f = fixture(t, { includeTelegram: false });
  // Notice: f.env has no DSH_TEST_TG at all
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.equal(config.telegram, null);
  
  const pub = publicP5Config(config);
  assert.equal(pub.telegram.configured, false);
  assert.equal(pub.telegram.token_present, false);
  assert.equal(pub.telegram.ownerUserId, null);
  assert.equal(pub.telegram.ownerChatId, null);

  // Verify composition readiness without telegram
  const sqlite = await new SqlitePersistenceStore().open({ path: config.sqlitePath });
  const coordination = {
    assertReady: async () => true,
    close: async () => {},
    registerCoordinatorIncarnation: async () => {},
    acquireLeadership: async () => null,
    registerWorkIdentity: async () => {},
    observeReconciliationResources: () => {},
  };
  const owner = {
    close: async () => {},
    beginCommand: async () => ({ status: 'PENDING', created_at: new Date().toISOString() }),
    claimNotifications: async () => [],
    completeCommand: async (id, canonical) => ({ command_id: id, status: 'COMPLETED', ...canonical }),
  };

  const composition = await createP5ProductionComposition(config, {
    sqliteStore: sqlite,
    coordinationStore: coordination,
    ownerRepository: owner,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  });
  try {
    const report = composition.readiness();
    assert.equal(report.ready, true);
    assert.equal(report.telegram.configured, false);
    assert.equal(report.telegram.token_present, false);
    assert.equal(report.ownerRuntime.constructed, true);
  } finally {
    await composition.close().catch(() => {});
  }
});

test('TELEGRAM CONFIG + valid env → accepted and configured', async (t) => {
  const f = fixture(t, {
    includeTelegram: true,
    envOverrides: { DSH_TEST_TG: 'valid-secret-token' },
  });
  const config = await loadP5ProductionConfig(f.path, { env: f.env });
  assert.notEqual(config.telegram, null);
  assert.equal(config.telegram.token, 'valid-secret-token');
  assert.equal(config.telegram.ownerUserId, '12345678');
  assert.equal(config.telegram.ownerChatId, '12345678');

  const pub = publicP5Config(config);
  assert.equal(pub.telegram.configured, true);
  assert.equal(pub.telegram.token_present, true);
  assert.equal(pub.telegram.ownerUserId, '12345678');
});

test('TELEGRAM CONFIG + missing token → fail closed with SECRET_UNAVAILABLE', async (t) => {
  const f = fixture(t, {
    includeTelegram: true,
    // DSH_TEST_TG is omitted from env
  });
  await assert.rejects(
    async () => { await loadP5ProductionConfig(f.path, { env: f.env }); },
    (error) => {
      assert.equal(error.code, 'SECRET_UNAVAILABLE');
      assert.match(error.message, /Telegram token secret is unavailable/);
      return true;
    }
  );
});

test('TELEGRAM CONFIG + malformed user_id → fail closed with TypeError', async (t) => {
  const f = fixture(t, {
    telegramLines: 'telegram:\n  token_env: DSH_TEST_TG\n  user_id: "not-a-number"\n  chat_id: "12345678"',
    envOverrides: { DSH_TEST_TG: 'valid-secret-token' },
  });
  await assert.rejects(
    async () => { await loadP5ProductionConfig(f.path, { env: f.env }); },
    (error) => {
      assert.match(error.message, /Telegram owner user_id is invalid/);
      return true;
    }
  );
});

test('TELEGRAM CONFIG + malformed chat_id → fail closed with TypeError', async (t) => {
  const f = fixture(t, {
    telegramLines: 'telegram:\n  token_env: DSH_TEST_TG\n  user_id: "12345678"\n  chat_id: "not-a-number"',
    envOverrides: { DSH_TEST_TG: 'valid-secret-token' },
  });
  await assert.rejects(
    async () => { await loadP5ProductionConfig(f.path, { env: f.env }); },
    (error) => {
      assert.match(error.message, /Telegram owner chat_id is invalid/);
      return true;
    }
  );
});
