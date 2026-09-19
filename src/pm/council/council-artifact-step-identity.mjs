/**
 * P20.4R3 R13 — ONE pure, shared "expected Council artifact step identity"
 * helper. Before this, three call sites each kept their own hard-coded
 * step-kind -> ARTIFACT_STAGE / role map that could drift:
 *   - CouncilStepWorkflowRunner.#expectedArtifactStepIdentity()  (workflow row)
 *   - CouncilChairDriver.#artifactStepsSoFar()                   (PM-turn history)
 *   - runCouncilFinalArtifactGate()                              (final gate)
 *
 * This module owns the single deterministic mapping. The caller still resolves
 * `actorAlias` (registry vs deriveActorAlias fallback) and passes it in — the
 * alias-resolution policy is caller-specific, the identity shape is not.
 *
 * Pure: no filesystem, no clock, no model output.
 */

import { ARTIFACT_STAGE, ARTIFACT_ROLE } from '../../artifacts/artifact-paths.mjs';
import { COUNCIL_ARTIFACT_STEP_KINDS } from './council-artifact-step-outcome.mjs';
import { councilStageKey } from './council-artifact-stage-keys.mjs';
import { debateStageKey, DEBATE_STAGE_ROLE } from './debate-artifact-keys.mjs';

/** step_kind -> canonical Council ARTIFACT_STAGE. */
export const COUNCIL_ARTIFACT_STAGE_FOR_STEP_KIND = Object.freeze({
  [COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_PLAN]: ARTIFACT_STAGE.CHAIR_PLAN,
  [COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT]: ARTIFACT_STAGE.PARTICIPANT_REPORT,
  [COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE]: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE,
  [COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_SYNTHESIS]: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
});

export function councilArtifactStageForStepKind(stepKind) {
  return COUNCIL_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind] ?? null;
}

export function isParticipantArtifactStepKind(stepKind) {
  return stepKind === COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT
    || stepKind === COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE;
}

export function councilArtifactRoleForStepKind(stepKind) {
  const stage = COUNCIL_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind];
  if (!stage) return null;
  return stage === ARTIFACT_STAGE.CHAIR_PLAN || stage === ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS
    ? ARTIFACT_ROLE.CHAIR
    : ARTIFACT_ROLE.MEMBER;
}

// ---- P20.5 — round-scoped Debate step identity -------------------------

/** step_kind -> canonical Debate ARTIFACT_STAGE. */
export const DEBATE_ARTIFACT_STAGE_FOR_STEP_KIND = Object.freeze({
  [COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF]: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF,
  [COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE]: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE,
  [COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS]: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS,
});

export function debateArtifactStageForStepKind(stepKind) {
  return DEBATE_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind] ?? null;
}

export function isDebateResponseStepKind(stepKind) {
  return stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE;
}

/**
 * The deterministic app-owned expected step identity for one round-scoped
 * Debate artifact step. `round` is REQUIRED (integer 1..99). Returns `null`
 * for an unrecognised step_kind / bad round / missing profileId/actorAlias.
 *
 * @returns {{ stepKind, artifactStage, stageKey, round, profileId, actorAlias, role }|null}
 */
export function expectedDebateArtifactStepIdentity({ stepKind, round, profileId, actorAlias } = {}) {
  const artifactStage = DEBATE_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind];
  if (!artifactStage) return null;
  if (!Number.isInteger(round) || round < 1 || round > 99) return null;
  if (typeof profileId !== 'string' || !profileId) return null;
  if (typeof actorAlias !== 'string' || !actorAlias) return null;
  const isResponse = isDebateResponseStepKind(stepKind);
  let stageKey;
  try {
    stageKey = debateStageKey({ artifactStage, round, actorAlias: isResponse ? actorAlias : null });
  } catch {
    return null;
  }
  return {
    stepKind, artifactStage, stageKey, round, profileId, actorAlias,
    role: DEBATE_STAGE_ROLE[artifactStage],
  };
}

/**
 * Unified expected-identity resolver for Council OR Debate step kinds. A
 * Debate step kind requires `round`; a Council step kind ignores it.
 */
export function expectedArtifactStepIdentity({ stepKind, round = null, profileId, actorAlias } = {}) {
  if (DEBATE_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind]) {
    return expectedDebateArtifactStepIdentity({ stepKind, round, profileId, actorAlias });
  }
  return expectedCouncilArtifactStepIdentity({ stepKind, profileId, actorAlias });
}

/**
 * The deterministic app-owned expected step identity for one Council artifact
 * step. Returns `null` for an unrecognised step_kind or a missing
 * profileId/actorAlias — the caller decides whether that is a typed
 * fail-closed condition.
 *
 * @param {object} input
 * @param {string} input.stepKind    one of COUNCIL_ARTIFACT_STEP_KINDS
 * @param {string} input.profileId
 * @param {string} input.actorAlias  the caller-resolved registered/stable alias
 * @returns {{ stepKind, artifactStage, stageKey, profileId, actorAlias, role }|null}
 */
export function expectedCouncilArtifactStepIdentity({ stepKind, profileId, actorAlias } = {}) {
  const artifactStage = COUNCIL_ARTIFACT_STAGE_FOR_STEP_KIND[stepKind];
  if (!artifactStage) return null;
  if (typeof profileId !== 'string' || !profileId) return null;
  if (typeof actorAlias !== 'string' || !actorAlias) return null;
  const isParticipant = isParticipantArtifactStepKind(stepKind);
  const stageKey = councilStageKey({ artifactStage, actorAlias: isParticipant ? actorAlias : null });
  const role = artifactStage === ARTIFACT_STAGE.CHAIR_PLAN || artifactStage === ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS
    ? ARTIFACT_ROLE.CHAIR
    : ARTIFACT_ROLE.MEMBER;
  return { stepKind, artifactStage, stageKey, profileId, actorAlias, role };
}
