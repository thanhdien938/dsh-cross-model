/**
 * Shared DSH connectivity smoke harness plumbing.
 *
 * Small generalization of the T1 gate1 driver used by both the two-agent
 * (`dsh-gate1-smoke.mjs`) and three-agent (`dsh-gate2-smoke.mjs`) connectivity
 * smokes. This is harness glue only: boot one DSH host/context, run each child
 * through the DSH subagent service (`ctx.subagents.start`), collect the real
 * child's final text, and normalize the outcome. No role logic, no agent
 * abstraction, no backend semantics live here.
 */

import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..', '..');

export function childPrompt(product, toolName) {
  return [
    `You are being invoked through the DSH tool ${toolName} as part of a cross-model connectivity smoke test.`,
    `Return exactly a short identification message stating that ${product} received the task in the current repository.`,
    'Do not modify any files.',
  ].join('\n');
}

export async function bootHarness(hostName, configRelative) {
  const configPath = resolveConfigPath(resolve(repoRoot, configRelative), undefined);
  if (!isAbsolute(configPath)) throw new Error(`config path not absolute: ${configPath}`);
  const claudeBinDir = join(homedir(), '.local', 'bin');
  if (!(process.env.PATH ?? '').split(delimiter).includes(claudeBinDir)) {
    process.env.PATH = `${claudeBinDir}${delimiter}${process.env.PATH ?? ''}`;
  }
  return boot(hostName, configPath, undefined, () => {});
}

export async function runChild(ctx, provider, toolName, product, { parentId = 'connectivity-parent' } = {}) {
  const parent = { id: parentId, session: { header: { cwd: repoRoot } } };
  const signal = new AbortController().signal;
  const result = { provider, toolName, product, ok: false, finalText: null, stopReason: null, error: null };
  let run;
  try {
    run = await ctx.subagents.start(provider, {
      prompt: [{ type: 'text', text: childPrompt(product, toolName) }],
      parent,
      signal,
    });
    const outcome = await run.result;
    const text = (outcome.output ?? [])
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    result.finalText = text || null;
    result.stopReason = outcome.stopReason ?? null;
    result.ok = outcome.stopReason === 'completed' && !!text;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (run) {
      try {
        await run.dispose();
      } catch (error) {
        result.error = `${result.error ?? ''} [dispose: ${error instanceof Error ? error.message : String(error)}]`.trim();
      }
    }
  }
  return result;
}
