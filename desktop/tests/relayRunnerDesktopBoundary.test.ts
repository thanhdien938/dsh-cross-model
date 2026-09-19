import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const desktopRoot = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(desktopRoot, 'electron/main/services/relayRunnerLifecycleManager.ts'), 'utf8');
const main = fs.readFileSync(path.join(desktopRoot, 'electron/main/main.ts'), 'utf8');
const preload = fs.readFileSync(path.join(desktopRoot, 'electron/preload/preload.ts'), 'utf8');
const card = fs.readFileSync(path.join(desktopRoot, 'src/components/ConnectionCenter.tsx'), 'utf8');

describe('GitHub relay runner Desktop boundary', () => {
  it('20. renderer has no arbitrary command execution surface', () => {
    expect(preload).not.toMatch(/relayRunner:[^']*(?:exec|command|spawn|shell)/i);
    expect(card).not.toMatch(/child_process|spawn\(|exec\(/);
    expect(preload).toContain("ipcRenderer.invoke('relayRunner:start')");
  });

  it('21/22. lifecycle source never reads credentials or invokes config.cmd', () => {
    expect(service).not.toContain('config.cmd');
    expect(service).not.toContain('.credentials');
    expect(service).not.toMatch(/readFileSync\([^)]*\.runner/);
    expect(service).toContain("['/d','/s','/c','call run.cmd']");
  });

  it('UI exposes required bounded fields and ownership/busy control guards', () => {
    for (const label of ['GitHub Relay Runner', 'Registration:', 'Status:', 'Ownership:', 'Version:', 'PID:', 'Runner path:', 'Auto Start:', 'Last checked:', 'Refresh', 'Start', 'Stop', 'Restart', 'Open Logs']) {
      expect(card).toContain(label);
    }
    expect(card).toContain("status.ownership === 'APP_OWNED'");
    expect(card).toContain("status.state !== 'ONLINE_BUSY'");
  });

  it('IPC/preload exposes only named typed runner operations', () => {
    for (const channel of ['getStatus', 'refresh', 'start', 'stop', 'restart', 'getLogs', 'updateSettings']) {
      expect(main).toContain(`relayRunner:${channel}`);
      expect(preload).toContain(`relayRunner:${channel}`);
    }
  });

  it('25. runner initialization is independent and failures are caught before existing runtime completion', () => {
    expect(main).toContain('const runnerInitialization = initializeRelayRunnerService()');
    expect(main).toContain('await initializeServices()');
    expect(main).toContain("console.error('GitHub relay runner initialization failed safely:'");
  });

  it('P0-1: runner supervisor and discovery use the deny-by-default env allowlist, and capture controls never reach Runner.Listener', () => {
    expect(service).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
    expect(service).toMatch(/spawnWindowsRunnerWithFileCapture[\s\S]*?\.\.\.buildRunnerChildEnv\(\)/);
    expect(service).toMatch(/env:\s*\{\s*\.\.\.buildRunnerChildEnv\(\)\s*,\s*DSH_RUNNER_DISCOVERY_EXE/);
    for (const key of ['DSH_RUNNER_STDOUT_FILE', 'DSH_RUNNER_STDERR_FILE', 'ELECTRON_RUN_AS_NODE']) {
      expect(service).toContain(`delete process.env.${key}`);
    }
  });

  it('P0-3: the renderer has no free-text runner path input, and updateSettings carries no runnerPath field', () => {
    expect(preload).not.toMatch(/updateSettings:.*runnerPath/);
    expect(card).not.toMatch(/value=\{runnerPath\}/);
    expect(card).not.toContain('Relay runner path');
    expect(card).toContain('window.desktop.relayRunner.pickFolder()');
    expect(main).toContain("dialog.showOpenDialog(mainWindow, {");
    expect(main).toContain('relayRunnerLifecycleManager.configureRunnerPath(picked.filePaths[0])');
  });

  it('P0-4: config.cmd is never invoked, and .runner content-reading is isolated to relayRunnerRegistrationReader.ts', () => {
    expect(service).not.toContain('config.cmd');
    expect(service).toContain('readRegistration');
  });
});
