/**
 * Peer layer — ConversationRecord / PeerHopRecord contracts.
 *
 * The peer layer sits ABOVE AgentBus and owns only conversation/hop/message
 * lineage. It is backend-neutral and role-neutral: a hop names `from`/`to` by
 * runtime backend identity, never a permanent role, and the contracts carry no
 * provider-specific fields.
 *
 * ConversationRecord:
 *   { id, status, createdAt, startedAt, completedAt, messages, hops, error }
 * PeerHopRecord:
 *   { id, conversationId, index, from, to, requestMessageId, responseMessageId,
 *     sourceTaskId, sourceRunId, sourceResultId, recipientTaskId, recipientRunId,
 *     recipientResultId, status, createdAt, completedAt, error }
 *
 * Status transitions are enforced by an explicit deterministic state machine.
 */

import { createId } from '../bus/envelopes.mjs';
import { BusError, InvalidEnvelopeError } from '../bus/errors.mjs';

export const CONVERSATION_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled'];
export const HOP_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled'];

const CONVERSATION_TRANSITIONS = {
  created: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['completed', 'failed', 'cancelled']),
};

const HOP_TRANSITIONS = {
  created: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
};

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

function optionalPlainObject(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidEnvelopeError(`${label} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new InvalidEnvelopeError(`${label} must be a plain object`);
  }
  return value;
}

/** @param {string} from @param {string} to */
export function assertConversationTransition(from, to) {
  const allowed = CONVERSATION_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new BusError(`invalid conversation status transition: ${from} -> ${to}`);
  }
  return to;
}

/** @param {string} from @param {string} to */
export function assertHopTransition(from, to) {
  const allowed = HOP_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new BusError(`invalid hop status transition: ${from} -> ${to}`);
  }
  return to;
}

/**
 * Create a validated ConversationRecord in the initial `created` state.
 * @param {object} [input]
 * @param {string} [input.id] - conversation id (`conv_...`); generated when omitted.
 * @param {string} [input.createdAt] - ISO-8601 UTC; defaults to now.
 * @returns {object}
 */
export function createConversationRecord({ id, createdAt } = {}) {
  return {
    id: id ?? createId('conv'),
    status: 'created',
    createdAt: createdAt ?? new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    messages: [],
    hops: [],
    error: null,
  };
}

/**
 * Create a validated PeerHopRecord in the initial `created` state.
 * @param {object} input
 * @param {string} input.conversationId
 * @param {number} input.index - zero-based hop index within the conversation.
 * @param {string} input.from - sender backend identity.
 * @param {string} input.to - recipient backend identity.
 * @param {string} [input.id] - hop id (`hop_...`); generated when omitted.
 * @param {string} [input.createdAt] - ISO-8601 UTC; defaults to now.
 * @returns {object}
 */
export function createPeerHopRecord({ conversationId, index, from, to, id, createdAt } = {}) {
  return {
    id: id ?? createId('hop'),
    conversationId: requireNonEmptyString(conversationId, 'hop.conversationId'),
    index,
    from: requireNonEmptyString(from, 'hop.from'),
    to: requireNonEmptyString(to, 'hop.to'),
    requestMessageId: null,
    responseMessageId: null,
    sourceTaskId: null,
    sourceRunId: null,
    sourceResultId: null,
    recipientTaskId: null,
    recipientRunId: null,
    recipientResultId: null,
    status: 'created',
    createdAt: createdAt ?? new Date().toISOString(),
    completedAt: null,
    error: null,
  };
}

/** Normalize an explicit source-result lineage into a hop patch (all optional). */
export function sourceLineage({ taskId, runId, resultId }) {
  return {
    sourceTaskId: optionalString(taskId, 'hop.sourceTaskId'),
    sourceRunId: optionalString(runId, 'hop.sourceRunId'),
    sourceResultId: optionalString(resultId, 'hop.sourceResultId'),
  };
}

/** Normalize an explicit context packet (must be a plain object). */
export function peerContextPacket(value, label = 'peer.context') {
  return optionalPlainObject(value, label);
}