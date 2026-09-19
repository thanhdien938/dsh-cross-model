/**
 * P20.8 §6.3 — production SINGLE artifact_v1 driver.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §6.3.
 *
 * A new production SINGLE task admitted to `artifact_v1` must use the P20
 * report-content path (runSingleReport + completeSingleReportArtifact),
 * seal the required report, and expose owner-facing final output from the
 * authoritative sealed final report — never a hidden legacy semantic
 * parser (§6.3).
 *
 * This is the SINGLE-mode counterpart to CouncilChairDriver's
 * `transportMode:'artifact_v1'` bridging: a PM driver (assertPmDriver()'s
 * `{ name, decide(input) }` contract, pm-contracts.mjs) that DurablePmRuntime
 * can turn against unchanged. Unlike CouncilChairDriver it is a ONE-TURN
 * state machine — there is only ever a single provider report to produce —
 * so it never emits a WORKFLOW/PEER_EXCHANGE/AWAIT_OWNER decision; turn 0
 * always resolves directly to a `finish` decision (or throws, which
 * DurablePmRuntime turns into a normal `failed` PmRun, identical to any
 * other PM decide() failure).
 *
 * `runSingleReport({..., complete:true})` already performs the FULL
 * report-content-plane lifecycle (allocate -> invoke -> DELIVERED ->
 * integrity gate -> seal -> Task Final Artifact Gate -> `final_ref`) using
 * the accepted P20.2/P20.3 primitives — this driver adds NO second
 * orchestration topology, it only supplies the deterministic identity and
 * bridges the result into a PM decision.
 *
 * Crash-restart safety: `invocationId` is derived deterministically from
 * `taskId` (never random), so a DurablePmRuntime resume that re-invokes
 * `decide()` for the same never-committed turn 0 allocates/opens the SAME
 * invocation record. If that invocation is already RUNNING/DELIVERED/SEALED
 * on disk from an earlier crashed attempt, the PRE-R3 `claimRunning()`
 * execution-ownership admission (report-invocation.mjs) refuses the
 * re-entry — this driver never silently re-runs a live/settled provider
 * outcome; the resulting error propagates and the PmRun is marked `failed`,
 * never a replay.
 */

import { randomUUID } from 'node:crypto';
import { DELIVERY_MECHANISM } from '../artifacts/artifact-delivery.mjs';
import { INPUT_TRANSPORT } from '../artifacts/artifact-schema.mjs';
import { deterministicOwnerId } from '../owner/owner-contracts.mjs';
import { runSingleReport, SingleReportOperationError } from './single-report-operation.mjs';
import { ReportInvoker } from './report-invocation.mjs';

export class SingleArtifactDriverError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'SingleArtifactDriverError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Deterministic SINGLE artifact_v1 invocation identity for one owner task. */
export function singleArtifactInvocationId(taskId) {
  return deterministicOwnerId('inv', taskId, 'single');
}

export class SingleArtifactDriver {
  #store; #taskId; #taskSlug; #createdAt; #invocationId;
  #profileId; #actorAlias; #instructions; #evidence;
  #deliveryMechanism; #inputTransport; #resolveReportBackend; #capabilityPolicy;
  #executionOptions;
  #reportInvoker; #maxReportBytes; #contextSelectors; #contextInputTransport; #contextLimits;
  #workspaceEvidence;

  /**
   * @param {object} deps
   * @param {import('../artifacts/artifact-store.mjs').ArtifactStore} deps.store
   * @param {string} deps.taskId
   * @param {string} deps.taskSlug
   * @param {string} deps.createdAt  ISO-8601
   * @param {string} deps.profileId
   * @param {string} deps.actorAlias
   * @param {string} [deps.instructions]  the owner task body — the same
   *        text legacy SINGLE would have rendered into its decision prompt.
   * @param {Array<{label:string,content:string}>} [deps.evidence]
   * @param {(profileId: string) => { backend: string, runReport: Function }} deps.resolveReportBackend
   * @param {object} [deps.capabilityPolicy]  §8 per-run evidence overlay (never DEFAULT_BACKEND_REPORT_POLICY hand-edited)
   * @param {string} [deps.deliveryMechanism]  default VERBATIM_MATERIALIZATION (§9 — smallest safe route)
   * @param {string|null} [deps.inputTransport]
   * @param {number} [deps.maxReportBytes]
   * @param {ReportInvoker} [deps.reportInvoker]
   * @param {Array} [deps.contextSelectors]  P20.6 SINGLE context chaining (optional)
   * @param {string} [deps.contextInputTransport]
   * @param {object} [deps.contextLimits]
   */
  constructor({
    store, taskId, taskSlug, createdAt, profileId, actorAlias,
    instructions = '', evidence = [],
    resolveReportBackend, capabilityPolicy,
    deliveryMechanism = DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION,
    inputTransport = INPUT_TRANSPORT.VERBATIM_CONTENT,
    maxReportBytes, reportInvoker = new ReportInvoker(),
    contextSelectors = null, contextInputTransport = INPUT_TRANSPORT.VERBATIM_CONTENT, contextLimits = {}, executionOptions = null,
    workspaceEvidence = null,
  }) {
    if (!store || typeof store.allocateTask !== 'function') throw new SingleArtifactDriverError('an ArtifactStore is required', 'SINGLE_ARTIFACT_NO_STORE');
    if (typeof taskId !== 'string' || !taskId) throw new SingleArtifactDriverError('taskId is required', 'SINGLE_ARTIFACT_NO_TASK_ID');
    if (typeof profileId !== 'string' || !profileId) throw new SingleArtifactDriverError('profileId is required', 'SINGLE_ARTIFACT_NO_PROFILE');
    if (typeof resolveReportBackend !== 'function') throw new SingleArtifactDriverError('resolveReportBackend(profileId) is required', 'SINGLE_ARTIFACT_NO_BACKEND_RESOLVER');
    this.#store = store;
    this.#taskId = taskId;
    this.#taskSlug = taskSlug ?? taskId;
    this.#createdAt = createdAt ?? new Date().toISOString();
    this.#invocationId = singleArtifactInvocationId(taskId);
    this.#profileId = profileId;
    this.#actorAlias = actorAlias ?? profileId;
    this.#instructions = instructions;
    this.#evidence = evidence;
    this.#resolveReportBackend = resolveReportBackend;
    this.#capabilityPolicy = capabilityPolicy;
    this.#deliveryMechanism = deliveryMechanism;
    this.#inputTransport = inputTransport;
    this.#maxReportBytes = maxReportBytes;
    this.#reportInvoker = reportInvoker;
    this.#contextSelectors = contextSelectors;
    this.#contextInputTransport = contextInputTransport;
    this.#contextLimits = contextLimits;
    this.#executionOptions = executionOptions;
    this.#workspaceEvidence = workspaceEvidence;
  }

  get name() { return `production:artifact_v1:single:${this.#profileId}`; }

  async decide({ turn, signal }) {
    if (turn !== 0) {
      throw new SingleArtifactDriverError('SINGLE artifact_v1 driver only ever runs one turn', 'SINGLE_ARTIFACT_EXTRA_TURN', { turn });
    }
    const resolved = this.#resolveReportBackend(this.#profileId, this.#executionOptions);
    if (!resolved || typeof resolved.runReport !== 'function' || typeof resolved.backend !== 'string') {
      throw new SingleArtifactDriverError(`resolveReportBackend(${JSON.stringify(this.#profileId)}) must return { backend, runReport }`, 'SINGLE_ARTIFACT_BAD_BACKEND');
    }
    const executionId = `exec-${randomUUID()}`;
    let out;
    try {
      out = await runSingleReport({
        store: this.#store,
        taskId: this.#taskId,
        taskSlug: this.#taskSlug,
        createdAt: this.#createdAt,
        invocationId: this.#invocationId,
        executionId,
        profileId: this.#profileId,
        backend: resolved.backend,
        actorAlias: this.#actorAlias,
        instructions: this.#instructions,
        evidence: this.#evidence,
        // P20.8R2 §5/§6 — the exact-profile route the backend resolver
        // proved (DIRECT_WRITE for the three Phase-1 backends) always
        // wins; the constructor default is only a fallback for a caller/
        // test whose `resolveReportBackend` predates these fields.
        deliveryMechanism: resolved.deliveryMechanism ?? this.#deliveryMechanism,
        inputTransport: this.#inputTransport,
        capabilityPolicy: this.#capabilityPolicy,
        reportBackend: { runReport: resolved.runReport },
        directWriter: resolved.deliveryMechanism === 'DIRECT_WRITE' ? (resolved.directWriter ?? undefined) : undefined,
        reportInvoker: this.#reportInvoker,
        complete: true,
        maxReportBytes: this.#maxReportBytes,
        contextSelectors: this.#contextSelectors,
        contextInputTransport: this.#contextInputTransport,
        contextLimits: this.#contextLimits,
        signal,
        timeoutMs: this.#executionOptions?.timeoutMs ?? null,
        workspaceEvidence: this.#workspaceEvidence,
      });
    } catch (error) {
      if (error instanceof SingleReportOperationError) throw error;
      throw new SingleArtifactDriverError(`SINGLE artifact_v1 report failed: ${error.message}`, error.code ?? 'SINGLE_ARTIFACT_REPORT_FAILED', { cause: error });
    }
    if (!out.completion || !out.completion.finalRef) {
      // §6.5 — provider success alone is insufficient; without a sealed
      // Task Final Artifact Gate result this driver refuses to report a
      // finish decision at all (DurablePmRuntime never marks the task
      // COMPLETED from an unsealed/ungated report).
      throw new SingleArtifactDriverError('SINGLE artifact_v1 report delivered but did not seal/gate to a final_ref', 'SINGLE_ARTIFACT_NOT_SEALED', { taskId: this.#taskId });
    }
    const text = typeof out.result?.accepted_visible_text === 'string' ? out.result.accepted_visible_text : '';
    return {
      type: 'finish',
      output: text,
      data: {
        transport_version: 'artifact_v1',
        task_id: this.#taskId,
        invocation_id: this.#invocationId,
        execution_id: executionId,
        backend: resolved.backend,
        profile_id: this.#profileId,
        final_ref: out.completion.finalRef,
        report_sha256: out.delivery?.sha256 ?? null,
        report_bytes: out.delivery?.bytes ?? null,
        sealed_attempt_ordinal: out.completion.sealedAttemptOrdinal ?? null,
      },
    };
  }
}
