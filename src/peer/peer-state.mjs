/**
 * Peer layer — PeerState.
 *
 * Owns in-memory conversation/hop records plus a per-conversation transcript
 * and message index. All mutation goes through explicit methods so the status
 * state machines are enforced in one place. The peer layer stores its own
 * peer-message envelopes (mirroring the bus's central record) so conversations
 * are self-contained and retrieval never exposes mutable internal collections.
 *
 * No database in T5; JSON-serializable records only.
 */

import { BusError, toSanitizedError } from '../bus/errors.mjs';
import {
  createConversationRecord,
  createPeerHopRecord,
  assertConversationTransition,
  assertHopTransition,
  CONVERSATION_STATUSES,
  HOP_STATUSES,
} from './peer-contracts.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class PeerState {
  #conversations = new Map();
  #hops = new Map();
  #messages = new Map();
  #messagesByConversation = new Map();
  #transcript = [];

  /** @param {object} [input] @returns {object} the created ConversationRecord. */
  createConversation(input = {}) {
    const record = createConversationRecord(input);
    this.#conversations.set(record.id, record);
    return record;
  }

  /** @returns {object|undefined} the conversation record (a live reference). */
  getConversation(id) {
    return this.#conversations.get(id);
  }

  /**
   * Transition a conversation's status. Enforces the explicit state machine.
   * @param {string} id
   * @param {{ status: string, error?: object|null }} patch
   * @returns {object} the updated conversation record.
   */
  updateConversationStatus(id, { status, error } = {}) {
    const record = this.#conversations.get(id);
    if (!record) throw new BusError(`unknown conversation: ${id}`);
    if (!CONVERSATION_STATUSES.includes(status)) throw new BusError(`invalid conversation status: ${String(status)}`);
    if (TERMINAL.has(record.status)) {
      throw new BusError(`conversation "${id}" is already terminal (${record.status})`);
    }
    assertConversationTransition(record.status, status);
    if (error !== undefined) record.error = error === null ? null : toSanitizedError(error);
    record.status = status;
    return record;
  }

  /**
   * Create a hop within a conversation (conversation must not be terminal).
   * @param {object} input - `conversationId`, `index`, `from`, `to`.
   * @returns {object} the created PeerHopRecord.
   */
  createHop({ conversationId, index, from, to }) {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) throw new BusError(`unknown conversation: ${conversationId}`);
    if (TERMINAL.has(conversation.status)) {
      throw new BusError(`cannot create hop in terminal conversation "${conversationId}" (${conversation.status})`);
    }
    const hop = createPeerHopRecord({ conversationId, index, from, to });
    this.#hops.set(hop.id, hop);
    conversation.hops.push(hop.id);
    return hop;
  }

  /** @returns {object|undefined} the hop record (a live reference). */
  getHop(id) {
    return this.#hops.get(id);
  }

  /** @returns {object[]} hops for a conversation in creation order. */
  hopsForConversation(conversationId) {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) throw new BusError(`unknown conversation: ${conversationId}`);
    return conversation.hops.map((id) => this.#hops.get(id)).filter(Boolean);
  }

  /**
   * Transition a hop's status and/or update its fields.
   * @param {string} id
   * @param {{ status?: string, [k: string]: any }} patch - `status` is optional
   *   (a field-only patch performs no transition).
   * @returns {object} the updated hop record.
   */
  updateHopStatus(id, patch = {}) {
    const hop = this.#hops.get(id);
    if (!hop) throw new BusError(`unknown hop: ${id}`);
    const { status, ...fields } = patch;
    if (status !== undefined) {
      if (!HOP_STATUSES.includes(status)) throw new BusError(`invalid hop status: ${String(status)}`);
      if (TERMINAL.has(hop.status)) {
        throw new BusError(`hop "${id}" is already terminal (${hop.status})`);
      }
      assertHopTransition(hop.status, status);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) hop[key] = value === null ? null : value;
    }
    if (patch.error !== undefined) hop.error = patch.error === null ? null : toSanitizedError(patch.error);
    if (status !== undefined) hop.status = status;
    return hop;
  }

  /**
   * Register a peer message envelope against a conversation for retrieval.
   * @param {string} conversationId
   * @param {object} message - a validated MessageEnvelope.
   */
  addConversationMessage(conversationId, message) {
    this.#messages.set(message.id, message);
    let ids = this.#messagesByConversation.get(conversationId);
    if (!ids) {
      ids = [];
      this.#messagesByConversation.set(conversationId, ids);
    }
    ids.push(message.id);
  }

  /** @returns {object[]} messages for a conversation in creation order. */
  messagesForConversation(conversationId) {
    return (this.#messagesByConversation.get(conversationId) ?? [])
      .map((id) => this.#messages.get(id))
      .filter(Boolean);
  }

  /** Append a peer transcript entry (ordered, per conversation). */
  appendEvent(entry) {
    this.#transcript.push({
      at: entry.at ?? new Date().toISOString(),
      conversationId: entry.conversationId,
      hopId: entry.hopId ?? null,
      messageId: entry.messageId ?? null,
      taskId: entry.taskId ?? null,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    });
  }

  /** Ordered transcript entries for a conversation. @returns {object[]} */
  transcriptForConversation(conversationId) {
    return this.#transcript.filter((entry) => entry.conversationId === conversationId);
  }

  /** @returns {object[]} all transcript entries. */
  transcript() {
    return this.#transcript;
  }

  /** @returns {number} number of conversations recorded. */
  get conversationCount() {
    return this.#conversations.size;
  }

  /** @returns {number} number of hops recorded. */
  get hopCount() {
    return this.#hops.size;
  }
}