/**
 * P20.4 — the `artifact_v1` Council orchestrator.
 *
 * Authority: docs/P20/P20_4_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §5–§40,
 * docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md.
 *
 * ADDITIVE, versioned Council report-content plane. It reuses ALL P20.3
 * authority primitives (resolveAndVerifySealedReference, commitInvocationSeal
 * via completeReportArtifact, reconstructSealedStageRef, validateStageSealEntry,
 * TaskWorkspace.openInvocationById / commitStageSeal / commitFinalRef) and the
 * artifact store's own durable locking + crash recovery. It drives the SAME
 * deterministic, app-owned Council topology CouncilChairDriver.decide() uses
 * (chair_plan -> reports in owner order -> critiques for successful reports
 * when rounds>=2 -> chair synthesis) but as a straight-line async sequence
 * over report stages, NOT a decide()/parseDecision() turn loop.
 *
 * Report prose NEVER enters parseDecision / acceptPmOutput / canonicalizer /
 * validateStepData / semantic repair. This module imports none of them.
 *
 * Debate (`debate.enabled === true`) fails closed BEFORE any stage with a
 * typed P20.5-required error and ZERO Debate backend invocation (task §7/§40).
 *
 * No live model/API calls — the caller supplies deterministic report
 * backends. Every stage is idempotent from disk: a pre-existing SEALED stage
 * is reused (RECOVERED_FROM_SEAL), never re-executed.
 */

import { randomUUID } from 'node:crypto';

import { ARTIFACT_ROLE, ARTIFACT_STAGE, deriveActorAlias } from '../../artifacts/artifact-paths.mjs';
import { INPUT_TRANSPORT } from '../../artifacts/artifact-schema.mjs';
import { ReportInvoker } from '../report-invocation.mjs';
import { completeReportArtifact } from '../report-stage-completion.mjs';
import { reconstructSealedStageRef, resolveAndVerifySealedReference, reconcileFailedInvocation } from '../../artifacts/artifact-recovery.mjs';
import { TERMINAL_STATE } from '../report-backend-result.mjs';
import { prepareArtifactInputs, renderPreparedInputs } from '../../artifacts/artifact-input-transport.mjs';
import { validateStageSealEntry } from '../../artifacts/artifact-schema.mjs';
import { councilStageKey, councilStageKeyPlan, councilFinalStageKey } from './council-artifact-stage-keys.mjs';
import {
  buildArtifactStepSuccess,
  buildArtifactStepFailure,
  COUNCIL_STEP_EXECUTION_STATE,
  COUNCIL_ARTIFACT_STEP_KINDS,
  assertCouncilArtifactStepBinding,
} from './council-artifact-step-outcome.mjs';
import {
  buildArtifactChairPlanInstructions,
  buildArtifactParticipantReportInstructions,
  buildArtifactParticipantCritiqueInstructions,
  buildArtifactChairSynthesisInstructions,
} from './council-artifact-prompts.mjs';
import { assertCouncilControlMatch, validateCouncilArtifactControl, buildCouncilArtifactControl } from './council-artifact-control.mjs';
import { expectedCouncilArtifactStepIdentity } from './council-artifact-step-identity.mjs';
import { debateStageKey, debateStageInvocationId, debateFinalStageKey, parseDebateStageKey, DEBATE_STAGE_ROLE } from './debate-artifact-keys.mjs';
import {
  captureDebateContinuationFromResult,
  validateDebateContinuationControlBinding,
  evaluateEffectiveContinuation,
} from '../../artifacts/debate-continuation-control.mjs';
import { assertDebateTypedControlAdmitted } from './debate-backend-capability.mjs';
import { expectedDebateArtifactStepIdentity } from './council-artifact-step-identity.mjs';
import { DEBATE_MAX_ROUNDS } from './council-contracts.mjs';

export class CouncilArtifactOrchestrationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CouncilArtifactOrchestrationError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const STEP_KIND_FOR_STAGE = Object.freeze({
  [ARTIFACT_STAGE.CHAIR_PLAN]: COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_PLAN,
  [ARTIFACT_STAGE.PARTICIPANT_REPORT]: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT,
  [ARTIFACT_STAGE.PARTICIPANT_CRITIQUE]: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE,
  [ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS]: COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_SYNTHESIS,
});
const ROLE_FOR_STAGE = Object.freeze({
  [ARTIFACT_STAGE.CHAIR_PLAN]: ARTIFACT_ROLE.CHAIR,
  [ARTIFACT_STAGE.PARTICIPANT_REPORT]: ARTIFACT_ROLE.MEMBER,
  [ARTIFACT_STAGE.PARTICIPANT_CRITIQUE]: ARTIFACT_ROLE.MEMBER,
  [ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS]: ARTIFACT_ROLE.CHAIR,
});

const DEFAULT_CLOCK = () => new Date().toISOString();

/** Deterministic, model-text-free invocation id for one Council artifact stage. */
export function councilStageInvocationId({ taskId, artifactStage, actorAlias = null }) {
  const suffix = actorAlias ? `:${actorAlias}` : '';
  return `council:${taskId}:${artifactStage}${suffix}`;
}

function aliasFor(aliasRegistry, profileId) {
  if (aliasRegistry && typeof aliasRegistry.get === 'function' && aliasRegistry.get(profileId)) {
    return aliasRegistry.get(profileId);
  }
  return deriveActorAlias(profileId);
}

/**
 * Run one Council artifact report stage. Idempotent from disk: a pre-existing
 * SEALED invocation for this deterministic id is reused (RECOVERED_FROM_SEAL,
 * NO provider replay); a DELIVERED-but-unsealed invocation is completed from
 * disk (gate + seal, NO provider replay); any other ambiguous prior state is
 * reported RECONCILED_NO_REPLAY.
 *
 * @returns {object} an artifact_v1 Council step outcome
 */
export async function runCouncilArtifactStage({
  store, task, taskId, createdAt,
  artifactStage, profileId, actorAlias, backend,
  reportBackend, capabilityPolicy, consumerInputTransport,
  instructions, inputReferences = [], extraEvidence = [], maxReportBytes, clock = DEFAULT_CLOCK,
  executionCapable = false,
  reportInvoker = new ReportInvoker(),
  // P24.3C-R1 — optional durable per-invocation task-workspace evidence
  // (task-execution-context.mjs's `resolveTaskWorkspaceBinding()` shape).
  // `null` for every legacy/non-isolated council — byte-for-byte unaffected.
  workspaceEvidence = null,
  // TEST-ONLY, DI-only fault-injection seam (P20.4R2 R10 A/C/G). No behaviour
  // when omitted. Never sourced from config / model text. When it returns
  // 'STOP_BEFORE_SEAL' the stage stops AFTER ReportInvocation delivery
  // (invocation is genuinely DELIVERED on disk: report.md + executive.log,
  // NO seal) and BEFORE completeReportArtifact() — used to construct a real
  // DELIVERED-before-seal durable crash state. It does not weaken any
  // production error handling.
  __afterDeliverHook = null,
}) {
  const stepKind = STEP_KIND_FOR_STAGE[artifactStage];
  const role = ROLE_FOR_STAGE[artifactStage];
  const isPerParticipant = artifactStage === ARTIFACT_STAGE.PARTICIPANT_REPORT || artifactStage === ARTIFACT_STAGE.PARTICIPANT_CRITIQUE;
  const stageKey = councilStageKey({ artifactStage, actorAlias: isPerParticipant ? actorAlias : null });
  const invocationId = councilStageInvocationId({ taskId, artifactStage, actorAlias: isPerParticipant ? actorAlias : null });
  const fail = (failureCode, reason, executionState = COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED) =>
    buildArtifactStepFailure({ stepKind, artifactStage, stageKey, profileId, actorAlias, failureCode, reason, executionState });

  // ---- 1. Recovery: is this stage already durably resolved on disk? --------
  // P20.4R R8: discriminate typed durable-store errors. ONLY a genuine
  // "record missing" lets a fresh allocation proceed; a corrupt record,
  // store/project/schema mismatch, path/reparse failure, or any other
  // authority error FAILS CLOSED with ZERO provider call.
  let existingInv = null;
  try {
    existingInv = task.openInvocationById(invocationId);
  } catch (error) {
    if (error?.code === 'ARTIFACT_INVOCATION_RECORD_MISSING' || error?.code === 'ARTIFACT_INVOCATION_ID_MISSING') {
      existingInv = null; // genuine not-found — fresh allocation may proceed
    } else {
      return fail('COUNCIL_ARTIFACT_STAGE_INVOCATION_OPEN_FAILED', `${error?.code ?? 'ARTIFACT_INVOCATION_OPEN_ERROR'}: ${error.message}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
    }
  }
  if (existingInv) {
    let rec;
    try { rec = existingInv.freshRecord(); } catch (error) {
      return fail('COUNCIL_ARTIFACT_STAGE_RECORD_CORRUPT', `${error?.code ?? 'ARTIFACT_INVOCATION_RECORD_CORRUPT'}: ${error.message}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
    }
    // R8: fail closed if the resolved record is not bound to this store/task.
    if (rec.store_id !== store.storeId || rec.project_id !== store.projectId || rec.task_id !== task.taskId) {
      return fail('COUNCIL_ARTIFACT_STAGE_IDENTITY_MISMATCH', `resolved invocation ${JSON.stringify(invocationId)} store/project/task identity does not match`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
    }
    if (rec.lifecycle === 'SEALED') {
      try {
        const sealedRef = reconstructSealedStageRef({ store, task, invocation: existingInv, stageKey });
        return buildArtifactStepSuccess({ stepKind, artifactStage, stageKey, profileId, actorAlias, sealedRef, executionState: COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL });
      } catch (error) {
        return fail('COUNCIL_ARTIFACT_STAGE_RECOVERY_FAILED', error.message);
      }
    }
    if (rec.lifecycle === 'DELIVERED') {
      // Crash between DELIVERED and SEALED — complete from disk, NO provider.
      // P20.4R R3: the physical execution id is on the ATTEMPT's artifact.json,
      // never invocation.json. Derive the authoritative attempt from the
      // validated record (latest_attempt_ordinal / attempts[]), fresh-read
      // its artifact.json, and bind the REAL execution_id — the Invocation
      // Artifact Gate must not have execution identity weakened to hide this.
      const ordinal = Number.isInteger(rec.latest_attempt_ordinal)
        ? rec.latest_attempt_ordinal
        : (Array.isArray(rec.attempts) && rec.attempts.length ? rec.attempts[rec.attempts.length - 1] : 0);
      let recoveredExecutionId;
      try {
        const meta = existingInv.freshAttemptMetadata(ordinal);
        recoveredExecutionId = meta.execution_id;
        if (typeof recoveredExecutionId !== 'string' || !recoveredExecutionId) {
          throw new CouncilArtifactOrchestrationError(`attempt-${ordinal} artifact.json has no execution_id`, 'COUNCIL_ARTIFACT_STAGE_NO_EXECUTION_ID');
        }
      } catch (error) {
        return fail(error?.code ?? 'COUNCIL_ARTIFACT_STAGE_RECOVERY_METADATA_FAILED', error.message);
      }
      try {
        // P20.8R2 §5/§6 — `deliveryMechanism`/`directWriter` come from the
        // SAME `resolveReportBackend(profileId)` result every fresh stage
        // uses (never a second policy source) — see the fresh-run path
        // below for the full rationale. Defaults preserve the exact P20.8
        // VERBATIM_MATERIALIZATION behavior for any caller whose
        // `reportBackend` predates these fields.
        const done = await completeReportArtifact({
          store, task, invocation: existingInv, attemptOrdinal: ordinal, stageKey,
          expected: expectedIdentity({ store, taskId, invocationId, role, artifactStage, profileId, actorAlias, backend, executionId: recoveredExecutionId }),
          capabilityPolicy, inputTransport: consumerInputTransport ?? null, maxReportBytes, now: clock,
          deliveryMechanism: reportBackend?.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION',
          directWriter: reportBackend?.deliveryMechanism === 'DIRECT_WRITE' ? (reportBackend?.directWriter ?? null) : null,
          reportBackend, // only used if a bounded repair is needed
        });
        return buildArtifactStepSuccess({
          stepKind, artifactStage, stageKey, profileId, actorAlias,
          sealedRef: done.sealedReference, executionState: COUNCIL_STEP_EXECUTION_STATE.SEALED,
          repair: { repaired: done.repaired, repairKind: done.repairKind },
        });
      } catch (error) {
        return fail('COUNCIL_ARTIFACT_STAGE_COMPLETE_FROM_DISK_FAILED', error.message);
      }
    }
    if (rec.lifecycle === 'FAILED' || rec.lifecycle === 'CANCELLED') {
      return fail(`COUNCIL_ARTIFACT_STAGE_${rec.lifecycle}`, rec.integrity_state ?? rec.lifecycle, COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED);
    }
    // ASSIGNED / RUNNING — the process died mid-stage; never blindly replay.
    return fail('COUNCIL_ARTIFACT_STAGE_AMBIGUOUS_NO_DURABLE_OUTCOME', `invocation lifecycle ${rec.lifecycle} after restart`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
  }

  // ---- 2. Fresh run ------------------------------------------------------
  // P20.4R R7: the owner-designated implementation participant's
  // participant_report may carry the existing execution capability. If the
  // resolved artifact report backend route cannot safely support it, FAIL
  // CLOSED BEFORE the provider call — never silently downgrade to read-only.
  // Generic `executionCapable` is NOT proof of DIRECT_WRITE / NATIVE read.
  if (executionCapable === true) {
    if (artifactStage !== ARTIFACT_STAGE.PARTICIPANT_REPORT) {
      return fail('COUNCIL_ARTIFACT_EXECUTION_CAPABILITY_STAGE_FORBIDDEN', `execution capability is only valid for participant_report, not ${artifactStage}`);
    }
    if (reportBackend?.supportsExecutionCapability !== true) {
      return fail('COUNCIL_ARTIFACT_IMPLEMENTATION_ROUTE_UNSUPPORTED', `report backend ${JSON.stringify(backend)} route does not support the required implementation execution capability`);
    }
  }
  // P20.8R2 §5/§6 — the delivery route is an exact-profile fact resolved
  // by `resolveReportBackend(profileId)` (p20-report-route-resolution.mjs)
  // — never hardcoded here, never inferred from stage/task content. Every
  // caller whose `reportBackend` predates these fields (offline P20.4
  // tests, the fake backends they use) falls back to the exact prior
  // literal `'VERBATIM_MATERIALIZATION'`, byte-for-byte unchanged.
  const deliveryMechanism = reportBackend?.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION';
  const directWriter = deliveryMechanism === 'DIRECT_WRITE' ? (reportBackend?.directWriter ?? null) : null;
  const executionId = `exec-${randomUUID()}`;
  let invocation;
  let attempt;
  try {
    invocation = task.allocateInvocation({ invocationId, role, stage: artifactStage, profileId, actorAlias });
    attempt = invocation.allocateAttempt({ deliveryMechanism, inputTransport: consumerInputTransport ?? null, startedAt: clock(), executionId });
  } catch (error) {
    // R8: a corrupt / binding-mismatched existing invocation record is an
    // authority failure — fail closed, never replay a provider call.
    const noReplay = error?.code === 'ARTIFACT_INVOCATION_RECORD_CORRUPT'
      || error?.code === 'ARTIFACT_INVOCATION_BINDING_MISMATCH'
      || error?.code === 'ARTIFACT_INVOCATION_RECORD_INVALID';
    return fail(
      noReplay ? `COUNCIL_ARTIFACT_STAGE_${error.code}` : 'COUNCIL_ARTIFACT_STAGE_ALLOCATION_FAILED',
      error.message,
      noReplay ? COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY : COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED,
    );
  }

  // §24 — resolve + verify every sealed input BEFORE the expensive call.
  let prepared = null;
  let evidence = [];
  let renderedInstructions = instructions;
  if (inputReferences.length) {
    try {
      // P20.8R4: `requestedDelivery` is this stage's own already-resolved
      // `deliveryMechanism` (from `resolveReportBackend(profileId)` — see
      // its declaration above), never a hard-coded literal. Previously
      // hard-coded to `'VERBATIM_MATERIALIZATION'` here, this fed a stale
      // delivery fact into the exact-tuple capability check while the
      // participant's real report call already used DIRECT_WRITE
      // (P20.8R2+) — causing input preflight to fail closed with
      // `ARTIFACT_REPORT_DELIVERY_UNPROVEN` before the provider was ever
      // spawned (docs/P20/P20_8R4_DIRECT_WRITE_INPUT_PREFLIGHT_ROUTE_FIX_MASTER_PROMPT.md).
      prepared = prepareArtifactInputs({
        store, consumerBackend: backend, capabilityPolicy,
        requestedInputTransport: consumerInputTransport ?? INPUT_TRANSPORT.VERBATIM_CONTENT,
        requestedDelivery: deliveryMechanism,
        references: inputReferences,
      });
    } catch (error) {
      return fail(error.code ?? 'COUNCIL_ARTIFACT_INPUT_PREP_FAILED', error.message);
    }
    const r = renderPreparedInputs(prepared);
    evidence = r.evidence;
    if (r.trustedRefBlock) renderedInstructions = `${instructions}\n\n${r.trustedRefBlock}`;
  }
  // P20.4R R6: workspace_requirement:READ source evidence is provided as
  // COMPLETE UNTRUSTED SOURCE EVIDENCE — the admitted/redacted packet is
  // built by the existing council-workspace subsystem (the caller), never by
  // this module, and it is prepended before the sealed-artifact evidence so
  // input ordering stays deterministic.
  if (Array.isArray(extraEvidence) && extraEvidence.length) {
    evidence = [...extraEvidence.map((e) => ({ label: e.label, content: e.content })), ...evidence];
  }

  const request = {
    store, task, invocation, attempt,
    taskId, stage: artifactStage, role, round: null,
    profileId, backend, actorAlias, executionId,
    deliveryMechanism,
    inputTransport: inputReferences.length ? (consumerInputTransport ?? INPUT_TRANSPORT.VERBATIM_CONTENT) : null,
    capabilityPolicy,
    instructions: renderedInstructions,
    evidence,
    // Artifact report DELIVERY permission is always READ_ONLY and stays
    // SEPARATE from source execution permission. Only the typed
    // `executionCapable` fact (validated above) propagates. P20.8R2 §6:
    // for DIRECT_WRITE, ReportInvoker requires `request.directWriter` —
    // the shared stateless confirmer off `reportBackend` (never a writer
    // this module constructs itself — DSH does not write report content).
    sourceWritePolicy: 'READ_ONLY',
    executionCapable: executionCapable === true,
    directWriter,
    workspaceEvidence,
  };

  try {
    await reportInvoker.invokeReport({ request, reportBackend });
  } catch (error) {
    // A known non-success terminal result / a thrown provider error leaves the
    // invocation at RUNNING. Settle it DURABLY (never left ambiguous) so a
    // later restart sees a definitive FAILED lifecycle and does not replay.
    const KNOWN = new Set([TERMINAL_STATE.TIMEOUT, TERMINAL_STATE.CANCELLED, TERMINAL_STATE.PROVIDER_ERROR, TERMINAL_STATE.PROCESS_ERROR, TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE]);
    const terminalState = KNOWN.has(error?.terminalState) ? error.terminalState : 'UNKNOWN_OUTCOME';
    try { reconcileFailedInvocation({ invocation, terminalState, reason: error.code ?? error.message }); } catch { /* already settled/sealed — leave it */ }
    return fail(error.code ?? 'COUNCIL_ARTIFACT_STAGE_EXECUTION_FAILED', error.message);
  }

  // TEST-ONLY seam (R10 A/C/G): the invocation is now genuinely DELIVERED on
  // disk (report.md + executive.log written, lifecycle DELIVERED) and NOT
  // sealed. Stop here — the caller then constructs the durable crash state.
  if (typeof __afterDeliverHook === 'function') {
    let signal = null;
    try { signal = __afterDeliverHook({ artifactStage, profileId, invocationId, attemptOrdinal: attempt.ordinal }); } catch { signal = null; }
    if (signal === 'STOP_BEFORE_SEAL') {
      const e = new CouncilArtifactOrchestrationError('test seam: stopped after ReportInvocation delivery, before completeReportArtifact()', 'COUNCIL_ARTIFACT_TEST_STOP_BEFORE_SEAL', { invocationId, artifactStage });
      e.__p20TestStopBeforeSeal = true;
      throw e;
    }
  }

  try {
    const done = await completeReportArtifact({
      store, task, invocation, attemptOrdinal: attempt.ordinal, stageKey,
      expected: expectedIdentity({ store, taskId, invocationId, role, artifactStage, profileId, actorAlias, backend, executionId }),
      capabilityPolicy, inputTransport: request.inputTransport, maxReportBytes, now: clock,
      deliveryMechanism, reportBackend, directWriter,
    });
    return buildArtifactStepSuccess({
      stepKind, artifactStage, stageKey, profileId, actorAlias,
      sealedRef: done.sealedReference, executionState: COUNCIL_STEP_EXECUTION_STATE.SEALED,
      repair: { repaired: done.repaired, repairKind: done.repairKind },
    });
  } catch (error) {
    return fail(error.code ?? 'COUNCIL_ARTIFACT_STAGE_SEAL_FAILED', error.message);
  }
}

function expectedIdentity({ store, taskId, invocationId, role, artifactStage, profileId, actorAlias, backend, executionId, round = null }) {
  return {
    storeId: store.storeId, projectId: store.projectId, taskId, invocationId,
    role, stage: artifactStage, round, profileId, actorAlias, executionId, backend,
  };
}

// ---- P20.5 — round-scoped Debate artifact report stage --------------------

const DEBATE_STEP_KIND_FOR_STAGE = Object.freeze({
  [ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF]: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF,
  [ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE]: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE,
  [ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS]: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS,
});

/**
 * P20.5 §14/§21/§26 — run ONE round-scoped Debate artifact report stage. Same
 * sealed-report lifecycle + recovery discipline as `runCouncilArtifactStage`,
 * plus:
 *   - every stage is reasoning-only: `executionCapable` is FORCED false (§12)
 *   - `debate-chair-synthesis` additionally captures the SEPARATE typed
 *     `continue_debate` machine control FROM THE SAME execution (§7/§24),
 *     persists it durably to `invocation.json` bound to the sealed attempt
 *     (§20), and returns it on the outcome
 *   - recovery of a DELIVERED/SEALED synthesis with NO durable typed control
 *     FAILS CLOSED (RECONCILED_NO_REPLAY) — it NEVER infers continuation from
 *     report.md (§21/§39-M)
 *
 * @returns {object} an artifact_v1 Debate step outcome (adds `typed_control`
 *   for a successful synthesis)
 */
export async function runDebateArtifactStage({
  store, task, taskId, createdAt,
  round, maxRounds, artifactStage, profileId, actorAlias, backend,
  reportBackend, capabilityPolicy, consumerInputTransport,
  instructions, inputReferences = [], extraEvidence = [], maxReportBytes, clock = DEFAULT_CLOCK,
  reportInvoker = new ReportInvoker(),
  // P24.3C-R1 — same optional durable per-invocation task-workspace evidence
  // as runCouncilArtifactStage() above; `null` for every legacy/non-isolated
  // Debate round — byte-for-byte unaffected.
  workspaceEvidence = null,
  __afterDeliverHook = null,
  __beforeSynthesisControlPersistHook = null,
}) {
  const stepKind = DEBATE_STEP_KIND_FOR_STAGE[artifactStage];
  const role = DEBATE_STAGE_ROLE[artifactStage];
  const isSynthesis = artifactStage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS;
  const isResponse = artifactStage === ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE;
  if (!stepKind || !role) {
    throw new CouncilArtifactOrchestrationError(`not a Debate artifact stage: ${JSON.stringify(artifactStage)}`, 'DEBATE_ARTIFACT_STAGE_UNKNOWN', { artifactStage });
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new CouncilArtifactOrchestrationError(`Debate stage requires an integer round, got ${JSON.stringify(round)}`, 'DEBATE_ARTIFACT_STAGE_BAD_ROUND', { round });
  }
  // P23.2 §3/§10G — the app-owned Debate round ceiling MUST be supplied by the
  // caller (the SAME `maxRounds` the engine's own round loop computed from
  // `council.debate.max_rounds`, capped at DEBATE_MAX_ROUNDS — never a second,
  // independently-derived value). Fail closed rather than silently inventing
  // a default: an unresolved ceiling must never surface a made-up "2" to the
  // trusted prompt.
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > DEBATE_MAX_ROUNDS) {
    throw new CouncilArtifactOrchestrationError(`Debate stage requires a valid app-owned maxRounds (1..${DEBATE_MAX_ROUNDS}), got ${JSON.stringify(maxRounds)}`, 'DEBATE_ARTIFACT_STAGE_BAD_MAX_ROUNDS', { maxRounds });
  }
  if (round > maxRounds) {
    throw new CouncilArtifactOrchestrationError(`Debate stage round ${round} exceeds its own maxRounds ${maxRounds}`, 'DEBATE_ARTIFACT_STAGE_ROUND_EXCEEDS_MAX_ROUNDS', { round, maxRounds });
  }
  const stageKey = debateStageKey({ artifactStage, round, actorAlias: isResponse ? actorAlias : null });
  const invocationId = debateStageInvocationId({ taskId, round, artifactStage, actorAlias: isResponse ? actorAlias : null });
  const fail = (failureCode, reason, executionState = COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED) =>
    buildArtifactStepFailure({ stepKind, artifactStage, stageKey, round, profileId, actorAlias, failureCode, reason, executionState });
  const succeed = (sealedRef, executionState, { repaired = false, repairKind = null } = {}, typedControl = null) => {
    const outcome = buildArtifactStepSuccess({ stepKind, artifactStage, stageKey, round, profileId, actorAlias, sealedRef, executionState, repair: { repaired, repairKind } });
    return isSynthesis ? Object.freeze({ ...outcome, typed_control: typedControl }) : outcome;
  };
  const expected = ({ executionId }) => expectedIdentity({ store, taskId, invocationId, role, artifactStage, profileId, actorAlias, backend, executionId, round });

  // ---- 1. Recovery ------------------------------------------------------
  let existingInv = null;
  try {
    existingInv = task.openInvocationById(invocationId);
  } catch (error) {
    if (error?.code === 'ARTIFACT_INVOCATION_RECORD_MISSING' || error?.code === 'ARTIFACT_INVOCATION_ID_MISSING') existingInv = null;
    else return fail('DEBATE_ARTIFACT_STAGE_INVOCATION_OPEN_FAILED', `${error?.code ?? 'ARTIFACT_INVOCATION_OPEN_ERROR'}: ${error.message}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
  }
  if (existingInv) {
    let rec;
    try { rec = existingInv.freshRecord(); } catch (error) {
      return fail('DEBATE_ARTIFACT_STAGE_RECORD_CORRUPT', `${error?.code ?? 'ARTIFACT_INVOCATION_RECORD_CORRUPT'}: ${error.message}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
    }
    if (rec.store_id !== store.storeId || rec.project_id !== store.projectId || rec.task_id !== task.taskId || (rec.round ?? null) !== round) {
      return fail('DEBATE_ARTIFACT_STAGE_IDENTITY_MISMATCH', `resolved invocation ${JSON.stringify(invocationId)} identity/round does not match`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
    }
    if (rec.lifecycle === 'SEALED' || rec.lifecycle === 'DELIVERED') {
      // §21/§M — a synthesis whose report is durably DELIVERED/SEALED MUST have
      // a durable, bound typed control; otherwise fail closed with ZERO replay.
      let typedControl = null;
      if (isSynthesis) {
        try { typedControl = existingInv.freshDebateContinuationControl(); } catch (error) {
          return fail('DEBATE_ARTIFACT_SYNTHESIS_CONTROL_CORRUPT', `${error?.code ?? 'ARTIFACT_DEBATE_CONTROL_CORRUPT'}: ${error.message}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
        }
        if (!typedControl) {
          return fail('DEBATE_ARTIFACT_SYNTHESIS_CONTROL_MISSING', 'the Debate synthesis report is durable but no typed continuation control was captured; refusing to infer continuation', COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
        }
      }
      if (rec.lifecycle === 'SEALED') {
        try {
          const sealedRef = reconstructSealedStageRef({ store, task, invocation: existingInv, stageKey });
          return succeed(sealedRef, COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL, {}, typedControl);
        } catch (error) {
          return fail('DEBATE_ARTIFACT_STAGE_RECOVERY_FAILED', error.message);
        }
      }
      // DELIVERED — complete from disk (gate + seal), NO provider.
      const ordinal = Number.isInteger(rec.latest_attempt_ordinal)
        ? rec.latest_attempt_ordinal
        : (Array.isArray(rec.attempts) && rec.attempts.length ? rec.attempts[rec.attempts.length - 1] : 0);
      let recoveredExecutionId;
      try {
        const meta = existingInv.freshAttemptMetadata(ordinal);
        recoveredExecutionId = meta.execution_id;
        if (typeof recoveredExecutionId !== 'string' || !recoveredExecutionId) throw new CouncilArtifactOrchestrationError(`attempt-${ordinal} artifact.json has no execution_id`, 'DEBATE_ARTIFACT_STAGE_NO_EXECUTION_ID');
      } catch (error) {
        return fail(error?.code ?? 'DEBATE_ARTIFACT_STAGE_RECOVERY_METADATA_FAILED', error.message, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
      }
      try {
        // P20.8R6: same route as normal Council's DELIVERED-recovery path
        // (see runCouncilArtifactStage() above) — `deliveryMechanism`/
        // `directWriter` come from the SAME `resolveReportBackend(profileId)`
        // result the fresh-run path below uses, never a second policy
        // source. Defaults preserve the exact prior VERBATIM_MATERIALIZATION
        // behavior for any caller whose `reportBackend` predates these fields.
        const done = await completeReportArtifact({
          store, task, invocation: existingInv, attemptOrdinal: ordinal, stageKey,
          expected: { ...expected({ executionId: recoveredExecutionId }) },
          capabilityPolicy, inputTransport: consumerInputTransport ?? null, maxReportBytes, now: clock,
          deliveryMechanism: reportBackend?.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION',
          directWriter: reportBackend?.deliveryMechanism === 'DIRECT_WRITE' ? (reportBackend?.directWriter ?? null) : null,
          reportBackend, // only used if a bounded repair is needed
        });
        return succeed(done.sealedReference, COUNCIL_STEP_EXECUTION_STATE.SEALED, { repaired: done.repaired, repairKind: done.repairKind }, typedControl);
      } catch (error) {
        return fail('DEBATE_ARTIFACT_STAGE_COMPLETE_FROM_DISK_FAILED', error.message);
      }
    }
    if (rec.lifecycle === 'FAILED' || rec.lifecycle === 'CANCELLED') {
      return fail(`DEBATE_ARTIFACT_STAGE_${rec.lifecycle}`, rec.integrity_state ?? rec.lifecycle);
    }
    return fail('DEBATE_ARTIFACT_STAGE_AMBIGUOUS_NO_DURABLE_OUTCOME', `invocation lifecycle ${rec.lifecycle} after restart`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY);
  }

  // ---- 2. Fresh run --------------------------------------------------
  // §25 defense-in-depth: a synthesis stage needs a PROVEN typed-control route.
  if (isSynthesis) {
    try { assertDebateTypedControlAdmitted(reportBackend, { profileId, role }); }
    catch (error) { return fail(error.code ?? 'DEBATE_TYPED_CONTROL_UNSUPPORTED', error.message); }
  }
  // P20.8R6: the delivery route is the SAME exact-profile fact
  // `resolveReportBackend(profileId)` resolves for normal Council
  // (runCouncilArtifactStage() above) — never hardcoded here, never
  // inferred from stage/task content. Every caller whose `reportBackend`
  // predates these fields (offline pre-R6 tests, their fake backends)
  // falls back to the exact prior literal `'VERBATIM_MATERIALIZATION'`,
  // byte-for-byte unchanged.
  const deliveryMechanism = reportBackend?.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION';
  const directWriter = deliveryMechanism === 'DIRECT_WRITE' ? (reportBackend?.directWriter ?? null) : null;
  const executionId = `exec-${randomUUID()}`;
  let invocation;
  let attempt;
  try {
    invocation = task.allocateInvocation({ invocationId, role, stage: artifactStage, round, profileId, actorAlias });
    attempt = invocation.allocateAttempt({ deliveryMechanism, inputTransport: consumerInputTransport ?? null, startedAt: clock(), executionId });
  } catch (error) {
    const noReplay = error?.code === 'ARTIFACT_INVOCATION_RECORD_CORRUPT' || error?.code === 'ARTIFACT_INVOCATION_BINDING_MISMATCH' || error?.code === 'ARTIFACT_INVOCATION_RECORD_INVALID' || error?.code === 'ARTIFACT_INVOCATION_ID_REBOUND';
    return fail(noReplay ? `DEBATE_ARTIFACT_STAGE_${error.code}` : 'DEBATE_ARTIFACT_STAGE_ALLOCATION_FAILED', error.message, noReplay ? COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY : COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED);
  }

  let evidence = [];
  let renderedInstructions = instructions;
  if (inputReferences.length) {
    let prepared;
    try {
      // P20.8R6: Debate now resolves its own real `deliveryMechanism` (see
      // its declaration above) exactly like runCouncilArtifactStage()'s
      // fixed call site (P20.8R4) — never a hard-coded literal. A
      // hard-coded literal here would feed a stale delivery fact into the
      // exact-tuple capability check while the report call itself already
      // used the backend's real route, causing input preflight to fail
      // closed with `ARTIFACT_REPORT_DELIVERY_UNPROVEN` before the
      // provider was ever spawned.
      prepared = prepareArtifactInputs({
        store, consumerBackend: backend, capabilityPolicy,
        requestedInputTransport: consumerInputTransport ?? INPUT_TRANSPORT.VERBATIM_CONTENT,
        requestedDelivery: deliveryMechanism,
        references: inputReferences,
      });
    } catch (error) {
      return fail(error.code ?? 'DEBATE_ARTIFACT_INPUT_PREP_FAILED', error.message);
    }
    const r = renderPreparedInputs(prepared);
    evidence = r.evidence;
    if (r.trustedRefBlock) renderedInstructions = `${instructions}\n\n${r.trustedRefBlock}`;
  }
  if (Array.isArray(extraEvidence) && extraEvidence.length) {
    evidence = [...extraEvidence.map((e) => ({ label: e.label, content: e.content })), ...evidence];
  }

  const request = {
    store, task, invocation, attempt,
    taskId, stage: artifactStage, role, round, maxRounds,
    profileId, backend, actorAlias, executionId,
    deliveryMechanism,
    inputTransport: inputReferences.length ? (consumerInputTransport ?? INPUT_TRANSPORT.VERBATIM_CONTENT) : null,
    capabilityPolicy,
    instructions: renderedInstructions,
    evidence,
    sourceWritePolicy: 'READ_ONLY',
    executionCapable: false, // §12 — Debate is never implementation-capable
    // P20.8R6 — for DIRECT_WRITE, ReportInvoker requires `request.directWriter`
    // — the shared stateless confirmer off `reportBackend` (never a writer
    // this module constructs itself — DSH does not write report content),
    // exactly like runCouncilArtifactStage()'s request above.
    directWriter,
    workspaceEvidence,
  };

  let invokeResult;
  try {
    invokeResult = await reportInvoker.invokeReport({ request, reportBackend });
  } catch (error) {
    const KNOWN = new Set([TERMINAL_STATE.TIMEOUT, TERMINAL_STATE.CANCELLED, TERMINAL_STATE.PROVIDER_ERROR, TERMINAL_STATE.PROCESS_ERROR, TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE]);
    const terminalState = KNOWN.has(error?.terminalState) ? error.terminalState : 'UNKNOWN_OUTCOME';
    try { reconcileFailedInvocation({ invocation, terminalState, reason: error.code ?? error.message }); } catch { /* already settled */ }
    return fail(error.code ?? 'DEBATE_ARTIFACT_STAGE_EXECUTION_FAILED', error.message);
  }

  // §21 — capture the typed control from THIS execution (synthesis only),
  // BEFORE integrity-gate + seal so a crash cannot leave a sealed synthesis
  // with no control (recovery would then fail closed).
  let capturedControl = null;
  if (isSynthesis) {
    try {
      capturedControl = captureDebateContinuationFromResult({
        result: invokeResult.result,
        expected: { ...expected({ executionId }), attemptOrdinal: attempt.ordinal },
      });
    } catch (error) {
      return fail(error.code ?? 'DEBATE_ARTIFACT_SYNTHESIS_CONTROL_NOT_CAPTURED', error.message, COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED);
    }
  }

  if (typeof __afterDeliverHook === 'function') {
    let signal = null;
    try { signal = __afterDeliverHook({ artifactStage, round, profileId, invocationId, attemptOrdinal: attempt.ordinal }); } catch { signal = null; }
    if (signal === 'STOP_BEFORE_SEAL') {
      const e = new CouncilArtifactOrchestrationError('test seam: stopped after Debate delivery, before completeReportArtifact()', 'DEBATE_ARTIFACT_TEST_STOP_BEFORE_SEAL', { invocationId, artifactStage, round });
      e.__p20TestStopBeforeSeal = true;
      // for a synthesis, still persist the captured control first so the
      // DELIVERED-before-seal recovery path can reuse it (§21 order).
      if (isSynthesis && capturedControl) {
        try { invocation.commitDebateContinuationControl({ control: capturedControl }); } catch { /* recovery re-checks */ }
      }
      throw e;
    }
  }

  let done;
  try {
    // P20.8R6: pass the SAME resolved `deliveryMechanism`/`directWriter`
    // the request above used — exactly runCouncilArtifactStage()'s pattern
    // — so DSH verifies the model-authored file (DIRECT_WRITE) or the
    // materialized text (VERBATIM_MATERIALIZATION) correctly, and so a
    // bounded delivery repair (if ever needed) uses the real route rather
    // than silently assuming VERBATIM_MATERIALIZATION.
    done = await completeReportArtifact({
      store, task, invocation, attemptOrdinal: attempt.ordinal, stageKey,
      expected: { ...expected({ executionId }) },
      capabilityPolicy, inputTransport: request.inputTransport, maxReportBytes, now: clock,
      deliveryMechanism, reportBackend, directWriter,
    });
  } catch (error) {
    return fail(error.code ?? 'DEBATE_ARTIFACT_STAGE_SEAL_FAILED', error.message);
  }

  if (isSynthesis) {
    // P20.5R R5 — the typed control was captured from the ORIGINAL synthesis
    // execution. If completeReportArtifact() needed a bounded delivery repair,
    // a NEW attempt with a NEW execution_id became authoritative and the
    // bounded-repair primitive does not surface that repair execution's typed
    // channel. It is FORBIDDEN to persist the original execution_id under the
    // new authoritative attempt — fail closed with NO persisted control.
    if (done.repaired === true || done.sealedAttemptOrdinal !== attempt.ordinal) {
      return fail(
        'DEBATE_ARTIFACT_SYNTHESIS_REPAIR_CONTROL_UNAVAILABLE',
        `Debate synthesis required a bounded delivery repair (authoritative attempt ${done.sealedAttemptOrdinal} != original ${attempt.ordinal}); the same-execution typed continuation channel cannot be preserved across the repair — refusing to persist a falsely-bound control`,
        COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED,
      );
    }
    if (typeof __beforeSynthesisControlPersistHook === 'function') {
      try { __beforeSynthesisControlPersistHook({ invocation, sealedOrdinal: done.sealedAttemptOrdinal }); } catch { /* test seam */ }
    }
    try {
      // The control already binds to `attempt.ordinal` / `executionId`; that IS
      // the sealed authoritative attempt (no repair). commitDebateContinuation
      // Control() fresh-reads that attempt's artifact.json and re-verifies
      // store/project/task/invocation/attempt/execution_id/round/profile/alias/
      // stage/role before writing.
      invocation.commitDebateContinuationControl({ control: capturedControl });
    } catch (error) {
      return fail(error.code ?? 'DEBATE_ARTIFACT_SYNTHESIS_CONTROL_PERSIST_FAILED', error.message, COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED);
    }
  }
  return succeed(done.sealedReference, COUNCIL_STEP_EXECUTION_STATE.SEALED, { repaired: done.repaired, repairKind: done.repairKind }, capturedControl);
}

/**
 * P20.4R §4 — OFFLINE / low-level convenience ONLY. The AUTHORITATIVE
 * app-owned artifact_v1 Council topology is `CouncilChairDriver.#artifactDecide`
 * over the durable `DurablePmRuntime` / `CouncilStepWorkflowRunner` /
 * `DurableWorkflowState` turn machine (see p5-production-composition.mjs's
 * `createRuntime` artifact branch). `runArtifactCouncil` reuses the SAME
 * primitives (`runCouncilArtifactStage`, `runCouncilFinalArtifactGate`,
 * `prepareArtifactInputs`, `completeReportArtifact`, `reconstructSealedStageRef`)
 * as a straight-line harness for focused offline tests — it is NOT wired into
 * production composition and is not a second production Council engine.
 *
 * Run a complete `artifact_v1` Council. Deterministic topology, app-owned.
 *
 * @param {object} input
 * @param {import('../../artifacts/artifact-store.mjs').ArtifactStore} input.store
 * @param {object} input.council   a normalizeCouncilSpec() result
 * @param {string} input.ownerTask
 * @param {string[]} [input.constraints]
 * @param {string} input.taskId
 * @param {string} input.taskSlug
 * @param {string} input.createdAt  ISO-8601
 * @param {Map<string,string>|null} [input.aliasRegistry]  profileId -> actor alias
 * @param {(profileId: string) => { backend: string, runReport: Function }} input.resolveReportBackend
 * @param {object} [input.capabilityPolicy]
 * @param {'NATIVE_ASSIGNED_READ'|'VERBATIM_CONTENT'} [input.consumerInputTransport]  app-owned admission
 * @param {number} [input.maxReportBytes]
 * @param {() => string} [input.clock]
 * @param {boolean} [input.projectSynthesisBytes]  §30 — include exact verified synthesis bytes in the projection
 * @returns {Promise<object>} the Council artifact outcome (app-owned facts + final_ref)
 */
export async function runArtifactCouncil(input) {
  const {
    store, council, ownerTask, constraints = [],
    taskId, taskSlug, createdAt,
    aliasRegistry = null,
    resolveReportBackend,
    capabilityPolicy,
    consumerInputTransport = INPUT_TRANSPORT.VERBATIM_CONTENT,
    maxReportBytes,
    clock = DEFAULT_CLOCK,
    projectSynthesisBytes = false,
  } = input ?? {};

  if (!store || typeof store.allocateTask !== 'function') {
    throw new CouncilArtifactOrchestrationError('an ArtifactStore is required', 'COUNCIL_ARTIFACT_NO_STORE');
  }
  if (!council || council.kind !== 'COUNCIL') {
    throw new CouncilArtifactOrchestrationError('a normalized CouncilSpec is required', 'COUNCIL_ARTIFACT_BAD_SPEC');
  }
  if (typeof resolveReportBackend !== 'function') {
    throw new CouncilArtifactOrchestrationError('resolveReportBackend(profileId) is required', 'COUNCIL_ARTIFACT_NO_BACKEND_RESOLVER');
  }

  // §7 / §40 — Debate guard: fail closed BEFORE any stage, zero Debate calls.
  if (council.debate?.enabled === true) {
    throw new CouncilArtifactOrchestrationError(
      'artifact_v1 Council with debate.enabled=true is not migrated — Debate artifact handoff is P20.5',
      'COUNCIL_ARTIFACT_DEBATE_P20_5_REQUIRED',
      { phase: 'P20.5' },
    );
  }

  // §26 — source/workspace policy stays SEPARATE and typed. The artifact
  // Council path in P20.4 does not thread the workspace evidence packet /
  // admission / redaction that a `workspace_requirement: 'READ'` council
  // requires — fail closed rather than silently drop that owner-authored
  // source authority. A `NONE` council (every pre-READ council) is
  // unaffected. (Wiring READ source evidence into the artifact path is a
  // later phase; see the P20.4 report Known Limitations.)
  if (council.workspace_requirement && council.workspace_requirement !== 'NONE') {
    throw new CouncilArtifactOrchestrationError(
      `artifact_v1 Council with workspace_requirement=${JSON.stringify(council.workspace_requirement)} is not migrated — source/workspace evidence is not yet threaded into the artifact path`,
      'COUNCIL_ARTIFACT_WORKSPACE_REQUIREMENT_NOT_MIGRATED',
      { workspaceRequirement: council.workspace_requirement },
    );
  }

  const chairProfileId = council.chair_profile_id;
  const participants = council.participant_profile_ids;
  const chairAlias = aliasFor(aliasRegistry, chairProfileId);
  const participantAliases = participants.map((id) => aliasFor(aliasRegistry, id));
  const stageKeyPlan = councilStageKeyPlan({ rounds: council.rounds, participantAliases });

  const task = store.allocateTask({
    taskId, taskSlug, createdAt, mode: 'council',
    chairProfileId, participantProfileIds: [...participants],
  });
  // P20.4R3 R15/R17 — bind the normalized Council control before any stage, so
  // the offline convenience path carries the SAME persisted authority the
  // production durable driver does (a bound manifest, a final gate that can
  // full-match, no "progress without control" hole).
  task.bindCouncilControl({
    control: buildCouncilArtifactControl(council),
    topLevel: { chairProfileId, participantProfileIds: [...participants] },
  });

  const backendFor = (profileId) => {
    const b = resolveReportBackend(profileId);
    if (!b || typeof b.runReport !== 'function' || typeof b.backend !== 'string') {
      throw new CouncilArtifactOrchestrationError(`resolveReportBackend(${JSON.stringify(profileId)}) must return { backend, runReport }`, 'COUNCIL_ARTIFACT_BAD_BACKEND', { profileId });
    }
    return b;
  };

  const steps = [];
  const runStage = (args) => runCouncilArtifactStage({ store, task, taskId, createdAt, capabilityPolicy, consumerInputTransport, maxReportBytes, clock, ...args });

  // ---- Stage 1: chair plan --------------------------------------------------
  const chairBackend = backendFor(chairProfileId);
  const chairPlanOutcome = await runStage({
    artifactStage: ARTIFACT_STAGE.CHAIR_PLAN,
    profileId: chairProfileId, actorAlias: chairAlias, backend: chairBackend.backend, reportBackend: chairBackend,
    instructions: buildArtifactChairPlanInstructions({
      ownerTask, constraints, participantProfileIds: participants,
      implementationParticipantId: council.implementation_participant_id,
    }),
  });
  steps.push(chairPlanOutcome);
  if (!chairPlanOutcome.ok) {
    throw new CouncilArtifactOrchestrationError(`Council chair plan failed: ${chairPlanOutcome.failure_code}`, 'COUNCIL_ARTIFACT_CHAIR_PLAN_FAILED', { steps });
  }
  const chairPlanRef = chairPlanOutcome.sealed_ref;

  // ---- Stage 2: participant reports (owner order) -------------------------
  const reportOutcomes = new Map(); // profileId -> outcome
  for (const [i, profileId] of participants.entries()) {
    const alias = participantAliases[i];
    const b = backendFor(profileId);
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runStage({
      artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
      profileId, actorAlias: alias, backend: b.backend, reportBackend: b,
      instructions: buildArtifactParticipantReportInstructions({
        ownerTask, constraints, participantProfileId: profileId,
        isImplementationParticipant: council.implementation_participant_id === profileId,
      }),
      inputReferences: [{ label: `chair-plan (${chairProfileId})`, reference: chairPlanRef }],
    });
    reportOutcomes.set(profileId, outcome);
    steps.push(outcome);
  }

  const successfulReports = participants.filter((id) => reportOutcomes.get(id)?.ok);
  if (successfulReports.length === 0) {
    throw new CouncilArtifactOrchestrationError('all Council participant reports failed', 'COUNCIL_ARTIFACT_ALL_PARTICIPANTS_FAILED', { steps });
  }
  const degraded = successfulReports.length < participants.length;

  // ---- Stage 3: participant critiques (rounds >= 2) ----------------------
  const critiqueOutcomes = new Map();
  if (council.rounds >= 2) {
    for (const [i, profileId] of participants.entries()) {
      const alias = participantAliases[i];
      const ownReport = reportOutcomes.get(profileId);
      if (!ownReport?.ok) {
        const stageKey = councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, actorAlias: alias });
        const skipped = buildArtifactStepFailure({
          stepKind: COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE,
          artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, stageKey,
          profileId, actorAlias: alias,
          failureCode: 'COUNCIL_ARTIFACT_CRITIQUE_SKIPPED_ROUND1_FAILED',
          reason: `participant ${profileId} had no successful round-1 report`,
          executionState: COUNCIL_STEP_EXECUTION_STATE.SKIPPED,
        });
        critiqueOutcomes.set(profileId, skipped);
        steps.push(skipped);
        continue;
      }
      const peerIds = successfulReports.filter((id) => id !== profileId);
      const inputRefs = [
        { label: `chair-plan (${chairProfileId})`, reference: chairPlanRef },
        { label: `own report (${profileId})`, reference: ownReport.sealed_ref },
        ...peerIds.map((id) => ({ label: `peer report (${id})`, reference: reportOutcomes.get(id).sealed_ref })),
      ];
      const b = backendFor(profileId);
      // eslint-disable-next-line no-await-in-loop
      const outcome = await runStage({
        artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE,
        profileId, actorAlias: alias, backend: b.backend, reportBackend: b,
        instructions: buildArtifactParticipantCritiqueInstructions({
          ownerTask, constraints, participantProfileId: profileId, peerProfileIds: peerIds,
        }),
        inputReferences: inputRefs,
      });
      critiqueOutcomes.set(profileId, outcome);
      steps.push(outcome);
    }
  }
  const successfulCritiques = participants.filter((id) => critiqueOutcomes.get(id)?.ok);

  // ---- Stage 4: chair synthesis -----------------------------------------
  const failureFacts = participants
    .filter((id) => !reportOutcomes.get(id)?.ok)
    .map((id) => ({ profileId: id, reason: reportOutcomes.get(id)?.failure_code ?? 'no report' }));
  const synthInputs = [
    { label: `chair-plan (${chairProfileId})`, reference: chairPlanRef },
    ...successfulReports.map((id) => ({ label: `report (${id})`, reference: reportOutcomes.get(id).sealed_ref })),
    ...successfulCritiques.map((id) => ({ label: `critique (${id})`, reference: critiqueOutcomes.get(id).sealed_ref })),
  ];
  const synthesisOutcome = await runStage({
    artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS,
    profileId: chairProfileId, actorAlias: chairAlias, backend: chairBackend.backend, reportBackend: chairBackend,
    instructions: buildArtifactChairSynthesisInstructions({
      ownerTask, constraints,
      successfulReportProfileIds: successfulReports,
      successfulCritiqueProfileIds: successfulCritiques,
      failureFacts, degraded,
    }),
    inputReferences: synthInputs,
  });
  steps.push(synthesisOutcome);
  if (!synthesisOutcome.ok) {
    throw new CouncilArtifactOrchestrationError(`Council chair synthesis failed: ${synthesisOutcome.failure_code}`, 'COUNCIL_ARTIFACT_SYNTHESIS_FAILED', { steps });
  }

  // ---- Council Final Artifact Gate (§29) -------------------------------
  const finalRef = runCouncilFinalArtifactGate({
    store, task,
    chairPlanOutcome, reportOutcomes, critiqueOutcomes, synthesisOutcome,
    council, stageKeyPlan, participants, maxReportBytes,
  });

  let synthesisBytes = null;
  if (projectSynthesisBytes) {
    const verified = resolveAndVerifySealedReference({ store, reference: finalRef });
    synthesisBytes = verified.buffer.toString('utf8');
  }

  return Object.freeze({
    type: 'council',
    transport_version: 'artifact_v1',
    ok: true,
    final_ref: finalRef,
    chair_profile_id: chairProfileId,
    participant_profile_ids: [...participants],
    rounds: council.rounds,
    strategy: council.strategy,
    degraded,
    completed_participants: successfulReports,
    failed_participants: participants.filter((id) => !reportOutcomes.get(id)?.ok),
    completed_critiques: successfulCritiques,
    steps,
    synthesis_bytes: synthesisBytes,
  });
}

/**
 * P20.5 §15 — VERIFY the Council artifact prerequisite topology WITHOUT
 * completing the task or committing a final_ref. This is the ONE shared
 * Council-topology verification implementation (§15: "Do NOT duplicate a
 * weaker pre-Debate Council verifier"). Reuses the P20.3 full
 * sealed-reference verifier for every stage ref; never inspects report
 * semantics.
 *
 *   - Council-only completion  = verifyCouncilArtifactTopology() + commitCouncilFinalRef()
 *   - Council + Debate enabled = verifyCouncilArtifactTopology() only, then Debate
 *
 * @returns {{ synthesisRef: object, manifest: object, control: object,
 *             degraded: boolean, successfulReports: string[],
 *             failedReports: string[], successfulCritiques: string[] }}
 */
export function verifyCouncilArtifactTopology({ store, task, chairPlanOutcome, reportOutcomes, critiqueOutcomes, synthesisOutcome, council, stageKeyPlan, participants, maxReportBytes, aliasRegistry = null }) {
  const manifest = task.freshManifest();
  if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) {
    throw new CouncilArtifactOrchestrationError('Council task manifest store/project identity mismatch', 'COUNCIL_ARTIFACT_FINAL_GATE_STORE_MISMATCH');
  }

  // P20.4R3 R17 — the final authority primitive must not be weaker than the
  // task authority it commits. `council_control` MUST exist, validate, and
  // FULLY match the caller's normalized Council control (chair, participants +
  // order, rounds, strategy, implementation participant, workspace
  // requirement, workspace evidence paths, debate.enabled, debate.max_rounds)
  // via the SAME shared builder/comparator `bindCouncilControl()` uses — no
  // hand-coded partial equality.
  const control = manifest.council_control;
  const cv = validateCouncilArtifactControl(control);
  if (!control || !cv.ok) {
    throw new CouncilArtifactOrchestrationError(
      `Council final gate: task manifest has no valid persisted council_control (${(cv?.errors ?? ['missing']).join('; ')})`,
      'COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_REQUIRED',
    );
  }
  try {
    assertCouncilControlMatch({ persisted: control, council });
  } catch (error) {
    throw new CouncilArtifactOrchestrationError(
      `Council final gate: requested normalized Council control does not fully match the persisted council_control: ${error.message}`,
      'COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_MISMATCH',
      { cause: error.code ?? null },
    );
  }
  // Defense in depth — the roster the caller iterates must equal the control's.
  if (JSON.stringify([...participants]) !== JSON.stringify(control.participant_profile_ids)) {
    throw new CouncilArtifactOrchestrationError('Council final gate: participants iteration order does not match persisted council_control', 'COUNCIL_ARTIFACT_FINAL_GATE_CONTROL_MISMATCH');
  }
  const aliasOf = (profileId) => {
    if (aliasRegistry && typeof aliasRegistry.get === 'function' && aliasRegistry.get(profileId)) return aliasRegistry.get(profileId);
    return deriveActorAlias(profileId);
  };
  const expectedIdentityFor = (stepKind, profileId) => expectedCouncilArtifactStepIdentity({ stepKind, profileId, actorAlias: aliasOf(profileId) });

  const requireSealedStage = (stageKey, outcome, label, stepKind, profileId) => {
    if (!outcome || !outcome.ok) throw new CouncilArtifactOrchestrationError(`Council final gate: ${label} is not a successful sealed stage`, 'COUNCIL_ARTIFACT_FINAL_GATE_STAGE_NOT_SEALED', { stageKey });
    const entry = manifest.stages?.[stageKey];
    if (!entry) throw new CouncilArtifactOrchestrationError(`Council final gate: manifest has no stage entry ${JSON.stringify(stageKey)}`, 'COUNCIL_ARTIFACT_FINAL_GATE_MISSING_STAGE', { stageKey });
    const sv = validateStageSealEntry(entry, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
    if (!sv.ok) throw new CouncilArtifactOrchestrationError(`Council final gate: stage ${JSON.stringify(stageKey)} entry invalid: ${sv.errors.join('; ')}`, 'COUNCIL_ARTIFACT_FINAL_GATE_BAD_STAGE', { stageKey, errors: sv.errors });
    if (JSON.stringify(entry.sealed_ref) !== JSON.stringify(outcome.sealed_ref)) {
      throw new CouncilArtifactOrchestrationError(`Council final gate: stage ${JSON.stringify(stageKey)} sealed_ref does not match the step outcome`, 'COUNCIL_ARTIFACT_FINAL_GATE_REF_MISMATCH', { stageKey });
    }
    // The SAME full P20.3 sealed-reference authority + containment verifier.
    const verified = resolveAndVerifySealedReference({ store, reference: entry.sealed_ref, maxReportBytes });
    // R9 — bind step_kind / stage / stage_key / profile / alias / role to the
    // expected Council-control identity AND the resolved invocation/attempt
    // metadata; handoff.sealed_ref must equal the manifest stage entry.
    try {
      assertCouncilArtifactStepBinding({
        handoff: outcome,
        expected: expectedIdentityFor(stepKind, profileId),
        sealedInvocationRecord: verified.invocationRecord,
        sealedAttemptMetadata: verified.attemptMetadata,
        expectedStageSealedRef: entry.sealed_ref,
      });
    } catch (error) {
      throw new CouncilArtifactOrchestrationError(`Council final gate: ${label} step binding mismatch: ${error.message}`, 'COUNCIL_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', { stageKey, cause: error.code ?? null });
    }
    return entry.sealed_ref;
  };

  // Chair plan must be sealed + verify + bind.
  requireSealedStage(stageKeyPlan.chairPlan, chairPlanOutcome, 'chair plan', COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_PLAN, council.chair_profile_id);

  // >= 1 successful participant-report stage sealed + verify + bind.
  let sealedReports = 0;
  for (const [i, profileId] of participants.entries()) {
    const outcome = reportOutcomes.get(profileId);
    const stageKey = stageKeyPlan.reports[i];
    if (outcome?.ok) {
      requireSealedStage(stageKey, outcome, `participant report ${profileId}`, COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT, profileId);
      sealedReports += 1;
    } else {
      // A FAILED/SKIPPED step must have NO fabricated sealed stage ref, and its
      // identity fields (when present) must still bind.
      if (manifest.stages?.[stageKey]) {
        throw new CouncilArtifactOrchestrationError(`Council final gate: failed report ${profileId} has a fabricated stage entry`, 'COUNCIL_ARTIFACT_FINAL_GATE_FABRICATED_REF', { stageKey });
      }
      if (outcome) {
        try { assertCouncilArtifactStepBinding({ handoff: outcome, expected: expectedIdentityFor(COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_REPORT, profileId) }); }
        catch (error) { throw new CouncilArtifactOrchestrationError(`Council final gate: failed report ${profileId} step binding mismatch: ${error.message}`, 'COUNCIL_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', { stageKey, cause: error.code ?? null }); }
      }
    }
  }
  if (sealedReports < 1) {
    throw new CouncilArtifactOrchestrationError('Council final gate: no successful sealed participant report', 'COUNCIL_ARTIFACT_FINAL_GATE_NO_REPORT');
  }

  // rounds >= 2: successful critique refs verify + bind; failures/skips carry no ref.
  if (council.rounds >= 2) {
    for (const [i, profileId] of participants.entries()) {
      const outcome = critiqueOutcomes.get(profileId);
      const stageKey = stageKeyPlan.critiques[i];
      if (outcome?.ok) {
        requireSealedStage(stageKey, outcome, `critique ${profileId}`, COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE, profileId);
      } else if (manifest.stages?.[stageKey]) {
        throw new CouncilArtifactOrchestrationError(`Council final gate: non-successful critique ${profileId} has a fabricated stage entry`, 'COUNCIL_ARTIFACT_FINAL_GATE_FABRICATED_REF', { stageKey });
      } else if (outcome) {
        try { assertCouncilArtifactStepBinding({ handoff: outcome, expected: expectedIdentityFor(COUNCIL_ARTIFACT_STEP_KINDS.PARTICIPANT_CRITIQUE, profileId) }); }
        catch (error) { throw new CouncilArtifactOrchestrationError(`Council final gate: non-successful critique ${profileId} step binding mismatch: ${error.message}`, 'COUNCIL_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', { stageKey, cause: error.code ?? null }); }
      }
    }
  }

  // Chair synthesis sealed + verify + bind; final_ref == its sealed_ref.
  const synthesisRef = requireSealedStage(stageKeyPlan.synthesis, synthesisOutcome, 'chair synthesis', COUNCIL_ARTIFACT_STEP_KINDS.CHAIR_SYNTHESIS, council.chair_profile_id);

  const successfulReports = participants.filter((id) => reportOutcomes.get(id)?.ok);
  return {
    synthesisRef,
    manifest,
    control,
    degraded: successfulReports.length < participants.length,
    successfulReports,
    failedReports: participants.filter((id) => !reportOutcomes.get(id)?.ok),
    successfulCritiques: participants.filter((id) => critiqueOutcomes?.get(id)?.ok),
  };
}

/**
 * P20.5 §15 — commit `final_ref = Council chair-council-synthesis sealed_ref`
 * and mark the task COMPLETED / TASK_ARTIFACT_PASS. Called ONLY for a
 * Council-only run (debate.enabled === false). A Debate run commits its own
 * final Debate synthesis ref through `commitDebateFinalRef()` instead (§31).
 *
 * @returns {object} the committed final_ref
 */
export function commitCouncilFinalRef({ task, synthesisRef }) {
  const finalManifest = task.commitFinalRef({
    finalRef: synthesisRef, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS',
    expectedStageKey: councilFinalStageKey(),
  });
  return finalManifest.final_ref;
}

/**
 * §29 — Council-only final gate: verify the prerequisite topology, then commit
 * `final_ref = chair-council-synthesis sealed_ref`. A thin wrapper over the
 * split (§15) so every existing Council-only caller is byte-for-byte unchanged.
 *
 * @returns {object} the committed final_ref (the synthesis sealed_ref)
 */
export function runCouncilFinalArtifactGate(args) {
  const { synthesisRef } = verifyCouncilArtifactTopology(args);
  return commitCouncilFinalRef({ task: args.task, synthesisRef });
}

// =====================================================================
// P20.5 §30/§31 — the Debate final topology gate
// =====================================================================

/**
 * Verify the complete Debate artifact topology WITHOUT committing final_ref
 * (§30). Reuses the same P20.3 sealed-reference authority + the shared
 * step-binding + typed-control binding. No report semantic parsing.
 *
 * @returns {{ finalRef: object, finalRound: number, roundsRun: number, engineForcedStop: boolean }}
 */
export function verifyDebateArtifactTopology({ store, task, council, roster, aliasRegistry = null, rounds, maxReportBytes, councilGateArgs = null }) {
  // P20.5R R4 — IMMEDIATELY before committing the Debate final_ref, RE-RUN the
  // ONE strong Council prerequisite verifier against FRESH durable state. This
  // re-establishes: council_control full match, chair-plan authority, every
  // participant-report outcome, critique topology when applicable, and Council
  // synthesis authority — never a weak "Council synthesis stage exists" check.
  if (!councilGateArgs || typeof councilGateArgs !== 'object') {
    throw new CouncilArtifactOrchestrationError('Debate final gate: councilGateArgs is required to re-verify the Council prerequisite', 'DEBATE_ARTIFACT_FINAL_GATE_NO_COUNCIL_ARGS');
  }
  let councilResult;
  try {
    councilResult = verifyCouncilArtifactTopology({ ...councilGateArgs, store, task, council });
  } catch (error) {
    throw new CouncilArtifactOrchestrationError(
      `Debate final gate: Council prerequisite topology failed re-verification: ${error.message}`,
      'DEBATE_ARTIFACT_FINAL_GATE_COUNCIL_PREREQ_FAILED',
      { cause: error.code ?? null },
    );
  }

  const manifest = task.freshManifest();
  if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) {
    throw new CouncilArtifactOrchestrationError('Debate final gate: task manifest store/project identity mismatch', 'DEBATE_ARTIFACT_FINAL_GATE_STORE_MISMATCH');
  }
  // 1. persisted council_control exists + FULLY matches the requested control.
  const control = manifest.council_control;
  const cv = validateCouncilArtifactControl(control);
  if (!control || !cv.ok) throw new CouncilArtifactOrchestrationError(`Debate final gate: no valid persisted council_control (${(cv?.errors ?? ['missing']).join('; ')})`, 'DEBATE_ARTIFACT_FINAL_GATE_CONTROL_REQUIRED');
  try { assertCouncilControlMatch({ persisted: control, council }); }
  catch (error) { throw new CouncilArtifactOrchestrationError(`Debate final gate: council_control mismatch: ${error.message}`, 'DEBATE_ARTIFACT_FINAL_GATE_CONTROL_MISMATCH', { cause: error.code ?? null }); }
  if (!control.debate || control.debate.enabled !== true) {
    throw new CouncilArtifactOrchestrationError('Debate final gate: persisted council_control does not have debate.enabled', 'DEBATE_ARTIFACT_FINAL_GATE_NOT_A_DEBATE');
  }
  // 2. Council prerequisite topology sealed (not prematurely completed as final).
  const councilFinal = manifest.stages?.[councilFinalStageKey()];
  if (!councilFinal) throw new CouncilArtifactOrchestrationError('Debate final gate: Council chair synthesis is not sealed', 'DEBATE_ARTIFACT_FINAL_GATE_NO_COUNCIL_SYNTHESIS');

  // 3. EXACT Debate roster authority (P20.5R R3): the roster MUST equal the
  // successful initial Council participant_report profiles in persisted owner
  // order, as proven by the strong Council verifier above — not a
  // caller-supplied subset.
  const authoritativeRoster = councilResult.successfulReports;
  if (!Array.isArray(authoritativeRoster) || authoritativeRoster.length === 0) {
    throw new CouncilArtifactOrchestrationError('Debate final gate: the Council prerequisite has no successful participant report', 'DEBATE_ARTIFACT_FINAL_GATE_EMPTY_ROSTER');
  }
  if (JSON.stringify([...(roster ?? [])]) !== JSON.stringify(authoritativeRoster)) {
    throw new CouncilArtifactOrchestrationError(
      `Debate final gate: the Debate roster does not equal the successful Council reporters in owner order (got ${JSON.stringify(roster)}, authoritative ${JSON.stringify(authoritativeRoster)})`,
      'DEBATE_ARTIFACT_FINAL_GATE_ROSTER_MISMATCH',
    );
  }
  roster = authoritativeRoster;
  const rosterSet = new Set(roster);

  const aliasOf = (profileId) => (aliasRegistry && typeof aliasRegistry.get === 'function' && aliasRegistry.get(profileId)) || deriveActorAlias(profileId);
  const hardCap = DEBATE_MAX_ROUNDS;
  const maxRounds = Math.min(council.debate.max_rounds ?? hardCap, hardCap);

  // 4. rounds contiguous from 1, within the ceiling.
  if (!Array.isArray(rounds) || rounds.length === 0) throw new CouncilArtifactOrchestrationError('Debate final gate: no executed rounds', 'DEBATE_ARTIFACT_FINAL_GATE_NO_ROUNDS');
  rounds.forEach((r, i) => {
    if (r.round !== i + 1) throw new CouncilArtifactOrchestrationError(`Debate final gate: rounds not contiguous from 1 (round ${r.round} at index ${i})`, 'DEBATE_ARTIFACT_FINAL_GATE_ROUNDS_NOT_CONTIGUOUS');
  });
  if (rounds.length > maxRounds) throw new CouncilArtifactOrchestrationError(`Debate final gate: ${rounds.length} rounds exceeds the ceiling ${maxRounds}`, 'DEBATE_ARTIFACT_FINAL_GATE_ROUND_OVERRUN');

  const verifyStage = (stageKey, outcome, expected, label) => {
    if (!outcome || outcome.ok !== true) throw new CouncilArtifactOrchestrationError(`Debate final gate: ${label} is not a successful sealed stage`, 'DEBATE_ARTIFACT_FINAL_GATE_STAGE_NOT_SEALED', { stageKey });
    const entry = manifest.stages?.[stageKey];
    if (!entry) throw new CouncilArtifactOrchestrationError(`Debate final gate: manifest has no stage entry ${JSON.stringify(stageKey)}`, 'DEBATE_ARTIFACT_FINAL_GATE_MISSING_STAGE', { stageKey });
    const sv = validateStageSealEntry(entry, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
    if (!sv.ok) throw new CouncilArtifactOrchestrationError(`Debate final gate: stage ${JSON.stringify(stageKey)} entry invalid: ${sv.errors.join('; ')}`, 'DEBATE_ARTIFACT_FINAL_GATE_BAD_STAGE', { stageKey });
    if (JSON.stringify(entry.sealed_ref) !== JSON.stringify(outcome.sealed_ref)) throw new CouncilArtifactOrchestrationError(`Debate final gate: stage ${JSON.stringify(stageKey)} sealed_ref != step outcome`, 'DEBATE_ARTIFACT_FINAL_GATE_REF_MISMATCH', { stageKey });
    const verified = resolveAndVerifySealedReference({ store, reference: entry.sealed_ref, maxReportBytes });
    try {
      assertCouncilArtifactStepBinding({ handoff: outcome, expected, sealedInvocationRecord: verified.invocationRecord, sealedAttemptMetadata: verified.attemptMetadata, expectedStageSealedRef: entry.sealed_ref });
    } catch (error) {
      throw new CouncilArtifactOrchestrationError(`Debate final gate: ${label} step binding mismatch: ${error.message}`, 'DEBATE_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', { stageKey, cause: error.code ?? null });
    }
    return { entry, verified };
  };

  let engineForcedStop = false;
  for (const r of rounds) {
    const isFinalRound = r.round === rounds.length;
    // 5. one sealed Chair brief.
    verifyStage(
      debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: r.round }),
      r.brief,
      expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_BRIEF, round: r.round, profileId: council.chair_profile_id, actorAlias: aliasOf(council.chair_profile_id) }),
      `round ${r.round} chair brief`,
    );
    // P20.5R R2 — EVERY roster member MUST have an EXPLICIT durable response
    // outcome for this round (a missing outcome is NOT the same as a failed
    // one), and NO response identity outside the exact roster may appear.
    for (const rid of r.responses.keys()) {
      if (!rosterSet.has(rid)) throw new CouncilArtifactOrchestrationError(`Debate final gate: round ${r.round} has a response outcome for ${JSON.stringify(rid)} which is not on the Debate roster`, 'DEBATE_ARTIFACT_FINAL_GATE_EXTRA_RESPONSE', { round: r.round, profileId: rid });
    }
    let sealedResponses = 0;
    for (const profileId of roster) {
      if (!r.responses.has(profileId)) {
        throw new CouncilArtifactOrchestrationError(`Debate final gate: round ${r.round} is missing a durable response outcome for roster member ${JSON.stringify(profileId)}`, 'DEBATE_ARTIFACT_FINAL_GATE_MISSING_RESPONSE_OUTCOME', { round: r.round, profileId });
      }
      const outcome = r.responses.get(profileId);
      const stageKey = debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round: r.round, actorAlias: aliasOf(profileId) });
      const expected = expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_RESPONSE, round: r.round, profileId, actorAlias: aliasOf(profileId) });
      if (outcome?.ok) {
        verifyStage(stageKey, outcome, expected, `round ${r.round} response ${profileId}`);
        sealedResponses += 1;
      } else {
        if (manifest.stages?.[stageKey]) throw new CouncilArtifactOrchestrationError(`Debate final gate: failed round ${r.round} response ${profileId} has a fabricated stage entry`, 'DEBATE_ARTIFACT_FINAL_GATE_FABRICATED_REF', { stageKey });
        if (outcome) {
          try { assertCouncilArtifactStepBinding({ handoff: outcome, expected }); }
          catch (error) { throw new CouncilArtifactOrchestrationError(`Debate final gate: failed round ${r.round} response ${profileId} binding mismatch: ${error.message}`, 'DEBATE_ARTIFACT_FINAL_GATE_BINDING_MISMATCH', { stageKey, cause: error.code ?? null }); }
        }
      }
    }
    // 9. at least one response succeeded before each synthesis.
    if (sealedResponses < 1) throw new CouncilArtifactOrchestrationError(`Debate final gate: round ${r.round} had no successful sealed response`, 'DEBATE_ARTIFACT_FINAL_GATE_NO_RESPONSE');
    // 10-11. one sealed Chair synthesis + one fully-bound typed control.
    const synthExpected = expectedDebateArtifactStepIdentity({ stepKind: COUNCIL_ARTIFACT_STEP_KINDS.DEBATE_SYNTHESIS, round: r.round, profileId: council.chair_profile_id, actorAlias: aliasOf(council.chair_profile_id) });
    const synthKey = debateStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round: r.round });
    const { verified: synthVerified } = verifyStage(synthKey, r.synthesis, synthExpected, `round ${r.round} chair synthesis`);
    const tc = r.synthesis.typed_control ?? null;
    const tcBind = validateDebateContinuationControlBinding({
      control: tc,
      expected: { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id, invocationId: synthVerified.invocationRecord.invocation_id, round: r.round, profileId: council.chair_profile_id, actorAlias: aliasOf(council.chair_profile_id), role: ARTIFACT_ROLE.CHAIR },
      sealedInvocationRecord: synthVerified.invocationRecord,
      sealedAttemptMetadata: synthVerified.attemptMetadata,
    });
    if (!tcBind.ok) throw new CouncilArtifactOrchestrationError(`Debate final gate: round ${r.round} synthesis typed control not bound: ${tcBind.errors.join('; ')}`, 'DEBATE_ARTIFACT_FINAL_GATE_CONTROL_UNBOUND', { round: r.round });
    if (JSON.stringify(synthVerified.invocationRecord.debate_continuation) !== JSON.stringify(tc)) {
      throw new CouncilArtifactOrchestrationError(`Debate final gate: round ${r.round} handoff typed control != persisted debate_continuation`, 'DEBATE_ARTIFACT_FINAL_GATE_CONTROL_DRIFT', { round: r.round });
    }
    // 12-13. effective continuation per round.
    const effective = evaluateEffectiveContinuation({ control: tc, round: r.round, maxRounds, hardCap });
    if (!isFinalRound) {
      if (effective.effectiveContinue !== true) throw new CouncilArtifactOrchestrationError(`Debate final gate: non-final round ${r.round} does not have effective_continue`, 'DEBATE_ARTIFACT_FINAL_GATE_BAD_CONTINUATION', { round: r.round });
    } else {
      if (effective.effectiveContinue !== false) throw new CouncilArtifactOrchestrationError(`Debate final gate: final round ${r.round} still says continue`, 'DEBATE_ARTIFACT_FINAL_GATE_FINAL_CONTINUES', { round: r.round });
      engineForcedStop = effective.engineForcedStop;
    }
  }

  // 14. no stages exist after the effective stop.
  const finalRound = rounds.length;
  for (const key of Object.keys(manifest.stages ?? {})) {
    const p = parseDebateStageKey(key);
    if (p && p.round > finalRound) throw new CouncilArtifactOrchestrationError(`Debate final gate: a stage exists past the final round: ${key}`, 'DEBATE_ARTIFACT_FINAL_GATE_STAGE_PAST_STOP', { stageKey: key });
  }

  // 15. final_ref == final round Debate Chair synthesis sealed_ref.
  const finalRef = rounds[finalRound - 1].synthesis.sealed_ref;
  const finalEntry = manifest.stages?.[debateFinalStageKey(finalRound)];
  if (!finalEntry || JSON.stringify(finalEntry.sealed_ref) !== JSON.stringify(finalRef)) {
    throw new CouncilArtifactOrchestrationError('Debate final gate: final_ref does not equal the final round Debate synthesis sealed_ref', 'DEBATE_ARTIFACT_FINAL_GATE_FINAL_REF_MISMATCH');
  }
  if (manifest.final_ref && JSON.stringify(manifest.final_ref) !== JSON.stringify(finalRef)) {
    throw new CouncilArtifactOrchestrationError('Debate final gate: a different final_ref is already committed', 'DEBATE_ARTIFACT_FINAL_GATE_ALREADY_COMMITTED');
  }
  return { finalRef, finalRound, roundsRun: finalRound, engineForcedStop };
}

/**
 * §31 — commit `final_ref = final Debate Chair synthesis sealed_ref` under the
 * final Debate synthesis stage key, marking the task COMPLETED /
 * TASK_ARTIFACT_PASS. Never leaves Council synthesis as final_ref.
 */
export function commitDebateFinalRef({ task, finalRef, finalRound }) {
  const finalManifest = task.commitFinalRef({
    finalRef, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS',
    expectedStageKey: debateFinalStageKey(finalRound),
  });
  return finalManifest.final_ref;
}

/** §30/§31 — verify the Debate topology, then commit the final Debate ref. */
export function runDebateFinalArtifactGate(args) {
  const { finalRef, finalRound } = verifyDebateArtifactTopology(args);
  return commitDebateFinalRef({ task: args.task, finalRef, finalRound });
}
