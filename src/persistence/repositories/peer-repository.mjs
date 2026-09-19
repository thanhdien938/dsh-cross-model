/**
 * Persistence layer — Peer domain repository.
 *
 * Project-owned repository that maps the Peer state domain
 * (ConversationRecord, PeerHopRecord, conversation messages, ordered peer
 * transcript) onto the persistence substrate. It is the ONLY reader/writer of
 * peer-domain rows; PeerRelay and DurablePeerState never touch SQL or import
 * the SQLite driver.
 *
 * Critical peer-hop invariant (Gate 4): before a peer hop can be considered
 * committed/running for a fresh downstream AgentBus dispatch, {@link
 * prepareHopAtomic} persists the hop, its running status, the request-message
 * commit, and the request-message linkage in ONE local transaction. A failed
 * prepare rolls the whole unit back, so a crash can never leave a
 * committed/running hop whose persisted request message is missing, and no
 * downstream dispatch can observe false running state.
 *
 * Status transition semantics intentionally mirror the legacy in-memory
 * PeerState (see tests for parity). AgentBus dispatch is an external boundary
 * and is never part of a peer SQL transaction.
 */

import { PersistenceError } from '../persistence-errors.mjs';
import { serializeDurable, parseDurable } from './json-durable.mjs';
import { BusError, toSanitizedError } from '../../bus/errors.mjs';
import { nowUtc } from '../../bus/envelopes.mjs';
import {
  CONVERSATION_STATUSES,
  HOP_STATUSES,
  assertConversationTransition,
  assertHopTransition,
} from '../../peer/peer-contracts.mjs';

const STORE_SEAM_METHODS = Object.freeze(['run', 'get', 'all', 'transactionSync']);

const REPOSITORY_METHODS = Object.freeze([
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
  'countConversations',
  'countHops',
  'prepareHopAtomic',
]);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function isForeignKeyError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error?.code === 'SQLITE_CONSTRAINT_TRIGGER';
}

function parseJsonField(json, label) {
  if (json === null || json === undefined || json === '') return null;
  return parseDurable(json, label);
}

function errorJson(error) {
  if (error === null || error === undefined) return null;
  return serializeDurable(toSanitizedError(error), 'peer error');
}

function rowToHop(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    index: row.hop_index,
    from: row.from_identity,
    to: row.to_identity,
    requestMessageId: row.request_message_id ?? null,
    responseMessageId: row.response_message_id ?? null,
    sourceTaskId: row.source_task_id ?? null,
    sourceRunId: row.source_run_id ?? null,
    sourceResultId: row.source_result_id ?? null,
    recipientTaskId: row.recipient_task_id ?? null,
    recipientRunId: row.recipient_run_id ?? null,
    recipientResultId: row.recipient_result_id ?? null,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    error: parseJsonField(row.error, 'hop error'),
  };
}

const HOP_SELECT_SQL =
  'SELECT id, conversation_id, hop_index, from_identity, to_identity, status, request_message_id, response_message_id, source_task_id, source_run_id, source_result_id, recipient_task_id, recipient_run_id, recipient_result_id, error, created_at, completed_at FROM peer_hops';

export class PeerRepository {
  /**
   * @param {object} deps
   * @param {object} deps.store - an opened/migrated persistence store exposing
   *   the repository composition seam (`run`/`get`/`all`/`transactionSync`).
   */
  constructor({ store } = {}) {
    if (store === null || typeof store !== 'object') {
      throw new TypeError('PeerRepository requires a persistence store');
    }
    const missingSeam = STORE_SEAM_METHODS.filter((name) => typeof store[name] !== 'function');
    if (missingSeam.length > 0) {
      throw new TypeError(`PeerRepository requires a store with repository seams; missing: ${missingSeam.join(', ')}`);
    }
    this.store = store;
  }

  #conversationFromRow(row) {
    if (!row) return undefined;
    const hopIds = this.store
      .all('SELECT id FROM peer_hops WHERE conversation_id = ? ORDER BY hop_index', [row.id])
      .map((hopRow) => hopRow.id);
    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      startedAt: null,
      completedAt: row.completed_at ?? null,
      messages: [],
      hops: hopIds,
      error: parseJsonField(row.error, 'conversation error'),
    };
  }

  #assertConversationPatch(record, patch) {
    if (!CONVERSATION_STATUSES.includes(patch.status)) {
      throw new BusError(`invalid conversation status: ${String(patch.status)}`);
    }
    if (TERMINAL.has(record.status)) {
      throw new BusError(`conversation "${record.id}" is already terminal (${record.status})`);
    }
    assertConversationTransition(record.status, patch.status);
  }

  /**
   * Persist a new conversation in `created` state.
   * @param {object} record - a validated ConversationRecord.
   * @returns {object} the persisted ConversationRecord.
   */
  createConversation(record) {
    if (record === null || typeof record !== 'object') throw new TypeError('createConversation requires a ConversationRecord object');
    serializeDurable(record, 'conversation record');
    try {
      this.store.run(
        'INSERT INTO peer_conversations (id, record_version, status, error, created_at, completed_at) VALUES (?, 1, ?, ?, ?, ?)',
        [record.id, record.status, record.error === null || record.error === undefined ? null : errorJson(record.error), record.createdAt ?? nowUtc(), record.completedAt ?? null],
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new BusError(`conversation already exists: ${record.id}`, { code: 'DUPLICATE_CONVERSATION', cause: error });
      }
      throw error;
    }
    return this.getConversation(record.id) ?? record;
  }

  /** @returns {object|undefined} the reconstructed ConversationRecord, if known. */
  getConversation(id) {
    const row = this.store.get('SELECT id, status, error, created_at, completed_at FROM peer_conversations WHERE id = ?', [id]);
    if (!row) return undefined;
    return this.#conversationFromRow(row);
  }

  /**
   * Transition a conversation's status, enforcing the legacy state machine in
   * one atomic read-validate-write.
   * @param {string} id
   * @param {{ status: string, error?: object|null }} patch
   * @returns {object} the updated ConversationRecord.
   */
  updateConversationStatus(id, { status, error } = {}) {
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT id, status, error, created_at, completed_at FROM peer_conversations WHERE id = ?', [id]);
      if (!row) throw new BusError(`unknown conversation: ${id}`);
      this.#assertConversationPatch(rowToConversation(row), { status });
      const hasError = error !== undefined;
      const errorColumn = !hasError ? row.error : error === null ? null : errorJson(error);
      run('UPDATE peer_conversations SET status = ?, error = ? WHERE id = ?', [status, errorColumn, id]);
      return rowToConversation({ ...row, status, error: errorColumn });
    });
  }

  /**
   * Create a hop within a conversation (conversation must exist and not be
   * terminal, matching the legacy rules).
   * @param {object} record - a validated PeerHopRecord in `created` state.
   * @returns {object} the created PeerHopRecord.
   */
  createHop(record) {
    if (record === null || typeof record !== 'object') throw new TypeError('createHop requires a PeerHopRecord object');
    serializeDurable(record, 'hop record');
    const conversation = this.getConversation(record.conversationId);
    if (!conversation) throw new BusError(`unknown conversation: ${record.conversationId}`);
    if (TERMINAL.has(conversation.status)) {
      throw new BusError(`cannot create hop in terminal conversation "${record.conversationId}" (${conversation.status})`);
    }
    try {
      this.store.run(
        'INSERT INTO peer_hops (id, record_version, conversation_id, hop_index, from_identity, to_identity, status, request_message_id, response_message_id, source_task_id, source_run_id, source_result_id, recipient_task_id, recipient_run_id, recipient_result_id, error, created_at, completed_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          record.id,
          record.conversationId,
          record.index,
          record.from,
          record.to,
          record.status,
          record.requestMessageId ?? null,
          record.responseMessageId ?? null,
          record.sourceTaskId ?? null,
          record.sourceRunId ?? null,
          record.sourceResultId ?? null,
          record.recipientTaskId ?? null,
          record.recipientRunId ?? null,
          record.recipientResultId ?? null,
          record.error === null || record.error === undefined ? null : errorJson(record.error),
          record.createdAt ?? nowUtc(),
          record.completedAt ?? null,
        ],
      );
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new BusError(`unknown conversation: ${record.conversationId}`, { code: 'UNKNOWN_CONVERSATION', cause: error });
      }
      if (isConstraintError(error)) {
        if (error.message?.includes('peer_hops.conversation_id, peer_hops.hop_index') || error.message?.includes('peer_hops.hop_index')) {
          throw new BusError(`hop index already exists for conversation ${record.conversationId}: ${record.index}`, {
            code: 'DUPLICATE_HOP_INDEX',
            cause: error,
          });
        }
        throw new BusError(`duplicate hop: ${record.id}`, { code: 'DUPLICATE_HOP', cause: error });
      }
      throw error;
    }
    return this.getHop(record.id) ?? record;
  }

  /** @returns {object|undefined} the reconstructed hop record, if known. */
  getHop(id) {
    const row = this.store.get(`${HOP_SELECT_SQL} WHERE id = ?`, [id]);
    if (!row) return undefined;
    return rowToHop(row);
  }

  /** @returns {object[]} hops for a conversation, in creation order. */
  hopsForConversation(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new BusError(`unknown conversation: ${conversationId}`);
    return this.store.all(`${HOP_SELECT_SQL} WHERE conversation_id = ? ORDER BY hop_index`, [conversationId]).map(rowToHop);
  }

  /**
   * Transition a hop's status and/or update its fields in one atomic
   * read-validate-write. Mirrors the legacy updateHopStatus rules.
   * @param {string} id
   * @param {{ status?: string, [k: string]: any }} patch
   * @returns {object} the updated hop record.
   */
  updateHopStatus(id, patch = {}) {
    if (patch === null || typeof patch !== 'object') throw new TypeError('updateHopStatus requires a patch object');
    const MUTABLE = new Set([
      'requestMessageId',
      'responseMessageId',
      'sourceTaskId',
      'sourceRunId',
      'sourceResultId',
      'recipientTaskId',
      'recipientRunId',
      'recipientResultId',
      'completedAt',
    ]);
    return this.store.transactionSync(({ get, run }) => {
      const row = get(`${HOP_SELECT_SQL} WHERE id = ?`, [id]);
      if (!row) throw new BusError(`unknown hop: ${id}`);
      const hop = rowToHop(row);
      const { status, ...fields } = patch;
      if (status !== undefined) {
        if (!HOP_STATUSES.includes(status)) throw new BusError(`invalid hop status: ${String(status)}`);
        if (TERMINAL.has(hop.status)) {
          throw new BusError(`hop "${id}" is already terminal (${hop.status})`);
        }
        assertHopTransition(hop.status, status);
        hop.status = status;
      }
      for (const key of MUTABLE) {
        if (fields[key] === undefined) continue;
        hop[key] = fields[key] === null ? null : fields[key];
      }
      if (fields.error !== undefined) hop.error = fields.error === null ? null : toSanitizedError(fields.error);
      const errorColumn = hop.error === null || hop.error === undefined ? null : serializeDurable(hop.error, 'hop error');
      run(
        `UPDATE peer_hops SET status = ?, request_message_id = ?, response_message_id = ?, source_task_id = ?, source_run_id = ?, source_result_id = ?, recipient_task_id = ?, recipient_run_id = ?, recipient_result_id = ?, completed_at = ?, error = ? WHERE id = ?`,
        [
          hop.status,
          hop.requestMessageId ?? null,
          hop.responseMessageId ?? null,
          hop.sourceTaskId ?? null,
          hop.sourceRunId ?? null,
          hop.sourceResultId ?? null,
          hop.recipientTaskId ?? null,
          hop.recipientRunId ?? null,
          hop.recipientResultId ?? null,
          hop.completedAt ?? null,
          errorColumn,
          id,
        ],
      );
      return hop;
    });
  }

  /**
   * Register a peer message envelope against a conversation for retrieval.
   * @param {string} conversationId
   * @param {object} message - a validated MessageEnvelope.
   */
  addConversationMessage(conversationId, message) {
    if (message === null || typeof message !== 'object') throw new TypeError('addConversationMessage requires a MessageEnvelope object');
    const envelope = serializeDurable(message, 'peer message envelope');
    try {
      this.store.run(
        'INSERT INTO peer_conversation_messages (id, conversation_id, message_id, envelope, created_at) VALUES (?, ?, ?, ?, ?)',
        [message.id, conversationId, message.id, envelope, message.createdAt ?? nowUtc()],
      );
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new BusError(`unknown conversation: ${conversationId}`, { code: 'UNKNOWN_CONVERSATION', cause: error });
      }
      if (isConstraintError(error)) {
        throw new BusError(`duplicate peer message: ${message.id}`, { code: 'DUPLICATE_PEER_MESSAGE', cause: error });
      }
      throw error;
    }
    return message;
  }

  /** @returns {object[]} messages for a conversation, in creation order. */
  messagesForConversation(conversationId) {
    return this.store
      .all('SELECT envelope FROM peer_conversation_messages WHERE conversation_id = ? ORDER BY rowid', [conversationId])
      .map((row) => parseDurable(row.envelope, 'peer message envelope'));
  }

  /**
   * Critical atomic peer-hop prepare. ONE local transaction persists:
   *   - the hop record (intent), with running status and its request-message
   *     linkage;
   *   - the request-message commit in peer conversation state;
   *   - the requested conversation status transition (e.g. created -> running).
   *
   * A failure anywhere in the transaction rolls back every row, so no partial
   * hop, no orphan peer message, and no false running conversation/hop state
   * can survive a local prepare failure. AgentBus dispatch is NOT part of this
   * transaction — it remains an external Gate-3 boundary.
   *
   * @param {object} input
   * @param {string} input.conversationId
   * @param {{ status: string, error?: object|null }|null|null} input.conversationPatch - optional
   *   conversation status transition to apply atomically.
   * @param {object} input.hop - the target PeerHopRecord (status `running`,
   *   requestMessageId + source lineage set).
   * @param {object} input.requestMessage - MessageEnvelope to commit into the
   *   conversation store.
   * @returns {object} `{ conversation, hop, requestMessage }` after the atomic write.
   */
  prepareHopAtomic({ conversationId, conversationPatch = null, hop, requestMessage } = {}) {
    if (conversationId === null || typeof conversationId !== 'string') throw new TypeError('prepareHopAtomic requires conversationId');
    if (hop === null || typeof hop !== 'object') throw new TypeError('prepareHopAtomic requires a hop record');
    if (requestMessage === null || typeof requestMessage !== 'object') throw new TypeError('prepareHopAtomic requires a request message');
    serializeDurable(hop, 'hop record');
    serializeDurable(requestMessage, 'peer message envelope');
    if (hop.status !== 'created') {
      assertHopTransition('created', hop.status);
    }
    try {
      this.store.transactionSync(({ get, run }) => {
        const conversationRow = get('SELECT id, status, error, created_at, completed_at FROM peer_conversations WHERE id = ?', [conversationId]);
        if (!conversationRow) throw new BusError(`unknown conversation: ${conversationId}`);
        if (TERMINAL.has(conversationRow.status)) {
          throw new BusError(`cannot create hop in terminal conversation "${conversationId}" (${conversationRow.status})`, { code: 'CONVERSATION_TERMINAL' });
        }
        if (conversationPatch) {
          this.#assertConversationPatch(rowToConversation(conversationRow), conversationPatch);
        }
        run(
          'INSERT INTO peer_hops (id, record_version, conversation_id, hop_index, from_identity, to_identity, status, request_message_id, response_message_id, source_task_id, source_run_id, source_result_id, recipient_task_id, recipient_run_id, recipient_result_id, error, created_at, completed_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            hop.id,
            conversationId,
            hop.index,
            hop.from,
            hop.to,
            hop.status,
            hop.requestMessageId ?? null,
            hop.responseMessageId ?? null,
            hop.sourceTaskId ?? null,
            hop.sourceRunId ?? null,
            hop.sourceResultId ?? null,
            hop.recipientTaskId ?? null,
            hop.recipientRunId ?? null,
            hop.recipientResultId ?? null,
            hop.error === null || hop.error === undefined ? null : errorJson(hop.error),
            hop.createdAt ?? nowUtc(),
            hop.completedAt ?? null,
          ],
        );
        run(
          'INSERT INTO peer_conversation_messages (id, conversation_id, message_id, envelope, created_at) VALUES (?, ?, ?, ?, ?)',
          [requestMessage.id, conversationId, requestMessage.id, serializeDurable(requestMessage, 'peer message envelope'), requestMessage.createdAt ?? nowUtc()],
        );
        if (conversationPatch) {
          const errorColumn = conversationPatch.error === undefined
            ? conversationRow.error
            : conversationPatch.error === null
              ? null
              : errorJson(conversationPatch.error);
          run(
            'UPDATE peer_conversations SET status = ?, error = ? WHERE id = ?',
            [conversationPatch.status, errorColumn, conversationId],
          );
        }
      });
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new BusError(`unknown conversation: ${conversationId}`, { code: 'UNKNOWN_CONVERSATION', cause: error });
      }
      if (isConstraintError(error)) {
        if (error.message?.includes('peer_conversation_messages')) {
          throw new BusError(`duplicate peer message: ${requestMessage.id}`, { code: 'DUPLICATE_PEER_MESSAGE', cause: error });
        }
        if (error.message?.includes('peer_hops.conversation_id, peer_hops.hop_index') || error.message?.includes('peer_hops.hop_index')) {
          throw new BusError(`hop index already exists for conversation ${conversationId}: ${hop.index}`, {
            code: 'DUPLICATE_HOP_INDEX',
            cause: error,
          });
        }
        throw new BusError(`duplicate hop: ${hop.id}`, { code: 'DUPLICATE_HOP', cause: error });
      }
      throw error;
    }
    return { conversation: this.getConversation(conversationId), hop: this.getHop(hop.id), requestMessage };
  }

  /**
   * Append an ordered, durable peer transcript entry. One atomic append with
   * deterministic ordering via the autoincrement id.
   * @param {{ conversationId: string, hopId?: string|null, messageId?: string|null, taskId?: string|null, runId?: string|null, agent?: string|null, event: string, at?: string }} entry
   */
  appendEvent(entry) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('appendEvent requires an entry object');
    const normalized = {
      at: entry.at ?? nowUtc(),
      conversationId: entry.conversationId,
      hopId: entry.hopId ?? null,
      messageId: entry.messageId ?? null,
      taskId: entry.taskId ?? null,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    };
    if (typeof normalized.event !== 'string' || normalized.event.trim() === '') {
      throw new BusError('event name must be a non-empty string', { code: 'INVALID_EVENT' });
    }
    serializeDurable(normalized, 'peer event payload');
    this.store.run(
      'INSERT INTO peer_events (conversation_id, hop_id, message_id, task_id, run_id, agent, event, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [normalized.conversationId, normalized.hopId, normalized.messageId, normalized.taskId, normalized.runId, normalized.agent, normalized.event, normalized.at],
    );
  }

  /** @returns {object[]} ordered transcript entries for a conversation. */
  transcriptForConversation(conversationId) {
    return this.store
      .all('SELECT at, conversation_id, hop_id, message_id, task_id, run_id, agent, event FROM peer_events WHERE conversation_id = ? ORDER BY id', [conversationId])
      .map(rowToTranscriptEntry);
  }

  /** @returns {object[]} all transcript entries, ordered. */
  transcript() {
    return this.store
      .all('SELECT at, conversation_id, hop_id, message_id, task_id, run_id, agent, event FROM peer_events ORDER BY id')
      .map(rowToTranscriptEntry);
  }

  /** @returns {number} number of conversations recorded. */
  countConversations() {
    return this.store.get('SELECT COUNT(*) AS count FROM peer_conversations').count;
  }

  /** @returns {number} number of hops recorded. */
  countHops() {
    return this.store.get('SELECT COUNT(*) AS count FROM peer_hops').count;
  }

  /**
   * Integrity check used by durable-state wiring/tests.
   * @returns {true}
   * @throws {PersistenceError} with code `INVALID_PEER_REPOSITORY` when any
   *   required member is missing.
   */
  assertComplete() {
    const missing = REPOSITORY_METHODS.filter((name) => typeof this[name] !== 'function');
    if (missing.length > 0) {
      throw new PersistenceError(`PeerRepository missing required members: ${missing.join(', ')}`, {
        code: 'INVALID_PEER_REPOSITORY',
        missing,
      });
    }
    return true;
  }
}

function rowToConversation(row) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: null,
    completedAt: row.completed_at ?? null,
    messages: [],
    hops: [],
    error: parseJsonField(row.error, 'conversation error'),
  };
}

function rowToTranscriptEntry(row) {
  return {
    at: row.at,
    conversationId: row.conversation_id,
    hopId: row.hop_id,
    messageId: row.message_id,
    taskId: row.task_id,
    runId: row.run_id,
    agent: row.agent,
    event: row.event,
  };
}