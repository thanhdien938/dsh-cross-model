/**
 * Peer layer — DurablePeerState.
 *
 * An explicit, project-owned durable replacement for the legacy in-memory
 * {@link PeerState}. It preserves the exact PeerState-facing API that
 * PeerRelay and tooling already consume (`createConversation`, `getConversation`,
 * `updateConversationStatus`, `createHop`, `getHop`, `hopsForConversation`,
 * `updateHopStatus`, `addConversationMessage`, `messagesForConversation`,
 * `appendEvent`, `transcriptForConversation`, `transcript`, `conversationCount`,
 * `hopCount`), so a relay constructed with `state: new DurablePeerState(...)`
 * needs no relay SQL knowledge.
 *
 * It additionally exposes the Gate-4 atomic hop-preparation capability
 * (`hasAtomicHopPrepare` + `prepareHop`) that PeerRelay feature-detects: one
 * local transaction persists the hop intent, its running status, the
 * request-message commit, and the request-message linkage BEFORE any
 * downstream AgentBus dispatch. A failed local prepare leaves zero partial
 * state and therefore never dispatches.
 *
 * This module contains no database driver import and no SQL. Constructing a
 * DurablePeerState requires an open/migrated persistence store behind it;
 * hydration performs NO automatic execution — nonterminal conversations/hops
 * are merely observable after reopen.
 */

import { BusError } from '../bus/errors.mjs';
import {
  createConversationRecord,
  createPeerHopRecord,
  assertConversationTransition,
  assertHopTransition,
  CONVERSATION_STATUSES,
} from './peer-contracts.mjs';

const PEER_STATE_METHODS = Object.freeze([
  'createConversation',
  'getConversation',
  'updateConversationStatus',
  'createHop',
  'getHop',
  'hopsForConversation',
  'updateHopStatus',
  'addConversationMessage',
  'messagesForConversation',
  'appendEvent',
  'transcriptForConversation',
  'transcript',
]);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class DurablePeerState {
  /**
   * @param {object} deps
   * @param {object} deps.repository - a Peer domain repository over an
   *   opened/migrated persistence store. Must expose the full PeerState
   *   mutation/read surface plus the atomic-hop-prepare capability.
   */
  constructor({ repository } = {}) {
    if (repository === null || typeof repository !== 'object') {
      throw new TypeError('DurablePeerState requires a Peer repository');
    }
    const missing = PEER_STATE_METHODS.filter((name) => typeof repository[name] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(
        `DurablePeerState requires a repository with PeerState-facing methods; missing: ${missing.join(', ')}`,
      );
    }
    if (typeof repository.prepareHopAtomic !== 'function') {
      throw new TypeError('DurablePeerState requires a repository with prepareHopAtomic');
    }
    if (typeof repository.countConversations !== 'function' || typeof repository.countHops !== 'function') {
      throw new TypeError('DurablePeerState requires a repository with counts');
    }
    if (typeof repository.assertComplete !== 'function') {
      throw new TypeError('DurablePeerState requires a repository that can assert its own completeness');
    }
    repository.assertComplete();
    this.#repository = repository;
  }

  #repository;

  /** @returns {import('../persistence/repositories/peer-repository.mjs').PeerRepository} */
  get repository() {
    return this.#repository;
  }

  /** @param {object} [input] @returns {object} the created ConversationRecord. */
  createConversation(input = {}) {
    const record = createConversationRecord(input);
    return this.#repository.createConversation(record);
  }

  /** @returns {object|undefined} the conversation record. */
  getConversation(id) {
    return this.#repository.getConversation(id);
  }

  /**
   * Transition a conversation's status, enforcing the explicit state machine.
   * @param {string} id
   * @param {{ status: string, error?: object|null }} patch
   * @returns {object} the updated conversation record.
   */
  updateConversationStatus(id, patch = {}) {
    return this.#repository.updateConversationStatus(id, patch);
  }

  /**
   * Create a hop within a conversation (conversation must not be terminal).
   * @param {object} input - `conversationId`, `index`, `from`, `to`.
   * @returns {object} the created PeerHopRecord.
   */
  createHop(input = {}) {
    const record = createPeerHopRecord(input);
    return this.#repository.createHop(record);
  }

  /** @returns {object|undefined} the hop record. */
  getHop(id) {
    return this.#repository.getHop(id);
  }

  /** @returns {object[]} hops for a conversation in creation order. */
  hopsForConversation(conversationId) {
    return this.#repository.hopsForConversation(conversationId);
  }

  /**
   * Transition a hop's status and/or update its fields, enforcing the explicit
   * state machine for status changes.
   * @param {string} id
   * @param {{ status?: string, [k: string]: any }} patch
   * @returns {object} the updated hop record.
   */
  updateHopStatus(id, patch = {}) {
    return this.#repository.updateHopStatus(id, patch);
  }

  /**
   * Register a peer message envelope against a conversation for retrieval.
   * @param {string} conversationId
   * @param {object} message - a validated MessageEnvelope.
   */
  addConversationMessage(conversationId, message) {
    return this.#repository.addConversationMessage(conversationId, message);
  }

  /** @returns {object[]} messages for a conversation, in creation order. */
  messagesForConversation(conversationId) {
    return this.#repository.messagesForConversation(conversationId);
  }

  /** Append a peer transcript entry (ordered, durable). */
  appendEvent(entry) {
    return this.#repository.appendEvent(entry);
  }

  /** Ordered transcript entries for a conversation. @returns {object[]} */
  transcriptForConversation(conversationId) {
    return this.#repository.transcriptForConversation(conversationId);
  }

  /** @returns {object[]} all transcript entries. */
  transcript() {
    return this.#repository.transcript();
  }

  /** @returns {number} number of conversations recorded. */
  get conversationCount() {
    return this.#repository.countConversations();
  }

  /** @returns {number} number of hops recorded. */
  get hopCount() {
    return this.#repository.countHops();
  }

  /**
   * Durable-peer capability flag that PeerRelay feature-detects. When true
   * the relay uses {@link prepareHop} for the atomic pre-dispatch hop write
   * instead of the legacy chatty sequence.
   * @returns {true}
   */
  get hasAtomicHopPrepare() {
    return true;
  }

  /**
   * Atomic peer-hop prepare. Validates the conversation/hop state-machine
   * rules exactly like the legacy path, then delegates ONE local transaction
   * that persists the hop, its running state, the request-message commit, and
   * the request-message linkage together. No AgentBus dispatch is part of this
   * call, and a failure leaves zero partial state.
   *
   * @param {object} input
   * @param {string} input.conversationId
   * @param {{ status: string, error?: object|null }|null} [input.conversationPatch] - optional
   *   conversation transition (e.g. created -> running) applied atomically.
   * @param {object} input.hop - partial hop fields (`id`, `index`, `from`,
   *   `to`, `requestMessageId`, optional `sourceTaskId/sourceRunId/sourceResultId`,
   *   optional `completedAt`).
   * @param {object} input.requestMessage - MessageEnvelope to commit.
   * @returns {object} `{ conversation, hop, requestMessage }` after the atomic write.
   */
  prepareHop({ conversationId, conversationPatch = null, hop, requestMessage } = {}) {
    if (hop === null || typeof hop !== 'object') throw new TypeError('prepareHop requires a hop object');
    if (requestMessage === null || typeof requestMessage !== 'object') throw new TypeError('prepareHop requires a request message');
    const conversation = this.#repository.getConversation(conversationId);
    if (!conversation) throw new BusError(`unknown conversation: ${conversationId}`);
    if (conversationPatch) {
      if (!CONVERSATION_STATUSES.includes(conversationPatch.status)) {
        throw new BusError(`invalid conversation status: ${String(conversationPatch.status)}`);
      }
      if (TERMINAL.has(conversation.status)) {
        throw new BusError(`conversation "${conversationId}" is already terminal (${conversation.status})`);
      }
      assertConversationTransition(conversation.status, conversationPatch.status);
    }
    const record = createPeerHopRecord({
      id: hop.id,
      conversationId,
      index: hop.index,
      from: hop.from,
      to: hop.to,
      createdAt: hop.createdAt,
    });
    for (const key of ['requestMessageId', 'sourceTaskId', 'sourceRunId', 'sourceResultId', 'completedAt']) {
      if (hop[key] !== undefined) record[key] = hop[key] === null ? null : hop[key];
    }
    if (hop.status === 'running' || hop.requestMessageId !== undefined) {
      assertHopTransition(record.status, 'running');
      record.status = 'running';
    }
    if (hop.completedAt === undefined) record.completedAt = null;
    if (hop.error !== undefined) record.error = hop.error === null ? null : hop.error;
    return this.#repository.prepareHopAtomic({ conversationId, conversationPatch, hop: record, requestMessage });
  }
}