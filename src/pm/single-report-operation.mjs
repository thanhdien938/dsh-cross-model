/**
 * P20.2 §24 — first SINGLE report operation (offline test-harness helper).
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §24, §31.
 *
 * Demonstrates, offline, the full report-content plane for a SINGLE stage:
 *   P20 artifact store
 *     -> SINGLE task/invocation/attempt allocation (P20.1)
 *     -> fail-closed report route resolution (P20.2E)
 *     -> report prompt render (P20.2C)
 *     -> report backend execution (fake / admitted `api` transport — no live call)
 *     -> VERBATIM_MATERIALIZATION or fake DIRECT_WRITE (P20.2 §15/§16)
 *     -> executive.log delivery evidence (P20.2 §17)
 *     -> invocation lifecycle ASSIGNED -> RUNNING -> DELIVERED (P20.2 §18)
 *     -> UNSEALED artifact candidate (P20.2 §19)
 *
 * It does NOT: enable real owner-facing `artifact_v1` completion, touch
 * `DurablePmRuntime`, set `final_ref`, seal, or select an authoritative
 * attempt (all P20.3). It never calls `decide()` / parseDecision /
 * canonicalizer.
 */

import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../artifacts/artifact-paths.mjs';
import { DELIVERY_MECHANISM } from '../artifacts/artifact-delivery.mjs';
import { INPUT_TRANSPORT } from '../artifacts/artifact-schema.mjs';
import { assertReportRoute } from '../artifacts/backend-report-capability.mjs';
import {
  resolveContextSelectors,
  admitArtifactContext,
  prepareContextForConsumption,
} from '../artifacts/artifact-context.mjs';
import { reconcileFailedInvocation } from '../artifacts/artifact-recovery.mjs';
import { TERMINAL_STATE } from './report-backend-result.mjs';
import { ReportInvoker } from './report-invocation.mjs';
import { completeSingleReportArtifact } from './single-report-completion.mjs';

// P20.8 PRE-R3 R3-1 — the SAME known-terminal-state set the accepted Council
// orchestrator (council-artifact-orchestrator.mjs) uses to decide whether a
// failed invokeReport() carries a KNOWN provider terminal fact, or must be
// reconciled as an UNKNOWN outcome (never auto-replayed).
const KNOWN_TERMINAL_STATES = new Set([
  TERMINAL_STATE.TIMEOUT, TERMINAL_STATE.CANCELLED, TERMINAL_STATE.PROVIDER_ERROR,
  TERMINAL_STATE.PROCESS_ERROR, TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE,
]);

export class SingleReportOperationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'SingleReportOperationError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * @param {object} input
 * @param {import('../artifacts/artifact-store.mjs').ArtifactStore} input.store
 * @param {string} input.taskId
 * @param {string} input.taskSlug
 * @param {string} input.createdAt      ISO-8601
 * @param {string} input.invocationId
 * @param {string} input.executionId
 * @param {string} input.profileId
 * @param {string} input.backend        product family key (e.g. "api", "fake")
 * @param {string} input.actorAlias
 * @param {string} [input.instructions]
 * @param {Array<{label:string,content:string}>} [input.evidence]
 * @param {string} [input.deliveryMechanism]  default VERBATIM_MATERIALIZATION
 * @param {string} [input.inputTransport]
 * @param {object} [input.capabilityPolicy]
 * @param {object} input.reportBackend  { runReport({prompt, request}) }
 * @param {Function} [input.directWriter]  required for DIRECT_WRITE
 * @param {ReportInvoker} [input.reportInvoker]
 * @param {string} [input.startedAt]  ISO-8601 attempt start (defaults now)
 */
export async function runSingleReport(input) {
  const {
    store, taskId, taskSlug, createdAt, invocationId, executionId,
    profileId, backend, actorAlias,
    instructions = '', evidence = [],
    deliveryMechanism = DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION,
    inputTransport = null, capabilityPolicy,
    reportBackend, directWriter,
    reportInvoker = new ReportInvoker(),
    startedAt = new Date().toISOString(),
    // P20.6 — optional explicit prior-artifact context (SINGLE Context
    // Chaining). `contextSelectors` is an ordered array of internal selector
    // forms (ARTIFACT_REF / TASK_FINAL / LATEST_FINAL). When absent this is a
    // plain SINGLE report — no context lane, unchanged behaviour.
    contextSelectors = null,
    contextInputTransport = INPUT_TRANSPORT.VERBATIM_CONTENT,
    contextLimits = {},
    signal = null,
    timeoutMs = null,
    // P24.3C-R1 — optional durable per-invocation task-workspace evidence
    // ({isolation_version, workspace_path, repository_common_dir}, the SAME
    // shape task-execution-context.mjs's `resolveTaskWorkspaceBinding()`
    // returns). `null`/absent for every legacy (non-isolated) task —
    // byte-for-byte unaffected; see report-invocation.mjs's own use of it.
    workspaceEvidence = null,
  } = input ?? {};

  if (!store || typeof store.allocateTask !== 'function') {
    throw new SingleReportOperationError('an ArtifactStore is required', 'SINGLE_REPORT_NO_STORE');
  }
  if (!reportBackend || typeof reportBackend.runReport !== 'function') {
    throw new SingleReportOperationError('reportBackend.runReport(...) is required', 'SINGLE_REPORT_NO_BACKEND');
  }

  // P20.6R R1 — does the target task ALREADY exist? Its PERSISTED
  // `previous_task_refs` — not the current caller's selector argument — are
  // the durable context authority. A bound target NEVER runs context-free
  // just because this call omitted (or passed `[]` for) contextSelectors.
  const existingTask = store.openTaskById(taskId);
  const persistedRefsAtEntry = existingTask && Array.isArray(existingTask.manifest?.previous_task_refs)
    ? existingTask.manifest.previous_task_refs : [];
  const callerSelectors = Array.isArray(contextSelectors) ? contextSelectors : [];
  const willConsumeContext = persistedRefsAtEntry.length > 0 || callerSelectors.length > 0;

  // P20.6R R4 — one EFFECTIVE report input transport for a context-bearing
  // SINGLE invocation, used consistently for route admission, attempt
  // allocation, the trusted request/prompt, artifact.json, and delivery
  // repair re-admission. A no-context caller keeps its previous behaviour.
  if (willConsumeContext && inputTransport !== null && inputTransport !== undefined && inputTransport !== contextInputTransport) {
    throw new SingleReportOperationError(
      `conflicting input transport for a context-bearing SINGLE run: inputTransport=${JSON.stringify(inputTransport)} != contextInputTransport=${JSON.stringify(contextInputTransport)} — fail closed before target allocation`,
      'SINGLE_REPORT_CONTEXT_TRANSPORT_CONFLICT',
    );
  }
  const effectiveInputTransport = willConsumeContext ? contextInputTransport : inputTransport;

  // Fail closed BEFORE any allocation if the route is unsupported/unproven.
  assertReportRoute({ policy: capabilityPolicy, product: backend, requestedDelivery: deliveryMechanism, requestedInputTransport: effectiveInputTransport });

  // P20.6 §10/§12 Boundary A — resolve the caller's selectors ONCE to concrete
  // sealed ArtifactReference(s) and admit the consumer route + aggregate size,
  // BEFORE the target task directory is created and BEFORE any provider work.
  // For a NEW target this establishes the binding; for an ALREADY-BOUND target
  // `allocateTask()` enforces exact-ordered equivalence
  // (ARTIFACT_TASK_CONTEXT_BINDING_MISMATCH) — a moved LATEST_FINAL fails
  // closed here, it is never silently re-resolved into new authority.
  let resolvedContextRefs = null;
  if (callerSelectors.length > 0) {
    resolvedContextRefs = resolveContextSelectors({ store, selectors: callerSelectors, targetTaskId: taskId });
    // P20.8R4: `requestedDelivery` is this SINGLE run's own real
    // `deliveryMechanism` (already resolved above for `assertReportRoute()`)
    // — never a hard-coded literal — so context-input admission checks the
    // SAME exact-tuple capability fact this run's actual report call uses.
    admitArtifactContext({
      store, refs: resolvedContextRefs, consumerBackend: backend,
      capabilityPolicy, requestedInputTransport: effectiveInputTransport, requestedDelivery: deliveryMechanism, limits: contextLimits,
    });
  }

  const task = store.allocateTask({
    taskId, taskSlug, createdAt, mode: 'single',
    ...(resolvedContextRefs ? { previousTaskRefs: resolvedContextRefs } : {}),
  });

  // P20.6R R1 — the PERSISTED target manifest decides whether context is
  // consumed. This is authoritative whether the caller supplied selectors,
  // omitted them, passed `[]`, or is reconstructing after a crash/restart.
  const boundManifest = task.freshManifest();
  const boundContext = Array.isArray(boundManifest.previous_task_refs) && boundManifest.previous_task_refs.length > 0;

  const invocation = task.allocateInvocation({
    invocationId,
    role: ARTIFACT_ROLE.SINGLE,
    stage: ARTIFACT_STAGE.SINGLE,
    profileId,
    actorAlias,
  });
  const attempt = invocation.allocateAttempt({ deliveryMechanism, inputTransport: effectiveInputTransport, startedAt, executionId });

  const request = {
    store,
    task,
    invocation,
    attempt,
    taskId,
    stage: ARTIFACT_STAGE.SINGLE,
    role: ARTIFACT_ROLE.SINGLE,
    round: null,
    profileId,
    backend,
    actorAlias,
    executionId,
    deliveryMechanism,
    inputTransport: effectiveInputTransport,
    capabilityPolicy,
    instructions,
    evidence,
    directWriter,
    sourceWritePolicy: 'READ_ONLY',
    signal,
    timeoutMs,
    workspaceEvidence,
  };

  // P20.6 §12 Boundary B — immediately before the provider call, fresh-read
  // the persisted target manifest, BIND its store/project/task/mode identity
  // (R3), FULL-verify its `previous_task_refs` again, re-admit the consumer
  // route/size, and render the ordered inputs. Post-admission hash drift
  // throws here, before any target provider call; a broken selected ref is
  // NEVER auto-replaced by latest/another artifact. R1: driven by the
  // PERSISTED refs, so a bound target consumes context even when this call
  // omitted selectors / passed `[]` / is a crash-restart re-entry.
  if (boundContext) {
    // P20.8R4: same real `deliveryMechanism`, threaded through to the
    // Boundary B re-admission immediately before the provider call.
    const ctx = prepareContextForConsumption({
      store, task, targetTaskId: taskId, consumerBackend: backend,
      capabilityPolicy, requestedInputTransport: effectiveInputTransport, requestedDelivery: deliveryMechanism, limits: contextLimits,
    });
    if (ctx.transport === INPUT_TRANSPORT.VERBATIM_CONTENT) {
      // Exact, complete, untrusted prior content — persisted order first.
      request.evidence = [...ctx.rendered.evidence, ...evidence];
    } else {
      // NATIVE_ASSIGNED_READ — verified path/sha/bytes descriptors only.
      request.contextRefDescriptors = ctx.prepared.entries.map((e) => ({
        label: e.label, path: e.path, sha256: e.sha256, bytes: e.bytes,
      }));
    }
    request.contextRefs = ctx.refs;
  }

  let out;
  try {
    out = await reportInvoker.invokeReport({ request, reportBackend });
  } catch (error) {
    // P20.8 PRE-R3 R3-1 — a known non-success terminal result, a thrown
    // provider error, or an execution-not-admitted refusal (a concurrent /
    // duplicate / post-terminal claim) all leave the invocation without a
    // truthful DELIVERED outcome. Settle it DURABLY (mirrors the accepted
    // Council orchestrator) so a later restart/re-entry sees a definitive
    // terminal lifecycle and NEVER auto-replays an unknown/in-flight
    // provider outcome. Idempotent — a second refusal on an already-settled
    // invocation is a harmless no-op here.
    const terminalState = KNOWN_TERMINAL_STATES.has(error?.terminalState) ? error.terminalState : 'UNKNOWN_OUTCOME';
    try { reconcileFailedInvocation({ invocation, terminalState, reason: error.code ?? error.message }); } catch { /* already settled/sealed — leave it */ }
    throw error;
  }
  const base = { task, invocation, attempt, ...out };

  // P20.3 §24 — optional: run the integrity gate + seal + Task Final
  // Artifact Gate so the SINGLE artifact_v1 flow can COMPLETE offline.
  // Default OFF: without `complete`, the caller gets the P20.2 DELIVERED
  // result unchanged. Never enabled by any script.
  if (input?.complete === true) {
    const completion = await completeSingleReportArtifact({
      store,
      task,
      invocation,
      attemptOrdinal: attempt.ordinal,
      expected: {
        storeId: store.storeId, projectId: store.projectId, taskId,
        invocationId, role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, round: null,
        profileId, actorAlias, executionId, backend,
      },
      reportBackend,
      directWriter,
      deliveryMechanism,
      inputTransport: effectiveInputTransport, // P20.6R R4: same provenance through delivery repair
      capabilityPolicy, // P20.3R R2: thread the ORIGINAL admitted policy into repair
      maxReportBytes: input?.maxReportBytes,
    });
    return { ...base, completion };
  }
  return base;
}
