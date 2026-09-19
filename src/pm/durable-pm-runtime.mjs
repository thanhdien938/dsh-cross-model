import { createId, nowUtc } from '../bus/envelopes.mjs';
import { toSanitizedError } from '../bus/errors.mjs';
import { PM_TURN_PHASES, isTerminalPmActionStatus } from '../persistence/repositories/pm-repository.mjs';
import { PM_CAPABILITIES, PM_DECISION_TYPES, assertPmDriver, createPmRequest, normalizePmDecision } from './pm-contracts.mjs';
import { sanitizePmDurable } from './pm-durable-sanitize.mjs';
import { deterministicOwnerId } from '../owner/owner-contracts.mjs';

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_HISTORY_LIMIT = 12;

// P13-R7.1 (docs/p13/15A_*.md): the AbortSignal `reason` value
// ProductionPmWorker's `#wakeCancelledActiveSlots()` (production-pm-
// worker.mjs) stamps onto a slot's controller when -- and only when --
// it fired the abort because a canonical, durable owner cancellation was
// read as REQUESTED for that exact work item. This is the one piece of
// evidence `#continue()`'s catch block below uses to distinguish "the
// owner cancelled this task" (terminal: cancelled) from every other abort
// cause, including a plain process-shutdown drain abort (terminal:
// failed, unchanged) -- see that call site's own docstring for the full
// precedence rule. A plain string, not a class, so it round-trips through
// `AbortSignal.reason` (a structured-clone-safe value) without needing an
// import cycle in either direction between this module and
// production-pm-worker.mjs.
export const PM_OWNER_CANCEL_ABORT_REASON = 'PM_OWNER_CANCEL_REQUESTED';

export const PM_RECOVERY = Object.freeze({
  SAFE_TO_DECIDE: 'SAFE_TO_DECIDE',
  DECISION_READY: 'DECISION_READY',
  ACTION_RECONCILE_REQUIRED: 'ACTION_RECONCILE_REQUIRED',
  ACTION_OUTCOME_RECOVERABLE: 'ACTION_OUTCOME_RECOVERABLE',
  TURN_COMPLETE: 'TURN_COMPLETE',
  OPERATOR_ACTION_REQUIRED: 'OPERATOR_ACTION_REQUIRED',
  AWAITING_OWNER: 'AWAITING_OWNER',
});

function positiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function resultSnapshot(result) {
  if (!result || typeof result !== 'object') return null;
  return { id: result.id ?? null, taskId: result.taskId ?? null, runId: result.runId ?? null, agent: result.agent ?? null, status: result.status ?? null, output: typeof result.output === 'string' ? result.output : '', handoff: result.handoff ?? null, artifacts: Array.isArray(result.artifacts) ? result.artifacts : [] };
}

export function normalizeDurableWorkflowOutcome(outcome) {
  return { kind: PM_DECISION_TYPES.WORKFLOW, status: outcome?.status ?? 'failed', workflowId: outcome?.workflowId ?? null, finalStepId: outcome?.finalStepId ?? null, finalTaskId: outcome?.finalTaskId ?? null, finalRunId: outcome?.finalRunId ?? null, finalResult: resultSnapshot(outcome?.finalResult), error: outcome?.error ?? null };
}

export function normalizeDurablePeerOutcome(outcome) {
  return { kind: PM_DECISION_TYPES.PEER_EXCHANGE, status: outcome?.status ?? 'failed', conversationId: outcome?.conversationId ?? null, hopCount: Array.isArray(outcome?.hops) ? outcome.hops.length : 0, finalResult: resultSnapshot(outcome?.finalResult) };
}

export function classifyPmTurnRecovery(turn, actionState = null) {
  if (!turn) return PM_RECOVERY.SAFE_TO_DECIDE;
  if (turn.phase === PM_TURN_PHASES.TURN_COMPLETE) return PM_RECOVERY.TURN_COMPLETE;
  if (turn.decision?.type === PM_DECISION_TYPES.AWAIT_OWNER) return PM_RECOVERY.AWAITING_OWNER;
  if (turn.phase === PM_TURN_PHASES.DECISION_COMMITTED) return PM_RECOVERY.DECISION_READY;
  if (turn.phase !== PM_TURN_PHASES.ACTION_STARTED) return PM_RECOVERY.OPERATOR_ACTION_REQUIRED;
  if (actionState && isTerminalPmActionStatus(actionState.status)) return PM_RECOVERY.ACTION_OUTCOME_RECOVERABLE;
  return PM_RECOVERY.ACTION_RECONCILE_REQUIRED;
}

export class DurablePmRecoveryError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'DurablePmRecoveryError'; Object.assign(this, extra); }
}

export class DurablePmRuntime {
  #driver; #workflowRunner; #peerRelay; #repository; #maxTurns; #historyLimit; #clock; #ownerControl; #profileRegistry; #profileId; #taskLog;

  // P10-R0.1 Part H/K: `taskLog`, when supplied, is a
  // src/runtime/task-diagnostic-log.mjs-shaped `{event(type,fields)}` sink
  // bound to ONE task by the caller (createRuntime() in
  // p5-production-composition.mjs) — this runtime never knows or needs to
  // know the task id itself, it just reports lifecycle facts it already has
  // (pm_run_id, terminal status/error) to whatever sink it was given. A
  // missing/no-op taskLog changes no PM run behavior (same B4 philosophy as
  // backend-execution-observer.mjs).
  constructor({ driver, workflowRunner, peerRelay, repository, ownerControl = null, profileRegistry = null, pmProfileId = null, maxTurns, historyLimit, clock = nowUtc, taskLog = null } = {}) {
    this.#driver = assertPmDriver(driver);
    if (!workflowRunner || typeof workflowRunner.run !== 'function' || typeof workflowRunner.result !== 'function') throw new TypeError('DurablePmRuntime requires workflowRunner run()/result()');
    if (!peerRelay || typeof peerRelay.exchange !== 'function' || typeof peerRelay.createConversation !== 'function' || typeof peerRelay.getConversation !== 'function' || typeof peerRelay.result !== 'function') throw new TypeError('DurablePmRuntime requires peerRelay durable inspection methods');
    if (!repository || typeof repository.create !== 'function' || typeof repository.load !== 'function') throw new TypeError('DurablePmRuntime requires PmRepository contract');
    this.#workflowRunner = workflowRunner; this.#peerRelay = peerRelay; this.#repository = repository;
    if (ownerControl !== null && typeof ownerControl.openInteraction !== 'function') throw new TypeError('ownerControl must implement openInteraction()');
    this.#ownerControl = ownerControl;
    if((profileRegistry===null)!==(pmProfileId===null))throw new TypeError('profileRegistry and pmProfileId must be provided together');this.#profileRegistry=profileRegistry;this.#profileId=pmProfileId;
    this.#maxTurns = positiveInteger(maxTurns, DEFAULT_MAX_TURNS, 'pm.maxTurns');
    this.#historyLimit = positiveInteger(historyLimit, DEFAULT_HISTORY_LIMIT, 'pm.historyLimit');
    this.#clock = clock;
    this.#taskLog = taskLog && typeof taskLog.event === 'function' ? taskLog : null;
  }

  get driverName() { return this.#driver.name; }
  get capabilities() { return [...PM_CAPABILITIES]; }
  open(pmRunId) { return this.#repository.load(pmRunId); }

  #history(run) {
    return run.turns.filter((turn) => turn.phase === PM_TURN_PHASES.TURN_COMPLETE).map((turn) => {
      const decision = turn.decision.type === PM_DECISION_TYPES.PEER_EXCHANGE ? { type: turn.decision.type, conversationId: turn.actionId } : { type: turn.decision.type };
      return { turn: turn.turnIndex, decision, outcome: turn.outcome };
    }).slice(-this.#historyLimit);
  }

  #result(run) {
    return { pmRunId: run.id, requestId: run.request.id, driver: run.driver, status: run.status, output: run.output, data: run.data, turns: run.turnCount, startedAt: run.startedAt, completedAt: run.completedAt, error: run.error, history: this.#history(run) };
  }

  async run({ objective, context, signal, pmRunId = null } = {}) {
    const prepared = this.prepare({ objective, context, pmRunId });
    return this.#continue(prepared.pmRunId, signal);
  }

  prepare({ objective, context, pmRunId = null } = {}) {
    if(pmRunId!==null&&(typeof pmRunId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pmRunId)))throw new TypeError('pmRunId is invalid');
    const rawRequest = createPmRequest({ id:pmRunId===null?undefined:deterministicOwnerId('pmreq',pmRunId), objective, context });
    const request = sanitizePmDurable(rawRequest);
    const id = pmRunId ?? createId('pmrun');
    let profile=null;if(this.#profileRegistry){try{profile=this.#profileRegistry.get(this.#profileId);}catch(cause){throw new DurablePmRecoveryError('PM profile unavailable',{code:'PM_PROFILE_UNAVAILABLE',cause});}}
    const runRecord={ id, driver:this.#driver.name, startedAt:String(this.#clock()), pmProfileId:profile?.id??null, pmProfileFingerprint:profile?.fingerprint??null };
    if(pmRunId===null)this.#repository.create(request,runRecord);else this.#repository.createOrAdopt(request,runRecord);
    this.#taskLog?.event('PM_RUN_CREATED', { pm_run_id: id, driver: this.#driver.name, chair_profile_id: profile?.id ?? null });
    return this.#result(this.#repository.load(id));
  }

  async executePrepared(pmRunId, { signal } = {}) {
    const run=this.#repository.load(pmRunId);if(run.turnCount!==0)throw new DurablePmRecoveryError('prepared PM run already advanced',{code:'PM_RUN_ALREADY_ADVANCED',pmRunId});
    return this.resume(pmRunId,{signal});
  }

  async resume(pmRunId, { signal } = {}) {
    const run = this.#repository.load(pmRunId);
    if (run.driver !== this.#driver.name) {
      throw new DurablePmRecoveryError(`PM driver mismatch for ${pmRunId}`, {
        code: 'PM_DRIVER_MISMATCH',
        pmRunId,
        persistedDriver: run.driver,
        configuredDriver: this.#driver.name,
      });
    }
    if(run.pmProfileId!==null||run.pmProfileFingerprint!==null){if(!this.#profileRegistry)throw new DurablePmRecoveryError('PM profile unavailable',{code:'PM_PROFILE_UNAVAILABLE'});let profile;try{profile=this.#profileRegistry.get(run.pmProfileId);}catch(cause){throw new DurablePmRecoveryError('PM profile unavailable',{code:'PM_PROFILE_UNAVAILABLE',cause});}if(profile.fingerprint!==run.pmProfileFingerprint)throw new DurablePmRecoveryError('PM profile fingerprint mismatch',{code:'PM_PROFILE_MISMATCH'});}
    return this.#continue(pmRunId, signal);
  }

  async #continue(pmRunId, signal) {
    while (true) {
      let run = this.#repository.load(pmRunId);
      if (run.status !== 'running') return this.#result(run);
      const pending = run.turns.at(-1)?.phase === PM_TURN_PHASES.TURN_COMPLETE ? null : run.turns.at(-1) ?? null;
      if (pending) {
        const recovery = await this.#processCommitted(run, pending, signal);
        if (recovery) return recovery;
        continue;
      }
      if (signal?.aborted) {
        this.#repository.completeRun(pmRunId, { status: 'cancelled', completedAt: String(this.#clock()), error: null, data: null, output: '' });
        this.#taskLog?.event('TASK_CANCELLED', { pm_run_id: pmRunId });
        return this.#result(this.#repository.load(pmRunId));
      }
      if (run.turnCount >= this.#maxTurns) {
        const error = { name: 'PmMaxTurnsExceeded', message: `PM driver "${this.#driver.name}" did not finish within ${this.#maxTurns} turns` };
        this.#repository.completeRun(pmRunId, { status: 'failed', completedAt: String(this.#clock()), output: '', data: null, error });
        this.#taskLog?.event('TASK_FAILED', { pm_run_id: pmRunId, error_code: error.name, error_reason: error.message });
        return this.#result(this.#repository.load(pmRunId));
      }
      let decision;
      try {
        const raw = await this.#driver.decide({ request: run.request, turn: run.turnCount, history: this.#history(run), capabilities: this.capabilities, signal });
        decision = sanitizePmDurable(normalizePmDecision(raw));
      } catch (error) {
        // P13-R7.1 (docs/p13/15A_*.md), Part F: a real R7 live defect --
        // an owner Cancel on an ACTIVE task persisted `failed` /
        // `PM_BACKEND_ABORTED` instead of canonical `cancelled`. The
        // pre-execution `signal?.aborted` gate above (line ~141) only ever
        // covers the window BETWEEN turns; the common, real case is the
        // owner cancelling WHILE `#driver.decide()` is in flight, which
        // rejects here via raceWithWatchdog()'s onAbort() (production-pm-
        // backend-registry.mjs) -- and this catch block, before this fix,
        // treated every caught exception identically as `failed`,
        // regardless of cause.
        //
        // Fix: `signal.reason === PM_OWNER_CANCEL_ABORT_REASON` is set ONLY
        // by ProductionPmWorker's `#wakeCancelledActiveSlots()`
        // (production-pm-worker.mjs), which itself only fires after
        // reading a REQUESTED cancellation for this exact work item off
        // the canonical durable coordination store -- i.e. cancellation
        // intent is proven by canonical current cancellation state, never
        // merely inferred from "some abort happened" (Part F's explicit
        // requirement). `drainActive()`'s OWN shutdown-triggered abort
        // (production-pm-worker.mjs) passes no reason at all, so a plain
        // process-shutdown abort -- or any other backend failure entirely
        // unrelated to cancellation -- is completely unaffected and still
        // terminalizes exactly as before: `failed` / `PM_BACKEND_ABORTED`.
        const sanitized = toSanitizedError(error);
        if (signal?.aborted && signal?.reason === PM_OWNER_CANCEL_ABORT_REASON) {
          this.#repository.completeRun(pmRunId, { status: 'cancelled', completedAt: String(this.#clock()), error: null, data: null, output: '' });
          this.#taskLog?.event('TASK_CANCELLED', { pm_run_id: pmRunId });
          return this.#result(this.#repository.load(pmRunId));
        }
        this.#repository.completeRun(pmRunId, { status: 'failed', completedAt: String(this.#clock()), output: '', data: null, error: sanitized });
        this.#taskLog?.event('TASK_FAILED', { pm_run_id: pmRunId, error_code: sanitized?.code ?? sanitized?.name ?? null, error_reason: sanitized?.message ?? null });
        return this.#result(this.#repository.load(pmRunId));
      }
      let actionType = null; let actionId = null;
      if (decision.type === PM_DECISION_TYPES.WORKFLOW) {
        // P13-R1 D3 (§9 of the architecture plan): the canonical durable
        // workflow identity is ALWAYS derived by DSH from (pm_run_id,
        // turn_index) -- never accepted from the model's own `spec.id`.
        // `workflows` is a single GLOBAL table with no per-run namespacing
        // (WorkflowRepository.createWorkflow() writes a fresh row with no
        // upsert/merge fallback), so trusting a model-supplied literal
        // would let two unrelated concurrent tasks collide on the same
        // durable row the moment P13 makes concurrent execution possible.
        // Deterministic in
        // (pm_run_id, turn_index) so this derivation is stable and
        // idempotent -- not that it is ever re-run on resume: once
        // committed, `turn.actionId` is the durable value every recovery
        // path reads back (see #processCommitted below), so an in-flight
        // pre-P13-R1 run resumes unaffected. The model's own requested id,
        // if any, is preserved under `spec.label` for diagnostics only --
        // it is never trusted as identity.
        actionType = decision.type;
        actionId = deterministicOwnerId('wf', pmRunId, String(run.turnCount));
        const requestedLabel = typeof decision.spec?.id === 'string' && decision.spec.id ? decision.spec.id : null;
        decision = { ...decision, spec: { ...decision.spec, id: actionId, ...(requestedLabel ? { label: requestedLabel } : {}) } };
      } else if (decision.type === PM_DECISION_TYPES.PEER_EXCHANGE) {
        actionType = decision.type; actionId = decision.conversationId ?? createId('conversation'); decision = { ...decision, conversationId: actionId };
      } else if (decision.type === PM_DECISION_TYPES.AWAIT_OWNER) {
        actionType = decision.type; actionId = deterministicOwnerId('interaction', pmRunId, String(run.turnCount)); decision = { ...decision, interactionId: actionId };
      }
      this.#repository.commitDecision(pmRunId, { id: createId('pmturn'), turnIndex: run.turnCount, decision, actionType, actionId, createdAt: String(this.#clock()) });
    }
  }

  async #processCommitted(run, turn, signal) {
    if (turn.decision.type === PM_DECISION_TYPES.FINISH) {
      const outcome = { status: 'completed', output: turn.decision.output, data: turn.decision.data };
      this.#repository.completeTurn(run.id, turn.turnIndex, outcome, { status: 'completed', output: turn.decision.output, data: turn.decision.data, error: null, completedAt: String(this.#clock()) });
      this.#taskLog?.event('TASK_COMPLETED', { pm_run_id: run.id });
      return null;
    }
    if (turn.decision.type === PM_DECISION_TYPES.AWAIT_OWNER) {
      if (!this.#ownerControl) throw new DurablePmRecoveryError('owner interaction integration is unavailable', { code: PM_RECOVERY.AWAITING_OWNER, pmRunId: run.id, turnIndex: turn.turnIndex, actionId: turn.actionId });
      const ownerState=await this.#ownerControl.openInteraction({ pmRunId:run.id, turnIndex:turn.turnIndex, interactionId:turn.actionId, decision:turn.decision, request:run.request });
      if (this.#repository.load(run.id).turns[turn.turnIndex]?.phase === PM_TURN_PHASES.DECISION_COMMITTED) this.#repository.markActionStarted(run.id, turn.turnIndex);
      if(ownerState?.decision){this.#repository.completeTurn(run.id,turn.turnIndex,{kind:'await_owner',status:'completed',decision:ownerState.decision});return null;}
      // P12-R5D Part C/D/E/F: an owner-requested cancellation of a task
      // parked AWAIT_OWNER never resolves through a decision — the caller
      // (production-pm-worker.mjs's openInteraction()) signals it via
      // `cancelled: true` once the open interaction has already been
      // durably CLOSED (never re-opened afterward — Part D). Reuses the
      // exact same completeTurn() primitive every other terminal outcome
      // in this file already uses; the preferred terminal result is
      // CANCELLED, never FAILED (Part E) — this is not a backend/action
      // failure, it is the owner's own explicit request.
      if(ownerState?.cancelled){this.#repository.completeTurn(run.id,turn.turnIndex,{kind:'await_owner',status:'cancelled'},{status:'cancelled',output:'',data:null,error:null,completedAt:String(this.#clock())});this.#taskLog?.event('TASK_CANCELLED',{pm_run_id:run.id});return null;}
      return { ...this.#result(this.#repository.load(run.id)), status:'awaiting_owner', recovery:PM_RECOVERY.AWAITING_OWNER, interactionId:turn.actionId };
    }

    const inspect = () => turn.actionType === PM_DECISION_TYPES.WORKFLOW ? this.#workflowRunner.result(turn.actionId) : this.#peerRelay.result(turn.actionId);
    let actionState = inspect();
    const classification = classifyPmTurnRecovery(turn, actionState);
    if (classification === PM_RECOVERY.ACTION_RECONCILE_REQUIRED) {
      throw new DurablePmRecoveryError(`PM action requires reconciliation: ${turn.actionId}`, { code: PM_RECOVERY.ACTION_RECONCILE_REQUIRED, pmRunId: run.id, turnIndex: turn.turnIndex, actionType: turn.actionType, actionId: turn.actionId });
    }

    let outcome;
    if (classification === PM_RECOVERY.ACTION_OUTCOME_RECOVERABLE) {
      outcome = turn.actionType === PM_DECISION_TYPES.WORKFLOW ? normalizeDurableWorkflowOutcome(actionState) : normalizeDurablePeerOutcome(actionState);
    } else {
      if (turn.actionType === PM_DECISION_TYPES.WORKFLOW) {
        this.#repository.markActionStarted(run.id, turn.turnIndex);
      } else {
        if (!actionState) this.#peerRelay.createConversation({ id: turn.actionId });
        this.#repository.markActionStarted(run.id, turn.turnIndex);
      }
      try {
        if (turn.actionType === PM_DECISION_TYPES.WORKFLOW) {
          // P13-R1.1 (docs/p13/05_*.md): `signal` was already threaded down
          // to every DIRECT driver.decide() call in #continue() above, but
          // never onto a WORKFLOW decision's spec -- so a Council step
          // (whose real backend call happens entirely inside
          // CouncilStepWorkflowRunner.run(), not here) never actually saw
          // a shutdown/cancel abort. CouncilStepWorkflowRunner already
          // reads `spec.signal` for its own decide() calls
          // (council-step-workflow-runner.mjs) -- this wires the existing
          // consumer to the existing signal, rather than inventing
          // anything new. A shallow clone (never a mutation of the durably
          // committed `turn.decision`) so the AbortSignal is never at risk
          // of being serialized/persisted anywhere.
          //
          // DSH-TIMEOUT-1 Part B (audit Finding T-1): a LONG-classified
          // owner task's actual worker/implementation step must resolve the
          // SAME LONG timeout class its own top-level PM planning turn
          // already does (p5-production-composition.mjs's createRuntime())
          // instead of being silently truncated to the fixed OWNER_SINGLE
          // (300s) stage. `runtimeClass` is stamped once, at SUBMIT_TASK
          // time, onto the OWNER's own request context (owner-task-
          // controller.mjs) — never onto the model-authored workflow spec —
          // so it is read from `run.request.context` here (never inferred
          // from task text) and merged into each step's EXISTING `context`
          // field, the one channel production-pm-workflow-runner.mjs's
          // worker-step adapter can actually read it from (task envelopes
          // and workflow step records both already carry `context` as a
          // durable, arbitrary-JSON field — no new schema, no durability
          // change). Explicit keys already on a step's own context always
          // win (spread last only when absent) so a future model-authored
          // `context.runtimeClass` — never expected in practice — is not
          // silently clobbered. Deliberately a total no-op (spec passed
          // through byte-for-byte unchanged, same shallow-clone-only
          // discipline as the `signal` field above) unless the run's own
          // runtimeClass is literally `'LONG'` — a NORMAL SINGLE task's
          // rendered worker prompt (production-pm-backend-registry.mjs's
          // renderRequest(), which inlines `context` verbatim) is therefore
          // completely untouched by this change. Council/Debate runs never
          // set `runtimeClass` on their request context at all (P10-R0.2.4
          // Part V: LONG COUNCIL execution policy stays explicitly
          // deferred), so this branch structurally never executes for them.
          const runtimeClass = run.request?.context?.runtimeClass ?? null;
          const spec = runtimeClass === 'LONG' && Array.isArray(turn.decision.spec?.steps)
            ? { ...turn.decision.spec, steps: turn.decision.spec.steps.map((step) => ({ ...step, context: { runtimeClass, ...(step && typeof step === 'object' ? step.context : null) } })) }
            : turn.decision.spec;
          outcome = normalizeDurableWorkflowOutcome(await this.#workflowRunner.run({ ...spec, signal }));
        } else {
          const input = { conversationId: turn.actionId, routes: turn.decision.routes, body: turn.decision.body, sourceResult: turn.decision.sourceResult, context: turn.decision.context, metadata: turn.decision.metadata };
          if (turn.decision.maxHops !== null) input.maxHops = turn.decision.maxHops;
          outcome = normalizeDurablePeerOutcome(await this.#peerRelay.exchange(input));
        }
      } catch (error) {
        outcome = { kind: turn.actionType, status: signal?.aborted ? 'cancelled' : 'failed', error: toSanitizedError(error) };
      }
    }
    outcome = sanitizePmDurable(outcome);
    const terminal = outcome.status !== 'completed';
    const patch = terminal ? { status: outcome.status === 'cancelled' ? 'cancelled' : 'failed', output: '', data: null, error: outcome.error ?? { name: 'PmActionError', message: `${turn.actionType} action ended with status ${outcome.status}` }, completedAt: String(this.#clock()) } : null;
    this.#repository.completeTurn(run.id, turn.turnIndex, outcome, patch);
    if (patch) this.#taskLog?.event(patch.status === 'cancelled' ? 'TASK_CANCELLED' : 'TASK_FAILED', { pm_run_id: run.id, error_code: patch.error?.code ?? patch.error?.name ?? null, error_reason: patch.error?.message ?? null });
    return null;
  }
}
