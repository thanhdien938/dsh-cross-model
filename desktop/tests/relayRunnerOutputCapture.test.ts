import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRunnerOutputCaptures,
  spawnWindowsRunnerWithFileCapture,
} from '../electron/main/services/relayRunnerLifecycleManager';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeOfficialWrapperFixture(): { runnerRoot: string; captureRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-capture-'));
  tempRoots.push(root);
  const runnerRoot = path.join(root, 'runner');
  const captureRoot = path.join(root, 'capture');
  fs.mkdirSync(runnerRoot, { recursive: true });
  fs.writeFileSync(path.join(runnerRoot, 'run.cmd'), [
    '@echo off',
    'copy "%~dp0run-helper.cmd.template" "%~dp0run-helper.cmd" /Y',
    'call "%~dp0run-helper.cmd"',
    'exit /b %ERRORLEVEL%',
  ].join('\r\n'));
  fs.writeFileSync(path.join(runnerRoot, 'run-helper.cmd.template'), [
    '@echo off',
    'echo FIXTURE_ROOT_CMD_OUTPUT',
    'node.exe "%~dp0listener-fixture.cjs"',
    'exit /b %ERRORLEVEL%',
  ].join('\r\n'));
  fs.writeFileSync(path.join(runnerRoot, 'listener-fixture.cjs'), [
    "console.log('Connected to GitHub');",
    "console.log('Listening for Jobs');",
    "console.error('FIXTURE_LISTENER_STDERR');",
    "const forbidden = ['TELEGRAM_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'DSH_PRIVATE_SECRET', 'DSH_RUNNER_STDOUT_FILE', 'DSH_RUNNER_STDERR_FILE'];",
    "console.log(`FORBIDDEN_ENV_PRESENT=${forbidden.some((key) => process.env[key] !== undefined)}`);",
  ].join('\n'));
  fs.writeFileSync(path.join(runnerRoot, 'config.cmd'), '@echo off\r\necho invoked>config-invoked.marker\r\n');
  fs.writeFileSync(path.join(runnerRoot, '.credentials'), 'DO_NOT_READ');
  fs.writeFileSync(path.join(runnerRoot, '.credentials_rsaparams'), 'DO_NOT_READ');
  return { runnerRoot, captureRoot };
}

describe('app-owned runner file-backed output capture', () => {
  windowsIt('official run.cmd -> helper -> listener output all reaches the observer without secret inheritance', async () => {
    const { runnerRoot, captureRoot } = makeOfficialWrapperFixture();
    const forbiddenReads: string[] = [];
    const originalRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
      const value = String(candidate);
      if (/\.credentials(?:_rsaparams)?$/i.test(value)) forbiddenReads.push(value);
      return originalRead(candidate, ...args as [any]);
    }) as typeof fs.readFileSync);
    const previous = {
      TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      DSH_PRIVATE_SECRET: process.env.DSH_PRIVATE_SECRET,
    };
    Object.assign(process.env, {
      TELEGRAM_TOKEN: 'fake', ANTHROPIC_API_KEY: 'fake', OPENAI_API_KEY: 'fake',
      GITHUB_TOKEN: 'fake', GH_TOKEN: 'fake', DSH_PRIVATE_SECRET: 'fake',
    });
    try {
      const handle = spawnWindowsRunnerWithFileCapture(runnerRoot, captureRoot);
      let stdout = '';
      let stderr = '';
      const captureErrors: Error[] = [];
      handle.onStdout((chunk) => { stdout += chunk; });
      handle.onStderr((chunk) => { stderr += chunk; });
      handle.onCaptureError((error) => captureErrors.push(error));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture runner did not exit')), 10_000);
        handle.onError(reject);
        handle.onExit(() => { clearTimeout(timer); resolve(); });
      });
      expect(stdout).toContain('FIXTURE_ROOT_CMD_OUTPUT');
      expect(stdout).toContain('Connected to GitHub');
      expect(stdout).toContain('Listening for Jobs');
      expect(stdout).toContain('FORBIDDEN_ENV_PRESENT=false');
      expect(stderr).toContain('FIXTURE_LISTENER_STDERR');
      expect(captureErrors).toEqual([]);
      expect(forbiddenReads).toEqual([]);
      expect(fs.existsSync(path.join(runnerRoot, 'config-invoked.marker'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 15_000);

  it('retention removes only dead generations beyond the bounded newest set and retains live roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-retention-'));
    tempRoots.push(root);
    for (let index = 0; index < 11; index += 1) {
      const id = `fixture-${index}`;
      fs.writeFileSync(path.join(root, `runner-${id}.stdout.log`), 'output');
      fs.writeFileSync(path.join(root, `runner-${id}.stderr.log`), 'error');
      fs.writeFileSync(path.join(root, `runner-${id}.json`), JSON.stringify({ schemaVersion: 1, rootPid: index === 0 ? 777 : 1000 + index, createdAt: new Date(index * 1000).toISOString() }));
    }
    cleanupRunnerOutputCaptures(root, (pid) => pid === 777);
    expect(fs.existsSync(path.join(root, 'runner-fixture-0.json'))).toBe(true);
    const remainingMetadata = fs.readdirSync(root).filter((name) => name.endsWith('.json'));
    expect(remainingMetadata).toHaveLength(9);
  });
});
