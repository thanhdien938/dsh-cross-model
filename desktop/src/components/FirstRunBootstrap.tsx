import React, { useEffect, useState } from 'react';
import './FirstRunBootstrap.css';

// M01/M02: shown instead of the normal app whenever main.ts reports
// requiresFirstRun (no valid DSH repo root resolved from env/setting/dev
// fallback) or the resolved bootstrap is not yet ready to start (missing
// production config / missing required secret env names). Only path
// references and CONFIGURED/MISSING/INVALID states are ever shown here —
// never a secret value.
function FirstRunBootstrap() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.desktop.bootstrap.status>> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Always the CURRENT bootstrap:status — M08 fixed the main process to
  // recompute this live on every call, so refresh() genuinely reflects
  // whatever was just persisted, not a startup snapshot.
  const refresh = async () => {
    const result = await window.desktop.bootstrap.status();
    setStatus(result);
    return result;
  };

  useEffect(() => {
    refresh();
  }, []);

  const pick = async (which: 'pickRepoRoot' | 'pickProductionConfig' | 'pickEnvFile') => {
    setMessage(null);
    const result = await window.desktop.bootstrap[which]();
    if (!result) return;
    if (!result.ok) {
      setMessage(result.message ?? result.code ?? 'Selection was rejected.');
      return;
    }
    const fresh = await refresh();
    setMessage(
      fresh.status?.readyToStart
        ? 'Configuration saved. Restart DSH Desktop to initialize the runtime.'
        : `Saved: ${result.path}`,
    );
  };

  if (!status) return <div className="first-run-loading">Loading…</div>;

  return (
    <div className="first-run">
      <div className="first-run-card card">
        <h2>DSH runtime location required</h2>
        <p className="first-run-intro">
          DSH Desktop could not find your DSH repository checkout automatically. Configure it below — this is a one-time setup.
        </p>

        <div className="first-run-row">
          <div className="first-run-row-label">
            DSH repository
            <span className={`first-run-badge first-run-badge-${status.status?.repoRoot.state.toLowerCase()}`}>{status.status?.repoRoot.state}</span>
          </div>
          {status.status?.repoRoot.path && <div className="first-run-path">{status.status.repoRoot.path} ({status.status.repoRoot.source})</div>}
          <button className="btn btn-primary" onClick={() => pick('pickRepoRoot')}>
            Choose folder…
          </button>
        </div>

        {status.status?.repoRoot.state === 'CONFIGURED' && (
          <>
            <div className="first-run-row">
              <div className="first-run-row-label">
                Production config
                <span className={`first-run-badge first-run-badge-${status.status.productionConfig.state.toLowerCase()}`}>{status.status.productionConfig.state}</span>
              </div>
              {status.status.productionConfig.path && <div className="first-run-path">{status.status.productionConfig.path} ({status.status.productionConfig.source})</div>}
              <button className="btn btn-secondary" onClick={() => pick('pickProductionConfig')}>
                Choose file…
              </button>
            </div>

            <div className="first-run-row">
              <div className="first-run-row-label">
                .env secrets file
                <span className={`first-run-badge first-run-badge-${status.status.envFile.state.toLowerCase()}`}>{status.status.envFile.state}</span>
              </div>
              {status.status.envFile.path && <div className="first-run-path">{status.status.envFile.path} ({status.status.envFile.source})</div>}
              <button className="btn btn-secondary" onClick={() => pick('pickEnvFile')}>
                Choose file…
              </button>
            </div>

            {status.status.requiredEnvNames.length > 0 && (
              <div className="first-run-row">
                <div className="first-run-row-label">Required secrets</div>
                <div className="first-run-env-list">
                  {status.status.requiredEnvNames.map((n) => (
                    <div key={n.name} className="first-run-env-item">
                      <span>{n.name}</span>
                      <span className={n.present ? 'connection-yes' : 'connection-no'}>{n.present ? 'PRESENT' : 'MISSING'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {message && <div className="first-run-message">{message}</div>}

        <div className="first-run-actions">
          <button className="btn btn-secondary" onClick={refresh}>
            Refresh
          </button>
          <button className="btn btn-primary" onClick={() => window.desktop.bootstrap.restartApp()} disabled={status.status?.repoRoot.state !== 'CONFIGURED'}>
            Restart DSH Desktop
          </button>
        </div>
        {status.status?.repoRoot.state === 'CONFIGURED' && !status.status.readyToStart && (
          <p className="first-run-hint">Repository configured. Set the production config and any missing secrets above, then restart.</p>
        )}
      </div>
    </div>
  );
}

export default FirstRunBootstrap;
