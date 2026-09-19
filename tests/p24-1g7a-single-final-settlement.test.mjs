// P24.1G7A — single-final-settlement journal + crash-recovery regression
// (reports/P24_1G7_SINGLE_SETTLEMENT_GIT_WORKFLOW_AUDIT_20260916.md;
// reports/P24_1G7A_SINGLE_FINAL_SETTLEMENT_IMPLEMENTATION_20260916.md).
//
// Uses the REAL AgentBusRepository/PmRepository/ProductionPmWorkHandler and
// a REAL local git fixture (a bare repo standing in for "origin") — never
// the shallow taskRepository fakes other older tests use — because the
// settlement journal (schema v8) and its crash-recovery reconciliation only
// exist on the real repository. "Crash before/after settlement" is
// simulated by driving the PM turn to a durable `completed` status via
// DurablePmRuntime directly (bypassing ProductionPmWorkHandler.execute()
// entirely, exactly like a process that died between "PM completion
// persisted" and "Git settlement ran" would leave things), then calling
// `handler.execute()` afterward — which necessarily takes the
// `run.status!=='running'` ADOPTION branch and must reconcile Git
// settlement from scratch, through the SAME `settleGitResult()` primitive
// a normal completion uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { GIT_SETTLEMENT_STATE, messageCarriesTaskTrailer, buildTaskCommitTrailer, loadGitSettlement } from '../src/pm/git-settlement-journal.mjs';

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
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p24-1g7a-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p24-1g7a-git-'));
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

function realCreateRuntime({ pmRepository, output = 'done', data = { type: 'single_result' } } = {}) {
  return () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output, data }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
}

function buildHandler({ agentBusRepository, pmRepository, project }) {
  return new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }), enableRepoHistoryMaterialization: false,
  });
}

async function submitTask({ agentBusRepository, project, payload, clientKind = 'LOCAL' }) {
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
  await controller.submit({ command: { command_id: commandId, client_kind: clientKind, payload }, project, profile: { id: 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  return { commandId, taskId, readBack };
}

async function createPmRun({ pmRepository, readBack, commandId }) {
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  return pmRunId;
}

function countCommitsAheadOfBase(workDir, baseSha, branch) {
  const out = git(workDir, ['log', '--format=%H', `${baseSha}..${branch}`]).trim();
  return out === '' ? 0 : out.split('\n').length;
}

const boundProject = (workDir) => ({ id: 'proj-g7a', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL', BRANCH_CREATE: 'APPROVAL' } } });

// ---------------------------------------------------------------------------
// Normal (non-crash) path: hard counters
// ---------------------------------------------------------------------------

test('SINGLE commit=true push=true: exactly 1 commit, exactly 1 push, remote exact SHA, journal SETTLED', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'exactly one result commit, ever');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  const localSha = git(workDir, ['rev-parse', binding.task_branch]).trim();
  assert.equal(remoteSha, localSha, 'remote exactly matches the one local result commit');

  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
  assert.equal(record.result_commit_sha, localSha);
  assert.equal(record.remote_verified_sha, localSha);
  assert.equal(record.push_attempt_consumed, true);
  assert.ok(messageCarriesTaskTrailer(git(workDir, ['show', '-s', '--format=%B', localSha]), taskId), 'the one result commit carries the task identity trailer');
}));

test('SINGLE commit=true push=false: exactly 1 local commit, 0 pushes, remote untouched', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: false } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'local only\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1);
  const remoteLine = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim();
  assert.equal(remoteLine, '', 'the remote never received the task branch at all — zero pushes');

  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.SETTLED);
  assert.equal(record.remote_verified_sha, null);
}));

test('LONG SINGLE: identical Git counts to normal SINGLE — LONG changes only execution timeout/durability defaults, no checkpoint commits', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true }, runtime_class: 'LONG' } });
  assert.equal(readBack.context.runtimeClass, 'LONG', 'this really is a LONG task, not an ordinary SINGLE');
  writeFileSync(join(workDir, 'CHANGE.md'), 'long task work\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'LONG produces exactly one result commit, same as normal SINGLE');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.equal(remoteSha, git(workDir, ['rev-parse', binding.task_branch]).trim());
}));

test('git.commit=false: 0 commits, 0 pushes, journal NOT_APPLICABLE', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = { id: 'proj-g7a-nogit', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing' } });
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  const handler = buildHandler({ agentBusRepository, pmRepository, project });

  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.NOT_APPLICABLE);
}));

// ---------------------------------------------------------------------------
// Crash recovery: PM already durably `completed`, but `handler.execute()`
// was never called before "the process died" — the ADOPTION branch must
// reconcile Git settlement itself, from scratch, using `run.data`/
// `run.output` (already durable) exactly as a fresh completion would have.
// ---------------------------------------------------------------------------

async function driveToCompletedWithoutSettling({ pmRepository, pmRunId }) {
  // Exactly what ProductionPmWorkHandler.execute() itself does BEFORE its
  // own settlement block — drives the PM turn to a durable terminal state
  // via DurablePmRuntime directly, deliberately never reaching the worker's
  // settlement code at all. This is the "crash between PM completion and
  // Git settlement" gap the audit's own "Recovery Lifecycle" section names.
  const runtime = realCreateRuntime({ pmRepository })();
  const result = await runtime.executePrepared(pmRunId, {});
  assert.equal(result.status, 'completed');
  assert.equal(pmRepository.load(pmRunId).status, 'completed', 'PM completion must already be durable before any Git settlement ever ran');
}

test('CASE A recovery: crash before any commit — adoption performs the full settlement (commit + push) for the first time', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'recovered work\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });

  await driveToCompletedWithoutSettling({ pmRepository, pmRunId });
  const { record: before } = loadGitSettlement(agentBusRepository, taskId);
  assert.equal(before.state, GIT_SETTLEMENT_STATE.UNSETTLED, 'no settlement attempt has happened yet');

  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.adopted, true, 'this really is the adoption branch, not a fresh completion');

  const binding = readBack.context.taskBranch;
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1, 'recovery created exactly one result commit');
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  const localSha = git(workDir, ['rev-parse', binding.task_branch]).trim();
  assert.equal(remoteSha, localSha, 'recovery pushed it exactly once');

  const { record: after } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(after.state, GIT_SETTLEMENT_STATE.SETTLED);
  assert.equal(after.result_commit_sha, localSha);
}));

test('CASE B/idempotent re-adoption: settlement already complete — a second adoption call creates no second commit and no second push', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const baseSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'idempotent recovery\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  await driveToCompletedWithoutSettling({ pmRepository, pmRunId });

  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
  await handler.execute({ work, fence: {} }); // first adoption — settles for real
  const binding = readBack.context.taskBranch;
  const firstSha = git(workDir, ['rev-parse', binding.task_branch]).trim();

  const secondOutcome = await handler.execute({ work, fence: {} }); // second adoption — must be a safe no-op
  assert.equal(secondOutcome.adopted, true);
  const secondSha = git(workDir, ['rev-parse', binding.task_branch]).trim();
  assert.equal(secondSha, firstSha, 'no second semantic commit was created');
  assert.equal(countCommitsAheadOfBase(workDir, baseSha, binding.task_branch), 1);
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.equal(remoteSha, firstSha, 'remote is still exactly the one commit — no second push republished anything different');
}));

test('unexpected remote branch content fails closed rather than force-pushing over it', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir, bareDir }) => {
  const project = boundProject(workDir);
  const { commandId, taskId, readBack } = await submitTask({ agentBusRepository, project, payload: { body: 'do the thing', git: { commit: true, push: true } } });
  writeFileSync(join(workDir, 'CHANGE.md'), 'conflict test\n');
  const pmRunId = await createPmRun({ pmRepository, readBack, commandId });
  await driveToCompletedWithoutSettling({ pmRepository, pmRunId });

  const handler = buildHandler({ agentBusRepository, pmRepository, project });
  const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
  await handler.execute({ work, fence: {} }); // settles + pushes for real
  const binding = readBack.context.taskBranch;
  const settledSha = git(workDir, ['rev-parse', binding.task_branch]).trim();

  // Simulate a foreign/conflicting push to the SAME task branch between
  // recovery attempts (e.g. a byzantine actor, or a genuinely different
  // settlement somehow reaching the remote) — from a second, independent
  // clone, never by mutating this worktree's own history.
  const otherClone = mkdtempSync(join(tmpdir(), 'p24-1g7a-conflict-'));
  try {
    git(otherClone, ['clone', '-q', bareDir, '.']);
    git(otherClone, ['checkout', '-q', binding.task_branch]);
    writeFileSync(join(otherClone, 'FOREIGN.md'), 'not ours\n');
    git(otherClone, ['add', '-A']);
    git(otherClone, ['commit', '-q', '-m', 'foreign change']);
    git(otherClone, ['push', '-q', 'origin', binding.task_branch]);
  } finally {
    rmSync(otherClone, { recursive: true, force: true });
  }

  const recoveryOutcome = await handler.execute({ work, fence: {} });
  assert.equal(recoveryOutcome.adopted, true);
  // The local worktree's own task branch must be COMPLETELY untouched — no
  // force-push, no local rewrite, no reset.
  assert.equal(git(workDir, ['rev-parse', binding.task_branch]).trim(), settledSha);
  const [remoteSha] = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/);
  assert.notEqual(remoteSha, settledSha, 'the foreign remote commit is still there — DSH never force-pushed over it');

  const { record } = agentBusRepository.getGitSettlement(taskId);
  assert.equal(record.state, GIT_SETTLEMENT_STATE.BLOCKED);
  assert.equal(record.error_code, 'REMOTE_BRANCH_CONFLICT');
}));

// ---------------------------------------------------------------------------
// Pure journal/trailer helpers
// ---------------------------------------------------------------------------

test('messageCarriesTaskTrailer only matches its OWN exact task_id, never a prefix/substring of a different one', () => {
  const taskId = 'task-abc123';
  const message = `DSH: single task ${taskId} result\n\n${buildTaskCommitTrailer(taskId)}`;
  assert.equal(messageCarriesTaskTrailer(message, taskId), true);
  assert.equal(messageCarriesTaskTrailer(message, 'task-abc'), false, 'must not match a mere prefix of a different task id');
  assert.equal(messageCarriesTaskTrailer(message, 'task-abc1234'), false, 'must not match a superstring of a different task id');
  assert.equal(messageCarriesTaskTrailer('an unrelated commit message', taskId), false);
});
