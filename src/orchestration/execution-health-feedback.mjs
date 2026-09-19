import { classifyExecutionFailure } from './execution-failure-classifier.mjs';

export const HEALTH_FEEDBACK_OUTCOME = Object.freeze({
  SUCCESS_RECORDED: 'SUCCESS_RECORDED',
  FAILURE_RECORDED: 'FAILURE_RECORDED',
  IGNORED_UNKNOWN: 'IGNORED_UNKNOWN',
  IGNORED_CANCELLED: 'IGNORED_CANCELLED',
});

export function attachExecutionHealthFeedback({ events, healthRegistry, onFeedback } = {}) {
  if (!events || typeof events.on !== 'function') throw new TypeError('execution health feedback requires EventBus-like events.on()');
  if (!healthRegistry || typeof healthRegistry.recordSuccess !== 'function' || typeof healthRegistry.recordFailure !== 'function') {
    throw new TypeError('execution health feedback requires BackendHealthRegistry-like recordSuccess()/recordFailure()');
  }
  if (onFeedback !== undefined && typeof onFeedback !== 'function') throw new TypeError('onFeedback must be a function when provided');

  const emitFeedback = (feedback) => {
    onFeedback?.(Object.freeze({ ...feedback }));
  };

  const offCompleted = events.on('agent.completed', (payload) => {
    const backend = payload?.agent;
    if (typeof backend !== 'string' || backend === '') return;
    const health = healthRegistry.recordSuccess(backend, { diagnostic: 'agent.completed' });
    emitFeedback({ outcome: HEALTH_FEEDBACK_OUTCOME.SUCCESS_RECORDED, backend, health, event: 'agent.completed' });
  });

  const offFailed = events.on('agent.failed', (payload) => {
    const backend = payload?.agent;
    if (typeof backend !== 'string' || backend === '') return;
    const classified = classifyExecutionFailure(payload?.error);
    if (!classified.recognized) {
      emitFeedback({
        outcome: HEALTH_FEEDBACK_OUTCOME.IGNORED_UNKNOWN,
        backend,
        classification: null,
        diagnostic: classified.diagnostic,
        event: 'agent.failed',
      });
      return;
    }
    const health = healthRegistry.recordFailure(backend, {
      classification: classified.classification,
      diagnostic: classified.diagnostic,
    });
    emitFeedback({
      outcome: HEALTH_FEEDBACK_OUTCOME.FAILURE_RECORDED,
      backend,
      classification: classified.classification,
      health,
      event: 'agent.failed',
    });
  });

  const offCancelled = events.on('agent.cancelled', (payload) => {
    const backend = payload?.agent;
    if (typeof backend !== 'string' || backend === '') return;
    emitFeedback({ outcome: HEALTH_FEEDBACK_OUTCOME.IGNORED_CANCELLED, backend, event: 'agent.cancelled' });
  });

  return Object.freeze({
    dispose() {
      offCompleted();
      offFailed();
      offCancelled();
    },
  });
}
