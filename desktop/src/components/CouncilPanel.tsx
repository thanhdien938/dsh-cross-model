import React, { useEffect, useState, useCallback } from 'react';
import './CouncilPanel.css';

const PHASE_LABEL: Record<string, string> = {
  PLANNING: 'Planning',
  ROUND_1_INDEPENDENT_ANALYSIS: 'Round 1 / Independent Analysis',
  ROUND_2_CRITIQUE: 'Round 2 / Critique',
  CHAIR_SYNTHESIS: 'Chair Synthesis',
  // P19-D4: additive — reported only for a debate-enabled council still
  // running (council-projection.mjs's COUNCIL_PHASES, D2).
  DEBATE_ROUND_1: 'Debate — Round 1',
  DEBATE_ROUND_2: 'Debate — Round 2',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

// P19-D4: sub-phase label for the CURRENT debate round, independent of the
// top-level PHASE_LABEL above (council-projection.mjs's DEBATE_ROUND_PHASE).
const DEBATE_ROUND_PHASE_LABEL: Record<string, string> = {
  BRIEF: 'preparing brief',
  RESPONSES: 'collecting responses',
  SYNTHESIS: 'synthesizing',
  DONE: 'round complete',
};

const DEBATE_STATUS_LABEL: Record<string, string> = {
  NOT_ENABLED: 'Not enabled',
  PENDING: 'Pending',
  ROUND_1_IN_PROGRESS: 'Round 1 in progress',
  ROUND_1_COMPLETE: 'Round 1 complete',
  ROUND_2_IN_PROGRESS: 'Round 2 in progress',
  COMPLETE: 'Complete',
};

function statusIcon(status: string): string {
  if (status === 'DONE') return '✓';
  if (status === 'FAILED') return '✗';
  if (status === 'RUNNING') return '●';
  return '○';
}

// P7 Part M/M1: an owner-friendly Council panel — normalized, readable
// content only, never unbounded raw JSON. Backend Execution (BackendRuns /
// BackendExecutionLogs) remains the debug surface for the same underlying
// pm_runs/pm_turns this panel projects.
function CouncilPanel({ selectedProjectId }: { selectedProjectId: string | null }) {
  const [runs, setRuns] = useState<CouncilProjection[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<{ code: string; message: string } | null>(null);

  const refresh = useCallback(async () => {
    const result = await window.desktop.council.list(selectedProjectId, { limit: 10 });
    if (result.status === 'ERROR') {
      setUnavailable(result.error);
      return;
    }
    setRuns(result.data);
    setUnavailable(result.error);
  }, [selectedProjectId]);

  useEffect(() => {
    refresh();
    // Manual/on-demand only — no periodic polling here (P6.5 owner
    // decision: no periodic Connection Center-style auto-refresh). The
    // caller (App.tsx) re-triggers a refresh on the same cadence it
    // already refreshes the Timeline/inbox.
  }, [refresh]);

  if (runs.length === 0 && !unavailable) {
    return (
      <div className="council-panel card">
        <h3 className="council-panel-title">Council</h3>
        <p className="council-panel-empty">No council runs yet for this project.</p>
      </div>
    );
  }

  return (
    <div className="council-panel card">
      <div className="council-panel-header">
        <h3 className="council-panel-title">Council</h3>
        <button className="btn btn-secondary council-panel-refresh" onClick={refresh}>
          Refresh
        </button>
      </div>
      {unavailable && (
        <div className="council-panel-error" role="alert">
          Council status is unknown ({unavailable.code}). Existing Council work may not be visible; any rows below are last-known state.
        </div>
      )}
      {runs.map((run) => (
        <div key={run.councilId} className="council-run">
          <button className="council-run-header" onClick={() => setExpanded(expanded === run.councilId ? null : run.councilId)}>
            <span className="council-run-id">Council #{run.councilId.slice(-8)}</span>
            <span className={`council-run-phase council-run-phase-${run.phase}`}>{PHASE_LABEL[run.phase] ?? run.phase}</span>
          </button>
          <div className="council-run-summary">
            <span className="council-run-chair">Chair: {run.chairProfileId}</span>
            <span className="council-run-participants">
              {run.participants.map((p) => (
                <span key={p.profileId} className={`council-participant-badge council-participant-${p.status}`}>
                  {statusIcon(p.status)} {p.profileId}
                  {/* P19-D6: the ONLY visual cue distinguishing an
                      execution-capable Council from an analysis-only one —
                      council-projection.mjs's implementationParticipantId is
                      the same W4R6 scalar every backend policy decision
                      already reads (D6-D: implementation participant
                      identity must be owner-visible). */}
                  {run.implementationParticipantId === p.profileId && ' ⚙ implements'}
                </span>
              ))}
            </span>
            {run.degraded && <span className="council-run-degraded">⚠ Degraded</span>}
            {run.debate.enabled && (
              <span className="council-run-debate-badge">
                Debate: {DEBATE_STATUS_LABEL[run.debate.status] ?? run.debate.status}
                {run.debate.currentRound && run.debate.currentRoundPhase && ` (R${run.debate.currentRound} — ${DEBATE_ROUND_PHASE_LABEL[run.debate.currentRoundPhase] ?? run.debate.currentRoundPhase})`}
              </span>
            )}
          </div>
          {expanded === run.councilId && (
            <div className="council-run-detail">
              {/* P19-D6 (D6-D): make the analysis-only vs execution-capable
                  distinction explicit in prose, not just the inline badge
                  above — this is the exact ambiguity the D5.1 live incident
                  showed a chair could get wrong; the owner must never have
                  to infer it. */}
              <p className="council-detail-implementation-summary">
                {run.implementationParticipantId
                  ? `Implementation participant: ${run.implementationParticipantId} (only this participant may edit the repository, during its own Council report turn)`
                  : 'All participants are analysis/review only — no repository edits were authorized for this run.'}
              </p>
              {run.round1.length > 0 && (
                <div className="council-detail-section">
                  <h4>Round 1</h4>
                  {run.round1.map((r) => (
                    <div key={r.profileId} className="council-detail-item">
                      <strong>{r.profileId}</strong>
                      {r.ok === false ? (
                        <span className="council-detail-failed"> — failed ({r.report?.reason ?? 'unknown'})</span>
                      ) : r.report ? (
                        <p>{r.report.recommendation}</p>
                      ) : (
                        <span className="council-detail-pending"> — pending</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {run.round2.length > 0 && (
                <div className="council-detail-section">
                  <h4>Round 2</h4>
                  {run.round2.map((r) => (
                    <div key={r.profileId} className="council-detail-item">
                      <strong>{r.profileId}</strong>
                      {r.ok === false ? (
                        <span className="council-detail-failed"> — failed ({r.critique?.reason ?? 'unknown'})</span>
                      ) : r.critique ? (
                        <p>{r.critique.revisedRecommendation}</p>
                      ) : (
                        <span className="council-detail-pending"> — pending</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="council-detail-section">
                <h4>Chair synthesis</h4>
                {run.finalOutput ? <p className="council-detail-synthesis">{run.finalOutput}</p> : <span className="council-detail-pending">pending</span>}
              </div>
              {run.debate.enabled && (
                <div className="council-detail-section council-detail-debate">
                  <h4>Debate — {DEBATE_STATUS_LABEL[run.debate.status] ?? run.debate.status}</h4>
                  <p className="council-detail-debate-meta">
                    Max rounds: {run.debate.maxRounds}
                    {run.debate.completedRounds.length > 0 && ` · Completed rounds: ${run.debate.completedRounds.join(', ')}`}
                  </p>
                  {run.debate.finalReportAvailable && run.debate.finalReport ? (
                    <div className="council-detail-final-debate-report">
                      <strong>Final Debate Report (Round {run.debate.finalReport.round}{run.debate.finalReport.engineForcedStop ? ' — engine forced stop' : ''})</strong>
                      <p className="council-detail-synthesis">{run.debate.finalReport.output}</p>
                      {run.debate.finalReport.unresolvedQuestions.length > 0 && (
                        <>
                          <em>Unresolved questions:</em>
                          <ul>
                            {run.debate.finalReport.unresolvedQuestions.map((q, i) => (
                              <li key={i}>{q}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="council-detail-pending">
                      {run.debate.status === 'PENDING' ? 'Council Report complete — Debate not yet started' : 'in progress'}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default CouncilPanel;
