#!/usr/bin/env node
import { backendsProving, PROVEN_SESSION_CAPABILITY_MATRIX } from '../src/session/proven-capability-matrix.mjs';

const expected = {
  resume_existing: ['claude-code', 'codex', 'grok', 'opencode'],
  send_next_turn: ['claude-code', 'codex', 'grok', 'opencode'],
  stream_events: ['claude-code', 'codex', 'grok', 'opencode'],
  interrupt_active_turn: ['grok', 'opencode'],
  concurrent_client_safe: ['opencode'],
  ui_live_refresh: [],
};

let passed = 0;
for (const [capability, wanted] of Object.entries(expected)) {
  const actual = backendsProving(capability);
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${capability}: ${JSON.stringify(actual)}`);
  if (!ok) process.exitCode = 1;
  else passed += 1;
}
console.log(`backends: ${Object.keys(PROVEN_SESSION_CAPABILITY_MATRIX).join(', ')}`);
console.log(`Gate 7 capability matrix: ${passed}/${Object.keys(expected).length} checks`);
if (passed !== Object.keys(expected).length) process.exitCode = 1;
