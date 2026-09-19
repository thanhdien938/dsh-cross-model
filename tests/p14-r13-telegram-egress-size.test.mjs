import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_MESSAGE_CHAR_LIMIT, TelegramOwnerAdapter, chunkTelegramMessage,
  renderAliasesHelp, renderPmProfileList, renderProjectList,
} from '../src/owner/telegram-owner-client.mjs';

function update(updateId, text) { return { update_id: updateId, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
function profiles(count, width = 80) { return Array.from({ length: count }, (_, index) => ({ id: `profile-${index}-${'x'.repeat(width)}`, product: 'codex', model: 'gpt-test', reasoning: 'high', status: 'ACTIVE' })); }
function projects(count, width = 80) { return Array.from({ length: count }, (_, index) => ({ id: `project-${index}-${'x'.repeat(width)}` })); }

function aliasRegistry(projectItems, profileItems) {
  const projectRows = projectItems.map((item, index) => ({ alias: String(index + 1), project_id: item.id }));
  const profileRows = profileItems.map((item, index) => ({ alias: String(index + 1), pm_profile_id: item.id }));
  return {
    listProjectAliases: () => projectRows, listPmAliases: () => profileRows,
    projectAliasFor: (id) => projectRows.find((row) => row.project_id === id)?.alias ?? null,
    pmAliasFor: (id) => profileRows.find((row) => row.pm_profile_id === id)?.alias ?? null,
  };
}

function telegramHarness({ updates, projectItems, profileItems, aliases }) {
  const sent = []; const reached = []; let sendAttempts = 0;
  const adapter = new TelegramOwnerAdapter({
    token: 't', ownerUserId: '1', ownerChatId: '2', projects: projectItems, pmProfiles: profileItems, aliasRegistry: aliases,
    service: { read: async (operation, routed) => { reached.push(routed.command_id); return operation === 'GET_PM_PROFILES' ? profileItems : { status: 'next update processed' }; } },
    fetchImpl: async (url, init) => {
      if (String(url).includes('getUpdates')) return { ok: true, json: async () => ({ result: updates }) };
      sendAttempts += 1; const text = JSON.parse(init.body).text; sent.push(text);
      return { ok: Array.from(text).length <= TELEGRAM_MESSAGE_CHAR_LIMIT, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }) };
    },
  });
  return { adapter, sent, reached, get sendAttempts() { return sendAttempts; } };
}

test('normal small responses remain one byte-for-byte unchanged outbound message', async () => {
  const small = profiles(2, 5); const aliases = aliasRegistry([{ id: 'p' }], small);
  const expected = renderPmProfileList(small, aliases);
  const harness = telegramHarness({ updates: [update(1, '/profiles')], projectItems: [{ id: 'p' }], profileItems: small, aliases });
  await harness.adapter.pollOnce();
  assert.deepEqual(harness.sent, [expected]); assert.equal(harness.adapter.offset, 2);
});

test('Unicode-safe chunking bounds a response just above Telegram limit without splitting astral characters', () => {
  const chunks = chunkTelegramMessage(`${'a'.repeat(TELEGRAM_MESSAGE_CHAR_LIMIT - 1)}😀b`);
  assert.ok(chunks.length > 1); assert.ok(chunks.every((chunk) => Array.from(chunk).length <= TELEGRAM_MESSAGE_CHAR_LIMIT));
  assert.ok(chunks.every((chunk) => !chunk.includes('\uFFFD'))); assert.match(chunks[0], /\[continued 1\/2\]$/);
});

test('large /profiles response is bounded and the queued next owner update advances', async () => {
  const large = profiles(80); const aliases = aliasRegistry([{ id: 'p' }], large);
  assert.ok(Array.from(renderPmProfileList(large, aliases)).length > TELEGRAM_MESSAGE_CHAR_LIMIT);
  const harness = telegramHarness({ updates: [update(10, '/profiles'), update(11, '/status next-task')], projectItems: [{ id: 'p' }], profileItems: large, aliases });
  await harness.adapter.pollOnce();
  assert.ok(harness.sendAttempts > 2); assert.ok(harness.sent.every((text) => Array.from(text).length <= TELEGRAM_MESSAGE_CHAR_LIMIT));
  assert.equal(harness.adapter.offset, 12); assert.equal(harness.reached.length, 2);
});

test('large /aliases response is bounded and cannot wedge later owner commands', async () => {
  const projectItems = projects(30); const profileItems = profiles(70); const aliases = aliasRegistry(projectItems, profileItems);
  assert.ok(Array.from(renderAliasesHelp({ projects: projectItems, profiles: profileItems, aliasRegistry: aliases })).length > TELEGRAM_MESSAGE_CHAR_LIMIT);
  const harness = telegramHarness({ updates: [update(20, '/aliases'), update(21, '/status next-task')], projectItems, profileItems, aliases });
  await harness.adapter.pollOnce();
  assert.ok(harness.sent.every((text) => Array.from(text).length <= TELEGRAM_MESSAGE_CHAR_LIMIT)); assert.equal(harness.adapter.offset, 22); assert.equal(harness.reached.length, 2);
});

test('large /projects response is bounded and cannot wedge later owner commands', async () => {
  const projectItems = projects(80); const profileItems = profiles(1); const aliases = aliasRegistry(projectItems, profileItems);
  assert.ok(Array.from(renderProjectList(projectItems, aliases)).length > TELEGRAM_MESSAGE_CHAR_LIMIT);
  const harness = telegramHarness({ updates: [update(30, '/projects'), update(31, '/status next-task')], projectItems, profileItems, aliases });
  await harness.adapter.pollOnce();
  assert.ok(harness.sent.every((text) => Array.from(text).length <= TELEGRAM_MESSAGE_CHAR_LIMIT)); assert.equal(harness.adapter.offset, 32); assert.equal(harness.reached.length, 1);
});
