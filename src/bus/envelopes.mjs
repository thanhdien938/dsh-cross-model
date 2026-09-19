/**
 * Agent Bus Core envelopes and run records.
 *
 * Small explicit plain-object contracts. Envelopes are validated at creation;
 * IDs are generated when omitted and are collision-resistant for local
 * orchestration. Envelopes deliberately avoid backend-specific fields — the
 * core stays backend-neutral.
 */

import { randomUUID } from 'node:crypto';
import { InvalidEnvelopeError } from './errors.mjs';

/** @returns {string} current time as an ISO-8601 UTC string. */
export function nowUtc() {
  return new Date().toISOString();
}

/** @param {string} prefix @returns {string} `prefix_<uuid>` */
export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEnvelopeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, label);
}

function optionalObject(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidEnvelopeError(`${label} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new InvalidEnvelopeError(`${label} must be a plain object`);
  }
  return value;
}

/**
 * Create a validated TaskEnvelope.
 *
 * @param {object} input
 * @param {string} [input.id] - task id (`task_...`); generated when omitted.
 * @param {string} [input.sender] - dispatching identity, defaults to `'pm'`.
 * @param {string} input.recipient - registered backend name (runtime identity, not a role).
 * @param {string} input.body - the task text.
 * @param {object} [input.context] - free-form extensible context.
 * @param {string|null} [input.expectedOutput] - optional expected-output hint.
 * @param {string} [input.createdAt] - ISO-8601 UTC; defaults to now.
 * @returns {{ id: string, sender: string, recipient: string, type: 'task', body: string, context: object, expectedOutput: string|null, createdAt: string }}
 */
export function createTaskEnvelope(input = {}) {
  const sender = input.sender === undefined ? 'pm' : requireNonEmptyString(input.sender, 'task.sender');
  const recipient = requireNonEmptyString(input.recipient, 'task.recipient');
  const body = requireNonEmptyString(input.body, 'task.body');
  return {
    id: input.id ?? createId('task'),
    sender,
    recipient,
    type: 'task',
    body,
    context: optionalObject(input.context, 'task.context') ?? {},
    expectedOutput: optionalString(input.expectedOutput, 'task.expectedOutput'),
    createdAt: input.createdAt ?? nowUtc(),
  };
}

/**
 * Create a validated MessageEnvelope. The central bus owns message recording so
 * the PM can always observe lineage. Envelope fields are backend-neutral and
 * JSON-serializable; `conversationId`/`hopId`/`metadata` are optional peer-layer
 * extensions and default to null/`{}` so existing callers are unaffected.
 *
 * @param {object} input
 * @param {string} [input.id] - message id (`msg_...`); generated when omitted.
 * @param {string|null} [input.taskId] - owning task id; null for
 *   conversation-scoped peer messages that predate a recipient task.
 * @param {string|null} [input.runId] - owning run id, or null when not run-scoped.
 * @param {string} input.from - sender identity.
 * @param {string} input.to - recipient identity (registered backend or `pm`).
 * @param {string} [input.kind] - message kind, defaults to `'message'`.
 * @param {string} input.body - message text.
 * @param {string|null} [input.replyTo] - id of the message this replies to.
 * @param {string|null} [input.conversationId] - peer conversation id (optional).
 * @param {string|null} [input.hopId] - peer hop id (optional).
 * @param {object|null} [input.metadata] - optional plain-object metadata.
 * @param {string} [input.createdAt] - ISO-8601 UTC; defaults to now.
 * @returns {{ id: string, taskId: string|null, runId: string|null, from: string, to: string, kind: string, body: string, replyTo: string|null, conversationId: string|null, hopId: string|null, metadata: object, createdAt: string }}
 */
export function createMessageEnvelope(input = {}) {
  const taskId = optionalString(input.taskId, 'message.taskId');
  const from = requireNonEmptyString(input.from, 'message.from');
  const to = requireNonEmptyString(input.to, 'message.to');
  const body = requireNonEmptyString(input.body, 'message.body');
  return {
    id: input.id ?? createId('msg'),
    taskId,
    runId: optionalString(input.runId, 'message.runId'),
    from,
    to,
    kind: input.kind === undefined ? 'message' : requireNonEmptyString(input.kind, 'message.kind'),
    body,
    replyTo: optionalString(input.replyTo, 'message.replyTo'),
    conversationId: optionalString(input.conversationId, 'message.conversationId'),
    hopId: optionalString(input.hopId, 'message.hopId'),
    metadata: optionalObject(input.metadata, 'message.metadata') ?? {},
    createdAt: input.createdAt ?? nowUtc(),
  };
}

const RESULT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Create a validated ResultEnvelope. Adapter-specific outputs are normalized
 * here into the single `output` string plus an `artifacts` list.
 *
 * @param {object} input
 * @param {string} [input.id] - result id (`result_...`); generated when omitted.
 * @param {string} input.taskId - owning task id.
 * @param {string} input.runId - owning run id.
 * @param {string} input.agent - backend name that produced the result.
 * @param {'completed'|'failed'|'cancelled'} input.status - terminal result status.
 * @param {string} [input.output] - normalized final text.
 * @param {string|null} [input.stopReason] - optional backend stop reason.
 * @param {Array} [input.artifacts] - artifact descriptors.
 * @param {object|null} [input.handoff] - reserved for later handoff data.
 * @param {string} [input.completedAt] - ISO-8601 UTC; defaults to now.
 * @returns {object}
 */
export function createResultEnvelope(input = {}) {
  const taskId = requireNonEmptyString(input.taskId, 'result.taskId');
  const runId = requireNonEmptyString(input.runId, 'result.runId');
  const agent = requireNonEmptyString(input.agent, 'result.agent');
  if (!RESULT_STATUSES.has(input.status)) {
    throw new InvalidEnvelopeError(`result.status must be one of ${[...RESULT_STATUSES].join(', ')}`);
  }
  const artifacts = input.artifacts === undefined ? [] : input.artifacts;
  if (!Array.isArray(artifacts)) throw new InvalidEnvelopeError('result.artifacts must be an array');
  return {
    id: input.id ?? createId('result'),
    taskId,
    runId,
    agent,
    status: input.status,
    output: typeof input.output === 'string' ? input.output : '',
    stopReason: optionalString(input.stopReason, 'result.stopReason'),
    artifacts,
    handoff: optionalObject(input.handoff, 'result.handoff'),
    completedAt: input.completedAt ?? nowUtc(),
  };
}

const RUN_STATUSES = new Set(['created', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Create a validated RunRecord in the initial `created` state.
 *
 * @param {object} input
 * @param {string} [input.id] - run id (`run_...`); generated when omitted.
 * @param {string} input.taskId - owning task id.
 * @param {string} input.agent - backend name this run executes on.
 * @returns {{ id: string, taskId: string, agent: string, status: 'created', startedAt: null, completedAt: null, error: null }}
 */
export function createRunRecord(input = {}) {
  const taskId = requireNonEmptyString(input.taskId, 'run.taskId');
  const agent = requireNonEmptyString(input.agent, 'run.agent');
  return {
    id: input.id ?? createId('run'),
    taskId,
    agent,
    status: 'created',
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

/** @returns {Set<string>} the set of valid run statuses. */
export function runStatuses() {
  return new Set(RUN_STATUSES);
}
