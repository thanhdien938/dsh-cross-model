import React, { useState, useEffect } from 'react';
import { RuntimeStatus } from '../../electron/main/types';
import './ActivityPanel.css';

interface RuntimeLogEntry {
  timestamp: number;
  level: 'INFO' | 'ERROR';
  line: string;
}

interface ActivityPanelProps {
  status: RuntimeStatus;
}

function ActivityPanel({ status }: ActivityPanelProps) {
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (status.state === 'RUNNING') {
      loadLogs();
      const interval = setInterval(loadLogs, 3000);
      return () => clearInterval(interval);
    }
  }, [status.state]);

  const loadLogs = async () => {
    try {
      const logEntries = await window.desktop.logs.runtime({ limit: 50 });
      setLogs(logEntries);
    } catch (error) {
      console.error('Failed to load logs:', error);
    }
  };

  return (
    <div className={`activity-panel ${expanded ? 'activity-panel-expanded' : ''}`}>
      <button
        type="button"
        className="activity-panel-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="activity-panel-title">
          <span className="panel-header-label">DSH Activity</span>
          {status.state === 'RUNNING' && status.pid && (
            <span className="activity-panel-pid">PID: {status.pid}</span>
          )}
        </span>
        <span className="activity-panel-toggle" aria-hidden="true">
          {expanded ? '▼' : '▲'}
        </span>
      </button>

      {expanded && (
        <div className="activity-panel-content">
          <div className="activity-panel-logs">
            {logs.length === 0 && (
              <div className="activity-panel-empty">
                {status.state === 'RUNNING' 
                  ? 'No logs yet...' 
                  : 'Start runtime to see activity logs'}
              </div>
            )}
            {logs.map((log, index) => (
              <div key={index} className={`activity-log-entry ${log.level === 'ERROR' ? 'activity-log-entry-error' : ''}`}>
                <span className="activity-log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                {log.line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ActivityPanel;
