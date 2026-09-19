import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startLocalRuntimeControl, MAX_CONTROL_FRAME_BYTES } from '../src/runtime/local-runtime-control.mjs';

const pipeName = `\\\\.\\pipe\\dsh-w1-control-${process.pid}-${randomUUID()}`;
const authCapability = randomBytes(32).toString('hex');
let control;
let shutdownRequested = false;

test.before(async () => {
  control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => ({ ready: true, postgres: { schema: 4 }, sqlite: { schema: 6 } }),
    runtimeTaskStatus: () => ({ global_limit: 2, active_count: 0, active: [], rejected: [] }),
    onShutdown: () => { shutdownRequested = true; },
  });
});

test.after(async () => {
  await control.close();
});

test('valid auth accepts PING', async () => {
  const response = await operation('ping', 'PING', authCapability);
  assert.deepEqual(response, { id: 'ping', success: true, result: 'PONG' });
});

test('valid auth accepts READINESS with canonical schema truth', async () => {
  const response = await operation('ready', 'READINESS', authCapability);
  assert.equal(response.success, true);
  assert.equal(response.result.ready, true);
  assert.equal(response.result.postgres.schema, 4);
  assert.equal(response.result.sqlite.schema, 6);
});

test('persistent client can issue READINESS then RUNTIME_TASK_STATUS back-to-back without write-after-end', async () => {
  const responses = await persistentOperations([
    { id: 'ready-persistent', operation: 'READINESS', auth: authCapability },
    { id: 'status-persistent', operation: 'RUNTIME_TASK_STATUS', auth: authCapability },
  ]);
  assert.equal(responses[0].result.ready, true);
  assert.deepEqual(responses[1].result, { global_limit: 2, active_count: 0, active: [], rejected: [] });
});

test('missing, wrong, and malformed auth are refused uniformly', async () => {
  for (const [id, auth] of [
    ['missing', undefined],
    ['wrong', '22'.repeat(32)],
    ['malformed', { token: authCapability }],
  ]) {
    const response = await operation(id, 'PING', auth);
    assert.deepEqual(response, { id, success: false, error: 'AUTH_REFUSED' });
  }
});

test('wrong auth cannot issue SHUTDOWN', async () => {
  const response = await operation('wrong-shutdown', 'SHUTDOWN', '33'.repeat(32));
  assert.equal(response.success, false);
  assert.equal(response.error, 'AUTH_REFUSED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownRequested, false);

  const ping = await operation('still-running', 'PING', authCapability);
  assert.equal(ping.success, true);
});

test('malformed JSON is refused', async () => {
  const response = await request('{not-json}\n');
  assert.equal(response.success, false);
  assert.equal(response.error, 'MALFORMED_REQUEST');
});

test('unknown operation with valid auth is refused', async () => {
  const response = await operation('unknown', 'EXEC', authCapability);
  assert.deepEqual(response, { id: 'unknown', success: false, error: 'UNKNOWN_OPERATION' });
});

test('fragmented oversized frame is refused before parsing', async () => {
  const response = await request(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1, 0x78), 16 * 1024);
  assert.equal(response.success, false);
  assert.equal(response.error, 'FRAME_TOO_LARGE');
});

test('valid auth acknowledges in-band SHUTDOWN', async () => {
  const response = await operation('shutdown', 'SHUTDOWN', authCapability);
  assert.equal(response.success, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownRequested, true);
});

function operation(id, operationName, auth) {
  const value = { id, operation: operationName };
  if (auth !== undefined) value.auth = auth;
  return request(`${JSON.stringify(value)}\n`);
}

function request(payload, fragmentSize = null) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => {
      if (!fragmentSize) return void socket.write(payload);
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      for (let offset = 0; offset < bytes.length; offset += fragmentSize) {
        socket.write(bytes.subarray(offset, offset + fragmentSize));
      }
    });
    socket.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(response.slice(0, newline)));
    });
  });
}

function persistentOperations(frames) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName); let response = ''; const parsed = [];
    socket.setEncoding('utf8'); socket.once('error', reject);
    socket.once('connect', () => { for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`); });
    socket.on('data', (chunk) => {
      response += chunk; let newline;
      while ((newline = response.indexOf('\n')) !== -1) { parsed.push(JSON.parse(response.slice(0, newline))); response = response.slice(newline + 1); }
      if (parsed.length === frames.length) { socket.end(); resolve(parsed); }
    });
  });
}
