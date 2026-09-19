/**
 * Shared strict smoke-gate classification contract (T4-R1).
 *
 * A gate is a boolean over declared targets, not a beauty contest:
 *
 *   PASS    = every declared/required target proved the intended invariant
 *   PARTIAL = at least one but not all declared targets proved it
 *   FAIL    = none proved it, or the harness itself could not execute meaningfully
 *
 * `classifySmoke` is deliberately stateless and deterministic so any smoke can
 * be audited from a `{ proved, required, harnessFailed }` triple. Reason
 * categories use a small fixed vocabulary so diagnostics are comparable across
 * runs instead of free-form prose.
 *
 * Exit semantics for automation:
 *   PASS    -> 0
 *   PARTIAL -> 2 (distinct non-zero)
 *   FAIL    -> 1 (distinct non-zero)
 */

export const SMOKE_STATUS = Object.freeze({
  PASS: 'PASS',
  PARTIAL: 'PARTIAL',
  FAIL: 'FAIL',
});

export const SMOKE_EXIT_CODE = Object.freeze({
  PASS: 0,
  PARTIAL: 2,
  FAIL: 1,
});

export const SMOKE_REASON = Object.freeze({
  PROVED: 'PROVED',
  EMPTY_SOURCE_OUTPUT: 'EMPTY_SOURCE_OUTPUT',
  SOURCE_AGENT_FAILED: 'SOURCE_AGENT_FAILED',
  HANDOFF_BUILD_FAILED: 'HANDOFF_BUILD_FAILED',
  TARGET_AGENT_FAILED: 'TARGET_AGENT_FAILED',
  TRANSFER_NOT_OBSERVED: 'TRANSFER_NOT_OBSERVED',
  HARNESS_ERROR: 'HARNESS_ERROR',
  AUTH_OR_PROVIDER_ERROR: 'AUTH_OR_PROVIDER_ERROR',
  TIMEOUT_OR_ABORT: 'TIMEOUT_OR_ABORT',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  AGENT_FAILED: 'AGENT_FAILED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Classify a smoke from proven/required counts.
 *
 * @param {object} input
 * @param {number} input.proved - targets that proved the invariant.
 * @param {number} input.required - declared targets that must prove it.
 * @param {boolean} [input.harnessFailed] - harness-level fatal failure.
 * @returns {string} one of `SMOKE_STATUS`.
 */
export function classifySmoke({ proved, required, harnessFailed = false }) {
  if (harnessFailed) return SMOKE_STATUS.FAIL;
  if (!Number.isInteger(required) || required <= 0) return SMOKE_STATUS.FAIL;
  if (proved === required) return SMOKE_STATUS.PASS;
  if (proved > 0) return SMOKE_STATUS.PARTIAL;
  return SMOKE_STATUS.FAIL;
}

/**
 * Map a smoke status to a process exit code.
 * @param {string} status - `SMOKE_STATUS` value.
 * @returns {number}
 */
export function exitCodeFor(status) {
  if (status === SMOKE_STATUS.PARTIAL) return SMOKE_EXIT_CODE.PARTIAL;
  if (status === SMOKE_STATUS.PASS) return SMOKE_EXIT_CODE.PASS;
  return SMOKE_EXIT_CODE.FAIL;
}

/**
 * Classify one Gate 3-R1 backend row (context sentinel echo).
 * A target is proved only when the child completed and echoed the sentinel.
 *
 * @param {object} row
 * @param {string} row.status - child/run status.
 * @param {boolean} row.outputEmpty - whether the child returned empty output.
 * @param {boolean} row.sentinelObserved - whether the sentinel was echoed.
 * @param {boolean} [row.agentFailed] - dispatch/adapter raised a provider error.
 * @returns {string} `SMOKE_REASON`.
 */
export function classifyContextRow({ status, outputEmpty, sentinelObserved, agentFailed = false }) {
  if (agentFailed) return SMOKE_REASON.AGENT_FAILED;
  if (status !== 'completed') return SMOKE_REASON.AGENT_FAILED;
  if (sentinelObserved) return SMOKE_REASON.PROVED;
  if (outputEmpty) return SMOKE_REASON.EMPTY_OUTPUT;
  return SMOKE_REASON.TRANSFER_NOT_OBSERVED;
}

/**
 * Classify one Gate 4 route (automatic handoff transfer).
 *
 * A route is proved only when the source completed and produced the transfer
 * token/material, the workflow handoff construction succeeded, the target
 * completed, and the target's output contains the exact transferred material.
 *
 * @param {object} row
 * @param {string} row.sourceStatus - hop A run status.
 * @param {boolean} row.sourceOutputEmpty - hop A output empty/absent.
 * @param {boolean} row.tokenObserved - source token (or material) present after A.
 * @param {string} row.targetStatus - hop B run status.
 * @param {boolean} row.transferObserved - hop B output contains the exact token.
 * @param {boolean} [row.handoffBuildFailed] - handoff/context construction threw.
 * @returns {string} `SMOKE_REASON`.
 */
export function classifyTransferRoute({
  sourceStatus,
  sourceOutputEmpty,
  tokenObserved,
  targetStatus,
  transferObserved,
  handoffBuildFailed = false,
}) {
  if (handoffBuildFailed) return SMOKE_REASON.HANDOFF_BUILD_FAILED;
  if (sourceStatus !== 'completed') return SMOKE_REASON.SOURCE_AGENT_FAILED;
  if (sourceOutputEmpty) return SMOKE_REASON.EMPTY_SOURCE_OUTPUT;
  if (!tokenObserved) return SMOKE_REASON.SOURCE_AGENT_FAILED;
  if (targetStatus !== 'completed') return SMOKE_REASON.TARGET_AGENT_FAILED;
  if (transferObserved) return SMOKE_REASON.PROVED;
  return SMOKE_REASON.TRANSFER_NOT_OBSERVED;
}