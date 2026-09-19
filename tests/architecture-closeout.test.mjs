import test from 'node:test';
import assert from 'node:assert/strict';

import { ARCHITECTURE_INVARIANTS, invariantById, invariantsForArea } from '../src/orchestration/architecture-invariants.mjs';
import { PROVEN_SESSION_CAPABILITY_MATRIX } from '../src/session/proven-capability-matrix.mjs';
import { BACKEND_HEALTH_STATUS, BACKEND_FAILURE_CLASSIFICATION } from '../src/orchestration/backend-health-registry.mjs';
import { isRetryableClassification } from '../src/orchestration/retry-failover-executor.mjs';

const EXPECTED_IDS = Array.from({ length: 12 }, (_, index) => `INV-${String(index + 1).padStart(3, '0')}`);

test('architecture invariant catalog is complete, ordered, immutable, and uniquely identified', () => {
  assert.equal(Object.isFrozen(ARCHITECTURE_INVARIANTS), true);
  assert.deepEqual(ARCHITECTURE_INVARIANTS.map((entry) => entry.id), EXPECTED_IDS);
  assert.equal(new Set(EXPECTED_IDS).size, EXPECTED_IDS.length);
  for (const entry of ARCHITECTURE_INVARIANTS) {
    assert.equal(Object.isFrozen(entry), true);
    assert.ok(entry.statement.length > 20);
    assert.equal(invariantById(entry.id), entry);
  }
});

test('closeout retains truthful native capability matrix', () => {
  const matrix = PROVEN_SESSION_CAPABILITY_MATRIX;
  assert.deepEqual(Object.keys(matrix).sort(), ['claude-code', 'codex', 'grok', 'opencode']);
  for (const backend of Object.keys(matrix)) {
    assert.equal(matrix[backend].capabilities.resume_existing, 'PROVED');
    assert.equal(matrix[backend].capabilities.send_next_turn, 'PROVED');
    assert.equal(matrix[backend].capabilities.stream_events, 'PROVED');
    assert.equal(matrix[backend].capabilities.ui_live_refresh, 'UNPROVEN');
  }
  assert.equal(matrix.codex.capabilities.interrupt_active_turn, 'ERROR');
  assert.equal(matrix['claude-code'].capabilities.interrupt_active_turn, 'UNPROVEN');
  assert.equal(matrix.grok.capabilities.interrupt_active_turn, 'PROVED');
  assert.equal(matrix.opencode.capabilities.interrupt_active_turn, 'PROVED');
  assert.equal(matrix.opencode.capabilities.concurrent_client_safe, 'PROVED');
  assert.equal(matrix.codex.capabilities.concurrent_client_safe, 'UNPROVEN');
});

test('health truth boundary keeps UNKNOWN distinct from HEALTHY', () => {
  assert.notEqual(BACKEND_HEALTH_STATUS.UNKNOWN, BACKEND_HEALTH_STATUS.HEALTHY);
  assert.ok(invariantsForArea('health').some((entry) => entry.id === 'INV-006'));
});

test('retry policy remains exactly bounded to retryable infrastructure classifications', () => {
  const retryable = [
    BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
    BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
    BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
    BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
  ];
  const stop = [
    BACKEND_FAILURE_CLASSIFICATION.AUTH,
    BACKEND_FAILURE_CLASSIFICATION.CONFIG,
    BACKEND_FAILURE_CLASSIFICATION.PROTOCOL,
    BACKEND_FAILURE_CLASSIFICATION.UNKNOWN_FAILURE,
  ];
  for (const classification of retryable) assert.equal(isRetryableClassification(classification), true);
  for (const classification of stop) assert.equal(isRetryableClassification(classification), false);
});

test('catalog explicitly protects continuity, role neutrality, failure truth, retry bounds, and audit minimization', () => {
  for (const id of ['INV-001', 'INV-002', 'INV-007', 'INV-009', 'INV-010', 'INV-011', 'INV-012']) {
    assert.ok(invariantById(id), `missing ${id}`);
  }
});
