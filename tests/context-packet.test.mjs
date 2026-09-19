import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPacket } from '../src/context-packet.mjs';
import { DebateState } from '../src/debate-state.mjs';

test('context packet carries task, own history, peer critique and constraints', () => {
  const text = buildContextPacket({
    task: 'Design X', role: 'Architect', round: 3,
    ownPrevious: ['Use A'], peerMessages: ['Critic: B is safer'], constraints: ['No API keys']
  });
  assert.match(text, /Design X/);
  assert.match(text, /Use A/);
  assert.match(text, /B is safer/);
  assert.match(text, /No API keys/);
  assert.match(text, /do not restart from zero/i);
});

test('debate state builds asymmetric packets for each actor', () => {
  const s = new DebateState({ task: 'Choose storage' });
  s.add({ actor: 'codex', text: 'Use Postgres', round: 1 });
  s.add({ actor: 'claude', text: 'Postgres needs migration discipline', round: 2 });
  const p = s.packetFor({ actor: 'codex', role: 'Architect', round: 3 });
  assert.match(p, /Your previous positions[\s\S]*Use Postgres/);
  assert.match(p, /Peer arguments[\s\S]*claude:[\s\S]*migration discipline/);
});
