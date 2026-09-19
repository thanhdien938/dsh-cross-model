#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { GrokSessionBridge } from '../src/session/grok-session-bridge.mjs';

const root = process.cwd();
const marker = `GR7_${crypto.randomBytes(6).toString('hex')}`;
const report = {
  runtime: null,
  sessionId: null,
  capabilities: {
    resume_existing: { status: 'UNPROVEN', evidence: null },
    send_next_turn: { status: 'UNPROVEN', evidence: null },
    stream_events: { status: 'UNPROVEN', evidence: null },
    interrupt_active_turn: { status: 'UNPROVEN', evidence: null },
    concurrent_client_safe: { status: 'UNPROVEN', evidence: 'not tested in this gate' },
    ui_live_refresh: { status: 'UNPROVEN', evidence: 'not tested in this gate' },
  },
  marker,
};

function printReport() {
  console.log('\n=== T7-GROK native-session capability report ===');
  console.log(JSON.stringify(report, null, 2));
}

let first = null;
let second = null;
try {
  first = await GrokSessionBridge.launch({ cwd: root, timeoutMs: 120_000 });
  report.runtime = {
    binary: first.client.binary,
    initialize: first.client.initialized,
  };
  const created = await first.createSession({ cwd: root });
  report.sessionId = created.sessionId;

  const turn1 = await first.sendNextTurn(
    created.sessionId,
    `Remember this exact marker for this session: ${marker}. Reply briefly confirming you stored it. Do not modify files.`,
  );
  if (!turn1.text.includes(marker)) throw new Error(`turn 1 did not visibly acknowledge marker; text=${JSON.stringify(turn1.text)}`);
  if (turn1.updates.length > 0) {
    report.capabilities.stream_events = {
      status: 'PROVED',
      evidence: `${turn1.updates.length} thread/session-scoped session/update notifications observed in process A`,
    };
  }

  await first.dispose();
  first = null;

  // Independent ACP process: restore server-owned conversation by session id.
  second = await GrokSessionBridge.launch({ cwd: root, timeoutMs: 120_000 });
  await second.resume(created.sessionId, { cwd: root });
  report.capabilities.resume_existing = {
    status: 'PROVED',
    evidence: `session/load accepted ${created.sessionId} in a new grok agent stdio process`,
  };

  const recallPrompt = 'What exact marker did I ask you to remember in the previous turn? Reply with only that marker. Do not inspect files or external memory.';
  if (recallPrompt.includes(marker)) throw new Error('proof invalid: recall prompt accidentally replays marker');
  const turn2 = await second.sendNextTurn(created.sessionId, recallPrompt);
  if (!turn2.text.includes(marker)) {
    report.capabilities.resume_existing = {
      status: 'ERROR',
      evidence: `session/load succeeded but semantic recall failed; returned=${JSON.stringify(turn2.text)}`,
    };
    throw new Error('cross-process Grok semantic continuity was not observed');
  }
  report.capabilities.send_next_turn = {
    status: 'PROVED',
    evidence: 'a new session/prompt completed on the loaded existing session in process B',
  };
  if (turn2.updates.length > 0) {
    report.capabilities.stream_events = {
      status: 'PROVED',
      evidence: `${turn1.updates.length + turn2.updates.length} session/update notifications observed across process restart`,
    };
  }

  // Independent interrupt probe. Non-blocking for the gate: if the model races
  // to completion before cancellation, report ERROR/UNPROVEN rather than lie.
  try {
    let sawUpdate;
    const firstUpdate = new Promise((resolve) => { sawUpdate = resolve; });
    const unsubscribe = second.subscribeEvents(created.sessionId, (event) => {
      if (event.method === 'session/update') sawUpdate(event);
    });
    const longTurn = second.sendNextTurn(
      created.sessionId,
      'Generate a very long numbered list slowly, with at least 300 items. Do not use tools.',
      { timeoutMs: 120_000 },
    );
    await Promise.race([firstUpdate, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    second.interrupt(created.sessionId);
    const interrupted = await Promise.race([
      longTurn.then((value) => ({ kind: 'settled', value }), (error) => ({ kind: 'error', error })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 15_000)),
    ]);
    unsubscribe();
    if (interrupted.kind === 'timeout') {
      report.capabilities.interrupt_active_turn = { status: 'ERROR', evidence: 'session/cancel sent but prompt did not settle within 15s' };
    } else if (interrupted.kind === 'error') {
      report.capabilities.interrupt_active_turn = { status: 'PROVED', evidence: `session/cancel caused active prompt to reject: ${interrupted.error.message}` };
    } else {
      const stopReason = interrupted.value?.result?.stopReason ?? null;
      if (stopReason && /cancel|interrupt/i.test(String(stopReason))) {
        report.capabilities.interrupt_active_turn = { status: 'PROVED', evidence: `session/cancel yielded stopReason=${stopReason}` };
      } else {
        report.capabilities.interrupt_active_turn = { status: 'ERROR', evidence: `cancel raced with normal completion; stopReason=${stopReason ?? '<none>'}` };
      }
    }
  } catch (error) {
    report.capabilities.interrupt_active_turn = { status: 'ERROR', evidence: error.message };
  }

  const core = ['resume_existing', 'send_next_turn', 'stream_events'];
  const passed = core.every((key) => report.capabilities[key].status === 'PROVED');
  printReport();
  console.log(`\nGATE 7-GROK: ${passed ? 'PASS' : 'FAIL'}`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  if (report.capabilities.resume_existing.status === 'UNPROVEN') {
    report.capabilities.resume_existing = { status: 'ERROR', evidence: error.message };
  }
  printReport();
  console.error(`\nGATE 7-GROK: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  await first?.dispose().catch(() => {});
  await second?.dispose().catch(() => {});
}
