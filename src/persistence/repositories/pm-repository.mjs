/** Sole SQL owner for durable PM requests, runs, and turns. */

import { PersistenceError } from '../persistence-errors.mjs';
import { parseDurable, serializeDurable } from './json-durable.mjs';
import { isDeepStrictEqual } from 'node:util';

export const PM_TURN_PHASES = Object.freeze({
  DECISION_COMMITTED: 'DECISION_COMMITTED',
  ACTION_STARTED: 'ACTION_STARTED',
  TURN_COMPLETE: 'TURN_COMPLETE',
});

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ACTION = new Set(['completed', 'failed', 'cancelled']);

export class PmPersistenceError extends PersistenceError {
  constructor(message, extra = {}) {
    super(message, extra);
    this.name = 'PmPersistenceError';
  }
}

function corrupt(message, extra = {}) {
  throw new PmPersistenceError(message, { code: 'CORRUPT_PM_STATE', ...extra });
}

function parse(value, label) {
  try { return parseDurable(value, label); } catch (error) {
    throw new PmPersistenceError(`corrupt ${label}`, { code: 'CORRUPT_PM_STATE', cause: error });
  }
}

function rowToTurn(row) {
  return Object.freeze({
    id: row.id,
    pmRunId: row.pm_run_id,
    turnIndex: row.turn_index,
    decision: parse(row.decision, 'PM decision'),
    outcome: row.outcome === null ? null : parse(row.outcome, 'PM outcome'),
    phase: row.phase,
    actionType: row.action_type,
    actionId: row.action_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    committed: row.committed,
  });
}

export class PmRepository {
  constructor({ store } = {}) {
    if (!store || typeof store.run !== 'function' || typeof store.get !== 'function' || typeof store.all !== 'function' || typeof store.transactionSync !== 'function') {
      throw new TypeError('PmRepository requires an opened persistence store contract');
    }
    this.store = store;
  }

  create(request, run) {
    const envelope = serializeDurable(request, 'PM request');
    const hasProfilePin = this.store.all('PRAGMA table_info(pm_runs)').some((column) => column.name === 'pm_profile_id');
    this.store.transactionSync(({ run: execute }) => {
      execute('INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?, ?, ?, ?, ?)', [request.id, request.objective, serializeDurable(request.context, 'PM context'), envelope, request.createdAt]);
      if (hasProfilePin) execute('INSERT INTO pm_runs (id, request_id, driver, status, output, data, error, started_at, completed_at, created_at, turn_count, pm_profile_id, pm_profile_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)', [run.id, request.id, run.driver, 'running', '', null, null, run.startedAt, null, run.startedAt, run.pmProfileId ?? null, run.pmProfileFingerprint ?? null]);
      else execute('INSERT INTO pm_runs (id, request_id, driver, status, output, data, error, started_at, completed_at, created_at, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)', [run.id, request.id, run.driver, 'running', '', null, null, run.startedAt, null, run.startedAt]);
    });
    return this.load(run.id);
  }

  find(pmRunId) { const row=this.store.get('SELECT id FROM pm_runs WHERE id=?',[pmRunId]);return row?this.load(pmRunId):null; }

  listTerminalRuns({ limit = 20 } = {}) {
    const bounded = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
    return this.store
      .all("SELECT id FROM pm_runs WHERE status IN ('completed','failed','cancelled') ORDER BY completed_at DESC,id DESC LIMIT ?", [bounded])
      .map(({ id }) => this.load(id));
  }

  createOrAdopt(request, run) {
    const existing=this.find(run.id);
    if(!existing){try{return this.create(request,run);}catch(error){const raced=this.find(run.id);if(!raced)throw error;return this.#assertCompatible(raced,request,run);}}
    return this.#assertCompatible(existing,request,run);
  }

  #assertCompatible(existing,request,run){if(existing.driver!==run.driver||existing.pmProfileId!==(run.pmProfileId??null)||existing.pmProfileFingerprint!==(run.pmProfileFingerprint??null)||existing.request.objective!==request.objective||!isDeepStrictEqual(existing.request.context,request.context))throw new PmPersistenceError(`PM run identity conflict: ${run.id}`,{code:'PM_RUN_ID_CONFLICT'});return existing;}

  commitDecision(pmRunId, turn) {
    const decision = serializeDurable(turn.decision, 'PM decision');
    return this.store.transactionSync(({ get, run }) => {
      const pmRun = get('SELECT status, turn_count FROM pm_runs WHERE id = ?', [pmRunId]);
      if (!pmRun) throw new PmPersistenceError(`unknown PM run: ${pmRunId}`, { code: 'UNKNOWN_PM_RUN' });
      if (pmRun.status !== 'running') throw new PmPersistenceError(`PM run is terminal: ${pmRunId}`, { code: 'PM_RUN_TERMINAL' });
      if (turn.turnIndex !== pmRun.turn_count) corrupt(`non-contiguous PM turn for ${pmRunId}`);
      run('INSERT INTO pm_turns (id, pm_run_id, turn_index, decision, outcome, committed, created_at, phase, action_type, action_id, completed_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL)', [turn.id, pmRunId, turn.turnIndex, decision, turn.createdAt, PM_TURN_PHASES.DECISION_COMMITTED, turn.actionType, turn.actionId]);
      run('UPDATE pm_runs SET turn_count = turn_count + 1, state_revision = state_revision + 1 WHERE id = ?', [pmRunId]);
    });
  }

  markActionStarted(pmRunId, turnIndex) {
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT phase, action_id FROM pm_turns WHERE pm_run_id = ? AND turn_index = ?', [pmRunId, turnIndex]);
      if (!row) throw new PmPersistenceError('unknown PM turn', { code: 'UNKNOWN_PM_TURN' });
      if (row.phase !== PM_TURN_PHASES.DECISION_COMMITTED || !row.action_id) corrupt('invalid PM action-start transition');
      run('UPDATE pm_turns SET phase = ?, state_revision = state_revision + 1 WHERE pm_run_id = ? AND turn_index = ?', [PM_TURN_PHASES.ACTION_STARTED, pmRunId, turnIndex]);
    });
  }

  completeTurn(pmRunId, turnIndex, outcome, runPatch = null) {
    const outcomeJson = serializeDurable(outcome, 'PM outcome');
    this.store.transactionSync(({ get, run }) => {
      const turn = get('SELECT phase, outcome, decision FROM pm_turns WHERE pm_run_id = ? AND turn_index = ?', [pmRunId, turnIndex]);
      if (!turn) throw new PmPersistenceError('unknown PM turn', { code: 'UNKNOWN_PM_TURN' });
      if (turn.phase === PM_TURN_PHASES.TURN_COMPLETE) return;
      const decision = parse(turn.decision, 'PM decision');
      const requiredPhase = decision?.type === 'finish' ? PM_TURN_PHASES.DECISION_COMMITTED : PM_TURN_PHASES.ACTION_STARTED;
      if (turn.phase !== requiredPhase) {
        corrupt(`illegal PM turn completion transition: ${turn.phase} -> ${PM_TURN_PHASES.TURN_COMPLETE}`, {
          pmRunId, turnIndex, decisionType: decision?.type,
        });
      }
      run('UPDATE pm_turns SET outcome = ?, phase = ?, completed_at = ?, state_revision = state_revision + 1 WHERE pm_run_id = ? AND turn_index = ?', [outcomeJson, PM_TURN_PHASES.TURN_COMPLETE, runPatch?.completedAt ?? new Date().toISOString(), pmRunId, turnIndex]);
      if (runPatch) {
        run('UPDATE pm_runs SET status = ?, output = ?, data = ?, error = ?, completed_at = ?, state_revision = state_revision + 1 WHERE id = ?', [runPatch.status, runPatch.output ?? '', runPatch.data === null || runPatch.data === undefined ? null : serializeDurable(runPatch.data, 'PM run data'), runPatch.error === null || runPatch.error === undefined ? null : serializeDurable(runPatch.error, 'PM run error'), runPatch.completedAt, pmRunId]);
      }
    });
  }

  completeRun(pmRunId, patch) {
    this.store.run('UPDATE pm_runs SET status = ?, output = ?, data = ?, error = ?, completed_at = ?, state_revision = state_revision + 1 WHERE id = ?', [patch.status, patch.output ?? '', patch.data === null || patch.data === undefined ? null : serializeDurable(patch.data, 'PM run data'), patch.error === null || patch.error === undefined ? null : serializeDurable(patch.error, 'PM run error'), patch.completedAt, pmRunId]);
  }

  // P12-R2 — durably records the six-dimension outcome model
  // (src/pm/task-outcome-model.mjs) onto the ALREADY-EXISTING `pm_runs.data`
  // JSON column, under the single reserved key `dsh_outcome`. No schema
  // migration: `data` already stores arbitrary driver-authored JSON; this
  // merges one additional, clearly-namespaced, DSH-computed key into it —
  // every existing backend-authored field (`type`, `chair_profile_id`,
  // `degraded`, ...) is preserved untouched, and no backend has ever used
  // (or has any reason to use) the key `dsh_outcome`. `status`/`output`/
  // `error`/`completed_at` are left exactly as they already were — this is
  // the ONLY field this method ever changes, and only ever called AFTER a
  // run already reached a terminal status (production-pm-worker.mjs), so
  // it can never race a still-`running` run's own turn-completion writes.
  recordTaskOutcome(pmRunId, outcome) {
    return this.store.transactionSync(({ get, run }) => {
      const row = get('SELECT data FROM pm_runs WHERE id = ?', [pmRunId]);
      if (!row) throw new PmPersistenceError(`unknown PM run: ${pmRunId}`, { code: 'UNKNOWN_PM_RUN' });
      const existing = row.data === null || row.data === undefined ? null : parse(row.data, 'PM run data');
      const merged = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), dsh_outcome: outcome };
      run('UPDATE pm_runs SET data = ?, state_revision = state_revision + 1 WHERE id = ?', [serializeDurable(merged, 'PM run data'), pmRunId]);
    });
  }

  load(pmRunId) {
    const row = this.store.get('SELECT r.*, q.envelope AS request_envelope FROM pm_runs r JOIN pm_requests q ON q.id = r.request_id WHERE r.id = ?', [pmRunId]);
    if (!row) throw new PmPersistenceError(`unknown PM run: ${pmRunId}`, { code: 'UNKNOWN_PM_RUN' });
    const turns = this.store.all('SELECT * FROM pm_turns WHERE pm_run_id = ? ORDER BY turn_index', [pmRunId]).map(rowToTurn);
    if (row.turn_count !== turns.length) corrupt(`PM turn count mismatch for ${pmRunId}`);
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turn.turnIndex !== index) corrupt(`non-contiguous PM history for ${pmRunId}`);
      if (turn.committed !== 1) corrupt(`uncommitted PM turn is not executable for ${pmRunId}`);
      const type = turn.decision?.type;
      if (!['workflow', 'peer_exchange', 'finish', 'await_owner'].includes(type)) corrupt(`invalid PM decision for ${pmRunId}`);
      const expectedAction = type === 'finish' ? null : type;
      if (turn.actionType !== expectedAction || (expectedAction === null ? turn.actionId !== null : typeof turn.actionId !== 'string' || turn.actionId === '')) corrupt(`PM action reference mismatch for ${pmRunId}`);
      if (type === 'workflow' && turn.actionId !== turn.decision?.spec?.id) corrupt(`workflow action linkage mismatch for ${pmRunId}`);
      if (type === 'peer_exchange' && turn.actionId !== turn.decision?.conversationId) corrupt(`peer action linkage mismatch for ${pmRunId}`);
      if (type === 'await_owner' && turn.actionId !== turn.decision?.interactionId) corrupt(`owner interaction linkage mismatch for ${pmRunId}`);
      if (!Object.values(PM_TURN_PHASES).includes(turn.phase)) corrupt(`invalid PM phase for ${pmRunId}`);
      if (turn.phase === PM_TURN_PHASES.TURN_COMPLETE && turn.outcome === null) corrupt(`completed PM turn lacks outcome for ${pmRunId}`);
      if (turn.phase !== PM_TURN_PHASES.TURN_COMPLETE && turn.outcome !== null) corrupt(`PM outcome precedes completion for ${pmRunId}`);
      if (type === 'finish' && turn.phase === PM_TURN_PHASES.ACTION_STARTED) corrupt(`FINISH cannot start an action for ${pmRunId}`);
      if (index < turns.length - 1 && turn.phase !== PM_TURN_PHASES.TURN_COMPLETE) corrupt(`incomplete PM turn precedes later history for ${pmRunId}`);
    }
    if (TERMINAL_RUN.has(row.status) && turns.some((turn) => turn.phase !== PM_TURN_PHASES.TURN_COMPLETE)) corrupt(`terminal PM run has incomplete turn for ${pmRunId}`);
    return Object.freeze({
      id: row.id,
      request: parse(row.request_envelope, 'PM request'),
      driver: row.driver,
      status: row.status,
      output: row.output ?? '',
      data: row.data === null ? null : parse(row.data, 'PM run data'),
      error: row.error === null ? null : parse(row.error, 'PM run error'),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      turnCount: row.turn_count,
      pmProfileId: row.pm_profile_id,
      pmProfileFingerprint: row.pm_profile_fingerprint,
      turns: Object.freeze(turns),
    });
  }
}

export function isTerminalPmActionStatus(status) { return TERMINAL_ACTION.has(status); }
