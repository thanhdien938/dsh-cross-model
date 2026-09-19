/**
 * Persistence layer — SQLite reference store migrations.
 *
 * Owns database schema migration truth only. This module intentionally does
 * NOT mix schema version, record/envelope version, architecture invariant
 * version, or provider capability version. The migration list is the runtime
 * definition the store applies and the checksum source for fail-closed
 * verification.
 */

import { createHash } from 'node:crypto';

/** Runtime-supported database schema version. */
export const SCHEMA_VERSION = 11;

/** Deterministic checksum for a migration definition (sha256 of normalized SQL). */
export function migrationChecksum(sql) {
  return createHash('sha256').update(sql.trim()).digest('hex');
}

/**
 * Bootstrap table created by the store before any numbered migration. Not a
 * user migration; it exists so `readSchemaVersion()` can answer 0 on an empty
 * database.
 */
export const MIGRATION_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
`;

const SCHEMA_V1_SQL = `
CREATE TABLE orchestrator_instances (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  sender TEXT,
  recipient TEXT,
  status TEXT,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  agent TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_task_id ON runs(task_id);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  agent TEXT,
  status TEXT NOT NULL,
  output TEXT,
  handoff TEXT,
  artifacts TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  from_identity TEXT NOT NULL,
  to_identity TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  hop_id TEXT,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_task_id ON messages(task_id);

CREATE TABLE bus_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  run_id TEXT,
  agent TEXT,
  event TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_bus_events_task_id ON bus_events(task_id);

CREATE TABLE dispatch_attempts (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  backend TEXT,
  phase TEXT NOT NULL,
  classification TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dispatch_attempts_task_id ON dispatch_attempts(task_id);

CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  backend TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  product TEXT,
  version TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lineage TEXT
);
CREATE UNIQUE INDEX idx_native_sessions_backend_session ON native_sessions(backend, native_session_id);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  step_index INTEGER NOT NULL,
  recipient TEXT,
  status TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  result_id TEXT,
  context_from_previous TEXT,
  dispatched_context TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, step_index)
);
CREATE INDEX idx_workflow_steps_workflow ON workflow_steps(workflow_id);

CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT,
  step_id TEXT,
  task_id TEXT,
  run_id TEXT,
  agent TEXT,
  event TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_workflow_events_workflow ON workflow_events(workflow_id);

CREATE TABLE peer_conversations (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE peer_hops (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT NOT NULL REFERENCES peer_conversations(id) ON DELETE RESTRICT,
  hop_index INTEGER NOT NULL,
  from_identity TEXT NOT NULL,
  to_identity TEXT NOT NULL,
  status TEXT NOT NULL,
  request_message_id TEXT,
  response_message_id TEXT,
  recipient_task_id TEXT,
  recipient_run_id TEXT,
  recipient_result_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_peer_hops_conversation ON peer_hops(conversation_id);

CREATE TABLE peer_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES peer_conversations(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, message_id)
);
CREATE INDEX idx_peer_messages_conversation ON peer_conversation_messages(conversation_id);

CREATE TABLE peer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  hop_id TEXT,
  message_id TEXT,
  task_id TEXT,
  run_id TEXT,
  agent TEXT,
  event TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_peer_events_conversation ON peer_events(conversation_id);

CREATE TABLE pm_requests (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  objective TEXT NOT NULL,
  context TEXT,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pm_runs (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  request_id TEXT NOT NULL REFERENCES pm_requests(id) ON DELETE RESTRICT,
  driver TEXT,
  status TEXT NOT NULL,
  output TEXT,
  data TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pm_runs_request ON pm_runs(request_id);

CREATE TABLE pm_turns (
  id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  pm_run_id TEXT NOT NULL REFERENCES pm_runs(id) ON DELETE RESTRICT,
  turn_index INTEGER NOT NULL,
  decision TEXT NOT NULL,
  outcome TEXT,
  committed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (pm_run_id, turn_index)
);
CREATE INDEX idx_pm_turns_run ON pm_turns(pm_run_id);

CREATE TABLE backend_health (
  backend TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  classification TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  cooldown_until TEXT,
  diagnostic TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_traces (
  trace_id TEXT PRIMARY KEY,
  sealed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_entries (
  trace_id TEXT NOT NULL REFERENCES audit_traces(trace_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (trace_id, sequence)
);
CREATE INDEX idx_audit_entries_trace ON audit_entries(trace_id);
`;

/**
 * All 22 logical v1 tables (schema_migrations is bootstrapped by the store;
 * the numbered migration creates the remaining 21 domain tables).
 */
export const SCHEMA_V1_TABLES = Object.freeze([
  'audit_entries',
  'audit_traces',
  'backend_health',
  'bus_events',
  'dispatch_attempts',
  'messages',
  'native_sessions',
  'orchestrator_instances',
  'peer_conversation_messages',
  'peer_conversations',
  'peer_events',
  'peer_hops',
  'pm_requests',
  'pm_runs',
  'pm_turns',
  'results',
  'runs',
  'schema_migrations',
  'tasks',
  'workflow_events',
  'workflow_steps',
  'workflows',
]);

const MIGRATION_V1 = Object.freeze({
  version: 1,
  name: 'phase2-gate1-schema-v1',
  checksum: migrationChecksum(SCHEMA_V1_SQL),
  up(db) {
    db.exec(SCHEMA_V1_SQL);
  },
});

/**
 * Schema v2 — Gate 4 durable workflow + peer state field completeness.
 *
 * Additive only. The v1 workflow_steps table carries the durable lineage
 * columns but not the full step record (body/context/expectedOutput), and the
 * v1 peer_hops table carries recipient lineage but not the source lineage that
 * PeerHopRecord owns. Both field groups are required for faithful reopen
 * reconstruction, so v2 adds them as nullable columns; v1 inserts written by
 * Gate-1 fixtures remain valid (new columns default to NULL).
 */
const SCHEMA_V2_SQL = `
ALTER TABLE workflow_steps ADD COLUMN body TEXT;
ALTER TABLE workflow_steps ADD COLUMN context TEXT;
ALTER TABLE workflow_steps ADD COLUMN expected_output TEXT;

ALTER TABLE peer_hops ADD COLUMN source_task_id TEXT;
ALTER TABLE peer_hops ADD COLUMN source_run_id TEXT;
ALTER TABLE peer_hops ADD COLUMN source_result_id TEXT;
`;

const MIGRATION_V2 = Object.freeze({
  version: 2,
  name: 'phase2-gate4-workflow-peer-durability',
  checksum: migrationChecksum(SCHEMA_V2_SQL),
  up(db) {
    db.exec(SCHEMA_V2_SQL);
  },
});

/**
 * Schema v3 — peer hop index uniqueness.
 *
 * A conversation's hops are ordered by `hop_index` and reconstructed in that
 * order; the durable state must reject a second hop at the same index exactly
 * like the in-memory PeerHopMap would. v2 shipped the tables without this
 * unique index, so prepareHopAtomic's DUPLICATE_HOP_INDEX mapping could never
 * fire. v3 adds the index additively.
 */
const SCHEMA_V3_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_peer_hops_conversation_index
  ON peer_hops(conversation_id, hop_index);
`;

const MIGRATION_V3 = Object.freeze({
  version: 3,
  name: 'phase2-gate4-peer-hop-index-unique',
  checksum: migrationChecksum(SCHEMA_V3_SQL),
  up(db) {
    db.exec(SCHEMA_V3_SQL);
  },
});

const SCHEMA_V4_SQL = `
ALTER TABLE pm_runs ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pm_turns ADD COLUMN phase TEXT NOT NULL DEFAULT 'DECISION_COMMITTED';
ALTER TABLE pm_turns ADD COLUMN action_type TEXT;
ALTER TABLE pm_turns ADD COLUMN action_id TEXT;
ALTER TABLE pm_turns ADD COLUMN completed_at TEXT;
`;

const MIGRATION_V4 = Object.freeze({
  version: 4,
  name: 'phase2-gate7-durable-pm-turns',
  checksum: migrationChecksum(SCHEMA_V4_SQL),
  up(db) {
    db.exec(SCHEMA_V4_SQL);
  },
});

const SCHEMA_V5_SQL = `
ALTER TABLE native_sessions ADD COLUMN native_reference TEXT;
ALTER TABLE native_sessions ADD COLUMN task_id TEXT;
ALTER TABLE native_sessions ADD COLUMN run_id TEXT;
ALTER TABLE native_sessions ADD COLUMN dispatch_attempt_id TEXT;
ALTER TABLE native_sessions ADD COLUMN transport TEXT;
ALTER TABLE native_sessions ADD COLUMN capability_fingerprint TEXT;
ALTER TABLE native_sessions ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE native_sessions ADD COLUMN reconciliation_result TEXT;
ALTER TABLE native_sessions ADD COLUMN diagnostic TEXT;
ALTER TABLE native_sessions ADD COLUMN reconciled_at TEXT;
ALTER TABLE native_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_native_sessions_dispatch_attempt
  ON native_sessions(dispatch_attempt_id) WHERE dispatch_attempt_id IS NOT NULL;
`;

const MIGRATION_V5 = Object.freeze({
  version: 5,
  name: 'phase2-gate8-native-session-reconciliation',
  checksum: migrationChecksum(SCHEMA_V5_SQL),
  up(db) { db.exec(SCHEMA_V5_SQL); },
});

const SCHEMA_V6_SQL = `
ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE tasks ADD COLUMN pm_profile_id TEXT;
ALTER TABLE tasks ADD COLUMN effective_autonomy TEXT;
ALTER TABLE tasks ADD COLUMN envelope_revision INTEGER;
ALTER TABLE tasks ADD COLUMN project_config_fingerprint TEXT;
ALTER TABLE pm_runs ADD COLUMN pm_profile_id TEXT;
ALTER TABLE pm_runs ADD COLUMN pm_profile_fingerprint TEXT;
`;

const MIGRATION_V6 = Object.freeze({
  version: 6,
  name: 'phase5-owner-control-pm-pinning',
  checksum: migrationChecksum(SCHEMA_V6_SQL),
  up(db) { db.exec(SCHEMA_V6_SQL); },
});

const SCHEMA_V7_SQL = `
ALTER TABLE pm_runs ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pm_turns ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pm_turns ADD COLUMN reconciliation_state TEXT;
ALTER TABLE pm_turns ADD COLUMN reconciliation_reason TEXT;
ALTER TABLE workflows ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflows ADD COLUMN reconciliation_state TEXT;
ALTER TABLE workflows ADD COLUMN reconciliation_reason TEXT;
ALTER TABLE workflow_steps ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_steps ADD COLUMN reconciliation_state TEXT;
ALTER TABLE workflow_steps ADD COLUMN reconciliation_reason TEXT;
ALTER TABLE runs ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN reconciliation_state TEXT;
ALTER TABLE runs ADD COLUMN reconciliation_reason TEXT;

CREATE TABLE reconciliation_audit (
  reconciliation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT,
  affected_lineage TEXT NOT NULL,
  classification TEXT NOT NULL,
  before_states TEXT NOT NULL,
  before_revisions TEXT NOT NULL,
  after_states TEXT NOT NULL,
  after_revisions TEXT NOT NULL,
  evidence_timestamps TEXT NOT NULL,
  leader_generation INTEGER NOT NULL,
  worker_incarnation TEXT,
  repair_reason TEXT NOT NULL,
  repair_result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reconciliation_audit_task ON reconciliation_audit(task_id, created_at);
`;

const MIGRATION_V7 = Object.freeze({
  version: 7,
  name: 'stuck-task-reconciliation',
  checksum: migrationChecksum(SCHEMA_V7_SQL),
  up(db) { db.exec(SCHEMA_V7_SQL); },
});

/**
 * Schema v8 — P24.1G7A single-final-settlement journal.
 *
 * One durable, task-keyed record per `tasks.id` tracking the Git settlement
 * state machine (UNSETTLED -> PREPARING -> COMMIT_CREATED -> PUSHING ->
 * REMOTE_VERIFIED -> SETTLED, or BLOCKED) independent of `pm_run_id` (a task
 * may span several PM runs/turns; settlement is owned by the task, never a
 * run) — see src/pm/git-settlement-journal.mjs. `git_settlement_revision`
 * follows the exact same CAS pattern `envelope_revision` already uses for
 * autonomy updates (schema v6): additive, nullable-safe, no v1-v7 row is
 * affected (`git_settlement` defaults NULL = UNSETTLED, revision defaults 0).
 */
const SCHEMA_V8_SQL = `
ALTER TABLE tasks ADD COLUMN git_settlement TEXT;
ALTER TABLE tasks ADD COLUMN git_settlement_revision INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_V8 = Object.freeze({
  version: 8,
  name: 'p24-1g7a-single-settlement-journal',
  checksum: migrationChecksum(SCHEMA_V8_SQL),
  up(db) { db.exec(SCHEMA_V8_SQL); },
});

/**
 * Schema v9 — P24.1G6A dynamic per-task fresh base pinning: durable
 * admission journal.
 *
 * A NEW, small, additive table (not a column on `tasks`, unlike schema
 * v8's settlement journal) because admission happens BEFORE a task row
 * exists at all — `OwnerTaskController.submit()` resolves/pins the task's
 * Git base and creates its `dsh/task-<id>` branch strictly before
 * `createOwnerTask()` ever runs (never a half-created task on failure).
 * `task_id` is deterministic from the owner command id
 * (`deterministicOwnerId('task', command_id)`), so it is knowable and
 * usable as a durable key before the task row exists. See
 * src/pm/task-base-admission.mjs for the state machine (UNPREPARED ->
 * BASE_OBSERVED -> BRANCH_BOUND -> ADMITTED) this table backs.
 */
const SCHEMA_V9_SQL = `
CREATE TABLE git_admission_journal (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  repo_path TEXT,
  workspace_id TEXT,
  effective_remote TEXT,
  base_branch TEXT,
  base_policy TEXT,
  project_expected_sha TEXT,
  caller_expected_sha TEXT,
  observed_base_sha TEXT,
  task_branch TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const MIGRATION_V9 = Object.freeze({
  version: 9,
  name: 'p24-1g6a-dynamic-base-admission-journal',
  checksum: migrationChecksum(SCHEMA_V9_SQL),
  up(db) { db.exec(SCHEMA_V9_SQL); },
});

/**
 * Schema v10 — P24.3A task-workspace-isolation foundation: durable
 * allocation record for a future, per-task LINKED GIT WORKTREE (audit
 * `reports/P24_3_PER_TASK_WORKTREE_ISOLATION_ARCHITECTURE_AUDIT_20260917.md`).
 *
 * A NEW, small, additive table — deliberately NOT a column on `tasks`, for
 * the exact same reason schema v9's `git_admission_journal` is not: this
 * record must be creatable and CAS-writable strictly BEFORE any Git
 * worktree/branch side effect, and possibly before an owner-task row exists
 * at all (`task_id` is deterministic and knowable in advance, same as
 * `git_admission_journal.task_id`). This table is inert until a caller
 * explicitly opts a task into isolation (`isolation_version = 1`) — no
 * legacy admission/settlement row is read, written or reinterpreted by
 * this migration or by `src/pm/task-workspace-manager.mjs`. Absence of a
 * row for a given `task_id` means exactly what it always meant: a legacy
 * shared-worktree task, never "missing v1 data to be inferred."
 *
 * `workspace_path` carries a UNIQUE constraint as defense-in-depth against
 * an alias collision (`task_id` already prevents two ACTIVE bindings for
 * the SAME task via CAS-guarded upsert; this additionally prevents two
 * DIFFERENT tasks from ever durably claiming the same derived path, which
 * would otherwise only be prevented by the deterministic path-derivation
 * function agreeing with itself).
 */
const SCHEMA_V10_SQL = `
CREATE TABLE task_workspace_registry (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  isolation_version INTEGER NOT NULL,
  repository_common_dir TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  task_branch TEXT NOT NULL,
  pinned_base_sha TEXT NOT NULL,
  remote_config_fingerprint TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_path)
);
CREATE INDEX idx_task_workspace_registry_project ON task_workspace_registry(project_id);
`;

const MIGRATION_V10 = Object.freeze({
  version: 10,
  name: 'p24-3a-task-workspace-isolation-foundation',
  checksum: migrationChecksum(SCHEMA_V10_SQL),
  up(db) { db.exec(SCHEMA_V10_SQL); },
});

/**
 * Schema v11 — P24.3C-R1 final-closure prep: durable git-failure diagnostics
 * for `task-workspace-manager.mjs` allocation/cleanup operations (reports/
 * P24_3C_FORENSIC_CLOSURE_DSH_P6_AND_ECRY_20260918.md's confirmed
 * observability gap — a failed `git worktree add`'s bounded stderr was only
 * ever attached to the in-memory thrown exception, never durably readable
 * after the fact).
 *
 * A NEW, small, additive, APPEND-ONLY table — deliberately NOT a column on
 * `task_workspace_registry` (that row is CAS-guarded by `revision` for
 * STATE, and a diagnostic write must never contend with, or be lost to, a
 * concurrent state CAS conflict; an operation can also fail more than once
 * for the same `task_id`, e.g. two independent fresh-allocation attempts —
 * see the forensic report's own `dsh-p6-test-b` two-row example — so this is
 * naturally one-row-per-failure, not one-row-per-task). No secrets/env/
 * credentials are ever written here — only the SAME bounded git stdout/
 * stderr slices `TaskWorkspaceError.extra` already carried in-memory, now
 * also persisted. Inert until `task-workspace-manager.mjs` actually records
 * a row (nothing does so before this schema exists); reading it back for a
 * `task_id` that never failed simply returns zero rows, same "absence means
 * exactly what it always meant" convention as schema v9/v10.
 */
const SCHEMA_V11_SQL = `
CREATE TABLE task_workspace_git_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  project_id TEXT,
  git_operation TEXT NOT NULL,
  error_code TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  bounded_stderr TEXT,
  bounded_stdout TEXT,
  workspace_path TEXT,
  task_branch TEXT,
  pinned_base_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_workspace_git_diagnostics_task ON task_workspace_git_diagnostics(task_id);
`;

const MIGRATION_V11 = Object.freeze({
  version: 11,
  name: 'p24-3c-r1-task-workspace-git-diagnostics',
  checksum: migrationChecksum(SCHEMA_V11_SQL),
  up(db) { db.exec(SCHEMA_V11_SQL); },
});

const MIGRATIONS = Object.freeze([MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6, MIGRATION_V7, MIGRATION_V8, MIGRATION_V9, MIGRATION_V10, MIGRATION_V11]);

/** @returns {ReadonlyArray<object>} migration definitions in ascending order. */
export function migrationDefinitions() {
  return MIGRATIONS;
}
