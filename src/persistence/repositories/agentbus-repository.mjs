/**
 * Persistence layer — AgentBus domain repository.
 *
 * Project-owned repository that maps the AgentBus state domain (tasks, runs,
 * results, messages, ordered bus transcript) onto the persistence substrate.
 * It is the ONLY reader/writer of AgentBus-domain rows; orchestration/bus code
 * never touches SQL. Run transition semantics intentionally mirror the legacy
 * in-memory StateStore (see tests for parity).
 *
 * Schema note: the schema v1 `results` table predates Gate 2 and has no
 * dedicated envelope column, so the repository persists the full, versioned
 * ResultEnvelope JSON in the `results.handoff` TEXT column (a documented
 * repository-owned convention); every read reconstructs the faithful envelope
 * from it. Scalar columns remain populated as query mirrors. No migration was
 * added: extending the schema would destabilize the Gate-1 fail-closed
 * "newer schema" fixtures, and the v1 tables already carry every required
 * field for a faithful round-trip.
 */

import { PersistenceError } from '../persistence-errors.mjs';
import { serializeDurable, parseDurable } from './json-durable.mjs';
import { BusError, UnknownRunError, UnknownTaskError, toSanitizedError } from '../../bus/errors.mjs';
import { nowUtc, runStatuses } from '../../bus/envelopes.mjs';
import {
  ATTEMPT_PHASES,
  assertLegalAttemptPhaseTransition,
  isAttemptPhase,
} from '../recovery/dispatch-attempt-protocol.mjs';

const VALID_STATUSES = runStatuses();
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TRANSITIONS = Object.freeze({
  created: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
});

const REPOSITORY_METHODS = Object.freeze([
  'createTask',
  'createRun',
  'addMessage',
  'addResult',
  'appendEvent',
  'updateRunStatus',
  'getTask',
  'getRun',
  'getResultByRun',
  'messagesForTask',
  'transcriptForTask',
  'listRuns',
  'countTasks',
  'countRuns',
  'prepareDispatch',
  'startDispatch',
  'startDispatchAndRun',
  'recordNativeStart',
  'transitionDispatchAttemptPhase',
  'terminalCommitSuccess',
  'terminalCommitFailure',
  'getDispatchAttempt',
  'getDispatchAttemptForRun',
  'listIncompleteDispatchAttempts',
]);

const STORE_SEAM_METHODS = Object.freeze(['run', 'get', 'all', 'transactionSync']);

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function isForeignKeyError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error?.code === 'SQLITE_CONSTRAINT_TRIGGER';
}

function rowToRun(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    agent: row.agent,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error === null || row.error === undefined ? null : parseDurable(row.error, 'run error'),
  };
}

export class AgentBusRepository {
  /**
   * @param {object} deps
   * @param {object} deps.store - an opened/migrated persistence store exposing
   *   the repository composition seam (`run`/`get`/`all`/`transactionSync`),
   *   e.g. the SQLite reference store.
   */
  constructor({ store } = {}) {
    if (store === null || typeof store !== 'object') {
      throw new TypeError('AgentBusRepository requires a persistence store');
    }
    const missingSeam = STORE_SEAM_METHODS.filter((name) => typeof store[name] !== 'function');
    if (missingSeam.length > 0) {
      throw new TypeError(`AgentBusRepository requires a store with repository seams; missing: ${missingSeam.join(', ')}`);
    }
    this.store = store;
  }

  /** Record a validated TaskEnvelope. Throws deterministically on a duplicate id. */
  createTask(task) {
    if (task === null || typeof task !== 'object') throw new TypeError('createTask requires a TaskEnvelope object');
    const envelope = serializeDurable(task, 'task envelope');
    try {
      this.store.run(
        'INSERT INTO tasks (id, record_version, sender, recipient, status, envelope, created_at) VALUES (?, 1, ?, ?, NULL, ?, ?)',
        [task.id, task.sender ?? null, task.recipient ?? null, envelope, task.createdAt ?? nowUtc()],
      );
    } catch (error) {
      if (isConstraintError(error)) throw new BusError(`duplicate task id: ${task.id}`, { code: 'DUPLICATE_TASK' });
      throw error;
    }
    return task;
  }

  createOwnerTask(task, pins) {
    const envelope=serializeDurable(task,'task envelope'); const policy=serializeDurable(pins.effectiveAutonomy,'effective autonomy');
    return this.store.transactionSync(({get,run})=>{const existing=get('SELECT envelope,project_id,pm_profile_id,effective_autonomy,envelope_revision,project_config_fingerprint FROM tasks WHERE id=?',[task.id]);if(existing){if(existing.envelope!==envelope||existing.project_id!==pins.projectId||existing.pm_profile_id!==pins.pmProfileId||existing.effective_autonomy!==policy||existing.envelope_revision!==pins.envelopeRevision||existing.project_config_fingerprint!==pins.projectConfigFingerprint)throw new BusError(`owner task identity conflict: ${task.id}`,{code:'OWNER_TASK_CONFLICT'});return task;}run('INSERT INTO tasks (id,record_version,sender,recipient,status,envelope,created_at,project_id,pm_profile_id,effective_autonomy,envelope_revision,project_config_fingerprint) VALUES (?,1,?,?,NULL,?,?,?,?,?,?,?)',[task.id,task.sender??null,task.recipient??null,envelope,task.createdAt??nowUtc(),pins.projectId,pins.pmProfileId,policy,pins.envelopeRevision,pins.projectConfigFingerprint]);return task;});
  }

  // P12-R5B Part C: the FIRST lossy boundary found for TEST 2/TEST 5 —
  // `envelope` is the exact TaskEnvelope object passed to createOwnerTask()
  // (id/sender/recipient/body/context/createdAt — owner-task-controller.mjs's
  // submit()), so `envelope.body`/`envelope.context` already durably hold
  // everything stamped there (durability/gitSync/review/relations/
  // runtimeClass/council/channel/ownerCommandId/taskSource). Before this fix
  // this method returned ONLY the flat pin columns (id/status/projectId/
  // pmProfileId/...) plus the still-serialized `envelope` blob — never a
  // top-level `.context`/`.body` — so every `task.context?.X` read in
  // production-pm-worker.mjs's execute() (the ONLY other real caller) was
  // silently `undefined`, always. This was invisible pre-P12 because
  // repo-history materialization was unconditional (no read of
  // `task.context` gated it); P12-R2's durability-gated materialization was
  // the first behavior to actually depend on this read, exposing the defect.
  // Every existing consumer keeps working unchanged — `body`/`context` are
  // purely additive fields no caller read before (there was nothing there to
  // depend on).
  getOwnerTask(taskId) { const row=this.store.get('SELECT id,status,envelope,project_id,pm_profile_id,effective_autonomy,envelope_revision,project_config_fingerprint,created_at FROM tasks WHERE id=?',[taskId]);if(!row)return null;const envelope=parseDurable(row.envelope,'task envelope');return Object.freeze({id:row.id,status:row.status,envelope,body:envelope?.body??null,context:envelope?.context??null,projectId:row.project_id,pmProfileId:row.pm_profile_id,effectiveAutonomy:row.effective_autonomy===null?null:parseDurable(row.effective_autonomy,'effective autonomy'),envelopeRevision:row.envelope_revision,projectConfigFingerprint:row.project_config_fingerprint,createdAt:row.created_at}); }
  listOwnerTasks({limit=50}={}) { return this.store.all('SELECT id FROM tasks WHERE project_id IS NOT NULL ORDER BY created_at,id LIMIT ?',[Math.min(100,Math.max(1,limit))]).map(({id})=>this.getOwnerTask(id)); }
  updateOwnerAutonomy(taskId,{expectedRevision,effectiveAutonomy}) { const policy=serializeDurable(effectiveAutonomy,'effective autonomy');return this.store.transactionSync(({get,run})=>{const row=get('SELECT envelope_revision FROM tasks WHERE id=?',[taskId]);if(!row)throw new UnknownTaskError(`unknown task: ${taskId}`);if(row.envelope_revision!==expectedRevision)throw new BusError('stale autonomy revision',{code:'STALE_AUTONOMY_REVISION'});run('UPDATE tasks SET effective_autonomy=?,envelope_revision=envelope_revision+1 WHERE id=?',[policy,taskId]);return this.getOwnerTask(taskId);}); }

  // P24.1G7A — single-final-settlement journal (schema v8, additive). Keyed
  // by `tasks.id` only (never `pm_run_id` — one task may span several PM
  // runs/turns; settlement is a task-wide fact, per G7's audit finding that
  // no new root id is needed). `git_settlement_revision` is the SAME CAS
  // pattern `updateOwnerAutonomy()` above already uses for
  // `envelope_revision` — a caller must present the revision it last read;
  // a stale write is rejected rather than silently overwriting a
  // concurrent/later transition (§23: same-task settlement is serialized/
  // idempotent, distinct tasks never collide since each owns its own row).
  // `record:null,revision:0` for a task that has never had a settlement
  // write is the durable equivalent of state UNSETTLED — never a missing-row
  // error, since every owner task implicitly starts UNSETTLED.
  getGitSettlement(taskId) {
    const row=this.store.get('SELECT git_settlement,git_settlement_revision FROM tasks WHERE id=?',[taskId]);
    if(!row)throw new UnknownTaskError(`unknown task: ${taskId}`);
    return Object.freeze({record:row.git_settlement===null?null:parseDurable(row.git_settlement,'git settlement journal'),revision:row.git_settlement_revision});
  }
  updateGitSettlement(taskId,{expectedRevision,record}) {
    const payload=serializeDurable(record,'git settlement journal');
    return this.store.transactionSync(({get,run})=>{
      const row=get('SELECT git_settlement_revision FROM tasks WHERE id=?',[taskId]);
      if(!row)throw new UnknownTaskError(`unknown task: ${taskId}`);
      if(row.git_settlement_revision!==expectedRevision)throw new BusError('stale git settlement revision',{code:'GIT_SETTLEMENT_CAS_CONFLICT'});
      run('UPDATE tasks SET git_settlement=?,git_settlement_revision=git_settlement_revision+1 WHERE id=?',[payload,taskId]);
      return this.getGitSettlement(taskId);
    });
  }

  // P24.1G6A — dynamic per-task fresh base admission journal (schema v9,
  // additive `git_admission_journal` table — deliberately NOT a column on
  // `tasks`, since admission resolves/pins the task's Git base and creates
  // its branch strictly BEFORE any task row exists; `task_id` is
  // deterministic from the owner command id and therefore usable as a
  // durable key before that row is created). CAS via `revision`, same
  // discipline as `updateOwnerAutonomy()`/`updateGitSettlement()` above,
  // except this one also supports the FIRST write (`expectedRevision:0`
  // with no existing row -> INSERT) since there is no pre-existing row to
  // require. `record:null,revision:0` for a task never observed at all is
  // the durable equivalent of state UNPREPARED.
  getGitAdmission(taskId) {
    const row=this.store.get('SELECT project_id,repo_path,workspace_id,effective_remote,base_branch,base_policy,project_expected_sha,caller_expected_sha,observed_base_sha,task_branch,state,revision,error_code,created_at,updated_at FROM git_admission_journal WHERE task_id=?',[taskId]);
    if(!row)return Object.freeze({record:null,revision:0});
    const {revision,...rest}=row;
    return Object.freeze({record:Object.freeze(rest),revision});
  }
  upsertGitAdmission(taskId,{expectedRevision,record}) {
    return this.store.transactionSync(({get,run})=>{
      const row=get('SELECT revision FROM git_admission_journal WHERE task_id=?',[taskId]);
      const currentRevision=row?row.revision:0;
      if(currentRevision!==expectedRevision)throw new BusError('stale git admission revision',{code:'ADMISSION_RECOVERY_CONFLICT'});
      const now=record.updated_at;
      const cols=[record.project_id??null,record.repo_path??null,record.workspace_id??null,record.effective_remote??null,record.base_branch??null,record.base_policy??null,record.project_expected_sha??null,record.caller_expected_sha??null,record.observed_base_sha??null,record.task_branch??null,record.state,record.error_code??null];
      if(!row){
        run('INSERT INTO git_admission_journal (task_id,project_id,repo_path,workspace_id,effective_remote,base_branch,base_policy,project_expected_sha,caller_expected_sha,observed_base_sha,task_branch,state,revision,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
          [taskId,...cols,now,now]);
      }else{
        run('UPDATE git_admission_journal SET project_id=?,repo_path=?,workspace_id=?,effective_remote=?,base_branch=?,base_policy=?,project_expected_sha=?,caller_expected_sha=?,observed_base_sha=?,task_branch=?,state=?,error_code=?,revision=revision+1,updated_at=? WHERE task_id=?',
          [...cols,now,taskId]);
      }
      return this.getGitAdmission(taskId);
    });
  }

  // P24.3A — task-workspace-isolation FOUNDATION durable allocation record
  // (schema v10, additive `task_workspace_registry` table — deliberately
  // NOT a column on `tasks`, for the identical reason schema v9's
  // `git_admission_journal` is not: see migrations.mjs's schema-v10
  // docstring). Same CAS discipline as `getGitAdmission`/
  // `upsertGitAdmission` above, including the same "record:null,revision:0
  // means never observed" semantics for a task that has no workspace row —
  // NOT a column on the git admission journal itself, and never read or
  // written by that module. This accessor pair is currently called by
  // nothing in production composition (`src/pm/task-workspace-manager.mjs`
  // is the only caller, and nothing wires that module into
  // `p5-production-composition.mjs`/`production-pm-worker.mjs`/
  // `owner-task-controller.mjs` yet) — feature OFF by construction, not by
  // a runtime flag check.
  getTaskWorkspace(taskId) {
    const row=this.store.get('SELECT project_id,isolation_version,repository_common_dir,workspace_path,task_branch,pinned_base_sha,remote_config_fingerprint,state,revision,reason_code,created_at,updated_at FROM task_workspace_registry WHERE task_id=?',[taskId]);
    if(!row)return Object.freeze({record:null,revision:0});
    const {revision,...rest}=row;
    return Object.freeze({record:Object.freeze(rest),revision});
  }
  upsertTaskWorkspace(taskId,{expectedRevision,record}) {
    return this.store.transactionSync(({get,run})=>{
      const row=get('SELECT revision FROM task_workspace_registry WHERE task_id=?',[taskId]);
      const currentRevision=row?row.revision:0;
      if(currentRevision!==expectedRevision)throw new BusError('stale task workspace revision',{code:'WORKSPACE_RECOVERY_CONFLICT'});
      const now=new Date().toISOString();
      const cols=[record.project_id,record.isolation_version,record.repository_common_dir,record.workspace_path,record.task_branch,record.pinned_base_sha,record.remote_config_fingerprint??null,record.state,record.reason_code??null];
      if(!row){
        run('INSERT INTO task_workspace_registry (task_id,project_id,isolation_version,repository_common_dir,workspace_path,task_branch,pinned_base_sha,remote_config_fingerprint,state,revision,reason_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)',
          [taskId,...cols,now,now]);
      }else{
        run('UPDATE task_workspace_registry SET project_id=?,isolation_version=?,repository_common_dir=?,workspace_path=?,task_branch=?,pinned_base_sha=?,remote_config_fingerprint=?,state=?,reason_code=?,revision=revision+1,updated_at=? WHERE task_id=?',
          [...cols,now,taskId]);
      }
      return this.getTaskWorkspace(taskId);
    });
  }

  // P24.3C-R1 — durable, bounded git-failure diagnostics (schema v11,
  // additive `task_workspace_git_diagnostics` table; see migrations.mjs's
  // schema-v11 docstring for why this is APPEND-ONLY rather than a CAS-
  // guarded single row). `recordTaskWorkspaceGitDiagnostic` never throws on
  // a caller-supplied oversized field — it truncates defensively at the SAME
  // 4096-byte bound `TaskWorkspaceError.extra.stderr` has always used, so a
  // best-effort diagnostic write can never itself become a new failure mode.
  recordTaskWorkspaceGitDiagnostic(taskId,{projectId=null,gitOperation,errorCode,exitCode=null,timedOut=false,boundedStderr=null,boundedStdout=null,workspacePath=null,taskBranch=null,pinnedBaseSha=null}={}) {
    const cap=(s)=>typeof s==='string'?s.slice(0,4096):null;
    const now=new Date().toISOString();
    this.store.run(
      'INSERT INTO task_workspace_git_diagnostics (task_id,project_id,git_operation,error_code,exit_code,timed_out,bounded_stderr,bounded_stdout,workspace_path,task_branch,pinned_base_sha,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [taskId,projectId,gitOperation,errorCode,exitCode,timedOut?1:0,cap(boundedStderr),cap(boundedStdout),workspacePath,taskBranch,pinnedBaseSha,now],
    );
  }
  listTaskWorkspaceGitDiagnostics(taskId) {
    return this.store.all(
      'SELECT id,task_id,project_id,git_operation,error_code,exit_code,timed_out,bounded_stderr,bounded_stdout,workspace_path,task_branch,pinned_base_sha,created_at FROM task_workspace_git_diagnostics WHERE task_id=? ORDER BY id ASC',
      [taskId],
    ).map((row)=>Object.freeze({...row,timed_out:Boolean(row.timed_out)}));
  }

  // P24.3C-R1 — narrow, project-scoped listing for orphan-allocation
  // reconciliation (task-workspace-orphan-reconciliation.mjs). Reuses the
  // existing `idx_task_workspace_registry_project` index (schema v10); never
  // scans across projects, never scans the filesystem.
  listTaskWorkspacesByProjectState(projectId,state) {
    return this.store.all(
      'SELECT task_id,project_id,isolation_version,repository_common_dir,workspace_path,task_branch,pinned_base_sha,remote_config_fingerprint,state,revision,reason_code,created_at,updated_at FROM task_workspace_registry WHERE project_id=? AND state=? ORDER BY created_at ASC',
      [projectId,state],
    ).map(({task_id,revision,...rest})=>Object.freeze({taskId:task_id,record:Object.freeze(rest),revision}));
  }

  /** @returns {object|undefined} the TaskEnvelope, if known. */
  getTask(taskId) {
    const row = this.store.get('SELECT envelope FROM tasks WHERE id = ?', [taskId]);
    if (!row) return undefined;
    return parseDurable(row.envelope, 'task envelope');
  }

  /** Record a RunRecord in `created` state. Requires the owning task to exist. */
  createRun(run) {
    if (run === null || typeof run !== 'object') throw new TypeError('createRun requires a RunRecord object');
    serializeDurable(run, 'run record');
    const errorJson = run.error === null || run.error === undefined ? null : serializeDurable(toSanitizedError(run.error), 'run error');
    try {
      this.store.run(
        'INSERT INTO runs (id, record_version, task_id, agent, status, started_at, completed_at, error, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
        [run.id, run.taskId, run.agent ?? null, run.status, run.startedAt ?? null, run.completedAt ?? null, errorJson, nowUtc()],
      );
    } catch (error) {
      if (isForeignKeyError(error)) throw new UnknownTaskError(`unknown task: ${run.taskId}`);
      if (isConstraintError(error)) throw new BusError(`duplicate run id: ${run.id}`, { code: 'DUPLICATE_RUN' });
      throw error;
    }
    return run;
  }

  /** @returns {object|undefined} the RunRecord, if known. */
  getRun(runId) {
    const row = this.store.get(
      'SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs WHERE id = ?',
      [runId],
    );
    if (!row) return undefined;
    return rowToRun(row);
  }

  /**
   * @param {object} current - current RunRecord.
   * @param {string} status - target terminal status.
   * @param {{ startedAt?: string, completedAt?: string, error?: object|null }} [patch]
   * @returns {object} the next RunRecord, reusing the legacy StateStore
   *   transition rules (terminal immutability + explicit transitions).
   */
  #prepareNextRun(current, status, { startedAt, completedAt, error } = {}) {
    if (!VALID_STATUSES.has(status)) throw new BusError(`invalid run status: ${String(status)}`);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new BusError(`run "${current.id}" is already terminal (${current.status})`);
    }
    const allowed = TRANSITIONS[current.status];
    if (!allowed || !allowed.has(status)) {
      throw new BusError(`invalid run status transition: ${current.status} -> ${status}`);
    }
    const next = { ...current };
    if (startedAt !== undefined) next.startedAt = startedAt;
    if (completedAt !== undefined) next.completedAt = completedAt;
    if (error !== undefined) next.error = error === null ? null : toSanitizedError(error);
    next.status = status;
    return next;
  }

  /**
   * Transition a run's status, enforcing the same explicit state machine as
   * the legacy StateStore. Read + validate + write are one atomic unit, so a
   * failed mutation never leaves a half-applied status.
   */
  updateRunStatus(runId, { status, startedAt, completedAt, error } = {}) {
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs WHERE id = ?', [runId]);
      if (!row) throw new UnknownRunError(`unknown run: ${runId}`);
      const next = this.#prepareNextRun(rowToRun(row), status, { startedAt, completedAt, error });
      const errorJson = next.error === null ? null : serializeDurable(next.error, 'run error');
      run(
        'UPDATE runs SET status = ?, started_at = ?, completed_at = ?, error = ?, state_revision = state_revision + 1 WHERE id = ?',
        [next.status, next.startedAt, next.completedAt, errorJson, runId],
      );
      return next;
    });
  }

  /** Record a ResultEnvelope. Enforces at most one result per run. */
  addResult(result) {
    if (result === null || typeof result !== 'object') throw new TypeError('addResult requires a ResultEnvelope object');
    const envelope = serializeDurable(result, 'result envelope');
    try {
      this.store.run(
        'INSERT INTO results (id, record_version, run_id, agent, status, output, handoff, artifacts, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
        [result.id, result.runId, result.agent ?? null, result.status, result.output ?? '', envelope, serializeDurable(result.artifacts, 'result artifacts'), result.completedAt ?? nowUtc()],
      );
    } catch (error) {
      if (isForeignKeyError(error)) throw new UnknownRunError(`unknown run: ${result.runId}`);
      if (isConstraintError(error)) {
        if (error.message?.includes('results.run_id')) {
          throw new BusError(`result already recorded for run "${result.runId}"`);
        }
        throw new BusError(`duplicate result id: ${result.id}`, { code: 'DUPLICATE_RESULT' });
      }
      throw error;
    }
    return result;
  }

  /** @returns {object|undefined} the ResultEnvelope for a run, if any. */
  getResultByRun(runId) {
    const row = this.store.get('SELECT handoff FROM results WHERE run_id = ?', [runId]);
    if (!row) return undefined;
    return parseDurable(row.handoff, 'result envelope');
  }

  /** Record a validated MessageEnvelope. */
  addMessage(message) {
    if (message === null || typeof message !== 'object') throw new TypeError('addMessage requires a MessageEnvelope object');
    const envelope = serializeDurable(message, 'message envelope');
    try {
      this.store.run(
        'INSERT INTO messages (id, record_version, task_id, run_id, from_identity, to_identity, body, reply_to, kind, conversation_id, hop_id, envelope, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [message.id, message.taskId, message.runId, message.from, message.to, message.body, message.replyTo, message.kind, message.conversationId, message.hopId, envelope, message.createdAt ?? nowUtc()],
      );
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new BusError('message references an unknown task or run', { code: 'MESSAGE_REFERENCE_VIOLATION' });
      }
      if (isConstraintError(error)) throw new BusError(`duplicate message id: ${message.id}`, { code: 'DUPLICATE_MESSAGE' });
      throw error;
    }
    return message;
  }

  /** @returns {object[]} messages for a task, in durable creation order. */
  messagesForTask(taskId) {
    return this.store
      .all('SELECT envelope FROM messages WHERE task_id = ? ORDER BY rowid', [taskId])
      .map((row) => parseDurable(row.envelope, 'message envelope'));
  }

  /**
   * Append an ordered, durable bus lifecycle entry. Mirrors the legacy
   * StateStore shape exactly; no event is fabricated on hydration.
   * @param {{ taskId?: string|null, runId?: string|null, agent?: string|null, event: string, at?: string }} entry
   */
  appendEvent(entry) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('appendEvent requires an entry object');
    const normalized = {
      at: entry.at ?? nowUtc(),
      taskId: entry.taskId ?? null,
      runId: entry.runId ?? null,
      agent: entry.agent ?? null,
      event: entry.event,
    };
    if (typeof normalized.event !== 'string' || normalized.event.trim() === '') {
      throw new BusError('event name must be a non-empty string', { code: 'INVALID_EVENT' });
    }
    const payload = serializeDurable(normalized, 'event payload');
    this.store.run(
      'INSERT INTO bus_events (task_id, run_id, agent, event, payload, at) VALUES (?, ?, ?, ?, ?, ?)',
      [normalized.taskId, normalized.runId, normalized.agent, normalized.event, payload, normalized.at],
    );
  }

  /** @returns {object[]} ordered transcript entries for a task. */
  transcriptForTask(taskId) {
    return this.store
      .all('SELECT at, task_id, run_id, agent, event FROM bus_events WHERE task_id = ? ORDER BY id', [taskId])
      .map((row) => ({ at: row.at, taskId: row.task_id, runId: row.run_id, agent: row.agent, event: row.event }));
  }

  /** @returns {object[]} runs, optionally filtered. */
  listRuns({ taskId, agent, status } = {}) {
    const clauses = [];
    const params = [];
    if (taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(taskId);
    }
    if (agent !== undefined) {
      clauses.push('agent = ?');
      params.push(agent);
    }
    if (status !== undefined) {
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.store
      .all(`SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs${where} ORDER BY rowid`, params)
      .map(rowToRun);
  }

  /** @returns {number} number of tasks recorded. */
  countTasks() {
    return this.store.get('SELECT COUNT(*) AS count FROM tasks').count;
  }

  /** @returns {number} number of runs recorded. */
  countRuns() {
    return this.store.get('SELECT COUNT(*) AS count FROM runs').count;
  }

  /**
   * Materialize a dispatch_attempts row into an attempt record object. A
   * payload that fails to parse is preserved as `corruptPayload: true` rather
   * than throwing, so the recovery classifier can decide the branch itself.
   * @param {object} row - dispatch_attempts row.
   * @returns {object} attempt record.
   */
  #toAttempt(row) {
    let payload;
    let corruptPayload = false;
    try {
      payload = row.payload === null || row.payload === undefined || row.payload === '' ? {} : JSON.parse(row.payload);
    } catch (error) {
      payload = null;
      corruptPayload = true;
    }
    if (!corruptPayload && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
      payload = {};
    }
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      backend: row.backend,
      phase: row.phase,
      classification: row.classification,
      nativeReference: corruptPayload ? null : payload.nativeReference ?? null,
      payload: corruptPayload ? null : payload,
      corruptPayload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Phase 2 write-ahead dispatch preparation. Atomically records the task + run
   * and a dispatch attempt in INTENT_COMMITTED, the outer boundary of the
   * dispatch-protocol state machine.
   *
   * Gate 3 rule that shapes this method: no terminal truth is ever written for
   * an attempt that never reached DISPATCH_STARTED, so an intent-only attempt
   * always recovers as SAFE_TO_DISPATCH.
   *
   * @param {{ task: object, run: object, attemptId: string, backend: string }} input
   * @returns {object} `{ task, run, attempt }` after the atomic write.
   * @throws {BusError} DUPLICATE_TASK / DUPLICATE_RUN / DUPLICATE_DISPATCH_ATTEMPT
   *   when any of the three identities is already present.
   */
  prepareDispatch({ task, run, attemptId, backend } = {}) {
    if (task === null || typeof task !== 'object') throw new TypeError('prepareDispatch requires a TaskEnvelope object');
    if (run === null || typeof run !== 'object') throw new TypeError('prepareDispatch requires a RunRecord object');
    if (typeof attemptId !== 'string' || attemptId === '') throw new TypeError('prepareDispatch requires a stable attemptId');
    if (typeof backend !== 'string' || backend === '') throw new TypeError('prepareDispatch requires a backend identity');
    const taskId = task.id;
    const runId = run.id;
    serializeDurable(task, 'task envelope');
    serializeDurable(run, 'run record');
    const payload = Object.freeze({});
    const createdAt = nowUtc();
    try {
      this.store.transactionSync(({ run: q }) => {
        q(
          'INSERT INTO tasks (id, record_version, sender, recipient, status, envelope, created_at) VALUES (?, 1, ?, ?, NULL, ?, ?)',
          [taskId, task.sender ?? null, task.recipient ?? null, serializeDurable(task, 'task envelope'), task.createdAt ?? createdAt],
        );
        q(
          'INSERT INTO runs (id, record_version, task_id, agent, status, started_at, completed_at, error, created_at) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL, ?)',
          [runId, taskId, run.agent ?? null, run.status ?? 'created', run.startedAt ?? null, createdAt],
        );
        q(
          'INSERT INTO dispatch_attempts (id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, ?, ?)',
          [attemptId, taskId, runId, backend, ATTEMPT_PHASES.INTENT_COMMITTED, serializeDurable(payload, 'dispatch attempt payload'), createdAt, createdAt],
        );
      });
    } catch (error) {
      if (isConstraintError(error)) {
        if (error.message?.includes('dispatch_attempts.id')) {
          throw new BusError(`duplicate dispatch attempt: ${attemptId}`, { code: 'DUPLICATE_DISPATCH_ATTEMPT' });
        }
        if (error.message?.includes('runs.id')) throw new BusError(`duplicate run: ${runId}`, { code: 'DUPLICATE_RUN' });
        if (error.message?.includes('tasks.id')) throw new BusError(`duplicate task: ${taskId}`, { code: 'DUPLICATE_TASK' });
        throw new BusError('dispatch preparation rejected by store constraints', { code: 'DISPATCH_PREP_CONSTRAINT', cause: error });
      }
      if (isForeignKeyError(error)) {
        throw new BusError('dispatch preparation references an unknown task or run', { code: 'DISPATCH_REFERENCE_VIOLATION' });
      }
      throw error;
    }
    const attempt = Object.freeze({
      id: attemptId,
      taskId,
      runId,
      backend,
      phase: ATTEMPT_PHASES.INTENT_COMMITTED,
      classification: null,
      nativeReference: null,
      payload,
      corruptPayload: false,
      createdAt,
      updatedAt: createdAt,
    });
    return { task, run, attempt };
  }

  /**
   * Generic attempt-phase transition used by the dispatch lifecycle. Writes the
   * new phase + payload atomically, with the correct state-machine guard thrown
   * by the protocol module when the transition is illegal.
   * @param {string} attemptId - attempt identity.
   * @param {string} targetPhase - legal target attempt phase.
   * @param {object} [payloadMerge] - key merge applied to the stored payload.
   * @returns {object} the updated attempt record.
   */
  transitionDispatchAttemptPhase(attemptId, targetPhase, { payloadMerge = {} } = {}) {
    if (!isAttemptPhase(targetPhase)) {
      throw new BusError(`invalid target attempt phase: ${String(targetPhase)}`, { code: 'INVALID_ATTEMPT_PHASE' });
    }
    if (targetPhase === ATTEMPT_PHASES.TERMINAL_COMMITTED) {
      throw new BusError('terminal commits must flow through the dedicated terminal commit writes', {
        code: 'TERMINAL_COMMIT_USE_DEDICATED_WRITE',
      });
    }
    return this.store.transactionSync(({ get, run }) => {
      const row = get(
        'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE id = ?',
        [attemptId],
      );
      if (!row) throw new BusError(`unknown dispatch attempt: ${attemptId}`, { code: 'UNKNOWN_DISPATCH_ATTEMPT' });
      const attempt = this.#toAttempt(row);
      assertLegalAttemptPhaseTransition(attempt.id, attempt.phase, targetPhase);
      const payload = { ...(attempt.payload ?? {}), ...(payloadMerge ?? {}) };
      const updatedAt = nowUtc();
      run(
        'UPDATE dispatch_attempts SET phase = ?, payload = ?, updated_at = ? WHERE id = ?',
        [targetPhase, serializeDurable(payload, 'dispatch attempt payload'), updatedAt, attempt.id],
      );
      return { ...attempt, phase: targetPhase, payload, corruptPayload: false, updatedAt };
    });
  }

  /**
   * Cross the durable dispatch boundary: INTENT_COMMITTED -> DISPATCH_STARTED.
   * Until this transition persists, the attempt recovers as SAFE_TO_DISPATCH.
   * @param {string} attemptId - attempt identity.
   * @returns {object} the updated attempt record.
   */
  startDispatch(attemptId) {
    return this.transitionDispatchAttemptPhase(attemptId, ATTEMPT_PHASES.DISPATCH_STARTED);
  }

  /** Atomically cross DISPATCH_STARTED and mark its exact run running. */
  startDispatchAndRun({ attemptId, runId, startedAt = nowUtc() } = {}) {
    if (typeof attemptId !== 'string' || attemptId === '' || typeof runId !== 'string' || runId === '') {
      throw new TypeError('startDispatchAndRun requires attemptId and runId');
    }
    return this.store.transactionSync(({ get, run }) => {
      const attemptRow = get(
        'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE id = ?',
        [attemptId],
      );
      if (!attemptRow) throw new BusError(`unknown dispatch attempt: ${attemptId}`, { code: 'UNKNOWN_DISPATCH_ATTEMPT' });
      const attempt = this.#toAttempt(attemptRow);
      if (attempt.runId !== runId) throw new BusError('dispatch attempt/run lineage mismatch', { code: 'DISPATCH_LINEAGE_MISMATCH' });
      assertLegalAttemptPhaseTransition(attempt.id, attempt.phase, ATTEMPT_PHASES.DISPATCH_STARTED);
      const runRow = get('SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs WHERE id = ?', [runId]);
      if (!runRow) throw new UnknownRunError(`unknown run: ${runId}`);
      const nextRun = this.#prepareNextRun(rowToRun(runRow), 'running', { startedAt });
      const updatedAt = nowUtc();
      run('UPDATE dispatch_attempts SET phase = ?, updated_at = ? WHERE id = ?', [ATTEMPT_PHASES.DISPATCH_STARTED, updatedAt, attemptId]);
      run('UPDATE runs SET status = ?, started_at = ?, state_revision = state_revision + 1 WHERE id = ?', [nextRun.status, nextRun.startedAt, runId]);
      return {
        attempt: { ...attempt, phase: ATTEMPT_PHASES.DISPATCH_STARTED, updatedAt },
        run: nextRun,
      };
    });
  }

  /**
   * Correlate a dispatch attempt with the external (native) session that was
   * actually started: DISPATCH_STARTED -> REMOTE_STARTED. The durable
   * native-reference columns are written into the attempt payload for recovery
   * classifier consumption (RAW table extension satisfies the deliverable
   * while ADDITIVE semantics keep light-view readers stable).
   * @param {{ attemptId: string, backend: string, nativeSessionId: string, product?: string|null, version?: string|null, observedAt?: string }} input
   * @returns {object} the updated attempt record with `nativeReference` set.
   */
  recordNativeStart({ attemptId, backend, nativeSessionId, product, version, observedAt } = {}) {
    if (typeof nativeSessionId !== 'string' || nativeSessionId === '') {
      throw new TypeError('recordNativeStart requires a nativeSessionId');
    }
    const nativeReference = Object.freeze({
      backend,
      nativeSessionId,
      product: product ?? null,
      version: version ?? null,
      observedAt: observedAt ?? nowUtc(),
    });
    return this.transitionDispatchAttemptPhase(attemptId, ATTEMPT_PHASES.REMOTE_STARTED, {
      payloadMerge: { nativeReference },
    });
  }

  /**
   * Terminal-success commit. One atomic write performs: run -> completed (with
   * validated transition), result persistence (at most one per run), and the
   * attempt -> TERMINAL_COMMITTED. An attempt that is not past DISPATCH_STARTED
   * cannot be committed here, preserving the recoverability of intent-only
   * attempts.
   * @param {{ runId: string, result: object }} input - ResultEnvelope carrying
   *   a stable `id` and a `runId` that matches the parameter.
   * @returns {object} `{ run, result, attempt }` post-commit.
   * @throws {BusError} codes UNKNOWN_DISPATCH_ATTEMPT / UNKNOWN_RUN /
   *   RESULT_ALREADY_RECORDED / INVALID_ATTEMPT_PHASE_TRANSITION.
   */
  terminalCommitSuccess({ runId, result } = {}) {
    if (typeof runId !== 'string' || runId === '') throw new TypeError('terminalCommitSuccess requires runId');
    if (result === null || typeof result !== 'object') throw new TypeError('terminalCommitSuccess requires a ResultEnvelope');
    if (typeof result.id !== 'string' || result.id === '') throw new TypeError('terminalCommitSuccess requires a result with a stable id');
    if (result.runId !== undefined && result.runId !== runId) {
      throw new BusError(`result.runId "${result.runId}" does not match run "${runId}"`, { code: 'RESULT_RUN_MISMATCH' });
    }
    const envelope = { ...result, runId };
    const completedAt = result.completedAt ?? nowUtc();
    return this.store.transactionSync(({ get, run }) => {
      const attemptRow = get(
        'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE run_id = ?',
        [runId],
      );
      if (!attemptRow) throw new BusError(`no dispatch attempt for run "${runId}"`, { code: 'UNKNOWN_DISPATCH_ATTEMPT' });
      const attempt = this.#toAttempt(attemptRow);
      assertLegalAttemptPhaseTransition(attempt.id, attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
      const runRow = get('SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs WHERE id = ?', [runId]);
      if (!runRow) throw new UnknownRunError(`unknown run: ${runId}`);
      const next = this.#prepareNextRun(rowToRun(runRow), 'completed', { completedAt });
      const errorJson = next.error === null ? null : serializeDurable(next.error, 'run error');
      run(
        'UPDATE runs SET status = ?, started_at = ?, completed_at = ?, error = ?, state_revision = state_revision + 1 WHERE id = ?',
        [next.status, next.startedAt, next.completedAt, errorJson, runId],
      );
      try {
        run(
          'INSERT INTO results (id, record_version, run_id, agent, status, output, handoff, artifacts, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
          [
            envelope.id,
            runId,
            envelope.agent ?? next.agent,
            envelope.status,
            envelope.output ?? '',
            serializeDurable(envelope, 'result envelope'),
            serializeDurable(envelope.artifacts, 'result artifacts'),
            completedAt,
          ],
        );
      } catch (error) {
        if (isConstraintError(error) && error.message?.includes('results.run_id')) {
          throw new BusError(`result already recorded for run "${runId}"`, { code: 'RESULT_ALREADY_RECORDED' });
        }
        throw error;
      }
      const updatedAt = nowUtc();
      run(
        'UPDATE dispatch_attempts SET phase = ?, classification = ?, updated_at = ? WHERE id = ?',
        [ATTEMPT_PHASES.TERMINAL_COMMITTED, null, updatedAt, attempt.id],
      );
      return {
        run: next,
        result: envelope,
        attempt: { ...attempt, phase: ATTEMPT_PHASES.TERMINAL_COMMITTED, classification: null, updatedAt },
      };
    });
  }

  /**
   * Terminal-failure commit. One atomic write performs: run -> failed|cancelled
   * (validated transition, sanitized error), no result, and the attempt ->
   * TERMINAL_COMMITTED.
   * @param {{ runId: string, status: string, completedAt?: string, error?: object }} input
   * @returns {object} `{ run, attempt }` post-commit.
   * @throws {BusError} codes UNKNOWN_DISPATCH_ATTEMPT / UNKNOWN_RUN /
   *   INVALID_ATTEMPT_PHASE_TRANSITION / INVALID_RUN_STATUS / INVALID_RUN_TRANSITION.
   */
  terminalCommitFailure({ runId, status, completedAt, error } = {}) {
    if (typeof runId !== 'string' || runId === '') throw new TypeError('terminalCommitFailure requires runId');
    if (!TERMINAL_STATUSES.has(status)) {
      throw new BusError(`terminal commit requires a terminal failure status, got: ${String(status)}`, {
        code: 'INVALID_RUN_STATUS',
      });
    }
    if (status === 'completed') {
      throw new BusError('completed terminal commits must flow through terminalCommitSuccess', {
        code: 'TERMINAL_COMMIT_USE_DEDICATED_WRITE',
      });
    }
    return this.store.transactionSync(({ get, run }) => {
      const attemptRow = get(
        'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE run_id = ?',
        [runId],
      );
      if (!attemptRow) throw new BusError(`no dispatch attempt for run "${runId}"`, { code: 'UNKNOWN_DISPATCH_ATTEMPT' });
      const attempt = this.#toAttempt(attemptRow);
      assertLegalAttemptPhaseTransition(attempt.id, attempt.phase, ATTEMPT_PHASES.TERMINAL_COMMITTED);
      const runRow = get('SELECT id, task_id, agent, status, started_at, completed_at, error FROM runs WHERE id = ?', [runId]);
      if (!runRow) throw new UnknownRunError(`unknown run: ${runId}`);
      const next = this.#prepareNextRun(rowToRun(runRow), status, { completedAt: completedAt ?? nowUtc(), error: error ?? null });
      const errorJson = next.error === null ? null : serializeDurable(next.error, 'run error');
      run(
        'UPDATE runs SET status = ?, started_at = ?, completed_at = ?, error = ?, state_revision = state_revision + 1 WHERE id = ?',
        [next.status, next.startedAt, next.completedAt, errorJson, runId],
      );
      const updatedAt = nowUtc();
      run(
        'UPDATE dispatch_attempts SET phase = ?, classification = ?, updated_at = ? WHERE id = ?',
        [ATTEMPT_PHASES.TERMINAL_COMMITTED, null, updatedAt, attempt.id],
      );
      return { run: next, attempt: { ...attempt, phase: ATTEMPT_PHASES.TERMINAL_COMMITTED, classification: null, updatedAt } };
    });
  }

  /** @returns {object|undefined} the dispatch attempt record, if known. */
  getDispatchAttempt(attemptId) {
    const row = this.store.get(
      'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE id = ?',
      [attemptId],
    );
    if (!row) return undefined;
    return this.#toAttempt(row);
  }

  /** @returns {object|undefined} the dispatch attempt record for a run, if any. */
  getDispatchAttemptForRun(runId) {
    const row = this.store.get(
      'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE run_id = ?',
      [runId],
    );
    if (!row) return undefined;
    return this.#toAttempt(row);
  }

  /** @returns {object[]} every dispatch attempt that is not yet terminal, in creation order. */
  listIncompleteDispatchAttempts() {
    return this.store
      .all(
        'SELECT id, record_version, task_id, run_id, backend, phase, classification, payload, created_at, updated_at FROM dispatch_attempts WHERE phase != ? ORDER BY created_at, id',
        [ATTEMPT_PHASES.TERMINAL_COMMITTED],
      )
      .map((row) => this.#toAttempt(row));
  }

  /**
   * Integrity check used by durable-store wiring/tests.
   * @returns {true}
   * @throws {PersistenceError} with code `INVALID_AGENTBUS_REPOSITORY` when any
   *   required repository member is missing.
   */
  assertComplete() {
    const missing = REPOSITORY_METHODS.filter((name) => typeof this[name] !== 'function');
    if (missing.length > 0) {
      throw new PersistenceError(`AgentBusRepository missing required members: ${missing.join(', ')}`, {
        code: 'INVALID_AGENTBUS_REPOSITORY',
        missing,
      });
    }
    return true;
  }
}
