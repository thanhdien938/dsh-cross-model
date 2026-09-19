// PARSER-0 — truthful layered diagnostics: mandatory error-layer fixtures.
//
// Entirely OFFLINE: no provider, CLI, network or process execution — every
// case uses dependency-injected stub runners / fake fetch implementations /
// in-memory envelopes. PARSER-0 is observability-only: every assertion here
// checks the NEW typed diagnostic facts BESIDE the UNCHANGED public error
// codes and UNCHANGED acceptance behavior.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCliPmDriver, ProductionPmBackendError } from '../src/pm/production-pm-backend-registry.mjs';
import {
  PARSER_0_DIAGNOSTIC_VERSION,
  PARSER_0_LAYERS,
  PARSER_0_REQUEST_PHASES,
  buildLayeredDiagnostic,
  executionFailureDiagnosticFromError,
  computeDenominatorCounters,
} from '../src/pm/parser-0-diagnostics.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';
import { runApiBackendRequest } from '../src/pm/api-backend/api-backend-adapter.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { ApiBackendError, API_ERROR_CODES } from '../src/pm/api-backend/api-backend-errors.mjs';
import { normalizeChatCompletionResponse, sendOpenAiChatCompletion } from '../src/pm/api-backend/api-openai-chat-protocol.mjs';
import { AntigravityCliError, extractAntigravityAssistantText, summarizeAntigravityCliRun } from '../src/session/antigravity-cli-session-bridge.mjs';

const PROFILE = { id: 'parser0-profile', product: 'codex', model: null };
const PROJECT = { id: 'parser0-project', repo_path: 'C:/repo' };
const INPUT = { request: { id: 'req-parser-0', objective: 'internal objective text', context: {} }, turn: 0, history: [] };

function driverFor(output, { observer = capturingObserver() } = {}) {
  return { driver: createCliPmDriver({ profile: PROFILE, project: PROJECT, observer, run: async () => output }), events: observer.events };
}
function driverThrowing(errorFactory) {
  const observer = capturingObserver();
  const driver = createCliPmDriver({ profile: PROFILE, project: PROJECT, observer, run: async () => { throw errorFactory(); } });
  return { driver, events: observer.events };
}
function capturingObserver() {
  const records = { events: [] };
  return Object.assign(() => {}, records, {
    events: records.events,
    layeredDiagnostic: (ctx, diagnostic) => records.events.push(diagnostic),
  });
}
const lastDiagnostic = (events) => events.at(-1) ?? null;

// ---------------------------------------------------------------------------
// Module shape: versioned, bounded, content-free
// ---------------------------------------------------------------------------

test('the diagnostic shape is versioned, fixed, JSON-serializable and content-free', () => {
  const diagnostic = buildLayeredDiagnostic({ executionState: 'ERROR', parserAttempted: false, parserState: 'NOT_ATTEMPTED' });
  assert.equal(diagnostic.diagnostic_version, PARSER_0_DIAGNOSTIC_VERSION);
  assert.equal(Object.isFrozen(diagnostic), true);
  const expectedKeys = ['diagnostic_version', 'execution_state', 'terminal_state', 'terminal_status', 'terminal_response_present', 'terminal_response_bytes', 'extraction_state', 'assistant_output_present', 'assistant_output_bytes', 'parser_attempted', 'parser_state', 'parse_error_code', 'parse_subreason', 'pm_contract_state', 'step_validation_state', 'provider_http_status', 'finish_reason', 'structured_output_requested', 'structured_output_present', 'attempt_ordinal', 'request_phase', 'execution_error_code', 'primary_layer'];
  assert.deepEqual(Object.keys(diagnostic), expectedKeys);
  for (const value of Object.values(diagnostic)) assert.equal(['boolean', 'number', 'string'].includes(typeof value) || value === null, true, 'only bounded scalars, never raw content');
  assert.doesNotThrow(() => JSON.stringify(diagnostic));
});

test('unknown facts stay null and are never inferred; invalid enum values are rejected', () => {
  const diagnostic = buildLayeredDiagnostic({});
  for (const value of Object.values(diagnostic)) assert.equal(value === null || value === PARSER_0_DIAGNOSTIC_VERSION, true);
  assert.equal(buildLayeredDiagnostic({ parserState: 'MAYBE' }).parser_state, null);
  assert.equal(buildLayeredDiagnostic({ requestPhase: 'SOMEDAY' }).request_phase, null);
});

test('denominator counters are computed deterministically from per-attempt facts', () => {
  const counters = computeDenominatorCounters([
    buildLayeredDiagnostic({ executionState: 'SUCCESS', terminalState: 'SUCCESS', assistantOutputPresent: true, assistantOutputBytes: 10, parserAttempted: true, parserState: 'PASS', pmContractState: 'PASS' }),
    buildLayeredDiagnostic({ executionState: 'ERROR', terminalState: 'ERROR', assistantOutputPresent: false, assistantOutputBytes: 0, parserAttempted: false, parserState: 'NOT_ATTEMPTED' }),
    buildLayeredDiagnostic({ executionState: 'SUCCESS', terminalState: 'SUCCESS', assistantOutputPresent: true, assistantOutputBytes: 5, parserAttempted: true, parserState: 'FAIL', parseErrorCode: 'PM_DECISION_PARSE_FAILED' }),
  ]);
  assert.deepEqual(counters, { ALL_CAPTURED: 3, PROVIDER_TERMINAL_SUCCESS: 2, PROVIDER_TERMINAL_ERROR: 1, ASSISTANT_OUTPUT_PRESENT: 2, ASSISTANT_OUTPUT_ABSENT: 1, PARSER_ATTEMPTED: 2, PARSER_PASS: 1, PARSER_FAIL: 1, PARSER_NOT_ATTEMPTED: 1, PM_CONTRACT_PASS: 1, PM_CONTRACT_FAIL: 0, STEP_VALIDATION_PASS: 0, STEP_VALIDATION_FAIL: 0 });
});

// ---------------------------------------------------------------------------
// Cases 1-4: successful provider execution + the four core output classes
// ---------------------------------------------------------------------------

test('1. successful provider + valid raw JSON: parser attempted and PASSED', async () => {
  const { driver, events } = driverFor('{"type":"finish","output":"ok"}');
  const decision = await driver.decide(INPUT);
  assert.equal(decision.type, 'finish');
  const diagnostic = lastDiagnostic(events);
  assert.equal(diagnostic.execution_state, 'SUCCESS');
  assert.equal(diagnostic.assistant_output_present, true);
  assert.equal(diagnostic.parser_attempted, true);
  assert.equal(diagnostic.parser_state, 'PASS');
  assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.PARSER);
  assert.equal(diagnostic.pm_contract_state, 'NOT_EVALUATED', 'parseDecision is NOT the full PM contract validator');
});

test('2. successful provider + fenced JSON: still PASS, with acceptance unchanged', async () => {
  const { driver, events } = driverFor('```json\n{"type":"finish","output":"ok"}\n```');
  const decision = await driver.decide(INPUT);
  assert.equal(decision.output, 'ok');
  const diagnostic = lastDiagnostic(events);
  assert.equal(diagnostic.parser_attempted, true);
  assert.equal(diagnostic.parser_state, 'PASS');
});

test('3. successful provider + malformed JSON: parser attempted and FAILED with the stable public code', async () => {
  const { driver, events } = driverFor('{"type":"finish","output":"ok"}}');
  await assert.rejects(driver.decide(INPUT), (error) => {
    assert.equal(error.code, 'PM_DECISION_PARSE_FAILED', 'public error code unchanged');
    const diagnostic = error.layeredDiagnostic;
    assert.equal(diagnostic.execution_state, 'SUCCESS', 'the provider execution itself succeeded');
    assert.equal(diagnostic.assistant_output_present, true, 'assistant output existed');
    assert.equal(diagnostic.parser_attempted, true, 'parseDecision really was called');
    assert.equal(diagnostic.parser_state, 'FAIL');
    assert.equal(diagnostic.parse_error_code, 'PM_DECISION_PARSE_FAILED');
    assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.PARSER);
    return true;
  });
  assert.equal(lastDiagnostic(events).parser_state, 'FAIL');
});

test('4. successful provider + truncated JSON: parser attempted and FAILED, not a provider failure', async () => {
  const { driver } = driverFor('{"type":"finish","output":"ok"');
  await assert.rejects(driver.decide(INPUT), (error) => {
    assert.equal(error.code, 'PM_DECISION_PARSE_FAILED');
    assert.equal(error.layeredDiagnostic.parser_attempted, true);
    assert.equal(error.layeredDiagnostic.parser_state, 'FAIL');
    assert.equal(error.layeredDiagnostic.execution_state, 'SUCCESS');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Cases 5-8: API transport failures — execution layer, parser never attempted
// ---------------------------------------------------------------------------

const PROVIDER = validateProviderEntry('parser0-provider', { protocol: 'openai-chat', base_url: 'https://parser0.invalid/api/v1', api_key_env: 'DSH_PARSER0_TEST_KEY' });
const API_ENV = { DSH_PARSER0_TEST_KEY: 'not-a-real-secret' };

async function apiFailure(fetchImpl, { timeoutMs } = {}) {
  const observed = [];
  let thrown = null;
  try {
    await runApiBackendRequest({ providerId: 'parser0-provider', model: 'parser0-model', prompt: 'internal prompt text', providers: { 'parser0-provider': PROVIDER }, env: API_ENV, fetchImpl, timeoutMs, observe: (method, payload) => observed.push({ method, payload }) });
  } catch (error) { thrown = error; }
  assert.ok(thrown, 'expected a typed API failure');
  const diagnostic = executionFailureDiagnosticFromError(thrown, { structuredOutputRequested: false, attemptOrdinal: 0 });
  return { thrown, diagnostic, observed };
}

test('5. HTTP 402: execution failure, parser NOT attempted — never a parse failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, text: async () => '{"error":{"message":"billing"}}' });
  const { thrown, diagnostic } = await apiFailure(fetchImpl);
  assert.equal(thrown.code, 'API_BILLING_FAILED', 'public error code preserved');
  assert.equal(diagnostic.execution_state, 'ERROR');
  assert.equal(diagnostic.terminal_state, 'ERROR');
  assert.equal(diagnostic.provider_http_status, 402);
  assert.equal(diagnostic.assistant_output_present, false);
  assert.equal(diagnostic.parser_attempted, false);
  assert.equal(diagnostic.parser_state, 'NOT_ATTEMPTED');
  assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
  assert.equal(diagnostic.execution_error_code, 'API_BILLING_FAILED');
});

test('6. HTTP 403: execution failure, parser NOT attempted — never an extractor defect', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"forbidden"}}' });
  const { thrown, diagnostic } = await apiFailure(fetchImpl);
  assert.equal(thrown.code, 'API_FORBIDDEN');
  assert.equal(diagnostic.provider_http_status, 403);
  assert.equal(diagnostic.parser_attempted, false);
  assert.equal(diagnostic.parser_state, 'NOT_ATTEMPTED');
  assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
});

test('7. provider timeout: typed API_TIMEOUT with assistant output absent, parser NOT attempted', async () => {
  const fetchImpl = (url, { signal } = {}) => new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))); });
  const { thrown, diagnostic } = await apiFailure(fetchImpl, { timeoutMs: 25 });
  assert.equal(thrown.code, 'API_TIMEOUT');
  assert.equal(thrown.assistantOutputPresent, false);
  assert.equal(thrown.terminationRequestedByDsh, true, 'timeout ownership unchanged');
  assert.equal(diagnostic.execution_state, 'ERROR');
  assert.equal(diagnostic.assistant_output_present, false);
  assert.equal(diagnostic.parser_attempted, false);
  assert.equal(diagnostic.parser_state, 'NOT_ATTEMPTED');
  assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
});

test('8. API body-read abort is diagnostically distinguishable from a connect/fetch failure — with timeout/retry semantics unchanged', async () => {
  const bodyAbort = new Error('body read aborted');
  bodyAbort.name = 'AbortError';
  const { thrown, diagnostic } = await apiFailure(async () => ({ ok: true, status: 200, text: () => Promise.reject(bodyAbort) }));
  assert.equal(thrown.code, 'API_NETWORK_ERROR', 'historical body-abort public code preserved');
  assert.equal(thrown.requestPhase, 'RESPONSE_BODY_READ');
  assert.equal(thrown.aborted, true);
  assert.equal(diagnostic.request_phase, 'RESPONSE_BODY_READ');
  assert.equal(diagnostic.parser_attempted, false);
  assert.equal(PARSER_0_REQUEST_PHASES.includes('RESPONSE_BODY_READ'), true);

  const connect = await apiFailure(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(connect.thrown.code, 'API_NETWORK_ERROR');
  assert.equal(connect.thrown.requestPhase, 'FETCH');
  assert.notEqual(connect.diagnostic.request_phase, diagnostic.request_phase, 'body-read abort is no longer indistinguishable from the initial fetch failure');
});

// ---------------------------------------------------------------------------
// Cases 9 + 13: extraction/availability facts (content_filter, missing content)
// ---------------------------------------------------------------------------

test('9. content_filter + empty content: finish reason preserved, parser NOT attempted', async () => {
  await assert.rejects(
    sendOpenAiChatCompletion({ baseUrl: 'https://parser0.invalid/api/v1', apiKey: 'not-a-real-secret', model: 'm', messages: [{ role: 'user', content: 'p' }], fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"finish_reason":"content_filter","message":{"content":""}}]}' }) }),
    (error) => {
      assert.equal(error.code, 'API_EMPTY_RESPONSE', 'public error code preserved');
      assert.equal(error.finishReason, 'content_filter');
      assert.equal(error.requestPhase, 'ASSISTANT_EXTRACTION');
      return true;
    },
  );
  const diagnostic = executionFailureDiagnosticFromError(new ApiBackendError('provider returned no usable assistant content', API_ERROR_CODES.EMPTY_RESPONSE, { finishReason: 'content_filter', requestPhase: 'ASSISTANT_EXTRACTION' }), {});
  assert.equal(diagnostic.finish_reason, 'content_filter');
  assert.equal(diagnostic.assistant_output_present, false);
  assert.equal(diagnostic.parser_attempted, false);
  assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
});

test('13. extraction receives an eligible envelope but content is missing: its own failure layer, not a parser defect', async () => {
  assert.throws(
    () => normalizeChatCompletionResponse({ choices: [{ finish_reason: 'stop', message: {} }] }),
    (error) => {
      assert.equal(error.code, 'API_EMPTY_RESPONSE');
      assert.equal(error.requestPhase, 'ASSISTANT_EXTRACTION');
      return true;
    },
  );
  const { driver } = driverThrowing(() => new ApiBackendError('provider returned no usable assistant content', API_ERROR_CODES.EMPTY_RESPONSE, { finishReason: 'stop', requestPhase: 'ASSISTANT_EXTRACTION' }));
  await assert.rejects(driver.decide(INPUT), (error) => {
    const diagnostic = error.layeredDiagnostic;
    assert.equal(diagnostic.parser_attempted, false);
    assert.equal(diagnostic.parser_state, 'NOT_ATTEMPTED');
    assert.equal(diagnostic.assistant_output_present, false);
    assert.equal(diagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Cases 10-12: Antigravity terminal facts — fail-closed semantics preserved
// ---------------------------------------------------------------------------

function antigravitySummary(result) {
  return summarizeAntigravityCliRun({ stdout: `${JSON.stringify({ event: 'result', result })}\n`, stderr: '', code: 0 });
}

test('10. Antigravity terminal ERROR + empty response: fail closed, no response facts faked', () => {
  const absent = antigravitySummary({ status: 'ERROR', error: 'run failed' });
  assert.throws(() => extractAntigravityAssistantText(absent), (error) => {
    assert.equal(error.code, 'ANTIGRAVITY_RUN_FAILED', 'public error code preserved');
    assert.equal(error.terminalResponsePresent, false);
    assert.equal(error.terminalResponseBytes, null, 'no response field means the byte count is genuinely unavailable, never invented');
    return true;
  });
  const empty = antigravitySummary({ status: 'ERROR', error: 'run failed', response: '' });
  assert.throws(() => extractAntigravityAssistantText(empty), (error) => {
    assert.equal(error.code, 'ANTIGRAVITY_RUN_FAILED');
    assert.equal(error.terminalResponsePresent, false);
    assert.equal(error.terminalResponseBytes, 0);
    return true;
  });
});

test('11. Antigravity terminal ERROR + response present: presence and byte count recorded, response NEVER parsed or exposed', async () => {
  const hiddenResponse = '{"type":"finish","output":"complete decision inside terminal ERROR"}';
  const summary = antigravitySummary({ status: 'ERROR', error: 'stream interrupted', response: hiddenResponse });
  assert.throws(() => extractAntigravityAssistantText(summary), (error) => {
    assert.equal(error.code, 'ANTIGRAVITY_RUN_FAILED');
    assert.equal(error.terminalResponsePresent, true);
    assert.equal(error.terminalResponseBytes, Buffer.byteLength(hiddenResponse, 'utf8'));
    assert.equal(JSON.stringify(error).includes('salvage'), false);
    assert.equal(JSON.stringify(error).includes('"output"'), false, 'no response body content on the diagnostic surface');
    assert.equal(error.detail, 'stream interrupted', 'sanitized error detail behavior unchanged');
    return true;
  });

  // Through the real driver boundary: the terminal ERROR stays an execution
  // failure; the response is not parsed and parser_attempted stays false.
  const { driver, events } = driverThrowing(() => {
    const summary2 = antigravitySummary({ status: 'ERROR', error: 'stream interrupted', response: hiddenResponse });
    try { extractAntigravityAssistantText(summary2); } catch (cause) { throw cause; }
  });
  await assert.rejects(driver.decide(INPUT), (error) => {
    assert.equal(error.code, 'ANTIGRAVITY_RUN_FAILED');
    assert.equal(error.layeredDiagnostic.terminal_response_present, true);
    assert.equal(error.layeredDiagnostic.terminal_response_bytes, Buffer.byteLength(hiddenResponse, 'utf8'));
    assert.equal(error.layeredDiagnostic.parser_attempted, false);
    assert.equal(error.layeredDiagnostic.parser_state, 'NOT_ATTEMPTED');
    assert.equal(error.layeredDiagnostic.primary_layer, PARSER_0_LAYERS.EXECUTION);
    return true;
  });
  assert.equal(lastDiagnostic(events).parser_state, 'NOT_ATTEMPTED');
});

test('12. Antigravity SUCCESS + response: eligibility and parsing unchanged', async () => {
  const summary = antigravitySummary({ status: 'SUCCESS', response: '{"type":"finish","output":"agy ok"}' });
  const observer = capturingObserver();
  const driver = createCliPmDriver({ profile: PROFILE, project: PROJECT, observer, run: async () => extractAntigravityAssistantText(summary) });
  const decision = await driver.decide(INPUT);
  assert.equal(decision.output, 'agy ok');
  const diagnostic = lastDiagnostic(observer.events);
  assert.equal(diagnostic.parser_attempted, true);
  assert.equal(diagnostic.parser_state, 'PASS');
});

// ---------------------------------------------------------------------------
// Cases 14-15: decoder/PM contract/Council semantic layer separation
// ---------------------------------------------------------------------------

test('14. parser PASS followed by PM contract failure: separate typed states, never a fake parse failure', async () => {
  // parseDecision accepts a finish with a nonempty output even when the PM
  // normalizer will reject the shape — the driver must NOT claim a PM
  // contract verdict.
  const { driver, events } = driverFor('{"type":"finish","output":"x","data":[]}');
  const decision = await driver.decide(INPUT);
  assert.equal(decision.type, 'finish');
  assert.throws(() => normalizePmDecision(decision), 'the real PM contract validator genuinely rejects this shape');
  const diagnostic = lastDiagnostic(events);
  assert.equal(diagnostic.parser_state, 'PASS');
  assert.equal(diagnostic.pm_contract_state, 'NOT_EVALUATED', 'PM contract truth lives with the normalizer, not parseDecision');

  // When the downstream normalizer verdict is attached, the layer model
  // attributes the row to L6_PM_CONTRACT — still never to the parser.
  const contractFailure = buildLayeredDiagnostic({ executionState: 'SUCCESS', terminalState: 'SUCCESS', extractionState: 'SUCCEEDED', assistantOutputPresent: true, assistantOutputBytes: 30, parserAttempted: true, parserState: 'PASS', pmContractState: 'FAIL' });
  assert.equal(contractFailure.primary_layer, PARSER_0_LAYERS.PM_CONTRACT);
  assert.equal(contractFailure.parse_error_code, null);
});

test('15. parser/PM PASS followed by Council semantic failure: L7 attribution with parser truth intact', async () => {
  // Inline minimal SQLite-free runner check is not possible (constructor
  // requires a durable step state), so assert at the validation boundary the
  // council itself uses: a parseable, normalizable finish whose data fails
  // typed COUNCIL_* semantic validation.
  const { CouncilStepWorkflowRunner } = await import('../src/pm/council/council-step-workflow-runner.mjs');
  const spec = {
    id: 'council:chair_plan:0', kind: 'council_step', stepKind: 'chair_plan', round: 0,
    profileId: 'parser0-profile', prompt: 'PLAN THE COUNCIL', participantProfileIds: ['p1', 'p2'],
  };
  const events = [];
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: () => ({
      name: 'parser0-fake',
      async decide() {
        return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: { p1: 'x', p2: 'y' } } };
      },
    }),
    project: PROJECT,
    taskLog: { event: (eventType, payload) => { events.push({ eventType, payload }); return true; } },
  });
  const outcome = await runner.run(spec);
  assert.equal(outcome.finalResult.status, 'failed');
  assert.match(outcome.finalResult.handoff.reason, /^COUNCIL_CHAIR_PLAN_INVALID:/, 'the semantic validator reason is unchanged');
  assert.equal(outcome.finalResult.handoff.reason.includes('MISSING_CRITIQUE_FOCUS'), true);
  // PARSER-0 Goal I: the attempt record distinguishes parser truth from the
  // semantic verdict — the decision parsed and passed at L5; the step failed
  // at L7 semantics, never at the parser.
  assert.deepEqual(outcome.finalResult.handoff.attempts[0], {
    attempt: 0,
    ok: true,
    execution_state: 'SUCCESS',
    parser_attempted: true,
    parser_state: 'PASS',
    assistant_output_present: true,
    structured_output_present: null,
  });
  const parserResult = events.find((event) => event.eventType === 'PARSER_RESULT');
  assert.equal(parserResult.payload.parser_outcome, 'OK');
  assert.equal(parserResult.payload.parser_attempted, true);
  assert.equal(parserResult.payload.assistant_output_present, true);
});

// ---------------------------------------------------------------------------
// Council attempt ledger truth for execution failures (Goal C/I/J)
// ---------------------------------------------------------------------------

test('Council attempt ledger records a backend execution error as parser NOT attempted, sourced from the real driver boundary', async () => {
  const { CouncilStepWorkflowRunner } = await import('../src/pm/council/council-step-workflow-runner.mjs');
  const spec = {
    id: 'council:participant_report:0', kind: 'council_step', stepKind: 'participant_report', round: 1,
    profileId: 'parser0-profile', prompt: 'report', participantProfileIds: ['p1', 'p2'],
  };
  const error = new ApiBackendError('API provider returned HTTP 402', API_ERROR_CODES.BILLING_FAILED, { httpStatus: 402 });
  error.layeredDiagnostic = executionFailureDiagnosticFromError(error, { structuredOutputRequested: false, attemptOrdinal: 0 });
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: () => ({ name: 'parser0-fake', async decide() { throw error; } }),
    project: PROJECT,
    taskLog: { event: () => true },
  });
  const outcome = await runner.run(spec);
  assert.equal(outcome.finalResult.status, 'failed');
  assert.equal(outcome.finalResult.handoff.reason, 'API_BILLING_FAILED');
  assert.deepEqual(outcome.finalResult.handoff.attempts[0], {
    attempt: 0,
    ok: false,
    error_code: 'API_BILLING_FAILED',
    parse_subreason: null,
    output_bytes: null,
    structured_output_present: null,
    execution_state: 'ERROR',
    parser_attempted: false,
    parser_state: 'NOT_ATTEMPTED',
    assistant_output_present: false,
  });
});

test('stub drivers without a layered diagnostic keep the prior attempt-record shape (no invented facts)', async () => {
  const { CouncilStepWorkflowRunner } = await import('../src/pm/council/council-step-workflow-runner.mjs');
  const spec = {
    id: 'council:participant_report:1', kind: 'council_step', stepKind: 'participant_report', round: 1,
    profileId: 'parser0-profile', prompt: 'report', participantProfileIds: ['p1', 'p2'],
  };
  const runner = new CouncilStepWorkflowRunner({
    resolveDriver: () => ({ name: 'parser0-fake', async decide() { const e = new Error('CLAUDE_TIMEOUT'); e.code = 'CLAUDE_TIMEOUT'; throw e; } }),
    project: PROJECT,
    taskLog: { event: () => true },
  });
  const outcome = await runner.run(spec);
  assert.deepEqual(outcome.finalResult.handoff.attempts[0], {
    attempt: 0, ok: false, error_code: 'CLAUDE_TIMEOUT', parse_subreason: null, output_bytes: null, structured_output_present: null,
  });
});
