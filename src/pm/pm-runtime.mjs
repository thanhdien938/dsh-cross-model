/**
 * Gate 6 — swappable PM runtime.
 *
 * The runtime owns only the PM decision loop. It asks a configured driver for
 * one normalized orchestration decision at a time and executes that decision
 * through existing project-owned WorkflowRunner / PeerRelay capabilities.
 *
 * It never imports provider-specific adapters and never binds roles to backend
 * identities.
 */

import { createId, nowUtc } from '../bus/envelopes.mjs';
import { toSanitizedError } from '../bus/errors.mjs';
import {
  PM_CAPABILITIES,
  PM_DECISION_TYPES,
  assertPmDriver,
  createPmRequest,
  normalizePmDecision,
} from './pm-contracts.mjs';

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_HISTORY_LIMIT = 12;

function positiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function resultSnapshot(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    id: result.id ?? null,
    taskId: result.taskId ?? null,
    runId: result.runId ?? null,
    agent: result.agent ?? null,
    status: result.status ?? null,
    output: typeof result.output === 'string' ? result.output : '',
    handoff: result.handoff ?? null,
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
  };
}

function normalizeWorkflowOutcome(outcome) {
  return {
    kind: PM_DECISION_TYPES.WORKFLOW,
    status: outcome?.status ?? 'failed',
    workflowId: outcome?.workflowId ?? null,
    finalStepId: outcome?.finalStepId ?? null,
    finalTaskId: outcome?.finalTaskId ?? null,
    finalRunId: outcome?.finalRunId ?? null,
    finalResult: resultSnapshot(outcome?.finalResult),
    error: outcome?.error ?? null,
  };
}

function normalizePeerOutcome(outcome) {
  return {
    kind: PM_DECISION_TYPES.PEER_EXCHANGE,
    status: outcome?.status ?? 'failed',
    conversationId: outcome?.conversationId ?? null,
    hopCount: Array.isArray(outcome?.hops) ? outcome.hops.length : 0,
    finalResult: resultSnapshot(outcome?.finalResult),
  };
}

export class PmRuntime {
  #driver;
  #workflowRunner;
  #peerRelay;
  #maxTurns;
  #historyLimit;

  constructor({ driver, workflowRunner, peerRelay, maxTurns, historyLimit } = {}) {
    this.#driver = assertPmDriver(driver);
    if (!workflowRunner || typeof workflowRunner.run !== 'function') {
      throw new TypeError('PmRuntime requires a workflowRunner with run()');
    }
    if (!peerRelay || typeof peerRelay.exchange !== 'function' || typeof peerRelay.createConversation !== 'function') {
      throw new TypeError('PmRuntime requires a peerRelay with createConversation() and exchange()');
    }
    this.#workflowRunner = workflowRunner;
    this.#peerRelay = peerRelay;
    this.#maxTurns = positiveInteger(maxTurns, DEFAULT_MAX_TURNS, 'pm.maxTurns');
    this.#historyLimit = positiveInteger(historyLimit, DEFAULT_HISTORY_LIMIT, 'pm.historyLimit');
  }

  get driverName() {
    return this.#driver.name;
  }

  get capabilities() {
    return [...PM_CAPABILITIES];
  }

  #bounded(history) {
    return history.slice(-this.#historyLimit);
  }

  #baseResult(run, history) {
    return {
      pmRunId: run.id,
      requestId: run.request.id,
      driver: this.#driver.name,
      status: run.status,
      output: run.output,
      data: run.data,
      turns: run.turns,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      error: run.error,
      history: this.#bounded(history),
    };
  }

  /**
   * Execute one PM decision loop.
   *
   * @param {object} input
   * @param {string} input.objective
   * @param {object} [input.context]
   * @param {AbortSignal} [input.signal]
   */
  async run({ objective, context, signal } = {}) {
    const request = createPmRequest({ objective, context });
    const run = {
      id: createId('pmrun'),
      request,
      status: 'running',
      output: '',
      data: null,
      turns: 0,
      startedAt: nowUtc(),
      completedAt: null,
      error: null,
    };
    const history = [];

    for (let turn = 0; turn < this.#maxTurns; turn += 1) {
      if (signal?.aborted) {
        run.status = 'cancelled';
        run.completedAt = nowUtc();
        return this.#baseResult(run, history);
      }

      let decision;
      try {
        const rawDecision = await this.#driver.decide({
          request,
          turn,
          history: this.#bounded(history),
          capabilities: this.capabilities,
          signal,
        });
        decision = normalizePmDecision(rawDecision);
      } catch (error) {
        run.status = 'failed';
        run.error = toSanitizedError(error);
        run.completedAt = nowUtc();
        return this.#baseResult(run, history);
      }

      run.turns = turn + 1;

      if (decision.type === PM_DECISION_TYPES.FINISH) {
        history.push({ turn, decision: { type: decision.type }, outcome: { status: 'completed', output: decision.output, data: decision.data } });
        run.status = 'completed';
        run.output = decision.output;
        run.data = decision.data;
        run.completedAt = nowUtc();
        return this.#baseResult(run, history);
      }

      try {
        if (decision.type === PM_DECISION_TYPES.WORKFLOW) {
          const outcome = normalizeWorkflowOutcome(await this.#workflowRunner.run(decision.spec));
          history.push({ turn, decision: { type: decision.type }, outcome });
          if (outcome.status !== 'completed') {
            run.status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
            run.error = outcome.error ?? { name: 'PmActionError', message: `workflow action ended with status ${outcome.status}` };
            run.completedAt = nowUtc();
            return this.#baseResult(run, history);
          }
          continue;
        }

        if (decision.type === PM_DECISION_TYPES.PEER_EXCHANGE) {
          const conversationId = decision.conversationId ?? this.#peerRelay.createConversation().id;
          const peerInput = {
            conversationId,
            routes: decision.routes,
            body: decision.body,
            sourceResult: decision.sourceResult,
            context: decision.context,
            metadata: decision.metadata,
          };
          if (decision.maxHops !== null) peerInput.maxHops = decision.maxHops;
          const outcome = normalizePeerOutcome(await this.#peerRelay.exchange(peerInput));
          history.push({ turn, decision: { type: decision.type, conversationId }, outcome });
          if (outcome.status !== 'completed') {
            run.status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
            run.error = { name: 'PmActionError', message: `peer_exchange action ended with status ${outcome.status}` };
            run.completedAt = nowUtc();
            return this.#baseResult(run, history);
          }
          continue;
        }
      } catch (error) {
        const sanitized = toSanitizedError(error);
        history.push({ turn, decision: { type: decision.type }, outcome: { status: 'failed', error: sanitized } });
        run.status = signal?.aborted ? 'cancelled' : 'failed';
        run.error = sanitized;
        run.completedAt = nowUtc();
        return this.#baseResult(run, history);
      }
    }

    run.status = 'failed';
    run.error = {
      name: 'PmMaxTurnsExceeded',
      message: `PM driver "${this.#driver.name}" did not finish within ${this.#maxTurns} turns`,
    };
    run.completedAt = nowUtc();
    return this.#baseResult(run, history);
  }
}
