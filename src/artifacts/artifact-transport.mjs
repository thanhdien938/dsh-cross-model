/**
 * P20.1D — inactive rollout seam (P20.1R R1: fail closed).
 *
 * Authority:
 *   docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §24
 *   docs/planning/P20_IMPLEMENTATION_PLAN_POST_SURVEY_PM_FREEZE.md §11 (P20.1D)
 *
 * Every task carries a persisted `transport_version`. The freeze authorizes
 * exactly one silent default:
 *
 *   field ABSENT / null  => legacy
 *
 * It does NOT authorize mapping an unknown / future / typo'd / corrupted
 * present value to legacy. A persisted `artifact_v2`, `artifcat_v1`, or any
 * other unsupported contract MUST fail closed with a typed error — never
 * silently execute through legacy parsing (P20.1R R1).
 *
 *   missing / null        -> legacy
 *   "legacy"              -> legacy
 *   "artifact_v1"         -> artifact_v1
 *   any other present value -> throw ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED
 *
 * Nested persisted context (`task.context.transport_version`) follows the
 * same rule. In P20.1 no production caller ever produces `artifact_v1`, so
 * legacy execution still creates no P20 artifact directories.
 */

import { TRANSPORT_VERSION } from './artifact-paths.mjs';

export { TRANSPORT_VERSION };

const SUPPORTED = new Set([TRANSPORT_VERSION.LEGACY, TRANSPORT_VERSION.ARTIFACT_V1]);

export class ArtifactTransportError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactTransportError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A present transport_version value must be exactly one we support. */
function assertSupportedValue(value, where) {
  if (value === undefined || value === null) return;
  if (!SUPPORTED.has(value)) {
    throw new ArtifactTransportError(
      `unsupported persisted transport_version ${JSON.stringify(value)} at ${where}; refusing to fall back to legacy`,
      'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED',
      { value, where, supported: [...SUPPORTED] },
    );
  }
}

/**
 * Resolve the effective transport version for a task-shaped object.
 * Consults `task.transport_version` then `task.context.transport_version`.
 * A present-but-unsupported value at EITHER location fails closed (R1).
 *
 * @param {object|null|undefined} task
 * @returns {'legacy'|'artifact_v1'}
 */
export function resolveTransportVersion(task) {
  const top = task?.transport_version ?? null;
  const nested = task?.context?.transport_version ?? null;
  // Validate BOTH so an unsupported value can never hide behind a valid one.
  assertSupportedValue(top, 'task.transport_version');
  assertSupportedValue(nested, 'task.context.transport_version');
  // P20.2 §6.1: both present + both supported + DIFFERENT => the persisted
  // contract is ambiguous. Fail closed; never silently prefer top or nested.
  if (top !== null && nested !== null && top !== nested) {
    throw new ArtifactTransportError(
      `ambiguous persisted transport_version: task.transport_version=${JSON.stringify(top)} but task.context.transport_version=${JSON.stringify(nested)}`,
      'ARTIFACT_TRANSPORT_VERSION_CONFLICT',
      { top, nested },
    );
  }
  const effective = top ?? nested ?? null;
  return effective === TRANSPORT_VERSION.ARTIFACT_V1 ? TRANSPORT_VERSION.ARTIFACT_V1 : TRANSPORT_VERSION.LEGACY;
}

/** True only when the task is explicitly, validly stamped `artifact_v1`. */
export function isArtifactV1Task(task) {
  return resolveTransportVersion(task) === TRANSPORT_VERSION.ARTIFACT_V1;
}

/**
 * Stamp a task-shaped context object with an explicit transport version.
 * Used by future phases (P20.2+) at task admission; returns a new object,
 * never mutates the input. An unknown value is refused with the same typed
 * error as resolve — a caller can never think it enabled `artifact_v1`.
 *
 * @param {object} context
 * @param {'legacy'|'artifact_v1'} version
 */
export function stampTransportVersion(context, version) {
  if (!SUPPORTED.has(version)) {
    throw new ArtifactTransportError(
      `transport_version must be "legacy" or "artifact_v1", got: ${JSON.stringify(version)}`,
      'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED',
      { value: version, supported: [...SUPPORTED] },
    );
  }
  return { ...(context ?? {}), transport_version: version };
}
