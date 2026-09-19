import { createHash, randomUUID } from 'node:crypto';
import { RECONCILIATION_MODE } from './reconciliation-mode.mjs';

export const RECONCILIATION_CLASS = Object.freeze({
  TERMINAL_PARENT_STALE_DESCENDANTS: 'TERMINAL_PARENT_STALE_DESCENDANTS',
  TERMINAL_TASK_STALE_CANCELLATION_REQUEST: 'TERMINAL_TASK_STALE_CANCELLATION_REQUEST',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  OWNER_ACTION_REQUIRED: 'OWNER_ACTION_REQUIRED',
  // P20.8 PRE-R3 R3-4.2 — a bounded, explicit-operator-only reconciliation of
  // an EXISTING orphan AgentBus run unreachable through the PM-action path
  // above (its owning workflow_steps.run_id linkage is null — see
  // src/reconciliation/agentbus-orphan-reconciliation.mjs). Never in `AUTO`:
  // never auto-repaired, never part of a startup-wide sweep.
  ORPHAN_UNKNOWN_EXTERNAL_OUTCOME: 'ORPHAN_UNKNOWN_EXTERNAL_OUTCOME',
});

export const RECONCILIATION_REASON = Object.freeze({
  TERMINAL_PARENT: 'RECONCILED_TERMINAL_PARENT',
  STALE_CANCELLATION: 'RECONCILED_TERMINAL_TASK_CANCELLATION',
});

const AUTO = new Set([
  RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS,
  RECONCILIATION_CLASS.TERMINAL_TASK_STALE_CANCELLATION_REQUEST,
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function reconciliationKey(subject) {
  const revisions = Object.fromEntries(Object.entries(subject.revisions ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(stable({ classification: subject.classification, taskId: subject.taskId, lineage: subject.lineage, revisions })).digest('hex');
}

export function classifyReconciliationSubject(subject, resources) {
  if (subject.validAwaitingOwner || (resources.openOwnerInteraction?.requiresResponse && resources.openOwnerInteraction?.lineageExact)) {
    return { classification: RECONCILIATION_CLASS.OWNER_ACTION_REQUIRED, autoRepair: false, reason: 'VALID_AWAITING_OWNER' };
  }
  if (subject.ambiguous || resources.ambiguousProviderCompletion || resources.uncertainExternalSideEffect || resources.uncertainGitState || resources.authorityDisagreement) {
    return { classification: RECONCILIATION_CLASS.RECOVERY_REQUIRED, autoRepair: false, reason: subject.ambiguityReason ?? 'AMBIGUOUS_DURABLE_EVIDENCE' };
  }
  const blockers = [];
  if (resources.liveProviderProcess) blockers.push('LIVE_PROVIDER_PROCESS');
  if (resources.activeClaim) blockers.push('ACTIVE_CLAIM');
  if (resources.unexpiredLease) blockers.push('UNEXPIRED_LEASE');
  if (resources.workspaceOccupancy) blockers.push('WORKSPACE_OCCUPIED');
  if (resources.activeProviderSlot) blockers.push('ACTIVE_PROVIDER_SLOT');
  if (resources.uncertainWorkerOwnership) blockers.push('UNCERTAIN_WORKER_OWNERSHIP');
  if (blockers.length) return { classification: RECONCILIATION_CLASS.RECOVERY_REQUIRED, autoRepair: false, reason: blockers.join(',') };
  if (!AUTO.has(subject.classification)) return { classification: RECONCILIATION_CLASS.RECOVERY_REQUIRED, autoRepair: false, reason: 'UNSUPPORTED_OR_SEMANTIC_REPAIR' };
  return { classification: subject.classification, autoRepair: true, reason: subject.classification === RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS ? RECONCILIATION_REASON.TERMINAL_PARENT : RECONCILIATION_REASON.STALE_CANCELLATION };
}

/**
 * Leader-owned, no-replay bookkeeping reconciler. The source owns revision-stable
 * observations and CAS mutations; the resource guard owns cross-store evidence.
 *
 * Mode gate (DSH_RECONCILIATION_MODE): 'enabled' is the pre-gate behavior
 * (leader-fenced auto-repair). 'dry-run' scans/classifies the same durable
 * state under the same leadership and resource guards but performs ZERO
 * mutations — no repair, no durable audit projection, no settlement; it only
 * reports structured would-repair candidates (log-only observability via
 * `onCandidate`). 'disabled' is never constructed here — the composition
 * passes a null reconciler instead — so constructing one in that mode is a
 * wiring bug and fails closed.
 */
export class StuckTaskReconciler {
  constructor({ source, resourceGuard, leadershipGuard, mode = RECONCILIATION_MODE.ENABLED, onCandidate = null, workerIncarnationId = null, clock = () => new Date().toISOString() } = {}) {
    if (!source || !resourceGuard || !leadershipGuard) throw new TypeError('source, resourceGuard, and leadershipGuard are required');
    if (mode !== RECONCILIATION_MODE.ENABLED && mode !== RECONCILIATION_MODE.DRY_RUN) throw new TypeError(`reconciliation mode must be 'dry-run' or 'enabled' (fail-closed, got ${JSON.stringify(mode)})`);
    this.source = source; this.resources = resourceGuard; this.leadership = leadershipGuard; this.mode = mode; this.onCandidate = onCandidate; this.workerIncarnationId = workerIncarnationId; this.clock = clock;
  }

  async scan({ fence, limit = 50 } = {}) {
    await this.leadership.assertCurrent(fence);
    const candidates = await this.source.scanCandidates({ limit });
    const outcomes = [];
    for (const candidate of candidates) outcomes.push(await this.#reconcileOne(candidate, fence));
    return Object.freeze({ scanned: candidates.length, outcomes: Object.freeze(outcomes) });
  }

  async #reconcileOne(candidate, fence) {
    const observedAt = this.clock();
    const before = await this.source.observe(candidate);
    const resources = await this.resources.observe(before);
    const decision = classifyReconciliationSubject(before, resources);
    const key = reconciliationKey({ ...before, classification: decision.classification });
    if (this.mode === RECONCILIATION_MODE.DRY_RUN) return this.#dryRunCandidate({ candidate, before, resources, decision }, fence);
    if (!decision.autoRepair) {
      const safeActions = decision.classification === RECONCILIATION_CLASS.OWNER_ACTION_REQUIRED ? (before.safeOwnerActions ?? []) : (before.safeRecoveryActions ?? []);
      if (decision.classification === RECONCILIATION_CLASS.RECOVERY_REQUIRED && typeof this.source.recordProjection === 'function') {
        await this.leadership.assertCurrent(fence);
        await this.source.recordProjection({ idempotencyKey: key, taskId: before.taskId, lineage: before.lineage, classification: decision.classification, states: before.states, revisions: before.revisions, evidenceTimestamps: { observedAt }, leaderGeneration: fence.leader_generation, workerIncarnation: typeof this.workerIncarnationId === 'function' ? this.workerIncarnationId() : this.workerIncarnationId, reason: decision.reason, resourceImpact: resources.resourceImpact ?? 'NONE', safeAllowedActions: safeActions });
      }
      return Object.freeze({ taskId: before.taskId, classification: decision.classification, result: 'NO_MUTATION', reason: decision.reason, resourceImpact: resources.resourceImpact ?? 'NONE', safeActions });
    }

    // Both authorities are checked again immediately before the source's CAS.
    await this.leadership.assertCurrent(fence);
    const stable = await this.source.observe(candidate);
    if (stable.observationToken !== before.observationToken) return Object.freeze({ taskId: before.taskId, classification: decision.classification, result: 'STALE_OBSERVATION' });
    const currentResources = await this.resources.observe(stable);
    const currentDecision = classifyReconciliationSubject(stable, currentResources);
    if (!currentDecision.autoRepair) return Object.freeze({ taskId: before.taskId, classification: currentDecision.classification, result: 'EVIDENCE_CHANGED', reason: currentDecision.reason });
    await this.leadership.assertCurrent(fence);
    const audit = {
      reconciliationId: randomUUID(), idempotencyKey: key, taskId: before.taskId, lineage: before.lineage,
      classification: decision.classification, beforeStates: before.states, beforeRevisions: before.revisions,
      evidenceTimestamps: { observedAt, verifiedAt: this.clock() }, leaderGeneration: fence.leader_generation,
      workerIncarnation: typeof this.workerIncarnationId === 'function' ? this.workerIncarnationId() : this.workerIncarnationId, repairReason: decision.reason,
    };
    const repaired = await this.source.repair({ candidate, expectedObservationToken: before.observationToken, audit, fence });
    return Object.freeze({ taskId: before.taskId, classification: decision.classification, result: repaired.applied ? 'REPAIRED' : repaired.idempotent ? 'IDEMPOTENT_NOOP' : 'CAS_REJECTED', reconciliationId: repaired.reconciliationId ?? audit.reconciliationId });
  }

  /**
   * Dry-run candidate report: reads the same revision-stable evidence and
   * re-runs the same leadership/resource/classification checks the repair
   * path would run, then reports what WOULD happen — and mutates nothing
   * (no source.repair, no recordProjection, no settlement, no audit row).
   */
  async #dryRunCandidate({ candidate, before, resources, decision }, fence) {
    await this.leadership.assertCurrent(fence);
    const stable = await this.source.observe(candidate);
    const stableToken = stable.observationToken === before.observationToken;
    const current = stableToken ? decision : classifyReconciliationSubject(stable, await this.resources.observe(stable));
    const wouldRepair = stableToken && current.autoRepair;
    const reason = stableToken ? current.reason : 'OBSERVATION_TOKEN_CHANGED';
    const safeActions = current.classification === RECONCILIATION_CLASS.OWNER_ACTION_REQUIRED ? (stable.safeOwnerActions ?? []) : (stable.safeRecoveryActions ?? []);
    const outcome = Object.freeze({
      taskId: before.taskId,
      classification: current.classification,
      result: !stableToken ? 'STALE_OBSERVATION' : wouldRepair ? 'WOULD_REPAIR' : 'NO_MUTATION',
      reason,
      resourceImpact: resources.resourceImpact ?? 'NONE',
      proposedRepair: wouldRepair ? current.reason : null,
      wouldMutate: wouldRepair ? 'YES' : 'NO',
      safeActions,
    });
    if (typeof this.onCandidate === 'function') this.onCandidate(outcome);
    return outcome;
  }
}

export function projectReconciliation(record, now = Date.now()) {
  const observed = Date.parse(record.evidenceTimestamps?.verifiedAt ?? record.createdAt ?? '');
  const auto = AUTO.has(record.classification) && record.repairResult === 'APPLIED';
  return Object.freeze({
    taskId: record.taskId, classification: record.classification,
    indicator: auto ? 'RECONCILED' : 'RECOVERY REQUIRED', affectedLayer: record.affectedLayer ?? 'DURABLE_BOOKKEEPING',
    reason: record.repairReason, ageMs: Number.isFinite(observed) ? Math.max(0, now - observed) : null,
    resourceImpact: record.resourceImpact ?? 'NONE', safeAllowedActions: auto ? [] : (record.safeAllowedActions ?? []),
    showApprovalCard: false,
  });
}
