/**
 * P20.4 §11 — the ONE reusable sealed report-stage lifecycle.
 *
 * Authority: docs/P20/P20_4_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §11,
 * docs/P20/P20_3_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §16/§23/§24/§28.
 *
 * Extracted verbatim (behaviour-preserving) from the SINGLE-oriented
 * `completeSingleReportArtifact()` so `chair-plan`, `participant-report`,
 * `participant-critique` and `chair-council-synthesis` all seal their own
 * report through the SAME path:
 *
 *   DELIVERED attempt
 *   -> Invocation Artifact Gate (P20.3R terminal-truth-first)
 *   -> at most ONE bounded delivery repair (P20.3R identity/capability bound)
 *   -> executive.log finalization (BEFORE seal)
 *   -> artifact.json finalization
 *   -> commitInvocationSeal()  (SEALED + authoritative_attempt + stage seal)
 *   -> sealed ArtifactReference
 *
 * It does NOT run the task Final Artifact Gate and does NOT set `final_ref`
 * — an intermediate Council stage seals only its OWN report (task §11). The
 * SINGLE wrapper adds `runTaskFinalArtifactGate()` on top; the Council
 * orchestrator adds a Council-topology final gate.
 *
 * No live model calls. A repair re-invokes the SAME fake/admitted
 * `reportBackend` the caller passed.
 */

import { join, resolve } from 'node:path';

import { createInvocationArtifactGate, INTEGRITY_STATE, ArtifactIntegrityError, isReportEmpty } from '../artifacts/artifact-integrity.mjs';
import { writeReportExecutiveLog, finalizeReportExecutiveLog } from '../artifacts/report-executive-log.mjs';
import {
  findMisplacedReportCandidates,
  relocateMisplacedReport,
  classifyRepair,
  assertNotAlreadyRepairAttempt,
  REPAIR_BOUND,
} from '../artifacts/artifact-repair.mjs';
import { commitInvocationSeal } from '../artifacts/artifact-recovery.mjs';
import { deliverVerbatimMaterialization, deliverDirectWrite } from '../artifacts/artifact-delivery.mjs';
import { validateReportBackendResult, reportDeliveryEligible } from './report-backend-result.mjs';
import { assertReportBackendResultBinding } from './report-invocation.mjs';
import { assertReportRoute } from '../artifacts/backend-report-capability.mjs';

export class ReportStageCompletionError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ReportStageCompletionError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const attemptDirOf = (invPath, ordinal) => join(invPath, `attempt-${String(ordinal).padStart(2, '0')}`);
const reportAbsOf = (storeRoot, relpath) => resolve(storeRoot, ...String(relpath).split('/'));

const REPAIR_FAIL = INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED;

/**
 * P20.3R R2 — one bounded delivery repair (a NEW attempt on the SAME
 * invocation / profile / backend, new execution_id). Route re-admitted
 * against the ORIGINAL capabilityPolicy; result identity-bound; persisted
 * metadata re-verified. Never a hidden failover.
 */
export async function runBoundedDeliveryRepair({ store, invocation, priorOrdinal, expected, capabilityPolicy, reportBackend, directWriter, deliveryMechanism, inputTransport, now }) {
  if (!reportBackend || typeof reportBackend.runReport !== 'function') {
    throw new ReportStageCompletionError('a delivery repair is required but no reportBackend was supplied', REPAIR_FAIL);
  }
  try {
    assertReportRoute({ policy: capabilityPolicy, product: expected.backend, requestedDelivery: deliveryMechanism, requestedInputTransport: inputTransport ?? null });
  } catch (error) {
    throw new ReportStageCompletionError(`repair delivery route not admitted: ${error.message}`, REPAIR_FAIL, { cause: error.code });
  }

  const startedAt = now();
  const repairAttempt = invocation.allocateAttempt({
    deliveryMechanism,
    startedAt,
    inputTransport: inputTransport ?? null,
    executionId: `exec-repair-${Math.random().toString(36).slice(2, 12)}`,
    repairOf: priorOrdinal,
  });

  const repairRequest = { ...expected, backend: expected.backend, profileId: expected.profileId, executionId: repairAttempt.executionId };

  const result = await reportBackend.runReport({
    prompt: '__ARTIFACT_DELIVERY_REPAIR__ produce the COMPLETE report body as the final visible output.',
    request: repairRequest,
  });
  const rv = validateReportBackendResult(result);
  if (!rv.ok) throw new ReportStageCompletionError(`repair backend result invalid: ${rv.errors.join('; ')}`, REPAIR_FAIL);
  try {
    assertReportBackendResultBinding(repairRequest, result);
  } catch (error) {
    throw new ReportStageCompletionError(`repair result identity mismatch: ${error.message}`, REPAIR_FAIL, { cause: error.code });
  }
  const elig = reportDeliveryEligible(result);
  if (!elig.eligible) throw new ReportStageCompletionError(`repair execution not delivery-eligible: ${elig.reason}`, REPAIR_FAIL);

  if (deliveryMechanism === 'DIRECT_WRITE') {
    if (typeof directWriter !== 'function') throw new ReportStageCompletionError('DIRECT_WRITE repair needs a directWriter', REPAIR_FAIL);
    deliverDirectWrite({ attempt: repairAttempt, writer: directWriter, allowEmptyAck: true });
  } else {
    if (typeof result.accepted_visible_text !== 'string' || isReportEmpty(Buffer.from(result.accepted_visible_text, 'utf8'))) {
      throw new ReportStageCompletionError('repair returned an empty body (0 bytes or Unicode-whitespace only; a token is not a report)', REPAIR_FAIL);
    }
    deliverVerbatimMaterialization({ attempt: repairAttempt, acceptedVisibleText: result.accepted_visible_text });
  }
  const finishedAt = now();
  const rMeta = repairAttempt.metadata;
  writeReportExecutiveLog({
    attempt: repairAttempt,
    facts: {
      task_id: expected.taskId, invocation_id: invocation.invocationId, execution_id: repairAttempt.executionId,
      attempt_ordinal: repairAttempt.ordinal, store_id: store.storeId, project_id: store.projectId,
      role: expected.role, stage: expected.stage, round: expected.round ?? null,
      profile_id: expected.profileId, backend: expected.backend, actor_alias: expected.actorAlias,
      started_at: startedAt, finished_at: finishedAt, terminal_state: 'SUCCESS',
      delivery_mechanism: deliveryMechanism, assigned_report_relpath: rMeta.report_relpath,
    },
  });
  invocation.recordDelivery({
    attemptOrdinal: repairAttempt.ordinal, terminalState: 'SUCCESS', deliveryMechanism,
    finishedAt, reportBytes: null, reportSha256: null,
  });

  const persisted = invocation.freshAttemptMetadata(repairAttempt.ordinal);
  const mm = [];
  for (const [f, want, have] of [
    ['store_id', store.storeId, persisted.store_id],
    ['project_id', store.projectId, persisted.project_id],
    ['task_id', expected.taskId, persisted.task_id],
    ['invocation_id', expected.invocationId, persisted.invocation_id],
    ['attempt_ordinal', repairAttempt.ordinal, persisted.attempt_ordinal],
    ['execution_id', repairAttempt.executionId, persisted.execution_id],
    ['role', expected.role, persisted.role],
    ['stage', expected.stage, persisted.stage],
    ['round', expected.round ?? null, persisted.round ?? null],
    ['profile_id', expected.profileId, persisted.profile_id],
    ['actor_alias', expected.actorAlias, persisted.actor_alias],
  ]) {
    if (want !== have) mm.push(`${f}: want=${JSON.stringify(want)} on-disk=${JSON.stringify(have)}`);
  }
  if (mm.length) throw new ReportStageCompletionError(`repair attempt persisted metadata mismatch: ${mm.join('; ')}`, REPAIR_FAIL);

  return { ordinal: repairAttempt.ordinal, executionId: repairAttempt.executionId };
}

/**
 * Gate + bounded repair + executive.log finalization + artifact.json
 * finalization + `commitInvocationSeal(stageKey)` for ONE report stage. Does
 * NOT touch the task final ref.
 *
 * @param {object} input
 * @param {import('../artifacts/artifact-store.mjs').ArtifactStore} input.store
 * @param {import('../artifacts/artifact-store.mjs').TaskWorkspace} input.task
 * @param {import('../artifacts/artifact-store.mjs').InvocationWorkspace} input.invocation
 * @param {number} input.attemptOrdinal
 * @param {string} input.stageKey  the manifest stage key this stage seals
 * @param {object} input.expected  { storeId, projectId, taskId, invocationId, role, stage, round, profileId, actorAlias, executionId, backend }
 * @param {object} [input.capabilityPolicy]
 * @param {string} [input.inputTransport]
 * @param {object} [input.reportBackend]  used only for a Case B/C bounded delivery repair
 * @param {Function} [input.directWriter]
 * @param {'VERBATIM_MATERIALIZATION'|'DIRECT_WRITE'} [input.deliveryMechanism]
 * @param {number} [input.maxReportBytes]
 * @param {() => string} [input.now]
 * @returns {{ integrity, sealedReference, sealedRecord, repaired, repairKind, sealedAttemptOrdinal, gateResult }}
 */
export async function completeReportArtifact(input) {
  const {
    store, task, invocation, expected, stageKey,
    capabilityPolicy, inputTransport = null,
    reportBackend = null, directWriter = null,
    deliveryMechanism = 'VERBATIM_MATERIALIZATION',
    maxReportBytes, now = () => new Date().toISOString(),
  } = input ?? {};
  let attemptOrdinal = input?.attemptOrdinal;

  if (!store || !task || !invocation) throw new ReportStageCompletionError('store, task and invocation are required', 'REPORT_STAGE_BAD_INPUT');
  if (typeof stageKey !== 'string' || !stageKey) throw new ReportStageCompletionError('stageKey is required', 'REPORT_STAGE_BAD_INPUT');
  if (!Number.isInteger(attemptOrdinal) || attemptOrdinal < 0) throw new ReportStageCompletionError('attemptOrdinal is required', 'REPORT_STAGE_BAD_INPUT');

  const gate = createInvocationArtifactGate(maxReportBytes ? { maxReportBytes } : {});
  let repaired = false;
  let repairKind = null;
  let gateResult = null;
  let currentExpected = { ...expected };

  for (let pass = 0; pass < 1 + REPAIR_BOUND.maxDeliveryRepairAttempts; pass += 1) {
    try {
      gateResult = gate({ store, invocation, attemptOrdinal, expected: currentExpected });
      break;
    } catch (error) {
      if (!(error instanceof ArtifactIntegrityError)) throw error;
      if (repaired) {
        throw new ReportStageCompletionError(`artifact repair did not recover the report: ${error.message}`, REPAIR_FAIL, { cause: error.code });
      }
      const meta = invocation.freshAttemptMetadata(attemptOrdinal);
      assertNotAlreadyRepairAttempt(meta);
      const attemptDir = attemptDirOf(invocation.path, attemptOrdinal);
      const expectedReportName = String(meta.report_relpath).split('/').pop();
      const candidates = findMisplacedReportCandidates({ attemptDir, expectedReportName, ...(maxReportBytes ? { maxReportBytes } : {}) });
      const plan = classifyRepair(error, candidates);
      if (plan.action === 'NONE') {
        throw new ReportStageCompletionError(`integrity failure ${error.code} is not repairable in P20`, error.code, { cause: error.code });
      }
      if (plan.action === 'RELOCATE') {
        relocateMisplacedReport({
          candidatePath: plan.candidate,
          expectedReportPath: reportAbsOf(store.root, meta.report_relpath),
          attemptDir,
        });
        repaired = true;
        repairKind = 'RELOCATE_MISPLACED';
        continue;
      }
      const rep = await runBoundedDeliveryRepair({
        store, invocation, priorOrdinal: attemptOrdinal, expected: currentExpected,
        capabilityPolicy, inputTransport, reportBackend, directWriter, deliveryMechanism, now,
      });
      attemptOrdinal = rep.ordinal;
      currentExpected = { ...currentExpected, executionId: rep.executionId };
      repaired = true;
      repairKind = plan.case === 'C'
        ? 'DELIVERY_REPAIR_MULTI_CANDIDATE'
        : (plan.case === 'B' && error.code === INTEGRITY_STATE.REPORT_EMPTY ? 'DELIVERY_REPAIR_EMPTY_REPORT' : 'DELIVERY_REPAIR_ZERO_CANDIDATE');
      continue;
    }
  }
  if (!gateResult) throw new ReportStageCompletionError('Invocation Artifact Gate did not pass after the bounded repair budget', REPAIR_FAIL);

  finalizeReportExecutiveLog({
    logPath: gateResult.executiveLogPath,
    finalization: {
      integrity_state: INTEGRITY_STATE.ARTIFACT_PASS,
      final_report_bytes: gateResult.bytes,
      final_report_sha256: gateResult.sha256,
      repair_state: repaired ? repairKind : 'NONE',
      seal_version: 'p20.3-1',
      size_policy_version: gateResult.sizePolicy.version,
      max_report_bytes: gateResult.sizePolicy.max_report_bytes,
    },
  });

  const { reference, sealedRecord } = commitInvocationSeal({
    store, task, invocation, attemptOrdinal, gateResult, stageKey,
    executiveLogFinalized: true, now,
  });

  return {
    integrity: gateResult.state,
    sealedReference: reference,
    sealedRecord,
    repaired,
    repairKind,
    sealedAttemptOrdinal: attemptOrdinal,
    gateResult,
  };
}
