/**
 * P20.5 §10/§11 — the ONE app-owned deterministic helper for round-scoped
 * Debate artifact identities.
 *
 * Two frozen forms, generated ONLY from an app-owned `ARTIFACT_STAGE` value +
 * an app-owned integer `round` + (for a Member response) a registered
 * `actor_alias`. Never from model text, never from filesystem enumeration.
 *
 *   task-manifest stage key   debate::round-01::chair-brief
 *                             debate::round-01::response::<actor-alias>
 *                             debate::round-01::chair-synthesis
 *
 *   invocation identity       debate:<task-id>:round-01:debate-chair-brief
 *                             debate:<task-id>:round-01:debate-member-response:<actor-alias>
 *                             debate:<task-id>:round-01:debate-chair-synthesis
 *
 * A participant responding in round 1 and round 2 therefore has two distinct
 * logical invocation identities / stage keys / directories (§10, §42). The
 * SAME helper is used for commit, recovery, history binding and the final
 * Debate topology gate (§11).
 *
 * Pure: no filesystem, no clock, no model output.
 */

import { ARTIFACT_STAGE, ARTIFACT_ROLE, assertActorAlias, debateRoundDirName } from '../../artifacts/artifact-paths.mjs';

export class DebateArtifactKeyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'DebateArtifactKeyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const SEP = '::';

/** The three Debate artifact stages (round REQUIRED for every one). */
export const DEBATE_ARTIFACT_STAGES = Object.freeze([
  ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF,
  ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE,
  ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS,
]);

const PER_ALIAS_DEBATE_STAGES = Object.freeze(new Set([ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE]));

// stage -> the short token used inside the manifest stage key.
const STAGE_KEY_TOKEN = Object.freeze({
  [ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF]: 'chair-brief',
  [ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE]: 'response',
  [ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS]: 'chair-synthesis',
});
const TOKEN_TO_STAGE = Object.freeze(Object.fromEntries(Object.entries(STAGE_KEY_TOKEN).map(([k, v]) => [v, k])));

export const DEBATE_STAGE_ROLE = Object.freeze({
  [ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF]: ARTIFACT_ROLE.CHAIR,
  [ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE]: ARTIFACT_ROLE.MEMBER,
  [ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS]: ARTIFACT_ROLE.CHAIR,
});

function assertDebateRound(round) {
  if (!Number.isInteger(round) || round < 1 || round > 99) {
    throw new DebateArtifactKeyError(`debate round must be an integer 1..99, got ${JSON.stringify(round)}`, 'DEBATE_KEY_BAD_ROUND', { round });
  }
  return round;
}

/** `round-01` … `round-99` — the canonical round token (delegates to artifact-paths). */
export function debateRoundToken(round) {
  return debateRoundDirName(assertDebateRound(round));
}

/**
 * Deterministic task-manifest stage key for a Debate artifact stage.
 *
 * @param {object} input
 * @param {string} input.artifactStage  one of DEBATE_ARTIFACT_STAGES
 * @param {number} input.round          1..99 (REQUIRED)
 * @param {string} [input.actorAlias]   registered actor alias — REQUIRED for
 *   debate-member-response, forbidden for the chair stages
 * @returns {string}
 */
export function debateStageKey({ artifactStage, round, actorAlias = null } = {}) {
  if (!DEBATE_ARTIFACT_STAGES.includes(artifactStage)) {
    throw new DebateArtifactKeyError(`unsupported Debate artifact stage: ${JSON.stringify(artifactStage)}`, 'DEBATE_KEY_STAGE_UNSUPPORTED', { artifactStage });
  }
  const token = STAGE_KEY_TOKEN[artifactStage];
  const roundTok = debateRoundToken(round);
  if (PER_ALIAS_DEBATE_STAGES.has(artifactStage)) {
    if (typeof actorAlias !== 'string' || !actorAlias) {
      throw new DebateArtifactKeyError(`stage ${JSON.stringify(artifactStage)} requires a registered actor alias`, 'DEBATE_KEY_ALIAS_REQUIRED', { artifactStage });
    }
    assertActorAlias(actorAlias, 'debate stage-key actor alias');
    return `debate${SEP}${roundTok}${SEP}${token}${SEP}${actorAlias}`;
  }
  if (actorAlias !== null && actorAlias !== undefined) {
    throw new DebateArtifactKeyError(`stage ${JSON.stringify(artifactStage)} is a Debate chair stage and must not carry an actor alias`, 'DEBATE_KEY_UNEXPECTED_ALIAS', { artifactStage });
  }
  return `debate${SEP}${roundTok}${SEP}${token}`;
}

/** Parse a Debate stage key back to `{ artifactStage, round, actorAlias|null }`, or null. */
export function parseDebateStageKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const parts = key.split(SEP);
  if (parts.length < 3 || parts[0] !== 'debate') return null;
  const m = /^round-(\d{2})$/.exec(parts[1]);
  if (!m) return null;
  const round = Number(m[1]);
  if (!Number.isInteger(round) || round < 1 || round > 99) return null;
  const artifactStage = TOKEN_TO_STAGE[parts[2]];
  if (!artifactStage) return null;
  if (PER_ALIAS_DEBATE_STAGES.has(artifactStage)) {
    if (parts.length !== 4 || !parts[3]) return null;
    return { artifactStage, round, actorAlias: parts[3] };
  }
  if (parts.length !== 3) return null;
  return { artifactStage, round, actorAlias: null };
}

/**
 * Deterministic, model-text-free invocation identity for one Debate stage.
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {number} input.round
 * @param {string} input.artifactStage  one of DEBATE_ARTIFACT_STAGES
 * @param {string} [input.actorAlias]   REQUIRED for debate-member-response
 * @returns {string}
 */
export function debateStageInvocationId({ taskId, round, artifactStage, actorAlias = null } = {}) {
  if (typeof taskId !== 'string' || !taskId) {
    throw new DebateArtifactKeyError('taskId is required', 'DEBATE_KEY_NO_TASK');
  }
  if (!DEBATE_ARTIFACT_STAGES.includes(artifactStage)) {
    throw new DebateArtifactKeyError(`unsupported Debate artifact stage: ${JSON.stringify(artifactStage)}`, 'DEBATE_KEY_STAGE_UNSUPPORTED', { artifactStage });
  }
  const roundTok = debateRoundToken(round);
  if (PER_ALIAS_DEBATE_STAGES.has(artifactStage)) {
    if (typeof actorAlias !== 'string' || !actorAlias) {
      throw new DebateArtifactKeyError(`stage ${JSON.stringify(artifactStage)} requires a registered actor alias`, 'DEBATE_KEY_ALIAS_REQUIRED', { artifactStage });
    }
    assertActorAlias(actorAlias, 'debate invocation-id actor alias');
    return `debate:${taskId}:${roundTok}:${artifactStage}:${actorAlias}`;
  }
  if (actorAlias !== null && actorAlias !== undefined) {
    throw new DebateArtifactKeyError(`stage ${JSON.stringify(artifactStage)} must not carry an actor alias`, 'DEBATE_KEY_UNEXPECTED_ALIAS', { artifactStage });
  }
  return `debate:${taskId}:${roundTok}:${artifactStage}`;
}

/** The manifest stage key of the FINAL Debate synthesis (`final_ref` corresponds to this — §31). */
export function debateFinalStageKey(round) {
  return debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round });
}

/**
 * Deterministic, enumeration-order-independent stage-key plan for ONE Debate
 * round (brief + one response key per roster alias in owner order + synthesis).
 *
 * @param {object} input
 * @param {number} input.round
 * @param {string[]} input.rosterAliases  Debate roster aliases in owner order
 * @returns {{ round:number, brief:string, responses:string[], synthesis:string }}
 */
export function debateRoundStageKeyPlan({ round, rosterAliases }) {
  assertDebateRound(round);
  if (!Array.isArray(rosterAliases) || rosterAliases.length === 0) {
    throw new DebateArtifactKeyError('rosterAliases must be a non-empty array', 'DEBATE_KEY_NO_ROSTER');
  }
  const seen = new Set();
  for (const a of rosterAliases) {
    assertActorAlias(a, 'debate roster alias');
    if (seen.has(a)) throw new DebateArtifactKeyError(`duplicate roster alias in Debate stage-key plan: ${a}`, 'DEBATE_KEY_DUP_ALIAS', { alias: a });
    seen.add(a);
  }
  return Object.freeze({
    round,
    brief: debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round }),
    responses: Object.freeze(rosterAliases.map((actorAlias) => debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round, actorAlias }))),
    synthesis: debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round }),
  });
}
