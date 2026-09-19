/**
 * Peer layer — PeerRelay facade.
 *
 * A small backend-neutral facade ABOVE AgentBus that turns a peer message into
 * a Level-1 relay: it records the request message centrally, builds a bounded
 * peer context packet, performs a NEW explicit `AgentBus.dispatch()` to the
 * recipient, and records the normalized recipient result back as a centrally
 * recorded response message with `replyTo` lineage.
 *
 * Crucial semantics:
 *  - This is NOT `AgentBus.send()`. `send()` means live delivery into an
 *    already-running session (unsupported for one-shot backends). Every Level-1
 *    peer delivery is a fresh explicit `dispatch()`.
 *  - This is NOT session continuation. Each recipient is a fresh one-shot
 *    child that receives explicit bounded context; continuity is reconstructed,
 *    never resumed.
 *  - No provider-name branching and no role assignment live here. `from`/`to`
 *    are runtime backend identities.
 *  - Failure/cancellation leave valid terminal conversation/hop state and stop
 *    later hops; no fake response is ever fabricated.
 */

import { BusError, toSanitizedError } from '../bus/errors.mjs';
import { createId, createMessageEnvelope } from '../bus/envelopes.mjs';
import { buildPeerContext, DEFAULT_PEER_HISTORY_LIMIT } from './peer-context.mjs';
import { sourceLineage, peerContextPacket } from './peer-contracts.mjs';
import { PeerState } from './peer-state.mjs';

const DEFAULT_MAX_HOPS = 8;

export class PeerRelayError extends BusError {
  constructor(message, extra = {}) {
    super(message, { code: extra.code ?? 'PEER_RELAY_ERROR' });
    Object.assign(this, extra);
  }
}

export class PeerRelay {
  #bus;
  #events;
  #state;

  /**
   * @param {object} deps
   * @param {import('../bus/agent-bus.mjs').AgentBus} deps.bus
   * @param {import('../bus/event-bus.mjs').EventBus} [deps.events] - defaults to `bus.events`.
   * @param {PeerState} [deps.state] - a fresh PeerState is created when omitted.
   */
  constructor({ bus, events, state } = {}) {
    if (!bus || typeof bus.dispatch !== 'function' || typeof bus.recordMessage !== 'function') {
      throw new TypeError('PeerRelay requires a bus with dispatch() and recordMessage()');
    }
    this.#bus = bus;
    this.#events = events ?? bus.events;
    this.#state = state ?? new PeerState();
  }

  /** @returns {import('../bus/event-bus.mjs').EventBus} */
  get events() {
    return this.#events;
  }

  /** @returns {PeerState} */
  get state() {
    return this.#state;
  }

  /**
   * @returns {boolean} whether the injected state facade supports the atomic
   *   hop-prepare capability (Gate 4 durable peer state).
   */
  get hasAtomicHopPrepare() {
    return this.#state?.hasAtomicHopPrepare === true;
  }

  #emit(event, payload) {
    this.#events.emit(event, payload);
    this.#state.appendEvent({
      conversationId: payload.conversationId,
      hopId: payload.hopId ?? null,
      messageId: payload.messageId ?? null,
      taskId: payload.taskId ?? null,
      runId: payload.runId ?? null,
      agent: payload.agent ?? null,
      from: payload.from ?? null,
      to: payload.to ?? null,
      event,
    });
  }

  /**
   * Create a new conversation. Emits `conversation.created`.
   * @param {object} [input] - optional explicit `id`.
   * @returns {object} the ConversationRecord.
   */
  createConversation(input = {}) {
    const conversation = this.#state.createConversation(input);
    this.#emit('conversation.created', { conversationId: conversation.id, conversation });
    return conversation;
  }

  /** @returns {object|undefined} the conversation record, if known. */
  getConversation(id) {
    return this.#state.getConversation(id);
  }

  /** @returns {object[]} peer messages for a conversation, in creation order. */
  messagesForConversation(id) {
    return this.#state.messagesForConversation(id);
  }

  /** @returns {object[]} hops for a conversation, in creation order. */
  hopsForConversation(id) {
    return this.#state.hopsForConversation(id);
  }

  /** @returns {object[]} ordered transcript entries for a conversation. */
  transcript(id) {
    return this.#state.transcriptForConversation(id);
  }

  /** Reconstruct a peer outcome from durable state without execution. */
  result(id) {
    const conversation = this.#state.getConversation(id);
    if (!conversation) return null;
    const hops = this.#state.hopsForConversation(id);
    const finalHopRecord = hops[hops.length - 1] ?? null;
    const finalResult = finalHopRecord?.recipientResultId ? this.#bus.result(finalHopRecord.recipientRunId) : null;
    return {
      conversationId: id,
      status: conversation.status,
      hops,
      finalHop: finalHopRecord,
      finalResult,
    };
  }

  /**
   * Execute one Level-1 relay hop:
   *
   *   validate -> record request message -> create hop -> build bounded context
   *     -> fresh bus.dispatch(to) -> normalize ResultEnvelope
   *     -> record response message (replyTo=request) -> complete hop
   *
   * @param {object} input
   * @param {string} input.conversationId
   * @param {string} input.from - sender backend identity.
   * @param {string} input.to - recipient backend identity.
   * @param {string} input.body - the peer message text.
   * @param {string|null} [input.replyTo] - id of the message this request replies to.
   * @param {object|null} [input.sourceResult] - optional originating ResultEnvelope.
   * @param {object|null} [input.sourceLineage] - optional `{ taskId, runId, resultId }`.
   * @param {object|null} [input.context] - optional explicit peer context packet
   *   merged over the derived packet (explicit wins per top-level key).
   * @param {object|null} [input.metadata] - optional plain-object metadata.
   * @param {string} [input.kind] - request message kind, defaults to `'peer.request'`.
   * @param {number} [input.historyLimit] - context history bound.
   * @returns {Promise<object>} normalized hop result:
   *   `{ conversationId, hopId, status, requestMessage, responseMessage, result }`.
   * @throws {PeerRelayError} when validation fails or recipient dispatch fails.
   */
  async relay({
    conversationId,
    from,
    to,
    body,
    replyTo = null,
    sourceResult = null,
    sourceLineage: lineage = null,
    context = null,
    metadata = null,
    kind = 'peer.request',
    historyLimit = DEFAULT_PEER_HISTORY_LIMIT,
  }) {
    const conversation = this.#state.getConversation(conversationId);
    if (!conversation) {
      throw new PeerRelayError(`unknown conversation: ${conversationId}`, { code: 'UNKNOWN_CONVERSATION', conversationId });
    }
    if (['completed', 'failed', 'cancelled'].includes(conversation.status)) {
      throw new PeerRelayError(
        `conversation "${conversationId}" is terminal (${conversation.status}); no further hops`,
        { code: 'CONVERSATION_TERMINAL', conversationId },
      );
    }
    if (typeof from !== 'string' || from.trim() === '' || typeof to !== 'string' || to.trim() === '') {
      throw new PeerRelayError('relay requires non-empty from and to', { code: 'INVALID_PEER_INPUT' });
    }
    if (typeof body !== 'string' || body.trim() === '') {
      throw new PeerRelayError('relay requires a non-empty message body', { code: 'INVALID_PEER_INPUT' });
    }
    let explicitContext = null;
    try {
      explicitContext = peerContextPacket(context);
    } catch {
      throw new PeerRelayError('relay context must be a plain object', { code: 'INVALID_PEER_INPUT', context });
    }

    const index = conversation.hops.length;

    // Gate-4 durable capability: when the state store exposes the atomic
    // hop-prepare capability, the hop intent + running state + request-message
    // commit + request-message linkage are persisted in ONE local transaction
    // BEFORE any AgentBus dispatch. The relay stays SQL-free: it calls the
    // state facade method and feature-detects the flag; the legacy in-memory
    // path below is unchanged.
    const atomicHopPrepare = this.#state?.hasAtomicHopPrepare === true && typeof this.#state.prepareHop === 'function';

    let hop;
    let requestMessage;
    if (atomicHopPrepare) {
      const hopId = createId('hop');
      const source = sourceLineage(lineage ?? {
        taskId: sourceResult?.taskId ?? null,
        runId: sourceResult?.runId ?? null,
        resultId: sourceResult?.id ?? null,
      });
      requestMessage = createMessageEnvelope({
        id: createId('msg'),
        from,
        to,
        taskId: source.sourceTaskId,
        runId: source.sourceRunId,
        body,
        replyTo,
        kind,
        conversationId: conversation.id,
        hopId,
        metadata: { ...(metadata ?? {}), peer: { conversationId: conversation.id, hopId } },
      });
      const prepared = this.#state.prepareHop({
        conversationId: conversation.id,
        conversationPatch: conversation.status === 'created' ? { status: 'running' } : null,
        hop: {
          id: hopId,
          index,
          from,
          to,
          requestMessageId: requestMessage.id,
          ...source,
        },
        requestMessage,
      });
      hop = prepared.hop;
      requestMessage = prepared.requestMessage;
      if (conversation.status === 'created') {
        this.#emit('conversation.started', { conversationId: conversation.id });
      }
      // Central AgentBus record under the same stable id (AgentBus domain write,
      // deliberately separate from the peer transaction and from any dispatch).
      this.#bus.recordMessage({
        id: requestMessage.id,
        from: requestMessage.from,
        to: requestMessage.to,
        taskId: requestMessage.taskId,
        runId: requestMessage.runId,
        body: requestMessage.body,
        replyTo: requestMessage.replyTo,
        kind: requestMessage.kind,
        conversationId: requestMessage.conversationId,
        hopId: requestMessage.hopId,
        metadata: requestMessage.metadata,
      });
    } else {
      if (conversation.status === 'created') {
        this.#state.updateConversationStatus(conversation.id, { status: 'running' });
        this.#emit('conversation.started', { conversationId: conversation.id });
      }
      hop = this.#state.createHop({ conversationId: conversation.id, index, from, to });
      this.#state.updateHopStatus(hop.id, {
        status: 'running',
        ...sourceLineage(lineage ?? {
          taskId: sourceResult?.taskId ?? null,
          runId: sourceResult?.runId ?? null,
          resultId: sourceResult?.id ?? null,
        }),
      });

      requestMessage = this.#bus.recordMessage({
        from,
        to,
        taskId: lineage?.taskId ?? sourceResult?.taskId ?? null,
        runId: lineage?.runId ?? sourceResult?.runId ?? null,
        body,
        replyTo,
        kind,
        conversationId: conversation.id,
        hopId: hop.id,
        metadata: { ...(metadata ?? {}), peer: { conversationId: conversation.id, hopId: hop.id } },
      });
      this.#state.updateHopStatus(hop.id, { requestMessageId: requestMessage.id });
      this.#state.addConversationMessage(conversation.id, requestMessage);
    }
    this.#emit('peer.request.created', {
      conversationId: conversation.id,
      hopId: hop.id,
      from,
      to,
      messageId: requestMessage.id,
      message: requestMessage,
    });

    const recentMessages = this.#state.messagesForConversation(conversation.id);
    const peerContext = buildPeerContext({
      conversation,
      hop: this.#state.getHop(hop.id),
      requestMessage,
      sourceResult,
      recentMessages,
      limit: historyLimit,
      explicitContext,
    });

    this.#emit('peer.hop.started', {
      conversationId: conversation.id,
      hopId: hop.id,
      from,
      to,
      requestMessageId: requestMessage.id,
    });

    try {
      let run = null;
      const onStarted = (payload) => {
        if (payload.agent === to && run === null) {
          run = payload.runId;
          this.#state.updateHopStatus(hop.id, { recipientRunId: payload.runId });
        }
      };
      this.#events.on('agent.started', onStarted);
      try {
        const completedRun = await this.#bus.dispatch({
          sender: from,
          recipient: to,
          body,
          context: peerContext,
        });
        run = completedRun.id;
      } finally {
        this.#events.off('agent.started', onStarted);
      }
      const result = this.#bus.result(run);

      const responseMessage = this.#bus.recordMessage({
        from: to,
        to: from,
        taskId: result?.taskId ?? this.#bus.task(run)?.taskId ?? null,
        runId: run,
        body: result?.output ?? '',
        replyTo: requestMessage.id,
        kind: 'peer.response',
        conversationId: conversation.id,
        hopId: hop.id,
        metadata: { peer: { conversationId: conversation.id, hopId: hop.id, replyToRequest: requestMessage.id } },
      });
      this.#state.updateHopStatus(hop.id, {
        status: 'completed',
        responseMessageId: responseMessage.id,
        recipientTaskId: result?.taskId ?? this.#bus.task(run)?.taskId ?? null,
        recipientRunId: run,
        recipientResultId: result?.id ?? null,
        completedAt: new Date().toISOString(),
      });
      this.#state.addConversationMessage(conversation.id, responseMessage);
      this.#emit('peer.response.created', {
        conversationId: conversation.id,
        hopId: hop.id,
        from: to,
        to: from,
        messageId: responseMessage.id,
        replyTo: requestMessage.id,
        message: responseMessage,
      });
      this.#emit('peer.hop.completed', {
        conversationId: conversation.id,
        hopId: hop.id,
        from,
        to,
        requestMessageId: requestMessage.id,
        responseMessageId: responseMessage.id,
        recipientTaskId: result?.taskId ?? this.#bus.task(run)?.taskId ?? null,
        recipientRunId: run,
        recipientResultId: result?.id ?? null,
      });

      return {
        conversationId: conversation.id,
        hopId: hop.id,
        status: 'completed',
        requestMessage,
        responseMessage,
        result: result ?? null,
      };
    } catch (error) {
      const sanitized = toSanitizedError(error);
      const current = this.#state.getConversation(conversation.id);
      const cancelled = current?.status === 'cancelled';
      const hopNow = this.#state.getHop(hop.id);
      if (!['completed', 'failed', 'cancelled'].includes(hopNow?.status ?? '')) {
        this.#state.updateHopStatus(hop.id, { status: cancelled ? 'cancelled' : 'failed', error: sanitized });
      }
      if (cancelled) {
        this.#emit('peer.hop.cancelled', {
          conversationId: conversation.id,
          hopId: hop.id,
          from,
          to,
          requestMessageId: requestMessage.id,
          error: sanitized,
        });
        throw new PeerRelayError(`peer relay hop ${hop.id} cancelled: ${sanitized.message}`, {
          code: 'PEER_HOP_CANCELLED',
          conversationId: conversation.id,
          hopId: hop.id,
          error: sanitized,
        });
      }
      this.#emit('peer.hop.failed', {
        conversationId: conversation.id,
        hopId: hop.id,
        from,
        to,
        requestMessageId: requestMessage.id,
        error: sanitized,
      });
      if (current && current.status === 'running') {
        this.#state.updateConversationStatus(conversation.id, { status: 'failed', error: sanitized });
        this.#emit('conversation.failed', {
          conversationId: conversation.id,
          hopId: hop.id,
          error: sanitized,
        });
      }
      throw new PeerRelayError(`peer relay hop ${hop.id} failed: ${sanitized.message}`, {
        code: 'PEER_HOP_FAILED',
        conversationId: conversation.id,
        hopId: hop.id,
        error: sanitized,
      });
    }
  }

  /**
   * Execute a caller-configured multi-hop exchange A -> B -> A ...
   * Each hop's response becomes the next hop's request automatically (no human
   * copy/paste). Stops immediately on failure/cancellation. Preserves one
   * conversationId and the `replyTo` chain. Enforces an explicit max-hop bound.
   *
   * @param {object} input
   * @param {string} input.conversationId
   * @param {Array<{ from: string, to: string }>} input.routes - ordered hop spec.
   * @param {string} input.body - the initial peer message text.
   * @param {object|null} [input.sourceResult] - optional seed ResultEnvelope.
   * @param {object|null} [input.context] - optional explicit context packet.
   * @param {object|null} [input.metadata] - optional request metadata.
   * @param {number} [input.maxHops] - explicit bound, defaults to 8.
   * @returns {Promise<object>} normalized exchange result:
   *   `{ conversationId, status, hops, finalHop, finalResult }`.
   */
  async exchange({
    conversationId,
    routes,
    body,
    sourceResult = null,
    context = null,
    metadata = null,
    maxHops = DEFAULT_MAX_HOPS,
  }) {
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new PeerRelayError('exchange requires a non-empty routes array', { code: 'INVALID_EXCHANGE' });
    }
    if (!Number.isInteger(maxHops) || maxHops < 1) {
      throw new PeerRelayError('exchange maxHops must be a positive integer', { code: 'INVALID_EXCHANGE' });
    }
    if (routes.length > maxHops) {
      throw new PeerRelayError(
        `exchange routes (${routes.length}) exceed maxHops (${maxHops})`,
        { code: 'MAX_HOPS_EXCEEDED', conversationId, routes: routes.length, maxHops },
      );
    }

    const conversation = this.#state.getConversation(conversationId);
    if (!conversation) {
      throw new PeerRelayError(`unknown conversation: ${conversationId}`, { code: 'UNKNOWN_CONVERSATION', conversationId });
    }
    if (['completed', 'failed', 'cancelled'].includes(conversation.status)) {
      throw new PeerRelayError(
        `conversation "${conversationId}" is terminal (${conversation.status}); no further hops`,
        { code: 'CONVERSATION_TERMINAL', conversationId },
      );
    }

    const hops = [];
    let previousResponse = null;
    let currentSource = sourceResult;

    for (let i = 0; i < routes.length; i += 1) {
      const route = routes[i];
      if (['completed', 'failed', 'cancelled'].includes(this.#state.getConversation(conversationId)?.status)) break;

      // Hop 0 has no incoming peer response yet; give the recipient concrete
      // source material by touching the route's `from` backend ONCE (fresh
      // explicit dispatch), unless the caller already supplied a seed result.
      if (i === 0 && previousResponse === null && currentSource === null && route.from) {
        const seedRun = await this.#bus.dispatch({ sender: 'pm', recipient: route.from, body });
        currentSource = this.#bus.result(seedRun.id);
      }

      const hopInput = {
        conversationId,
        from: route.from,
        to: route.to,
        body: previousResponse ? previousResponse.body : body,
        replyTo: previousResponse ? previousResponse.id : null,
        sourceResult: currentSource,
        context,
        metadata,
      };
      const outcome = await this.relay(hopInput);
      hops.push(outcome);
      previousResponse = outcome.responseMessage;
      currentSource = outcome.result;
    }

    const current = this.#state.getConversation(conversationId);
    if (current && current.status === 'running') {
      this.#state.updateConversationStatus(conversationId, { status: 'completed', completedAt: new Date().toISOString() });
      this.#emit('conversation.completed', { conversationId });
    }

    const status = this.#state.getConversation(conversationId)?.status ?? 'failed';
    const finalHop = hops[hops.length - 1] ?? null;
    return {
      conversationId,
      status,
      hops,
      finalHop,
      finalResult: finalHop?.result ?? null,
    };
  }

  /**
   * Cancel a conversation: mark it cancelled, abort any active recipient run
   * best-effort, and prevent all future hops. No response message is fabricated.
   * @param {string} conversationId
   * @returns {Promise<object>} the (now cancelled) ConversationRecord.
   */
  async cancel(conversationId) {
    const conversation = this.#state.getConversation(conversationId);
    if (!conversation) {
      throw new PeerRelayError(`unknown conversation: ${conversationId}`, { code: 'UNKNOWN_CONVERSATION', conversationId });
    }
    if (['completed', 'failed', 'cancelled'].includes(conversation.status)) {
      throw new PeerRelayError(
        `cannot cancel conversation "${conversationId}": current status is ${conversation.status}`,
        { code: 'CONVERSATION_TERMINAL', conversationId },
      );
    }
    const activeHop = this.#state.hopsForConversation(conversationId).find((hop) => hop.status === 'running');
    this.#state.updateConversationStatus(conversationId, { status: 'cancelled' });
    this.#emit('conversation.cancelled', { conversationId });
    if (activeHop) {
      this.#state.updateHopStatus(activeHop.id, { status: 'cancelled' });
      this.#emit('peer.hop.cancelled', {
        conversationId,
        hopId: activeHop.id,
        from: activeHop.from,
        to: activeHop.to,
      });
      if (activeHop.recipientRunId && typeof this.#bus.cancel === 'function') {
        try {
          await this.#bus.cancel(activeHop.recipientRunId);
        } catch {
          // cancellation is best-effort at the native adapter boundary
        }
      }
    }
    return conversation;
  }
}
