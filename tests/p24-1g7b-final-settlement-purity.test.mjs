// P24.1G7B — final settlement purity & qualification (reports/
// P24_1G7B_FINAL_SETTLEMENT_PURITY_QUALIFICATION_20260916.md).
//
// Closes G7A's three disclosed residual risks with real, offline
// end-to-end fixtures (real AgentBusRepository/PmRepository/
// ProductionPmWorkHandler + a real local git fixture with a bare remote —
// never a shallow mock of the settlement primitives themselves):
//   A. commit-reuse evidence hardened to durable tree/object identity,
//      never a trailer match alone once that evidence exists;
//   B. a task with zero actual target-repository diff must produce zero
//      commits and zero pushes, even with durability/history/journal
//      machinery active;
//   C. Council and Debate settlement, through the REAL shared
//      `settleGitResult()` call site, with real chair+participant
//      orchestration (CouncilChairDriver + CouncilStepWorkflowRunner),
//      not merely "the code path is shared" reasoning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { GIT_SETTLEMENT_STATE, loadGitSettlement, transitionGitSettlement } from '../src/pm/git-settlement-journal.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initWorktreeWithBareRemote(root) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', 'main']);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', 'main']);
  git(workDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', 'main']);
  return { bareDir, workDir };
}

async function withRealStack(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-1g7b-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-1g7b-git-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const pmRepository = new PmRepository({ store });
    const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
    await fn({ agentBusRepository, pmRepository, workDir, bareDir });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
  }
}

const boundProject = (workDir, extraAutonomy = {}) => ({ id: 'proj-g7b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL', ...extraAutonomy } } });

function countCommitsAheadOfBase(workDir, baseSha, branch) {
  const out = git(workDir, ['log', '--format=%H', `${baseSha}..${branch}`]).trim();
  return out === '' ? 0 : out.split('\n').length;
}

async function submitTask({ agentBusRepository, project, payload, council = null, clientKind = 'LOCAL' }) {
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
  await controller.submit({ command: { command_id: commandId, client_kind: clientKind, payload }, project, profile: { id: 'pm-1' }, council });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  return { commandId, taskId, readBack };
}

// `driver` must match the ACTUAL driver's own `.name` DurablePmRuntime will
// construct when it resumes this pm_run (durable-pm-runtime.mjs fails
// closed with PM_DRIVER_MISMATCH otherwise) — `single-pm-fake` for the
// SINGLE fixture below, `council:<chair_profile_id>` for Council/Debate
// (CouncilChairDriver.name getter).
async function createPmRun({ pmRepository, readBack, commandId, driver = 'single-pm-fake' }) {
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver, startedAt: '2026-01-01T00:00:00.000Z' });
  return pmRunId;
}

// ---------------------------------------------------------------------------
// Council/Debate fake driver + runtime factory — mirrors
// tests/council-debate.test.mjs's own fixture exactly (the established,
// already-relied-upon pattern for exercising CouncilChairDriver +
// CouncilStepWorkflowRunner deterministically), wired here into a REAL
// `createRuntime` factory `ProductionPmWorkHandler` can actually drive.
// ---------------------------------------------------------------------------

function fakeResolveDriverFactory({ debateContinueByRound = {}, failStepKind = null } = {}) {
  const resolveDriver = (profile, context = {}) => {
    if (!context.project?.repo_path) throw new Error('resolveDriver requires project.repo_path');
    const round = context.extraCtx?.round;
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        if (failStepKind && stepKind === failStepKind) throw new Error(`simulated ${stepKind} failure for ${profile.id}`);
        if (stepKind === 'chair_plan') {
          const participantIds = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(participantIds.map((id) => [id, `focus ${id}`]));
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be harsh', synthesis_focus: 'be concise' } };
        }
        if (stepKind === 'participant_report') {
          return { type: 'finish', output: `${profile.id} summary`, data: { type: 'council_report', analysis: `${profile.id} analysis`, recommendation: `${profile.id} rec`, risks: ['r1'], uncertainties: ['u1'] } };
        }
        if (stepKind === 'participant_critique') {
          return { type: 'finish', output: `${profile.id} critique summary`, data: { type: 'council_critique', criticisms: ['c1'], agreements: ['a1'], revised_recommendation: `${profile.id} revised`, remaining_disagreements: [] } };
        }
        if (stepKind === 'chair_synthesis') {
          return { type: 'finish', output: 'FINAL SYNTHESIS TEXT', data: { type: 'council_synthesis' } };
        }
        if (stepKind === 'debate_brief') {
          return { type: 'finish', output: 'brief ready', data: { type: 'debate_brief', brief: `ROUND ${round} CANONICAL BRIEF` } };
        }
        if (stepKind === 'debate_response') {
          return { type: 'finish', output: `${profile.id} round ${round} summary`, data: { type: 'debate_response', response: `${profile.id} response for round ${round}` } };
        }
        if (stepKind === 'debate_synthesis') {
          const continueDebate = debateContinueByRound[round] ?? false;
          return { type: 'finish', output: `DEBATE REPORT ROUND ${round}`, data: { type: 'debate_synthesis', continue_debate: continueDebate, reason: `round ${round} reason`, unresolved_questions: continueDebate ? [`unresolved after round ${round}`] : [] } };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  return resolveDriver;
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

function realCreateRuntime({ pmRepository, councilDriverOptions = {} }) {
  return ({ project, council, ownerTask }) => {
    if (council) {
      const allIds = [council.chair_profile_id, ...council.participant_profile_ids];
      const profileRegistry = fakeProfileRegistry(allIds);
      const resolveDriver = fakeResolveDriverFactory(councilDriverOptions);
      const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project, extraCtx: (spec) => ({ councilId: 'g7b-test', phase: spec.stepKind, round: spec.round }) });
      const peerRelay = { async exchange() { throw new Error('council never uses peer_exchange'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
      const driver = new CouncilChairDriver({ council, ownerTask: ownerTask ?? '' });
      return new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 40 });
    }
    return new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    });
  };
}

function buildHandler({ agentBusRepository, pmRepository, project, councilDriverOptions = {} }) {
  return new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository, councilDriverOptions }), enableRepoHistoryMaterialization: false,
  });
}

// ---------------------------------------------------------------------------
// §5/§21 item 1/2 — explicit zero-diff hard-counter regression (SINGLE)
// ---------------------------------------------------------------------------

test('SINGLE real diff: exactly 1 commit / 1 push (hard counter baseline)', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'real work\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  const binding = readBack.context.taskBranch;
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1);
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.equal(remoteSha, git(workDir, ['rev-parse', binding.task_branch]).trim());
}));

test('SINGLE zero diff, git.commit=true git.push=true: 0 commits / 0 pushes even with durability + history (durable root) + journal all active', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', durability: 'DURABLE_LOCAL', git: { commit: true, push: true } } });
  // Deliberately NO file write — true zero-diff task.
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const historyRoot = mkdtempSync(join(tmpdir(), 'p24-1g7b-history-'));
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }),
    enableRepoHistoryMaterialization: true, resolveProjectHistoryRoot: () => historyRoot, // §4: production history root, outside the target repo
  });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  const binding = readBack.context.taskBranch;
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED', 'zero result commit -> push must be skipped entirely');
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 0, 'no commit was created at all');
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '', 'remote task branch was never created');
  const { record } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
  assert.equal(record.result_commit_sha, null, 'journal never records a commit that was never created');
}));

test('review requested but zero diff: no synthetic commit, no review interaction opened', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = boundProject(workDir);
  const interactionsCreated = [];
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: true }, review: { requested: true } } });
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository,
    ownerRepository: { createInteraction: async (v) => { interactionsCreated.push(v); return v; } },
    taskRepository: agentBusRepository, projects: [project], createRuntime: realCreateRuntime({ pmRepository }),
  });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.review_status, 'REVIEW_BLOCKED_REMOTE', 'requested but never reaches READY_FOR_REVIEW without a real published result');
  assert.equal(interactionsCreated.length, 0, 'no review interaction was opened for a task with nothing to review');
}));

// ---------------------------------------------------------------------------
// §7/§9 — commit identity hardening: fail-closed cases
// ---------------------------------------------------------------------------

test('CASE: durable tree evidence disagrees with the actual (unchanged) branch tip -> fail closed, never silently reused or recommitted', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: false } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'first content\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
  const first = await handler.execute({ work, fence: {} });
  assert.equal(first.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  const binding = readBack.context.taskBranch;
  const settledSha = git(workDir, ['rev-parse', binding.task_branch]).trim();

  // Corrupt the durable evidence: record a WRONG expected tree for the
  // SAME already-committed SHA — simulating durable evidence that
  // disagrees with what is actually on the branch (e.g. a corrupted
  // journal row). The commit SHA itself is untouched.
  const { record: before } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(before.result_commit_sha, settledSha);
  transitionGitSettlement(agentBusRepository, taskId, (cur) => ({ ...cur, result_tree_sha: 'f'.repeat(40) }));

  // The next call is the adoption/recovery path (this pm_run already
  // reached `completed`) — it must reconcile Git settlement again and
  // discover the inconsistency BEFORE ever considering a new commit.
  const second = await handler.execute({ work, fence: {} });
  assert.equal(second.adopted, true);
  const { record: after } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(after.state, GIT_SETTLEMENT_STATE.BLOCKED);
  assert.equal(after.error_code, 'RESULT_TREE_MISMATCH');
  // The branch itself is completely untouched — no second commit, no
  // recovery from the corrupted evidence by force.
  assert.equal(git(workDir, ['rev-parse', binding.task_branch]).trim(), settledSha);
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'still exactly the one original commit — no second was ever created');
}));

test('CASE: branch tip has NO task trailer and is NOT the pinned base commit -> fail closed as unexpected foreign content', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: false } } });
  const binding = readBack.context.taskBranch;
  // Simulate foreign/tampered content landing on the exclusively-DSH-owned
  // task branch BEFORE settlement ever runs — a plain commit with no
  // trailer at all, created directly (never through DSH's own commit
  // helper), standing in for "something else wrote to this branch".
  writeFileSync(join(workDir, 'FOREIGN.md'), 'not ours\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'foreign, untrailered commit']);

  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_FAILED');
  const { record } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.BLOCKED);
  assert.equal(record.error_code, 'UNEXPECTED_BRANCH_CONTENT');
  // DSH never committed on top of the foreign content.
  assert.equal(git(workDir, ['log', '--format=%s', '-1', binding.task_branch]).trim(), 'foreign, untrailered commit');
}));

// ---------------------------------------------------------------------------
// §11 — Council offline Git qualification
// ---------------------------------------------------------------------------

test('Council (3 participants) real diff: zero participant/chair Git effects, exactly 1 final commit / 1 final push', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1 });
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'council task', git: { commit: true, push: true } }, council });
  writeFileSync(join(workDir, 'COUNCIL-CHANGE.md'), 'chair + participants produced this\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId, driver: 'council:chair' });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.data.type, 'council');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'exactly one final commit regardless of participant count');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.equal(remoteSha, git(workDir, ['rev-parse', binding.task_branch]).trim());
  const { record } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
  // No participant/chair-attributable branch ever existed — only the one
  // top-level task branch this project's dsh/task-<id> namespace owns.
  const localBranches = git(workDir, ['branch', '--list']).split('\n').map((l) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean);
  assert.ok(localBranches.every((b) => b === binding.task_branch || b === binding.original_checkout), `no extra participant/round branches: ${localBranches.join(', ')}`);
}));

test('Council no-product-diff: 0 commits / 0 pushes even though chair/participants/synthesis all durably completed', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1 });
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'council task no diff', git: { commit: true, push: true } }, council });
  // No file write — the Council reasons and reports, but nothing is ever
  // materialized into the repository.
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId, driver: 'council:chair' });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 0);
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '');
}));

test('Council terminal failure (chair_plan throws): 0 commits / 0 pushes', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'council task will fail', git: { commit: true, push: true } }, council });
  writeFileSync(join(workDir, 'SHOULD-NOT-BE-COMMITTED.md'), 'never committed because the run fails\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId, driver: 'council:chair' });
  const handler = buildHandler({ agentBusRepository, pmRepository, project, councilDriverOptions: { failStepKind: 'chair_plan' } });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 0, 'a failed task never commits, even with real dirty content sitting in the workspace');
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '');
}));

// ---------------------------------------------------------------------------
// §12 — Debate offline Git qualification (2 rounds)
// ---------------------------------------------------------------------------

test('Debate 2 rounds real diff: zero round/PM-continuation Git effects, exactly 1 final commit / 1 final push', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'debate task', git: { commit: true, push: true } }, council });
  writeFileSync(join(workDir, 'DEBATE-CHANGE.md'), 'debate produced this\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId, driver: 'council:chair' });
  // continue after round 1 so round 2 genuinely runs; stop after round 2
  // (the engine cap of 2 would force it either way).
  const handler = buildHandler({ agentBusRepository, pmRepository, project, councilDriverOptions: { debateContinueByRound: { 1: true } } });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.data.type, 'council_debate');
  assert.equal(outcome.result.data.debate?.enabled, true);
  assert.equal(outcome.result.data.debate?.rounds_run, 2, 'both debate rounds actually ran');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'N=2 rounds produces exactly one final commit, never one per round');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.equal(remoteSha, git(workDir, ['rev-parse', binding.task_branch]).trim());
}));

test('Debate no-product-diff: 0 commits / 0 pushes across 2 rounds', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'debate task no diff', git: { commit: true, push: true } }, council });
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId, driver: 'council:chair' });
  const handler = buildHandler({ agentBusRepository, pmRepository, project, councilDriverOptions: { debateContinueByRound: { 1: true } } });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.data.debate?.rounds_run, 2);
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_GIT_VERIFIED_NO_CHANGES');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 0);
  assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim(), '');
}));

// ---------------------------------------------------------------------------
// §15 — external repo purity
// ---------------------------------------------------------------------------

test('external repo purity: a no-op successful task leaves the target repo completely clean — no history/journal/runtime internals appear', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', durability: 'DURABLE_LOCAL', git: { commit: true, push: true } } });
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const historyRoot = mkdtempSync(join(tmpdir(), 'p24-1g7b-history-'));
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }),
    enableRepoHistoryMaterialization: true, resolveProjectHistoryRoot: () => historyRoot,
  });
  await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(git(workDir, ['status', '--porcelain']).trim(), '', 'git status must be completely clean');
  const rootEntries = readdirSync(workDir);
  assert.ok(!rootEntries.includes('docs') || !existsSync(join(workDir, 'docs', 'history')), 'no docs/history/** in the target repo');
  assert.ok(!rootEntries.includes('docs') || !existsSync(join(workDir, 'docs', 'task-review')), 'no docs/task-review/** in the target repo');
  assert.ok(!rootEntries.includes('.runtime'), 'no .runtime/ leaked into the target repo');
}));

test('external repo purity: a real-change task commits ONLY the requested file, never runtime/journal internals', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'x', git: { commit: true, push: false } } });
  writeFileSync(join(workDir, 'REQUESTED.md'), 'the only intended change\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  const binding = readBack.context.taskBranch;
  const tree = git(workDir, ['ls-tree', '-r', '--name-only', binding.task_branch]).trim().split('\n');
  assert.deepEqual(tree.sort(), ['README.md', 'REQUESTED.md'].sort(), 'the one result commit contains ONLY the seed file and the requested change');
}));
