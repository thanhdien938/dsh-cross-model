import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';

const configs = {
  shared: value('--shared-config'),
  isolatedA: value('--isolated-a'),
  isolatedB: value('--isolated-b'),
};
const expectCoexistence = process.argv.includes('--expect-coexistence');
if (!configs.shared || (!expectCoexistence && (!configs.isolatedA || !configs.isolatedB))) {
  console.error('usage: node scripts/p15-rem-r1-runtime-live-proof.mjs --shared-config <path> --isolated-a <path> --isolated-b <path>');
  process.exit(2);
}

const runtimeScript = resolve(value('--runtime-script') ?? 'scripts/p5-runtime.mjs');
const live = new Set();

function pipeName() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-p15-live-${randomUUID()}`
    : `/tmp/dsh-p15-live-${randomUUID()}.sock`;
}

function launch({ shape, config }) {
  const pipe = pipeName();
  const auth = randomBytes(32).toString('hex');
  const role = shape === 'desktop' ? 'all' : 'worker';
  const child = spawn(process.execPath, [runtimeScript, role, '--config', resolve(config), '--control-pipe', pipe], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_RUNTIME_CONTROL_AUTH: auth },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  live.add(child);
  child.once('exit', () => live.delete(child));
  return { child, pipe, auth, shape };
}

function waitForEvent(runtime, streamName, event, timeoutMs = 15000) {
  return new Promise((resolveEvent, reject) => {
    let buffered = '';
    const stream = runtime.child[streamName];
    const timer = setTimeout(() => reject(new Error(`${runtime.shape} timed out waiting for ${event}`)), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === event) {
            clearTimeout(timer);
            resolveEvent(parsed);
            return;
          }
        } catch {}
      }
    });
    runtime.child.once('error', reject);
  });
}

function requestShutdown({ pipe, auth }) {
  return new Promise((resolveRequest, reject) => {
    const socket = net.connect(pipe);
    let buffered = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('shutdown acknowledgement timeout')); }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: randomUUID(), operation: 'SHUTDOWN', auth })}\n`));
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      resolveRequest();
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

async function stop(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  const exit = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`${runtime.shape} runtime exit timeout`)), 20000);
    runtime.child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
  await requestShutdown(runtime);
  const code = await exit;
  if (code !== 0) throw new Error(`${runtime.shape} runtime exited ${code}`);
}

async function proveRefusal(firstShape, secondShape) {
  const first = launch({ shape: firstShape, config: configs.shared });
  await waitForEvent(first, 'stdout', 'p5.runtime.started');
  const second = launch({ shape: secondShape, config: configs.shared });
  const failure = await waitForEvent(second, 'stderr', 'p5.runtime.failed');
  const secondExit = await waitForExit(second.child);
  if (failure.code !== 'RUNTIME_ALREADY_ACTIVE' || secondExit !== 1) throw new Error(`typed refusal failed: ${JSON.stringify({ failure, secondExit })}`);
  await stop(first);
  return { first: 'READY', second: 'REFUSED', code: failure.code };
}

try {
  if (expectCoexistence) {
    const cli = launch({ shape: 'cli', config: configs.shared });
    const desktop = launch({ shape: 'desktop', config: configs.shared });
    await Promise.all([waitForEvent(cli, 'stdout', 'p5.runtime.started'), waitForEvent(desktop, 'stdout', 'p5.runtime.started')]);
    await Promise.all([stop(cli), stop(desktop)]);
    console.log(JSON.stringify({ status: 'RED_PROVEN', cli: 'READY', desktop: 'READY', simultaneous_runtime_count: 2 }, null, 2));
    process.exitCode = 0;
  } else {
    const cliThenCli = await proveRefusal('cli', 'cli');
    const desktopThenCli = await proveRefusal('desktop', 'cli');

    const isolatedA = launch({ shape: 'cli', config: configs.isolatedA });
    const isolatedB = launch({ shape: 'desktop', config: configs.isolatedB });
    await Promise.all([
      waitForEvent(isolatedA, 'stdout', 'p5.runtime.started'),
      waitForEvent(isolatedB, 'stdout', 'p5.runtime.started'),
    ]);
    await Promise.all([stop(isolatedA), stop(isolatedB)]);

    console.log(JSON.stringify({
      status: 'PASS',
      cli_then_cli: cliThenCli,
      desktop_then_cli: desktopThenCli,
      isolated_domains: 'BOTH_READY',
      owner_data_touched: false,
    }, null, 2));
  }
} finally {
  for (const child of live) child.kill('SIGTERM');
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}
