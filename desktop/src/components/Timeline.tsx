import React from 'react';
import { TimelineEntry, Project } from '../../electron/main/types';
import './Timeline.css';

interface TimelineProps {
  entries: TimelineEntry[];
  // P15-REM-R3-G (P15-D-012): non-null whenever the last timeline read
  // failed or degraded (one of the two sources unavailable) — `entries` in
  // that case is the LAST successfully-read/partial list, never fabricated
  // as "definitely no activity."
  unavailable?: { code: string; message: string } | null;
  filter: string;
  onFilterChange: (filter: string) => void;
  selectedProject: string | null;
  projects: Project[];
}

const FILTERS = ['ALL', 'USER', 'PM', 'AGENT', 'APPROVAL', 'RESULT', 'SYSTEM'];

// P12-R5C Part C/D/J: the "Request Cancel" control that used to live here
// was removed — a Timeline entry is a single historical EVENT (submission/
// PM reply/result/...), never the task's CURRENT canonical status, so it
// had no way to gate Cancel correctly (it showed on every entry with a
// taskId, including a long-COMPLETED/FAILED/CANCELLED one — the exact
// mistake Part J forbids). Cancel now lives in BackendRuns.tsx instead,
// which already reads pm_runs.status (the real canonical, non-terminal-vs-
// terminal signal) for every run it lists.
function Timeline({ entries, unavailable, filter, onFilterChange, selectedProject, projects }: TimelineProps) {
  const selectedProjectName = projects.find(p => p.id === selectedProject)?.name || 'All Projects';

  const formatTimestamp = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'USER_TELEGRAM': return '💬';
      case 'USER_GUI': return '🖥️';
      case 'PM': return '📋';
      case 'AGENT': return '🤖';
      case 'APPROVAL': return '✓';
      case 'RESULT': return '✦';
      case 'SYSTEM': return '⚙️';
      default: return '•';
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'USER_TELEGRAM':
      case 'USER_GUI':
        return 'var(--dsh-accent)';
      case 'PM':
        return 'var(--dsh-status-success)';
      case 'AGENT':
        return 'var(--dsh-status-info)';
      case 'APPROVAL':
        return 'var(--dsh-status-warning)';
      case 'RESULT':
        return 'var(--dsh-category-purple, #C7B8ED)';
      case 'SYSTEM':
        return 'var(--dsh-text-muted)';
      default:
        return 'var(--dsh-text-muted)';
    }
  };

  return (
    <div className="timeline">
      <div className="timeline-header">
        <div>
          <h2 className="timeline-title">{selectedProjectName}</h2>
          <div className="timeline-subtitle">
            {entries.length} event{entries.length !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="timeline-filters">
          {FILTERS.map(f => (
            <button
              key={f}
              className={`timeline-filter ${filter === f ? 'timeline-filter-active' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="timeline-content">
        {unavailable && (
          <div className="timeline-unavailable" role="alert">
            {entries.length > 0
              ? `Timeline could not be fully refreshed (${unavailable.code}) — showing the last known/partial activity.`
              : `Timeline could not be loaded (${unavailable.code}).`}
          </div>
        )}

        {entries.length === 0 && !unavailable && (
          <div className="timeline-empty">
            {selectedProject
              ? 'No activity yet for this project.'
              : 'No activity yet. Start runtime and submit a task to see events here.'}
          </div>
        )}

        {entries.map((entry, index) => (
          <div key={entry.commandId ?? index} className={`timeline-entry ${entry.pending ? 'timeline-entry-pending' : ''}`}>
            <div
              className="timeline-entry-marker"
              style={{ backgroundColor: getCategoryColor(entry.category) }}
            >
              <span>{getCategoryIcon(entry.category)}</span>
            </div>

            <div className="timeline-entry-content">
              <div className="timeline-entry-header">
                <span className="timeline-entry-category" style={{ color: getCategoryColor(entry.category) }}>
                  {entry.category}
                </span>
                <span className="timeline-entry-time">{entry.pending ? 'SENDING…' : formatTimestamp(entry.timestamp)}</span>
              </div>

              {entry.taskId && (
                <div className="timeline-entry-meta">
                  Task: <code>{entry.taskId.slice(0, 8)}</code>
                </div>
              )}

              <div className="timeline-entry-body">
                {entry.content}
              </div>

              {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                <details className="timeline-entry-details">
                  <summary>Details</summary>
                  <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Timeline;
