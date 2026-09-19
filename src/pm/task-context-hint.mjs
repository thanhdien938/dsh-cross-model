/**
 * P12-R3 — the ONE bounded, static context-discovery hint (docs/p12/01_P12_R0_*
 * §9, plan doc §2.2/§6/§12). Pure string constant, zero I/O, zero
 * dependencies — deliberately kept separate from task-context-index.mjs
 * (which does real filesystem work) so appending this hint to a task body
 * (owner-task-controller.mjs) never pulls in fs access.
 *
 * This is the ENTIRE mechanism P12 uses to make durable context
 * discoverable: a fixed, two-sentence pointer, never a listing of files,
 * never injected content, never a "MUST read" instruction. The agent
 * decides what (if anything) to read.
 */
export const CONTEXT_HINT_TEXT = 'Durable project/task context may be available under docs/history/. Read only what is relevant to this task.';

export function buildContextHint() {
  return CONTEXT_HINT_TEXT;
}

// Appends the hint to a task body with a clear, visually distinct
// separator so it is never confused with the owner's own task text.
// Returns `body` completely unchanged when `includeHint` is false — every
// DIRECT task (and every pre-P12 caller) is byte-for-byte unaffected.
export function appendContextHint(body, includeHint) {
  if (!includeHint) return body;
  const text = typeof body === 'string' ? body : '';
  return `${text}\n\n---\n${CONTEXT_HINT_TEXT}`;
}
