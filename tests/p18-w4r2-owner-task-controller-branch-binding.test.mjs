import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { deriveTaskBranchName, TaskBranchLifecycleError } from '../src/pm/task-branch-binding.mjs';
import { OwnerControlError, deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

// P18-W4R2 / P24.1G6A — task-branch admission wired into
// OwnerTaskController.submit(), BEFORE the durable owner task/pm_run is
// ever created (owner-task-controller.mjs). These tests exercise the
// SUBMIT_TASK-layer wiring with a faked `admitTaskGitBinding` (unit-level,
// no real git subprocess) — real-git behavior of the admission primitives
// themselves is covered end-to-end in p18-w4r2-task-branch-binding.test.mjs
// and tests/p24-1g6a-dynamic-base-admission.test.mjs. The injectable seam
// used to be the lower-level `prepareTaskBranch`; P24.1G6A moved admission
// authority to `admitTaskGitBinding()` (src/pm/task-base-admission.mjs),
// which now owns base-policy/caller-CAS resolution BEFORE ever calling the
// (still real, still lower-level) `prepareTaskBranch()` — these tests were
// updated to fake that new seam instead.

function makeController({ admitTaskGitBinding } = {}) {
  const created = [];
  const repo = { createOwnerTask: (task) => created.push(task) };
  const controller = new OwnerTaskController({ repository: repo, startPm: async () => null, admitTaskGitBinding });
  return { controller, created };
}

const ALLOWED_AUTONOMY = { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'APPROVAL' } };
const FORBID_AUTONOMY = { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'FORBID' } };
const NO_KEY_AUTONOMY = { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } }; // absent -> defaults FORBID

test('BRANCH_CREATE FORBID (including the absent-key default): no branch is prepared, byte-for-byte pre-W4R2 behavior', async () => {
  let calls = 0;
  const { controller, created } = makeController({ admitTaskGitBinding: async () => { calls += 1; return {}; } });
  const profile = { id: 'pm-1' };

  for (const [label, autonomy] of [['explicit FORBID', FORBID_AUTONOMY], ['absent key', NO_KEY_AUTONOMY]]) {
    const project = { id: `proj-${label}`, autonomy };
    await controller.submit({ command: { command_id: `cmd-${label}`, client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true } } }, project, profile });
  }
  assert.equal(calls, 0);
  assert.equal('taskBranch' in created[0].context, false);
  assert.equal('taskBranch' in created[1].context, false);
});

test('no gitSync requested: no branch is prepared even when BRANCH_CREATE is granted', async () => {
  let calls = 0;
  const { controller, created } = makeController({ admitTaskGitBinding: async () => { calls += 1; return {}; } });
  const project = { id: 'proj-a', autonomy: ALLOWED_AUTONOMY };
  await controller.submit({ command: { command_id: 'cmd-no-git', client_kind: 'LOCAL', payload: { body: 'plain task' } }, project, profile: { id: 'pm-1' } });
  assert.equal(calls, 0);
  assert.equal('taskBranch' in created[0].context, false);
});

test('BRANCH_CREATE granted + gitSync requested: admitTaskGitBinding is called with the deterministic pre-computed task_id, BEFORE the task is created', async () => {
  const calls = [];
  let taskCreatedBeforePrepare = null;
  const { controller, created } = makeController({
    admitTaskGitBinding: async (args) => {
      calls.push(args);
      taskCreatedBeforePrepare = created.length > 0;
      return { task_id: args.taskId, project_id: args.projectId, task_mode: args.taskMode, base_branch: 'main', base_sha: 'a'.repeat(40), task_branch: deriveTaskBranchName(args.taskId), remote: args.remote, original_checkout: 'main' };
    },
  });
  const project = { id: 'proj-b', autonomy: ALLOWED_AUTONOMY };
  const commandId = 'cmd-prep-1';
  const expectedTaskId = deterministicOwnerId('task', commandId);

  const ack = await controller.submit({ command: { command_id: commandId, client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true } } }, project, profile: { id: 'pm-1' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, expectedTaskId);
  assert.equal(calls[0].projectId, 'proj-b');
  assert.equal(calls[0].taskMode, 'SINGLE');
  assert.equal(calls[0].project.id, 'proj-b', 'the FRESH project record is threaded through, not just its id');
  assert.equal(calls[0].callerExpectedBaseSha, null, 'no caller CAS was supplied for this request');
  assert.equal(taskCreatedBeforePrepare, false, 'branch admission must happen BEFORE createOwnerTask()');
  assert.equal(ack.task_id, expectedTaskId);
  assert.equal(created[0].context.taskBranch.task_branch, `dsh/task-${expectedTaskId}`);
});

test('COUNCIL mode: admitTaskGitBinding is called once with taskMode COUNCIL, same task_id shape', async () => {
  const calls = [];
  const { controller } = makeController({
    admitTaskGitBinding: async (args) => { calls.push(args); return { task_id: args.taskId, project_id: args.projectId, task_mode: args.taskMode, base_branch: 'main', base_sha: 'a'.repeat(40), task_branch: deriveTaskBranchName(args.taskId), remote: 'origin', original_checkout: 'main' }; },
  });
  const project = { id: 'proj-c', autonomy: ALLOWED_AUTONOMY };
  const council = { chair_profile_id: 'pm-chair', participant_profile_ids: ['pm-a', 'pm-b'], rounds: 1, strategy: 'independent_then_critique_then_synthesis' };
  await controller.submit({ command: { command_id: 'cmd-council-1', client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true } } }, project, profile: { id: 'pm-chair' }, council });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskMode, 'COUNCIL');
});

test('caller-supplied expected_base_sha is threaded through as the typed per-task CAS', async () => {
  const calls = [];
  const { controller } = makeController({
    admitTaskGitBinding: async (args) => { calls.push(args); return { task_id: args.taskId, project_id: args.projectId, task_mode: args.taskMode, base_branch: 'main', base_sha: args.callerExpectedBaseSha ?? 'a'.repeat(40), task_branch: deriveTaskBranchName(args.taskId), remote: 'origin', original_checkout: 'main' }; },
  });
  const project = { id: 'proj-cas', autonomy: ALLOWED_AUTONOMY };
  const expectedSha = 'b'.repeat(40);
  await controller.submit({ command: { command_id: 'cmd-cas-1', client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true, expected_base_sha: expectedSha } } }, project, profile: { id: 'pm-1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callerExpectedBaseSha, expectedSha);
});

test('malformed expected_base_sha rejects BEFORE any admission call at all', async () => {
  const calls = [];
  const { controller } = makeController({ admitTaskGitBinding: async (args) => { calls.push(args); return {}; } });
  const project = { id: 'proj-cas-bad', autonomy: ALLOWED_AUTONOMY };
  await assert.rejects(
    () => controller.submit({ command: { command_id: 'cmd-cas-bad', client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, expected_base_sha: 'not-a-sha' } } }, project, profile: { id: 'pm-1' } }),
    (e) => e instanceof OwnerControlError && e.code === 'CALLER_EXPECTED_BASE_SHA_INVALID',
  );
  assert.equal(calls.length, 0);
});

test('caller-supplied branch-shaped fields in payload.git are silently ignored — the branch is always DSH-derived', async () => {
  const calls = [];
  const { controller, created } = makeController({
    admitTaskGitBinding: async (args) => { calls.push(args); return { task_id: args.taskId, project_id: args.projectId, task_mode: args.taskMode, base_branch: 'main', base_sha: 'a'.repeat(40), task_branch: deriveTaskBranchName(args.taskId), remote: 'origin', original_checkout: 'main' }; },
  });
  const project = { id: 'proj-d', autonomy: ALLOWED_AUTONOMY };
  const commandId = 'cmd-no-caller-branch';
  const expectedTaskId = deterministicOwnerId('task', commandId);
  await controller.submit({
    command: { command_id: commandId, client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true, branch_name: 'evil', branch: 'evil' } } },
    project, profile: { id: 'pm-1' },
  });
  assert.equal(created[0].context.taskBranch.task_branch, `dsh/task-${expectedTaskId}`);
  assert.equal('branchName' in calls[0], false);
  assert.equal('branch' in calls[0], false);
});

test('an admitTaskGitBinding failure (e.g. dirty workspace) refuses the ENTIRE submission — no task, no pm_run, never a half-created task', async () => {
  const startPmCalls = [];
  const repo = { createOwnerTask: () => { throw new Error('must never be reached'); } };
  const controller = new OwnerTaskController({
    repository: repo,
    startPm: async (v) => { startPmCalls.push(v); return null; },
    admitTaskGitBinding: async () => { throw new TaskBranchLifecycleError('workspace is dirty', 'TASK_BRANCH_WORKSPACE_DIRTY', {}); },
  });
  const project = { id: 'proj-e', autonomy: ALLOWED_AUTONOMY };

  await assert.rejects(
    () => controller.submit({ command: { command_id: 'cmd-dirty', client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true } } }, project, profile: { id: 'pm-1' } }),
    (e) => e instanceof OwnerControlError && e.code === 'TASK_BRANCH_WORKSPACE_DIRTY',
  );
  assert.equal(startPmCalls.length, 0);
});

// ---- real-git integration: submit() actually creates the bound branch ----

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initWorktreeWithBareRemote(root) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', 'main']);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', 'main']);
  git(workDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', 'main']);
  return workDir;
}

test('real git: OwnerTaskController.submit() with the REAL admitTaskGitBinding actually creates and checks out dsh/task-<task_id>, dynamic policy, no config SHA needed', async () => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p18-w4r2-owner-submit-git-'));
  try {
    const workDir = initWorktreeWithBareRemote(gitRoot);
    const { controller, created } = makeController({}); // no override -> real task-base-admission.mjs + task-branch-binding.mjs impls
    const project = { id: 'proj-real', repo_path: workDir, autonomy: ALLOWED_AUTONOMY }; // no git_base_branch/git_base_sha at all -> dynamic default
    const commandId = 'cmd-real-git';
    const expectedTaskId = deterministicOwnerId('task', commandId);

    await controller.submit({ command: { command_id: commandId, client_kind: 'TELEGRAM', payload: { body: 'x', git: { commit: true, push: true } } }, project, profile: { id: 'pm-1' } });

    assert.equal(created[0].context.taskBranch.task_branch, `dsh/task-${expectedTaskId}`);
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), `dsh/task-${expectedTaskId}`);
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
});
