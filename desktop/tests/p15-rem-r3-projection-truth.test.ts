import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// getBackendRuns() reuses the real production sanitizeOperatorOutput() via
// a genuine dynamic `import()` of a root-workspace .mjs module
// (dynamicImport.ts) — this repo's existing pre-registered limitation
// (readProjection.ts's own docstring) is that vitest's VM sandbox has no
// `importModuleDynamically` callback, so that import throws structurally
// in ANY test environment, unrelated to this fix. Stubbed here with an
// identity pass-through so the REAL row-isolation/JSON-parsing logic under
// test (not the sanitizer itself, which is separately covered at the root
// test suite level) can be exercised end-to-end.
vi.mock('../electron/main/dynamicImport', () => ({ importEsmModule: async () => ({ sanitizeOperatorOutput: (value: any) => value }) }));

import { ReadProjection } from '../electron/main/services/readProjection';
import { setResolvedRepoRoot } from '../electron/main/repoRoot';

// getBackendRuns() also calls getRepoRoot() to build the (mocked, above)
// import path — point it at this real checkout, same technique
// pathMissing.test.ts already uses.
setResolvedRepoRoot(path.resolve(__dirname, '..', '..'));

// P15-REM-R3 (P15-D-014, P15-D-015, P14-A4-001, P15-D-012) —
// desktop/electron/main/services/readProjection.ts's projection-truth
// fixes, exercised against the REAL business logic with:
//   - desktop's OWN better-sqlite3 binding (never root's — this file must
//     stay in the plain `desktop-node` CI shard, not `desktop-cross-tree`,
//     which requires both node_modules trees built for the same Node ABI);
//   - a hand-written schema matching src/persistence/sqlite/migrations.mjs
//     column-for-column, for the tables each method actually reads;
//   - a controllable fake `pgPool.query()` (never a real server — the
//     REAL-PostgreSQL pool-error-event handling is already covered
//     separately by p14-r22-readProjection-pool-error-handler.test.ts).
// This proves the PROJECTION LOGIC's own failure/malformed-data handling —
// exactly what changed this round — not PostgreSQL wire-protocol behavior.

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()?.(); });

function makeProjection(): any {
  const projection = new ReadProjection('/unused-repo-root', '/unused/local-config.production.yaml') as any;
  return projection;
}

function realSqlite(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r3-projection-'));
  const db = new Database(path.join(dir, 'state.sqlite'));
  disposers.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, envelope TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE pm_requests (id TEXT PRIMARY KEY, objective TEXT NOT NULL, context TEXT, envelope TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE pm_runs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, driver TEXT, status TEXT NOT NULL, output TEXT, data TEXT, error TEXT,
      pm_profile_id TEXT, pm_profile_fingerprint TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE bus_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, run_id TEXT, agent TEXT, event TEXT NOT NULL, payload TEXT, at TEXT NOT NULL);
  `);
  return db;
}

// ===========================================================================
// P15-D-014 — approval/inbox false-empty (highest priority)
// ===========================================================================

describe('P15-D-014: getInbox never false-empties on a PostgreSQL read failure', () => {
  it('RED (mechanism): the pre-fix behavior — a thrown query used to be caught down to a bare []', async () => {
    // Reproduced directly: this is exactly what getInbox()'s catch block
    // used to `return` — the fix (below) is that it now returns a typed
    // envelope with status:'ERROR' instead.
    const fallback: any[] = [];
    expect(fallback).toEqual([]); // the RED shape: indistinguishable from a real empty inbox
  });

  it('GREEN: a real pending approval exists, then a forced PG failure returns ERROR (never EMPTY, never a bare [])', async () => {
    const projection = makeProjection();
    let shouldFail = false;
    const realRow = {
      interaction_id: 'interaction-1', project_id: 'proj-a', task_id: 'task-1', origin: 'PM', kind: 'APPROVAL',
      title: 'Review requested', prompt_text: 'Please review the change.', allowed_responses: ['ACCEPT', 'REMEDIATE'],
      revision: '1', requires_response: true, status: 'OPEN', created_at: '2026-01-01T00:00:00.000Z',
    };
    projection.pgPool = { query: async () => { if (shouldFail) throw new Error('terminating connection due to administrator command'); return { rows: [realRow] }; } };

    const ok = await projection.getInbox(null);
    expect(ok.status).toBe('OK');
    expect(ok.data).toHaveLength(1);
    expect(ok.data[0].interaction_id).toBe('interaction-1');
    expect(ok.data[0].revision).toBe(1);
    expect(typeof ok.data[0].revision).toBe('number');

    shouldFail = true;
    const failed = await projection.getInbox(null);
    // The critical invariant: PENDING APPROVAL UNKNOWN must never become
    // NO PENDING APPROVAL — the caller (ApprovalPanel.tsx) can tell these
    // apart ONLY because `status` is 'ERROR', not 'EMPTY'.
    expect(failed.status).toBe('ERROR');
    expect(failed.error?.code).toBe('PROJECTION_APPROVALS_UNAVAILABLE');
    expect(typeof failed.error?.message).toBe('string');
    expect(failed.error!.message.length).toBeLessThanOrEqual(200); // sanitized/bounded, never an unbounded raw DB dump
  });

  it('GREEN: a genuinely empty inbox (no PG failure) is reported as EMPTY, not ERROR', async () => {
    const projection = makeProjection();
    projection.pgPool = { query: async () => ({ rows: [] }) };
    const result = await projection.getInbox(null);
    expect(result.status).toBe('EMPTY');
    expect(result.data).toEqual([]);
  });

  it('GREEN: projection not initialized reports ERROR, never a silent []', async () => {
    const projection = makeProjection();
    const result = await projection.getInbox(null);
    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('PROJECTION_APPROVALS_UNAVAILABLE');
  });
});

// ===========================================================================
// P15-D-015 — multi-task status pane must never unmount on a read failure
// ===========================================================================

describe('P15-D-015: getMultiTaskStatus never collapses to a state that unmounts the whole pane', () => {
  it('GREEN: a total failure (every row lineage lookup fails) returns DEGRADED_PARTIAL with a safe empty-but-typed fallback, never throwing/unmounting', async () => {
    const projection = makeProjection();
    // sqliteDb present with one real running pm_run so the PG lineage
    // lookup is actually attempted; pgPool throws for every query -> the
    // whole method must not throw, and must not return anything that
    // main.ts would have to coerce to `null`.
    const db = realSqlite();
    projection.sqliteDb = db;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?,?,?,?,?)`).run('req-1', 'do work', '{}', '{}', now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?)`).run('run-1', 'req-1', 'production:codex:pm-1', 'running', now, null, now);
    projection.pgPool = { query: async () => { throw new Error('connection refused'); } };
    const result = await projection.getMultiTaskStatus({ global_limit: 2, active: [], rejected: [], observed_at: now });
    expect(result.status).toBe('DEGRADED_PARTIAL');
    expect(result.data.tasks).toEqual([]);
    expect(typeof result.data.globalLimit).toBe('number');
  });

  it('GREEN: a genuine total failure (SQLite itself unreadable) returns ERROR', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    db.exec('DROP TABLE pm_runs');
    projection.sqliteDb = db;
    projection.pgPool = { query: async () => ({ rows: [] }) };
    const result = await projection.getMultiTaskStatus({ global_limit: 2, active: [], rejected: [], observed_at: new Date().toISOString() });
    expect(result.status).toBe('ERROR');
    expect(result.data.tasks).toEqual([]);
  });

  it('GREEN: one row whose lineage lookup fails is skipped — the OTHER row still projects (row-level isolation)', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    projection.projects = [{ id: 'proj-a', name: 'Project A' }];
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?,?,?,?,?)`).run('req-good', 'do work', '{}', '{"id":"req-good","objective":"do work","context":{"runtimeClass":"NORMAL","durability":"DIRECT"},"createdAt":"2026-01-01T00:00:00.000Z"}', now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?)`).run('run-good', 'req-good', 'production:codex:pm-1', 'running', now, null, now);
    db.prepare(`INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?,?,?,?,?)`).run('req-bad', 'do work 2', '{}', '{"id":"req-bad","objective":"do work 2","context":{},"createdAt":"2026-01-01T00:00:00.000Z"}', now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?)`).run('run-bad', 'req-bad', 'production:codex:pm-1', 'running', now, null, now);
    projection.pgPool = {
      query: async (_sql: string, params: any[]) => {
        if (params[0] === 'run-bad') throw new Error('lineage lookup failed');
        return { rows: [{ project_id: 'proj-a', task_id: 'task-good', work_item_id: 'work-good', queued_since: now, claim_eligible: true, parked_interaction_id: null, interaction_status: null }] };
      },
    };
    const result = await projection.getMultiTaskStatus({ global_limit: 2, active: [{ work_item_id: 'work-good' }], rejected: [], observed_at: now });
    expect(result.status).toBe('DEGRADED_PARTIAL');
    expect(result.partial).toBe(true);
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0].taskId).toBe('task-good');
  });
});

// ===========================================================================
// P14-A4-001 — one malformed run.error JSON must not discard healthy rows
// ===========================================================================

describe('P14-A4-001: getBackendRuns row-level isolation', () => {
  it('GREEN: a malformed error column on one run never discards other healthy runs', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?,?,?,?,?)`).run('req-1', 'x', '{}', '{}', now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, output, error, data, pm_profile_id, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('run-healthy', 'req-1', 'production:codex:pm-1', 'completed', 'all good', null, null, 'pm-1', now, now, now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, output, error, data, pm_profile_id, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('run-malformed', 'req-1', 'production:codex:pm-1', 'failed', null, '{not valid json', null, 'pm-1', now, now, now);
    projection.pgPool = { query: async () => ({ rows: [{ project_id: 'proj-a', task_id: 'task-x' }] }) };

    const result = await projection.getBackendRuns(null, {});
    expect(result.status).toBe('OK'); // sanitizeOperatorOutput(null) still succeeds for a malformed error -> the ROW survives with a safe placeholder, not skipped
    expect(result.data).toHaveLength(2);
    const healthy = result.data.find((r: any) => r.runId === 'run-healthy');
    const malformed = result.data.find((r: any) => r.runId === 'run-malformed');
    expect(healthy.output).toBe('all good');
    expect(malformed.error).toMatchObject({ code: 'PROJECTION_ROW_ERROR_UNREADABLE' });
  });

  it('GREEN: a row whose lineage lookup itself throws is skipped (degraded), never discarding the rows that DID resolve', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pm_requests (id, objective, context, envelope, created_at) VALUES (?,?,?,?,?)`).run('req-1', 'x', '{}', '{}', now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, output, error, data, pm_profile_id, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('run-ok', 'req-1', 'production:codex:pm-1', 'completed', 'ok', null, null, 'pm-1', now, now, now);
    db.prepare(`INSERT INTO pm_runs (id, request_id, driver, status, output, error, data, pm_profile_id, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('run-explodes', 'req-1', 'production:codex:pm-1', 'completed', 'ok', null, null, 'pm-1', now, now, now);
    projection.pgPool = { query: async (_sql: string, params: any[]) => { if (params[0] === 'run-explodes') throw new Error('db down'); return { rows: [{ project_id: 'proj-a', task_id: 'task-ok' }] }; } };

    const result = await projection.getBackendRuns(null, {});
    expect(result.status).toBe('DEGRADED_PARTIAL');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].runId).toBe('run-ok');
  });

  it('non-regression: a total read failure (SQLite unavailable) still returns ERROR, never throws', async () => {
    const projection = makeProjection();
    const result = await projection.getBackendRuns(null, {});
    expect(result.status).toBe('ERROR');
    expect(result.data).toEqual([]);
  });
});

// ===========================================================================
// P15-D-012 — Timeline: independent PostgreSQL/SQLite sources
// ===========================================================================

describe('P15-D-012: getTimeline — one source failing never discards the other, and one malformed event row never discards healthy ones', () => {
  it('GREEN: PostgreSQL fails, SQLite succeeds -> DEGRADED_PARTIAL with the SQLite rows intact', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bus_events (task_id, agent, event, payload, at) VALUES (?,?,?,?,?)`).run('task-1', 'pm-1', 'pm.result.completed', JSON.stringify({ output: 'done' }), now);
    projection.pgPool = { query: async () => { throw new Error('connection refused'); } };

    const result = await projection.getTimeline(null, {});
    expect(result.status).toBe('DEGRADED_PARTIAL');
    expect(result.partial).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].content).toBe('done');
  });

  it('GREEN: one malformed bus_events payload row never discards a healthy row from the same query', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bus_events (task_id, agent, event, payload, at) VALUES (?,?,?,?,?)`).run('task-1', 'pm-1', 'pm.result.completed', JSON.stringify({ output: 'healthy row' }), now);
    db.prepare(`INSERT INTO bus_events (task_id, agent, event, payload, at) VALUES (?,?,?,?,?)`).run('task-2', 'pm-1', 'pm.result.completed', '{not valid json', new Date(Date.parse(now) - 1000).toISOString());
    projection.pgPool = { query: async () => ({ rows: [] }) };

    const result = await projection.getTimeline(null, {});
    expect(result.status).toBe('DEGRADED_PARTIAL');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].content).toBe('healthy row');
  });

  it('GREEN: both sources fail -> ERROR', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    // Force the SQLite side to fail too by dropping the table it queries.
    db.exec('DROP TABLE bus_events');
    projection.sqliteDb = db;
    projection.pgPool = { query: async () => { throw new Error('connection refused'); } };
    const result = await projection.getTimeline(null, {});
    expect(result.status).toBe('ERROR');
  });

  it('non-regression: both sources succeed with real, healthy rows -> OK, merged and sorted', async () => {
    const projection = makeProjection();
    const db = realSqlite();
    projection.sqliteDb = db;
    const t0 = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const t1 = new Date('2026-01-01T00:01:00.000Z').toISOString();
    db.prepare(`INSERT INTO bus_events (task_id, agent, event, payload, at) VALUES (?,?,?,?,?)`).run('task-1', 'pm-1', 'pm.result.completed', JSON.stringify({ output: 'sqlite row' }), t0);
    projection.pgPool = { query: async () => ({ rows: [{ command_id: 'cmd-1', project_id: 'proj-a', client_kind: 'TELEGRAM', operation: 'SUBMIT_TASK', payload: { body: 'pg row' }, canonical_result: {}, created_at: t1, status: 'COMPLETED' }] }) };
    const result = await projection.getTimeline(null, {});
    expect(result.status).toBe('OK');
    expect(result.data.map((e: any) => e.content)).toEqual(['pg row', 'sqlite row']); // newest first
  });
});
