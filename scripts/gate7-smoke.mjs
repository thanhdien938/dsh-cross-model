#!/usr/bin/env node
import { SessionRegistry } from '../src/session/session-registry.mjs';
import { SessionRouter } from '../src/session/session-router.mjs';

const checks = [];
const expect = (name, condition, detail = '') => {
  checks.push({ name, pass: !!condition, detail });
};

const calls = [];
const bridge = {
  resume: async (sessionId) => { calls.push(['resume', sessionId]); return { sessionId, resumed: true }; },
  sendNextTurn: async (sessionId, message) => { calls.push(['next', sessionId, message]); return { output: `echo:${message}` }; },
  interrupt: async (sessionId) => { calls.push(['interrupt', sessionId]); return { interrupted: true }; },
};

const registry = new SessionRegistry();
registry.register('alpha-native', bridge, {
  resume_existing: true,
  send_next_turn: true,
  interrupt_active_turn: true,
});
registry.register('beta-one-shot', {}, {});

let dispatches = 0;
const router = new SessionRouter({
  registry,
  agentBus: {
    dispatch: async (input) => {
      dispatches += 1;
      return { id: `fresh-${dispatches}`, input };
    },
  },
});

const resumed = await router.resume('alpha-native', 'native-123');
const next = await router.sendNextTurn('alpha-native', 'native-123', 'hello');
const interrupted = await router.interrupt('alpha-native', 'native-123');
expect('native resume delegated', resumed.resumed === true && calls[0]?.[0] === 'resume');
expect('next-turn delegated', next.output === 'echo:hello' && calls[1]?.[0] === 'next');
expect('interrupt delegated', interrupted.interrupted === true && calls[2]?.[0] === 'interrupt');

let unsupported = false;
try {
  await router.resume('beta-one-shot', 'native-999');
} catch (error) {
  unsupported = error?.code === 'UNSUPPORTED_SESSION_CAPABILITY';
}
expect('one-shot backend rejects resume', unsupported);

const plan = router.planFreshDispatchFallback({ backend: 'beta-one-shot', body: 'continue with explicit context', context: { prior: 'bounded' } });
expect('fallback plan explicit', plan.mode === 'fresh_dispatch' && plan.truthfulContinuity === false && plan.executed === false);
expect('fallback planning does not execute', dispatches === 0);

const run = await router.executeFreshDispatchPlan(plan);
expect('fallback execution explicit', dispatches === 1 && run.id === 'fresh-1');

const report = router.report();
expect('capability report neutral', report.map((r) => r.backend).join(',') === 'alpha-native,beta-one-shot');

for (const row of checks) {
  process.stdout.write(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? ` — ${row.detail}` : ''}\n`);
}
const passed = checks.filter((row) => row.pass).length;
process.stdout.write(`\nGate 7 deterministic checks: ${passed}/${checks.length}\n`);
process.stdout.write('Native Codex/Claude/Grok continuation proven by this smoke: NO\n');
process.stdout.write('Gate 7 means capability seam readiness only.\n');
process.exit(passed === checks.length ? 0 : 1);
