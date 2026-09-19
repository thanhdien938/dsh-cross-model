import { describe, it, expect } from 'vitest';
import { BackendExecutionLogService, EXEC_LOG_SENTINEL, LONG_TASK_HARD_DEADLINE_MS } from '../electron/main/services/backendExecutionLogService';

function sentinelLine(event: Record<string, unknown>): string {
  return `${EXEC_LOG_SENTINEL} ${JSON.stringify(event)}\n`;
}

const LONG = { stage: 'single_pm_long' };
const NORMAL = { stage: 'single_pm' };

describe('BackendExecutionLogService long-task runtime projection (P10-R0.2.4.1)', () => {
  it('a NORMAL-stage event never creates a long-task projection entry (Part L)', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-normal', eventKind: 'PROCESS_SPAWN', pid: 1, ...NORMAL, message: 'x' }));
    expect(service.getLongTaskStates()).toHaveLength(0);
  });

  it('a LONG-stage PROCESS_SPAWN creates one entry with pid/startedAt/hardDeadlineMs', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({
      backendProduct: 'codex', taskId: 'task-long-1', pmRunId: 'pmrun-1', projectId: 'p', profileId: 'pm-9',
      eventKind: 'PROCESS_SPAWN', pid: 4242, timestamp: '2026-08-25T00:00:00.000Z', ...LONG, message: 'spawn',
    }));
    const states = service.getLongTaskStates();
    expect(states).toHaveLength(1);
    expect(states[0].taskId).toBe('task-long-1');
    expect(states[0].pid).toBe(4242);
    expect(states[0].startedAt).toBe('2026-08-25T00:00:00.000Z');
    expect(states[0].hardDeadlineMs).toBe(LONG_TASK_HARD_DEADLINE_MS);
    expect(states[0].liveness).toBeNull();
    expect(states[0].processExited).toBe(false);
  });

  it('a BACKEND_LIVENESS_STATE transition updates liveness/lastActivityKind/lastActivityAgeMs', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-2', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({
      backendProduct: 'codex', taskId: 'task-long-2', eventKind: 'BACKEND_LIVENESS_STATE',
      livenessFrom: 'ACTIVE', livenessTo: 'QUIET_RUNNING', lastActivityKind: 'STDOUT_CHUNK', lastActivityAgeMs: 20000,
      timestamp: '2026-08-25T00:01:00.000Z', ...LONG, message: 'liveness',
    }));
    const state = service.getLongTaskState('task-long-2');
    expect(state?.liveness).toBe('QUIET_RUNNING');
    expect(state?.lastActivityKind).toBe('STDOUT_CHUNK');
    expect(state?.lastActivityAgeMs).toBe(20000);
    expect(state?.snapshotAt).toBe('2026-08-25T00:01:00.000Z');
  });

  it('CODEX_SANDBOX updates sandboxState without disturbing liveness', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-3', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-3', eventKind: 'CODEX_SANDBOX', sandboxState: 'READY', ...LONG, message: 'sandbox' }));
    expect(service.getLongTaskState('task-long-3')?.sandboxState).toBe('READY');
  });

  it('a TIMEOUT event on the LONG stage marks hardDeadlineReached, distinct from STALLED', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-4', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({
      backendProduct: 'codex', taskId: 'task-long-4', eventKind: 'BACKEND_LIVENESS_STATE',
      livenessFrom: 'QUIET_RUNNING', livenessTo: 'STALLED', ...LONG, message: 'liveness',
    }));
    let state = service.getLongTaskState('task-long-4');
    expect(state?.liveness).toBe('STALLED');
    expect(state?.hardDeadlineReached).toBe(false);
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-4', eventKind: 'TIMEOUT', timeoutMs: LONG_TASK_HARD_DEADLINE_MS, ...LONG, message: 'timeout' }));
    state = service.getLongTaskState('task-long-4');
    expect(state?.hardDeadlineReached).toBe(true);
    // STALLED is not overwritten into some "HARD_DEADLINE" liveness value
    // — liveness and hardDeadlineReached stay two independent facts.
    expect(state?.liveness).toBe('STALLED');
  });

  it('PROCESS_EXIT marks processExited/liveness EXITED and records exitCode', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-5', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-5', eventKind: 'PROCESS_EXIT', exitCode: 0, ...LONG, message: 'exit' }));
    const state = service.getLongTaskState('task-long-5');
    expect(state?.processExited).toBe(true);
    expect(state?.liveness).toBe('EXITED');
    expect(state?.exitCode).toBe(0);
  });

  it('backend process exit status is a distinct fact from any canonical task status (Part S) — this service never claims completed/failed/await_owner', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-6', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-6', eventKind: 'PROCESS_EXIT', exitCode: 0, ...LONG, message: 'exit' }));
    const state = service.getLongTaskState('task-long-6');
    expect(Object.keys(state ?? {})).not.toContain('taskStatus');
    expect(Object.keys(state ?? {})).not.toContain('status');
  });

  it('never regresses an already-known identity field to null on a later event that omits it', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-7', profileId: 'pm-9', projectId: 'p', pmRunId: 'run-7', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-7', eventKind: 'BACKEND_LIVENESS_STATE', livenessTo: 'ACTIVE', ...LONG, message: 'liveness' }));
    const state = service.getLongTaskState('task-long-7');
    expect(state?.profileId).toBe('pm-9');
    expect(state?.projectId).toBe('p');
    expect(state?.pmRunId).toBe('run-7');
  });

  it('an unknown taskId lookup returns null, never throws', () => {
    const service = new BackendExecutionLogService();
    expect(service.getLongTaskState('does-not-exist')).toBeNull();
  });

  it('bounds the number of tracked long-task entries (oldest evicted first)', () => {
    const service = new BackendExecutionLogService();
    for (let i = 0; i < 40; i += 1) {
      service.ingest(sentinelLine({ backendProduct: 'codex', taskId: `task-long-bulk-${i}`, eventKind: 'PROCESS_SPAWN', pid: i, timestamp: `2026-08-25T00:00:${String(i).padStart(2, '0')}.000Z`, ...LONG, message: 'spawn' }));
    }
    const states = service.getLongTaskStates();
    expect(states.length).toBeLessThanOrEqual(25);
    // The earliest-created task must have been evicted.
    expect(service.getLongTaskState('task-long-bulk-0')).toBeNull();
    // The most recent task must still be present.
    expect(service.getLongTaskState('task-long-bulk-39')).not.toBeNull();
  });

  it('clear() resets long-task projections along with everything else (a restarted runtime cannot be trusted to still reflect old state)', () => {
    const service = new BackendExecutionLogService();
    service.ingest(sentinelLine({ backendProduct: 'codex', taskId: 'task-long-8', eventKind: 'PROCESS_SPAWN', pid: 1, ...LONG, message: 'spawn' }));
    expect(service.getLongTaskStates()).toHaveLength(1);
    service.clear();
    expect(service.getLongTaskStates()).toHaveLength(0);
  });

  it('malformed/unknown-product long-task lines never throw and never create a projection entry', () => {
    const service = new BackendExecutionLogService();
    expect(() => service.ingest(`${EXEC_LOG_SENTINEL} {not-json\n`)).not.toThrow();
    service.ingest(sentinelLine({ backendProduct: 'some-future-backend', taskId: 'task-x', eventKind: 'PROCESS_SPAWN', ...LONG, message: 'x' }));
    expect(service.getLongTaskStates()).toHaveLength(0);
  });
});
