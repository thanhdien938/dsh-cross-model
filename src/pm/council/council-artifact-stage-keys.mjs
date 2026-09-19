/**
 * P20.4 §13 — deterministic Council artifact-stage KEYS for
 * `task-manifest.json.stages`.
 *
 * Authority: docs/P20/P20_4_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §12/§13,
 * docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §6/§15.
 *
 * A Council has multiple successful Member reports / critiques, so the
 * single-value `stages.single` key is not enough. This module owns the ONE
 * deterministic stage-key form used everywhere (commit, recovery, final
 * gate). The manifest stage-key is an ORCHESTRATION INDEX only — the
 * canonical P20 artifact `stage` enum and full profile identity live in
 * invocation.json / attempt artifact.json and are NOT overloaded per
 * participant.
 *
 * Frozen semantic form:
 *   chair-plan
 *   participant-report::<actor-alias>
 *   participant-critique::<actor-alias>
 *   chair-council-synthesis
 *
 * Keys are generated only from an app-owned `ARTIFACT_STAGE` value plus a
 * registered `actor_alias` (never from model text), are unique within one
 * task, and do not depend on participant enumeration order.
 *
 * Pure: no filesystem, no clock, no model output.
 */

import { ARTIFACT_STAGE, assertActorAlias } from '../../artifacts/artifact-paths.mjs';

export class CouncilStageKeyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CouncilStageKeyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const SEP = '::';

// The Council artifact stages P20.4 migrates. Debate stages are intentionally
// NOT here — Debate migration is P20.5 (task §7/§40).
const PER_ALIAS_STAGES = Object.freeze(new Set([
  ARTIFACT_STAGE.PARTICIPANT_REPORT,
  ARTIFACT_STAGE.PARTICIPANT_CRITIQUE,
]));
const SINGLETON_STAGES = Object.freeze(new Set([
  ARTIFACT_STAGE.CHAIR_PLAN,
  ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
]));

export const COUNCIL_ARTIFACT_STAGES = Object.freeze([
  ARTIFACT_STAGE.CHAIR_PLAN,
  ARTIFACT_STAGE.PARTICIPANT_REPORT,
  ARTIFACT_STAGE.PARTICIPANT_CRITIQUE,
  ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
]);

/**
 * Deterministic manifest stage key for a Council artifact stage.
 *
 * @param {object} input
 * @param {string} input.artifactStage  one of ARTIFACT_STAGE (Council subset)
 * @param {string} [input.actorAlias]   registered actor alias — REQUIRED for
 *   participant-report / participant-critique, forbidden for the chair stages
 * @returns {string}
 */
export function councilStageKey({ artifactStage, actorAlias = null } = {}) {
  if (SINGLETON_STAGES.has(artifactStage)) {
    if (actorAlias !== null && actorAlias !== undefined) {
      throw new CouncilStageKeyError(`stage ${JSON.stringify(artifactStage)} is a Council singleton and must not carry an actor alias`, 'COUNCIL_STAGE_KEY_UNEXPECTED_ALIAS', { artifactStage });
    }
    return artifactStage; // "chair-plan" / "chair-council-synthesis"
  }
  if (PER_ALIAS_STAGES.has(artifactStage)) {
    if (typeof actorAlias !== 'string' || !actorAlias) {
      throw new CouncilStageKeyError(`stage ${JSON.stringify(artifactStage)} requires a registered actor alias`, 'COUNCIL_STAGE_KEY_ALIAS_REQUIRED', { artifactStage });
    }
    assertActorAlias(actorAlias, 'stage-key actor alias');
    return `${artifactStage}${SEP}${actorAlias}`;
  }
  throw new CouncilStageKeyError(`unsupported Council artifact stage for a stage key: ${JSON.stringify(artifactStage)}`, 'COUNCIL_STAGE_KEY_STAGE_UNSUPPORTED', { artifactStage });
}

/** Parse a Council stage key back to `{ artifactStage, actorAlias|null }`, or null. */
export function parseCouncilStageKey(key) {
  if (typeof key !== 'string' || !key) return null;
  if (SINGLETON_STAGES.has(key)) return { artifactStage: key, actorAlias: null };
  const idx = key.indexOf(SEP);
  if (idx < 0) return null;
  const artifactStage = key.slice(0, idx);
  const actorAlias = key.slice(idx + SEP.length);
  if (!PER_ALIAS_STAGES.has(artifactStage) || !actorAlias) return null;
  return { artifactStage, actorAlias };
}

/** The frozen final Council stage key (§29 — `final_ref` corresponds to this). */
export function councilFinalStageKey() {
  return councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS });
}

/**
 * Deterministic, enumeration-order-independent full stage-key plan for a
 * normalized Council spec + resolved alias registry. Used by the final gate
 * and recovery to know exactly which keys a run of this shape must produce
 * (report/critique keys for participants; critique keys only when rounds>=2).
 *
 * @param {object} input
 * @param {number} input.rounds
 * @param {string[]} input.participantAliases  participant aliases in owner order
 * @returns {{ chairPlan: string, reports: string[], critiques: string[], synthesis: string }}
 */
export function councilStageKeyPlan({ rounds, participantAliases }) {
  if (!Array.isArray(participantAliases) || participantAliases.length === 0) {
    throw new CouncilStageKeyError('participantAliases must be a non-empty array', 'COUNCIL_STAGE_KEY_NO_PARTICIPANTS');
  }
  const seen = new Set();
  for (const a of participantAliases) {
    assertActorAlias(a, 'participant alias');
    if (seen.has(a)) throw new CouncilStageKeyError(`duplicate participant alias in stage-key plan: ${a}`, 'COUNCIL_STAGE_KEY_DUP_ALIAS', { alias: a });
    seen.add(a);
  }
  const reports = participantAliases.map((actorAlias) => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias }));
  const critiques = Number.isInteger(rounds) && rounds >= 2
    ? participantAliases.map((actorAlias) => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, actorAlias }))
    : [];
  return Object.freeze({
    chairPlan: councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_PLAN }),
    reports: Object.freeze(reports),
    critiques: Object.freeze(critiques),
    synthesis: councilFinalStageKey(),
  });
}
