import React, { useMemo, useState } from 'react';
import { PmProfileEntry, PmProfileWriteResult } from '../../electron/main/types';
import './PmProfileManagement.css';

type LifecycleFilter = 'ACTIVE' | 'INACTIVE' | 'ALL';

interface PmProfileManagementProps {
  profiles: PmProfileEntry[];
  onDeactivate: (id: string) => Promise<PmProfileWriteResult>;
  onReactivate: (id: string) => Promise<PmProfileWriteResult>;
}

// P9-R0.4 Part L: a dedicated, compact PM Profile Management surface —
// deliberately separate from Connection Center (which stays a per-product
// config/health view) so lifecycle status/actions have one clear home as
// the profile count grows. Read-only except for the two SAFE lifecycle
// actions (Deactivate/Reactivate, Part D) — there is no Edit Identity and
// no Delete here (Part E/L): a different execution config is always a
// "Create Variant" (Connection Center), never an in-place edit or removal.
function PmProfileManagement({ profiles, onDeactivate, onReactivate }: PmProfileManagementProps) {
  // Part M: Active/Inactive/All, defaulting Active.
  const [filter, setFilter] = useState<LifecycleFilter>('ACTIVE');
  const [productFilter, setProductFilter] = useState<string>('ALL');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  const products = useMemo(() => [...new Set(profiles.map((p) => p.product))].sort(), [profiles]);

  // P9-R0.4.1 Part G: an OPTIONAL, cheap diagnostic only — deliberately NOT
  // the trusted duplicate guard (that lives server-side in
  // PmProfileConfigService.create(), using the real executionIdentityKey —
  // src/pm/pm-profile-identity.mjs). This is a passive display hint so an
  // INACTIVE profile that duplicates an existing one is easy to notice
  // rather than a security boundary, so a small inline copy of the same
  // six-field comparison is an acceptable, low-risk exception to "one
  // canonical helper" here — nothing this computes is ever trusted for
  // acceptance/rejection of anything.
  const equivalentIdById = useMemo(() => {
    const keyOf = (p: PmProfileEntry) => JSON.stringify([p.role_kind ?? 'PM', p.session_kind, p.product, p.transport, p.model ?? null, p.reasoning ?? null]);
    const firstByKey = new Map<string, string>();
    const map = new Map<string, string>();
    for (const p of profiles) {
      const key = keyOf(p);
      const first = firstByKey.get(key);
      if (first && first !== p.id) map.set(p.id, first);
      else if (!first) firstByKey.set(key, p.id);
    }
    return map;
  }, [profiles]);

  const visible = profiles.filter((p) => {
    if (filter !== 'ALL' && p.status !== filter) return false;
    if (productFilter !== 'ALL' && p.product !== productFilter) return false;
    return true;
  });

  const runAction = async (id: string, action: (id: string) => Promise<PmProfileWriteResult>) => {
    setBusyId(id);
    setErrorById((prev) => ({ ...prev, [id]: '' }));
    try {
      const result = await action(id);
      if (!result.ok) {
        setErrorById((prev) => ({ ...prev, [id]: `${result.code}: ${result.message}` }));
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pm-profile-management card">
      <div className="pm-profile-management-header">
        <h3 className="section-title">PM Profile Management</h3>
        <p className="pm-profile-management-hint">
          Deactivate a profile to hide it from Single/Chair/Participant selectors. Nothing is ever deleted — canonical ids and aliases stay reserved forever, and historical runs keep their full identity.
        </p>
      </div>

      <div className="pm-profile-management-filters">
        <div className="pm-profile-management-filter-group" role="radiogroup" aria-label="Lifecycle filter">
          {(['ACTIVE', 'INACTIVE', 'ALL'] as LifecycleFilter[]).map((value) => (
            <label key={value} className="pm-profile-management-filter-option">
              <input type="radio" name="pm-profile-lifecycle-filter" checked={filter === value} onChange={() => setFilter(value)} />
              {value === 'ACTIVE' ? 'Active' : value === 'INACTIVE' ? 'Inactive' : 'All'}
            </label>
          ))}
        </div>
        {products.length > 1 && (
          <select className="pm-profile-management-product-filter" value={productFilter} onChange={(e) => setProductFilter(e.target.value)}>
            <option value="ALL">All backends</option>
            {products.map((product) => (
              <option key={product} value={product}>
                {product}
              </option>
            ))}
          </select>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="pm-profile-management-empty">No {filter === 'ALL' ? '' : filter.toLowerCase()} PM profiles.</div>
      ) : (
        <div className="pm-profile-management-list">
          {visible.map((p) => (
            <div key={p.id} className="pm-profile-management-row">
              <div className="pm-profile-management-row-main">
                <span className={`pm-profile-management-status pm-profile-management-status-${p.status.toLowerCase()}`}>{p.status}</span>
                <span className="pm-profile-management-text">
                  <span className="pm-profile-management-label">{p.displayLabel}</span>
                  <span className="pm-profile-management-id">{p.id}</span>
                  {equivalentIdById.has(p.id) && <span className="pm-profile-management-equivalent">Equivalent to: {equivalentIdById.get(p.id)}</span>}
                </span>
              </div>
              <div className="pm-profile-management-actions">
                {p.status === 'ACTIVE' ? (
                  <button className="btn btn-secondary" onClick={() => runAction(p.id, onDeactivate)} disabled={busyId === p.id}>
                    {busyId === p.id ? 'Deactivating…' : 'Deactivate'}
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={() => runAction(p.id, onReactivate)} disabled={busyId === p.id}>
                    {busyId === p.id ? 'Reactivating…' : 'Reactivate'}
                  </button>
                )}
              </div>
              {errorById[p.id] && <div className="pm-profile-management-error">{errorById[p.id]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PmProfileManagement;
