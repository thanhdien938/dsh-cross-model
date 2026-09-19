/**
 * P20.2A — ReportBackendResult envelope: terminal-state truth (§9.1),
 * finish-reason mapping (§9.2), no semantic fields (§30).
 * Tests C, D (partial), Q, R, S, T.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReportBackendResult,
  validateReportBackendResult,
  reportDeliveryEligible,
  mapChatCompletionFinishReason,
  TERMINAL_STATE,
  VISIBLE_OUTPUT_SOURCE,
} from '../src/pm/report-backend-result.mjs';

const base = { backend: 'fake', profileId: 'p', executionId: 'e', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE };

test('C: every terminal state round-trips through build + validate', () => {
  for (const ts of Object.values(TERMINAL_STATE)) {
    const r = buildReportBackendResult({ ...base, terminalState: ts, acceptedVisibleText: ts === TERMINAL_STATE.SUCCESS ? 'body' : null });
    const v = validateReportBackendResult(r);
    assert.ok(v.ok, `${ts}: ${v.errors.join('; ')}`);
    assert.equal(r.terminal_state, ts);
  }
  assert.equal(validateReportBackendResult({ ...base, kind: 'ReportBackendResult', terminal_state: 'MADE_UP' }).ok, false);
});

test('C: accepted_visible_bytes must equal the UTF-8 length of accepted_visible_text', () => {
  const r = buildReportBackendResult({ ...base, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'héllo 🚀' });
  assert.equal(r.accepted_visible_bytes, Buffer.byteLength('héllo 🚀', 'utf8'));
  assert.equal(validateReportBackendResult({ ...r, accepted_visible_bytes: 3 }).ok, false);
});

test('§30: a ReportBackendResult carrying a semantic field is rejected', () => {
  for (const key of ['decision', 'verdict', 'recommendation', 'findings', 'risks', 'agreement', 'analysis']) {
    const bad = { ...buildReportBackendResult({ ...base, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'x' }), [key]: 'leak' };
    assert.equal(validateReportBackendResult(bad).ok, false, `${key} must be rejected`);
  }
});

test('D/§9.2: chat-completion finish_reason maps to a truthful terminal state; length/tool are NOT complete success', () => {
  assert.equal(mapChatCompletionFinishReason('stop'), TERMINAL_STATE.SUCCESS);
  assert.equal(mapChatCompletionFinishReason('end_turn'), TERMINAL_STATE.SUCCESS);
  assert.equal(mapChatCompletionFinishReason('length'), TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE);
  assert.equal(mapChatCompletionFinishReason('max_tokens'), TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE);
  assert.equal(mapChatCompletionFinishReason('tool_calls'), TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE);
  assert.equal(mapChatCompletionFinishReason('content_filter'), TERMINAL_STATE.PROVIDER_ERROR);
  assert.equal(mapChatCompletionFinishReason(null), TERMINAL_STATE.UNKNOWN_OUTCOME);
  assert.equal(mapChatCompletionFinishReason('something-weird'), TERMINAL_STATE.UNKNOWN_OUTCOME);
});

test('Q/R/S/T: only a truthful SUCCESS is delivery-eligible — text/file existence never implies success', () => {
  const withText = (ts, extra = {}) => buildReportBackendResult({ ...base, terminalState: ts, acceptedVisibleText: 'looks complete but is not', ...extra });

  assert.equal(reportDeliveryEligible(withText(TERMINAL_STATE.SUCCESS)).eligible, true);

  // Q timeout, R cancel, S provider/process error, T truncated — all NOT eligible even though visible text exists.
  assert.deepEqual(
    [
      reportDeliveryEligible(withText(TERMINAL_STATE.TIMEOUT, { timedOut: true })).code,
      reportDeliveryEligible(withText(TERMINAL_STATE.CANCELLED, { cancelled: true })).code,
      reportDeliveryEligible(withText(TERMINAL_STATE.PROVIDER_ERROR)).code,
      reportDeliveryEligible(withText(TERMINAL_STATE.PROCESS_ERROR)).code,
      reportDeliveryEligible(withText(TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE)).code,
      reportDeliveryEligible(withText(TERMINAL_STATE.UNKNOWN_OUTCOME)).code,
    ],
    [
      'REPORT_EXECUTION_TIMEOUT', 'REPORT_EXECUTION_CANCELLED', 'REPORT_PROVIDER_ERROR',
      'REPORT_PROCESS_ERROR', 'REPORT_TRUNCATED_OR_INCOMPLETE', 'REPORT_UNKNOWN_OUTCOME',
    ],
  );
  for (const ts of [TERMINAL_STATE.TIMEOUT, TERMINAL_STATE.CANCELLED, TERMINAL_STATE.PROVIDER_ERROR, TERMINAL_STATE.PROCESS_ERROR, TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE, TERMINAL_STATE.UNKNOWN_OUTCOME]) {
    assert.equal(reportDeliveryEligible(withText(ts, { timedOut: ts === TERMINAL_STATE.TIMEOUT, cancelled: ts === TERMINAL_STATE.CANCELLED })).eligible, false);
  }
});

test('a SUCCESS terminal state that is also timed_out/cancelled is still not eligible', () => {
  assert.equal(reportDeliveryEligible(buildReportBackendResult({ ...base, terminalState: TERMINAL_STATE.SUCCESS, timedOut: true, acceptedVisibleText: 'x' })).eligible, false);
  assert.equal(reportDeliveryEligible(buildReportBackendResult({ ...base, terminalState: TERMINAL_STATE.SUCCESS, cancelled: true, acceptedVisibleText: 'x' })).eligible, false);
});
