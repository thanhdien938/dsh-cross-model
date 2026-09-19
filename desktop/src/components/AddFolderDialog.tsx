import React, { useState } from 'react';
import { PmProfileOption } from './Composer';
import { useDialogA11y } from '../lib/useDialogA11y';
import './AddFolderDialog.css';

interface AddFolderDialogProps {
  pmProfiles: PmProfileOption[];
  onClose: () => void;
  onAdded: (result: { projectId: string; restartRequired: boolean }) => void;
}

// W2-I: native picker only, then realpath/git/duplicate/config validation,
// atomic write, and (if the runtime is active) an explicit — never silent —
// restart prompt.
function AddFolderDialog({ pmProfiles, onClose, onAdded }: AddFolderDialogProps) {
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [defaultPmProfileId, setDefaultPmProfileId] = useState(pmProfiles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !busy });

  const pick = async () => {
    const picked = await window.desktop.dialogs.pickFolder();
    if (picked) setFolderPath(picked);
  };

  const submit = async (force = false) => {
    if (!folderPath || !defaultPmProfileId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.desktop.project.addFolder({ folderPath, displayName: displayName || undefined, defaultPmProfileId, force });
      if (result.ok) {
        onAdded({ projectId: result.projectId, restartRequired: result.restartRequired });
        onClose();
      } else if (result.code === 'DUPLICATE_PROJECT_PATH') {
        setDuplicateWarning(`Already registered as project "${result.existingProjectId}". Add anyway under a new id?`);
      } else {
        setError(`${result.code}: ${result.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-folder-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-folder-title"
        tabIndex={-1}
        className="add-folder-dialog card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="add-folder-title" className="section-title">Add Folder</h3>

        <button className="btn btn-secondary" onClick={pick} disabled={busy}>
          Choose folder…
        </button>
        {folderPath && <div className="add-folder-path">{folderPath}</div>}

        <label className="add-folder-field">
          Display name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
        </label>

        <label className="add-folder-field">
          Default PM profile
          <select value={defaultPmProfileId} onChange={(e) => setDefaultPmProfileId(e.target.value)} disabled={busy}>
            <option value="" disabled>
              Choose a PM profile
            </option>
            {/* P9-R0.4 Part B: same self-describing label + canonical id
                every other selector uses — this list is already
                ACTIVE-only (Part N), sourced from window.desktop.pm.profiles()
                like Composer's selectors. */}
            {pmProfiles.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.displayLabel} — {p.id}
              </option>
            ))}
          </select>
        </label>

        {duplicateWarning && (
          <div className="add-folder-warning">
            <p>{duplicateWarning}</p>
            <button className="btn btn-danger" onClick={() => submit(true)} disabled={busy}>
              Add anyway (new project id)
            </button>
          </div>
        )}
        {error && <div className="add-folder-error">{error}</div>}

        <div className="add-folder-actions">
          <button className="btn btn-secondary" onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => submit(false)} disabled={busy || !folderPath || !defaultPmProfileId}>
            {busy ? 'Adding…' : 'Add Folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddFolderDialog;
