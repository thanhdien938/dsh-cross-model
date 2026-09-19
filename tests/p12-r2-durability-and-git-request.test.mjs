import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_DURABILITY, normalizeDurability, normalizeGitSyncRequest, OwnerTaskController } from '../src/owner/owner-task-controller.mjs';

// P12-R2 — durability default/override and the optional git-sync request
// shape, stamped once at SUBMIT_TASK acceptance (owner-task-controller.mjs).

test('normalizeDurability: NORMAL runtimeClass defaults to DIRECT (the owner-approved P12-R0 §3 behavior change)', () => {
  assert.equal(normalizeDurability(undefined, 'NORMAL'), TASK_DURABILITY.DIRECT);
  assert.equal(normalizeDurability(null, 'NORMAL'), TASK_DURABILITY.DIRECT);
});

test('normalizeDurability: LONG runtimeClass defaults to DURABLE_LOCAL — byte-for-byte the pre-P12 behavior', () => {
  assert.equal(normalizeDurability(undefined, 'LONG'), TASK_DURABILITY.DURABLE_LOCAL);
});

test('normalizeDurability: an explicit owner value always overrides the computed default, in either direction', () => {
  assert.equal(normalizeDurability('direct', 'LONG'), TASK_DURABILITY.DIRECT);
  assert.equal(normalizeDurability('durable_remote', 'NORMAL'), TASK_DURABILITY.DURABLE_REMOTE);
  assert.equal(normalizeDurability('DURABLE_LOCAL', 'NORMAL'), TASK_DURABILITY.DURABLE_LOCAL);
});

test('normalizeDurability: an invalid/unrecognized value falls back to the computed default, never throws', () => {
  assert.equal(normalizeDurability('not-a-real-level', 'NORMAL'), TASK_DURABILITY.DIRECT);
  assert.equal(normalizeDurability(42, 'LONG'), TASK_DURABILITY.DURABLE_LOCAL);
});

test('normalizeGitSyncRequest: absent/malformed input is "not requested" (null)', () => {
  assert.equal(normalizeGitSyncRequest(undefined), null);
  assert.equal(normalizeGitSyncRequest(null), null);
  assert.equal(normalizeGitSyncRequest('commit please'), null);
  assert.equal(normalizeGitSyncRequest({}), null);
  assert.equal(normalizeGitSyncRequest({ commit: 'yes' }), null); // must be boolean true, not truthy
});

test('normalizeGitSyncRequest: commit-only request', () => {
  const req = normalizeGitSyncRequest({ commit: true });
  assert.deepEqual({ commit: req.commit, push: req.push, remote: req.remote }, { commit: true, push: false, remote: undefined });
});

test('normalizeGitSyncRequest: push implies commit — never pushes without something to commit first', () => {
  const req = normalizeGitSyncRequest({ push: true });
  assert.equal(req.commit, true);
  assert.equal(req.push, true);
});

test('normalizeGitSyncRequest: a valid remote name is preserved; an invalid explicit remote fails closed', () => {
  assert.equal(normalizeGitSyncRequest({ commit: true, remote: 'upstream' }).remote, 'upstream');
  assert.throws(() => normalizeGitSyncRequest({ commit: true, remote: 'not a remote name!' }), (error) => error?.code === 'GIT_REMOTE_INVALID');
});

// ---- end-to-end through OwnerTaskController.submit() -----------------------

test('OwnerTaskController.submit stamps durability and gitSync into the durable task context exactly once', async () => {
  const created = [];
  const repo = { createOwnerTask: (task) => created.push(task) };
  const controller = new OwnerTaskController({ repository: repo, startPm: async () => null });
  const project = { id: 'proj-a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const profile = { id: 'pm-1' };

  await controller.submit({
    command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'plain task', git: { commit: true, push: true } } },
    project, profile,
  });
  assert.equal(created[0].context.durability, TASK_DURABILITY.DIRECT);
  assert.deepEqual({ commit: created[0].context.gitSync.commit, push: created[0].context.gitSync.push }, { commit: true, push: true });

  await controller.submit({
    command: { command_id: 'cmd-2', client_kind: 'TELEGRAM', payload: { body: 'pinned file content', task_source: { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) } } },
    project, profile,
  });
  assert.equal(created[1].context.durability, TASK_DURABILITY.DURABLE_LOCAL);
  assert.equal('gitSync' in created[1].context, false);

  await controller.submit({
    command: { command_id: 'cmd-3', client_kind: 'LOCAL', payload: { body: 'explicit remote request', durability: 'DURABLE_REMOTE' } },
    project, profile,
  });
  assert.equal(created[2].context.durability, TASK_DURABILITY.DURABLE_REMOTE);
});
