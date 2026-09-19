import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChairPlanPrompt } from '../src/pm/council/council-prompts.mjs';
import { createCliPmDriver, ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };

// ---- Part L.1/L.2: prompt composition ------------------------------------

test('L1: buildChairPlanPrompt states the exact required finish/council_plan shape', () => {
  const prompt = buildChairPlanPrompt({ ownerTask: 'do the thing', constraints: [], participantProfileIds: ['p1', 'p2'] });
  assert.match(prompt, /"type":"finish"/);
  assert.match(prompt, /"type":"council_plan"/);
  assert.match(prompt, /"participant_instructions"/);
  assert.match(prompt, /"critique_focus"/);
  assert.match(prompt, /"synthesis_focus"/);
  assert.match(prompt, /"p1"/);
  assert.match(prompt, /"p2"/);
});

test('L2: renderRequest (via createCliPmDriver) renders a council step objective as plain readable text, not double-JSON-escaped, and states the outer/inner disambiguation', async () => {
  let capturedPrompt = null;
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: PROJECT,
    run: async (prompt) => { capturedPrompt = prompt; return '{"type":"finish","output":"ok"}'; },
  });
  const chairPlanText = buildChairPlanPrompt({ ownerTask: 'Compare two approaches', constraints: [], participantProfileIds: ['p1', 'p2'] });
  await driver.decide({ turn: 0, request: { id: 'r1', objective: chairPlanText }, history: [] });
  // The inner prompt's own literal text appears readably (not JSON-string-
  // escaped: no backslash-escaped quotes around it) inside the outer prompt.
  assert.ok(capturedPrompt.includes(chairPlanText), 'inner prompt text appears verbatim, unescaped');
  assert.ok(!capturedPrompt.includes(JSON.stringify(chairPlanText)), 'inner prompt text is not JSON.stringify-embedded');
  assert.match(capturedPrompt, /separate, OUTER decision wrapper/i);
  // Universal contract lines are still present, unchanged.
  assert.match(capturedPrompt, /"type":"finish","output":"<required non-empty string/);
  assert.match(capturedPrompt, /do not substitute "summary", "result", "message"/);
});

// ---- Part L.3-L.9, Part F: parser behavior (unchanged strictness) --------

function driverWithRunner(run) {
  return createCliPmDriver({ profile: { id: 'live1-claude-pm', product: 'claude-code' }, project: PROJECT, run });
}

test('L3: exact valid chair_plan JSON parses', async () => {
  const shape = { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' }, critique_focus: 'a', synthesis_focus: 'b' } };
  const driver = driverWithRunner(async () => JSON.stringify(shape));
  const decision = await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] });
  assert.deepEqual(decision, shape);
});

test('L4: prose prefix + one JSON decision is accepted when unambiguous', async () => {
  const driver = driverWithRunner(async () => `Sure, here is the plan:\n${JSON.stringify({ type: 'finish', output: 'ok' })}`);
  assert.equal((await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] })).output, 'ok');
});

test('L5: one JSON decision + prose suffix is accepted when unambiguous', async () => {
  const driver = driverWithRunner(async () => `${JSON.stringify({ type: 'finish', output: 'ok' })}\nLet me know if you need anything else!`);
  assert.equal((await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] })).output, 'ok');
});

test('L6: a single fenced JSON block is still explicitly accepted (Part F)', async () => {
  const shape = { type: 'finish', output: 'ok' };
  const driver = driverWithRunner(async () => '```json\n' + JSON.stringify(shape) + '\n```');
  const decision = await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] });
  assert.deepEqual(decision, shape);
});

test('L7: missing finish.output is still PM_DECISION_EMPTY_OUTPUT (M09)', async () => {
  const driver = driverWithRunner(async () => JSON.stringify({ type: 'finish' }));
  await assert.rejects(driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] }), (e) => e.code === 'PM_DECISION_EMPTY_OUTPUT');
});

test('L8: alternate "summary"/"result" keys instead of "output" are still rejected (M09/M06)', async () => {
  const driver = driverWithRunner(async () => JSON.stringify({ type: 'finish', summary: 'ok', result: { x: 1 } }));
  await assert.rejects(driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] }), (e) => e.code === 'PM_DECISION_EMPTY_OUTPUT');
});

test('L9: malformed JSON — including the exact live-observed "valid object + one stray trailing brace" shape — is still PM_DECISION_PARSE_FAILED', async () => {
  const validPart = JSON.stringify({ type: 'finish', output: 'council plan ready', data: { type: 'council_plan', participant_instructions: { p1: 'x' }, critique_focus: 'a', synthesis_focus: 'b' } });
  const driver = driverWithRunner(async () => `${validPart}}`); // exactly one extra trailing '}'
  await assert.rejects(driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] }), (e) => e.code === 'PM_DECISION_PARSE_FAILED');
});

test('L9b: forbidden fixes were NOT added — a stray trailing brace is never silently repaired, no matter how "close" the JSON is', async () => {
  // Regression guard: proves no brace-balancing/truncate-until-it-parses
  // heuristic crept in alongside the retry mechanism.
  const driver = driverWithRunner(async () => '{"type":"finish","output":"ok"}}}');
  await assert.rejects(driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] }), (e) => e.code === 'PM_DECISION_PARSE_FAILED');
});

// ---- Part I: sanitized parse diagnostics ----------------------------------

test('L18: a parse failure emits sanitized structural diagnostics, never the raw assistant text', async () => {
  const events = [];
  const observer = { start() {}, parser(ctx, extra) { events.push(extra); }, terminal() {} };
  const secretOutput = '{"type":"finish","output":"ok"}} token=SECRET-abc123-do-not-leak';
  const registry = new ProductionPmBackendRegistry({ probe: () => true, claudeBinary: 'claude', observer, claudeRunner: async () => ({ result: secretOutput }) });
  const driver = registry.resolve({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }, { project: PROJECT });
  await assert.rejects(driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] }));
  const parserEvent = events.find((e) => e.outcome === 'PM_DECISION_PARSE_FAILED');
  assert.ok(parserEvent);
  assert.equal(typeof parserEvent.bytes, 'number');
  assert.equal(typeof parserEvent.firstChar, 'string');
  assert.equal(typeof parserEvent.lastChar, 'string');
  assert.equal(typeof parserEvent.fullJson, 'boolean');
  assert.equal(typeof parserEvent.jsonFence, 'boolean');
  assert.equal(typeof parserEvent.prefixClass, 'string');
  assert.equal(parserEvent.prefixClass, 'NONE');
  assert.equal(parserEvent.suffixClass, 'UNKNOWN');
  const serialized = JSON.stringify(parserEvent);
  assert.equal(serialized.includes('SECRET'), false, 'raw assistant text (and any secret it might contain) is never in the diagnostic event');
  assert.equal(serialized.includes('token='), false);
});

// ---- Part G/H: council-step schema validation -----------------------------

function fakeProductionDriver(response) {
  return {
    name: 'fake',
    async decide() { return response; },
  };
}

function runnerFor(response, { participantProfileIds = ['p1', 'p2'] } = {}) {
  const resolveDriver = () => fakeProductionDriver(response);
  return new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
}

test('L10: chair_plan finish with no data at all fails as a council step (not silently successful)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok' });
  const outcome = await runner.run({ id: 's1', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /^COUNCIL_CHAIR_PLAN_INVALID:/);
});

test('L11: chair_plan with the wrong data.type fails', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok', data: { type: 'something_else' } });
  const outcome = await runner.run({ id: 's2', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /WRONG_DATA_TYPE/);
});

test('L12: chair_plan missing a required participant instruction fails', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x' }, critique_focus: 'a', synthesis_focus: 'b' } });
  const outcome = await runner.run({ id: 's3', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /MISSING_PARTICIPANT_INSTRUCTION:p2/);
});

test('L13: chair_plan with an extra/unknown participant instruction fails', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y', ghost: 'z' }, critique_focus: 'a', synthesis_focus: 'b' } });
  const outcome = await runner.run({ id: 's4', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /UNKNOWN_PARTICIPANT_INSTRUCTION:ghost/);
});

test('L14: chair_plan with an empty-string participant instruction fails', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: '   ' }, critique_focus: 'a', synthesis_focus: 'b' } });
  const outcome = await runner.run({ id: 's5', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /EMPTY_PARTICIPANT_INSTRUCTION:p2/);
});

test('L10b: a fully compliant chair_plan passes', async () => {
  const runner = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' }, critique_focus: 'a', synthesis_focus: 'b' } });
  const outcome = await runner.run({ id: 's6', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1', 'p2'] });
  assert.equal(outcome.finalResult.handoff.ok, true);
});

test('L15: participant_report schema validation (missing/wrong-type fields fail; compliant shape passes)', async () => {
  const bad = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r' } }); // missing risks/uncertainties arrays
  const badOutcome = await bad.run({ id: 'r1', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'p1', prompt: 'x' });
  assert.equal(badOutcome.finalResult.handoff.ok, false);
  assert.match(badOutcome.finalResult.handoff.reason, /^COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_RISKS/);

  const good = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: ['x'], uncertainties: [] } });
  const goodOutcome = await good.run({ id: 'r2', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'p1', prompt: 'x' });
  assert.equal(goodOutcome.finalResult.handoff.ok, true);
});

test('L16: participant_critique schema validation (missing/wrong-type fields fail; compliant shape passes)', async () => {
  const bad = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_critique', criticisms: ['c'], agreements: [] } }); // missing revised_recommendation/remaining_disagreements
  const badOutcome = await bad.run({ id: 'c1', kind: 'council_step', stepKind: 'participant_critique', round: 2, profileId: 'p1', prompt: 'x' });
  assert.equal(badOutcome.finalResult.handoff.ok, false);
  assert.match(badOutcome.finalResult.handoff.reason, /^COUNCIL_PARTICIPANT_CRITIQUE_INVALID:/);

  const good = runnerFor({ type: 'finish', output: 'ok', data: { type: 'council_critique', criticisms: ['c'], agreements: [], revised_recommendation: 'r', remaining_disagreements: [] } });
  const goodOutcome = await good.run({ id: 'c2', kind: 'council_step', stepKind: 'participant_critique', round: 2, profileId: 'p1', prompt: 'x' });
  assert.equal(goodOutcome.finalResult.handoff.ok, true);
});

test('L17: chair_synthesis schema validation (wrong data.type fails; compliant shape passes)', async () => {
  const bad = runnerFor({ type: 'finish', output: 'the synthesis', data: { type: 'not_a_synthesis' } });
  const badOutcome = await bad.run({ id: 'y1', kind: 'council_step', stepKind: 'chair_synthesis', round: 2, profileId: 'chair', prompt: 'x' });
  assert.equal(badOutcome.finalResult.handoff.ok, false);
  assert.match(badOutcome.finalResult.handoff.reason, /^COUNCIL_CHAIR_SYNTHESIS_INVALID:WRONG_DATA_TYPE/);

  const good = runnerFor({ type: 'finish', output: 'the synthesis', data: { type: 'council_synthesis' } });
  const goodOutcome = await good.run({ id: 'y2', kind: 'council_step', stepKind: 'chair_synthesis', round: 2, profileId: 'chair', prompt: 'x' });
  assert.equal(goodOutcome.finalResult.handoff.ok, true);
});

// ---- Retry: bounded, PM_DECISION_PARSE_FAILED-only ------------------------

test('retry: a PM_DECISION_PARSE_FAILED on the first attempt is retried exactly once, and a compliant second attempt succeeds', async () => {
  // Simulate a real PM_DECISION_PARSE_FAILED thrown by the production driver
  // (this is what createCliPmDriver's decide() actually throws — see
  // production-pm-backend-registry.mjs's parseDecision()).
  let attempt = 0;
  const flakyResolveDriver = () => ({
    name: 'fake',
    async decide() {
      attempt += 1;
      if (attempt === 1) { const e = new Error('bad'); e.code = 'PM_DECISION_PARSE_FAILED'; throw e; }
      return { type: 'finish', output: 'ok', data: { type: 'council_plan', participant_instructions: { p1: 'x' }, critique_focus: 'a', synthesis_focus: 'b' } };
    },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: flakyResolveDriver, project: PROJECT });
  const outcome = await runner.run({ id: 'retry1', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1'] });
  assert.equal(attempt, 2, 'exactly one retry happened');
  assert.equal(outcome.finalResult.handoff.ok, true);
});

test('retry: two consecutive PM_DECISION_PARSE_FAILED results in a failed step after exactly two attempts (bounded)', async () => {
  let attempt = 0;
  const resolveDriver = () => ({
    name: 'fake',
    async decide() { attempt += 1; const e = new Error('bad'); e.code = 'PM_DECISION_PARSE_FAILED'; throw e; },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run({ id: 'retry2', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1'] });
  assert.equal(attempt, 2, 'bounded to exactly two attempts, never more');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.match(outcome.finalResult.handoff.reason, /PM_DECISION_PARSE_FAILED/);
});

test('retry: a non-parse failure (e.g. empty output) is NOT retried — fails on the first attempt', async () => {
  let attempt = 0;
  const resolveDriver = () => ({
    name: 'fake',
    async decide() { attempt += 1; const e = new Error('bad'); e.code = 'PM_DECISION_EMPTY_OUTPUT'; throw e; },
  });
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: PROJECT });
  const outcome = await runner.run({ id: 'retry3', kind: 'council_step', stepKind: 'chair_plan', round: 0, profileId: 'chair', prompt: 'x', participantProfileIds: ['p1'] });
  assert.equal(attempt, 1, 'M09 (empty output) is a real compliance failure, never retried');
  assert.equal(outcome.finalResult.handoff.ok, false);
});
