/**
 * Workflow layer — project-owned in-memory workflow state.
 *
 * Tracks WorkflowRun objects, their StepRecords, and an ordered transcript for
 * observability. All mutation goes through explicit methods so lifecycle
 * invariants (workflow/step status transitions) are enforced in one place.
 * No database in T4.
 */

import { nowUtc } from '../bus/envelopes.mjs';
import { BusError, toSanitizedError } from '../bus/errors.mjs';
import { assertStepTransition, assertWorkflowTransition } from './workflow-contracts.mjs';

export class WorkflowState {
  #workflows = new Map();
  #transcripts = new Map();

  /** Record a workflow in `created` state. @param {object} run - a WorkflowRun. */
  createWorkflow(run) {
    if (this.#workflows.has(run.id)) throw new BusError(`workflow already exists: ${run.id}`);
    this.#workflows.set(run.id, run);
    this.#transcripts.set(run.id, []);
    return run;
  }

  /** @returns {object|undefined} the workflow, if known. */
  getWorkflow(id) {
    return this.#workflows.get(id);
  }

  /** @returns {object[]} workflows in creation order. */
  listWorkflows() {
    return [...this.#workflows.values()];
  }

  /**
   * Transition a workflow's status. Enforces the explicit state machine:
   * created -> running|cancelled; running -> completed|failed|cancelled.
   * `error` is stored verbatim as the documented structured failure object
   * `{ stepIndex, stepId, runId, error: { name, message, code } }` (already a
   * plain serializable object when the runner produces it).
   * @param {string} id
   * @param {{ status: string, startedAt?: string|null, completedAt?: string|null, error?: object|null }} patch
   */
  updateWorkflowStatus(id, { status, startedAt, completedAt, error } = {}) {
    const run = this.#workflows.get(id);
    if (!run) throw new BusError(`unknown workflow: ${id}`);
    assertWorkflowTransition(run.status, status);
    if (startedAt !== undefined) run.startedAt = startedAt;
    if (completedAt !== undefined) run.completedAt = completedAt;
    if (error !== undefined) run.error = error === null ? null : error;
    run.status = status;
    return run;
  }

  /** @returns {object|undefined} the step, if known. */
  getStep(workflowId, stepId) {
    return this.#workflows.get(workflowId)?.steps.find((step) => step.id === stepId);
  }

  /** @returns {object[]} step records in order. */
  listSteps(workflowId) {
    const run = this.#workflows.get(workflowId);
    return run ? [...run.steps] : [];
  }

  /**
   * Transition a step's status and attach lineage fields.
   * @param {string} workflowId
   * @param {string} stepId
   * @param {{ status?: string, taskId?: string|null, runId?: string|null, resultId?: string|null, dispatchedContext?: object|null, error?: object|null }} patch
   */
  updateStepStatus(workflowId, stepId, { status, taskId, runId, resultId, dispatchedContext, error } = {}) {
    const step = this.getStep(workflowId, stepId);
    if (!step) throw new BusError(`unknown step: ${stepId}`);
    if (status !== undefined) assertStepTransition(step.status, status);
    if (taskId !== undefined) step.taskId = taskId;
    if (runId !== undefined) step.runId = runId;
    if (resultId !== undefined) step.resultId = resultId;
    if (dispatchedContext !== undefined) step.dispatchedContext = dispatchedContext;
    if (error !== undefined) step.error = error === null ? null : toSanitizedError(error);
    if (status !== undefined) step.status = status;
    return step;
  }

  /**
   * Append an ordered transcript entry for a workflow.
   * @param {{ workflowId: string, stepId?: string|null, taskId?: string|null, runId?: string|null, agent?: string|null, event: string }} entry
   */
  appendEvent(entry) {
    const list = this.#transcripts.get(entry.workflowId);
    if (!list) return;
    list.push({
      at: new Date().toISOString(),
      workflowId: entry.workflowId,
      stepId: entry.stepId ?? null,
      taskId: entry.taskId ?? null,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    });
  }

  /** @returns {object[]} ordered transcript entries for a workflow. */
  transcript(workflowId) {
    return [...(this.#transcripts.get(workflowId) ?? [])];
  }
}
