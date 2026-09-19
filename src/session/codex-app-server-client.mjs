import { spawn } from 'node:child_process';
import { buildProviderChildEnv } from './provider-child-policy.mjs';
import { resolveCodexCliExecutable } from './codex-cli-session-bridge.mjs';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class CodexAppServerError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = extra.code ?? 'CODEX_APP_SERVER_ERROR';
    Object.assign(this, extra);
  }
}

export class CodexAppServerClient extends EventEmitter {
  #command;
  #args;
  #cwd;
  #env;
  #timeoutMs;
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = [];
  #initialized = false;

  constructor({ command = resolveCodexCliExecutable().path ?? '', args = ['app-server', '--listen', 'stdio://'], cwd = process.cwd(), env = process.env, timeoutMs = 30_000 } = {}) {
    super();
    this.#command = command;
    this.#args = [...args];
    this.#cwd = cwd;
    this.#env = env;
    this.#timeoutMs = timeoutMs;
  }

  get running() {
    return !!this.#child && this.#child.exitCode === null;
  }

  get stderrText() {
    return this.#stderr.join('');
  }

  async start({ clientInfo = { name: 'dsh-session-proof', version: '0.1.0' }, capabilities = {} } = {}) {
    if (this.running) return this;
    if (!this.#command) throw new CodexAppServerError('codex executable is unavailable or untrusted', { code: 'PROVIDER_EXECUTABLE_UNTRUSTED' });
    this.#child = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildProviderChildEnv({ provider: 'codex', sourceEnv: this.#env }),
    });

    const stdout = readline.createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.#onLine(line));
    this.#child.stderr.on('data', (chunk) => this.#stderr.push(String(chunk)));
    this.#child.on('error', (error) => this.#failAll(new CodexAppServerError(`codex app-server spawn failed: ${error.message}`, { code: 'SPAWN_FAILED', cause: error })));
    this.#child.on('exit', (code, signal) => {
      if (this.#pending.size > 0) {
        this.#failAll(new CodexAppServerError(`codex app-server exited while requests were pending (code=${code}, signal=${signal})`, {
          code: 'PROCESS_EXITED', exitCode: code, signal, stderr: this.stderrText,
        }));
      }
      this.emit('exit', { code, signal });
    });

    await this.request('initialize', { clientInfo, capabilities });
    this.notify('initialized', {});
    this.#initialized = true;
    return this;
  }

  async stop() {
    const child = this.#child;
    this.#child = null;
    this.#initialized = false;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request(method, params = {}, { timeoutMs = this.#timeoutMs } = {}) {
    if (!this.running) {
      return Promise.reject(new CodexAppServerError('codex app-server is not running', { code: 'NOT_RUNNING' }));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexAppServerError(`request timed out: ${method}`, { code: 'REQUEST_TIMEOUT', method, id }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#write(message);
    });
  }

  notify(method, params = {}) {
    if (!this.running) throw new CodexAppServerError('codex app-server is not running', { code: 'NOT_RUNNING' });
    this.#write({ method, params });
  }

  waitFor(predicate, { timeoutMs = this.#timeoutMs, label = 'notification' } = {}) {
    return new Promise((resolve, reject) => {
      const onNotification = (message) => {
        let matched = false;
        try { matched = !!predicate(message); } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (matched) {
          cleanup();
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CodexAppServerError(`timed out waiting for ${label}`, { code: 'EVENT_TIMEOUT', label }));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('notification', onNotification);
      };
      this.on('notification', onNotification);
    });
  }

  #write(message) {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new CodexAppServerError(`failed writing JSONL request: ${error.message}`, { code: 'WRITE_FAILED', cause: error });
    }
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolError', new CodexAppServerError('non-JSON stdout from app-server', { code: 'INVALID_JSON', line }));
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit('notification', message);
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerError(`app-server ${pending.method} failed: ${message.error.message ?? 'unknown error'}`, {
          code: 'RPC_ERROR', method: pending.method, rpcError: message.error,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.emit('notification', message);
    if (message.method) this.emit(message.method, message.params ?? {});
  }

  #failAll(error) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}
