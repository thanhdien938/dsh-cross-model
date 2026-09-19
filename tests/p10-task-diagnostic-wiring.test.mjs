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
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { TaskDiagnosticLog, taskLogDir, createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';
import { finalizeTaskDiagnostics } from '../src/runtime/production-pm-worker.mjs';

const PROJECT = Object.freeze({ id: 'dsh-p6-test-b', repo_path: '/tmp/proj' });
const ALLOWED = ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'];

async function withSqliteFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-wire-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') }); await store.migrate();
    await fn(new PmRepository({ store }));
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function compliantResolveDriver() {
  return (profile) => ({
    name: `fake:${profile.id}`,
    async decide(input) {
      const stepKind = input.request.context.stepKind;
      if (stepKind === 'chair_plan') {
        const ids = input.request.context.participantProfileIds ?? [];
        const instructions = Object.fromEntries(ids.map((id) => [id, `focus ${id}`]));
        return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be rigorous', synthesis_focus: 'converge' } };
      }
      if (stepKind === 'participant_report') return { type: 'finish', output: 'report', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      if (stepKind === 'participant_critique') return { type: 'finish', output: 'critique', data: { type: 'council_critique', criticisms: [], agreements: ['agree'], revised_recommendation: 'r2', remaining_disagreements: [] } };
      return { type: 'finish', output: 'DSH T1 miniqueue synthesis complete.', data: { type: 'council_synthesis' } };
    },
  });
}

// P10-R0.1 Part T/W: proves the REAL DurablePmRuntime/CouncilStepWorkflowRunner
// output shape (turn history, handoff.repaired, council finish `data`) flows
// through finalizeTaskDiagnostics() into real summary.md/council.json files
// on disk — not just the pure builder functions in isolation.
test('a real end-to-end council run produces a task diagnostic bundle with events.jsonl, summary.md, council.json', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-p10-tasklogs-'));
  try {
    await withSqliteFixture(async (repository) => {
      const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
      const taskId = 'task_p10_t1';
      const taskLog = new TaskDiagnosticLog({ runtimeRoot: logRoot, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL' });
      const chairDriver = new CouncilChairDriver({ council, ownerTask: 'P10 T1 miniqueue' });
      const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver: compliantResolveDriver(), project: PROJECT, taskLog });
      const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
      const runtime = new DurablePmRuntime({ driver: chairDriver, workflowRunner, peerRelay, repository, maxTurns: 16, taskLog });
      runtime.prepare({ objective: 'P10 T1 miniqueue', context: { ownerCommandId: 'cmd-t1', council }, pmRunId: 'pmrun_t1' });

      const result = await runtime.executePrepared('pmrun_t1');
      assert.equal(result.status, 'completed');

      finalizeTaskDiagnostics({ taskLog, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL', submittedVia: 'OWNER', council, result });

      const dir = taskLogDir(logRoot, taskId);
      assert.ok(existsSync(join(dir, 'events.jsonl')), 'events.jsonl exists');
      assert.ok(existsSync(join(dir, 'summary.md')), 'summary.md exists');
      assert.ok(existsSync(join(dir, 'council.json')), 'council.json exists');

      const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const types = events.map((e) => e.event_type);
      assert.ok(types.includes('PM_RUN_CREATED'));
      assert.ok(types.includes('COUNCIL_PLAN_START'));
      assert.ok(types.includes('COUNCIL_PLAN_RESULT'));
      assert.equal(types.filter((t) => t === 'PARTICIPANT_START').length, ALLOWED.length);
      assert.equal(types.filter((t) => t === 'PARTICIPANT_RESULT').length, ALLOWED.length);
      assert.ok(types.includes('CRITIQUE_START'));
      assert.ok(types.includes('CHAIR_SYNTHESIS_START'));
      assert.ok(types.includes('CHAIR_SYNTHESIS_RESULT'));
      assert.ok(types.includes('TASK_COMPLETED'));
      // Chronological: events are in append order, which is call order.
      const timestamps = events.map((e) => e.timestamp);
      assert.deepEqual(timestamps, [...timestamps].sort());

      const council_json = JSON.parse(readFileSync(join(dir, 'council.json'), 'utf8'));
      assert.equal(council_json.chair_profile_id, 'live1-claude-pm');
      assert.deepEqual(council_json.participant_profile_ids, ALLOWED);
      assert.equal(council_json.status, 'completed');

      const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
      assert.match(summary, /DSH Task Diagnostic Summary/);
      assert.match(summary, /live1-claude-pm/);
      for (const id of ALLOWED) assert.match(summary, new RegExp(id));
      assert.match(summary, /Terminal Result/);
      assert.match(summary, /status: completed/);
    });
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('the exact owner failure, end-to-end through DurablePmRuntime, produces a failed task with a repaired-once diagnostic trail', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-p10-tasklogs-fail-'));
  try {
    await withSqliteFixture(async (repository) => {
      const council = normalizeCouncilSpec({ chair_profile_id: 'live1-claude-pm', participant_profile_ids: ALLOWED, rounds: 2 });
      const taskId = 'task_p10_t1_fail';
      const taskLog = new TaskDiagnosticLog({ runtimeRoot: logRoot, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL' });
      const chairDriver = new CouncilChairDriver({ council, ownerTask: 'P10 T1 miniqueue' });
      // A chair that ALWAYS mangles the opencode id, exactly like the owner's
      // live failure — never recovers even after the bounded repair.
      const resolveDriver = () => ({
        name: 'fake-chair',
        async decide(input) {
          const ids = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(ids.map((id) => [id, `focus ${id}`]));
          instructions['live1-opencode-pm_note'] = 'stray';
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'x', synthesis_focus: 'y' } };
        },
      });
      const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog });
      const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
      const runtime = new DurablePmRuntime({ driver: chairDriver, workflowRunner, peerRelay, repository, maxTurns: 16, taskLog });
      const request = createPmRequest({ objective: 'P10 T1 miniqueue', context: { ownerCommandId: 'cmd-t1-fail', council } });
      repository.create(request, { id: 'pmrun_t1_fail', driver: chairDriver.name, startedAt: '2026-08-24T00:00:00.000Z' });

      const result = await runtime.resume('pmrun_t1_fail');
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'COUNCIL_CHAIR_PLAN_FAILED');

      finalizeTaskDiagnostics({ taskLog, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL', submittedVia: 'OWNER', council, result });

      const dir = taskLogDir(logRoot, taskId);
      const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.event_type === 'COUNCIL_PLAN_RETRY'));
      assert.equal(events.filter((e) => e.event_type === 'COUNCIL_PLAN_INVALID').length, 2);
      assert.ok(events.some((e) => e.event_type === 'TASK_FAILED'));
      assert.equal(events.some((e) => e.event_type === 'PARTICIPANT_START'), false, 'no participant was ever spawned on a failed plan');

      const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
      assert.match(summary, /status: failed/);
      assert.match(summary, /chair_plan participant-instruction contract was repaired once/);
    });
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('OwnerTaskController.submit() emits TASK_ACCEPTED via an injected taskDiagnostics factory', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-p10-owner-'));
  try {
    const created = [];
    const repo = { createOwnerTask: (task, meta) => created.push({ task, meta }) };
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: logRoot });
    const controller = new OwnerTaskController({ repository: repo, startPm: null, taskDiagnostics: factory });
    const command = { command_id: 'cmd-accept-1', accepted_at: '2026-08-24T00:00:00.000Z', payload: { body: 'do the thing' } };
    const project = { id: 'proj-x', autonomy: { effects: {} } };
    const profile = { id: 'live1-claude-pm' };
    await controller.submit({ command, project, profile });

    const taskId = created[0].task.id;
    const dir = taskLogDir(logRoot, taskId);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events[0].event_type, 'TASK_ACCEPTED');
    assert.equal(events[0].project_id, 'proj-x');
    assert.equal(events[0].pm_profile_id, 'live1-claude-pm');
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('a throwing taskDiagnostics factory never fails task submission (Part P)', async () => {
  const repo = { createOwnerTask: () => {} };
  const controller = new OwnerTaskController({ repository: repo, startPm: null, taskDiagnostics: () => { throw new Error('disk is full'); } });
  const command = { command_id: 'cmd-accept-2', accepted_at: '2026-08-24T00:00:00.000Z', payload: { body: 'x' } };
  const result = await controller.submit({ command, project: { id: 'p', autonomy: { effects: {} } }, profile: { id: 'pm-1' } });
  assert.equal(result.status, 'MATERIALIZED');
});
