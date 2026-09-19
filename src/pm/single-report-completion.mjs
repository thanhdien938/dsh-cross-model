/**
 * P20.3 §16 / §23 / §24 / §28 — the SINGLE artifact_v1 completion
 * orchestrator: DELIVERED -> Invocation Artifact Gate (+ bounded repair) ->
 * SEALED -> sealed ArtifactReference -> Task Final Artifact Gate ->
 * final_ref + task COMPLETED.
 *
 * P20.4 §11: the gate/repair/exec-log/seal/commitStageSeal body is now the
 * shared `completeReportArtifact()` in ./report-stage-completion.mjs (one
 * reusable report-stage lifecycle for SINGLE + every Council stage). This
 * wrapper keeps the SINGLE-specific behaviour: stage key `single`, and the
 * Task Final Artifact Gate on top so the SINGLE `artifact_v1` flow COMPLETES.
 * Public API, return shape, and observable behaviour are unchanged.
 *
 * §28 seam decision: `ReportInvoker.invokeReport()` is UNCHANGED — it still
 * ends at DELIVERED. Integrity / seal / authority live HERE, so a partial
 * commit is recoverable from fresh disk state (artifact-recovery.mjs
 * `resumeSingleTaskFromDisk`).
 *
 * No live model calls.
 */

import { INTEGRITY_STATE } from '../artifacts/artifact-integrity.mjs';
import { runTaskFinalArtifactGate } from '../artifacts/artifact-recovery.mjs';
import { completeReportArtifact, runBoundedDeliveryRepair } from './report-stage-completion.mjs';

export { runBoundedDeliveryRepair };

export class SingleReportCompletionError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'SingleReportCompletionError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const STAGE_KEY = 'single';

/**
 * @param {object} input  see `completeReportArtifact` — plus SINGLE always
 *        seals stage key `single` and then runs the Task Final Artifact Gate.
 * @returns {{ integrity, sealedReference, finalRef, sealedRecord, manifest, repaired, repairKind, sealedAttemptOrdinal }}
 */
export async function completeSingleReportArtifact(input) {
  const {
    store, task, invocation, expected,
    capabilityPolicy, inputTransport = null,
    reportBackend = null, directWriter = null,
    deliveryMechanism = 'VERBATIM_MATERIALIZATION',
    maxReportBytes, now = () => new Date().toISOString(),
  } = input ?? {};

  if (!store || !task || !invocation) throw new SingleReportCompletionError('store, task and invocation are required', 'SINGLE_COMPLETE_BAD_INPUT');
  if (!Number.isInteger(input?.attemptOrdinal) || input.attemptOrdinal < 0) throw new SingleReportCompletionError('attemptOrdinal is required', 'SINGLE_COMPLETE_BAD_INPUT');

  let stage;
  try {
    stage = await completeReportArtifact({
      store, task, invocation, expected, stageKey: STAGE_KEY,
      attemptOrdinal: input.attemptOrdinal,
      capabilityPolicy, inputTransport, reportBackend, directWriter, deliveryMechanism, maxReportBytes, now,
    });
  } catch (error) {
    // Preserve the SINGLE error identity/codes callers/tests assert on.
    throw new SingleReportCompletionError(error.message, error.code ?? INTEGRITY_STATE.ARTIFACT_REPAIR_FAILED, { cause: error.cause ?? error.code ?? null });
  }

  const { finalRef, manifest } = runTaskFinalArtifactGate({
    store, task, stageKey: STAGE_KEY, maxReportBytes: stage.gateResult.sizePolicy.max_report_bytes,
  });

  return {
    integrity: stage.integrity,
    sealedReference: stage.sealedReference,
    finalRef,
    sealedRecord: stage.sealedRecord,
    manifest,
    repaired: stage.repaired,
    repairKind: stage.repairKind,
    sealedAttemptOrdinal: stage.sealedAttemptOrdinal,
  };
}
