/**
 * P7 — CouncilChairDriver.
 *
 * The PM driver DurablePmRuntime turns against for a council run. It is
 * orchestration-only (Part Q1/R): DSH code owns the phase topology
 * deterministically — this driver never spawns a CLI itself. Every real
 * backend call happens inside a WORKFLOW decision it emits, executed by
 * CouncilStepWorkflowRunner; the chair PM's own real backend is invoked only
 * for the chair_plan and chair_synthesis steps, exactly like any other
 * participant step.
 *
 * Sequencing (Part D/E/F/G, strategy `independent_then_critique_then_
 * synthesis`):
 *   turn 0            -> chair_plan
 *   turn 1..P          -> participant_report, one per owner-selected
 *                          participant, in owner-selected order (Part L:
 *                          sequential physical execution)
 *   turn P+1..P+P'      -> participant_critique, one per participant with a
 *                          SUCCESSFUL round-1 report (only when rounds >= 2)
 *   next turn          -> chair_synthesis
 *   final turn         -> finish, with the chair's synthesis as `output`
 *
 * Failure policy (Part H): a participant step failing never throws — it is
 * recorded and the council continues if a minimum viable council remains (>=1
 * successful report). ALL participants failing, or the chair failing to plan
 * or synthesize, throws — DurablePmRuntime turns that into a normal failed
 * PmRun, identical to any other PM decide() failure (Part I: this IS the
 * bounded retry policy — one attempt, no automatic re-invocation, no
 * infinite loop).
 */

import { COUNCIL_STEP_KINDS, DEGRADED_DISCLOSURE_SENTENCE, DEBATE_MAX_ROUNDS, WORKSPACE_REQUIREMENT, councilStepId } from './council-contracts.mjs';
import {
  buildChairPlanPrompt, buildParticipantReportPrompt, buildParticipantCritiquePrompt, buildChairSynthesisPrompt,
  buildDebateBriefPrompt, buildDebateResponsePrompt, buildDebateSynthesisPrompt,
} from './council-prompts.mjs';
import { WORKSPACE_CAPABILITY, resolveProfileCapabilities } from './workspace-capability.mjs';
import { renderWorkspaceEvidencePacketText } from './workspace-evidence-packet.mjs';
// P20.4R R1 — artifact_v1 Council topology (same driver / same history model).
import { ARTIFACT_STAGE, deriveActorAlias, actorAliasFor } from '../../artifacts/artifact-paths.mjs';
import { councilStageKey } from './council-artifact-stage-keys.mjs';
import {
  runCouncilFinalArtifactGate, verifyCouncilArtifactTopology, commitCouncilFinalRef,
  verifyDebateArtifactTopology, commitDebateFinalRef,
} from './council-artifact-orchestrator.mjs';
import { buildCouncilArtifactControl, validateCouncilArtifactControl } from './council-artifact-control.mjs';
import { validateArtifactStepOutcome, validateCouncilArtifactStepBinding, COUNCIL_ARTIFACT_STEP_KINDS, isDebateArtifactStepKind } from './council-artifact-step-outcome.mjs';
import { expectedCouncilArtifactStepIdentity, expectedArtifactStepIdentity, debateArtifactStageForStepKind } from './council-artifact-step-identity.mjs';
import { debateStageKey } from './debate-artifact-keys.mjs';
import { validateDebateContinuationControlBinding, evaluateEffectiveContinuation } from '../../artifacts/debate-continuation-control.mjs';
import { assertDebateTypedControlAdmitted } from './debate-backend-capability.mjs';
import { assertReportRoute } from '../../artifacts/backend-report-capability.mjs';
import { assertBackendTaskModeSupported, TASK_MODE } from '../../runtime/production-backend-capabilities.mjs';
import { validateStageSealEntry } from '../../artifacts/artifact-schema.mjs';
import { resolveAndVerifySealedReference } from '../../artifacts/artifact-recovery.mjs';
import {
  buildArtifactChairPlanInstructions,
  buildArtifactParticipantReportInstructions,
  buildArtifactParticipantCritiqueInstructions,
  buildArtifactChairSynthesisInstructions,
  buildArtifactDebateBriefInstructions,
  buildArtifactDebateResponseInstructions,
  buildArtifactDebateSynthesisInstructions,
} from './council-artifact-prompts.mjs';

const ARTIFACT_STAGE_FOR_STEP = Object.freeze({
  [COUNCIL_STEP_KINDS.CHAIR_PLAN]: ARTIFACT_STAGE.CHAIR_PLAN,
  [COUNCIL_STEP_KINDS.PARTICIPANT_REPORT]: ARTIFACT_STAGE.PARTICIPANT_REPORT,
  [COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE]: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE,
  [COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS]: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
});

export class CouncilOrchestrationError extends Error {
  constructor(message, code, extra = {}) { super(message); this.name = 'CouncilOrchestrationError'; this.code = code; Object.assign(this, extra); }
}

export class CouncilChairDriver {
  #spec;
  #ownerTask;
  #constraints;
  #resolveWorkspaceCapability;
  #loadEvidencePacket;
  #evidencePacketDataPromise = null;

  /**
   * @param {object} deps
   * @param {object} deps.council - a normalizeCouncilSpec() result.
   * @param {string} deps.ownerTask - the owner's raw task text.
   * @param {string[]} [deps.constraints]
   * @param {(profileId: string) => string} [deps.resolveWorkspaceCapability] -
   *   Council/Debate WORKSPACE_READ remediation: returns one of
   *   workspace-capability.mjs's WORKSPACE_CAPABILITY values for a given
   *   participant/chair profile id. Only ever consulted when this
   *   council's own `workspace_requirement === 'READ'` (every pre-existing
   *   council/debate never calls it — byte-for-byte unaffected). Defaults
   *   to a fail-closed TEXT_ONLY-for-everyone resolver so an omitted DI in
   *   a direct/test construction never silently grants NATIVE.
   * @param {() => Promise<{ text: string, hashesByPath?: Record<string,string> }>} [deps.loadEvidencePacket] -
   *   lazily builds (once, cached for this driver's lifetime — "same
   *   packet for every participant" invariant) the bounded evidence-packet
   *   TEXT every TEXT_ONLY-capability step receives. Defaults to a
   *   deterministic "unavailable" packet — a real production composition
   *   always supplies the real one (workspace-evidence-packet.mjs).
   *   Final stabilization patch (§17/§18 of the brief): `hashesByPath` —
   *   the SAME packet's authoritative `path -> sha256` snapshot
   *   (workspace-evidence-packet.mjs's `packetHashesByPath()`) — is cached
   *   alongside `text` and threaded onto `participant_report`/
   *   `debate_response` step specs, so evidence-hash validation checks
   *   against what the model was ACTUALLY shown, never a fresh live-
   *   filesystem re-read. Omitted (every pre-stabilization DI/test) ->
   *   `null` -> `checkWorkspaceEvidence()` falls back to its original
   *   live-disk-read behavior, byte-for-byte unchanged.
   */
  #transportMode;
  #artifact;

  constructor({
    council, ownerTask, constraints = [],
    resolveWorkspaceCapability = () => WORKSPACE_CAPABILITY.TEXT_ONLY,
    loadEvidencePacket = async () => ({ text: '(no evidence packet provider was configured for this council run)', hashesByPath: null }),
    transportMode = 'legacy', artifactCouncil = null,
  }) {
    if (!council) throw new TypeError('CouncilChairDriver requires a normalized council spec');
    if (typeof ownerTask !== 'string' || !ownerTask.trim()) throw new TypeError('CouncilChairDriver requires a non-empty ownerTask');
    this.#spec = council;
    this.#ownerTask = ownerTask;
    this.#constraints = constraints;
    this.#resolveWorkspaceCapability = resolveWorkspaceCapability;
    this.#loadEvidencePacket = loadEvidencePacket;
    this.#transportMode = transportMode === 'artifact_v1' ? 'artifact_v1' : 'legacy';
    if (this.#transportMode === 'artifact_v1') {
      const need = ['store', 'taskId', 'taskSlug', 'createdAt'];
      const missing = need.filter((k) => !artifactCouncil || artifactCouncil[k] === undefined || artifactCouncil[k] === null);
      if (missing.length) throw new TypeError(`CouncilChairDriver artifact_v1 mode requires artifactCouncil: ${missing.join(', ')}`);
      this.#artifact = {
        store: artifactCouncil.store,
        taskId: artifactCouncil.taskId,
        taskSlug: artifactCouncil.taskSlug,
        createdAt: artifactCouncil.createdAt,
        capabilityPolicy: artifactCouncil.capabilityPolicy ?? undefined,
        aliasRegistry: artifactCouncil.aliasRegistry ?? null,
        // P20.5 §25 — used ONLY for the capability-only Debate preflight (never
        // to invoke a backend from the driver). Optional; when absent the
        // preflight resolves UNPROVEN and artifact Debate fails closed.
        resolveReportBackend: typeof artifactCouncil.resolveReportBackend === 'function' ? artifactCouncil.resolveReportBackend : null,
        // P20.5R R6 — the required artifact input transport, admitted in the
        // early Debate preflight (default VERBATIM_CONTENT).
        consumerInputTransport: artifactCouncil.consumerInputTransport ?? 'VERBATIM_CONTENT',
        maxReportBytes: artifactCouncil.maxReportBytes ?? undefined,
        sourceRevision: artifactCouncil.sourceRevision ?? null,
        workspaceId: artifactCouncil.workspaceId ?? null,
        admittedCapabilitySnapshot: artifactCouncil.admittedCapabilitySnapshot ?? null,
        // P20.4R2 R11 — DI/test-only seam. When (and only when) a direct/test
        // construction supplies a function, it is invoked once AFTER the
        // Council Artifact Final Gate has committed `final_ref` and BEFORE the
        // consumer synthesis projection re-verifies the sealed bytes. It has
        // NO production behaviour (never sourced from model text/config) and
        // does not weaken any error handling — it only lets a focused test
        // corrupt the sealed synthesis on disk to prove the projection fails
        // closed with a typed error (no catch-all success fallback).
        __beforeFinalProjection: typeof artifactCouncil.__beforeFinalProjection === 'function' ? artifactCouncil.__beforeFinalProjection : null,
      };
    }
  }

  get name() { return `council:${this.#spec.chair_profile_id}`; }

  async decide({ turn, history }) {
    // P20.4R R1 — prepend-guard: the SAME deterministic topology decides the
    // next Council step, but for artifact_v1 it builds artifact-oriented
    // workflow specs (app-owned control + sealed ArtifactReferences only) and
    // never reads a semantic report field. Legacy `decide()` below is
    // byte-for-byte unchanged.
    if (this.#transportMode === 'artifact_v1') return this.#artifactDecide({ turn, history });
    const steps = this.#stepsSoFar(history);
    const participants = this.#spec.participant_profile_ids;

    if (turn === 0) {
      // P19-D5.1R2: the ONE additional, already-normalized signal the chair
      // planning prompt needs — the SAME `implementation_participant_id`
      // scalar #isImplementationParticipant() below reads. No second source
      // of truth: this is a straight pass-through, never re-derived.
      //
      // Final owner-review micro-patch, Blocker A: chair_plan is a
      // repository-reasoning stage for a READ council — it receives the
      // SAME cached #getEvidenceText() authority every other stage this
      // run uses (Part 5 invariant: one packet, byte-identical everywhere).
      // No product is currently WORKSPACE_READ_NATIVE (workspace-
      // capability.mjs), so the chair always gets the evidence-packet
      // text, never a native "no packet needed" branch — unlike a
      // participant step, the chair has no per-profile capability
      // resolution at all; it is DSH's own orchestration profile.
      const evidencePacketText = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceText() : null;
      return this.#workflow(COUNCIL_STEP_KINDS.CHAIR_PLAN, 0, this.#spec.chair_profile_id, buildChairPlanPrompt({
        ownerTask: this.#ownerTask, constraints: this.#constraints, participantProfileIds: participants,
        implementationParticipantId: this.#spec.implementation_participant_id,
        workspaceRequirement: this.#spec.workspace_requirement, evidencePacketText,
      }));
    }

    if (!steps.chairPlan) throw new CouncilOrchestrationError('chair plan step did not complete', 'COUNCIL_CHAIR_PLAN_MISSING');
    if (!steps.chairPlan.ok) throw new CouncilOrchestrationError(`chair failed to plan the council: ${steps.chairPlan.reason ?? 'unknown'}`, 'COUNCIL_CHAIR_PLAN_FAILED');
    const plan = steps.chairPlan;

    // Round 1: independent reports — owner-selected order, one per turn.
    const nextReport = participants.find((id) => !steps.reports.has(id));
    if (nextReport) {
      const instructions = typeof plan.participant_instructions?.[nextReport] === 'string' ? plan.participant_instructions[nextReport] : '';
      // P18-W4R6-R1: the SAME derivation #workflow() below uses for the
      // execution-capability flag it hands CouncilStepWorkflowRunner —
      // computed once, via #isImplementationParticipant(), so the prompt
      // the model sees and the permission mode DSH actually grants can
      // never drift apart.
      const isImplementationParticipant = this.#isImplementationParticipant(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, nextReport);
      const workspaceMode = this.#workspaceModeFor(nextReport);
      const evidencePacketText = workspaceMode === WORKSPACE_CAPABILITY.TEXT_ONLY ? await this.#getEvidenceText() : null;
      // Final stabilization patch (§17/§18): the SAME cached packet's
      // authoritative hash snapshot travels with this step's spec so
      // council-step-workflow-runner.mjs's evidence validation binds to
      // what this participant was ACTUALLY shown, never a live re-read.
      const evidenceHashesByPath = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceHashes() : null;
      return this.#workflow(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, 1, nextReport, buildParticipantReportPrompt({
        ownerTask: this.#ownerTask, constraints: this.#constraints, instructions, participantProfileId: nextReport, isImplementationParticipant,
        workspaceMode, evidencePacketText,
      }), { workspaceMode, evidenceHashesByPath });
    }

    const successfulReports = participants.filter((id) => steps.reports.get(id)?.ok).map((id) => [id, steps.reports.get(id)]);
    if (successfulReports.length === 0) {
      throw new CouncilOrchestrationError('all council participants failed round 1', 'COUNCIL_ALL_PARTICIPANTS_FAILED');
    }

    // Round 2: cross-critique — only participants with a successful round-1
    // report take part (Part H: a failed participant's content is never
    // fabricated, so it can neither critique nor be critiqued).
    if (this.#spec.rounds >= 2) {
      const eligible = successfulReports.map(([id]) => id);
      const nextCritique = eligible.find((id) => !steps.critiques.has(id));
      if (nextCritique) {
        const peerReports = successfulReports.filter(([id]) => id !== nextCritique).map(([id, r]) => ({ profileId: id, report: r }));
        const critiqueWorkspaceMode = this.#workspaceModeFor(nextCritique);
        const critiqueEvidenceText = critiqueWorkspaceMode === WORKSPACE_CAPABILITY.TEXT_ONLY ? await this.#getEvidenceText() : null;
        return this.#workflow(COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE, 2, nextCritique, buildParticipantCritiquePrompt({
          ownerTask: this.#ownerTask, ownReport: steps.reports.get(nextCritique), peerReports, critiqueFocus: plan.critique_focus, participantProfileId: nextCritique,
          workspaceMode: critiqueWorkspaceMode, evidencePacketText: critiqueEvidenceText,
        }), { workspaceMode: critiqueWorkspaceMode });
      }
    }

    // P11-R3: degraded means the owner-selected council lost ANY round-1
    // participant, not merely that fewer than two reports survived.  The
    // old `< 2` predicate was correct for P7's two-member canary but
    // misclassified a three-member council with two successes and one
    // failure as healthy.  This remains the one generic P7 flag; there is
    // no API-specific degraded state or provider branch.
    const degraded = successfulReports.length < participants.length;

    const successfulCritiques = participants.filter((id) => steps.critiques.get(id)?.ok).map((id) => [id, steps.critiques.get(id)]);
    const failures = participants.filter((id) => !steps.reports.get(id)?.ok).map((id) => ({ profileId: id, reason: steps.reports.get(id)?.reason ?? 'no report' }));

    if (!steps.synthesis) {
      // Final owner-review micro-patch, Blocker A: chair_synthesis is the
      // OTHER half of "chair reads/validates source before orchestration"
      // (T5's requirement) — same cached packet, additive to the
      // participant reports/critiques already passed below.
      const synthesisEvidenceText = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceText() : null;
      return this.#workflow(COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS, this.#spec.rounds, this.#spec.chair_profile_id, buildChairSynthesisPrompt({
        ownerTask: this.#ownerTask, constraints: this.#constraints,
        reports: successfulReports.map(([id, r]) => ({ profileId: id, report: r })),
        critiques: successfulCritiques.map(([id, c]) => ({ profileId: id, critique: c })),
        failures, synthesisFocus: plan.synthesis_focus, degraded,
        workspaceRequirement: this.#spec.workspace_requirement, evidencePacketText: synthesisEvidenceText,
      }));
    }

    if (!steps.synthesis.ok) {
      throw new CouncilOrchestrationError(`chair failed to synthesize the council: ${steps.synthesis.reason ?? 'unknown'}`, 'COUNCIL_SYNTHESIS_FAILED');
    }

    // Degraded disclosure is enforced programmatically (Part H), not only
    // prompted — real-backend compliance is never assumed for a hard
    // owner-facing safety guarantee.
    let output = steps.synthesis.output;
    if (degraded) {
      // Preserve the exact historical P7 disclosure for its canonical
      // one-survivor case.  A larger council can retain multiple successful
      // reports while still being degraded; describe that case truthfully.
      const disclosure = successfulReports.length === 1
        ? DEGRADED_DISCLOSURE_SENTENCE
        : 'Council degraded: one or more participants failed.';
      const trimmed = output.trimStart();
      // The chair is allowed to discuss the failure evidence, but it is not
      // authoritative for the programmatic participant count. Replace any
      // model-authored leading disclosure line so a plausible-but-wrong
      // sentence (for example "only one" when two reports survived) cannot
      // override the durable projection.
      const body = trimmed.startsWith('Council degraded:')
        ? trimmed.replace(/^Council degraded:[^\r\n]*(?:\r?\n)*/, '').trimStart()
        : trimmed;
      output = body ? `${disclosure}\n\n${body}` : disclosure;
    }

    // P19-D1 (docs/p19/00_...md §3): Council Report is now complete — this
    // is the ONE branch point. Debate is only ever entered AFTER this exact
    // line, consuming the just-computed `output` as its round-1 "latest
    // canonical synthesis" input. When debate is absent/disabled, the
    // pre-existing `finish` below is reached unconditionally — byte-for-
    // byte unchanged for every pre-P19 council.
    if (this.#spec.debate?.enabled) {
      return this.#debateDecide({
        history, participants, degraded, councilSynthesisOutput: output,
        successfulReports, successfulCritiques,
      });
    }

    return {
      type: 'finish',
      output,
      data: {
        type: 'council',
        chair_profile_id: this.#spec.chair_profile_id,
        participant_profile_ids: participants,
        rounds: this.#spec.rounds,
        strategy: this.#spec.strategy,
        degraded,
        completed_participants: participants.filter((id) => steps.reports.get(id)?.ok),
        failed_participants: participants.filter((id) => !steps.reports.get(id)?.ok),
      },
    };
  }

  // =========================================================================
  // P19-D1 — Debate extension (docs/p19/00_P19_DEBATE_EXTENSION_PLAN.md).
  // DEBATE = COUNCIL + bounded iterative challenge/synthesis. Entered ONLY
  // from decide() above, ONLY after chair_synthesis has already completed
  // successfully — Debate never replaces or bypasses chair_synthesis, it
  // consumes its output. Reasoning-only by construction: #debateWorkflow()
  // below never derives isImplementationParticipant for any debate step.
  // P19-D5 exposes the existing W4R6 Council report capability to Debate
  // submissions; it does not make rebuttal turns executable.
  // =========================================================================

  /**
   * Reconstruct completed debate-step state from history, keyed by debate
   * round number (1-based, a namespace disjoint from Council's own `round`
   * values because the stepKind differs — see councilStepId()). Same
   * "replay the durable turn history, never a transient counter" pattern
   * #stepsSoFar() already uses for Council, so a restart mid-debate-round
   * never re-dispatches an already-durably-complete step (docs/p19/00_...md
   * §9's "duplicate participant execution after restart").
   */
  #debateStepsSoFar(history) {
    const rounds = new Map();
    const roundState = (round) => {
      if (!rounds.has(round)) rounds.set(round, { brief: null, responses: new Map(), synthesis: null });
      return rounds.get(round);
    };
    for (const entry of history) {
      if (entry.decision?.type !== 'workflow') continue;
      const handoff = entry.outcome?.finalResult?.handoff;
      if (!handoff) continue;
      if (handoff.stepKind === COUNCIL_STEP_KINDS.DEBATE_BRIEF) roundState(handoff.round).brief = handoff;
      else if (handoff.stepKind === COUNCIL_STEP_KINDS.DEBATE_RESPONSE) roundState(handoff.round).responses.set(handoff.participantProfileId, handoff);
      else if (handoff.stepKind === COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS) roundState(handoff.round).synthesis = handoff;
    }
    return rounds;
  }

  /**
   * Sequences DEBATE_R{n}_BRIEF -> DEBATE_R{n}_RESPONSES*N ->
   * DEBATE_R{n}_SYNTHESIS -> typed continuation decision -> STOP
   * (FINAL_DEBATE_REPORT, composed programmatically, no extra model call —
   * mirrors how Council's own `finish` is composed from chair_synthesis's
   * handoff without an additional step) or CONTINUE into round n+1, up to
   * the engine-enforced `DEBATE_MAX_ROUNDS` ceiling (docs/p19/00_...md §6:
   * "never trust model prose" for the loop boundary — the SAME discipline
   * already applied to the degraded-disclosure sentence above).
   *
   * Debate participants are exactly the council's own round-1 SUCCESSFUL
   * reporters (`successfulReports`) — the same eligibility rule
   * participant_critique already uses (Part H: a failed participant's
   * content is never fabricated, so it can neither be debated nor debate).
   */
  async #debateDecide({ history, degraded, councilSynthesisOutput, successfulReports }) {
    const debateSpec = this.#spec.debate;
    const maxRounds = Math.min(debateSpec.max_rounds, DEBATE_MAX_ROUNDS);
    const debateParticipants = successfulReports.map(([id]) => id);
    const debateRounds = this.#debateStepsSoFar(history);

    let canonicalSynthesis = councilSynthesisOutput;
    let unresolvedQuestions = [];

    for (let round = 1; round <= maxRounds; round += 1) {
      const r = debateRounds.get(round) ?? { brief: null, responses: new Map(), synthesis: null };

      if (!r.brief) {
        // Final owner-review micro-patch, Blocker A: debate_brief is a
        // chair repository-reasoning stage — Council READ policy == Debate
        // READ policy (§5 invariant), same cached packet.
        const briefEvidenceText = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceText() : null;
        return this.#debateWorkflow(COUNCIL_STEP_KINDS.DEBATE_BRIEF, round, this.#spec.chair_profile_id, buildDebateBriefPrompt({
          ownerTask: this.#ownerTask, constraints: this.#constraints, canonicalSynthesis, round, maxRounds,
          unresolvedQuestions,
          reports: round === 1 ? successfulReports.map(([id, rep]) => ({ profileId: id, report: rep })) : [],
          workspaceRequirement: this.#spec.workspace_requirement, evidencePacketText: briefEvidenceText,
        }));
      }
      if (!r.brief.ok) {
        throw new CouncilOrchestrationError(`chair failed to prepare debate round ${round} brief: ${r.brief.reason ?? 'unknown'}`, 'COUNCIL_DEBATE_BRIEF_FAILED');
      }

      const nextResponse = debateParticipants.find((id) => !r.responses.has(id));
      if (nextResponse) {
        const workspaceMode = this.#workspaceModeFor(nextResponse);
        const evidencePacketText = workspaceMode === WORKSPACE_CAPABILITY.TEXT_ONLY ? await this.#getEvidenceText() : null;
        // Final stabilization patch (§17/§18): same authoritative-snapshot
        // binding as participant_report — Council READ policy == Debate
        // READ policy.
        const evidenceHashesByPath = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceHashes() : null;
        return this.#debateWorkflow(COUNCIL_STEP_KINDS.DEBATE_RESPONSE, round, nextResponse, buildDebateResponsePrompt({
          ownerTask: this.#ownerTask, constraints: this.#constraints, canonicalSynthesis,
          debateBrief: r.brief.brief, round, participantProfileId: nextResponse,
          workspaceMode, evidencePacketText,
        }), { workspaceMode, evidenceHashesByPath });
      }

      const successfulResponses = debateParticipants.filter((id) => r.responses.get(id)?.ok).map((id) => [id, r.responses.get(id)]);
      if (!r.synthesis) {
        if (successfulResponses.length === 0) {
          throw new CouncilOrchestrationError(`all debate round ${round} participants failed to respond`, 'COUNCIL_DEBATE_ALL_RESPONSES_FAILED');
        }
        // Final owner-review micro-patch, Blocker A: debate_synthesis
        // compares round responses against source of truth — same cached
        // packet, additive to the responses already passed below.
        const debateSynthesisEvidenceText = this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ ? await this.#getEvidenceText() : null;
        return this.#debateWorkflow(COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS, round, this.#spec.chair_profile_id, buildDebateSynthesisPrompt({
          ownerTask: this.#ownerTask, constraints: this.#constraints, canonicalSynthesis,
          debateBrief: r.brief.brief, responses: successfulResponses.map(([id, resp]) => ({ profileId: id, response: resp })),
          round, maxRounds,
          workspaceRequirement: this.#spec.workspace_requirement, evidencePacketText: debateSynthesisEvidenceText,
        }));
      }
      if (!r.synthesis.ok) {
        throw new CouncilOrchestrationError(`chair failed to synthesize debate round ${round}: ${r.synthesis.reason ?? 'unknown'}`, 'COUNCIL_DEBATE_SYNTHESIS_FAILED');
      }

      // Never trust model prose for the loop boundary (docs/p19/00_...md
      // §6): `roundsRemaining` is false at round === maxRounds regardless
      // of what the chair's own JSON says, forcing STOP.
      const modelSaidContinue = r.synthesis.continue_debate === true;
      const roundsRemaining = round < maxRounds;
      const effectiveContinue = modelSaidContinue && roundsRemaining;

      if (!effectiveContinue) {
        return {
          type: 'finish',
          output: r.synthesis.output,
          data: {
            type: 'council_debate',
            chair_profile_id: this.#spec.chair_profile_id,
            participant_profile_ids: this.#spec.participant_profile_ids,
            rounds: this.#spec.rounds,
            strategy: this.#spec.strategy,
            degraded,
            completed_participants: successfulReports.map(([id]) => id),
            failed_participants: this.#spec.participant_profile_ids.filter((id) => !successfulReports.some(([sid]) => sid === id)),
            debate: {
              enabled: true,
              max_rounds: maxRounds,
              rounds_run: round,
              final_continue_debate: modelSaidContinue,
              engine_forced_stop: modelSaidContinue && !roundsRemaining,
              unresolved_questions: r.synthesis.unresolved_questions ?? [],
            },
          },
        };
      }

      canonicalSynthesis = r.synthesis.output;
      unresolvedQuestions = r.synthesis.unresolved_questions ?? [];
    }

    // Unreachable given the forced-stop-at-maxRounds branch above (fail
    // closed rather than an undefined/looping outcome, matching this
    // codebase's existing "typed error, never silently unbounded" style —
    // see e.g. DurablePmRuntime's own PmMaxTurnsExceeded).
    throw new CouncilOrchestrationError('debate exceeded its bounded round cap without terminating', 'COUNCIL_DEBATE_ROUND_OVERRUN');
  }

  /**
   * Same workflow-spec shape #workflow() below produces, but
   * `isImplementationParticipant` is hardcoded `false` — never derived
   * from `implementation_participant_id` — so a debate step can never
   * become execution-capable regardless of the council's own W4R6
   * configuration (docs/p19/00_...md invariant §0.8). P19-D5 deliberately
   * leaves this unchanged and reuses the earlier participant_report turn.
   */
  #debateWorkflow(stepKind, round, profileId, prompt, { workspaceMode = null, evidenceHashesByPath = null } = {}) {
    return { type: 'workflow', spec: { id: councilStepId({ stepKind, round, participantProfileId: profileId }), kind: 'council_step', stepKind, round, profileId, prompt, participantProfileIds: this.#spec.participant_profile_ids, isImplementationParticipant: false, workspaceRequirement: this.#spec.workspace_requirement, workspaceMode, workspaceEvidencePaths: this.#spec.workspace_evidence_paths, workspaceEvidenceHashes: evidenceHashesByPath } };
  }

  // P18-W4R6: the ONE typed signal both CouncilStepWorkflowRunner (execution
  // capability) and, since W4R6-R1, buildParticipantReportPrompt() (prompt
  // content) derive from — never a stepKind guess, never prompt text. True
  // for exactly the council's own owner-selected `implementation_
  // participant_id`, and only on ITS `participant_report` step (the one
  // step type where a solo participant does an unsupervised turn);
  // chair_plan/chair_synthesis (chair-only, no repo write) and
  // participant_critique (peer review, not implementation) are never
  // eligible regardless of who is named. Absent implementation_participant_id,
  // this is false for every step of every council — byte-for-byte pre-W4R6
  // behavior.
  #isImplementationParticipant(stepKind, profileId) {
    return stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT
      && this.#spec.implementation_participant_id != null
      && profileId === this.#spec.implementation_participant_id;
  }

  #workflow(stepKind, round, profileId, prompt, { workspaceMode = null, evidenceHashesByPath = null } = {}) {
    // P7-R0.2 Part G: participantProfileIds travels with every step spec
    // (not just chair_plan's) so CouncilStepWorkflowRunner's schema
    // validator can check chair_plan's participant_instructions keys
    // against the owner-selected authority boundary without needing a
    // second lookup path.
    const isImplementationParticipant = this.#isImplementationParticipant(stepKind, profileId);
    // Council/Debate WORKSPACE_READ remediation: `workspaceRequirement` is
    // this council's own durable, owner-authored fact — always present,
    // 'NONE' for every pre-existing council (byte-for-byte: council-step-
    // workflow-runner.mjs's evidence check is a no-op unless this is
    // 'READ'). `workspaceMode` is this ONE step's resolved per-profile
    // capability (workspace-capability.mjs), null whenever the caller
    // above didn't need to resolve one (workspace_requirement is 'NONE',
    // or this step kind never carries evidence).
    return { type: 'workflow', spec: { id: councilStepId({ stepKind, round, participantProfileId: profileId }), kind: 'council_step', stepKind, round, profileId, prompt, participantProfileIds: this.#spec.participant_profile_ids, isImplementationParticipant, workspaceRequirement: this.#spec.workspace_requirement, workspaceMode, workspaceEvidencePaths: this.#spec.workspace_evidence_paths, workspaceEvidenceHashes: evidenceHashesByPath } };
  }

  /**
   * Council/Debate WORKSPACE_READ remediation: resolve which capability
   * mode a given profile's step should use, or `null` when this council
   * has no workspace requirement at all (Part 1 regression requirement:
   * every existing council/debate never calls #resolveWorkspaceCapability
   * and always builds the exact pre-existing prompt).
   */
  #workspaceModeFor(profileId) {
    if (this.#spec.workspace_requirement !== WORKSPACE_REQUIREMENT.READ) return null;
    return this.#resolveWorkspaceCapability(profileId);
  }

  /**
   * Lazily builds, and caches for this driver instance's lifetime, the
   * bounded evidence-packet TEXT every TEXT_ONLY-capability step in THIS
   * council/debate run receives — byte-identical for every one of them
   * (same discipline as buildDebateBriefPrompt's "every participant will
   * receive this exact text"). A packet-build failure is rendered honestly
   * into the text (never thrown from here — the participant then has no
   * real evidence to cite and its report naturally fails
   * workspace-evidence-contract.mjs's validation, reusing the existing
   * failed-participant/degraded pipeline rather than a second error path).
   */
  async #getEvidenceText() {
    return (await this.#getEvidencePacketData()).text;
  }

  /**
   * Final closure patch (Defect A — "packet failure must never fall back
   * to live disk"): the SAME cached packet build's authoritative
   * `path -> sha256` snapshot. This method is ONLY ever called from a
   * `workspace_requirement === 'READ'` code path (every call site in
   * `decide()` guards on that before calling it) — so it ALWAYS represents
   * a real "READ production packet provider" result and therefore NEVER
   * returns `null`, even when the packet build failed or produced no
   * usable files: it returns `{}` (an authoritative-but-empty snapshot).
   * `null` is reserved exclusively for a caller of
   * `workspace-evidence-contract.mjs`'s `validateEvidence()` that never
   * went through a packet provider AT ALL (a legacy/direct/unit-test call
   * that omits `authoritativeHashes` entirely) — this driver is never
   * that caller. The distinction matters: `{}` makes
   * `checkWorkspaceEvidence()` bind to "authoritative packet mode, zero
   * files shown" and reject every citation with `PATH_NOT_IN_PACKET`;
   * `null` would have silently re-enabled `validateEvidence()`'s
   * live-filesystem fallback, letting a participant's fabricated/invented
   * citation of a file that merely happens to exist on disk PASS even
   * though the model was shown no real evidence at all.
   */
  async #getEvidenceHashes() {
    return (await this.#getEvidencePacketData()).hashesByPath;
  }

  /**
   * Lazily builds, and caches for this driver instance's lifetime, the
   * bounded evidence-packet TEXT (and its authoritative hash snapshot)
   * every TEXT_ONLY-capability step in THIS council/debate run receives —
   * byte-identical for every one of them (same discipline as
   * buildDebateBriefPrompt's "every participant will receive this exact
   * text"). A packet-build failure is rendered honestly into the text
   * (never thrown from here — the participant then has no real evidence
   * to cite and its report naturally fails workspace-evidence-
   * contract.mjs's validation, reusing the existing failed-participant/
   * degraded pipeline rather than a second error path).
   *
   * Final closure patch (Defect A): `hashesByPath` is normalized to a real
   * object (`{}` when absent/malformed/build-failed) in BOTH the success
   * and failure branches — this method never resolves with `hashesByPath:
   * null`. See `#getEvidenceHashes()`'s docstring for the exact
   * null-vs-{} rationale.
   */
  async #getEvidencePacketData() {
    if (!this.#evidencePacketDataPromise) {
      this.#evidencePacketDataPromise = this.#loadEvidencePacket()
        .then((result) => ({
          text: typeof result?.text === 'string' ? result.text : '(evidence packet unavailable — no text was returned)',
          hashesByPath: result?.hashesByPath && typeof result.hashesByPath === 'object' ? result.hashesByPath : {},
        }))
        .catch((error) => ({
          text: `(evidence packet generation FAILED: ${String(error?.code ?? error?.message ?? 'unknown error')} — no repository evidence is available for this task; do not fabricate any)`,
          hashesByPath: {},
        }));
    }
    return this.#evidencePacketDataPromise;
  }

  /** Reconstruct completed-step state from DurablePmRuntime's bounded turn history. */
  #stepsSoFar(history) {
    const reports = new Map();
    const critiques = new Map();
    let chairPlan = null;
    let synthesis = null;
    for (const entry of history) {
      if (entry.decision?.type !== 'workflow') continue;
      const handoff = entry.outcome?.finalResult?.handoff;
      if (!handoff) continue;
      if (handoff.stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN) chairPlan = handoff;
      else if (handoff.stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT) reports.set(handoff.participantProfileId, handoff);
      else if (handoff.stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE) critiques.set(handoff.participantProfileId, handoff);
      else if (handoff.stepKind === COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS) synthesis = handoff;
    }
    return { chairPlan, reports, critiques, synthesis };
  }

  // =========================================================================
  // P20.4R R1 — artifact_v1 Council topology. SAME deterministic sequencing
  // as decide() above; builds artifact workflow specs; reads ONLY
  // handoff.ok + handoff.sealed_ref from prior durable steps.
  // =========================================================================

  /**
   * P20.4R3 R13 — the deterministic app-owned EXPECTED step identity for one
   * artifact_v1 PM-turn history handoff, derived ONLY from persisted
   * `council_control` + owner participant order + the ONE shared canonical
   * step→stage/role/stage-key helper + a stable registered actor alias.
   * Returns `null` when the step kind / profile is not a legitimate member of
   * THIS council's control (the caller turns that into a typed fail-closed).
   */
  #expectedArtifactHistoryIdentity(stepKind, profileId, control) {
    const isChairStep = stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN || stepKind === COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS;
    if (isChairStep) {
      if (profileId !== control.chair_profile_id) return null;
    } else if (!control.participant_profile_ids.includes(profileId)) {
      return null;
    }
    return expectedCouncilArtifactStepIdentity({ stepKind, profileId, actorAlias: this.#aliasOf(profileId) });
  }

  /**
   * Reconstruct artifact-step state from DURABLE PM-turn history.
   *
   * P20.4R3 R13 — a PM-turn history handoff is a SECOND durable projection of a
   * step outcome (distinct from `workflow_steps.dispatched_context`, which the
   * runner's #reconstructArtifactOutcome fully binds). Before ANY successful
   * prior handoff is admitted into chairPlan/reports/critiques/synthesis state
   * (and its `sealed_ref` handed to a downstream critique/synthesis provider),
   * it is bound to app-owned authority EXACTLY as strongly as the workflow row:
   *   1. persisted council_control (already fresh-validated by the caller)
   *   2. expected step identity from control + owner order + canonical maps
   *   3. resolveAndVerifySealedReference(h.sealed_ref)   (full P20.3 verifier)
   *   4. manifest.stages[expectedStageKey] exists + validateStageSealEntry +
   *      equals the handoff ref
   *   5. the SAME validateCouncilArtifactStepBinding helper as R9, with the
   *      resolved invocation record / attempt metadata + manifest stage ref
   * A failed/skipped history handoff: full identity bind, sealed_ref === null,
   * no fabricated manifest stage entry.
   *
   * Any malformed / missing / mismatched artifact handoff in a completed PM
   * turn FAILS CLOSED with a typed Council history-authority error — never a
   * silent `continue` + re-emit, never a legacy fallback, never a downstream
   * provider call, never a final_ref mutation.
   *
   * @param {object[]} history  DurablePmRuntime bounded turn history
   * @param {{ task: object, control: object, manifest: object }} bound  the
   *   already-allocated task + its fresh-validated persisted council_control
   */
  #artifactStepsSoFar(history, { task, control, manifest }) {
    const reports = new Map();
    const critiques = new Map();
    let chairPlan = null;
    let synthesis = null;
    const store = this.#artifact.store;

    for (const entry of history) {
      // #artifactStepsSoFar only runs on the artifact_v1 path — EVERY workflow
      // decision this driver emitted in this run is an artifact Council step,
      // so its completed turn MUST carry a valid artifact handoff. (Non-
      // workflow turns — finish / await_owner / peer_exchange — are skipped.
      // DurablePmRuntime.#history() strips the decision to just `{ type }`, so
      // the artifact-step signal is the outcome handoff, not the decision.)
      if (entry.decision?.type !== 'workflow') continue;

      const h = entry.outcome?.finalResult?.handoff ?? null;
      // P20.5 — Debate step turns are reconstructed + fully bound by
      // #artifactDebateStepsSoFar, not here. Skip them (a well-formed Debate
      // handoff carries an artifact_v1 debate_* step_kind).
      if (h && h.transport_version === 'artifact_v1' && isDebateArtifactStepKind(h.step_kind ?? h.stepKind)) continue;

      const shape = validateArtifactStepOutcome(h ?? undefined);
      if (!h || !shape.ok) {
        throw new CouncilOrchestrationError(
          `artifact Council PM-turn history carries a missing/malformed handoff for a completed artifact step: ${(shape?.errors ?? ['no handoff object']).join('; ')}`,
          'COUNCIL_ARTIFACT_HISTORY_HANDOFF_INVALID',
        );
      }
      const stepKind = h.step_kind ?? h.stepKind;
      const profileId = h.profile_id;
      const expected = this.#expectedArtifactHistoryIdentity(stepKind, profileId, control);
      if (!expected) {
        throw new CouncilOrchestrationError(
          `artifact Council PM-turn history handoff has an identity outside persisted council_control: step_kind=${JSON.stringify(stepKind)} profile_id=${JSON.stringify(profileId)}`,
          'COUNCIL_ARTIFACT_HISTORY_IDENTITY_UNKNOWN',
        );
      }

      if (h.ok === true) {
        let verified;
        try {
          verified = resolveAndVerifySealedReference({ store, reference: h.sealed_ref });
        } catch (error) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history handoff sealed_ref failed full verification: ${error.message}`,
            'COUNCIL_ARTIFACT_HISTORY_REF_VERIFY_FAILED',
            { cause: error.code ?? null },
          );
        }
        const stageEntry = manifest.stages?.[expected.stageKey];
        if (!stageEntry) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history handoff references stage ${JSON.stringify(expected.stageKey)} but the task manifest has no such stage entry`,
            'COUNCIL_ARTIFACT_HISTORY_STAGE_MISSING',
          );
        }
        const sv = validateStageSealEntry(stageEntry, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
        if (!sv.ok) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history handoff stage entry ${JSON.stringify(expected.stageKey)} is invalid: ${sv.errors.join('; ')}`,
            'COUNCIL_ARTIFACT_HISTORY_STAGE_INVALID',
          );
        }
        const bind = validateCouncilArtifactStepBinding({
          handoff: h,
          expected,
          sealedInvocationRecord: verified.invocationRecord,
          sealedAttemptMetadata: verified.attemptMetadata,
          expectedStageSealedRef: stageEntry.sealed_ref,
        });
        if (!bind.ok) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history handoff does not bind to app-owned authority: ${bind.errors.join('; ')}`,
            'COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH',
          );
        }
      } else {
        const bind = validateCouncilArtifactStepBinding({ handoff: h, expected });
        if (!bind.ok) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history failed/skipped handoff identity mismatch: ${bind.errors.join('; ')}`,
            'COUNCIL_ARTIFACT_HISTORY_BINDING_MISMATCH',
          );
        }
        if (h.sealed_ref !== null) {
          throw new CouncilOrchestrationError(
            'artifact Council PM-turn history failed/skipped handoff carries a non-null sealed_ref',
            'COUNCIL_ARTIFACT_HISTORY_FABRICATED_REF',
          );
        }
        if (manifest.stages?.[expected.stageKey]) {
          throw new CouncilOrchestrationError(
            `artifact Council PM-turn history failed/skipped handoff has a fabricated manifest stage entry ${JSON.stringify(expected.stageKey)}`,
            'COUNCIL_ARTIFACT_HISTORY_FABRICATED_REF',
          );
        }
      }

      // admit — keyed on the fully-bound handoff.profile_id (never the
      // legacy-compat participantProfileId).
      if (stepKind === COUNCIL_STEP_KINDS.CHAIR_PLAN) chairPlan = h;
      else if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_REPORT) reports.set(profileId, h);
      else if (stepKind === COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE) critiques.set(profileId, h);
      else if (stepKind === COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS) synthesis = h;
    }
    return { chairPlan, reports, critiques, synthesis };
  }

  #aliasOf(profileId) {
    if (this.#artifact.aliasRegistry) {
      try { return actorAliasFor(this.#artifact.aliasRegistry, profileId); } catch { /* fall through */ }
    }
    return deriveActorAlias(profileId);
  }

  #artifactWorkflow(stepKind, profileId, { instructions, inputRefs = [], isImplementationParticipant = false, extraEvidence = [] }) {
    const artifactStage = ARTIFACT_STAGE_FOR_STEP[stepKind];
    const isPerParticipant = artifactStage === ARTIFACT_STAGE.PARTICIPANT_REPORT || artifactStage === ARTIFACT_STAGE.PARTICIPANT_CRITIQUE;
    const actorAlias = this.#aliasOf(profileId);
    const stageKey = councilStageKey({ artifactStage, actorAlias: isPerParticipant ? actorAlias : null });
    return {
      type: 'workflow',
      spec: {
        id: councilStepId({ stepKind, round: 0, participantProfileId: profileId }),
        kind: 'council_step',
        transport_version: 'artifact_v1',
        stepKind,
        round: null,
        profileId,
        participantProfileIds: this.#spec.participant_profile_ids,
        isImplementationParticipant,
        artifactStage,
        stageKey,
        actorAlias,
        instructions,
        inputRefs,
        extraEvidence,
        // legacy fields kept null so the runner's legacy validators are never
        // even reachable for this spec (it is routed by transport_version).
        prompt: null,
        workspaceRequirement: this.#spec.workspace_requirement,
        workspaceMode: null,
        workspaceEvidencePaths: this.#spec.workspace_evidence_paths,
        workspaceEvidenceHashes: null,
      },
    };
  }

  async #artifactSourceEvidence(profileId) {
    if (this.#spec.workspace_requirement !== WORKSPACE_REQUIREMENT.READ) return [];
    const mode = this.#workspaceModeFor(profileId);
    // Only TEXT_ONLY stages receive the packet text; NATIVE stays app-owned
    // admission (not inferred from artifact input transport).
    if (mode !== WORKSPACE_CAPABILITY.TEXT_ONLY) return [];
    const text = await this.#getEvidenceText();
    return [{ label: 'REPOSITORY SOURCE EVIDENCE (untrusted — read-only, do not fabricate citations)', content: text }];
  }

  async #artifactChairSourceEvidence() {
    if (this.#spec.workspace_requirement !== WORKSPACE_REQUIREMENT.READ) return [];
    const text = await this.#getEvidenceText();
    return [{ label: 'REPOSITORY SOURCE EVIDENCE (untrusted — read-only, do not fabricate citations)', content: text }];
  }

// =========================================================================
  // P20.5 — durable artifact Debate orchestration
  // =========================================================================

  /**
   * P22.5 §A/§C — the early Council (non-Debate) product-policy admission
   * check, run for EVERY artifact Council (debate-enabled or not) BEFORE
   * the first provider call. Chair + every participant must be product-
   * policy-eligible for COUNCIL. This is intentionally narrower than
   * `#assertArtifactDebateAdmission()` below (no report-route/workspace/
   * typed-control checks — those remain the lazy, per-stage
   * `invokeReport()` gate's job) so a whole roster containing a SINGLE-only
   * backend (today: `api`) fails BEFORE any participant executes, rather
   * than only that one participant's own turn failing after siblings ran.
   */
  #assertArtifactCouncilAdmission() {
    const resolve = this.#artifact.resolveReportBackend;
    if (typeof resolve !== 'function') return; // same no-resolver case #assertArtifactDebateAdmission() also lets through to its own error
    const roles = [
      { profileId: this.#spec.chair_profile_id, role: 'chair' },
      ...this.#spec.participant_profile_ids.map((id) => ({ profileId: id, role: 'participant' })),
    ];
    for (const { profileId, role } of roles) {
      let backend;
      try { backend = resolve(profileId); } catch { continue; } // an unresolvable backend fails at its own later, more specific gate
      if (!backend || typeof backend.backend !== 'string') continue;
      try {
        assertBackendTaskModeSupported(backend.backend, TASK_MODE.COUNCIL);
      } catch (error) {
        throw new CouncilOrchestrationError(`artifact Council admission: ${role} ${profileId} (${backend.backend}): ${error.message}`, 'COUNCIL_ARTIFACT_ADMISSION_TASK_MODE_UNSUPPORTED', { profileId, role, product: backend.backend, cause: error.code ?? null });
      }
    }
  }

  /**
   * P20.5R R6 — the COMPLETE early Debate capability/admission check, run
   * ONCE BEFORE the first Council provider call. App-owned, fail-closed,
   * never name-inferred. Throws `CouncilOrchestrationError` with a typed code
   * on the first unsatisfied route; returns nothing on success.
   *
   * Covers: the Chair Debate report delivery route + EVERY Debate participant
   * report delivery route (the Debate roster is a subset of
   * `participant_profile_ids`, so the full set is admitted up front) + the
   * required artifact input transport for each + the Chair same-execution
   * typed continuation route (must be PROVEN) + the workspace/source policy
   * for the Chair and every participant when `workspace_requirement === READ`.
   * Debate steps remain `executionCapable = false` structurally (forced in
   * `#artifactDebateWorkflow` / `runDebateArtifactStage`).
   */
  #assertArtifactDebateAdmission() {
    const resolve = this.#artifact.resolveReportBackend;
    if (typeof resolve !== 'function') {
      throw new CouncilOrchestrationError('artifact Debate admission: no report-backend resolver is configured', 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_NO_RESOLVER');
    }
    const inputTransport = this.#artifact.consumerInputTransport ?? 'VERBATIM_CONTENT';
    const chair = this.#spec.chair_profile_id;
    const roles = [{ profileId: chair, role: 'chair' }, ...this.#spec.participant_profile_ids.map((id) => ({ profileId: id, role: 'participant' }))];

    for (const { profileId, role } of roles) {
      let backend;
      try { backend = resolve(profileId); }
      catch (error) { throw new CouncilOrchestrationError(`artifact Debate admission: resolveReportBackend(${JSON.stringify(profileId)}) threw: ${error.message}`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_BACKEND_UNRESOLVED', { profileId, role }); }
      if (!backend || typeof backend.runReport !== 'function' || typeof backend.backend !== 'string') {
        throw new CouncilOrchestrationError(`artifact Debate admission: resolveReportBackend(${JSON.stringify(profileId)}) did not return { backend, runReport }`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_BACKEND_INVALID', { profileId, role });
      }
      // P22.5 §A/§D/§E — product-policy task-mode gate, BEFORE any report-
      // route/delivery check or provider call. A backend can have a fully
      // working report route and still be intentionally unsupported for
      // Debate by product decision (today: `api` — SINGLE-only). Distinct
      // from, and checked before, the route-capability check below; never
      // phrased as PROVEN/UNPROVEN.
      try {
        assertBackendTaskModeSupported(backend.backend, role === 'chair' ? TASK_MODE.DEBATE_CHAIR : TASK_MODE.DEBATE_MEMBER);
      } catch (error) {
        throw new CouncilOrchestrationError(`artifact Debate admission: ${role} ${profileId} (${backend.backend}): ${error.message}`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_TASK_MODE_UNSUPPORTED', { profileId, role, product: backend.backend, cause: error.code ?? null });
      }
      // P20.8R8 — report delivery route + required artifact input transport.
      // `requestedDelivery` MUST be the SAME actual delivery mechanism the
      // resolved report backend will use at execution time
      // (runDebateArtifactStage()'s own `reportBackend?.deliveryMechanism ??
      // 'VERBATIM_MATERIALIZATION'`, R6) — never a hard-coded literal, never
      // inferred from profile/model/stage text. This was previously
      // hard-coded to 'VERBATIM_MATERIALIZATION' here while the real Phase-1
      // CLI routes resolve to DIRECT_WRITE, so a Debate task with fully
      // DIRECT_WRITE-PROVEN alternate profiles (24/23/7) still failed closed
      // at this earlier admission gate before any provider call
      // (docs/P20/P20_8R8_DEBATE_ADMISSION_ACTUAL_ROUTE_FIX_MASTER_PROMPT.md).
      // A backend with no `.deliveryMechanism` at all (pre-R6/legacy/test
      // doubles) keeps the exact prior VERBATIM_MATERIALIZATION default —
      // byte-for-byte backward compatible; an explicit DIRECT_WRITE backend
      // is never silently downgraded to materialization.
      const actualDelivery = backend.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION';
      try {
        assertReportRoute({
          policy: this.#artifact.capabilityPolicy,
          product: backend.backend,
          requestedDelivery: actualDelivery,
          requestedInputTransport: inputTransport,
        });
      } catch (error) {
        throw new CouncilOrchestrationError(`artifact Debate admission: ${role} ${profileId} report route not admitted: ${error.message}`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_ROUTE_UNSUPPORTED', { profileId, role, cause: error.code ?? null });
      }
      // workspace / source policy (only when this council is a READ council)
      if (this.#spec.workspace_requirement === WORKSPACE_REQUIREMENT.READ) {
        let mode;
        try { mode = this.#resolveWorkspaceCapability(profileId); }
        catch (error) { throw new CouncilOrchestrationError(`artifact Debate admission: workspace capability for ${role} ${profileId} threw: ${error.message}`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_WORKSPACE_UNSUPPORTED', { profileId, role }); }
        if (mode !== WORKSPACE_CAPABILITY.TEXT_ONLY && mode !== WORKSPACE_CAPABILITY.WORKSPACE_READ_NATIVE) {
          throw new CouncilOrchestrationError(`artifact Debate admission: workspace capability for ${role} ${profileId} is ${JSON.stringify(mode)} (not a valid READ capability)`, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_WORKSPACE_UNSUPPORTED', { profileId, role, mode });
        }
      }
    }

    // Chair same-execution typed continuation route MUST be PROVEN.
    try { assertDebateTypedControlAdmitted(resolve(chair), { profileId: chair, role: 'chair' }); }
    catch (error) {
      throw new CouncilOrchestrationError(
        `artifact_v1 Council with debate.enabled=true: ${error.message} (real artifact Debate is DEFERRED / fail-closed for this profile)`,
        'COUNCIL_ARTIFACT_DEBATE_TYPED_CONTROL_UNSUPPORTED',
        { cause: error.code ?? null },
      );
    }
  }

  /**
   * §27/§28/§41 — reconstruct Debate round state from DURABLE PM-turn history
   * with FULL authority binding on every successful handoff (shape + expected
   * round/stage/profile/alias identity + resolveAndVerifySealedReference +
   * manifest stage entry + step binding; for a synthesis also the typed
   * continuation control binding). A malformed / mismatched Debate history
   * handoff FAILS CLOSED with a typed error — never a silent drop + re-emit.
   *
   * @returns {{ rounds: Map<number, { round:number, brief:object|null, responses: Map<string,object>, synthesis:object|null }> }}
   */
  #artifactDebateStepsSoFar(history, { task, control, manifest, roster }) {
    const rounds = new Map();
    const store = this.#artifact.store;
    const rosterSet = new Set(roster);
    const roundOf = (round) => {
      if (!rounds.has(round)) rounds.set(round, { round, brief: null, responses: new Map(), synthesis: null });
      return rounds.get(round);
    };

    for (const entry of history) {
      if (entry.decision?.type !== 'workflow') continue;
      const h = entry.outcome?.finalResult?.handoff ?? null;
      if (!h || h.transport_version !== 'artifact_v1') continue;
      const stepKind = h.step_kind ?? h.stepKind;
      if (!isDebateArtifactStepKind(stepKind)) continue; // a Council step
      const shape = validateArtifactStepOutcome(h);
      if (!shape.ok) {
        throw new CouncilOrchestrationError(`artifact Debate PM-turn history carries a malformed handoff: ${shape.errors.join('; ')}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_HANDOFF_INVALID');
      }
      const round = h.round;
      const profileId = h.profile_id;
      const isChairStep = stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF || stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS;
      if (isChairStep) {
        if (profileId !== control.chair_profile_id) throw new CouncilOrchestrationError(`artifact Debate history ${stepKind} handoff profile ${JSON.stringify(profileId)} is not the chair`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_IDENTITY_UNKNOWN');
      } else if (!rosterSet.has(profileId)) {
        throw new CouncilOrchestrationError(`artifact Debate history response handoff profile ${JSON.stringify(profileId)} is not on the Debate roster`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_IDENTITY_UNKNOWN');
      }
      const expected = expectedArtifactStepIdentity({ stepKind, round, profileId, actorAlias: this.#aliasOf(profileId) });
      if (!expected) throw new CouncilOrchestrationError(`artifact Debate history handoff has an unrecognised identity (step_kind=${JSON.stringify(stepKind)} round=${JSON.stringify(round)})`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_IDENTITY_UNKNOWN');

      if (h.ok === true) {
        let verified;
        try { verified = resolveAndVerifySealedReference({ store, reference: h.sealed_ref }); }
        catch (error) { throw new CouncilOrchestrationError(`artifact Debate history handoff sealed_ref failed full verification: ${error.message}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_REF_VERIFY_FAILED', { cause: error.code ?? null }); }
        const stageEntry = manifest.stages?.[expected.stageKey];
        if (!stageEntry) throw new CouncilOrchestrationError(`artifact Debate history handoff references stage ${JSON.stringify(expected.stageKey)} with no manifest entry`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_STAGE_MISSING');
        const sv = validateStageSealEntry(stageEntry, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
        if (!sv.ok) throw new CouncilOrchestrationError(`artifact Debate history stage entry ${JSON.stringify(expected.stageKey)} invalid: ${sv.errors.join('; ')}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_STAGE_INVALID');
        const bind = validateCouncilArtifactStepBinding({ handoff: h, expected, sealedInvocationRecord: verified.invocationRecord, sealedAttemptMetadata: verified.attemptMetadata, expectedStageSealedRef: stageEntry.sealed_ref });
        if (!bind.ok) throw new CouncilOrchestrationError(`artifact Debate history handoff does not bind: ${bind.errors.join('; ')}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_BINDING_MISMATCH');
        if (stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS) {
          const tc = h.typed_control ?? null;
          const tv = validateDebateContinuationControlBinding({
            control: tc,
            expected: { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id, invocationId: verified.invocationRecord.invocation_id, round, profileId, actorAlias: this.#aliasOf(profileId), role: expected.role },
            sealedInvocationRecord: verified.invocationRecord,
            sealedAttemptMetadata: verified.attemptMetadata,
          });
          if (!tv.ok) throw new CouncilOrchestrationError(`artifact Debate history synthesis typed control not bound: ${tv.errors.join('; ')}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_CONTROL_UNBOUND');
          if (JSON.stringify(verified.invocationRecord.debate_continuation) !== JSON.stringify(tc)) {
            throw new CouncilOrchestrationError('artifact Debate history synthesis typed control != persisted debate_continuation', 'COUNCIL_ARTIFACT_DEBATE_HISTORY_CONTROL_DRIFT');
          }
        }
      } else {
        const bind = validateCouncilArtifactStepBinding({ handoff: h, expected });
        if (!bind.ok) throw new CouncilOrchestrationError(`artifact Debate history failed handoff identity mismatch: ${bind.errors.join('; ')}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_BINDING_MISMATCH');
        if (h.sealed_ref !== null) throw new CouncilOrchestrationError('artifact Debate history failed handoff carries a non-null sealed_ref', 'COUNCIL_ARTIFACT_DEBATE_HISTORY_FABRICATED_REF');
        if (manifest.stages?.[expected.stageKey]) throw new CouncilOrchestrationError(`artifact Debate history failed handoff has a fabricated manifest stage entry ${JSON.stringify(expected.stageKey)}`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_FABRICATED_REF');
      }

      const r = roundOf(round);
      if (stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF) r.brief = h;
      else if (stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE) r.responses.set(profileId, h);
      else r.synthesis = h;
    }
    // §28 — round sequence must be contiguous from 1.
    const seen = [...rounds.keys()].sort((a, b) => a - b);
    seen.forEach((rn, i) => {
      if (rn !== i + 1) throw new CouncilOrchestrationError(`artifact Debate history rounds are not contiguous from 1 (round ${rn} at index ${i})`, 'COUNCIL_ARTIFACT_DEBATE_HISTORY_ROUNDS_NOT_CONTIGUOUS');
    });
    return { rounds };
  }

  #artifactDebateWorkflow(stepKind, round, maxRounds, profileId, { instructions, inputRefs = [], extraEvidence = [] }) {
    const artifactStage = debateArtifactStageForStepKind(stepKind);
    const isResponse = stepKind === COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE;
    const actorAlias = this.#aliasOf(profileId);
    const stageKey = debateStageKey({ artifactStage, round, actorAlias: isResponse ? actorAlias : null });
    return {
      type: 'workflow',
      spec: {
        id: councilStepId({ stepKind, round, participantProfileId: profileId }),
        kind: 'council_step',
        transport_version: 'artifact_v1',
        stepKind,
        round,
        // P23.2 §4 — the SAME app-owned ceiling this round loop computed
        // (never a second, independently-derived value); the durable
        // step-workflow runner forwards it unchanged to
        // runDebateArtifactStage(), which fails closed if it is missing.
        maxRounds,
        profileId,
        participantProfileIds: this.#spec.participant_profile_ids,
        isImplementationParticipant: false, // §12 — Debate is never implementation-capable
        artifactStage,
        stageKey,
        actorAlias,
        instructions,
        inputRefs,
        extraEvidence,
        prompt: null,
        workspaceRequirement: this.#spec.workspace_requirement,
        workspaceMode: null,
        workspaceEvidencePaths: this.#spec.workspace_evidence_paths,
        workspaceEvidenceHashes: null,
      },
    };
  }

  async #artifactDebateDecide({ history, store, taskId, council, control, manifest, councilSynthesisRef, councilReportRefs, councilGateArgs, successfulReports, degraded }) {
    const roster = [...successfulReports]; // owner order, successful initial Council reporters (§12)
    const maxRounds = Math.min(council.debate.max_rounds ?? DEBATE_MAX_ROUNDS, DEBATE_MAX_ROUNDS);
    const chair = council.chair_profile_id;
    const task = store.openTaskById(taskId);
    const dstate = this.#artifactDebateStepsSoFar(history, { task, control, manifest, roster });

    for (let round = 1; round <= maxRounds; round += 1) {
      const r = dstate.rounds.get(round) ?? { round, brief: null, responses: new Map(), synthesis: null };
      const priorSynthRef = round === 1 ? councilSynthesisRef : dstate.rounds.get(round - 1).synthesis.sealed_ref;

      // ---- round brief ----
      if (!r.brief) {
        const inputRefs = round === 1
          ? [
            { label: `council-synthesis (${chair})`, reference: councilSynthesisRef },
            ...roster.map((id) => ({ label: `council-report (${id})`, reference: councilReportRefs.get(id) })),
          ]
          : [{ label: `prior debate synthesis (round ${round - 1})`, reference: priorSynthRef }];
        return this.#artifactDebateWorkflow(COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF, round, maxRounds, chair, {
          instructions: buildArtifactDebateBriefInstructions({
            ownerTask: this.#ownerTask, constraints: this.#constraints, round,
            priorSynthesisLabel: round === 1 ? 'the sealed Council synthesis and every successful Council report' : `the sealed round ${round - 1} Debate synthesis`,
          }),
          inputRefs,
          extraEvidence: await this.#artifactChairSourceEvidence(),
        });
      }
      if (!r.brief.ok) throw new CouncilOrchestrationError(`chair failed to prepare artifact Debate round ${round} brief: ${r.brief.failure_code ?? 'unknown'}`, 'COUNCIL_DEBATE_BRIEF_FAILED');

      // ---- round responses (owner order; NO same-round peer visibility §13) ----
      const nextResponse = roster.find((id) => !r.responses.has(id));
      if (nextResponse) {
        return this.#artifactDebateWorkflow(COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE, round, maxRounds, nextResponse, {
          instructions: buildArtifactDebateResponseInstructions({ ownerTask: this.#ownerTask, constraints: this.#constraints, round, participantProfileId: nextResponse }),
          inputRefs: [
            { label: round === 1 ? `council-synthesis (${chair})` : `prior debate synthesis (round ${round - 1})`, reference: priorSynthRef },
            { label: `debate brief (round ${round})`, reference: r.brief.sealed_ref },
          ],
          extraEvidence: await this.#artifactSourceEvidence(nextResponse),
        });
      }
      const successfulResponses = roster.filter((id) => r.responses.get(id)?.ok);
      if (successfulResponses.length === 0) throw new CouncilOrchestrationError(`all artifact Debate round ${round} responses failed`, 'COUNCIL_DEBATE_ALL_RESPONSES_FAILED');

      // ---- round synthesis ----
      if (!r.synthesis) {
        return this.#artifactDebateWorkflow(COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS, round, maxRounds, chair, {
          instructions: buildArtifactDebateSynthesisInstructions({ ownerTask: this.#ownerTask, constraints: this.#constraints, round, respondedProfileIds: successfulResponses }),
          inputRefs: [
            { label: round === 1 ? `council-synthesis (${chair})` : `prior debate synthesis (round ${round - 1})`, reference: priorSynthRef },
            { label: `debate brief (round ${round})`, reference: r.brief.sealed_ref },
            ...successfulResponses.map((id) => ({ label: `debate response (${id})`, reference: r.responses.get(id).sealed_ref })),
          ],
          extraEvidence: await this.#artifactChairSourceEvidence(),
        });
      }
      if (!r.synthesis.ok) throw new CouncilOrchestrationError(`chair failed to synthesize artifact Debate round ${round}: ${r.synthesis.failure_code ?? 'unknown'}`, 'COUNCIL_DEBATE_SYNTHESIS_FAILED');

      // ---- typed continuation (§29) — from the durable typed control, never prose ----
      const effective = evaluateEffectiveContinuation({ control: r.synthesis.typed_control, round, maxRounds, hardCap: DEBATE_MAX_ROUNDS });
      if (effective.effectiveContinue) {
        continue; // next turn re-derives and emits round+1's brief
      }

      // ---- STOP: this round's synthesis is the final Debate authority ----
      const builtRounds = [];
      for (let k = 1; k <= round; k += 1) {
        const rk = dstate.rounds.get(k) ?? r;
        builtRounds.push({ round: k, brief: rk.brief, responses: rk.responses, synthesis: rk.synthesis });
      }
      const gateArgs = {
        store, task: store.openTaskById(taskId), council, roster,
        aliasRegistry: this.#artifact.aliasRegistry, rounds: builtRounds, maxReportBytes: this.#artifact.maxReportBytes,
        // P20.5R R3/R4 — re-verify the FULL Council prerequisite from fresh
        // state and derive the authoritative roster from it.
        councilGateArgs: { ...councilGateArgs, task: store.openTaskById(taskId) },
      };
      const { finalRef, finalRound, engineForcedStop } = verifyDebateArtifactTopology(gateArgs);
      commitDebateFinalRef({ task: store.openTaskById(taskId), finalRef, finalRound });

      // §32 — final projection: exact re-verified Debate synthesis bytes, fail closed.
      if (this.#artifact.__beforeFinalProjection) this.#artifact.__beforeFinalProjection({ store, finalRef, taskId });
      let output;
      try {
        const verified = resolveAndVerifySealedReference({ store, reference: finalRef });
        output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verified.buffer);
      } catch (error) {
        throw new CouncilOrchestrationError(
          `artifact Debate final synthesis projection failed re-verification after the final gate: ${error.message}`,
          'COUNCIL_ARTIFACT_DEBATE_FINAL_PROJECTION_VERIFY_FAILED',
          { cause: error.code ?? null, finalRefSha256: finalRef?.sha256 ?? null },
        );
      }
      return {
        type: 'finish',
        output,
        data: {
          type: 'council_debate',
          transport_version: 'artifact_v1',
          final_ref: finalRef,
          chair_profile_id: chair,
          participant_profile_ids: council.participant_profile_ids,
          rounds: council.rounds,
          strategy: council.strategy,
          degraded,
          completed_participants: roster,
          failed_participants: council.participant_profile_ids.filter((id) => !roster.includes(id)),
          debate: {
            enabled: true,
            max_rounds: maxRounds,
            rounds_run: finalRound,
            final_continue_debate: effective.modelControlContinue,
            engine_forced_stop: engineForcedStop,
          },
        },
      };
    }
    /* c8 ignore next */
    throw new CouncilOrchestrationError('artifact Debate exceeded its bounded round cap without terminating', 'COUNCIL_ARTIFACT_DEBATE_ROUND_OVERRUN');
  }


  async #artifactDecide({ history }) {
    const debateEnabled = this.#spec.debate?.enabled === true;
    // P20.5 §25 / P20.5R R6 — the COMPLETE early Debate admission check runs
    // BEFORE the first Council provider call (before allocateTask): Chair +
    // every participant report delivery route + required artifact input
    // transport + Chair same-execution typed-control route (PROVEN) +
    // workspace/source policy for a READ council. Fail closed rather than
    // silently finishing as Council-only or spending any provider call.
    // P22.5 §A/§C/§D/§E — product-policy task-mode admission runs for
    // EVERY artifact Council, before any provider call. A plain (non-
    // Debate) Council checks the COUNCIL mode for every role;
    // `#assertArtifactDebateAdmission()` below checks the more specific
    // DEBATE_MEMBER/DEBATE_CHAIR modes instead when Debate is enabled —
    // never both (a `api` chair in a Debate must be rejected as a
    // DEBATE_CHAIR product-policy violation, not a generic COUNCIL one).
    if (debateEnabled) this.#assertArtifactDebateAdmission();
    else this.#assertArtifactCouncilAdmission();

    const { store, taskId, taskSlug, createdAt } = this.#artifact;
    const participants = this.#spec.participant_profile_ids;

    // P20.4R3 R13 (ordering) — bind the durable task + council_control and
    // fresh-validate the manifest BEFORE any PM-turn history handoff is
    // accepted. R4 — idempotent for an equal control; a reopened task_id with a
    // changed roster/order/rounds/chair (R12/R15/R16/R17) fails closed here,
    // before any stage / provider call. The first pristine turn still works:
    // allocate/reopen -> bindCouncilControl -> history empty -> chair_plan.
    const task = store.allocateTask({
      taskId, taskSlug, createdAt, mode: 'council',
      chairProfileId: this.#spec.chair_profile_id,
      participantProfileIds: [...participants],
      admittedCapabilitySnapshot: this.#artifact.admittedCapabilitySnapshot,
      sourceRevision: this.#artifact.sourceRevision,
      workspaceId: this.#artifact.workspaceId,
    });
    task.bindCouncilControl({
      control: buildCouncilArtifactControl(this.#spec),
      topLevel: {
        chairProfileId: this.#spec.chair_profile_id,
        participantProfileIds: [...participants],
        admittedCapabilitySnapshot: this.#artifact.admittedCapabilitySnapshot,
        sourceRevision: this.#artifact.sourceRevision,
        workspaceId: this.#artifact.workspaceId,
      },
    });
    // Fresh-read + re-validate the just-bound manifest (R15/R16 fail closed on
    // read) and require a valid persisted control before trusting any history.
    const manifest = task.freshManifest();
    const control = manifest.council_control;
    const cv = validateCouncilArtifactControl(control);
    if (!control || !cv.ok) {
      throw new CouncilOrchestrationError(
        `artifact Council task ${JSON.stringify(taskId)} has no valid persisted council_control after bind: ${(cv?.errors ?? ['missing']).join('; ')}`,
        'COUNCIL_ARTIFACT_CONTROL_UNAVAILABLE',
      );
    }

    const steps = this.#artifactStepsSoFar(history, { task, control, manifest });

    // ---- chair plan ----
    if (!steps.chairPlan) {
      return this.#artifactWorkflow(COUNCIL_STEP_KINDS.CHAIR_PLAN, this.#spec.chair_profile_id, {
        instructions: buildArtifactChairPlanInstructions({
          ownerTask: this.#ownerTask, constraints: this.#constraints,
          participantProfileIds: participants, implementationParticipantId: this.#spec.implementation_participant_id,
        }),
        extraEvidence: await this.#artifactChairSourceEvidence(),
      });
    }
    if (!steps.chairPlan.ok) {
      throw new CouncilOrchestrationError(`chair failed to plan the artifact council: ${steps.chairPlan.failure_code ?? 'unknown'}`, 'COUNCIL_CHAIR_PLAN_FAILED');
    }
    const chairPlanRef = steps.chairPlan.sealed_ref;

    // ---- participant reports (owner order) ----
    const nextReport = participants.find((id) => !steps.reports.has(id));
    if (nextReport) {
      return this.#artifactWorkflow(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT, nextReport, {
        instructions: buildArtifactParticipantReportInstructions({
          ownerTask: this.#ownerTask, constraints: this.#constraints, participantProfileId: nextReport,
          isImplementationParticipant: this.#spec.implementation_participant_id === nextReport,
        }),
        inputRefs: [{ label: `chair-plan (${this.#spec.chair_profile_id})`, reference: chairPlanRef }],
        isImplementationParticipant: this.#spec.implementation_participant_id === nextReport,
        extraEvidence: await this.#artifactSourceEvidence(nextReport),
      });
    }

    const successfulReports = participants.filter((id) => steps.reports.get(id)?.ok);
    if (successfulReports.length === 0) {
      throw new CouncilOrchestrationError('all artifact council participants failed round 1', 'COUNCIL_ALL_PARTICIPANTS_FAILED');
    }
    const degraded = successfulReports.length < participants.length;

    // ---- critiques (rounds >= 2, successful reports only) ----
    if (this.#spec.rounds >= 2) {
      const nextCritique = successfulReports.find((id) => !steps.critiques.has(id));
      if (nextCritique) {
        const peerIds = successfulReports.filter((id) => id !== nextCritique);
        return this.#artifactWorkflow(COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE, nextCritique, {
          instructions: buildArtifactParticipantCritiqueInstructions({
            ownerTask: this.#ownerTask, constraints: this.#constraints, participantProfileId: nextCritique, peerProfileIds: peerIds,
          }),
          inputRefs: [
            { label: `chair-plan (${this.#spec.chair_profile_id})`, reference: chairPlanRef },
            { label: `own report (${nextCritique})`, reference: steps.reports.get(nextCritique).sealed_ref },
            ...peerIds.map((id) => ({ label: `peer report (${id})`, reference: steps.reports.get(id).sealed_ref })),
          ],
          extraEvidence: await this.#artifactSourceEvidence(nextCritique),
        });
      }
    }
    const successfulCritiques = participants.filter((id) => steps.critiques.get(id)?.ok);

    // ---- chair synthesis ----
    if (!steps.synthesis) {
      const failureFacts = participants
        .filter((id) => !steps.reports.get(id)?.ok)
        .map((id) => ({ profileId: id, reason: steps.reports.get(id)?.failure_code ?? 'no report' }));
      return this.#artifactWorkflow(COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS, this.#spec.chair_profile_id, {
        instructions: buildArtifactChairSynthesisInstructions({
          ownerTask: this.#ownerTask, constraints: this.#constraints,
          successfulReportProfileIds: successfulReports,
          successfulCritiqueProfileIds: successfulCritiques,
          failureFacts, degraded,
        }),
        inputRefs: [
          { label: `chair-plan (${this.#spec.chair_profile_id})`, reference: chairPlanRef },
          ...successfulReports.map((id) => ({ label: `report (${id})`, reference: steps.reports.get(id).sealed_ref })),
          ...successfulCritiques.map((id) => ({ label: `critique (${id})`, reference: steps.critiques.get(id).sealed_ref })),
        ],
        extraEvidence: await this.#artifactChairSourceEvidence(),
      });
    }
    if (!steps.synthesis.ok) {
      throw new CouncilOrchestrationError(`chair failed to synthesize the artifact council: ${steps.synthesis.failure_code ?? 'unknown'}`, 'COUNCIL_SYNTHESIS_FAILED');
    }

    // ---- FINAL: Council Artifact topology from DURABLE history + control ----
    const stageKeyPlan = {
      chairPlan: councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_PLAN }),
      reports: participants.map((id) => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias: this.#aliasOf(id) })),
      critiques: this.#spec.rounds >= 2 ? participants.map((id) => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, actorAlias: this.#aliasOf(id) })) : [],
      synthesis: councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS }),
    };
    const reportOutcomes = new Map(participants.map((id) => [id, steps.reports.get(id) ?? null]));
    const critiqueOutcomes = new Map(participants.map((id) => [id, steps.critiques.get(id) ?? null]));
    const councilGateArgs = {
      store, task: store.openTaskById(taskId),
      chairPlanOutcome: steps.chairPlan, reportOutcomes, critiqueOutcomes, synthesisOutcome: steps.synthesis,
      council: this.#spec, stageKeyPlan, participants, maxReportBytes: this.#artifact.maxReportBytes,
      aliasRegistry: this.#artifact.aliasRegistry,
    };

    // §15/§46 — Debate enabled: VERIFY the Council prerequisite topology
    // WITHOUT completing the task / committing final_ref, then enter the
    // durable Debate orchestration. final_ref becomes the final Debate
    // synthesis (never the Council synthesis).
    if (debateEnabled) {
      verifyCouncilArtifactTopology(councilGateArgs);
      return await this.#artifactDebateDecide({
        history,
        store, taskId,
        council: this.#spec, control, manifest,
        councilSynthesisRef: steps.synthesis.sealed_ref,
        councilReportRefs: new Map(successfulReports.map((id) => [id, steps.reports.get(id).sealed_ref])),
        councilGateArgs,
        successfulReports, degraded,
      });
    }

    const finalRef = runCouncilFinalArtifactGate(councilGateArgs);

    // §25/§30 / P20.4R2 R11 — output is the EXACT verified synthesis bytes.
    // The projection RE-VERIFIES the sealed final ref (consumer preflight —
    // catches a post-final-gate corruption / reparse / hash drift) and
    // strict-UTF-8 decodes. A verification/decode failure FAILS CLOSED with a
    // typed error — DurablePmRuntime does NOT commit a normal FINISH, and
    // there is NO catch-all "sealed as final_ref …" success fallback.
    if (this.#artifact.__beforeFinalProjection) {
      this.#artifact.__beforeFinalProjection({ store, finalRef, taskId });
    }
    let output;
    try {
      const verified = resolveAndVerifySealedReference({ store, reference: finalRef });
      output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verified.buffer);
    } catch (error) {
      throw new CouncilOrchestrationError(
        `artifact Council final synthesis projection failed re-verification after the final gate: ${error.message}`,
        'COUNCIL_ARTIFACT_FINAL_PROJECTION_VERIFY_FAILED',
        { cause: error.code ?? null, finalRefSha256: finalRef?.sha256 ?? null },
      );
    }

    return {
      type: 'finish',
      output,
      data: {
        type: 'council',
        transport_version: 'artifact_v1',
        final_ref: finalRef,
        chair_profile_id: this.#spec.chair_profile_id,
        participant_profile_ids: participants,
        rounds: this.#spec.rounds,
        strategy: this.#spec.strategy,
        degraded,
        completed_participants: successfulReports,
        failed_participants: participants.filter((id) => !steps.reports.get(id)?.ok),
        completed_critiques: successfulCritiques,
      },
    };
  }
}
