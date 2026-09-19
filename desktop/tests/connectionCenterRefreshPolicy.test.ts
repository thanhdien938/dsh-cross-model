import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P6-W3-R4.2 Part R42-9: App.tsx itself has no dedicated React test
// harness in this repo (no jsdom/@testing-library/react dependency — the
// same reason R4/R4.1's React-level behavior was validated by extracting
// logic into the framework-free ConnectionRefreshCoordinator instead).
// These are structural source assertions, the same technique
// desktop/tests/security.test.ts already uses for main.ts/preload.ts —
// they prove the *wiring* App.tsx does (which handler calls which
// coordinator method, with which scope) without needing to mount a real
// component tree.
const desktopRoot = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(desktopRoot, 'src/App.tsx'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(desktopRoot, 'src/lib/connectionRefreshCoordinator.ts'), 'utf8');
const connectionCenterSource = fs.readFileSync(path.join(desktopRoot, 'src/components/ConnectionCenter.tsx'), 'utf8');

describe('P6-W3-R4.2 Connection Center refresh policy — startup-once + manual only', () => {
  it('no periodic scheduler language/constant remains in App.tsx', () => {
    expect(appSource).not.toMatch(/AUTO_REFRESH_INTERVAL_MS/);
    expect(appSource).not.toMatch(/startAutoRefresh/);
    expect(appSource).not.toMatch(/coordinatorRef\.current\?\.\s*stop\(/);
  });

  it('App.tsx never calls setInterval/setTimeout for connection refresh', () => {
    // The 1s runtime-status poll (unrelated: projects/timeline/inbox, not
    // backend capabilities) is the only setInterval left in this file —
    // assert no OTHER interval/timeout call sites exist near
    // coordinatorRef, which would indicate a reintroduced scheduler.
    const coordinatorRefBlock = appSource.split('coordinatorRef').join('\n---COORDINATOR-REF---\n');
    expect(coordinatorRefBlock).not.toMatch(/---COORDINATOR-REF---[\s\S]{0,200}setInterval/);
    expect(coordinatorRefBlock).not.toMatch(/---COORDINATOR-REF---[\s\S]{0,200}setTimeout/);
  });

  it('the startup effect calls refreshAll exactly once and has no cleanup (no timer to cancel)', () => {
    const startupEffect = appSource.match(/useEffect\(\(\) => \{\s*void coordinatorRef\.current\?\.refreshAll\('full'\);\s*\}, \[\]\);/);
    expect(startupEffect).not.toBeNull();
  });

  it('runtime status changes never trigger a Connection Center refresh (R42-8)', () => {
    const statusHandler = appSource.match(/window\.desktop\.runtime\.onStatusChange\(\(newStatus: RuntimeStatus\) => \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(statusHandler).not.toMatch(/coordinatorRef/);
    expect(statusHandler).not.toMatch(/refreshAll|refreshOne/);
  });

  it('handleStart never triggers a Connection Center refresh (R42-8)', () => {
    const handleStartBlock = appSource.match(/const handleStart = async \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(handleStartBlock).not.toMatch(/coordinatorRef/);
  });

  it('handleRestart never triggers a Connection Center refresh (R42-8)', () => {
    const handleRestartBlock = appSource.match(/const handleRestart = async \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(handleRestartBlock).not.toMatch(/coordinatorRef/);
  });

  it('handleStop never triggers a Connection Center refresh (R42-8)', () => {
    const handleStopBlock = appSource.match(/const handleStop = async \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(handleStopBlock).not.toMatch(/coordinatorRef/);
  });

  it('Login/Logout success (connections:changed) refreshes only the affected product, never all four', () => {
    const handler = appSource.match(/connections\.onChanged\(\(info\) => \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(handler).toContain('refreshOne(info.product');
  });

  it('PM profile Create (and Create Variant, which reuses the same handler) never calls the native-probe coordinator', () => {
    // P8-R0.2 Part Q: handleSaveProfile/pmProfiles:update is no longer
    // called from the renderer at all — execution identity (model/
    // reasoning/product) is immutable once a profile exists, so create()
    // (a brand-new canonical id, either a fresh profile or a "variant") is
    // the only PM-profile write path App.tsx still exposes.
    expect(appSource).not.toMatch(/const handleSaveProfile/);
    expect(appSource).not.toMatch(/window\.desktop\.pmProfiles\.update/);
    const createBlock = appSource.match(/const handleCreateProfile = useCallback\(async[\s\S]*?\}, \[refreshProfilesOnly\]\);/)?.[0] ?? '';
    expect(createBlock).not.toMatch(/coordinatorRef/);
    expect(createBlock).toContain('refreshProfilesOnly()');
  });

  it('refreshProfilesOnly only ever calls pmProfiles.list(), never backends.capabilities/capability', () => {
    const block = appSource.match(/const refreshProfilesOnly = useCallback\(async \(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(block).toContain('window.desktop.pmProfiles.list()');
    expect(block).not.toMatch(/backends\.capabilit/);
  });

  it('the coordinator itself exposes no scheduling API (constructor takes deps only)', () => {
    expect(coordinatorSource).not.toMatch(/startAutoRefresh/);
    expect(coordinatorSource).not.toMatch(/autoIntervalMs/);
    expect(coordinatorSource).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('P6-W3-R4.2 Part R42-7 staleness UX', () => {
  it('shows "Last checked" and an on-demand hint, never a staleness warning', () => {
    expect(connectionCenterSource).toContain('Last checked:');
    expect(connectionCenterSource).toContain('Status is refreshed on demand.');
    expect(connectionCenterSource).not.toMatch(/stale|out of date|outdated/i);
  });
});
