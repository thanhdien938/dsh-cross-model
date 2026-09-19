/**
 * P20.8 §10 — exact-byte report extraction for OpenCode/Antigravity, and
 * the report-backend adapters' truthful terminal-state classification.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §10, §12 (#19).
 *
 * Offline. No real CLI process is ever spawned — extractor tests exercise
 * the pure functions directly; adapter tests inject a fake spawnImpl-free
 * runner via the module's own exported factories is not attempted here
 * (that would require faking node:child_process) — instead this file
 * proves the extractor purity claim directly, which is the load-bearing
 * fact §10 requires (`createXReportBackend()` never post-processes the
 * extractor's return value — see cli-report-backends.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractOpenCodeReportText, extractAntigravityReportText, CliReportBackendError } from '../src/pm/report-backends/cli-report-backends.mjs';
import { extractOpenCodeAssistantText } from '../src/session/opencode-cli-session-bridge.mjs';
import { extractAntigravityAssistantText } from '../src/session/antigravity-cli-session-bridge.mjs';

// The exact byte-sensitive canary categories §10 requires: leading/trailing
// whitespace, Unicode/emoji, a Markdown fence, a zero-width marker,
// JSON-looking text.
const ZW = '​'; // ZERO WIDTH SPACE
const CANARY = `  leading and trailing spaces on this line   \nunicode: café ✅ 🚀 — em dash\nzero-width marker:${ZW}(here)${ZW}\n\`\`\`\n{"looks_like_json": true, "value": 42}\n\`\`\`\n`;

test('§10 — extractOpenCodeReportText preserves EXACT bytes (no zero-width strip, no trim)', () => {
  const summary = { events: [{ type: 'text', part: { type: 'text', text: CANARY } }] };
  const text = extractOpenCodeReportText(summary);
  assert.equal(text, CANARY, 'report-plane extractor must return byte-identical text');
  assert.ok(text.includes(ZW), 'zero-width markers must survive');
  assert.notEqual(text, text.trim(), 'leading/trailing whitespace must survive (i.e. NOT already trimmed)');
});

test('§10 — extractOpenCodeReportText concatenates multiple text events in order with zero joining logic beyond straight concatenation', () => {
  const summary = { events: [
    { type: 'text', part: { type: 'text', text: 'part-one ' } },
    { type: 'other' },
    { type: 'text', part: { type: 'text', text: 'part-two' } },
  ] };
  assert.equal(extractOpenCodeReportText(summary), 'part-one part-two');
});

test('§10 — extractOpenCodeReportText throws CLI_REPORT_OUTPUT_MISSING (never returns empty string) when no text event exists', () => {
  assert.throws(() => extractOpenCodeReportText({ events: [] }), (e) => e instanceof CliReportBackendError && e.code === 'CLI_REPORT_OUTPUT_MISSING');
});

test('§10 — the EXISTING decision-plane OpenCode extractor is demonstrably NOT byte-exact (motivates the new one)', () => {
  // The decision-plane extractor's zero-width strip is anchored (`^`/`$`)
  // to the start/end of each event's own text fragment — so the marker
  // must sit at an edge to demonstrate the difference.
  const edgeMarked = `${ZW}leading zero-width marker`;
  const summary = { events: [{ type: 'text', part: { type: 'text', text: edgeMarked } }] };
  const exact = extractOpenCodeReportText(summary);
  const decisionPlaneText = extractOpenCodeAssistantText(summary);
  assert.equal(exact, edgeMarked, 'the report-plane extractor must preserve the leading zero-width marker');
  assert.notEqual(decisionPlaneText, edgeMarked, 'the decision-plane extractor strips a leading zero-width run — it must differ from the exact bytes');
  assert.ok(!decisionPlaneText.includes(ZW));
});

test('§10 — extractAntigravityReportText preserves EXACT bytes (no .trim())', () => {
  const paddedResponse = '   padded response with trailing space   ';
  const summary = { result: { status: 'SUCCESS', response: paddedResponse } };
  const text = extractAntigravityReportText(summary);
  assert.equal(text, paddedResponse);
  assert.notEqual(text, text.trim());
});

test('§10 — the EXISTING decision-plane Antigravity extractor is demonstrably NOT byte-exact (motivates the new one)', () => {
  const paddedResponse = '   padded response with trailing space   ';
  const summary = { result: { status: 'SUCCESS', response: paddedResponse } };
  const decisionPlaneText = extractAntigravityAssistantText(summary);
  assert.equal(decisionPlaneText, paddedResponse.trim());
  assert.notEqual(decisionPlaneText, extractAntigravityReportText(summary));
});

test('extractAntigravityReportText classifies CANCELED/ERROR/unknown status as typed, distinct errors', () => {
  assert.throws(() => extractAntigravityReportText({ result: { status: 'CANCELED' } }), (e) => e.code === 'CLI_REPORT_CANCELLED');
  assert.throws(() => extractAntigravityReportText({ result: { status: 'ERROR', error: 'boom' } }), (e) => e.code === 'CLI_REPORT_PROVIDER_ERROR');
  assert.throws(() => extractAntigravityReportText({ result: { status: 'WEIRD' } }), (e) => e.code === 'CLI_REPORT_UNKNOWN_STATUS');
  assert.throws(() => extractAntigravityReportText({ result: { status: 'SUCCESS', response: '   ' } }), (e) => e.code === 'CLI_REPORT_OUTPUT_MISSING');
  assert.throws(() => extractAntigravityReportText({}), (e) => e.code === 'CLI_REPORT_OUTPUT_MISSING');
});
