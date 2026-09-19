import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { PmRepository, PmPersistenceError } from '../src/persistence/repositories/pm-repository.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { buildTaskOutcome, EXECUTION_STATUS } from '../src/pm/task-outcome-model.mjs';

// P12-R2 — recordTaskOutcome() persists the six-dimension outcome onto the
// ALREADY-EXISTING pm_runs.data column under a reserved `dsh_outcome` key —
// no schema migration — so it survives past the in-process return value and
// becomes visible to anything that later reads a terminal pm_run (Telegram's
// terminal notifier, Desktop's read projection).

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p12-r2-pmrun-outcome-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'x.db') });
    await store.migrate();
    await fn(new PmRepository({ store }));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('recordTaskOutcome merges dsh_outcome into pm_runs.data without touching any existing field', () => withRepo(async (pm) => {
  const request = createPmRequest({ objective: 'do a thing', context: {} });
  await pm.create(request, { id: 'pmrun-1', driver: 'fake', startedAt: '2026-01-01T00:00:00.000Z' });
  pm.completeRun('pmrun-1', { status: 'completed', output: 'done', data: { type: 'single_result', custom_field: 'preserved' }, error: null, completedAt: '2026-01-01T00:01:00.000Z' });

  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED });
  pm.recordTaskOutcome('pmrun-1', outcome);

  const loaded = pm.load('pmrun-1');
  assert.equal(loaded.data.type, 'single_result');
  assert.equal(loaded.data.custom_field, 'preserved', 'a backend-authored field must never be clobbered');
  assert.deepEqual(loaded.data.dsh_outcome, outcome);
}));

test('recordTaskOutcome works even when the run had no prior data (SINGLE tasks with data:null)', () => withRepo(async (pm) => {
  const request = createPmRequest({ objective: 'do a thing', context: {} });
  await pm.create(request, { id: 'pmrun-2', driver: 'fake', startedAt: '2026-01-01T00:00:00.000Z' });
  pm.completeRun('pmrun-2', { status: 'completed', output: 'done', data: null, error: null, completedAt: '2026-01-01T00:01:00.000Z' });

  const outcome = buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED });
  pm.recordTaskOutcome('pmrun-2', outcome);

  const loaded = pm.load('pmrun-2');
  assert.deepEqual(loaded.data, { dsh_outcome: outcome });
}));

test('recordTaskOutcome never touches status/output/error/completed_at', () => withRepo(async (pm) => {
  const request = createPmRequest({ objective: 'do a thing', context: {} });
  await pm.create(request, { id: 'pmrun-3', driver: 'fake', startedAt: '2026-01-01T00:00:00.000Z' });
  pm.completeRun('pmrun-3', { status: 'failed', output: 'partial', data: { type: 'x' }, error: { name: 'Error', message: 'boom', code: 'X' }, completedAt: '2026-01-01T00:01:00.000Z' });

  pm.recordTaskOutcome('pmrun-3', buildTaskOutcome({ executionStatus: EXECUTION_STATUS.FAILED }));

  const loaded = pm.load('pmrun-3');
  assert.equal(loaded.status, 'failed');
  assert.equal(loaded.output, 'partial');
  assert.deepEqual(loaded.error, { name: 'Error', message: 'boom', code: 'X' });
  assert.equal(loaded.completedAt, '2026-01-01T00:01:00.000Z');
}));

test('recordTaskOutcome on an unknown pm_run throws a typed error, never a silent no-op', () => withRepo(async (pm) => {
  assert.throws(
    () => pm.recordTaskOutcome('no-such-run', buildTaskOutcome({ executionStatus: EXECUTION_STATUS.PASSED })),
    (e) => e instanceof PmPersistenceError && e.code === 'UNKNOWN_PM_RUN',
  );
}));
