import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Durable GUI-local owner outbox (W2-B). This store is NOT canonical DSH
// execution truth — it exists only to prevent unknown-outcome / duplicate
// task creation across GUI crash, renderer crash, Desktop restart, pipe
// disconnect, or response loss. It lives in a small isolated SQLite file
// outside the canonical PostgreSQL v4 / SQLite v6 stores and is never read
// by the runtime.

export type OutboxState =
  | 'PENDING'
  | 'SENDING'
  | 'AWAITING_ACK'
  | 'COMPLETED'
  | 'CONFLICT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_TERMINAL';

export interface OutboxRecord {
  client_message_id: string;
  command_id: string;
  operation: string;
  project_id: string | null;
  payload_json: string;
  payload_digest: string | null;
  created_at: string;
  updated_at: string;
  state: OutboxState;
  attempt_count: number;
  last_attempt_at: string | null;
  canonical_result_json: string | null;
  last_error_code: string | null;
}

export class OutboxStore {
  private db: Database.Database;

  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const dbPath = path.join(userDataDir, 'dsh-desktop-outbox.sqlite');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        client_message_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        project_id TEXT,
        payload_json TEXT NOT NULL,
        payload_digest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        canonical_result_json TEXT,
        last_error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_command_id ON outbox(command_id);
      CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state);
    `);
  }

  close(): void {
    this.db.close();
  }

  // The row is written BEFORE dispatch so a crash between "user clicked
  // send" and "pipe dispatch" leaves durable evidence of intent, not an
  // unknown outcome.
  createPending(input: { clientMessageId: string; commandId: string; operation: string; projectId: string | null; payload: unknown; payloadDigest?: string | null }): OutboxRecord {
    const now = new Date().toISOString();
    const record: OutboxRecord = {
      client_message_id: input.clientMessageId,
      command_id: input.commandId,
      operation: input.operation,
      project_id: input.projectId,
      payload_json: JSON.stringify(input.payload),
      payload_digest: input.payloadDigest ?? null,
      created_at: now,
      updated_at: now,
      state: 'PENDING',
      attempt_count: 0,
      last_attempt_at: null,
      canonical_result_json: null,
      last_error_code: null,
    };
    this.db
      .prepare(
        `INSERT INTO outbox (client_message_id, command_id, operation, project_id, payload_json, payload_digest, created_at, updated_at, state, attempt_count, last_attempt_at, canonical_result_json, last_error_code)
         VALUES (@client_message_id, @command_id, @operation, @project_id, @payload_json, @payload_digest, @created_at, @updated_at, @state, @attempt_count, @last_attempt_at, @canonical_result_json, @last_error_code)`,
      )
      .run(record);
    return record;
  }

  get(clientMessageId: string): OutboxRecord | undefined {
    return this.db.prepare(`SELECT * FROM outbox WHERE client_message_id = ?`).get(clientMessageId) as OutboxRecord | undefined;
  }

  markSending(clientMessageId: string): void {
    this.transitionAttempt(clientMessageId, 'SENDING');
  }

  markAwaitingAck(clientMessageId: string): void {
    this.transition(clientMessageId, 'AWAITING_ACK', {});
  }

  markCompleted(clientMessageId: string, canonicalResult: unknown): void {
    this.transition(clientMessageId, 'COMPLETED', { canonical_result_json: JSON.stringify(canonicalResult ?? null), last_error_code: null });
  }

  markConflict(clientMessageId: string, errorCode: string): void {
    this.transition(clientMessageId, 'CONFLICT', { last_error_code: errorCode });
  }

  markFailedRetryable(clientMessageId: string, errorCode: string): void {
    this.transition(clientMessageId, 'FAILED_RETRYABLE', { last_error_code: errorCode });
  }

  markFailedTerminal(clientMessageId: string, errorCode: string): void {
    this.transition(clientMessageId, 'FAILED_TERMINAL', { last_error_code: errorCode });
  }

  // Rows that have not reached a durable-safe terminal state (COMPLETED,
  // CONFLICT, FAILED_TERMINAL) are replayed on restart using the exact same
  // command_id and payload — never a freshly minted command_id.
  listIncomplete(): OutboxRecord[] {
    return this.db
      .prepare(`SELECT * FROM outbox WHERE state IN ('PENDING','SENDING','AWAITING_ACK','FAILED_RETRYABLE') ORDER BY created_at ASC`)
      .all() as OutboxRecord[];
  }

  listRecent(limit = 200): OutboxRecord[] {
    return this.db.prepare(`SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?`).all(limit) as OutboxRecord[];
  }

  // Retention: only rows that already reached COMPLETED and are older than
  // the retention window are compacted. Canonical tasks/history are never
  // touched — this only prunes local delivery-safety bookkeeping.
  compactCompleted(retentionMs: number): number {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = this.db.prepare(`DELETE FROM outbox WHERE state = 'COMPLETED' AND updated_at < ?`).run(cutoff);
    return result.changes;
  }

  private transitionAttempt(clientMessageId: string, state: OutboxState): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE outbox SET state = ?, updated_at = ?, last_attempt_at = ?, attempt_count = attempt_count + 1 WHERE client_message_id = ?`)
      .run(state, now, now, clientMessageId);
  }

  private transition(clientMessageId: string, state: OutboxState, fields: Record<string, string | null>): void {
    const now = new Date().toISOString();
    const keys = Object.keys(fields);
    const setClause = ['state = @state', 'updated_at = @updated_at', ...keys.map((k) => `${k} = @${k}`)].join(', ');
    this.db
      .prepare(`UPDATE outbox SET ${setClause} WHERE client_message_id = @client_message_id`)
      .run({ client_message_id: clientMessageId, state, updated_at: now, ...fields });
  }
}
