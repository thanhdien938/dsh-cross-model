import React, { useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
// P12-R5C Part E: reuses PmProfileCreateDialog's modal styling wholesale
// (backdrop/dialog/actions classes) — same visual language as
// UpdateApiKeyDialog.tsx's own reuse of the same stylesheet, no new
// stylesheet introduced for one small confirmation dialog.
import './PmProfileCreateDialog.css';

interface CancelTaskDialogProps {
  taskId: string;
  onClose: () => void;
  // Resolves once the canonical REQUEST_CANCEL round-trip completes (or
  // throws) — this dialog never marks anything cancelled itself (Part I:
  // "do not fake immediate CANCELLED before runtime confirms it").
  onConfirm: () => Promise<void>;
}

// P12-R5C Part E/F: destructive-action confirmation for an in-flight task.
// Renderer-side: captures the owner's explicit intent only — the actual
// cancellation still goes through the exact same canonical
// window.desktop.owner.requestCancel() -> OwnerControlService ->
// OwnerTaskController.requestCancel() path every other owner mutation
// already uses (this dialog performs no IPC of its own; `onConfirm` is
// supplied by the caller).
function CancelTaskDialog({ taskId, onClose, onConfirm }: CancelTaskDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !busy });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Cancel request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-profile-create-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-task-title"
        tabIndex={-1}
        className="pm-profile-create-dialog card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cancel-task-title" className="section-title">Cancel this task?</h3>
        <p className="pm-profile-create-hint">
          The current task will be terminated. Durable history already written will be preserved.
        </p>
        <p className="pm-profile-create-field-static">
          Task: <span>{taskId.slice(0, 12)}</span>
        </p>
        {error && <div className="pm-profile-create-error">{error}</div>}
        <div className="pm-profile-create-actions">
          <button className="btn btn-secondary" onClick={requestClose} disabled={busy}>
            Keep running
          </button>
          <button className="btn btn-danger" onClick={confirm} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel task'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CancelTaskDialog;
