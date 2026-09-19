import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoordinationStore, COORDINATION_STORE_METHODS } from '../src/coordination/coordination-store-contract.mjs';
import { createWorkIdentity, normalizeCapacity, normalizeInstalledProfiles, normalizeWorkerIdentity } from '../src/coordination/coordination-identities.mjs';

test('coordination contract is project-owned and excludes provider dispatch semantics', () => {
  const store = Object.fromEntries(COORDINATION_STORE_METHODS.map((name) => [name, () => {}]));
  assert.equal(assertCoordinationStore(store), true);
  assert.deepEqual(COORDINATION_STORE_METHODS.filter((name) => /election|provider|adapter/i.test(name)), []);
  for (const method of ['acquireLeadership', 'renewLeadership', 'withLeadershipAuthority', 'fencedPolicyTouch']) assert.ok(COORDINATION_STORE_METHODS.includes(method));
  assert.deepEqual(COORDINATION_STORE_METHODS.filter((name) => /dispatch/i.test(name)), ['listTaskDispatchCandidates']);
  for (const method of ['registerWorkIdentity', 'readWorkItem', 'readClaim', 'acquireClaim', 'renewClaim', 'releaseClaim', 'completeClaim', 'fencedTouch']) assert.ok(COORDINATION_STORE_METHODS.includes(method));
});

test('worker metadata is bounded, allowlisted, faithful, and health-free', () => {
  const worker = normalizeWorkerIdentity({ logical_worker_id: 'worker-a', worker_incarnation_id: 'inc-1', host_id: 'host-a', installed_profiles: [{ backend: 'codex', product: 'cli', version: '1.2.3', transport: 'stdio', capabilities: { resume_existing: 'PROVED' } }], capacity: { max_concurrency: 4, reported_in_use: 1, resource_class: 'standard' } });
  assert.equal(worker.record_version, 1);
  assert.equal('health' in worker, false);
  assert.throws(() => normalizeInstalledProfiles([{ backend: 'x', api_key: 'raw-secret' }]), /not allowlisted/);
  assert.throws(() => normalizeInstalledProfiles([{ backend: 'x\nsecret' }]), /invalid/);
  assert.throws(() => normalizeInstalledProfiles([{ backend: 'x', capabilities: { resume_existing: 'YES' } }]), /invalid/);
  assert.throws(() => normalizeCapacity({ max_concurrency: -1, reported_in_use: 0 }), /invalid/);
  assert.throws(() => normalizeCapacity({ max_concurrency: 1, reported_in_use: 2 }), /invalid/);
});

test('installed profiles reject every non-JSON-faithful JavaScript value without echoing payloads', () => {
  const secret = 'R1_SECRET_MUST_NOT_ECHO';
  const invalid = [
    () => {}, undefined, Symbol('x'), 1n, new Date(), NaN, Infinity, -Infinity,
    { nested: { value: () => {}, secret } },
    { capabilities: { resume_existing: { nested: () => {} } } },
  ];
  const cycle = { backend: 'x' };
  cycle.self = cycle;
  invalid.push(cycle);
  for (const value of invalid) {
    const profile = value === cycle ? value : { backend: 'x', foo: value, secret };
    assert.throws(() => normalizeInstalledProfiles([profile]), (error) => {
      assert.equal(error.code, 'INVALID_COORDINATION_INPUT');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  const hidden = { backend: 'x' };
  Object.defineProperty(hidden, 'secret', { value: secret, enumerable: false });
  assert.throws(() => normalizeInstalledProfiles([hidden]), /hidden or accessor state/);
});

test('work identity preserves exact P2 lineage and grants no ownership/replay authority', () => {
  const work = createWorkIdentity({ work_item_id: 'work-1', work_kind: 'TASK_DISPATCH', task_id: 'task-1', run_id: 'run-1', dispatch_attempt_id: 'attempt-1' });
  assert.deepEqual(work, { work_item_id: 'work-1', work_kind: 'TASK_DISPATCH', task_id: 'task-1', run_id: 'run-1', dispatch_attempt_id: 'attempt-1', record_version: 1 });
  for (const forbidden of ['owner', 'lease', 'expires_at', 'fencing_token', 'replay_safe']) assert.equal(forbidden in work, false);
  assert.throws(() => createWorkIdentity({ work_item_id: 'work-2', work_kind: 'TASK_DISPATCH', task_id: 'task-2', run_id: 'run-2' }), /lineage/);
  assert.throws(() => createWorkIdentity({ work_item_id: 'work-3', work_kind: 'PEER_HOP', conversation_id: 'c', hop_id: 'h', task_id: 'extra' }), /unknown fields/);
});

test('every work kind rejects unknown and authority-adjacent keys instead of stripping them', () => {
  const validByKind = {
    TASK_DISPATCH: { task_id: 'task', run_id: 'run', dispatch_attempt_id: 'attempt' },
    WORKFLOW_STEP: { workflow_id: 'workflow', step_id: 'step' },
    PEER_HOP: { conversation_id: 'conversation', hop_id: 'hop' },
    PM_ACTION: { pm_run_id: 'pm-run', action_id: 'action' },
  };
  const extras = ['owner', 'lease_until', 'fencing_token', 'replaySafe', 'arbitrary'];
  for (const [work_kind, lineage] of Object.entries(validByKind)) {
    const base = { work_kind, work_item_id: `work-${work_kind}`, ...lineage };
    assert.equal(createWorkIdentity(base).work_kind, work_kind);
    for (const key of extras) assert.throws(() => createWorkIdentity({ ...base, [key]: key === 'replaySafe' ? true : 'forbidden' }), /unknown fields/);
  }
  const hidden = { work_kind: 'PM_ACTION', work_item_id: 'work-hidden', pm_run_id: 'pm', action_id: 'action' };
  Object.defineProperty(hidden, 'owner', { value: 'hidden-owner', enumerable: false });
  assert.throws(() => createWorkIdentity(hidden), /unknown fields/);
  assert.throws(() => createWorkIdentity({ ...validByKind.PM_ACTION, work_kind: 'PM_ACTION', work_item_id: 'work-symbol', [Symbol('owner')]: 'hidden-owner' }), /unknown fields/);
});
