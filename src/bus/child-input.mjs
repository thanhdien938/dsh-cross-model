/**
 * Agent Bus Core — canonical Level-1 child input serialization.
 *
 * The one deterministic way to turn TaskEnvelope data into the text payload
 * sent to a fresh one-shot child. Backend-neutral by construction: it never
 * branches on Codex/Claude/Grok and never invents backend-specific fields.
 *
 * This is the first building block for explicit Level-1 continuity: a future
 * workflow reconstructs context from canonical packets, never from fabricated
 * session state.
 *
 * Format:
 *
 *   TASK
 *   <task.body>
 *
 *   CONTEXT
 *   <deterministic serialized JSON context | explicit `<empty>` marker>
 *
 *   EXPECTED OUTPUT
 *   <task.expectedOutput | explicit `<unspecified>` marker>
 *
 * Serialization rules (documented contract):
 *  - `task.body` is emitted verbatim; meaning is preserved.
 *  - Non-empty context is emitted as JSON indented with two spaces and
 *    object keys sorted recursively, so equivalent objects serialize
 *    identically regardless of insertion order.
 *  - Empty/absent context emits the compact marker `<empty>` (no JSON noise).
 *  - `expectedOutput`, when present, is emitted verbatim; otherwise the
 *    compact marker `<unspecified>` is emitted.
 *  - Values that are not JSON-compatible (functions, symbols, bigint,
 *    undefined, non-finite numbers, non-plain objects such as Date/Map/class
 *    instances, circular references) fail with an explicit
 *    {@link InvalidEnvelopeError} instead of silently producing misleading
 *    text.
 *  - No environment variables, auth state, or hidden runtime metadata is ever
 *    read or emitted here.
 */

import { InvalidEnvelopeError } from './errors.mjs';

const JSON_INDENT = 2;
const EMPTY_CONTEXT_MARKER = '<empty>';
const UNSPECIFIED_OUTPUT_MARKER = '<unspecified>';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject anything that JSON cannot represent faithfully. Plain objects and
 * arrays are walked recursively (with cycle detection) so a single bad leaf
 * fails the whole packet.
 * @param {unknown} value
 * @param {string} path - breadcrumb for the error message.
 * @param {Set<object>} seen - containers on the current walk path.
 */
function assertSerializable(value, path, seen = new Set()) {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidEnvelopeError(`task.context${path} has a non-finite number; not JSON-serializable`);
    }
    return;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) {
      throw new InvalidEnvelopeError(`task.context${path} has a circular reference; not JSON-serializable`);
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) assertSerializable(value[i], `${path}[${i}]`, seen);
      } else {
        for (const key of Object.keys(value)) assertSerializable(value[key], `${path}.${key}`, seen);
      }
    } finally {
      seen.delete(value);
    }
    return;
  }
  const kind =
    t === 'function' ? 'function'
      : t === 'symbol' ? 'symbol'
        : t === 'bigint' ? 'bigint'
          : t === 'undefined' ? 'undefined'
            : 'non-plain object';
  throw new InvalidEnvelopeError(
    `task.context${path} contains a ${kind} value; only JSON-compatible values are allowed`,
  );
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively and the
 * result is indented with two spaces. Safe to call only after
 * {@link assertSerializable} has accepted the value.
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const sorted = {};
        for (const key of Object.keys(val).sort()) sorted[key] = val[key];
        return sorted;
      }
      return val;
    },
    JSON_INDENT,
  );
}

/**
 * Build the canonical child-input text for a TaskEnvelope.
 *
 * @param {object} task - a validated TaskEnvelope (`body`, `context`,
 *   `expectedOutput`). Missing `context`/`expectedOutput` are treated as
 *   empty/absent.
 * @returns {string} the serialized prompt sent to a one-shot child.
 * @throws {InvalidEnvelopeError} when the task shape or the context contains
 *   values that cannot be serialized faithfully.
 */
export function buildChildInput(task) {
  if (task === null || typeof task !== 'object') {
    throw new InvalidEnvelopeError('buildChildInput requires a TaskEnvelope object');
  }
  if (typeof task.body !== 'string') {
    throw new InvalidEnvelopeError('task.body must be a string');
  }
  const context = task.context === undefined || task.context === null ? {} : task.context;
  const expectedOutput = task.expectedOutput === undefined || task.expectedOutput === null ? null : task.expectedOutput;

  const contextText =
    context !== null && typeof context === 'object' && Object.keys(context).length > 0
      ? (assertSerializable(context, ''), stableJson(context))
      : EMPTY_CONTEXT_MARKER;

  const expectedText = expectedOutput === null ? UNSPECIFIED_OUTPUT_MARKER : expectedOutput;

  return ['TASK', task.body, '', 'CONTEXT', contextText, '', 'EXPECTED OUTPUT', expectedText].join('\n');
}
