import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';

import { OwnerTaskController, normalizeTaskRelations, TASK_DURABILITY } from '../src/owner/owner-task-controller.mjs';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';
import { findTaskHistoryEntry } from '../src/runtime/task-context-index.mjs';
import { materializeTaskHistory } from '../src/runtime/repo-history-materializer.mjs';
import { CONTEXT_HINT_TEXT } from '../src/pm/task-context-hint.mjs';

// ---- normalizeTaskRelations (pure) -----------------------------------------

test('normalizeTaskRelations: absent/malformed input is null', () => {
  assert.equal(normalizeTaskRelations(undefined), null);
  assert.equal(normalizeTaskRelations({}), null);
  assert.equal(normalizeTaskRelations('task-1'), null);
});

test('normalizeTaskRelations: accepts a bounded set of relation fields, drops invalid ids', () => {
  const rel = normalizeTaskRelations({
    parent_task_id: 'task-parent',
    related_task_ids: ['task-a', 'task-b', 'invalid id with spaces', 'task-a'],
    remediation_of_task_id: 'task-old',
    review_of_task_id: null,
  });
  assert.equal(rel.parent_task_id, 'task-parent');
  assert.deepEqual(rel.related_task_ids, ['task-a', 'task-b']);
  assert.equal(rel.remediation_of_task_id, 'task-old');
  assert.equal(rel.review_of_task_id, null);
});

// ---- context hint gating (via OwnerTaskController.submit) ------------------

function project() { return { id: 'proj-a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }; }
function profile() { return { id: 'pm-1' }; }

test('the context hint is appended ONLY for a durable task — a DIRECT task body is byte-for-byte unchanged', async () => {
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });

  await controller.submit({ command: { command_id: 'c-direct', client_kind: 'LOCAL', payload: { body: 'plain task' } }, project: project(), profile: profile() });
  assert.equal(created[0].body, 'plain task', 'DIRECT (the default for a plain-prompt task) must never gain the hint');

  await controller.submit({ command: { command_id: 'c-durable', client_kind: 'LOCAL', payload: { body: 'plain task', durability: 'DURABLE_LOCAL' } }, project: project(), profile: profile() });
  assert.equal(created[1].body, `plain task\n\n---\n${CONTEXT_HINT_TEXT}`);
  assert.equal(created[1].context.durability, TASK_DURABILITY.DURABLE_LOCAL);
});

test('a task-file (LONG) dispatch defaults to DURABLE_LOCAL and gets the hint too', async () => {
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });
  await controller.submit({
    command: { command_id: 'c-long', client_kind: 'TELEGRAM', payload: { body: 'pinned content', task_source: { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) } } },
    project: project(), profile: profile(),
  });
  assert.equal(created[0].body, `pinned content\n\n---\n${CONTEXT_HINT_TEXT}`);
});

test('relations are stamped into the durable context exactly once, absent when not supplied', async () => {
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });
  await controller.submit({
    command: { command_id: 'c-rel', client_kind: 'LOCAL', payload: { body: 'follow-up task', relations: { parent_task_id: 'task-parent' } } },
    project: project(), profile: profile(),
  });
  assert.deepEqual(created[0].context.relations.parent_task_id, 'task-parent');

  await controller.submit({ command: { command_id: 'c-norel', client_kind: 'LOCAL', payload: { body: 'independent task' } }, project: project(), profile: profile() });
  assert.equal('relations' in created[1].context, false);
});

// ---- required-context pre-flight (pipe layer) ------------------------------

// NOTE: async-aware on purpose (unlike the sync-only withTmpProject helper
// in tests/p10-r02-repo-history-materializer.test.mjs) — several tests
// below `await` a pipe round-trip inside the callback, and a bare
// `try { return fn(dir); } finally { rmSync(...) }` would delete `dir`
// synchronously before an async callback's first `await` ever resumes.
async function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p12-r3-reqctx-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('SUBMIT_TASK with requires_context resolves against real durable history and blocks execution when absent', async () => withTmpProject(async (root) => {
  // Seed one real durable task via the actual materializer.
  materializeTaskHistory({
    projectRoot: root, taskId: 'task-parent', pmRunId: 'pmrun-parent', projectId: 'proj-a', taskMode: 'SINGLE',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', status: 'completed',
    ownerTaskText: 'parent task', pmProfileId: 'pm-1', history: [], finalOutput: 'done', finalData: {}, resolveProfile: () => null,
  });

  const pipeName = `\\\\.\\pipe\\dsh-p12r3-reqctx-${process.pid}-${randomUUID()}`;
  const authCapability = randomBytes(32).toString('hex');
  const enrolledOwnerActorId = '100000001';
  let received = [];
  const control = await startLocalRuntimeControl({
    pipeName, authCapability, readiness: () => ({ ready: true }), onShutdown: () => {}, enrolledOwnerActorId,
    ownerCommand: async (input) => { received.push(input); return { status: 'MATERIALIZED' }; },
    resolveRequiredContext: async ({ projectId, taskId }) => (projectId === 'proj-a' ? findTaskHistoryEntry(root, taskId) : null),
  });
  try {
    const request = (value) => new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      let response = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('connect', () => socket.write(`${JSON.stringify(value)}\n`));
      socket.on('data', (chunk) => {
        response += chunk;
        const newline = response.indexOf('\n');
        if (newline === -1) return;
        socket.end();
        resolve(JSON.parse(response.slice(0, newline)));
      });
    });

    const ok = await request({ id: 'found', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: 'cmd-found', project_id: 'proj-a', payload: { body: 'follow up', requires_context: { task_id: 'task-parent' } } } });
    assert.equal(ok.success, true);
    assert.equal(received.length, 1);

    const blocked = await request({ id: 'missing', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: 'cmd-missing', project_id: 'proj-a', payload: { body: 'follow up', requires_context: { task_id: 'task-does-not-exist' } } } });
    assert.deepEqual(blocked, { id: 'missing', success: false, error: 'TASK_CONTEXT_REQUIRED_UNAVAILABLE' });
    assert.equal(received.length, 1, 'a blocked required-context task must never reach ownerCommand — no pm_run is ever created');
  } finally {
    await control.close();
  }
}));

test('SUBMIT_TASK with requires_context but no resolver wired is refused as unavailable, never silently ignored', async () => {
  const pipeName = `\\\\.\\pipe\\dsh-p12r3-noresolver-${process.pid}-${randomUUID()}`;
  const authCapability = randomBytes(32).toString('hex');
  const control = await startLocalRuntimeControl({
    pipeName, authCapability, readiness: () => ({ ready: true }), onShutdown: () => {}, enrolledOwnerActorId: '100000001',
    ownerCommand: async () => ({ status: 'MATERIALIZED' }),
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      let buf = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'x', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: 'cmd-x', project_id: 'p', payload: { body: 'x', requires_context: { task_id: 't' } } } })}\n`));
      socket.on('data', (chunk) => { buf += chunk; const nl = buf.indexOf('\n'); if (nl === -1) return; socket.end(); resolve(JSON.parse(buf.slice(0, nl))); });
    });
    assert.deepEqual(response, { id: 'x', success: false, error: 'TASK_CONTEXT_REQUIRED_UNAVAILABLE' });
  } finally {
    await control.close();
  }
});

test('a malformed requires_context shape is refused before any resolution attempt', async () => {
  const pipeName = `\\\\.\\pipe\\dsh-p12r3-malformed-${process.pid}-${randomUUID()}`;
  const authCapability = randomBytes(32).toString('hex');
  let resolverCalls = 0;
  const control = await startLocalRuntimeControl({
    pipeName, authCapability, readiness: () => ({ ready: true }), onShutdown: () => {}, enrolledOwnerActorId: '100000001',
    ownerCommand: async () => ({ status: 'MATERIALIZED' }),
    resolveRequiredContext: async () => { resolverCalls += 1; return null; },
  });
  try {
    for (const bad of [{}, 'not-an-object', { task_id: 42 }]) {
      const response = await new Promise((resolve, reject) => {
        const socket = net.createConnection(pipeName);
        let buf = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'y', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: `cmd-${JSON.stringify(bad)}`, project_id: 'p', payload: { body: 'x', requires_context: bad } } })}\n`));
        socket.on('data', (chunk) => { buf += chunk; const nl = buf.indexOf('\n'); if (nl === -1) return; socket.end(); resolve(JSON.parse(buf.slice(0, nl))); });
      });
      assert.deepEqual(response, { id: 'y', success: false, error: 'MALFORMED_REQUEST' });
    }
    assert.equal(resolverCalls, 0);
  } finally {
    await control.close();
  }
});

// ---- task.json relations fields --------------------------------------------

test('task.json records relations when supplied, and stays absent-safe when not', () => withTmpProject((root) => {
  const withRel = materializeTaskHistory({
    projectRoot: root, taskId: 'task-child', pmRunId: 'pmrun-child', projectId: 'proj-a', taskMode: 'SINGLE',
    createdAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T00:01:00.000Z', status: 'completed',
    ownerTaskText: 'child task', pmProfileId: 'pm-1', history: [], finalOutput: 'done', finalData: {}, resolveProfile: () => null,
    relations: { parent_task_id: 'task-parent', related_task_ids: ['task-x'], remediation_of_task_id: null, review_of_task_id: null },
  });
  const dir1 = join(root, ...withRel.historyPath.split('/'));
  const json1 = JSON.parse(readFileSync(join(dir1, 'task.json'), 'utf8'));
  assert.equal(json1.parent_task_id, 'task-parent');
  assert.deepEqual(json1.related_task_ids, ['task-x']);
}));
