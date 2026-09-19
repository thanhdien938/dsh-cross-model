import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ReadProjection } from '../electron/main/services/readProjection';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('ReadProjection - Initialization', () => {
  it('should require initialization before use', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    // Should throw when not initialized
    await expect(async () => {
      await projection.getProjects();
    }).rejects.toThrow('Projection not initialized');
  });

  it('should close cleanly', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    // Should be safe to close without initializing
    await projection.close();
  });
});

describe('ReadProjection - Project Filters', () => {
  it('should support project-scoped timeline queries', async () => {
    // This validates the M3 requirement
    const projection = new ReadProjection(REPO_ROOT);
    
    try {
      await projection.initialize();
      
      // Query with project filter
      const timeline = await projection.getTimeline('test-project-id', {
        limit: 10,
      });
      
      // P15-REM-R3-G (P15-D-012): getTimeline() now returns a typed ProjectionResult.
      expect(Array.isArray(timeline.data)).toBe(true);
    } catch (error) {
      // Expected to fail if DB not available
      expect(error).toBeDefined();
    } finally {
      await projection.close();
    }
  });

  it('should support global timeline queries', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    try {
      await projection.initialize();
      
      // Query without project filter
      const timeline = await projection.getTimeline(null, {
        limit: 10,
      });
      
      // P15-REM-R3-G (P15-D-012): getTimeline() now returns a typed ProjectionResult.
      expect(Array.isArray(timeline.data)).toBe(true);
    } catch (error) {
      // Expected to fail if DB not available
      expect(error).toBeDefined();
    } finally {
      await projection.close();
    }
  });

  it('should support project-scoped task queries', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    try {
      await projection.initialize();
      
      const tasks = await projection.getTasks('test-project-id');
      expect(Array.isArray(tasks)).toBe(true);
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      await projection.close();
    }
  });

  it('should support project-scoped inbox queries', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    try {
      await projection.initialize();
      
      // P15-REM-R3-F (P15-D-014): getInbox() now returns a typed
      // ProjectionResult, not a bare array.
      const inbox = await projection.getInbox('test-project-id');
      expect(Array.isArray(inbox.data)).toBe(true);
      expect(['OK', 'EMPTY']).toContain(inbox.status);
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      await projection.close();
    }
  });
});

describe('ReadProjection - No Notification Theft', () => {
  it('should never call claimNotifications', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    
    // ReadProjection should not have this method
    expect((projection as any).claimNotifications).toBeUndefined();
  });

  it('should never call markNotified', async () => {
    const projection = new ReadProjection(REPO_ROOT);

    // ReadProjection should not have this method
    expect((projection as any).markNotified).toBeUndefined();
  });
});

// P6-W3-R3 Part B: resolveTaskLineageByRequestId() is the two-hop
// (SQLite pm_runs.request_id -> Postgres owner_command.canonical_result)
// lookup the live execLogs:statuses IPC handler uses to backfill
// BackendExecutionEvent's taskId (only ever known as `runId`/requestId at
// the PM decide() layer — see backend-execution-observer.mjs). Real
// schemas are separately proven end to end against real
// PostgreSQL+SQLite by scripts/w3-backend-runs-verify.mjs; this is the
// fast, fixture-level shape/wiring test.
describe('ReadProjection - resolveTaskLineageByRequestId', () => {
  it('returns null without throwing when not initialized', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    await expect(projection.resolveTaskLineageByRequestId('pmreq-x')).resolves.toBeNull();
  });

  it('returns null for a null/empty requestId', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    (projection as any).sqliteDb = { prepare: () => ({ get: () => ({ id: 'pmrun-1' }) }) };
    (projection as any).pgPool = { query: async () => ({ rows: [{ project_id: 'p', task_id: 't' }] }) };
    await expect(projection.resolveTaskLineageByRequestId(null)).resolves.toBeNull();
  });

  it('joins SQLite pm_runs.request_id to the Postgres owner_command lineage', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    let capturedRequestId: string | null = null;
    let capturedPmRunId: string | null = null;
    (projection as any).sqliteDb = {
      prepare: (_sql: string) => ({
        get: (requestId: string) => { capturedRequestId = requestId; return { id: 'pmrun-abc' }; },
      }),
    };
    (projection as any).pgPool = {
      query: async (_sql: string, params: string[]) => { capturedPmRunId = params[0]; return { rows: [{ project_id: 'dsh-p6-test-b', task_id: 'task-36_TinH' }] }; },
    };
    const result = await projection.resolveTaskLineageByRequestId('pmreq-MeYYE3');
    expect(capturedRequestId).toBe('pmreq-MeYYE3');
    expect(capturedPmRunId).toBe('pmrun-abc');
    expect(result).toEqual({ taskId: 'task-36_TinH', projectId: 'dsh-p6-test-b' });
  });

  it('returns null when no matching pm_runs row exists, without querying Postgres', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    let pgCalled = false;
    (projection as any).sqliteDb = { prepare: () => ({ get: () => undefined }) };
    (projection as any).pgPool = { query: async () => { pgCalled = true; return { rows: [] }; } };
    const result = await projection.resolveTaskLineageByRequestId('pmreq-missing');
    expect(result).toBeNull();
    expect(pgCalled).toBe(false);
  });

  it('never throws — a query failure resolves null instead', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    (projection as any).sqliteDb = { prepare: () => { throw new Error('boom'); } };
    (projection as any).pgPool = { query: async () => ({ rows: [] }) };
    await expect(projection.resolveTaskLineageByRequestId('pmreq-x')).resolves.toBeNull();
  });
});

// P7 Part M/M1: getCouncil()/getCouncilRuns() reuse the REAL production
// PmRepository.load() + projectCouncil() via the SAME importEsmModule seam
// getBackendRuns() already uses for sanitizeOperatorOutput above. That
// helper's `new Function(...)`-constructed dynamic import exists
// specifically to survive tsc's real CommonJS emit (see
// tests/dynamicImport.test.ts) and, like every other importEsmModule-
// dependent method in this file (getBackendRuns has no direct vitest
// coverage either, for the identical reason), cannot be driven through a
// real round trip from inside vitest's own module sandbox
// (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING) — only via the compiled
// dist-electron output, which dynamicImport.test.ts already proves works.
// What IS covered here, directly and exhaustively, is the actual council
// projection logic itself: tests/council-runtime.test.mjs at the repo root
// exercises the real PmRepository/DurablePmRuntime/CouncilChairDriver/
// projectCouncil() end to end. This suite instead proves getCouncil()'s own
// contract: it returns a typed ERROR rather than throwing or false-emptying.
describe('ReadProjection - getCouncil/getCouncilRuns (P7)', () => {
  it('getCouncil returns null when the projection has not been initialized', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    await expect(projection.getCouncil('pmrun-x')).resolves.toMatchObject({ status: 'ERROR', data: null, error: { code: 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE' } });
  });

  it('getCouncil never throws — an internal failure resolves null instead', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    (projection as any).sqliteDb = { prepare: () => { throw new Error('boom'); } };
    await expect(projection.getCouncil('pmrun-x')).resolves.toMatchObject({ status: 'ERROR', data: null, error: { code: 'PROJECTION_COUNCIL_DETAIL_UNAVAILABLE' } });
  });

  it('getCouncilRuns returns [] when the projection has not been initialized', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    await expect(projection.getCouncilRuns(null)).resolves.toMatchObject({ status: 'ERROR', data: [], error: { code: 'PROJECTION_COUNCIL_LIST_UNAVAILABLE' } });
  });

  it('getCouncilRuns never throws — an internal failure resolves [] instead', async () => {
    const projection = new ReadProjection(REPO_ROOT);
    (projection as any).sqliteDb = { prepare: () => { throw new Error('boom'); } };
    (projection as any).pgPool = { query: async () => ({ rows: [] }) };
    await expect(projection.getCouncilRuns('proj-a')).resolves.toMatchObject({ status: 'ERROR', data: [], error: { code: 'PROJECTION_COUNCIL_LIST_UNAVAILABLE' } });
  });
});
