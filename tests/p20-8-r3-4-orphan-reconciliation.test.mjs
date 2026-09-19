/**
 * P20.8 PRE-R3 — R3-4.2: canonical operator orphan reconciliation for an
 * EXISTING AgentBus run unreachable through PM-action reconciliation.
 *
 * Authority: docs/P20/P20_8_PRE_R3_ASTRA_AUTHORITY_AND_ORPHAN_REMEDIATION_MASTER_PROMPT.md §6.2/§6.3.
 *
 * Builds the exact historical shape (terminal PM run -> terminal workflow ->
 * terminal step whose `run_id` is null -> the orphan `runs` row still
 * `running`) and proves:
 *   - the positive case reconciles to FAILED/ORPHAN_UNKNOWN_EXTERNAL_OUTCOME
 *     with a durable `reconciliation_audit` row, reusing
 *     `AgentBusRepository.updateRunStatus` (never raw SQL mutation);
 *   - every negative predicate in §6.3 refuses, with ZERO mutation.
 *
 * Offline; no live model/API calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import {
  observeOrphanAgentBusRun, evaluateOrphanReconciliationEligibility, reconcileOrphanAgentBusRun, OrphanReconciliationError,
} from '../src/reconciliation/agentbus-orphan-reconciliation.mjs';

const AT = '2026-09-01T00:00:00.000Z';
const FULL_PROOF = Object.freeze({ noLiveRuntimeSingleton: true, noLiveWorkerClaimOrLease: true, noOpenOwnerInteraction: true });

/** Build the exact historical orphan shape, with per-test overrides. */
async function orphanFixture({
  pmStatus = 'failed', workflowStatus = 'failed', turnPhase = 'TURN_COMPLETE', stepStatus = 'failed',
  runStatus = 'running', stepRunId = null, dispatchAttemptPhase = null, withResult = false, withNativeSession = false,
  extraNonterminalStepOnSameRun = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-r34-orphan-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'fixture.sqlite') });
  await store.migrate();
  const pm = 'pm-orphan'; const wf = 'wf-orphan'; const step = 'wf-orphan-step';
  const task = 'task-orphan'; const runId = 'run-orphan';

  store.run('INSERT INTO pm_requests(id,objective,context,envelope,created_at) VALUES(?,?,?,?,?)',
    [`req-${pm}`, 'fixture', '{}', JSON.stringify({ id: `req-${pm}`, objective: 'fixture', context: {}, createdAt: AT }), AT]);
  store.run('INSERT INTO pm_runs(id,request_id,driver,status,output,started_at,completed_at,created_at,turn_count,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [pm, `req-${pm}`, 'single:pm', pmStatus, '', AT, AT, AT, 1, 4]);
  store.run('INSERT INTO pm_turns(id,pm_run_id,turn_index,decision,committed,created_at,phase,action_type,action_id,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [`turn-${pm}`, pm, 0, JSON.stringify({ type: 'workflow', spec: { id: wf } }), 1, AT, turnPhase, 'workflow', wf, 3]);
  store.run('INSERT INTO workflows(id,spec,status,created_at,state_revision) VALUES(?,?,?,?,?)',
    [wf, JSON.stringify({ id: wf, sender: 'pm', steps: [] }), workflowStatus, AT, 5]);
  store.run('INSERT INTO tasks(id,status,envelope,created_at) VALUES(?,?,?,?)',
    [task, 'dispatched', JSON.stringify({ id: task, body: 'fixture' }), AT]);
  store.run('INSERT INTO runs(id,task_id,status,created_at,state_revision) VALUES(?,?,?,?,?)',
    [runId, task, runStatus, AT, 6]);
  store.run('INSERT INTO workflow_steps(id,workflow_id,step_index,status,task_id,run_id,created_at,state_revision) VALUES(?,?,?,?,?,?,?,?)',
    [step, wf, 0, stepStatus, task, stepRunId, AT, 8]);

  if (extraNonterminalStepOnSameRun) {
    store.run('INSERT INTO workflow_steps(id,workflow_id,step_index,status,task_id,run_id,created_at,state_revision) VALUES(?,?,?,?,?,?,?,?)',
      ['wf-orphan-step-2', wf, 1, 'running', task, runId, AT, 1]);
  }
  if (dispatchAttemptPhase) {
    store.run('INSERT INTO dispatch_attempts (id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, ?, ?)',
      ['attempt-orphan', task, runId, 'fake', dispatchAttemptPhase, '{}', AT, AT]);
  }
  if (withResult) {
    store.run('INSERT INTO results (id, record_version, run_id, agent, status, output, handoff, artifacts, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
      ['result-orphan', runId, 'worker', 'completed', 'x', '{}', '[]', AT]);
  }
  if (withNativeSession) {
    store.run('INSERT INTO native_sessions (id, record_version, backend, native_session_id, product, version, created_at, last_seen_at, lineage, native_reference, task_id, run_id, dispatch_attempt_id, transport, capability_fingerprint, reconciliation_status, reconciliation_result, diagnostic, reconciled_at, revision) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)',
      ['native-orphan', 'fake', 'native-sess-1', 'fake', '1', AT, AT, '{}', '{}', task, runId, null, 'stdio', 'fp', 'PENDING']);
  }

  return {
    store, dir, pm, wf, step, task, runId,
    close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('R3-4.2 positive: an eligible orphan run reconciles to FAILED/ORPHAN_UNKNOWN_EXTERNAL_OUTCOME with a durable audit row', async (t) => {
  const f = await orphanFixture();
  t.after(f.close);
  const agentBusRepository = new AgentBusRepository({ store: f.store });

  const facts = observeOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId });
  assert.equal(facts.linkedSteps.length, 1);
  assert.equal(facts.linkedSteps[0].runId, null, 'sanity: reproduces the historical linkage hole — step.run_id is null');
  const eligibility = evaluateOrphanReconciliationEligibility(facts, FULL_PROOF);
  assert.equal(eligibility.eligible, true, eligibility.refusals.join('; '));

  const result = reconcileOrphanAgentBusRun({
    store: f.store, agentBusRepository, runId: f.runId, operatorAck: true, runtimeOwnershipProof: FULL_PROOF, reason: 'test',
  });
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.error.code, 'ORPHAN_UNKNOWN_EXTERNAL_OUTCOME');
  assert.equal(f.store.get('SELECT status FROM runs WHERE id = ?', [f.runId]).status, 'failed');

  const audit = f.store.get('SELECT * FROM reconciliation_audit WHERE reconciliation_id = ?', [result.reconciliationId]);
  assert.ok(audit, 'a durable audit row was recorded using the EXISTING reconciliation_audit table');
  assert.equal(audit.classification, 'ORPHAN_UNKNOWN_EXTERNAL_OUTCOME');
  assert.equal(audit.repair_result, 'APPLIED');
  assert.equal(f.store.get('SELECT COUNT(*) c FROM reconciliation_audit').c, 1);

  // A second attempt (idempotency / no-replay): the run is now terminal —
  // refused, zero further mutation.
  assert.throws(
    () => reconcileOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId, operatorAck: true, runtimeOwnershipProof: FULL_PROOF }),
    (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_REFUSED' && /RUN_ALREADY_TERMINAL/.test(e.message),
  );
  assert.equal(f.store.get('SELECT COUNT(*) c FROM reconciliation_audit').c, 1, 'no duplicate audit row from the refused retry');
});

test('R3-4.2: no operator acknowledgement — refused before any observation/mutation, never a startup sweep', async (t) => {
  const f = await orphanFixture();
  t.after(f.close);
  const agentBusRepository = new AgentBusRepository({ store: f.store });
  assert.throws(
    () => reconcileOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId, operatorAck: false, runtimeOwnershipProof: FULL_PROOF }),
    (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_ACK_REQUIRED',
  );
  assert.equal(f.store.get('SELECT status FROM runs WHERE id = ?', [f.runId]).status, 'running');
  assert.equal(f.store.get('SELECT COUNT(*) c FROM reconciliation_audit').c, 0);
});

const NEGATIVE_CASES = [
  ['run already terminal', { runStatus: 'failed' }, /RUN_ALREADY_TERMINAL_OR_NOT_RUNNING/],
  ['result exists', { withResult: true }, /RESULT_ALREADY_EXISTS/],
  ['active/nonterminal parent workflow', { workflowStatus: 'running' }, /PARENT_WORKFLOW_NOT_TERMINAL/],
  ['nonterminal PM parent', { pmStatus: 'running' }, /PARENT_PM_RUN_NOT_TERMINAL/],
  ['nonterminal parent turn', { turnPhase: 'ACTION_STARTED' }, /PARENT_TURN_NOT_TERMINAL/],
  ['step links a different run', { stepRunId: 'run-someone-else' }, /STEP_LINKS_A_DIFFERENT_RUN/],
  ['step itself not terminal', { stepStatus: 'running' }, /PARENT_STEP_NOT_TERMINAL/],
  ['durable dispatch attempt indicates a recoverable/owned execution path (DISPATCH_STARTED)', { dispatchAttemptPhase: 'DISPATCH_STARTED' }, /DISPATCH_ATTEMPT_INDICATES_RECOVERABLE_PATH/],
  ['durable dispatch attempt indicates a recoverable/owned execution path (REMOTE_STARTED)', { dispatchAttemptPhase: 'REMOTE_STARTED' }, /DISPATCH_ATTEMPT_INDICATES_RECOVERABLE_PATH/],
  ['native session indicates active/ambiguous ownership', { withNativeSession: true }, /NATIVE_SESSION_INDICATES_ACTIVE_OR_AMBIGUOUS_OWNERSHIP/],
  ['run/task participates in another active workflow (another nonterminal step on the SAME run)', { extraNonterminalStepOnSameRun: true }, /RUN_REFERENCED_BY_ANOTHER_NONTERMINAL_STEP/],
];

for (const [name, overrides, expectedPattern] of NEGATIVE_CASES) {
  test(`R3-4.2 negative: ${name} — refused, zero mutation`, async (t) => {
    const f = await orphanFixture(overrides);
    t.after(f.close);
    const agentBusRepository = new AgentBusRepository({ store: f.store });
    const before = f.store.get('SELECT status FROM runs WHERE id = ?', [f.runId]).status;

    const facts = observeOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId });
    const eligibility = evaluateOrphanReconciliationEligibility(facts, FULL_PROOF);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.refusals.some((r) => expectedPattern.test(r)), `expected a refusal matching ${expectedPattern}, got: ${eligibility.refusals.join('; ')}`);

    assert.throws(
      () => reconcileOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId, operatorAck: true, runtimeOwnershipProof: FULL_PROOF }),
      (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_REFUSED' && expectedPattern.test(e.message),
    );
    assert.equal(f.store.get('SELECT status FROM runs WHERE id = ?', [f.runId]).status, before, 'no mutation occurred');
    assert.equal(f.store.get('SELECT COUNT(*) c FROM reconciliation_audit').c, 0, 'no audit row was written for a refused reconciliation');
  });
}

for (const [name, missingKey, expectedCode] of [
  ['no live runtime singleton/process ownership not proven', 'noLiveRuntimeSingleton', 'RUNTIME_SINGLETON_OWNERSHIP_NOT_PROVEN_ABSENT'],
  ['no live/unexpired worker claim/lease not proven', 'noLiveWorkerClaimOrLease', 'WORKER_CLAIM_OR_LEASE_NOT_PROVEN_ABSENT'],
  ['no open owner interaction/active work item/lease not proven', 'noOpenOwnerInteraction', 'OPEN_OWNER_INTERACTION_NOT_PROVEN_ABSENT'],
]) {
  test(`R3-4.2 negative: ${name} — refused, zero mutation`, async (t) => {
    const f = await orphanFixture();
    t.after(f.close);
    const agentBusRepository = new AgentBusRepository({ store: f.store });
    const proof = { ...FULL_PROOF, [missingKey]: false };
    const facts = observeOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId });
    const eligibility = evaluateOrphanReconciliationEligibility(facts, proof);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.refusals.includes(expectedCode));
    assert.throws(
      () => reconcileOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: f.runId, operatorAck: true, runtimeOwnershipProof: proof }),
      (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_REFUSED',
    );
    assert.equal(f.store.get('SELECT status FROM runs WHERE id = ?', [f.runId]).status, 'running');
  });
}

test('R3-4.2 negative: missing parent lineage entirely — safety cannot be proven, refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-r34-orphan-nolineage-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'fixture.sqlite') });
  await store.migrate();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  // A run/task pair exists (as AgentBus would create it) but with NO
  // workflow_steps row at all referencing it — no lineage to prove safety.
  const task = 'task-nolineage'; const runId = 'run-nolineage';
  store.run('INSERT INTO tasks(id,status,envelope,created_at) VALUES(?,?,?,?)', [task, 'dispatched', JSON.stringify({ id: task, body: 'x' }), AT]);
  store.run('INSERT INTO runs(id,task_id,status,created_at,state_revision) VALUES(?,?,?,?,?)', [runId, task, 'running', AT, 1]);

  const agentBusRepository = new AgentBusRepository({ store });
  const facts = observeOrphanAgentBusRun({ store, agentBusRepository, runId });
  const eligibility = evaluateOrphanReconciliationEligibility(facts, FULL_PROOF);
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.refusals.includes('NO_PARENT_WORKFLOW_STEP_LINEAGE_FOUND'));
  assert.throws(
    () => reconcileOrphanAgentBusRun({ store, agentBusRepository, runId, operatorAck: true, runtimeOwnershipProof: FULL_PROOF }),
    (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_REFUSED',
  );
  assert.equal(store.get('SELECT status FROM runs WHERE id = ?', [runId]).status, 'running');
});

test('R3-4.2 negative: unknown run id is refused, not silently treated as already reconciled', async (t) => {
  const f = await orphanFixture();
  t.after(f.close);
  const agentBusRepository = new AgentBusRepository({ store: f.store });
  assert.throws(
    () => reconcileOrphanAgentBusRun({ store: f.store, agentBusRepository, runId: 'run-does-not-exist', operatorAck: true, runtimeOwnershipProof: FULL_PROOF }),
    (e) => e instanceof OrphanReconciliationError && e.code === 'ORPHAN_RECONCILIATION_REFUSED' && /RUN_NOT_FOUND/.test(e.message),
  );
});
