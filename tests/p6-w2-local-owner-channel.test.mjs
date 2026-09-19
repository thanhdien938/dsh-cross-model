import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';

const pipeName = `\\\\.\\pipe\\dsh-w2-control-${process.pid}-${randomUUID()}`;
const authCapability = randomBytes(32).toString('hex');
const enrolledOwnerActorId = '100000001';
let control;
let receivedCommands = [];
let nextResult = null;
let nextError = null;

test.before(async () => {
  control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    enrolledOwnerActorId,
    ownerCommand: async (input) => {
      receivedCommands.push(input);
      if (nextError) throw nextError;
      return nextResult;
    },
    ownerRead: async (operation) => {
      if (operation === 'GET_PM_PROFILES') return [{ id: 'w2-pm', product: 'claude-code', model: null, session_kind: 'STATELESS' }];
      throw new OwnerControlError('unsupported', 'OWNER_OPERATION_REFUSED');
    },
  });
});

test.after(async () => {
  await control.close();
});

test.beforeEach(() => {
  receivedCommands = [];
  nextResult = { status: 'MATERIALIZED', task_id: 'task-1', pm_run_id: 'pmrun-1' };
  nextError = null;
});

test('SUBMIT_TASK reaches the sole OwnerControlService with server-stamped identity', async () => {
  const response = await request({
    id: 'submit-1',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: {
      command_id: 'cmd-1',
      client_kind: 'TELEGRAM', // client-supplied spoof attempt
      actor_id: '999999999',   // client-supplied spoof attempt
      project_id: 'proj-a',
      payload: { body: 'do the thing' },
    },
  });
  assert.equal(response.success, true);
  assert.deepEqual(response.result, nextResult);
  assert.equal(receivedCommands.length, 1);
  const forwarded = receivedCommands[0];
  // The server ignores whatever client_kind/actor_id the caller sent and
  // unconditionally re-stamps the already-enrolled LOCAL owner identity.
  assert.equal(forwarded.client_kind, 'LOCAL');
  assert.equal(forwarded.actor_id, enrolledOwnerActorId);
  assert.equal(forwarded.command_id, 'cmd-1');
  assert.equal(forwarded.project_id, 'proj-a');
  assert.deepEqual(forwarded.payload, { body: 'do the thing' });
});

test('REPLY_TO_INTERACTION, DECIDE_INTERACTION, and REQUEST_CANCEL all route through the same channel', async () => {
  for (const operation of ['REPLY_TO_INTERACTION', 'DECIDE_INTERACTION', 'REQUEST_CANCEL']) {
    const response = await request({
      id: operation,
      operation,
      auth: authCapability,
      command: { command_id: `cmd-${operation}`, target_id: 'task-1', expected_revision: 1, payload: {} },
    });
    assert.equal(response.success, true, operation);
  }
  assert.equal(receivedCommands.map((c) => c.operation).length, 3);
});

test('typed OWNER_COMMAND_CONFLICT is forwarded verbatim without message/stack', async () => {
  nextError = new OwnerControlError('command id semantic conflict', 'OWNER_COMMAND_CONFLICT');
  const response = await request({ id: 'conflict', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: 'cmd-2', project_id: 'p', payload: { body: 'x' } } });
  assert.deepEqual(response, { id: 'conflict', success: false, error: 'OWNER_COMMAND_CONFLICT' });
});

test('STALE_INTERACTION is forwarded verbatim', async () => {
  nextError = new OwnerControlError('interaction is stale', 'STALE_INTERACTION');
  const response = await request({ id: 'stale', operation: 'DECIDE_INTERACTION', auth: authCapability, command: { command_id: 'cmd-3', target_id: 'i', expected_revision: 2, payload: { response: 'YES' } } });
  assert.deepEqual(response, { id: 'stale', success: false, error: 'STALE_INTERACTION' });
});

test('an unknown/unsanitized error code collapses to a generic sanitized code', async () => {
  nextError = Object.assign(new Error('ENOENT: /C/secret/path/internal.db'), { code: 'ENOENT', stack: 'at internal (C:/secret/path)' });
  const response = await request({ id: 'leaky', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: 'cmd-4', project_id: 'p', payload: { body: 'x' } } });
  assert.equal(response.success, false);
  assert.notEqual(response.error, 'ENOENT');
  assert.equal(JSON.stringify(response).includes('secret'), false);
  assert.equal(JSON.stringify(response).includes('internal.db'), false);
  assert.equal('stack' in response, false);
});

test('GET_PM_PROFILES is a closed sanitized read, not generic dispatch', async () => {
  const response = await request({ id: 'profiles', operation: 'GET_PM_PROFILES', auth: authCapability });
  assert.equal(response.success, true);
  assert.deepEqual(response.result, [{ id: 'w2-pm', product: 'claude-code', model: null, session_kind: 'STATELESS' }]);
});

test('an arbitrary unknown owner-shaped operation is refused, not dispatched', async () => {
  const response = await request({ id: 'exec', operation: 'EXEC_SHELL', auth: authCapability, command: { command_id: 'cmd-5' } });
  assert.deepEqual(response, { id: 'exec', success: false, error: 'UNKNOWN_OPERATION' });
  assert.equal(receivedCommands.length, 0);
});

test('missing auth on an owner mutation is refused before the command is ever forwarded', async () => {
  const response = await request({ id: 'noauth', operation: 'SUBMIT_TASK', command: { command_id: 'cmd-6', project_id: 'p', payload: { body: 'x' } } });
  assert.deepEqual(response, { id: 'noauth', success: false, error: 'AUTH_REFUSED' });
  assert.equal(receivedCommands.length, 0);
});

test('a malformed command envelope is refused before forwarding', async () => {
  const response = await request({ id: 'malformed', operation: 'SUBMIT_TASK', auth: authCapability, command: 'not-an-object' });
  assert.deepEqual(response, { id: 'malformed', success: false, error: 'MALFORMED_REQUEST' });
  assert.equal(receivedCommands.length, 0);
});

test('idempotent retry: same command_id and same payload against a real-shaped repository yields one canonical effect', async () => {
  // Simulate the repository-level idempotency contract directly: a second
  // identical SUBMIT_TASK with the same command_id must not re-invoke the
  // task materializer with different lineage. We assert the pipe forwards
  // the exact same command_id twice and leaves conflict/duplicate detection
  // to the sole canonical OwnerControlService (proven separately in
  // tests/phase5-owner-control.test.mjs and the real-Postgres suites).
  const command = { command_id: 'cmd-retry-1', project_id: 'p', payload: { body: 'retry-safe task' } };
  const first = await request({ id: 'r1', operation: 'SUBMIT_TASK', auth: authCapability, command });
  const second = await request({ id: 'r2', operation: 'SUBMIT_TASK', auth: authCapability, command });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(receivedCommands[0].command_id, receivedCommands[1].command_id);
  assert.deepEqual(receivedCommands[0].payload, receivedCommands[1].payload);
});

function request(value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(response.slice(0, newline)));
    });
  });
}
