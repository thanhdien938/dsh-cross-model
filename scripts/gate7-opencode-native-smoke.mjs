#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  OpenCodeCliSessionBridge,
  resolveOpenCodeBinary,
} from '../src/session/opencode-cli-session-bridge.mjs';

const root = process.cwd();
const marker = `OC7_${crypto.randomBytes(6).toString('hex')}`;
const binary = resolveOpenCodeBinary();
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });

const report = {
  binary,
  version: (version.stdout || version.stderr || '').trim(),
  marker,
  sessionId: null,
  capabilities: {
    resume_existing: { status: 'UNPROVEN' },
    send_next_turn: { status: 'UNPROVEN' },
    stream_events: { status: 'UNPROVEN' },
    interrupt_active_turn: { status: 'UNPROVEN', evidence: 'not tested in CLI gate' },
    concurrent_client_safe: { status: 'UNPROVEN' },
    ui_live_refresh: { status: 'UNPROVEN' },
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // Process A: create a native OpenCode session and store a random marker.
  const firstBridge = new OpenCodeCliSessionBridge({ binary, cwd: root });
  const first = await firstBridge.createSession(
    `Remember this exact marker for the next turn: ${marker}. Reply briefly confirming you stored it. Do not modify files.`,
  );
  report.sessionId = first.sessionId;
  assert(first.events.length > 1, `process A produced only ${first.events.length} structured event(s)`);

  // Process B is intentionally represented by a NEW bridge; every call spawns a
  // fresh CLI process. The marker is NOT present in this prompt.
  const secondBridge = new OpenCodeCliSessionBridge({ binary, cwd: root });
  await secondBridge.resume(first.sessionId);
  const second = await secondBridge.sendNextTurn(
    first.sessionId,
    'What exact marker did I ask you to remember in the previous turn? Return only that marker. Do not modify files.',
  );

  const combined = [second.stdout, JSON.stringify(second.events)].join('\n');
  assert(combined.includes(marker), 'process B did not recall the marker without client replay');
  assert(second.events.length > 1, `process B produced only ${second.events.length} structured event(s)`);

  report.capabilities.resume_existing = {
    status: 'PROVED',
    evidence: `fresh CLI process continued native session ${first.sessionId} and recalled marker without replay`,
  };
  report.capabilities.send_next_turn = {
    status: 'PROVED',
    evidence: `second opencode run completed against --session ${first.sessionId}`,
  };
  report.capabilities.stream_events = {
    status: 'PROVED',
    evidence: `${first.events.length + second.events.length} parseable JSON events across two CLI processes`,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('GATE 7-OPENCODE: PASS');
  process.exitCode = 0;
} catch (error) {
  report.error = {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  };
  console.error(JSON.stringify(report, null, 2));
  console.error('GATE 7-OPENCODE: FAIL');
  process.exitCode = 1;
}
