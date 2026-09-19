/**
 * P20.4R R4 — build/compare the versioned app-owned Council control block
 * persisted on an artifact_v1 Council task manifest.
 *
 * Authority: docs/P20/P20_4R_SONNET_REMEDIATION_MASTER_PROMPT.md §8/§21.
 *
 * This is APPLICATION CONTROL derived from the normalized CouncilSpec
 * (council-contracts.mjs `normalizeCouncilSpec`), never report semantics and
 * never model text. The shape is deterministic (fixed key order, arrays kept
 * in owner order) so a `JSON.stringify` deep-equality holds across process
 * restarts — that is what `TaskWorkspace.bindCouncilControl()` relies on to
 * fail closed (`COUNCIL_ARTIFACT_CONTROL_MISMATCH`) when a `task_id` is
 * reopened under a changed roster/order/rounds/chair/etc.
 *
 * Pure: no filesystem, no clock, no model output.
 */

import {
  COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION,
  validateCouncilArtifactControl,
} from '../../artifacts/artifact-schema.mjs';

export { COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION, validateCouncilArtifactControl };

export class CouncilArtifactControlError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CouncilArtifactControlError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Deterministic control block from a normalized CouncilSpec.
 *
 * @param {object} council  a `normalizeCouncilSpec()` result
 * @returns {object} the frozen `council_control` block
 */
export function buildCouncilArtifactControl(council) {
  if (!council || council.kind !== 'COUNCIL') {
    throw new CouncilArtifactControlError('a normalized CouncilSpec is required', 'COUNCIL_ARTIFACT_CONTROL_BAD_SPEC');
  }
  return Object.freeze({
    schema_version: COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION,
    chair_profile_id: council.chair_profile_id,
    participant_profile_ids: [...council.participant_profile_ids], // ORDERED
    rounds: council.rounds,
    strategy: council.strategy,
    implementation_participant_id: council.implementation_participant_id ?? null,
    workspace_requirement: council.workspace_requirement ?? 'NONE',
    workspace_evidence_paths: Array.isArray(council.workspace_evidence_paths) ? [...council.workspace_evidence_paths] : null,
    debate: Object.freeze({
      enabled: council.debate?.enabled === true,
      max_rounds: council.debate?.max_rounds ?? 2,
    }),
  });
}

/**
 * Fail closed if the requested normalized Council control does not match the
 * one already durably bound to the task.
 */
export function assertCouncilControlMatch({ persisted, council }) {
  const requested = buildCouncilArtifactControl(council);
  const pv = validateCouncilArtifactControl(persisted);
  if (!pv.ok) {
    throw new CouncilArtifactControlError(`persisted council_control is not valid: ${pv.errors.join('; ')}`, 'COUNCIL_ARTIFACT_CONTROL_INVALID', { errors: pv.errors });
  }
  if (JSON.stringify(persisted) !== JSON.stringify(requested)) {
    throw new CouncilArtifactControlError(
      'requested Council control does not match the control durably bound to this artifact task',
      'COUNCIL_ARTIFACT_CONTROL_MISMATCH',
      { persisted, requested },
    );
  }
  return requested;
}
