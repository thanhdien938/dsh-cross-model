#!/usr/bin/env node
/**
 * T4 Gate 4 — real automated two-hop dispatch/handoff smoke + PM simulator.
 *
 * PM simulator: a deterministic workflow driver (not an LLM) that chooses a
 * WorkflowSpec, runs it through WorkflowRunner, prints compact status/results,
 * and exits non-zero on failure. No model-specific reasoning policy.
 *
 * Proof of AUTOMATIC handoff, not just two independent dispatches:
 *   Hop A returns a synthetic token (T4HK_<hex>) through the real native
 *   child. The smoke NEVER writes that token into Hop B's body/expectedOutput
 *   or into the workflow spec — the runner builds Hop B's context from Hop A's
 *   ResultEnvelope via the canonical handoff builder. Hop B proves it received
 *   A-derived data by returning exactly that token from the CONTEXT section.
 *
 * Read-only: children run in this repository workspace and must not modify
 * files. The only nontrivial data is the synthetic per-run token.
 *
 * Per T4-R1 strict gate semantics:
 *   PASS    = EVERY declared route proved automatic handoff (2/2)
 *   PARTIAL = at least one but not all routes proved it (1/2)
 *   FAIL    = none proved it, or the harness could not execute meaningfully
 * Exit code: 0 (PASS), 2 (PARTIAL), 1 (FAIL).
 */

import { bootHarness, repoRoot } from './lib/conn-smoke.mjs';
import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { createDshSubagentAdapter } from '../src/adapters/dsh-subagent-adapter.mjs';
import { WorkflowRunner } from '../src/workflow/workflow-runner.mjs';
import { buildHandoffContext } from '../src/workflow/handoff-context.mjs';
import {
  classifySmoke,
  classifyTransferRoute,
  exitCodeFor,
  SMOKE_REASON,
} from './lib/smoke-status.mjs';

const TOKEN_RE = /T4HK_[0-9a-f]{8}/i;

const hopABody = (product) => [
  `You are Agent A (${product}) in an automated two-hop workflows test.`,
  'Return exactly one synthetic token and nothing else.',
  'The token must be the literal string T4HK_ followed by exactly 8 lowercase hexadecimal characters (0-9a-f).',
  'Example output: T4HK_a1b2c3d4',
  'Do not modify any files.',
].join('\n');

const hopBBody = [
  'You are Agent B in an automated two-hop workflow.',
  'Read the CONTEXT section of your task input. It contains a field `previousResult.output`',
  'holding a synthetic token of the form T4HK_<8 hex chars> that a previous agent (Agent A) produced.',
  'Return exactly that token and nothing else.',
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
  ctx = await bootHarness('t4-gate4-smoke', 'config/dsh-gate2.cordis.yml');
  try {
    const events = new EventBus({ onListenerError: (error) => process.stderr.write(`event-bus: ${error}\n`) });
    const state = new StateStore();
    const registry = new AgentRegistry();
    const bus = new AgentBus({ registry, events, state });
    const runner = new WorkflowRunner({ bus });

    for (const { provider, product } of [
      { provider: 'codex', product: 'Codex' },
      { provider: 'claude-code', product: 'Claude Code' },
      { provider: 'grok', product: 'Grok Build' },
    ]) {
      registry.register(
        provider,
        createDshSubagentAdapter({ ctx, provider, product, cwd: repoRoot }),
        { transport: 'dsh-subagent', provider, product },
      );
    }
    report.registered = registry.list();

    for (const route of routes) {
      const spec = {
        sender: 'pm',
        steps: [
          { recipient: route.a, body: hopABody(route.aProduct) },
          { recipient: route.b, body: hopBBody, contextFromPrevious: true },
        ],
      };
      let result;
      let runError = null;
      let handoffBuildFailed = false;
      try {
        result = await runner.run(spec);
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }
      const workflow = result ? runner.getWorkflow(result.workflowId) : null;
      const stepA = workflow?.steps[0] ?? null;
      const stepB = workflow?.steps[1] ?? null;
      const resultA = stepA?.resultId ? bus.result(stepA.runId) : null;
      const resultB = stepB?.resultId ? bus.result(stepB.runId) : null;
      const aOutput = resultA?.output ?? '';
      const bOutput = resultB?.output ?? '';
      const token = (aOutput.match(TOKEN_RE) || [])[0] ?? null;
      const sourceStatus = resultA?.status ?? (result?.status ?? 'failed');
      const sourceOutputEmpty = typeof aOutput !== 'string' || aOutput.trim() === '';
      const tokenObserved = !!token;
      const targetStatus = resultB?.status ?? null;
      const transferObserved =
        sourceStatus === 'completed' && targetStatus === 'completed' &&
        !!token && typeof bOutput === 'string' && bOutput.includes(token);

      let derivedForDisplay = null;
      if (resultA && workflow && stepA && stepB) {
        try {
          derivedForDisplay = buildHandoffContext({ workflow, previousStep: stepA, previousResult: resultA, nextStep: stepB });
        } catch {
          handoffBuildFailed = true;
        }
      } else {
        handoffBuildFailed = !!runError;
      }

      const reason = classifyTransferRoute({
        sourceStatus,
        sourceOutputEmpty,
        tokenObserved,
        targetStatus,
        transferObserved,
        handoffBuildFailed,
      });
      const proved = reason === SMOKE_REASON.PROVED;
      if (proved) report.proved += 1;
      report.routes.push({
        route: `${route.a} -> ${route.b}`,
        sourceAgent: route.a,
        targetAgent: route.b,
        workflowId: result?.workflowId ?? null,
        workflowStatus: result?.status ?? 'unknown',
        stepStatuses: result ? result.steps.map((s) => `${s.recipient}=${s.status}`).join(', ') : 'unknown',
        sourceStatus,
        sourceOutputEmpty,
        tokenObserved,
        targetStatus,
        transferObserved,
        proved,
        reason,
        aResultId: resultA?.id ?? null,
        bResultId: resultB?.id ?? null,
        token,
        aOutput,
        bOutput,
        error: runError ?? null,
        derivedHandoffB: derivedForDisplay
          ? {
              workflow: derivedForDisplay.workflow,
              previousResult: {
                status: derivedForDisplay.previousResult.status,
                output: derivedForDisplay.previousResult.output,
                artifacts: derivedForDisplay.previousResult.artifacts,
                handoff: derivedForDisplay.previousResult.handoff,
              },
            }
          : null,
        events: result ? runner.transcript(result.workflowId).map((entry) => entry.event) : [],
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

process.stdout.write(`\n===== PM SIMULATOR / GATE 4 TWO-HOP SMOKE =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
if (report.registered) process.stdout.write(`registered backends: ${JSON.stringify(report.registered)}\n`);
for (const row of report.routes ?? []) {
  process.stdout.write(`\n-- route ${row.route} --\n`);
  process.stdout.write(`  workflowId: ${row.workflowId}\n`);
  process.stdout.write(`  workflow status: ${row.workflowStatus} (${row.stepStatuses})\n`);
  process.stdout.write(`  source:  ${row.sourceAgent} (status ${row.sourceStatus}, output empty ${row.sourceOutputEmpty ? 'YES' : 'NO'}, token ${row.tokenObserved ? 'YES' : 'NO'})\n`);
  process.stdout.write(`  target:  ${row.targetAgent} (status ${row.targetStatus ?? 'n/a'})\n`);
  process.stdout.write(`  hop A result id: ${row.aResultId}\n`);
  process.stdout.write(`  hop B result id: ${row.bResultId}\n`);
  process.stdout.write(`  hop A output: ${row.aOutput || '(empty)'}\n`);
  process.stdout.write(`  hop B output: ${row.bOutput || '(empty)'}\n`);
  process.stdout.write(`  sentinel from A: ${row.token ?? '(not found)'}\n`);
  process.stdout.write(`  B proved A-derived data received: ${row.transferObserved ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  route proved: ${row.proved ? 'YES' : 'NO'} (${row.reason})\n`);
  if (row.error) process.stdout.write(`  dispatch error: ${row.error}\n`);
  const d = row.derivedHandoffB;
  if (d) {
    process.stdout.write(`  automatic handoff context delivered to B: ${JSON.stringify({ workflow: d.workflow, previousResult: { status: d.previousResult.status, output: d.previousResult.output, artifacts: d.previousResult.artifacts, handoff: d.previousResult.handoff } })}\n`);
  }
  process.stdout.write(`  workflow events: ${row.events.join(' -> ')}\n`);
}
process.stdout.write(`\nroutes proving automatic handoff: ${report.proved}/${report.required}\n`);
process.stdout.write(`GATE 4: ${report.status}\n`);
if (report.error) process.stdout.write(`PM SIMULATOR ERROR: ${report.error}\n`);
process.exit(report.exitCode);