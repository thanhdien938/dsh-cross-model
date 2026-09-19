#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime, PM_RECOVERY } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { classifySmoke, exitCodeFor } from './lib/smoke-status.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g7-smoke-'));
const store = new SqlitePersistenceStore();
const checks = [];
const workflowStates = new Map();
const peerStates = new Map();
const workflowRunner = {
  calls: [], result(id) { return workflowStates.get(id) ?? null; },
  async run(spec) { this.calls.push(spec.id); const out = { workflowId: spec.id, status: 'completed', finalResult: { id: 'r', output: 'ok' } }; workflowStates.set(spec.id, out); return out; },
};
const peerRelay = {
  calls: [], creates: [], getConversation(id) { return peerStates.get(id) ?? null; }, result(id) { return peerStates.get(id)?.outcome ?? null; },
  createConversation({ id }) { this.creates.push(id); const state = { id, status: 'created' }; peerStates.set(id, state); return state; },
  async exchange(input) { this.calls.push(input.conversationId); const outcome = { conversationId: input.conversationId, status: 'completed', hops: [{}], finalResult: { id: 'p', output: 'ok' } }; peerStates.set(input.conversationId, { id: input.conversationId, status: 'completed', outcome }); return outcome; },
};
const makeDriver = (decisions) => ({ name: 'neutral', calls: [], async decide(input) { this.calls.push(input); return decisions.shift(); } });
const add = async (name, fn) => { try { checks.push({ name, passed: await fn() === true }); } catch (error) { checks.push({ name, passed: false, error: error.message }); } };

try {
  await store.open({ path: join(dir, 'pm.db') }); await store.migrate();
  const repository = new PmRepository({ store });
  const request = createPmRequest({ id: 'req', objective: 'objective', context: {} });
  repository.create(request, { id: 'pmrun', driver: 'neutral', startedAt: 'now' });
  const decision = { type: 'workflow', spec: { id: 'wf_stable', steps: [{ recipient: 'alpha', body: 'work' }] } };
  repository.commitDecision('pmrun', { id: 'turn0', turnIndex: 0, decision, actionType: 'workflow', actionId: 'wf_stable', createdAt: 'now' });
  const d = makeDriver([{ type: 'finish', output: 'done', data: null }]);
  const result = await new DurablePmRuntime({ driver: d, repository, workflowRunner, peerRelay }).resume('pmrun');
  await add('1. committed decision reopens without same-turn re-decide', () => d.calls.length === 1 && d.calls[0].turn === 1);
  await add('2. stored decision executes with stable action reference', () => workflowRunner.calls[0] === 'wf_stable' && result.status === 'completed');

  repository.create(createPmRequest({ id: 'req_recover', objective: 'o', context: {} }), { id: 'recover', driver: 'neutral', startedAt: 'now' });
  repository.commitDecision('recover', { id: 'rt', turnIndex: 0, decision: { ...decision, spec: { ...decision.spec, id: 'wf_terminal' } }, actionType: 'workflow', actionId: 'wf_terminal', createdAt: 'now' });
  repository.markActionStarted('recover', 0); workflowStates.set('wf_terminal', { workflowId: 'wf_terminal', status: 'completed', finalResult: { id: 'x', output: 'recovered' } });
  const rd = makeDriver([{ type: 'finish', output: 'recovered', data: null }]);
  await new DurablePmRuntime({ driver: rd, repository, workflowRunner, peerRelay }).resume('recover');
  await add('3. terminal action outcome reconstructs without rerun', () => workflowRunner.calls.filter((id) => id === 'wf_terminal').length === 0 && repository.load('recover').turns[0].outcome.status === 'completed');

  repository.create(createPmRequest({ id: 'req_amb', objective: 'o', context: {} }), { id: 'amb', driver: 'neutral', startedAt: 'now' });
  repository.commitDecision('amb', { id: 'at', turnIndex: 0, decision: { ...decision, spec: { ...decision.spec, id: 'wf_running' } }, actionType: 'workflow', actionId: 'wf_running', createdAt: 'now' });
  repository.markActionStarted('amb', 0); workflowStates.set('wf_running', { workflowId: 'wf_running', status: 'running' });
  let reconcile = false; try { await new DurablePmRuntime({ driver: makeDriver([]), repository, workflowRunner, peerRelay }).resume('amb'); } catch (error) { reconcile = error.code === PM_RECOVERY.ACTION_RECONCILE_REQUIRED; }
  await add('4. nonterminal action requires reconciliation and no replay', () => reconcile && !workflowRunner.calls.includes('wf_running'));

  repository.create(createPmRequest({ id: 'req_finish', objective: 'o', context: {} }), { id: 'finish', driver: 'neutral', startedAt: 'now' });
  repository.commitDecision('finish', { id: 'ft', turnIndex: 0, decision: { type: 'finish', output: 'fixed', data: null }, actionType: null, actionId: null, createdAt: 'now' });
  const fd = makeDriver([]); const finish = await new DurablePmRuntime({ driver: fd, repository, workflowRunner, peerRelay }).resume('finish');
  await add('5. FINISH restart completes without re-decide', () => finish.output === 'fixed' && fd.calls.length === 0);
  await add('6. bounded history reconstructs committed outcomes', () => rd.calls[0].history.length === 1 && rd.calls[0].history[0].turn === 0);

  store.run('UPDATE pm_turns SET decision = ? WHERE pm_run_id = ?', ['{bad', 'finish']); let corrupt = false; try { repository.load('finish'); } catch (error) { corrupt = error.code === 'CORRUPT_PM_STATE'; }
  await add('7. corrupt durable PM state fails closed', () => corrupt);
  await add('8. provider-neutral legacy-compatible seam', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/pm/durable-pm-runtime.mjs', import.meta.url), 'utf8'));
    return !/codex|claude|grok|opencode/i.test(source) && typeof workflowRunner.run === 'function' && typeof peerRelay.exchange === 'function';
  });

  for (const item of checks) console.log(`${item.passed ? 'PASS' : 'FAIL'}  ${item.name}${item.error ? ` — ${item.error}` : ''}`);
  const proved = checks.filter((item) => item.passed).length; const status = classifySmoke({ proved, required: 8 });
  console.log(`P2-GATE7: ${status} (${proved}/8 checks) — durable PM turns`); process.exitCode = exitCodeFor(status);
} finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
