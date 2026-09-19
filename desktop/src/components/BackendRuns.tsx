import React, { useEffect, useState } from 'react';
import { BackendRun } from '../../electron/main/types';
import CancelTaskDialog from './CancelTaskDialog';
import './BackendRuns.css';

interface BackendRunsProps {
  selectedProject: string | null;
  runtimeRunning: boolean;
  // P12-R5C Part F: only a run belonging to the CURRENTLY ARMED project ever
  // offers Cancel — mirrors the exact gate the removed Timeline cancel
  // control already applied (`entry.projectId === armedProjectId`), and
  // matches OwnerCommandService's own independent PROJECT_NOT_ARMED
  // enforcement server-side (Part F: renderer never becomes the authority,
  // this is truthful UX, not a security boundary of its own).
  armedProjectId?: string | null;
  // P12-R5C Part C/F: optional — omitted, this component renders exactly as
  // before (no Cancel control at all). Supplied by App.tsx, wired to the
  // SAME canonical window.desktop.owner.requestCancel() -> OwnerControlService
  // -> OwnerTaskController.requestCancel() round-trip every other owner
  // mutation already uses. This component never calls any IPC of its own
  // for cancellation — it only captures WHICH run/task the owner confirmed.
  onCancelTask?: (taskId: string, projectId: string) => Promise<void>;
}

// P12-R2/P12-R5C: `run.status` is pm_runs.status VERBATIM (readProjection.ts's
// getBackendRuns() — `SELECT ... status ... FROM pm_runs`), the exact same
// canonical column TERMINAL_RUN (pm-repository.mjs) checks against:
// 'completed'/'failed'/'cancelled' are terminal, everything else
// ('running') covers every non-terminal refinement a task can be in
// (actively executing, parked AWAIT_OWNER, quiet-but-alive, stalled-but-not-
// yet-timed-out) — none of those change the top-level pm_runs.status value.
// Cancel is therefore offered exactly when status is NOT one of the three
// terminal values — never invented state names, never a second status
// vocabulary.
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export function isCancellable(run: BackendRun, armedProjectId: string | null | undefined): boolean {
  return Boolean(run.taskId) && Boolean(run.projectId) && run.projectId === armedProjectId && !TERMINAL_RUN_STATUSES.has(run.status);
}

// W3-C: safe, already-sanitized backend run history for the selected
// project. No fence token, no raw argv/env, no full unsanitized error —
// every field here already passed through the real production
// sanitizeOperatorOutput() in readProjection.ts.
function BackendRuns({ selectedProject, runtimeRunning, armedProjectId, onCancelTask }: BackendRunsProps) {
  const [runs, setRuns] = useState<BackendRun[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ taskId: string; projectId: string } | null>(null);
  // P15-REM-R3-G (P14-A4-001): `window.desktop.runs.list()` now returns a
  // typed ProjectionResult — `unavailable` distinguishes "the read failed"
  // from "there really are no runs yet"; the last successfully-read list is
  // kept on screen rather than replaced with an empty one.
  const [unavailable, setUnavailable] = useState<{ code: string; message: string } | null>(null);

  const load = () => window.desktop.runs.list(selectedProject, { limit: 30 }).then((result) => {
    if (result.status === 'ERROR') { setUnavailable(result.error); }
    else { setRuns(result.data); setUnavailable(result.status === 'DEGRADED_PARTIAL' ? result.error : null); }
  }).catch(() => {});

  useEffect(() => {
    if (!runtimeRunning) return;
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [selectedProject, runtimeRunning]);

  return (
    <div className={`backend-runs ${expanded ? 'backend-runs-expanded' : ''}`}>
      <button
        type="button"
        className="backend-runs-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="panel-header-label">Backend Runs {selectedProject ? `— ${selectedProject}` : '(all projects)'}</span>
        <span className="backend-runs-toggle" aria-hidden="true">{expanded ? '▼' : '▲'}</span>
      </button>
      {expanded && (
        <div className="backend-runs-content">
          {unavailable && (
            <div className="backend-runs-unavailable" role="alert">
              {runs.length > 0
                ? `Backend runs could not be refreshed (${unavailable.code}) — showing the last known list, which may be stale or incomplete.`
                : `Backend runs could not be loaded (${unavailable.code}).`}
            </div>
          )}
          {runs.length === 0 && !unavailable && <div className="backend-runs-empty">No backend runs yet.</div>}
          {runs.map((run) => {
            // P12-R2: `dshOutcome` is additive/optional — every field below
            // is only ever shown when it's actually present, so a run that
            // predates P12 (or never had it recorded) renders exactly as
            // before.
            const outcome = run.dshOutcome ?? null;
            const hasDetail = run.cwd || run.model || run.exitCode !== null || run.parserOutcome || outcome;
            const noteworthy = outcome?.persistence_warning || outcome?.degraded;
            const cancellable = Boolean(onCancelTask) && isCancellable(run, armedProjectId);
            return (
              <div key={run.runId}>
                <div
                  className="backend-run-row"
                  onClick={() => hasDetail && setOpenRunId(openRunId === run.runId ? null : run.runId)}
                  style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                >
                  <span className="backend-run-product">{run.product}</span>
                  <span className="backend-run-task">{run.taskId ? run.taskId.slice(0, 12) : '—'}</span>
                  <span className={`backend-run-status backend-run-status-${run.status}`}>{run.status}</span>
                  {noteworthy && <span className="backend-run-outcome-warning" title={outcome?.terminal_marker}>⚠</span>}
                  <span className="backend-run-duration">{run.durationMs !== null ? `${(run.durationMs / 1000).toFixed(1)}s` : ''}</span>
                  {cancellable && (
                    <button
                      className="btn btn-danger backend-run-cancel"
                      onClick={(e) => { e.stopPropagation(); setCancelTarget({ taskId: run.taskId!, projectId: run.projectId! }); }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {openRunId === run.runId && hasDetail && (
                  <div className="backend-run-detail">
                    {run.cwd && <span>CWD: {run.cwd}</span>}
                    {run.model && <span>Model: {run.model}</span>}
                    {run.exitCode !== null && run.exitCode !== undefined && <span>Exit code: {run.exitCode}</span>}
                    {run.parserOutcome && <span>Parser: {run.parserOutcome}</span>}
                    {outcome && <span>Outcome: {outcome.terminal_marker}</span>}
                    {outcome && outcome.local_git_status !== 'NOT_REQUESTED' && <span>Local git: {outcome.local_git_status}</span>}
                    {outcome && outcome.remote_sync_status !== 'NOT_REQUESTED' && <span>Remote sync: {outcome.remote_sync_status}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {cancelTarget && onCancelTask && (
        <CancelTaskDialog
          taskId={cancelTarget.taskId}
          onClose={() => setCancelTarget(null)}
          onConfirm={async () => {
            await onCancelTask(cancelTarget.taskId, cancelTarget.projectId);
            // Part I: re-query the REAL projection immediately rather than
            // waiting out the 5s poll — never fabricates a CANCELLED status
            // itself, just asks sooner for the truth the runtime actually
            // committed.
            await load();
          }}
        />
      )}
    </div>
  );
}

export default BackendRuns;
