import { BASELINE_CALLS, MAX_ALLOWED_RETRY_RESERVE, ACCEPTANCE_CALL_BUDGET } from './acceptance-call-budget.mjs';
// Research-only evidence. Runtime model values never cross a filesystem boundary.
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { deterministicOwnerId } from '../../../src/owner/owner-contracts.mjs';
import { PmRepository } from '../../../src/persistence/repositories/pm-repository.mjs';

const now = () => new Date().toISOString();
export const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pickEnum = (v, values, fallback = 'UNKNOWN') => values.includes(v) ? v : fallback;
export const errorCode = v => typeof v === 'string' && /^(PM_|API_|COUNCIL_|ANTIGRAVITY_|CANARY_)[A-Z0-9_]{1,100}$/.test(v) ? v : null;

export function atomicJson(path, value, beforeRename = () => {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    beforeRename(); renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function assertExecutionMode(mode, runners) {
  if (!['LIVE', 'SYNTHETIC'].includes(mode)) throw new Error('EXECUTION_MODE_REQUIRED');
  if (mode === 'SYNTHETIC' && (typeof runners?.api !== 'function' || typeof runners?.antigravity !== 'function')) throw new Error('SYNTHETIC_STUBS_REQUIRED');
  if (mode === 'LIVE' && Object.keys(runners ?? {}).length) throw new Error('LIVE_RUNNER_OVERRIDE_REFUSED');
}

export class AcceptanceEvidence {
  constructor({ root, mode, fixture, profiles, repositoryHead, branch, expectedCalls = BASELINE_CALLS }) {
    if (!['LIVE', 'SYNTHETIC'].includes(mode)) throw new Error('EXECUTION_MODE_REQUIRED');
    const execution = `acc-${mode.toLowerCase()}-${randomUUID()}`;
    const run = `pmrun-${randomUUID()}`;
    this.directory = resolve(root, 'research', 'live-acceptance-runs', execution);
    mkdirSync(resolve(root, 'research', 'live-acceptance-runs'), { recursive: true });
    mkdirSync(this.directory); // Never adopt an existing execution directory.
    this.path = join(this.directory, 'acceptance-manifest.json');
    this.ledgerPath = join(this.directory, 'provider-invocations.json');
    this.records = [];
    this.completed = false;
    this.claimed = false;
    this.manifest = {
      manifest_version: 1, execution_mode: mode, acceptance_execution_id: execution,
      council_run_id: run, action_id: deterministicOwnerId('wf', run, '0'), created_at: now(),
      repository_head: repositoryHead, branch, worktree_path: resolve(root),
      database_path: join(this.directory, 'council-evidence.sqlite'),
      database_content_policy: 'METADATA_ONLY_VOLATILE_MODEL_VALUES_NOT_RESTARTABLE',
      database_created_at: null, database_size_bytes: null, database_sha256_initial: null, database_sha256_final: null,
      workspace_fixture_path: fixture.relative_path, workspace_fixture_sha256: fixture.sha256,
      chair_profile: profiles.chair, antigravity_profile: profiles.antigravity, control_profile: profiles.control,
      debate_rounds: 1, expected_provider_invocations: expectedCalls, call_budget: ACCEPTANCE_CALL_BUDGET, baseline_calls: BASELINE_CALLS, max_allowed_retry_reserve: MAX_ALLOWED_RETRY_RESERVE,
      status: 'PREPARED', started_at: null, ended_at: null, actual_provider_invocations: 0,
      council_terminal_state: null, durable_outcome_present: false, chair_plan_state: 'NOT_REACHED',
      antigravity_reached: false, control_reached: false, strict_full_pass: false, recovered_full_pass: false,
      primary_failure_owner: null, failure_step: null, failure_profile: null, failure_public_error_code: null,
      manifest_completed_at: null, abort_reason: null, durable_manifest_disagreement: false,
      incomplete_run_policy: 'NONTERMINAL_MEANS_INCOMPLETE_NEVER_SUCCESS_REQUIRES_OFFLINE_FINALIZATION',
      provider_invocation_definition: 'BACKEND_RUNNER_ENTRY_NOT_BILLING_RECEIPT',
      lifecycle: [{ status: 'PREPARED', at: now() }],
    };
    atomicJson(this.ledgerPath, this.records);
    this.save();
  }
  save() { atomicJson(this.path, this.manifest); }
  claim() { if (this.claimed || this.manifest.status !== 'PREPARED') throw new Error('EXECUTION_ALREADY_CLAIMED'); this.claimed = true; }
  databaseReady() {
    const s = statSync(this.manifest.database_path);
    Object.assign(this.manifest, { database_created_at: s.birthtime.toISOString(), database_size_bytes: s.size });
    // Initial hash is deliberately null: WAL writes can be pending before close.
    this.save();
  }
  running() {
    if (this.manifest.status !== 'PREPARED') throw new Error('INVALID_RUNNING_TRANSITION');
    this.manifest.status = 'RUNNING'; this.manifest.started_at = now();
    this.manifest.lifecycle.push({ status: 'RUNNING', at: now() }); this.save();
  }
  reserve(entry) {
    if (this.ioFailure) throw Object.assign(new Error('evidence persistence unavailable'), {code:'CANARY_EVIDENCE_IO_FAILED'});
    if (this.records.length >= ACCEPTANCE_CALL_BUDGET) {
      this.budgetExceeded = true;
      this.manifest.abort_reason = 'CALL_BUDGET_EXCEEDED'; this.save();
      throw Object.assign(new Error('call budget exhausted'), { code: 'CANARY_LIVE_CALL_BUDGET_EXHAUSTED' });
    }
    if (this.manifest.status !== 'RUNNING') throw new Error('EXECUTION_NOT_RUNNING');
    const record = {
      invocation_ordinal: this.records.length + 1,
      acceptance_execution_id: this.manifest.acceptance_execution_id, council_run_id: this.manifest.council_run_id,
      action_id: entry.action_id, backend_attempt_id: `attempt-${randomUUID()}`,
      backend_request_id: typeof entry.backend_request_id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(entry.backend_request_id) ? entry.backend_request_id : null,
      provider_request_id: null,
      observer_identity_matches: entry.observer_identity_matches === true,
      invocation_role:entry.invocation_role??'pm',source_profile:entry.source_profile??null,
      profile_id: entry.profile_id, product: entry.product, step_kind: entry.step_kind,
      attempt_ordinal: entry.attempt_ordinal, retry_kind: entry.retry_kind,
      structured_output_requested: entry.native_schema_requested === true,
      start_time: now(), end_time: null, execution_state: 'RUNNING', terminal_state: 'RUNNING',
      public_error_code: null, parser_attempted: false, parser_state: 'NOT_ATTEMPTED',
      parse_subreason: null, diagnostic_version: 1, assistant_output_present: null,
    };
    // Failed reservation writes cannot create an in-memory counted invocation.
    atomicJson(this.ledgerPath, [...this.records, record]);
    this.records.push(record);
    return record;
  }
  persistLedger() {
    try { atomicJson(this.ledgerPath, this.records); }
    catch(error) { this.ioFailure = true; throw error; }
  }
  receipt(record, payload) {
    if (!record) return;
    const id = payload?.requestId;
    record.provider_request_id = typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : null;
    this.persistLedger();
  }
  transport(record, ok) {
    record.end_time = now(); record.execution_state = ok ? 'SUCCESS' : 'ERROR';
    record.terminal_state = record.execution_state; this.persistLedger();
  }
  diagnostic(record, d) {
    if (!record) return;
    Object.assign(record, {
      diagnostic_version: 1,
      execution_state: pickEnum(d?.execution_state, ['SUCCESS', 'ERROR', 'RUNNING', 'NOT_ATTEMPTED']),
      terminal_state: pickEnum(d?.terminal_state, ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']),
      parser_attempted: d?.parser_attempted === true,
      parser_state: pickEnum(d?.parser_state, ['PASS', 'FAIL', 'NOT_ATTEMPTED']),
      public_error_code: errorCode(d?.parse_error_code), parse_subreason: errorCode(d?.parse_subreason),
      assistant_output_present: typeof d?.assistant_output_present === 'boolean' ? d.assistant_output_present : null,
    });
    this.persistLedger();
  }
  finish(result, durable) {
    if (this.completed) throw new Error('EXECUTION_ALREADY_FINALIZED');
    const terminal = ['completed', 'failed', 'cancelled'].includes(durable?.status);
    const outcomePresent = terminal && durable.turns?.some(t => t.outcome !== null && t.outcome !== undefined) === true;
    const mismatch = result.durable_result_status !== durable?.status;
    Object.assign(this.manifest, {
      status: !outcomePresent || mismatch || this.budgetExceeded || this.ioFailure ? 'ABORTED' : durable.status === 'completed' ? 'SUCCESS' : durable.status === 'cancelled' ? 'ABORTED' : 'FAILED',
      abort_reason: this.ioFailure ? 'HARNESS_ERROR' : this.budgetExceeded ? 'CALL_BUDGET_EXCEEDED' : !outcomePresent || mismatch ? 'TERMINALIZATION_INCOMPLETE' : durable.status === 'cancelled' ? 'PROCESS_ERROR' : null,
      ended_at: now(), actual_provider_invocations: this.records.length,
      council_terminal_state: terminal ? durable.status : null,
      durable_outcome_present: outcomePresent,
      durable_manifest_disagreement: mismatch,
      chair_plan_state: pickEnum(result.chair_plan?.state, ['PASS', 'FAIL', 'NOT_REACHED']),
      antigravity_reached: this.records.some(r => r.profile_id === this.manifest.antigravity_profile),
      control_reached: this.records.some(r => r.profile_id === this.manifest.control_profile),
      strict_full_pass: outcomePresent && !mismatch && !this.budgetExceeded && !this.ioFailure && durable?.status === 'completed' && result.strict_full_pass === true,
      recovered_full_pass: outcomePresent && !mismatch && !this.budgetExceeded && !this.ioFailure && durable?.status === 'completed' && result.recovered_full_pass === true,
      primary_failure_owner: pickEnum(result.primary_failure_owner, ['NONE', 'CHAIR', 'ANTIGRAVITY_PARTICIPANT', 'CONTROL_PARTICIPANT', 'COUNCIL_ORCHESTRATION']),
      failure_step: this.records.find(r => r.step_kind === result.failure_step)?.step_kind ?? null,
      failure_profile: this.records.find(r => r.profile_id === result.failure_profile)?.profile_id ?? null,
      failure_public_error_code: errorCode(result.failure_public_error_code),
    });
    this.finalStamp();
  }
  finalStamp() {
    if (existsSync(this.manifest.database_path)) {
      this.manifest.database_sha256_final = hashFile(this.manifest.database_path);
      this.manifest.database_size_bytes = statSync(this.manifest.database_path).size;
    }
    this.manifest.manifest_completed_at = now();
    this.manifest.lifecycle.push({ status: this.manifest.status, at: now() });
    this.save(); this.completed = true;
  }
  abort(reason = 'HARNESS_ERROR') {
    if (this.completed) return;
    Object.assign(this.manifest, { status: 'ABORTED', abort_reason: pickEnum(reason, ['PROCESS_ERROR', 'HARNESS_ERROR', 'CALL_BUDGET_EXCEEDED', 'TERMINALIZATION_INCOMPLETE']), ended_at: now(), actual_provider_invocations: this.records.length });
    // Do not advertise a final DB hash while a process may still have a WAL open.
    this.manifest.manifest_completed_at = now();
    this.manifest.lifecycle.push({ status: 'ABORTED', at: now() }); this.save(); this.completed = true;
  }
  installFinalizers() {
    const exit = () => { if (!this.completed) this.abort('TERMINALIZATION_INCOMPLETE'); };
    const failure = () => { try { this.abort('PROCESS_ERROR'); } catch {} };
    const interrupt = () => { failure(); process.exit(130); };
    const terminate = () => { failure(); process.exit(143); };
    process.on('exit', exit); process.on('uncaughtExceptionMonitor', failure);
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    return () => { process.off('exit', exit); process.off('uncaughtExceptionMonitor', failure); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
  }
}

// Explicit offline operation after an operator established the process is gone.
// Never resumes Council or edits SQLite. SIGKILL/power loss cannot run JS finalizers.
export function finalizeAbandonedManifest(path) {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (m.manifest_version !== 1 || !['PREPARED', 'RUNNING'].includes(m.status)) throw new Error('NOT_INCOMPLETE_MANIFEST');
  m.status = 'ABORTED'; m.abort_reason = 'TERMINALIZATION_INCOMPLETE';
  m.ended_at = now(); m.manifest_completed_at = now();
  m.lifecycle.push({ status: 'ABORTED', at: now() });
  atomicJson(path, m);
}

// Same production SQL transactions / state authority; full model-bearing values
// are volatile overlays for this single process. Retained DB is NOT resumable.
export class ContentFreePmRepository extends PmRepository {
  constructor(options) { super(options); this.volatile = new Map(); }
  create(request, run) {
    this.volatile.set(run.id, { request, decisions: new Map(), outcomes: new Map(), patch: null });
    return super.create({ ...request, objective: '', context: { acceptance_execution_id: request.context.acceptance_execution_id, execution_mode: request.context.execution_mode } }, run);
  }
  commitDecision(id, turn) {
    const d = turn.decision;
    if (!['workflow','finish'].includes(d.type)) throw new Error('HARNESS_DECISION_KIND_REFUSED');
    const decision = d.type === 'workflow' ? { type: d.type, spec: { id: d.spec.id, kind: d.spec.kind, stepKind: d.spec.stepKind, profileId: d.spec.profileId } } : { type: 'finish', output: '', data: null };
    super.commitDecision(id, { ...turn, decision }); this.volatile.get(id).decisions.set(turn.turnIndex, d);
  }
  completeTurn(id, index, outcome, patch) {
    if (super.load(id).turns[index]?.phase === 'TURN_COMPLETE') return;
    const safe = { kind: outcome.kind ?? null, status: outcome.status, workflowId: outcome.workflowId ?? null, finalResult: outcome.finalResult ? { id: outcome.finalResult.id, status: outcome.finalResult.status } : null, error: null };
    super.completeTurn(id, index, safe, this.safePatch(patch));
    this.volatile.get(id).outcomes.set(index, outcome); if (patch) this.volatile.get(id).patch = patch;
  }
  safePatch(p) { return p ? { status: p.status, completedAt: p.completedAt, output: '', data: null, error: p.error ? { name: 'AcceptanceRuntimeError', code: errorCode(p.error.code) } : null } : null; }
  completeRun(id, patch) { super.completeRun(id, this.safePatch(patch)); this.volatile.get(id).patch = patch; }
  load(id) {
    const run = super.load(id), v = this.volatile.get(id);
    if (!v) return run;
    return { ...run, request: v.request, output: v.patch?.output ?? run.output, data: v.patch?.data ?? run.data, error: v.patch?.error ?? run.error,
      turns: run.turns.map(t => ({ ...t, decision: v.decisions.get(t.turnIndex) ?? t.decision, outcome: v.outcomes.get(t.turnIndex) ?? t.outcome })) };
  }
}
