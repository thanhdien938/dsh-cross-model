/**
 * Workflow layer — DurableWorkflowState.
 *
 * An explicit, project-owned durable replacement for the legacy in-memory
 * {@link WorkflowState}. It preserves the exact WorkflowState-facing API that
 * WorkflowRunner and tooling already consume (`createWorkflow`,
 * `getWorkflow`, `listWorkflows`, `updateWorkflowStatus`, `getStep`,
 * `listSteps`, `updateStepStatus`, `appendEvent`, `transcript`), so a runner
 * constructed with `state: new DurableWorkflowState(...)` needs no runner
 * changes.
 *
 * This module contains no database driver import and no SQL: all persistence is
 * delegated to a project-owned Workflow domain repository. Constructing a
 * DurableWorkflowState requires an open/migrated persistence store behind it;
 * hydration performs NO automatic execution — nonterminal state is merely
 * observable after reopen.
 */

const WORKFLOW_STATE_METHODS = Object.freeze([
  'createWorkflow',
  'getWorkflow',
  'listWorkflows',
  'updateWorkflowStatus',
  'getStep',
  'listSteps',
  'updateStepStatus',
  'appendEvent',
  'transcript',
]);

export class DurableWorkflowState {
  /**
   * @param {object} deps
   * @param {object} deps.repository - a Workflow domain repository over an
   *   opened/migrated persistence store. Must expose the full WorkflowState
   *   mutation/read surface.
   */
  constructor({ repository } = {}) {
    if (repository === null || typeof repository !== 'object') {
      throw new TypeError('DurableWorkflowState requires a Workflow repository');
    }
    const missing = WORKFLOW_STATE_METHODS.filter((name) => typeof repository[name] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(
        `DurableWorkflowState requires a repository with WorkflowState-facing methods; missing: ${missing.join(', ')}`,
      );
    }
    if (typeof repository.assertComplete !== 'function') {
      throw new TypeError('DurableWorkflowState requires a repository that can assert its own completeness');
    }
    repository.assertComplete();
    this.#repository = repository;
  }

  #repository;

  /** @returns {import('../persistence/repositories/workflow-repository.mjs').WorkflowRepository} */
  get repository() {
    return this.#repository;
  }

  /** Record a workflow and its initial step rows. @param {object} run - a WorkflowRun. */
  createWorkflow(run) {
    return this.#repository.createWorkflow(run);
  }

  /** @returns {object|undefined} the reconstructed WorkflowRun, if known. */
  getWorkflow(id) {
    return this.#repository.getWorkflow(id);
  }

  /** @returns {object[]} workflows in creation order. */
  listWorkflows() {
    return this.#repository.listWorkflows();
  }

  /**
   * Transition a workflow's status through the explicit state machine,
   * atomically with its terminal metadata.
   * @param {string} id
   * @param {{ status: string, startedAt?: string|null, completedAt?: string|null, error?: object|null }} patch
   */
  updateWorkflowStatus(id, patch) {
    return this.#repository.updateWorkflowStatus(id, patch);
  }

  /** @returns {object|undefined} the step record, if known. */
  getStep(workflowId, stepId) {
    return this.#repository.getStep(workflowId, stepId);
  }

  /** @returns {object[]} step records in order. */
  listSteps(workflowId) {
    return this.#repository.listSteps(workflowId);
  }

  /**
   * Transition a step's status and attach lineage fields, atomically with its
   * lineage write.
   * @param {string} workflowId
   * @param {string} stepId
   * @param {{ status?: string, taskId?: string|null, runId?: string|null, resultId?: string|null, dispatchedContext?: object|null, error?: object|null }} patch
   */
  updateStepStatus(workflowId, stepId, patch) {
    return this.#repository.updateStepStatus(workflowId, stepId, patch);
  }

  /** Append an ordered, durable workflow transcript entry. */
  appendEvent(entry) {
    return this.#repository.appendEvent(entry);
  }

  /** @returns {object[]} ordered transcript entries for a workflow. */
  transcript(workflowId) {
    return this.#repository.transcript(workflowId);
  }

  /**
   * Durable-workflow capability flag (also present via the repository). Used by
   * wiring checks to detect durable mode without importing a concrete type.
   * @returns {true}
   */
  get hasWorkflowDurability() {
    return true;
  }

  /** @returns {number} number of workflows recorded. */
  get workflowCount() {
    return this.#repository.countWorkflows();
  }
}