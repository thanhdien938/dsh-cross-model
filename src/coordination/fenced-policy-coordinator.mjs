export class FencedPolicyCoordinator {
  constructor({ coordinationStore } = {}) { if (!coordinationStore || typeof coordinationStore.withLeadershipAuthority !== 'function') throw new TypeError('fenced policy coordinator requires leadership store'); this.coordination = coordinationStore; }
  async commit(leaderFence, mutation) { if (typeof mutation !== 'function') throw new TypeError('policy mutation is required'); return this.coordination.withLeadershipAuthority(leaderFence, mutation); }
  async decideAndCommit({ leaderFence, readCommitted, decide, commitDecision } = {}) {
    if (![readCommitted, decide, commitDecision].every((fn) => typeof fn === 'function')) throw new TypeError('PM continuity callbacks are required');
    const existing = await this.coordination.withLeadershipAuthority(leaderFence, () => readCommitted());
    if (existing) return Object.freeze({ source: 'DURABLE_COMMITTED', decision: existing, driverCalled: false });
    await this.coordination.fencedPolicyTouch(leaderFence);
    const decision = await decide(); // external policy I/O: no PostgreSQL/SQLite transaction is open
    const committed = await this.coordination.withLeadershipAuthority(leaderFence, async () => {
      const raced = await readCommitted();
      if (raced) return raced;
      return commitDecision(decision);
    });
    return Object.freeze({ source: 'NEW_COMMIT', decision: committed, driverCalled: true });
  }
}
