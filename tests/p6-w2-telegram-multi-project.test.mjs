import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTelegramUpdate, TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';

const twoProjects = [{ id: 'accounting', display_name: 'Accounting' }, { id: 'billing', display_name: 'Billing' }];
const oneProject = [{ id: 'solo' }];

function msg(update_id, text) {
  return { update_id, message: { from: { id: 1 }, chat: { id: 2 }, text } };
}

test('one registered project: bare task text remains valid (regression)', () => {
  const routed = routeTelegramUpdate(msg(1, 'report current branch'), { projects: oneProject });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'solo');
  assert.equal(routed.payload.body, 'report current branch');
});

test('more than one registered project: bare new-task text fails closed', () => {
  const routed = routeTelegramUpdate(msg(2, 'report current branch'), { projects: twoProjects });
  assert.equal(routed.read, 'PROJECT_REQUIRED');
  assert.equal('operation' in routed, false);
  assert.deepEqual(routed.projects, twoProjects);
});

test('/projects lists registered ids', () => {
  const routed = routeTelegramUpdate(msg(3, '/projects'), { projects: twoProjects });
  assert.equal(routed.read, 'LIST_PROJECTS');
});

test('@<project_id> <task> routes to the exact project and carries the body', () => {
  const routed = routeTelegramUpdate(msg(4, '@billing fix reconciliation report'), { projects: twoProjects });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'billing');
  assert.equal(routed.payload.body, 'fix reconciliation report');
});

test('@<unknown project> refuses and creates no task', () => {
  const routed = routeTelegramUpdate(msg(5, '@unknown foo'), { projects: twoProjects });
  assert.equal(routed.read, 'PROJECT_UNKNOWN');
  assert.equal(routed.requested_project_id, 'unknown');
  assert.equal('operation' in routed, false);
});

test('@<project_id> with no task text is refused, not submitted empty', () => {
  const routed = routeTelegramUpdate(msg(6, '@billing'), { projects: twoProjects });
  assert.equal(routed.read, 'PROJECT_TASK_TEXT_REQUIRED');
});

test('interaction replies and callbacks never require @project routing', () => {
  const bound = { interaction_id: 'i-1', revision: 3 };
  const reply = routeTelegramUpdate({ update_id: 7, message: { from: { id: 1 }, chat: { id: 2 }, text: 'yes proceed', reply_to_message: {} } }, { projects: twoProjects, boundInteraction: bound });
  assert.equal(reply.operation, 'REPLY_TO_INTERACTION');
  assert.equal(reply.target_id, 'i-1');
  const callback = routeTelegramUpdate({ update_id: 8, callback_query: { from: { id: 1 }, message: { chat: { id: 2 }, interaction_id: 'i-1' }, data: 'nonce' } }, { projects: twoProjects, boundInteraction: bound });
  assert.equal(callback.operation, 'DECIDE_INTERACTION');
});

test('single-project routeTelegramUpdate stays backward compatible with the legacy projectId option', () => {
  const routed = routeTelegramUpdate(msg(9, 'legacy call site'), { projectId: 'legacy-project' });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'legacy-project');
});

test('acknowledgement echoes the destination project on successful submit', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 10, message: { from: { id: 1 }, chat: { id: 2 }, text: '@billing fix reconciliation report' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  // Real owner_command row shape (postgres-owner-repository.mjs row()) — the
  // operation outcome lives under canonical_result, not at the top level.
  const service = { mutate: async () => ({ command_id: 'c', status: 'COMPLETED', canonical_result: { status: 'MATERIALIZED', task_id: 'task-42', pm_run_id: 'pmrun-42', pm_profile_id: 'w2-pm' } }) };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects: twoProjects, service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /billing/);
  assert.match(sent[0], /task-42/);
});

test('bare multi-project text produces a safe refusal message, not a task', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 11, message: { from: { id: 1 }, chat: { id: 2 }, text: 'report current branch' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  let mutated = false;
  const service = { mutate: async () => { mutated = true; return {}; } };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects: twoProjects, service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(mutated, false);
  assert.match(sent[0], /more than one project/i);
  assert.match(sent[0], /accounting/);
  assert.match(sent[0], /billing/);
});

test('unknown project mention produces a safe project-options message, no task', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 12, message: { from: { id: 1 }, chat: { id: 2 }, text: '@unknown foo' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  let mutated = false;
  const service = { mutate: async () => { mutated = true; return {}; } };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects: twoProjects, service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(mutated, false);
  assert.match(sent[0], /unknown/i);
});

test('unknown owner (wrong actor/chat) remains silent: zero disclosure', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 13, message: { from: { id: 999 }, chat: { id: 999 }, text: '@billing snoop' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  const service = { mutate: async () => { throw new Error('must not be called'); } };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects: twoProjects, service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(sent.length, 0);
});
