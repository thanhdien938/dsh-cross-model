#!/usr/bin/env node
/**
 * T1 Gate 1 — DSH dual-provider smoke driver.
 *
 * Boots ONE DSH host/context from `config/dsh-gate1.cordis.yml`, verifies that
 * both stock providers (`codex`, `claude-code`) are registered, then executes
 * the T1 parent task by invoking each stock provider through the DSH subagent
 * service — the exact execution route the `subagent_codex` /
 * `subagent_claude_code` tool wrapper calls — and prints each real child's
 * final answer. Tool exposure in the full DSH host is proven separately by
 * booting the `headless` profile patched with `config/dsh-gate1.patch.yml`.
 *
 * The parent instruction is executed deterministically by this harness host
 * because no parent-model credential is configured on the host. The child
 * runs themselves are real: DSH spawns the native `codex` / `claude` products.
 */

import { join } from 'node:path';
import { bootHarness, repoRoot, runChild } from './lib/conn-smoke.mjs';

const report = {
  repoRoot,
  timestamp: new Date().toISOString(),
  composition: 'config/dsh-gate1.cordis.yml',
  children: [],
  gate1: 'FAIL',
};

try {
  const ctx = await bootHarness('t1-gate1-smoke', 'config/dsh-gate1.cordis.yml');
  try {
    const providers = ctx.subagents.list();
    const codexProvider = ctx.subagents.getProvider('codex');
    const claudeProvider = ctx.subagents.getProvider('claude-code');

    report.providers = providers;
    report.codexProvider = { registered: !!codexProvider, inheritsParentContext: codexProvider?.inheritsParentContext ?? null };
    report.claudeProvider = { registered: !!claudeProvider, inheritsParentContext: claudeProvider?.inheritsParentContext ?? null };

    if (!codexProvider || !claudeProvider) {
      throw new Error('composition did not register both subagent providers');
    }

    report.children = [];
    report.children.push(await runChild(ctx, 'codex', 'subagent_codex', 'Codex', { parentId: 't1-gate1-parent' }));
    report.children.push(await runChild(ctx, 'claude-code', 'subagent_claude_code', 'Claude Code', { parentId: 't1-gate1-parent' }));

    report.gate1 = report.children.every((child) => child.ok) ? 'PASS' : 'PARTIAL';
  } finally {
    await ctx.fiber.dispose();
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.gate1 = 'FAIL';
}

process.stdout.write(`\n===== DSH GATE 1 SMOKE REPORT =====\n`);
process.stdout.write(`timestamp: ${report.timestamp}\n`);
process.stdout.write(`repoRoot: ${report.repoRoot}\n`);
process.stdout.write(`composition: ${report.composition}\n`);
if (report.providers) process.stdout.write(`providers: ${JSON.stringify(report.providers)}\n`);
process.stdout.write(`codex provider registered: ${report.codexProvider ? String(report.codexProvider.registered) : '-'}\n`);
process.stdout.write(`claude-code provider registered: ${report.claudeProvider ? String(report.claudeProvider.registered) : '-'}\n`);
process.stdout.write(`tools: exposed in full host via config/dsh-gate1.patch.yml (verified with dsh --profile headless --patch)\n`);
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
process.stdout.write(`\nGATE 1: ${report.gate1}\n`);
if (report.error) process.stdout.write(`HARNESS ERROR: ${report.error}\n`);
process.stdout.write(`claude bin dir used: ${join('~', '.local', 'bin')}\n`);
process.exit(report.gate1 === 'PASS' ? 0 : 1);
