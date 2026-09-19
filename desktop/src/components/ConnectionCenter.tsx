import React, { useEffect, useState } from 'react';
import { Connection, BackendCapability, PmProfileEntry, ApiProviderStatus } from '../../electron/main/types';
import type { RelayRunnerOperationResult, RelayRunnerState, RelayRunnerStatus } from '../../electron/main/services/relayRunnerLifecycleManager';
import './ConnectionCenter.css';

interface ConnectionCenterProps {
  connections: Connection[];
  capabilities: BackendCapability[];
  pmProfileEntries: PmProfileEntry[];
  lastChecked: Date | null;
  // P6-W3-R4.1 Part R41-1/R41-6: a key set ('ALL' and/or product names)
  // rather than one string — an 'ALL' refresh and an independent
  // per-product refresh can each be busy at the same time without one
  // clobbering the other's UI state.
  refreshingKeys: ReadonlySet<string>;
  onOpenLoginTerminal: (product: string, mode: 'login' | 'logout') => void;
  onRefreshAll: () => void;
  onRefreshOne: (product: string) => void;
  onCreateProfile: (product: string) => void;
  // P8-R0.2 Part C/D: opens the create dialog seeded from an EXISTING
  // profile's execution config (model/reasoning) so the owner can pick a
  // different one under a new canonical id — the source profile itself is
  // never mutated (there is no more in-place Save for execution identity;
  // see PmProfileConfigService#update).
  onCreateVariant: (profile: PmProfileEntry) => void;
  // P11-R4.1 Part E/G: the `api` product's one credential action, replacing
  // CLI-style Login/Logout (which do not apply to an HTTP backend). Opens
  // the trusted Update API Key flow (main-process-only write — see
  // UpdateApiKeyDialog.tsx / apiKeyUpdateService.ts). Currently scoped to
  // OpenRouter only (the sole active production API provider).
  onUpdateApiKey: () => void;
}

// P6-W3-R4 Part J: explicit, separate terminology — never "HEALTHY
// UNKNOWN" without labels. Health = configured-profile execution health
// (existing M07 evidence). Authentication = the real native CLI auth probe
// (Part A). These are two different facts about two different layers
// (Layer A native connection vs Layer B DSH PM configuration) and must
// never be collapsed into one indicator.
const HEALTH_COLOR: Record<string, string> = {
  HEALTHY: 'var(--dsh-status-success)',
  DEGRADED: 'var(--dsh-status-warning)',
  UNHEALTHY: 'var(--dsh-status-error)',
  UNKNOWN: 'var(--dsh-text-muted)',
};
const HEALTH_LABEL: Record<string, string> = { HEALTHY: '●', DEGRADED: '◐', UNHEALTHY: '○', UNKNOWN: '?' };
const AUTH_COLOR: Record<string, string> = {
  LOGGED_IN: 'var(--dsh-status-success)',
  LOGGED_OUT: 'var(--dsh-status-error)',
  UNKNOWN: 'var(--dsh-text-muted)',
  ERROR: 'var(--dsh-status-error)',
};
const AUTH_LABEL: Record<string, string> = { LOGGED_IN: 'Logged in', LOGGED_OUT: 'Logged out', UNKNOWN: 'Unknown', ERROR: 'Error' };

function ConnectionCenter({
  connections,
  capabilities,
  pmProfileEntries,
  lastChecked,
  refreshingKeys,
  onOpenLoginTerminal,
  onRefreshAll,
  onRefreshOne,
  onCreateProfile,
  onCreateVariant,
  onUpdateApiKey,
}: ConnectionCenterProps) {
  const allBusy = refreshingKeys.has('ALL');
  return (
    <div className="connection-center">
      <div className="connection-header">
        <h3 className="section-title">Connection Center</h3>
        {/* P6-W3-R4.2 Part R42-7: periodic background refresh was removed
            (R4-M02) — this hint is the one place that tells the owner why
            a status can sit unchanged for a while: it is refreshed on
            demand, by design. Never a warning merely because time has
            passed. */}
        <p className="connection-refresh-hint">Status is refreshed on demand.</p>
        <div className="connection-header-actions">
          {lastChecked && <span className="connection-last-checked">Last checked: {lastChecked.toLocaleTimeString()}</span>}
          <button className="btn btn-secondary" onClick={onRefreshAll} disabled={allBusy}>
            {allBusy ? 'Refreshing…' : 'Refresh All'}
          </button>
        </div>
      </div>

      <div className="connection-list">
        <RelayRunnerCard />
        {capabilities.length === 0 && <div className="connection-empty">Loading backend connections…</div>}

        {capabilities.map((cap) => {
          const configuredProfiles = connections.filter((c) => c.backend === cap.product);
          const overallHealth = configuredProfiles.length === 0 ? 'UNKNOWN' : configuredProfiles.some((p) => p.health === 'HEALTHY') ? 'HEALTHY' : 'UNHEALTHY';
          const productProfiles = pmProfileEntries.filter((p) => p.product === cap.product);
          const busy = allBusy || refreshingKeys.has(cap.product);

          return (
            // UI V2.2: dropped the shared `.card` class (padding/border/
            // radius meant for a standalone surface) — this is now a
            // compact operator unit, divided from its neighbors by a thin
            // border-bottom rule (`.connection-card`, ConnectionCenter.css)
            // instead of each one being its own boxed card. See
            // UI_V2_DENSE_COMPONENTS_IMPLEMENTATION.md §5.
            <div key={cap.product} className="connection-card">
              <div className="connection-card-header">
                <span className="connection-name">{cap.product}</span>
                <span className="connection-health" style={{ color: HEALTH_COLOR[overallHealth] }} title={`configured-profile execution health: ${overallHealth}`}>
                  {HEALTH_LABEL[overallHealth]} {overallHealth}
                </span>
              </div>

              <div className="connection-section-label">Connection</div>
              <div className="connection-details">
                {/* P11-R1/R4.1: 'api' has no CLI at all (cliInstalled is
                    honestly `null`) — showing "CLI: Missing" would be
                    misleading, so that line (and the CLI-only
                    Authentication line, which always reads
                    SEE_PROVIDERS/UNCONFIGURED for 'api') is skipped here.
                    Per-provider debug detail (API Providers/Scope/Check
                    live) is deliberately NOT rendered in this normal owner
                    card as of R4.1 — see ApiProviderList's own docstring
                    below for where that detail still lives. */}
                {cap.product !== 'api' && (
                  <div className="connection-detail">
                    <span className="connection-detail-label">CLI:</span>
                    <span className={cap.cliInstalled ? 'connection-yes' : 'connection-no'}>{cap.cliInstalled ? 'Installed' : 'Missing'}</span>
                  </div>
                )}
                {cap.cliVersion && (
                  <div className="connection-detail">
                    <span className="connection-detail-label">Version:</span>
                    <span>{cap.cliVersion}</span>
                  </div>
                )}
                {cap.product !== 'api' && (
                  <div className="connection-detail">
                    <span className="connection-detail-label">Authentication:</span>
                    <span style={{ color: AUTH_COLOR[cap.authState] }} title={cap.authDetail ?? undefined}>
                      {AUTH_LABEL[cap.authState] ?? cap.authState}
                    </span>
                  </div>
                )}
                <div className="connection-detail">
                  <span className="connection-detail-label">Backend:</span>
                  <span className={cap.dshBackendAvailable ? 'connection-yes' : 'connection-no'}>{cap.dshBackendAvailable ? 'Available' : 'Unavailable'}</span>
                </div>
                <div className="connection-detail">
                  <span className="connection-detail-label">Session kind:</span>
                  <span>{cap.sessionKinds.join(', ')}</span>
                </div>
                {cap.nativeDefaultModel && (
                  <div className="connection-detail">
                    <span className="connection-detail-label">CLI default model:</span>
                    <span className="connection-unknown">{cap.nativeDefaultModel}</span>
                  </div>
                )}
                <div className="connection-detail">
                  <span className="connection-detail-label">Checked:</span>
                  <span className="connection-unknown">{new Date(cap.authCheckedAt).toLocaleTimeString()}</span>
                </div>
              </div>

              <div className="connection-login-actions">
                <button className="btn btn-secondary" onClick={() => onRefreshOne(cap.product)} disabled={busy}>
                  {busy ? 'Refreshing…' : 'Refresh'}
                </button>
                {/* P11-R4.1 Part E/G/J: `api` has neither Login nor Logout
                    (an HTTP backend has no session to log into) — its one
                    credential action is Update API Key instead. Every CLI
                    backend's Login/Logout below is completely unchanged. */}
                {cap.product === 'api' && (
                  <button className="btn btn-secondary" onClick={onUpdateApiKey}>
                    Update API Key…
                  </button>
                )}
                {cap.loginCommandSupported && (
                  <button className="btn btn-secondary" onClick={() => onOpenLoginTerminal(cap.product, 'login')}>
                    Login…
                  </button>
                )}
                {cap.logoutCommandSupported && (
                  <button className="btn btn-secondary" onClick={() => onOpenLoginTerminal(cap.product, 'logout')}>
                    Logout…
                  </button>
                )}
              </div>

              <div className="connection-section-label">DSH PM Configuration</div>
              {productProfiles.length === 0 ? (
                <div className="connection-no-profile">
                  <p>No PM profile configured.</p>
                  <button className="btn btn-primary" onClick={() => onCreateProfile(cap.product)}>
                    + Create PM Profile
                  </button>
                </div>
              ) : (
                <PmProfilePanel
                  product={cap.product}
                  profiles={productProfiles}
                  onCreateProfile={onCreateProfile}
                  onCreateVariant={onCreateVariant}
                  configuredEvidence={configuredProfiles}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RUNNER_STATUS_LABEL: Record<RelayRunnerState, string> = {
  UNCONFIGURED: 'OFFLINE', REGISTERED_OFFLINE: 'OFFLINE', STARTING: 'STARTING',
  RUNNING_ONLINE_UNVERIFIED: 'RUNNING UNVERIFIED', ONLINE_IDLE: 'IDLE', ONLINE_BUSY: 'BUSY',
  DEGRADED: 'DEGRADED', STOPPING: 'STOPPING', FAILED: 'FAILED',
};

function RelayRunnerCard() {
  const [status, setStatus] = useState<RelayRunnerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [autoStart, setAutoStart] = useState(false);

  const acceptStatus = (next: RelayRunnerStatus | null) => {
    if (!next) return;
    setStatus(next);
    setEnabled(next.enabled);
    setAutoStart(next.autoStart);
  };

  useEffect(() => {
    void window.desktop.relayRunner.getStatus().then(acceptStatus);
    return window.desktop.relayRunner.onStatusChange(acceptStatus);
  }, []);

  const invoke = async (operation: () => Promise<RelayRunnerOperationResult | RelayRunnerStatus | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await operation();
      if (result && 'ok' in result) {
        acceptStatus(result.status);
        if (!result.ok) setMessage(result.message ?? result.code ?? 'Runner operation failed.');
      } else acceptStatus(result);
      if (logs !== null) setLogs(await window.desktop.relayRunner.getLogs());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Runner operation failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="connection-card"><span className="connection-name">GitHub Relay Runner</span><p className="connection-refresh-hint">Loading runner status…</p></div>;
  const stopped = status.state === 'REGISTERED_OFFLINE';
  const controllable = status.ownership === 'APP_OWNED' && status.state !== 'ONLINE_BUSY' && status.state !== 'STOPPING';
  const ownershipLabel = status.ownership === 'APP_OWNED' ? 'APP' : status.ownership;

  return (
    <div className="connection-card relay-runner-card" data-testid="relay-runner-card">
      <div className="connection-card-header">
        <span className="connection-name">GitHub Relay Runner</span>
        <span className={`runner-state runner-state-${status.state.toLowerCase()}`}>{RUNNER_STATUS_LABEL[status.state]}</span>
      </div>
      <div className="connection-details">
        <div className="connection-detail"><span className="connection-detail-label">Registration:</span><span>{status.registration === 'REGISTERED' ? 'REGISTERED' : status.registration === 'NOT_CONFIGURED' ? 'NOT CONFIGURED' : 'INVALID'}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Status:</span><span>{RUNNER_STATUS_LABEL[status.state]}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Ownership:</span><span>{ownershipLabel}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Version:</span><span>{status.version ?? 'Unknown'}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">PID:</span><span>{status.pid ?? '—'}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Runner path:</span><span className="runner-path-value">{status.runnerPath ?? 'Not configured'}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Auto Start:</span><span>{status.autoStart ? 'ON' : 'OFF'}</span></div>
        <div className="connection-detail"><span className="connection-detail-label">Last checked:</span><span>{new Date(status.lastChecked).toLocaleTimeString()}</span></div>
      </div>
      {status.lastError && <p className="runner-error">{status.lastError.message}</p>}
      {message && <p className="runner-error">{message}</p>}
      <div className="connection-login-actions runner-actions">
        <button className="btn btn-secondary" disabled={busy} onClick={() => void invoke(() => window.desktop.relayRunner.refresh())}>Refresh</button>
        <button className="btn btn-secondary" disabled={busy || !status.enabled || status.registration !== 'REGISTERED' || !stopped} onClick={() => void invoke(() => window.desktop.relayRunner.start())}>Start</button>
        <button className="btn btn-secondary" disabled={busy || !controllable} title={status.state === 'ONLINE_BUSY' ? 'Active relay job is protected' : undefined} onClick={() => void invoke(() => window.desktop.relayRunner.stop())}>Stop</button>
        <button className="btn btn-secondary" disabled={busy || !controllable} title={status.state === 'ONLINE_BUSY' ? 'Active relay job is protected' : undefined} onClick={() => void invoke(() => window.desktop.relayRunner.restart())}>Restart</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void (async () => setLogs(logs === null ? await window.desktop.relayRunner.getLogs() : null))()}>{logs === null ? 'Open Logs' : 'Close Logs'}</button>
      </div>
      {logs !== null && <pre className="runner-logs">{logs.length ? logs.join('\n') : 'No runner lifecycle logs.'}</pre>}
      <div className="connection-section-label">Runner settings</div>
      <label className="runner-setting"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label>
      <label className="runner-setting"><input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} /> Auto Start</label>
      {/* P0-3: the runner directory is never renderer-supplied free text —
          it can only be chosen through a MAIN-process-owned native OS
          folder picker (see main.ts's `relayRunner:pickFolder` handler),
          which validates and persists the OS-selected path itself. This
          button carries no path value at all; it is a bare request. */}
      <button className="btn btn-secondary" disabled={busy || status.ownership === 'APP_OWNED'} title={status.ownership === 'APP_OWNED' ? 'Stop the app-owned runner before changing its path' : undefined} onClick={() => void invoke(() => window.desktop.relayRunner.pickFolder())}>Configure Runner…</button>
      <button className="btn btn-secondary runner-save" disabled={busy} onClick={() => void invoke(() => window.desktop.relayRunner.updateSettings({ enabled, autoStart }))}>Save Settings</button>
    </div>
  );
}

interface PmProfilePanelProps {
  product: string;
  profiles: PmProfileEntry[];
  onCreateProfile: (product: string) => void;
  onCreateVariant: (profile: PmProfileEntry) => void;
  configuredEvidence: Connection[];
}

// P8-R0.2 Part B: a PM profile's execution identity — product, model,
// reasoning — is fixed at creation and never edited in place (see
// PmProfileConfigService#update, which refuses PM_PROFILE_IDENTITY_
// IMMUTABLE regardless of what this renderer does). This panel is now a
// read-only view of that identity plus one action: "Create Variant", which
// opens PmProfileCreateDialog seeded from the selected profile's model/
// reasoning to create a DIFFERENT, brand-new canonical profile — the
// selected profile itself is never touched.
//
// P6-W3-R4 Part C/E/F/H: the profile selector only changes which
// configuration is being viewed here — it never changes which profile is
// the project's default PM (that stays governed by Composer/project rules
// per Part H).
function PmProfilePanel({ product, profiles, onCreateProfile, onCreateVariant, configuredEvidence }: PmProfilePanelProps) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? '');
  useEffect(() => {
    if (!profiles.some((p) => p.id === selectedId)) setSelectedId(profiles[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.map((p) => p.id).join(',')]);

  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0];
  if (!selected) return null;

  const evidence = configuredEvidence.find((c) => c.profileId === selected.id);

  return (
    <div className="pm-profile-panel">
      {/* P9-R0.4 Part B/L: this is the full DSH PM Configuration view for the
          product — every profile regardless of lifecycle status, so an
          INACTIVE one is marked rather than hidden (lifecycle ACTIONS live
          on the dedicated PM Profile Management card, not here). */}
      {profiles.length > 1 && (
        <label className="pm-profile-field">
          Profile
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayLabel} — {p.id}
                {p.status === 'INACTIVE' ? ' [INACTIVE]' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {profiles.length === 1 && (
        <div className="pm-profile-single-id">
          {selected.displayLabel} — {selected.id}
          {selected.status === 'INACTIVE' ? ' [INACTIVE]' : ''}
        </div>
      )}

      {evidence && (
        <div className="connection-detail">
          <span className="connection-detail-label">Execution evidence:</span>
          <span className={evidence.authStatus === 'UNKNOWN' ? 'connection-unknown' : evidence.authStatus?.startsWith('FAILED') ? 'connection-no' : 'connection-yes'}>{evidence.authStatus}</span>
        </div>
      )}

      <div className="pm-profile-field">
        <span className="pm-profile-field-label">Model</span>
        <span className="pm-profile-readonly">{selected.model ?? 'default/inherited (CLI default)'}</span>
      </div>

      <div className="pm-profile-field">
        <span className="pm-profile-field-label">Reasoning</span>
        <span className="pm-profile-readonly">{selected.reasoning ?? 'default/inherited (CLI/model default)'}</span>
      </div>

      {/* P11-R4.2 Part E/F/N: freshly read on every pmProfiles:list() call
          (never cached — see main.ts) — "Not yet assigned" is the honest,
          expected state for a profile created while no runtime is running,
          or in the brief window before the create-triggered hot-reload's
          alias write completes; it is never a real product gap. The bare
          PM-profile alias number is shown here — the owner's Telegram
          shorthand additionally prefixes a PROJECT alias
          (`<project_alias>-<pm_alias>`, e.g. `2-17`), which is a
          per-task project selection, not part of this profile's own
          identity, so it is deliberately not fabricated here. */}
      <div className="pm-profile-field">
        <span className="pm-profile-field-label">Alias</span>
        <span className="pm-profile-readonly">{selected.alias ?? 'Not yet assigned'}</span>
      </div>

      <p className="pm-profile-identity-note">
        Execution identity (product · model · reasoning) is fixed once a profile is created — a different model or reasoning is a different PM profile. Historical task/run records stay meaningful because this profile's configuration never changes underneath them.
      </p>

      <div className="pm-profile-actions">
        <button className="btn btn-primary" onClick={() => onCreateVariant(selected)}>
          Create Variant
        </button>
        <button className="btn btn-secondary" onClick={() => onCreateProfile(product)}>
          + Add another profile
        </button>
      </div>
    </div>
  );
}

// P11-R1 Part G/H: originally the normal owner API card's per-provider
// detail (CONFIGURED/key-present truth plus an owner-triggered "Check
// live" probe — see backends:apiProviderLive in main.ts). P11-R4.1 Part
// C/AG: the owner rejected this as implementation/debug noise (five
// providers including two deliberately-broken test fixtures and two
// deferred providers) for the normal card — ConnectionCenter no longer
// mounts this component there. Left in place, unmounted, as a developer/
// diagnostic building block (Part AG: "do not delete useful backend/
// provider code just to hide the UI") — a future developer-diagnostics
// surface can still render it; `backends:apiProviderLive`/the per-provider
// readiness IPC it depends on are untouched.
const READY_LABEL: Record<string, string> = {
  CONFIGURED: 'Configured (no key)',
  KEY_PRESENT: 'Key present (not yet live-checked)',
  REACHABLE: 'Reachable',
  AUTH_FAILED: 'Auth failed',
  RATE_LIMITED: 'Rate limited',
  UNAVAILABLE: 'Unavailable',
  UNKNOWN: 'Unknown',
};
const READY_COLOR: Record<string, string> = {
  CONFIGURED: 'var(--dsh-text-muted)',
  KEY_PRESENT: 'var(--dsh-text-muted)',
  REACHABLE: 'var(--dsh-status-success)',
  AUTH_FAILED: 'var(--dsh-status-error)',
  RATE_LIMITED: 'var(--dsh-status-warning)',
  UNAVAILABLE: 'var(--dsh-status-error)',
  UNKNOWN: 'var(--dsh-text-muted)',
};

export function ApiProviderList({ providers }: { providers: ApiProviderStatus[] }) {
  // Ephemeral, component-local only — a live result is a point-in-time
  // proof, never persisted, never conflated with the zero-network
  // CONFIGURED/KEY_PRESENT truth `providers` itself already carries.
  const [liveStatus, setLiveStatus] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  if (providers.length === 0) {
    return (
      <div className="connection-no-profile">
        <p>No API providers configured. See config/api-providers.example.yaml.</p>
      </div>
    );
  }

  const checkLive = async (id: string) => {
    setChecking((prev) => ({ ...prev, [id]: true }));
    try {
      const result = await window.desktop.backends.apiProviderLive(id);
      setLiveStatus((prev) => ({ ...prev, [id]: result?.status ?? 'UNKNOWN' }));
    } finally {
      setChecking((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <>
      <div className="connection-section-label">API Providers</div>
      {providers.map((provider) => {
        const status = liveStatus[provider.id] ?? provider.status;
        return (
          <div key={provider.id} className="connection-details">
            <div className="connection-detail">
              <span className="connection-detail-label">{provider.id}:</span>
              <span className={provider.keyPresent ? 'connection-yes' : 'connection-no'}>{provider.keyPresent ? 'Key present' : 'Key missing'}</span>
            </div>
            <div className="connection-detail"><span className="connection-detail-label">Scope:</span><span>{provider.id === 'openrouter' ? 'PRIMARY / PRODUCTION / LIVE_PROVEN' : 'DEFERRED_POST_P11 / INACTIVE'}</span></div>
            <div className="connection-detail">
              <span className="connection-detail-label">Live:</span>
              <span style={{ color: READY_COLOR[status] ?? 'var(--dsh-text-muted)' }} title="Key present is env-only truth — Check live proves an actual HTTP round trip (non-billable — a plain GET, no generation)">
                {READY_LABEL[status] ?? status}
              </span>
            </div>
            <button className="btn btn-secondary" onClick={() => void checkLive(provider.id)} disabled={checking[provider.id] || !provider.keyPresent}>
              {checking[provider.id] ? 'Checking…' : 'Check live'}
            </button>
          </div>
        );
      })}
    </>
  );
}

export default ConnectionCenter;
