// P11-R4.2 Part E — the RELOAD_PM_PROFILES control-pipe operation Desktop
// triggers right after a successful pmProfiles:create() write. Same
// request/response harness tests/p6-w1-local-runtime-control.test.mjs
// already uses.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';

const pipeName = `\\\\.\\pipe\\dsh-r42-reload-${process.pid}-${randomUUID()}`;
const authCapability = randomBytes(32).toString('hex');
let control;
let reloadCalls = 0;
let nextResult = { admitted: [], rejected: [], aliasesAssigned: {} };
let shouldThrow = false;

test.before(async () => {
  control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    reloadPmProfiles: async () => {
      reloadCalls += 1;
      if (shouldThrow) throw new Error('boom — must never leak this message across the pipe');
      return nextResult;
    },
  });
});

test.after(async () => {
  await control.close();
});

test('valid auth invokes reloadPmProfiles and returns its bounded result verbatim', async () => {
  nextResult = { admitted: ['pm2'], rejected: [], aliasesAssigned: { pm2: '2' } };
  const response = await operation('r1', 'RELOAD_PM_PROFILES', authCapability);
  assert.deepEqual(response, { id: 'r1', success: true, result: nextResult });
  assert.equal(reloadCalls, 1);
});

test('a reloadPmProfiles rejection collapses to one typed code, never the raw error message', async () => {
  shouldThrow = true;
  const response = await operation('r2', 'RELOAD_PM_PROFILES', authCapability);
  assert.deepEqual(response, { id: 'r2', success: false, error: 'PM_PROFILE_RELOAD_FAILED' });
  assert.doesNotMatch(JSON.stringify(response), /boom/);
  shouldThrow = false;
});

test('missing/wrong auth is refused before reloadPmProfiles is ever called', async () => {
  const before = reloadCalls;
  const response = await operation('r3', 'RELOAD_PM_PROFILES', 'not-a-real-capability');
  assert.equal(response.success, false);
  assert.equal(response.error, 'AUTH_REFUSED');
  assert.equal(reloadCalls, before);
});

test('a control instance with no reloadPmProfiles wired refuses the operation as UNKNOWN_OPERATION, never a crash', async () => {
  const barePipeName = `\\\\.\\pipe\\dsh-r42-bare-${process.pid}-${randomUUID()}`;
  const bareControl = await startLocalRuntimeControl({
    pipeName: barePipeName,
    authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    // reloadPmProfiles deliberately omitted — mirrors every pre-R4.2
    // control-pipe consumer/test (e.g. p6-w1-local-runtime-control.test.mjs),
    // which must keep working byte-for-byte unchanged.
  });
  const response = await request(barePipeName, `${JSON.stringify({ id: 'r4', operation: 'RELOAD_PM_PROFILES', auth: authCapability })}\n`);
  assert.deepEqual(response, { id: 'r4', success: false, error: 'UNKNOWN_OPERATION' });
  await bareControl.close();
});

function operation(id, operationName, auth) {
  const value = { id, operation: operationName };
  if (auth !== undefined) value.auth = auth;
  return request(pipeName, `${JSON.stringify(value)}\n`);
}

function request(targetPipe, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(targetPipe);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) {
        socket.end();
        resolve(JSON.parse(response));
      }
    });
  });
}
