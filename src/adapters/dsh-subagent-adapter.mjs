/**
 * Agent Bus Core — DSH subagent adapter.
 *
 * The thinnest adapter that maps a registered backend descriptor (provider /
 * product / cwd) onto the already-proven DSH subagent service
 * (`ctx.subagents.start(...)`) and normalizes the final output into the bus
 * result contract.
 *
 * This module is provider-agnostic: it takes the provider name from
 * configuration and never branches on Codex/Claude/Grok identity.
 *
 * One-shot semantics (Level 1): each `start` spawns a fresh child; `send`
 * returns {@link UNSUPPORTED} because there is no live session to continue —
 * never claim continuation that does not exist.
 */

import { UNSUPPORTED } from '../bus/errors.mjs';
import { buildChildInput } from '../bus/child-input.mjs';

/**
 * @param {object} config
 * @param {object} config.ctx - a DSH host context exposing `ctx.subagents`.
 * @param {string} config.provider - DSH subagent provider name (e.g. `codex`).
 * @param {string} config.product - display product name for prompts/metadata.
 * @param {string} config.cwd - workspace the child operates in.
 * @returns {object} an AgentAdapter-compatible object.
 */
export function createDshSubagentAdapter({ ctx, provider, product, cwd }) {
  const handles = new Map();

  return {
    /**
     * Dispatch a task to the real native child through DSH.
     * @returns {Promise<{ output: string, stopReason: string|null, artifacts: [] }>}
     */
    async start({ task, run, signal }) {
      const parent = { id: task.sender ?? 'pm', session: { header: { cwd } } };
      const handle = await ctx.subagents.start(provider, {
        prompt: [{ type: 'text', text: buildChildInput(task) }],
        parent,
        signal,
      });
      handles.set(run.id, handle);
      const outcome = await handle.result;
      const output = (outcome.output ?? [])
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      return { output, stopReason: outcome.stopReason ?? null, artifacts: [] };
    },

    /** One-shot backend: no live session continuation is ever fabricated. */
    async send() {
      return UNSUPPORTED;
    },

    /** Best-effort remote cancellation; the bus's signal is authoritative. */
    async cancel({ run }) {
      const handle = handles.get(run.id);
      if (handle && typeof handle.cancel === 'function') {
        try {
          handle.cancel();
        } catch {
          // best-effort
        }
      }
    },

    /** Idempotent disposal of the child process tree. */
    async dispose({ run }) {
      const handle = handles.get(run.id);
      handles.delete(run.id);
      if (handle) {
        try {
          await handle.dispose();
        } catch {
          // best-effort; the child may already be gone
        }
      }
    },
  };
}
