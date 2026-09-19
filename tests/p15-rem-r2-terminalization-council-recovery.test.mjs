/**
 * P15-REM-R2 — Durable Failure Terminalization + Council Recovery.
 *
 * Regression evidence for the two primary REM-R2 findings:
 *   P15-C-001 — Council step state was process-local (in-memory); a restart
 *     during an ACTION_STARTED council step reached ACTION_RECONCILE_REQUIRED
 *     forever instead of a deterministic recovery.
 *   P15-C-006 — Typed failures escaping ProductionPmWorkHandler#execute()
 *     bypassed durable terminalization and relied on lease expiry, causing a
 *     silent, unbounded reclaim/retry loop (docs/p12/06B_*.md's TEST 4 live
 *     incident).
 *
 * Every scenario below reproduces the REAL pre-fix mechanism first (RED —
 * the in-memory-only path is still reachable today by simply omitting
 * `stepState`/going through the real thrown-error path, so it stays a live,
 * permanent regression guard rather than a one-time snapshot) before
 * asserting the fixed (GREEN) behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { normalizeCouncilSpec, councilMaxTurns } from '../src/pm/council/council-contracts.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime, PM_RECOVERY, classifyPmTurnRecovery, DurablePmRecoveryError } from '../src/pm/durable-pm-runtime.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { classifyPmWorkFailure, settleTerminalPmRunFailure, settlePmWorkFailure, PM_WORK_FAILURE_DISPOSITION, PM_WORK_FAILURE_CLASS } from '../src/runtime/pm-work-failure-settlement.mjs';
import { reconcilePendingAction, RECONCILE_RESOLUTIONS } from '../src/runtime/pm-action-reconciliation.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

const PROJECT = { repo_path: 'C:/repo' };

function fakeResolveDriver(handlers) {
  return (profile) => ({
    name: `fake:${profile.id ?? profile}`,
    async decide(input) {
      const stepKind = input.request.context.stepKind;
      const fn = handlers[stepKind];
      if (!fn) throw new Error(`no fake handler for ${stepKind}`);
      return fn(profile, input);
    },
  });
}

function compliantHandlers({ participants = ['p1', 'p2'] } = {}) {
  return {
    chair_plan: () => ({ type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: Object.fromEntries(participants.map((id) => [id, `focus ${id}`])), critique_focus: 'rigor', synthesis_focus: 'converge' } }),
    participant_report: (profile) => ({ type: 'finish', output: `report ${profile.id}`, data: { type: 'council_report', analysis: `analysis ${profile.id}`, recommendation: `rec ${profile.id}`, risks: [], uncertainties: [] } }),
    participant_critique: (profile) => ({ type: 'finish', output: `critique ${profile.id}`, data: { type: 'council_critique', criticisms: [], agreements: ['ok'], revised_recommendation: `revised ${profile.id}`, remaining_disagreements: [] } }),
    chair_synthesis: () => ({ type: 'finish', output: 'synthesis done', data: { type: 'council_synthesis' } }),
  };
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p15-r2-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    await fn(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function durableStepState(store) {
  return new DurableWorkflowState({ repository: new WorkflowRepository({ store }) });
}

// ---------------------------------------------------------------------------
// P15-C-001 — CouncilStepWorkflowRunner unit-level RED/GREEN
// ---------------------------------------------------------------------------

test('P15-C-001 RED: without a durable stepState, a fresh runner instance ("restart") has completely lost a step that already completed', async () => {
  const calls = { chair_plan: 0 };
  const resolveDriver = fakeResolveDriver({
    chair_plan: () => { calls.chair_plan += 1; return compliantHandlers({ participants: ['p1'] }).chair_plan(); },
  });
  const runner1 = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const spec = { id: 'wf-red-1', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', participantProfileIds: ['p1'], prompt: 'plan it' };
  const outcome1 = await runner1.run(spec);
  assert.equal(outcome1.finalResult.handoff.ok, true);
  assert.equal(calls.chair_plan, 1);

  // A genuine restart: a brand-new process constructs a brand-new runner —
  // this is EXACTLY the pre-R2 shape (no stepState existed at all).
  const runner2 = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  assert.equal(runner2.result(spec.id), null, 'RED: the completed step is gone — nothing durable backs it');
});

test('P15-C-001 RED (mechanism): DurablePmRuntime really does throw ACTION_RECONCILE_REQUIRED forever when the workflow runner cannot answer result() after restart', () => {
  const turn = { phase: 'ACTION_STARTED', decision: { type: 'workflow', spec: { id: 'wf-x' } }, actionType: 'workflow', actionId: 'wf-x' };
  // No durable backing at all -> exactly what a fresh in-memory-only
  // CouncilStepWorkflowRunner.result() returns (null) on every single call,
  // not just the first — this is the "forever" part of the bug.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(classifyPmTurnRecovery(turn, null), PM_RECOVERY.ACTION_RECONCILE_REQUIRED);
  }
});

test('P15-C-001 GREEN: a durable stepState lets a fresh runner instance reconstruct an already-completed step without re-executing it', async () => {
  await withStore(async (store) => {
    const stepState = durableStepState(store);
    const calls = { chair_plan: 0 };
    const resolveDriver = fakeResolveDriver({ chair_plan: () => { calls.chair_plan += 1; return compliantHandlers({ participants: ['p1'] }).chair_plan(); } });
    const spec = { id: 'wf-green-1', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', participantProfileIds: ['p1'], prompt: 'plan it' };

    const runner1 = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, stepState });
    const outcome1 = await runner1.run(spec);
    assert.equal(outcome1.finalResult.handoff.ok, true);
    assert.equal(calls.chair_plan, 1);

    // Restart: fresh runner instance, SAME durable store.
    const runner2 = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, stepState });
    const recovered = runner2.result(spec.id);
    assert.ok(recovered, 'GREEN: result() answers correctly after restart');
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.finalResult.handoff.ok, true);
    assert.equal(recovered.finalResult.output, outcome1.finalResult.output);

    // Invariant #9: run() called again for the SAME id must never re-execute.
    const rerun = await runner2.run(spec);
    assert.deepEqual(rerun, recovered);
    assert.equal(calls.chair_plan, 1, 'the provider was never called a second time for a completed step');
  });
});

test('P15-C-001 GREEN: mid-step restart (durable row STARTED, never completed) reconciles deterministically as a typed, terminal, non-replayed failure — never loops, never reruns the provider', async () => {
  await withStore(async (store) => {
    const stepState = durableStepState(store);
    const calls = { participant_report: 0 };
    const resolveDriver = fakeResolveDriver({ participant_report: () => { calls.participant_report += 1; return compliantHandlers().participant_report({ id: 'p1' }); } });
    const spec = { id: 'wf-mid-crash', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'p1', participantProfileIds: ['p1'], prompt: 'report' };

    // Reproduce EXACTLY the physical durable state a real crash leaves: the
    // process marked this step STARTED (durably, via the same
    // WorkflowRepository shape run() itself writes) and then died before
    // ever calling the provider or recording ANY outcome.
    stepState.createWorkflow({
      id: spec.id, sender: 'council', status: 'created', startedAt: null, completedAt: null, error: null,
      steps: [{ id: `${spec.id}-step0`, workflowId: spec.id, index: 0, recipient: spec.profileId, status: 'created', taskId: null, runId: null, resultId: null, contextFromPrevious: false, dispatchedContext: null, error: null, body: spec.stepKind, context: { stepKind: spec.stepKind, round: spec.round, participantProfileIds: spec.participantProfileIds }, expectedOutput: null }],
    });
    stepState.updateWorkflowStatus(spec.id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    stepState.updateStepStatus(spec.id, `${spec.id}-step0`, { status: 'running' });

    // Restart: a fresh runner instance never saw this step start.
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, stepState });
    const recovered = runner.result(spec.id);
    assert.ok(recovered, 'GREEN: never ACTION_RECONCILE_REQUIRED forever — a real, terminal outcome is produced');
    assert.equal(recovered.status, 'completed', 'reported through the SAME status:"completed"/handoff.ok:false convention every other step failure already uses (Part H/I) — no new PM-level recovery state needed');
    assert.equal(recovered.finalResult.status, 'failed');
    assert.equal(recovered.finalResult.handoff.ok, false);
    assert.match(recovered.finalResult.handoff.reason, /COUNCIL_STEP_RECONCILE_REQUIRED/);
    assert.equal(calls.participant_report, 0, 'the provider was NEVER called — an ambiguous outcome is never replayed');

    // Idempotency: a second result() call (e.g. a second restart, or the
    // durable-pm-runtime recovery classifier reading it twice) must not
    // re-run the reconciliation write or change the answer.
    const recoveredAgain = runner.result(spec.id);
    assert.deepEqual(recoveredAgain, recovered);

    // The durable row itself is now terminal — no more 'running' forever.
    const row = stepState.getWorkflow(spec.id);
    assert.equal(row.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// P15-C-001 — full end-to-end through DurablePmRuntime + ProductionPmWorkHandler
// ---------------------------------------------------------------------------

function buildCouncilHandler({ pmRepository, project, resolveDriver, stepState }) {
  const coordinationStore = { completedFences: [], completeClaim: async function (fence) { this.completedFences.push(fence); } };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'chair', context: {} } : null) };
  const createRuntime = ({ council, taskId, pmRunId }) => {
    const chairDriver = new CouncilChairDriver({ council, ownerTask: 'restart recovery canary' });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, project, extraCtx: () => ({ taskId, pmRunId }), stepState });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    return new DurablePmRuntime({ driver: chairDriver, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 16 });
  };
  const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository: {}, taskRepository, projects: [project], createRuntime });
  return { handler, coordinationStore };
}

test('P15-C-001 GREEN end-to-end: a real restart mid participant_report recovers deterministically to a degraded-but-completed council, through the real execute() path', async () => {
  await withStore(async (store) => {
    const stepState = durableStepState(store);
    const pmRepository = new PmRepository({ store });
    const commandId = 'cmd-p15r2-restart';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-restart', repo_path: 'C:/repo', taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
    const request = createPmRequest({ objective: 'restart canary', context: { ownerCommandId: commandId, council } });
    const pmRunId = 'pmrun-p15r2-restart';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:chair', startedAt: '2026-01-01T00:00:00.000Z' });

    // Hand-place the EXACT durable state a real crash leaves: turn 0
    // (chair_plan) already TURN_COMPLETE, turn 1 (participant_report:p1)
    // committed + ACTION_STARTED, with its durable workflow row stuck
    // 'running' (the provider call itself was never durably resolved).
    const chairPlanSpecId = deterministicOwnerId('wf', pmRunId, '0');
    const realChairRunner = new CouncilStepWorkflowRunner({ resolveDriver: fakeResolveDriver(compliantHandlers({ participants: ['p1', 'p2'] })), project, stepState });
    const chairOutcome = await realChairRunner.run({ id: chairPlanSpecId, kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', participantProfileIds: ['p1', 'p2'], prompt: 'plan' });
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: chairPlanSpecId, kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', participantProfileIds: ['p1', 'p2'], prompt: 'plan' } }, actionType: 'workflow', actionId: chairPlanSpecId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);
    pmRepository.completeTurn(pmRunId, 0, chairOutcome);

    const p1SpecId = deterministicOwnerId('wf', pmRunId, '1');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-1', turnIndex: 1, decision: { type: 'workflow', spec: { id: p1SpecId, kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'p1', participantProfileIds: ['p1', 'p2'], prompt: 'report p1' } }, actionType: 'workflow', actionId: p1SpecId, createdAt: '2026-01-01T00:00:02.000Z' });
    pmRepository.markActionStarted(pmRunId, 1);
    stepState.createWorkflow({
      id: p1SpecId, sender: 'council', status: 'created', startedAt: null, completedAt: null, error: null,
      steps: [{ id: `${p1SpecId}-step0`, workflowId: p1SpecId, index: 0, recipient: 'p1', status: 'created', taskId: null, runId: null, resultId: null, contextFromPrevious: false, dispatchedContext: null, error: null, body: 'participant_report', context: { stepKind: 'participant_report', round: 1, participantProfileIds: ['p1', 'p2'] }, expectedOutput: null }],
    });
    stepState.updateWorkflowStatus(p1SpecId, { status: 'running', startedAt: '2026-01-01T00:00:02.500Z' });
    stepState.updateStepStatus(p1SpecId, `${p1SpecId}-step0`, { status: 'running' });

    // Restart: brand-new handler/runtime/runner, p2's driver actually runs.
    const calls = { p2: 0 };
    const handlers = compliantHandlers({ participants: ['p1', 'p2'] });
    const resolveDriver = fakeResolveDriver({
      ...handlers,
      participant_report: (profile, input) => { if (profile.id === 'p2') calls.p2 += 1; return handlers.participant_report(profile, input); },
    });
    const { handler, coordinationStore } = buildCouncilHandler({ pmRepository, project, resolveDriver, stepState });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };

    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.status, 'COMPLETED', 'GREEN: no throw, no crash-loop — the restart resolves deterministically');
    assert.equal(outcome.result.status, 'completed');
    assert.equal(calls.p2, 1, 'p2 (never touched by the crash) executed exactly once — for real');
    assert.equal(outcome.result.data?.degraded, true, 'p1 is honestly reported as failed (reconciled), not silently dropped or fabricated as successful');
    assert.ok(outcome.result.data?.failed_participants?.includes('p1'));
    assert.ok(outcome.result.data?.completed_participants?.includes('p2'));
    assert.equal(coordinationStore.completedFences.length, 1, 'the claim was completed exactly once');

    const finalRun = pmRepository.load(pmRunId);
    assert.equal(finalRun.status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// P15-C-006 — the settlement boundary: classification + durable disposition
// ---------------------------------------------------------------------------

test('P15-C-006: classifyPmWorkFailure maps every enumerated typed failure to a bounded, never-looping disposition', () => {
  const cases = [
    ['PM_WORK_LINEAGE_INVALID', PM_WORK_FAILURE_DISPOSITION.TERMINAL_CLAIM_ONLY, PM_WORK_FAILURE_CLASS.TERMINAL_INTERNAL],
    ['PROJECT_REFUSED', PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, PM_WORK_FAILURE_CLASS.TERMINAL_USER_CONFIG],
    ['PM_DRIVER_MISMATCH', PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, PM_WORK_FAILURE_CLASS.TERMINAL_USER_CONFIG],
    ['PM_PROFILE_UNAVAILABLE', PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, PM_WORK_FAILURE_CLASS.TERMINAL_USER_CONFIG],
    ['PM_PROFILE_MISMATCH', PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN, PM_WORK_FAILURE_CLASS.TERMINAL_USER_CONFIG],
    ['PM_RUN_ALREADY_ADVANCED', PM_WORK_FAILURE_DISPOSITION.TERMINAL_CLAIM_ONLY, PM_WORK_FAILURE_CLASS.TERMINAL_INTERNAL],
    ['ACTION_RECONCILE_REQUIRED', PM_WORK_FAILURE_DISPOSITION.RECONCILE_ABANDON, PM_WORK_FAILURE_CLASS.RECONCILIATION_REQUIRED],
  ];
  for (const [code, disposition, classification] of cases) {
    const result = classifyPmWorkFailure({ code });
    assert.equal(result.disposition, disposition, code);
    assert.equal(result.classification, classification, code);
  }
  // Fail-closed default for anything unclassified — never left unsettled.
  const unknown = classifyPmWorkFailure({ code: 'SOME_NEW_ERROR_THIS_MODULE_HAS_NEVER_SEEN' });
  assert.equal(unknown.disposition, PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN);
});

async function withPmRun(fn) {
  await withStore(async (store) => {
    const pmRepository = new PmRepository({ store });
    const request = createPmRequest({ objective: 'settlement canary', context: { ownerCommandId: 'cmd-settle' } });
    const pmRunId = 'pmrun-settle';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:chair', startedAt: '2026-01-01T00:00:00.000Z' });
    await fn({ pmRepository, pmRunId });
  });
}

test('P15-C-006: settleTerminalPmRunFailure durably fails a running pm_run with a pending ACTION_STARTED workflow turn, without corrupting load()', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const actionId = deterministicOwnerId('wf', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);

    const result = settleTerminalPmRunFailure({ pmRepository, pmRunId, error: { code: 'PROJECT_REFUSED', message: 'PM project is unavailable' } });
    assert.equal(result.pmRunTouched, true);

    const run = pmRepository.load(pmRunId); // must not throw CORRUPT_PM_STATE
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'PROJECT_REFUSED');
    assert.equal(run.turns[0].phase, 'TURN_COMPLETE');
  });
});

test('P15-C-006: settleTerminalPmRunFailure never touches a run parked on a real AWAIT_OWNER interaction', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const interactionId = deterministicOwnerId('interaction', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'await_owner', interactionId, prompt: 'question?' }, actionType: 'await_owner', actionId: interactionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);

    const result = settleTerminalPmRunFailure({ pmRepository, pmRunId, error: { code: 'PM_DRIVER_MISMATCH' } });
    assert.equal(result.pmRunTouched, false);
    assert.equal(result.reason, 'AWAIT_OWNER_PENDING');

    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'running', 'the real owner interaction is left completely untouched');
  });
});

test('P15-C-006: terminalizer idempotency — settling an already-terminal run is a safe no-op', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    pmRepository.completeRun(pmRunId, { status: 'failed', output: '', data: null, error: { code: 'X' }, completedAt: '2026-01-01T00:00:01.000Z' });
    const first = settleTerminalPmRunFailure({ pmRepository, pmRunId, error: { code: 'PROJECT_REFUSED' } });
    const second = settleTerminalPmRunFailure({ pmRepository, pmRunId, error: { code: 'PROJECT_REFUSED' } });
    assert.equal(first.pmRunTouched, false);
    assert.equal(second.pmRunTouched, false);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.error.code, 'X', 'the original terminal error is never overwritten by a later settlement attempt');
  });
});

test('P15-C-006: ACTION_RECONCILE_REQUIRED can never loop — settlePmWorkFailure applies automatic ABANDON exactly once, and re-settling is a safe no-op', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const actionId = deterministicOwnerId('wf', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);

    const first = settlePmWorkFailure({ pmRepository, pmRunId, error: { code: 'ACTION_RECONCILE_REQUIRED' } });
    assert.equal(first.disposition, PM_WORK_FAILURE_DISPOSITION.RECONCILE_ABANDON);
    assert.equal(first.pmRunOutcome.pmRunTouched, true);

    let run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'ACTION_RECONCILED_ABANDONED');

    // A second poll reclaiming the same (now-terminal) work item must never
    // crash or re-throw ACTION_RECONCILE_REQUIRED again — this IS the fix
    // for the infinite loop.
    const second = settlePmWorkFailure({ pmRepository, pmRunId, error: { code: 'ACTION_RECONCILE_REQUIRED' } });
    assert.equal(second.pmRunOutcome.pmRunTouched, false);
    run = pmRepository.load(pmRunId);
    assert.equal(run.error.code, 'ACTION_RECONCILED_ABANDONED', 'unchanged — never re-reconciled');
  });
});

// ---------------------------------------------------------------------------
// P15-C-006 — full end-to-end through ProductionPmWorkHandler.execute()
// ---------------------------------------------------------------------------

function buildSettlementHandler({ pmRepository, project, createRuntime }) {
  const coordinationStore = { completedFences: [], completeClaim: async function (fence) { this.completedFences.push(fence); } };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'chair', context: {} } : null) };
  const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository: {}, taskRepository, projects: [project], createRuntime: createRuntime ?? (() => { throw new Error('unused'); }) });
  return { handler, coordinationStore };
}

test('P15-C-006 end-to-end: PM_WORK_LINEAGE_INVALID settles the claim without fabricating a pm_run mutation, and never throws', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const project = { id: 'proj-lineage', repo_path: 'C:/repo', taskId: deterministicOwnerId('task', 'wrong-command') };
    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project });
    // A work item whose action_id does not match this pm_run's real lineage.
    const work = { pm_run_id: pmRunId, action_id: 'bogus-action-id' };
    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PM_WORK_LINEAGE_INVALID');
    assert.equal(outcome.disposition, PM_WORK_FAILURE_DISPOSITION.TERMINAL_CLAIM_ONLY);
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'running', 'an untrustworthy work-item claim never mutates a pm_run it cannot verify');
  });
});

test('P15-C-006 end-to-end: PROJECT_REFUSED durably fails the pm_run and completes the claim exactly once', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const commandId = 'cmd-settle';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-missing', repo_path: 'C:/repo', taskId };
    // The task references a project id that is NOT in the handler's project map.
    const coordinationStore = { completedFences: [], completeClaim: async function (fence) { this.completedFences.push(fence); } };
    const taskRepository = { getOwnerTask: (id) => (id === taskId ? { id, projectId: 'some-other-project', pmProfileId: 'chair', context: {} } : null) };
    const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository: {}, taskRepository, projects: [project], createRuntime: () => { throw new Error('unused'); } });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };

    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PROJECT_REFUSED');
    assert.equal(outcome.disposition, PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN);
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'PROJECT_REFUSED');

    // A second poll of the exact same work item: PROJECT_REFUSED is checked
    // BEFORE execute()'s own "already terminal -> adopt" branch (pre-
    // existing ordering, unchanged by this fix), so it is classified again —
    // but this is NOT a loop: the claim is completed again (never left
    // hanging on a lease), and the durable run is untouched (already
    // terminal, same error preserved) rather than re-mutated.
    const again = await handler.execute({ work, fence: {} });
    assert.equal(again.status, 'FAILURE_SETTLED');
    assert.equal(again.code, 'PROJECT_REFUSED');
    assert.equal(coordinationStore.completedFences.length, 2, 'the claim is settled on every poll — never left to lease-expire and retry silently');
    const unchanged = pmRepository.load(pmRunId);
    assert.equal(unchanged.error.code, 'PROJECT_REFUSED', 'the already-terminal run is never re-mutated');
  });
});

test('P15-C-006 end-to-end: PM_RUN_ALREADY_ADVANCED (a real DurablePmRuntime throw, from the TOCTOU window executePrepared() itself guards against) settles the claim without touching the pm_run', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const commandId = 'cmd-settle';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-advanced', repo_path: 'C:/repo', taskId };
    const workflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    const realRuntime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 16 });
    // execute() reads turnCount===0 ONCE, at the very top, to choose
    // executePrepared() over resume() — then calls it. executePrepared()'s
    // OWN internal reload is the actual PM_RUN_ALREADY_ADVANCED guard,
    // protecting against exactly this TOCTOU window: a second, racing
    // dispatch of the SAME pm_run_id (e.g. a duplicate work item) advancing
    // the run in between. Reproduced directly rather than by chance timing.
    const racingRuntime = {
      executePrepared: async (id, opts) => {
        const actionId = deterministicOwnerId('wf', id, '0');
        pmRepository.commitDecision(id, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
        pmRepository.markActionStarted(id, 0);
        pmRepository.completeTurn(id, 0, { status: 'completed', output: 'raced', data: null });
        return realRuntime.executePrepared(id, opts);
      },
      resume: (...args) => realRuntime.resume(...args),
    };

    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project, createRuntime: () => racingRuntime });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PM_RUN_ALREADY_ADVANCED');
    assert.equal(outcome.disposition, PM_WORK_FAILURE_DISPOSITION.TERMINAL_CLAIM_ONLY);
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'running', 'the racing dispatch that lost never mutates the run — the winning dispatch\'s own progress (turn 0, completed) is left untouched');
    assert.equal(run.turnCount, 1);
  });
});

test('P15-C-006 end-to-end: PM_DRIVER_MISMATCH (a real DurablePmRuntime throw) durably fails the pm_run and completes the claim', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const commandId = 'cmd-settle';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-driver', repo_path: 'C:/repo', taskId };
    const actionId = deterministicOwnerId('wf', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);
    const workflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    // The pm_run was created with driver 'council:chair' (withPmRun); resume
    // against a DIFFERENT configured driver name -> real PM_DRIVER_MISMATCH.
    const runtime = new DurablePmRuntime({ driver: { name: 'council:someone-else', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 16 });
    await assert.rejects(() => runtime.resume(pmRunId, {}), (error) => error instanceof DurablePmRecoveryError && error.code === 'PM_DRIVER_MISMATCH');

    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project, createRuntime: () => runtime });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PM_DRIVER_MISMATCH');
    assert.equal(outcome.disposition, PM_WORK_FAILURE_DISPOSITION.TERMINAL_RUN);
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'PM_DRIVER_MISMATCH');
    assert.equal(run.turns[0].phase, 'TURN_COMPLETE', 'load() invariants stay intact — no corruption');
  });
});

test('P15-C-006 end-to-end: PM_PROFILE_UNAVAILABLE (a real DurablePmRuntime throw) durably fails the pm_run and completes the claim', async () => {
  await withStore(async (store) => {
    const pmRepository = new PmRepository({ store });
    const commandId = 'cmd-settle-profile';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-profile', repo_path: 'C:/repo', taskId };
    const profileRegistry = { get: () => ({ id: 'chair', fingerprint: 'fp-a' }) };
    const request = createPmRequest({ objective: 'profile canary', context: { ownerCommandId: commandId } });
    const pmRunId = 'pmrun-settle-profile';
    const workflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    const prepareRuntime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, profileRegistry, pmProfileId: 'chair', maxTurns: 16 });
    prepareRuntime.prepare({ objective: request.objective, context: request.context, pmRunId });

    // Resume against a registry that can no longer resolve the pinned profile.
    const brokenRegistry = { get: () => { throw new Error('profile deleted'); } };
    const resumeRuntime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, profileRegistry: brokenRegistry, pmProfileId: 'chair', maxTurns: 16 });
    await assert.rejects(() => resumeRuntime.resume(pmRunId, {}), (error) => error instanceof DurablePmRecoveryError && error.code === 'PM_PROFILE_UNAVAILABLE');

    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project, createRuntime: () => resumeRuntime });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PM_PROFILE_UNAVAILABLE');
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'PM_PROFILE_UNAVAILABLE');
  });
});

test('P15-C-006 end-to-end: PM_PROFILE_MISMATCH (a real DurablePmRuntime throw) durably fails the pm_run and completes the claim', async () => {
  await withStore(async (store) => {
    const pmRepository = new PmRepository({ store });
    const commandId = 'cmd-settle-fp';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-fp', repo_path: 'C:/repo', taskId };
    const request = createPmRequest({ objective: 'fingerprint canary', context: { ownerCommandId: commandId } });
    const pmRunId = 'pmrun-settle-fp';
    const workflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    const prepareRuntime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, profileRegistry: { get: () => ({ id: 'chair', fingerprint: 'fp-original' }) }, pmProfileId: 'chair', maxTurns: 16 });
    prepareRuntime.prepare({ objective: request.objective, context: request.context, pmRunId });

    // The profile now resolves to a DIFFERENT fingerprint (its underlying
    // config changed identity since this run was pinned).
    const changedRegistry = { get: () => ({ id: 'chair', fingerprint: 'fp-changed' }) };
    const resumeRuntime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, profileRegistry: changedRegistry, pmProfileId: 'chair', maxTurns: 16 });
    await assert.rejects(() => resumeRuntime.resume(pmRunId, {}), (error) => error instanceof DurablePmRecoveryError && error.code === 'PM_PROFILE_MISMATCH');

    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project, createRuntime: () => resumeRuntime });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });
    assert.equal(outcome.status, 'FAILURE_SETTLED');
    assert.equal(outcome.code, 'PM_PROFILE_MISMATCH');
    assert.equal(coordinationStore.completedFences.length, 1);
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'PM_PROFILE_MISMATCH');
  });
});

test('P15-C-006 end-to-end: ACTION_RECONCILE_REQUIRED (a real DurablePmRuntime throw) never crash-loops — settles automatically, then adopts cleanly on the next poll', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const commandId = 'cmd-settle';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-reconcile', repo_path: 'C:/repo', taskId };
    const actionId = deterministicOwnerId('wf', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);
    // A fresh workflowRunner that has genuinely never heard of this action
    // (exactly the pre-R2-A Council in-memory-loss shape, and also the
    // shape SINGLE's own durable WorkflowRunner produces for a step that
    // never even got as far as a durable row).
    const workflowRunner = { run: async () => { throw new Error('unused'); }, result: () => null };
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    const runtime = new DurablePmRuntime({ driver: { name: 'council:chair', decide: async () => { throw new Error('unused'); } }, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 16 });
    await assert.rejects(() => runtime.resume(pmRunId, {}), (error) => error instanceof DurablePmRecoveryError && error.code === 'ACTION_RECONCILE_REQUIRED');

    const { handler, coordinationStore } = buildSettlementHandler({ pmRepository, project, createRuntime: () => runtime });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };

    const first = await handler.execute({ work, fence: {} });
    assert.equal(first.status, 'FAILURE_SETTLED');
    assert.equal(first.code, 'ACTION_RECONCILE_REQUIRED');
    assert.equal(first.disposition, PM_WORK_FAILURE_DISPOSITION.RECONCILE_ABANDON);
    assert.equal(coordinationStore.completedFences.length, 1);
    let run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'ACTION_RECONCILED_ABANDONED');

    // A fresh poll (a NEW worker incarnation, exactly what caused the real
    // TEST-4 crash loop) reclaims the same work item — this must adopt
    // cleanly, never re-throw, never re-execute anything.
    const second = await handler.execute({ work, fence: {} });
    assert.equal(second.status, 'COMPLETED');
    assert.equal(second.adopted, true);
    assert.equal(coordinationStore.completedFences.length, 2);
    run = pmRepository.load(pmRunId);
    assert.equal(run.error.code, 'ACTION_RECONCILED_ABANDONED', 'never re-reconciled a second time');
  });
});

// ---------------------------------------------------------------------------
// Non-regression — SINGLE / normal Council completion / cancellation shape
// ---------------------------------------------------------------------------

test('non-regression: a normal, uninterrupted Council run completes exactly as before (settlement boundary is a no-op on the happy path)', async () => {
  await withStore(async (store) => {
    const stepState = durableStepState(store);
    const pmRepository = new PmRepository({ store });
    const commandId = 'cmd-happy';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-happy', repo_path: 'C:/repo', taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
    const request = createPmRequest({ objective: 'happy path', context: { ownerCommandId: commandId, council } });
    const pmRunId = 'pmrun-happy';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:chair', startedAt: '2026-01-01T00:00:00.000Z' });

    const resolveDriver = fakeResolveDriver(compliantHandlers({ participants: ['p1', 'p2'] }));
    const { handler, coordinationStore } = buildCouncilHandler({ pmRepository, project, resolveDriver, stepState });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.status, 'completed');
    assert.equal(outcome.result.data?.degraded, false);
    assert.deepEqual(outcome.result.data?.failed_participants, []);
    assert.equal(coordinationStore.completedFences.length, 1);
  });
});

test('non-regression: all participants failing still throws COUNCIL_ALL_PARTICIPANTS_FAILED and fails the run normally (unrelated to the new settlement boundary)', async () => {
  await withStore(async (store) => {
    const stepState = durableStepState(store);
    const pmRepository = new PmRepository({ store });
    const commandId = 'cmd-allfail';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'proj-allfail', repo_path: 'C:/repo', taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
    const request = createPmRequest({ objective: 'all fail', context: { ownerCommandId: commandId, council } });
    const pmRunId = 'pmrun-allfail';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:chair', startedAt: '2026-01-01T00:00:00.000Z' });

    const resolveDriver = fakeResolveDriver({
      chair_plan: () => ({ type: 'finish', output: 'plan', data: { type: 'council_plan', participant_instructions: { p1: 'go' }, critique_focus: 'a', synthesis_focus: 'b' } }),
      participant_report: () => ({ type: 'finish', output: '', data: { type: 'wrong' } }), // fails schema validation
    });
    const { handler, coordinationStore } = buildCouncilHandler({ pmRepository, project, resolveDriver, stepState });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.error.code, 'COUNCIL_ALL_PARTICIPANTS_FAILED');
    assert.equal(coordinationStore.completedFences.length, 1, 'the pre-existing normal-failure path still completes the claim exactly as before');
  });
});

test('non-regression: reconcilePendingAction (manual operator path, P12-R5B) is completely unaffected and still works standalone', async () => {
  await withPmRun(async ({ pmRepository, pmRunId }) => {
    const actionId = deterministicOwnerId('wf', pmRunId, '0');
    pmRepository.commitDecision(pmRunId, { id: 'pmturn-0', turnIndex: 0, decision: { type: 'workflow', spec: { id: actionId } }, actionType: 'workflow', actionId, createdAt: '2026-01-01T00:00:01.000Z' });
    pmRepository.markActionStarted(pmRunId, 0);
    const applied = reconcilePendingAction({ pmRepository, pmRunId, resolution: RECONCILE_RESOLUTIONS.CONFIRM_NOT_APPLIED, note: 'manual operator check' });
    assert.equal(applied.outcome.error.code, 'ACTION_RECONCILED_NOT_APPLIED');
    const run = pmRepository.load(pmRunId);
    assert.equal(run.status, 'failed');
  });
});
