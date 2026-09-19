import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { projectCouncil, COUNCIL_PHASES, DEBATE_STATUS, DEBATE_ROUND_PHASE } from '../src/pm/council/council-projection.mjs';
import { materializeTaskHistory, EXECUTION_LOG_VERSION } from '../src/runtime/repo-history-materializer.mjs';
import { buildDebateResponseFailureMarkdown, buildDebateReportMarkdown } from '../src/runtime/repo-history-content.mjs';

const PROJECT = Object.freeze({ id: 'proj-debate-history', repo_path: '/tmp/proj-debate-history' });

// =========================================================================
// Shared fixture machinery (same style as tests/council-debate.test.mjs).
// =========================================================================

function fakeResolveDriverFactory({ debateContinueByRound = {}, synthesisOutput = 'FINAL SYNTHESIS TEXT' } = {}) {
  const calls = [];
  const resolveDriver = (profile, context = {}) => {
    if (!context.project?.repo_path) throw new Error('resolveDriver requires project.repo_path');
    const round = context.extraCtx?.round;
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        calls.push({ profileId: profile.id, stepKind, round });
        if (stepKind === 'chair_plan') {
          const participantIds = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(participantIds.map((id) => [id, `focus ${id}`]));
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be harsh', synthesis_focus: 'be concise' } };
        }
        if (stepKind === 'participant_report') {
          return { type: 'finish', output: `${profile.id} summary`, data: { type: 'council_report', analysis: `${profile.id} analysis`, recommendation: `${profile.id} rec`, risks: ['r1'], uncertainties: ['u1'] } };
        }
        if (stepKind === 'chair_synthesis') {
          return { type: 'finish', output: synthesisOutput, data: { type: 'council_synthesis' } };
        }
        if (stepKind === 'debate_brief') {
          return { type: 'finish', output: 'brief ready', data: { type: 'debate_brief', brief: `ROUND ${round} CANONICAL BRIEF` } };
        }
        if (stepKind === 'debate_response') {
          return { type: 'finish', output: `${profile.id} round ${round} summary`, data: { type: 'debate_response', response: `${profile.id} response for round ${round}` } };
        }
        if (stepKind === 'debate_synthesis') {
          const continueDebate = debateContinueByRound[round] ?? false;
          return {
            type: 'finish', output: `DEBATE REPORT ROUND ${round}`,
            data: { type: 'debate_synthesis', continue_debate: continueDebate, reason: `round ${round} reason`, unresolved_questions: continueDebate ? [`unresolved after round ${round}`] : [] },
          };
        }
        throw new Error(`unexpected stepKind ${stepKind}`);
      },
    };
  };
  return { resolveDriver, calls };
}

function fakeProfileRegistry(ids) {
  return { get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id }; } };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-council-debate-history-'));
  const path = join(dir, 'council.db');
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate();
    await fn({ store, repository: new PmRepository({ store }) });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function actionsFor(resolveDriver, profileRegistry) {
  const workflowRunner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, extraCtx: (spec) => ({ round: spec.round }) });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() { throw new Error('unused'); }, getConversation() { return null; }, result() { return null; } };
  return { workflowRunner, peerRelay };
}

/** Drives a council/debate run to completion (or a maxTurns-truncated partial state) and returns {result, run}. */
async function runToState({ repository, council, participantIds, driverOpts = {}, maxTurns = 30, pmRunId }) {
  const { resolveDriver } = fakeResolveDriverFactory(driverOpts);
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', ...participantIds]));
  const driver = new CouncilChairDriver({ council, ownerTask: 'Materialize a debate task fixture.' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns });
  const request = createPmRequest({ objective: 'Materialize a debate task fixture.', context: { ownerCommandId: `cmd-${pmRunId}`, council } });
  repository.create(request, { id: pmRunId, driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  const result = await runtime.resume(pmRunId);
  const run = repository.load(pmRunId);
  return { result, run };
}

function withProjectRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-debate-materialize-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// =========================================================================
// council-projection.mjs — Debate phases/fields
// =========================================================================

test('projection: debate-less council projection is byte-for-byte unaffected (NOT_ENABLED)', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  const { run } = await runToState({ repository, council, participantIds: ['p1'], pmRunId: 'pmrun_proj_nodebate' });
  const projection = projectCouncil(run);
  assert.equal(projection.phase, COUNCIL_PHASES.COMPLETED);
  assert.deepEqual(projection.debate, {
    enabled: false, maxRounds: 2, currentRound: null, status: DEBATE_STATUS.NOT_ENABLED,
    completedRounds: [], currentRoundPhase: null, finalReportAvailable: false, finalReport: null,
  });
}));

test('projection: debate enabled, Council Report complete, Debate not started -> PENDING, never claims a round exists', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  // maxTurns=3 stops right after chair_plan+report+chair_synthesis, before any debate step.
  const { run } = await runToState({ repository, council, participantIds: ['p1'], maxTurns: 3, pmRunId: 'pmrun_proj_pending' });
  const projection = projectCouncil(run);
  assert.equal(projection.debate.enabled, true);
  assert.equal(projection.debate.status, DEBATE_STATUS.PENDING);
  assert.equal(projection.debate.currentRound, null);
  assert.deepEqual(projection.debate.completedRounds, []);
  // Council Report itself is durably visible and correct regardless.
  assert.equal(projection.synthesis.ok, true);
}));

test('projection: mid Round-1 responses -> ROUND_1_IN_PROGRESS / RESPONSES phase, top-level phase reports DEBATE_ROUND_1 not stale CHAIR_SYNTHESIS', async () => fixture(async ({ store, repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  // chair_plan+2 reports+synthesis(4) + debate_brief(5) + 1 response(6) = 6 turns.
  const { run } = await runToState({ repository, council, participantIds: ['p1', 'p2'], maxTurns: 6, pmRunId: 'pmrun_proj_r1resp' });
  // maxTurns truncation genuinely terminalizes the PmRun as 'failed'
  // (PmMaxTurnsExceeded) — that IS the correct top-level projection for a
  // truly failed run. To read the projection as a live dashboard would
  // see it MID-FLIGHT (the actual scenario under test), force the durable
  // status back to 'running', exactly as the D1 restart tests already do.
  store.run('UPDATE pm_runs SET status = ? WHERE id = ?', ['running', 'pmrun_proj_r1resp']);
  const projection = projectCouncil(repository.load('pmrun_proj_r1resp'));
  assert.equal(projection.phase, COUNCIL_PHASES.DEBATE_ROUND_1, 'top-level phase must reflect debate, not stale CHAIR_SYNTHESIS');
  assert.equal(projection.debate.status, DEBATE_STATUS.ROUND_1_IN_PROGRESS);
  assert.equal(projection.debate.currentRound, 1);
  assert.equal(projection.debate.currentRoundPhase, DEBATE_ROUND_PHASE.RESPONSES);
}));

test('projection: Round 1 complete + continue=true, Round 2 not yet started -> ROUND_1_COMPLETE, currentRound stays 1', async () => fixture(async ({ store, repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  // chair_plan+report+synthesis(3) + debate_brief(4)+response(5)+synthesis(6) = 6 turns, round 1 fully done, round 2 not started.
  const { run } = await runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: true } }, maxTurns: 6, pmRunId: 'pmrun_proj_r1complete' });
  store.run('UPDATE pm_runs SET status = ? WHERE id = ?', ['running', 'pmrun_proj_r1complete']); // see note above
  const projection = projectCouncil(repository.load('pmrun_proj_r1complete'));
  assert.equal(projection.debate.status, DEBATE_STATUS.ROUND_1_COMPLETE);
  assert.equal(projection.debate.currentRound, 1);
  assert.deepEqual(projection.debate.completedRounds, [1]);
  assert.equal(projection.debate.finalReportAvailable, false, 'not stopped -- continuing into round 2, which has not started yet');
  assert.equal(projection.phase, COUNCIL_PHASES.DEBATE_ROUND_1);
  void run;
}));

test('projection: Round 1 STOP -> COMPLETE with finalReport from round 1', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { result, run } = await runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: false } }, pmRunId: 'pmrun_proj_r1stop' });
  assert.equal(result.status, 'completed');
  const projection = projectCouncil(run);
  assert.equal(projection.debate.status, DEBATE_STATUS.COMPLETE);
  assert.equal(projection.debate.currentRound, null);
  assert.equal(projection.debate.finalReportAvailable, true);
  assert.equal(projection.debate.finalReport.round, 1);
  assert.equal(projection.debate.finalReport.engineForcedStop, false);
  assert.equal(projection.phase, COUNCIL_PHASES.COMPLETED);
}));

test('projection: Round 2 forced stop -> COMPLETE with finalReport from round 2, engineForcedStop true', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { result, run } = await runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: true, 2: true } }, pmRunId: 'pmrun_proj_r2stop' });
  assert.equal(result.status, 'completed');
  const projection = projectCouncil(run);
  assert.equal(projection.debate.status, DEBATE_STATUS.COMPLETE);
  assert.deepEqual(projection.debate.completedRounds, [1, 2]);
  assert.equal(projection.debate.finalReport.round, 2);
  assert.equal(projection.debate.finalReport.engineForcedStop, true);
}));

test('projection: degraded flag is preserved for a debate-completed run (finish data.type is "council_debate", not "council")', async () => fixture(async ({ repository }) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  const { run } = await runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: false } }, pmRunId: 'pmrun_proj_degraded' });
  const projection = projectCouncil(run);
  assert.equal(projection.degraded, false, 'degraded must be a real boolean, not silently null, for a council_debate finish');
}));

// =========================================================================
// repo-history-materializer.mjs — Debate/Round-N/** artifacts
// =========================================================================

function materialize(projectRoot, { taskId, run, result, council }) {
  return materializeTaskHistory({
    projectRoot, taskId, pmRunId: run.id, projectId: 'proj-1', taskMode: 'COUNCIL',
    submittedVia: 'TEST', commandId: 'cmd-1', createdAt: '2026-09-03T00:00:00.000Z', completedAt: '2026-09-03T00:05:00.000Z',
    status: result.status, ownerTaskText: 'Materialize a debate task fixture.', council, history: result.history,
    resolveProfile: (id) => ({ id, product: 'fake', model: 'fake-model' }),
  });
}

test('materialization: ordinary Council (no debate) produces zero Debate artifacts, unchanged file set', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  return runToState({ repository, council, participantIds: ['p1'], pmRunId: 'pmrun_mat_nodebate' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-nodebate', run, result, council });
    assert.equal(out.status, 'COMPLETED');
    const fullDir = join(root, out.historyPath);
    assert.ok(existsSync(join(fullDir, 'Task.md')));
    assert.ok(existsSync(join(fullDir, 'chair', 'Synthesis.md')));
    assert.ok(!existsSync(join(fullDir, 'Debate')), 'no Debate/ directory at all for a debate-less council');
  });
})));

test('materialization: debate.enabled=false produces zero Debate artifacts', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: false } });
  return runToState({ repository, council, participantIds: ['p1'], pmRunId: 'pmrun_mat_off' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-off', run, result, council });
    assert.ok(!existsSync(join(root, out.historyPath, 'Debate')));
  });
})));

test('materialization: Council Report complete, Debate not started -> Council artifacts only, no fake Debate completion', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  return runToState({ repository, council, participantIds: ['p1'], maxTurns: 3, pmRunId: 'pmrun_mat_pending' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-pending', run, result, council });
    assert.ok(existsSync(join(root, out.historyPath, 'chair', 'Synthesis.md')));
    assert.ok(!existsSync(join(root, out.historyPath, 'Debate')));
  });
})));

test('materialization: max_rounds=1 complete -> Round-1 artifacts + FinalDebateReport, no Round-2', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  return runToState({ repository, council, participantIds: ['p1', 'p2'], driverOpts: { debateContinueByRound: { 1: true } }, pmRunId: 'pmrun_mat_r1only' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-r1only', run, result, council });
    const dir = join(root, out.historyPath);
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'Brief.md')));
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'DebateReport.md')));
    assert.ok(existsSync(join(dir, 'Debate', 'FinalDebateReport.md')));
    assert.ok(!existsSync(join(dir, 'Debate', 'Round-2')), 'no Round-2 directory when max_rounds=1');
    const final = readFileSync(join(dir, 'Debate', 'FinalDebateReport.md'), 'utf8');
    assert.match(final, /DEBATE REPORT ROUND 1/);
    assert.match(final, /engine forced stop.*YES/i);
  });
})));

test('materialization: Round 1 STOP -> final = Debate Report R1, no Round-2 directory', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  return runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: false } }, pmRunId: 'pmrun_mat_r1stop' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-r1stop', run, result, council });
    const dir = join(root, out.historyPath);
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'DebateReport.md')));
    assert.ok(!existsSync(join(dir, 'Debate', 'Round-2')));
    const final = readFileSync(join(dir, 'Debate', 'FinalDebateReport.md'), 'utf8');
    assert.match(final, /final round.*1/i);
    assert.match(final, /engine forced stop.*NO/i);
  });
})));

test('materialization: Round 1 CONTINUE before Round 2 starts -> Round-1 artifacts exist, no Round-2 dir, no FinalDebateReport yet', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  const { resolveDriver } = fakeResolveDriverFactory({ debateContinueByRound: { 1: true } });
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 6 }); // stops exactly after round-1 synthesis
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-r1continue', council } });
  repository.create(request, { id: 'pmrun_mat_r1continue', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  return runtime.resume('pmrun_mat_r1continue').then((result) => {
    const run = repository.load('pmrun_mat_r1continue');
    const out = materialize(root, { taskId: 'task-mat-r1continue', run, result, council });
    const dir = join(root, out.historyPath);
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'Brief.md')));
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'Participant-fake__fake-model.md')));
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'DebateReport.md')));
    assert.ok(!existsSync(join(dir, 'Debate', 'Round-2')), 'round 2 has not started yet');
    assert.ok(!existsSync(join(dir, 'Debate', 'FinalDebateReport.md')), 'debate is still continuing -- no final report yet');
  });
})));

test('materialization: partial Round-1 participant set (1/2 responses) materializes only existing durable artifacts', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  // chair_plan+2reports+synthesis(4) + debate_brief(5) + 1 response(6) = 6 turns.
  const { resolveDriver } = fakeResolveDriverFactory();
  const { workflowRunner, peerRelay } = actionsFor(resolveDriver, fakeProfileRegistry(['chair', 'p1', 'p2']));
  const driver = new CouncilChairDriver({ council, ownerTask: 'task' });
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository, maxTurns: 6 });
  const request = createPmRequest({ objective: 'task', context: { ownerCommandId: 'cmd-partial', council } });
  repository.create(request, { id: 'pmrun_mat_partial', driver: driver.name, startedAt: '2026-09-03T00:00:00.000Z' });
  return runtime.resume('pmrun_mat_partial').then((result) => {
    const run = repository.load('pmrun_mat_partial');
    const out = materialize(root, { taskId: 'task-mat-partial', run, result, council });
    const dir = join(root, 'docs', 'history', 'council');
    const taskFolders = readdirSync(dir);
    assert.equal(taskFolders.length, 1);
    const roundDir = join(dir, taskFolders[0], 'Debate', 'Round-1');
    const files = readdirSync(roundDir).sort();
    // Brief.md + exactly ONE Participant-*.md (only 1 of 2 responses completed); no DebateReport.md yet.
    assert.equal(files.filter((f) => f.startsWith('Participant-')).length, 1);
    assert.ok(files.includes('Brief.md'));
    assert.ok(!files.includes('DebateReport.md'));
    void out;
  });
})));

test('materialization: complete Round 2 -> final = Debate Report R2, Round-1 artifacts preserved unchanged', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  return runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: true, 2: false } }, pmRunId: 'pmrun_mat_r2complete' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-r2complete', run, result, council });
    const dir = join(root, out.historyPath);
    assert.ok(existsSync(join(dir, 'Debate', 'Round-1', 'DebateReport.md')));
    assert.ok(existsSync(join(dir, 'Debate', 'Round-2', 'DebateReport.md')));
    const round1Report = readFileSync(join(dir, 'Debate', 'Round-1', 'DebateReport.md'), 'utf8');
    assert.match(round1Report, /DEBATE REPORT ROUND 1/, 'round-1 artifact is preserved unchanged once round 2 exists');
    const final = readFileSync(join(dir, 'Debate', 'FinalDebateReport.md'), 'utf8');
    assert.match(final, /DEBATE REPORT ROUND 2/, 'final report points to round 2, the completed round, not round 1');
  });
})));

test('materialization: participant artifact filenames are deterministic and match the members/ folder slug', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  return runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: false } }, pmRunId: 'pmrun_mat_names' }).then(({ result, run }) => {
    const out = materialize(root, { taskId: 'task-mat-names', run, result, council });
    const dir = join(root, out.historyPath);
    const memberFile = join(dir, 'members', 'fake__fake-model', 'Round1_Report.md');
    const debateFile = join(dir, 'Debate', 'Round-1', 'Participant-fake__fake-model.md');
    assert.ok(existsSync(memberFile), 'members/ folder uses the expected slug');
    assert.ok(existsSync(debateFile), 'Debate/Round-1/ participant file uses the SAME slug as members/');
  });
})));

test('materialization: duplicate materialization is idempotent — same durable state produces byte-identical Debate files', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
  return runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: true, 2: false } }, pmRunId: 'pmrun_mat_idem' }).then(({ result, run }) => {
    const first = materialize(root, { taskId: 'task-mat-idem', run, result, council });
    assert.equal(first.idempotent, false);
    const briefPath = join(root, first.historyPath, 'Debate', 'Round-1', 'Brief.md');
    const finalPath = join(root, first.historyPath, 'Debate', 'FinalDebateReport.md');
    const briefBefore = readFileSync(briefPath, 'utf8');
    const finalBefore = readFileSync(finalPath, 'utf8');

    // Second call at the SAME EXECUTION_LOG_VERSION short-circuits via the
    // marker (materializeTaskHistory()'s own Part U/X/Y idempotency) --
    // proving it never rewrites (and never diverges from) what's on disk.
    const second = materialize(root, { taskId: 'task-mat-idem', run, result, council });
    assert.equal(second.idempotent, true);
    assert.equal(readFileSync(briefPath, 'utf8'), briefBefore);
    assert.equal(readFileSync(finalPath, 'utf8'), finalBefore);
  });
})));

test('materialization: process-restart re-materialization (stale marker) reproduces byte-identical Debate content from the same durable state', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
  return runToState({ repository, council, participantIds: ['p1'], driverOpts: { debateContinueByRound: { 1: false } }, pmRunId: 'pmrun_mat_restart' }).then(({ result, run }) => {
    const first = materialize(root, { taskId: 'task-mat-restart', run, result, council });
    const finalPath = join(root, first.historyPath, 'Debate', 'FinalDebateReport.md');
    const before = readFileSync(finalPath, 'utf8');

    // Simulate "process restart re-materializes from the same durable
    // state" by forcing the marker stale (an OLDER execution_log_version)
    // — materializeTaskHistory() then genuinely re-runs every builder
    // fresh, from the SAME `history`/`council` inputs, and must reproduce
    // byte-identical content (every builder here is a pure function with
    // no clock, no randomness, no LLM call).
    const markerPath = join(root, first.historyPath, '.materialized.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.execution_log_version = EXECUTION_LOG_VERSION - 1;
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    const second = materialize(root, { taskId: 'task-mat-restart', run, result, council });
    assert.equal(second.idempotent, false, 'stale marker forces a genuine re-materialization, not a short-circuit');
    assert.equal(readFileSync(finalPath, 'utf8'), before, 'byte-identical output from the same durable input');
  });
})));

test('materialization: old (pre-P19) council spec without a `.debate` field remains compatible — no Debate artifacts, no crash', async () => fixture(async ({ repository }) => withProjectRoot((root) => {
  const council = normalizeCouncilSpec({ chair_profile_id: 'chair', participant_profile_ids: ['p1'], rounds: 1 });
  return runToState({ repository, council, participantIds: ['p1'], pmRunId: 'pmrun_mat_old' }).then(({ result, run }) => {
    // Simulate a genuinely pre-P19 durable spec: strip `.debate` entirely
    // (a pre-D1 normalizeCouncilSpec() never added it) rather than relying
    // on the current normalizer's default.
    const oldCouncil = { ...council };
    delete oldCouncil.debate;
    const out = materialize(root, { taskId: 'task-mat-old', run, result, council: oldCouncil });
    assert.equal(out.status, 'COMPLETED');
    assert.ok(!existsSync(join(root, out.historyPath, 'Debate')));
    assert.ok(existsSync(join(root, out.historyPath, 'chair', 'Synthesis.md')));
  });
})));

// =========================================================================
// Direct unit coverage for the failure-path content builders (no full
// orchestration needed — pure functions).
// =========================================================================

test('buildDebateReportMarkdown: ok=false path never fabricates report content', () => {
  const md = buildDebateReportMarkdown({ round: 1, ok: false, reason: 'COUNCIL_DEBATE_SYNTHESIS_INVALID:WRONG_DATA_TYPE:missing' });
  assert.match(md, /Failure/);
  assert.match(md, /COUNCIL_DEBATE_SYNTHESIS_INVALID/);
  assert.doesNotMatch(md, /## Report/);
});

test('buildDebateResponseFailureMarkdown: records the failure, never fabricates a substitute response', () => {
  const md = buildDebateResponseFailureMarkdown({ profileId: 'p1', profile: { product: 'fake' }, round: 1, reason: 'simulated failure' });
  assert.match(md, /FAILED/);
  assert.match(md, /simulated failure/);
});
