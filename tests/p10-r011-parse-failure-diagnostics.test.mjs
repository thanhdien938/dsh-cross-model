import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyParseSubreason, ProductionPmBackendError } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { TaskDiagnosticLog, taskLogDir, forwardBackendEventToTaskLog, createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };

// ---- Part B: subreason taxonomy, derived from real parser diagnostics ----

test('classifyParseSubreason maps bounded prefix/suffix classes to distinct named subreasons', () => {
  assert.equal(classifyParseSubreason({ prefixClass: 'EMPTY' }), 'PM_DECISION_EMPTY_TEXT');
  assert.equal(classifyParseSubreason({ prefixClass: 'LEADING_CONTENT' }), 'PM_DECISION_LEADING_CONTENT');
  assert.equal(classifyParseSubreason({ prefixClass: 'FENCE' }), 'PM_DECISION_FENCE_INVALID');
  assert.equal(classifyParseSubreason({ prefixClass: 'NONE', suffixClass: 'TRAILING_CONTENT' }), 'PM_DECISION_TRAILING_CONTENT');
  assert.equal(classifyParseSubreason({ prefixClass: 'NONE', fullJson: false }), 'PM_DECISION_JSON_INVALID');
  assert.equal(classifyParseSubreason({ prefixClass: 'UNKNOWN' }), 'PM_DECISION_UNEXPECTED_SHAPE');
});

// ---- Part A/N: reproduce the live shape (PROCESS_EXIT 0, output present, ----
// ---- PM_DECISION_PARSE_FAILED on BOTH attempts) with REPRESENTATIVE      ----
// ---- malformed JSON (the exact captured bytes are unavailable -- no raw  ----
// ---- backend-execution-observer capture survived the live run; this is  ----
// ---- the exact diagnostic deficiency this wave closes for NEXT time --  ----
// ---- see docs/p10/04_CHAIR_DECISION_PARSE_FAILURE_DIAGNOSTICS_SONNET5.md).

function chairPlanSpec() {
  return {
    id: 'council:chair_plan:0', kind: 'council_step', stepKind: 'chair_plan', round: 0,
    profileId: 'live1-claude-pm', prompt: 'PLAN THE COUNCIL', participantProfileIds: ['p1', 'p2'],
  };
}

// A realistic malformed shape matching the ONE concretely-documented real
// historical parse-failure class in this codebase (P7-R0.2: a complete,
// correct decision object followed by exactly one stray trailing `}`).
function strayBraceOutput() {
  return `${JSON.stringify({ type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' }, critique_focus: 'a', synthesis_focus: 'b' } })}}`;
}

function fakeProductionResolveDriver(outputsByProfile) {
  // Simulates createCliPmDriver's REAL behavior: parseDecision() throws
  // PM_DECISION_PARSE_FAILED with diagnostics/parseSubreason attached
  // (production-pm-backend-registry.mjs), for malformed text.
  return () => ({
    name: 'fake:live1-claude-pm', product: 'claude-code', model: 'sonnet', reasoning: 'high',
    async decide() {
      const text = outputsByProfile.shift();
      let parsed; try { parsed = JSON.parse(text.trim()); } catch { /* malformed */ }
      if (parsed === undefined) {
        const error = new ProductionPmBackendError('PM backend returned an invalid decision', 'PM_DECISION_PARSE_FAILED');
        const firstChar = text.trim()[0] ?? ''; const lastChar = text.trim()[text.trim().length - 1] ?? '';
        error.diagnostics = { bytes: text.length, firstChar, lastChar, fullJson: false, jsonFence: false, prefixClass: firstChar === '{' ? 'NONE' : 'UNKNOWN' };
        error.parseSubreason = classifyParseSubreason(error.diagnostics);
        throw error;
      }
      return parsed;
    },
  });
}

test('1/2/3/5/6: both real attempts (0 and 1) are logged with output bytes and parse subreason, plus a PARSE_RETRY event between them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-'));
  try {
    const taskId = 'task_live_repro';
    const taskLog = new TaskDiagnosticLog({ runtimeRoot: root, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL' });
    // Both real Claude invocations failed the same way, exactly like the
    // owner's live evidence (two PROCESS_EXIT=0, PM_DECISION_PARSE_FAILED).
    const resolveDriver = fakeProductionResolveDriver([strayBraceOutput(), strayBraceOutput()]);
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog });
    const outcome = await runner.run(chairPlanSpec());

    assert.equal(outcome.finalResult.handoff.ok, false);
    assert.equal(outcome.finalResult.handoff.reason, 'PM_DECISION_PARSE_FAILED');
    assert.equal(outcome.finalResult.handoff.attempts.length, 2, 'attempt 0 AND attempt 1 both recorded on the handoff');
    assert.deepEqual(outcome.finalResult.handoff.attempts.map((a) => a.attempt), [0, 1]);
    for (const a of outcome.finalResult.handoff.attempts) {
      assert.equal(a.ok, false);
      assert.equal(a.error_code, 'PM_DECISION_PARSE_FAILED');
      assert.equal(a.parse_subreason, 'PM_DECISION_JSON_INVALID');
      assert.equal(typeof a.output_bytes, 'number');
      assert.ok(a.output_bytes > 0);
    }

    const events = readFileSync(join(taskLogDir(root, taskId), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const attemptStarts = events.filter((e) => e.event_type === 'COUNCIL_PLAN_ATTEMPT_START');
    assert.deepEqual(attemptStarts.map((e) => e.attempt), [0, 1], '1/2: attempt 0 and attempt 1 both appear as their own events');
    const backendResults = events.filter((e) => e.event_type === 'COUNCIL_PLAN_BACKEND_RESULT');
    assert.equal(backendResults.length, 2);
    const parserResults = events.filter((e) => e.event_type === 'PARSER_RESULT');
    assert.equal(parserResults.length, 2);
    for (const p of parserResults) {
      assert.equal(p.attempt !== undefined, true);
      assert.equal(p.parse_subreason, 'PM_DECISION_JSON_INVALID', '6: parse subreason logged');
      assert.equal(typeof p.output_bytes, 'number', '5: output bytes logged');
    }
    const retry = events.find((e) => e.event_type === 'COUNCIL_PLAN_RETRY');
    assert.ok(retry, '3: retry event logged');
    assert.equal(retry.retry_kind, 'PARSE_RETRY');
    assert.equal(retry.from_attempt, 0);
    assert.equal(retry.to_attempt, 1);

    // 10: participants never spawned when the chair plan never validated.
    assert.equal(events.some((e) => e.event_type === 'PARTICIPANT_START'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a corrected second attempt (attempt 1 valid JSON) succeeds and is classified correctly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-ok-'));
  try {
    const taskId = 'task_live_repro_ok';
    const taskLog = new TaskDiagnosticLog({ runtimeRoot: root, taskId, projectId: PROJECT.id, taskMode: 'COUNCIL' });
    const validOutput = JSON.stringify({ type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' }, critique_focus: 'a', synthesis_focus: 'b' } });
    const resolveDriver = fakeProductionResolveDriver([strayBraceOutput(), validOutput]);
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog });
    const outcome = await runner.run(chairPlanSpec());

    assert.equal(outcome.finalResult.handoff.ok, true);
    assert.equal(outcome.finalResult.handoff.attempts.length, 2);
    assert.equal(outcome.finalResult.handoff.attempts[0].ok, false);
    assert.equal(outcome.finalResult.handoff.attempts[1].ok, true);

    const events = readFileSync(join(taskLogDir(root, taskId), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const okParser = events.filter((e) => e.event_type === 'PARSER_RESULT' && e.attempt === 1);
    assert.equal(okParser[0].parser_outcome, 'OK');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Part L: PID/PROCESS_EXIT correlation bridge ---------------------------

test('4: forwardBackendEventToTaskLog records process_pid when a real PROCESS_SPAWN event carries taskId', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-pid-'));
  try {
    const taskId = 'task_pid_test';
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const events = [];
    const observer = createBackendExecutionObserver({ emit: (event) => { events.push(event); forwardBackendEventToTaskLog(event, factory); } });
    observer.spawn({ taskId, projectId: 'p1', profileId: 'live1-claude-pm', backendProduct: 'claude-code', attempt: 0, phase: 'chair_plan' }, { pid: 4242 });
    observer.exit({ taskId, projectId: 'p1', profileId: 'live1-claude-pm', backendProduct: 'claude-code', attempt: 0, phase: 'chair_plan' }, { exitCode: 0 });

    const logged = readFileSync(join(taskLogDir(root, taskId), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const spawnEvent = logged.find((e) => e.event_type === 'BACKEND_PROCESS_SPAWN');
    assert.ok(spawnEvent, 'PID event forwarded into the task-scoped bundle');
    assert.equal(spawnEvent.process_pid, 4242);
    assert.equal(spawnEvent.attempt, 0);
    const exitEvent = logged.find((e) => e.event_type === 'BACKEND_PROCESS_EXIT');
    assert.equal(exitEvent.exit_code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the PID bridge does not create a task file when taskId is absent (no cross-task leakage)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-nopid-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const forwarded = forwardBackendEventToTaskLog({ eventKind: 'PROCESS_SPAWN', pid: 1, taskId: null }, factory);
    assert.equal(forwarded, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the task bridge forwards parser facts as a single durable PARSER_RESULT event', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-nodupe-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const forwarded = forwardBackendEventToTaskLog({ eventKind: 'PARSER', taskId: 'task_x', taskMode: 'SINGLE', parserOutcome: 'PM_DECISION_PARSE_FAILED', outputByteLength: 4, firstChar: '{', lastChar: '}', firstCharClass: 'OPEN_BRACE', lastCharClass: 'CLOSE_BRACE', fullJson: false, jsonFence: false, prefixClass: 'NONE', suffixClass: 'UNKNOWN', parseSubreason: 'PM_DECISION_JSON_INVALID' }, factory);
    assert.equal(forwarded, true);
    const logged = readFileSync(join(taskLogDir(root, 'task_x'), 'events.jsonl'), 'utf8');
    assert.match(logged, /"event_type":"PARSER_RESULT"/);
    assert.equal(forwardBackendEventToTaskLog({ eventKind: 'PARSER', taskId: 'task_council', taskMode: 'COUNCIL' }, factory), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Part H: no raw output / secrets in the diagnostic trail --------------

test('7/13: the malformed raw output is NEVER logged, only bounded sanitized structural facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p1011-nosecret-'));
  try {
    const taskId = 'task_nosecret';
    const taskLog = new TaskDiagnosticLog({ runtimeRoot: root, taskId });
    const secretLadenOutput = `${strayBraceOutput().slice(0, -1)} /* token=SUPER-SECRET-abc123-leak-me */}`;
    const resolveDriver = fakeProductionResolveDriver([secretLadenOutput, secretLadenOutput]);
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog });
    await runner.run(chairPlanSpec());

    const raw = readFileSync(join(taskLogDir(root, taskId), 'events.jsonl'), 'utf8');
    assert.equal(raw.includes('SUPER-SECRET'), false);
    assert.equal(raw.includes('token='), false);
    assert.equal(raw.includes('participant_instructions'), false, 'raw JSON content itself is never dumped, only its shape facts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Part P: logging failure remains non-fatal to the real step -----------

test('14: a throwing taskLog never changes the step outcome (Part P)', async () => {
  const throwingTaskLog = { event: () => { throw new Error('disk is full'); } };
  const resolveDriver = fakeProductionResolveDriver([JSON.stringify({ type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' }, critique_focus: 'a', synthesis_focus: 'b' } })]);
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT, taskLog: throwingTaskLog });
  // taskLog validation in the constructor only checks `.event` is a
  // function -- it does not call it -- so this exercises the real call
  // sites too. If any call site failed to be defensive, this would throw
  // out of run() instead of returning a normal outcome.
  const outcome = await runner.run(chairPlanSpec());
  assert.equal(outcome.finalResult.handoff.ok, true);
});
