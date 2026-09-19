import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';
import { normalizeProductionWorkflowSpec } from '../src/workflow/production-pm-workflow-runner.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { createTaskDiagnosticLogFactory, forwardBackendEventToTaskLog } from '../src/runtime/task-diagnostic-log.mjs';

const codexJson = (text) => [
  JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');

function coordinationFixture() {
  let work = null;
  let completed = false;
  return {
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { work = value; },
    registerWorkerIncarnation: async () => {},
    listPmActionCandidates: async () => work && !completed ? [work] : [],
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => ({
      work_item_id, owner_worker_incarnation_id: worker_incarnation_id,
      fencing_generation: 1, fencing_token: 'fixture-fence',
    }),
    renewClaim: async () => {},
    completeClaim: async () => { completed = true; },
    withClaimAuthority: async (_fence, fn) => fn(work),
    listTaskDispatchCandidates: async () => [],
  };
}

test('compact workflow vocabulary normalizes at the shared workflow seam, never in the PM parser', () => {
  assert.deepEqual(
    normalizeProductionWorkflowSpec({ id: 'wf-live', task: 'read progress', agent: 'worker' }),
    { id: 'wf-live', steps: [{ recipient: 'worker', body: 'read progress' }] },
  );
  const canonical = { id: 'wf-canonical', steps: [{ recipient: 'worker', body: 'x' }] };
  assert.equal(normalizeProductionWorkflowSpec(canonical), canonical);
});

test('API success provenance is durably projected into task diagnostics without a schema migration or secret material', () => {
  const root = mkdtempSync(join(tmpdir(), 'p11-r12-provenance-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const observer = createBackendExecutionObserver({ emit: (event) => forwardBackendEventToTaskLog(event, factory) });
    observer.apiUsage({ backendProduct: 'api', profileId: 'p11-openrouter-fixture', projectId: 'p', taskId: 'task-provenance', pmRunId: 'pmrun-provenance' }, {
      provider: 'openrouter', requestedModel: 'openai/gpt-5.6-luna', returnedModel: 'openai/gpt-5.6-luna',
      httpStatus: 200, requestId: 'req-safe', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, requestFields: ['messages', 'model', 'stream'], durationMs: 42, streaming: false,
    });
    const line = JSON.parse(readFileSync(join(root, 'task-provenance', 'events.jsonl'), 'utf8').trim());
    assert.equal(line.event_type, 'API_EXECUTION_SUCCESS');
    assert.equal(line.http_status, 200);
    assert.equal(line.provider, 'openrouter');
    assert.equal(line.provider_request_id, 'req-safe');
    assert.deepEqual(line.request_fields, ['messages', 'model', 'stream']);
    assert.doesNotMatch(JSON.stringify(line), /authorization|api[_-]?key|bearer/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API strict workflow decision executes through actual production composition and the same shared runner used by non-API PMs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p11-r12-compose-'));
  mkdirSync(join(root, 'repo'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const apiPrompts = [];
  const backend = new ProductionPmBackendRegistry({
    probe: () => true,
    codexBinary: 'codex-fixture',
    codexRunner: async () => summarizeCodexCliRun({ stdout: codexJson('{"type":"finish","output":"workflow worker read completed evidence"}') }),
    apiRunner: async ({ prompt }) => {
      apiPrompts.push(prompt);
      return apiPrompts.length === 1
        ? '{"type":"workflow","spec":{"task":"read progress.md","agent":"worker"}}'
        : '{"type":"finish","output":"P11_R1_OPENROUTER_LIVE_CANARY_COMPLETE"}';
    },
  });
  const apiProfile = { id: 'p11-openrouter-fixture', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'openai/gpt-5.6-luna', status: 'ACTIVE' };
  const codexProfile = { id: 'codex-worker', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'fixture', status: 'ACTIVE' };
  const project = { id: 'p', repo_path: join(root, 'repo'), default_pm_profile_id: codexProfile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [project], profiles: [apiProfile, codexProfile], apiProviders: {},
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p', pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const coordination = coordinationFixture();
  const owner = { close: async () => {}, claimNotifications: async () => [] };
  let composition;
  try {
    composition = await createP5ProductionComposition(config, { pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
    const shared = composition.workflowRunnerForProject(project);
    assert.equal(shared, composition.workflowRunnerForProject(project));
    assert.equal(shared.contract, 'shared-production-pm-workflow');
    assert.equal(shared.registry.getEntry('worker').metadata.profile_id, codexProfile.id);
    assert.equal(shared.registry.getEntry(apiProfile.id).metadata.product, 'api');
    assert.equal(shared.registry.getEntry(codexProfile.id).metadata.product, 'codex');

    await composition.taskController.submit({ command: { command_id: 'owner-live-repro', payload: { body: 'canary' }, accepted_at: '2026-08-25T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(apiProfile.id) });
    const worker = await composition.buildWorker();
    // P13-R1 §4.2: runOnce() now starts the admitted work and returns
    // promptly instead of awaiting it to completion -- await the started
    // slot's own settlement promise to observe the same terminal outcome
    // this test asserted on synchronously before P13-R1.
    const started = await worker.runOnce();
    assert.equal(started.status, 'WORK');
    const result = await started.started[0].promise;
    assert.equal(result.status, 'WORK');
    assert.equal(result.outcome.result.status, 'completed', JSON.stringify(result.outcome.result));
    assert.equal(result.outcome.result.output, 'P11_R1_OPENROUTER_LIVE_CANARY_COMPLETE');
    assert.equal(apiPrompts.length, 2);
    assert.match(apiPrompts[0], /workflow: \{"type":"workflow","spec":\{"steps":/);
    assert.equal(sqlite.get('SELECT COUNT(*) n FROM workflows').n, 1);
    assert.equal(sqlite.get('SELECT status FROM workflows').status, 'completed');
    assert.equal(sqlite.get('SELECT recipient FROM workflow_steps').recipient, 'worker');
    assert.equal(sqlite.get('SELECT status FROM workflow_steps').status, 'completed');
  } finally {
    await composition?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
