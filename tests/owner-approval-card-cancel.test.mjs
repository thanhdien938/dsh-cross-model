import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError, normalizeInteraction } from '../src/owner/owner-contracts.mjs';

function fixture({ taskId = 'task-a', projectId = 'proj-a' } = {}) {
  const interactions = new Map();
  const commands = new Map();
  const calls = { cancel: 0, interactionDecision: 0, providerReplay: 0 };
  const repository = {
    async createInteraction(value) {
      const normalized = normalizeInteraction(value);
      const stored = { ...normalized, revision: 1 };
      interactions.set(stored.interaction_id, stored);
      return stored;
    },
    async acceptCommand(command, effect) {
      if (commands.has(command.command_id)) return commands.get(command.command_id);
      const canonical = await effect({});
      const completed = { command_id: command.command_id, status: 'COMPLETED', canonical_result: canonical };
      commands.set(command.command_id, completed);
      return completed;
    },
    async decide(_client, { interactionId, expectedRevision, selectedResponse, decisionId }) {
      calls.interactionDecision += 1;
      const current = interactions.get(interactionId);
      if (!current) throw new OwnerControlError('interaction not found', 'INTERACTION_NOT_FOUND');
      if (current.status !== 'OPEN' || current.revision !== expectedRevision) throw new OwnerControlError('interaction is stale', 'STALE_INTERACTION');
      if (selectedResponse && !current.allowed_responses.includes(selectedResponse)) throw new OwnerControlError('response is not allowed', 'RESPONSE_REFUSED');
      current.status = 'DECIDED';
      current.revision += 1;
      return { interaction_id: interactionId, decision_id: decisionId, status: 'DECIDED' };
    },
    async closeOpenInteractionForTaskCancellation(_client, guards) {
      const current = interactions.get(guards.interactionId);
      if (!current) throw new OwnerControlError('interaction not found', 'INTERACTION_NOT_FOUND');
      if (current.status !== 'OPEN' || current.revision !== guards.expectedRevision) throw new OwnerControlError('interaction is stale', 'STALE_INTERACTION');
      if (!current.allowed_responses.includes('CANCEL')) throw new OwnerControlError('response is not allowed', 'RESPONSE_REFUSED');
      if (current.project_id !== guards.projectId || current.task_id !== guards.taskId || current.pm_run_id !== 'pmrun-a') {
        throw new OwnerControlError('task and interaction lineage do not match', 'INTERACTION_TASK_MISMATCH');
      }
      current.status = 'CLOSED';
      current.revision += 1;
      return current;
    },
  };
  const tasks = {
    async requestCancel({ taskId: requestedTaskId }) {
      calls.cancel += 1;
      return { status: 'CANCEL_REQUESTED', task_id: requestedTaskId, cancellation: 'REQUESTED' };
    },
  };
  const service = new OwnerControlService({ repository, taskController: tasks });
  const createOpen = (overrides = {}) => repository.createInteraction({
    interaction_id: 'interaction-a',
    project_id: projectId,
    task_id: taskId,
    pm_run_id: 'pmrun-a',
    origin: 'PM',
    kind: 'APPROVAL',
    status: 'OPEN',
    title: 'File access blocked',
    prompt_text: 'Retry or cancel?',
    allowed_responses: ['RETRY', 'CANCEL'],
    requires_response: true,
    ...overrides,
  });
  const cancel = (overrides = {}) => service.mutate({
    command_id: 'cmd-cancel-a',
    actor_id: '100000001',
    client_kind: 'LOCAL',
    project_id: projectId,
    target_id: taskId,
    expected_revision: 1,
    operation: 'REQUEST_CANCEL',
    payload: { interaction_id: 'interaction-a' },
    ...overrides,
  });
  return { interactions, calls, service, createOpen, cancel };
}

test('valid OPEN approval interaction + CANCEL closes the interaction and requests canonical task cancellation', async () => {
  const f = fixture();
  await f.createOpen();

  const result = await f.cancel();

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.canonical_result.status, 'CANCEL_REQUESTED');
  assert.equal(result.canonical_result.interaction_status, 'CLOSED');
  assert.equal(f.interactions.get('interaction-a').status, 'CLOSED');
  assert.equal(f.calls.cancel, 1);
});

test('valid OPEN approval interaction + RETRY retains interaction-response semantics', async () => {
  const f = fixture();
  await f.createOpen();

  const result = await f.service.mutate({
    command_id: 'cmd-retry-a', actor_id: '100000001', client_kind: 'LOCAL', project_id: 'proj-a',
    target_id: 'interaction-a', expected_revision: 1, operation: 'DECIDE_INTERACTION', payload: { response: 'RETRY' },
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.canonical_result.status, 'DECIDED');
  assert.equal(f.calls.interactionDecision, 1);
  assert.equal(f.calls.cancel, 0);
});

test('approval CANCEL with a stale revision fails closed', async () => {
  const f = fixture();
  await f.createOpen();

  await assert.rejects(() => f.cancel({ expected_revision: 2 }), (error) => error instanceof OwnerControlError && error.code === 'STALE_INTERACTION');
  assert.equal(f.interactions.get('interaction-a').status, 'OPEN');
  assert.equal(f.calls.cancel, 0);
});

test('a CLOSED approval interaction cannot be cancelled twice', async () => {
  const f = fixture();
  await f.createOpen();
  await f.cancel();

  await assert.rejects(() => f.cancel({ command_id: 'cmd-cancel-b' }), (error) => error instanceof OwnerControlError && error.code === 'STALE_INTERACTION');
  assert.equal(f.calls.cancel, 1);
});

test('wrong task/interaction pairing fails closed', async () => {
  const f = fixture();
  await f.createOpen();

  await assert.rejects(
    () => f.cancel({ command_id: 'cmd-wrong-task', target_id: 'task-other' }),
    (error) => error instanceof OwnerControlError && error.code === 'INTERACTION_TASK_MISMATCH',
  );
  assert.equal(f.interactions.get('interaction-a').status, 'OPEN');
  assert.equal(f.calls.cancel, 0);
});

test('approval CANCEL never takes the decision/retry path and never replays provider work', async () => {
  const f = fixture();
  await f.createOpen();

  await f.cancel();

  assert.equal(f.calls.interactionDecision, 0);
  assert.equal(f.calls.providerReplay, 0);
  assert.equal(f.calls.cancel, 1);
});
