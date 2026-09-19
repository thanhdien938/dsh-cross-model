import React, { useState } from 'react';
import { InboxItem, Project } from '../../electron/main/types';
import './ApprovalPanel.css';

interface ApprovalPanelProps {
  interactions: InboxItem[];
  // P15-REM-R3-F (P15-D-014): non-null whenever the last inbox read failed
  // — `interactions` in that case is the LAST successfully-read list (may
  // be stale, may be empty), never a fabricated "definitely nothing
  // pending" answer. This must always be checked BEFORE rendering the
  // "Nothing awaiting a decision" empty state.
  unavailable?: { code: string; message: string } | null;
  projects: Project[];
  armedProjectId: string | null;
  onNavigate: (projectId: string) => void;
  onDecide: (interaction: InboxItem, response: string) => Promise<void>;
  onReply: (interaction: InboxItem, text: string) => Promise<void>;
}

function projectName(projects: Project[], id: string): string {
  return projects.find((p) => p.id === id)?.name ?? id;
}

function age(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

// W2-G/W2-M: the global "Awaiting You" list is navigation only — it never
// renders Approve/Deny/Reply. Only the armed-project section below is
// actionable, and its controls come exclusively from each interaction's
// canonical allowed_responses, never from parsing PM prose.
function ApprovalPanel({ interactions, unavailable, projects, armedProjectId, onNavigate, onDecide, onReply }: ApprovalPanelProps) {
  const armed = interactions.filter((i) => i.project_id === armedProjectId);
  const others = interactions.filter((i) => i.project_id !== armedProjectId);

  return (
    <div className="approval-panel">
      {/* P15-REM-R3-F (P15-D-014): the critical invariant — PENDING
          APPROVAL UNKNOWN must never render as NO PENDING APPROVAL. This
          banner is shown whenever the last read failed, REGARDLESS of
          whether `interactions` happens to be empty or stale-populated,
          and it is never used to infer or apply any decision. */}
      {unavailable && (
        <div className="approval-section approval-unavailable" role="alert">
          <h3 className="section-title">Approvals — status unknown</h3>
          <div className="approval-error">
            Could not load pending approvals ({unavailable.code}). A decision may be waiting that this view cannot currently show.
            {interactions.length > 0 ? ' The list below is the last successfully loaded state and may be stale.' : ''}
          </div>
        </div>
      )}
      <div className="approval-section">
        <h3 className="section-title">Approvals — armed project</h3>
        {armed.length === 0 && !unavailable && <div className="approval-empty">Nothing awaiting a decision in the armed project.</div>}
        {armed.map((interaction) => (
          <ApprovalCard key={interaction.interaction_id} interaction={interaction} projects={projects} actionable onDecide={onDecide} onReply={onReply} />
        ))}
      </div>

      {others.length > 0 && (
        <div className="approval-section">
          <h3 className="section-title">Awaiting you — other projects</h3>
          <div className="approval-nav-note">Navigation only. Arm the project to act.</div>
          {others.map((interaction) => (
            <button
              type="button"
              key={interaction.interaction_id}
              className="awaiting-nav-item"
              onClick={() => onNavigate(interaction.project_id)}
            >
              <span className="awaiting-nav-project">{projectName(projects, interaction.project_id)}</span>
              <span className="awaiting-nav-title">{interaction.title}</span>
              <span className="awaiting-nav-age">{age(interaction.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  interaction,
  projects,
  actionable,
  onDecide,
  onReply,
}: {
  interaction: InboxItem;
  projects: Project[];
  actionable: boolean;
  onDecide: (interaction: InboxItem, response: string) => Promise<void>;
  onReply: (interaction: InboxItem, text: string) => Promise<void>;
}) {
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((p) => p.id === interaction.project_id);

  const decide = async (response: string) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(interaction, response);
    } catch (e: any) {
      setError(mapError(e?.message));
    } finally {
      setBusy(false);
    }
  };

  const reply = async () => {
    if (!replyText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onReply(interaction, replyText);
      setReplyText('');
    } catch (e: any) {
      setError(mapError(e?.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-card card">
      <div className="approval-card-context">
        <span>{project?.name ?? interaction.project_id}</span>
        {project?.path && <span className="approval-card-path">{project.path}</span>}
        {project?.branch && <span>⎇ {project.branch}</span>}
      </div>
      <div className="approval-card-title">{interaction.title}</div>
      <div className="approval-card-prompt">{interaction.prompt_text}</div>
      <div className="approval-card-meta">
        rev {interaction.revision} · {age(interaction.created_at)} · {interaction.status}
      </div>

      {actionable && interaction.allowed_responses.length > 0 && (
        <div className="approval-card-actions">
          {interaction.allowed_responses.map((response) => (
            <button key={response} className="btn btn-primary" onClick={() => decide(response)} disabled={busy}>
              {response}
            </button>
          ))}
        </div>
      )}

      {actionable && interaction.kind === 'QUESTION' && (
        <div className="approval-card-reply">
          <input
            className="approval-card-reply-input"
            placeholder="Reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            disabled={busy}
          />
          <button className="btn btn-secondary" onClick={reply} disabled={busy || !replyText.trim()}>
            Reply
          </button>
        </div>
      )}

      {!actionable && <div className="approval-card-locked">Arm this project to respond.</div>}
      {error && <div className="approval-card-error">{error}</div>}
    </div>
  );
}

function mapError(code?: string): string {
  switch (code) {
    case 'STALE_INTERACTION':
      return 'Already answered from another surface (GUI or Telegram).';
    case 'OWNER_COMMAND_CONFLICT':
      return 'OWNER_COMMAND_CONFLICT';
    case 'PROJECT_NOT_ARMED':
      return 'PROJECT NOT ARMED';
    case 'LOCAL_OWNER_PIPE_UNAVAILABLE':
      return 'LOCAL OWNER PIPE UNAVAILABLE';
    default:
      return code ?? 'OWNER_COMMAND_FAILED';
  }
}

export default ApprovalPanel;
