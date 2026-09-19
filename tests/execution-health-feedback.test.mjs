import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/bus/event-bus.mjs';
import { BackendHealthRegistry, BACKEND_FAILURE_CLASSIFICATION, BACKEND_HEALTH_STATUS } from '../src/orchestration/backend-health-registry.mjs';
import { classifyExecutionFailure } from '../src/orchestration/execution-failure-classifier.mjs';
import { attachExecutionHealthFeedback, HEALTH_FEEDBACK_OUTCOME } from '../src/orchestration/execution-health-feedback.mjs';

const CASES = [
  ['503 Service temporarily unavailable', BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE],
  ['HTTP 429 Too Many Requests', BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT],
  ['request ETIMEDOUT after 30000ms', BACKEND_FAILURE_CLASSIFICATION.TIMEOUT],
  ['socket ECONNRESET by peer', BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT],
  ['HTTP 401 Unauthorized invalid API key', BACKEND_FAILURE_CLASSIFICATION.AUTH],
  ['spawn opencode ENOENT', BACKEND_FAILURE_CLASSIFICATION.CONFIG],
  ['JSON-RPC protocol error: invalid response schema', BACKEND_FAILURE_CLASSIFICATION.PROTOCOL],
];

for (const [message, expected] of CASES) {
  test(`classifier maps ${expected}`, () => {
    const out = classifyExecutionFailure({ name: 'Error', message });
    assert.equal(out.recognized, true);
    assert.equal(out.classification, expected);
  });
}

test('classifier leaves ambiguous task failure unrecognized', () => {
  const out = classifyExecutionFailure({ name: 'TaskError', message: 'the requested proof assertion was false' });
  assert.equal(out.recognized, false);
  assert.equal(out.classification, null);
});

test('agent.completed records HEALTHY success automatically', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  const feedback = [];
  const sub = attachExecutionHealthFeedback({ events, healthRegistry: health, onFeedback: (entry) => feedback.push(entry) });
  events.emit('agent.completed', { agent: 'codex' });
  assert.equal(health.get('codex').status, BACKEND_HEALTH_STATUS.HEALTHY);
  assert.equal(feedback[0].outcome, HEALTH_FEEDBACK_OUTCOME.SUCCESS_RECORDED);
  sub.dispose();
});

test('recognized agent.failed records classified failure', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  attachExecutionHealthFeedback({ events, healthRegistry: health });
  events.emit('agent.failed', { agent: 'opencode', error: { name: 'HttpError', message: '503 Service temporarily unavailable' } });
  const entry = health.get('opencode');
  assert.equal(entry.status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
  assert.equal(entry.classification, BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE);
  assert.equal(entry.retryable, true);
});

test('ambiguous task failure does not mutate health', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  const feedback = [];
  attachExecutionHealthFeedback({ events, healthRegistry: health, onFeedback: (entry) => feedback.push(entry) });
  events.emit('agent.failed', { agent: 'grok', error: { name: 'TaskError', message: 'assertion did not match expected content' } });
  assert.equal(health.get('grok').status, BACKEND_HEALTH_STATUS.UNKNOWN);
  assert.equal(feedback[0].outcome, HEALTH_FEEDBACK_OUTCOME.IGNORED_UNKNOWN);
});

test('agent.cancelled is health-neutral', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  health.recordSuccess('claude-code');
  const before = health.get('claude-code');
  const feedback = [];
  attachExecutionHealthFeedback({ events, healthRegistry: health, onFeedback: (entry) => feedback.push(entry) });
  events.emit('agent.cancelled', { agent: 'claude-code' });
  assert.deepEqual(health.get('claude-code'), before);
  assert.equal(feedback[0].outcome, HEALTH_FEEDBACK_OUTCOME.IGNORED_CANCELLED);
});

test('later success restores backend after recognized failure', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  attachExecutionHealthFeedback({ events, healthRegistry: health });
  events.emit('agent.failed', { agent: 'codex', error: { message: 'HTTP 429 rate limit exceeded' } });
  assert.equal(health.get('codex').status, BACKEND_HEALTH_STATUS.UNAVAILABLE);
  events.emit('agent.completed', { agent: 'codex' });
  assert.equal(health.get('codex').status, BACKEND_HEALTH_STATUS.HEALTHY);
  assert.equal(health.get('codex').classification, null);
});

test('dispose detaches all feedback listeners', () => {
  const events = new EventBus();
  const health = new BackendHealthRegistry();
  const sub = attachExecutionHealthFeedback({ events, healthRegistry: health });
  sub.dispose();
  events.emit('agent.completed', { agent: 'codex' });
  assert.equal(health.get('codex').status, BACKEND_HEALTH_STATUS.UNKNOWN);
});
