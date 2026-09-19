/**
 * Agent Bus Core — project-owned in-memory state store.
 *
 * Tracks tasks, runs, messages, results, and the ordered transcript for
 * observability. All mutation happens through explicit methods so lifecycle
 * invariants (run status transitions, single result per run) are enforced in
 * one place. No database in T3.
 */

import { runStatuses } from './envelopes.mjs';
import { BusError, UnknownRunError, toSanitizedError } from './errors.mjs';

const VALID_STATUSES = runStatuses();
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TRANSITIONS = {
  created: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
};

export class StateStore {
  #tasks = new Map();
  #runs = new Map();
  #messages = new Map();
  #results = new Map();
  #resultByRun = new Map();
  #transcript = [];

  /** Record a task. @param {object} task - a validated TaskEnvelope. */
  createTask(task) {
    this.#tasks.set(task.id, task);
    return task;
  }

  /** Record a run in `created` state. @param {object} run - a RunRecord. */
  createRun(run) {
    this.#runs.set(run.id, run);
    return run;
  }

  /** Record a message. @param {object} message - a MessageEnvelope. */
  addMessage(message) {
    this.#messages.set(message.id, message);
    return message;
  }

  /**
   * Record a result. Enforces at most one result per run.
   * @param {object} result - a validated ResultEnvelope.
   */
  addResult(result) {
    if (this.#resultByRun.has(result.runId)) {
      throw new BusError(`result already recorded for run "${result.runId}"`);
    }
    this.#results.set(result.id, result);
    this.#resultByRun.set(result.runId, result);
    return result;
  }

  /**
   * Append a transcript entry (ordered).
   * @param {{ taskId: string, runId?: string|null, agent?: string|null, event: string, at?: string, [k: string]: any }} entry
   */
  appendEvent(entry) {
    this.#transcript.push({
      at: entry.at ?? new Date().toISOString(),
      taskId: entry.taskId,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    });
  }

  /**
   * Transition a run's status. Enforces the explicit state machine:
   * created -> running|failed|cancelled; running -> completed|failed|cancelled;
   * terminal states are final.
   * @param {string} runId
   * @param {{ status: string, startedAt?: string|null, completedAt?: string|null, error?: object|null }} patch
   * @returns {object} the updated RunRecord.
   */
  updateRunStatus(runId, { status, startedAt, completedAt, error } = {}) {
    const run = this.#runs.get(runId);
    if (!run) throw new UnknownRunError(`unknown run: ${runId}`);
    if (!VALID_STATUSES.has(status)) throw new BusError(`invalid run status: ${String(status)}`);
    if (TERMINAL_STATUSES.has(run.status)) throw new BusError(`run "${runId}" is already terminal (${run.status})`);
    const allowed = TRANSITIONS[run.status];
    if (!allowed || !allowed.has(status)) {
      throw new BusError(`invalid run status transition: ${run.status} -> ${status}`);
    }
    if (startedAt !== undefined) run.startedAt = startedAt;
    if (completedAt !== undefined) run.completedAt = completedAt;
    if (error !== undefined) run.error = error === null ? null : toSanitizedError(error);
    run.status = status;
    return run;
  }

  /** @returns {object|undefined} the task, if known. */
  getTask(taskId) {
    return this.#tasks.get(taskId);
  }

  /** @returns {object|undefined} the run, if known. */
  getRun(runId) {
    return this.#runs.get(runId);
  }

  /** @returns {object|undefined} the result for a run, if any. */
  getResultByRun(runId) {
    return this.#resultByRun.get(runId);
  }

  /** @returns {object[]} messages for a task, in creation order. */
  messagesForTask(taskId) {
    return [...this.#messages.values()].filter((message) => message.taskId === taskId);
  }

  /**
   * Ordered transcript entries for a task (task/run/message/result lifecycle
   * in the exact order the bus produced them).
   * @returns {object[]}
   */
  transcriptForTask(taskId) {
    return this.#transcript.filter((entry) => entry.taskId === taskId);
  }

  /**
   * List runs, optionally filtered.
   * @param {{ taskId?: string, agent?: string, status?: string }} [filter]
   * @returns {object[]}
   */
  listRuns({ taskId, agent, status } = {}) {
    let runs = [...this.#runs.values()];
    if (taskId !== undefined) runs = runs.filter((run) => run.taskId === taskId);
    if (agent !== undefined) runs = runs.filter((run) => run.agent === agent);
    if (status !== undefined) runs = runs.filter((run) => run.status === status);
    return runs;
  }

  /** @returns {number} number of tasks recorded. */
  get taskCount() {
    return this.#tasks.size;
  }

  /** @returns {number} number of runs recorded. */
  get runCount() {
    return this.#runs.size;
  }
}
