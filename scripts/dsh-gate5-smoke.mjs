#!/usr/bin/env node
/**
 * T5 Gate 5 — real AWS-style A -> B -> A peer relay smoke through PeerRelay.
 *
 * PM simulator: a deterministic driver (not an LLM) that configures a peer
 * conversation, registers the real DSH children as backends, and runs a
 * configured automatic exchange through the peer layer. No model-specific
 * reasoning policy and no debate scoring.
 *
 * Proof of the exact peer relay path (not just "two models were called"):
 *   fresh seed A dispatch produces: P5_<hex>
 *     -> recorded peer request message (A -> B) + bounded peer context
 *     -> fresh B dispatch (PeerRelay records the request centrally first)
 *     -> B echoes P5_<hex> from the CONTEXT section
 *     -> peer response message (B -> A) recorded with replyTo lineage
 *     -> fresh A dispatch reading B-derived material from source context
 *     -> A echoes the B-derived material exactly
 * The token is produced by the real child A and is NEVER hard-coded into B's
 * body or into the route config.
 *
 * For every declared route we print: conversation id, hop ids, request/response
 * message ids, source/recipient task/run/result ids, backend names, source
 * output empty flag, transfer material observed flags, reason code and the
 * final strict status.
 *
 * Read-only: children run in this repository workspace; the only nontrivial
 * data is the synthetic per-run token.
 *
 * Per T4-R1 strict gate semantics:
 *   PASS    = EVERY declared route proved the peer relay invariant
 *   PARTIAL = at least one but not all routes proved it
 *   FAIL    = none proved it, or the harness could not execute meaningfully
 * Exit code: 0 (PASS), 2 (PARTIAL), 1 (FAIL).
 */

import { bootHarness, repoRoot } from './lib/conn-smoke.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { createDshSubagentAdapter } from '../src/adapters/dsh-subagent-adapter.mjs';
import { PeerRelay } from '../src/peer/peer-relay.mjs';
import { PeerState } from '../src/peer/peer-state.mjs';
import {
  classifySmoke,
  classifyTransferRoute,
  exitCodeFor,
  SMOKE_REASON,
} from './lib/smoke-status.mjs';

const TOKEN_RE = /P5_[0-9a-f]{8}/i;

/** Seed A: produce the synthetic token that must later travel A -> B -> A. */
const seedABody = (product) => [
  `You are Agent A (${product}) in an automated peer-relay test.`,
  'Return exactly one synthetic token and nothing else.',
  'The token must be the literal string P5_ followed by exactly 8 lowercase hexadecimal characters (0-9a-f).',
  'Example output: P5_1a2b3c4d',
  'Do not modify any files.',
].join('\n');

/** Recipient B: read the transferred token from the CONTEXT peer relay section. */
const hopBBody = [
  'You are Agent B in an automated peer relay.',
  'Read the CONTEXT section of your task input. It contains a field `source.output`',
  'holding a synthetic token of the form P5_<8 hex chars> that Agent A produced.',
  'Return exactly that token and nothing else.',
  'Do not modify any files.',
].join('\n');

/** Final hop A: acknowledge the B-derived material carried back in the context. */
const returnABody = [
  'You are Agent A again in an automated two-hop peer exchange.',
  'Read the CONTEXT section of your task input. It contains a field `source.output`',
  'holding the token that Agent B echoed back to you.',
  'Return strictly: ACK:<that exact token> and nothing else.',
  'Do not modify any files.',
].join('\n');

const routes = [
  { a: 'codex', b: 'claude-code', aProduct: 'Codex', bProduct: 'Claude Code' },
  { a: 'claude-code', b: 'grok', aProduct: 'Claude Code', bProduct: 'Grok Build' },
];

const report = {
  repoRoot,
  timestamp: new Date().toISOString(),
  composition: 'config/dsh-gate2.cordis.yml',
  routes: [],
  required: routes.length,
  proved: 0,
  status: 'FAIL',
  exitCode: 1,
};

let ctx;
try {
  ctx = await bootHarness('t5-gate5-smoke', 'config/dsh-gate2.cordis.yml');
  try {
    const events = new EventBus({ onListenerError: (error) => process.stderr.write(`event-bus: ${error}\n`) });
    const bus = new AgentBus({ registry: new AgentRegistry(), events, state: new StateStore() });
    const relay = new PeerRelay({ bus, events, state: new PeerState() });

    for (const { provider, product } of [
      { provider: 'codex', product: 'Codex' },
      { provider: 'claude-code', product: 'Claude Code' },
      { provider: 'grok', product: 'Grok Build' },
    ]) {
      bus.registry.register(
        provider,
        createDshSubagentAdapter({ ctx, provider, product, cwd: repoRoot }),
        { transport: 'dsh-subagent', provider, product },
      );
    }
    report.registered = bus.registry.list();

    for (const route of routes) {
      const conversation = relay.createConversation();
      let exchange;
      let runError = null;
      try {
        exchange = await relay.exchange({
          conversationId: conversation.id,
          routes: [
            { from: route.a, to: route.b },
            { from: route.b, to: route.a },
          ],
          body: seedABody(route.aProduct),
        });
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }

      const conversationRow = relay.getConversation(conversation.id);
      const conversationStatus = conversationRow?.status ?? 'unknown';
      const hops = conversationRow ? relay.hopsForConversation(conversation.id) : [];
      const hop0 = hops[0] ?? null;
      const hop1 = hops[1] ?? null;
      const messages = relay.messagesForConversation(conversation.id);
      const msg0 = hop0 ? messages.find((m) => m.id === hop0.requestMessageId) : null;
      const resp0 = hop0 ? messages.find((m) => m.id === hop0.responseMessageId) : null;
      const resp1 = hop1 ? messages.find((m) => m.id === hop1.responseMessageId) : null;

      const run0Id = hop0?.recipientRunId ?? null;
      const run1Id = hop1?.recipientRunId ?? null;
      const result0 = run0Id ? bus.result(run0Id) : null;
      const sourceOutput = (result0?.output ?? exchange?.hops?.[0]?.result?.output ?? msg0?.body ?? '') || '';
      const bOutput = resp0?.body ?? exchange?.hops?.[0]?.requestMessage?.body ?? '';
      const a1Output = resp1?.body ?? exchange?.hops?.[1]?.responseMessage?.body ?? '';

      const token = (sourceOutput.match(TOKEN_RE) || [])[0] ?? null;
      const tokenObserved = !!token;
      const sourceStatus = run0Id ? (bus.run(run0Id)?.status ?? null) : (exchange?.hops?.[0]?.status ?? 'failed');
      const transferToB =
        hop0?.status === 'completed' && !!token && typeof bOutput === 'string' && bOutput.includes(token);
      const transferToA =
        hop1?.status === 'completed' && !!token && typeof a1Output === 'string' && a1Output.includes(token);

      const proved =
        conversationStatus === 'completed' && !!token && transferToB && transferToA;

      const reason = classifyTransferRoute({
        sourceStatus: sourceStatus ?? 'failed',
        sourceOutputEmpty: typeof sourceOutput !== 'string' || sourceOutput.trim() === '',
        tokenObserved,
        targetStatus: transferToB ? 'completed' : 'failed',
        transferObserved: transferToA,
        handoffBuildFailed: false,
      });

      if (proved) report.proved += 1;

      report.routes.push({
        route: `${route.a} -> ${route.b} -> ${route.a}`,
        conversationId: conversation.id,
        conversationStatus,
        hops: hops.map((hop) => ({
          id: hop.id,
          status: hop.status,
          from: hop.from,
          to: hop.to,
          requestMessageId: hop.requestMessageId,
          responseMessageId: hop.responseMessageId,
          sourceTaskId: hop.sourceTaskId,
          sourceRunId: hop.sourceRunId,
          sourceResultId: hop.sourceResultId,
          recipientTaskId: hop.recipientTaskId,
          recipientRunId: hop.recipientRunId,
          recipientResultId: hop.recipientResultId,
        })),
        backendNames: [route.a, route.b],
        sourceAgent: route.a,
        targetAgent: route.b,
        sourceStatus,
        sourceOutputEmpty: typeof sourceOutput !== 'string' || sourceOutput.trim() === '',
        tokenObserved,
        targetStatus: transferToB ? 'completed' : 'failed',
        transferToB,
        transferToA,
        proved,
        reason,
        token,
        a0Output: sourceOutput,
        bOutput,
        a1Output,
        conversations: {
          status: conversationStatus,
          messageCount: messages.length,
          hopCount: hops.length,
        },
        transcript: relay.transcript(conversation.id).map((entry) => entry.event),
        error: runError ?? null,
      });
    }

    report.status = classifySmoke({ proved: report.proved, required: report.required });
    report.exitCode = exitCodeFor(report.status);
  } finally {
    await ctx.fiber.dispose();
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.status = classifySmoke({ proved: report.proved, required: report.required, harnessFailed: true });
  report.exitCode = exitCodeFor(report.status);
}

process.stdout.write(`\n===== PM SIMULATOR / GATE 5 PEER-RELAY SMOKE =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
if (report.registered) process.stdout.write(`registered backends: ${JSON.stringify(report.registered)}\n`);
for (const row of report.routes ?? []) {
  process.stdout.write(`\n-- route ${row.route} --\n`);
  process.stdout.write(`  conversationId: ${row.conversationId}\n`);
  process.stdout.write(`  conversation status: ${row.conversationStatus}\n`);
  for (const hop of row.hops ?? []) {
    process.stdout.write(`  hop ${hop.id}: ${hop.from} -> ${hop.to} [${hop.status}] req=${hop.requestMessageId ?? '-'} resp=${hop.responseMessageId ?? '-'}\n`);
    process.stdout.write(`    source (${hop.sourceTaskId ?? '-'}/${hop.sourceRunId ?? '-'}/${hop.sourceResultId ?? '-'})\n`);
    process.stdout.write(`    recipient (${hop.recipientTaskId ?? '-'}/${hop.recipientRunId ?? '-'}/${hop.recipientResultId ?? '-'})\n`);
  }
  process.stdout.write(`  sentinel from A: ${row.token ?? '(not found)'}\n`);
  process.stdout.write(`  A0 output: ${row.a0Output || '(empty)'}\n`);
  process.stdout.write(`  B echoed token: ${row.transferToB ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  B output: ${row.bOutput || '(empty)'}\n`);
  process.stdout.write(`  A returned B-derived material: ${row.transferToA ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  A1 output: ${row.a1Output || '(empty)'}\n`);
  process.stdout.write(`  conversation messages: ${row.conversations?.messageCount ?? 0}\n`);
  process.stdout.write(`  route proved: ${row.proved ? 'YES' : 'NO'} (${row.reason})\n`);
  if (row.error) process.stdout.write(`  dispatch error: ${row.error}\n`);
  process.stdout.write(`  peer events: ${(row.transcript ?? []).join(' -> ')}\n`);
}
process.stdout.write(`\nroutes proving automatic peer relay: ${report.proved}/${report.required}\n`);
process.stdout.write(`GATE 5: ${report.status}\n`);
if (report.error) process.stdout.write(`PM SIMULATOR ERROR: ${report.error}\n`);
process.exit(report.exitCode);