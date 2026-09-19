/**
 * Agent Bus Core — main orchestration facade.
 *
 * Composes an {@link AgentRegistry}, an {@link EventBus}, and a
 * {@link StateStore} into one uniform contract for the PM/orchestrator:
 *
 *   dispatch -> run -> result -> send -> cancel
 *
 * The bus is backend-neutral: it only ever talks to registered adapters
 * through the narrow AgentAdapter contract. Provider-specific knowledge
 * (e.g. "codex", "claude-code", "grok") must stay in adapter configuration,
 * never in this module.
 *
 * Lifecycle on success:
 *   task.created -> task.dispatched -> agent.started -> result.created -> agent.completed
 * On failure: agent.failed. On cancellation: agent.cancelled.
 */

import { createTaskEnvelope, createMessageEnvelope, createResultEnvelope, createRunRecord, nowUtc } from './envelopes.mjs';
import {
  AgentNotRegisteredError,
  UnknownRunError,
  UnknownTaskError,
  UnsupportedCapabilityError,
  UNSUPPORTED,
  toSanitizedError,
} from './errors.mjs';

export class AgentBus {
  #registry;
  #events;
  #state;
  #controllers = new Map();

  /**
   * @param {object} deps
   * @param {import('./agent-registry.mjs').AgentRegistry} deps.registry
   * @param {import('./event-bus.mjs').EventBus} deps.events
   * @param {import('./state-store.mjs').StateStore} deps.state
   */
  constructor({ registry, events, state }) {
    if (!registry || typeof registry.getEntry !== 'function') throw new TypeError('AgentBus requires a registry');
    if (!events || typeof events.emit !== 'function') throw new TypeError('AgentBus requires an event bus');
    if (!state || typeof state.createTask !== 'function') throw new TypeError('AgentBus requires a state store');
    this.#registry = registry;
    this.#events = events;
    this.#state = state;
    events.all((event, payload) => {
      state.appendEvent({
        taskId: payload?.taskId,
        runId: payload?.runId ?? null,
        agent: payload?.agent ?? null,
        event,
      });
    });
  }

  /** @returns {import('./event-bus.mjs').EventBus} */
  get events() {
    return this.#events;
  }

  /** @returns {import('./state-store.mjs').StateStore} */
  get state() {
    return this.#state;
  }

  /** @returns {import('./agent-registry.mjs').AgentRegistry} */
  get registry() {
    return this.#registry;
  }

  /**
   * Dispatch a task to a registered backend. Resolves with the completed
   * RunRecord; the normalized result is available via {@link AgentBus.result}.
   *
   * @param {object} input
   * @param {string} input.recipient - registered backend name.
   * @param {string} input.body - task text.
   * @param {object} [input.context] - free-form context carried in the envelope.
   * @param {string} [input.sender] - defaults to `'pm'`.
   * @param {string|null} [input.expectedOutput] - optional hint.
   * @param {string} [input.taskId] - optional explicit task id.
   * @returns {Promise<object>} the completed RunRecord.
   * @throws {AgentNotRegisteredError} when `recipient` is not registered.
   */
  async dispatch({ recipient, body, context, sender, expectedOutput, taskId }) {
    const task = createTaskEnvelope({ id: taskId, sender, recipient, body, context, expectedOutput });

    const entry = this.#registry.getEntry(task.recipient);
    if (!entry) throw new AgentNotRegisteredError(`agent not registered: "${task.recipient}"`);

    // Optional project-owned dispatch-durability capability. A durable state
    // store advertises `hasDispatchDurability === true` and exposes the atomic
    // intent/terminal write-ahead operations; the legacy in-memory StateStore
    // has neither. The bus feature-detects the flag and never imports the
    // concrete repository or any SQLite API.
    const durable = this.#state.hasDispatchDurability === true;
    const run = createRunRecord({ taskId: task.id, agent: task.recipient });
    let attemptId = null;

    // R1 (Gate 3): the durable path persists the write-ahead intent BEFORE any
    // durable lifecycle event can be appended. The EventBus listener persists
    // transcript rows synchronously, so a failed prepare/start here leaves zero
    // task/run/attempt/bus_event rows and can never reach the adapter. The
    // legacy in-memory path keeps its original createTask/createRun sequence
    // and the exact same event ordering.
    if (durable) {
      const prepared = this.#state.prepareDispatch({
        task,
        run,
        attemptId: `attempt_${run.id}`,
        backend: task.recipient,
      });
      attemptId = prepared.attempt.id;
      // Cross the external boundary durably BEFORE any local live state
      // (running status, controller registration, agent.started). A local
      // failure here leaves the attempt INTENT_COMMITTED, which classifies as
      // SAFE_TO_DISPATCH (never AMBIGUOUS), and never registers a controller or
      // invokes the adapter.
      this.#state.startDispatch(attemptId);
    } else {
      this.#state.createTask(task);
      this.#state.createRun(run);
    }
    this.#events.emit('task.created', { taskId: task.id, task, agent: task.recipient });
    this.#events.emit('task.dispatched', { taskId: task.id, runId: run.id, agent: task.recipient, task });

    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    const adapter = entry.adapter;
    try {
      this.#state.updateRunStatus(run.id, { status: 'running', startedAt: nowUtc() });
      this.#events.emit('agent.started', { taskId: task.id, runId: run.id, agent: task.recipient });

      const outcome = await adapter.start({ task, run, signal: controller.signal });
      const result = createResultEnvelope({
        taskId: task.id,
        runId: run.id,
        agent: task.recipient,
        status: 'completed',
        output: typeof outcome?.output === 'string' ? outcome.output : '',
        stopReason: typeof outcome?.stopReason === 'string' ? outcome.stopReason : null,
        artifacts: Array.isArray(outcome?.artifacts) ? outcome.artifacts : [],
        handoff: outcome?.handoff,
      });
      if (durable) {
        // One atomic write: run -> completed, result persisted, attempt ->
        // TERMINAL_COMMITTED.
        this.#state.terminalCommitSuccess({ runId: run.id, result });
      } else {
        this.#state.addResult(result);
        this.#state.updateRunStatus(run.id, { status: 'completed', completedAt: nowUtc() });
      }
      this.#events.emit('result.created', { taskId: task.id, runId: run.id, agent: task.recipient, result });
      this.#events.emit('agent.completed', { taskId: task.id, runId: run.id, agent: task.recipient, result });
      return this.#state.getRun(run.id) ?? run;
    } catch (error) {
      if (controller.signal.aborted) {
        if (durable) {
          // One atomic write: run -> cancelled, attempt -> TERMINAL_COMMITTED.
          this.#state.terminalCommitFailure({ runId: run.id, status: 'cancelled' });
        } else {
          this.#state.updateRunStatus(run.id, { status: 'cancelled', completedAt: nowUtc() });
        }
        this.#events.emit('agent.cancelled', { taskId: task.id, runId: run.id, agent: task.recipient });
      } else {
        const sanitized = toSanitizedError(error);
        if (durable) {
          // One atomic write: run -> failed with sanitized error, attempt ->
          // TERMINAL_COMMITTED. No ResultEnvelope is fabricated.
          this.#state.terminalCommitFailure({ runId: run.id, status: 'failed', error: sanitized });
        } else {
          this.#state.updateRunStatus(run.id, { status: 'failed', completedAt: nowUtc(), error: sanitized });
        }
        this.#events.emit('agent.failed', { taskId: task.id, runId: run.id, agent: task.recipient, error: sanitized });
      }
      throw error;
    } finally {
      try {
        await adapter.dispose?.({ run });
      } catch {
        // disposal must never mask the primary outcome
      }
      this.#controllers.delete(run.id);
    }
  }

  /**
   * Record a message on the central bus for audit/lineage. This is the
   * record-only primitive: it persists a validated MessageEnvelope and emits
   * `message.created`, but NEVER attempts native live delivery and NEVER
   * creates a new run. It is deliberately distinct from {@link AgentBus.send}
   * (live delivery into an already-running session) and from the peer layer's
   * Level-1 relay (which pairs a record with a fresh explicit dispatch).
   *
   * @param {object} input
   * @param {string} [input.id] - optional explicit stable message id; the peer
   *   layer uses this to keep the centrally recorded message identical to the
   *   one atomically committed in peer conversation state.
   * @param {string} input.from - sender identity.
   * @param {string} input.to - recipient identity.
   * @param {string} input.taskId - owning task id.
   * @param {string|null} [input.runId] - owning run id (or null for task-scoped).
   * @param {string} input.body - message text.
   * @param {string|null} [input.replyTo] - id of the message this replies to.
   * @param {string} [input.kind] - message kind, defaults to `'message'`.
   * @param {string|null} [input.conversationId] - optional peer conversation id.
   * @param {string|null} [input.hopId] - optional peer hop id.
   * @param {object|null} [input.metadata] - optional plain-object metadata.
   * @returns {object} the recorded MessageEnvelope.
   */
  recordMessage({ id, from, to, taskId, runId, body, replyTo, kind, conversationId, hopId, metadata }) {
    const message = createMessageEnvelope({
      id,
      taskId,
      runId,
      from,
      to,
      body,
      replyTo,
      kind,
      conversationId,
      hopId,
      metadata,
    });
    this.#state.addMessage(message);
    this.#events.emit('message.created', { taskId: message.taskId, runId: message.runId, agent: message.to, message });
    return message;
  }

  /**
   * Record a message on the central bus and attempt live delivery.
   *
   * Recording always happens (the PM can observe lineage). Live delivery is
   * attempted only while the run is still running; one-shot backends have no
   * live session, so delivery then fails with an explicit
   * {@link UnsupportedCapabilityError} — never fabricated success.
   *
   * @param {object} input
   * @param {string} input.from - sender identity.
   * @param {string} input.to - recipient identity.
   * @param {string} input.taskId - owning task id.
   * @param {string|null} input.runId - owning run id (or null for task-scoped).
   * @param {string} input.body - message text.
   * @param {string|null} [input.replyTo]
   * @param {string} [input.kind]
   * @returns {Promise<{ message: object, delivered: boolean }>}
   * @throws {UnsupportedCapabilityError} when live delivery is unavailable.
   */
  async send({ from, to, taskId, runId, body, replyTo, kind }) {
    const message = createMessageEnvelope({ taskId, runId, from, to, body, replyTo, kind });
    this.#state.addMessage(message);
    this.#events.emit('message.created', { taskId: message.taskId, runId: message.runId, agent: message.to, message });

    if (message.runId === null) {
      throw new UnsupportedCapabilityError(
        `message ${message.id} recorded but not delivered: no live session for a task-scoped message`,
        { messageId: message.id },
      );
    }
    const run = this.#state.getRun(message.runId);
    if (!run) throw new UnknownRunError(`unknown run: ${message.runId}`);
    if (run.status !== 'running') {
      throw new UnsupportedCapabilityError(
        `message ${message.id} recorded but not delivered: run ${run.id} has no live session (status ${run.status})`,
        { messageId: message.id },
      );
    }
    const entry = this.#registry.getEntry(run.agent);
    const adapter = entry?.adapter;
    if (!adapter || typeof adapter.send !== 'function') {
      throw new UnsupportedCapabilityError(
        `message ${message.id} recorded but not delivered: backend "${run.agent}" has no live-send capability`,
        { messageId: message.id },
      );
    }
    const outcome = await adapter.send({ run, message });
    if (outcome === UNSUPPORTED) {
      throw new UnsupportedCapabilityError(
        `message ${message.id} recorded but not delivered: backend "${run.agent}" is one-shot with no live session`,
        { messageId: message.id },
      );
    }
    return { message, delivered: true };
  }

  /**
   * Cancel a running run: abort the dispatch signal, best-effort adapter
   * cancel, then rely on the dispatch `finally` for safe disposal.
   * @param {string} runId
   * @returns {Promise<object>} the (now cancelled) RunRecord.
   * @throws {UnknownRunError} when the run is unknown.
   * @throws {Error} when the run is not in a cancellable state.
   */
  async cancel(runId) {
    const run = this.#state.getRun(runId);
    if (!run) throw new UnknownRunError(`unknown run: ${runId}`);
    if (run.status !== 'running') {
      throw new Error(`cannot cancel run "${runId}": current status is ${run.status}`);
    }
    const controller = this.#controllers.get(runId);
    if (controller && !controller.signal.aborted) controller.abort();
    const adapter = this.#registry.get(run.agent);
    if (adapter && typeof adapter.cancel === 'function') {
      try {
        await adapter.cancel({ run });
      } catch {
        // cancellation is best-effort; the dispatch finally still disposes
      }
    }
    return run;
  }

  /**
   * Get the normalized result envelope for a run.
   * @returns {object|null} the ResultEnvelope, or null if none recorded.
   * @throws {UnknownRunError} when the run is unknown.
   */
  result(runId) {
    if (!this.#state.getRun(runId)) throw new UnknownRunError(`unknown run: ${runId}`);
    return this.#state.getResultByRun(runId);
  }

  /** @returns {object|undefined} the task envelope, if known. */
  task(taskId) {
    return this.#state.getTask(taskId);
  }

  /** @returns {object|undefined} the run record, if known. */
  run(runId) {
    return this.#state.getRun(runId);
  }

  /** @returns {object[]} messages for a task, in creation order. */
  messagesForTask(taskId) {
    if (!this.#state.getTask(taskId)) throw new UnknownTaskError(`unknown task: ${taskId}`);
    return this.#state.messagesForTask(taskId);
  }

  /** @returns {object[]} ordered transcript entries for a task. */
  transcriptForTask(taskId) {
    if (!this.#state.getTask(taskId)) throw new UnknownTaskError(`unknown task: ${taskId}`);
    return this.#state.transcriptForTask(taskId);
  }

  /** @param {{ taskId?: string, agent?: string, status?: string }} [filter] @returns {object[]} */
  listRuns(filter = {}) {
    return this.#state.listRuns(filter);
  }
}
