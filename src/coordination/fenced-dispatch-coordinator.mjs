import { createResultEnvelope, nowUtc } from '../bus/envelopes.mjs';
import { classifyDispatchAttempt } from '../persistence/recovery/dispatch-recovery-classifier.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../persistence/recovery/dispatch-attempt-protocol.mjs';
import { CoordinationError } from './coordination-errors.mjs';

export class FencedDispatchError extends CoordinationError {
  constructor(message, { code = 'FENCED_DISPATCH_ERROR', cause } = {}) {
    super(message, { code, cause });
    this.name = 'FencedDispatchError';
  }
}

const REPOSITORY_METHODS = [
  'prepareDispatch', 'startDispatchAndRun', 'recordNativeStart',
  'terminalCommitSuccess', 'terminalCommitFailure', 'getTask', 'getRun',
  'getResultByRun', 'getDispatchAttempt',
];

export class FencedDispatchCoordinator {
  constructor({ coordinationStore, agentBusRepository } = {}) {
    if (!coordinationStore || typeof coordinationStore.withClaimAuthority !== 'function' || typeof coordinationStore.completeClaim !== 'function') {
      throw new TypeError('FencedDispatchCoordinator requires a coordination store authority seam');
    }
    const missing = REPOSITORY_METHODS.filter((name) => typeof agentBusRepository?.[name] !== 'function');
    if (missing.length) throw new TypeError(`FencedDispatchCoordinator requires AgentBus repository methods: ${missing.join(', ')}`);
    this.coordination = coordinationStore;
    this.repository = agentBusRepository;
  }

  prepareIntent({ fence, lineage, task, run, backend } = {}) {
    const exact = normalizeLineage(lineage);
    if (task?.id !== exact.task_id || run?.id !== exact.run_id || run?.taskId !== exact.task_id) throw lineageError();
    return this.coordination.withClaimAuthority(fence, (work) => {
      assertWorkLineage(work, exact);
      if (this.repository.getTask(exact.task_id) || this.repository.getRun(exact.run_id) || this.repository.getDispatchAttempt(exact.dispatch_attempt_id)) {
        throw new FencedDispatchError('dispatch intent identities already exist', { code: 'DISPATCH_INTENT_ALREADY_EXISTS' });
      }
      return this.repository.prepareDispatch({ task, run, attemptId: exact.dispatch_attempt_id, backend });
    });
  }

  classifyForExecution({ fence, lineage, capabilities = {} } = {}) {
    const exact = normalizeLineage(lineage);
    return this.coordination.withClaimAuthority(fence, (work) => {
      assertWorkLineage(work, exact);
      const records = this.#exactRecords(exact);
      return classifyDispatchAttempt({ attempt: records.attempt, run: records.run, result: records.result, capabilities });
    });
  }

  markDispatchStarted({ fence, lineage } = {}) {
    const exact = normalizeLineage(lineage);
    return this.coordination.withClaimAuthority(fence, (work) => {
      assertWorkLineage(work, exact);
      const records = this.#exactRecords(exact);
      const diagnostic = classifyDispatchAttempt({ attempt: records.attempt, run: records.run, result: records.result });
      if (diagnostic.classification !== RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH) {
        throw new FencedDispatchError('persisted attempt is not safe to dispatch', { code: 'DISPATCH_NOT_SAFE' });
      }
      return this.repository.startDispatchAndRun({ attemptId: exact.dispatch_attempt_id, runId: exact.run_id, startedAt: nowUtc() });
    });
  }

  validateBeforeProvider({ fence, lineage } = {}) {
    const exact = normalizeLineage(lineage);
    return this.coordination.withClaimAuthority(fence, (work) => {
      assertWorkLineage(work, exact);
      const records = this.#exactRecords(exact);
      if (records.attempt.phase !== ATTEMPT_PHASES.DISPATCH_STARTED || records.run.status !== 'running') {
        throw new FencedDispatchError('provider boundary requires durable DISPATCH_STARTED/running truth', { code: 'PROVIDER_BOUNDARY_NOT_READY' });
      }
      return Object.freeze({ attempt: records.attempt, run: records.run, task: records.task });
    });
  }

  recordRemoteStarted({ fence, lineage, evidence } = {}) {
    const exact = normalizeLineage(lineage);
    return this.coordination.withClaimAuthority(fence, (work) => {
      assertWorkLineage(work, exact);
      this.#exactRecords(exact);
      return this.repository.recordNativeStart({ attemptId: exact.dispatch_attempt_id, ...evidence });
    });
  }

  commitTerminalSuccess({ fence, lineage, result } = {}) {
    const exact = normalizeLineage(lineage);
    if (result?.taskId !== exact.task_id || result?.runId !== exact.run_id) throw lineageError();
    return this.coordination.withClaimAuthority(fence, async (work) => {
      assertWorkLineage(work, exact);
      this.#exactRecords(exact);
      const committed = this.repository.terminalCommitSuccess({ runId: exact.run_id, result });
      await this.coordination.completeClaim(fence);
      return committed;
    });
  }

  commitTerminalFailure({ fence, lineage, status = 'failed', error } = {}) {
    const exact = normalizeLineage(lineage);
    return this.coordination.withClaimAuthority(fence, async (work) => {
      assertWorkLineage(work, exact);
      this.#exactRecords(exact);
      const committed = this.repository.terminalCommitFailure({ runId: exact.run_id, status, error, completedAt: nowUtc() });
      await this.coordination.completeClaim(fence);
      return committed;
    });
  }

  async execute({ fence, lineage, provider } = {}) {
    if (typeof provider !== 'function') throw new TypeError('execute requires a provider function');
    const diagnostic = await this.classifyForExecution({ fence, lineage });
    if (!diagnostic.autoReplayAllowed) return Object.freeze({ status: 'BLOCKED', diagnostic, providerCalled: false });
    await this.markDispatchStarted({ fence, lineage });
    const boundary = await this.validateBeforeProvider({ fence, lineage });
    let providerResult;
    try {
      // No PostgreSQL or SQLite transaction is open here.
      providerResult = await provider(Object.freeze({ task: boundary.task, run: boundary.run, attempt: boundary.attempt }));
    } catch (cause) {
      try {
        const committed = await this.commitTerminalFailure({ fence, lineage, status: 'failed', error: cause });
        return Object.freeze({ status: 'TERMINAL_COMMITTED', committed, providerCalled: true });
      } catch (commitError) {
        if (isStaleAuthority(commitError)) return this.#postCallRejected(lineage);
        throw commitError;
      }
    }
    const result = createResultEnvelope(providerResult);
    try {
      const committed = await this.commitTerminalSuccess({ fence, lineage, result });
      return Object.freeze({ status: 'TERMINAL_COMMITTED', committed, providerCalled: true });
    } catch (error) {
      if (isStaleAuthority(error)) return this.#postCallRejected(lineage);
      throw error;
    }
  }

  #exactRecords(exact) {
    const task = this.repository.getTask(exact.task_id);
    const run = this.repository.getRun(exact.run_id);
    const attempt = this.repository.getDispatchAttempt(exact.dispatch_attempt_id);
    if (!task || !run || !attempt || task.id !== exact.task_id || run.id !== exact.run_id || run.taskId !== exact.task_id || attempt.id !== exact.dispatch_attempt_id || attempt.taskId !== exact.task_id || attempt.runId !== exact.run_id) throw lineageError();
    return { task, run, attempt, result: this.repository.getResultByRun(exact.run_id) ?? null };
  }

  #postCallRejected(lineage) {
    const exact = normalizeLineage(lineage);
    const records = this.#exactRecords(exact);
    const diagnostic = classifyDispatchAttempt({ attempt: records.attempt, run: records.run, result: records.result });
    if (diagnostic.classification === RECOVERY_CLASSIFICATIONS.CLEAN) {
      return Object.freeze({ status: 'TERMINAL_P2_COMMITTED_COORDINATION_UNCONFIRMED', diagnostic, providerCalled: true, canonicalCommitted: true });
    }
    return Object.freeze({ status: 'STALE_RESULT_REJECTED', diagnostic, providerCalled: true, canonicalCommitted: false });
  }
}

function normalizeLineage(value) {
  const keys = ['task_id', 'run_id', 'dispatch_attempt_id'];
  const proto = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  const ownKeys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  const exact = (proto === Object.prototype || proto === null)
    && ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string' && descriptor.value !== '';
    });
  if (!exact) throw lineageError();
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function assertWorkLineage(work, exact) {
  if (work?.work_kind !== 'TASK_DISPATCH' || work.task_id !== exact.task_id || work.run_id !== exact.run_id || work.dispatch_attempt_id !== exact.dispatch_attempt_id) throw lineageError();
}

function lineageError() { return new FencedDispatchError('coordination and Phase-2 dispatch lineage do not match', { code: 'FENCED_DISPATCH_LINEAGE_MISMATCH' }); }
function isStaleAuthority(error) { return error instanceof CoordinationError && error.code === 'CLAIM_AUTHORITY_REJECTED'; }
