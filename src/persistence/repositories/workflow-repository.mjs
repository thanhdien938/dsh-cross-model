/**
 * Persistence layer — Workflow domain repository.
 *
 * Project-owned repository that maps the Workflow state domain (WorkflowRun,
 * StepRecord, ordered workflow transcript) onto the persistence substrate. It
 * is the ONLY reader/writer of workflow-domain rows; WorkflowRunner and
 * DurableWorkflowState never touch SQL or import the SQLite driver.
 *
 * Repository conventions (matching the Gate-2 AgentBus repository):
 *  - the `workflows.spec` column stores the full, versioned WorkflowRun
 *    envelope (including every step) at creation time, preserving the original
 *    WorkflowSpec for future undispatched-step continuation;
 *  - every mutation that must be coherent writes through one local
 *    transactionSync, so its unit of work is atomic;
 *  - status transition semantics intentionally mirror the legacy in-memory
 *    WorkflowState (see tests for parity), including legal/illegal transition
 *    rejection and JSON-faithful fail-before-mutate behavior.
 *
 * External AgentBus dispatch is never part of a workflow SQL transaction.
 */

import { PersistenceError } from '../persistence-errors.mjs';
import { serializeDurable, parseDurable } from './json-durable.mjs';
import { BusError, toSanitizedError } from '../../bus/errors.mjs';
import { nowUtc } from '../../bus/envelopes.mjs';
import { assertStepTransition, assertWorkflowTransition } from '../../workflow/workflow-contracts.mjs';

const STORE_SEAM_METHODS = Object.freeze(['run', 'get', 'all', 'transactionSync']);

const REPOSITORY_METHODS = Object.freeze([
  'createWorkflow',
  'getWorkflow',
  'listWorkflows',
  'updateWorkflowStatus',
  'getStep',
  'listSteps',
  'updateStepStatus',
  'appendEvent',
  'transcript',
  'countWorkflows',
]);

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function isForeignKeyError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error?.code === 'SQLITE_CONSTRAINT_TRIGGER';
}

function parseBool(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') return value === '1' || value === 'true';
  return false;
}

function parseJsonField(json, label) {
  if (json === null || json === undefined || json === '') return null;
  return parseDurable(json, label);
}

function toErrorField(error) {
  if (error === null || error === undefined) return null;
  return serializeDurable(toSanitizedError(error), 'workflow error');
}

export class WorkflowRepository {
  /**
   * @param {object} deps
   * @param {object} deps.store - an opened/migrated persistence store exposing
   *   the repository composition seam (`run`/`get`/`all`/`transactionSync`).
   */
  constructor({ store } = {}) {
    if (store === null || typeof store !== 'object') {
      throw new TypeError('WorkflowRepository requires a persistence store');
    }
    const missingSeam = STORE_SEAM_METHODS.filter((name) => typeof store[name] !== 'function');
    if (missingSeam.length > 0) {
      throw new TypeError(`WorkflowRepository requires a store with repository seams; missing: ${missingSeam.join(', ')}`);
    }
    this.store = store;
  }

  /** @returns {boolean} whether `error` is a stable-id constraint failure. */
  #mapConstraint(error, { workflowId, stepId, index }) {
    if (error?.message?.includes('workflow_steps.id')) {
      throw new BusError(`duplicate step id: ${stepId}`, { code: 'DUPLICATE_STEP', cause: error });
    }
    if (error?.message?.includes('workflow_steps.workflow_id, workflow_steps.step_index')) {
      throw new BusError(`step index already exists for workflow ${workflowId}: ${index}`, {
        code: 'DUPLICATE_STEP_INDEX',
        cause: error,
      });
    }
    if (error?.message?.includes('workflows.id')) {
      throw new BusError(`workflow already exists: ${workflowId}`, { code: 'DUPLICATE_WORKFLOW', cause: error });
    }
    return false;
  }

  /**
   * Reconstruct one StepRecord from its stored row, merging the step-spec
   * fields (body/context/expectedOutput) that v2 columns carry and falling
   * back to the persisted spec envelope when the v2 column is absent.
   * @param {object} row - workflow_steps row.
   * @param {object|null} specStep - matching step from the persisted spec
   *   envelope (keyed by stable step id), or null.
   * @returns {object} StepRecord.
   */
  #stepFromRow(row, specStep) {
    const step = {
      id: row.id,
      workflowId: row.workflow_id,
      index: row.step_index,
      recipient: row.recipient,
      body: row.body ?? specStep?.body ?? '',
      expectedOutput: row.expected_output ?? specStep?.expectedOutput ?? null,
      context: row.context === null || row.context === undefined ? (specStep?.context ?? {}) : parseDurable(row.context, 'step context'),
      contextFromPrevious: parseBool(row.context_from_previous ?? specStep?.contextFromPrevious === true),
      taskId: row.task_id ?? null,
      runId: row.run_id ?? null,
      resultId: row.result_id ?? null,
      dispatchedContext: parseJsonField(row.dispatched_context, 'step dispatched context'),
      status: row.status,
      error: parseJsonField(row.error, 'step error'),
    };
    return step;
  }

  /**
   * Reconstruct the full WorkflowRun (spec + steps + lineage + status) from
   * the persisted rows.
   * @param {object} row - workflows row.
   * @returns {object} a semantically-equivalent WorkflowRun.
   */
  #workflowFromRow(row) {
    const specRun = parseDurable(row.spec, 'workflow spec');
    if (specRun === null || typeof specRun !== 'object') {
      throw new PersistenceError('stored workflow spec is not an object', { code: 'CORRUPT_DURABLE_STATE' });
    }
    const stepRows = this.store.all(
      'SELECT id, workflow_id, step_index, recipient, status, task_id, run_id, result_id, context_from_previous, dispatched_context, error, body, context, expected_output FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index',
      [row.id],
    );
    const specSteps = Array.isArray(specRun.steps) ? specRun.steps : [];
    const byId = new Map(specSteps.map((step) => [step.id, step]));
    return {
      id: row.id,
      sender: specRun.sender ?? 'pm',
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      steps: stepRows.map((stepRow) => this.#stepFromRow(stepRow, byId.get(stepRow.id) ?? null)),
      error: parseJsonField(row.error, 'workflow error'),
    };
  }

  /**
   * Persist a WorkflowRun with all of its StepRecords in one local
   * transaction. The full run envelope is stored as the durable spec.
   * @param {object} run - a validated WorkflowRun.
   * @returns {object} the persisted WorkflowRun.
   */
  createWorkflow(run) {
    if (run === null || typeof run !== 'object') throw new TypeError('createWorkflow requires a WorkflowRun object');
    serializeDurable(run, 'workflow run');
    const createdAt = nowUtc();
    try {
      this.store.transactionSync(({ run: q }) => {
        q(
          'INSERT INTO workflows (id, record_version, spec, status, started_at, completed_at, error, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
          [run.id, serializeDurable(run, 'workflow spec'), run.status, run.startedAt ?? null, run.completedAt ?? null, run.error === null || run.error === undefined ? null : serializeDurable(run.error, 'workflow error'), createdAt],
        );
        for (const step of run.steps ?? []) {
          q(
            'INSERT INTO workflow_steps (id, workflow_id, step_index, recipient, status, task_id, run_id, result_id, context_from_previous, dispatched_context, error, created_at, body, context, expected_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              step.id,
              run.id,
              step.index,
              step.recipient ?? null,
              step.status,
              step.taskId ?? null,
              step.runId ?? null,
              step.resultId ?? null,
              step.contextFromPrevious === true ? '1' : '0',
              step.dispatchedContext === null || step.dispatchedContext === undefined ? null : serializeDurable(step.dispatchedContext, 'step dispatched context'),
              step.error === null || step.error === undefined ? null : toErrorField(step.error),
              createdAt,
              step.body ?? null,
              step.context === null || step.context === undefined ? null : serializeDurable(step.context, 'step context'),
              step.expectedOutput ?? null,
            ],
          );
        }
      });
    } catch (error) {
      if (isConstraintError(error)) {
        this.#mapConstraint(error, { workflowId: run.id, stepId: run.steps?.[0]?.id, index: run.steps?.[0]?.index });
        throw new BusError(`workflow creation rejected by store constraints`, { code: 'WORKFLOW_CREATE_CONSTRAINT', cause: error });
      }
      if (isForeignKeyError(error)) {
        throw new BusError('workflow creation references an unknown workflow', { code: 'WORKFLOW_REFERENCE_VIOLATION', cause: error });
      }
      throw error;
    }
    return run;
  }

  /** @returns {object|undefined} the reconstructed WorkflowRun, if known. */
  getWorkflow(id) {
    const row = this.store.get('SELECT id, spec, status, started_at, completed_at, error FROM workflows WHERE id = ?', [id]);
    if (!row) return undefined;
    return this.#workflowFromRow(row);
  }

  /** @returns {object[]} all WorkflowRuns, in creation order. */
  listWorkflows() {
    return this.store
      .all('SELECT id, spec, status, started_at, completed_at, error FROM workflows ORDER BY created_at, id')
      .map((row) => this.#workflowFromRow(row));
  }

  /**
   * Transition a workflow's status, enforcing the legacy state machine in one
   * atomic read-validate-write.
   * @param {string} id
   * @param {{ status: string, startedAt?: string|null, completedAt?: string|null, error?: object|null }} patch
   * @returns {object} the reconstructed WorkflowRun after the update.
   */
  updateWorkflowStatus(id, { status, startedAt, completedAt, error } = {}) {
    if (status === undefined) {
      throw new BusError('updateWorkflowStatus requires a status', { code: 'INVALID_WORKFLOW_STATUS' });
    }
    this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT id, status, started_at, completed_at, error FROM workflows WHERE id = ?', [id]);
      if (!row) throw new BusError(`unknown workflow: ${id}`);
      assertWorkflowTransition(row.status, status);
      const nextStartedAt = startedAt !== undefined ? startedAt : row.started_at;
      const nextCompletedAt = completedAt !== undefined ? completedAt : row.completed_at;
      const hasError = error !== undefined;
      const nextErrorJson = !hasError ? row.error : error === null ? null : serializeDurable(error, 'workflow error');
      run(
        'UPDATE workflows SET status = ?, started_at = ?, completed_at = ?, error = ?, state_revision = state_revision + 1 WHERE id = ?',
        [status, nextStartedAt, nextCompletedAt, nextErrorJson, id],
      );
    });
    return this.getWorkflow(id);
  }

  /** @returns {object|undefined} the step record, if known. */
  getStep(workflowId, stepId) {
    const run = this.getWorkflow(workflowId);
    if (!run) return undefined;
    return run.steps.find((step) => step.id === stepId);
  }

  /** @returns {object[]} step records in order. */
  listSteps(workflowId) {
    const run = this.getWorkflow(workflowId);
    return run ? run.steps : [];
  }

  /**
   * Transition a step's status and/or attach lineage fields in one atomic
   * read-validate-write. Mirrors the legacy updateStepStatus rules.
   * @param {string} workflowId
   * @param {string} stepId
   * @param {{ status?: string, taskId?: string|null, runId?: string|null, resultId?: string|null, dispatchedContext?: object|null, error?: object|null }} patch
   * @returns {object} the reconstructed step after the update.
   */
  updateStepStatus(workflowId, stepId, { status, taskId, runId, resultId, dispatchedContext, error } = {}) {
    const updatedStep = this.store.transactionSync(({ get, run }) => {
      const row = get(
        'SELECT id, workflow_id, step_index, recipient, status, task_id, run_id, result_id, context_from_previous, dispatched_context, error, body, context, expected_output FROM workflow_steps WHERE id = ? AND workflow_id = ?',
        [stepId, workflowId],
      );
      if (!row) throw new BusError(`unknown step: ${stepId}`);
      const specRow = this.store.get('SELECT spec FROM workflows WHERE id = ?', [workflowId]);
      const specStep = specRow ? this.#specStepById(specRow.spec, stepId) : null;
      const step = this.#stepFromRow(row, specStep);
      if (status !== undefined) assertStepTransition(step.status, status);
      if (taskId !== undefined) step.taskId = taskId;
      if (runId !== undefined) step.runId = runId;
      if (resultId !== undefined) step.resultId = resultId;
      if (dispatchedContext !== undefined) step.dispatchedContext = dispatchedContext;
      if (error !== undefined) step.error = error === null ? null : toSanitizedError(error);
      if (status !== undefined) step.status = status;

      const dispatchedContextJson = step.dispatchedContext === null || step.dispatchedContext === undefined
        ? null
        : serializeDurable(step.dispatchedContext, 'step dispatched context');
      const errorJson = step.error === null || step.error === undefined ? null : serializeDurable(step.error, 'step error');
      run(
        'UPDATE workflow_steps SET status = ?, task_id = ?, run_id = ?, result_id = ?, dispatched_context = ?, error = ?, state_revision = state_revision + 1 WHERE id = ? AND workflow_id = ?',
        [step.status, step.taskId, step.runId, step.resultId, dispatchedContextJson, errorJson, stepId, workflowId],
      );
      return step;
    });
    return updatedStep;
  }

  /** @param {string} specJson @param {string} stepId @returns {object|null} */
  #specStepById(specJson, stepId) {
    try {
      const specRun = parseDurable(specJson, 'workflow spec');
      if (specRun === null || typeof specRun !== 'object' || !Array.isArray(specRun.steps)) return null;
      return specRun.steps.find((step) => step.id === stepId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Append an ordered, durable workflow transcript entry. One atomic append
   * with deterministic ordering via the autoincrement id.
   * @param {{ workflowId: string, stepId?: string|null, taskId?: string|null, runId?: string|null, agent?: string|null, event: string, at?: string }} entry
   */
  appendEvent(entry) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('appendEvent requires an entry object');
    const normalized = {
      at: entry.at ?? nowUtc(),
      workflowId: entry.workflowId,
      stepId: entry.stepId ?? null,
      taskId: entry.taskId ?? null,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    };
    if (typeof normalized.event !== 'string' || normalized.event.trim() === '') {
      throw new BusError('event name must be a non-empty string', { code: 'INVALID_EVENT' });
    }
    serializeDurable(normalized, 'workflow event payload');
    this.store.run(
      'INSERT INTO workflow_events (workflow_id, step_id, task_id, run_id, agent, event, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [normalized.workflowId, normalized.stepId, normalized.taskId, normalized.runId, normalized.agent, normalized.event, normalized.at],
    );
  }

  /** @returns {object[]} ordered transcript entries for a workflow. */
  transcript(workflowId) {
    return this.store
      .all('SELECT at, workflow_id, step_id, task_id, run_id, agent, event FROM workflow_events WHERE workflow_id = ? ORDER BY id', [workflowId])
      .map((row) => ({
        at: row.at,
        workflowId: row.workflow_id,
        stepId: row.step_id,
        taskId: row.task_id,
        runId: row.run_id,
        agent: row.agent,
        event: row.event,
      }));
  }

  /** @returns {number} number of workflows recorded. */
  countWorkflows() {
    return this.store.get('SELECT COUNT(*) AS count FROM workflows').count;
  }

  /**
   * Integrity check used by durable-state wiring/tests.
   * @returns {true}
   * @throws {PersistenceError} with code `INVALID_WORKFLOW_REPOSITORY` when any
   *   required member is missing.
   */
  assertComplete() {
    const missing = REPOSITORY_METHODS.filter((name) => typeof this[name] !== 'function');
    if (missing.length > 0) {
      throw new PersistenceError(`WorkflowRepository missing required members: ${missing.join(', ')}`, {
        code: 'INVALID_WORKFLOW_REPOSITORY',
        missing,
      });
    }
    return true;
  }
}
