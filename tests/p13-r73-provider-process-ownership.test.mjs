import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  awaitOwnedSpawnReaping,
  withReapedOwnedSpawnLifecycle,
} from '../src/runtime/backend-execution-observer.mjs';

function fakeChild(pid, { cooperative = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (cooperative) queueMicrotask(() => { child.signalCode = signal; child.emit('close', null, signal); });
    return true;
  };
  return child;
}

test('cooperative owned child reaps after graceful signal without tree escalation', async () => {
  const controller = new AbortController();
  const child = fakeChild(41001, { cooperative: true });
  const taskkillCalls = [];
  const spawnOwned = withReapedOwnedSpawnLifecycle(() => child, controller.signal, {
    gracefulAfterMs: 10,
    taskkillSpawn: (...args) => { taskkillCalls.push(args); return fakeChild(51001, { cooperative: true }); },
  });
  spawnOwned('provider');
  const keepAlive = setInterval(() => {}, 1_000);
  controller.abort();
  await awaitOwnedSpawnReaping(controller.signal).finally(() => clearInterval(keepAlive));
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(taskkillCalls.length, 0);
});

test('non-cooperative Windows child escalates only its proven PID tree and waits for close', { skip: process.platform !== 'win32' }, async () => {
  const controller = new AbortController();
  const child = fakeChild(41002);
  const taskkillCalls = [];
  const spawnOwned = withReapedOwnedSpawnLifecycle(() => child, controller.signal, {
    gracefulAfterMs: 5,
    reapAfterMs: 100,
    taskkillSpawn: (command, args, options) => {
      taskkillCalls.push({ command, args, options });
      const killer = fakeChild(51002);
      queueMicrotask(() => {
        killer.emit('close', 0, null);
        child.signalCode = 'SIGKILL';
        child.emit('close', null, 'SIGKILL');
      });
      return killer;
    },
  });
  spawnOwned('provider');
  const keepAlive = setInterval(() => {}, 1_000);
  controller.abort();
  await awaitOwnedSpawnReaping(controller.signal).finally(() => clearInterval(keepAlive));
  assert.deepEqual(taskkillCalls.map((call) => call.args), [['/PID', '41002', '/T', '/F']]);
  assert.equal(taskkillCalls[0].options.shell, false);
});

test('parallel task ownership is isolated by AbortSignal', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const childA = fakeChild(41003, { cooperative: true });
  const childB = fakeChild(41004, { cooperative: true });
  withReapedOwnedSpawnLifecycle(() => childA, a.signal)('a');
  withReapedOwnedSpawnLifecycle(() => childB, b.signal)('b');
  a.abort();
  await awaitOwnedSpawnReaping(a.signal);
  assert.deepEqual(childA.killCalls, ['SIGTERM']);
  assert.deepEqual(childB.killCalls, []);
  b.abort();
  await awaitOwnedSpawnReaping(b.signal);
});
