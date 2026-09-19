// P14-R1.2 Part E/F: reproduces the exact B4 audit observation — an open
// QUESTION advertising RETRY/CANCEL rejecting a "RETRY" attempt with
// INVALID_OWNER_COMMAND — against the real, single-authority
// OwnerControlService (src/owner/owner-control-service.mjs) that every
// surface (Desktop's ApprovalPanel/App.tsx, Telegram's callback_query/
// reply-to/`/decide` routes) ultimately calls through.
//
// Forensic finding this test encodes: OwnerControlService validates
// target_id/expected_revision/payload.response BEFORE ever touching the
// interaction row (#validateBeforeAcceptance, owner-control-service.mjs).
// A real, canonical Retry action (any surface) always supplies all three
// fields — see App.tsx#handleDecide (interactionId + expectedRevision +
// response) and telegram-owner-client.mjs's callback_query/`/decide`
// routes. INVALID_OWNER_COMMAND is therefore only reachable from a command
// that omits one of those fields entirely — never from a real interaction
// being open, stale, or advertising a different response set (those are
// the distinct STALE_INTERACTION/RESPONSE_REFUSED codes below). This is
// the source-level proof behind classifying the B4 observation
// AUDIT_AUTOMATION_SENT_WRONG_ACTION rather than a product defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError, normalizeInteraction } from '../src/owner/owner-contracts.mjs';
import { routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';

// Minimal in-memory stand-in for PostgresOwnerRepository, implementing only
// the surface OwnerControlService#mutate() actually calls for
// DECIDE_INTERACTION/REPLY_TO_INTERACTION (acceptCommand + decide), with
// the SAME error codes/ordering as the real repository's decide() —
// src/owner/postgres-owner-repository.mjs lines 76-84.
function fakeRepository() {
  const interactions = new Map();
  const commands = new Map();
  return {
    async createInteraction(value) {
      const v = normalizeInteraction(value);
      const stored = { ...v, revision: 1 };
      interactions.set(v.interaction_id, stored);
      return stored;
    },
    async acceptCommand(command, effect) {
      if (commands.has(command.command_id)) return commands.get(command.command_id);
      const canonical = await effect({});
      const record = { command_id: command.command_id, status: 'COMPLETED', canonical_result: canonical };
      commands.set(command.command_id, record);
      return record;
    },
    async decide(_client, { interactionId, commandId, actorId, expectedRevision, selectedResponse, responseText, decisionId }) {
      const current = interactions.get(interactionId);
      if (!current) throw new OwnerControlError('interaction not found', 'INTERACTION_NOT_FOUND');
      if (current.status !== 'OPEN' || current.revision !== expectedRevision) throw new OwnerControlError('interaction is stale', 'STALE_INTERACTION');
      if (selectedResponse && !current.allowed_responses.includes(selectedResponse)) throw new OwnerControlError('response is not allowed', 'RESPONSE_REFUSED');
      current.status = 'DECIDED';
      current.revision += 1;
      return { interaction_id: interactionId, decision_id: decisionId, status: 'DECIDED' };
    },
  };
}

async function openRetryCancelQuestion(repository) {
  return repository.createInteraction({
    interaction_id: 'itx-b4-retry',
    project_id: 'proj-a',
    origin: 'PM',
    kind: 'QUESTION',
    status: 'OPEN',
    title: 'Provider call failed',
    prompt_text: 'The backend call failed. Retry or cancel?',
    allowed_responses: ['RETRY', 'CANCEL'],
    requires_response: true,
  });
}

test('the real Desktop/Telegram Retry payload (target_id + expected_revision + response) is accepted', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  const outcome = await service.mutate({
    command_id: 'cmd-retry-1',
    actor_id: '100000001',
    client_kind: 'LOCAL',
    target_id: 'itx-b4-retry',
    expected_revision: 1,
    operation: 'DECIDE_INTERACTION',
    payload: { response: 'RETRY' },
  });

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.canonical_result.status, 'DECIDED');
});

test('a bare RETRY missing target_id reproduces the audit INVALID_OWNER_COMMAND without any interaction ever being touched', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  await assert.rejects(
    () =>
      service.mutate({
        command_id: 'cmd-retry-2',
        actor_id: '100000001',
        client_kind: 'LOCAL',
        expected_revision: 1,
        operation: 'DECIDE_INTERACTION',
        payload: { response: 'RETRY' }, // target_id omitted — not what any real surface sends
      }),
    (error) => error instanceof OwnerControlError && error.code === 'INVALID_OWNER_COMMAND',
  );
});

test('a bare RETRY missing expected_revision also reproduces INVALID_OWNER_COMMAND, distinctly from a stale/open interaction', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  await assert.rejects(
    () =>
      service.mutate({
        command_id: 'cmd-retry-3',
        actor_id: '100000001',
        client_kind: 'LOCAL',
        target_id: 'itx-b4-retry',
        operation: 'DECIDE_INTERACTION',
        payload: { response: 'RETRY' }, // expected_revision omitted
      }),
    (error) => error instanceof OwnerControlError && error.code === 'INVALID_OWNER_COMMAND',
  );
});

test('a response outside allowed_responses is rejected as RESPONSE_REFUSED, never conflated with INVALID_OWNER_COMMAND', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  await assert.rejects(
    () =>
      service.mutate({
        command_id: 'cmd-retry-4',
        actor_id: '100000001',
        client_kind: 'LOCAL',
        target_id: 'itx-b4-retry',
        expected_revision: 1,
        operation: 'DECIDE_INTERACTION',
        payload: { response: 'BOGUS' },
      }),
    (error) => error instanceof OwnerControlError && error.code === 'RESPONSE_REFUSED',
  );
});

test('a wrong/stale expected_revision is rejected as STALE_INTERACTION, never conflated with INVALID_OWNER_COMMAND', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  await assert.rejects(
    () =>
      service.mutate({
        command_id: 'cmd-retry-5',
        actor_id: '100000001',
        client_kind: 'LOCAL',
        target_id: 'itx-b4-retry',
        expected_revision: 2, // interaction is at revision 1
        operation: 'DECIDE_INTERACTION',
        payload: { response: 'RETRY' },
      }),
    (error) => error instanceof OwnerControlError && error.code === 'STALE_INTERACTION',
  );
});

test('Telegram inline-button RETRY tap (callback_query) and the /decide command both carry target_id + expected_revision, never a bare response', () => {
  const bound = { interaction_id: 'itx-b4-retry', revision: 1 };

  const buttonTap = routeTelegramUpdate(
    { update_id: 40, callback_query: { from: { id: 1 }, message: { chat: { id: 2 } }, data: 'RETRY' } },
    { projectId: 'proj-a', boundInteraction: bound },
  );
  assert.equal(buttonTap.operation, 'DECIDE_INTERACTION');
  assert.equal(buttonTap.target_id, 'itx-b4-retry');
  assert.equal(buttonTap.expected_revision, 1);

  const decideCommand = routeTelegramUpdate(
    { update_id: 41, message: { from: { id: 1 }, chat: { id: 2 }, text: '/decide itx-b4-retry 1 RETRY' } },
    { projectId: 'proj-a' },
  );
  assert.equal(decideCommand.operation, 'DECIDE_INTERACTION');
  assert.equal(decideCommand.target_id, 'itx-b4-retry');
  assert.equal(decideCommand.expected_revision, 1);
  assert.equal(decideCommand.payload.response, 'RETRY');

  // The one Telegram shape that is NOT a DECIDE_INTERACTION: a plain typed
  // reply to the interaction's message. It is routed as REPLY_TO_INTERACTION
  // (free text), so an owner typing the bare word "RETRY" as a reply — never
  // tapping the button and never using /decide — never reaches the
  // allowed_responses vocabulary at all. This is expected-contract behavior,
  // not a defect: the canonical decision path is the button (or /decide),
  // not free-text pattern-matching against allowed_responses.
  const typedReply = routeTelegramUpdate(
    { update_id: 42, message: { from: { id: 1 }, chat: { id: 2 }, text: 'RETRY', reply_to_message: {} } },
    { projectId: 'proj-a', boundInteraction: bound },
  );
  assert.equal(typedReply.operation, 'REPLY_TO_INTERACTION');
  assert.equal(typedReply.target_id, 'itx-b4-retry');
  assert.equal(typedReply.expected_revision, 1);
  assert.equal(typedReply.payload.text, 'RETRY');
});

test('a correctly-tokened RETRY cannot be replayed after the interaction is already decided (no duplicate resume)', async () => {
  const repository = fakeRepository();
  const service = new OwnerControlService({ repository });
  await openRetryCancelQuestion(repository);

  const first = await service.mutate({
    command_id: 'cmd-retry-6a',
    actor_id: '100000001',
    client_kind: 'LOCAL',
    target_id: 'itx-b4-retry',
    expected_revision: 1,
    operation: 'DECIDE_INTERACTION',
    payload: { response: 'RETRY' },
  });
  assert.equal(first.status, 'COMPLETED');

  await assert.rejects(
    () =>
      service.mutate({
        command_id: 'cmd-retry-6b',
        actor_id: '100000001',
        client_kind: 'LOCAL',
        target_id: 'itx-b4-retry',
        expected_revision: 1, // still the pre-decision revision — now stale
        operation: 'DECIDE_INTERACTION',
        payload: { response: 'RETRY' },
      }),
    (error) => error instanceof OwnerControlError && error.code === 'STALE_INTERACTION',
  );
});
