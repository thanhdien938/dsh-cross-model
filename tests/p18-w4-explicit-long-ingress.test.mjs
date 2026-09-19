import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { OwnerTaskController, TASK_DURABILITY } from '../src/owner/owner-task-controller.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';
import { EXECUTION_STAGE, resolveExecutionOptions } from '../src/pm/pm-execution-timeout-policy.mjs';
import { createProductionPmWorkflowRunner } from '../src/workflow/production-pm-workflow-runner.mjs';
import { AgentBusRepository } from '../src/persistence/repositories/agentbus-repository.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P18-W4 Part A — explicit LONG ingress via a new `--long` Telegram flag,
// folded onto a new typed `payload.runtime_class` fact (never repurposing
// `payload.task_source`, which continues to mean GIT_FILE provenance
// only). `OwnerTaskController#submit()` remains the ONE place that stamps
// the final durable `context.runtimeClass`.

// ---- parseOwnerFlags: --long is a bare boolean, like --commit/--push/--review ----

test('parseOwnerFlags: --long is a bare boolean switch, never consuming a following word', () => {
  const r = parseOwnerFlags('--long do the actual task');
  assert.equal(r.long, true);
  assert.equal(r.text, 'do the actual task');
});

test('parseOwnerFlags: omitting --long is byte-for-byte the pre-W4 default (false)', () => {
  assert.equal(parseOwnerFlags('--pm pm-1 plain task').long, false);
});

test('parseOwnerFlags: --long combines with --pm/--durability/--commit in any documented order', () => {
  const r = parseOwnerFlags('--pm pm-1 --long --durability direct --commit fix the thing');
  assert.equal(r.long, true);
  assert.equal(r.pmProfileId, 'pm-1');
  assert.equal(r.durability, 'DIRECT');
  assert.equal(r.commit, true);
  assert.equal(r.text, 'fix the thing');
});

// ---- routeTelegramUpdate: --long folds onto payload.runtime_class, never payload.task_source ----

const projects = [{ id: 'proj-a', display_name: 'A', repo_path: 'C:/a', default_pm_profile_id: 'pm-1' }];
function update(text) {
  return { message: { from: { id: 1 }, chat: { id: 2 }, text, message_id: 1 } };
}

test('routeTelegramUpdate: --long compiles to payload.runtime_class="LONG", payload.task_source stays absent', () => {
  const routed = routeTelegramUpdate(update('@proj-a --long do the thing'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.payload.runtime_class, 'LONG');
  assert.equal('task_source' in routed.payload, false);
});

test('routeTelegramUpdate: omitting --long never sets payload.runtime_class at all', () => {
  const routed = routeTelegramUpdate(update('@proj-a plain task'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal('runtime_class' in routed.payload, false);
});

// ---- OwnerTaskController.submit(): the final durable-context stamping rule ----

function fixture() {
  const created = [];
  const repo = { createOwnerTask: (task) => created.push(task) };
  const controller = new OwnerTaskController({ repository: repo, startPm: async () => null });
  const project = { id: 'proj-a', repo_path: 'C:/a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const profile = { id: 'pm-1' };
  return { created, controller, project, profile };
}

test('submit(): no --long and no task_source -> runtimeClass NORMAL (unchanged default)', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-1', client_kind: 'TELEGRAM', payload: { body: 'plain task' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'NORMAL');
});

test('submit(): payload.runtime_class="LONG" (from --long) -> runtimeClass LONG, no task_source in context', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-2', client_kind: 'TELEGRAM', payload: { body: 'a long task', runtime_class: 'LONG' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'LONG');
  assert.equal('taskSource' in created[0].context, false);
});

test('submit(): task_source alone (--task-file) still produces LONG unchanged — existing semantics preserved byte-for-byte', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({
    command: { command_id: 'cmd-3', client_kind: 'TELEGRAM', payload: { body: 'file content', task_source: { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) } } },
    project, profile,
  });
  assert.equal(created[0].context.runtimeClass, 'LONG');
  assert.deepEqual(created[0].context.taskSource, { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) });
});

test('submit(): task_source present + explicit runtime_class="NORMAL" still resolves LONG — task_source is never downgraded/overridden by an explicit NORMAL', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({
    command: { command_id: 'cmd-3b', client_kind: 'TELEGRAM', payload: { body: 'file content', runtime_class: 'NORMAL', task_source: { type: 'GIT_FILE', resolvedCommitSha: 'b'.repeat(40) } } },
    project, profile,
  });
  assert.equal(created[0].context.runtimeClass, 'LONG');
});

test('submit(): explicit runtime_class="NORMAL" with no task_source is a legal no-op -> NORMAL', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-3c', client_kind: 'TELEGRAM', payload: { body: 'plain task', runtime_class: 'NORMAL' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'NORMAL');
});

test('submit(): a malformed runtime_class fails closed with a typed error BEFORE any task is created', async () => {
  const { created, controller, project, profile } = fixture();
  for (const bogus of ['long', 'Long', 'FOO', 42, true, {}, ['LONG']]) {
    await assert.rejects(
      controller.submit({ command: { command_id: `cmd-bogus-${JSON.stringify(bogus)}`, client_kind: 'TELEGRAM', payload: { body: 'x', runtime_class: bogus } }, project, profile }),
      (error) => error instanceof OwnerControlError && error.code === 'INVALID_RUNTIME_CLASS_REQUEST',
    );
  }
  assert.equal(created.length, 0, 'no task may ever be durably created for a rejected malformed runtime_class');
});

test('submit(): explicit durability DIRECT + runtime_class LONG -> LONG execution budget, DIRECT durability (explicit durability still wins)', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-4', client_kind: 'TELEGRAM', payload: { body: 'x', runtime_class: 'LONG', durability: 'direct' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'LONG');
  assert.equal(created[0].context.durability, TASK_DURABILITY.DIRECT);
});

test('submit(): omitted durability + runtime_class LONG -> the existing LONG durability default (DURABLE_LOCAL) is preserved unchanged', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-5', client_kind: 'TELEGRAM', payload: { body: 'x', runtime_class: 'LONG' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'LONG');
  assert.equal(created[0].context.durability, TASK_DURABILITY.DURABLE_LOCAL);
});

// ---- end-to-end composition with the T-1 timeout policy (unchanged downstream code) ----

async function withWorkflowRunnerFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p18-w4-long-ingress-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(root, 'x.db') });
    await store.migrate();
    const agentBusRepository = new AgentBusRepository({ store });
    const profileRegistry = new PmProfileRegistry([{ id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio' }]);
    await fn({ store, agentBusRepository, profileRegistry, root });
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('composition: a --long-originated task.context.runtimeClass="LONG" resolves OWNER_SINGLE_LONG (1800000ms) at the worker step, exactly like a --task-file-originated one (T-1, unchanged)', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => {
    captured.push(context.executionOptions);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done' }; } };
  };
  const project = { id: 'proj-w4-long', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });
  await runner.run({ id: 'wf-w4-explicit-long', steps: [{ recipient: 'worker', body: 'x', context: { runtimeClass: 'LONG' } }] });
  assert.equal(captured[0].stage, EXECUTION_STAGE.OWNER_SINGLE_LONG);
  assert.equal(captured[0].timeoutMs, 1_800_000);
}));

test('composition: NORMAL (no --long, no task-file) still resolves OWNER_SINGLE (300000ms) unchanged', async () => withWorkflowRunnerFixture(async ({ store, agentBusRepository, profileRegistry }) => {
  const captured = [];
  const resolveDriver = (profile, context) => { captured.push(context.executionOptions); return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'done' }; } }; };
  const project = { id: 'proj-w4-normal', repo_path: 'C:/repo', default_pm_profile_id: 'live1-claude-pm' };
  const runner = createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project });
  await runner.run({ id: 'wf-w4-normal', steps: [{ recipient: 'worker', body: 'x' }] });
  assert.equal(captured[0].stage, EXECUTION_STAGE.OWNER_SINGLE);
  assert.equal(captured[0].timeoutMs, 300_000);
}));
