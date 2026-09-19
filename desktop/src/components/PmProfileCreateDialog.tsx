import React, { useMemo, useState } from 'react';
import { ApiModelEntry, BackendCapability, PmProfileWriteResult } from '../../electron/main/types';
import { useDialogA11y } from '../lib/useDialogA11y';
import './PmProfileCreateDialog.css';

// P8-R0.2 Part E: a bounded, best-effort suggestion only — never enforced.
// The owner may always edit the id before creating (existing id validation
// still applies via `existingIds`/idValid below). Slugs product/model/
// reasoning into a readable id; falls back to `-2`, `-3`, ... on collision
// rather than ever silently reusing/overwriting an existing id.
function slugSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// P9-R0.3 Part E/F: SUPPLEMENTAL renderer-side copy of the same rule
// src/session/antigravity-cli-session-bridge.mjs's
// deriveAntigravityReasoningFromModel() enforces authoritatively —
// pmProfileConfigService.ts's create() (Part F) is the real, trusted
// guard; a stale/bypassed renderer can never create a contradictory
// profile because the service rejects it independently. This copy exists
// only so the dialog can show the derived tier immediately, without an
// IPC round-trip per keystroke. Returns null for a model with no
// recognized tier suffix (e.g. every current Claude slug) — never invents
// one.
export function deriveAntigravityReasoningTier(model: string): string | null {
  const match = model.match(/-(low|medium|high)$/i);
  return match ? match[1].toLowerCase() : null;
}
export function suggestPmProfileId(product: string, model: string | null, reasoning: string | null, existingIds: string[]): string {
  const shortProduct = product === 'claude-code' ? 'claude' : product;
  const parts = [shortProduct, model ? slugSegment(model) : null, reasoning ? slugSegment(reasoning) : null].filter(Boolean) as string[];
  const base = parts.length > 1 ? `live1-${parts.join('-')}` : `live1-${shortProduct}-pm`;
  if (!existingIds.includes(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
  return base;
}

interface PmProfileCreateDialogProps {
  product: string;
  capability: BackendCapability | undefined;
  existingIds: string[];
  // P8-R0.2 Part C/D: when set, this dialog is a "Create Variant" of an
  // EXISTING profile — model/reasoning are pre-filled from it (still
  // owner-editable) and the suggested id reflects the chosen execution
  // configuration. The source profile (`variantOf.id`) is never written to
  // by this dialog — creating a variant always produces a brand-new
  // canonical id via create(), and the original profile's execution
  // identity (Part B) is left completely untouched.
  variantOf?: { id: string; provider?: string; model: string | null; reasoning: string | null } | null;
  onClose: () => void;
  onCreate: (args: { id: string; product: string; provider?: string; model?: string | null; reasoning?: string | null }) => Promise<PmProfileWriteResult>;
  onCreated: () => void;
}

// P6-W3-R4 Part D1/D2/D4: owner-safe profile creation for any supported
// backend with no existing profile (or an additional one/a variant).
// Session kind is fixed to STATELESS — this dialog never exposes
// NATIVE_SESSION, and transport is always the fixed 'stdio' the runtime
// derives, so neither is an editable field here.
function PmProfileCreateDialog({ product, capability, existingIds, variantOf = null, onClose, onCreate, onCreated }: PmProfileCreateDialogProps) {
  const [model, setModel] = useState(variantOf?.model ?? '');
  const [reasoning, setReasoning] = useState(variantOf?.reasoning ?? '');
  const suggestedId = suggestPmProfileId(product, model.trim() || null, reasoning.trim() || null, existingIds);
  const [id, setId] = useState(existingIds.includes(suggestedId) ? '' : suggestedId);
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !busy });
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ApiModelEntry[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelsRetrievedAt, setModelsRetrievedAt] = useState<string | null>(null);
  const isApi = product === 'api';
  const selectedApiModel = models.find((entry) => entry.id === model) ?? null;
  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return models.filter((entry) => !query || entry.id.toLowerCase().includes(query) || entry.name?.toLowerCase().includes(query)).slice(0, 150);
  }, [models, modelSearch]);
  const refreshModels = async () => {
    setBusy(true); setError(null);
    try {
      const result = await window.desktop.backends.apiProviderModels('openrouter');
      if (!result.ok) setError(`${result.code}: ${result.message}`);
      else { setModels(result.models); setModelsRetrievedAt(result.retrievedAt); }
    } finally { setBusy(false); }
  };

  // Keep the suggested id following model/reasoning edits until the owner
  // has actually touched the id field themselves (Part E: a suggestion,
  // never forced).
  const effectiveId = idTouched ? id : existingIds.includes(suggestedId) ? '' : suggestedId;

  const idTaken = existingIds.includes(effectiveId.trim());
  const idValid = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(effectiveId.trim());

  // P9-R0.3 Part E: for Antigravity, a model with a recognized tier
  // suffix makes reasoning DERIVED and read-only — the owner picks the
  // model, DSH shows (and, on submit, sends) the tier that model already
  // encodes. A model with no recognized tier (e.g. Claude) falls back to
  // the same "managed by CLI/model" pattern every other backend without
  // reasoning support already uses (Part E: reuse the existing null/
  // inherited representation, never invent one). This makes a
  // contradictory pair unselectable in this dialog — the real guard is
  // still server-side (pmProfileConfigService.ts, Part F).
  const isAntigravity = product === 'antigravity';
  const antigravityDerivedTier = isAntigravity ? deriveAntigravityReasoningTier(model) : null;
  const effectiveReasoning = isAntigravity ? antigravityDerivedTier : reasoning.trim() || null;

  // P11-R5.1 Part L/M: narrows the product-wide `reasoning.levels` to the
  // selected model's own proven subset when the backend's capability
  // exposes per-model variation (modelEffortLevels) — a generic
  // capability-driven fallback to the product-wide list when no model is
  // selected yet or the backend has no such variation, never a
  // backend-specific branch.
  const effectiveReasoningLevels = (model && capability?.modelDiscovery.modelEffortLevels?.[model]) || capability?.reasoning.levels || null;

  const submit = async () => {
    if (!idValid || idTaken) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate({ id: effectiveId.trim(), product, ...(isApi ? { provider: 'openrouter' } : {}), model: model.trim() || null, reasoning: effectiveReasoning });
      if (result.ok) {
        onCreated();
        onClose();
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
        aria-labelledby="pm-profile-create-title"
        tabIndex={-1}
        className="pm-profile-create-dialog card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="pm-profile-create-title" className="section-title">{variantOf ? `Create Variant of ${variantOf.id}` : `Create PM Profile — ${product}`}</h3>
        {variantOf && (
          <p className="pm-profile-create-hint">
            Pick a different model and/or reasoning below, then create — <strong>{variantOf.id}</strong> itself is never changed. A different model or reasoning is a different PM profile.
          </p>
        )}

        <label className="pm-profile-create-field">
          Profile id
          <input value={effectiveId} onChange={(e) => { setIdTouched(true); setId(e.target.value); }} disabled={busy} placeholder={suggestedId} />
        </label>
        {effectiveId.trim() && !idValid && <div className="pm-profile-create-warning">Id must start with a letter/digit and contain only letters, digits, . _ : -</div>}
        {idTaken && <div className="pm-profile-create-warning">A profile with this id already exists — choose a different id (never silently overwritten).</div>}

        {isApi && <div className="pm-profile-create-field-static">Provider: <strong>OpenRouter — PRIMARY API PROVIDER</strong></div>}
        {isApi && <label className="pm-profile-create-field">Search models<input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} disabled={busy || models.length === 0} placeholder="Model ID or name" /></label>}
        {isApi && <button className="btn btn-secondary" onClick={() => void refreshModels()} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh OpenRouter Models'}</button>}
        {isApi && modelsRetrievedAt && <div className="pm-profile-create-hint">Live catalogue retrieved {new Date(modelsRetrievedAt).toLocaleString()} · {models.length} models</div>}
        <label className="pm-profile-create-field">
          Model {capability?.modelDiscovery.supported ? '' : '(manual entry — no model-list command discovered for this CLI)'}
          {isApi ? (
            <select value={model} onChange={(e) => { setModel(e.target.value); setReasoning(''); }} disabled={busy || models.length === 0}>
              <option value="">{models.length ? '(select a live OpenRouter model)' : '(refresh models first)'}</option>
              {variantOf?.model && !models.some((m) => m.id === variantOf.model) && <option value={variantOf.model}>{variantOf.model} (currently unavailable)</option>}
              {visibleModels.map((m) => <option key={m.id} value={m.id}>{m.name ? `${m.name} — ` : ''}{m.id}</option>)}
            </select>
          ) : capability?.modelDiscovery.supported && capability.modelDiscovery.models ? (
            // P11-R5.1 Part T/U: generic, data-driven select — `modelLabels`
            // and `modelEffortLevels` are optional per-backend-agnostic maps
            // (BackendCapability.modelDiscovery); a backend with no distinct
            // labels/per-model effort variation simply omits them and this
            // renders exactly as it did before. Selecting a model that has a
            // narrower proven effort set than the currently-picked reasoning
            // clears reasoning rather than leaving an unproven combination
            // selected (Part K "no fake option").
            <select
              value={model}
              onChange={(e) => {
                const nextModel = e.target.value;
                setModel(nextModel);
                const nextLevels = capability?.modelDiscovery.modelEffortLevels?.[nextModel];
                if (Array.isArray(nextLevels) && reasoning && !nextLevels.includes(reasoning)) setReasoning('');
              }}
              disabled={busy}
            >
              <option value="">Default / CLI-selected model</option>
              {capability.modelDiscovery.models.map((m) => (
                <option key={m} value={m}>
                  {capability.modelDiscovery.modelLabels?.[m] ?? m}
                </option>
              ))}
            </select>
          ) : (
            <input value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} placeholder="Model ID (optional)" />
          )}
        </label>
        {/* P11-R5/R5.1 Part N/Q: truthful provenance for whatever populated
            the Model control above — a LIVE CLI query ("claude --help",
            "opencode models", "grok models", "agy models", `debug models`)
            vs a bounded, explicitly DSH-managed JSON fallback catalogue
            (used only when a backend's live discovery is unavailable —
            see src/pm/codex-model-catalogue.mjs) must never look the same
            to the owner. `capability.modelDiscovery.source` already
            carries this distinction (production-pm-backend-registry.mjs's
            #buildCapability); this is the first place any renderer
            surfaces it. */}
        {!isApi && capability?.modelDiscovery.supported && capability.modelDiscovery.source && (
          <div className="pm-profile-create-hint">{capability.modelDiscovery.source}</div>
        )}

        {isApi ? (
          <label className="pm-profile-create-field">
            Reasoning ({selectedApiModel?.reasoningSupport ?? 'UNKNOWN'})
            <select value={reasoning} onChange={(e) => setReasoning(e.target.value)} disabled={busy || selectedApiModel?.reasoningSupport !== 'SUPPORTED'}>
              <option value="">default (provider/model default)</option>
              {selectedApiModel?.reasoningOptions.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        ) : isAntigravity ? (
          <label className="pm-profile-create-field">
            Reasoning {antigravityDerivedTier ? '(derived from model — read-only)' : "(this model has no reasoning tier — managed by CLI/model, left blank)"}
            <input value={antigravityDerivedTier ?? ''} readOnly disabled placeholder={antigravityDerivedTier ? undefined : 'not applicable for this model'} />
          </label>
        ) : capability?.reasoning.selection === 'SUPPORTED' && Array.isArray(effectiveReasoningLevels) ? (
          // P11-R5/R5.1 Part N/O/S/L: the SAME generic capability contract
          // (reasoningCapabilityFor() — src/pm/pm-reasoning-capability.mjs)
          // already existed; this branch is the first renderer to actually
          // use levels as a real, enforced dropdown rather than only a
          // free-text placeholder hint. `effectiveReasoningLevels` narrows
          // to the selected model's own proven subset when the backend
          // exposes per-model variation (modelEffortLevels) — never a
          // backend-specific branch, just this one shared condition. Grok
          // (`levels: null` — the CLI documents the flag but does not
          // enumerate accepted values) correctly falls through to the
          // manual-entry branch below instead.
          <label className="pm-profile-create-field">
            Reasoning
            <select value={reasoning} onChange={(e) => setReasoning(e.target.value)} disabled={busy}>
              <option value="">default (managed by CLI/model)</option>
              {effectiveReasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {capability?.reasoning.labels?.[level] ?? level}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="pm-profile-create-field">
            Reasoning {capability?.reasoning.selection === 'SUPPORTED' ? '' : '(managed by CLI/model — leave blank)'}
            <input value={reasoning} onChange={(e) => setReasoning(e.target.value)} disabled={busy || capability?.reasoning.selection !== 'SUPPORTED'} placeholder={effectiveReasoningLevels?.join(' / ') ?? 'optional'} />
          </label>
        )}

        <div className="pm-profile-create-field-static">
          Session kind: <span>STATELESS</span> · Transport: <span>{isApi ? 'http' : 'stdio'}</span>
        </div>

        {error && <div className="pm-profile-create-error">{error}</div>}

        <div className="pm-profile-create-actions">
          <button className="btn btn-secondary" onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !idValid || idTaken || (isApi && !model)}>
            {busy ? 'Creating…' : variantOf ? 'Create Variant' : 'Create PM Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PmProfileCreateDialog;
