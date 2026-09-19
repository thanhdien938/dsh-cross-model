import { createHash } from 'node:crypto';

export const COORDINATION_SCHEMA_VERSION = 5;
export const COORDINATION_SCHEMA = 'dsh_coordination';

const V1 = `
CREATE TABLE dsh_coordination.worker_incarnations (
  worker_incarnation_id varchar(128) PRIMARY KEY,
  logical_worker_id varchar(128) NOT NULL,
  host_id varchar(128) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE','DRAINING','DISABLED','DEAD')),
  installed_profiles jsonb NOT NULL,
  capacity jsonb NOT NULL,
  record_version integer NOT NULL CHECK (record_version = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX worker_incarnations_logical_idx ON dsh_coordination.worker_incarnations(logical_worker_id, started_at);
CREATE TABLE dsh_coordination.coordinator_incarnations (
  coordinator_incarnation_id varchar(128) PRIMARY KEY,
  logical_coordinator_id varchar(128) NOT NULL,
  host_id varchar(128) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE','DRAINING','DISABLED','DEAD')),
  record_version integer NOT NULL CHECK (record_version = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX coordinator_incarnations_logical_idx ON dsh_coordination.coordinator_incarnations(logical_coordinator_id, started_at);
`;

export function coordinationMigrationChecksum(sql) { return createHash('sha256').update(sql.trim()).digest('hex'); }
const V2 = `
CREATE TABLE dsh_coordination.work_items (
  work_item_id varchar(128) PRIMARY KEY,
  work_kind varchar(32) NOT NULL CHECK (work_kind IN ('TASK_DISPATCH','WORKFLOW_STEP','PEER_HOP','PM_ACTION')),
  task_id varchar(128), run_id varchar(128), dispatch_attempt_id varchar(128),
  workflow_id varchar(128), step_id varchar(128), conversation_id varchar(128), hop_id varchar(128),
  pm_run_id varchar(128), action_id varchar(128),
  record_version integer NOT NULL CHECK (record_version = 1),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claim_state varchar(16) NOT NULL DEFAULT 'READY' CHECK (claim_state IN ('READY','ACTIVE','RELEASED','EXPIRED','COMPLETED')),
  owner_worker_incarnation_id varchar(128) REFERENCES dsh_coordination.worker_incarnations(worker_incarnation_id) ON DELETE RESTRICT,
  fencing_generation bigint NOT NULL DEFAULT 0 CHECK (fencing_generation >= 0),
  fencing_token varchar(64), acquired_at timestamptz, renewed_at timestamptz, expires_at timestamptz,
  claim_record_version integer NOT NULL DEFAULT 1 CHECK (claim_record_version = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  touch_revision bigint NOT NULL DEFAULT 0 CHECK (touch_revision >= 0),
  CHECK (
    (work_kind='TASK_DISPATCH' AND task_id IS NOT NULL AND run_id IS NOT NULL AND dispatch_attempt_id IS NOT NULL AND workflow_id IS NULL AND step_id IS NULL AND conversation_id IS NULL AND hop_id IS NULL AND pm_run_id IS NULL AND action_id IS NULL) OR
    (work_kind='WORKFLOW_STEP' AND workflow_id IS NOT NULL AND step_id IS NOT NULL AND task_id IS NULL AND run_id IS NULL AND dispatch_attempt_id IS NULL AND conversation_id IS NULL AND hop_id IS NULL AND pm_run_id IS NULL AND action_id IS NULL) OR
    (work_kind='PEER_HOP' AND conversation_id IS NOT NULL AND hop_id IS NOT NULL AND task_id IS NULL AND run_id IS NULL AND dispatch_attempt_id IS NULL AND workflow_id IS NULL AND step_id IS NULL AND pm_run_id IS NULL AND action_id IS NULL) OR
    (work_kind='PM_ACTION' AND pm_run_id IS NOT NULL AND action_id IS NOT NULL AND task_id IS NULL AND run_id IS NULL AND dispatch_attempt_id IS NULL AND workflow_id IS NULL AND step_id IS NULL AND conversation_id IS NULL AND hop_id IS NULL)
  ),
  CHECK (
    (claim_state='READY' AND owner_worker_incarnation_id IS NULL AND fencing_generation=0 AND fencing_token IS NULL AND acquired_at IS NULL AND renewed_at IS NULL AND expires_at IS NULL) OR
    (claim_state<>'READY' AND owner_worker_incarnation_id IS NOT NULL AND fencing_generation>0 AND fencing_token IS NOT NULL AND acquired_at IS NOT NULL AND renewed_at IS NOT NULL AND expires_at IS NOT NULL)
  )
);
CREATE INDEX work_items_owner_idx ON dsh_coordination.work_items(owner_worker_incarnation_id, claim_state);
`;
const V3 = `
CREATE TABLE dsh_coordination.coordinator_leadership (
  logical_coordinator_id varchar(128) PRIMARY KEY,
  owner_coordinator_incarnation_id varchar(128) NOT NULL REFERENCES dsh_coordination.coordinator_incarnations(coordinator_incarnation_id) ON DELETE RESTRICT,
  leader_generation bigint NOT NULL CHECK (leader_generation > 0),
  leadership_token varchar(64) NOT NULL,
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  policy_revision bigint NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE TABLE dsh_coordination.cancellation_requests (
  work_item_id varchar(128) PRIMARY KEY REFERENCES dsh_coordination.work_items(work_item_id) ON DELETE RESTRICT,
  requested_by_logical_coordinator_id varchar(128) NOT NULL,
  requested_by_leader_generation bigint NOT NULL CHECK (requested_by_leader_generation > 0),
  state varchar(32) NOT NULL CHECK (state IN ('REQUESTED','INTERRUPT_STARTED','CANCELLED','AMBIGUOUS','UNSUPPORTED')),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  worker_fencing_generation bigint,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
`;
const V4 = `
ALTER TABLE dsh_coordination.work_items ADD COLUMN claim_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE dsh_coordination.work_items ADD COLUMN parked_interaction_id varchar(128);
CREATE INDEX work_items_eligible_idx ON dsh_coordination.work_items(claim_eligible, claim_state, created_at);

CREATE TABLE dsh_coordination.owner_command (
  command_id varchar(128) PRIMARY KEY,
  actor_id varchar(32) NOT NULL CHECK (actor_id ~ '^[0-9]+$'),
  client_kind varchar(16) NOT NULL CHECK (client_kind IN ('TELEGRAM','LOCAL')),
  operation varchar(32) NOT NULL CHECK (operation IN ('SUBMIT_TASK','REPLY_TO_INTERACTION','DECIDE_INTERACTION','REQUEST_CANCEL','NARROW_AUTONOMY','EXPAND_AUTONOMY')),
  project_id varchar(128), target_id varchar(128), expected_revision bigint,
  payload jsonb NOT NULL, payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  status varchar(16) NOT NULL CHECK (status IN ('ACCEPTED','COMPLETED','REFUSED')),
  canonical_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), completed_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX owner_command_created_idx ON dsh_coordination.owner_command(created_at, command_id);

CREATE TABLE dsh_coordination.owner_interaction (
  interaction_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL, task_id varchar(128), pm_run_id varchar(128), pm_turn_index integer,
  origin varchar(8) NOT NULL CHECK (origin IN ('PM','SYSTEM')),
  kind varchar(16) NOT NULL CHECK (kind IN ('QUESTION','APPROVAL','INFO')),
  status varchar(16) NOT NULL CHECK (status IN ('OPEN','DECIDED','SUPERSEDED','CLOSED')),
  title varchar(256) NOT NULL, prompt_text text NOT NULL,
  allowed_responses jsonb NOT NULL, runtime_facts jsonb NOT NULL, response_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_response boolean NOT NULL, local_only boolean NOT NULL DEFAULT false,
  supersedes_interaction_id varchar(128) REFERENCES dsh_coordination.owner_interaction(interaction_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), decided_at timestamptz,
  notified_at timestamptz, notification_attempts integer NOT NULL DEFAULT 0 CHECK (notification_attempts >= 0),
  notification_lease_until timestamptz, revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (kind <> 'INFO' OR requires_response = false),
  CHECK (origin <> 'SYSTEM' OR local_only = true),
  CHECK (jsonb_typeof(allowed_responses) = 'array' AND jsonb_typeof(runtime_facts) = 'object' AND jsonb_typeof(response_bindings) = 'object')
);
CREATE UNIQUE INDEX owner_interaction_open_pm_run_idx ON dsh_coordination.owner_interaction(pm_run_id)
  WHERE origin='PM' AND requires_response=true AND status='OPEN';
CREATE INDEX owner_interaction_inbox_idx ON dsh_coordination.owner_interaction(status, created_at, interaction_id);

CREATE TABLE dsh_coordination.owner_decision (
  decision_id varchar(128) PRIMARY KEY,
  interaction_id varchar(128) NOT NULL UNIQUE REFERENCES dsh_coordination.owner_interaction(interaction_id) ON DELETE RESTRICT,
  command_id varchar(128) NOT NULL REFERENCES dsh_coordination.owner_command(command_id) ON DELETE RESTRICT,
  selected_response varchar(64), response_text text,
  interaction_revision bigint NOT NULL CHECK (interaction_revision >= 1),
  decided_by_actor_id varchar(32) NOT NULL CHECK (decided_by_actor_id ~ '^[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((selected_response IS NOT NULL)::integer + (response_text IS NOT NULL)::integer = 1)
);
`;

const V5 = `
CREATE TABLE dsh_coordination.reconciliation_audit (
  reconciliation_id varchar(64) PRIMARY KEY,
  idempotency_key char(64) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  task_id varchar(128), affected_lineage jsonb NOT NULL, classification varchar(64) NOT NULL,
  before_states jsonb NOT NULL, before_revisions jsonb NOT NULL,
  after_states jsonb NOT NULL, after_revisions jsonb NOT NULL,
  evidence_timestamps jsonb NOT NULL, leader_generation bigint NOT NULL,
  worker_incarnation varchar(128), repair_reason varchar(128) NOT NULL,
  repair_result varchar(32) NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX reconciliation_audit_task_idx ON dsh_coordination.reconciliation_audit(task_id, created_at);
`;

export const COORDINATION_MIGRATIONS = Object.freeze([
  { version: 1, name: 'identity_incarnations', sql: V1, checksum: coordinationMigrationChecksum(V1) },
  { version: 2, name: 'work_claim_lease_fencing', sql: V2, checksum: coordinationMigrationChecksum(V2) },
  { version: 3, name: 'coordinator_leadership_cancellation', sql: V3, checksum: coordinationMigrationChecksum(V3) },
  { version: 4, name: 'owner_control_human_loop', sql: V4, checksum: coordinationMigrationChecksum(V4) },
  { version: 5, name: 'stuck_task_reconciliation', sql: V5, checksum: coordinationMigrationChecksum(V5) },
]);
