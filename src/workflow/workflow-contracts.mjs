/**
 * Workflow layer — WorkflowRun / StepRecord / WorkflowSpec contracts.
 *
 * A workflow is data-driven sequencing above AgentBus: the spec names
 * backends by runtime identity (never a permanent role), the runner turns each
 * step into one explicit `AgentBus.dispatch()`, and derived context flows from
 * one normalized ResultEnvelope to the next task's context.
 *
 * The core workflow contract is backend-neutral: no field here encodes
 * Codex/Claude/Grok identity, review roles, or debate policy.
 *
 * WorkflowRun:
 *   { id, sender, status, startedAt, completedAt, steps, error }
 * StepRecord:
 *   { id, workflowId, index, recipient, body, expectedOutput,
 *     context, contextFromPrevious, taskId, runId, resultId,
 *     dispatchedContext, status, error }
 */

import { createId } from '../bus/envelopes.mjs';
import { BusError, InvalidEnvelopeError } from '../bus/errors.mjs';

export const WORKFLOW_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled'];
export const STEP_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled', 'skipped'];

const WORKFLOW_TRANSITIONS = {
  created: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
};

const STEP_TRANSITIONS = {
  created: new Set(['running', 'skipped', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
};

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEnvelopeError(`${label} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {string} from @param {string} to */
export function assertWorkflowTransition(from, to) {
  const allowed = WORKFLOW_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new BusError(`invalid workflow status transition: ${from} -> ${to}`);
  }
  return to;
}

/** @param {string} from @param {string} to */
export function assertStepTransition(from, to) {
  const allowed = STEP_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new BusError(`invalid step status transition: ${from} -> ${to}`);
  }
  return to;
}

/**
 * Create a validated StepRecord for one workflow step.
 * @param {object} input
 * @param {string} input.workflowId
 * @param {number} input.index
 * @param {string} input.recipient - registered backend name (runtime identity).
 * @param {string} input.body - the task text for this step.
 * @param {object} [input.context] - explicit context packet for this step.
 * @param {string|null} [input.expectedOutput] - optional expected-output hint.
 * @param {boolean} [input.contextFromPrevious] - when true, the runner derives
 *   this step's context from the previous step's ResultEnvelope (merged over
 *   any explicit `context`; explicit keys win).
 */
export function createStepRecord({ workflowId, index, recipient, body, context, expectedOutput, contextFromPrevious } = {}) {
  const label = `workflow.steps[${index}]`;
  const normalized = {
    id: createId('step'),
    workflowId: requireNonEmptyString(workflowId, 'step.workflowId'),
    index,
    recipient: requireNonEmptyString(recipient, `${label}.recipient`),
    body: requireNonEmptyString(body, `${label}.body`),
    expectedOutput: null,
    context: {},
    contextFromPrevious: contextFromPrevious === true,
    taskId: null,
    runId: null,
    resultId: null,
    dispatchedContext: null,
    status: 'created',
    error: null,
  };
  if (expectedOutput !== undefined && expectedOutput !== null) {
    if (typeof expectedOutput !== 'string' || expectedOutput.trim() === '') {
      throw new InvalidEnvelopeError(`${label}.expectedOutput must be a non-empty string when provided`);
    }
    normalized.expectedOutput = expectedOutput;
  }
  if (context !== undefined && context !== null) {
    if (!isPlainObject(context)) {
      throw new InvalidEnvelopeError(`${label}.context must be a plain object`);
    }
    normalized.context = context;
  }
  return normalized;
}

/**
 * Create a validated WorkflowRun from a WorkflowSpec.
 *
 * @param {object} spec
 * @param {string} [spec.id] - workflow id (`wf_...`); generated when omitted.
 * @param {string} [spec.sender] - dispatching identity, defaults to `'pm'`.
 * @param {object[]} spec.steps - ordered step specs; each becomes a StepRecord.
 */
export function createWorkflowRun({ id, sender, steps } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new InvalidEnvelopeError('workflow.steps must be a non-empty array');
  }
  const run = {
    id: id ?? createId('wf'),
    sender: sender === undefined ? 'pm' : requireNonEmptyString(sender, 'workflow.sender'),
    status: 'created',
    startedAt: null,
    completedAt: null,
    steps: [],
    error: null,
  };
  run.steps = steps.map((step, index) => createStepRecord({ workflowId: run.id, index, ...step }));
  return run;
}
