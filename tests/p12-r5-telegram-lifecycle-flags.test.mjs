import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';

// P12-R5 — real Telegram syntax for the durability/git-sync/review contract
// fields R2-R4 built (previously reachable only via a raw pipe/IPC call).
// This is what makes the owner-live DURABLE_REMOTE test actually dispatchable
// from Telegram.

test('parseOwnerFlags: --durability accepts direct/local/remote case-insensitively', () => {
  assert.equal(parseOwnerFlags('--durability direct do it').durability, 'DIRECT');
  assert.equal(parseOwnerFlags('--durability LOCAL do it').durability, 'DURABLE_LOCAL');
  assert.equal(parseOwnerFlags('--durability Remote do it').durability, 'DURABLE_REMOTE');
});

test('parseOwnerFlags: an invalid --durability value is refused, never silently defaulted', () => {
  assert.throws(() => parseOwnerFlags('--durability nonsense do it'), /must be one of: direct, local, remote/);
});

test('parseOwnerFlags: --commit/--push/--review are bare boolean switches, never consuming a following word', () => {
  const r = parseOwnerFlags('--commit --push --review do the actual task');
  assert.equal(r.commit, true);
  assert.equal(r.push, true);
  assert.equal(r.review, true);
  assert.equal(r.text, 'do the actual task');
});

test('parseOwnerFlags: flags can be combined with --pm and --durability in any documented order', () => {
  const r = parseOwnerFlags('--pm pm-1 --durability remote --commit --push --review fix the thing');
  assert.equal(r.pmProfileId, 'pm-1');
  assert.equal(r.durability, 'DURABLE_REMOTE');
  assert.equal(r.commit, true);
  assert.equal(r.push, true);
  assert.equal(r.review, true);
  assert.equal(r.text, 'fix the thing');
});

test('parseOwnerFlags: omitting every new flag is byte-for-byte the pre-P12 default (false/null)', () => {
  const r = parseOwnerFlags('--pm pm-1 plain task');
  assert.equal(r.durability, null);
  assert.equal(r.commit, false);
  assert.equal(r.push, false);
  assert.equal(r.review, false);
});

test('parseOwnerFlags: --remote names a non-default remote, only meaningful alongside --commit/--push', () => {
  assert.equal(parseOwnerFlags('--push --remote test-remote do it').remote, 'test-remote');
});

test('a --push --remote combination reaches payload.git.remote unmodified — enables a safe, controlled remote-sync-failure rehearsal (R5 TEST 5) against a deliberately unconfigured remote name, never a real credential/URL', () => {
  const routed = routeTelegramUpdate(update('@proj-a --commit --push --remote deliberately-unconfigured-remote ship it'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.git, { commit: true, push: true, remote: 'deliberately-unconfigured-remote' });
});

test('parseOwnerFlags: --parent/--remediates/--reviews/--requires-context are extracted', () => {
  const r = parseOwnerFlags('--parent task-1 --remediates task-2 --reviews task-3 --requires-context task-4 do it');
  assert.equal(r.parentTaskId, 'task-1');
  assert.equal(r.remediatesTaskId, 'task-2');
  assert.equal(r.reviewsTaskId, 'task-3');
  assert.equal(r.requiresContextTaskId, 'task-4');
  assert.equal(r.text, 'do it');
});

test('a --remediates dispatch produces the exact relations.remediation_of_task_id shape R3 already validated', () => {
  const routed = routeTelegramUpdate(update('@proj-a --remediates task-parent-123 fix the thing that failed'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.relations, { remediation_of_task_id: 'task-parent-123' });
});

test('a --requires-context dispatch produces the exact payload.requires_context shape the pipe pre-flight expects', () => {
  const routed = routeTelegramUpdate(update('@proj-a --requires-context task-earlier-1 continue the earlier work'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.requires_context, { task_id: 'task-earlier-1' });
});

// ---- end-to-end through routeTelegramUpdate --------------------------------

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
const projects = [{ id: 'proj-a' }];

test('a real @project dispatch with the full DURABLE_REMOTE flag set produces the exact payload shape owner-task-controller.mjs expects', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --durability remote --commit --push --review ship the fix'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload, {
    body: 'ship the fix', pm_profile_id: 'pm-1', durability: 'DURABLE_REMOTE',
    git: { commit: true, push: true }, review: { requested: true },
  });
});

test('--push alone still implies commit (matches normalizeGitSyncRequest exactly)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --push ship it'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.git, { commit: true, push: true });
});

test('a plain dispatch with no new flags carries no durability/git/review fields at all (zero payload noise)', () => {
  const routed = routeTelegramUpdate(update('@proj-a plain task'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload, { body: 'plain task' });
});

test('the flags also work on a task-file dispatch (durability/git/review are orthogonal to source)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --durability remote --commit --push --task-file main tasks/dsh/X.md'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.task_file, { ref: 'main', path: 'tasks/dsh/X.md' });
  assert.equal(routed.payload.durability, 'DURABLE_REMOTE');
  assert.deepEqual(routed.payload.git, { commit: true, push: true });
});
