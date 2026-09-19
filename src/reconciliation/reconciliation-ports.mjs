/** Routes candidates to their owning durable store without pretending the stores share a transaction. */
export class CompositeReconciliationSource {
  constructor(sources = []) { this.sources = sources; }
  async scanCandidates({ limit = 50 } = {}) {
    const groups = await Promise.all(this.sources.map(async (source, sourceIndex) => (await source.scanCandidates({ limit })).map(candidate => ({ ...candidate, sourceIndex }))));
    return groups.flat().slice(0, limit);
  }
  #source(candidate) { const source = this.sources[candidate.sourceIndex]; if (!source) throw new TypeError('unknown reconciliation source'); return source; }
  observe(candidate) { return this.#source(candidate).observe(candidate); }
  repair(args) { return this.#source(args.candidate).repair(args); }
}

/**
 * Combines durable PostgreSQL facts with process-local ownership registries.
 * Missing registries are treated as unknown/active, so production fails closed.
 */
export class ConservativeResourceGuard {
  constructor({ coordinationStore, providerProcesses, workspaceOccupancy, providerSlots } = {}) {
    if (!coordinationStore?.observeReconciliationResources) throw new TypeError('coordination reconciliation reader is required');
    this.coordination = coordinationStore; this.processes = providerProcesses; this.workspaces = workspaceOccupancy; this.slots = providerSlots;
  }
  async observe(subject) {
    const durable = await this.coordination.observeReconciliationResources(subject.lineage);
    const call = async (provider, fallback) => typeof provider === 'function' ? Boolean(await provider(subject)) : fallback;
    return Object.freeze({
      ...durable,
      liveProviderProcess: await call(this.processes, true),
      workspaceOccupancy: await call(this.workspaces, true),
      activeProviderSlot: await call(this.slots, true),
    });
  }
}

export class CoordinationLeadershipGuard {
  constructor(coordinationStore) { this.store = coordinationStore; }
  async assertCurrent(fence) { await this.store.withLeadershipAuthority(fence, async () => true); return true; }
}
