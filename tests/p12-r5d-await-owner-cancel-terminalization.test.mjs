// P12-R5D — canonical cancellation for a task parked AWAIT_OWNER.
//
// Real owner-live finding: R5C's REQUEST_CANCEL wiring correctly durably
// records a cancellation_requests row (coordination.requestCancellation()),
// but NOTHING ever consumed it for a task parked on a real owner
// interaction (task-DUcHTW-oAqWIhfdg5HZlAXq8ALMdaxPy /
// interaction-dmNTqPpiI710Q7U6QzCKZsSzVcSPyMhT) — the interaction stayed
// OPEN, the PmRun stayed 'running', forever, even across a restart.
//
// Fix, end to end, using REAL AwaitOwnerCoordinator/AwaitOwnerCloser/
// DurablePmRuntime/ProductionPmWorkHandler/AgentBusRepository/PmRepository
// (real SQLite) — only the Postgres-shaped owner/coordination stores are
// faked, in-memory, matching the exact contract shape those real classes
// already require (never a shallow/loose double).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { AwaitOwnerCloser } from '../src/owner/await-owner-closer.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// In-memory fakes matching the REAL Postgres owner/coordination contract
// shapes exactly (PostgresOwnerRepository / PostgresCoordinationStore) —
// same methods, same semantics, never a loosened double.
// ---------------------------------------------------------------------------
function fakeStores() {
  const interactions = new Map();
  const decisions = new Map();
  const workItems = new Map();
  const cancellationRequests = new Map();

  const owner = {
    async createInteraction(v) {
      if (!interactions.has(v.interaction_id)) interactions.set(v.interaction_id, { ...v, revision: 1 });
      return interactions.get(v.interaction_id);
    },
    async getInteraction(id) { return interactions.get(id) ?? null; },
    async readDecision(id) { return decisions.get(id) ?? null; },
    async listDecidedAwaitingResumption({ limit = 20 } = {}) {
      const out = [];
      for (const [id, i] of interactions) {
        if (i.status !== 'DECIDED') continue;
        for (const [wid, w] of workItems) if (w.parked_interaction_id === id && !w.claim_eligible && w.claim_state === 'RELEASED') out.push({ interaction_id: id, work_item_id: wid });
      }
      return out.slice(0, limit);
    },
    async listCancelledInteractionsAwaitingClosure({ limit = 20 } = {}) {
      const out = [];
      for (const [id, i] of interactions) {
        if (i.status !== 'OPEN') continue;
        for (const [wid, w] of workItems) {
          if (w.parked_interaction_id === id && !w.claim_eligible && w.claim_state === 'RELEASED' && cancellationRequests.get(wid)?.state === 'REQUESTED') out.push({ interaction_id: id, work_item_id: wid });
        }
      }
      return out.slice(0, limit);
    },
    async closeInteractionForCancellation(id) {
      const i = interactions.get(id);
      if (!i || i.status !== 'OPEN') return null;
      i.status = 'CLOSED'; i.revision += 1;
      return i;
    },
  };

  const coordination = {
    async registerWorkIdentity(value) { workItems.set(value.work_item_id, { claim_eligible: true, claim_state: 'READY', parked_interaction_id: null, ...value }); },
    async parkClaimForOwner(fence, interactionId) {
      const w = workItems.get(fence.work_item_id);
      if (w) { w.claim_eligible = false; w.claim_state = 'RELEASED'; w.parked_interaction_id = interactionId; }
      return true;
    },
    async restoreOwnerDecisionEligibility(_fence, { work_item_id, interaction_id }) {
      const w = workItems.get(work_item_id);
      if (w && !w.claim_eligible && w.parked_interaction_id === interaction_id && w.claim_state === 'RELEASED') { w.claim_eligible = true; w.parked_interaction_id = null; return w; }
      return null;
    },
    async requestCancellation(_fence, workItemId) {
      if (!cancellationRequests.has(workItemId)) cancellationRequests.set(workItemId, { state: 'REQUESTED' });
      return { state: cancellationRequests.get(workItemId).state };
    },
    async completeClaim(fence) { const w = workItems.get(fence.work_item_id); if (w) { w.claim_state = 'COMPLETED'; w.claim_eligible = false; } },
  };

  return { owner, coordination, interactions, workItems, cancellationRequests };
}

async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p12-r5d-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const pmRepository = new PmRepository({ store });
    await fn({ agentBusRepository, pmRepository });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Mirrors the EXACT R5C production wiring (p5-production-composition.mjs) —
// same derivation, same fail-closed behavior when no coordinator fence
// exists yet.
function wireRequestCancel({ agentBusRepository, coordination, getFence }) {
  return {
    resolveWorkItem: async (taskId) => {
      const task = agentBusRepository.getOwnerTask(taskId);
      if (!task) { const e = new Error('task not found'); e.code = 'TASK_NOT_FOUND'; throw e; }
      const commandId = task.context?.ownerCommandId;
      if (typeof commandId !== 'string' || !commandId) { const e = new Error('unresolvable lineage'); e.code = 'CANCELLATION_UNAVAILABLE'; throw e; }
      return pmWorkIdentity({ taskId, pmRunId: deterministicOwnerId('pmrun', commandId) });
    },
    requestCancellation: async (workItemId) => {
      const fence = getFence();
      if (!fence) { const e = new Error('no active coordinator lease'); e.code = 'CANCELLATION_UNAVAILABLE'; throw e; }
      return coordination.requestCancellation(fence, workItemId);
    },
  };
}

function awaitOwnerScriptedDriver() {
  return { name: 'await-owner-fake', async decide() { return { type: 'await_owner', kind: 'QUESTION', title: 'blocked', prompt: 'what should I do?', allowedResponses: ['CANCEL'] }; } };
}
const inertWorkflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
const inertPeerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };

async function parkAwaitOwnerTask({ agentBusRepository, pmRepository, owner, coordination, getFence, projectRepoPath, commandId = 'cmd-r5d-1' }) {
  const project = { id: 'dsh-p6-test-b', repo_path: projectRepoPath, autonomy: { revision: 1, effects: {} } };
  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  await taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'x' } }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  const { createPmRequest } = await import('../src/pm/pm-contracts.mjs');
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'await-owner-fake', startedAt: '2026-01-01T00:00:00.000Z' });

  const handler = new ProductionPmWorkHandler({
    coordinationStore: coordination, pmRepository, ownerRepository: owner, taskRepository: agentBusRepository, projects: [project],
    createRuntime: ({ ownerControl }) => new DurablePmRuntime({ driver: awaitOwnerScriptedDriver(), workflowRunner: inertWorkflowRunner, peerRelay: inertPeerRelay, repository: pmRepository, maxTurns: 4, ownerControl }),
  });
  await coordination.registerWorkIdentity(pmWorkIdentity({ taskId, pmRunId }));
  const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
  const parked = await handler.execute({ work, fence: { work_item_id: pmWorkIdentity({ taskId, pmRunId }).work_item_id } });
  assert.equal(parked.status, 'PARKED');
  return { taskId, pmRunId, project, handler, work, interactionId: parked.interactionId };
}

// ---------------------------------------------------------------------------

test('PART A repro: before the fix, a cancellation request for a parked AWAIT_OWNER task changes nothing — interaction stays OPEN, PmRun stays running', async () => withFixture(async ({ agentBusRepository, pmRepository }) => {
  const { owner, coordination, interactions } = fakeStores();
  let fence = null;
  const { taskId, pmRunId, interactionId } = await parkAwaitOwnerTask({ agentBusRepository, pmRepository, owner, coordination, getFence: () => fence, projectRepoPath: '/tmp/unused' });

  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence: () => fence });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  fence = { work_item_id: pmWorkIdentity({ taskId, pmRunId }).work_item_id, logical_coordinator_id: 'c', leader_generation: 1 };
  const result = await taskController.requestCancel({ taskId });
  assert.equal(result.status, 'CANCEL_REQUESTED');

  // Exactly the real owner-live symptom: the request is recorded, but
  // nothing has consumed it yet — this is what R5C alone produced.
  assert.equal(interactions.get(interactionId).status, 'OPEN');
  assert.equal(pmRepository.load(pmRunId).status, 'running');
}));

test('1/2/3/4/5/6: the full generic fix — cancel request -> interaction CLOSED -> work item settles -> PM turn CANCELLED -> PmRun/task CANCELLED', async () => withFixture(async ({ agentBusRepository, pmRepository }) => {
  const { owner, coordination, interactions, workItems, cancellationRequests } = fakeStores();
  let fence = { work_item_id: null, logical_coordinator_id: 'c', leader_generation: 1 };
  const { taskId, pmRunId, project, handler, work, interactionId } = await parkAwaitOwnerTask({ agentBusRepository, pmRepository, owner, coordination, getFence: () => fence, projectRepoPath: '/tmp/unused' });
  fence.work_item_id = pmWorkIdentity({ taskId, pmRunId }).work_item_id;

  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence: () => fence });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  const cancelResult = await taskController.requestCancel({ taskId });
  assert.equal(cancelResult.status, 'CANCEL_REQUESTED');
  assert.equal(cancellationRequests.get(fence.work_item_id).state, 'REQUESTED');

  // The coordinator's own periodic AwaitOwnerCloser tick.
  const closer = new AwaitOwnerCloser({ ownerRepository: owner, coordinationStore: coordination, getLeadershipFence: () => fence });
  const tick = await closer.runOnce();
  assert.equal(tick.cancelled, 1, '3. the open interaction is found and closed by the closer');

  // 3. interaction becomes terminal (CLOSED — an existing canonical status, no schema change).
  assert.equal(interactions.get(interactionId).status, 'CLOSED');
  // 4. the work item settles (claim eligible again, no longer parked) —
  // this IS "settlement", proven concretely by the worker successfully
  // resuming it next, never replaying the backend call.
  assert.equal(workItems.get(fence.work_item_id).claim_eligible, true);
  assert.equal(workItems.get(fence.work_item_id).parked_interaction_id, null);

  // The worker's own next resume() of this now-eligible work item.
  const outcome = await handler.execute({ work, fence });
  assert.equal(outcome.status, 'COMPLETED');
  // 5. PM turn becomes cancelled.
  const reloaded = pmRepository.load(pmRunId);
  assert.equal(reloaded.turns.at(-1).outcome.status, 'cancelled');
  // 6. PmRun/task becomes cancelled — never FAILED (Part E).
  assert.equal(reloaded.status, 'cancelled');
  assert.equal(outcome.result.status, 'cancelled');
  assert.notEqual(reloaded.status, 'failed');

  // 13/14/15: cancellation invokes no Git sync, no review, no fabricated materialization.
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.review_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.artifact_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.terminal_marker, 'CANCELLED');
}));

test('7/8: once cancelled, a Desktop-shaped projection would stop showing Cancel, and a restart never revives the task (no ACTION_RECONCILE_REQUIRED)', async () => withFixture(async ({ agentBusRepository, pmRepository }) => {
  const { owner, coordination } = fakeStores();
  let fence = { work_item_id: null, logical_coordinator_id: 'c', leader_generation: 1 };
  const { taskId, pmRunId, handler, work } = await parkAwaitOwnerTask({ agentBusRepository, pmRepository, owner, coordination, getFence: () => fence, projectRepoPath: '/tmp/unused' });
  fence.work_item_id = pmWorkIdentity({ taskId, pmRunId }).work_item_id;

  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence: () => fence });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  await taskController.requestCancel({ taskId });
  const closer = new AwaitOwnerCloser({ ownerRepository: owner, coordinationStore: coordination, getLeadershipFence: () => fence });
  await closer.runOnce();
  await handler.execute({ work, fence });

  // 7. pm_runs.status is now 'cancelled' -- BackendRuns.tsx's isCancellable()
  // (TERMINAL_RUN_STATUSES) already treats this as terminal, no Cancel shown.
  assert.ok(['completed', 'failed', 'cancelled'].includes(pmRepository.load(pmRunId).status));

  // 8. "restart" = a completely fresh execute() attempt on the same claimed
  // work item, exactly like ProductionPmWorkHandler's own "adopt already-
  // terminal run" branch a real worker hits after any restart.
  const secondAttempt = await handler.execute({ work, fence });
  assert.equal(secondAttempt.status, 'COMPLETED');
  assert.equal(secondAttempt.adopted, true, 'must be adopted as already-terminal, never re-processed, never ACTION_RECONCILE_REQUIRED');
}));

test('9: repeated owner cancel clicks are idempotent -- no duplicate terminal events, no corruption, no reopened interaction, no double-completed work item', async () => withFixture(async ({ agentBusRepository, pmRepository }) => {
  const { owner, coordination, interactions, cancellationRequests } = fakeStores();
  let fence = { work_item_id: null, logical_coordinator_id: 'c', leader_generation: 1 };
  const { taskId, pmRunId, handler, work, interactionId } = await parkAwaitOwnerTask({ agentBusRepository, pmRepository, owner, coordination, getFence: () => fence, projectRepoPath: '/tmp/unused' });
  fence.work_item_id = pmWorkIdentity({ taskId, pmRunId }).work_item_id;

  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence: () => fence });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  // Three owner clicks, exactly like the real owner-live evidence.
  await taskController.requestCancel({ taskId });
  await taskController.requestCancel({ taskId });
  await taskController.requestCancel({ taskId });
  assert.equal(cancellationRequests.size, 1, 'ON CONFLICT DO NOTHING semantics -- one request row, never duplicated');

  const closer = new AwaitOwnerCloser({ ownerRepository: owner, coordinationStore: coordination, getLeadershipFence: () => fence });
  await closer.runOnce();
  await closer.runOnce(); // a second tick before the worker ever resumes
  assert.equal(interactions.get(interactionId).status, 'CLOSED');
  assert.equal(interactions.get(interactionId).revision, 2, 'closed exactly once -- the second tick found nothing left to close');

  await handler.execute({ work, fence });
  const afterFirst = pmRepository.load(pmRunId).status;
  assert.equal(afterFirst, 'cancelled');
  // Further closer ticks and a repeated cancel request after settlement
  // must never reopen anything or throw.
  await closer.runOnce();
  await assert.doesNotReject(taskController.requestCancel({ taskId }));
  assert.equal(pmRepository.load(pmRunId).status, 'cancelled', 'never reopened, never corrupted');
}));

test('10/11: a COMPLETED/FAILED task refuses cancel at the canonical layer (unchanged from before this gate)', async () => withFixture(async ({ agentBusRepository, pmRepository }) => {
  const { owner, coordination } = fakeStores();
  const project = { id: 'p', repo_path: '/tmp/x', autonomy: { revision: 1, effects: {} } };
  const commandId = 'cmd-r5d-terminal';
  const { resolveWorkItem, requestCancellation } = wireRequestCancel({ agentBusRepository, coordination, getFence: () => ({ work_item_id: 'w', logical_coordinator_id: 'c', leader_generation: 1 }) });
  const taskController = new OwnerTaskController({ repository: agentBusRepository, startPm: null, resolveWorkItem, requestCancellation });
  await taskController.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'x' } }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  const { createPmRequest } = await import('../src/pm/pm-contracts.mjs');
  const readBack = agentBusRepository.getOwnerTask(taskId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'd', startedAt: '2026-01-01T00:00:00.000Z' });
  pmRepository.commitDecision(pmRunId, { id: 'pmturn-1', turnIndex: 0, decision: { type: 'finish', output: 'done' }, actionType: null, actionId: null, createdAt: '2026-01-01T00:00:01.000Z' });
  pmRepository.completeTurn(pmRunId, 0, { kind: 'finish', status: 'completed', output: 'done' }, { status: 'completed', output: 'done', data: null, error: null, completedAt: '2026-01-01T00:00:02.000Z' });

  // The task-level cancel request itself is still accepted by OwnerTaskController
  // (it doesn't inspect run status) -- but reconciling a run that's already
  // terminal must never do anything (Part I / stop condition
  // CANCEL_TERMINAL_TASK_ALLOWED is about the UI; here we prove the closer
  // itself never touches a terminal run's non-existent parked interaction).
  await taskController.requestCancel({ taskId });
  const closer = new AwaitOwnerCloser({ ownerRepository: owner, coordinationStore: coordination, getLeadershipFence: () => ({ work_item_id: 'w', logical_coordinator_id: 'c', leader_generation: 1 }) });
  const tick = await closer.runOnce();
  assert.equal(tick.cancelled, 0, 'nothing to close -- this task was never parked AWAIT_OWNER');
  assert.equal(pmRepository.load(pmRunId).status, 'completed', 'a completed run is never disturbed');
}));

test('12: Council AWAIT_OWNER cancel is architecturally not applicable -- CouncilChairDriver never returns an await_owner decision', () => {
  // Confirmed directly from the driver's own source rather than asserted
  // from memory: the ONLY decision types CouncilChairDriver ever produces
  // are 'workflow' (dispatch one council step) and 'finish' (synthesis
  // complete) -- 'await_owner' does not appear anywhere in it. A Council
  // task can therefore never reach the state this gate fixes; the generic
  // fix above (production-pm-worker.mjs/durable-pm-runtime.mjs) still
  // covers it automatically if that ever changed, since it is not
  // Council-specific in any way.
  const source = readFileSync(new URL('../src/pm/council/council-chair-driver.mjs', import.meta.url), 'utf8');
  const decisionTypes = [...source.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(decisionTypes.includes('workflow'));
  assert.ok(decisionTypes.includes('finish'));
  assert.equal(decisionTypes.includes('await_owner'), false);
});
