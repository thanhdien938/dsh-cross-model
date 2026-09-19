import { CodexAppServerClient, CodexAppServerError } from './codex-app-server-client.mjs';

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export class CodexSessionBridge {
  #client;
  #turnByThread = new Map();
  #terminalTurns = new Map();
  #listeners = new Map();
  #onNotification;

  constructor({ client } = {}) {
    if (!client || typeof client.request !== 'function' || typeof client.on !== 'function') {
      throw new TypeError('CodexSessionBridge requires an app-server client');
    }
    this.#client = client;
    this.#onNotification = (message) => {
      const params = message?.params ?? {};
      const threadId = params.threadId ?? params.thread?.id ?? null;
      const turnId = params.turnId ?? params.turn?.id ?? null;
      if (threadId && turnId && (message.method === 'turn/started' || message.method === 'turn/completed')) {
        if (message.method === 'turn/completed') {
          this.#turnByThread.delete(threadId);
          this.#terminalTurns.set(`${threadId}:${turnId}`, message);
        } else {
          this.#turnByThread.set(threadId, turnId);
        }
      }
      if (threadId) {
        for (const listener of this.#listeners.get(threadId) ?? []) listener(message);
      }
    };
    this.#client.on('notification', this.#onNotification);
  }

  static async launch(options = {}) {
    const client = new CodexAppServerClient(options);
    await client.start();
    return new CodexSessionBridge({ client });
  }

  get client() {
    return this.#client;
  }

  async createThread(options = {}) {
    const result = await this.#client.request('thread/start', { ...options, ephemeral: options.ephemeral ?? false });
    const threadId = result?.thread?.id;
    if (!threadId) throw new CodexAppServerError('thread/start returned no thread id', { code: 'MISSING_THREAD_ID', result });
    return result;
  }

  async resume(sessionId, options = {}) {
    const threadId = requireString(sessionId, 'sessionId');
    return this.#client.request('thread/resume', { threadId, ...options });
  }

  async sendNextTurn(sessionId, message, options = {}) {
    const threadId = requireString(sessionId, 'sessionId');
    requireString(message, 'message');
    const params = {
      threadId,
      input: [{ type: 'text', text: message }],
      ...options,
    };
    const result = await this.#client.request('turn/start', params);
    if (result?.turn?.id) this.#turnByThread.set(threadId, result.turn.id);
    return result;
  }

  async interrupt(sessionId, options = {}) {
    const threadId = requireString(sessionId, 'sessionId');
    const turnId = options.turnId ?? this.#turnByThread.get(threadId);
    requireString(turnId, 'turnId');
    return this.#client.request('turn/interrupt', { threadId, turnId });
  }

  subscribeEvents(sessionId, listener) {
    const threadId = requireString(sessionId, 'sessionId');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const listeners = this.#listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(threadId, listeners);
    return () => {
      const current = this.#listeners.get(threadId);
      current?.delete(listener);
      if (current?.size === 0) this.#listeners.delete(threadId);
    };
  }

  waitForTurnTerminal(threadId, turnId, { timeoutMs = 120_000 } = {}) {
    requireString(threadId, 'threadId');
    requireString(turnId, 'turnId');
    const key = `${threadId}:${turnId}`;
    const alreadyTerminal = this.#terminalTurns.get(key);
    if (alreadyTerminal) return Promise.resolve(alreadyTerminal);
    return this.#client.waitFor(
      (message) => message.method === 'turn/completed' &&
        message.params?.threadId === threadId &&
        (message.params?.turn?.id === turnId || message.params?.turnId === turnId),
      { timeoutMs, label: `turn/completed ${turnId}` },
    );
  }

  async dispose() {
    this.#client.off('notification', this.#onNotification);
    this.#listeners.clear();
    this.#terminalTurns.clear();
    await this.#client.stop?.();
  }
}

export const CODEX_SANDBOX_MODES = Object.freeze({
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  DANGER_FULL_ACCESS: 'danger-full-access',
});

export const CODEX_DOCUMENTED_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: true,
  send_next_turn: true,
  interrupt_active_turn: true,
  stream_events: true,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});

export const CODEX_UNPROVEN_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: false,
  send_next_turn: false,
  interrupt_active_turn: false,
  stream_events: false,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});
