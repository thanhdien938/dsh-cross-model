import { randomUUID } from 'node:crypto';
import { sanitizeAuditData } from './audit-sanitize.mjs';

export class DurableAuditTraceError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DurableAuditTraceError';
    Object.assign(this, extra);
  }
}

export class DurableOrchestrationAuditTrace {
  #id;
  #repository;
  #clock;

  constructor({ repository, traceId, clock = () => new Date().toISOString(), mode = 'create' } = {}) {
    if (!repository || typeof repository.createTrace !== 'function' || typeof repository.loadTrace !== 'function' || typeof repository.append !== 'function' || typeof repository.seal !== 'function') {
      throw new TypeError('durable audit trace requires an AuditRepository-like contract');
    }
    if (typeof clock !== 'function') throw new TypeError('audit trace clock must be a function');
    if (mode !== 'create' && mode !== 'open') throw new TypeError('durable audit mode must be create or open');
    this.#id = traceId ?? (mode === 'create' ? `trace_${randomUUID()}` : null);
    if (typeof this.#id !== 'string' || this.#id.trim() === '') throw new TypeError('traceId must be a non-empty string');
    this.#repository = repository;
    this.#clock = clock;
    if (mode === 'create') this.#repository.createTrace(this.#id, String(this.#clock()));
    else this.#repository.loadTrace(this.#id);
  }

  static create(options) { return new DurableOrchestrationAuditTrace({ ...options, mode: 'create' }); }
  static open(options) { return new DurableOrchestrationAuditTrace({ ...options, mode: 'open' }); }

  get id() { return this.#id; }
  get sealed() { return this.#repository.loadTrace(this.#id).sealed; }

  record(type, data = {}) {
    if (this.#repository.loadTrace(this.#id).sealed) {
      throw new DurableAuditTraceError(`audit trace ${this.#id} is sealed`, { code: 'AUDIT_TRACE_SEALED', traceId: this.#id });
    }
    if (typeof type !== 'string' || type.trim() === '') throw new TypeError('audit trace type must be non-empty');
    const safeData = sanitizeAuditData(data);
    return this.#repository.append(this.#id, { type, data: safeData, timestamp: String(this.#clock()) });
  }

  healthFeedback(feedback) {
    return this.record('health.feedback', {
      outcome: feedback?.outcome ?? null,
      backend: feedback?.backend ?? null,
      classification: feedback?.classification ?? null,
      event: feedback?.event ?? null,
      health: feedback?.health ?? null,
    });
  }

  seal(finalData = {}) {
    if (this.#repository.loadTrace(this.#id).sealed) return this.snapshot();
    const safeData = sanitizeAuditData(finalData);
    this.#repository.seal(this.#id, { data: safeData, timestamp: String(this.#clock()) });
    return this.snapshot();
  }

  snapshot() {
    const stored = this.#repository.loadTrace(this.#id);
    return Object.freeze({
      traceId: stored.traceId,
      sealed: stored.sealed,
      entries: stored.entries,
    });
  }
}
