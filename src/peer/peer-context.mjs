/**
 * Peer layer — canonical bounded peer context packet.
 *
 * The fresh one-shot recipient of a Level-1 relay must receive enough explicit
 * context to understand the peer message WITHOUT pretending it shares native
 * session memory. This module builds that packet deterministically and keeps
 * history bounded.
 *
 * Default history bound: the most recent 8 conversation messages. `recentMessages`
 * must already be in conversation order (oldest first); the builder keeps the
 * newest `limit` entries in that same deterministic order.
 *
 * Merge precedence: derived `peer`/`source`/`request`/`recentMessages` are the
 * base; an optional `explicitContext`'s top-level keys override per top-level
 * key (explicit wins). This is documented and tested.
 */

import { InvalidEnvelopeError } from '../bus/errors.mjs';

export const DEFAULT_PEER_HISTORY_LIMIT = 8;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeMessage(message) {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    body: message.body,
    replyTo: message.replyTo ?? null,
    createdAt: message.createdAt,
  };
}

/**
 * Build the canonical bounded peer context packet for a fresh recipient.
 *
 * @param {object} input
 * @param {object} input.conversation - a ConversationRecord.
 * @param {object} input.hop - the active PeerHopRecord.
 * @param {object} input.requestMessage - the recorded request MessageEnvelope.
 * @param {object|null} [input.sourceResult] - optional originating ResultEnvelope
 *   (lineage + material that produced the request).
 * @param {object[]} [input.recentMessages] - conversation messages oldest-first.
 * @param {number} [input.limit] - history bound, defaults to 8.
 * @param {object} [input.explicitContext] - optional caller packet; top-level
 *   keys override the derived packet.
 * @returns {object} a JSON-compatible, deterministic context packet.
 * @throws {InvalidEnvelopeError} on malformed input.
 */
export function buildPeerContext({
  conversation,
  hop,
  requestMessage,
  sourceResult = null,
  recentMessages = [],
  limit = DEFAULT_PEER_HISTORY_LIMIT,
  explicitContext = null,
}) {
  if (!isPlainObject(conversation) || typeof conversation.id !== 'string') {
    throw new InvalidEnvelopeError('buildPeerContext requires a conversation record');
  }
  if (!isPlainObject(hop) || typeof hop.id !== 'string') {
    throw new InvalidEnvelopeError('buildPeerContext requires a hop record');
  }
  if (!isPlainObject(requestMessage) || typeof requestMessage.id !== 'string') {
    throw new InvalidEnvelopeError('buildPeerContext requires a request message envelope');
  }
  if (!Array.isArray(recentMessages)) {
    throw new InvalidEnvelopeError('buildPeerContext recentMessages must be an array');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidEnvelopeError('buildPeerContext limit must be a positive integer');
  }
  if (explicitContext !== null && explicitContext !== undefined && !isPlainObject(explicitContext)) {
    throw new InvalidEnvelopeError('buildPeerContext explicitContext must be a plain object');
  }

  const source = {
    taskId: sourceResult?.taskId ?? null,
    runId: sourceResult?.runId ?? null,
    resultId: sourceResult?.id ?? null,
    output: typeof sourceResult?.output === 'string' ? sourceResult.output : '',
    handoff: sourceResult?.handoff ?? null,
    artifacts: Array.isArray(sourceResult?.artifacts) ? sourceResult.artifacts : [],
  };

  const request = {
    body: requestMessage.body,
    metadata: requestMessage.metadata ?? {},
  };

  const normalized = recentMessages
    .filter((message) => isPlainObject(message) && typeof message.id === 'string')
    .slice(-limit)
    .map(normalizeMessage);

  const derived = {
    peer: {
      conversationId: conversation.id,
      hopId: hop.id,
      from: hop.from,
      to: hop.to,
      requestMessageId: requestMessage.id,
      replyTo: requestMessage.replyTo ?? null,
    },
    source,
    request,
    recentMessages: normalized,
  };

  return explicitContext ? { ...derived, ...explicitContext } : derived;
}

/**
 * Normalize a list of conversation messages for context inclusion (bounded).
 * @param {object[]} messages - conversation messages oldest-first.
 * @param {number} [limit]
 * @returns {object[]} normalized bounded messages.
 */
export function boundedRecentMessages(messages, limit = DEFAULT_PEER_HISTORY_LIMIT) {
  if (!Array.isArray(messages)) throw new InvalidEnvelopeError('messages must be an array');
  return messages.slice(-limit).map(normalizeMessage);
}