#!/usr/bin/env node
// P13-R8 benchmark harness. NOT part of the product -- a throwaway CLI used
// only to drive the R8 concurrency benchmark against a dedicated,
// gitignored .runtime/p13-benchmark/ instance. Talks to the real,
// unmodified local-runtime-control pipe protocol (PING/READINESS/
// RUNTIME_TASK_STATUS/SUBMIT_TASK/SHUTDOWN) -- no scheduler code touched.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BENCH_ROOT = resolve(REPO_ROOT, '.runtime/p13-benchmark');
const STATE_PATH = resolve(BENCH_ROOT, 'harness-state.json');
const CONFIG_PATH = resolve(BENCH_ROOT, 'production.yaml');
const PIPE_NAME = '\\\\.\\pipe\\dsh-p13-r8-bench';

function loadEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}
function writeState(state) {
  mkdirSync(BENCH_ROOT, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sendRequest(pipeName, capability, operation, command) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(pipeName);
    const id = randomUUID();
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TIMEOUT')); }, 15000);
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, operation, auth: capability, command }) + '\n');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const response = JSON.parse(buf.slice(0, nl));
        socket.end();
        resolvePromise(response);
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function cmdStart() {
  if (readState()) throw new Error('harness-state.json already exists -- stop first, or rm it if stale');
  const env = { ...process.env, ...loadEnvFile(resolve(REPO_ROOT, '.env')) };
  const capability = randomBytes(32).toString('hex');
  env.DSH_RUNTIME_CONTROL_AUTH = capability;
  const child = spawn(process.execPath, [resolve(REPO_ROOT, 'scripts/p5-runtime.mjs'), 'all', '--config', CONFIG_PATH, '--control-pipe', PIPE_NAME], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.unref();
  writeState({ pipeName: PIPE_NAME, capability, pid: child.pid, startedAt: new Date().toISOString() });
  // Poll readiness for up to 20s.
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await sendRequest(PIPE_NAME, capability, 'PING');
      if (resp.success) {
        console.log(JSON.stringify({ event: 'started', pid: child.pid, pipeName: PIPE_NAME }));
        return;
      }
    } catch (err) { lastError = err; }
  }
  throw new Error('runtime did not become ready in time: ' + String(lastError));
}

async function cmdStop() {
  const state = readState();
  if (!state) { console.log(JSON.stringify({ event: 'not_running' })); return; }
  try {
    const resp = await sendRequest(state.pipeName, state.capability, 'SHUTDOWN');
    console.log(JSON.stringify({ event: 'shutdown_requested', resp }));
  } catch (err) {
    console.log(JSON.stringify({ event: 'shutdown_request_failed', error: String(err) }));
  }
  writeFileSync(STATE_PATH + '.stopped-' + Date.now(), JSON.stringify(state, null, 2));
  try { const fs = await import('node:fs'); fs.unlinkSync(STATE_PATH); } catch {}
}

async function cmdPing() {
  const state = readState();
  if (!state) throw new Error('not started');
  console.log(JSON.stringify(await sendRequest(state.pipeName, state.capability, 'PING')));
}

async function cmdStatus() {
  const state = readState();
  if (!state) throw new Error('not started');
  console.log(JSON.stringify(await sendRequest(state.pipeName, state.capability, 'RUNTIME_TASK_STATUS'), null, 2));
}

async function cmdReadiness() {
  const state = readState();
  if (!state) throw new Error('not started');
  console.log(JSON.stringify(await sendRequest(state.pipeName, state.capability, 'READINESS'), null, 2));
}

async function cmdSubmit(args) {
  const state = readState();
  if (!state) throw new Error('not started');
  const projectId = args[0];
  const pmProfileId = args[1];
  const bodyFile = args[2];
  const label = args[3] ?? randomUUID();
  const body = readFileSync(bodyFile, 'utf8');
  const commandId = 'p13r8-' + label + '-' + Date.now();
  const submittedAt = new Date().toISOString();
  const resp = await sendRequest(state.pipeName, state.capability, 'SUBMIT_TASK', {
    command_id: commandId,
    project_id: projectId,
    payload: { body, pm_profile_id: pmProfileId, durability: 'DIRECT' },
  });
  console.log(JSON.stringify({ event: 'submitted', label, projectId, pmProfileId, commandId, submittedAt, resp }));
}

const [, , cmd, ...args] = process.argv;
try {
  if (cmd === 'start') await cmdStart();
  else if (cmd === 'stop') await cmdStop();
  else if (cmd === 'ping') await cmdPing();
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'readiness') await cmdReadiness();
  else if (cmd === 'submit') await cmdSubmit(args);
  else { console.error('usage: p13-r8-bench.mjs <start|stop|ping|status|readiness|submit>'); process.exitCode = 2; }
} catch (err) {
  console.error(JSON.stringify({ event: 'error', message: String(err?.message ?? err) }));
  process.exitCode = 1;
}
