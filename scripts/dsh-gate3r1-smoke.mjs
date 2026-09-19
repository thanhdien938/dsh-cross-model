#!/usr/bin/env node
/**
 * T3-R1 — real context delivery smoke through AgentBus.
 *
 * Proves `TaskEnvelope.context` reaches a real native child via the
 * AgentBus -> DSH adapter path. A synthetic sentinel exists ONLY in the task
 * context (never in task.body or expectedOutput); the child is asked to echo
 * exactly that sentinel from the CONTEXT section of the canonical child input.
 *
 * Read-only: children run in this repository workspace and must not modify
 * files. Context data is synthetic only — no real user secrets.
 *
 * Runs against all three real backends. Per T4-R1 strict gate semantics:
 *   PASS    = every declared backend echoed the sentinel (3/3)
 *   PARTIAL = at least one but not all proved it (1/3 or 2/3)
 *   FAIL    = none proved it, or the harness could not execute meaningfully
 * Exit code: 0 (PASS), 2 (PARTIAL), 1 (FAIL).
 */

import { bootHarness, repoRoot } from './lib/conn-smoke.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { createDshSubagentAdapter } from '../src/adapters/dsh-subagent-adapter.mjs';
import {
  classifySmoke,
  classifyContextRow,
  exitCodeFor,
  SMOKE_REASON,
} from './lib/smoke-status.mjs';

const SENTINEL = 'CTX_T3R1_a61f7c';

const body = [
  'You are dispatched through the AgentBus in a read-only context-delivery smoke test.',
  'Your task text contains a CONTEXT section holding a JSON object with a field named `t3r1Sentinel`.',
  'Locate the CONTEXT section and reproduce exactly the value of the `t3r1Sentinel` field in your reply.',
  'Return exactly that sentinel value and nothing else.',
  'Do not modify any files.',
].join('\n');

const context = {
  t3r1Sentinel: SENTINEL,
  purpose: 'prove TaskEnvelope.context reached the native child',
};

const backends = [
  { provider: 'codex', product: 'Codex' },
  { provider: 'claude-code', product: 'Claude Code' },
  { provider: 'grok', product: 'Grok Build' },
];

const report = {
  repoRoot,
  timestamp: new Date().toISOString(),
  composition: 'config/dsh-gate2.cordis.yml',
  sentinel: SENTINEL,
  rows: [],
  required: backends.length,
  proved: 0,
  status: 'FAIL',
  exitCode: 1,
};

let ctx;
try {
  ctx = await bootHarness('t3-r1-context-smoke', 'config/dsh-gate2.cordis.yml');
  try {
    const events = new EventBus();
    const state = new StateStore();
    const registry = new AgentRegistry();
    const bus = new AgentBus({ registry, events, state });

    for (const { provider, product } of backends) {
      registry.register(
        provider,
        createDshSubagentAdapter({ ctx, provider, product, cwd: repoRoot }),
        { transport: 'dsh-subagent', provider, product },
      );
    }
    report.providers = registry.list();

    for (const { provider, product } of backends) {
      let run = null;
      let error = null;
      try {
        run = await bus.dispatch({ recipient: provider, body, context });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const result = run ? bus.result(run.id) : null;
      const output = result ? result.output : '';
      const outputEmpty = typeof output !== 'string' || output.trim() === '';
      const sentinelObserved = typeof output === 'string' && output.includes(SENTINEL);
      const status = run ? run.status : 'failed';
      const reason = classifyContextRow({
        status,
        outputEmpty,
        sentinelObserved,
        agentFailed: !!error,
      });
      const proved = reason === SMOKE_REASON.PROVED;
      if (proved) report.proved += 1;
      report.rows.push({
        taskId: run ? run.taskId : null,
        runId: run ? run.id : null,
        agent: provider,
        product,
        status,
        outputEmpty,
        sentinelObserved,
        proved,
        reason,
        output: output.slice(0, 500),
        error: error ?? null,
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

process.stdout.write(`\n===== T3-R1 CONTEXT DELIVERY SMOKE =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
process.stdout.write(`sentinel (context only, synthetic): ${report.sentinel}\n`);
process.stdout.write(`canonical child input:\n${'---'}\n${body}\n\nCONTEXT\n${JSON.stringify(context, null, 2)}\n\nEXPECTED OUTPUT\n<unspecified>\n${'---'}\n`);
for (const row of report.rows ?? []) {
  process.stdout.write(`\n-- ${row.agent} (${row.product}) --\n`);
  process.stdout.write(`  taskId:  ${row.taskId ?? '-'}\n`);
  process.stdout.write(`  runId:   ${row.runId ?? '-'}\n`);
  process.stdout.write(`  status:  ${row.status}\n`);
  process.stdout.write(`  output empty: ${row.outputEmpty ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  sentinel echoed: ${row.sentinelObserved ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  proved:  ${row.proved ? 'YES' : 'NO'} (${row.reason})\n`);
  process.stdout.write(`  output:  ${row.output || '(empty)'}\n`);
  if (row.error) process.stdout.write(`  error:   ${row.error}\n`);
}
process.stdout.write(`\nbackends proving context delivery: ${report.proved}/${report.required}\n`);
process.stdout.write(`T3-R1 CONTEXT SMOKE: ${report.status}\n`);
if (report.error) process.stdout.write(`HARNESS ERROR: ${report.error}\n`);
process.exit(report.exitCode);