import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
const projects = [{ id: 'proj-a' }];

test('D5 Telegram: --implementation is a single scalar and requires explicit Debate enablement', () => {
  const parsed = parseOwnerFlags('--debate-extend --implementation impl do it');
  assert.equal(parsed.implementationParticipantId, 'impl');
  assert.throws(() => parseOwnerFlags('--implementation impl do it'), /--implementation requires --debate-extend/);
  assert.throws(() => parseOwnerFlags('--debate-extend --implementation p1 --implementation p2 do it'), /specified more than once/);
});

test('D5 Telegram: no implementation selection preserves the all-read-only payload default', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm chair --debate p1,p2 --debate-extend do it'), { ownerUserId: 1, ownerChatId: 2, projects });
  assert.equal('implementation_participant_id' in routed.payload.council, false);
});

test('D5 Telegram: selected Debate participant reaches the existing implementation_participant_id field', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm chair --debate p1,impl --debate-extend --implementation impl --durability local --commit do it'), { ownerUserId: 1, ownerChatId: 2, projects });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.council, {
    chair_profile_id: 'chair', participant_profile_ids: ['p1', 'impl'],
    debate: { enabled: true }, implementation_participant_id: 'impl',
  });
  assert.equal(routed.payload.durability, 'DURABLE_LOCAL');
  assert.deepEqual(routed.payload.git, { commit: true, push: false });
});

test('D5 Telegram: a selected implementation profile outside the Council fails closed before submission', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm chair --debate p1,p2 --debate-extend --implementation ghost do it'), { ownerUserId: 1, ownerChatId: 2, projects });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /must name one of this council's participants/);
  assert.equal(routed.operation, undefined);
});

test('D5 Telegram: SINGLE cannot request implementation capability', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm chair --debate-extend --implementation chair do it'), { ownerUserId: 1, ownerChatId: 2, projects });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /requires a council dispatch/);
});

test('D5 Telegram: alias Council shorthand wires a canonical selected participant through unchanged', () => {
  const aliasRegistry = new TelegramAliasRegistry({ projects: { 1: 'proj-a' }, pmProfiles: { 1: 'chair', 2: 'p1', 3: 'impl' } });
  const routed = routeTelegramUpdate(update('/c 1 1 2,3 --debate-extend --implementation impl do it'), { projects, aliasRegistry });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.payload.council.implementation_participant_id, 'impl');
});

test('D5 Telegram: alias Council shorthand rejects a non-member selected participant', () => {
  const aliasRegistry = new TelegramAliasRegistry({ projects: { 1: 'proj-a' }, pmProfiles: { 1: 'chair', 2: 'p1', 3: 'p2' } });
  const routed = routeTelegramUpdate(update('/c 1 1 2,3 --debate-extend --implementation ghost do it'), { projects, aliasRegistry });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /must name one of this council's participants/);
});
