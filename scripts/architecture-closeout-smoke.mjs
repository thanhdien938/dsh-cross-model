#!/usr/bin/env node
import process from 'node:process';

import { ARCHITECTURE_INVARIANTS } from '../src/orchestration/architecture-invariants.mjs';
import { PROVEN_SESSION_CAPABILITY_MATRIX } from '../src/session/proven-capability-matrix.mjs';
import { BACKEND_HEALTH_STATUS, BACKEND_FAILURE_CLASSIFICATION } from '../src/orchestration/backend-health-registry.mjs';
import { isRetryableClassification } from '../src/orchestration/retry-failover-executor.mjs';

const checks = [];
function check(name, fn) {
  try { checks.push({ name, ok: true, detail: fn() }); }
  catch (error) { checks.push({ name, ok: false, detail: `${error.name}: ${error.message}` }); }
}

check('12 architecture invariants are frozen and numbered', () => {
  if (ARCHITECTURE_INVARIANTS.length !== 12) throw new Error(`expected 12, got ${ARCHITECTURE_INVARIANTS.length}`);
  if (!Object.isFrozen(ARCHITECTURE_INVARIANTS)) throw new Error('catalog not frozen');
  ARCHITECTURE_INVARIANTS.forEach((entry, index) => {
    const expected = `INV-${String(index + 1).padStart(3, '0')}`;
    if (entry.id !== expected || !Object.isFrozen(entry)) throw new Error(`bad invariant ${entry.id}`);
  });
  return 'INV-001..INV-012';
});

check('all four backends retain native resume/next-turn/stream PROVED', () => {
  const names = Object.keys(PROVEN_SESSION_CAPABILITY_MATRIX).sort();
  if (names.join(',') !== 'claude-code,codex,grok,opencode') throw new Error(names.join(','));
  for (const name of names) {
    const caps = PROVEN_SESSION_CAPABILITY_MATRIX[name].capabilities;
    for (const capability of ['resume_existing', 'send_next_turn', 'stream_events']) {
      if (caps[capability] !== 'PROVED') throw new Error(`${name}.${capability}=${caps[capability]}`);
    }
  }
  return names.join(',');
});

check('interrupt/concurrency truth remains narrow', () => {
  const m = PROVEN_SESSION_CAPABILITY_MATRIX;
  if (m.codex.capabilities.interrupt_active_turn !== 'ERROR') throw new Error('codex interrupt drifted');
  if (m['claude-code'].capabilities.interrupt_active_turn !== 'UNPROVEN') throw new Error('claude interrupt drifted');
  if (m.grok.capabilities.interrupt_active_turn !== 'PROVED') throw new Error('grok interrupt drifted');
  if (m.opencode.capabilities.interrupt_active_turn !== 'PROVED') throw new Error('opencode interrupt drifted');
  if (m.opencode.capabilities.concurrent_client_safe !== 'PROVED') throw new Error('opencode concurrency drifted');
  return 'grok+opencode interrupt; opencode-only concurrency';
});

check('no backend claims UI live refresh', () => {
  for (const [name, profile] of Object.entries(PROVEN_SESSION_CAPABILITY_MATRIX)) {
    if (profile.capabilities.ui_live_refresh !== 'UNPROVEN') throw new Error(`${name}=${profile.capabilities.ui_live_refresh}`);
  }
  return 'all UNPROVEN';
});

check('UNKNOWN health remains distinct from HEALTHY', () => {
  if (BACKEND_HEALTH_STATUS.UNKNOWN === BACKEND_HEALTH_STATUS.HEALTHY) throw new Error('health truth collapsed');
  return `${BACKEND_HEALTH_STATUS.UNKNOWN} != ${BACKEND_HEALTH_STATUS.HEALTHY}`;
});

check('retryable set excludes auth/config/protocol/unknown', () => {
  for (const c of [
    BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
    BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
    BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
    BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
  ]) if (!isRetryableClassification(c)) throw new Error(`${c} unexpectedly non-retryable`);
  for (const c of [
    BACKEND_FAILURE_CLASSIFICATION.AUTH,
    BACKEND_FAILURE_CLASSIFICATION.CONFIG,
    BACKEND_FAILURE_CLASSIFICATION.PROTOCOL,
    BACKEND_FAILURE_CLASSIFICATION.UNKNOWN_FAILURE,
  ]) if (isRetryableClassification(c)) throw new Error(`${c} unexpectedly retryable`);
  return '4 retryable infra classes only';
});

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
const passed = checks.filter((entry) => entry.ok).length;
console.log(`ARCHITECTURE CLOSEOUT: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
process.exitCode = passed === checks.length ? 0 : 1;
