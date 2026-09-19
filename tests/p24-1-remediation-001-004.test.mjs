import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleArtifactDriver } from '../src/pm/single-artifact-driver.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY } from '../src/artifacts/backend-report-capability.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';
import { TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';
import { runGit } from '../src/pm/task-result-git-sync.mjs';
import { acquireRuntimeSingletonLease, buildRuntimeLockDomain } from '../src/runtime/runtime-singleton-lease.mjs';
import { resolveArtifactReportTimeout } from '../src/runtime/p20-report-route-resolution.mjs';
import { PRODUCTION_REPORT_BACKEND_TIMEOUT_MS } from '../src/pm/report-execution-timeout-policy.mjs';
import { awaitOwnedSpawnReaping, withReapedOwnedSpawnLifecycle } from '../src/runtime/backend-execution-observer.mjs';

test('P24.1-001: artifact SINGLE propagates cancellation and cannot seal a raced success', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const controller = new AbortController();
    const executionOptions = { timeoutMs: 300_000, stage: 'OWNER_SINGLE' };
    let observedSignal;
    let observedPolicy;
    const driver = new SingleArtifactDriver({
      store, taskId: 'p24-cancel', taskSlug: 'p24-cancel', createdAt: '2026-09-15T00:00:00Z',
      profileId: 'live1-fake', actorAlias: 'fake', instructions: 'work', executionOptions,
      capabilityPolicy: DEFAULT_BACKEND_REPORT_POLICY,
      resolveReportBackend: (_profileId, policy) => {
        observedPolicy = policy;
        return { backend: 'fake', async runReport({ request }) {
          observedSignal = request.signal;
          controller.abort();
          return buildReportBackendResult({ backend: 'fake', profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'late success', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE });
        } };
      },
    });
    await assert.rejects(driver.decide({ turn: 0, signal: controller.signal }), (error) => error?.code === 'REPORT_EXECUTION_CANCELLED');
    assert.equal(observedSignal, controller.signal);
    assert.equal(observedPolicy, executionOptions);
    assert.notEqual(store.openTaskById('p24-cancel').manifest.task_state, 'COMPLETED');
  });
});

test('P24.1-001: Normal and Long policy deadlines are explicit and CLI safety ceilings are preserved', () => {
  assert.equal(resolveArtifactReportTimeout('api', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 300_000 }), 300_000);
  assert.equal(resolveArtifactReportTimeout('api', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 1_800_000 }), 1_800_000);
  assert.equal(resolveArtifactReportTimeout('codex', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 300_000 }), 540_000);
  assert.equal(resolveArtifactReportTimeout('opencode', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 300_000 }), 540_000);
  assert.equal(resolveArtifactReportTimeout('claude-code', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 300_000 }), 360_000);
  assert.equal(resolveArtifactReportTimeout('codex', PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, { timeoutMs: 1_800_000 }), 1_800_000);
});

test('P24.1-002: stale callback is consumed and a later update in the batch is processed', async () => {
  const sent = [];
  let mutations = 0;
  const updates = [
    { update_id: 10, callback_query: { from: { id: 1 }, message: { chat: { id: 2 } }, data: 'stale' } },
    { update_id: 11, message: { from: { id: 1 }, chat: { id: 2 }, text: '@p task' } },
  ];
  const fetchImpl = async (url, options = {}) => String(url).includes('getUpdates')
    ? { ok: true, json: async () => ({ result: updates }) }
    : (sent.push(JSON.parse(options.body).text), { ok: true, json: async () => ({ ok: true }) });
  const adapter = new TelegramOwnerAdapter({
    token: 'x', ownerUserId: 1, ownerChatId: 2, fetchImpl, projects: [{ id: 'p' }], pmProfiles: [],
    service: {
      resolveCallback: async () => { throw new OwnerControlError('expired', 'STALE_CALLBACK'); },
      mutate: async () => { mutations += 1; return { canonical_result: { task_id: 't', pm_profile_id: 'pm' } }; },
      read: async () => ({}),
    },
  });
  await adapter.pollOnce();
  assert.equal(adapter.offset, 12);
  assert.equal(mutations, 1);
  assert.ok(sent.some((text) => text.includes('expired')));
});

test('P24.1-002: transient callback lookup failure retains the update for retry', async () => {
  const update = { update_id: 20, callback_query: { from: { id: 1 }, message: { chat: { id: 2 } }, data: 'retry' } };
  const adapter = new TelegramOwnerAdapter({ token: 'x', ownerUserId: 1, ownerChatId: 2, projects: [{ id: 'p' }], pmProfiles: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [update] }) }),
    service: { resolveCallback: async () => { throw new Error('temporary database outage'); } },
  });
  await assert.rejects(adapter.pollOnce(), /temporary database outage/);
  assert.equal(adapter.offset, 0);
});

function fakeGitChild({ exits }) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { if (exits) queueMicrotask(() => { child.signalCode = signal; child.emit('close', null, signal); }); return true; };
  return child;
}

test('P24.1-003: Git timeout reports confirmed exit separately from unresolved ownership', async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const confirmed = await runGit(['status'], { timeoutMs: 5, spawnImpl: () => fakeGitChild({ exits: true }), processSettlementOptions: { gracefulAfterMs: 2, reapAfterMs: 2 } });
    assert.equal(confirmed.timedOut, true);
    assert.equal(confirmed.ownershipState, 'CONFIRMED_EXITED');
    const unresolved = await runGit(['status'], { timeoutMs: 5, spawnImpl: () => fakeGitChild({ exits: false }), processSettlementOptions: { gracefulAfterMs: 2, reapAfterMs: 2, taskkillSpawn: () => fakeGitChild({ exits: true }) } });
    assert.equal(unresolved.timedOut, true);
    assert.equal(unresolved.ownershipState, 'UNRESOLVED_OWNERSHIP');
  } finally { clearInterval(keepAlive); }
});

test('P24.1-003: unresolved provider ownership is a fail-closed barrier', async () => {
  const controller = new AbortController();
  const child = fakeGitChild({ exits: false });
  withReapedOwnedSpawnLifecycle(() => child, controller.signal, {
    gracefulAfterMs: 2, reapAfterMs: 2, taskkillSpawn: () => fakeGitChild({ exits: true }),
  })('provider');
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    controller.abort();
    await assert.rejects(awaitOwnedSpawnReaping(controller.signal), (error) => error?.code === 'PROCESS_OWNERSHIP_UNRESOLVED' && error?.ownershipState === 'UNRESOLVED_OWNERSHIP');
  } finally { clearInterval(keepAlive); }
});

async function recoveryFixture(label) {
  const lockRoot = await mkdtemp(join(tmpdir(), `p24-recovery-${label}-`));
  const domain = buildRuntimeLockDomain({ sqlitePath: `C:/p24/${label}.sqlite`, postgresConnectionString: `postgresql://u:p@localhost:5432/${label}` });
  const stale = await acquireRuntimeSingletonLease({ domain, lockRoot, pid: 2147482000, isProcessAlive: () => false });
  const lockPath = stale.lockPaths[0];
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  return { lockRoot, domain, stale, lockPath, owner };
}

test('P24.1-004: dead recovery guard is reclaimed while live and malformed guards fail closed', async (t) => {
  for (const mode of ['dead', 'live', 'malformed']) {
    const f = await recoveryFixture(mode);
    t.after(() => rm(f.lockRoot, { recursive: true, force: true }));
    const recoveryPath = `${f.lockPath}.recovery`;
    if (mode === 'malformed') await writeFile(recoveryPath, '{bad-json');
    else await writeFile(recoveryPath, `${JSON.stringify({ ...f.owner, pid: mode === 'live' ? process.pid : 2147481999 })}\n`);
    if (mode === 'dead') {
      const lease = await acquireRuntimeSingletonLease({ domain: f.domain, lockRoot: f.lockRoot, isProcessAlive: () => false });
      await lease.release();
    } else {
      await assert.rejects(
        acquireRuntimeSingletonLease({ domain: f.domain, lockRoot: f.lockRoot, isProcessAlive: (pid) => pid === process.pid }),
        (error) => error?.code === (mode === 'live' ? 'RUNTIME_ALREADY_ACTIVE' : 'RUNTIME_LOCK_INVALID'),
      );
    }
  }
});
