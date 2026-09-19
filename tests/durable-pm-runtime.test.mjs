import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime, PM_RECOVERY } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

function driver(decisions = []) {
  return { name: 'neutral-driver', calls: [], async decide(input) { this.calls.push(input); const next = decisions.shift(); return typeof next === 'function' ? next(input) : next; } };
}

function actions() {
  const workflows = new Map(); const conversations = new Map();
  const workflowRunner = {
    calls: [], result(id) { return workflows.get(id) ?? null; },
    async run(spec) { this.calls.push(spec.id); const value = { workflowId: spec.id, status: 'completed', finalStepId: 'step', finalTaskId: 'task', finalRunId: 'run', finalResult: { id: 'result', output: 'workflow-ok' }, error: null }; workflows.set(spec.id, value); return value; },
  };
  const peerRelay = {
    createCalls: [], exchangeCalls: [], getConversation(id) { return conversations.get(id) ?? null; }, result(id) { return conversations.get(id)?.outcome ?? null; },
    createConversation({ id }) { this.createCalls.push(id); const value = { id, status: 'created' }; conversations.set(id, value); return value; },
    async exchange(input) { this.exchangeCalls.push(input.conversationId); const outcome = { conversationId: input.conversationId, status: 'completed', hops: [{ id: 'hop' }], finalResult: { id: 'peer-result', output: 'peer-ok' } }; conversations.set(input.conversationId, { id: input.conversationId, status: 'completed', outcome }); return outcome; },
  };
  return { workflowRunner, peerRelay, workflows, conversations };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm7-'));
  const path = join(dir, 'pm.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ store, repository: new PmRepository({ store }), path });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function seed(repository, decision, { id = 'pmrun_seed', turnIndex = 0 } = {}) {
  const request = createPmRequest({ id: `request_${id}`, objective: 'objective', context: {} });
  repository.create(request, { id, driver: 'neutral-driver', startedAt: '2026-08-18T00:00:00.000Z' });
  const actionType = decision.type === 'finish' ? null : decision.type;
  const actionId = decision.type === 'workflow' ? decision.spec.id : decision.type === 'peer_exchange' ? decision.conversationId : null;
  repository.commitDecision(id, { id: `turn_${id}_${turnIndex}`, turnIndex, decision, actionType, actionId, createdAt: '2026-08-18T00:00:01.000Z' });
  return id;
}

test('durable PM request/run persists faithfully and construction/open call driver zero times', async () => fixture(async ({ repository }) => {
  const d = driver([]); const a = actions();
  const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
  const request = createPmRequest({ id: 'request_open', objective: 'persist me', context: { value: 1 } });
  repository.create(request, { id: 'pmrun_open', driver: d.name, startedAt: 'now' });
  const reopened = runtime.open('pmrun_open');
  assert.equal(reopened.request.objective, 'persist me'); assert.equal(reopened.status, 'running'); assert.equal(d.calls.length, 0);
}));

test('decision persistence failure executes no workflow or peer action', async () => fixture(async ({ repository }) => {
  const d = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'alpha', body: 'work' }] } }]); const a = actions();
  const failing = new Proxy(repository, { get(target, prop) { if (prop === 'commitDecision') return () => { throw new Error('COMMIT_FAILED'); }; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
  const runtime = new DurablePmRuntime({ driver: d, repository: failing, ...a });
  await assert.rejects(() => runtime.run({ objective: 'x' }), /COMMIT_FAILED/);
  assert.equal(a.workflowRunner.calls.length, 0); assert.equal(a.peerRelay.exchangeCalls.length, 0);
}));

for (const type of ['workflow', 'peer_exchange']) {
  test(`committed ${type} resumes with zero re-decide and stable action identity`, async () => fixture(async ({ repository }) => {
    const decision = type === 'workflow'
      ? { type, spec: { id: 'stable_workflow', steps: [{ recipient: 'alpha', body: 'work' }] } }
      : { type, conversationId: 'stable_conversation', routes: [{ from: 'alpha', to: 'beta' }], body: 'work', sourceResult: null, context: null, metadata: null, maxHops: null };
    const id = seed(repository, decision); const d = driver([{ type: 'finish', output: 'done', data: null }]); const a = actions();
    const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
    const result = await runtime.resume(id);
    assert.equal(result.status, 'completed'); assert.equal(d.calls.length, 1);
    if (type === 'workflow') assert.deepEqual(a.workflowRunner.calls, ['stable_workflow']);
    else { assert.deepEqual(a.peerRelay.createCalls, ['stable_conversation']); assert.deepEqual(a.peerRelay.exchangeCalls, ['stable_conversation']); }
    assert.equal(d.calls[0].turn, 1);
  }));
}

for (const type of ['workflow', 'peer_exchange']) {
  test(`started nonterminal ${type} returns ACTION_RECONCILE_REQUIRED without replay`, async () => fixture(async ({ repository }) => {
    const decision = type === 'workflow'
      ? { type, spec: { id: 'action_nonterminal', steps: [{ recipient: 'alpha', body: 'work' }] } }
      : { type, conversationId: 'action_nonterminal', routes: [{ from: 'alpha', to: 'beta' }], body: 'work', sourceResult: null, context: null, metadata: null, maxHops: null };
    const id = seed(repository, decision); repository.markActionStarted(id, 0); const d = driver([]); const a = actions();
    if (type === 'workflow') a.workflows.set('action_nonterminal', { workflowId: 'action_nonterminal', status: 'running' });
    else a.conversations.set('action_nonterminal', { id: 'action_nonterminal', status: 'running', outcome: { conversationId: 'action_nonterminal', status: 'running', hops: [] } });
    const runtime = new DurablePmRuntime({ driver: d, repository, ...a });
    await assert.rejects(() => runtime.resume(id), (error) => error.code === PM_RECOVERY.ACTION_RECONCILE_REQUIRED);
    assert.equal(d.calls.length, 0); assert.equal(a.workflowRunner.calls.length, 0); assert.equal(a.peerRelay.exchangeCalls.length, 0);
  }));
}

for (const type of ['workflow', 'peer_exchange']) {
  test(`terminal durable ${type} outcome is reconstructed without rerun`, async () => fixture(async ({ repository }) => {
    const actionId = `terminal_${type}`;
    const decision = type === 'workflow'
      ? { type, spec: { id: actionId, steps: [{ recipient: 'alpha', body: 'work' }] } }
      : { type, conversationId: actionId, routes: [{ from: 'alpha', to: 'beta' }], body: 'work', sourceResult: null, context: null, metadata: null, maxHops: null };
    const id = seed(repository, decision); repository.markActionStarted(id, 0); const d = driver([{ type: 'finish', output: 'finished', data: null }]); const a = actions();
    if (type === 'workflow') a.workflows.set(actionId, { workflowId: actionId, status: 'completed', finalStepId: 's', finalTaskId: 't', finalRunId: 'r', finalResult: { id: 'z', output: 'ok' }, error: null });
    else a.conversations.set(actionId, { id: actionId, status: 'completed', outcome: { conversationId: actionId, status: 'completed', hops: [{}], finalResult: { id: 'z', output: 'ok' } } });
    const result = await new DurablePmRuntime({ driver: d, repository, ...a }).resume(id);
    assert.equal(result.status, 'completed'); assert.equal(result.history[0].outcome.status, 'completed'); assert.equal(d.calls.length, 1);
    assert.equal(a.workflowRunner.calls.length, 0); assert.equal(a.peerRelay.exchangeCalls.length, 0);
  }));
}

test('lost outcome commit preserves linkage and restart reconstructs without blind rerun', async () => fixture(async ({ repository }) => {
  const d1 = driver([{ type: 'workflow', spec: { steps: [{ recipient: 'alpha', body: 'work' }] } }]); const a = actions(); let failed = false;
  const flaky = new Proxy(repository, { get(target, prop) { if (prop === 'completeTurn') return (...args) => { if (!failed) { failed = true; throw new Error('OUTCOME_WRITE_LOST'); } return target.completeTurn(...args); }; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
  const first = new DurablePmRuntime({ driver: d1, repository: flaky, ...a });
  await assert.rejects(() => first.run({ objective: 'x' }), /OUTCOME_WRITE_LOST/);
  const pmRunId = repository.store.get('SELECT id FROM pm_runs').id; const stored = repository.load(pmRunId); const actionId = stored.turns[0].actionId;
  assert.equal(stored.turns[0].phase, 'ACTION_STARTED'); assert.equal(a.workflowRunner.calls.length, 1);
  const d2 = driver([{ type: 'finish', output: 'done', data: null }]);
  const result = await new DurablePmRuntime({ driver: d2, repository, ...a }).resume(pmRunId);
  assert.equal(result.status, 'completed'); assert.deepEqual(a.workflowRunner.calls, [actionId]); assert.equal(d2.calls.length, 1);
}));

test('FINISH decision-only state completes after restart without re-decide', async () => fixture(async ({ repository }) => {
  const id = seed(repository, { type: 'finish', output: 'durable finish', data: { ok: true } }); const d = driver([]); const a = actions();
  const result = await new DurablePmRuntime({ driver: d, repository, ...a }).resume(id);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'durable finish'); assert.deepEqual(result.data, { ok: true }); assert.equal(d.calls.length, 0);
}));

test('bounded history is reconstructed for the next turn after restart', async () => fixture(async ({ repository }) => {
  const id = seed(repository, { type: 'workflow', spec: { id: 'old', steps: [{ recipient: 'a', body: 'x' }] } });
  repository.markActionStarted(id, 0); repository.completeTurn(id, 0, { kind: 'workflow', status: 'completed', workflowId: 'old' });
  const d = driver([{ type: 'finish', output: 'done', data: null }]); const a = actions();
  await new DurablePmRuntime({ driver: d, repository, historyLimit: 1, ...a }).resume(id);
  assert.equal(d.calls.length, 1); assert.equal(d.calls[0].history.length, 1); assert.equal(d.calls[0].history[0].turn, 0);
}));

test('action failure and max-turn terminal states are coherent and durable', async () => fixture(async ({ repository }) => {
  const a = actions(); a.workflowRunner.run = async function run(spec) { this.calls.push(spec.id); const value = { workflowId: spec.id, status: 'failed', error: { name: 'Failure', message: 'failed' } }; a.workflows.set(spec.id, value); return value; };
  const failed = await new DurablePmRuntime({ driver: driver([{ type: 'workflow', spec: { steps: [{ recipient: 'a', body: 'x' }] } }]), repository, ...a }).run({ objective: 'x' });
  assert.equal(failed.status, 'failed'); assert.equal(repository.load(failed.pmRunId).turns[0].phase, 'TURN_COMPLETE');
  const maxed = await new DurablePmRuntime({ driver: driver([{ type: 'workflow', spec: { steps: [{ recipient: 'a', body: 'x' }] } }]), repository, maxTurns: 1, ...actions() }).run({ objective: 'y' });
  assert.equal(maxed.status, 'failed'); assert.equal(maxed.error.name, 'PmMaxTurnsExceeded');
}));

test('corrupt JSON, action mismatch, and non-contiguous history fail closed', async () => fixture(async ({ store, repository }) => {
  const id = seed(repository, { type: 'finish', output: 'x', data: null });
  store.run('UPDATE pm_turns SET decision = ? WHERE pm_run_id = ?', ['{broken', id]);
  assert.throws(() => repository.load(id), (error) => error.code === 'CORRUPT_PM_STATE');
  store.run('UPDATE pm_turns SET decision = ?, action_type = ?, action_id = ? WHERE pm_run_id = ?', [JSON.stringify({ type: 'finish', output: 'x', data: null }), 'workflow', 'bad', id]);
  assert.throws(() => repository.load(id), (error) => error.code === 'CORRUPT_PM_STATE');
  store.run('UPDATE pm_turns SET action_type = NULL, action_id = NULL, turn_index = 2 WHERE pm_run_id = ?', [id]);
  assert.throws(() => repository.load(id), (error) => error.code === 'CORRUPT_PM_STATE');
}));

test('credentials are redacted before PM request and decision storage', async () => fixture(async ({ store, repository }) => {
  const d = driver([{ type: 'finish', output: 'Bearer SECRET123456789', data: { apiKey: 'sk-secret123456789' } }]); const a = actions();
  await new DurablePmRuntime({ driver: d, repository, ...a }).run({ objective: 'use Bearer SECRET123456789', context: { password: 'hunter2' } });
  const raw = JSON.stringify(store.all('SELECT envelope FROM pm_requests')).concat(JSON.stringify(store.all('SELECT decision, outcome FROM pm_turns')));
  assert.equal(raw.includes('SECRET123456789'), false); assert.equal(raw.includes('hunter2'), false); assert.match(raw, /REDACTED/);
}));

test('durable PM facade contains no SQL and remains provider-neutral', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/pm/durable-pm-runtime.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|sqlite)\b/i); assert.doesNotMatch(source, /codex|claude|grok|opencode/i);
});
