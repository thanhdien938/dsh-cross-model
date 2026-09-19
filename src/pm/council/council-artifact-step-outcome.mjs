/**
 * P20.4 §14 — the versioned `artifact_v1` Council step-outcome contract.
 *
 * Authority: docs/P20/P20_4_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §14/§28/§38,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md.
 *
 * A Council workflow step outcome for the artifact path carries ONLY
 * app-owned operational facts:
 *   - transport_version: "artifact_v1"
 *   - ok
 *   - step_kind / artifact_stage / stage_key
 *   - profile_id / actor_alias
 *   - execution_state (bounded)
 *   - sealed_ref (a fully-valid sealed ArtifactReference on success; null on
 *     failure — never a fabricated ref)
 *   - repair facts, if any (bounded operational)
 *   - failure_code + bounded safe reason, on failure
 *
 * It MUST NOT carry extracted model fields (analysis / recommendation /
 * risks / participant_instructions / critique_focus / synthesis_focus /
 * report summary / selected answer / …). `validateForbiddenSemanticKeys`
 * from the P20 schema is applied to the whole object.
 *
 * Pure: no filesystem, no clock, no model output.
 */

import { validateArtifactReference, findForbiddenSemanticKeys } from '../../artifacts/artifact-schema.mjs';
import { COUNCIL_ARTIFACT_STAGES } from './council-artifact-stage-keys.mjs';
import { DEBATE_ARTIFACT_STAGES } from './debate-artifact-keys.mjs';
import { validateDebateContinuationControl } from '../../artifacts/debate-continuation-control.mjs';

export const COUNCIL_ARTIFACT_STEP_OUTCOME_VERSION = 'artifact_v1';

const ALL_ARTIFACT_STAGES = Object.freeze([...COUNCIL_ARTIFACT_STAGES, ...DEBATE_ARTIFACT_STAGES]);

export class CouncilArtifactStepOutcomeError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CouncilArtifactStepOutcomeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Bounded execution-state vocabulary — app-owned, never model semantics.
export const COUNCIL_STEP_EXECUTION_STATE = Object.freeze({
  SEALED: 'SEALED',                       // report produced + integrity-passed + sealed
  RECOVERED_FROM_SEAL: 'RECOVERED_FROM_SEAL', // reused a pre-existing sealed authority (no replay)
  EXECUTION_FAILED: 'EXECUTION_FAILED',   // provider/delivery/integrity failed
  SKIPPED: 'SKIPPED',                     // deterministically not run (policy)
  RECONCILED_NO_REPLAY: 'RECONCILED_NO_REPLAY', // ambiguous prior state; never replayed
});
const EXEC_STATES = new Set(Object.values(COUNCIL_STEP_EXECUTION_STATE));

export const COUNCIL_ARTIFACT_STEP_KINDS = Object.freeze({
  CHAIR_PLAN: 'chair_plan',
  PARTICIPANT_REPORT: 'participant_report',
  PARTICIPANT_CRITIQUE: 'participant_critique',
  CHAIR_SYNTHESIS: 'chair_synthesis',
  // P20.5 — round-scoped Debate artifact step kinds.
  DEBATE_BRIEF: 'debate_brief',
  DEBATE_RESPONSE: 'debate_response',
  DEBATE_SYNTHESIS: 'debate_synthesis',
});
const STEP_KINDS = new Set(Object.values(COUNCIL_ARTIFACT_STEP_KINDS));

/** The three round-scoped Debate step kinds — each REQUIRES an integer `round`. */
export const DEBATE_ARTIFACT_STEP_KINDS = Object.freeze(new Set([
  COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF,
  COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE,
  COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS,
]));

export function isDebateArtifactStepKind(stepKind) { return DEBATE_ARTIFACT_STEP_KINDS.has(stepKind); }

function normalizeStepRound(stepKind, round) {
  if (DEBATE_ARTIFACT_STEP_KINDS.has(stepKind)) {
    if (!Number.isInteger(round) || round < 1 || round > 99) {
      throw new CouncilArtifactStepOutcomeError(`Debate step_kind ${JSON.stringify(stepKind)} requires an integer round 1..99, got ${JSON.stringify(round)}`, 'COUNCIL_STEP_OUTCOME_BAD_ROUND');
    }
    return round;
  }
  if (round !== null && round !== undefined) {
    throw new CouncilArtifactStepOutcomeError(`non-Debate step_kind ${JSON.stringify(stepKind)} must not carry a round`, 'COUNCIL_STEP_OUTCOME_BAD_ROUND');
  }
  return null;
}

const REASON_MAX = 240;

/** Bound + sanitize an operational failure reason (§38 — no secrets/reasoning/raw stderr). */
export function sanitizeStepReason(value) {
  if (value === null || value === undefined) return null;
  let s = typeof value === 'string' ? value : (value?.code ?? value?.message ?? String(value));
  s = String(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (s.length > REASON_MAX) s = `${s.slice(0, REASON_MAX)}…`;
  return s || null;
}

/**
 * Build a SUCCESSFUL artifact_v1 Council step outcome.
 *
 * @param {object} input
 * @param {string} input.stepKind
 * @param {string} input.artifactStage
 * @param {string} input.stageKey
 * @param {string} input.profileId
 * @param {string} input.actorAlias
 * @param {object} input.sealedRef  a sealed ArtifactReference (validated requireSealed)
 * @param {'SEALED'|'RECOVERED_FROM_SEAL'} [input.executionState]
 * @param {{ repaired: boolean, repairKind: string|null }} [input.repair]
 */
export function buildArtifactStepSuccess({ stepKind, artifactStage, stageKey, round = null, profileId, actorAlias, sealedRef, executionState = COUNCIL_STEP_EXECUTION_STATE.SEALED, repair = null }) {
  if (!STEP_KINDS.has(stepKind)) throw new CouncilArtifactStepOutcomeError(`unknown step_kind ${JSON.stringify(stepKind)}`, 'COUNCIL_STEP_OUTCOME_BAD_KIND');
  if (!ALL_ARTIFACT_STAGES.includes(artifactStage)) throw new CouncilArtifactStepOutcomeError(`unknown artifact_stage ${JSON.stringify(artifactStage)}`, 'COUNCIL_STEP_OUTCOME_BAD_STAGE');
  if (typeof stageKey !== 'string' || !stageKey) throw new CouncilArtifactStepOutcomeError('stage_key is required', 'COUNCIL_STEP_OUTCOME_BAD_STAGE_KEY');
  if (typeof profileId !== 'string' || !profileId) throw new CouncilArtifactStepOutcomeError('profile_id is required', 'COUNCIL_STEP_OUTCOME_BAD_PROFILE');
  if (typeof actorAlias !== 'string' || !actorAlias) throw new CouncilArtifactStepOutcomeError('actor_alias is required', 'COUNCIL_STEP_OUTCOME_BAD_ALIAS');
  const normRound = normalizeStepRound(stepKind, round);
  if (executionState !== COUNCIL_STEP_EXECUTION_STATE.SEALED && executionState !== COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL) {
    throw new CouncilArtifactStepOutcomeError(`a successful outcome must be SEALED or RECOVERED_FROM_SEAL, got ${JSON.stringify(executionState)}`, 'COUNCIL_STEP_OUTCOME_BAD_STATE');
  }
  const rv = validateArtifactReference(sealedRef, { requireSealed: true });
  if (!rv.ok) throw new CouncilArtifactStepOutcomeError(`a successful outcome requires a valid sealed ArtifactReference: ${rv.errors.join('; ')}`, 'COUNCIL_STEP_OUTCOME_BAD_REF', { errors: rv.errors });

  const outcome = {
    transport_version: COUNCIL_ARTIFACT_STEP_OUTCOME_VERSION,
    ok: true,
    step_kind: stepKind,
    artifact_stage: artifactStage,
    stage_key: stageKey,
    round: normRound,
    profile_id: profileId,
    actor_alias: actorAlias,
    execution_state: executionState,
    sealed_ref: sealedRef,
    repair: repair
      ? { repaired: repair.repaired === true, repair_kind: repair.repaired === true ? (repair.repairKind ?? null) : null }
      : { repaired: false, repair_kind: null },
    failure_code: null,
    reason: null,
  };
  assertNoSemanticLeak(outcome);
  return Object.freeze(outcome);
}

/**
 * Build a FAILED / SKIPPED artifact_v1 Council step outcome. `sealed_ref` is
 * always null — a failed step never fabricates a reference.
 */
export function buildArtifactStepFailure({ stepKind, artifactStage = null, stageKey = null, round = null, profileId, actorAlias, failureCode, reason = null, executionState = COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED }) {
  if (!STEP_KINDS.has(stepKind)) throw new CouncilArtifactStepOutcomeError(`unknown step_kind ${JSON.stringify(stepKind)}`, 'COUNCIL_STEP_OUTCOME_BAD_KIND');
  if (typeof profileId !== 'string' || !profileId) throw new CouncilArtifactStepOutcomeError('profile_id is required', 'COUNCIL_STEP_OUTCOME_BAD_PROFILE');
  if (typeof actorAlias !== 'string' || !actorAlias) throw new CouncilArtifactStepOutcomeError('actor_alias is required', 'COUNCIL_STEP_OUTCOME_BAD_ALIAS');
  const normRound = normalizeStepRound(stepKind, round);
  if (!EXEC_STATES.has(executionState) || executionState === COUNCIL_STEP_EXECUTION_STATE.SEALED || executionState === COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL) {
    throw new CouncilArtifactStepOutcomeError(`a failed/skipped outcome must be EXECUTION_FAILED / SKIPPED / RECONCILED_NO_REPLAY, got ${JSON.stringify(executionState)}`, 'COUNCIL_STEP_OUTCOME_BAD_STATE');
  }
  if (typeof failureCode !== 'string' || !failureCode) throw new CouncilArtifactStepOutcomeError('failure_code is required for a failed step', 'COUNCIL_STEP_OUTCOME_NO_FAILURE_CODE');

  const outcome = {
    transport_version: COUNCIL_ARTIFACT_STEP_OUTCOME_VERSION,
    ok: false,
    step_kind: stepKind,
    artifact_stage: artifactStage,
    stage_key: stageKey,
    round: normRound,
    profile_id: profileId,
    actor_alias: actorAlias,
    execution_state: executionState,
    sealed_ref: null,
    repair: { repaired: false, repair_kind: null },
    failure_code: failureCode,
    reason: sanitizeStepReason(reason),
  };
  assertNoSemanticLeak(outcome);
  return Object.freeze(outcome);
}

/** Throw if a forbidden model-semantic key appears anywhere in the outcome. */
export function assertNoSemanticLeak(outcome) {
  const hits = findForbiddenSemanticKeys(outcome);
  if (hits.length) {
    throw new CouncilArtifactStepOutcomeError(`Council step outcome contains forbidden model-semantic keys: ${hits.join(', ')}`, 'COUNCIL_STEP_OUTCOME_SEMANTIC_LEAK', { hits });
  }
  return outcome;
}

/** Validate an artifact_v1 Council step outcome shape. Returns `{ ok, errors }`. */
export function validateArtifactStepOutcome(outcome) {
  const errors = [];
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return { ok: false, errors: ['outcome must be an object'] };
  }
  if (outcome.transport_version !== COUNCIL_ARTIFACT_STEP_OUTCOME_VERSION) errors.push(`transport_version must be ${JSON.stringify(COUNCIL_ARTIFACT_STEP_OUTCOME_VERSION)}`);
  if (typeof outcome.ok !== 'boolean') errors.push('ok must be a boolean');
  if (!STEP_KINDS.has(outcome.step_kind)) errors.push('step_kind is not a recognised artifact Council/Debate step kind');
  if (!EXEC_STATES.has(outcome.execution_state)) errors.push('execution_state is not recognised');
  if (typeof outcome.profile_id !== 'string' || !outcome.profile_id) errors.push('profile_id required');
  if (typeof outcome.actor_alias !== 'string' || !outcome.actor_alias) errors.push('actor_alias required');
  // P20.5 — round is REQUIRED (int 1..99) for a Debate step kind, and MUST be
  // null/absent for a Council step kind.
  if (DEBATE_ARTIFACT_STEP_KINDS.has(outcome.step_kind)) {
    if (!Number.isInteger(outcome.round) || outcome.round < 1 || outcome.round > 99) errors.push('a Debate step outcome requires an integer round 1..99');
  } else if (outcome.round !== null && outcome.round !== undefined) {
    errors.push('a non-Debate step outcome must not carry a round');
  }
  if (outcome.ok === true) {
    if (outcome.execution_state !== COUNCIL_STEP_EXECUTION_STATE.SEALED && outcome.execution_state !== COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL) {
      errors.push('a successful outcome must be SEALED or RECOVERED_FROM_SEAL');
    }
    if (!ALL_ARTIFACT_STAGES.includes(outcome.artifact_stage)) errors.push('artifact_stage is not a recognised Council/Debate artifact stage');
    if (typeof outcome.stage_key !== 'string' || !outcome.stage_key) errors.push('stage_key required on success');
    const rv = validateArtifactReference(outcome.sealed_ref, { requireSealed: true });
    if (!rv.ok) errors.push(`sealed_ref must be a valid sealed ArtifactReference: ${rv.errors.join('; ')}`);
    if (outcome.failure_code !== null) errors.push('failure_code must be null on a successful outcome');
  } else {
    if (outcome.execution_state === COUNCIL_STEP_EXECUTION_STATE.SEALED || outcome.execution_state === COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL) {
      errors.push('a failed/skipped outcome must not be SEALED/RECOVERED_FROM_SEAL');
    }
    if (outcome.sealed_ref !== null) errors.push('a failed/skipped outcome must not carry a sealed_ref (no fabricated ref)');
    if (typeof outcome.failure_code !== 'string' || !outcome.failure_code) errors.push('failure_code required on a failed/skipped outcome');
  }
  // P20.5R R1 — the TYPED_CONTROL PLACEMENT CONTRACT. A durable artifact
  // handoff may carry `typed_control` ONLY when `ok === true` AND
  // `step_kind === debate_synthesis`. debate_brief, debate_response, every
  // Council step, and every failed/skipped debate_synthesis MUST fail closed
  // if `typed_control` is present.
  const hasTypedControl = outcome.typed_control !== undefined && outcome.typed_control !== null;
  const isDebateSynthesis = outcome.step_kind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS;
  if (hasTypedControl) {
    if (!(outcome.ok === true && isDebateSynthesis)) {
      errors.push('typed_control is only permitted on a successful debate_synthesis outcome');
    } else {
      const tv = validateDebateContinuationControl(outcome.typed_control);
      if (!tv.ok) errors.push(...tv.errors.map((e) => `typed_control: ${e}`));
    }
  }
  const hits = findForbiddenSemanticKeys(outcome);
  if (hits.length) errors.push(`forbidden semantic keys: ${hits.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

// ---- P20.4R2 R9 — full durable-handoff structural binding ----------------

const PARTICIPANT_STEP_KINDS = new Set([
  COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT,
  COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE,
  COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE,
]);

/**
 * P20.4R2 R9 — validate one durable `artifact_v1` Council handoff against an
 * app-owned EXPECTED step identity, and (for a successful handoff) against
 * the RESOLVED sealed invocation record / attempt metadata + the required
 * manifest stage `sealed_ref`. Semantic-content-free: it never reads a report
 * body and rejects any forbidden model-semantic key.
 *
 * The caller (durable workflow reconstruction / Council final gate) supplies:
 *   - `expected` — the deterministic step identity derived from durable row
 *     context/recipient or from persisted `council_control` + owner order +
 *     registered alias + canonical `ARTIFACT_STAGE`/role/stage-key.
 *   - `sealedInvocationRecord` / `sealedAttemptMetadata` — from a prior
 *     `resolveAndVerifySealedReference(handoff.sealed_ref)` (success only).
 *   - `expectedStageSealedRef` — the manifest stage entry's `sealed_ref`
 *     when a stage entry is required for this step (success only).
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCouncilArtifactStepBinding({
  handoff,
  expected,
  sealedInvocationRecord = null,
  sealedAttemptMetadata = null,
  expectedStageSealedRef = null,
} = {}) {
  const errors = [];
  if (handoff === null || typeof handoff !== 'object') return { ok: false, errors: ['handoff must be an object'] };
  if (!expected || typeof expected !== 'object') return { ok: false, errors: ['expected step identity is required'] };

  // 1. shape
  const sv = validateArtifactStepOutcome(handoff);
  if (!sv.ok) { errors.push(...sv.errors.map((e) => `handoff shape: ${e}`)); }

  // 2. duplicated orchestration identity must agree with the expected step
  const stepKind = handoff.step_kind ?? handoff.stepKind;
  if (stepKind !== expected.stepKind) errors.push(`step_kind ${JSON.stringify(stepKind)} != expected ${JSON.stringify(expected.stepKind)}`);
  if (handoff.profile_id !== expected.profileId) errors.push(`profile_id ${JSON.stringify(handoff.profile_id)} != expected ${JSON.stringify(expected.profileId)}`);
  if (handoff.actor_alias !== expected.actorAlias) errors.push(`actor_alias ${JSON.stringify(handoff.actor_alias)} != expected ${JSON.stringify(expected.actorAlias)}`);
  // P20.5 — round-scoped identity. When `expected` carries a round (a Debate
  // step) the handoff's round MUST match; a Council step's expected.round is
  // null/undefined and the handoff round must also be null.
  const expectedRound = expected.round ?? null;
  const handoffRound = handoff.round ?? null;
  if (handoffRound !== expectedRound) errors.push(`round ${JSON.stringify(handoffRound)} != expected ${JSON.stringify(expectedRound)}`);

  const isParticipantStage = PARTICIPANT_STEP_KINDS.has(expected.stepKind);
  // the legacy-compat wrapper key must not be an independent source of truth
  if (handoff.participantProfileId !== undefined && handoff.participantProfileId !== null) {
    if (isParticipantStage && handoff.participantProfileId !== handoff.profile_id) {
      errors.push(`participantProfileId ${JSON.stringify(handoff.participantProfileId)} != profile_id ${JSON.stringify(handoff.profile_id)}`);
    }
  }

  if (handoff.ok === true) {
    if (handoff.artifact_stage !== expected.artifactStage) errors.push(`artifact_stage ${JSON.stringify(handoff.artifact_stage)} != expected ${JSON.stringify(expected.artifactStage)}`);
    if (handoff.stage_key !== expected.stageKey) errors.push(`stage_key ${JSON.stringify(handoff.stage_key)} != expected ${JSON.stringify(expected.stageKey)}`);
    if (handoff.execution_state !== COUNCIL_STEP_EXECUTION_STATE.SEALED && handoff.execution_state !== COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL) {
      errors.push(`a successful handoff must be SEALED / RECOVERED_FROM_SEAL, got ${JSON.stringify(handoff.execution_state)}`);
    }
    // 3. bind against the RESOLVED sealed invocation record / attempt metadata
    if (sealedInvocationRecord) {
      if (sealedInvocationRecord.profile_id !== expected.profileId) errors.push(`resolved invocation.profile_id ${JSON.stringify(sealedInvocationRecord.profile_id)} != expected ${JSON.stringify(expected.profileId)}`);
      if (sealedInvocationRecord.actor_alias !== expected.actorAlias) errors.push(`resolved invocation.actor_alias ${JSON.stringify(sealedInvocationRecord.actor_alias)} != expected ${JSON.stringify(expected.actorAlias)}`);
      if (sealedInvocationRecord.stage !== expected.artifactStage) errors.push(`resolved invocation.stage ${JSON.stringify(sealedInvocationRecord.stage)} != expected ${JSON.stringify(expected.artifactStage)}`);
      if (expected.role !== undefined && sealedInvocationRecord.role !== expected.role) errors.push(`resolved invocation.role ${JSON.stringify(sealedInvocationRecord.role)} != expected ${JSON.stringify(expected.role)}`);
      if ((sealedInvocationRecord.round ?? null) !== expectedRound) errors.push(`resolved invocation.round ${JSON.stringify(sealedInvocationRecord.round ?? null)} != expected ${JSON.stringify(expectedRound)}`);
    }
    if (sealedAttemptMetadata) {
      if (sealedAttemptMetadata.profile_id !== expected.profileId) errors.push(`resolved attempt.profile_id ${JSON.stringify(sealedAttemptMetadata.profile_id)} != expected ${JSON.stringify(expected.profileId)}`);
      if (sealedAttemptMetadata.actor_alias !== expected.actorAlias) errors.push(`resolved attempt.actor_alias ${JSON.stringify(sealedAttemptMetadata.actor_alias)} != expected ${JSON.stringify(expected.actorAlias)}`);
      if (sealedAttemptMetadata.stage !== expected.artifactStage) errors.push(`resolved attempt.stage ${JSON.stringify(sealedAttemptMetadata.stage)} != expected ${JSON.stringify(expected.artifactStage)}`);
      if ((sealedAttemptMetadata.round ?? null) !== expectedRound) errors.push(`resolved attempt.round ${JSON.stringify(sealedAttemptMetadata.round ?? null)} != expected ${JSON.stringify(expectedRound)}`);
    }
    // 4. handoff.sealed_ref must equal the required manifest stage entry
    if (expectedStageSealedRef !== null && expectedStageSealedRef !== undefined) {
      if (JSON.stringify(handoff.sealed_ref) !== JSON.stringify(expectedStageSealedRef)) {
        errors.push('handoff.sealed_ref does not equal the required manifest stage sealed_ref');
      }
    }
    // P20.5R R1 — a successful debate_synthesis handoff MUST carry typed_control
    // (placement + shape enforced by validateArtifactStepOutcome above; the
    // full same-execution binding is done by the caller with the resolved
    // invocation/attempt metadata).
    if (expected.stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS) {
      if (handoff.typed_control === undefined || handoff.typed_control === null) {
        errors.push('a successful debate_synthesis handoff must carry typed_control');
      }
    }
  } else {
    if (handoff.sealed_ref !== null) errors.push('a failed/skipped handoff must carry sealed_ref === null');
    if (typeof handoff.failure_code !== 'string' || !handoff.failure_code) errors.push('a failed/skipped handoff requires a failure_code');
    // R1 — a failed/skipped debate_synthesis MUST NOT carry typed_control.
    if (handoff.typed_control !== undefined && handoff.typed_control !== null) {
      errors.push('a failed/skipped handoff must not carry typed_control');
    }
    // identity fields still bind (stage_key / artifact_stage may be null for an
    // early failure, but when present they must agree)
    if (handoff.artifact_stage !== null && handoff.artifact_stage !== undefined && handoff.artifact_stage !== expected.artifactStage) {
      errors.push(`failed handoff artifact_stage ${JSON.stringify(handoff.artifact_stage)} != expected ${JSON.stringify(expected.artifactStage)}`);
    }
    if (handoff.stage_key !== null && handoff.stage_key !== undefined && handoff.stage_key !== expected.stageKey) {
      errors.push(`failed handoff stage_key ${JSON.stringify(handoff.stage_key)} != expected ${JSON.stringify(expected.stageKey)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Throw-style wrapper — `CouncilArtifactStepOutcomeError` code `COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH`. */
export function assertCouncilArtifactStepBinding(input) {
  const v = validateCouncilArtifactStepBinding(input);
  if (!v.ok) {
    throw new CouncilArtifactStepOutcomeError(
      `durable artifact Council handoff does not bind to its expected step identity: ${v.errors.join('; ')}`,
      'COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH',
      { errors: v.errors },
    );
  }
  return input.handoff;
}
