import { describe, it, expect } from 'vitest';
import { isCancellable, TERMINAL_RUN_STATUSES } from '../src/components/BackendRuns';
import type { BackendRun } from '../electron/main/types';

// P12-R5C Part D/J/L — `isCancellable()` is the ONE gate deciding whether
// BackendRuns.tsx offers a Cancel button for a given run. `run.status` is
// pm_runs.status VERBATIM (readProjection.ts's getBackendRuns()) — the same
// canonical column TERMINAL_RUN (src/persistence/repositories/pm-repository.mjs)
// checks. No second status vocabulary, no invented state names.
function run(overrides: Partial<BackendRun> = {}): BackendRun {
  return {
    runId: 'r1', product: 'claude-code', pmProfileId: 'pm-1', projectId: 'proj-armed',
    taskId: 'task-1', status: 'running', startedAt: null, completedAt: null, durationMs: null,
    output: null, error: null, ...overrides,
  };
}

describe('isCancellable — Part D: which states show Cancel', () => {
  it('4. RUNNING shows Cancel', () => {
    expect(isCancellable(run({ status: 'running' }), 'proj-armed')).toBe(true);
  });

  // Part D: AWAIT_OWNER/QUIET_RUNNING/STALLED are all refinements of a PM
  // run that is still not yet terminal — none of them change the top-level
  // pm_runs.status column away from 'running' (only the turn-level
  // decision/phase changes), so they are indistinguishable from RUNNING at
  // this projection and correctly show Cancel too — never a second,
  // invented status name.
  it('5. a run whose task is parked AWAIT_OWNER (still pm_runs.status=\'running\') shows Cancel, because the canonical runtime\'s own REQUEST_CANCEL path accepts it', () => {
    expect(isCancellable(run({ status: 'running' }), 'proj-armed')).toBe(true);
  });

  it('6. COMPLETED shows no Cancel', () => {
    expect(isCancellable(run({ status: 'completed' }), 'proj-armed')).toBe(false);
  });

  it('7. FAILED shows no Cancel', () => {
    expect(isCancellable(run({ status: 'failed' }), 'proj-armed')).toBe(false);
  });

  it('8. CANCELLED shows no Cancel', () => {
    expect(isCancellable(run({ status: 'cancelled' }), 'proj-armed')).toBe(false);
  });

  it('every terminal status in the canonical set is covered', () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isCancellable(run({ status }), 'proj-armed')).toBe(false);
    }
  });

  it('a run with no taskId (nothing to cancel) never shows Cancel, even if status looks non-terminal', () => {
    expect(isCancellable(run({ status: 'running', taskId: null }), 'proj-armed')).toBe(false);
  });

  it('a run belonging to a DIFFERENT (non-armed) project never shows Cancel, even if genuinely running', () => {
    expect(isCancellable(run({ status: 'running', projectId: 'some-other-project' }), 'proj-armed')).toBe(false);
  });

  it('no armed project at all -> never shows Cancel', () => {
    expect(isCancellable(run({ status: 'running' }), null)).toBe(false);
  });

  // Part H: Council's chair pm_run is a row in the SAME pm_runs table
  // (driver formatted "council:<chairProfileId>") — no separate Council
  // status vocabulary, so a Council task in flight is cancellable through
  // the exact same gate/control as a SINGLE task, satisfying "Cancel
  // Council at task/run level" without any participant-level kill button.
  it('13. an active Council run (driver="council:...") is cancellable through the exact same gate as SINGLE — no special-casing', () => {
    expect(isCancellable(run({ status: 'running', product: 'council:live1-claude-pm' }), 'proj-armed')).toBe(true);
  });

  it('a completed historical Council run is never cancellable (Part J)', () => {
    expect(isCancellable(run({ status: 'completed', product: 'council:live1-claude-pm' }), 'proj-armed')).toBe(false);
  });
});
