import test from 'node:test';
import assert from 'node:assert/strict';
import { FencedPolicyCoordinator } from '../src/coordination/fenced-policy-coordinator.mjs';

function harness({ rejectAuthorityCall } = {}) {
  let authorityCalls = 0;
  const store = {
    async withLeadershipAuthority(_fence, callback) {
      authorityCalls += 1;
      if (authorityCalls === rejectAuthorityCall) throw Object.assign(new Error('leadership lost'), { code: 'LEADERSHIP_AUTHORITY_REJECTED' });
      return callback();
    },
    async fencedPolicyTouch() {},
  };
  return { policy: new FencedPolicyCoordinator({ coordinationStore: store }), authorityCalls: () => authorityCalls };
}

test('R1 sync committed read retains durable decision without driver or commit', async () => {
  const { policy } = harness(); let driverCalls = 0; let commitCalls = 0; const durable = { id: 'durable-sync' };
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: () => durable, decide: () => { driverCalls += 1; }, commitDecision: () => { commitCalls += 1; } });
  assert.deepEqual(out, { source: 'DURABLE_COMMITTED', decision: durable, driverCalled: false }); assert.equal(driverCalls, 0); assert.equal(commitCalls, 0);
});

test('R1 async Promise<committed> initial read skips driver', async () => {
  const { policy } = harness(); let driverCalls = 0; const durable = { id: 'durable-async' };
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: async () => durable, decide: () => { driverCalls += 1; }, commitDecision: () => assert.fail('must not commit') });
  assert.equal(out.source, 'DURABLE_COMMITTED'); assert.equal(out.decision, durable); assert.equal(driverCalls, 0);
});

test('R1 async Promise<null> on both reads commits driver decision exactly once', async () => {
  const { policy } = harness(); let reads = 0; let driverCalls = 0; let commitCalls = 0; const driverDecision = { id: 'new' };
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: async () => { reads += 1; return null; }, decide: async () => { driverCalls += 1; return driverDecision; }, commitDecision: (decision) => { commitCalls += 1; return { ...decision, committed: true }; } });
  assert.equal(reads, 2); assert.equal(driverCalls, 1); assert.equal(commitCalls, 1); assert.deepEqual(out.decision, { id: 'new', committed: true });
});

test('R1 async raced same-turn commit wins while decide is in flight', async () => {
  const { policy } = harness(); let durable = null; let commitCalls = 0; const raced = { id: 'raced-durable' };
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: async () => durable, decide: async () => { durable = raced; return { id: 'stale-local' }; }, commitDecision: () => { commitCalls += 1; } });
  assert.equal(commitCalls, 0); assert.equal(out.decision, raced); assert.equal(out.driverCalled, true);
});

test('R1 async commitDecision is awaited and returned', async () => {
  const { policy } = harness(); let commitCalls = 0;
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: async () => null, decide: async () => ({ id: 'async-commit' }), commitDecision: async (decision) => { commitCalls += 1; await Promise.resolve(); return { ...decision, durable: true }; } });
  assert.equal(commitCalls, 1); assert.deepEqual(out.decision, { id: 'async-commit', durable: true });
});

test('R1 leadership loss during decide rejects post-decide commit with zero mutation', async () => {
  const { policy, authorityCalls } = harness({ rejectAuthorityCall: 2 }); let commitCalls = 0; let driverCalls = 0;
  await assert.rejects(policy.decideAndCommit({ leaderFence: {}, readCommitted: async () => null, decide: async () => { driverCalls += 1; return { id: 'cannot-commit' }; }, commitDecision: async () => { commitCalls += 1; } }), (error) => error.code === 'LEADERSHIP_AUTHORITY_REJECTED');
  assert.equal(authorityCalls(), 2); assert.equal(driverCalls, 1); assert.equal(commitCalls, 0);
});

test('R1 existing all-sync new-decision behavior remains unchanged', async () => {
  const { policy } = harness(); let commits = 0;
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: () => null, decide: () => ({ id: 'sync-new' }), commitDecision: (decision) => { commits += 1; return decision; } });
  assert.equal(out.source, 'NEW_COMMIT'); assert.deepEqual(out.decision, { id: 'sync-new' }); assert.equal(out.driverCalled, true); assert.equal(commits, 1);
});
