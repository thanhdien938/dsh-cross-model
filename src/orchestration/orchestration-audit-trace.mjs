import { randomUUID } from 'node:crypto';
import { sanitizeAuditData } from './audit-sanitize.mjs';

export class OrchestrationAuditTrace {
  #id;
  #clock;
  #entries = [];
  #sealed = false;

  constructor({ traceId, clock = () => new Date().toISOString() } = {}) {
    if (typeof clock !== 'function') throw new TypeError('audit trace clock must be a function');
    this.#id = traceId ?? `trace_${randomUUID()}`;
    if (typeof this.#id !== 'string' || this.#id.trim() === '') throw new TypeError('traceId must be a non-empty string');
    this.#clock = clock;
  }

  get id() { return this.#id; }
  get sealed() { return this.#sealed; }

  record(type, data = {}) {
    if (this.#sealed) throw new Error(`audit trace ${this.#id} is sealed`);
    if (typeof type !== 'string' || type.trim() === '') throw new TypeError('audit trace type must be non-empty');
    const entry = Object.freeze({
      traceId: this.#id,
      sequence: this.#entries.length + 1,
      timestamp: String(this.#clock()),
      type,
      data: sanitizeAuditData(data),
    });
    this.#entries.push(entry);
    return entry;
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
    if (!this.#sealed) {
      this.record('trace.sealed', finalData);
      this.#sealed = true;
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      traceId: this.#id,
      sealed: this.#sealed,
      entries: Object.freeze([...this.#entries]),
    });
  }
}

export function createAuditHealthFeedbackSink(trace) {
  if (!trace || typeof trace.healthFeedback !== 'function') throw new TypeError('audit feedback sink requires trace.healthFeedback()');
  return (feedback) => trace.healthFeedback(feedback);
}
