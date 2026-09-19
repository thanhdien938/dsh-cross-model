// P24.1G6A — dynamic per-task fresh base pinning (reports/
// P24_1G6_PER_TASK_FRESH_BASE_PINNING_ARCHITECTURE_20260916.md; this
// phase's own reports/P24_1G6A_DYNAMIC_PER_TASK_FRESH_BASE_PINNING_
// IMPLEMENTATION_20260916.md).
//
// Real disposable git fixtures throughout (never a mocked Git primitive
// for the admission-authority assertions themselves) — the whole point of
// this phase is that admission observes REAL remote state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { admitTaskGitBinding, BaseAdmissionError, GIT_ADMISSION_STATE } from '../src/pm/task-base-admission.mjs';
import { prepareTaskBranch, restoreOriginalBranch, TaskBranchLifecycleError } from '../src/pm/task-branch-binding.mjs';
import { verifyBaseIsAncestor } from '../src/pm/git-settlement-journal.mjs';
import { createWorkspaceAdmissionLock } from '../src/runtime/workspace-admission-lock.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim(); }

function initRepo(root, name) {
  const bareDir = join(root, `${name}-origin.git`);
  const workDir = join(root, `${name}-work`);
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
function advance(workDir, text) {
  writeFileSync(join(workDir, 'CHANGE.md'), `${text}\n`);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', text]);
  git(workDir, ['push', '-q', 'origin', 'main']);
  return git(workDir, ['rev-parse', 'HEAD']);
}
// A separate "advance" clone lets main move WITHOUT touching the task's
// own checked-out worktree — closer to what a real second contributor
// pushing to the same repo looks like than mutating the same worktree the
// task's own branch was created in.
function advanceViaClone(root, name, bareDir, text) {
  const cloneDir = mkdtempSync(join(root, `${name}-advancer-`));
  git(cloneDir, ['clone', '-q', bareDir, '.']);
  // git config is per-repository, never inherited through `git clone` — a
  // fresh CI runner has no global user.name/user.email, so this clone
  // needs its own identity before it can commit, same as initRepo()'s
  // workDir already sets up.
  git(cloneDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(cloneDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(cloneDir, 'CHANGE.md'), `${text}\n`);
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-q', '-m', text]);
  git(cloneDir, ['push', '-q', 'origin', 'main']);
  const sha = git(cloneDir, ['rev-parse', 'HEAD']);
  rmSync(cloneDir, { recursive: true, force: true });
  return sha;
}

function fakeJournal() {
  const rows = new Map();
  return {
    getGitAdmission(taskId) {
      const row = rows.get(taskId);
      return row ? { record: row.record, revision: row.revision } : { record: null, revision: 0 };
    },
    upsertGitAdmission(taskId, { expectedRevision, record }) {
      const row = rows.get(taskId);
      const currentRevision = row ? row.revision : 0;
      if (currentRevision !== expectedRevision) { const e = new Error('stale'); e.code = 'ADMISSION_RECOVERY_CONFLICT'; throw e; }
      const nextRevision = currentRevision + 1;
      rows.set(taskId, { record, revision: nextRevision });
      return { record, revision: nextRevision };
    },
    _rows: rows,
  };
}

async function withDisposableRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p24-1g6a-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// §31 items 1-6 — dynamic pinning across sequential/independent tasks
// ---------------------------------------------------------------------------

test('dynamic project: NEW task pins the current base with no project SHA configured at all', async () => withDisposableRoot(async (root) => {
  const { workDir } = initRepo(root, 'r1');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const binding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-1', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(binding.base_sha, git(workDir, ['rev-parse', 'origin/main']));
}));

test('base A->B, new task pins B; T1 (pinned A, base moves to B) still settles on A — no drift error', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'r2');
  const journal = fakeJournal();
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const bindingT1 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-t1', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(bindingT1.base_sha, a);
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: bindingT1 });

  const b = advanceViaClone(root, 'r2', bareDir, 'B');
  const bindingT2 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-t2', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(bindingT2.base_sha, b, 'T2 pins the NEW current base, independently of T1');
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: bindingT2 });

  // T1 still settles on its own pin A — its own commit + push must succeed
  // even though `main` has since moved past it.
  await prepareTaskBranch({ projectRepoPath: workDir, taskId: 'task-t1', pinnedBaseSha: a }); // replay/checkout back onto T1's branch
  writeFileSync(join(workDir, 'T1-RESULT.md'), 'done\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'T1 result']);
  const r1 = git(workDir, ['rev-parse', 'HEAD']);
  git(workDir, ['push', '-q', 'origin', bindingT1.task_branch]);
  assert.equal(git(workDir, ['ls-remote', bareDir, bindingT1.task_branch]).split(/\s+/)[0], r1);
  assert.ok(await verifyBaseIsAncestor({ projectRepoPath: workDir, ancestorSha: a, descendantSha: r1 }));
}));

test('rapidly moving base A->B->C: three tasks each independently pin their own observation and can settle in ANY order', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'r3');
  const journal = fakeJournal();
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const t1 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-c1', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: t1 });
  const b = advanceViaClone(root, 'r3', bareDir, 'B');
  const t2 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-c2', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: t2 });
  const c = advanceViaClone(root, 'r3', bareDir, 'C');
  const t3 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-c3', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: t3 });

  assert.equal(t1.base_sha, a); assert.equal(t2.base_sha, b); assert.equal(t3.base_sha, c);

  // Complete in arbitrary order: T2, T1, T3.
  for (const [binding, label] of [[t2, 'T2'], [t1, 'T1'], [t3, 'T3']]) {
    await prepareTaskBranch({ projectRepoPath: workDir, taskId: binding.task_id, pinnedBaseSha: binding.base_sha });
    writeFileSync(join(workDir, `${label}.md`), `${label} result\n`);
    git(workDir, ['add', '-A']); git(workDir, ['commit', '-q', '-m', `${label} result`]);
    const sha = git(workDir, ['rev-parse', 'HEAD']);
    git(workDir, ['push', '-q', 'origin', binding.task_branch]);
    assert.equal(git(workDir, ['ls-remote', bareDir, binding.task_branch]).split(/\s+/)[0], sha, `${label} pushes only its own task branch`);
    await restoreOriginalBranch({ projectRepoPath: workDir, binding });
  }
  // main itself was never touched by any task settlement.
  assert.equal(git(workDir, ['ls-remote', bareDir, 'main']).split(/\s+/)[0], c);
}));

// ---------------------------------------------------------------------------
// §31 items 10-12 — orphan branch, deleted remote base
// ---------------------------------------------------------------------------

test('orphan branch without durable binding: fails closed rather than inferring a base from current topology', async () => withDisposableRoot(async (root) => {
  const { workDir } = initRepo(root, 'r4');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  // Simulate a task branch that exists (e.g. from a prior, non-journaled
  // run, or hand-created) with NO admission journal record at all.
  git(workDir, ['checkout', '-q', '-b', 'dsh/task-task-orphan']);
  git(workDir, ['checkout', '-q', 'main']);
  await assert.rejects(
    () => admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-orphan', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' }),
    (e) => e instanceof BaseAdmissionError && e.code === 'TASK_BASE_ORPHANED',
  );
}));

test('deleted remote base ref with a stale local tracking ref: admission fails closed, never trusts the cached ref', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'r5');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  // Cache a local `origin/main` remote-tracking ref FIRST (an ordinary
  // fetch, exactly what a real worker would already have done at some
  // earlier point). The branch is then deleted on the remote from a
  // SEPARATE clone (never from `workDir` itself — Git proactively prunes
  // a repo's OWN remote-tracking ref when THAT repo is the one issuing
  // `push --delete`, which would defeat the staleness this test needs) —
  // reproducing the exact "stale cached branch, deleted remote" scenario
  // the G6 audit demonstrated as a live gap: `workDir`'s own cached
  // tracking ref has no reason to know the branch is gone.
  git(workDir, ['fetch', 'origin']);
  assert.ok(git(workDir, ['rev-parse', 'refs/remotes/origin/main']).length > 0, 'the stale local tracking ref still resolves (this is the trap)');
  git(bareDir, ['symbolic-ref', 'HEAD', 'refs/heads/keepalive']); // move the bare repo's own HEAD off main so it can be deleted
  const deleterClone = mkdtempSync(join(root, 'r5-deleter-'));
  git(deleterClone, ['clone', '-q', bareDir, '.']);
  git(deleterClone, ['push', '-q', 'origin', '--delete', 'main']);
  rmSync(deleterClone, { recursive: true, force: true });
  assert.ok(git(workDir, ['rev-parse', 'refs/remotes/origin/main']).length > 0, 'the stale local tracking ref in workDir STILL resolves even after remote deletion (no prune happened there)');

  await assert.rejects(
    () => admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-deleted-base', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin', }),
    (e) => e instanceof BaseAdmissionError && (e.code === 'BASE_REF_NOT_FOUND' || e.code === 'BASE_FETCH_FAILED'),
  );
}));

// ---------------------------------------------------------------------------
// §31 items 14-19 — caller CAS + project pinned policy
// ---------------------------------------------------------------------------

test('dynamic project + matching caller CAS: PASS and pins exactly that SHA', async () => withDisposableRoot(async (root) => {
  const { workDir } = initRepo(root, 'r6');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const binding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-cas-ok', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin', callerExpectedBaseSha: a });
  assert.equal(binding.base_sha, a);
}));

test('dynamic project + stale caller CAS after base advanced: reject before any branch mutation', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'r7');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  advanceViaClone(root, 'r7', bareDir, 'B');
  await assert.rejects(
    () => admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-cas-stale', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin', callerExpectedBaseSha: a }),
    (e) => e instanceof BaseAdmissionError && e.code === 'CALLER_EXPECTED_BASE_SHA_DRIFT',
  );
  assert.equal(git(workDir, ['branch', '--list', 'dsh/task-task-cas-stale']), '', 'no branch was created for the rejected admission');
}));

test('pinned project: matching expected SHA -> PASS; drift -> reject', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'r8');
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const pinnedProject = { repo_path: workDir, git_base_policy: 'pinned', git_base_branch: 'main', git_base_sha: a };
  const binding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-pin-ok', projectId: 'p', taskMode: 'SINGLE', project: pinnedProject, remote: 'origin' });
  assert.equal(binding.base_sha, a);
  await restoreOriginalBranch({ projectRepoPath: workDir, binding });

  advanceViaClone(root, 'r8', bareDir, 'B');
  await assert.rejects(
    () => admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-pin-drift', projectId: 'p', taskMode: 'SINGLE', project: pinnedProject, remote: 'origin' }),
    (e) => e instanceof BaseAdmissionError && e.code === 'PROJECT_PIN_BASE_SHA_DRIFT',
  );
}));

test('pinned project + caller CAS agreeing: PASS; contradictory: reject before mutation', async () => withDisposableRoot(async (root) => {
  const { workDir } = initRepo(root, 'r9');
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const pinnedProject = { repo_path: workDir, git_base_policy: 'pinned', git_base_branch: 'main', git_base_sha: a };
  const okBinding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-pin-cas-ok', projectId: 'p', taskMode: 'SINGLE', project: pinnedProject, remote: 'origin', callerExpectedBaseSha: a });
  assert.equal(okBinding.base_sha, a);

  await assert.rejects(
    () => admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-pin-cas-bad', projectId: 'p', taskMode: 'SINGLE', project: pinnedProject, remote: 'origin', callerExpectedBaseSha: 'f'.repeat(40) }),
    (e) => e instanceof BaseAdmissionError && e.code === 'BASE_POLICY_CONFLICT',
  );
  // Contradiction was rejected before any fetch/branch mutation was even attempted.
  assert.equal(git(workDir, ['branch', '--list', 'dsh/task-task-pin-cas-bad']), '');
}));

// ---------------------------------------------------------------------------
// §31 item 21 — independent repos, no cross-project authority leakage
// ---------------------------------------------------------------------------

test('repo A / repo B are fully independent: advancing A never affects B, and each pins its own observation', async () => withDisposableRoot(async (root) => {
  const a = initRepo(root, 'repoA');
  const b = initRepo(root, 'repoB');
  const journal = fakeJournal();
  const projectA = { repo_path: a.workDir, git_base_policy: 'dynamic', git_base_branch: 'main' };
  const projectB = { repo_path: b.workDir, git_base_policy: 'dynamic', git_base_branch: 'main' };

  const a1 = git(a.workDir, ['rev-parse', 'HEAD']);
  const b1 = git(b.workDir, ['rev-parse', 'HEAD']);
  const taskA = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-a-repo', projectId: 'repo-a', taskMode: 'SINGLE', project: projectA, remote: 'origin' });
  const taskB = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-b-repo', projectId: 'repo-b', taskMode: 'SINGLE', project: projectB, remote: 'origin' });
  assert.equal(taskA.base_sha, a1); assert.equal(taskB.base_sha, b1);
  await restoreOriginalBranch({ projectRepoPath: a.workDir, binding: taskA });
  await restoreOriginalBranch({ projectRepoPath: b.workDir, binding: taskB });

  const a2 = advanceViaClone(root, 'repoA', a.bareDir, 'A-advance');
  const taskA2 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-a-repo-2', projectId: 'repo-a', taskMode: 'SINGLE', project: projectA, remote: 'origin' });
  assert.equal(taskA2.base_sha, a2, 'repo A observes its own advance');
  assert.equal(git(b.workDir, ['rev-parse', 'HEAD']), b1, 'repo B is completely untouched by repo A advancing');

  const taskB2 = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-b-repo-2', projectId: 'repo-b', taskMode: 'SINGLE', project: projectB, remote: 'origin' });
  assert.equal(taskB2.base_sha, b1, 'repo B, never advanced, still pins its own unchanged tip — never repo A\'s SHA');
}));

// ---------------------------------------------------------------------------
// §31 item 22 — DSH self-repo: identical semantics, no special-casing
// ---------------------------------------------------------------------------

test('DSH self-repo (a project whose repo_path happens to be a DSH-style checkout) behaves EXACTLY like any external project', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'dsh-self');
  // A DSH-style repo layout (docs/, src/ dirs) — the point is that
  // admitTaskGitBinding() never inspects the repository's CONTENT or
  // name, only its repo_path/remote, so this needs no special fixture at
  // all beyond an ordinary repo.
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'index.mjs'), '// dsh-like\n');
  git(workDir, ['add', '-A']); git(workDir, ['commit', '-q', '-m', 'dsh-like layout']); git(workDir, ['push', '-q', 'origin', 'main']);
  const project = { repo_path: workDir, git_base_policy: 'dynamic', git_base_branch: 'main' };
  const before = git(workDir, ['rev-parse', 'HEAD']);
  const binding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-dsh-self', projectId: 'dsh-cross-model-debate-poc', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(binding.base_sha, before);
  await restoreOriginalBranch({ projectRepoPath: workDir, binding });

  // Promoting "canonical" (advancing main) requires NO project SHA update
  // at all — this is the exact G5 incident this phase closes.
  const promoted = advanceViaClone(root, 'dsh-self', bareDir, 'promotion');
  const nextTask = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-dsh-self-2', projectId: 'dsh-cross-model-debate-poc', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(nextTask.base_sha, promoted, 'the NEXT task observes the promoted canonical HEAD with zero config edits');
}));

// ---------------------------------------------------------------------------
// §31 item 25/26 — ancestry + base-moved-does-not-block-settlement
// ---------------------------------------------------------------------------

test('task base is an ancestor of the result commit; a moved current base never causes settlement rejection', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'anc');
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  const binding = await admitTaskGitBinding({ taskRepository: fakeJournal(), taskId: 'task-anc', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  writeFileSync(join(workDir, 'RESULT.md'), 'done\n');
  git(workDir, ['add', '-A']); git(workDir, ['commit', '-q', '-m', 'result']);
  const result = git(workDir, ['rev-parse', 'HEAD']);
  assert.ok(await verifyBaseIsAncestor({ projectRepoPath: workDir, ancestorSha: a, descendantSha: result }));
  await restoreOriginalBranch({ projectRepoPath: workDir, binding });

  // main moves AFTER this task's own commit — ancestry against the task's
  // OWN pin is unaffected; there is no rejection of any kind tied to that
  // movement.
  advanceViaClone(root, 'anc', bareDir, 'unrelated-later-advance');
  assert.ok(await verifyBaseIsAncestor({ projectRepoPath: workDir, ancestorSha: a, descendantSha: result }), 'ancestry against the task\'s OWN pin is unaffected by later base movement');
}));

// ---------------------------------------------------------------------------
// Crash-recovery replay (§13 CASE B/C/D), via a shared fake journal
// ---------------------------------------------------------------------------

test('CASE B: base already durably observed (crash before branch creation) — recovery reuses it, never re-resolves', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'crashb');
  const journal = fakeJournal();
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const a = git(workDir, ['rev-parse', 'HEAD']);
  // Simulate CASE B by pre-seeding the journal at BASE_OBSERVED (as if a
  // prior call resolved A and journaled it, then crashed before ever
  // creating the branch) — the base then genuinely moves before recovery.
  journal.upsertGitAdmission('task-crash-b', { expectedRevision: 0, record: { task_id: 'task-crash-b', project_id: 'p', repo_path: workDir, workspace_id: null, effective_remote: 'origin', base_branch: 'main', base_policy: 'dynamic', project_expected_sha: null, caller_expected_sha: null, observed_base_sha: a, task_branch: 'dsh/task-task-crash-b', state: GIT_ADMISSION_STATE.BASE_OBSERVED, error_code: null, updated_at: new Date().toISOString() } });
  advanceViaClone(root, 'crashb', bareDir, 'moved-after-observation');

  const binding = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-crash-b', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(binding.base_sha, a, 'recovery reused the ALREADY-observed A, never re-resolving to the moved base');
}));

test('CASE D: task already ADMITTED at S; base moves to S2; replay keeps S, never re-derives', async () => withDisposableRoot(async (root) => {
  const { workDir, bareDir } = initRepo(root, 'crashd');
  const journal = fakeJournal();
  const project = { repo_path: workDir, git_base_policy: 'dynamic' };
  const first = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-crash-d', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  await restoreOriginalBranch({ projectRepoPath: workDir, binding: first });
  advanceViaClone(root, 'crashd', bareDir, 'moved-after-admission');

  const replay = await admitTaskGitBinding({ taskRepository: journal, taskId: 'task-crash-d', projectId: 'p', taskMode: 'SINGLE', project, remote: 'origin' });
  assert.equal(replay.base_sha, first.base_sha, 'replay of an ADMITTED task never re-resolves, regardless of base movement');
}));

// ---------------------------------------------------------------------------
// §31 items 23/24 — same-workspace admission fencing; different workspaces parallel
// ---------------------------------------------------------------------------

test('same physical workspace: two concurrent admission attempts are serialized, never interleaved', async () => {
  const lock = createWorkspaceAdmissionLock();
  const order = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: () => {} }, startPm: async () => null, workspaceAdmissionLock: lock,
    admitTaskGitBinding: async (args) => {
      order.push(`${args.taskId}:enter`);
      await new Promise((r) => setTimeout(r, 30)); // simulate real admission's own await points (fetch/resolve)
      order.push(`${args.taskId}:exit`);
      return {};
    },
  });
  const project = { id: 'shared-proj', repo_path: 'C:/shared-repo', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'APPROVAL' } } };
  const submitOne = (commandId) => controller.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'x', git: { commit: true } } }, project, profile: { id: 'pm-1' } });

  await Promise.all([submitOne('cmd-race-1'), submitOne('cmd-race-2')]);
  const id1 = deterministicOwnerId('task', 'cmd-race-1'), id2 = deterministicOwnerId('task', 'cmd-race-2');
  // Whichever task acquired the lock FIRST must fully exit before the
  // other one ever enters — never `id1:enter, id2:enter, id1:exit, id2:exit`.
  const firstEnterIndex = order.indexOf(`${order[0].split(':')[0]}:enter`);
  const firstTaskId = order[0].split(':')[0];
  const secondTaskId = firstTaskId === id1 ? id2 : id1;
  assert.deepEqual(order, [`${firstTaskId}:enter`, `${firstTaskId}:exit`, `${secondTaskId}:enter`, `${secondTaskId}:exit`], `admission was serialized, never interleaved: ${order.join(',')}`);
  void firstEnterIndex;
});

test('different physical workspaces remain fully parallel under the SAME lock instance', async () => {
  const lock = createWorkspaceAdmissionLock();
  const order = [];
  const controller = new OwnerTaskController({
    repository: { createOwnerTask: () => {} }, startPm: async () => null, workspaceAdmissionLock: lock,
    admitTaskGitBinding: async (args) => {
      order.push(`${args.taskId}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${args.taskId}:exit`);
      return {};
    },
  });
  const projectA = { id: 'proj-a', repo_path: 'C:/repo-a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'APPROVAL' } } };
  const projectB = { id: 'proj-b', repo_path: 'C:/repo-b', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', BRANCH_CREATE: 'APPROVAL' } } };
  const submit = (commandId, project) => controller.submit({ command: { command_id: commandId, client_kind: 'LOCAL', payload: { body: 'x', git: { commit: true } } }, project, profile: { id: 'pm-1' } });

  await Promise.all([submit('cmd-par-a', projectA), submit('cmd-par-b', projectB)]);
  const idA = deterministicOwnerId('task', 'cmd-par-a'), idB = deterministicOwnerId('task', 'cmd-par-b');
  // Different workspaces -> both ENTER before either EXITs (true overlap),
  // proving the lock did not serialize them.
  const enterA = order.indexOf(`${idA}:enter`), enterB = order.indexOf(`${idB}:enter`);
  const exitA = order.indexOf(`${idA}:exit`), exitB = order.indexOf(`${idB}:exit`);
  assert.ok(enterA < exitB && enterB < exitA, `expected real overlap across different workspaces, got: ${order.join(',')}`);
});
