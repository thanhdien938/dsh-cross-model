import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInteractionNotifier, OwnerTerminalResultNotifier, TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';

function durableOwnerRepository() {
  const interactions = new Map();
  let marked = 0;
  return {
    interactions,
    get marked() { return marked; },
    async findMaterializedCommandByPmRunId(pmRunId) { return { project_id: 'p', canonical_result: { task_id: `task-${pmRunId}`, pm_run_id: pmRunId } }; },
    async createInteraction(value) { if (!interactions.has(value.interaction_id)) interactions.set(value.interaction_id, structuredClone(value)); return interactions.get(value.interaction_id); },
    async claimNotifications({ terminal }) { return [...interactions.values()].filter((item) => !item.notified_at && (item.runtime_facts?.notification_kind === 'TERMINAL_PM_RESULT') === terminal); },
    async markNotified(id) { interactions.get(id).notified_at = 'durable'; marked += 1; },
  };
}

function terminalRun(status, overrides = {}) {
  return { id: `run-${status}`, status, output: status === 'completed' ? 'branch: main\ntracked files: clean' : '', error: status === 'failed' ? { message: 'bounded failure', password: 'raw-secret' } : status === 'cancelled' ? { message: 'owner cancelled' } : null, driver: 'production:claude-code:pm', pmProfileId: 'pm', ...overrides };
}

test('SUBMIT_TASK acknowledgement remains immediate and terminal work is separate', async () => {
  const calls = [];
  // Real owner_command row shape (postgres-owner-repository.mjs row()):
  // the operation outcome lives under canonical_result, and M05's
  // renderOwnerAck() renders a small safe DTO from it — never the raw
  // internal status jargon.
  const adapter = new TelegramOwnerAdapter({ token: 'opaque', ownerUserId: '1', ownerChatId: '1', projectId: 'p', service: { mutate: async () => ({ command_id: 'c', status: 'COMPLETED', canonical_result: { status: 'MATERIALIZED', task_id: 'task-1', pm_run_id: 'run-1' } }) }, fetchImpl: async (url, init) => { calls.push({ url, init }); return url.includes('getUpdates') ? { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 1 }, text: 'task' } }] }) } : { ok: true, json: async () => ({ ok: true }) }; } });
  await adapter.pollOnce();
  const ack = JSON.parse(calls[1].init.body).text;
  assert.match(ack, /accepted/i);
  assert.match(ack, /task-1/);
  assert.equal(ack.includes('MATERIALIZED'), false); // no raw internal status jargon in the owner-facing ACK
});

test('running PM run produces no terminal message', async () => {
  const repository = durableOwnerRepository(); let sends = 0;
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [] }, send: async () => { sends += 1; } });
  assert.deepEqual(await notifier.flush(), { materialized: 0, conflicted: 0, claimed: 0, sent: 0 }); assert.equal(sends, 0);
});

for (const status of ['completed', 'failed', 'cancelled']) test(`${status} durable PM truth produces bounded terminal delivery`, async () => {
  const repository = durableOwnerRepository(), sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [terminalRun(status)] }, send: async (text) => sent.push(text) });
  const result = await notifier.flush(); assert.equal(result.sent, 1); assert.match(sent[0], new RegExp(`Status: ${status}`)); assert.ok(sent[0].length <= 3500); assert.doesNotMatch(sent[0], /raw-secret/);
  assert.equal((await notifier.flush()).sent, 0); assert.equal(repository.marked, 1);
});

test('send failure remains retryable and recreated notifier discovers durable terminal truth', async () => {
  const repository = durableOwnerRepository(), pmRepository = { listTerminalRuns: () => [terminalRun('completed')] }; let attempts = 0;
  const first = new OwnerTerminalResultNotifier({ repository, pmRepository, send: async () => { attempts += 1; throw new Error('offline'); } });
  assert.equal((await first.flush()).sent, 0); assert.equal(repository.marked, 0);
  const restarted = new OwnerTerminalResultNotifier({ repository, pmRepository, send: async () => { attempts += 1; } });
  assert.equal((await restarted.flush()).sent, 1); assert.equal(attempts, 2); assert.equal(repository.marked, 1);
});

test('AWAIT_OWNER notifier excludes terminal outbox and keeps existing rendering path', async () => {
  let terminalFlag = null, sent = 0;
  const notifier = new OwnerInteractionNotifier({ repository: { claimNotifications: async (input) => { terminalFlag = input.terminal; return [{ interaction_id: 'i', runtime_facts: { status: 'SAFE' }, title: 'Question', prompt_text: 'Proceed?' }]; }, markNotified: async () => {} }, send: async () => { sent += 1; } });
  assert.equal((await notifier.flush()).sent, 1); assert.equal(terminalFlag, false); assert.equal(sent, 1);
});

test('unknown Telegram owner remains zero-disclosure', async () => {
  let serviceCalls = 0, sends = 0;
  const adapter = new TelegramOwnerAdapter({ token: 'opaque', ownerUserId: '1', ownerChatId: '1', projectId: 'p', service: { mutate: async () => { serviceCalls += 1; } }, fetchImpl: async (url) => url.includes('getUpdates') ? { ok: true, json: async () => ({ result: [{ update_id: 7, message: { from: { id: 2 }, chat: { id: 2 }, text: 'secret task' } }] }) } : (sends += 1, { ok: true, json: async () => ({}) }) });
  await adapter.pollOnce(); assert.equal(serviceCalls, 0); assert.equal(sends, 0);
});
