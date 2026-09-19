import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { ProductionPmWorkHandler, pmWorkIdentity } from '../src/runtime/production-pm-worker.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';

// P18-W4R2 — THE CANARY (PM mandate): Telegram-origin task -> DSH-created
// task branch -> real edit -> code commit -> publication commit (if
// materialization changed anything) -> push exact task branch -> base
// remote unchanged -> worktree clean. Runs the REAL OwnerTaskController.
// submit() (real prepareTaskBranch, no fakes) chained into the REAL
// ProductionPmWorkHandler.execute(), against a throwaway, isolated local
// git fixture (a local bare repo standing in for "origin") — never the
// dirty live dsh-p6-test-b workspace, exactly as directed.

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
  return { bareDir, workDir };
}

test('CANARY: real Telegram SUBMIT_TASK -> real prepareTaskBranch -> real backend edit -> real settlement -> real verified push, base branch untouched, worktree clean', async () => {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'p18-w4r2-canary-sqlite-'));
  const gitRoot = mkdtempSync(join(tmpdir(), 'p18-w4r2-canary-git-'));
  const logRoot = mkdtempSync(join(tmpdir(), 'p18-w4r2-canary-logs-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(sqliteDir, 'x.db') });
    await store.migrate();
    const pmRepository = new PmRepository({ store });
    const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
    const baseShaBefore = git(workDir, ['rev-parse', 'origin/main']).trim();

    // ---- 1. Real Telegram-origin SUBMIT_TASK through the real OwnerTaskController.submit() ----
    const created = [];
    const controller = new OwnerTaskController({ repository: { createOwnerTask: (t) => created.push(t) }, startPm: async () => null }); // no DI override -> the REAL task-branch-binding.mjs
    const project = { id: 'proj-canary', repo_path: workDir, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } } };
    const commandId = 'cmd-canary-e2e';
    const ack = await controller.submit({
      command: { command_id: commandId, client_kind: 'TELEGRAM', payload: { body: 'canary task body', git: { commit: true, push: true }, durability: 'DURABLE_LOCAL' } },
      project, profile: { id: 'pm-1' },
    });
    const taskId = ack.task_id;
    const taskRecord = created[0];
    const binding = taskRecord.context.taskBranch;
    assert.equal(binding.task_branch, `dsh/task-${taskId}`);
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch, 'the real submit() left the workspace checked out on the bound branch');

    // ---- 2. "real edit" — the PM backend's own turn (scripted, per this codebase's established test convention for proving git/materialization mechanics without a real CLI spawn — see p12-r2/p12-r4/p10-r02) ----
    writeFileSync(join(workDir, 'CANARY_CHANGE.md'), 'the real edit made by this task\n');

    const request = createPmRequest({
      objective: 'canary task body',
      context: { ownerCommandId: commandId, channel: 'TELEGRAM', durability: 'DURABLE_LOCAL', git: { commit: true, push: true } },
    });
    await pmRepository.create(request, { id: 'pmrun-canary', driver: 'single-pm-fake', startedAt: '2026-01-01T00:00:00.000Z' });

    // submit()'s own `task` object never carries `projectId` on itself (the
    // real repository stores it from the separate createOwnerTask() options
    // arg) — a real taskRepository.getOwnerTask() merges the two back
    // together; this fake does the same, matching this codebase's other
    // test fakes (p12-r4/p10-r02 buildHandler()).
    const taskRepository = { getOwnerTask: (id) => (id === taskId ? { ...taskRecord, projectId: project.id, pmProfileId: 'pm-1' } : null) };
    const coordinationStore = { completeClaim: async () => {} };
    const createRuntime = () => new DurablePmRuntime({
      driver: createScriptedPmDriver({ name: 'single-pm-fake', decisions: [{ type: 'finish', output: 'canary done', data: { type: 'single_result' } }] }),
      workflowRunner: { async run() { throw new Error('unused'); }, result() { return null; } },
      peerRelay: { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } },
      repository: pmRepository, maxTurns: 4,
    });
    const handler = new ProductionPmWorkHandler({ coordinationStore, pmRepository, ownerRepository: {}, taskRepository, projects: [project], createRuntime, enableRepoHistoryMaterialization: true });
    const work = { pm_run_id: 'pmrun-canary', action_id: pmWorkIdentity({ taskId, pmRunId: 'pmrun-canary' }).action_id };

    // ---- 3. real settlement: commit -> (no materialization here — verified separately in the settlement test file) -> verified push ----
    const outcome = await handler.execute({ work, fence: {} });

    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.outcome.artifact_status, 'ARTIFACTS_MATERIALIZED');
    assert.equal(outcome.result.outcome.local_git_status, 'LOCAL_COMMIT_VERIFIED');
    assert.equal(outcome.result.outcome.remote_sync_status, 'REMOTE_PUSH_VERIFIED');

    // ---- P24 atomic settlement: exactly 1 unified commit for code changes and materialized history ----
    const commitsAheadOfBase = git(workDir, ['log', '--format=%s', `${binding.base_sha}..${binding.task_branch}`]).trim().split('\n');
    assert.equal(commitsAheadOfBase.length, 1, `expected 1 unified settlement commit, got:\n${commitsAheadOfBase.join('\n')}`);

    const publishedHead = git(workDir, ['rev-parse', binding.task_branch]).trim();
    // ---- 4. push exact task branch — verify remote head ----
    const remoteTaskBranchSha = git(workDir, ['ls-remote', bareDir, binding.task_branch]).trim().split(/\s+/)[0];
    assert.equal(remoteTaskBranchSha, publishedHead);

    // ---- 5. base remote unchanged ----
    const remoteMainAfter = git(workDir, ['ls-remote', bareDir, 'main']).trim().split(/\s+/)[0];
    assert.equal(remoteMainAfter, baseShaBefore);
    assert.equal(binding.base_sha, baseShaBefore);

    // ---- 6. worktree clean ----
    assert.equal(git(workDir, ['status', '--porcelain']).trim(), '');

    // Print the full evidence bundle for the human-readable report.
    console.log(JSON.stringify({
      task_id: taskId, task_branch: binding.task_branch, base_sha_before: baseShaBefore, base_sha_after: remoteMainAfter,
      published_head: publishedHead, remote_task_branch_sha: remoteTaskBranchSha, worktree_clean: true,
    }, null, 2));
  } finally {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});
