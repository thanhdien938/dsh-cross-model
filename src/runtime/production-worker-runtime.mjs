export class ProductionWorkerRuntime {
  constructor({ worker, heartbeat, pollIntervalMs = 250, telemetry } = {}) {
    if (!worker || typeof worker.runOnce !== 'function') throw new TypeError('worker is required');
    this.worker = worker; this.heartbeat = heartbeat; this.pollIntervalMs = pollIntervalMs; this.telemetry = telemetry; this.draining = false;
  }
  requestDrain() { this.draining = true; this.worker.requestStop(); }
  // P13-R1 D4/§13: passthrough to the wrapped worker's bounded active-slot
  // drain, when it has one (ProductionPmWorker / CompositeProductionWorker
  // do; a plain test double worker may not). Callers (composition close())
  // must await this BEFORE closing shared persistence stores.
  async drainActive(opts) { return typeof this.worker.drainActive === 'function' ? this.worker.drainActive(opts) : { settled: true, remaining: 0 }; }
  async runOnce() {
    if (this.draining) return Object.freeze({ status: 'DRAINING' });
    try { await this.heartbeat?.(); } catch { this.telemetry?.count('heartbeat_failures'); }
    const outcome = await this.worker.runOnce();
    this.telemetry?.count(outcome.status === 'WORK' ? 'work_completed' : 'worker_polls');
    return outcome;
  }
  async run({ maxPolls = Infinity } = {}) { const finite = Number.isFinite(maxPolls); const output = finite ? [] : null; for (let i = 0; !this.draining && i < maxPolls; i += 1) { const result = await this.runOnce(); if (finite) output.push(result); if (!this.draining) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs)); } return finite ? Object.freeze(output) : undefined; }
}
