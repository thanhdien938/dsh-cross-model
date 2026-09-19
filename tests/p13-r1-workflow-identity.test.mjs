// P13-R1 D3 (§9 of the architecture plan): canonical durable workflow
// identity is derived by DSH from (pm_run_id, turn_index), never accepted
// from the model's own `spec.id`. See durable-pm-runtime.mjs's decide loop
// for the exact seam these tests exercise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

function driver(decisions = []) {
  return { name: 'neutral-driver', calls: [], async decide(input) { this.calls.push(input); const next = decisions.shift(); return typeof next === 'function' ? next(input) : next; } };
}
function actions() {
  const workflows = new Map();
  const workflowRunner = {
    calls: [],
    result(id) { return workflows.get(id) ?? null; },
    async run(spec) { this.calls.push(spec); const value = { workflowId: spec.id, status: 'completed', finalResult: { id: 'r', output: 'ok' }, error: null }; workflows.set(spec.id, value); return value; },
  };
  const peerRelay = { exchange: async () => {}, createConversation() {}, getConversation() { return null; }, result: () => null };
  return { workflowRunner, peerRelay, workflows };
}
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p13-wf-'));
  const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'pm.db') }); await store.migrate(); await fn({ store, repository: new PmRepository({ store }) }); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('a workflow decision without a spec.id gets a deterministic id derived from (pm_run_id, turn_index)', async () => fixture(async ({ repository }) => {
  const a = actions();
  const d = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'alpha', body: 'work' }] } }, { type: 'finish', output: 'done', data: null }]);
  const result = await new DurablePmRuntime({ driver: d, repository, ...a }).run({ objective: 'x' });
  assert.equal(result.status, 'completed');
  const expected = deterministicOwnerId('wf', result.pmRunId, '0');
  assert.deepEqual(a.workflowRunner.calls.map((s) => s.id), [expected]);
  assert.equal(repository.load(result.pmRunId).turns[0].actionId, expected);
}));

test('a model-supplied spec.id is NEVER trusted as identity -- it is overridden and preserved only as a non-identity label', async () => fixture(async ({ repository }) => {
  const a = actions();
  const d = driver([{ type: 'workflow', spec: { id: 'model-chosen-literal', steps: [{ recipient: 'alpha', body: 'work' }] } }, { type: 'finish', output: 'done', data: null }]);
  const result = await new DurablePmRuntime({ driver: d, repository, ...a }).run({ objective: 'x' });
  const expected = deterministicOwnerId('wf', result.pmRunId, '0');
  assert.equal(a.workflowRunner.calls[0].id, expected);
  assert.notEqual(a.workflowRunner.calls[0].id, 'model-chosen-literal');
  assert.equal(a.workflowRunner.calls[0].label, 'model-chosen-literal', 'the model\'s own requested id is preserved for diagnostics, never as identity');
  assert.equal(repository.load(result.pmRunId).turns[0].actionId, expected);
}));

test('two DIFFERENT pm_runs whose models both emit the SAME literal spec.id never collide on the durable workflow identity', async () => fixture(async ({ repository }) => {
  const a1 = actions(); const a2 = actions();
  const literalId = 'wf-1'; // a plausible naive/stable literal a model might emit every time
  const d1 = driver([{ type: 'workflow', spec: { id: literalId, steps: [{ recipient: 'alpha', body: 'work' }] } }, { type: 'finish', output: 'done', data: null }]);
  const d2 = driver([{ type: 'workflow', spec: { id: literalId, steps: [{ recipient: 'alpha', body: 'work' }] } }, { type: 'finish', output: 'done', data: null }]);
  const r1 = await new DurablePmRuntime({ driver: d1, repository, ...a1 }).run({ objective: 'task one' });
  const r2 = await new DurablePmRuntime({ driver: d2, repository, ...a2 }).run({ objective: 'task two' });
  assert.notEqual(r1.pmRunId, r2.pmRunId);
  const id1 = repository.load(r1.pmRunId).turns[0].actionId;
  const id2 = repository.load(r2.pmRunId).turns[0].actionId;
  assert.notEqual(id1, id2, 'the same model-chosen literal must never alias two different durable workflow rows');
}));

test('the derivation is deterministic: same (pm_run_id, turn_index) always yields the same id, and differs by turn_index', () => {
  const a = deterministicOwnerId('wf', 'pmrun-x', '0');
  const b = deterministicOwnerId('wf', 'pmrun-x', '0');
  const c = deterministicOwnerId('wf', 'pmrun-x', '1');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('resume stability: a durable turn seeded (pre-P13-R1 shape) with a literal actionId is read back as-is, never re-derived on resume', async () => fixture(async ({ repository }) => {
  // Backward compatibility (§9.2 point 4): an in-flight run created before
  // this change resumes from its OWN durably committed turn.actionId --
  // #processCommitted() never recomputes it. This directly exercises that
  // by seeding a turn the way `seed()` does in durable-pm-runtime.test.mjs,
  // bypassing the decide loop entirely.
  const request = createPmRequest({ id: 'request_legacy', objective: 'objective', context: {} });
  repository.create(request, { id: 'pmrun_legacy', driver: 'neutral-driver', startedAt: '2026-08-18T00:00:00.000Z' });
  repository.commitDecision('pmrun_legacy', { id: 'turn_legacy_0', turnIndex: 0, decision: { type: 'workflow', spec: { id: 'pre-existing-legacy-id', steps: [{ recipient: 'a', body: 'x' }] } }, actionType: 'workflow', actionId: 'pre-existing-legacy-id', createdAt: '2026-08-18T00:00:01.000Z' });
  repository.markActionStarted('pmrun_legacy', 0);
  const a = actions();
  a.workflows.set('pre-existing-legacy-id', { workflowId: 'pre-existing-legacy-id', status: 'completed', finalResult: { id: 'z', output: 'ok' }, error: null });
  const result = await new DurablePmRuntime({ driver: driver([{ type: 'finish', output: 'done', data: null }]), repository, ...a }).resume('pmrun_legacy');
  assert.equal(result.status, 'completed');
  assert.equal(repository.load('pmrun_legacy').turns[0].actionId, 'pre-existing-legacy-id');
  assert.equal(a.workflowRunner.calls.length, 0, 'a terminal durable outcome is reconstructed, never re-run');
}));

test('recovery/resume after a mid-flight commit failure re-derives the SAME deterministic id, not a new one', async () => fixture(async ({ repository }) => {
  const a = actions();
  const d1 = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'alpha', body: 'work' }] } }]);
  let failed = false;
  const flaky = new Proxy(repository, { get(target, prop) { if (prop === 'completeTurn') return (...args) => { if (!failed) { failed = true; throw new Error('OUTCOME_WRITE_LOST'); } return target.completeTurn(...args); }; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
  await assert.rejects(() => new DurablePmRuntime({ driver: d1, repository: flaky, ...a }).run({ objective: 'x' }), /OUTCOME_WRITE_LOST/);
  const pmRunId = repository.store.get('SELECT id FROM pm_runs').id;
  const committedId = repository.load(pmRunId).turns[0].actionId;
  assert.equal(committedId, deterministicOwnerId('wf', pmRunId, '0'));
  const d2 = driver([{ type: 'finish', output: 'done', data: null }]);
  const result = await new DurablePmRuntime({ driver: d2, repository, ...a }).resume(pmRunId);
  assert.equal(result.status, 'completed');
  assert.deepEqual(a.workflowRunner.calls.map((s) => s.id), [committedId], 'the exact same durable id is looked up on recovery, never a fresh one');
}));
