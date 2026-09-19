import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

const SECRET = 'Bearer RAWSECRET123456789';

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm7-r1-')); const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'pm.db') }); await store.migrate(); await fn({ store, repository: new PmRepository({ store }) }); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function driver(name, decisions = []) {
  return { name, calls: [], async decide(input) { this.calls.push(input); return decisions.shift(); } };
}

function actions() {
  const workflows = new Map(); const peers = new Map();
  return {
    workflows, peers,
    workflowRunner: {
      calls: [], result(id) { return workflows.get(id) ?? null; },
      async run(spec) { this.calls.push(spec.id); const result = { workflowId: spec.id, status: 'completed', finalResult: { id: 'wr', output: SECRET, artifacts: [{ password: 'workflow-password' }], handoff: { apiKey: 'sk-workflowsecret123' } }, error: null }; workflows.set(spec.id, result); return result; },
    },
    peerRelay: {
      calls: [], creates: [], getConversation(id) { return peers.get(id) ?? null; }, result(id) { return peers.get(id)?.outcome ?? null; },
      createConversation({ id }) { this.creates.push(id); const value = { id, status: 'created' }; peers.set(id, value); return value; },
      async exchange(input) { this.calls.push(input.conversationId); const outcome = { conversationId: input.conversationId, status: 'completed', hops: [{}], finalResult: { id: 'pr', output: SECRET, artifacts: [{ credential: 'peer-credential' }], handoff: { authorization: 'peer-auth' } } }; peers.set(input.conversationId, { id: input.conversationId, status: 'completed', outcome }); return outcome; },
    },
  };
}

function createRun(repository, id, owner = 'driver-a') {
  repository.create(createPmRequest({ id: `request_${id}`, objective: 'objective', context: {} }), { id, driver: owner, startedAt: 'now' });
}

function commit(repository, id, decision) {
  const actionType = decision.type === 'finish' ? null : decision.type;
  const actionId = decision.type === 'workflow' ? decision.spec.id : decision.type === 'peer_exchange' ? decision.conversationId : null;
  repository.commitDecision(id, { id: `turn_${id}`, turnIndex: 0, decision, actionType, actionId, createdAt: 'now' });
}

const workflowDecision = (id) => ({ type: 'workflow', spec: { id, steps: [{ recipient: 'alpha', body: 'work' }] } });
const peerDecision = (id) => ({ type: 'peer_exchange', conversationId: id, routes: [{ from: 'alpha', to: 'beta' }], body: 'work', sourceResult: null, context: null, metadata: null, maxHops: null });

test('fresh workflow and peer outcomes are sanitized before raw PM JSON storage', async () => fixture(async ({ store, repository }) => {
  for (const [kind, decision] of [['workflow', workflowDecision('fresh_wf')], ['peer', peerDecision('fresh_peer')]]) {
    const a = actions(); const d = driver('driver-a', [decision, { type: 'finish', output: 'done', data: null }]);
    await new DurablePmRuntime({ driver: d, repository, ...a }).run({ objective: kind });
  }
  const raw = store.all('SELECT outcome FROM pm_turns WHERE outcome IS NOT NULL').map((row) => row.outcome).join('\n');
  for (const secret of ['RAWSECRET123456789', 'workflow-password', 'sk-workflowsecret123', 'peer-credential', 'peer-auth']) assert.equal(raw.includes(secret), false);
  assert.match(raw, /REDACTED/);
}));

test('reconstructed terminal workflow and peer outcomes sanitize nested result data before storage', async () => fixture(async ({ store, repository }) => {
  const a = actions();
  createRun(repository, 'reconstruct_wf'); commit(repository, 'reconstruct_wf', workflowDecision('rwf')); repository.markActionStarted('reconstruct_wf', 0);
  a.workflows.set('rwf', { workflowId: 'rwf', status: 'completed', finalResult: { id: 'x', output: SECRET, artifacts: [{ password: 'recovered-workflow' }], handoff: { apiKey: 'sk-recoveredworkflow123' } }, error: { credential: 'workflow-error-secret' } });
  await new DurablePmRuntime({ driver: driver('driver-a', [{ type: 'finish', output: 'done', data: null }]), repository, ...a }).resume('reconstruct_wf');
  createRun(repository, 'reconstruct_peer'); commit(repository, 'reconstruct_peer', peerDecision('rpeer')); repository.markActionStarted('reconstruct_peer', 0);
  a.peers.set('rpeer', { id: 'rpeer', status: 'completed', outcome: { conversationId: 'rpeer', status: 'completed', hops: [{}], finalResult: { id: 'y', output: SECRET, artifacts: [{ password: 'recovered-peer' }], handoff: { apiKey: 'sk-recoveredpeer123' } } } });
  await new DurablePmRuntime({ driver: driver('driver-a', [{ type: 'finish', output: 'done', data: null }]), repository, ...a }).resume('reconstruct_peer');
  const raw = store.all('SELECT outcome FROM pm_turns WHERE outcome IS NOT NULL').map((row) => row.outcome).join('\n');
  for (const secret of ['RAWSECRET123456789', 'recovered-workflow', 'sk-recoveredworkflow123', 'workflow-error-secret', 'recovered-peer', 'sk-recoveredpeer123']) assert.equal(raw.includes(secret), false);
}));

test('repository enforces legal external-action and FINISH completion transitions', async () => fixture(async ({ repository }) => {
  for (const [id, decision] of [['transition_wf', workflowDecision('twf')], ['transition_peer', peerDecision('tpeer')]]) {
    createRun(repository, id); commit(repository, id, decision);
    assert.throws(() => repository.completeTurn(id, 0, { status: 'completed' }), (error) => error.code === 'CORRUPT_PM_STATE');
    assert.equal(repository.load(id).turns[0].phase, 'DECISION_COMMITTED');
    repository.markActionStarted(id, 0); repository.completeTurn(id, 0, { status: 'completed', marker: 'first' });
    repository.completeTurn(id, 0, { status: 'failed', marker: 'second' });
    assert.equal(repository.load(id).turns[0].outcome.marker, 'first');
  }
  createRun(repository, 'transition_finish'); commit(repository, 'transition_finish', { type: 'finish', output: 'done', data: null });
  repository.completeTurn('transition_finish', 0, { status: 'completed', output: 'done', data: null });
  assert.equal(repository.load('transition_finish').turns[0].phase, 'TURN_COMPLETE');
}));

test('hydration cross-checks workflow action linkage in both tamper directions', async () => fixture(async ({ store, repository }) => {
  createRun(repository, 'wf_action_tamper'); commit(repository, 'wf_action_tamper', workflowDecision('wf_original'));
  store.run('UPDATE pm_turns SET action_id = ? WHERE pm_run_id = ?', ['wf_other', 'wf_action_tamper']);
  assert.throws(() => repository.load('wf_action_tamper'), (error) => error.code === 'CORRUPT_PM_STATE');
  createRun(repository, 'wf_decision_tamper'); commit(repository, 'wf_decision_tamper', workflowDecision('wf_valid'));
  store.run('UPDATE pm_turns SET decision = ? WHERE pm_run_id = ?', [JSON.stringify(workflowDecision('wf_changed')), 'wf_decision_tamper']);
  assert.throws(() => repository.load('wf_decision_tamper'), (error) => error.code === 'CORRUPT_PM_STATE');
}));

test('hydration cross-checks peer action linkage in both tamper directions and accepts untouched linkage', async () => fixture(async ({ store, repository }) => {
  createRun(repository, 'peer_valid'); commit(repository, 'peer_valid', peerDecision('peer_original')); assert.equal(repository.load('peer_valid').turns[0].actionId, 'peer_original');
  store.run('UPDATE pm_turns SET action_id = ? WHERE pm_run_id = ?', ['peer_other', 'peer_valid']);
  assert.throws(() => repository.load('peer_valid'), (error) => error.code === 'CORRUPT_PM_STATE');
  createRun(repository, 'peer_decision_tamper'); commit(repository, 'peer_decision_tamper', peerDecision('peer_valid2'));
  store.run('UPDATE pm_turns SET decision = ? WHERE pm_run_id = ?', [JSON.stringify(peerDecision('peer_changed')), 'peer_decision_tamper']);
  assert.throws(() => repository.load('peer_decision_tamper'), (error) => error.code === 'CORRUPT_PM_STATE');
}));

test('driver mismatch fails before pending, recoverable, or terminal run processing with zero mutation', async () => fixture(async ({ store, repository }) => {
  const a = actions();
  createRun(repository, 'empty');
  createRun(repository, 'pending'); commit(repository, 'pending', workflowDecision('pending_wf'));
  createRun(repository, 'recoverable'); commit(repository, 'recoverable', workflowDecision('terminal_wf')); repository.markActionStarted('recoverable', 0); a.workflows.set('terminal_wf', { workflowId: 'terminal_wf', status: 'completed', finalResult: null });
  createRun(repository, 'terminal'); commit(repository, 'terminal', { type: 'finish', output: 'done', data: null }); repository.completeTurn('terminal', 0, { status: 'completed', output: 'done', data: null }, { status: 'completed', output: 'done', data: null, error: null, completedAt: 'done' });
  const before = JSON.stringify(store.all('SELECT * FROM pm_runs')).concat(JSON.stringify(store.all('SELECT * FROM pm_turns')));
  for (const id of ['empty', 'pending', 'recoverable', 'terminal']) {
    const b = driver('driver-b', []); const runtime = new DurablePmRuntime({ driver: b, repository, ...a });
    await assert.rejects(() => runtime.resume(id), (error) => error.code === 'PM_DRIVER_MISMATCH' && error.persistedDriver === 'driver-a' && error.configuredDriver === 'driver-b');
    assert.equal(b.calls.length, 0);
  }
  assert.equal(a.workflowRunner.calls.length, 0); assert.equal(a.peerRelay.calls.length, 0);
  assert.equal(JSON.stringify(store.all('SELECT * FROM pm_runs')).concat(JSON.stringify(store.all('SELECT * FROM pm_turns'))), before);
}));

test('fresh driver objects with the same persisted name may resume normally', async () => fixture(async ({ repository }) => {
  createRun(repository, 'same_name'); commit(repository, 'same_name', { type: 'finish', output: 'same', data: null });
  const a = actions(); const same = driver('driver-a', []);
  const result = await new DurablePmRuntime({ driver: same, repository, ...a }).resume('same_name');
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'same'); assert.equal(same.calls.length, 0);
}));
