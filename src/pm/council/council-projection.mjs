/**
 * P7 — council read projection (Part M/M1/W).
 *
 * A pure function from a loaded PmRun (PmRepository#load — the SAME durable
 * record a council's pm_run/pm_turns already are) to a normalized,
 * owner-readable council progress/detail shape. Zero new storage: this is
 * computed on every read, so it is trivially restart-safe and can never drift
 * from the durable turn record it projects.
 *
 * Backend Execution (raw pm_turns/execution logs) remains the debug surface;
 * this projection is the product-level Council panel surface (Part M1).
 *
 * P19-D2 (docs/p19/03_P19_D2_FIRST_PROMPT.md): extends this SAME pure
 * projection — zero new storage, same restart-safety-by-construction — with
 * Debate-visible state (`projection.debate`). A debate-disabled council's
 * projection is byte-for-byte unaffected (every new code path below is
 * gated on `spec.debate?.enabled`); see council-debate-projection.test.mjs.
 */

import { COUNCIL_STEP_KINDS, DEBATE_MAX_ROUNDS } from './council-contracts.mjs';

export const COUNCIL_PHASES = Object.freeze({
  PLANNING: 'PLANNING',
  ROUND_1_INDEPENDENT_ANALYSIS: 'ROUND_1_INDEPENDENT_ANALYSIS',
  ROUND_2_CRITIQUE: 'ROUND_2_CRITIQUE',
  CHAIR_SYNTHESIS: 'CHAIR_SYNTHESIS',
  // P19-D2: additive — reported ONLY while `run.status === 'running'` (the
  // outer if-chain below still returns COMPLETED/FAILED/CANCELLED first,
  // exactly as before), and ONLY when `spec.debate?.enabled` — a
  // debate-disabled council can never observe these, and the pre-existing
  // CHAIR_SYNTHESIS fallback is preserved byte-for-byte for it.
  DEBATE_ROUND_1: 'DEBATE_ROUND_1',
  DEBATE_ROUND_2: 'DEBATE_ROUND_2',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

// P19-D2: debate-specific status/sub-phase vocabularies, nested under
// `projection.debate` — never collapsed into COUNCIL_PHASES (Part: "the
// SAME projection", not a second incompatible enum for the same concept —
// COUNCIL_PHASES stays the coarse top-level phase; DEBATE_STATUS is the
// finer-grained state a Debate-aware reader needs).
export const DEBATE_STATUS = Object.freeze({
  NOT_ENABLED: 'NOT_ENABLED',
  PENDING: 'PENDING',
  ROUND_1_IN_PROGRESS: 'ROUND_1_IN_PROGRESS',
  ROUND_1_COMPLETE: 'ROUND_1_COMPLETE',
  ROUND_2_IN_PROGRESS: 'ROUND_2_IN_PROGRESS',
  COMPLETE: 'COMPLETE',
});

export const DEBATE_ROUND_PHASE = Object.freeze({
  BRIEF: 'BRIEF',
  RESPONSES: 'RESPONSES',
  SYNTHESIS: 'SYNTHESIS',
  DONE: 'DONE',
});

const PARTICIPANT_STATUS = Object.freeze({ PENDING: 'PENDING', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED' });

/** @returns {boolean} whether `run` (a PmRepository#load result) is a council run. */
export function isCouncilRun(run) {
  return Boolean(run?.request?.context?.council);
}

/**
 * P19-D2: pure projection of Debate state from the SAME durable `run.turns`
 * array `projectCouncil()` already walks — never a second source of truth,
 * never mutable authority duplicated anywhere. `debateParticipantIds` is
 * the council's own round-1 SUCCESSFUL reporters (Part H — the same
 * eligibility set `CouncilChairDriver`'s `#debateDecide()` uses), supplied
 * by the caller since `projectCouncil()` already computes it once.
 *
 * "Never claim Round 2 exists merely because max_rounds=2" (docs/p19/
 * 03_...md): `currentRound`/`status` are derived exclusively from which
 * round numbers actually have at least one durable `debate_*` turn — a
 * round that hasn't started yet is invisible here regardless of how many
 * rounds the spec permits.
 */
function projectDebate(spec, run, debateParticipantIds) {
  const debateSpec = spec.debate ?? { enabled: false, max_rounds: DEBATE_MAX_ROUNDS };
  const maxRounds = Math.min(debateSpec.max_rounds ?? DEBATE_MAX_ROUNDS, DEBATE_MAX_ROUNDS);

  if (!debateSpec.enabled) {
    return Object.freeze({
      enabled: false, maxRounds, currentRound: null, status: DEBATE_STATUS.NOT_ENABLED,
      completedRounds: Object.freeze([]), currentRoundPhase: null,
      finalReportAvailable: false, finalReport: null,
    });
  }

  const rounds = new Map(); // round -> { brief, responses: Map<profileId, handoff>, responsesRunning: Set<profileId>, synthesis }
  const roundState = (r) => {
    if (!rounds.has(r)) rounds.set(r, { brief: null, responses: new Map(), responsesRunning: new Set(), synthesis: null });
    return rounds.get(r);
  };

  for (const turn of run.turns) {
    if (turn.decision?.type !== 'workflow') continue;
    const stepKind = turn.decision.spec?.stepKind;
    if (stepKind !== COUNCIL_STEP_KINDS.DEBATE_BRIEF && stepKind !== COUNCIL_STEP_KINDS.DEBATE_RESPONSE && stepKind !== COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS) continue;
    const round = turn.decision.spec?.round;
    const profileId = turn.decision.spec?.profileId ?? null;
    const done = turn.phase === 'TURN_COMPLETE';
    const handoff = done ? (turn.outcome?.finalResult?.handoff ?? null) : null;
    const rs = roundState(round);
    if (stepKind === COUNCIL_STEP_KINDS.DEBATE_BRIEF) rs.brief = handoff;
    else if (stepKind === COUNCIL_STEP_KINDS.DEBATE_RESPONSE) { if (done) rs.responses.set(profileId, handoff); else rs.responsesRunning.add(profileId); }
    else if (stepKind === COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS) rs.synthesis = handoff;
  }

  if (rounds.size === 0) {
    return Object.freeze({
      enabled: true, maxRounds, currentRound: null, status: DEBATE_STATUS.PENDING,
      completedRounds: Object.freeze([]), currentRoundPhase: null,
      finalReportAvailable: false, finalReport: null,
    });
  }

  // Same "never trust model prose for the loop boundary" discipline as
  // CouncilChairDriver's own #debateDecide() (docs/p19/00_...md §6) —
  // recomputed here independently from durable handoffs, never read back
  // from a cached/prior projection.
  const sortedRoundNums = [...rounds.keys()].sort((a, b) => a - b);
  const completedRounds = [];
  let finalReport = null;
  let stopped = false;

  for (const roundNum of sortedRoundNums) {
    const rs = rounds.get(roundNum);
    if (rs.synthesis?.ok === true) {
      completedRounds.push(roundNum);
      const continueDebate = rs.synthesis.continue_debate === true;
      const roundsRemaining = roundNum < maxRounds;
      const effectiveContinue = continueDebate && roundsRemaining;
      if (!effectiveContinue) {
        finalReport = Object.freeze({
          round: roundNum, output: rs.synthesis.output ?? null,
          continueDebate, unresolvedQuestions: Object.freeze(rs.synthesis.unresolved_questions ?? []),
          engineForcedStop: continueDebate && !roundsRemaining,
        });
        stopped = true;
      }
    }
  }

  const latestRoundNum = sortedRoundNums[sortedRoundNums.length - 1];
  const latest = rounds.get(latestRoundNum);

  let currentRoundPhase;
  if (!latest.brief) currentRoundPhase = DEBATE_ROUND_PHASE.BRIEF;
  else if (!latest.brief.ok) currentRoundPhase = DEBATE_ROUND_PHASE.BRIEF; // failed brief -- never fabricate further progress
  else if (latest.responses.size < debateParticipantIds.length || latest.responsesRunning.size > 0) currentRoundPhase = DEBATE_ROUND_PHASE.RESPONSES;
  else if (!latest.synthesis) currentRoundPhase = DEBATE_ROUND_PHASE.SYNTHESIS;
  else currentRoundPhase = DEBATE_ROUND_PHASE.DONE;

  let status;
  if (stopped) status = DEBATE_STATUS.COMPLETE;
  else if (latestRoundNum === 1) status = currentRoundPhase === DEBATE_ROUND_PHASE.DONE ? DEBATE_STATUS.ROUND_1_COMPLETE : DEBATE_STATUS.ROUND_1_IN_PROGRESS;
  else status = DEBATE_STATUS.ROUND_2_IN_PROGRESS;

  return Object.freeze({
    enabled: true, maxRounds, currentRound: stopped ? null : latestRoundNum,
    status, completedRounds: Object.freeze(completedRounds), currentRoundPhase: stopped ? null : currentRoundPhase,
    finalReportAvailable: finalReport !== null, finalReport,
  });
}

/**
 * @param {object} run - a PmRepository#load(pmRunId) result.
 * @returns {object} normalized council projection; throws if `run` is not a
 *   council run (callers should guard with isCouncilRun()).
 */
export function projectCouncil(run) {
  if (!isCouncilRun(run)) throw new TypeError('projectCouncil requires a council PmRun');
  const spec = run.request.context.council;
  const participants = spec.participant_profile_ids;

  const reportTurns = new Map();
  const critiqueTurns = new Map();
  let planTurn = null;
  let synthesisTurn = null;
  let lastStepKind = null;
  let lastStepDone = true;

  for (const turn of run.turns) {
    if (turn.decision?.type !== 'workflow') continue;
    const stepKind = turn.decision.spec?.stepKind;
    const profileId = turn.decision.spec?.profileId ?? null;
    const done = turn.phase === 'TURN_COMPLETE';
    const handoff = done ? turn.outcome?.finalResult?.handoff ?? null : null;
    if (!done) { lastStepKind = stepKind; lastStepDone = false; continue; }
    lastStepKind = stepKind; lastStepDone = true;
    if (stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN) planTurn = handoff;
    else if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT) reportTurns.set(profileId, handoff);
    else if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE) critiqueTurns.set(profileId, handoff);
    else if (stepKind === COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS) synthesisTurn = handoff;
  }

  const finishTurn = run.turns.find((t) => t.decision?.type === 'finish' && t.phase === 'TURN_COMPLETE') ?? null;
  // P19-D2: a debate-completed run's finish data is `type: 'council_debate'`
  // (council-chair-driver.mjs's #debateDecide()), not `'council'` — both are
  // recognized here so `degraded` below is never silently lost for a
  // debate-completed run. A plain (debate-disabled) council's finish data
  // is completely unaffected (still exactly `type: 'council'`).
  const finalData = finishTurn?.outcome?.data?.type === 'council' || finishTurn?.outcome?.data?.type === 'council_debate'
    ? finishTurn.outcome.data : null;

  const debateParticipantIds = participants.filter((id) => reportTurns.get(id)?.ok);
  const debate = projectDebate(spec, run, debateParticipantIds);

  let phase;
  if (run.status === 'completed') phase = COUNCIL_PHASES.COMPLETED;
  else if (run.status === 'failed') phase = COUNCIL_PHASES.FAILED;
  else if (run.status === 'cancelled') phase = COUNCIL_PHASES.CANCELLED;
  else if (!planTurn) phase = COUNCIL_PHASES.PLANNING;
  else if (reportTurns.size < participants.length || (lastStepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT && !lastStepDone)) phase = COUNCIL_PHASES.ROUND_1_INDEPENDENT_ANALYSIS;
  else if (spec.rounds >= 2 && (lastStepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE && !lastStepDone || (!synthesisTurn && critiqueTurns.size < participants.filter((id) => reportTurns.get(id)?.ok).length))) phase = COUNCIL_PHASES.ROUND_2_CRITIQUE;
  else if (spec.debate?.enabled && synthesisTurn?.ok) {
    // P19-D2: Council Report (chair_synthesis) is already durably complete
    // and ok — report the debate sub-phase instead of the stale
    // CHAIR_SYNTHESIS fallback. `relevantDebateRound` covers the narrow
    // transient-read window where debate has already stopped
    // (`debate.currentRound === null`) but `run.status` has not yet
    // flipped to 'completed' — fall back to the final report's own round,
    // never mis-report round 1 for a round-2 finish.
    const relevantDebateRound = debate.currentRound ?? debate.finalReport?.round ?? 1;
    phase = relevantDebateRound === 2 ? COUNCIL_PHASES.DEBATE_ROUND_2 : COUNCIL_PHASES.DEBATE_ROUND_1;
  } else phase = COUNCIL_PHASES.CHAIR_SYNTHESIS;

  const participantStatus = (id) => {
    const report = reportTurns.get(id);
    if (!report) return lastStepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT && !lastStepDone ? PARTICIPANT_STATUS.RUNNING : PARTICIPANT_STATUS.PENDING;
    return report.ok ? PARTICIPANT_STATUS.DONE : PARTICIPANT_STATUS.FAILED;
  };

  return Object.freeze({
    councilId: run.id,
    chairProfileId: run.pmProfileId ?? spec.chair_profile_id,
    participantProfileIds: participants,
    rounds: spec.rounds,
    strategy: spec.strategy,
    phase,
    status: run.status,
    degraded: finalData?.degraded ?? null,
    // P19-D6: surfaces the SAME normalized scalar CouncilChairDriver already
    // reads (W4R6) — never a second source of truth, zero new storage. Owner
    // surfaces (Desktop/Telegram) must be able to show which participant, if
    // any, was ever execution-capable; before this field existed the
    // projection had no way to answer that question at all (D6-D finding).
    implementationParticipantId: spec.implementation_participant_id ?? null,
    participants: Object.freeze(participants.map((id) => Object.freeze({ profileId: id, status: participantStatus(id) }))),
    round1: Object.freeze(participants.map((id) => Object.freeze({ profileId: id, ok: reportTurns.get(id)?.ok ?? null, report: reportTurns.get(id) ? Object.freeze({ analysis: reportTurns.get(id).analysis ?? null, recommendation: reportTurns.get(id).recommendation ?? null, risks: reportTurns.get(id).risks ?? [], uncertainties: reportTurns.get(id).uncertainties ?? [], reason: reportTurns.get(id).ok ? null : reportTurns.get(id).reason ?? null }) : null }))),
    round2: spec.rounds >= 2 ? Object.freeze(participants.filter((id) => reportTurns.get(id)?.ok).map((id) => Object.freeze({ profileId: id, ok: critiqueTurns.get(id)?.ok ?? null, critique: critiqueTurns.get(id) ? Object.freeze({ criticisms: critiqueTurns.get(id).criticisms ?? [], agreements: critiqueTurns.get(id).agreements ?? [], revisedRecommendation: critiqueTurns.get(id).revised_recommendation ?? null, remainingDisagreements: critiqueTurns.get(id).remaining_disagreements ?? [], reason: critiqueTurns.get(id).ok ? null : critiqueTurns.get(id).reason ?? null }) : null }))) : Object.freeze([]),
    synthesis: synthesisTurn ? Object.freeze({ ok: synthesisTurn.ok, output: synthesisTurn.ok ? synthesisTurn.output : null, reason: synthesisTurn.ok ? null : synthesisTurn.reason ?? null }) : null,
    // P19-D2: nested Debate projection — see projectDebate() above.
    // `enabled: false` (NOT_ENABLED) for every debate-disabled council,
    // by construction.
    debate,
    finalOutput: run.status === 'completed' ? run.output : null,
    error: run.error ?? null,
  });
}
