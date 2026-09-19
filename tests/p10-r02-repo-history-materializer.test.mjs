import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { materializeTaskHistory, assertWithinProjectRoot, correlateStagePids, readEventsJsonlSafe } from '../src/runtime/repo-history-materializer.mjs';

const PROFILES = {
  'live1-claude-pm': { product: 'claude-code', model: 'sonnet', reasoning: 'high', session_kind: 'STATELESS' },
  'live1-codex-gpt-5-6-sol-pm': { product: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', session_kind: 'STATELESS' },
  'live1-antigravity-gemini-high': { product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high', session_kind: 'STATELESS' },
  'live1-opencode-pm': { product: 'opencode', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high', session_kind: 'STATELESS' },
};
function resolveProfile(id) { return PROFILES[id] ?? null; }

function councilTurn(turn, stepKind, participantProfileId, round, handoffExtra = {}) {
  return {
    turn, decision: { type: 'workflow', spec: { round } },
    outcome: { status: 'completed', completedAt: `2026-08-24T10:5${turn}:00.000Z`, finalResult: { handoff: { stepKind, participantProfileId, ok: true, ...handoffExtra } } },
  };
}

function fullCouncilHistory() {
  return [
    councilTurn(0, 'chair_plan', 'live1-claude-pm', 0, {
      participant_instructions: { 'live1-codex-gpt-5-6-sol-pm': 'focus codex', 'live1-antigravity-gemini-high': 'focus antigravity', 'live1-opencode-pm': 'focus opencode' },
      critique_focus: 'be rigorous', synthesis_focus: 'converge',
      structured_output: { requested: true, provider: 'claude-code', schema_kind: 'council_chair_plan', present: true },
      attempts: [{ attempt: 0, ok: true }],
    }),
    councilTurn(1, 'participant_report', 'live1-codex-gpt-5-6-sol-pm', 1, { analysis: 'codex analysis', recommendation: 'codex rec', risks: ['r1'], uncertainties: ['u1'] }),
    councilTurn(2, 'participant_report', 'live1-antigravity-gemini-high', 1, { analysis: 'antigravity analysis', recommendation: 'antigravity rec', risks: [], uncertainties: [] }),
    councilTurn(3, 'participant_report', 'live1-opencode-pm', 1, { analysis: 'opencode analysis', recommendation: 'opencode rec', risks: [], uncertainties: [] }),
    councilTurn(4, 'participant_critique', 'live1-codex-gpt-5-6-sol-pm', 2, { criticisms: ['c1'], agreements: ['a1'], revised_recommendation: 'codex revised', remaining_disagreements: [] }),
    councilTurn(5, 'participant_critique', 'live1-antigravity-gemini-high', 2, { criticisms: [], agreements: [], revised_recommendation: 'antigravity revised', remaining_disagreements: [] }),
    councilTurn(6, 'participant_critique', 'live1-opencode-pm', 2, { criticisms: [], agreements: [], revised_recommendation: 'opencode revised', remaining_disagreements: [] }),
    councilTurn(7, 'chair_synthesis', 'live1-claude-pm', 2, { output: 'CHAIR SYNTHESIS final text\nP10-T1-MARKER=ORBIT-417' }),
  ];
}

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-r02-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const COUNCIL = { chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'], rounds: 2, strategy: 'independent_then_critique_then_synthesis' };

function baseCouncilArgs(projectRoot, overrides = {}) {
  return {
    projectRoot, taskId: 'task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz', pmRunId: 'pmrun-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz', projectId: 'dsh-p6-test-b',
    taskMode: 'COUNCIL', submittedVia: 'TELEGRAM', commandId: 'tg-abc', createdAt: '2026-08-24T10:53:20.868Z', completedAt: '2026-08-24T11:00:20.868Z',
    status: 'completed', ownerTaskText: 'P10 SESSION TEST T1 — INITIAL ARCHITECTURE COUNCIL.\nInclude marker:\nP10-T1-MARKER=ORBIT-417',
    council: COUNCIL, history: fullCouncilHistory(), finalOutput: 'CHAIR SYNTHESIS final text\nP10-T1-MARKER=ORBIT-417', finalData: { type: 'council' },
    resolveProfile, events: [], ...overrides,
  };
}

// ---- LAYOUT --------------------------------------------------------------

test('SINGLE task materializes under docs/history/single/', () => withTmpProject((root) => {
  const result = materializeTaskHistory({
    projectRoot: root, taskId: 'task-single1', pmRunId: 'pmrun-single1', projectId: 'proj-x', taskMode: 'SINGLE',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', status: 'completed',
    ownerTaskText: 'Do a single PM task', pmProfileId: 'live1-claude-pm', history: [], finalOutput: 'done', finalData: {}, resolveProfile,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.match(result.historyPath, /^docs\/history\/single\//);
  const dir = join(root, ...result.historyPath.split('/'));
  for (const f of ['Task.md', 'PM.md', 'Plan.md', 'Walkthrough.md', 'ExecutionLog.md']) {
    assert.ok(existsSync(join(dir, f)), `missing ${f}`);
  }
  assert.ok(!existsSync(join(dir, 'chair')), 'SINGLE must not have a chair/ subfolder');
  assert.ok(!existsSync(join(dir, 'members')), 'SINGLE must not have a members/ subfolder');
}));

test('COUNCIL task materializes under docs/history/council/ with chair/ and members/ subfolders', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  assert.equal(result.status, 'COMPLETED');
  assert.match(result.historyPath, /^docs\/history\/council\//);
  const dir = join(root, ...result.historyPath.split('/'));
  assert.ok(existsSync(join(dir, 'Task.md')));
  assert.ok(existsSync(join(dir, 'chair', 'PM.md')));
  assert.ok(existsSync(join(dir, 'chair', 'Plan.md')));
  assert.ok(existsSync(join(dir, 'chair', 'Synthesis.md')));
  assert.ok(existsSync(join(dir, 'Walkthrough.md')));
  assert.ok(existsSync(join(dir, 'ExecutionLog.md')));
}));

test('COUNCIL member coverage: 3 participants = 3 member folders, each with a report + critique file', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  const expectedFolders = ['codex__gpt-5-6-sol', 'antigravity__gemini-3-7-flash-high', 'opencode__deepseek-v4-flash'];
  for (const folder of expectedFolders) {
    assert.ok(existsSync(join(dir, 'members', folder, 'Round1_Report.md')), `missing report for ${folder}`);
    assert.ok(existsSync(join(dir, 'members', folder, 'Round2_Critique.md')), `missing critique for ${folder}`);
  }
}));

// ---- IDENTITY --------------------------------------------------------------

test('full canonical task_id/pm_run_id/chair/participant profile ids are preserved verbatim', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  const task = readFileSync(join(dir, 'Task.md'), 'utf8');
  assert.match(task, /task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz/);
  assert.match(task, /pmrun-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz/);
  assert.match(task, /live1-claude-pm/);
  assert.match(task, /live1-codex-gpt-5-6-sol-pm/);
  assert.match(task, /live1-antigravity-gemini-high/);
  assert.match(task, /live1-opencode-pm/);
  const chairPm = readFileSync(join(dir, 'chair', 'PM.md'), 'utf8');
  assert.match(chairPm, /claude-code/);
  assert.match(chairPm, /sonnet/);
  assert.match(chairPm, /\bhigh\b/);
}));

test('reports/critiques map to the correct participant with no cross-member mixup', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  const codexReport = readFileSync(join(dir, 'members', 'codex__gpt-5-6-sol', 'Round1_Report.md'), 'utf8');
  assert.match(codexReport, /codex analysis/);
  assert.doesNotMatch(codexReport, /antigravity analysis/);
  const antigravityReport = readFileSync(join(dir, 'members', 'antigravity__gemini-3-7-flash-high', 'Round1_Report.md'), 'utf8');
  assert.match(antigravityReport, /antigravity analysis/);
  assert.doesNotMatch(antigravityReport, /codex analysis/);
}));

// ---- CONTENT --------------------------------------------------------------

test('owner task text is preserved (bounded) and the ORBIT-417 marker survives in Task.md and Synthesis.md', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.match(readFileSync(join(dir, 'Task.md'), 'utf8'), /P10-T1-MARKER=ORBIT-417/);
  assert.match(readFileSync(join(dir, 'chair', 'Synthesis.md'), 'utf8'), /P10-T1-MARKER=ORBIT-417/);
  assert.match(readFileSync(join(dir, 'Walkthrough.md'), 'utf8'), /P10-T1-MARKER=ORBIT-417|Synthesis\.md/);
}));

test('final chair synthesis is preserved, not re-summarized by another model', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.match(readFileSync(join(dir, 'chair', 'Synthesis.md'), 'utf8'), /CHAIR SYNTHESIS final text/);
}));

// ---- EXECUTION LOG --------------------------------------------------------------

test('ExecutionLog.md is chronological and includes a PID when opportunistic events evidence is supplied', () => withTmpProject((root) => {
  const events = [
    { event_type: 'COUNCIL_PLAN_ATTEMPT_START', profile_id: 'live1-claude-pm' },
    { event_type: 'BACKEND_PROCESS_SPAWN', profile_id: 'live1-claude-pm', process_pid: 29612 },
  ];
  const result = materializeTaskHistory(baseCouncilArgs(root, { events }));
  const dir = join(root, ...result.historyPath.split('/'));
  const log = readFileSync(join(dir, 'ExecutionLog.md'), 'utf8');
  assert.match(log, /29612/);
  const turnOrder = [...log.matchAll(/TURN (\d+):/g)].map((m) => Number(m[1]));
  assert.deepEqual(turnOrder, [...turnOrder].sort((a, b) => a - b));
}));

test('a missing PID is non-fatal — materialization still succeeds with no events evidence', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root, { events: [] }));
  assert.equal(result.status, 'COMPLETED');
}));

// ---- PROGRESS --------------------------------------------------------------

test('progress.md gets exactly one appended UTF-8 line with the correct relative history path, never rewriting prior content', () => withTmpProject((root) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'progress.md'), '# Progress\nexisting line 1\n', 'utf8');
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const text = readFileSync(join(root, 'progress.md'), 'utf8');
  assert.match(text, /^# Progress\nexisting line 1\n/);
  assert.match(text, new RegExp(result.historyPath.replace(/\//g, '\\/')));
  assert.match(text, /task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz/);
}));

test('a second materialize() call for the same task does not append a second progress.md line (idempotent)', () => withTmpProject((root) => {
  materializeTaskHistory(baseCouncilArgs(root));
  materializeTaskHistory(baseCouncilArgs(root));
  const text = readFileSync(join(root, 'progress.md'), 'utf8');
  const occurrences = text.split('task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz').length - 1;
  assert.equal(occurrences, 1);
}));

// ---- SAFETY --------------------------------------------------------------

test('path traversal via a malicious task_id is rejected, not silently sanitized into something wrong', () => withTmpProject((root) => {
  assert.throws(() => materializeTaskHistory(baseCouncilArgs(root, { taskId: '../../etc/passwd' })));
}));

test('assertWithinProjectRoot rejects an absolute path escape outside the project root', () => withTmpProject((root) => {
  assert.throws(() => assertWithinProjectRoot(root, join(tmpdir(), 'somewhere-else')));
  assert.throws(() => assertWithinProjectRoot(root, root)); // the root itself is not a valid "inside" target
  assert.doesNotThrow(() => assertWithinProjectRoot(root, join(root, 'docs', 'history')));
}));

test('materialization can never write outside the project root, even indirectly', () => withTmpProject((root) => {
  const result = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...result.historyPath.split('/'));
  assert.ok(dir.startsWith(root));
}));

test('secrets are redacted in materialized content', () => withTmpProject((root) => {
  const history = fullCouncilHistory();
  history[7].outcome.finalResult.handoff.output = 'final text with token sk-abcdefgh12345678 embedded';
  const result = materializeTaskHistory(baseCouncilArgs(root, { history, finalOutput: 'final text with token sk-abcdefgh12345678 embedded' }));
  const dir = join(root, ...result.historyPath.split('/'));
  const synthesis = readFileSync(join(dir, 'chair', 'Synthesis.md'), 'utf8');
  assert.doesNotMatch(synthesis, /sk-abcdefgh12345678/);
}));

test('bounded large fields never blow past the documented limit', () => withTmpProject((root) => {
  const history = fullCouncilHistory();
  history[7].outcome.finalResult.handoff.output = 'x'.repeat(50000);
  const result = materializeTaskHistory(baseCouncilArgs(root, { history, finalOutput: 'x'.repeat(50000) }));
  const dir = join(root, ...result.historyPath.split('/'));
  const synthesis = readFileSync(join(dir, 'chair', 'Synthesis.md'), 'utf8');
  assert.match(synthesis, /TRUNCATED/);
  assert.ok(synthesis.length < 50000);
}));

// ---- LIFECYCLE --------------------------------------------------------------

test('idempotent: calling materializeTaskHistory twice for the same task returns the same historyPath and never creates a _copy/_2 folder', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseCouncilArgs(root));
  const second = materializeTaskHistory(baseCouncilArgs(root));
  assert.equal(first.historyPath, second.historyPath);
  assert.equal(second.idempotent, true);
}));

test('idempotent: no duplicate _copy/_2/_final2 folders are ever created', () => withTmpProject((root) => {
  materializeTaskHistory(baseCouncilArgs(root));
  materializeTaskHistory(baseCouncilArgs(root));
  const entries = readdirSync(join(root, 'docs', 'history', 'council'));
  assert.equal(entries.length, 1);
}));

test('partial materialization recovery: a folder with content but no .materialized.json marker is safely completed on retry', () => withTmpProject((root) => {
  const first = materializeTaskHistory(baseCouncilArgs(root));
  const dir = join(root, ...first.historyPath.split('/'));
  unlinkSync(join(dir, '.materialized.json'));
  const second = materializeTaskHistory(baseCouncilArgs(root));
  assert.equal(second.idempotent, false); // it was redone, not treated as already-complete
  assert.ok(existsSync(join(dir, '.materialized.json')));
  assert.ok(existsSync(join(dir, 'chair', 'Synthesis.md')));
}));

test('materialization failure never changes the task status object it is given (this module only ever describes itself, never the caller\'s result)', () => withTmpProject((root) => {
  assert.throws(() => materializeTaskHistory(baseCouncilArgs(root, { taskId: null })));
  // caller-owned `result.status` is a completely separate object never touched by this module
}));

// ---- DEGRADED COUNCIL --------------------------------------------------------------

test('a degraded council (one participant failed) still gets a folder for that participant, with a Failure file instead of a fabricated report', () => withTmpProject((root) => {
  const history = fullCouncilHistory();
  // opencode's report never validated -- represent it as a failed step.
  history[3] = { turn: 3, decision: { type: 'workflow', spec: { round: 1 } }, outcome: { status: 'completed', completedAt: '2026-08-24T10:53:00.000Z', finalResult: { handoff: { stepKind: 'participant_report', participantProfileId: 'live1-opencode-pm', ok: false, reason: 'PM_DECISION_PARSE_FAILED', attempts: [{ attempt: 0 }, { attempt: 1 }] } } } };
  // opencode never reaches critique either.
  history.splice(6, 1);
  const result = materializeTaskHistory(baseCouncilArgs(root, { history }));
  const dir = join(root, ...result.historyPath.split('/'));
  const opencodeDir = join(dir, 'members', 'opencode__deepseek-v4-flash');
  assert.ok(existsSync(join(opencodeDir, 'Round1_Failure.md')), 'expected a Round1_Failure.md, never a fabricated report');
  assert.ok(!existsSync(join(opencodeDir, 'Round1_Report.md')));
  const failureText = readFileSync(join(opencodeDir, 'Round1_Failure.md'), 'utf8');
  assert.match(failureText, /PM_DECISION_PARSE_FAILED/);
  assert.match(failureText, /retry occurred: YES/);
  // codex and antigravity, who succeeded, are unaffected.
  assert.ok(existsSync(join(dir, 'members', 'codex__gpt-5-6-sol', 'Round1_Report.md')));
}));

// ---- correlateStagePids / readEventsJsonlSafe unit coverage ----

test('correlateStagePids correlates by event order, not by the ambiguous literal "stage" field', () => {
  const events = [
    { event_type: 'COUNCIL_PLAN_ATTEMPT_START', profile_id: 'chair-1' },
    { event_type: 'BACKEND_PROCESS_SPAWN', profile_id: 'chair-1', process_pid: 111, stage: 'PROCESS_SPAWN' },
    { event_type: 'CHAIR_SYNTHESIS_ATTEMPT_START', profile_id: 'chair-1' },
    { event_type: 'BACKEND_PROCESS_SPAWN', profile_id: 'chair-1', process_pid: 222, stage: 'PROCESS_SPAWN' },
  ];
  const map = correlateStagePids(events);
  assert.equal(map.get('chair_plan:chair-1'), 111);
  assert.equal(map.get('chair_synthesis:chair-1'), 222);
});

test('readEventsJsonlSafe never throws on a missing or malformed file', () => {
  assert.deepEqual(readEventsJsonlSafe(join(tmpdir(), 'does-not-exist-xyz.jsonl')), []);
});
