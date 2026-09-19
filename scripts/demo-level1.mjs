import { DebateState } from '../src/debate-state.mjs';

const state = new DebateState({
  task: 'Design a safe cross-model coding workflow that minimizes context drift.',
  constraints: ['Codex and Claude Code are one-shot in stock DSH adapters', 'No human copy/paste between rounds']
});

state.add({ actor: 'codex', round: 1, text: 'Use DSH as the canonical transcript owner and relay compact context packets.' });
console.log('\n--- CLAUDE ROUND 2 PACKET ---\n');
console.log(state.packetFor({ actor: 'claude', role: 'Adversarial reviewer', round: 2 }));

state.add({ actor: 'claude', round: 2, text: 'Require explicit change tracking and bounded transcript summaries to avoid drift.' });
console.log('\n--- CODEX ROUND 3 PACKET ---\n');
console.log(state.packetFor({ actor: 'codex', role: 'Architect/reviser', round: 3 }));
