import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// W2-O: local, GUI-only operational evidence about whether a PM profile's
// authentication has ever been demonstrated to work. This is explicitly
// NOT provider auth truth and NEVER stores credentials — only a state, a
// timestamp, and (for FAILED) a short, already-sanitized reason string.
// Default for anything not recorded here is UNKNOWN; nothing in this store
// can ever produce FAILED from a mere `--version`/install probe, and
// nothing here is consulted by canonical DSH execution — it is read-only
// evidence for the Connection Center display.

export type AuthEvidenceState = 'PROVEN' | 'FAILED';

export interface AuthEvidenceRecord {
  profile_id: string;
  product: string;
  state: AuthEvidenceState;
  timestamp: string;
  reason: string | null;
}

export class AuthEvidenceStore {
  private db: Database.Database;

  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const dbPath = path.join(userDataDir, 'dsh-desktop-auth-evidence.sqlite');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pm_auth_evidence (
        profile_id TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        state TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reason TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  recordProven(profileId: string, product: string): void {
    this.upsert(profileId, product, 'PROVEN', null);
  }

  // Only a clearly auth-classified failure (see
  // src/orchestration/execution-failure-classifier.mjs's AUTH rule) may
  // call this. An ordinary inference/protocol/config/runtime failure must
  // never reach here.
  recordFailed(profileId: string, product: string, reason: string): void {
    this.upsert(profileId, product, 'FAILED', reason.slice(0, 256));
  }

  get(profileId: string): AuthEvidenceRecord | undefined {
    return this.db.prepare(`SELECT * FROM pm_auth_evidence WHERE profile_id = ?`).get(profileId) as AuthEvidenceRecord | undefined;
  }

  list(): AuthEvidenceRecord[] {
    return this.db.prepare(`SELECT * FROM pm_auth_evidence`).all() as AuthEvidenceRecord[];
  }

  // Deleting local evidence simply returns that profile to UNKNOWN — there
  // is nothing else it could mean, since this store holds no secrets.
  clear(profileId: string): void {
    this.db.prepare(`DELETE FROM pm_auth_evidence WHERE profile_id = ?`).run(profileId);
  }

  clearAll(): void {
    this.db.exec(`DELETE FROM pm_auth_evidence`);
  }

  private upsert(profileId: string, product: string, state: AuthEvidenceState, reason: string | null): void {
    const timestamp = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pm_auth_evidence (profile_id, product, state, timestamp, reason) VALUES (@profile_id, @product, @state, @timestamp, @reason)
         ON CONFLICT(profile_id) DO UPDATE SET product = @product, state = @state, timestamp = @timestamp, reason = @reason`,
      )
      .run({ profile_id: profileId, product, state, timestamp, reason });
  }
}
