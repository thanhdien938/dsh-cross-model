// P15-B-001: every launcher-shaped path must converge on the runtime-owned lease.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireRuntimeSingletonLease, buildRuntimeLockDomain } from '../src/runtime/runtime-singleton-lease.mjs';

const holderScript = fileURLToPath(new URL('./fixtures/p15-runtime-lease-holder.mjs', import.meta.url));

function waitForJson(child, streamName, event) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const stream = child[streamName];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}; buffered=${buffered}`)), 5000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      for (const line of buffered.split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === event) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {}
      }
    });
    child.once('error', reject);
  });
}

function startHolder(shape, lockRoot, stateSuffix = 'shared') {
  return spawn(process.execPath, [holderScript, shape, lockRoot, stateSuffix], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

for (const [firstShape, secondShape] of [['cli', 'desktop'], ['desktop', 'cli'], ['cli', 'cli'], ['desktop', 'desktop']]) {
  test(`P15-B-001 ${firstShape} first -> ${secondShape} second: first READY, second typed REFUSED`, async (t) => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'dsh-p15-lock-'));
    const first = startHolder(firstShape, lockRoot);
    t.after(async () => { await stop(first); await rm(lockRoot, { recursive: true, force: true }); });
    assert.equal((await waitForJson(first, 'stdout', 'READY')).launch_shape, firstShape);

    const second = startHolder(secondShape, lockRoot);
    const refusal = await waitForJson(second, 'stderr', 'REFUSED');
    assert.equal(refusal.launch_shape, secondShape);
    assert.equal(refusal.code, 'RUNTIME_ALREADY_ACTIVE');
    assert.equal(await new Promise((resolve) => second.once('exit', resolve)), 73);
  });
}

test('P15-B-001 distinct isolated state domains may run concurrently', async (t) => {
  const lockRoot = await mkdtemp(join(tmpdir(), 'dsh-p15-isolated-'));
  const first = startHolder('cli', lockRoot, 'alpha');
  const second = startHolder('desktop', lockRoot, 'beta');
  t.after(async () => { await stop(first); await stop(second); await rm(lockRoot, { recursive: true, force: true }); });
  assert.equal((await waitForJson(first, 'stdout', 'READY')).launch_shape, 'cli');
  assert.equal((await waitForJson(second, 'stdout', 'READY')).launch_shape, 'desktop');
});

test('P15-B-001 live PID lease is not stolen; dead PID lease recovers; malformed lease fails safely', async (t) => {
  const lockRoot = await mkdtemp(join(tmpdir(), 'dsh-p15-stale-'));
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const domain = buildRuntimeLockDomain({
    sqlitePath: 'C:/dsh-test/stale/state.sqlite',
    postgresConnectionString: 'postgresql://test:test@127.0.0.1:5432/stale',
    projects: [{ workspace_id: 'workspace-stale', workspace_verified: true }],
  });

  const live = await acquireRuntimeSingletonLease({ domain, lockRoot });
  await assert.rejects(() => acquireRuntimeSingletonLease({ domain, lockRoot }), (error) => error?.code === 'RUNTIME_ALREADY_ACTIVE');
  await live.release();

  const stale = await acquireRuntimeSingletonLease({ domain, lockRoot, pid: 2147483000, isProcessAlive: () => false });
  const recovered = await acquireRuntimeSingletonLease({ domain, lockRoot, isProcessAlive: (pid) => pid === process.pid });
  await stale.release(); // ownership token prevents the stale owner from deleting its successor
  await assert.rejects(() => acquireRuntimeSingletonLease({ domain, lockRoot }), (error) => error?.code === 'RUNTIME_ALREADY_ACTIVE');
  await recovered.release();

  const concurrentlyStale = await acquireRuntimeSingletonLease({ domain, lockRoot, pid: 2147482999, isProcessAlive: () => false });
  const contenders = await Promise.allSettled(Array.from({ length: 8 }, () => acquireRuntimeSingletonLease({ domain, lockRoot, isProcessAlive: (pid) => pid === process.pid })));
  const winners = contenders.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1, 'atomic stale recovery elects exactly one replacement owner');
  assert.equal(contenders.filter((result) => result.status === 'rejected').every((result) => result.reason?.code === 'RUNTIME_ALREADY_ACTIVE'), true);
  await concurrentlyStale.release();
  await winners[0].value.release();

  const malformed = await acquireRuntimeSingletonLease({ domain, lockRoot });
  const lockPath = malformed.lockPaths[0];
  await malformed.release();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(lockPath, '{not-json', { flag: 'wx' });
  await assert.rejects(() => acquireRuntimeSingletonLease({ domain, lockRoot }), (error) => error?.code === 'RUNTIME_LOCK_INVALID');
});
