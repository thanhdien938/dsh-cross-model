/**
 * Workflow layer — WorkflowRunner.
 *
 * A small project-owned orchestration facade ABOVE AgentBus. It owns only
 * sequencing/handoff behavior: it turns each ordered step of a WorkflowSpec
 * into one explicit `AgentBus.dispatch()`, waits for the normalized
 * ResultEnvelope, derives the next step's context via the canonical handoff
 * builder, and stops deterministically on failure/cancellation.
 *
 * AgentBus stays transport/task-lifecycle infrastructure; no workflow policy
 * lives there. Backends come from the spec (runtime identity), never from
 * hard-coded roles.
 *
 * Level-1 truthfulness: every step is a fresh explicit dispatch; the runner
 * never pretends to continue a native child session.
 */

import { createId, nowUtc } from '../bus/envelopes.mjs';
import { BusError, toSanitizedError } from '../bus/errors.mjs';
import { createWorkflowRun } from './workflow-contracts.mjs';
import { WorkflowState } from './workflow-state.mjs';
import { buildHandoffContext, mergeStepContext } from './handoff-context.mjs';

export class WorkflowRunner {
  #bus;
  #events;
  #state;
  #cancelled = new Set();
  #active = new Map();
  #activeRunId = new Map();

  /**
   * @param {object} deps
   * @param {import('../bus/agent-bus.mjs').AgentBus} deps.bus - the AgentBus
   *   this runner dispatches through.
   * @param {import('../bus/event-bus.mjs').EventBus} [deps.events] - event bus;
   *   defaults to `bus.events`.
   * @param {WorkflowState} [deps.state] - workflow state store; a fresh one is
   *   created when omitted.
   */
  constructor({ bus, events, state } = {}) {
    if (!bus || typeof bus.dispatch !== 'function') {
      throw new TypeError('WorkflowRunner requires a bus with dispatch()');
    }
    this.#bus = bus;
    this.#events = events ?? bus.events;
    this.#state = state ?? new WorkflowState();
    this.#events.on('agent.started', (payload) => {
      const active = this.#active.get(payload.taskId);
      if (!active) return;
      this.#activeRunId.set(payload.taskId, payload.runId);
      // P20.8 PRE-R3 R3-4 — durably persist the task_id -> run_id linkage the
      // MOMENT the AgentBus run begins, BEFORE `adapter.start()` is awaited
      // below (this listener fires synchronously inside `AgentBus.dispatch()`,
      // ahead of the adapter call). Previously `run_id` was written onto the
      // step ONLY at step completion/failure — a process crash during the
      // (potentially long-running) adapter call left `workflow_steps.run_id`
      // permanently null even though a real AgentBus run existed, which is
      // exactly the historical orphan-linkage hole: canonical reconciliation
      // locates runs through `workflow_steps.run_id` and misses an unlinked
      // one. Best-effort: a failure here must never mask the primary dispatch
      // outcome (mirrored by the in-memory #activeRunId map either way, and
      // the terminal write in run()'s completion/failure path remains the
      // authoritative final step record regardless).
      try {
        this.#state.updateStepStatus(active.workflowId, active.stepId, { runId: payload.runId });
      } catch {
        // best-effort — see above
      }
    });
    const dropActiveRun = (payload) => {
      if (payload?.taskId) this.#activeRunId.delete(payload.taskId);
    };
    this.#events.on('agent.completed', dropActiveRun);
    this.#events.on('agent.failed', dropActiveRun);
    this.#events.on('agent.cancelled', dropActiveRun);
  }

  /** @returns {WorkflowState} */
  get state() {
    return this.#state;
  }

  /** @returns {import('../bus/event-bus.mjs').EventBus} */
  get events() {
    return this.#events;
  }

  /** @returns {object|undefined} the workflow, if known. */
  getWorkflow(id) {
    return this.#state.getWorkflow(id);
  }

  /** @returns {object[]} ordered workflow transcript entries. */
  transcript(id) {
    return this.#state.transcript(id);
  }

  /** Reconstruct a workflow outcome from durable state without execution. */
  result(id) {
    const run = this.#state.getWorkflow(id);
    return run ? this.#summarize(run) : null;
  }

  #emit(event, payload) {
    this.#events.emit(event, payload);
    this.#state.appendEvent({
      workflowId: payload.workflowId,
      stepId: payload.stepId ?? null,
      taskId: payload.taskId ?? null,
      runId: payload.runId ?? null,
      agent: payload.agent ?? null,
      event,
    });
  }

  #summarize(run) {
    // DurableWorkflowState returns immutable repository snapshots rather than
    // mutating the originally-created in-memory object. Always re-read the
    // authoritative state before summarizing so production durable workflows
    // cannot report their stale initial `created` status after execution.
    run = this.#state.getWorkflow(run.id) ?? run;
    const completed = run.steps.filter((step) => step.status === 'completed');
    const finalStep = completed[completed.length - 1] ?? null;
    const finalResult = finalStep?.resultId ? this.#bus.result(finalStep.runId) : null;
    return {
      workflowId: run.id,
      status: run.status,
      finalStepId: finalStep?.id ?? null,
      finalTaskId: finalStep?.taskId ?? null,
      finalRunId: finalStep?.runId ?? null,
      finalResult,
      steps: run.steps.map((step) => ({
        id: step.id,
        index: step.index,
        recipient: step.recipient,
        taskId: step.taskId,
        runId: step.runId,
        resultId: step.resultId,
        status: step.status,
      })),
      error: run.error,
    };
  }

  /**
   * Execute a workflow sequentially.
   * @param {object} spec - a WorkflowSpec (`sender`, `steps`).
   * @returns {Promise<object>} a normalized workflow result; `status` is one of
   *   `completed` | `failed` | `cancelled` and `error` carries the failing step.
   */
  async run(spec = {}) {
    const run = createWorkflowRun(spec);
    this.#state.createWorkflow(run);
    this.#emit('workflow.created', { workflowId: run.id, workflow: run });
    for (const step of run.steps) {
      this.#emit('step.created', {
        workflowId: run.id,
        stepId: step.id,
        stepIndex: step.index,
        recipient: step.recipient,
      });
    }

    if (this.#cancelled.has(run.id)) {
      this.#skipRemaining(run, 0);
      this.#state.updateWorkflowStatus(run.id, { status: 'cancelled', completedAt: nowUtc() });
      this.#emit('workflow.cancelled', { workflowId: run.id });
      this.#cancelled.delete(run.id);
      return this.#summarize(run);
    }

    this.#state.updateWorkflowStatus(run.id, { status: 'running', startedAt: nowUtc() });
    this.#emit('workflow.started', { workflowId: run.id });

    for (let i = 0; i < run.steps.length; i += 1) {
      const step = run.steps[i];
      if (this.#cancelled.has(run.id)) {
        this.#skipRemaining(run, i);
        break;
      }

      let effectiveContext = step.context;
      let derivedHandoff = null;
      if (step.contextFromPrevious && i > 0) {
        const previousStep = run.steps[i - 1];
        const previousResult = previousStep.resultId ? this.#bus.result(previousStep.runId) : null;
        if (previousResult) {
          derivedHandoff = buildHandoffContext({
            workflow: run,
            previousStep,
            previousResult,
            nextStep: step,
          });
          effectiveContext = mergeStepContext({ derived: derivedHandoff, explicit: step.context });
        }
      }
      this.#state.updateStepStatus(run.id, step.id, { dispatchedContext: effectiveContext });
      if (derivedHandoff) {
        this.#emit('handoff.created', {
          workflowId: run.id,
          fromStepId: run.steps[i - 1].id,
          fromRunId: run.steps[i - 1].runId,
          toStepIndex: step.index,
          context: derivedHandoff,
        });
      }

      this.#state.updateStepStatus(run.id, step.id, { status: 'running' });
      this.#emit('step.started', {
        workflowId: run.id,
        stepId: step.id,
        stepIndex: step.index,
        recipient: step.recipient,
      });

      const taskId = createId('task');
      this.#active.set(taskId, { workflowId: run.id, stepId: step.id });
      this.#state.updateStepStatus(run.id, step.id, { taskId });
      // Keep the execution-local record aligned with durable states that
      // return snapshots instead of mutating `step`; failure/cancel lineage
      // below needs this task id to recover the AgentBus run id.
      step.taskId = taskId;

      try {
        const dispatched = await this.#bus.dispatch({
          sender: run.sender,
          recipient: step.recipient,
          body: step.body,
          context: effectiveContext,
          expectedOutput: step.expectedOutput,
          taskId,
        });
        const result = this.#bus.result(dispatched.id);
        this.#active.delete(taskId);
        this.#state.updateStepStatus(run.id, step.id, {
          status: 'completed',
          runId: dispatched.id,
          resultId: result?.id ?? null,
        });
        this.#emit('step.completed', {
          workflowId: run.id,
          stepId: step.id,
          stepIndex: step.index,
          taskId,
          runId: dispatched.id,
          resultId: result?.id ?? null,
        });
      } catch (error) {
        this.#active.delete(taskId);
        const runId = this.#resolveActiveRunId(step) ?? null;
        let runStatus = null;
        if (runId) {
          try {
            runStatus = this.#bus.run(runId)?.status ?? null;
          } catch {
            runStatus = null;
          }
        }
        const cancelled = this.#cancelled.has(run.id) || runStatus === 'cancelled';
        const stepStatus = cancelled ? 'cancelled' : 'failed';
        const sanitized = toSanitizedError(error);
        this.#state.updateStepStatus(run.id, step.id, { status: stepStatus, runId, error: sanitized });
        this.#emit(stepStatus === 'cancelled' ? 'step.cancelled' : 'step.failed', {
          workflowId: run.id,
          stepId: step.id,
          stepIndex: step.index,
          taskId,
          runId,
          error: sanitized,
        });
        this.#skipRemaining(run, i + 1);
        const wfStatus = cancelled ? 'cancelled' : 'failed';
        const wfError = cancelled
          ? null
          : { stepIndex: step.index, stepId: step.id, runId, error: sanitized };
        this.#state.updateWorkflowStatus(run.id, { status: wfStatus, completedAt: nowUtc(), error: wfError });
        this.#emit(wfStatus === 'cancelled' ? 'workflow.cancelled' : 'workflow.failed', {
          workflowId: run.id,
          stepId: step.id,
          stepIndex: step.index,
          error: wfError,
        });
        this.#cancelled.delete(run.id);
        return this.#summarize(run);
      }
    }

    if (this.#cancelled.has(run.id)) {
      this.#skipRemaining(run, run.steps.length);
      this.#state.updateWorkflowStatus(run.id, { status: 'cancelled', completedAt: nowUtc() });
      this.#emit('workflow.cancelled', { workflowId: run.id });
      this.#cancelled.delete(run.id);
      return this.#summarize(run);
    }

    this.#state.updateWorkflowStatus(run.id, { status: 'completed', completedAt: nowUtc() });
    this.#emit('workflow.completed', { workflowId: run.id });
    return this.#summarize(run);
  }

  /** Mark every step from `startIndex` onward as skipped (predeclared steps). */
  #skipRemaining(run, startIndex) {
    for (let j = startIndex; j < run.steps.length; j += 1) {
      const step = run.steps[j];
      if (step.status !== 'created') continue;
      this.#state.updateStepStatus(run.id, step.id, { status: 'skipped' });
      this.#emit('step.skipped', {
        workflowId: run.id,
        stepId: step.id,
        stepIndex: step.index,
        recipient: step.recipient,
      });
    }
  }

  /** Best source of truth for the currently-active step's AgentBus run id. */
  #resolveActiveRunId(step) {
    if (typeof this.#bus.listRuns === 'function' && step.taskId) {
      const byTask = this.#bus.listRuns({ taskId: step.taskId });
      if (byTask.length > 0) return byTask[0].id;
    }
    return this.#activeRunId.get(step.taskId) ?? null;
  }

  /**
   * Cancel a running workflow: mark it cancelled, abort the active step's
   * AgentBus run where one is running, and prevent all future dispatches.
   * Safe/idempotent; races resolve to a valid terminal state.
   * @param {string} workflowId
   * @returns {Promise<object>} the (now cancelled) WorkflowRun.
   */
  async cancel(workflowId) {
    const run = this.#state.getWorkflow(workflowId);
    if (!run) throw new BusError(`unknown workflow: ${workflowId}`);
    if (run.status !== 'running') {
      throw new BusError(`cannot cancel workflow "${workflowId}": current status is ${run.status}`);
    }
    this.#cancelled.add(workflowId);
    const activeStep = run.steps.find((step) => step.status === 'running');
    if (activeStep) {
      const runId = this.#resolveActiveRunId(activeStep);
      if (runId && typeof this.#bus.cancel === 'function') {
        try {
          await this.#bus.cancel(runId);
        } catch {
          // best-effort; the runner still stops future dispatches
        }
      }
    }
    return run;
  }
}
