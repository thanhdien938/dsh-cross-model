import React, { useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
// P11-R4.1 Part G: reuses PmProfileCreateDialog's modal styling wholesale
// (backdrop/dialog/field/actions/error classes) rather than a new
// stylesheet — same visual language, no foreign style introduced.
import './PmProfileCreateDialog.css';

interface UpdateApiKeyDialogProps {
  onClose: () => void;
  // Renderer never retrieves the OLD key — this call is a pure one-way
  // write (Part F/H/I). `onUpdated` fires only after a successful save so
  // the caller can trigger the SAME `Refresh` action the card's own button
  // already uses (no new refresh plumbing — Part I).
  onSave: (value: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  onUpdated: () => void;
}

// P11-R4.1 Part G/H/I: the ONE owner-facing credential-rotation flow for
// the `api` backend (OpenRouter only — Part E). No current value is ever
// fetched or prefilled (Part F/AL); the input is masked, cleared
// immediately after Save regardless of outcome (Part I), and the secret
// is never shown again after entry.
function UpdateApiKeyDialog({ onClose, onSave, onUpdated }: UpdateApiKeyDialogProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !busy });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await onSave(value);
      // Clear the draft immediately regardless of outcome — never left
      // sitting in renderer state after a Save attempt (Part I).
      setValue('');
      if (result.ok) {
        setDone(true);
        onUpdated();
      } else {
        setError(`${result.code}: ${result.message}`);
      }
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
        aria-labelledby="update-api-key-title"
        tabIndex={-1}
        className="pm-profile-create-dialog card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="update-api-key-title" className="section-title">Update API Key — OpenRouter</h3>
        <p className="pm-profile-create-hint">
          Enter a replacement OpenRouter API key. The current key is never shown or read back — this is a one-way update.
        </p>

        {done ? (
          <>
            <div className="pm-profile-create-field-static">API key updated.</div>
            <div className="pm-profile-create-actions">
              <button className="btn btn-primary" onClick={requestClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="pm-profile-create-field">
              OpenRouter API key
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={busy}
                placeholder="sk-or-…"
              />
            </label>

            {error && <div className="pm-profile-create-error">{error}</div>}

            <div className="pm-profile-create-actions">
              <button className="btn btn-secondary" onClick={requestClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default UpdateApiKeyDialog;
