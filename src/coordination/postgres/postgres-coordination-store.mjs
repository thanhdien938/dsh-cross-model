import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { CoordinationError } from '../coordination-errors.mjs';
import { createWorkIdentity, normalizeCoordinatorIdentity, normalizeWorkerIdentity } from '../coordination-identities.mjs';
import { COORDINATION_MIGRATIONS, COORDINATION_SCHEMA, COORDINATION_SCHEMA_VERSION } from './coordination-migrations.mjs';

const { Pool } = pg;
export const MIN_LEASE_MS = 50;
export const MAX_LEASE_MS = 3_600_000;

function error(message, code, cause, details = {}) {
  return new CoordinationError(message, { code, cause, ...details });
}

function workerRow(row) {
  return Object.freeze({ ...row, started_at: row.started_at.toISOString(), last_heartbeat_at: row.last_heartbeat_at.toISOString(), revision: Number(row.revision) });
}
function coordinatorRow(row) {
  return Object.freeze({ ...row, started_at: row.started_at.toISOString(), revision: Number(row.revision) });
}
const LINEAGE_KEYS = ['task_id', 'run_id', 'dispatch_attempt_id', 'workflow_id', 'step_id', 'conversation_id', 'hop_id', 'pm_run_id', 'action_id'];
function workRow(row) {
  if (!row) return null;
  const result = { work_item_id: row.work_item_id, work_kind: row.work_kind };
  for (const key of LINEAGE_KEYS) if (row[key] !== null) result[key] = row[key];
  return Object.freeze({ ...result, record_version: row.record_version, created_at: row.created_at.toISOString() });
}
function claimRow(row) {
  const generation = Number(row?.fencing_generation ?? 0);
  if (!row || generation === 0) return null;
  if (!row.server_now) throw error('claim read lacks authoritative server time', 'CLAIM_TIME_MISSING');
  const state = row.claim_state === 'ACTIVE' && row.expires_at <= row.server_now ? 'EXPIRED' : row.claim_state;
  return Object.freeze({
    work_item_id: row.work_item_id, owner_worker_incarnation_id: row.owner_worker_incarnation_id,
    fencing_generation: generation, fencing_token: row.fencing_token,
    acquired_at: row.acquired_at.toISOString(), renewed_at: row.renewed_at.toISOString(),
    expires_at: row.expires_at.toISOString(), claim_state: state,
    record_version: row.claim_record_version, revision: Number(row.revision), touch_revision: Number(row.touch_revision),
  });
}
function leadershipRow(row) {
  if (!row) return null;
  const state = row.expires_at <= row.server_now ? 'EXPIRED' : 'ACTIVE';
  return Object.freeze({ logical_coordinator_id: row.logical_coordinator_id, owner_coordinator_incarnation_id: row.owner_coordinator_incarnation_id, leader_generation: Number(row.leader_generation), leadership_token: row.leadership_token, acquired_at: row.acquired_at.toISOString(), renewed_at: row.renewed_at.toISOString(), expires_at: row.expires_at.toISOString(), state, policy_revision: Number(row.policy_revision), revision: Number(row.revision) });
}
function cancellationRow(row) { return Object.freeze({ work_item_id: row.work_item_id, requested_by_logical_coordinator_id: row.requested_by_logical_coordinator_id, requested_by_leader_generation: Number(row.requested_by_leader_generation), state: row.state, requested_at: row.requested_at.toISOString(), updated_at: row.updated_at.toISOString(), worker_fencing_generation: row.worker_fencing_generation === null ? null : Number(row.worker_fencing_generation), revision: Number(row.revision) }); }

export class PostgresCoordinationStore {
  #pool;
  #tx = new AsyncLocalStorage();

  async open(options = {}) {
    if (this.#pool) throw error('coordination store is already open', 'STORE_ALREADY_OPEN');
    const config = { ...options };
    if (!config.connectionString && !config.host) throw error('PostgreSQL connection configuration is required', 'CONNECTION_CONFIG_REQUIRED');
    this.#pool = new Pool({ ...config, max: config.max ?? 10 });
    // node-postgres emits idle-client failures on the pool. Keep them from
    // becoming process-level exceptions; every authority operation still
    // receives and propagates its own connection/query failure.
    this.#pool.on('error', () => {});
    try { await this.#pool.query('SELECT 1'); }
    catch (cause) { await this.#pool.end().catch(() => {}); this.#pool = undefined; throw error('PostgreSQL coordination connection failed', 'COORDINATION_CONNECTION_FAILED', cause); }
    return this;
  }

  async close() {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool) await pool.end();
  }

  #ready() {
    if (!this.#pool) throw error('coordination store is closed', 'COORDINATION_STORE_CLOSED');
    return this.#pool;
  }

  async transaction(callback) {
    if (typeof callback !== 'function') throw error('transaction callback is required', 'INVALID_TRANSACTION_CALLBACK');
    if (this.#tx.getStore()) throw error('nested transactions are not supported', 'NESTED_TRANSACTION_REJECTED');
    const client = await this.#ready().connect();
    try {
      await client.query('BEGIN');
      const facade = Object.freeze({
        serverNow: () => this.#serverNow(client),
        registerWorkerIncarnation: (value) => this.#registerWorker(client, value),
        registerCoordinatorIncarnation: (value) => this.#registerCoordinator(client, value),
        registerWorkIdentity: (value) => this.#registerWork(client, value),
      });
      const value = await this.#tx.run(client, () => callback(facade));
      await client.query('COMMIT');
      return value;
    } catch (cause) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original truth */ }
      if (cause instanceof CoordinationError) throw cause;
      throw error('coordination transaction failed', 'COORDINATION_TRANSACTION_FAILED', cause);
    } finally { client.release(); }
  }

  async serverNow() {
    const client = this.#tx.getStore();
    return this.#serverNow(client ?? this.#ready());
  }
  async #serverNow(queryable) {
    const { rows } = await queryable.query('SELECT statement_timestamp() AS server_now');
    return rows[0].server_now.toISOString();
  }

  async migrate() {
    return this.transaction(async () => {
      const client = this.#tx.getStore();
      await client.query('SELECT pg_advisory_xact_lock($1)', [730001]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${COORDINATION_SCHEMA}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${COORDINATION_SCHEMA}.schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT statement_timestamp())`);
      const { rows } = await client.query(`SELECT version, name, checksum FROM ${COORDINATION_SCHEMA}.schema_migrations ORDER BY version`);
      for (const row of rows) {
        const expected = COORDINATION_MIGRATIONS.find((m) => m.version === row.version);
        if (!expected) throw error(`unknown coordination schema version ${row.version}`, 'UNKNOWN_COORDINATION_SCHEMA', undefined, { version: row.version });
        if (expected.name !== row.name || expected.checksum !== row.checksum.trim()) throw error(`coordination migration checksum mismatch at version ${row.version}`, 'COORDINATION_SCHEMA_CHECKSUM_MISMATCH', undefined, { version: row.version });
      }
      for (const migration of COORDINATION_MIGRATIONS.filter((m) => !rows.some((r) => r.version === m.version))) {
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`, [migration.version, migration.name, migration.checksum]);
      }
      return COORDINATION_SCHEMA_VERSION;
    });
  }

  async readSchemaVersion() {
    try {
      const { rows } = await this.#ready().query(`SELECT COALESCE(MAX(version), 0)::integer AS version FROM ${COORDINATION_SCHEMA}.schema_migrations`);
      return rows[0].version;
    } catch (cause) {
      if (cause?.code === '42P01' || cause?.code === '3F000') return 0;
      throw error('failed to read coordination schema version', 'COORDINATION_SCHEMA_READ_FAILED', cause);
    }
  }

  async assertReady() {
    const version = await this.readSchemaVersion();
    if (version !== COORDINATION_SCHEMA_VERSION) throw error(`coordination schema version ${version} is not supported`, 'COORDINATION_SCHEMA_NOT_READY', undefined, { version });
    const { rows } = await this.#ready().query(`SELECT version, name, checksum FROM ${COORDINATION_SCHEMA}.schema_migrations ORDER BY version`);
    for (const migration of COORDINATION_MIGRATIONS) {
      const row = rows.find((candidate) => candidate.version === migration.version);
      if (!row || row.name !== migration.name || row.checksum.trim() !== migration.checksum) throw error('coordination schema integrity check failed', 'COORDINATION_SCHEMA_CHECKSUM_MISMATCH');
    }
    return true;
  }

  registerWorkerIncarnation(value) {
    const client = this.#tx.getStore();
    return client ? this.#registerWorker(client, value) : this.transaction((tx) => tx.registerWorkerIncarnation(value));
  }
  async #registerWorker(client, value) {
    const v = normalizeWorkerIdentity(value);
    await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.worker_incarnations
      (worker_incarnation_id,logical_worker_id,host_id,status,installed_profiles,capacity,record_version)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT (worker_incarnation_id) DO NOTHING`,
    [v.worker_incarnation_id, v.logical_worker_id, v.host_id, v.status, JSON.stringify(v.installed_profiles), JSON.stringify(v.capacity), v.record_version]);
    const { rows } = await client.query(`SELECT * FROM ${COORDINATION_SCHEMA}.worker_incarnations WHERE worker_incarnation_id=$1`, [v.worker_incarnation_id]);
    const row = rows[0];
    const same = row && row.logical_worker_id === v.logical_worker_id && row.host_id === v.host_id && row.status === v.status && row.record_version === v.record_version && isDeepStrictEqual(row.installed_profiles, v.installed_profiles) && isDeepStrictEqual(row.capacity, v.capacity);
    if (!same) throw error('worker incarnation ID conflicts with durable identity', 'INCARNATION_ID_CONFLICT');
    return workerRow(row);
  }
  async readWorkerIncarnation(id) {
    boundedLookupId(id);
    const { rows } = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.worker_incarnations WHERE worker_incarnation_id=$1`, [id]);
    return rows[0] ? workerRow(rows[0]) : null;
  }
  async listWorkerIncarnations(logicalId) {
    boundedLookupId(logicalId);
    const { rows } = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.worker_incarnations WHERE logical_worker_id=$1 ORDER BY started_at, worker_incarnation_id`, [logicalId]);
    return rows.map(workerRow);
  }
  async heartbeatWorkerIncarnation(id, capacity) {
    boundedLookupId(id);
    const payload = capacity === undefined ? null : normalizeCapacityUpdate(capacity);
    const { rows } = await this.#ready().query(`UPDATE ${COORDINATION_SCHEMA}.worker_incarnations SET last_heartbeat_at=statement_timestamp(), capacity=COALESCE($2::jsonb,capacity), revision=revision+1 WHERE worker_incarnation_id=$1 RETURNING *`, [id, payload && JSON.stringify(payload)]);
    if (!rows[0]) throw error('worker incarnation not found', 'WORKER_INCARNATION_NOT_FOUND');
    return workerRow(rows[0]);
  }
  async setWorkerLifecycle(id, status) {
    boundedLookupId(id); lifecycle(status);
    const { rows } = await this.#ready().query(`UPDATE ${COORDINATION_SCHEMA}.worker_incarnations SET status=$2, revision=revision+1 WHERE worker_incarnation_id=$1 RETURNING *`, [id, status]);
    if (!rows[0]) throw error('worker incarnation not found', 'WORKER_INCARNATION_NOT_FOUND');
    return workerRow(rows[0]);
  }

  registerCoordinatorIncarnation(value) {
    const client = this.#tx.getStore();
    return client ? this.#registerCoordinator(client, value) : this.transaction((tx) => tx.registerCoordinatorIncarnation(value));
  }
  async #registerCoordinator(client, value) {
    const v = normalizeCoordinatorIdentity(value);
    await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.coordinator_incarnations
      (coordinator_incarnation_id,logical_coordinator_id,host_id,status,record_version)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (coordinator_incarnation_id) DO NOTHING`,
    [v.coordinator_incarnation_id, v.logical_coordinator_id, v.host_id, v.status, v.record_version]);
    const { rows } = await client.query(`SELECT * FROM ${COORDINATION_SCHEMA}.coordinator_incarnations WHERE coordinator_incarnation_id=$1`, [v.coordinator_incarnation_id]);
    const row = rows[0];
    if (!row || row.logical_coordinator_id !== v.logical_coordinator_id || row.host_id !== v.host_id || row.status !== v.status || row.record_version !== v.record_version) throw error('coordinator incarnation ID conflicts with durable identity', 'INCARNATION_ID_CONFLICT');
    return coordinatorRow(row);
  }
  async readCoordinatorIncarnation(id) {
    boundedLookupId(id);
    const { rows } = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.coordinator_incarnations WHERE coordinator_incarnation_id=$1`, [id]);
    return rows[0] ? coordinatorRow(rows[0]) : null;
  }
  async listCoordinatorIncarnations(logicalId) {
    boundedLookupId(logicalId);
    const { rows } = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.coordinator_incarnations WHERE logical_coordinator_id=$1 ORDER BY started_at, coordinator_incarnation_id`, [logicalId]);
    return rows.map(coordinatorRow);
  }
  async setCoordinatorLifecycle(id, status) {
    boundedLookupId(id); lifecycle(status);
    const { rows } = await this.#ready().query(`UPDATE ${COORDINATION_SCHEMA}.coordinator_incarnations SET status=$2, revision=revision+1 WHERE coordinator_incarnation_id=$1 RETURNING *`, [id, status]);
    if (!rows[0]) throw error('coordinator incarnation not found', 'COORDINATOR_INCARNATION_NOT_FOUND');
    return coordinatorRow(rows[0]);
  }

  acquireLeadership(input) {
    const { logical_coordinator_id, coordinator_incarnation_id, leaseMs } = validateLeadershipRequest(input);
    boundedLookupId(logical_coordinator_id); boundedLookupId(coordinator_incarnation_id); validateLeaseMs(leaseMs);
    return this.transaction(async () => {
      const client = this.#tx.getStore();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 730008))', [logical_coordinator_id]);
      const identity = await client.query(`SELECT 1 FROM ${COORDINATION_SCHEMA}.coordinator_incarnations WHERE coordinator_incarnation_id=$1 AND logical_coordinator_id=$2`, [coordinator_incarnation_id, logical_coordinator_id]);
      if (!identity.rowCount) throw error('coordinator incarnation does not match logical coordinator', 'COORDINATOR_INCARNATION_NOT_FOUND');
      const locked = await client.query(`SELECT *, statement_timestamp() AS server_now FROM ${COORDINATION_SCHEMA}.coordinator_leadership WHERE logical_coordinator_id=$1 FOR UPDATE`, [logical_coordinator_id]);
      const current = locked.rows[0];
      if (current && current.expires_at > current.server_now) return null;
      const generation = Number(current?.leader_generation ?? 0) + 1; const token = randomBytes(32).toString('base64url');
      const { rows } = await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.coordinator_leadership
        (logical_coordinator_id,owner_coordinator_incarnation_id,leader_generation,leadership_token,acquired_at,renewed_at,expires_at)
        VALUES ($1,$2,$3,$4,statement_timestamp(),statement_timestamp(),statement_timestamp()+($5::bigint*interval '1 millisecond'))
        ON CONFLICT (logical_coordinator_id) DO UPDATE SET owner_coordinator_incarnation_id=EXCLUDED.owner_coordinator_incarnation_id,
        leader_generation=EXCLUDED.leader_generation,leadership_token=EXCLUDED.leadership_token,acquired_at=EXCLUDED.acquired_at,
        renewed_at=EXCLUDED.renewed_at,expires_at=EXCLUDED.expires_at,revision=${COORDINATION_SCHEMA}.coordinator_leadership.revision+1
        RETURNING *, statement_timestamp() AS server_now`, [logical_coordinator_id, coordinator_incarnation_id, generation, token, leaseMs]);
      return leadershipRow(rows[0]);
    });
  }

  async readLeadership(logicalId) {
    boundedLookupId(logicalId);
    const { rows } = await this.#ready().query(`SELECT *, statement_timestamp() AS server_now FROM ${COORDINATION_SCHEMA}.coordinator_leadership WHERE logical_coordinator_id=$1`, [logicalId]);
    return rows[0] ? leadershipRow(rows[0]) : null;
  }

  renewLeadership(fence, leaseMs) {
    const v = validateLeadershipFence(fence); validateLeaseMs(leaseMs);
    return this.transaction(async () => {
      const { rows } = await this.#tx.getStore().query(`UPDATE ${COORDINATION_SCHEMA}.coordinator_leadership SET renewed_at=statement_timestamp(),expires_at=statement_timestamp()+($5::bigint*interval '1 millisecond'),revision=revision+1
        WHERE logical_coordinator_id=$1 AND owner_coordinator_incarnation_id=$2 AND leader_generation=$3 AND leadership_token=$4 AND expires_at>statement_timestamp()
        RETURNING *,statement_timestamp() AS server_now`, [v.logical_coordinator_id, v.owner_coordinator_incarnation_id, v.leader_generation, v.leadership_token, leaseMs]);
      if (!rows[0]) throw error('leadership authority is absent, stale, or expired', 'LEADERSHIP_AUTHORITY_REJECTED');
      return leadershipRow(rows[0]);
    });
  }

  withLeadershipAuthority(fence, callback) {
    const v = validateLeadershipFence(fence); if (typeof callback !== 'function') throw error('leadership callback is required', 'INVALID_AUTHORITY_CALLBACK');
    return this.transaction(async () => {
      const { rows } = await this.#tx.getStore().query(`SELECT *,statement_timestamp() AS server_now FROM ${COORDINATION_SCHEMA}.coordinator_leadership WHERE logical_coordinator_id=$1 AND owner_coordinator_incarnation_id=$2 AND leader_generation=$3 AND leadership_token=$4 AND expires_at>statement_timestamp() FOR UPDATE`, [v.logical_coordinator_id, v.owner_coordinator_incarnation_id, v.leader_generation, v.leadership_token]);
      if (!rows[0]) throw error('leadership authority is absent, stale, or expired', 'LEADERSHIP_AUTHORITY_REJECTED');
      return callback(leadershipRow(rows[0]));
    });
  }

  fencedPolicyTouch(fence) { return this.withLeadershipAuthority(fence, async () => { const { rows } = await this.#tx.getStore().query(`UPDATE ${COORDINATION_SCHEMA}.coordinator_leadership SET policy_revision=policy_revision+1,revision=revision+1 WHERE logical_coordinator_id=$1 RETURNING *,statement_timestamp() AS server_now`, [fence.logical_coordinator_id]); return leadershipRow(rows[0]); }); }

  requestCancellation(leaderFence, workItemId) {
    boundedLookupId(workItemId);
    return this.withLeadershipAuthority(leaderFence, async () => {
      const client = this.#tx.getStore(); const found = await client.query(`SELECT 1 FROM ${COORDINATION_SCHEMA}.work_items WHERE work_item_id=$1`, [workItemId]);
      if (!found.rowCount) throw error('work item does not exist', 'WORK_ITEM_NOT_FOUND');
      await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.cancellation_requests(work_item_id,requested_by_logical_coordinator_id,requested_by_leader_generation,state,requested_at,updated_at) VALUES($1,$2,$3,'REQUESTED',statement_timestamp(),statement_timestamp()) ON CONFLICT(work_item_id) DO NOTHING`, [workItemId, leaderFence.logical_coordinator_id, leaderFence.leader_generation]);
      return this.readCancellation(workItemId, client);
    });
  }
  async readCancellation(workItemId, queryable = this.#ready()) { boundedLookupId(workItemId); const { rows } = await queryable.query(`SELECT * FROM ${COORDINATION_SCHEMA}.cancellation_requests WHERE work_item_id=$1`, [workItemId]); return rows[0] ? cancellationRow(rows[0]) : null; }
  // P13-R2.3: cancel a work item that has NEVER been claimed (§6.4 of the
  // R1 architecture plan flagged this as an unreachable-before-R2 state:
  // "a queued-but-unclaimed PM task ... no behaviour exists for it").
  // Deliberately NOT `startCancellation()`/`completeCancellation()` --
  // those require `withClaimAuthority(fence, ...)`, i.e. an ACTIVE claim's
  // fence, which is exactly what this path must never acquire ("no ACTIVE
  // claim is acquired merely to cancel it"). This is a single atomic
  // row-locked transition instead: only succeeds when the item has NEVER
  // been claimed (`claim_state='READY'`, its schema default) AND a
  // cancellation is genuinely REQUESTED for it.
  //
  // Sets ONLY `claim_eligible=false` -- `claim_state` is deliberately left
  // at `'READY'`. The schema's own CHECK constraint requires any
  // `claim_state<>'READY'` row to carry real claim provenance
  // (`owner_worker_incarnation_id`/`fencing_generation>0`/`fencing_token`/
  // timestamps, coordination-migrations.mjs), which a never-claimed item
  // by definition has none of -- setting `claim_state='COMPLETED'` here
  // (an earlier draft of this method did exactly that) violates that
  // constraint and fails at the database (caught only once this was run
  // against a REAL PostgreSQL instance, never by the Tier 1 fakes).
  // `claim_eligible=false` alone is already sufficient:
  // `listPmActionCandidates()`'s existing `claim_eligible=true` filter
  // permanently excludes the row, and nothing ever flips `claim_eligible`
  // back to `true` for a `claim_state='READY'` row --
  // `restoreOwnerDecisionEligibility()`'s own guard requires
  // `claim_state='RELEASED'`, so it can never match this one.
  //
  // Advances the cancellation itself to the schema's own terminal
  // `CANCELLED` state. Returns `null` (never throws) when the item does
  // not exist, was already claimed/terminal/ineligible, or has no
  // REQUESTED cancellation -- the caller (production-pm-worker.mjs) then
  // simply proceeds with normal admission.
  cancelUnclaimedWork(workItemId) {
    boundedLookupId(workItemId);
    return this.transaction(() => this.#cancelUnclaimedWork(this.#tx.getStore(), workItemId));
  }
  async #cancelUnclaimedWork(client, workItemId) {
    const cancellation = await client.query(`SELECT 1 FROM ${COORDINATION_SCHEMA}.cancellation_requests WHERE work_item_id=$1 AND state='REQUESTED' FOR UPDATE`, [workItemId]);
    if (!cancellation.rowCount) return null;
    const updated = await client.query(`UPDATE ${COORDINATION_SCHEMA}.work_items SET claim_eligible=false, revision=revision+1 WHERE work_item_id=$1 AND claim_state='READY' AND claim_eligible=true`, [workItemId]);
    if (!updated.rowCount) return null;
    const { rows } = await client.query(`UPDATE ${COORDINATION_SCHEMA}.cancellation_requests SET state='CANCELLED', updated_at=statement_timestamp(), revision=revision+1 WHERE work_item_id=$1 RETURNING *`, [workItemId]);
    return cancellationRow(rows[0]);
  }
  startCancellation(fence) { return this.withClaimAuthority(fence, async () => this.#mutateCancellation(fence, ['REQUESTED'], 'INTERRUPT_STARTED')); }
  completeCancellation(fence, state) { if (!['CANCELLED','AMBIGUOUS','UNSUPPORTED'].includes(state)) throw error('cancellation outcome is invalid', 'INVALID_COORDINATION_INPUT'); return this.withClaimAuthority(fence, async () => this.#mutateCancellation(fence, ['INTERRUPT_STARTED'], state)); }
  async #mutateCancellation(fence, from, state) { const { rows } = await this.#tx.getStore().query(`UPDATE ${COORDINATION_SCHEMA}.cancellation_requests SET state=$2,updated_at=statement_timestamp(),worker_fencing_generation=$3,revision=revision+1 WHERE work_item_id=$1 AND state=ANY($4::varchar[]) RETURNING *`, [fence.work_item_id, state, fence.fencing_generation, from]); if (!rows[0]) throw error('cancellation transition rejected', 'CANCELLATION_TRANSITION_REJECTED'); return cancellationRow(rows[0]); }

  registerWorkIdentity(value) {
    const client = this.#tx.getStore();
    return client ? this.#registerWork(client, value) : this.transaction((tx) => tx.registerWorkIdentity(value));
  }
  async #registerWork(client, value) {
    const v = createWorkIdentity(value);
    const columns = LINEAGE_KEYS.map((key) => v[key] ?? null);
    await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.work_items
      (work_item_id,work_kind,task_id,run_id,dispatch_attempt_id,workflow_id,step_id,conversation_id,hop_id,pm_run_id,action_id,record_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (work_item_id) DO NOTHING`,
    [v.work_item_id, v.work_kind, ...columns, v.record_version]);
    const { rows } = await client.query(`SELECT * FROM ${COORDINATION_SCHEMA}.work_items WHERE work_item_id=$1`, [v.work_item_id]);
    const existing = workRow(rows[0]);
    const comparable = { ...existing };
    delete comparable.created_at;
    if (!isDeepStrictEqual(comparable, v)) throw error('work item ID conflicts with durable identity', 'WORK_ITEM_ID_CONFLICT');
    return existing;
  }

  async readWorkItem(workItemId) {
    boundedLookupId(workItemId);
    const { rows } = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.work_items WHERE work_item_id=$1`, [workItemId]);
    return workRow(rows[0]);
  }

  async listTaskDispatchCandidates({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw error('candidate limit must be an integer between 1 and 256', 'INVALID_COORDINATION_INPUT');
    }
    const { rows } = await this.#ready().query(`SELECT work_item_id, work_kind, task_id, run_id, dispatch_attempt_id,
      workflow_id, step_id, conversation_id, hop_id, pm_run_id, action_id, record_version, created_at
      FROM ${COORDINATION_SCHEMA}.work_items
      WHERE work_kind='TASK_DISPATCH' AND claim_state<>'COMPLETED'
        AND claim_eligible=true
        AND (claim_state<>'ACTIVE' OR expires_at<=statement_timestamp())
      ORDER BY created_at, work_item_id LIMIT $1`, [limit]);
    return Object.freeze(rows.map(workRow));
  }

  async listPmActionCandidates({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw error('candidate limit must be an integer between 1 and 256', 'INVALID_COORDINATION_INPUT');
    const { rows } = await this.#ready().query(`SELECT work_item_id, work_kind, task_id, run_id, dispatch_attempt_id,
      workflow_id, step_id, conversation_id, hop_id, pm_run_id, action_id, record_version, created_at
      FROM ${COORDINATION_SCHEMA}.work_items
      WHERE work_kind='PM_ACTION' AND claim_state<>'COMPLETED' AND claim_eligible=true
        AND (claim_state<>'ACTIVE' OR expires_at<=statement_timestamp())
      ORDER BY created_at, work_item_id LIMIT $1`, [limit]);
    return Object.freeze(rows.map(workRow));
  }

  // P13-R3: the COMPLEMENT of listPmActionCandidates() -- every PM_ACTION
  // work item currently holding a real, unexpired ACTIVE claim, held by
  // ANY worker incarnation (not necessarily this process's own). This
  // exists so a freshly restarted ProductionPmWorker (an empty in-process
  // slot table by design -- §4.4/§10) can reconcile which physical
  // workspaces are ALREADY occupied by a still-unexpired claim from a
  // PRIOR incarnation before admitting new work into the same workspace.
  // Without this, a fast restart (well within the lease window) would
  // have no way to know a workspace is still nominally claimed by a dead-
  // but-not-yet-expired executor, risking the exact "same physical
  // workspace writers concurrently active" hazard P13 must never
  // introduce. Read-only; never mutates claim state itself.
  async listActivePmActionWork({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw error('candidate limit must be an integer between 1 and 256', 'INVALID_COORDINATION_INPUT');
    const { rows } = await this.#ready().query(`SELECT work_item_id, work_kind, task_id, run_id, dispatch_attempt_id,
      workflow_id, step_id, conversation_id, hop_id, pm_run_id, action_id, record_version, created_at
      FROM ${COORDINATION_SCHEMA}.work_items
      WHERE work_kind='PM_ACTION' AND claim_state='ACTIVE' AND expires_at>statement_timestamp()
      ORDER BY created_at, work_item_id LIMIT $1`, [limit]);
    return Object.freeze(rows.map(workRow));
  }

  async readClaim(workItemId) {
    boundedLookupId(workItemId);
    const { rows } = await this.#ready().query(`SELECT *, statement_timestamp() AS server_now FROM ${COORDINATION_SCHEMA}.work_items WHERE work_item_id=$1`, [workItemId]);
    return claimRow(rows[0]);
  }

  acquireClaim(input) {
    const { work_item_id, worker_incarnation_id, leaseMs } = validateAcquireRequest(input);
    boundedLookupId(work_item_id); boundedLookupId(worker_incarnation_id); validateLeaseMs(leaseMs);
    return this.transaction(() => this.#acquireClaim(this.#tx.getStore(), { work_item_id, worker_incarnation_id, leaseMs }));
  }
  async #acquireClaim(client, { work_item_id, worker_incarnation_id, leaseMs }) {
    const worker = await client.query(`SELECT 1 FROM ${COORDINATION_SCHEMA}.worker_incarnations WHERE worker_incarnation_id=$1`, [worker_incarnation_id]);
    if (!worker.rowCount) throw error('worker incarnation does not exist', 'WORKER_INCARNATION_NOT_FOUND');
    const locked = await client.query(`SELECT *, statement_timestamp() AS server_now FROM ${COORDINATION_SCHEMA}.work_items WHERE work_item_id=$1 FOR UPDATE`, [work_item_id]);
    const current = locked.rows[0];
    if (!current) throw error('work item does not exist', 'WORK_ITEM_NOT_FOUND');
    if (!current.claim_eligible) return null;
    if (current.claim_state === 'COMPLETED') return null;
    if (current.claim_state === 'ACTIVE' && current.expires_at > current.server_now) return null;
    if (current.claim_state === 'ACTIVE') {
      await client.query(`UPDATE ${COORDINATION_SCHEMA}.work_items SET claim_state='EXPIRED', revision=revision+1 WHERE work_item_id=$1`, [work_item_id]);
    }
    const token = randomBytes(32).toString('base64url');
    const { rows } = await client.query(`UPDATE ${COORDINATION_SCHEMA}.work_items SET
      claim_state='ACTIVE', owner_worker_incarnation_id=$2, fencing_generation=fencing_generation+1,
      fencing_token=$3, acquired_at=statement_timestamp(), renewed_at=statement_timestamp(),
      expires_at=statement_timestamp()+($4::bigint * interval '1 millisecond'), revision=revision+1
      WHERE work_item_id=$1 RETURNING *, statement_timestamp() AS server_now`, [work_item_id, worker_incarnation_id, token, leaseMs]);
    return claimRow(rows[0]);
  }

  renewClaim(fence, leaseMs) {
    const v = validateFence(fence); validateLeaseMs(leaseMs);
    return this.#fencedMutation('renew', v, leaseMs);
  }
  releaseClaim(fence) { return this.#fencedMutation('release', validateFence(fence)); }
  completeClaim(fence) { return this.#fencedMutation('complete', validateFence(fence)); }
  fencedTouch(fence) { return this.#fencedMutation('touch', validateFence(fence)); }
  parkClaimForOwner(fence, interactionId) { boundedLookupId(interactionId); return this.#fencedMutation('park', validateFence(fence), interactionId); }

  #fencedMutation(operation, fence, leaseMs) {
    return this.#tx.getStore()
      ? this.#mutateLiveFence(operation, fence, leaseMs)
      : this.transaction(() => this.#mutateLiveFence(operation, fence, leaseMs));
  }

  withClaimAuthority(fence, callback) {
    const validated = validateFence(fence);
    if (typeof callback !== 'function') throw error('authority callback is required', 'INVALID_AUTHORITY_CALLBACK');
    if (this.#tx.getStore()) return this.#withClaimAuthority(validated, callback);
    return this.transaction(() => this.#withClaimAuthority(validated, callback));
  }

  async #withClaimAuthority(fence, callback) {
    const client = this.#tx.getStore();
    const { rows } = await client.query(`SELECT work_item_id, work_kind, task_id, run_id, dispatch_attempt_id,
      workflow_id, step_id, conversation_id, hop_id, pm_run_id, action_id, record_version, created_at
      FROM ${COORDINATION_SCHEMA}.work_items
      WHERE work_item_id=$1 AND owner_worker_incarnation_id=$2 AND fencing_generation=$3 AND fencing_token=$4
        AND claim_state='ACTIVE' AND expires_at>statement_timestamp()
      FOR UPDATE`, [fence.work_item_id, fence.owner_worker_incarnation_id, fence.fencing_generation, fence.fencing_token]);
    if (!rows[0]) throw error('claim authority is absent, stale, or expired', 'CLAIM_AUTHORITY_REJECTED');
    return callback(workRow(rows[0]));
  }

  async #mutateLiveFence(operation, fence, leaseMs) {
    const client = this.#tx.getStore();
    const sets = {
      renew: `renewed_at=statement_timestamp(), expires_at=statement_timestamp()+($5::bigint * interval '1 millisecond'), revision=revision+1`,
      release: `claim_state='RELEASED', revision=revision+1`,
      complete: `claim_state='COMPLETED', revision=revision+1`,
      touch: `touch_revision=touch_revision+1, revision=revision+1`,
      park: `claim_state='RELEASED', claim_eligible=false, parked_interaction_id=$5, revision=revision+1`,
    };
    const params = [fence.work_item_id, fence.owner_worker_incarnation_id, fence.fencing_generation, fence.fencing_token];
    if (operation === 'renew' || operation === 'park') params.push(leaseMs);
    const { rows } = await client.query(`UPDATE ${COORDINATION_SCHEMA}.work_items SET ${sets[operation]}
      WHERE work_item_id=$1 AND owner_worker_incarnation_id=$2 AND fencing_generation=$3 AND fencing_token=$4
        AND claim_state='ACTIVE' AND expires_at>statement_timestamp()
      RETURNING *, statement_timestamp() AS server_now`, params);
    if (!rows[0]) throw error('claim authority is absent, stale, or expired', 'CLAIM_AUTHORITY_REJECTED');
    return claimRow(rows[0]);
  }

  async restoreOwnerDecisionEligibility(leaderFence, { work_item_id, interaction_id }) {
    boundedLookupId(work_item_id); boundedLookupId(interaction_id);
    return this.withLeadershipAuthority(leaderFence, async () => {
      const { rows } = await this.#tx.getStore().query(`UPDATE ${COORDINATION_SCHEMA}.work_items SET claim_eligible=true, parked_interaction_id=NULL, revision=revision+1
        WHERE work_item_id=$1 AND claim_eligible=false AND parked_interaction_id=$2 AND claim_state='RELEASED' RETURNING *`, [work_item_id, interaction_id]);
      return rows[0] ? workRow(rows[0]) : null;
    });
  }

  async listStaleCancellationCandidates({ limit = 50 } = {}) {
    const { rows } = await this.#ready().query(`SELECT c.work_item_id FROM ${COORDINATION_SCHEMA}.cancellation_requests c JOIN ${COORDINATION_SCHEMA}.work_items w USING(work_item_id) WHERE c.state='REQUESTED' AND w.claim_state='COMPLETED' ORDER BY c.requested_at,c.work_item_id LIMIT $1`, [Math.min(200, Math.max(1, limit))]);
    return rows.map(({ work_item_id }) => ({ kind: 'POSTGRES_CANCELLATION', id: work_item_id }));
  }

  async observeCancellationReconciliation(workItemId) {
    boundedLookupId(workItemId);
    const { rows } = await this.#ready().query(`SELECT w.*,c.state AS cancellation_state,c.revision AS cancellation_revision,c.updated_at AS cancellation_updated_at,
      COALESCE(w.task_id,oc.canonical_result->>'task_id') AS resolved_task_id
      FROM ${COORDINATION_SCHEMA}.work_items w JOIN ${COORDINATION_SCHEMA}.cancellation_requests c USING(work_item_id)
      LEFT JOIN LATERAL (SELECT canonical_result FROM ${COORDINATION_SCHEMA}.owner_command WHERE operation='SUBMIT_TASK' AND status='COMPLETED' AND canonical_result->>'pm_run_id'=w.pm_run_id LIMIT 1) oc ON true
      WHERE w.work_item_id=$1`, [workItemId]);
    const row = rows[0]; if (!row) return null;
    return Object.freeze({ workItemId: row.work_item_id, taskId: row.resolved_task_id ?? null, pmRunId: row.pm_run_id ?? null, claimState: row.claim_state, claimEligible: row.claim_eligible, workRevision: Number(row.revision), cancellationState: row.cancellation_state, cancellationRevision: Number(row.cancellation_revision), cancellationUpdatedAt: row.cancellation_updated_at.toISOString() });
  }

  async observeReconciliationResources(lineage = {}) {
    const ids = [...new Set([...(lineage.runIds ?? []), ...(lineage.workflowIds ?? []), ...(lineage.stepIds ?? []), lineage.pmRunId, lineage.taskId].filter(Boolean))];
    const { rows } = await this.#ready().query(`SELECT w.*,statement_timestamp() AS server_now,wi.status AS worker_status FROM ${COORDINATION_SCHEMA}.work_items w LEFT JOIN ${COORDINATION_SCHEMA}.worker_incarnations wi ON wi.worker_incarnation_id=w.owner_worker_incarnation_id WHERE w.task_id=ANY($1::varchar[]) OR w.run_id=ANY($1::varchar[]) OR w.workflow_id=ANY($1::varchar[]) OR w.step_id=ANY($1::varchar[]) OR w.pm_run_id=ANY($1::varchar[])`, [ids]);
    const active = rows.some(row => row.claim_state === 'ACTIVE');
    const leased = rows.some(row => row.expires_at && row.expires_at > row.server_now);
    const uncertainWorkerOwnership = rows.some(row => row.claim_state === 'ACTIVE' && row.worker_status !== 'ACTIVE');
    const interactions = await this.#ready().query(`SELECT * FROM ${COORDINATION_SCHEMA}.owner_interaction WHERE status='OPEN' AND (pm_run_id=$1 OR task_id=$2)`, [lineage.pmRunId ?? null, lineage.taskId ?? null]);
    const exact = interactions.rows.find(row => row.pm_run_id === (lineage.pmRunId ?? null) || row.task_id === (lineage.taskId ?? null));
    return Object.freeze({ activeClaim: active, unexpiredLease: leased, uncertainWorkerOwnership, openOwnerInteraction: exact ? { requiresResponse: exact.requires_response, lineageExact: true, interactionId: exact.interaction_id } : null, resourceImpact: active || leased ? 'CAPACITY_OR_OWNERSHIP_HELD' : 'NONE' });
  }

  reconcileTerminalCancellation(fence, { expected, audit }) {
    return this.withLeadershipAuthority(fence, async () => {
      const client = this.#tx.getStore();
      const prior = await client.query(`SELECT reconciliation_id FROM ${COORDINATION_SCHEMA}.reconciliation_audit WHERE idempotency_key=$1`, [audit.idempotencyKey]);
      if (prior.rows[0]) return { applied: false, idempotent: true, reconciliationId: prior.rows[0].reconciliation_id };
      // `revision=c.revision+1` (never bare `revision+1`): this UPDATE...FROM
      // joins work_items, which also has a `revision` column — an unqualified
      // RHS throws PG 42702 "column reference revision is ambiguous" (real
      // live regression, 2026-09-07).
      const changed = await client.query(`UPDATE ${COORDINATION_SCHEMA}.cancellation_requests c SET state='CANCELLED',updated_at=statement_timestamp(),revision=c.revision+1 FROM ${COORDINATION_SCHEMA}.work_items w WHERE c.work_item_id=$1 AND c.work_item_id=w.work_item_id AND c.state='REQUESTED' AND c.revision=$2 AND w.claim_state='COMPLETED' AND w.revision=$3 RETURNING c.*`, [expected.workItemId, expected.cancellationRevision, expected.workRevision]);
      if (!changed.rows[0]) return { applied: false, idempotent: false };
      const after = cancellationRow(changed.rows[0]);
      await client.query(`INSERT INTO ${COORDINATION_SCHEMA}.reconciliation_audit (reconciliation_id,idempotency_key,task_id,affected_lineage,classification,before_states,before_revisions,after_states,after_revisions,evidence_timestamps,leader_generation,worker_incarnation,repair_reason,repair_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'APPLIED')`, [audit.reconciliationId,audit.idempotencyKey,audit.taskId,audit.lineage,audit.classification,audit.beforeStates,audit.beforeRevisions,{ cancellation: after.state },{ cancellation: after.revision },audit.evidenceTimestamps,audit.leaderGeneration,audit.workerIncarnation,audit.repairReason]);
      return { applied: true, idempotent: false, reconciliationId: audit.reconciliationId };
    });
  }
}

function boundedLookupId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw error('identity lookup ID is invalid', 'INVALID_COORDINATION_INPUT');
}

function lifecycle(value) {
  if (!['ACTIVE', 'DRAINING', 'DISABLED', 'DEAD'].includes(value)) throw error('lifecycle status is invalid', 'INVALID_COORDINATION_INPUT');
}

function normalizeCapacityUpdate(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2 || !Number.isInteger(value.max_concurrency) || value.max_concurrency < 1 || value.max_concurrency > 1_000 || !Number.isInteger(value.reported_in_use) || value.reported_in_use < 0 || value.reported_in_use > value.max_concurrency) throw error('capacity is invalid', 'INVALID_COORDINATION_INPUT');
  return { max_concurrency: value.max_concurrency, reported_in_use: value.reported_in_use };
}

function validateLeaseMs(value) {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) throw error(`leaseMs must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`, 'INVALID_LEASE_DURATION');
  return value;
}

function validateFence(value) {
  if (!value || typeof value !== 'object') throw error('claim fence is required', 'INVALID_CLAIM_FENCE');
  const allowed = ['work_item_id', 'owner_worker_incarnation_id', 'fencing_generation', 'fencing_token'];
  if (!hasExactDataKeys(value, allowed)) throw error('claim fence fields are invalid', 'INVALID_CLAIM_FENCE');
  boundedLookupId(value.work_item_id); boundedLookupId(value.owner_worker_incarnation_id);
  if (!Number.isSafeInteger(value.fencing_generation) || value.fencing_generation < 1 || typeof value.fencing_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.fencing_token)) throw error('claim fence fields are invalid', 'INVALID_CLAIM_FENCE');
  return value;
}

function validateAcquireRequest(value) {
  const allowed = ['work_item_id', 'worker_incarnation_id', 'leaseMs'];
  if (!value || typeof value !== 'object' || !hasExactDataKeys(value, allowed)) throw error('claim acquisition fields are invalid', 'INVALID_CLAIM_REQUEST');
  return value;
}
function validateLeadershipRequest(value) {
  const allowed = ['logical_coordinator_id', 'coordinator_incarnation_id', 'leaseMs'];
  if (!value || typeof value !== 'object' || !hasExactDataKeys(value, allowed)) throw error('leadership acquisition fields are invalid', 'INVALID_LEADERSHIP_REQUEST');
  return value;
}
function validateLeadershipFence(value) {
  const allowed = ['logical_coordinator_id', 'owner_coordinator_incarnation_id', 'leader_generation', 'leadership_token'];
  if (!value || typeof value !== 'object' || !hasExactDataKeys(value, allowed)) throw error('leadership fence fields are invalid', 'INVALID_LEADERSHIP_FENCE');
  boundedLookupId(value.logical_coordinator_id); boundedLookupId(value.owner_coordinator_incarnation_id);
  if (!Number.isSafeInteger(value.leader_generation) || value.leader_generation < 1 || typeof value.leadership_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.leadership_token)) throw error('leadership fence fields are invalid', 'INVALID_LEADERSHIP_FENCE');
  return value;
}

function hasExactDataKeys(value, allowed) {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) return false;
  return allowed.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && 'value' in descriptor;
  }) && keys.every((key) => typeof key === 'string' && allowed.includes(key));
}
