export class OpenCodeServerError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'OpenCodeServerError';
    Object.assign(this, extra);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenCodeServerError(`${label} must be a non-empty string`, { code: 'INVALID_OPENCODE_SERVER_INPUT' });
  }
  return value;
}

export class OpenCodeServerClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = requireString(baseUrl, 'baseUrl').replace(/\/$/, '');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.fetch = fetchImpl;
  }

  async request(method, path, { body, signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!response.ok) {
      throw new OpenCodeServerError(`${method} ${path} failed with ${response.status}`, {
        code: 'OPENCODE_SERVER_HTTP_ERROR',
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }

  health(options) { return this.request('GET', '/global/health', options); }
  createSession(body = {}, options) { return this.request('POST', '/session', { ...options, body }); }
  getSession(id, options) { return this.request('GET', `/session/${encodeURIComponent(requireString(id, 'sessionId'))}`, options); }
  sessionStatus(options) { return this.request('GET', '/session/status', options); }
  listMessages(id, options) { return this.request('GET', `/session/${encodeURIComponent(requireString(id, 'sessionId'))}/message`, options); }
  promptAsync(id, body, options) {
    return this.request('POST', `/session/${encodeURIComponent(requireString(id, 'sessionId'))}/prompt_async`, { ...options, body });
  }
  abort(id, options) { return this.request('POST', `/session/${encodeURIComponent(requireString(id, 'sessionId'))}/abort`, options); }

  async subscribeEvents(listener, { signal } = {}) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const response = await this.fetch(`${this.baseUrl}/event`, { headers: { accept: 'text/event-stream' }, signal });
    if (!response.ok || !response.body) {
      throw new OpenCodeServerError(`GET /event failed with ${response.status}`, { code: 'OPENCODE_EVENT_STREAM_ERROR', status: response.status });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const cancelReader = () => { reader.cancel().catch(() => {}); };
    if (signal?.aborted) cancelReader();
    else signal?.addEventListener('abort', cancelReader, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            let event = raw;
            try { event = JSON.parse(raw); } catch {}
            listener(event);
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  }
}
