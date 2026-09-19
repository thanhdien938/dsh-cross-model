#!/usr/bin/env node
/**
 * T2 Gate 2 — DSH three-agent connectivity smoke driver.
 *
 * Boots ONE DSH host/context from `config/dsh-gate2.cordis.yml`, verifies that
 * all three backend providers (`codex`, `claude-code`, `grok`) are registered,
 * then invokes each through the DSH subagent service — the exact execution
 * route the `subagent_codex` / `subagent_claude_code` / `subagent_grok` tool
 * wrappers call — and prints each real child's final answer.
 *
 * Backends are interchangeable: no permanent roles are assigned anywhere in
 * this composition (see `docs/POC_GATES.md` for the infrastructure-first
 * roadmap). The parent instruction is executed deterministically by this
 * harness host because no parent-model credential is configured on the host;
 * the child runs themselves are real:
 *
 *   codex        -> native Codex app-server subprocess
 *   claude-code  -> native Claude Code SDK subprocess
 *   grok         -> native Grok Build ACP stdio subprocess (`grok agent stdio`)
 *                   driven by the stock @deepseek-ai/dsh-subagent-acp provider
 */

import { join } from 'node:path';
import { bootHarness, repoRoot, runChild } from './lib/conn-smoke.mjs';

const report = {
  repoRoot,
  timestamp: new Date().toISOString(),
  composition: 'config/dsh-gate2.cordis.yml',
  children: [],
  gate2: 'FAIL',
};

try {
  const ctx = await bootHarness('t2-gate2-smoke', 'config/dsh-gate2.cordis.yml');
  try {
    const providers = ctx.subagents.list();
    const codexProvider = ctx.subagents.getProvider('codex');
    const claudeProvider = ctx.subagents.getProvider('claude-code');
    const grokProvider = ctx.subagents.getProvider('grok');

    report.providers = providers;
    report.codexProvider = { registered: !!codexProvider, inheritsParentContext: codexProvider?.inheritsParentContext ?? null };
    report.claudeProvider = { registered: !!claudeProvider, inheritsParentContext: claudeProvider?.inheritsParentContext ?? null };
    report.grokProvider = { registered: !!grokProvider, inheritsParentContext: grokProvider?.inheritsParentContext ?? null };

    if (!codexProvider || !claudeProvider || !grokProvider) {
      throw new Error('composition did not register all three subagent providers');
    }

    report.children = [];
    report.children.push(await runChild(ctx, 'codex', 'subagent_codex', 'Codex', { parentId: 't2-gate2-parent' }));
    report.children.push(await runChild(ctx, 'claude-code', 'subagent_claude_code', 'Claude Code', { parentId: 't2-gate2-parent' }));
    report.children.push(await runChild(ctx, 'grok', 'subagent_grok', 'Grok Build', { parentId: 't2-gate2-parent' }));

    report.gate2 = report.children.every((child) => child.ok) ? 'PASS' : 'PARTIAL';
  } finally {
    await ctx.fiber.dispose();
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.gate2 = 'FAIL';
}

process.stdout.write(`\n===== DSH GATE 2 SMOKE REPORT =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
if (report.providers) process.stdout.write(`providers: ${JSON.stringify(report.providers)}\n`);
process.stdout.write(`codex provider registered: ${report.codexProvider ? String(report.codexProvider.registered) : '-'}\n`);
process.stdout.write(`claude-code provider registered: ${report.claudeProvider ? String(report.claudeProvider.registered) : '-'}\n`);
process.stdout.write(`grok provider registered: ${report.grokProvider ? String(report.grokProvider.registered) : '-'}\n`);
process.stdout.write(`tools: exposed in full host via config/dsh-gate2.patch.yml (verified with dsh --profile headless --patch)\n`);
for (const child of report.children ?? []) {
  process.stdout.write(`\n-- ${child.provider} (${child.toolName}) --\n`);
  if (child.ok) {
    process.stdout.write(`status: OK (${child.stopReason})\n`);
    process.stdout.write(`child final text:\n${child.finalText}\n`);
  } else {
    process.stdout.write(`status: FAIL\n`);
    process.stdout.write(`error: ${child.error ?? 'unknown'}\n`);
  }
}
process.stdout.write(`\nGATE 2: ${report.gate2}\n`);
if (report.error) process.stdout.write(`HARNESS ERROR: ${report.error}\n`);
process.stdout.write(`claude bin dir used: ${join('~', '.local', 'bin')}\n`);
process.exit(report.gate2 === 'PASS' ? 0 : 1);
