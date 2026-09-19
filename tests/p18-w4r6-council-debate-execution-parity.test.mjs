import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeCouncilSpec, CouncilValidationError, COUNCIL_STEP_KINDS,
} from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import {
  prepareTaskBranch, verifyBoundBranch, assertTaskBranchPublishable, TaskBranchLifecycleError,
} from '../src/pm/task-branch-binding.mjs';
import { resolveExecutionOptions, EXECUTION_STAGE, PM_PERMISSION_MODE } from '../src/pm/pm-execution-timeout-policy.mjs';

// P18-W4R6 — COUNCIL/DEBATE execution-mode parity. W4R3 established the
// role-derived Claude permission-mode mechanism (resolveExecutionOptions())
// and left every council stepKind at its byte-for-byte default (`plan`) —
// "none of the four known council stepKinds are implementation steps today;
// the SAME mechanism is available the moment one is" (pm-execution-timeout-
// policy.mjs's own docstring). This wave adds the ONE typed, owner-selected
// signal (CouncilSpec.implementation_participant_id) that opts a single
// participant's own `participant_report` step into `bypassPermissions` —
// never a stepKind guess, never prompt text, never "everyone" — and proves
// it end to end against real local-git fixtures (never the live dsh-p6-
// test-b workspace), reusing the exact SAME W4R5-verified task-branch
// primitive without any change to it.
//
// DEBATE has no separate top-level dispatch path: P19 added it as the
// `council.debate` extension on this exact CouncilChairDriver/
// CouncilStepWorkflowRunner primitive. P19-D5 therefore selects the same
// W4R6 participant_report implementation turn; all later Debate-round steps
// remain analysis-only.

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function initWorktreeWithBareRemote(root, { branch = 'main' } = {}) {
  const bareDir = join(root, 'origin.git');
  const workDir = join(root, 'work');
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '-q', '--bare', '-b', branch]);
  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', branch]);
  git(workDir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(workDir, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', branch]);
  return { bareDir, workDir };
}

/** Pushes a second branch (`feature/other`) to the bare remote with distinct content — the "another repository ref" a participant must be able to read. */
function pushOtherBranch(root, bareDir) {
  const otherClone = join(root, 'other-clone');
  git(root, ['clone', '-q', bareDir, otherClone]);
  git(otherClone, ['checkout', '-q', '-b', 'feature/other']);
  git(otherClone, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(otherClone, ['config', 'user.name', 'DSH Test']);
  writeFileSync(join(otherClone, 'OTHER.md'), 'other branch content\n');
  git(otherClone, ['add', '-A']);
  git(otherClone, ['commit', '-q', '-m', 'other branch commit']);
  git(otherClone, ['push', '-q', 'origin', 'feature/other']);
}

// A plain, standalone fixture check — deliberately NOT `node:test`-based:
// this file is itself run under `node --test`, and a nested `node --test`
// subprocess would inherit Node's own test-runner recursion guard and
// silently skip ("run() is being called recursively within a test file"),
// producing empty output rather than a real result. A plain script that
// asserts and prints a pass marker (or throws, non-zero exit) is a genuine,
// real, bounded subprocess test run — exactly what a `bypassPermissions`
// Claude turn running `node fixture.council.check.mjs` would do.
const FIXTURE_CHECK_SOURCE = `import assert from 'node:assert/strict';
assert.equal(1 + 1, 2);
console.log('FIXTURE_TEST_PASS');
`;
const FIXTURE_TEST_PASS_RE = /FIXTURE_TEST_PASS/;

async function withPmRepository(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p18-w4r6-sqlite-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    await fn(new PmRepository({ store }));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A production-shaped resolveDriver: every call is recorded (profileId,
 * stepKind, the resolved executionOptions.permissionMode, and the
 * project.repo_path it was resolved against). ONLY the step matching
 * `{stepKind: 'participant_report', profileId: implementationParticipantId}`
 * AND observing `permissionMode === 'bypassPermissions'` performs real
 * filesystem/process side effects in `workDir` — simulating exactly what a
 * real Claude Code `bypassPermissions` turn is empirically verified (W4R3)
 * to be able to do inside its own turn: read another repository ref, write
 * a fixture file, and run a fixture test. Every other step returns a plain
 * canned decision and touches nothing on disk.
 */
function makeCouncilFixtureDriver({ workDir, implementationParticipantId }) {
  const calls = [];
  let implementationRan = false;
  let fixtureTestOutput = null;
  const resolveDriver = (profile, context) => {
    calls.push({
      profileId: profile.id,
      stepKind: context.extraCtx?.stepKind ?? null,
      permissionMode: context.executionOptions?.permissionMode ?? null,
      repoPath: context.project?.repo_path ?? null,
    });
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        const participantId = input.request.context.profileId;
        if (stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN) {
          const ids = input.request.context.participantProfileIds ?? [];
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: Object.fromEntries(ids.map((id) => [id, `focus for ${id}`])), critique_focus: 'be harsh', synthesis_focus: 'be concise' } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT) {
          if (participantId === implementationParticipantId && context.executionOptions?.permissionMode === 'bypassPermissions') {
            // Repository-wide read: another branch's content, not this
            // task's own bound branch, not its base.
            const otherRefContent = git(workDir, ['show', 'origin/feature/other:OTHER.md']).trim();
            // Write a fixture file (a real repo edit, inside this one turn).
            writeFileSync(join(workDir, 'FIXTURE_IMPLEMENTED.md'), `implemented by ${participantId}\nread-other-ref: ${otherRefContent}\n`);
            writeFileSync(join(workDir, 'fixture.council.check.mjs'), FIXTURE_CHECK_SOURCE);
            // Run a fixture test (a real, bounded, throwaway subprocess).
            fixtureTestOutput = execFileSync(process.execPath, ['fixture.council.check.mjs'], { cwd: workDir, encoding: 'utf8' });
            implementationRan = true;
            return { type: 'finish', output: `${participantId} implemented and verified`, data: { type: 'council_report', analysis: `wrote FIXTURE_IMPLEMENTED.md; fixture test passed=${FIXTURE_TEST_PASS_RE.test(fixtureTestOutput)}; other-ref=${otherRefContent}`, recommendation: 'ship it', risks: [], uncertainties: [] } };
          }
          return { type: 'finish', output: `${participantId} report`, data: { type: 'council_report', analysis: `${participantId} analysis`, recommendation: `${participantId} rec`, risks: ['r1'], uncertainties: ['u1'] } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE) {
          return { type: 'finish', output: `${participantId} critique`, data: { type: 'council_critique', criticisms: ['c1'], agreements: ['a1'], revised_recommendation: `${participantId} revised`, remaining_disagreements: [] } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS) {
          return { type: 'finish', output: 'council synthesis', data: { type: 'council_synthesis' } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.DEBATE_BRIEF) {
          return { type: 'finish', output: 'debate brief ready', data: { type: 'debate_brief', brief: 'challenge the implementation evidence' } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.DEBATE_RESPONSE) {
          return { type: 'finish', output: `${participantId} debate response`, data: { type: 'debate_response', response: `${participantId} analysis-only response` } };
        }
        if (stepKind === COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS) {
          return { type: 'finish', output: 'final debate synthesis', data: { type: 'debate_synthesis', continue_debate: false, reason: 'resolved', unresolved_questions: [] } };
        }
        throw new Error(`unexpected fixture step: ${stepKind}`);
      },
    };
  };
  return { resolveDriver, calls, implementationRan: () => implementationRan, fixtureTestOutput: () => fixtureTestOutput };
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

async function runCouncilFixture({ repository, gitRoot, participantIds, implementationParticipantId, rounds, taskId, debate = undefined }) {
  const { bareDir, workDir } = initWorktreeWithBareRemote(gitRoot);
  pushOtherBranch(gitRoot, bareDir);

  const branchesBeforePrepare = git(workDir, ['branch', '--list']).trim();
  const binding = await prepareTaskBranch({ projectRepoPath: workDir, taskId, taskMode: 'COUNCIL' });
  assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch);

  const project = { id: 'proj-w4r6', repo_path: workDir };
  const council = normalizeCouncilSpec({
    chair_profile_id: 'chair', participant_profile_ids: participantIds, rounds, implementation_participant_id: implementationParticipantId, ...(debate ? { debate } : {}),
  });
  const { resolveDriver, calls, implementationRan, fixtureTestOutput } = makeCouncilFixtureDriver({ workDir, implementationParticipantId });
  const workflowRunner = new CouncilStepWorkflowRunner({
    resolveDriver, profileRegistry: fakeProfileRegistry(['chair', ...participantIds]), project,
    extraCtx: (spec) => ({ stepKind: spec.stepKind, round: spec.round }),
  });
  const peerRelay = { async exchange() { throw new Error('council never uses peer_exchange'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  const driver = new CouncilChairDriver({ council, ownerTask: 'Add a tiny fixture and prove it is tested.' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 20 });

  const request = createPmRequest({ objective: 'Add a tiny fixture and prove it is tested.', context: { ownerCommandId: `cmd-${taskId}`, council } });
  await repository.create(request, { id: `pmrun-${taskId}`, driver: driver.name, startedAt: '2026-01-01T00:00:00.000Z' });
  const result = await runtime.resume(`pmrun-${taskId}`);

  return { result, binding, workDir, bareDir, calls, implementationRan, fixtureTestOutput, branchesBeforePrepare };
}

// ---- fail-closed: unknown / invalid implementation_participant_id --------

test('normalizeCouncilSpec: implementation_participant_id omitted -> null, byte-for-byte unaffected', () => {
  const spec = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'] });
  assert.equal(spec.implementation_participant_id, null);
});

test('normalizeCouncilSpec: implementation_participant_id fails closed when it is not one of THIS council\'s own participants', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], implementation_participant_id: 'p3-not-a-member' }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_UNKNOWN_IMPLEMENTATION_PARTICIPANT',
  );
});

test('normalizeCouncilSpec: implementation_participant_id fails closed on a malformed value — never silently ignored', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], implementation_participant_id: '' }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_PROFILE_ID',
  );
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], implementation_participant_id: 42 }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_PROFILE_ID',
  );
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], implementation_participant_id: ['p1', 'p2'] }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_INVALID_PROFILE_ID',
    'two implementation participants cannot be represented by the scalar contract',
  );
});

test('normalizeCouncilSpec: the chair is never implicitly the implementation participant — chair id supplied but not a participant fails closed', () => {
  assert.throws(
    () => normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], implementation_participant_id: 'chair' }),
    (e) => e instanceof CouncilValidationError && e.code === 'COUNCIL_UNKNOWN_IMPLEMENTATION_PARTICIPANT',
  );
});

// ---- SINGLE: reaffirm the pre-existing W4R3 parity (planning vs worker) --

test('SINGLE: planning stage stays plan by default; the SAME stage explicitly opted in is execution-capable — the mechanism COUNCIL/DEBATE now reuse', () => {
  assert.equal(resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE).permissionMode, PM_PERMISSION_MODE.PLAN);
  assert.equal(resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE, { executionCapable: true }).permissionMode, PM_PERMISSION_MODE.EXECUTE);
});

// ---- COUNCIL end-to-end: real git fixture, real orchestration loop -------

test('COUNCIL end-to-end (real git fixture): chair/critique stay plan, only the designated implementation participant runs bypassPermissions and can write a fixture file + run a fixture test, every step shares the SAME bound task branch, no new branch is ever created, repository-wide read works, and only the bound branch can ever be published', async () => withPmRepository(async (repository) => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p18-w4r6-council-git-'));
  try {
    const { result, binding, workDir, bareDir, calls, implementationRan, fixtureTestOutput, branchesBeforePrepare } = await runCouncilFixture({
      repository, gitRoot, participantIds: ['p1', 'impl'], implementationParticipantId: 'impl', rounds: 1, taskId: 'task-w4r6-council-1',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.data.type, 'council');
    assert.deepEqual(result.data.completed_participants, ['p1', 'impl']);

    // ---- permission-mode parity per step -------------------------------
    const byRole = Object.fromEntries(calls.map((c, i) => [`${i}`, c]));
    void byRole;
    const chairPlanCall = calls.find((c) => c.profileId === 'chair');
    assert.equal(chairPlanCall.permissionMode, 'plan', 'chair_plan must stay plan');
    const p1ReportCall = calls.filter((c) => c.profileId === 'p1')[0];
    assert.equal(p1ReportCall.permissionMode, 'plan', 'non-designated participant report must stay plan');
    const implReportCall = calls.filter((c) => c.profileId === 'impl')[0];
    assert.equal(implReportCall.permissionMode, 'bypassPermissions', 'the designated implementation participant must be execution-capable');
    // chair_synthesis is the LAST call to profileId 'chair'.
    const chairCalls = calls.filter((c) => c.profileId === 'chair');
    assert.equal(chairCalls[chairCalls.length - 1].permissionMode, 'plan', 'chair_synthesis must stay plan');

    // ---- the fixture file was actually created and the fixture test actually ran ----
    assert.equal(implementationRan(), true);
    assert.equal(existsSync(join(workDir, 'FIXTURE_IMPLEMENTED.md')), true);
    assert.match(readFileSync(join(workDir, 'FIXTURE_IMPLEMENTED.md'), 'utf8'), /implemented by impl/);
    assert.match(fixtureTestOutput(), FIXTURE_TEST_PASS_RE, 'the fixture test genuinely ran and passed');
    // Repository-wide read: the content read came from the OTHER branch, not this task's own branch.
    assert.match(readFileSync(join(workDir, 'FIXTURE_IMPLEMENTED.md'), 'utf8'), /read-other-ref: other branch content/);

    // ---- every participant/chair turn shares the SAME task-branch binding ----
    for (const call of calls) assert.equal(call.repoPath, workDir, 'every step must resolve against the SAME bound task workspace');
    await verifyBoundBranch({ projectRepoPath: workDir, binding, stage: 'POST_COUNCIL' }); // throws on any drift

    // ---- no participant ever created its own branch -----------------------
    const branchesAfter = git(workDir, ['branch', '--list']).trim();
    const dshBranchesAfter = branchesAfter.split('\n').map((l) => l.replace(/^\*?\s*/, '').trim()).filter((b) => b.startsWith('dsh/task-'));
    assert.deepEqual(dshBranchesAfter, [binding.task_branch], 'exactly one dsh/task-* branch exists — no participant-specific branch was created');
    assert.notEqual(branchesBeforePrepare, branchesAfter); // sanity: prepareTaskBranch itself did add the one expected branch

    // ---- final publication remains the one bound task branch --------------
    assert.equal(assertTaskBranchPublishable({ binding, requestedBranch: binding.task_branch, requestedRemote: binding.remote }), true);

    // ---- no participant can publish an arbitrary branch --------------------
    assert.throws(
      () => assertTaskBranchPublishable({ binding, requestedBranch: 'dsh/task-some-other-task', requestedRemote: binding.remote }),
      (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_VIOLATION',
    );
    assert.throws(
      () => assertTaskBranchPublishable({ binding, requestedBranch: `dsh/task-w4r6-council-1-impl-private`, requestedRemote: binding.remote }),
      (e) => e instanceof TaskBranchLifecycleError && e.code === 'TASK_BRANCH_BINDING_VIOLATION',
      'a participant-specific branch name is refused exactly like any other foreign branch',
    );
    void bareDir;
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
}));

// ---- P19-D5: actual Council + Debate extension, same W4R6 turn -----------

test('P19-D5 actual Debate extension: only selected participant report executes; every Debate round is plan; all turns use the one bound task branch', async () => withPmRepository(async (repository) => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p19-d5-debate-git-'));
  try {
    const { result, binding, workDir, calls, implementationRan, fixtureTestOutput } = await runCouncilFixture({
      repository, gitRoot, participantIds: ['analyst', 'implementer'], implementationParticipantId: 'implementer', rounds: 2,
      debate: { enabled: true, max_rounds: 1 }, taskId: 'task-p19-d5-debate-1',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.data.type, 'council_debate');
    assert.equal(implementationRan(), true);
    assert.match(fixtureTestOutput(), FIXTURE_TEST_PASS_RE);
    assert.match(readFileSync(join(workDir, 'FIXTURE_IMPLEMENTED.md'), 'utf8'), /implemented by implementer/);

    const executableCalls = calls.filter((call) => call.permissionMode === PM_PERMISSION_MODE.EXECUTE);
    assert.deepEqual(executableCalls.map(({ profileId, stepKind }) => ({ profileId, stepKind })), [
      { profileId: 'implementer', stepKind: COUNCIL_STEP_KINDS.PARTICIPANT_REPORT },
    ]);
    for (const call of calls.filter((c) => c.stepKind.startsWith('debate_'))) {
      assert.equal(call.permissionMode, PM_PERMISSION_MODE.PLAN, `${call.stepKind} must remain analysis-only`);
    }
    for (const call of calls) assert.equal(call.repoPath, workDir, 'all Council/Debate turns share the task-bound workspace');
    await verifyBoundBranch({ projectRepoPath: workDir, binding, stage: 'POST_DEBATE' });
    assert.equal(git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), binding.task_branch);
    assert.deepEqual(
      git(workDir, ['branch', '--format=%(refname:short)']).trim().split(/\r?\n/).filter((name) => name.startsWith('dsh/task-')),
      [binding.task_branch],
    );
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
}));

test('P19-D5 actual Debate extension without implementation_participant_id keeps every turn plan and writes nothing', async () => withPmRepository(async (repository) => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p19-d5-readonly-git-'));
  try {
    const { result, workDir, calls, implementationRan } = await runCouncilFixture({
      repository, gitRoot, participantIds: ['p1', 'p2'], implementationParticipantId: undefined, rounds: 1,
      debate: { enabled: true, max_rounds: 1 }, taskId: 'task-p19-d5-readonly-1',
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.data.type, 'council_debate');
    assert.equal(implementationRan(), false);
    assert.equal(existsSync(join(workDir, 'FIXTURE_IMPLEMENTED.md')), false);
    for (const call of calls) assert.equal(call.permissionMode, PM_PERMISSION_MODE.PLAN);
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
}));

// ---- DEBATE-shaped: same primitive, honestly labeled ----------------------

test('DEBATE-shaped (same primitive — no separate top-level DEBATE dispatch exists): reasoning-only critique participants stay plan; the designated implementation/finalizer participant can still write a fixture file and run tests; the SAME shared task-branch binding holds', async () => withPmRepository(async (repository) => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p18-w4r6-debate-git-'));
  try {
    // rounds:2 -> report + cross-critique + synthesis: the debate-shaped
    // flow (`independent_then_critique_then_synthesis` IS the only
    // multi-round reasoning strategy this codebase has — see file header).
    const { result, binding, workDir, calls, implementationRan, fixtureTestOutput } = await runCouncilFixture({
      repository, gitRoot, participantIds: ['reasoner', 'finalizer'], implementationParticipantId: 'finalizer', rounds: 2, taskId: 'task-w4r6-debate-1',
    });

    assert.equal(result.status, 'completed');

    const reasonerCalls = calls.filter((c) => c.profileId === 'reasoner');
    assert.ok(reasonerCalls.length >= 2, 'reasoner participates in both report and critique rounds');
    for (const call of reasonerCalls) assert.equal(call.permissionMode, 'plan', 'a reasoning-only participant must never be execution-capable');

    const finalizerReportCall = calls.filter((c) => c.profileId === 'finalizer')[0];
    assert.equal(finalizerReportCall.permissionMode, 'bypassPermissions', 'the designated implementation/finalizer participant must be execution-capable on its report step');
    // Its own critique-round turn (if reached) is NOT the designated
    // report step — critique is peer review, never implementation,
    // regardless of who is named.
    const finalizerCritiqueCall = calls.filter((c) => c.profileId === 'finalizer')[1];
    if (finalizerCritiqueCall) assert.equal(finalizerCritiqueCall.permissionMode, 'plan', 'critique is review, never implementation, even for the designated participant');

    assert.equal(implementationRan(), true);
    assert.equal(existsSync(join(workDir, 'FIXTURE_IMPLEMENTED.md')), true);
    assert.match(fixtureTestOutput(), FIXTURE_TEST_PASS_RE);

    for (const call of calls) assert.equal(call.repoPath, workDir);
    await verifyBoundBranch({ projectRepoPath: workDir, binding, stage: 'POST_DEBATE' });
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
}));
