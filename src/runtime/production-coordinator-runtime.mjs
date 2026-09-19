import { randomUUID } from 'node:crypto';

export class ProductionCoordinatorRuntime {
  constructor({ coordinationStore, logicalCoordinatorId, reconstruct, advance, reconciler = null, reconciliationIntervalMs = 30_000, leaseMs = 30_000, pollIntervalMs = 250, telemetry } = {}) {
    if (!coordinationStore || typeof coordinationStore.acquireLeadership !== 'function') throw new TypeError('coordination store is required');
    if (typeof reconstruct !== 'function' || typeof advance !== 'function') throw new TypeError('reconstruct and advance callbacks are required');
    this.store = coordinationStore; this.logicalId = logicalCoordinatorId; this.incarnationId = `${logicalCoordinatorId}:${randomUUID()}`;
    this.reconstruct = reconstruct; this.advance = advance; this.leaseMs = leaseMs; this.pollIntervalMs = pollIntervalMs; this.telemetry = telemetry;
    this.fence = null; this.draining = false; this.reconstructedGeneration = null;
    this.reconciler = reconciler; this.reconciliationIntervalMs = reconciliationIntervalMs; this.lastReconciliationAt = 0;
  }
  async start(metadata = {}) { await this.store.registerCoordinatorIncarnation({ logical_coordinator_id: this.logicalId, coordinator_incarnation_id: this.incarnationId, ...metadata }); return this.incarnationId; }
  requestDrain() { this.draining = true; }
  async runOnce() {
    if (this.draining) return Object.freeze({ status: 'DRAINING' });
    try {
      const authority = this.fence ? await this.store.renewLeadership(this.fence, this.leaseMs) : await this.store.acquireLeadership({ logical_coordinator_id: this.logicalId, coordinator_incarnation_id: this.incarnationId, leaseMs: this.leaseMs });
      this.fence = authority ? leadershipFenceOf(authority) : null;
      if (!this.fence) return Object.freeze({ status: 'FOLLOWER' });
      if (this.reconstructedGeneration !== this.fence.leader_generation) {
        await this.reconstruct({ fence: this.fence });
        this.reconstructedGeneration = this.fence.leader_generation;
      }
      await this.store.withLeadershipAuthority(this.fence, async () => true);
      const now = Date.now();
      if (this.reconciler && now - this.lastReconciliationAt >= this.reconciliationIntervalMs) {
        await this.reconciler.scan({ fence: this.fence });
        this.lastReconciliationAt = now;
      }
      // Policy/driver I/O stays outside the PostgreSQL transaction. The injected
      // accepted fenced-policy seam must revalidate this fence at canonical commit.
      const result = await this.advance({ fence: this.fence });
      return Object.freeze({ status: 'LEADER', generation: this.fence.leader_generation, result });
    } catch (error) {
      this.fence = null; this.telemetry?.count('coordinator_authority_failures');
      return Object.freeze({ status: 'FROZEN', reason: error?.code ?? 'AUTHORITY_UNAVAILABLE' });
    }
  }
  async run({ maxPolls = Infinity } = {}) { const finite = Number.isFinite(maxPolls); const output = finite ? [] : null; for (let i = 0; !this.draining && i < maxPolls; i += 1) { const result = await this.runOnce(); if (finite) output.push(result); if (!this.draining) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs)); } return finite ? Object.freeze(output) : undefined; }
}

function leadershipFenceOf(value) { return Object.freeze({ logical_coordinator_id:value.logical_coordinator_id,owner_coordinator_incarnation_id:value.owner_coordinator_incarnation_id,leader_generation:value.leader_generation,leadership_token:value.leadership_token }); }
