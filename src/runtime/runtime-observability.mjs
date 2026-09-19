const SENSITIVE = /(prompt|task.?body|result|dsn|password|secret|token|credential|authorization|connection.?string|api.?key|session)/i;
const SENSITIVE_VALUE = /(bearer\s+\S+|(?:token|password|credential|secret|api.?key)\s*[=:]\s*\S+|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@)/i;
export const KNOWN_TELEMETRY_COUNTERS = Object.freeze(['blocked', 'coordinator_authority_failures', 'heartbeat_failures', 'work_completed', 'worker_polls']);
export const KNOWN_TELEMETRY_EVENT_TYPES = Object.freeze(['coordinator.lifecycle', 'runtime.health', 'worker.lifecycle']);
const COUNTER_NAMES = new Set(KNOWN_TELEMETRY_COUNTERS); const EVENT_TYPES = new Set(KNOWN_TELEMETRY_EVENT_TYPES);

export class RuntimeObservability {
  constructor({ eventLimit = 256, sink } = {}) { this.eventLimit = Number.isInteger(eventLimit) ? Math.min(Math.max(eventLimit, 1), 4_096) : 256; this.sink = sink; this.events = []; this.counters = new Map(); }
  count(name, amount = 1) { try { const safe = knownIdentifier(name, COUNTER_NAMES); if (!Number.isFinite(amount)) return; this.counters.set(safe, (this.counters.get(safe) ?? 0) + amount); } catch {} }
  emit(type, data = {}) {
    try {
      const event = Object.freeze({ type: knownIdentifier(type, EVENT_TYPES), at: new Date().toISOString(), data: sanitize(data) });
      this.events.push(event); if (this.events.length > this.eventLimit) this.events.shift();
      try { const pending = this.sink?.(event); if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {}); } catch {}
    } catch {}
  }
  snapshot({ alive = true, authorityReady = false } = {}) {
    return Object.freeze({ liveness: Boolean(alive), readiness: Boolean(alive && authorityReady), counters: Object.freeze(Object.fromEntries(this.counters)), events: Object.freeze([...this.events]) });
  }
}

function sanitize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)).slice(0, 32).map(([key, item]) => [key, scalar(item)])));
}
function scalar(value) { return ['string', 'number', 'boolean'].includes(typeof value) ? (typeof value === 'string' ? redactString(value, 256) : value) : null; }
function knownIdentifier(value, allowed) { const raw = String(value); return allowed.has(raw) ? raw : 'redacted'; }
function redactString(value, limit) { return SENSITIVE_VALUE.test(value) ? '[REDACTED]' : value.slice(0, limit); }
