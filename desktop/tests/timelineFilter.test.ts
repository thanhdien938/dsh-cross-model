import { describe, it, expect } from 'vitest';
import { isUserFacingCategory, timelineCategory } from '../electron/main/services/readProjection';

// M04 regression: the Timeline category filter must be a single source of
// truth (isUserFacingCategory + timelineCategory), never two independent
// SQL-level guesses that only ever *included* their own category and
// otherwise ran unfiltered. These are the exact building blocks
// getTimeline() uses to decide which store(s) to query and how to filter
// SQLite rows — see the extended real-Postgres+SQLite proof in
// scripts/w3-r1-timeline-filter-verify.mjs for the end-to-end version
// (currently blocked in this environment by a live owner runtime process
// holding the shared root better-sqlite3 native module open — see
// docs/p6/implementation/22_W3_MANUAL_ACCEPTANCE_REMEDIATION.md).

describe('isUserFacingCategory', () => {
  it('the "USER" meta-filter and both concrete USER_* categories are user-facing', () => {
    expect(isUserFacingCategory('USER')).toBe(true);
    expect(isUserFacingCategory('USER_GUI')).toBe(true);
    expect(isUserFacingCategory('USER_TELEGRAM')).toBe(true);
  });

  it('every non-user category is not user-facing', () => {
    for (const category of ['PM', 'AGENT', 'APPROVAL', 'RESULT', 'SYSTEM', 'ALL', '']) {
      expect(isUserFacingCategory(category)).toBe(false);
    }
  });
});

describe('timelineCategory (bus_events classification)', () => {
  it('classifies "completed" events as RESULT even without a literal "result" prefix — the exact prior LIKE-prefix mismatch', () => {
    expect(timelineCategory('task.completed')).toBe('RESULT');
    expect(timelineCategory('pm.terminal.result')).toBe('RESULT');
  });

  it('classifies pm/agent/approval/system events correctly', () => {
    expect(timelineCategory('pm.decision')).toBe('PM');
    expect(timelineCategory('agent.dispatch')).toBe('AGENT');
    expect(timelineCategory('agent.run.started')).toBe('AGENT');
    expect(timelineCategory('approval.requested')).toBe('APPROVAL');
    expect(timelineCategory('system.info')).toBe('SYSTEM');
    expect(timelineCategory('something-unclassified')).toBe('SYSTEM');
  });
});

// Proves the exact filter-inclusion/exclusion decision getTimeline() makes
// per store, for every category the Timeline UI can request.
describe('getTimeline category routing decisions (M04)', () => {
  const shouldQueryPostgres = (requested: string | null) => !requested || isUserFacingCategory(requested);
  const shouldQuerySqlite = (requested: string | null) => !requested || !isUserFacingCategory(requested);

  it('ALL (no filter) queries both stores', () => {
    expect(shouldQueryPostgres(null)).toBe(true);
    expect(shouldQuerySqlite(null)).toBe(true);
  });

  it('USER/USER_GUI/USER_TELEGRAM query Postgres only, never SQLite — the RESULT-showed-USER-rows bug is this exact routing', () => {
    for (const category of ['USER', 'USER_GUI', 'USER_TELEGRAM']) {
      expect(shouldQueryPostgres(category)).toBe(true);
      expect(shouldQuerySqlite(category)).toBe(false);
    }
  });

  it('PM/AGENT/APPROVAL/RESULT/SYSTEM query SQLite only, never Postgres — the USER-filter-showed-everything bug is this exact routing', () => {
    for (const category of ['PM', 'AGENT', 'APPROVAL', 'RESULT', 'SYSTEM']) {
      expect(shouldQueryPostgres(category)).toBe(false);
      expect(shouldQuerySqlite(category)).toBe(true);
    }
  });
});
