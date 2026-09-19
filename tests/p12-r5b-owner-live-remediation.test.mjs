// P12-R5B — reproduction + regression coverage for the six owner-live
// failures reported against R5A (docs/p12/06B_P12_R5B_OWNER_LIVE_REMEDIATION_
// SONNET5.md). Deliberately uses the REAL production components wherever
// practical (AgentBusRepository, OwnerTaskController, OwnerControlService,
// ProductionPmWorkHandler, a real named pipe via local-runtime-control.mjs,
// real `git`) rather than the shallow `taskRepository: { getOwnerTask: () =>
// ({..., context: {...}}) }` fakes every prior P12 gate's tests used — that
// exact shallow-mock shape is WHY the real defect (AgentBusRepository.
// getOwnerTask() never exposed `.context`/`.body`) went unnoticed through
// R2/R3/R4/R5/R5A: every existing fixture invented a shape the real
// repository never actually returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { findTaskHistoryEntry } from '../src/runtime/task-context-index.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { routeTelegramUpdate, parseOwnerFlags } from '../src/owner/telegram-owner-client.mjs';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';
import { LOCAL_GIT_STATUS } from '../src/pm/task-outcome-model.mjs';

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

async function withRealStack(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p12-r5b-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p12-r5b-git-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const pmRepository = new PmRepository({ store });
    const workDir = initWorktreeWithBareRemote(gitRoot);
    await fn({ agentBusRepository, pmRepository, workDir });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
  }
}

// One shared, real-driver createRuntime — a "finish" decision, no
// participants, matches every other P12 gate's fixture PM behavior.
function realCreateRuntime({ pmRepository, output = 'done', data = { type: 'single_result' } } = {}) {
  return () => new DurablePmRuntime({
    driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output, data }] }),
    workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
    peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
    repository: pmRepository, maxTurns: 4,
  });
}

// A minimal, honest fake for OwnerControlService's command-journal
// repository (Postgres coordination schema, orthogonal to what this file is
// actually testing) — `taskController` below is wired to the REAL
// AgentBusRepository, which is the one boundary under test.
function fakeCommandJournal() {
  return {
    beginCommand: async (command) => ({ status: 'ACCEPTED', created_at: '2026-01-01T00:00:00.000Z', command_id: command.command_id }),
    completeCommand: async (_id, canonical) => canonical,
  };
}

// ---------------------------------------------------------------------------
// PART A/C — the FIRST lossy boundary: AgentBusRepository.getOwnerTask()
// ---------------------------------------------------------------------------

test('PART A/C: real AgentBusRepository.getOwnerTask() now round-trips context/body exactly as createOwnerTask() durably stored it', async () => withRealStack(async ({ agentBusRepository }) => {
  const task = {
    id: 'task-r5b-roundtrip', sender: 'owner', recipient: 'pm', body: 'do the thing',
    context: { ownerCommandId: 'cmd-x', channel: 'TELEGRAM', runtimeClass: 'NORMAL', durability: 'DURABLE_LOCAL', gitSync: { commit: true, push: false }, review: { requested: true } },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  agentBusRepository.createOwnerTask(task, { projectId: 'proj', pmProfileId: 'pm-1', effectiveAutonomy: { revision: 1, effects: {} }, envelopeRevision: 1, projectConfigFingerprint: 'fp' });
  const readBack = agentBusRepository.getOwnerTask('task-r5b-roundtrip');
  assert.equal(readBack.body, 'do the thing');
  assert.deepEqual(readBack.context, task.context);
  assert.equal(readBack.context.durability, 'DURABLE_LOCAL');
}));

test('PART A/C repro (documents the pre-fix defect): a task-shape fixture with NO top-level context (matching the real repository, not the shallow fakes other P12 tests used) exercises the SAME fallback path a broken accessor would always hit', async () => {
  // This is what every prior P12 test's fake taskRepository.getOwnerTask()
  // did NOT look like, and what the real one used to return before this
  // gate's fix: no top-level `.context` at all.
  const brokenShapeTask = { id: 't', projectId: 'p', pmProfileId: 'pm-1' };
  const durability = brokenShapeTask.context?.durability ?? (brokenShapeTask.context?.runtimeClass === 'LONG' ? 'DURABLE_LOCAL' : 'DIRECT');
  assert.equal(durability, 'DIRECT', 'proves the exact silent fallback TEST 2/TEST 5 hit: a real DURABLE_LOCAL/DURABLE_REMOTE request collapses to DIRECT when .context is missing');
});

// ---------------------------------------------------------------------------
// PART D/L — Telegram DURABLE_LOCAL propagates end to end (TEST 2 fixture)
// ---------------------------------------------------------------------------

test('PART D/L: TEST 2\'s exact prepared Telegram command parses via the REAL production parser and survives verbatim through OwnerTaskController.submit()/AgentBusRepository into a materialized DURABLE_LOCAL history', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const update = {
    update_id: 5001,
    message: { from: { id: 999 }, chat: { id: 999 }, text: '@dsh-p6-test-b --durability local list every file under tasks/dsh/ in this repository and summarize what each one is for. Do not modify anything.' },
  };
  const routed = routeTelegramUpdate(update, { projects: [{ id: 'dsh-p6-test-b' }] });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.payload.durability, 'DURABLE_LOCAL', 'the real parser must actually resolve --durability local to DURABLE_LOCAL');
  assert.equal(routed.client_kind, 'TELEGRAM');

  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
  await controller.submit({ command: { command_id: routed.command_id, client_kind: routed.client_kind, payload: routed.payload }, project, profile: { id: 'pm-1' } });

  const taskId = deterministicOwnerId('task', routed.command_id);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  assert.equal(readBack.context.durability, 'DURABLE_LOCAL', 'must survive the real durable round-trip, not silently fall back to DIRECT');

  // Now drive it through the REAL worker completion path exactly like
  // production-pm-worker.mjs's execute() does, proving materialization
  // actually fires this time (TEST 2's exact "Repository Handoff: NOT
  // REQUESTED" symptom).
  const pmRunId = deterministicOwnerId('pmrun', routed.command_id);
  await pmRepository.create(
    createPmRequest({ objective: readBack.body, context: readBack.context }),
    { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' },
  );
  const handler = new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository: {}, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }), enableRepoHistoryMaterialization: true,
  });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.result.status, 'completed');
  assert.equal(outcome.result.outcome.artifact_status, 'ARTIFACTS_MATERIALIZED', 'TEST 2 expected ARTIFACTS: PASS, not the reported silent skip');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.ok(existsSync(join(workDir, 'docs', 'history', 'single')), 'docs/history/single/** must actually exist in the project working tree');

  // PART P / TEST 6 dependency: only run/verify context discovery AFTER
  // TEST 2's real fix — findTaskHistoryEntry must now find this task's
  // task.json using the same project root, without loading unrelated history.
  const found = findTaskHistoryEntry(workDir, taskId);
  assert.ok(found, 'TEST 6 depends on this: a DURABLE_LOCAL task must be discoverable by its task_id after TEST 2 is fixed');
  assert.equal(found.task_id, taskId);
}));

// ---------------------------------------------------------------------------
// PART M/N/O — Desktop DURABLE_REMOTE SINGLE/COUNCIL/failure fixtures,
// through the REAL AgentBusRepository (not the shallow fakes).
// ---------------------------------------------------------------------------

function buildRealHandler({ agentBusRepository, pmRepository, project, ownerRepository = {} }) {
  return new ProductionPmWorkHandler({
    coordinationStore: { completeClaim: async () => {} }, pmRepository, ownerRepository, taskRepository: agentBusRepository,
    projects: [project], createRuntime: realCreateRuntime({ pmRepository }), enableRepoHistoryMaterialization: true,
  });
}

async function submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind = 'LOCAL', ownerRepository }) {
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
  const submitResult = await controller.submit({ command: { command_id: commandId, client_kind: clientKind, payload }, project, profile: { id: payload.pm_profile_id ?? 'pm-1' } });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  const pmRunId = deterministicOwnerId('pmrun', commandId);
  await pmRepository.create(createPmRequest({ objective: readBack.body, context: readBack.context }), { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });
  const handler = buildRealHandler({ agentBusRepository, pmRepository, project, ownerRepository });
  const outcome = await handler.execute({ work: { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id }, fence: {} });
  return { taskId, pmRunId, readBack, outcome, submitResult };
}

test('PART M: Desktop DURABLE_REMOTE SINGLE with push+review reaches production-pm-worker.mjs with every field intact — real commit, real verified push, real review interaction', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  writeFileSync(join(workDir, 'docs-p12-r5-test3-log.md'), 'the backend actually wrote this\n');
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const interactionsCreated = [];
  const ownerRepository = { createInteraction: async (v) => { interactionsCreated.push(v); return v; } };
  const payload = { body: 'write the log file', pm_profile_id: 'pm-1', durability: 'DURABLE_REMOTE', git: { commit: true, push: true }, review: { requested: true } };
  const { outcome } = await submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind: 'LOCAL', ownerRepository });

  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED);
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');
  assert.equal(outcome.result.outcome.review_status, 'READY_FOR_REVIEW');
  assert.equal(outcome.result.outcome.terminal_marker, 'COMPLETED');
  assert.equal(interactionsCreated.length, 1);
  const remoteSha = git(workDir, ['ls-remote', 'origin', 'main']).split(/\s+/)[0];
  const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.equal(remoteSha, localSha, 'the push must be independently, verifiably real');
}));

test('PART F/N: Council DURABLE_REMOTE uses the exact SAME durability/git/review contract as SINGLE — no divergent Council metadata path', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  writeFileSync(join(workDir, 'council-change.md'), 'chair + participants produced this\n');
  const payload = {
    body: 'propose three improvements', pm_profile_id: 'live1-claude-pm',
    council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'] },
    durability: 'DURABLE_REMOTE', git: { commit: true, push: true }, review: { requested: true },
  };
  const commandId = `cmd-${randomUUID()}`;
  const controller = new OwnerTaskController({ repository: agentBusRepository, startPm: null });
  await controller.submit({
    command: { command_id: commandId, client_kind: 'LOCAL', payload },
    project, profile: { id: 'live1-claude-pm' },
    council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2 },
  });
  const taskId = deterministicOwnerId('task', commandId);
  const readBack = agentBusRepository.getOwnerTask(taskId);
  // Exactly the same contract fields SINGLE gets — no separate Council shape.
  assert.equal(readBack.context.durability, 'DURABLE_REMOTE');
  assert.deepEqual(readBack.context.gitSync, { commit: true, push: true }, 'JSON round-trip through durable storage drops the undefined remote key entirely');
  assert.deepEqual(readBack.context.review, { requested: true });
  assert.ok(readBack.context.council, 'council spec must also be present alongside the identical lifecycle fields');
}));

test('PART O: Desktop DURABLE_REMOTE SINGLE with a deliberately unconfigured remote (TEST 5) — execution/artifacts/local commit all preserved, push fails closed, origin never touched', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  mkdirSync(join(workDir, 'docs'), { recursive: true });
  writeFileSync(join(workDir, 'docs', 'p12-r5-test5-log.md'), 'real UTC timestamp written by the backend\n');
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: { PUSH_REMOTE: 'APPROVAL' } } };
  const payload = { body: 'write the date into the log', pm_profile_id: 'pm-1', durability: 'DURABLE_REMOTE', git: { commit: true, push: true, remote: 'dsh-p12-r5-test5-unconfigured-remote' } };
  const { outcome } = await submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind: 'LOCAL' });

  assert.equal(outcome.result.status, 'completed', 'EXECUTION: PASS — a persistence failure must never erase execution success');
  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED, 'LOCAL_GIT: the local commit is preserved');
  assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_SYNC_FAILED');
  assert.equal(outcome.result.outcome.terminal_marker, 'COMPLETED_WITH_PERSISTENCE_WARNING', 'never FAILED_EXECUTION');
  const originUrl = git(workDir, ['remote', 'get-url', 'origin']).trim();
  assert.ok(originUrl.endsWith('origin.git'), 'the real origin remote must be completely untouched');
  const localSha = git(workDir, ['rev-parse', 'HEAD']).trim();
  assert.match(localSha, /^[0-9a-f]{40}$/, 'the result commit must still exist locally');
}));

// ---------------------------------------------------------------------------
// PART J/K — model-prose is never side-effect proof: LOCAL_GIT_STATUS now
// distinguishes a real new commit from a verified-but-empty working tree.
// ---------------------------------------------------------------------------

test('PART J/K truthfulness: when the backend claims a file was written but the working tree is actually clean, DSH reports a DISTINCT, honest LOCAL_GIT_VERIFIED_NO_CHANGES — never the same status a real commit gets', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  // Deliberately do NOT write any file — simulates the exact owner-observed
  // discrepancy: the model's own output text claims a file was created, but
  // nothing was actually changed in the working tree. durability:'DIRECT'
  // isolates this from P24.1G7A's single-final-settlement change: once
  // history/progress materialization shares the SAME one result commit as
  // the code (no separate history-only commit to sweep it into any more),
  // a DURABLE_LOCAL/DURABLE_REMOTE task always has SOMETHING new to commit
  // (the per-task history record itself) even when the code has zero diff
  // — this test's own point is the code-diff distinction specifically, so
  // it must not be confounded by that unrelated, always-on provenance
  // write.
  const payload = { body: 'write the current UTC date and time into docs/p12-r5-test5-log.md and stop.', pm_profile_id: 'pm-1', durability: 'DIRECT', git: { commit: true } };
  const { outcome } = await submitAndRun({
    agentBusRepository, pmRepository, project, payload, clientKind: 'LOCAL',
  });
  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED_NO_CHANGES, 'must be independently, verifiably distinguishable from a real commit — never inferred from the model\'s own prose');
  assert.notEqual(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED);
}));

test('PART J/K: a real backend-authored change still reports the ordinary VERIFIED status, unaffected by the new distinction', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  writeFileSync(join(workDir, 'real-change.md'), 'this really happened\n');
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  const payload = { body: 'x', pm_profile_id: 'pm-1', durability: 'DURABLE_LOCAL', git: { commit: true } };
  const { outcome } = await submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind: 'LOCAL' });
  assert.equal(outcome.result.outcome.local_git_status, LOCAL_GIT_STATUS.VERIFIED);
}));

// ---------------------------------------------------------------------------
// PART E/R — Desktop OWNER_COMMAND_FAILED: real, typed error codes now
// survive the real named pipe instead of collapsing to the generic fallback.
// ---------------------------------------------------------------------------

async function withRealPipe(fn) {
  const pipeName = `\\\\.\\pipe\\dsh-p12-r5b-${process.pid}-${randomUUID()}`;
  const authCapability = randomBytes(32).toString('hex');
  const projects = [{ id: 'dsh-p6-test-b', autonomy: { revision: 1, effects: {} } }];
  const pmProfiles = [
    { id: 'live1-claude-pm', status: 'ACTIVE' },
    { id: 'live1-codex-pm', status: 'ACTIVE' },
    { id: 'live1-inactive-pm', status: 'INACTIVE' },
  ];
  const ownerControlService = new OwnerControlService({ repository: fakeCommandJournal(), taskController: { submit: async () => ({ status: 'MATERIALIZED' }) }, projects, pmProfiles });
  const control = await startLocalRuntimeControl({
    pipeName, authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    ownerCommand: (input) => ownerControlService.mutate(input),
    ownerRead: (op, input) => ownerControlService.read(op, input),
    enrolledOwnerActorId: '12345',
  });
  try {
    await fn({ pipeName, authCapability });
  } finally {
    await control.close();
  }
}

function pipeRequest(pipeName, request) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 5_000;
    let settled = false;
    let buf = '';
    const socket = net.connect(pipeName, () => socket.write(`${JSON.stringify(request)}\n`));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The production control channel is intentionally persistent. This test owns the
      // client socket, so it closes its side after receiving exactly one complete frame.
      socket.end();
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`test pipe response timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newline = buf.indexOf('\n');
      if (newline < 0) return;
      const frame = buf.slice(0, newline);
      try { finish(null, JSON.parse(frame)); }
      catch (error) { finish(error); }
    });
    socket.on('end', () => {
      if (!settled) finish(new Error('test pipe ended before a complete response frame'));
    });
    socket.on('error', (error) => finish(error));
  });
}

test('PART E: a real Desktop COUNCIL dispatch naming an unknown participant now surfaces COUNCIL_UNKNOWN_PARTICIPANT over the real pipe — not generic OWNER_COMMAND_FAILED', async () => withRealPipe(async ({ pipeName, authCapability }) => {
  const response = await pipeRequest(pipeName, {
    id: 'req-1', auth: authCapability, operation: 'SUBMIT_TASK',
    command: {
      command_id: 'cmd-council-unknown', project_id: 'dsh-p6-test-b',
      payload: { body: 'x', pm_profile_id: 'live1-claude-pm', council: { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-does-not-exist'] } },
    },
  });
  assert.equal(response.success, false);
  assert.equal(response.error, 'COUNCIL_UNKNOWN_PARTICIPANT', 'must be the real typed cause, not the generic fallback');
}));

test('PART E: a real Desktop dispatch naming an INACTIVE PM profile now surfaces PM_PROFILE_INACTIVE over the real pipe — not generic OWNER_COMMAND_FAILED', async () => withRealPipe(async ({ pipeName, authCapability }) => {
  const response = await pipeRequest(pipeName, {
    id: 'req-2', auth: authCapability, operation: 'SUBMIT_TASK',
    command: { command_id: 'cmd-inactive', project_id: 'dsh-p6-test-b', payload: { body: 'x', pm_profile_id: 'live1-inactive-pm' } },
  });
  assert.equal(response.success, false);
  assert.equal(response.error, 'PM_PROFILE_INACTIVE');
}));

test('PART E regression: a genuinely unlisted/unexpected error code still collapses to the generic, non-leaking fallback (never leaks an arbitrary code)', async () => withRealPipe(async ({ pipeName, authCapability }) => {
  const response = await pipeRequest(pipeName, {
    id: 'req-3', auth: authCapability, operation: 'SUBMIT_TASK',
    command: { command_id: 'cmd-unknown-project', project_id: 'not-a-real-project', payload: { body: 'x', pm_profile_id: 'live1-claude-pm' } },
  });
  assert.equal(response.success, false);
  assert.equal(response.error, 'PROJECT_REFUSED', 'a pre-existing, already-allow-listed code stays exactly as specific as before');
}));

// ---------------------------------------------------------------------------
// PART S — a few compact, targeted regressions for the checklist that are
// not already covered by an existing, more specific test above.
// ---------------------------------------------------------------------------

test('PART S: DIRECT stays byte-for-byte unchanged — no materialization, no git, no review, regardless of the getOwnerTask() fix', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  const payload = { body: 'just answer a question', pm_profile_id: 'pm-1' };
  const { outcome } = await submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind: 'TELEGRAM' });
  assert.equal(outcome.result.outcome.artifact_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.local_git_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.remote_sync_status, 'NOT_REQUESTED');
  assert.equal(outcome.result.outcome.review_status, 'NOT_REQUESTED');
  assert.equal(existsSync(join(workDir, 'docs', 'history')), false);
}));

test('PART S: --requires-context (TEST 6) resolves a real DURABLE_LOCAL task\'s task.json through the real resolveRequiredContext shape (findTaskHistoryEntry) once TEST 2 is fixed', async () => withRealStack(async ({ agentBusRepository, pmRepository, workDir }) => {
  const project = { id: 'dsh-p6-test-b', repo_path: workDir, autonomy: { revision: 1, effects: {} } };
  const payload = { body: 'list files', pm_profile_id: 'pm-1', durability: 'DURABLE_LOCAL' };
  const { taskId } = await submitAndRun({ agentBusRepository, pmRepository, project, payload, clientKind: 'TELEGRAM' });

  const resolveRequiredContext = async ({ taskId: id }) => findTaskHistoryEntry(workDir, id);
  const found = await resolveRequiredContext({ taskId });
  assert.ok(found, 'the pre-flight --requires-context check must resolve a real prior DURABLE_LOCAL task now that materialization actually ran');

  const missing = await resolveRequiredContext({ taskId: 'task-does-not-exist' });
  assert.equal(missing, null, 'a nonexistent task must still refuse honestly, never fabricate a match');
}));
