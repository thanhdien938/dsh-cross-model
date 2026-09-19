import test from 'node:test';
import assert from 'node:assert/strict';

// DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING — regressions for (A) the
// terminal Council contract capsule appended at the FINAL renderRequest()
// boundary, and (B) the ONE bounded semantic repair for read-only Council/
// Debate participant steps. Live failure trail being reproduced:
// MISSING_ANALYSIS -> NO_VALID_EVIDENCE_ENTRIES -> WRONG_DATA_TYPE:missing,
// all with healthy transport/parseDecision under ~248KB WORKSPACE_READ
// prompts. Validator codes, fail-closed behavior, and SINGLE requests are
// byte-for-byte unchanged.

import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { buildParticipantSemanticRepairPrompt } from '../src/pm/council/council-prompts.mjs';

const PROJECT = { id: 'live1-local', repo_path: 'C:/repo' };
const HASH_A = 'a'.repeat(64);
const PATH_A = 'src/pm/council/council-step-workflow-runner.mjs';
const PATH_B = 'README.md';
const MANIFEST = [PATH_A, PATH_B];
const HASHES = { [PATH_A]: HASH_A, [PATH_B]: 'b'.repeat(64) };
const READ_SPEC_BASE = {
  kind: 'council_step', stepKind: 'participant_report', round: 1,
  profileId: 'live1-antigravity-gemini-3-8-flash-high', prompt: 'x',
  workspaceRequirement: 'READ', workspaceEvidencePaths: MANIFEST, workspaceEvidenceHashes: HASHES,
};
const VALID_EVIDENCE = [
  { path: PATH_A, sha256: HASH_A, line_start: 1, line_end: 2, claim: 'supports a claim' },
  { path: PATH_B, sha256: HASHES[PATH_B], line_start: null, line_end: null, claim: 'supports another' },
];
const VALID_DATA = { type: 'council_report', analysis: 'structured analysis', recommendation: 'pass', risks: [], uncertainties: [], evidence: VALID_EVIDENCE };

function driverWithRunner(run) {
  return createCliPmDriver({ profile: { id: 'live1-antigravity-gemini-3-8-flash-high', product: 'antigravity' }, project: PROJECT, run });
}

// ---- TERMINAL CAPSULE ------------------------------------------------------

test('capsule 1-2: the participant_report capsule is appended AFTER Request context and History and is the final rendered text', async () => {
  let captured = null;
  const driver = driverWithRunner(async (prompt) => { captured = prompt; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: { id: 'r', objective: 'the task text', context: { council: true, stepKind: 'participant_report', profileId: 'p1', participantProfileIds: [] } }, history: [{ role: 'x', text: 'y' }], capabilities: ['finish'] });
  const historyIndex = captured.lastIndexOf('History: [{"role":"x","text":"y"}]');
  assert.ok(historyIndex > 0, 'History section rendered');
  const capsuleIndex = captured.indexOf('FINAL COUNCIL PARTICIPANT CONTRACT');
  assert.ok(capsuleIndex > historyIndex, 'capsule comes AFTER Request context and History');
  assert.equal(captured.slice(capsuleIndex).trim(), captured.slice(capsuleIndex), 'capsule is terminal (only whitespace after it)');
  assert.match(captured.slice(capsuleIndex), /"type":"finish","output":"<non-empty string>","data":\{"type":"council_report","analysis":"<ONE non-empty string>","recommendation":"<ONE non-empty string>","risks":\[\],"uncertainties":\[\],"evidence":\[\]\}/);
});

test('capsule 3-4: exact council_report discriminator and field-type contract are included', async () => {
  let captured = null;
  const driver = driverWithRunner(async (prompt) => { captured = prompt; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: { id: 'r', objective: 't', context: { council: true, stepKind: 'participant_report' } }, history: [], capabilities: ['finish'] });
  assert.match(captured, /"data\.type" MUST be exactly "council_report" — never omitted/);
  assert.match(captured, /"analysis" and "recommendation" must each be ONE non-empty JSON string/);
  assert.match(captured, /never renamed, omitted, nested, stringified, or moved into "output"/);
  assert.match(captured, /exactly ONE DSH decision object and nothing else/);
});

test('capsule 5: SINGLE renders byte-for-byte unchanged — no capsule, History is terminal', async () => {
  let captured = null;
  const driver = driverWithRunner(async (prompt) => { captured = prompt; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: { id: 'r', objective: 'plain single task' }, history: [], capabilities: ['finish'] });
  assert.equal(captured.includes('FINAL COUNCIL PARTICIPANT CONTRACT'), false);
  assert.ok(captured.endsWith('History: []'), 'History remains the terminal text for SINGLE');
  // and the universal contract sections are untouched
  assert.match(captured, /"data":\{"\.\.\.optional\.\.\.":true\}/);
});

test('capsule 6: debate_response receives the source-derived debate_response capsule; critique receives the council_critique capsule', async () => {
  let debatePrompt = null;
  let critiquePrompt = null;
  let call = 0;
  const driver = driverWithRunner(async (prompt) => { if (call++ === 0) debatePrompt = prompt; else critiquePrompt = prompt; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: { id: 'r1', objective: 't', context: { council: true, stepKind: 'debate_response' } }, history: [], capabilities: ['finish'] });
  await driver.decide({ turn: 0, request: { id: 'r2', objective: 't', context: { council: true, stepKind: 'participant_critique' } }, history: [], capabilities: ['finish'] });
  assert.match(debatePrompt, /"data\.type" MUST be exactly "debate_response" — never omitted/);
  assert.match(debatePrompt, /"response" must be ONE non-empty JSON string/);
  assert.equal(debatePrompt.includes('"council_report"'), false, 'no invented council_report fields in the debate capsule');
  assert.match(critiquePrompt, /"data\.type" MUST be exactly "council_critique" — never omitted/);
  assert.match(critiquePrompt, /"revised_recommendation" must be ONE non-empty JSON string/);
  assert.match(critiquePrompt, /"criticisms", "agreements", and "remaining_disagreements" must each be a JSON array/);
});

// DSH-CHAIR-PLAN-JSON-INVALID (2026-09-09): a chair_plan step that DOES carry
// the owner-selected participant set now gets its own terminal CHAIR contract
// (tests/chair-plan-json-invalid-contract.test.mjs). The chair case below — a
// chair_plan with NO participant set — still renders unchanged, because DSH
// refuses to state a participant-key contract it cannot derive. No PARTICIPANT
// capsule ever reaches a chair step, which is what this regression guards.
test('capsule 7: non-Council requests (and a chair step with no owner-selected participant set) get no capsule', async () => {
  let plain = null; let chair = null; let singleWithContext = null;
  let call = 0;
  const driver = driverWithRunner(async (prompt) => { if (call++ === 0) plain = prompt; else if (call === 2) chair = prompt; else singleWithContext = prompt; return '{"type":"finish","output":"ok"}'; });
  await driver.decide({ turn: 0, request: { id: 'r1', objective: 't' }, history: [], capabilities: ['finish'] });
  await driver.decide({ turn: 0, request: { id: 'r2', objective: 't', context: { council: true, stepKind: 'chair_plan' } }, history: [], capabilities: ['finish'] });
  await driver.decide({ turn: 0, request: { id: 'r3', objective: 't', context: { stepKind: 'participant_report' } }, history: [], capabilities: ['finish'] });
  for (const p of [plain, chair, singleWithContext]) {
    assert.equal(p.includes('FINAL COUNCIL PARTICIPANT CONTRACT'), false);
    assert.ok(p.endsWith('History: []'));
  }
});

// ---- SEMANTIC REPAIR -------------------------------------------------------

function repairRunner(handlers, { taskLog = null } = {}) {
  // handlers: array of decide() return values / thrown errors, one per call.
  let call = 0;
  const calls = [];
  const resolveDriver = () => ({
    name: 'fake',
    async decide(input) {
      calls.push({ objective: input?.request?.objective ?? null });
      const next = handlers[Math.min(call, handlers.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(calls[calls.length - 1].objective) : next;
    },
  });
  return { runner: new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry: { get: (id) => ({ id, product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' }) }, project: PROJECT, ...(taskLog ? { taskLog } : {}) }), calls };
}

const typedError = (code) => { const e = new Error(code); e.code = code; return e; };

test('repair 8: valid first response -> no repair (exactly one decide call, no repair fields)', async () => {
  const { runner, calls } = repairRunner([{ type: 'finish', output: 'ok', data: VALID_DATA }]);
  const outcome = await runner.run({ id: 'r-ok', ...READ_SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(calls.length, 1, 'no repair decide call');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);
});

test('repair 9: missing data.type -> exactly one repair -> valid -> PASS, original failure durably retained', async () => {
  const fixed = { ...VALID_DATA, type: 'council_report' };
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, type: undefined } }, // data.type omitted entirely
    { type: 'finish', output: 'ok', data: fixed },
  ]);
  const outcome = await runner.run({ id: 'r-type', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2, 'exactly one repair decide call');
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.analysis, 'structured analysis');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, true);
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:WRONG_DATA_TYPE:missing');
  // the repair prompt carried the prior normalized content + typed reason, NOT the workspace packet
  assert.match(calls[1].objective, /WRONG_DATA_TYPE:missing/);
  assert.match(calls[1].objective, /structured analysis/);
  assert.equal(calls[1].objective.includes('Repository evidence packet'), false, 'the ~248KB packet is never re-sent in the repair');
});

test('repair 10: missing analysis -> exactly one repair -> valid -> PASS', async () => {
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [], evidence: VALID_EVIDENCE } },
    { type: 'finish', output: 'ok', data: VALID_DATA },
  ]);
  const outcome = await runner.run({ id: 'r-analysis', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2);
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, true);
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
});

test('repair 11: invalid evidence (all entries outside the manifest) -> exactly one repair -> valid -> PASS', async () => {
  const badEvidence = Array.from({ length: 3 }, (_, i) => ({ path: `src/unknown-${i}.mjs`, sha256: 'f'.repeat(64), line_start: null, line_end: null, claim: 'c' }));
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, evidence: badEvidence } },
    { type: 'finish', output: 'ok', data: VALID_DATA },
  ]);
  const outcome = await runner.run({ id: 'r-evidence', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2);
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, true);
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:NO_VALID_EVIDENCE_ENTRIES');
  assert.deepEqual(outcome.finalResult.handoff.original_failure.evidence_diagnostics.drop_reasons, { EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST: 3 });
});

test('repair 12-13: repair still invalid -> participant FAILED, never more than one repair', async () => {
  const stillInvalid = { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [], evidence: VALID_EVIDENCE };
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, analysis: '' } },
    { type: 'finish', output: 'ok', data: stillInvalid }, // repaired attempt STILL missing analysis
  ]);
  const outcome = await runner.run({ id: 'r-still-bad', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2, 'exactly one repair, no third attempt');
  assert.equal(outcome.finalResult.status, 'failed');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, true);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.repaired_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.ok(outcome.finalResult.handoff.repaired_failure.data_diagnostics, 'repaired diagnostics durably observable');
  assert.equal(outcome.finalResult.output, '');
});

test('repair 14: transport failure -> NO repair', async () => {
  const { runner, calls } = repairRunner([typedError('ANTIGRAVITY_RUN_FAILED')]);
  const outcome = await runner.run({ id: 'r-transport', ...READ_SPEC_BASE });
  assert.equal(calls.length, 1, 'transport failures never trigger a semantic repair');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'ANTIGRAVITY_RUN_FAILED');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);
});

test('repair 15: parse failure -> NO semantic repair (bounded generic parse retry only)', async () => {
  const { runner, calls } = repairRunner([typedError('PM_DECISION_PARSE_FAILED'), typedError('PM_DECISION_PARSE_FAILED')]);
  const outcome = await runner.run({ id: 'r-parse', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2, 'only the pre-existing bounded parse retry ran; no third semantic-repair call');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'PM_DECISION_PARSE_FAILED');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);
});

test('repair 16: timeout/cancel -> NO repair', async () => {
  for (const [i, code] of ['ANTIGRAVITY_TIMEOUT', 'PM_BACKEND_ABORTED'].entries()) {
    const { runner, calls } = repairRunner([typedError(code)]);
    const outcome = await runner.run({ id: `r-timeout-${i}`, ...READ_SPEC_BASE });
    assert.equal(calls.length, 1);
    assert.equal(outcome.finalResult.handoff.reason, code);
    assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);
  }
});

test('repair 17: mutation-capable (implementation participant) step -> NO repair', async () => {
  const { runner, calls } = repairRunner([{ type: 'finish', output: 'ok', data: { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [] } }]);
  const outcome = await runner.run({ id: 'r-impl', ...READ_SPEC_BASE, isImplementationParticipant: true });
  assert.equal(calls.length, 1, 'implementation (mutation-capable) steps are never semantically repaired');
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);
});

test('repair 18-19: the repair prompt performs no workspace reread and invokes no tools (packet absent, read-only stated)', async () => {
  const objectives = [];
  const runner2 = new CouncilStepWorkflowRunner({
    resolveDriver: () => ({ name: 'fake', async decide(input) { objectives.push(input?.request?.objective ?? ''); return objectives.length === 1 ? { type: 'finish', output: 'ok', data: { ...VALID_DATA, type: undefined } } : { type: 'finish', output: 'ok', data: VALID_DATA }; } }),
    profileRegistry: { get: (id) => ({ id, product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
  });
  const outcome = await runner2.run({ id: 'r-noread', ...READ_SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(objectives.length, 2, 'one original + one repair decide call');
  const repairText = objectives[1];
  assert.match(repairText, /REPAIR REQUEST/);
  assert.match(repairText, /read-only, tool-free repair turn/);
  assert.match(repairText, /do not inspect the repository, do not use tools, do not perform Git operations/);
  assert.equal(repairText.includes('Repository evidence packet'), false, 'no packet re-send (no workspace reread by proxy)');
});

test('repair 20: no fabricated fields — the repaired handoff content is exactly what the MODEL returned', async () => {
  const modelAnalysis = 'model-authored analysis text';
  const { runner } = repairRunner([
    { type: 'finish', output: 'ok', data: { type: 'council_report', recommendation: 'pass', risks: [], uncertainties: [], evidence: VALID_EVIDENCE } },
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, analysis: modelAnalysis } },
  ]);
  const outcome = await runner.run({ id: 'r-nofab', ...READ_SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.analysis, modelAnalysis, 'analysis comes from the model, never from DSH');
  // the repair prompt builder itself never injects content DSH authored
  const prompt = buildParticipantSemanticRepairPrompt({ stepKind: 'participant_report', reason: 'X', dataDiagnostics: {}, priorData: { analysis: modelAnalysis } });
  assert.match(prompt, new RegExp(modelAnalysis.slice(0, 12)));
  assert.equal(/DSH recommends|DSH analysis|generated by DSH/.test(prompt), false);
});

test('repair 21-23: original validator reason + repair facts are durably observable; reason codes unchanged; task-log carries the repair trail', async () => {
  const events = [];
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, analysis: '' } },
    { type: 'finish', output: 'ok', data: { ...VALID_DATA, analysis: '   ' } },
  ], { taskLog: { event: (type, fields) => events.push({ type, fields }) } });
  const outcome = await runner.run({ id: 'r-durable', ...READ_SPEC_BASE });
  assert.equal(calls.length, 2);
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS', 'exact validator reason code unchanged');
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.repaired_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, true);
  const started = events.find((e) => e.type === 'PARTICIPANT_SEMANTIC_REPAIR');
  const result = events.find((e) => e.type === 'PARTICIPANT_SEMANTIC_REPAIR_RESULT');
  assert.ok(started, 'repair start logged');
  assert.equal(started.fields.retry_kind, 'SEMANTIC_REPAIR');
  assert.equal(started.fields.original_reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  assert.ok(result, 'repair result logged');
  assert.equal(result.fields.ok, false);
  const failed = events.find((e) => e.type === 'PARTICIPANT_FAILED');
  assert.ok(failed);
  assert.equal(failed.fields.semantic_repair_used, true);
  assert.equal(failed.fields.original_reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
  // diagnostics stay content-free through the whole repair trail
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('structured analysis'), false);
});

test('repair: debate_response steps are repair-eligible with their exact contract code', async () => {
  const debateSpec = { kind: 'council_step', stepKind: 'debate_response', round: 2, profileId: 'live1-antigravity-gemini-3-8-flash-high', prompt: 'x' };
  const { runner, calls } = repairRunner([
    { type: 'finish', output: 'ok', data: { type: 'debate_response', response: '' } },
    { type: 'finish', output: 'ok', data: { type: 'debate_response', response: 'the response' } },
  ]);
  const outcome = await runner.run({ id: 'r-debate', ...debateSpec });
  assert.equal(calls.length, 2);
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.response, 'the response');
  assert.equal(outcome.finalResult.handoff.original_failure.reason, 'COUNCIL_DEBATE_RESPONSE_INVALID:MISSING_RESPONSE');
});

test('repair: NON_FINISH_DECISION and EMPTY_OUTPUT are NOT semantically repaired (structurally outside the COUNCIL_ reason family)', async () => {
  const { runner, calls } = repairRunner([{ type: 'workflow', spec: { steps: [] } }]);
  const outcome = await runner.run({ id: 'r-nonfinish', ...READ_SPEC_BASE });
  assert.equal(calls.length, 1);
  assert.equal(outcome.finalResult.handoff.reason, 'NON_FINISH_DECISION:workflow');
  assert.equal(outcome.finalResult.handoff.semantic_repair_used, undefined);

  const { runner: runner2, calls: calls2 } = repairRunner([{ type: 'finish', output: '   ' }]);
  const outcome2 = await runner2.run({ id: 'r-empty', ...READ_SPEC_BASE });
  assert.equal(calls2.length, 1);
  assert.equal(outcome2.finalResult.handoff.reason, 'EMPTY_OUTPUT');
  assert.equal(outcome2.finalResult.handoff.semantic_repair_used, undefined);
});
