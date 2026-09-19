import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/p13-r61-control-close-child.mjs', import.meta.url));

test('persistent runtime-control client is closed and subprocess exits naturally for five normal-stop cycles', { timeout: 20_000 }, async () => {
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const pipeName = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-r61-${process.pid}-${cycle}-${crypto.randomBytes(6).toString('hex')}`
      : `/tmp/dsh-r61-${process.pid}-${cycle}-${crypto.randomBytes(6).toString('hex')}.sock`;
    const auth = crypto.randomBytes(32).toString('hex');
    const child = spawn(process.execPath, [fixture, pipeName, auth], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    try {
      await waitUntil(() => stdout.includes('"event":"READY"'), 2_000);
      const socket = net.connect(pipeName);
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const responses = responseReader(socket);
      await request(socket, responses, auth, 'READINESS', `ready-${cycle}`);
      await request(socket, responses, auth, 'RUNTIME_TASK_STATUS', `status-${cycle}`);
      const draining = await request(socket, responses, auth, 'SHUTDOWN', `shutdown-${cycle}`);
      assert.deepEqual(draining.result, { status: 'DRAINING' });

      const exit = await waitForExit(child, 2_000);
      assert.deepEqual(exit, { code: 0, signal: null }, `cycle ${cycle + 1}: ${stderr}`);
      assert.match(stdout, /"event":"CLOSED"/);
      assert.equal(socket.destroyed, true);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }
});

function responseReader(socket) {
  let buffered = '';
  const waiting = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const frame = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      waiting.shift()?.(JSON.parse(frame));
    }
  });
  return () => new Promise((resolve) => waiting.push(resolve));
}

async function request(socket, nextResponse, auth, operation, id) {
  const response = nextResponse();
  socket.write(`${JSON.stringify({ id, auth, operation })}\n`);
  return response;
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture readiness timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('natural process exit timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
