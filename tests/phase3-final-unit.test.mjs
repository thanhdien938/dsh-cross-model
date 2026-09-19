import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWorkerEligibility, selectEligibleWorkers } from '../src/coordination/worker-eligibility.mjs';
import { DistributedDispatchRecovery, DISTRIBUTED_RECOVERY_ACTIONS } from '../src/coordination/distributed-recovery.mjs';
import { reconcileParentChildren } from '../src/coordination/distributed-parent-recovery.mjs';
import { FencedPolicyCoordinator } from '../src/coordination/fenced-policy-coordinator.mjs';

const profile = { backend: 'alpha', product: 'cli', version: '1', transport: 'stdio', fingerprint: 'fp' };
const requirement = { backend: 'alpha', product: 'cli', version: '1', transport: 'stdio', fingerprint: 'fp' };
function worker(id, extra = {}) { return { worker_incarnation_id: id, status: 'ACTIVE', installed_profiles: [profile], capacity: { max_concurrency: 1, reported_in_use: 0 }, ...extra }; }

test('G5_CHECKPOINT separates profile, lifecycle, capacity, and provider health', () => {
  const eligible = worker('a'); const absent = worker('b', { installed_profiles: [] });
  assert.deepEqual(selectEligibleWorkers({ workers: [absent, eligible], requirement }).map((x) => x.worker.worker_incarnation_id), ['a']);
  assert.equal(evaluateWorkerEligibility({ worker: absent, requirement, providerHealth: 'HEALTHY' }).reason, 'WORKER_PROFILE_MISMATCH');
  assert.equal(evaluateWorkerEligibility({ worker: worker('full', { capacity: { max_concurrency: 1, reported_in_use: 1 } }), requirement, providerHealth: 'HEALTHY' }).reason, 'WORKER_CAPACITY_FULL');
  for (const status of ['DRAINING', 'DISABLED', 'DEAD']) assert.equal(evaluateWorkerEligibility({ worker: worker(status, { status }), requirement }).eligible, false);
  assert.equal(evaluateWorkerEligibility({ worker: eligible, requirement, providerHealth: 'DEGRADED' }).eligible, true);
  assert.equal(evaluateWorkerEligibility({ worker: eligible, requirement, providerHealth: 'UNAVAILABLE' }).reason, 'PROVIDER_UNAVAILABLE');
  assert.equal(evaluateWorkerEligibility({ worker: absent, requirement, providerHealth: 'HEALTHY' }).providerHealth, 'HEALTHY');
});

test('G6_CHECKPOINT maps unchanged P2 classifications without synthetic replay', async () => {
  for (const [classification, action, calls] of [['SAFE_TO_DISPATCH', DISTRIBUTED_RECOVERY_ACTIONS.EXECUTE_EXACT_INTENT, 1], ['NATIVE_RECONCILE_REQUIRED', DISTRIBUTED_RECOVERY_ACTIONS.ROUTE_NATIVE_RECONCILIATION, 0], ['AMBIGUOUS_EXTERNAL_ACCEPTANCE', DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, 0], ['INTERRUPTED_EXTERNAL_RUN', DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, 0], ['AMBIGUOUS_RESULT_COMMIT', DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, 0], ['OPERATOR_ACTION_REQUIRED', DISTRIBUTED_RECOVERY_ACTIONS.BLOCK_AMBIGUOUS, 0], ['CLEAN', DISTRIBUTED_RECOVERY_ACTIONS.NO_ACTION, 0]]) {
    let providerCalls = 0;
    const recovery = new DistributedDispatchRecovery({ coordinationStore: { acquireClaim: async () => ({ work_item_id: 'w', owner_worker_incarnation_id: 'i', fencing_generation: 2, fencing_token: 'x'.repeat(43) }) }, dispatchCoordinator: { classifyForExecution: async () => ({ classification }), execute: async ({ provider }) => { await provider(); return { status: 'TERMINAL_COMMITTED' }; } } });
    const out = await recovery.recover({ work: { work_item_id: 'w', task_id: 't', run_id: 'r', dispatch_attempt_id: 'a' }, workerIncarnationId: 'i', leaseMs: 100, provider: async () => { providerCalls += 1; } });
    assert.equal(out.action, action); assert.equal(providerCalls, calls);
  }
});

test('G7_CHECKPOINT preserves workflow/peer child IDs and blocks ambiguous parents', () => {
  for (const kind of ['WORKFLOW_STEP', 'PEER_HOP']) {
    const children = [{ kind, parentId: `${kind}-parent`, childId: 'done', taskId: 'td', runId: 'rd', attemptId: 'ad', classification: 'CLEAN' }, { kind, parentId: `${kind}-parent`, childId: 'safe', taskId: 'ts', runId: 'rs', attemptId: 'as', classification: 'SAFE_TO_DISPATCH' }, { kind, parentId: `${kind}-parent`, childId: 'ambiguous', taskId: 'ta', runId: 'ra', attemptId: 'aa', classification: 'AMBIGUOUS_EXTERNAL_ACCEPTANCE' }];
    const plan = reconcileParentChildren(children); assert.equal(plan.canAdvance, false); assert.equal(plan.completed[0].childId, 'done'); assert.equal(plan.executable[0].attemptId, 'as'); assert.equal(plan.blocking[0].childId, 'ambiguous');
  }
});

test('G8 PM continuity never regenerates a committed same-turn decision', async () => {
  const store = { withLeadershipAuthority: async (_f, cb) => cb(), fencedPolicyTouch: async () => {} }; const policy = new FencedPolicyCoordinator({ coordinationStore: store });
  let driverCalls = 0; const durable = { decision: { type: 'finish', answer: 'durable' } };
  const out = await policy.decideAndCommit({ leaderFence: {}, readCommitted: () => durable.decision, decide: async () => { driverCalls += 1; }, commitDecision: () => assert.fail('must not commit') });
  assert.equal(out.source, 'DURABLE_COMMITTED'); assert.equal(driverCalls, 0);
});
