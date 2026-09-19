/**
 * Workflow layer — canonical automatic handoff context builder.
 *
 * Converts a previous step's normalized ResultEnvelope into the context packet
 * for the next task. Backend-neutral: field names are structural
 * (`previousResult.output`, `handoff`, ...), never role-specific
 * (`reviewerOutput`, `coderResult`).
 *
 * Guarantees:
 *  - deterministic (fixed key order, plain JSON-compatible values);
 *  - structured `handoff` is carried as a structure, never parsed prose;
 *  - previous normalized `output` is carried as text;
 *  - no environment variables, auth/session state, or hidden runtime data;
 *  - bounded: only the previous result is carried, not an unbounded transcript.
 */

import { InvalidEnvelopeError } from '../bus/errors.mjs';

/**
 * @param {object} input
 * @param {object} input.workflow - the WorkflowRun owning the steps.
 * @param {object} input.previousStep - the completed StepRecord.
 * @param {object} input.previousResult - the previous ResultEnvelope.
 * @param {object} input.nextStep - the StepRecord that will receive this context.
 * @returns {{
 *   workflow: { workflowId: string, previousStepId: string, previousTaskId: string|null,
 *     previousRunId: string|null, previousAgent: string|null },
 *   previousResult: { status: string, output: string, artifacts: object[], handoff: object|null }
 * }}
 */
export function buildHandoffContext({ workflow, previousStep, previousResult, nextStep } = {}) {
  if (!workflow || typeof workflow !== 'object' || typeof workflow.id !== 'string') {
    throw new InvalidEnvelopeError('buildHandoffContext requires a workflow with an id');
  }
  if (!previousStep || typeof previousStep !== 'object' || typeof previousStep.id !== 'string') {
    throw new InvalidEnvelopeError('buildHandoffContext requires a previousStep with an id');
  }
  if (!previousResult || typeof previousResult !== 'object') {
    throw new InvalidEnvelopeError('buildHandoffContext requires a previous ResultEnvelope');
  }
  const handoff =
    previousResult.handoff === undefined || previousResult.handoff === null
      ? null
      : { ...previousResult.handoff };
  return {
    workflow: {
      workflowId: workflow.id,
      previousStepId: previousStep.id,
      previousTaskId: previousResult.taskId ?? null,
      previousRunId: previousResult.runId ?? null,
      previousAgent: previousResult.agent ?? null,
    },
    previousResult: {
      status: previousResult.status ?? 'completed',
      output: typeof previousResult.output === 'string' ? previousResult.output : '',
      artifacts: Array.isArray(previousResult.artifacts) ? [...previousResult.artifacts] : [],
      handoff,
    },
  };
}

/**
 * Merge derived handoff context with a step's explicit context.
 *
 * Documented precedence: the derived handoff context is the base; step-level
 * explicit context keys override on a per-top-level-key basis (explicit wins).
 * When there is no explicit context, the derived context is used unchanged.
 *
 * @param {object} input
 * @param {object} [input.derived] - context from buildHandoffContext().
 * @param {object} [input.explicit] - the step's explicit `context`.
 * @returns {object}
 */
export function mergeStepContext({ derived, explicit } = {}) {
  const base = derived === undefined || derived === null ? {} : derived;
  const extra = explicit === undefined || explicit === null ? {} : explicit;
  return { ...base, ...extra };
}
