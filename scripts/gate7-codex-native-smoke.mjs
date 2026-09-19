#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { CodexSessionBridge, CODEX_SANDBOX_MODES } from '../src/session/codex-session-bridge.mjs';

const root = process.cwd();
const marker = `C7_${crypto.randomBytes(6).toString('hex')}`;
const report = {
  timestamp: new Date().toISOString(),
  cwd: root,
  marker,
  status: 'FAIL',
  capabilities: {
    resume_existing: { status: 'UNPROVED', evidence: null },
    send_next_turn: { status: 'UNPROVED', evidence: null },
    interrupt_active_turn: { status: 'UNPROVED', evidence: null },
    stream_events: { status: 'UNPROVED', evidence: null },
    concurrent_client_safe: { status: 'UNPROVED', evidence: 'not tested by this gate' },
    ui_live_refresh: { status: 'UNPROVED', evidence: 'not tested by this gate' },
  },
  errors: [],
};

function terminalStatus(event) {
  return event?.params?.turn?.status ?? event?.params?.status ?? null;
}

function includesMarker(value) {
  try { return JSON.stringify(value).includes(marker); } catch { return false; }
}

let threadId = null;
let firstClient = null;
let secondClient = null;
try {
  firstClient = await CodexSessionBridge.launch({ cwd: root, timeoutMs: 60_000 });
  const created = await firstClient.createThread({ cwd: root, approvalPolicy: 'never', sandbox: CODEX_SANDBOX_MODES.READ_ONLY });
  threadId = created.thread.id;

  const turn1Events = [];
  const off1 = firstClient.subscribeEvents(threadId, (event) => turn1Events.push(event));
  const firstPrompt = [
    'This is a read-only session-continuity test.',
    `Remember this exact private marker for the next turn: ${marker}`,
    'Reply only with ACK. Do not modify files or run commands.',
  ].join('\n');
  const firstTurn = await firstClient.sendNextTurn(threadId, firstPrompt);
  const turn1Id = firstTurn?.turn?.id;
  if (!turn1Id) throw new Error('turn 1 returned no turn id');
  const firstTerminal = await firstClient.waitForTurnTerminal(threadId, turn1Id, { timeoutMs: 120_000 });
  off1();
  report.capabilities.stream_events = turn1Events.length > 0
    ? { status: 'PROVED', evidence: `${turn1Events.length} thread-scoped notifications observed on turn 1` }
    : { status: 'UNPROVED', evidence: 'no thread-scoped notifications observed' };
  if (!['completed', 'completedWithWarnings', 'success'].includes(terminalStatus(firstTerminal) ?? 'completed')) {
    report.errors.push(`turn 1 terminal status: ${terminalStatus(firstTerminal)}`);
  }
  report.capabilities.send_next_turn = { status: 'PROVED', evidence: `turn/start accepted on ${threadId}, turn=${turn1Id}` };

  await firstClient.dispose();
  firstClient = null;

  secondClient = await CodexSessionBridge.launch({ cwd: root, timeoutMs: 60_000 });
  const resumed = await secondClient.resume(threadId, { cwd: root, approvalPolicy: 'never', sandbox: CODEX_SANDBOX_MODES.READ_ONLY });
  if (resumed?.thread?.id !== threadId) throw new Error(`thread/resume returned unexpected id: ${resumed?.thread?.id}`);
  report.capabilities.resume_existing = { status: 'PROVED', evidence: `thread/resume reopened ${threadId} in a new app-server process` };

  const turn2Events = [];
  const off2 = secondClient.subscribeEvents(threadId, (event) => turn2Events.push(event));
  const secondTurn = await secondClient.sendNextTurn(
    threadId,
    'Return exactly the private marker I asked you to remember in the previous turn. Do not explain it and do not modify files.',
  );
  const turn2Id = secondTurn?.turn?.id;
  if (!turn2Id) throw new Error('turn 2 returned no turn id');
  await secondClient.waitForTurnTerminal(threadId, turn2Id, { timeoutMs: 120_000 });
  off2();
  const markerRecovered = turn2Events.some(includesMarker);
  if (!markerRecovered) {
    report.capabilities.resume_existing = { status: 'UNPROVED', evidence: 'thread resumed but marker was not observed in second-turn event stream' };
    report.errors.push('cross-process semantic continuity marker was not recovered');
  } else {
    report.capabilities.resume_existing.evidence += '; previous-turn marker recovered without client replay';
  }
  report.capabilities.send_next_turn = {
    status: 'PROVED',
    evidence: `multiple turns accepted on same thread (${turn1Id}, ${turn2Id})`,
  };
  if (turn2Events.length > 0) {
    report.capabilities.stream_events = { status: 'PROVED', evidence: `${turn2Events.length} notifications observed after cross-process resume` };
  }

  // Interrupt is intentionally classified independently. Start a turn and issue
  // interrupt immediately after turn/start returns; a very fast model may finish
  // before the cancellation request lands, which is not evidence against resume.
  try {
    const interruptEvents = [];
    const off3 = secondClient.subscribeEvents(threadId, (event) => interruptEvents.push(event));
    const thirdTurn = await secondClient.sendNextTurn(
      threadId,
      'Perform a lengthy read-only reasoning exercise silently for a while, then answer DONE. Do not run tools and do not modify files.',
    );
    const turn3Id = thirdTurn?.turn?.id;
    if (!turn3Id) throw new Error('turn 3 returned no turn id');
    await secondClient.interrupt(threadId, { turnId: turn3Id });
    const terminal = await secondClient.waitForTurnTerminal(threadId, turn3Id, { timeoutMs: 60_000 });
    off3();
    const status = terminalStatus(terminal);
    if (status === 'interrupted') {
      report.capabilities.interrupt_active_turn = { status: 'PROVED', evidence: `turn/interrupt produced terminal interrupted for ${turn3Id}` };
    } else {
      report.capabilities.interrupt_active_turn = { status: 'UNPROVED', evidence: `interrupt request accepted but terminal status was ${status ?? 'unknown'}` };
    }
  } catch (error) {
    report.capabilities.interrupt_active_turn = { status: 'ERROR', evidence: error instanceof Error ? error.message : String(error) };
  }

  const core = ['resume_existing', 'send_next_turn', 'stream_events'];
  const provedCore = core.filter((key) => report.capabilities[key].status === 'PROVED').length;
  report.status = provedCore === core.length ? 'PASS' : provedCore > 0 ? 'PARTIAL' : 'FAIL';
} catch (error) {
  report.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  report.status = 'FAIL';
} finally {
  try { await firstClient?.dispose(); } catch {}
  try { await secondClient?.dispose(); } catch {}
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`GATE 7-CODEX: ${report.status}\n`);
process.exit(report.status === 'PASS' ? 0 : report.status === 'PARTIAL' ? 2 : 1);
