import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { SqlitePersistenceStore } from '../../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../../src/persistence/repositories/agentbus-repository.mjs';
import { NativeSessionRepository } from '../../src/persistence/repositories/native-session-repository.mjs';
import { WorkflowRepository } from '../../src/persistence/repositories/workflow-repository.mjs';
import { PeerRepository } from '../../src/persistence/repositories/peer-repository.mjs';
import { PmRepository } from '../../src/persistence/repositories/pm-repository.mjs';
import { HealthRepository } from '../../src/persistence/repositories/health-repository.mjs';
import { AuditRepository } from '../../src/persistence/repositories/audit-repository.mjs';
import { classifyDispatchAttempt } from '../../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { NativeSessionReconciler } from '../../src/session/native-session-reconciler.mjs';
import { nativeProfileFingerprint } from '../../src/session/native-profile.mjs';
import { DurablePmRuntime } from '../../src/pm/durable-pm-runtime.mjs';
import { createPmRequest } from '../../src/pm/pm-contracts.mjs';
import { createWorkflowRun } from '../../src/workflow/workflow-contracts.mjs';
import { createConversationRecord, createPeerHopRecord } from '../../src/peer/peer-contracts.mjs';
import { DurableBackendHealthRegistry } from '../../src/orchestration/durable-backend-health-registry.mjs';
import { BACKEND_FAILURE_CLASSIFICATION } from '../../src/orchestration/backend-health-registry.mjs';
import { DurableOrchestrationAuditTrace } from '../../src/orchestration/durable-orchestration-audit-trace.mjs';

const [scenario, mode, dbPath, ledgerPath] = process.argv.slice(2);
const now = '2026-08-18T00:00:00.000Z';
const ids = { task: `task-${scenario}`, run: `run-${scenario}`, attempt: `attempt-${scenario}`, result: `result-${scenario}` };

function ledger(kind, identity = {}) {
  const fd = openSync(ledgerPath, 'a');
  try { writeSync(fd, `${JSON.stringify({ kind, scenario, ...identity })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
function task() { return { id: ids.task, sender: 'pm', recipient: 'alpha', body: 'fixture-body', context: {}, expectedOutput: null, createdAt: now }; }
function run() { return { id: ids.run, taskId: ids.task, agent: 'alpha', status: 'running', startedAt: now, completedAt: null, error: null }; }
function result() { return { id: ids.result, taskId: ids.task, runId: ids.run, agent: 'alpha', status: 'completed', output: 'fixture-ok', handoff: null, artifacts: [], completedAt: now }; }
function profile(bridge) { return { backend: 'alpha', product: 'Fixture CLI', version: '1.0.0', transport: 'local-fixture', capabilities: { resume_existing: 'PROVED' }, bridge }; }
function marker(extra = {}) { process.send?.({ type: 'CRASH_POINT', scenario, pid: process.pid, ...extra }); setInterval(() => {}, 60_000); }
function report(data) { return new Promise((resolve, reject) => process.send?.({ type: 'RESULT', scenario, data }, (error) => error ? reject(error) : resolve())); }

const store = new SqlitePersistenceStore();
await store.open({ path: dbPath });
await store.migrate();
const agent = new AgentBusRepository({ store });
const persisted = () => ({ attempt: agent.getDispatchAttempt(ids.attempt), run: agent.getRun(ids.run), result: agent.getResultByRun(ids.run) });
const classify = (resumeExisting = 'UNPROVEN') => classifyDispatchAttempt({ ...persisted(), capabilities: { resumeExisting } });

async function setupDispatch(phase) {
  agent.prepareDispatch({ task: task(), run: run(), attemptId: ids.attempt, backend: 'alpha' });
  if (phase === 'INTENT_COMMITTED') return;
  agent.startDispatch(ids.attempt);
  if (phase === 'DISPATCH_STARTED') return;
  agent.recordNativeStart({ attemptId: ids.attempt, backend: 'alpha', nativeSessionId: `native-${scenario}`, product: 'Fixture CLI', version: '1.0.0', observedAt: now });
}
function prepareLinked(prefix, start = false) {
  const linked = { task: `task-${prefix}`, run: `run-${prefix}`, attempt: `attempt-${prefix}`, result: `result-${prefix}` };
  agent.prepareDispatch({ task: { ...task(), id: linked.task }, run: { ...run(), id: linked.run, taskId: linked.task }, attemptId: linked.attempt, backend: 'alpha' });
  if (start) agent.startDispatch(linked.attempt);
  return linked;
}

if (mode === 'setup') {
  if (scenario === 'A') await setupDispatch('INTENT_COMMITTED');
  if (scenario === 'B') { await setupDispatch('DISPATCH_STARTED'); ledger('adapter', ids); }
  if (scenario === 'C') { await setupDispatch('REMOTE_STARTED'); ledger('adapter', ids); }
  if (scenario === 'D' || scenario === 'E') {
    await setupDispatch('REMOTE_STARTED'); ledger('adapter', ids);
    const bridge = { async resume() { return { status: 'resumed', usable: true }; } }; const current = profile(bridge);
    const native = new NativeSessionRepository({ store, knownBackends: ['alpha'] });
    native.capture({ id: `native-record-${scenario}`, backend: 'alpha', nativeSessionId: `native-${scenario}`, nativeReference: { nativeSessionId: `native-${scenario}` }, product: current.product, version: current.version, transport: current.transport, capabilityFingerprint: nativeProfileFingerprint(current), taskId: ids.task, runId: ids.run, dispatchAttemptId: ids.attempt, lineage: {}, capturedAt: now });
    if (scenario === 'E') { native.startReconcile(`native-record-${scenario}`, now); ledger('native_resume', { nativeSessionId: `native-${scenario}` }); }
  }
  if (scenario === 'F') {
    await setupDispatch('DISPATCH_STARTED'); ledger('adapter', ids); ledger('external_result', ids);
    store.transactionSync(({ run: execute }) => {
      execute('UPDATE runs SET status = ?, completed_at = ? WHERE id = ?', ['completed', now, ids.run]);
      execute('INSERT INTO results (id, record_version, run_id, agent, status, output, handoff, artifacts, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)', [ids.result, ids.run, 'alpha', 'completed', 'fixture-ok', JSON.stringify(result()), '[]', now]);
    });
  }
  if (scenario === 'G') { await setupDispatch('DISPATCH_STARTED'); ledger('adapter', ids); agent.terminalCommitSuccess({ runId: ids.run, result: result() }); }
  if (scenario === 'H') {
    const pm = new PmRepository({ store }); const workflows = new WorkflowRepository({ store });
    const request = createPmRequest({ id: 'request-H', objective: 'recover terminal workflow', context: {} });
    pm.create(request, { id: 'pmrun-H', driver: 'fixture-driver', startedAt: now });
    const workflow = createWorkflowRun({ id: 'workflow-H', steps: [{ recipient: 'alpha', body: 'work' }] });
    pm.commitDecision('pmrun-H', { id: 'turn-H', turnIndex: 0, decision: { type: 'workflow', spec: { id: workflow.id, steps: [{ recipient: 'alpha', body: 'work' }] } }, actionType: 'workflow', actionId: workflow.id, createdAt: now });
    pm.markActionStarted('pmrun-H', 0); workflows.createWorkflow(workflow); workflows.updateWorkflowStatus(workflow.id, { status: 'running' }); workflows.updateStepStatus(workflow.id, workflow.steps[0].id, { status: 'running' }); ledger('workflow_action', { actionId: workflow.id }); workflows.updateStepStatus(workflow.id, workflow.steps[0].id, { status: 'completed', taskId: 'task-H-action', runId: 'run-H-action', resultId: 'result-H-action' }); workflows.updateWorkflowStatus(workflow.id, { status: 'completed' });
  }
  if (scenario === 'I') {
    const workflows = new WorkflowRepository({ store }); const peers = new PeerRepository({ store });
    const safe = createWorkflowRun({ id: 'workflow-I-safe', steps: [{ recipient: 'alpha', body: 'done' }, { recipient: 'beta', body: 'safe' }] }); workflows.createWorkflow(safe); workflows.updateWorkflowStatus(safe.id, { status: 'running' }); workflows.updateStepStatus(safe.id, safe.steps[0].id, { status: 'running' }); workflows.updateStepStatus(safe.id, safe.steps[0].id, { status: 'completed', taskId: 'wt0', runId: 'wr0', resultId: 'wz0' }); ledger('workflow_committed', { stepId: safe.steps[0].id }); const wfSafe = prepareLinked('I-wf-safe'); workflows.updateStepStatus(safe.id, safe.steps[1].id, { status: 'running', taskId: wfSafe.task, runId: wfSafe.run });
    const ambiguous = createWorkflowRun({ id: 'workflow-I-ambiguous', steps: [{ recipient: 'alpha', body: 'active' }] }); workflows.createWorkflow(ambiguous); workflows.updateWorkflowStatus(ambiguous.id, { status: 'running' }); const wfAmbiguous = prepareLinked('I-wf-ambiguous', true); workflows.updateStepStatus(ambiguous.id, ambiguous.steps[0].id, { status: 'running', taskId: wfAmbiguous.task, runId: wfAmbiguous.run }); ledger('workflow_active', { stepId: ambiguous.steps[0].id });
    const conversation = createConversationRecord({ id: 'peer-I-safe', createdAt: now }); peers.createConversation(conversation); peers.updateConversationStatus(conversation.id, { status: 'running' }); const hop0 = createPeerHopRecord({ id: 'hop-I-0', conversationId: conversation.id, index: 0, from: 'alpha', to: 'beta', createdAt: now }); peers.createHop(hop0); peers.updateHopStatus(hop0.id, { status: 'running' }); ledger('peer_committed', { hopId: hop0.id }); peers.updateHopStatus(hop0.id, { status: 'completed', completedAt: now }); const peerSafe = prepareLinked('I-peer-safe');
    const ambConv = createConversationRecord({ id: 'peer-I-ambiguous', createdAt: now }); peers.createConversation(ambConv); peers.updateConversationStatus(ambConv.id, { status: 'running' }); const active = createPeerHopRecord({ id: 'hop-I-active', conversationId: ambConv.id, index: 0, from: 'alpha', to: 'beta', createdAt: now }); peers.createHop(active); const peerAmbiguous = prepareLinked('I-peer-ambiguous', true); peers.updateHopStatus(active.id, { status: 'running', recipientTaskId: peerAmbiguous.task, recipientRunId: peerAmbiguous.run }); ledger('peer_active', { hopId: active.id });
  }
  if (scenario === 'J') {
    const health = new DurableBackendHealthRegistry({ repository: new HealthRepository({ store }), clock: () => 100_000, freshnessMs: 1_000, cooldownMs: 10_000 }); health.recordSuccess('codex'); health.recordFailure('grok', { classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE });
    const audits = new AuditRepository({ store }); const open = DurableOrchestrationAuditTrace.create({ repository: audits, traceId: 'trace-J-open', clock: () => now }); open.record('before.restart', { stable: true }); const sealed = DurableOrchestrationAuditTrace.create({ repository: audits, traceId: 'trace-J-sealed', clock: () => now }); sealed.record('before.seal', {}); sealed.seal({ done: true });
  }
  await store.close(); marker({ boundary: scenario });
} else {
  let data;
  if (scenario === 'A') { const recovery = classify(); ledger('adapter', ids); agent.startDispatch(ids.attempt); agent.terminalCommitSuccess({ runId: ids.run, result: result() }); data = { classification: recovery.classification, attempt: agent.getDispatchAttempt(ids.attempt), phase: agent.getDispatchAttempt(ids.attempt).phase, run: agent.getRun(ids.run), results: agent.getResultByRun(ids.run) ? 1 : 0 };
  } else if (scenario === 'B' || scenario === 'C' || scenario === 'F' || scenario === 'G') { data = { classification: classify().classification, phase: persisted().attempt.phase, resultCount: agent.getResultByRun(ids.run) ? 1 : 0 };
  } else if (scenario === 'D' || scenario === 'E') {
    const recovery = classify('PROVED'); const native = new NativeSessionRepository({ store, knownBackends: ['alpha'] }); let calls = 0; const bridge = { async resume(reference) { calls += 1; ledger('native_resume', reference); return { status: 'resumed', usable: true, nativeSessionId: reference.nativeSessionId }; } }; const current = profile(bridge); const reconciled = await new NativeSessionReconciler({ repository: native, profileResolver: () => current }).reconcileGate3({ attempt: persisted().attempt, recovery }); if (scenario === 'D' && reconciled.status === 'RECONCILED') agent.terminalCommitSuccess({ runId: ids.run, result: result() }); data = { classification: recovery.classification, reconciliation: reconciled.status, calls, phase: agent.getDispatchAttempt(ids.attempt).phase, resultCount: agent.getResultByRun(ids.run) ? 1 : 0 };
  } else if (scenario === 'H') {
    const pm = new PmRepository({ store }); const workflows = new WorkflowRepository({ store }); const decideTurns = []; const driver = { name: 'fixture-driver', async decide(input) { decideTurns.push(input.turn); return { type: 'finish', output: 'recovered', data: null }; } };
    const workflowRunner = { calls: [], result(id) { const value = workflows.getWorkflow(id); return value ? { workflowId: id, status: value.status, finalStepId: value.steps.at(-1)?.id, finalTaskId: value.steps.at(-1)?.taskId, finalRunId: value.steps.at(-1)?.runId, finalResult: { id: value.steps.at(-1)?.resultId, output: 'terminal' }, error: value.error } : null; }, async run(spec) { this.calls.push(spec.id); throw new Error('must not rerun'); } };
    const peerRelay = { result() { return null; }, getConversation() { return null; }, createConversation() {}, async exchange() { throw new Error('unused'); } };
    const out = await new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository: pm }).resume('pmrun-H'); data = { status: out.status, decideTurns, workflowCalls: workflowRunner.calls, actionId: pm.load('pmrun-H').turns[0].actionId, outcome: pm.load('pmrun-H').turns[0].outcome };
  } else if (scenario === 'I') {
    const workflows = new WorkflowRepository({ store }); const peers = new PeerRepository({ store }); const safe = workflows.getWorkflow('workflow-I-safe'); const committedBefore = safe.steps[0]; const pending = safe.steps[1]; const wfSafeAttempt = agent.getDispatchAttemptForRun(pending.runId); const wfSafeClass = classifyDispatchAttempt({ attempt: wfSafeAttempt, run: agent.getRun(pending.runId), result: agent.getResultByRun(pending.runId) }); ledger('workflow_safe_continue', { stepId: pending.id }); agent.startDispatch(wfSafeAttempt.id); agent.terminalCommitSuccess({ runId: pending.runId, result: { ...result(), id: 'result-I-wf-safe', taskId: pending.taskId, runId: pending.runId } }); workflows.updateStepStatus(safe.id, pending.id, { status: 'completed', resultId: 'result-I-wf-safe' }); workflows.updateWorkflowStatus(safe.id, { status: 'completed' }); const ambiguousWorkflow = workflows.getWorkflow('workflow-I-ambiguous'); const wfAmbiguousAttempt = agent.getDispatchAttemptForRun(ambiguousWorkflow.steps[0].runId); const wfAmbiguousClass = classifyDispatchAttempt({ attempt: wfAmbiguousAttempt, run: agent.getRun(ambiguousWorkflow.steps[0].runId), result: null });
    const conv = peers.getConversation('peer-I-safe'); const peerSafe = agent.getDispatchAttempt('attempt-I-peer-safe'); const peerSafeClass = classifyDispatchAttempt({ attempt: peerSafe, run: agent.getRun(peerSafe.runId), result: null }); ledger('peer_safe_continue', { attemptId: peerSafe.id }); agent.startDispatch(peerSafe.id); agent.terminalCommitSuccess({ runId: peerSafe.runId, result: { ...result(), id: 'result-I-peer-safe', taskId: peerSafe.taskId, runId: peerSafe.runId } }); const hop1 = createPeerHopRecord({ id: 'hop-I-1', conversationId: conv.id, index: 1, from: 'beta', to: 'alpha', createdAt: now }); peers.createHop(hop1); peers.updateHopStatus(hop1.id, { status: 'running', recipientTaskId: peerSafe.taskId, recipientRunId: peerSafe.runId }); peers.updateHopStatus(hop1.id, { status: 'completed', recipientResultId: 'result-I-peer-safe', completedAt: now }); peers.updateConversationStatus(conv.id, { status: 'completed' }); const activePeer = peers.getHop('hop-I-active'); const peerAmbiguousAttempt = agent.getDispatchAttemptForRun(activePeer.recipientRunId); const peerAmbiguousClass = classifyDispatchAttempt({ attempt: peerAmbiguousAttempt, run: agent.getRun(activePeer.recipientRunId), result: null }); data = { committedStepStatus: committedBefore.status, safeStepStatus: workflows.getWorkflow(safe.id).steps[1].status, ambiguousStepStatus: ambiguousWorkflow.steps[0].status, peerCommittedStatus: peers.getHop('hop-I-0').status, peerSafeStatus: peers.getHop('hop-I-1').status, peerAmbiguousStatus: activePeer.status, wfSafeClass: wfSafeClass.classification, wfAmbiguousClass: wfAmbiguousClass.classification, peerSafeClass: peerSafeClass.classification, peerAmbiguousClass: peerAmbiguousClass.classification };
  } else if (scenario === 'J') {
    const healthRepo = new HealthRepository({ store }); const before = Object.fromEntries(healthRepo.listRaw().map((x) => [x.backend, x.revision])); const health = new DurableBackendHealthRegistry({ repository: healthRepo, clock: () => 105_000, freshnessMs: 1_000, cooldownMs: 10_000 }); const audits = new AuditRepository({ store }); const old = audits.loadTrace('trace-J-open').entries.map((x) => JSON.stringify(x)); const trace = DurableOrchestrationAuditTrace.open({ repository: audits, traceId: 'trace-J-open', clock: () => '2026-08-18T00:01:00.000Z' }); trace.record('after.restart', { stable: true }); const after = audits.loadTrace('trace-J-open'); const sealed = DurableOrchestrationAuditTrace.open({ repository: audits, traceId: 'trace-J-sealed' }); let sealedRejected = false; try { sealed.record('forbidden', {}); } catch { sealedRejected = true; } data = { codex: health.get('codex'), grok: health.get('grok'), revisionsUnchanged: healthRepo.listRaw().every((x) => before[x.backend] === x.revision), sequences: after.entries.map((x) => x.sequence), oldRowsUnchanged: old.every((x, i) => x === JSON.stringify(after.entries[i])), sealed: sealed.sealed, sealedRejected };
  }
  await store.close(); await report(data); process.disconnect();
}
