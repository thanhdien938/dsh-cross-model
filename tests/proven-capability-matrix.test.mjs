import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVEN_SESSION_CAPABILITY_MATRIX,
  backendProves,
  backendsProving,
  getProvenBackendProfile,
} from '../src/session/proven-capability-matrix.mjs';

test('matrix contains the four locally verified backends', () => {
  assert.deepEqual(Object.keys(PROVEN_SESSION_CAPABILITY_MATRIX).sort(), ['claude-code', 'codex', 'grok', 'opencode']);
});

test('all four prove resume, next turn, and event streaming', () => {
  for (const capability of ['resume_existing', 'send_next_turn', 'stream_events']) {
    assert.deepEqual(backendsProving(capability), ['claude-code', 'codex', 'grok', 'opencode']);
  }
});

test('only Grok and OpenCode prove native interrupt', () => {
  assert.deepEqual(backendsProving('interrupt_active_turn'), ['grok', 'opencode']);
  assert.equal(getProvenBackendProfile('codex').capabilities.interrupt_active_turn, 'ERROR');
});

test('only OpenCode proves concurrent client safety', () => {
  assert.deepEqual(backendsProving('concurrent_client_safe'), ['opencode']);
});

test('no backend claims UI live refresh', () => {
  assert.deepEqual(backendsProving('ui_live_refresh'), []);
});

test('eligibility requires PROVED exactly', () => {
  assert.equal(backendProves('opencode', 'concurrent_client_safe'), true);
  assert.equal(backendProves('codex', 'interrupt_active_turn'), false);
  assert.equal(backendProves('claude-code', 'interrupt_active_turn'), false);
});

test('unknown backend is rejected', () => {
  assert.throws(() => getProvenBackendProfile('not-real'), /unknown proven backend/);
});
