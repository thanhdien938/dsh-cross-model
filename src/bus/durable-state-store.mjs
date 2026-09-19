/**
 * Agent Bus Core — durable state store.
 *
 * An explicit, project-owned durable replacement for the legacy in-memory
 * {@link StateStore}. It preserves the exact StateStore-facing API the
 * AgentBus depends on (`createTask`, `createRun`, `addMessage`, `addResult`,
 * `appendEvent`, `updateRunStatus`, reads/listing, counts), so constructing an
 * AgentBus with `state: new DurableStateStore(...)` needs no bus changes. This
 * module contains no SQLite driver import and no SQL: all persistence is
 * delegated to a project-owned AgentBus domain repository.
 *
 * Durable mode is explicit: constructing even one DurableStateStore requires
 * an open/migrated persistence store behind it, and every mutation is
 * durably persisted. There is no silent downgrade to memory and no automatic
 * replay or dispatch of persisted state on construction.
 */

const STATE_STORE_METHODS = Object.freeze([
  'createTask',
  'createRun',
  'addMessage',
  'addResult',
  'appendEvent',
  'updateRunStatus',
  'getTask',
  'getRun',
  'getResultByRun',
  'messagesForTask',
  'transcriptForTask',
  'listRuns',
]);

export class DurableStateStore {
  /**
   * @param {object} deps
   * @param {object} deps.repository - an AgentBus domain repository over an
   *   opened/migrated persistence store. Must expose the full StateStore
   *   mutation/read surface.
   */
  constructor({ repository } = {}) {
    if (repository === null || typeof repository !== 'object') {
      throw new TypeError('DurableStateStore requires an AgentBus repository');
    }
    const missing = STATE_STORE_METHODS.filter((name) => typeof repository[name] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(
        `DurableStateStore requires a repository with StateStore-facing methods; missing: ${missing.join(', ')}`,
      );
    }
    if (typeof repository.countTasks !== 'function' || typeof repository.countRuns !== 'function') {
      throw new TypeError('DurableStateStore requires a repository with countTasks/countRuns');
    }
    if (typeof repository.assertComplete !== 'function') {
      throw new TypeError('DurableStateStore requires a repository that can assert its own completeness');
    }
    repository.assertComplete();
    this.#repository = repository;
  }

  #repository;

  /** @returns {import('../persistence/repositories/agentbus-repository.mjs').AgentBusRepository} */
  get repository() {
    return this.#repository;
  }

  /** Record a task. @param {object} task - a validated TaskEnvelope. */
  createTask(task) {
    return this.#repository.createTask(task);
  }

  /** Record a run in `created` state. @param {object} run - a RunRecord. */
  createRun(run) {
    return this.#repository.createRun(run);
  }

  /** Record a message. @param {object} message - a MessageEnvelope. */
  addMessage(message) {
    return this.#repository.addMessage(message);
  }

  /** Record a result. Enforces at most one result per run. */
  addResult(result) {
    return this.#repository.addResult(result);
  }

  /** Append a transcript entry (ordered, durable). */
  appendEvent(entry) {
    return this.#repository.appendEvent(entry);
  }

  /** Transition a run's status through the explicit state machine. */
  updateRunStatus(runId, patch) {
    return this.#repository.updateRunStatus(runId, patch);
  }

  /** @returns {object|undefined} the task, if known. */
  getTask(taskId) {
    return this.#repository.getTask(taskId);
  }

  /** @returns {object|undefined} the run, if known. */
  getRun(runId) {
    return this.#repository.getRun(runId);
  }

  /** @returns {object|undefined} the result for a run, if any. */
  getResultByRun(runId) {
    return this.#repository.getResultByRun(runId);
  }

  /** @returns {object[]} messages for a task, in creation order. */
  messagesForTask(taskId) {
    return this.#repository.messagesForTask(taskId);
  }

  /** @returns {object[]} ordered transcript entries for a task. */
  transcriptForTask(taskId) {
    return this.#repository.transcriptForTask(taskId);
  }

  /** @returns {object[]} runs, optionally filtered. */
  listRuns(filter = {}) {
    return this.#repository.listRuns(filter);
  }

  /**
   * Dispatch-durability capability flag. When `true`, the AgentBus uses the
   * atomic write-ahead intent/terminal paths below instead of the legacy
   * createTask/createRun + addResult/updateRunStatus sequence. Legacy
   * StateStore instances report no such flag (the property is absent), so the
   * bus feature-detects this capability and stays unbound to this concrete
   * type (or to `AgentBusRepository`).
   * @returns {true}
   */
  get hasDispatchDurability() {
    return true;
  }

  /** Atomically record task + run + an INTENT_COMMITTED dispatch attempt. */
  prepareDispatch(input) {
    return this.#repository.prepareDispatch(input);
  }

  /** Cross the durable boundary: INTENT_COMMITTED -> DISPATCH_STARTED. */
  startDispatch(attemptId) {
    return this.#repository.startDispatch(attemptId);
  }

  /** Correlate a native session reference and promote to REMOTE_STARTED. */
  recordNativeStart(input) {
    return this.#repository.recordNativeStart(input);
  }

  /** Generic attempt-phase transition with legal-transition enforcement. */
  transitionDispatchAttemptPhase(attemptId, targetPhase, options = {}) {
    return this.#repository.transitionDispatchAttemptPhase(attemptId, targetPhase, options);
  }

  /** Atomic success terminal write: run + result + TERMINAL_COMMITTED. */
  terminalCommitSuccess(input) {
    return this.#repository.terminalCommitSuccess(input);
  }

  /** Atomic failure/cancellation terminal write: run + TERMINAL_COMMITTED. */
  terminalCommitFailure(input) {
    return this.#repository.terminalCommitFailure(input);
  }

  /** @returns {object|undefined} the dispatch attempt record, if known. */
  getDispatchAttempt(attemptId) {
    return this.#repository.getDispatchAttempt(attemptId);
  }

  /** @returns {object|undefined} the dispatch attempt for a run, if any. */
  getDispatchAttemptForRun(runId) {
    return this.#repository.getDispatchAttemptForRun(runId);
  }

  /** @returns {object[]} non-terminal attempts, in creation order. */
  listIncompleteDispatchAttempts() {
    return this.#repository.listIncompleteDispatchAttempts();
  }

  /** @returns {number} number of tasks recorded. */
  get taskCount() {
    return this.#repository.countTasks();
  }

  /** @returns {number} number of runs recorded. */
  get runCount() {
    return this.#repository.countRuns();
  }
}