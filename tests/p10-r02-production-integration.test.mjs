import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';
import { TaskDiagnosticLog, taskLogDir, createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';

const PROFILES = [
  { id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'high' },
  { id: 'live1-codex-gpt-5-6-sol-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'gpt-5.6-sol', reasoning: 'medium' },
  { id: 'live1-antigravity-gemini-high', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'gemini-3.7-flash-high', reasoning: 'high' },
  { id: 'live1-opencode-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'opencode', transport: 'stdio', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high' },
];
const ALLOWED = ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'];

function compliantResolveDriver({ synthesisOutput = 'DSH T1 synthesis complete.\nP10-T1-MARKER=ORBIT-417' } = {}) {
  return (profile) => ({
    name: `fake:${profile.id}`,
    async decide(input) {
      const stepKind = input.request.context.stepKind;
      if (stepKind === 'chair_plan') {
        const ids = input.request.context.participantProfileIds ?? [];
        const instructions = Object.fromEntries(ids.map((id) => [id, `focus ${id}`]));
        return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be rigorous', synthesis_focus: 'converge' } };
      }
      if (stepKind === 'participant_report') return { type: 'finish', output: `report from ${profile.id}`, data: { type: 'council_report', analysis: `analysis from ${profile.id}`, recommendation: `rec from ${profile.id}`, risks: [], uncertainties: [] } };
      if (stepKind === 'participant_critique') return { type: 'finish', output: `critique from ${profile.id}`, data: { type: 'council_critique', criticisms: [], agreements: ['agree'], revised_recommendation: `revised from ${profile.id}`, remaining_disagreements: [] } };
      return { type: 'finish', output: synthesisOutput, data: { type: 'council_synthesis' } };
    },
  });
}

async function withFixture(fn) {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'dsh-p10r02-sqlite-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-p10r02-logs-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-p10r02-project-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const pmRepository = new PmRepository({ store });
    await fn({ pmRepository, logRoot, projectRoot });
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function buildHandler({ pmRepository, logRoot, projectRoot, project, resolveDriver, enableRepoHistoryMaterialization = true }) {
  const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: logRoot });
  const profileRegistry = new PmProfileRegistry(PROFILES);
  const coordinationStore = { completeClaim: async () => {} };
  const ownerRepository = {};
  // P12-R2: materialization is now gated on durability !== 'DIRECT' (a
  // plain-prompt task defaults to DIRECT/no-write — the owner-approved
  // P12-R0 §3 behavior change). These fixtures explicitly request
  // DURABLE_LOCAL so they keep testing exactly what they tested before
  // P12: real materialization behavior, now via an explicit request
  // rather than an implicit unconditional default.
  const taskRepository = { getOwnerTask: (id) => (id === project.taskId ? { id, projectId: project.id, pmProfileId: 'live1-claude-pm', context: { durability: 'DURABLE_LOCAL' } } : null) };
  const createRuntime = ({ council, taskId, pmRunId }) => {
    const chairDriver = new CouncilChairDriver({ council, ownerTask: 'P10 T1 miniqueue' });
    const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, project, extraCtx: () => ({ taskId, pmRunId, taskMode: 'COUNCIL' }), taskLog: taskDiagnosticsFactory({ taskId, projectId: project.id, pmRunId, taskMode: 'COUNCIL' }) });
    const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
    return new DurablePmRuntime({ driver: chairDriver, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 16, taskLog: taskDiagnosticsFactory({ taskId, projectId: project.id, pmRunId, taskMode: 'COUNCIL' }) });
  };
  const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, profileRegistry, enableRepoHistoryMaterialization });
  return { handler, taskDiagnosticsFactory };
}

test('a real end-to-end COUNCIL run through ProductionPmWorkHandler.execute() materializes docs/history and emits HANDOFF diagnostics', async () => {
  await withFixture(async ({ pmRepository, logRoot, projectRoot }) => {
    const commandId = 'cmd-p10r02-t1';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'dsh-p6-test-b', repo_path: projectRoot, taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
    const request = createPmRequest({ objective: 'P10 SESSION TEST T1 — INITIAL ARCHITECTURE COUNCIL.\nP10-T1-MARKER=ORBIT-417', context: { ownerCommandId: commandId, council, channel: 'TELEGRAM' } });
    const pmRunId = 'pmrun-p10r02-t1';
    await pmRepository.create(request, { id: pmRunId, driver: `council:live1-claude-pm`, startedAt: '2026-08-24T00:00:00.000Z' });

    const { handler, taskDiagnosticsFactory } = buildHandler({ pmRepository, logRoot, projectRoot, project, resolveDriver: compliantResolveDriver() });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.status, 'completed');

    // ---- docs/history landed in the OWNER project, not the runtime dir ----
    const historyCouncilDir = join(projectRoot, 'docs', 'history', 'council');
    assert.ok(existsSync(historyCouncilDir), 'docs/history/council was created');
    const { readdirSync } = await import('node:fs');
    const [folder] = readdirSync(historyCouncilDir);
    const taskDir = join(historyCouncilDir, folder);
    assert.ok(existsSync(join(taskDir, 'Task.md')));
    assert.ok(existsSync(join(taskDir, 'chair', 'Synthesis.md')));
    assert.match(readFileSync(join(taskDir, 'chair', 'Synthesis.md'), 'utf8'), /P10-T1-MARKER=ORBIT-417/);
    for (const id of ALLOWED) assert.match(readFileSync(join(taskDir, 'Task.md'), 'utf8'), new RegExp(id));

    // ---- progress.md in the owner project ----
    const progress = readFileSync(join(projectRoot, 'progress.md'), 'utf8');
    assert.match(progress, new RegExp(taskId));

    // ---- runtime diagnostic bundle shows handoff diagnostics ----
    const dir = taskLogDir(logRoot, taskId);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.event_type === 'HANDOFF_MATERIALIZATION_START'));
    assert.ok(events.some((e) => e.event_type === 'HANDOFF_MATERIALIZATION_COMPLETED'));
    assert.ok(!events.some((e) => e.event_type === 'HANDOFF_MATERIALIZATION_FAILED'));

    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /Repository Handoff/);
    assert.match(summary, /status: COMPLETED/);
    assert.match(summary, /history path: docs\/history\/council/);
  });
});

test('a FAILED council run never gets auto-materialized repo history, and summary.md shows NOT REQUESTED', async () => {
  await withFixture(async ({ pmRepository, logRoot, projectRoot }) => {
    const commandId = 'cmd-p10r02-fail';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'dsh-p6-test-b', repo_path: projectRoot, taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
    // A chair that always mangles the opencode id -- fails closed after the bounded repair (never reaches COMPLETED).
    const resolveDriver = () => ({
      name: 'fake-chair',
      async decide(input) {
        const ids = input.request.context.participantProfileIds ?? [];
        const instructions = Object.fromEntries(ids.map((id) => [id, `focus ${id}`]));
        instructions['live1-opencode-pm_note'] = 'stray';
        return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'x', synthesis_focus: 'y' } };
      },
    });
    const request = createPmRequest({ objective: 'P10 T1 miniqueue', context: { ownerCommandId: commandId, council, channel: 'TELEGRAM' } });
    const pmRunId = 'pmrun-p10r02-fail';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:live1-claude-pm', startedAt: '2026-08-24T00:00:00.000Z' });

    const { handler } = buildHandler({ pmRepository, logRoot, projectRoot, project, resolveDriver });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.result.status, 'failed');
    assert.ok(!existsSync(join(projectRoot, 'docs', 'history')), 'no docs/history for a FAILED task in this wave');
    assert.ok(!existsSync(join(projectRoot, 'progress.md')));

    const dir = taskLogDir(logRoot, taskId);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.event_type.startsWith('HANDOFF_MATERIALIZATION')));
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /Repository Handoff/);
    assert.match(summary, /status: NOT REQUESTED/);
  });
});

test('a materialization failure (e.g. an unwritable project root) is recorded as HANDOFF_MATERIALIZATION_FAILED but the task result stays COMPLETED', async () => {
  await withFixture(async ({ pmRepository, logRoot, projectRoot }) => {
    const commandId = 'cmd-p10r02-handoff-fail';
    const taskId = deterministicOwnerId('task', commandId);
    // A non-absolute repo_path makes assertWithinProjectRoot's isAbsolute() guard throw deterministically.
    const project = { id: 'dsh-p6-test-b', repo_path: 'relative/not/absolute', taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
    const request = createPmRequest({ objective: 'P10 T1 miniqueue', context: { ownerCommandId: commandId, council, channel: 'TELEGRAM' } });
    const pmRunId = 'pmrun-p10r02-handoff-fail';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:live1-claude-pm', startedAt: '2026-08-24T00:00:00.000Z' });

    const { handler } = buildHandler({ pmRepository, logRoot, projectRoot, project, resolveDriver: compliantResolveDriver() });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    // The council itself still completed successfully.
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.status, 'completed');

    const dir = taskLogDir(logRoot, taskId);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.event_type === 'HANDOFF_MATERIALIZATION_FAILED'));
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /status: FAILED/);
  });
});

test('Part AA: a real end-to-end SINGLE (non-council) run through ProductionPmWorkHandler.execute() materializes docs/history/single with no chair/ or members/ subfolders', async () => {
  await withFixture(async ({ pmRepository, logRoot, projectRoot }) => {
    const commandId = 'cmd-p10r02-single';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'dsh-p6-test-b', repo_path: projectRoot, taskId };
    const request = createPmRequest({ objective: 'Investigate the flaky test and report findings.', context: { ownerCommandId: commandId, channel: 'LOCAL' } });
    const pmRunId = 'pmrun-p10r02-single';
    await pmRepository.create(request, { id: pmRunId, driver: 'single-pm-fake', startedAt: '2026-08-24T00:00:00.000Z' });

    const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: logRoot });
    const profileRegistry = new PmProfileRegistry(PROFILES);
    const coordinationStore = { completeClaim: async () => {} };
    const ownerRepository = {};
    // P12-R2: see the identical comment on buildHandler()'s taskRepository above.
    const taskRepository = { getOwnerTask: (id) => (id === taskId ? { id, projectId: project.id, pmProfileId: 'live1-claude-pm', context: { durability: 'DURABLE_LOCAL' } } : null) };
    const createRuntime = ({ taskId: t, pmRunId: r }) => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'Root cause identified: flaky assertion ordering.', data: { type: 'single_result', summary: 'flaky assertion ordering' } }] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4, taskLog: taskDiagnosticsFactory({ taskId: t, projectId: project.id, pmRunId: r, taskMode: 'SINGLE' }),
    });
    const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository, taskRepository, projects: [project], createRuntime, taskDiagnosticsFactory, profileRegistry, enableRepoHistoryMaterialization: true });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.result.status, 'completed');
    const historySingleDir = join(projectRoot, 'docs', 'history', 'single');
    assert.ok(existsSync(historySingleDir));
    const { readdirSync } = await import('node:fs');
    const [folder] = readdirSync(historySingleDir);
    const taskDir = join(historySingleDir, folder);
    for (const f of ['Task.md', 'PM.md', 'Plan.md', 'Walkthrough.md', 'ExecutionLog.md']) assert.ok(existsSync(join(taskDir, f)), `missing ${f}`);
    assert.ok(!existsSync(join(taskDir, 'chair')));
    assert.ok(!existsSync(join(taskDir, 'members')));
    assert.match(readFileSync(join(taskDir, 'Plan.md'), 'utf8'), /Root cause identified/);
  });
});

test('the existing P2-P9 test suite pattern (no profileRegistry/enableRepoHistoryMaterialization deps) gets zero repo-history writes', async () => {
  await withFixture(async ({ pmRepository, logRoot, projectRoot }) => {
    const commandId = 'cmd-p10r02-optout';
    const taskId = deterministicOwnerId('task', commandId);
    const project = { id: 'dsh-p6-test-b', repo_path: projectRoot, taskId };
    const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
    const request = createPmRequest({ objective: 'P10 T1 miniqueue', context: { ownerCommandId: commandId, council, channel: 'TELEGRAM' } });
    const pmRunId = 'pmrun-p10r02-optout';
    await pmRepository.create(request, { id: pmRunId, driver: 'council:live1-claude-pm', startedAt: '2026-08-24T00:00:00.000Z' });

    const { handler } = buildHandler({ pmRepository, logRoot, projectRoot, project, resolveDriver: compliantResolveDriver(), enableRepoHistoryMaterialization: false });
    const work = { pm_run_id: pmRunId, action_id: pmWorkIdentity({ taskId, pmRunId }).action_id };
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.result.status, 'completed');
    assert.ok(!existsSync(join(projectRoot, 'docs', 'history')));
    assert.ok(!existsSync(join(projectRoot, 'progress.md')));
  });
});
