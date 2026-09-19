/**
 * P20.2B — the first-class report invocation port.
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §5, §12, §13, §19, §26.
 *
 * `invokeReport()` is the report CONTENT plane. It is structurally separate
 * from `driver.decide()` (the CONTROL plane). It MUST NOT reach:
 *   parseDecision · acceptPmOutput semantic path · canonicalizer ·
 *   participant semantic repair · single-decision extraction.
 * This module imports NONE of those — the parser/canonicalizer bypass is
 * enforced by construction, and a spy test proves the call count is 0.
 *
 * P20.2 may take an invocation/attempt through ASSIGNED → RUNNING →
 * DELIVERED and return an UNSEALED artifact candidate. It never SEALs,
 * never selects `authoritative_attempt`, never sets a task `final_ref`.
 */

import {
  validateReportBackendResult,
  reportDeliveryEligible,
  sha256HexUtf8,
  TERMINAL_STATE,
  buildReportBackendResult,
} from './report-backend-result.mjs';
import { renderReportPrompt } from './report-prompt.mjs';
import {
  deliverVerbatimMaterialization,
  deliverDirectWrite,
  DELIVERY_MECHANISM,
} from '../artifacts/artifact-delivery.mjs';
import { writeReportExecutiveLog } from '../artifacts/report-executive-log.mjs';
import { writeExecutionDiagnosticsArtifact, executionDiagnosticsRelpath } from '../artifacts/execution-diagnostics-artifact.mjs';
import { withoutForensicPreview } from './report-backends/report-execution-forensics.mjs';
import { assertReportRoute } from '../artifacts/backend-report-capability.mjs';
import { buildArtifactReference, validateArtifactReference } from '../artifacts/artifact-schema.mjs';
import { ARTIFACT_STAGE, stageRequiresRound } from '../artifacts/artifact-paths.mjs';
import { assertBackendTaskModeSupported, taskModeForArtifactStage } from '../runtime/production-backend-capabilities.mjs';

export class ReportInvocationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ReportInvocationError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const norm = (v) => (v === undefined ? null : v);

/**
 * P20.2R R1 — one validation seam that binds the app-owned
 * ReportInvocationRequest to the PERSISTED P20.1 metadata end to end.
 * Reads `task.manifest` (task-manifest.json), `invocation.record`
 * (invocation.json), and `attempt.metadata` (attempt artifact.json) and
 * refuses a mismatch on ANY immutable field. No semantic parsing.
 *
 * Throws `ReportInvocationError` code `REPORT_INVOCATION_BINDING_MISMATCH`
 * with a `mismatches` list.
 */
export function assertReportInvocationBinding(request) {
  const mismatches = [];
  const eq = (field, ...values) => {
    const [head, ...rest] = values.map(norm);
    if (rest.some((v) => v !== head)) mismatches.push(`${field}: ${JSON.stringify(values.map(norm))}`);
  };

  let manifest;
  let record;
  let meta;
  try { manifest = request.task.manifest; } catch (e) { throw new ReportInvocationError(`task manifest unreadable: ${e.message}`, 'REPORT_INVOCATION_BINDING_MISMATCH', { field: 'task.manifest' }); }
  try { record = request.invocation.record; } catch (e) { throw new ReportInvocationError(`invocation record unreadable: ${e.message}`, 'REPORT_INVOCATION_BINDING_MISMATCH', { field: 'invocation.record' }); }
  try { meta = request.attempt.metadata; } catch (e) { throw new ReportInvocationError(`attempt metadata unreadable: ${e.message}`, 'REPORT_INVOCATION_BINDING_MISMATCH', { field: 'attempt.metadata' }); }

  // store / project
  eq('store_id', request.store.storeId, manifest.store_id, record.store_id, meta.store_id);
  eq('project_id', request.store.projectId, manifest.project_id, record.project_id, meta.project_id);
  // task identity
  eq('task_id', request.taskId, request.task.taskId, manifest.task_id, record.task_id, meta.task_id);
  // invocation identity
  eq('invocation_id', request.invocation.invocationId, record.invocation_id, meta.invocation_id);
  // attempt identity + execution chain
  eq('attempt_ordinal', request.attempt.ordinal, meta.attempt_ordinal);
  eq('execution_id', request.executionId, request.attempt.executionId, meta.execution_id);
  // role / stage / round / profile / alias
  eq('role', request.role, record.role, meta.role);
  eq('stage', request.stage, record.stage, meta.stage);
  eq('round', request.round ?? null, record.round ?? null, meta.round ?? null);
  eq('profile_id', request.profileId, record.profile_id, meta.profile_id);
  eq('actor_alias', request.actorAlias, record.actor_alias, meta.actor_alias);

  if (mismatches.length) {
    throw new ReportInvocationError(
      `report invocation request is not consistent with persisted P20.1 metadata: ${mismatches.join('; ')}`,
      'REPORT_INVOCATION_BINDING_MISMATCH',
      { mismatches },
    );
  }
}

/**
 * P20.2R R1 — the returned execution facts must belong to THIS request.
 * Throws `REPORT_BACKEND_RESULT_BINDING_MISMATCH` before any delivery.
 */
export function assertReportBackendResultBinding(request, result) {
  const mismatches = [];
  if (result.backend !== request.backend) mismatches.push(`backend: result=${JSON.stringify(result.backend)} request=${JSON.stringify(request.backend)}`);
  if (result.profile_id !== request.profileId) mismatches.push(`profile_id: result=${JSON.stringify(result.profile_id)} request=${JSON.stringify(request.profileId)}`);
  if (result.execution_id !== request.executionId) mismatches.push(`execution_id: result=${JSON.stringify(result.execution_id)} request=${JSON.stringify(request.executionId)}`);
  if (mismatches.length) {
    throw new ReportInvocationError(
      `report backend result does not belong to this request: ${mismatches.join('; ')}`,
      'REPORT_BACKEND_RESULT_BINDING_MISMATCH',
      { mismatches },
    );
  }
}

/**
 * Build the report prompt from a ReportInvocationRequest. The model never
 * chooses its own official artifact path (§13); the assigned path comes
 * from the app-owned attempt.
 */
export function buildReportPromptFromRequest(request) {
  // P23.2 §3/§4/§10G — for every Debate stage (brief / response / chair
  // synthesis), the app-owned round ceiling MUST come from the SAME
  // `request.maxRounds` the engine's own round loop already resolved from
  // `council.debate.max_rounds` (council-chair-driver.mjs's
  // `#artifactDebateDecide`, capped at DEBATE_MAX_ROUNDS) — never a second,
  // independently-derived value, never owner/report prose, never a
  // hardcoded literal. Fail closed rather than silently inventing a value:
  // an unresolved ceiling must never surface a made-up "2" to the model.
  const isDebateStage = stageRequiresRound(request.stage);
  let debateRoundFacts = null;
  if (isDebateStage) {
    const round = request.round;
    const maxRounds = request.maxRounds;
    if (!Number.isInteger(round) || round < 1 || !Number.isInteger(maxRounds) || maxRounds < 1 || round > maxRounds) {
      throw new ReportInvocationError(
        `Debate stage ${JSON.stringify(request.stage)} requires a resolved app-owned round/maxRounds pair, got round=${JSON.stringify(round)} maxRounds=${JSON.stringify(maxRounds)}`,
        'REPORT_PROMPT_DEBATE_ROUND_POSITION_UNRESOLVED',
      );
    }
    debateRoundFacts = {
      debateCurrentRound: round,
      debateMaxRounds: maxRounds,
      debateRoundsRemainingAfterThis: maxRounds - round,
      debateRoundContract: 'MAXIMUM_N',
    };
  }
  const trusted = {
    taskId: request.taskId,
    stage: request.stage,
    role: request.role,
    round: request.round ?? null,
    profileId: request.profileId,
    actorAlias: request.actorAlias,
    deliveryMechanism: request.deliveryMechanism,
    inputTransport: request.inputTransport ?? null,
    sourceWritePolicy: request.sourceWritePolicy ?? 'READ_ONLY',
    assignedReportPath: request.deliveryMechanism === DELIVERY_MECHANISM.DIRECT_WRITE ? request.attempt?.reportPath : null,
    // P20.8R7 §4 — ONLY the Debate chair-synthesis DIRECT_WRITE stage needs
    // the separate same-execution typed-control envelope instruction; every
    // other stage/product is byte-for-byte unaffected. `request.stage` is
    // the app-owned artifact stage string (never model text).
    debateTypedControlRequired: request.deliveryMechanism === DELIVERY_MECHANISM.DIRECT_WRITE && request.stage === ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS,
    ...(debateRoundFacts ?? {}),
    allowedEvidenceLabels: (request.evidence ?? []).map((e) => e.label),
    // P20.6 — NATIVE_ASSIGNED_READ prior-context path descriptors (never bodies).
    assignedSealedArtifacts: Array.isArray(request.contextRefDescriptors) && request.contextRefDescriptors.length
      ? request.contextRefDescriptors
      : null,
  };
  return renderReportPrompt({ trusted, instructions: request.instructions ?? '', evidence: request.evidence ?? [] });
}

/**
 * The report invoker. `reportBackend` must expose
 * `async runReport({ prompt, request }) -> ReportBackendResult`.
 * No PM parser/canonicalizer is ever consulted.
 *
 * @param {object} deps  optional DI overrides (tests)
 */
export class ReportInvoker {
  #deliverVerbatim; #deliverDirect; #writeLog; #writeDiagnostics;

  constructor(deps = {}) {
    this.#deliverVerbatim = deps.deliverVerbatimMaterialization ?? deliverVerbatimMaterialization;
    this.#deliverDirect = deps.deliverDirectWrite ?? deliverDirectWrite;
    this.#writeLog = deps.writeReportExecutiveLog ?? writeReportExecutiveLog;
    // P23.1 §4 — the dedicated non-SUCCESS forensic artifact writer.
    // Separate DI slot (mirrors #writeLog) so tests can spy/stub it
    // independently without touching executive-log behavior.
    this.#writeDiagnostics = deps.writeExecutionDiagnosticsArtifact ?? writeExecutionDiagnosticsArtifact;
  }

  /**
   * @param {object} input
   * @param {object} input.request  a ReportInvocationRequest (see §13). Must
   *        carry: store, task, invocation, attempt (P20.1 workspaces),
   *        taskId, stage, role, round, profileId, backend, actorAlias,
   *        executionId, deliveryMechanism, inputTransport, capabilityPolicy,
   *        instructions, evidence, and (for DIRECT_WRITE) directWriter.
   * @param {object} input.reportBackend  { runReport({prompt, request}) }
   * @returns {Promise<{ result, delivery, executiveLog, unsealedCandidate, prompt }>}
   */
  async invokeReport({ request, reportBackend }) {
    if (!request || typeof request !== 'object') {
      throw new ReportInvocationError('request is required', 'REPORT_REQUEST_MISSING');
    }
    for (const k of ['store', 'task', 'invocation', 'attempt', 'taskId', 'stage', 'role', 'profileId', 'backend', 'actorAlias', 'executionId', 'deliveryMechanism']) {
      if (request[k] === undefined || request[k] === null) {
        throw new ReportInvocationError(`request.${k} is required`, 'REPORT_REQUEST_INCOMPLETE', { missing: k });
      }
    }
    if (!reportBackend || typeof reportBackend.runReport !== 'function') {
      throw new ReportInvocationError('reportBackend.runReport(...) is required', 'REPORT_BACKEND_MISSING');
    }

    // P22.5 §A/§C/§D/§E — product-policy task-mode gate, BEFORE the route/
    // delivery check below and BEFORE any provider call. This is a
    // SEPARATE axis from report-delivery/artifact-input capability: a
    // backend can have a fully working route and still be intentionally
    // restricted from a task mode (today: `api` is SINGLE-only by product
    // decision, not by unproven/incomplete migration state). Never
    // mentions PROVEN/UNPROVEN — `BACKEND_TASK_MODE_UNSUPPORTED` is a
    // distinct, clear product-policy error.
    assertBackendTaskModeSupported(request.backend, taskModeForArtifactStage(request.stage));

    // Fail closed on an unsupported / unproven route (§31 — never a silent
    // fallback to the legacy PM parser).
    const route = assertReportRoute({
      policy: request.capabilityPolicy,
      product: request.backend,
      requestedDelivery: request.deliveryMechanism,
      requestedInputTransport: request.inputTransport ?? null,
    });
    if (request.deliveryMechanism === DELIVERY_MECHANISM.DIRECT_WRITE && typeof request.directWriter !== 'function') {
      throw new ReportInvocationError('DIRECT_WRITE requires request.directWriter (a deterministic local writer in P20.2)', 'REPORT_DIRECT_WRITE_NO_WRITER');
    }

    // P20.2R R1: the app-owned request must be consistent with the PERSISTED
    // P20.1 metadata (task-manifest.json / invocation.json / attempt
    // artifact.json) before anything is rendered or written. Duplicated
    // request fields are NOT trusted just because runSingleReport() usually
    // builds them correctly.
    assertReportInvocationBinding(request);

    const prompt = buildReportPromptFromRequest(request);

    // P20.8 PRE-R3 R3-1 — the ONE atomic execution-ownership admission
    // boundary (ASSIGNED -> RUNNING, truthful: we are about to run the
    // provider). Grants exactly once per invocation; a concurrent racer or
    // a later re-entry (sequential retry, restart, or a known-terminal
    // invocation) is refused here, BEFORE the backend is ever called — an
    // UNKNOWN or in-flight provider outcome is never auto-replayed.
    try {
      request.invocation.claimRunning({ attemptOrdinal: request.attempt.ordinal, executionId: request.executionId });
    } catch (error) {
      throw new ReportInvocationError(
        `execution not admitted: ${error.message}`,
        error.code ?? 'REPORT_EXECUTION_NOT_ADMITTED',
        { cause: error.code ?? null },
      );
    }

    const startedAt = new Date().toISOString();
    let result = await reportBackend.runReport({ prompt, request });
    // Cancellation remains authoritative even when a backend races to a
    // nominal success after the owner cancellation was accepted.
    if (request.signal?.aborted) {
      result = buildReportBackendResult({
        backend: request.backend,
        profileId: request.profileId,
        model: result?.model ?? null,
        executionId: request.executionId,
        terminalState: TERMINAL_STATE.CANCELLED,
        cancelled: true,
        durationMs: result?.duration_ms ?? null,
        safeDiagnostics: { error_code: 'REPORT_EXECUTION_CANCELLED' },
      });
    }

    const rv = validateReportBackendResult(result);
    if (!rv.ok) {
      throw new ReportInvocationError(`report backend result invalid: ${rv.errors.join('; ')}`, 'REPORT_RESULT_INVALID', { errors: rv.errors });
    }
    // P20.2R R1: the returned execution facts must belong to THIS request —
    // fail closed before any report bytes are written.
    assertReportBackendResultBinding(request, result);
    const elig = reportDeliveryEligible(result);
    if (!elig.eligible) {
      // P23.1 Fix C — forensic audit finding: a TIMEOUT/FAILED result used
      // to throw HERE, before executive.log or any diagnostic evidence was
      // ever written (report-executive-log.mjs's writeReportExecutiveLog()
      // was only ever reached past this gate). Truthfulness is UNCHANGED —
      // no delivery, no lifecycle advance to DELIVERED, no report.md, and
      // recordDelivery() below is still never reached on this branch — but
      // forensic evidence (executive.log + execution-diagnostics.json) is
      // now captured for every non-SUCCESS terminal result BEFORE the
      // throw, so a future timeout/failure is diagnosable even when no
      // report bytes ever existed.
      const nonSuccessFinishedAt = new Date().toISOString();
      const meta = request.attempt.metadata ?? {};
      const compactDiagnostics = withoutForensicPreview(result.safe_diagnostics ?? null);
      const preview = (result.safe_diagnostics && typeof result.safe_diagnostics === 'object') ? result.safe_diagnostics.preview ?? null : null;
      const diagnosticsRelpath = executionDiagnosticsRelpath(meta.report_relpath ?? null);
      const ws = request.workspaceEvidence ?? null;
      const commonFacts = {
        task_id: request.taskId,
        invocation_id: request.invocation.invocationId,
        execution_id: request.executionId,
        attempt_ordinal: request.attempt.ordinal,
        store_id: meta.store_id ?? request.store.storeId,
        project_id: meta.project_id ?? request.store.projectId,
        role: request.role,
        stage: request.stage,
        round: request.round ?? null,
        profile_id: request.profileId,
        backend: request.backend,
        model: result.model ?? null,
        actor_alias: request.actorAlias,
        started_at: startedAt,
        finished_at: nonSuccessFinishedAt,
        duration_ms: result.duration_ms ?? null,
        terminal_state: result.terminal_state,
        // Prefer the BACKEND's own error code (e.g. 'CLAUDE_TIMEOUT') when
        // the report backend supplied one — more specific than the generic
        // delivery-eligibility rejection code, which is near-mechanically
        // derived from terminal_state alone (TIMEOUT -> REPORT_EXECUTION_
        // TIMEOUT, always). Falls back to that generic code only when the
        // backend's result carries no safe_diagnostics.error_code at all.
        error_code: result.safe_diagnostics?.error_code ?? elig.code,
        timed_out: result.timed_out,
        cancelled: result.cancelled,
        provider_finish_reason: result.provider_finish_reason ?? null,
        process_exit_code: result.process_exit_code ?? null,
        workspace_isolation_version: ws?.isolation_version ?? null,
        workspace_repository_common_dir: ws?.repository_common_dir ?? null,
        workspace_path: ws?.workspace_path ?? null,
      };
      // Part P discipline (task-diagnostic-log.mjs's own established
      // philosophy): a diagnostic-write failure must NEVER mask, replace,
      // or upgrade the real eligibility failure below — best-effort only.
      let executiveLog = null;
      try {
        executiveLog = this.#writeLog({
          attempt: request.attempt,
          facts: {
            ...commonFacts,
            // No delivery was ever attempted on this branch — these stay
            // truthfully null/unset rather than implying an outcome that
            // didn't happen.
            delivery_mechanism: null,
            input_transport: route.input,
            assigned_report_relpath: meta.report_relpath ?? null,
            report_bytes: null,
            report_sha256_observed: null,
            visible_output_source: result.visible_output_source ?? null,
            usage: result.usage ?? null,
            diagnostics_artifact_relpath: diagnosticsRelpath,
          },
          safeDiagnostics: compactDiagnostics,
        });
      } catch { /* best-effort — never mask the real eligibility failure */ }
      let diagnosticsArtifact = null;
      try {
        diagnosticsArtifact = this.#writeDiagnostics({
          attempt: request.attempt,
          facts: { ...commonFacts, ...(compactDiagnostics ?? {}) },
          boundedStdoutPreview: preview?.stdout_preview ?? null,
          boundedStderrPreview: preview?.stderr_preview ?? null,
        });
      } catch { /* best-effort — never mask the real eligibility failure */ }
      // Truthful non-success — no delivery, no lifecycle advance to DELIVERED.
      throw new ReportInvocationError(`report execution is not delivery-eligible: ${elig.reason}`, elig.code, {
        terminalState: result.terminal_state, executiveLog, diagnosticsArtifact,
      });
    }

    // Deliver.
    let delivery;
    if (route.delivery === DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION) {
      if (typeof result.accepted_visible_text !== 'string') {
        throw new ReportInvocationError('VERBATIM_MATERIALIZATION requires accepted_visible_text on the report result', 'REPORT_NO_VISIBLE_TEXT');
      }
      delivery = this.#deliverVerbatim({ attempt: request.attempt, acceptedVisibleText: result.accepted_visible_text });
    } else {
      delivery = this.#deliverDirect({ attempt: request.attempt, writer: request.directWriter, allowEmptyAck: true });
    }
    const finishedAt = new Date().toISOString();

    // Executive log (delivery evidence, not seal).
    const meta = request.attempt.metadata ?? {};
    const ws = request.workspaceEvidence ?? null;
    const executiveLog = this.#writeLog({
      attempt: request.attempt,
      facts: {
        task_id: request.taskId,
        invocation_id: request.invocation.invocationId,
        execution_id: request.executionId,
        attempt_ordinal: request.attempt.ordinal,
        store_id: meta.store_id ?? request.store.storeId,
        project_id: meta.project_id ?? request.store.projectId,
        role: request.role,
        stage: request.stage,
        round: request.round ?? null,
        profile_id: request.profileId,
        backend: request.backend,
        model: result.model ?? null,
        actor_alias: request.actorAlias,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: result.duration_ms ?? null,
        terminal_state: result.terminal_state,
        timed_out: result.timed_out,
        cancelled: result.cancelled,
        provider_finish_reason: result.provider_finish_reason ?? null,
        process_exit_code: result.process_exit_code ?? null,
        delivery_mechanism: delivery.mechanism,
        input_transport: route.input,
        assigned_report_relpath: meta.report_relpath ?? null,
        report_bytes: delivery.bytes,
        report_sha256_observed: delivery.sha256,
        visible_output_source: result.visible_output_source ?? null,
        usage: result.usage ?? null,
        workspace_isolation_version: ws?.isolation_version ?? null,
        workspace_repository_common_dir: ws?.repository_common_dir ?? null,
        workspace_path: ws?.workspace_path ?? null,
      },
      safeDiagnostics: withoutForensicPreview(result.safe_diagnostics ?? null),
    });

    // Record delivery evidence on artifact.json + advance to DELIVERED.
    request.invocation.recordDelivery({
      attemptOrdinal: request.attempt.ordinal,
      terminalState: TERMINAL_STATE.SUCCESS,
      deliveryMechanism: delivery.mechanism,
      inputTransport: route.input,
      finishedAt,
      reportBytes: delivery.bytes,
      reportSha256: delivery.sha256,
      executiveLogRelpath: meta.executive_log_relpath ?? null,
      providerFinishReason: result.provider_finish_reason ?? null,
    });

    // UNSEALED artifact candidate — schema-distinguishable from a sealed
    // ArtifactReference (validateArtifactReference(..).sealed === false;
    // requireSealed:true rejects it). No fake sealed_at / sha authority.
    const reference = buildArtifactReference({
      storeId: meta.store_id ?? request.store.storeId,
      projectId: meta.project_id ?? request.store.projectId,
      taskId: request.taskId,
      invocationId: request.invocation.invocationId,
      attemptOrdinal: request.attempt.ordinal,
      artifactRelpath: meta.report_relpath ?? null,
    }, { sealed: false });
    const unsealedCandidate = Object.freeze({
      kind: 'UnsealedReportArtifactCandidate',
      sealed: false,
      reference,
      reference_valid: validateArtifactReference(reference).ok,
      delivery_observed: Object.freeze({ bytes: delivery.bytes, sha256: delivery.sha256, report_path: delivery.reportPath }),
      lifecycle: 'DELIVERED',
    });

    return { result, delivery, executiveLog, unsealedCandidate, prompt };
  }
}

/** Convenience factory. */
export function createReportInvoker(deps = {}) {
  return new ReportInvoker(deps);
}
