import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeReviewRequest, OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { REVIEW_STATUS } from '../src/pm/task-outcome-model.mjs';
import { renderInteraction } from '../src/owner/telegram-owner-client.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';

// ---- normalizeReviewRequest (pure) -----------------------------------------

test('normalizeReviewRequest: absent/malformed input is null', () => {
  assert.equal(normalizeReviewRequest(undefined), null);
  assert.equal(normalizeReviewRequest({}), null);
  assert.equal(normalizeReviewRequest({ requested: 'yes' }), null, 'must be boolean true, not truthy');
});

test('normalizeReviewRequest: {requested:true} is preserved', () => {
  assert.deepEqual(normalizeReviewRequest({ requested: true }), { requested: true });
});

test('review is stamped into durable context exactly once, absent when not supplied', async () => {
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });
  const project = { id: 'p', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  await controller.submit({ command: { command_id: 'c-review', client_kind: 'LOCAL', payload: { body: 'x', review: { requested: true } } }, project, profile: { id: 'pm-1' } });
  assert.deepEqual(created[0].context.review, { requested: true });
  await controller.submit({ command: { command_id: 'c-noreview', client_kind: 'LOCAL', payload: { body: 'x' } }, project, profile: { id: 'pm-1' } });
  assert.equal('review' in created[1].context, false);
});

// ---- renderInteraction: SYSTEM vs PM origin --------------------------------

test('renderInteraction labels a SYSTEM-origin interaction as DSH SYSTEM, never "UNTRUSTED PM PROSE"', () => {
  const text = renderInteraction({ origin: 'SYSTEM', title: 'DSH task ready for PM review', prompt_text: 'Respond ACCEPT or REMEDIATE.', runtime_facts: {} });
  assert.match(text, /\[DSH SYSTEM\]/);
  assert.equal(text.includes('[UNTRUSTED PM PROSE]'), false);
});

test('renderInteraction still labels a PM-origin interaction as untrusted prose (unchanged regression check)', () => {
  const text = renderInteraction({ origin: 'PM', title: 'Some model-authored question', prompt_text: 'What should I do?', runtime_facts: {} });
  assert.match(text, /\[UNTRUSTED PM PROSE\]/);
});

// ---- full end-to-end: review status + review interaction ------------------

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
  return workDir;
}

async function withHandler(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p12-r4-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p12-r4-git-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const pmRepository = new PmRepository({ store });
    const workDir = initWorktreeWithBareRemote(gitRoot);
    writeFileSync(join(workDir, 'CHANGE.md'), 'the actual work\n'); // simulate a real backend edit
    await fn({ pmRepository, workDir });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
  }
}

function buildHandler({ pmRepository, project, interactionsCreated, taskRepositoryContext }) {
  const ownerRepository = { createInteraction: async (v) => { interactionsCreated.push(v); return v; } };
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'pm-1', context: taskRepositoryContext } : null) };
  const createRuntime = ({ taskId: t, pmRunId: r }) => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'done', data: { type: 'single_result' } }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
  const coordinationStore = { completeClaim: async () => {} };
  return new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, enableRepoHistoryMaterialization: false });
}

test('review requested + real verified push -> READY_FOR_REVIEW and a real actionable interaction is created', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-ready';
  const taskId = deterministicOwnerId('task', commandId);
  // P12-R5: PUSH_REMOTE is a pre-existing autonomy effect
  // (autonomy-envelope.mjs) production-pm-worker.mjs now consults before
  // ever attempting a push — this project explicitly grants it (a
  // dedicated test below proves the opposite: FORBID actually blocks it).
  const project = { id: 'proj-r4', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'ALLOW' } } };
  const request = createPmRequest({
    objective: 'do the thing', id: undefined,
    context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DURABLE_REMOTE', git: { commit: true, push: true }, review: { requested: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-r4-ready', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const interactionsCreated = [];
  const handler = buildHandler({ pmRepository, project, interactionsCreated, taskRepositoryContext: { durability: 'DURABLE_REMOTE', gitSync: { commit: true, push: true }, review: { requested: true } } });
  const work = { pm_run_id: 'pmrun-r4-ready', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-ready' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(outcome.result.outcome.review_status, REVIEW_STATUS.READY_FOR_REVIEW);
  assert.equal(outcome.result.outcome.terminal_marker, 'COMPLETED');

  assert.equal(interactionsCreated.length, 1);
  assert.equal(interactionsCreated[0].kind, 'APPROVAL');
  assert.equal(interactionsCreated[0].origin, 'SYSTEM');
  assert.deepEqual(interactionsCreated[0].allowed_responses, ['ACCEPT', 'REMEDIATE']);
  assert.equal(interactionsCreated[0].requires_response, true);
  assert.match(interactionsCreated[0].runtime_facts.result_commit, /^[0-9a-f]{40}$/);

  // Independently verify the push actually landed.
  const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.equal(interactionsCreated[0].runtime_facts.result_commit, localSha);
}));

// P12-R5: PUSH_REMOTE:FORBID (a real, pre-existing per-project autonomy
// setting — e.g. this repo's own `.runtime/live1/projects.yaml` sets this
// exact effect to FORBID for the `live1-local` project) must actually
// block a requested push — the local commit still succeeds and is
// preserved (P12-R2-F: a persistence failure never erases execution
// success), but nothing is ever pushed, and no remote-tracking ref is
// touched.
test('PUSH_REMOTE:FORBID actually blocks the push — local commit still succeeds, nothing is pushed', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-forbid';
  const taskId = deterministicOwnerId('task', commandId);
  const project = { id: 'proj-r4', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'FORBID' } } };
  const request = createPmRequest({
    objective: 'do the thing',
    context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DURABLE_REMOTE', git: { commit: true, push: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-r4-forbid', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const interactionsCreated = [];
  const handler = buildHandler({ pmRepository, project, interactionsCreated, taskRepositoryContext: { durability: 'DURABLE_REMOTE', gitSync: { commit: true, push: true } } });
  const work = { pm_run_id: 'pmrun-r4-forbid', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-forbid' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED', 'the local commit itself is NOT gated — only the remote push is');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_SYNC_FAILED');
  assert.equal(outcome.result.outcome.terminal_marker, 'COMPLETED_WITH_PERSISTENCE_WARNING');

  // Independently verify: the origin bare repo never received the commit.
  const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  const remoteSha = git(workDir, ['ls-remote', 'origin', 'main']).split(/\s+/)[0];
  assert.notEqual(remoteSha, localSha, 'FORBID must have prevented the push from ever reaching the remote');
}));

// P12-R5: matches the real, currently-configured `dsh-p6-test-b` project
// (this repo's own `.runtime/live1/projects.yaml` sets exactly
// PUSH_REMOTE:APPROVAL for it) — a LOCAL-channel task's own explicit
// `--push` request IS the contemporaneous approval act; it must succeed
// without the owner needing to separately EXPAND_AUTONOMY first.
test('PUSH_REMOTE:APPROVAL from a LOCAL-channel task succeeds — the explicit --push request itself satisfies the approval', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-approval-local';
  const taskId = deterministicOwnerId('task', commandId);
  const project = { id: 'proj-r4', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({
    objective: 'do the thing',
    context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DURABLE_REMOTE', git: { commit: true, push: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-r4-approval-local', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, interactionsCreated: [], taskRepositoryContext: { durability: 'DURABLE_REMOTE', gitSync: { commit: true, push: true } } });
  const work = { pm_run_id: 'pmrun-r4-approval-local', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-approval-local' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
}));

test('PUSH_REMOTE:APPROVAL from a TELEGRAM-originated task is refused outright — remote effects are never authorized from a remote channel', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-approval-telegram';
  const taskId = deterministicOwnerId('task', commandId);
  const project = { id: 'proj-r4', repo_path: workDir, taskId, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const request = createPmRequest({
    objective: 'do the thing',
    context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DURABLE_REMOTE', git: { commit: true, push: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-r4-approval-telegram', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildHandler({ pmRepository, project, interactionsCreated: [], taskRepositoryContext: { durability: 'DURABLE_REMOTE', gitSync: { commit: true, push: true } } });
  const work = { pm_run_id: 'pmrun-r4-approval-telegram', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-approval-telegram' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_SYNC_FAILED');
}));

test('review requested but push never happened -> REVIEW_BLOCKED_REMOTE, execution stays preserved, no interaction created', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-blocked';
  const taskId = deterministicOwnerId('task', commandId);
  const project = { id: 'proj-r4', repo_path: workDir, taskId };
  const request = createPmRequest({
    objective: 'do the thing',
    context: { ownerCommandId: commandId, channel: 'LOCAL', durability: 'DURABLE_LOCAL', review: { requested: true } },
  });
  await pmRepository.create(request, { id: 'pmrun-r4-blocked', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const interactionsCreated = [];
  const handler = buildHandler({ pmRepository, project, interactionsCreated, taskRepositoryContext: { durability: 'DURABLE_LOCAL', review: { requested: true } } });
  const work = { pm_run_id: 'pmrun-r4-blocked', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-blocked' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });

  assert.equal(outcome.result.status, 'completed', 'execution succeeds regardless of review being blocked');
  assert.equal(outcome.result.outcome.review_status, REVIEW_STATUS.BLOCKED_REMOTE);
  assert.notEqual(outcome.result.outcome.execution_status, 'EXECUTION_FAILED');
  assert.equal(interactionsCreated.length, 0, 'no actionable review interaction when there is nothing pushed to review yet');
}));

test('review not requested -> NOT_REQUESTED, no interaction, zero behavior change for every existing caller', async () => withHandler(async ({ pmRepository, workDir }) => {
  const commandId = 'cmd-r4-none';
  const taskId = deterministicOwnerId('task', commandId);
  const project = { id: 'proj-r4', repo_path: workDir, taskId };
  const request = createPmRequest({ objective: 'do the thing', context: { ownerCommandId: commandId, channel: 'LOCAL' } });
  await pmRepository.create(request, { id: 'pmrun-r4-none', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const interactionsCreated = [];
  const handler = buildHandler({ pmRepository, project, interactionsCreated, taskRepositoryContext: {} });
  const work = { pm_run_id: 'pmrun-r4-none', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-r4-none' }).action_id };
  const outcome = await handler.execute({ work, fence: {} });
  assert.equal(outcome.result.outcome.review_status, REVIEW_STATUS.NOT_REQUESTED);
  assert.equal(interactionsCreated.length, 0);
}));
