import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {buildProviderChildEnv,providerExecutablePolicy,resolveProviderExecutable,resolveProviderExecutableSync} from './provider-child-policy.mjs';

export class GrokAcpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GrokAcpError';
    this.code = extra.code ?? 'GROK_ACP_ERROR';
    Object.assign(this, extra);
  }
}

export const GROK_BINARY_CANDIDATES = Object.freeze([
  join(homedir(), '.grok', 'bin', 'grok'),
  join(homedir(), 'AppData', 'Roaming', 'npm', 'grok.cmd'),
]);

export function resolveGrokExecutable() { return resolveProviderExecutableSync(providerExecutablePolicy({provider:'grok',executableName:'grok',knownCandidates:GROK_BINARY_CANDIDATES})); }
export function resolveGrokBinary() { return resolveGrokExecutable().path ?? ''; }

// P6.5 Part C/E: async, non-blocking counterpart — see binary-resolution-async.mjs's docstring.
export async function resolveGrokBinaryAsync() {
  return (await resolveProviderExecutable(providerExecutablePolicy({provider:'grok',executableName:'grok',knownCandidates:GROK_BINARY_CANDIDATES}))).path ?? '';
}

export class GrokAcpClient extends EventEmitter {
  #binary;
  #args;
  #cwd;
  #timeoutMs;
  #proc = null;
  #rl = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = '';
  #initialized = null;

  constructor({
    binary = resolveGrokBinary(),
    args = ['agent', '--always-approve', 'stdio'],
    cwd = process.cwd(),
    timeoutMs = 120_000,
  } = {}) {
    super();
    this.#binary = binary;
    this.#args = [...args];
    this.#cwd = cwd;
    this.#timeoutMs = timeoutMs;
  }

  get binary() { return this.#binary; }
  get initialized() { return this.#initialized; }
  get stderr() { return this.#stderr; }

  async start() {
    if (this.#proc) return this.#initialized;
    const proc = spawn(this.#binary, this.#args, {
      cwd: this.#cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildProviderChildEnv({provider:'grok'}),
    });
    this.#proc = proc;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { this.#stderr += chunk; });
    proc.once('error', (error) => this.#failAll(new GrokAcpError(`failed to spawn Grok ACP: ${error.message}`, { code: 'SPAWN_FAILED', cause: error })));
    proc.once('exit', (code, signal) => {
      if (this.#pending.size > 0) {
        this.#failAll(new GrokAcpError(`Grok ACP exited with code=${code} signal=${signal}`, {
          code: 'PROCESS_EXITED', exitCode: code, signal, stderr: this.#stderr.trim(),
        }));
      }
      this.emit('exit', { code, signal });
    });

    this.#rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.#rl.on('line', (line) => this.#handleLine(line));

    this.#initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-cross-model-debate-poc', version: '0.1.0' },
    });
    return this.#initialized;
  }

  request(method, params = {}, { timeoutMs = this.#timeoutMs } = {}) {
    if (!this.#proc?.stdin?.writable) {
      return Promise.reject(new GrokAcpError('Grok ACP process is not running', { code: 'NOT_RUNNING', method }));
    }
    const id = this.#nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new GrokAcpError(`ACP request timed out: ${method}`, { code: 'REQUEST_TIMEOUT', method, id }));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new GrokAcpError(`failed writing ACP request ${method}: ${error.message}`, { code: 'WRITE_FAILED', method, cause: error }));
      });
    });
  }

  notify(method, params = {}) {
    if (!this.#proc?.stdin?.writable) throw new GrokAcpError('Grok ACP process is not running', { code: 'NOT_RUNNING', method });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.emit('nonjson', trimmed);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit('orphan-response', message);
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new GrokAcpError(`${pending.method} failed: ${message.error.message ?? 'ACP error'}`, {
          code: 'ACP_REQUEST_FAILED', method: pending.method, rpcError: message.error,
        }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      // Read-only proof runs should not need reverse requests because Grok is
      // launched with --always-approve. Reject unknown extension/client methods
      // explicitly rather than leaving the agent blocked forever.
      this.#proc.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: `client method not implemented: ${message.method}` },
      })}\n`);
      this.emit('request', message);
      return;
    }
    if (message.method) {
      this.emit('notification', message);
      return;
    }
    this.emit('message', message);
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async stop({ graceMs = 500 } = {}) {
    const proc = this.#proc;
    this.#proc = null;
    if (!proc) return;
    this.#rl?.close();
    this.#rl = null;
    if (proc.exitCode !== null) return;
    proc.kill();
    await Promise.race([
      new Promise((resolve) => proc.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
}
