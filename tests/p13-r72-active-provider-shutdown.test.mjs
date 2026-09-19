import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

const quietObserver = {
  start() {}, spawn() {}, stdoutChunk() {}, stderrChunk() {}, exit() {},
  parser() {}, terminal() {}, timeout() {}, stdoutSummary() {}, sandbox() {},
};

test('active provider child is owned by the task abort and cannot hold runtime shutdown open', async () => {
  let providerPid = null;
  let providerClosed;
  const providerClose = new Promise((resolve) => { providerClosed = resolve; });
  const runner = ({ spawnImpl }) => new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    providerPid = child.pid;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      providerClosed({ code, signal });
      reject(Object.assign(new Error('provider interrupted'), { code: 'TEST_PROVIDER_INTERRUPTED' }));
    });
  });
  const registry = new ProductionPmBackendRegistry({
    codexRunner: runner,
    codexBinary: process.execPath,
    probe: () => true,
    observer: quietObserver,
  });
  const driver = registry.resolve(
    { id: 'owned-provider', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' },
    { project: { id: 'workspace-a', repo_path: process.cwd() } },
  );
  const controller = new AbortController();
  const active = driver.decide({ request: { id: 'request-a', objective: 'hold' }, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(Number.isInteger(providerPid) && providerPid > 0, 'the active provider child must be proven');

  const shutdownAt = Date.now();
  controller.abort();
  await assert.rejects(active, (error) => error.code === 'PM_BACKEND_ABORTED');
  await Promise.race([
    providerClose,
    new Promise((_, reject) => setTimeout(() => reject(new Error('owned provider did not close')), 4_000)),
  ]);
  assert.ok(Date.now() - shutdownAt < 4_000, 'owned provider must close inside the fixed shutdown budget');
  assert.throws(() => process.kill(providerPid, 0), /ESRCH|no such process/i);
});
