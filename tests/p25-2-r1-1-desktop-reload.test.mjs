import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import net from 'node:net';
import { parse, stringify } from 'yaml';

import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition, createProductionPmDriverResolver } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';

function fixture(t, { includeTelegram = false, envOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p25-r11-reload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo'));

  writeFileSync(join(root, 'projects.yaml'), stringify({
    projects: [
      {
        id: 'p1',
        repo_path: './repo',
        default_pm_profile_id: 'pm-initial',
        autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } },
      },
    ],
  }));

  const profilesPath = join(root, 'pm_profiles.yaml');
  writeFileSync(profilesPath, stringify({
    pm_profiles: [
      {
        id: 'pm-initial',
        role_kind: 'PM',
        session_kind: 'STATELESS',
        product: 'scripted',
        transport: 'in-process',
      },
    ],
  }));

  const configPath = join(root, 'config.yaml');
  const configDoc = {
    mode: 'production',
    postgres: { dsn_env: 'DSH_TEST_PG' },
    sqlite: { path: './state.db' },
    projects_file: './projects.yaml',
    pm_profiles_file: './pm_profiles.yaml',
    coordinator: { logical_id: 'c', lease_ms: 30000, poll_interval_ms: 250 },
    worker: { logical_id: 'w', lease_ms: 30000, poll_interval_ms: 250 },
    pm: { scripted_decisions: [{ type: 'finish', output: 'ok' }] },
    ...(includeTelegram ? {
      telegram: {
        token_env: 'DSH_TEST_TG',
        user_id: '12345678',
        chat_id: '12345678',
        poll_interval_ms: 1000,
      },
    } : {}),
  };
  writeFileSync(configPath, stringify(configDoc));

  const env = {
    DSH_TEST_PG: 'postgresql://example.invalid/dsh',
    ...envOverrides,
  };

  return { root, configPath, profilesPath, env };
}

function appendProfile(profilesPath, entry) {
  const doc = parse(readFileSync(profilesPath, 'utf8'));
  doc.pm_profiles.push(entry);
  writeFileSync(profilesPath, stringify(doc), 'utf8');
}

async function buildComposition(f) {
  const config = await loadP5ProductionConfig(f.configPath, { env: f.env });
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
  const resolveDriver = createProductionPmDriverResolver({
    scriptedDecisions: config.pm.scriptedDecisions,
  });

  return createP5ProductionComposition(config, {
    sqliteStore: sqlite,
    coordinationStore: coordination,
    ownerRepository: owner,
    resolvePmDriver: resolveDriver,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  });
}

function sendPipeRequest(targetPipe, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(targetPipe);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) {
        socket.end();
        resolve(JSON.parse(response));
      }
    });
  });
}

test('NO TELEGRAM + reloadPmProfiles() → PASS, newly admitted profile visible, no null adapter exception', async (t) => {
  const f = fixture(t, { includeTelegram: false });
  const composition = await buildComposition(f);
  try {
    assert.equal(composition.adapter, null);
    const before = composition.readiness();
    assert.equal(before.telegram.configured, false);
    assert.equal(before.pmProfiles.backends.some((b) => b.profile_id === 'pm-hot-added'), false);

    // Append new profile to profiles.yaml
    appendProfile(f.profilesPath, {
      id: 'pm-hot-added',
      role_kind: 'PM',
      session_kind: 'STATELESS',
      product: 'scripted',
      transport: 'in-process',
    });

    // Call reloadPmProfiles() — MUST NOT throw TypeError: Cannot read properties of null
    const result = await composition.reloadPmProfiles();
    assert.deepEqual(result.admitted, ['pm-hot-added']);
    assert.deepEqual(result.rejected, []);

    // Verify newly admitted profile is visible across the runtime
    assert.equal(composition.profileRegistry.hasProfile('pm-hot-added'), true);
    assert.equal(composition.ownerService.pmProfiles.has('pm-hot-added'), true);

    const after = composition.readiness();
    const entry = after.pmProfiles.backends.find((b) => b.profile_id === 'pm-hot-added');
    assert.ok(entry, 'newly admitted profile must be present in readiness().pmProfiles.backends');
    assert.equal(Boolean(entry.available), true);
    assert.equal(after.pmProfiles.count, before.pmProfiles.count + 1);
  } finally {
    await composition.close().catch(() => {});
  }
});

test('TELEGRAM ENABLED + reloadPmProfiles() → existing routing refresh behavior preserved', async (t) => {
  const f = fixture(t, { includeTelegram: true, envOverrides: { DSH_TEST_TG: 'dummy-token' } });
  const composition = await buildComposition(f);
  try {
    assert.notEqual(composition.adapter, null);
    assert.equal(composition.adapter.pmProfiles.some((p) => p.id === 'pm-initial'), true);
    assert.equal(composition.adapter.pmProfiles.some((p) => p.id === 'pm-tg-added'), false);

    appendProfile(f.profilesPath, {
      id: 'pm-tg-added',
      role_kind: 'PM',
      session_kind: 'STATELESS',
      product: 'scripted',
      transport: 'in-process',
    });

    const result = await composition.reloadPmProfiles();
    assert.deepEqual(result.admitted, ['pm-tg-added']);
    assert.deepEqual(result.rejected, []);

    // Verify Telegram adapter routing was refreshed
    assert.equal(composition.adapter.pmProfiles.some((p) => p.id === 'pm-tg-added'), true);
  } finally {
    await composition.close().catch(() => {});
  }
});

test('LOCAL_RUNTIME_CONTROL_RELOAD (Desktop-only / No Telegram) → control pipe reloads profiles cleanly', async (t) => {
  const f = fixture(t, { includeTelegram: false });
  const composition = await buildComposition(f);
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-p25-reload-${process.pid}-${randomUUID()}`
    : join(f.root, `dsh-p25-reload-${process.pid}-${randomUUID()}.sock`);
  const authCapability = randomBytes(32).toString('hex');

  const control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => composition.readiness(),
    reloadPmProfiles: () => composition.reloadPmProfiles(),
    onShutdown: () => {},
  });

  try {
    appendProfile(f.profilesPath, {
      id: 'pm-pipe-added',
      role_kind: 'PM',
      session_kind: 'STATELESS',
      product: 'scripted',
      transport: 'in-process',
    });

    const response = await sendPipeRequest(pipeName, {
      id: 'r-test-1',
      operation: 'RELOAD_PM_PROFILES',
      auth: authCapability,
    });

    assert.equal(response.success, true);
    assert.deepEqual(response.result.admitted, ['pm-pipe-added']);
    assert.deepEqual(response.result.rejected, []);

    const readiness = composition.readiness();
    assert.equal(readiness.pmProfiles.backends.some((b) => b.profile_id === 'pm-pipe-added'), true);
  } finally {
    await control.close().catch(() => {});
    await composition.close().catch(() => {});
  }
});
