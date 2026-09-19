import pg from 'pg';
import { OwnerControlError, normalizeInteraction, stableJson } from './owner-contracts.mjs';
const { Pool } = pg;
const S = 'dsh_coordination';

function row(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of ['revision', 'expected_revision', 'interaction_revision', 'notification_attempts', 'pm_turn_index']) if (out[key] !== null && out[key] !== undefined) out[key] = Number(out[key]);
  for (const key of ['created_at', 'completed_at', 'decided_at', 'notified_at', 'notification_lease_until']) if (out[key] instanceof Date) out[key] = out[key].toISOString();
  return Object.freeze(out);
}

export class PostgresOwnerRepository {
  #pool;
  async open(options = {}) {
    if (this.#pool) throw new OwnerControlError('owner repository already open', 'OWNER_STORE_ALREADY_OPEN');
    const config = options.connectionString ? { connectionString: options.connectionString } : { ...options };
    if (!config.connectionString && !config.host) throw new OwnerControlError('PostgreSQL configuration required', 'OWNER_STORE_CONFIG_REQUIRED');
    this.#pool = new Pool({ ...config, max: config.max ?? 8 }); this.#pool.on('error', () => {});
    try { await this.#pool.query(`SELECT 1 FROM ${S}.schema_migrations WHERE version=4`); }
    catch (cause) { await this.close(); throw new OwnerControlError('owner store unavailable or schema not v4', 'OWNER_STORE_UNAVAILABLE', { cause }); }
    return this;
  }
  async close() { const pool = this.#pool; this.#pool = undefined; if (pool) await pool.end(); }
  #ready() { if (!this.#pool) throw new OwnerControlError('owner store unavailable', 'OWNER_STORE_UNAVAILABLE'); return this.#pool; }
  async transaction(callback) {
    const client = await this.#ready().connect();
    try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value; }
    catch (cause) { await client.query('ROLLBACK').catch(() => {}); if (cause instanceof OwnerControlError) throw cause; throw new OwnerControlError('owner transaction failed', 'OWNER_STORE_UNAVAILABLE', { cause }); }
    finally { client.release(); }
  }
  async acceptCommand(command, effect) {
    return this.transaction(async (client) => {
      const existing = await client.query(`SELECT * FROM ${S}.owner_command WHERE command_id=$1 FOR UPDATE`, [command.command_id]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_digest !== command.payload_digest) throw new OwnerControlError('command id semantic conflict', 'OWNER_COMMAND_CONFLICT');
        return row(existing.rows[0]);
      }
      await client.query(`INSERT INTO ${S}.owner_command
        (command_id,actor_id,client_kind,operation,project_id,target_id,expected_revision,payload,payload_digest,status,canonical_result,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'ACCEPTED','{}'::jsonb,NULL)`,
      [command.command_id, command.actor_id, command.client_kind, command.operation, command.project_id, command.target_id, command.expected_revision, JSON.stringify(command.payload), command.payload_digest]);
      const canonical = await effect(client);
      const completed = await client.query(`UPDATE ${S}.owner_command SET status='COMPLETED',canonical_result=$2::jsonb,completed_at=statement_timestamp(),revision=revision+1 WHERE command_id=$1 RETURNING *`, [command.command_id,JSON.stringify(canonical)]);
      return row(completed.rows[0]);
    });
  }
  async beginCommand(command) {
    return this.transaction(async (client) => {
      const existing=await client.query(`SELECT * FROM ${S}.owner_command WHERE command_id=$1 FOR UPDATE`,[command.command_id]);
      if(existing.rows[0]){if(existing.rows[0].payload_digest!==command.payload_digest)throw new OwnerControlError('command id semantic conflict','OWNER_COMMAND_CONFLICT');return row(existing.rows[0]);}
      const q=await client.query(`INSERT INTO ${S}.owner_command(command_id,actor_id,client_kind,operation,project_id,target_id,expected_revision,payload,payload_digest,status,canonical_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'ACCEPTED','{}'::jsonb) RETURNING *`,[command.command_id,command.actor_id,command.client_kind,command.operation,command.project_id,command.target_id,command.expected_revision,JSON.stringify(command.payload),command.payload_digest]);return row(q.rows[0]);
    });
  }
  async completeCommand(commandId,canonical) { const q=await this.#ready().query(`UPDATE ${S}.owner_command SET status='COMPLETED',canonical_result=$2::jsonb,completed_at=statement_timestamp(),revision=revision+1 WHERE command_id=$1 AND status='ACCEPTED' RETURNING *`,[commandId,JSON.stringify(canonical)]);if(q.rows[0])return row(q.rows[0]);const existing=await this.#ready().query(`SELECT * FROM ${S}.owner_command WHERE command_id=$1`,[commandId]);if(!existing.rows[0])throw new OwnerControlError('command missing','OWNER_COMMAND_NOT_FOUND');return row(existing.rows[0]); }
  async findMaterializedCommandByPmRunId(pmRunId) { const q=await this.#ready().query(`SELECT * FROM ${S}.owner_command WHERE operation='SUBMIT_TASK' AND status='COMPLETED' AND canonical_result->>'pm_run_id'=$1 ORDER BY created_at,command_id LIMIT 1`,[pmRunId]);return row(q.rows[0]); }
  async getCommand(commandId){return row((await this.#ready().query(`SELECT * FROM ${S}.owner_command WHERE command_id=$1`,[commandId])).rows[0]);}
  async createInteraction(value) {
    const v = normalizeInteraction(value);
    return this.transaction(async (client) => {
      const q = await client.query(`INSERT INTO ${S}.owner_interaction
        (interaction_id,project_id,task_id,pm_run_id,pm_turn_index,origin,kind,status,title,prompt_text,allowed_responses,runtime_facts,response_bindings,requires_response,local_only,supersedes_interaction_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)
        ON CONFLICT (interaction_id) DO NOTHING RETURNING *`, [v.interaction_id,v.project_id,v.task_id??null,v.pm_run_id??null,v.pm_turn_index??null,v.origin,v.kind,v.status,v.title,v.prompt_text,JSON.stringify(v.allowed_responses),JSON.stringify(v.runtime_facts),JSON.stringify(v.response_bindings),v.requires_response,v.local_only??false,v.supersedes_interaction_id??null]);
      if (q.rows[0]) return row(q.rows[0]);
      const existing = await client.query(`SELECT * FROM ${S}.owner_interaction WHERE interaction_id=$1`, [v.interaction_id]);
      const found=row(existing.rows[0]);
      const wanted={project_id:v.project_id,task_id:v.task_id??null,pm_run_id:v.pm_run_id??null,pm_turn_index:v.pm_turn_index??null,origin:v.origin,kind:v.kind,title:v.title,prompt_text:v.prompt_text,allowed_responses:v.allowed_responses,runtime_facts:v.runtime_facts,requires_response:v.requires_response,local_only:v.local_only??false};
      const actual={project_id:found.project_id,task_id:found.task_id,pm_run_id:found.pm_run_id,pm_turn_index:found.pm_turn_index,origin:found.origin,kind:found.kind,title:found.title,prompt_text:found.prompt_text,allowed_responses:found.allowed_responses,runtime_facts:found.runtime_facts,requires_response:found.requires_response,local_only:found.local_only};
      if(stableJson(actual)!==stableJson(wanted))throw new OwnerControlError('interaction id semantic conflict','OWNER_INTERACTION_CONFLICT');
      return found;
    });
  }
  async getInteraction(id, client = this.#ready()) { return row((await client.query(`SELECT * FROM ${S}.owner_interaction WHERE interaction_id=$1`, [id])).rows[0]); }
  async decide(client, { interactionId, commandId, actorId, expectedRevision, selectedResponse, responseText, decisionId }) {
    const locked = await client.query(`SELECT * FROM ${S}.owner_interaction WHERE interaction_id=$1 FOR UPDATE`, [interactionId]); const current = locked.rows[0];
    if (!current) throw new OwnerControlError('interaction not found', 'INTERACTION_NOT_FOUND');
    if (current.status !== 'OPEN' || Number(current.revision) !== expectedRevision) throw new OwnerControlError('interaction is stale', 'STALE_INTERACTION');
    if (selectedResponse && !current.allowed_responses.includes(selectedResponse)) throw new OwnerControlError('response is not allowed', 'RESPONSE_REFUSED');
    await client.query(`INSERT INTO ${S}.owner_decision (decision_id,interaction_id,command_id,selected_response,response_text,interaction_revision,decided_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [decisionId,interactionId,commandId,selectedResponse??null,responseText??null,expectedRevision,actorId]);
    await client.query(`UPDATE ${S}.owner_interaction SET status='DECIDED',decided_at=statement_timestamp(),revision=revision+1 WHERE interaction_id=$1`, [interactionId]);
    return { interaction_id: interactionId, decision_id: decisionId, status: 'DECIDED' };
  }
  async closeOpenInteractionForTaskCancellation(client,{interactionId,expectedRevision,taskId,projectId}) {
    const locked=await client.query(`SELECT i.*,w.work_item_id,w.pm_run_id AS work_pm_run_id,w.claim_state,w.claim_eligible,w.parked_interaction_id
      FROM ${S}.owner_interaction i
      LEFT JOIN ${S}.work_items w ON w.parked_interaction_id=i.interaction_id
      WHERE i.interaction_id=$1 FOR UPDATE OF i`,[interactionId]);
    const current=locked.rows[0];
    if(!current)throw new OwnerControlError('interaction not found','INTERACTION_NOT_FOUND');
    if(current.status!=='OPEN'||Number(current.revision)!==expectedRevision)throw new OwnerControlError('interaction is stale','STALE_INTERACTION');
    if(!current.allowed_responses.includes('CANCEL'))throw new OwnerControlError('response is not allowed','RESPONSE_REFUSED');
    if(current.project_id!==projectId||current.task_id!==taskId||!current.work_item_id||current.pm_run_id!==current.work_pm_run_id||current.claim_state!=='RELEASED'||current.claim_eligible!==false||current.parked_interaction_id!==interactionId){
      throw new OwnerControlError('task and interaction lineage do not match','INTERACTION_TASK_MISMATCH');
    }
    const updated=await client.query(`UPDATE ${S}.owner_interaction SET status='CLOSED',revision=revision+1 WHERE interaction_id=$1 AND status='OPEN' AND revision=$2 RETURNING *`,[interactionId,expectedRevision]);
    if(!updated.rows[0])throw new OwnerControlError('interaction is stale','STALE_INTERACTION');
    return row(updated.rows[0]);
  }
  async listInbox({ limit = 50 } = {}) { const q = await this.#ready().query(`SELECT * FROM ${S}.owner_interaction WHERE status='OPEN' ORDER BY created_at,interaction_id LIMIT $1`, [Math.min(100, Math.max(1, limit))]); return q.rows.map(row); }
  async listDecidedAwaitingResumption({ limit = 20 } = {}) { const q=await this.#ready().query(`SELECT i.*,w.work_item_id FROM ${S}.owner_interaction i JOIN ${S}.work_items w ON w.parked_interaction_id=i.interaction_id WHERE i.status='DECIDED' AND w.claim_eligible=false AND w.claim_state='RELEASED' ORDER BY i.decided_at,i.interaction_id LIMIT $1`,[Math.min(100,Math.max(1,limit))]);return q.rows.map(row); }
  // P12-R5D Part B/C/E: the SAME shape as listDecidedAwaitingResumption()
  // above (a parked, claim-ineligible/released work item whose interaction
  // needs a state transition before the worker can resume it) — for a task
  // whose owner requested cancellation while it was parked AWAIT_OWNER
  // instead of ever being decided. `cancellation_requests` already exists
  // (coordination-migrations.mjs, R5C's requestCancellation() already
  // writes it) — this is its first real consumer for a PM_ACTION work
  // item. OPEN rows are closed here for generic task cancellation; CLOSED
  // rows from the revision-guarded approval action still need their parked
  // work item restored. The restore operation is itself idempotent, so a
  // settled interaction stops matching once claim_eligible becomes true.
  async listCancelledInteractionsAwaitingClosure({ limit = 20 } = {}) { const q=await this.#ready().query(`SELECT i.*,w.work_item_id FROM ${S}.owner_interaction i JOIN ${S}.work_items w ON w.parked_interaction_id=i.interaction_id JOIN ${S}.cancellation_requests c ON c.work_item_id=w.work_item_id WHERE i.status IN ('OPEN','CLOSED') AND w.claim_eligible=false AND w.claim_state='RELEASED' AND c.state='REQUESTED' ORDER BY i.created_at,i.interaction_id LIMIT $1`,[Math.min(100,Math.max(1,limit))]);return q.rows.map(row); }
  // P12-R5D Part C: 'CLOSED' is an existing, canonical owner_interaction
  // terminal status (coordination-migrations.mjs's CHECK constraint —
  // OPEN/DECIDED/SUPERSEDED/CLOSED already existed; no schema change).
  // Revision-guarded and `WHERE status='OPEN'`-gated exactly like decide()
  // above, so a second call for an already-closed interaction is a safe,
  // observable no-op (Part I) rather than an error.
  async closeInteractionForCancellation(interactionId) { const q=await this.#ready().query(`UPDATE ${S}.owner_interaction SET status='CLOSED',revision=revision+1 WHERE interaction_id=$1 AND status='OPEN' RETURNING *`,[interactionId]); return q.rows[0]?row(q.rows[0]):null; }
  async readDecision(interactionId) { return row((await this.#ready().query(`SELECT * FROM ${S}.owner_decision WHERE interaction_id=$1`, [interactionId])).rows[0]); }
  async resolveCallbackDigest(digest) { const q=await this.#ready().query(`SELECT i.*,b.key AS callback_response FROM ${S}.owner_interaction i CROSS JOIN LATERAL jsonb_each_text(i.response_bindings) b WHERE b.value=$1 AND i.status='OPEN'`,[digest]);if(q.rowCount!==1)throw new OwnerControlError('callback is invalid or stale','STALE_CALLBACK');return row(q.rows[0]); }
  async claimNotifications({ limit = 20, leaseMs = 30000, terminal = false } = {}) { const filter=terminal?`runtime_facts->>'notification_kind'='TERMINAL_PM_RESULT'`:`COALESCE(runtime_facts->>'notification_kind','')<>'TERMINAL_PM_RESULT'`;return this.transaction(async (c) => (await c.query(`WITH picked AS (SELECT interaction_id FROM ${S}.owner_interaction WHERE notified_at IS NULL AND ${filter} AND (notification_lease_until IS NULL OR notification_lease_until<=statement_timestamp()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE ${S}.owner_interaction i SET notification_lease_until=statement_timestamp()+($2::bigint*interval '1 millisecond'),notification_attempts=notification_attempts+1 FROM picked WHERE i.interaction_id=picked.interaction_id RETURNING i.*`, [limit,leaseMs])).rows.map(row)); }
  async markNotified(id) { await this.#ready().query(`UPDATE ${S}.owner_interaction SET notified_at=statement_timestamp(),notification_lease_until=NULL WHERE interaction_id=$1`, [id]); }
}
