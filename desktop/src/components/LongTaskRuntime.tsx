import React, { useEffect, useState } from 'react';
import './LongTaskRuntime.css';

interface LongTaskRuntimeProps {
  runtimeRunning: boolean;
}

const POLL_MS = 2000;

// P10-R0.2.4.1 Part J/K/M/P — a narrow, READ-ONLY owner-visible panel for
// LONG (`--task-file`) task runtime/liveness state. Every value here
// comes from window.desktop.longTasks.statuses() (poll-only — see
// preload.ts); there is no stdin, no task control, and no raw chain-of-
// thought/event-stream exposure. The elapsed/remaining clock below is
// display-only (Part O): it re-renders from `startedAt`/`hardDeadlineMs`
// on a local interval, but never drives any real execution policy — the
// actual 30-minute hard deadline is enforced entirely in the runtime
// process, independent of whether this panel is even open.
function formatDuration(ms: number): string {
  const clamped = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function livenessLabel(state: LongTaskRuntimeState['liveness']): string {
  if (state === 'ACTIVE') return 'Active';
  if (state === 'QUIET_RUNNING') return 'Quiet (running)';
  if (state === 'STALLED') return 'Stalled — no activity observed, process still running';
  if (state === 'EXITED') return 'Process exited';
  return 'Unknown';
}

function LongTaskRuntime({ runtimeRunning }: LongTaskRuntimeProps) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<LongTaskRuntimeState[]>([]);
  // Local, display-only re-render clock (Part O) — never touches the
  // real runtime; used only to recompute elapsed/remaining text.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!runtimeRunning) return;
    const load = () => window.desktop.longTasks.statuses().then(setTasks).catch(() => {});
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [runtimeRunning]);

  useEffect(() => {
    const interval = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Part L: nothing to show is nothing to render — this panel never
  // clutters the UI for an all-NORMAL session.
  if (tasks.length === 0) return null;

  return (
    <div className={`long-task-runtime ${expanded ? 'long-task-runtime-expanded' : ''}`}>
      <button
        type="button"
        className="long-task-runtime-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="panel-header-label">Long Task Runtime ({tasks.length})</span>
        <span className="long-task-runtime-toggle" aria-hidden="true">{expanded ? '▼' : '▲'}</span>
      </button>
      {expanded && (
        <div className="long-task-runtime-content">
          {tasks.map((task) => {
            const now = Date.now();
            const startedAtMs = task.startedAt ? Date.parse(task.startedAt) : null;
            const elapsedMs = startedAtMs !== null ? Math.max(0, now - startedAtMs) : null;
            const remainingMs = elapsedMs !== null ? Math.max(0, task.hardDeadlineMs - elapsedMs) : null;
            const snapshotAtMs = Date.parse(task.snapshotAt);
            const lastActivityAgeMs = task.lastActivityAgeMs !== null && !Number.isNaN(snapshotAtMs)
              ? task.lastActivityAgeMs + Math.max(0, now - snapshotAtMs)
              : task.lastActivityAgeMs;
            return (
              <div key={task.taskId} className="long-task-row">
                <div className="long-task-row-line">
                  <span className="long-task-field-label">Task</span>
                  <span className="long-task-task-id">{task.taskId.slice(0, 20)}</span>
                  <span className={`long-task-liveness long-task-liveness-${(task.liveness ?? 'unknown').toLowerCase()}`}>
                    {livenessLabel(task.liveness)}
                  </span>
                </div>
                <div className="long-task-row-detail">
                  <span>PM: {task.profileId ?? '—'}</span>
                  <span>Backend: {task.product ?? '—'}</span>
                  {task.pid !== null && <span>PID: {task.pid}</span>}
                  {task.sandboxState && <span>Sandbox: {task.sandboxState}</span>}
                </div>
                <div className="long-task-row-detail">
                  <span>Runtime: LONG</span>
                  {elapsedMs !== null && <span>Elapsed: {formatDuration(elapsedMs)}</span>}
                  <span>Hard deadline: {formatDuration(task.hardDeadlineMs)}</span>
                  {remainingMs !== null && !task.processExited && <span>Remaining: {formatDuration(remainingMs)}</span>}
                  {task.hardDeadlineReached && (
                    <span className="long-task-hard-deadline">
                      Hard deadline reached — termination requested, no retry, no partial-result success
                    </span>
                  )}
                </div>
                {lastActivityAgeMs !== null && (
                  <div className="long-task-row-detail">
                    <span>Last activity: {task.lastActivityKind ?? 'unknown'} ({formatDuration(lastActivityAgeMs)} ago)</span>
                  </div>
                )}
                {task.processExited && (
                  <div className="long-task-row-detail long-task-exited-note">
                    Backend process exited{task.exitCode !== null ? ` (code ${task.exitCode})` : ''}. Task completion/failure/await-owner status is reported separately (Activity/Timeline) — process exit is not itself a task outcome.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LongTaskRuntime;
