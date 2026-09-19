import test from 'node:test';
import assert from 'node:assert/strict';

// DSH-ANTIGRAVITY-COUNCIL-PARTICIPANT-CONTRACT — regression tests for the
// exact live failure class COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS
// (T5 task-y2dkRWx6CIrY4mNulAVSk476ZxTlf52D, live1-antigravity-gemini-high:
// parseDecision() accepted a finish decision whose data.type was exactly
// council_report, but data.analysis was not a non-empty string). These tests
// pin: (1) the compliant shape still passes; (2) every MISSING_ANALYSIS
// variant fails closed with the typed reason; (3) the new content-free
// data_diagnostics distinguish absent/empty/renamed/non-string/mis-nested
// analysis WITHOUT ever carrying a field value (no fabrication, no salvage);
// (4) the parser itself preserves a valid nested analysis; (5) the prompt
// states the field-type contract explicitly.

import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner, dataShapeSummary } from '../src/pm/council/council-step-workflow-runner.mjs';
import { buildParticipantReportPrompt } from '../src/pm/council/council-prompts.mjs';

const PROJECT = { id: 'live1-local', repo_path: 'C:/repo' };
const SPEC_BASE = { kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: 'live1-antigravity-gemini-high', prompt: 'x' };

function fakeProductionDriver(response) {
  return { name: 'fake', async decide() { return response; } };
}

function runnerFor(response, { taskLog = null } = {}) {
  return new CouncilStepWorkflowRunner({
    resolveDriver: () => fakeProductionDriver(response),
    profileRegistry: { get: (id) => ({ id, product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
    ...(taskLog ? { taskLog } : {}),
  });
}

function compliantData(overrides = {}) {
  return { type: 'council_report', analysis: 'structured analysis', recommendation: 'pass', risks: [], uncertainties: [], ...overrides };
}

// ---- 1: the exact compliant Antigravity council_report shape PASSES --------

test('antigravity council_report with all required fields passes and preserves the nested analysis verbatim', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: compliantData() });
  const outcome = await runner.run({ id: 'ag-pass', ...SPEC_BASE });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.analysis, 'structured analysis');
  assert.equal(outcome.finalResult.handoff.recommendation, 'pass');
  assert.deepEqual(outcome.finalResult.handoff.risks, []);
  assert.deepEqual(outcome.finalResult.handoff.uncertainties, []);
  assert.equal(outcome.finalResult.handoff.data_diagnostics, undefined, 'no diagnostics on a validated step');
});

// ---- 2: MISSING_ANALYSIS typed failure + safe structural diagnostics -------

test('missing analysis -> typed MISSING_ANALYSIS failure; diagnostics report analysis absent (variant A)', async () => {
  const events = [];
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [] } }, { taskLog: { event: (type, fields) => events.push({ type, fields }) } });
  const outcome = await runner.run({ id: 'ag-missing', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  const diag = outcome.finalResult.handoff.data_diagnostics;
  assert.ok(diag, 'data_diagnostics persisted in the durable handoff');
  assert.equal(diag.data_present, true);
  assert.equal(diag.data_type, 'council_report');
  assert.equal(diag.fields.analysis, undefined, 'absent analysis appears in no field entry');
  assert.ok(diag.keys.includes('recommendation'));
  const failEvent = events.find((e) => e.type === 'PARTICIPANT_FAILED');
  assert.ok(failEvent, 'PARTICIPANT_FAILED carries the same diagnostics');
  assert.equal(failEvent.fields.data_diagnostics.data_type, 'council_report');
});

test('empty analysis -> typed MISSING_ANALYSIS failure; diagnostics report type string with length 0 (variant B)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: compliantData({ analysis: '' }) });
  const outcome = await runner.run({ id: 'ag-empty', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.type, 'string');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.length, 0);
});

test('whitespace-only analysis -> typed MISSING_ANALYSIS failure (contract requires non-empty)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: compliantData({ analysis: '   ' }) });
  const outcome = await runner.run({ id: 'ag-ws', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.length, 3, 'length is reported; the whitespace content itself is not');
});

test('analysis as an ARRAY -> typed MISSING_ANALYSIS failure; diagnostics report the non-string type (variant E-type)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: compliantData({ analysis: ['point one', 'point two'] }) });
  const outcome = await runner.run({ id: 'ag-array', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.type, 'array');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.length, 2);
});

test('analysis as an OBJECT -> typed MISSING_ANALYSIS failure; diagnostics report the nested keys (variant E-nested)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: compliantData({ analysis: { summary: 's', detail: 'd' } }) });
  const outcome = await runner.run({ id: 'ag-obj', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.type, 'object');
  assert.deepEqual(outcome.finalResult.handoff.data_diagnostics.fields.analysis.keys, ['summary', 'detail']);
});

// ---- 3: misplaced/renamed analysis -> still fail-closed, never salvaged ----

test('analysis renamed to a different key -> typed MISSING_ANALYSIS failure; diagnostics name the actual top-level keys (variant D)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: { type: 'council_report', findings: 'long analysis text', recommendation: 'pass', risks: [], uncertainties: [] } });
  const outcome = await runner.run({ id: 'ag-renamed', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.keys.includes('findings'), true);
  assert.equal(outcome.finalResult.handoff.data_diagnostics.keys.includes('analysis'), false);
  assert.equal(outcome.finalResult.handoff.analysis, undefined, 'renamed content is never copied into analysis');
});

test('analysis nested one level too deep (data.report.analysis) -> typed MISSING_ANALYSIS failure; diagnostics expose the wrapper key', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: { type: 'council_report', report: { analysis: 'deep', recommendation: 'pass', risks: [], uncertainties: [] }, recommendation: 'pass', risks: [], uncertainties: [] } });
  const outcome = await runner.run({ id: 'ag-nested', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.deepEqual(outcome.finalResult.handoff.data_diagnostics.fields.report.keys, ['analysis', 'recommendation', 'risks', 'uncertainties'], 'mis-nested shape is visible at exactly one diagnostic level');
  assert.equal(outcome.finalResult.handoff.analysis, undefined, 'nested content is never promoted into analysis');
});

// ---- 4: no silent fabrication ---------------------------------------------

test('no silent fabrication: a non-empty output never substitutes for a missing analysis', async () => {
  const longOutput = 'This output text could look like an analysis but is NOT one.';
  const runner = runnerFor({ type: 'finish', output: longOutput, data: { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [] } });
  const outcome = await runner.run({ id: 'ag-fabricate', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.analysis, undefined);
  assert.equal(outcome.finalResult.output, '', 'failed step carries no output');
  // The output LENGTH is diagnostic evidence; the output VALUE never enters the diagnostics.
  assert.equal(outcome.finalResult.handoff.data_diagnostics.output_length, longOutput.length);
  assert.equal(JSON.stringify(outcome.finalResult.handoff.data_diagnostics).includes('could look like an analysis'), false);
});

// ---- 5: diagnostics are content-free (safe-diagnostics contract) -----------

test('data_diagnostics never carry any field VALUE — only keys, types, and lengths', async () => {
  const analysisValue = 'SECRET-ANALYSIS-CONTENT-do-not-leak-12345';
  // Valid analysis but missing risks -> the step fails at MISSING_RISKS, so
  // the diagnostics capture the full data shape including the secret-valued
  // analysis string — which must appear only as a length.
  const runner = runnerFor({ type: 'finish', output: 'SECRET-OUTPUT-VALUE-67890', data: { type: 'council_report', analysis: analysisValue, recommendation: 'SECRET-REC-VALUE', uncertainties: [] } });
  const outcome = await runner.run({ id: 'ag-safe', ...SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_RISKS');
  const serialized = JSON.stringify(outcome.finalResult.handoff.data_diagnostics);
  assert.equal(serialized.includes(analysisValue), false, 'string field values never appear, only their lengths');
  assert.equal(serialized.includes('SECRET-OUTPUT-VALUE'), false, 'output value never appears, only its length');
  assert.equal(serialized.includes('SECRET-REC-VALUE'), false);
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.length, analysisValue.length);
  assert.equal(outcome.finalResult.handoff.data_diagnostics.output_length, 'SECRET-OUTPUT-VALUE-67890'.length);
});

// ---- 6: the parser itself preserves a valid nested analysis ----------------

test('parser must preserve valid nested analysis: full createCliPmDriver decide() keeps data.analysis intact', async () => {
  const shape = { type: 'finish', output: 'one-line summary', data: compliantData() };
  const driver = createCliPmDriver({
    profile: { id: 'live1-antigravity-gemini-high', product: 'antigravity' },
    project: PROJECT,
    run: async () => JSON.stringify(shape),
  });
  const decision = await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [], capabilities: ['finish'] });
  assert.deepEqual(decision, shape, 'parseDecision() is lossless for the nested council_report payload');
});

test('parser must preserve valid nested analysis even through the unambiguous-salvage path (prose prefix)', async () => {
  const shape = { type: 'finish', output: 'one-line summary', data: compliantData() };
  const driver = createCliPmDriver({
    profile: { id: 'live1-antigravity-gemini-high', product: 'antigravity' },
    project: PROJECT,
    run: async () => `Here is my report:\n${JSON.stringify(shape)}`,
  });
  const decision = await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [], capabilities: ['finish'] });
  assert.equal(decision.data.analysis, 'structured analysis', 'salvage extraction never drops the nested analysis field');
});

// ---- 7: dataShapeSummary unit behavior ------------------------------------

test('dataShapeSummary: absent/undefined data is reported honestly', () => {
  const missing = dataShapeSummary(undefined);
  assert.equal(missing.data_present, false);
  assert.equal(missing.data_value_type, 'undefined');
  const nulled = dataShapeSummary(null);
  assert.equal(nulled.data_present, false);
  assert.equal(nulled.data_value_type, 'null');
  const arrayed = dataShapeSummary(['nope']);
  assert.equal(arrayed.data_present, false);
  assert.equal(arrayed.data_value_type, 'array');
});

test('dataShapeSummary: bounded key list with truncation marker', () => {
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`k${i}`] = 'x';
  const summary = dataShapeSummary(many);
  assert.equal(summary.key_count, 40);
  assert.equal(summary.keys.length, 32);
  assert.equal(summary.keys_truncated, true);
});

// ---- 8: prompt states the field-type contract explicitly ------------------

test('buildParticipantReportPrompt states the strict field-type contract (analysis/recommendation must be single non-empty strings)', () => {
  const prompt = buildParticipantReportPrompt({ ownerTask: 'task', constraints: [], instructions: 'focus', participantProfileId: 'p1' });
  assert.match(prompt, /"type":"council_report"/);
  assert.match(prompt, /"analysis"/);
  assert.match(prompt, /must each be ONE non-empty JSON string/);
  assert.match(prompt, /never an array, an object, null, or omitted/);
  assert.match(prompt, /never renamed and never nested inside another key/);
});

test('buildParticipantReportPrompt: the field-type contract is present for BOTH the plain and the workspace-read evidence shape', () => {
  const plain = buildParticipantReportPrompt({ ownerTask: 't', constraints: [], instructions: 'i', participantProfileId: 'p1' });
  const read = buildParticipantReportPrompt({ ownerTask: 't', constraints: [], instructions: 'i', participantProfileId: 'p1', workspaceMode: 'TEXT_ONLY', evidencePacketText: 'packet' });
  assert.doesNotMatch(plain, /"evidence"/, 'the plain NONE-requirement shape stays byte-for-byte unchanged apart from the type rule');
  assert.match(read, /"evidence"/, 'the TEXT_ONLY shape still carries the evidence field schema');
  for (const prompt of [plain, read]) {
    assert.match(prompt, /must each be ONE non-empty JSON string/);
  }
});
