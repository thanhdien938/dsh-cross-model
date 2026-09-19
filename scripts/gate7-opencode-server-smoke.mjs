#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { resolveOpenCodeBinary } from '../src/session/opencode-cli-session-bridge.mjs';
import { OpenCodeServerClient } from '../src/session/opencode-server-client.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(client, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await client.health();
      if (health?.healthy === true) return health;
    } catch (error) { lastError = error; }
    await sleep(150);
  }
  throw new Error(`OpenCode server health timeout: ${lastError?.message ?? 'unknown'}`);
}

async function waitForBusy(client, sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.sessionStatus();
    const entry = last?.[sessionId];
    if (entry) {
      const text = JSON.stringify(entry).toLowerCase();
      if (text.includes('busy') || text.includes('running') || text.includes('active')) return { all: last, entry };
    }
    await sleep(150);
  }
  throw new Error(`session ${sessionId} never observed active; last status=${JSON.stringify(last)}`);
}

async function waitForIdle(client, sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.sessionStatus();
    const entry = last?.[sessionId];
    if (!entry) return { all: last, entry: null };
    const text = JSON.stringify(entry).toLowerCase();
    if (text.includes('idle')) return { all: last, entry };
    await sleep(150);
  }
  throw new Error(`session ${sessionId} never returned idle; last status=${JSON.stringify(last)}`);
}

const binary = resolveOpenCodeBinary();
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  // Inherited OPENCODE_SERVER_* credentials (e.g. from a desktop server) would
  // force basic auth and 401 every probe. Clear them so the local proof server
  // runs unsecured and the smoke is deterministic regardless of host env.
  env: { ...process.env, OPENCODE_SERVER_USERNAME: '', OPENCODE_SERVER_PASSWORD: '' },
});
let stderr = '';
child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

const clientA = new OpenCodeServerClient({ baseUrl });
const clientB = new OpenCodeServerClient({ baseUrl });
const report = {
  binary,
  baseUrl,
  health: null,
  sessionId: null,
  activeStatus: null,
  idleStatus: null,
  abortResult: null,
  eventsSeen: 0,
  capabilities: {
    interrupt_active_turn: 'UNPROVEN',
    concurrent_client_safe: 'UNPROVEN',
    ui_live_refresh: 'UNPROVEN',
  },
};

const eventAbort = new AbortController();
const events = [];
try {
  report.health = await waitForHealth(clientA);
  const session = await clientA.createSession({ title: 'T7 OpenCode server capability proof' });
  const sessionId = session?.id;
  if (!sessionId) throw new Error(`POST /session returned no id: ${JSON.stringify(session)}`);
  report.sessionId = sessionId;

  const eventTask = clientB.subscribeEvents((event) => events.push(event), { signal: eventAbort.signal }).catch((error) => {
    if (eventAbort.signal.aborted) return;
    throw error;
  });
  await sleep(250);

  const prompt = 'Read-only capability test. Do not modify files. Use a shell/tool to run a harmless ~30 second wait (for example a Node timer), then answer exactly SERVER_LONG_TURN_DONE.';
  await clientA.promptAsync(sessionId, { parts: [{ type: 'text', text: prompt }] });

  const busy = await waitForBusy(clientB, sessionId);
  report.activeStatus = busy.entry;

  const abortResult = await clientB.abort(sessionId);
  report.abortResult = abortResult;
  if (abortResult !== true) throw new Error(`abort did not return true: ${JSON.stringify(abortResult)}`);

  const idle = await waitForIdle(clientA, sessionId);
  report.idleStatus = idle.entry;

  const [sessionFromA, sessionFromB, messagesA, messagesB] = await Promise.all([
    clientA.getSession(sessionId),
    clientB.getSession(sessionId),
    clientA.listMessages(sessionId),
    clientB.listMessages(sessionId),
  ]);
  if (sessionFromA?.id !== sessionId || sessionFromB?.id !== sessionId) throw new Error('clients did not observe same session after abort');
  if (JSON.stringify(messagesA) !== JSON.stringify(messagesB)) throw new Error('clients observed different message state');

  report.eventsSeen = events.length;
  report.capabilities.interrupt_active_turn = 'PROVED';
  report.capabilities.concurrent_client_safe = 'PROVED';

  console.log(JSON.stringify(report, null, 2));
  console.log('T7-OPENCODE-SERVER: PASS');
  eventAbort.abort();
  await eventTask;
} catch (error) {
  eventAbort.abort();
  report.error = error?.stack ?? String(error);
  report.serverStderr = stderr.slice(-2000);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(1500),
  ]);
}
