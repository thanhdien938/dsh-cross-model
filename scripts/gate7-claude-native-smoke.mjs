#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { ClaudeCodeSessionBridge } from '../src/session/claude-code-session-bridge.mjs';

const root = process.cwd();
const marker = `CL7_${crypto.randomBytes(6).toString('hex')}`;
const report = {
  timestamp: new Date().toISOString(),
  versionExpectation: 'Claude Code 2.1.233 (local source of truth)',
  sessionId: null,
  marker,
  capabilities: {
    resume_existing: { status: 'UNPROVEN' },
    send_next_turn: { status: 'UNPROVEN' },
    stream_events: { status: 'UNPROVEN' },
    interrupt_active_turn: { status: 'UNPROVEN', evidence: 'not implemented/probed in this gate' },
    concurrent_client_safe: { status: 'UNPROVEN', evidence: 'not tested' },
    ui_live_refresh: { status: 'UNPROVEN', evidence: 'not tested' },
  },
  checks: [],
};

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}: ${detail || 'failed'}`);
}

try {
  const first = new ClaudeCodeSessionBridge({ cwd: root, timeoutMs: 120_000, permissionMode: 'plan' });
  const turn1 = await first.createSession([
    'This is a native-session persistence test.',
    `Remember this synthetic marker exactly: ${marker}`,
    'Reply with exactly ACK and nothing else. Do not modify files.',
  ].join('\n'));

  report.sessionId = turn1.sessionId;
  check('new session id returned', typeof turn1.sessionId === 'string' && turn1.sessionId.length > 0, String(turn1.sessionId));
  check('turn 1 completed in first process', typeof turn1.result === 'string', String(turn1.result));

  // The bridge launches a fresh CLI process per call. No process object survives
  // between createSession() and sendNextTurn(), so this is a cross-process proof.
  const second = new ClaudeCodeSessionBridge({ cwd: root, timeoutMs: 120_000, permissionMode: 'plan' });
  const turn2Prompt = 'What exact synthetic marker did I ask you to remember in the previous turn? Reply with only that marker. Do not modify files.';
  check('turn 2 prompt does not replay marker', !turn2Prompt.includes(marker));
  const turn2 = await second.sendNextTurn(turn1.sessionId, turn2Prompt);
  const recalled = typeof turn2.result === 'string' && turn2.result.includes(marker);
  check('marker recalled after resume in a new process', recalled, String(turn2.result));
  report.capabilities.resume_existing = { status: 'PROVED', evidence: `session ${turn1.sessionId} recalled marker across independent CLI processes without replay` };
  report.capabilities.send_next_turn = { status: 'PROVED', evidence: `second turn accepted with --resume ${turn1.sessionId}` };

  const streamPrompt = 'Reply with exactly STREAM_OK and nothing else. Do not modify files.';
  const streamed = await second.streamTurn(turn1.sessionId, streamPrompt);
  const sameSession = streamed.sessionId === turn1.sessionId;
  const structured = Array.isArray(streamed.events) && streamed.events.length >= 2;
  const hasResult = streamed.events?.some((event) => event?.type === 'result');
  check('stream turn preserved session id', sameSession, String(streamed.sessionId));
  check('stream-json produced multiple structured events', structured, `events=${streamed.events?.length ?? 0}`);
  check('stream-json contained result event', hasResult, `events=${streamed.events?.length ?? 0}`);
  report.capabilities.stream_events = {
    status: structured && hasResult ? 'PROVED' : 'UNPROVEN',
    evidence: `structured events observed=${streamed.events?.length ?? 0}`,
  };

  const core = ['resume_existing', 'send_next_turn', 'stream_events'];
  const proved = core.filter((name) => report.capabilities[name].status === 'PROVED').length;
  report.status = proved === core.length ? 'PASS' : proved > 0 ? 'PARTIAL' : 'FAIL';
  report.proved = `${proved}/${core.length}`;
} catch (error) {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
  if (error?.stderr) report.stderr = error.stderr.slice(0, 4000);
}

process.stdout.write('\n===== T7-CLAUDE NATIVE SESSION PROOF =====\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`GATE 7-CLAUDE: ${report.status}\n`);
process.exit(report.status === 'PASS' ? 0 : report.status === 'PARTIAL' ? 2 : 1);