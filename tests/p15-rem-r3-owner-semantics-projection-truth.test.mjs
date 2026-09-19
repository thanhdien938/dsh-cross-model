/**
 * P15-REM-R3 — Shared Owner Intent + Truthful Projections (root-side).
 *
 * REM-R3-A (P15-D-001): Telegram alias shorthand and canonical `@project`
 * syntax must feed the SAME shared parseOwnerFlags()/applyLifecycleFlags()
 * normalizer — no lifecycle flag may be silently swallowed into prompt
 * prose by one grammar branch only.
 *
 * REM-R3-B (P15-D-002): `requires_context` must be enforced by the ONE
 * shared submission authority (OwnerTaskController#submit()), not only by
 * Desktop's pipe preflight — every ingress path (Desktop/LOCAL, Telegram
 * canonical, Telegram alias shorthand) must receive identical behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';
import { findTaskHistoryEntry } from '../src/runtime/task-context-index.mjs';
import { materializeTaskHistory } from '../src/runtime/repo-history-materializer.mjs';

const projects = [
  { id: 'live1-local', display_name: 'DSH LIVE-1 Local' },
  { id: 'dsh-p6-test-b' },
];
const pmProfiles = [
  { id: 'live1-claude-sonnet-high', product: 'claude-code', model: 'sonnet', reasoning: 'high' },
  { id: 'live1-codex-pm', product: 'codex', model: 'default', reasoning: null },
  { id: 'live1-grok-pm', product: 'grok', model: 'grok-4.5', reasoning: null },
];

function aliasRegistry() {
  return new TelegramAliasRegistry({
    projects: { 1: 'live1-local', 2: 'dsh-p6-test-b' },
    pmProfiles: { 1: 'live1-claude-sonnet-high', 2: 'live1-codex-pm', 3: 'live1-grok-pm' },
  });
}

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }

// ===========================================================================
// REM-R3-A (P15-D-001) — canonical vs alias parity
// ===========================================================================

test('P15-D-001 RED (mechanism): the pre-fix alias shorthand grammar branch swallowed the ENTIRE lifecycle-flag sequence into the prompt body — reproduced here against the durability flag specifically', () => {
  // Pre-fix, routeTelegramUpdate's shorthand branch used `body = rawBody.trim()`
  // directly, with no parseOwnerFlags() call at all. Post-fix, the exact
  // same input is recognized as a flag and refused as a bare-word (no
  // value), never silently absorbed — proving the branch now actually
  // parses rather than passing text through untouched. (A canonical
  // equivalent already errors identically — this establishes shorthand now
  // shares that behavior instead of accepting it as literal prompt text.)
  const shorthand = routeTelegramUpdate(update('2-2 --durability'), { projects, aliasRegistry: aliasRegistry() });
  assert.notEqual(shorthand.read, undefined, 'pre-fix this would have been operation:SUBMIT_TASK with payload.body === "--durability" (a lifecycle flag token silently treated as prompt text)');
  assert.equal(shorthand.operation, undefined);
});

for (const [label, flagString, assertPayload] of [
  ['--durability DIRECT', '--durability direct', (p) => assert.equal(p.durability, 'DIRECT')],
  ['--durability DURABLE_LOCAL --commit', '--durability local --commit', (p) => { assert.equal(p.durability, 'DURABLE_LOCAL'); assert.deepEqual(p.git, { commit: true, push: false }); }],
  ['--durability DURABLE_REMOTE --commit --push', '--durability remote --commit --push', (p) => { assert.equal(p.durability, 'DURABLE_REMOTE'); assert.deepEqual(p.git, { commit: true, push: true }); }],
  ['--review', '--review', (p) => assert.deepEqual(p.review, { requested: true })],
  ['relations (--parent/--remediates/--reviews)', '--parent task-a --remediates task-b --reviews task-c', (p) => assert.deepEqual(p.relations, { parent_task_id: 'task-a', remediation_of_task_id: 'task-b', review_of_task_id: 'task-c' })],
  ['--requires-context', '--requires-context task-z', (p) => assert.deepEqual(p.requires_context, { task_id: 'task-z' })],
]) {
  test(`P15-D-001 GREEN: alias/canonical parity for ${label}`, () => {
    const body = 'do the thing';
    const canonical = routeTelegramUpdate(update(`@dsh-p6-test-b --pm live1-codex-pm ${flagString} ${body}`), { projects });
    const shorthand = routeTelegramUpdate(update(`2-2 ${flagString} ${body}`), { projects, aliasRegistry: aliasRegistry() });
    assert.equal(canonical.operation, 'SUBMIT_TASK', `canonical ${label} must be accepted`);
    assert.equal(shorthand.operation, 'SUBMIT_TASK', `alias shorthand ${label} must be accepted identically — it must not fall through to prompt prose`);
    assertPayload(canonical.payload);
    assertPayload(shorthand.payload);
    // The true user prompt text is identical and untouched by flag parsing.
    assert.equal(shorthand.payload.body, body);
    assert.equal(canonical.payload.body, body);
  });
}

test('P15-D-001 GREEN: council alias shorthand also parses lifecycle flags (was completely unparsed before this fix)', () => {
  const canonical = routeTelegramUpdate(update('@dsh-p6-test-b --pm live1-codex-pm --debate live1-grok-pm --durability local --commit --review compare two designs'), { projects });
  const shorthand = routeTelegramUpdate(update('/c 2 2 3 --durability local --commit --review compare two designs'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(canonical.operation, 'SUBMIT_TASK');
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.equal(shorthand.payload.durability, 'DURABLE_LOCAL');
  assert.deepEqual(shorthand.payload.git, { commit: true, push: false });
  assert.deepEqual(shorthand.payload.review, { requested: true });
  assert.equal(shorthand.payload.body, 'compare two designs');
  assert.equal(shorthand.payload.council.chair_profile_id, canonical.payload.council.chair_profile_id);
  assert.deepEqual(shorthand.payload.council.participant_profile_ids, canonical.payload.council.participant_profile_ids);
});

test('P15-D-001 GREEN: task-file directive PLUS lifecycle flags now works in alias shorthand (previously: no match, entire string became body)', () => {
  const canonical = routeTelegramUpdate(update('@dsh-p6-test-b --pm live1-codex-pm --task-file main path/to/task.md --durability remote --commit --push'), { projects });
  const shorthand = routeTelegramUpdate(update('2-2 --task-file main path/to/task.md --durability remote --commit --push'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(canonical.operation, 'SUBMIT_TASK');
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.deepEqual(shorthand.payload.task_file, { ref: 'main', path: 'path/to/task.md' });
  assert.equal(shorthand.payload.durability, 'DURABLE_REMOTE');
  assert.deepEqual(shorthand.payload.git, { commit: true, push: true });
  assert.equal('body' in shorthand.payload, false, 'a task-file dispatch never carries a separate prompt body');
});

test('P15-D-001 GREEN: a bare task-file directive alone still works in shorthand (non-regression)', () => {
  const shorthand = routeTelegramUpdate(update('2-2 --task-file main path/to/task.md'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.deepEqual(shorthand.payload.task_file, { ref: 'main', path: 'path/to/task.md' });
});

test('P15-D-001 GREEN: unknown flags fail explicitly in shorthand, exactly like canonical — never silently become prose', () => {
  const canonical = routeTelegramUpdate(update('@dsh-p6-test-b --pm live1-codex-pm --bogus-flag value do the thing'), { projects });
  const shorthand = routeTelegramUpdate(update('2-2 --bogus-flag value do the thing'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(canonical.read, 'FLAGS_INVALID');
  assert.equal(shorthand.read, 'FLAGS_INVALID', 'a syntactically-flag-shaped unknown token must be refused, not silently absorbed as prompt text');
  assert.match(shorthand.detail, /unknown flag/);
});

test('P15-D-001 GREEN: --pm/--debate in shorthand body text is refused explicitly — PM identity is the alias, never overridden silently', () => {
  const shorthand = routeTelegramUpdate(update('2-2 --pm live1-grok-pm do the thing'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(shorthand.read, 'FLAGS_INVALID');
  assert.match(shorthand.detail, /alias/);
});

test('P15-D-001 GREEN: prompt body text that does not start with "--" is never mis-parsed as a flag, in either grammar', () => {
  const body = 'please double-check the config -- it looks off';
  const canonical = routeTelegramUpdate(update(`@dsh-p6-test-b --pm live1-codex-pm ${body}`), { projects });
  const shorthand = routeTelegramUpdate(update(`2-2 ${body}`), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(canonical.payload.body, body);
  assert.equal(shorthand.payload.body, body);
});

test('P15-D-001 non-regression: shorthand with no flags at all is byte-for-byte unchanged', () => {
  const shorthand = routeTelegramUpdate(update('2-2 inspect current repository architecture'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.equal(shorthand.payload.body, 'inspect current repository architecture');
  assert.equal(shorthand.payload.pm_profile_id, 'live1-codex-pm');
  assert.equal('durability' in shorthand.payload, false);
  assert.equal('git' in shorthand.payload, false);
});

// ===========================================================================
// REM-R3-B (P15-D-002) — shared requires-context authority
// ===========================================================================

function project() { return { id: 'proj-a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }; }
function profile() { return { id: 'pm-1' }; }

async function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p15-r3b-reqctx-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('P15-D-002 RED (mechanism): OwnerTaskController#submit() previously had no requires_context enforcement at all — a bare submit() with no resolveRequiredContext wired silently accepted requires_context before this fix', async () => {
  // Reproduces the exact pre-fix acceptance: an OwnerTaskController built
  // the way TelegramOwnerAdapter's real composition ALWAYS built it before
  // REM-R3-B (no resolveRequiredContext dependency existed on this class at
  // all) would have created the task regardless of whether the referenced
  // context existed. Post-fix, `resolveRequiredContext` defaults to `null`,
  // which now REFUSES rather than silently accepting (see next test) — this
  // documents that the safe default flipped from "ignore" to "refuse".
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });
  await assert.rejects(
    () => controller.submit({ command: { command_id: 'c1', client_kind: 'TELEGRAM', payload: { body: 'follow up', requires_context: { task_id: 'task-parent' } } }, project: project(), profile: profile() }),
    (error) => error instanceof OwnerControlError && error.code === 'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  );
  assert.equal(created.length, 0, 'no misleading runnable work is ever created when the check cannot be performed');
});

test('P15-D-002 GREEN: Telegram-originated SUBMIT_TASK (client_kind TELEGRAM) is now blocked by the shared authority when required context is missing — this is the exact gap the audit found (Desktop blocked, Telegram silently executed)', async () => withTmpProject(async (root) => {
  const created = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async ({ projectId, taskId }) => (projectId === 'proj-a' ? findTaskHistoryEntry(root, taskId) : null),
  });
  await assert.rejects(
    () => controller.submit({ command: { command_id: 'c-missing', client_kind: 'TELEGRAM', payload: { body: 'follow up', requires_context: { task_id: 'task-does-not-exist' } } }, project: project(), profile: profile() }),
    (error) => error instanceof OwnerControlError && error.code === 'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  );
  assert.equal(created.length, 0);
}));

test('P15-D-002 GREEN: LOCAL (Desktop) client_kind gets identical enforcement at the shared authority — parity, not just the pipe\'s own early check', async () => withTmpProject(async (root) => {
  const created = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async ({ projectId, taskId }) => (projectId === 'proj-a' ? findTaskHistoryEntry(root, taskId) : null),
  });
  await assert.rejects(
    () => controller.submit({ command: { command_id: 'c-missing', client_kind: 'LOCAL', payload: { body: 'follow up', requires_context: { task_id: 'task-does-not-exist' } } }, project: project(), profile: profile() }),
    (error) => error instanceof OwnerControlError && error.code === 'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  );
  assert.equal(created.length, 0);
}));

test('P15-D-002 GREEN: an alias-originated Telegram route (client_kind TELEGRAM, via routeTelegramUpdate + --requires-context) is blocked identically through the full OwnerControlService path', async () => withTmpProject(async (root) => {
  const routed = routeTelegramUpdate(update('2-2 --requires-context task-does-not-exist follow up'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.requires_context, { task_id: 'task-does-not-exist' });

  const created = [];
  const taskController = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async ({ taskId }) => findTaskHistoryEntry(root, taskId),
  });
  const service = new OwnerControlService({
    repository: { beginCommand: async () => ({ status: 'PENDING', created_at: '2026-01-01T00:00:00.000Z' }), completeCommand: async (id, canonical) => canonical },
    taskController, projects: [{ id: 'dsh-p6-test-b', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }], pmProfiles,
  });
  await assert.rejects(
    () => service.mutate({ command_id: routed.command_id, actor_id: routed.actor_id, client_kind: routed.client_kind, operation: routed.operation, project_id: routed.project_id, payload: routed.payload }),
    (error) => error instanceof OwnerControlError && error.code === 'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  );
  assert.equal(created.length, 0);
}));

test('P15-D-002 GREEN: when required context IS available, submission proceeds normally through the shared authority', async () => withTmpProject(async (root) => {
  materializeTaskHistory({
    projectRoot: root, taskId: 'task-parent', pmRunId: 'pmrun-parent', projectId: 'proj-a', taskMode: 'SINGLE',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', status: 'completed',
    ownerTaskText: 'parent task', pmProfileId: 'pm-1', history: [], finalOutput: 'done', finalData: {}, resolveProfile: () => null,
  });
  const created = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async ({ projectId, taskId }) => (projectId === 'proj-a' ? findTaskHistoryEntry(root, taskId) : null),
  });
  const result = await controller.submit({ command: { command_id: 'c-found', client_kind: 'TELEGRAM', payload: { body: 'follow up', requires_context: { task_id: 'task-parent' } } }, project: project(), profile: profile() });
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(created.length, 1);
}));

test('P15-D-002 GREEN: a malformed requires_context shape is refused before any resolver call, at the shared authority', async () => {
  let resolverCalls = 0;
  const created = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async () => { resolverCalls += 1; return null; },
  });
  for (const bad of [{}, 'not-an-object', { task_id: 42 }]) {
    await assert.rejects(
      () => controller.submit({ command: { command_id: `c-${JSON.stringify(bad)}`, client_kind: 'TELEGRAM', payload: { body: 'x', requires_context: bad } }, project: project(), profile: profile() }),
      (error) => error instanceof OwnerControlError && error.code === 'REQUIRES_CONTEXT_MALFORMED',
    );
  }
  assert.equal(resolverCalls, 0);
  assert.equal(created.length, 0);
});

test('P15-D-002 GREEN: a resolver that throws (history/projection unavailable) is treated as "not found" — fail-closed, never silently proceeds', async () => {
  const created = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: (t) => created.push(t) },
    startPm: async () => null,
    resolveRequiredContext: async () => { throw new Error('disk unavailable'); },
  });
  await assert.rejects(
    () => controller.submit({ command: { command_id: 'c-throw', client_kind: 'TELEGRAM', payload: { body: 'x', requires_context: { task_id: 'task-parent' } } }, project: project(), profile: profile() }),
    (error) => error instanceof OwnerControlError && error.code === 'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  );
  assert.equal(created.length, 0);
});

test('P15-D-002 non-regression: every existing caller that never uses requires_context is completely unaffected', async () => {
  const created = [];
  const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null });
  const result = await controller.submit({ command: { command_id: 'c-plain', client_kind: 'LOCAL', payload: { body: 'plain task' } }, project: project(), profile: profile() });
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(created.length, 1);
  assert.equal(created[0].body, 'plain task');
});
