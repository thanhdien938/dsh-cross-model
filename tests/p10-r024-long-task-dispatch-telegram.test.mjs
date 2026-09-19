import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  routeTelegramUpdate, TelegramOwnerAdapter, renderTaskFileError, renderTaskFileCouncilNotSupported,
} from '../src/owner/telegram-owner-client.mjs';
import { TaskSourceError } from '../src/owner/task-source-resolver.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createTaskDiagnosticLogFactory, taskLogDir } from '../src/runtime/task-diagnostic-log.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

function fakeAliasRegistry() {
  return {
    resolveProject: (alias) => (alias === '2' ? 'proj-2' : (() => { throw Object.assign(new Error('unknown'), { code: 'ALIAS_PROJECT_UNKNOWN' }); })()),
    resolvePmProfile: (alias) => (alias === '9' ? 'pm-9' : (() => { throw Object.assign(new Error('unknown'), { code: 'ALIAS_PM_UNKNOWN' }); })()),
  };
}

// ---- Part B: dispatch syntax parsing ---------------------------------------

test('shorthand --task-file dispatch parses into an unresolved payload.task_file (never body text)', () => {
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file ff134b8 tasks/dsh/X.md' } };
  const routed = routeTelegramUpdate(update, { aliasRegistry: fakeAliasRegistry() });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.task_file, { ref: 'ff134b8', path: 'tasks/dsh/X.md' });
  assert.equal('body' in routed.payload, false);
});

test('canonical @project --task-file dispatch parses the same way', () => {
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@proj-2 --task-file ff134b8 tasks/dsh/X.md' } };
  const routed = routeTelegramUpdate(update, { projects: [{ id: 'proj-2' }] });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.task_file, { ref: 'ff134b8', path: 'tasks/dsh/X.md' });
});

test('a council --task-file dispatch is explicitly refused (deferred, never half-supported)', () => {
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '/c 2 9 9 --task-file ff134b8 tasks/dsh/X.md' } };
  const routed = routeTelegramUpdate(update, { aliasRegistry: fakeAliasRegistry() });
  assert.equal(routed.read, 'TASK_FILE_COUNCIL_NOT_SUPPORTED');
});

test('renderTaskFileCouncilNotSupported and renderTaskFileError never leak internals', () => {
  assert.ok(renderTaskFileCouncilNotSupported().startsWith('❌'));
  const msg = renderTaskFileError(new TaskSourceError('boom', 'TASK_FILE_NOT_FOUND', { path: 'tasks/dsh/x.md' }));
  assert.ok(msg.includes('TASK_FILE_NOT_FOUND'));
  assert.ok(msg.includes('backend was NOT started'));
});

// ---- Part N: adapter-level acceptance order (resolve THEN mutate) ---------

function fakeService({ mutateImpl } = {}) {
  const calls = [];
  return {
    calls,
    resolveCallback: async () => { throw new Error('not used'); },
    read: async () => ({}),
    mutate: async (routed) => { calls.push(routed); return mutateImpl ? mutateImpl(routed) : { canonical_result: { task_id: 't1', pm_profile_id: routed.payload.pm_profile_id ?? 'pm' } }; },
  };
}

function fakeFetchFor(update) {
  let served = false;
  return async (url) => {
    if (String(url).includes('getUpdates')) {
      if (served) return { ok: true, json: async () => ({ result: [] }) };
      served = true;
      return { ok: true, json: async () => ({ result: [update] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
}

test('a resolved task-file dispatch calls service.mutate with body/task_source, never the raw directive', async () => {
  const sent = [];
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file ff134b8 tasks/dsh/X.md' } };
  const service = fakeService();
  const taskFileResolver = async ({ projectId, ref, path }) => {
    assert.equal(projectId, 'proj-2');
    assert.equal(ref, 'ff134b8');
    assert.equal(path, 'tasks/dsh/X.md');
    return { type: 'GIT_FILE', requestedRef: ref, resolvedCommitSha: '0'.repeat(40), path, content: 'RESOLVED CANONICAL TASK TEXT', contentBytes: 29, contentSha256: '1'.repeat(64) };
  };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver });
  adapter.send = async (text) => { sent.push(text); };
  await adapter.pollOnce();
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].payload.body, 'RESOLVED CANONICAL TASK TEXT');
  assert.equal('task_file' in service.calls[0].payload, false);
  assert.equal(service.calls[0].payload.task_source.resolvedCommitSha, '0'.repeat(40));
  assert.ok(sent.some((t) => t.includes('LONG')));
});

test('a resolution failure never calls service.mutate — no backend spawn on preflight failure (Part N)', async () => {
  const sent = [];
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file badref tasks/dsh/X.md' } };
  const service = fakeService();
  const taskFileResolver = async () => { throw new TaskSourceError('ref did not resolve', 'TASK_FILE_REF_INVALID', { ref: 'badref' }); };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver });
  adapter.send = async (text) => { sent.push(text); };
  await adapter.pollOnce();
  assert.equal(service.calls.length, 0);
  assert.ok(sent.some((t) => t.includes('TASK_FILE_REF_INVALID')));
});

test('a task-file dispatch with no configured resolver fails closed with a clear message, never a crash', async () => {
  const sent = [];
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file ff134b8 tasks/dsh/X.md' } };
  const service = fakeService();
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update) });
  adapter.send = async (text) => { sent.push(text); };
  await adapter.pollOnce();
  assert.equal(service.calls.length, 0);
  assert.ok(sent.length > 0);
});

test('a plain (non-task-file) SUBMIT_TASK is completely unaffected by this wave (regression)', async () => {
  const sent = [];
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 fix the reconciliation report' } };
  const service = fakeService();
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update) });
  adapter.send = async (text) => { sent.push(text); };
  await adapter.pollOnce();
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].payload.body, 'fix the reconciliation report');
  assert.equal('task_source' in service.calls[0].payload, false);
});

// ---- P10-R0.2.4.2 Part D/J/K/L/M/W: preflight failure diagnostics ---------

test('Part W: a failed task-file dispatch gets a bounded dispatch-<id> diagnostic bundle — never PM_RUN_CREATED/BACKEND_PROCESS_SPAWN', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p10-r0242-preflight-'));
  try {
    const sent = [];
    const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file badref tasks/dsh/X.md' } };
    const service = fakeService();
    const taskFileResolver = async () => { throw new TaskSourceError('task file ref did not resolve to a commit: badref', 'TASK_FILE_REF_INVALID', { ref: 'badref' }); };
    const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver, taskDiagnosticsFactory });
    adapter.send = async (text) => { sent.push(text); };
    await adapter.pollOnce();

    assert.equal(service.calls.length, 0, 'backend must never spawn on a preflight failure');
    const entries = readdirSync(root);
    assert.equal(entries.length, 1, 'exactly one diagnostic bundle for the one failed dispatch');
    const dispatchId = entries[0];
    assert.ok(dispatchId.startsWith('dispatch-'), `expected a dispatch-<id> folder, got: ${dispatchId}`);
    const dir = taskLogDir(root, dispatchId);
    assert.ok(existsSync(join(dir, 'events.jsonl')), 'events.jsonl must exist');
    assert.ok(existsSync(join(dir, 'summary.md')), 'summary.md must exist');
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes('TASK_DISPATCH_RECEIVED'));
    assert.ok(types.includes('TASK_SOURCE_RESOLUTION_FAILED'));
    assert.ok(!types.includes('PM_RUN_CREATED'));
    assert.ok(!types.includes('BACKEND_PROCESS_SPAWN'));
    const failedEvent = events.find((e) => e.event_type === 'TASK_SOURCE_RESOLUTION_FAILED');
    assert.equal(failedEvent.error_code, 'TASK_FILE_REF_INVALID');
    assert.equal(failedEvent.backend_started, false);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.ok(summary.includes('TASK_FILE_REF_INVALID'));
    assert.ok(summary.includes('Backend'));
    assert.ok(summary.includes('- started: NO'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Part W: a repository-mismatch preflight failure records the typed error and project id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p10-r0242-preflight-mismatch-'));
  try {
    const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file deadbeef tasks/dsh/X.md' } };
    const service = fakeService();
    const taskFileResolver = async () => { throw new TaskSourceError('project working directory is not a git worktree', 'TASK_FILE_REPOSITORY_MISMATCH', { reason: 'NOT_A_WORKTREE' }); };
    const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver, taskDiagnosticsFactory });
    adapter.send = async () => {};
    await adapter.pollOnce();
    const dispatchId = readdirSync(root)[0];
    const summary = readFileSync(join(taskLogDir(root, dispatchId), 'summary.md'), 'utf8');
    assert.ok(summary.includes('TASK_FILE_REPOSITORY_MISMATCH'));
    assert.ok(summary.includes('Project'));
    assert.ok(summary.includes('proj-2'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Part W #9: a SUCCESSFUL task-file dispatch writes NO dispatch-<id> preflight bundle (only the real task path handles it)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p10-r0242-preflight-success-'));
  try {
    const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file ff134b8 tasks/dsh/X.md' } };
    const service = fakeService();
    const taskFileResolver = async ({ ref, path }) => ({ type: 'GIT_FILE', requestedRef: ref, resolvedCommitSha: '0'.repeat(40), path, content: 'ok', contentBytes: 2, contentSha256: '1'.repeat(64) });
    const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver, taskDiagnosticsFactory });
    adapter.send = async () => {};
    await adapter.pollOnce();
    assert.equal(service.calls.length, 1);
    assert.ok(!existsSync(root) || readdirSync(root).length === 0, 'no dispatch-<id> bundle for a successful resolution');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Part W #10: a plain non-task-file SUBMIT_TASK never touches taskDiagnosticsFactory at the adapter level', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p10-r0242-preflight-normal-'));
  try {
    const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 fix the reconciliation report' } };
    const service = fakeService();
    const taskDiagnosticsFactory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskDiagnosticsFactory });
    adapter.send = async () => {};
    await adapter.pollOnce();
    assert.equal(service.calls.length, 1);
    assert.ok(!existsSync(root) || readdirSync(root).length === 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing taskDiagnosticsFactory changes no Telegram-visible behavior (purely additive dep)', async () => {
  const sent = [];
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '2-9 --task-file badref tasks/dsh/X.md' } };
  const service = fakeService();
  const taskFileResolver = async () => { throw new TaskSourceError('boom', 'TASK_FILE_REF_INVALID', { ref: 'badref' }); };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', service, projects: [{ id: 'proj-2' }], aliasRegistry: fakeAliasRegistry(), fetchImpl: fakeFetchFor(update), taskFileResolver });
  adapter.send = async (text) => { sent.push(text); };
  await adapter.pollOnce();
  assert.equal(service.calls.length, 0);
  assert.ok(sent.some((t) => t.includes('TASK_FILE_REF_INVALID')));
});

// ---- Full pipeline: real git repo -> real resolver -> real composition ----

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

test('end-to-end: a real git task file, dispatched through the real composition, becomes the canonical LONG task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p10-r024-e2e-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'dsh-test@example.invalid']);
    git(repo, ['config', 'user.name', 'DSH Test']);
    mkdirSync(join(repo, 'tasks', 'dsh'), { recursive: true });
    writeFileSync(join(repo, 'tasks', 'dsh', 'CANARY.md'), '# Canary\n\nDo the thing.\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'add canary task']);
    git(repo, ['remote', 'add', 'origin', 'https://example.invalid/placeholder.git']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();

    const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
    const captured = [];
    const resolvePmDriver = (profile, context) => { captured.push(context); return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'ok' }; } }; };
    resolvePmDriver.inspect = (profile) => ({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind });
    const profile = { id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
    const project = { id: 'p', repo_path: repo, default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    const config = {
      postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'),
      projects: [project], profiles: [profile],
      telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p', pollIntervalMs: 10 },
      coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
      pm: { scriptedDecisions: null }, telegramAliases: fakeAliasRegistryFor(project.id, profile.id),
    };
    const coordination = { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} };
    const owner = {
      close: async () => {}, claimNotifications: async () => [],
      beginCommand: async (command) => ({ status: 'ACCEPTED', created_at: '2026-08-25T00:00:00.000Z', command_id: command.command_id }),
      completeCommand: async (commandId, canonical) => ({ command_id: commandId, status: 'COMPLETED', canonical_result: canonical }),
    };
    const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: `2-9 --task-file ${sha} tasks/dsh/CANARY.md` } };
    const composition = await createP5ProductionComposition(config, { resolvePmDriver, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: fakeFetchFor(update) });
    try {
      const sent = [];
      composition.adapter.send = async (text) => { sent.push(text); };
      await composition.adapter.pollOnce();
      assert.equal(captured.length, 1, 'the backend must have been spawned exactly once');
      assert.equal(captured[0].executionOptions.timeoutMs, 1_800_000);
      assert.equal(captured[0].executionOptions.stage, 'single_pm_long');
      assert.ok(sent.some((t) => t.includes('LONG')));
    } finally { await composition.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeAliasRegistryFor(projectId, pmProfileId) {
  return {
    listProjectAliases: () => [{ alias: '2', project_id: projectId }],
    listPmAliases: () => [{ alias: '9', pm_profile_id: pmProfileId }],
    projectAliasFor: (id) => (id === projectId ? '2' : null),
    pmAliasFor: (id) => (id === pmProfileId ? '9' : null),
    resolveProject: (alias) => (alias === '2' ? projectId : (() => { throw Object.assign(new Error('unknown'), { code: 'ALIAS_PROJECT_UNKNOWN' }); })()),
    resolvePmProfile: (alias) => (alias === '9' ? pmProfileId : (() => { throw Object.assign(new Error('unknown'), { code: 'ALIAS_PM_UNKNOWN' }); })()),
  };
}
