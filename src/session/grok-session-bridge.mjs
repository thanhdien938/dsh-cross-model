import { GrokAcpClient, GrokAcpError } from './grok-acp-client.mjs';

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new GrokAcpError(`${label} must be a non-empty string`, { code: 'INVALID_GROK_SESSION_INPUT' });
  return value;
}

export class GrokSessionBridge {
  #client;
  #cwd;

  constructor({ client, cwd = process.cwd() } = {}) {
    if (!client || typeof client.request !== 'function' || typeof client.on !== 'function') {
      throw new TypeError('GrokSessionBridge requires a Grok ACP client');
    }
    this.#client = client;
    this.#cwd = cwd;
  }

  static async launch(options = {}) {
    const client = new GrokAcpClient(options);
    await client.start();
    return new GrokSessionBridge({ client, cwd: options.cwd ?? process.cwd() });
  }

  get client() { return this.#client; }

  async createSession({ cwd = this.#cwd, mcpServers = [], meta = { yoloMode: true } } = {}) {
    const result = await this.#client.request('session/new', { cwd, mcpServers, _meta: meta });
    if (!result?.sessionId) throw new GrokAcpError('session/new returned no sessionId', { code: 'MISSING_SESSION_ID', result });
    return result;
  }

  async resume(sessionId, { cwd = this.#cwd, mcpServers = [], meta = { yoloMode: true } } = {}) {
    return this.#client.request('session/load', {
      sessionId: requireString(sessionId, 'sessionId'),
      cwd,
      mcpServers,
      _meta: meta,
    });
  }

  async sendNextTurn(sessionId, message, { timeoutMs, collectUpdates = true } = {}) {
    const id = requireString(sessionId, 'sessionId');
    requireString(message, 'message');
    const updates = [];
    const chunks = [];
    const onNotification = (notification) => {
      if (notification.method !== 'session/update' || notification.params?.sessionId !== id) return;
      const update = notification.params?.update ?? {};
      if (collectUpdates) updates.push(notification);
      if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') chunks.push(update.content.text);
    };
    this.#client.on('notification', onNotification);
    try {
      const result = await this.#client.request('session/prompt', {
        sessionId: id,
        prompt: [{ type: 'text', text: message }],
      }, timeoutMs === undefined ? {} : { timeoutMs });
      return {
        sessionId: id,
        result,
        text: chunks.join(''),
        updates,
      };
    } finally {
      this.#client.off('notification', onNotification);
    }
  }

  interrupt(sessionId) {
    this.#client.notify('session/cancel', { sessionId: requireString(sessionId, 'sessionId') });
    return { sent: true, sessionId };
  }

  subscribeEvents(sessionId, listener) {
    const id = requireString(sessionId, 'sessionId');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (notification) => {
      if (notification.params?.sessionId === id) listener(notification);
    };
    this.#client.on('notification', wrapped);
    return () => this.#client.off('notification', wrapped);
  }

  async dispose() {
    await this.#client.stop?.();
  }
}

export const GROK_DOCUMENTED_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: true,
  send_next_turn: true,
  interrupt_active_turn: true,
  stream_events: true,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});

export const GROK_UNPROVEN_SESSION_CAPABILITIES = Object.freeze({
  resume_existing: false,
  send_next_turn: false,
  interrupt_active_turn: false,
  stream_events: false,
  concurrent_client_safe: false,
  ui_live_refresh: false,
});
