import { selectBackendWithHealth } from './health-aware-selector.mjs';
import { classifyExecutionFailure } from './execution-failure-classifier.mjs';
import { BACKEND_FAILURE_CLASSIFICATION } from './backend-health-registry.mjs';

const RETRYABLE_CLASSIFICATIONS = new Set([
  BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE,
  BACKEND_FAILURE_CLASSIFICATION.RATE_LIMIT,
  BACKEND_FAILURE_CLASSIFICATION.TIMEOUT,
  BACKEND_FAILURE_CLASSIFICATION.TRANSIENT_TRANSPORT,
]);

export class RetryFailoverError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'RetryFailoverError';
    Object.assign(this, extra);
  }
}

function positiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function freezeAttempt(attempt) {
  return Object.freeze({ ...attempt });
}

function assertTrace(trace) {
  if (trace === undefined || trace === null) return null;
  if (typeof trace.record !== 'function') throw new TypeError('retry auditTrace must implement record(type, data)');
  return trace;
}

export function isRetryableClassification(classification) {
  return RETRYABLE_CLASSIFICATIONS.has(classification);
}

export class RetryFailoverExecutor {
  #agentBus;
  #healthRegistry;
  #maxAttempts;
  #auditTrace;

  constructor({ agentBus, healthRegistry, maxAttempts = 3, auditTrace = null } = {}) {
    if (!agentBus || typeof agentBus.dispatch !== 'function' || typeof agentBus.result !== 'function') {
      throw new TypeError('RetryFailoverExecutor requires agentBus dispatch()/result()');
    }
    if (!healthRegistry || typeof healthRegistry.snapshot !== 'function') {
      throw new TypeError('RetryFailoverExecutor requires healthRegistry.snapshot()');
    }
    this.#agentBus = agentBus;
    this.#healthRegistry = healthRegistry;
    this.#maxAttempts = positiveInteger(maxAttempts, 3, 'retry.maxAttempts');
    this.#auditTrace = assertTrace(auditTrace);
  }

  #trace(type, data = {}) {
    try {
      this.#auditTrace?.record(type, data);
    } catch {
      // Audit is observational-only; telemetry failure must never alter execution.
    }
  }

  async execute({ selector, body, context, sender = 'pm', expectedOutput = null, signal } = {}) {
    if (typeof body !== 'string' || body.trim() === '') throw new TypeError('retry execute body must be non-empty');
    const attempts = [];
    this.#trace('retry.started', { selector, sender, maxAttempts: this.#maxAttempts });

    for (let index = 0; index < this.#maxAttempts; index += 1) {
      if (signal?.aborted) {
        this.#trace('retry.cancelled', { phase: 'before_selection', attempts: attempts.length });
        return Object.freeze({ status: 'cancelled', attempts: Object.freeze(attempts), result: null, backend: null });
      }

      let selection;
      const healthSnapshot = this.#healthRegistry.snapshot();
      try {
        selection = selectBackendWithHealth(selector, healthSnapshot);
        this.#trace('selection.made', {
          attempt: index + 1,
          backend: selection.backend,
          usable: selection.usable,
          capabilityEligible: selection.capabilityEligible,
          selectedHealth: selection.health,
        });
      } catch (error) {
        this.#trace('selection.failed', {
          attempt: index + 1,
          code: error.code ?? 'SELECTION_FAILED',
          message: error.message,
        });
        throw new RetryFailoverError(`retry selection failed before attempt ${index + 1}: ${error.message}`, {
          code: error.code ?? 'SELECTION_FAILED',
          cause: error,
          attempts: Object.freeze(attempts),
        });
      }

      const backend = selection.backend;
      this.#trace('attempt.started', { attempt: index + 1, backend });
      try {
        const run = await this.#agentBus.dispatch({ recipient: backend, body, context, sender, expectedOutput });
        const result = this.#agentBus.result(run.id);
        const attempt = freezeAttempt({
          attempt: index + 1,
          backend,
          status: 'completed',
          runId: run.id,
          taskId: run.taskId,
          classification: null,
          retryable: false,
        });
        attempts.push(attempt);
        this.#trace('attempt.completed', attempt);
        this.#trace('retry.completed', { backend, attempts: attempts.length, resultId: result?.id ?? null });
        return Object.freeze({
          status: 'completed',
          backend,
          result,
          attempts: Object.freeze(attempts),
        });
      } catch (error) {
        if (signal?.aborted) {
          const attempt = freezeAttempt({ attempt: index + 1, backend, status: 'cancelled', runId: null, taskId: null, classification: null, retryable: false });
          attempts.push(attempt);
          this.#trace('attempt.cancelled', attempt);
          this.#trace('retry.cancelled', { phase: 'dispatch', backend, attempts: attempts.length });
          return Object.freeze({ status: 'cancelled', backend, result: null, attempts: Object.freeze(attempts) });
        }

        const classified = classifyExecutionFailure(error);
        const retryable = classified.recognized && isRetryableClassification(classified.classification);
        const attempt = freezeAttempt({
          attempt: index + 1,
          backend,
          status: 'failed',
          runId: null,
          taskId: null,
          classification: classified.classification,
          retryable,
        });
        attempts.push(attempt);
        this.#trace('attempt.failed', {
          ...attempt,
          recognized: classified.recognized,
          diagnostic: classified.diagnostic,
        });

        if (!retryable) {
          const code = classified.recognized ? 'NON_RETRYABLE_FAILURE' : 'AMBIGUOUS_FAILURE';
          this.#trace('retry.stopped', { code, backend, classification: classified.classification, attempts: attempts.length });
          throw new RetryFailoverError(`non-retryable execution failure on ${backend}`, {
            code,
            backend,
            classification: classified.classification,
            cause: error,
            attempts: Object.freeze(attempts),
          });
        }

        if (index + 1 >= this.#maxAttempts) {
          this.#trace('retry.exhausted', { backend, classification: classified.classification, attempts: attempts.length });
          throw new RetryFailoverError(`retry attempts exhausted after ${this.#maxAttempts} attempts`, {
            code: 'RETRY_EXHAUSTED',
            backend,
            classification: classified.classification,
            cause: error,
            attempts: Object.freeze(attempts),
          });
        }
        this.#trace('failover.reselect', {
          afterAttempt: index + 1,
          failedBackend: backend,
          classification: classified.classification,
          nextHealth: this.#healthRegistry.snapshot(),
        });
        // Gate 10 feedback has synchronously updated health before dispatch rejects.
        // The next loop must reselect from the fresh snapshot; no same-backend bypass.
      }
    }

    throw new RetryFailoverError('retry executor reached unreachable state', { code: 'INTERNAL' });
  }
}
