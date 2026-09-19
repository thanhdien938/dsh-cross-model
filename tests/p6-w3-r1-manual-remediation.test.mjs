import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { ProductionPmBackendRegistry, createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { TelegramOwnerAdapter, renderOwnerRead } from '../src/owner/telegram-owner-client.mjs';

async function sqlite(t) {
  const dir = mkdtempSync(join(tmpdir(), 'p6w3r1-'));
  const store = await new SqlitePersistenceStore().open({ path: join(dir, 'db.sqlite') });
  await store.migrate();
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const workflow = { run: async () => ({ status: 'completed' }), result: () => null };
const peer = { exchange: async () => ({ status: 'completed' }), createConversation() {}, getConversation() {}, result: () => null };

// M06: a real CLI-backed driver whose model response omits `output` on a
// `finish` decision must durably FAIL the PM run with a clear error,
// never durably COMPLETE it with a blank result. End to end through the
// same DurablePmRuntime/PmRepository used in production, not a mock of
// the fix itself.
test('M06: a real CLI driver that finishes with no output durably fails, never completes blank', async (t) => {
  const store = await sqlite(t);
  const repository = new PmRepository({ store });
  const registry = new PmProfileRegistry([{ id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio' }]);
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: { id: 'dsh-p6-test-b', repo_path: 'C:/disposable' },
    run: async () => '{"type":"finish"}', // exactly the real failure shape: valid JSON, no output
  });
  const runtime = new DurablePmRuntime({ driver, workflowRunner: workflow, peerRelay: peer, repository, profileRegistry: registry, pmProfileId: 'live1-claude-pm' });
  const result = await runtime.run({ objective: 'report repository name and current branch' });
  const persisted = repository.load(result.pmRunId);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.output, '');
  assert.equal(persisted.error?.code, 'PM_DECISION_EMPTY_OUTPUT');
});

test('M06: a real CLI driver with genuine output completes normally (regression, project B shape)', async (t) => {
  const store = await sqlite(t);
  const repository = new PmRepository({ store });
  const registry = new PmProfileRegistry([{ id: 'live1-claude-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio' }]);
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: { id: 'dsh-p6-test-b', repo_path: 'C:/disposable' },
    run: async () => JSON.stringify({ type: 'finish', output: 'Repository: dsh-p6-test-b\nBranch: main' }),
  });
  const runtime = new DurablePmRuntime({ driver, workflowRunner: workflow, peerRelay: peer, repository, profileRegistry: registry, pmProfileId: 'live1-claude-pm' });
  const result = await runtime.run({ objective: 'report repository name and current branch' });
  const persisted = repository.load(result.pmRunId);
  assert.equal(persisted.status, 'completed');
  assert.match(persisted.output, /dsh-p6-test-b/);
});

// M05: the Telegram owner ACK for a mutation must never dump the raw
// internal owner_command row (command_id/actor_id/client_kind/
// payload_digest/canonical_result/revision/...) as JSON.
test('M05: SUBMIT_TASK Telegram ACK never contains raw internal owner_command fields', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@dsh-p6-test-b report repository name and current branch. Do not modify anything.' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  // The exact raw shape postgres-owner-repository.mjs's row() returns.
  const rawInternalRow = {
    command_id: 'tg-abc123', actor_id: '100000001', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK',
    project_id: 'dsh-p6-test-b', target_id: null, expected_revision: null,
    payload: { body: 'report repository name and current branch. Do not modify anything.' },
    payload_digest: 'deadbeef'.repeat(8), status: 'COMPLETED',
    canonical_result: { status: 'MATERIALIZED', task_id: 'task-xyz', pm_run_id: 'pmrun-xyz' },
    created_at: '2026-08-21T00:00:00.000Z', completed_at: '2026-08-21T00:00:01.000Z', revision: 1,
  };
  const service = { mutate: async () => rawInternalRow };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects: [{ id: 'dsh-p6-test-b' }], service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(sent.length, 1);
  const text = sent[0];
  for (const leaked of ['payload_digest', 'client_kind', 'actor_id', 'expected_revision', 'command_id', 'canonical_result']) {
    assert.equal(text.includes(leaked), false, `ACK leaked internal field "${leaked}": ${text}`);
  }
  assert.match(text, /dsh-p6-test-b/);
});
