#!/usr/bin/env node
/**
 * T3 Gate 3 — Agent Bus Core real three-backend smoke.
 *
 * Boots ONE DSH host/context from the proven Gate 2 composition
 * (`config/dsh-gate2.cordis.yml`), registers the three real backends as
 * AgentAdapter instances over the DSH subagent service, and dispatches the
 * same neutral read-only task through `AgentBus.dispatch` (never a direct
 * `ctx.subagents.start` from this script).
 *
 * Every dispatch produces a normalized ResultEnvelope. No permanent roles are
 * assigned; backends are interchangeable. All children run in this repository
 * workspace and must not modify files.
 */

import { bootHarness, repoRoot } from './lib/conn-smoke.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { createDshSubagentAdapter } from '../src/adapters/dsh-subagent-adapter.mjs';

const body = [
  'You are being dispatched through the AgentBus in a connectivity smoke test.',
  'Return exactly a short identification message stating that you received the task in the current repository through the AgentBus.',
  'Do not modify any files.',
].join('\n');

const backends = [
  { provider: 'codex', product: 'Codex' },
  { provider: 'claude-code', product: 'Claude Code' },
  { provider: 'grok', product: 'Grok Build' },
];

const report = {
  repoRoot,
  timestamp: new Date().toISOString(),
  composition: 'config/dsh-gate2.cordis.yml',
  rows: [],
  eventSequence: [],
  gate3: 'FAIL',
};

let ctx;
let allEvents = [];
try {
  ctx = await bootHarness('t3-gate3-smoke', 'config/dsh-gate2.cordis.yml');
  try {
    const events = new EventBus();
    const state = new StateStore();
    const registry = new AgentRegistry();
    const bus = new AgentBus({ registry, events, state });

    bus.events.all((event, payload) => allEvents.push({
      event,
      taskId: payload?.taskId ?? null,
      runId: payload?.runId ?? null,
      agent: payload?.agent ?? null,
    }));

    for (const { provider, product } of backends) {
      registry.register(
        provider,
        createDshSubagentAdapter({ ctx, provider, product, cwd: repoRoot }),
        { transport: 'dsh-subagent', provider, product },
      );
    }
    report.providers = registry.list();

    for (const { provider, product } of backends) {
      const run = await bus.dispatch({ recipient: provider, body, context: { smoke: 't3-gate3' } });
      const result = bus.result(run.id);
      report.rows.push({
        taskId: run.taskId,
        runId: run.id,
        agent: run.agent,
        product,
        status: run.status,
        output: result ? result.output : '',
      });
    }

    for (const row of report.rows) {
      const perRun = allEvents
        .filter((entry) => entry.runId === row.runId || (entry.runId === null && entry.taskId === row.taskId && entry.event === 'task.created'))
        .map((entry) => entry.event);
      if (perRun.length > 0) report.eventSequence.push({ agent: row.agent, sequence: perRun.join(' -> ') });
    }

    report.gate3 = report.rows.every((row) => row.status === 'completed' && row.output.length > 0) ? 'PASS' : 'PARTIAL';
  } finally {
    await ctx.fiber.dispose();
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.gate3 = 'FAIL';
}

process.stdout.write(`\n===== AGENT BUS GATE 3 SMOKE REPORT =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
if (report.providers) process.stdout.write(`registered backends: ${JSON.stringify(report.providers)}\n`);
for (const row of report.rows ?? []) {
  process.stdout.write(`\n-- ${row.agent} (${row.product}) --\n`);
  process.stdout.write(`  taskId: ${row.taskId}\n`);
  process.stdout.write(`  runId:  ${row.runId}\n`);
  process.stdout.write(`  status: ${row.status}\n`);
  process.stdout.write(`  result: ${row.output || '(empty)'}\n`);
}
process.stdout.write(`\nEVENT LIFECYCLE (per run):\n`);
for (const item of report.eventSequence ?? []) {
  process.stdout.write(`  ${item.agent}: ${item.sequence}\n`);
}
process.stdout.write(`\nGATE 3: ${report.gate3}\n`);
if (report.error) process.stdout.write(`HARNESS ERROR: ${report.error}\n`);
process.exit(report.gate3 === 'PASS' ? 0 : 1);
