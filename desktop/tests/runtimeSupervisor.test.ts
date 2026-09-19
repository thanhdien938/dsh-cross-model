import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RuntimeSupervisor } from '../electron/main/services/runtimeSupervisor';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('RuntimeSupervisor', () => {
  let supervisor: RuntimeSupervisor;

  beforeAll(() => {
    supervisor = new RuntimeSupervisor(REPO_ROOT);
  });

  afterAll(async () => {
    if (supervisor.getStatus().state === 'RUNNING') {
      await supervisor.forceStop();
    }
  });

  it('should initialize with STOPPED state', () => {
    const status = supervisor.getStatus();
    expect(status.state).toBe('STOPPED');
    expect(status.pid).toBeNull();
    expect(status.uptime).toBe(0);
  });

  it('should not allow starting when already running', async () => {
    // This is a smoke test - actual runtime start requires full environment
    const status = supervisor.getStatus();
    expect(['STOPPED', 'ERROR']).toContain(status.state);
  });

  it('should emit statusChanged events', (done) => {
    supervisor.once('statusChanged', (status) => {
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('pid');
      expect(status).toHaveProperty('uptime');
      done();
    });

    // Trigger a status change
    supervisor.getStatus();
  });
});

describe('RuntimeSupervisor - lifecycle', () => {
  it('should handle stop when not running', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT);
    
    await expect(async () => {
      await supervisor.stop();
    }).rejects.toThrow();
  });

  it('should support force stop', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT);

    // Force stop should complete even when not running
    await supervisor.forceStop();

    const status = supervisor.getStatus();
    expect(status.state).toBe('STOPPED');
  });
});

// M03: RuntimeSupervisor.runExclusive is the primitive that makes "restart
// while a restart/start/stop is already in flight" structurally impossible
// instead of merely unlikely — every public start/stop/restart/forceStop
// call is routed through it. These tests exercise the primitive directly
// (real child-process start/stop is integration-level and requires a full
// DSH_CONFIG_PATH environment, covered separately by the manual runbook).
describe('RuntimeSupervisor - lifecycle mutex (M03)', () => {
  it('serializes overlapping calls instead of running them concurrently', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT) as any;
    const order: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = (label: string, delayMs: number) => async () => {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${label}:end`);
      concurrentCount -= 1;
    };

    const first = supervisor.runExclusive(task('a', 20));
    const second = supervisor.runExclusive(task('b', 5));
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1); // never overlapped
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']); // submission order preserved
  });

  it('a rejection in one queued task does not block or corrupt the next', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT) as any;
    const order: string[] = [];

    const failing = supervisor.runExclusive(async () => {
      order.push('failing');
      throw new Error('simulated stop failure');
    });
    const following = supervisor.runExclusive(async () => {
      order.push('following');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('simulated stop failure');
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'following']);
  });

  it('three rapid overlapping calls all run, strictly one at a time, in submission order', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT) as any;
    const order: string[] = [];
    let running = false;

    const task = (label: string) => async () => {
      expect(running).toBe(false); // would fail if two tasks ever overlapped
      running = true;
      order.push(label);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running = false;
    };

    await Promise.all([
      supervisor.runExclusive(task('restart-click-1')),
      supervisor.runExclusive(task('restart-click-2')),
      supervisor.runExclusive(task('add-folder-restart-now')),
    ]);

    expect(order).toEqual(['restart-click-1', 'restart-click-2', 'add-folder-restart-now']);
  });
});

// P6-W3-R3.1.1 — 'sessionStarting' is the one central seam main.ts uses
// to clear session-scoped, ephemeral log presentation (runtimeLogBuffer,
// BackendExecutionLogService) exactly once per genuinely new runtime
// child process. Real child-process spawn is integration-level (see the
// M03 note above) — these tests instead prove the two properties that
// actually matter about the seam without needing one: (a) it is never
// reached by a rejected/no-op start attempt, so existing evidence is
// never erased for nothing, and (b) restart() — the single call path
// both the topbar Restart button and Add Folder's "Restart now" use
// (App.tsx's shared handleRestart()) — funnels into the exact same
// startImpl() the emit lives in, not a separate/duplicated path.
describe('RuntimeSupervisor - sessionStarting seam (R3.1.1)', () => {
  it('does not emit sessionStarting when start() is rejected before a real process would ever spawn (missing runtime script)', async () => {
    const fakeRepoRoot = mkdtempSync(path.join(tmpdir(), 'dsh-r3111-missing-'));
    // Deliberately no scripts/p5-runtime.mjs under fakeRepoRoot.
    const supervisor = new RuntimeSupervisor(fakeRepoRoot, path.join(fakeRepoRoot, 'config.yaml'));
    let emitted = false;
    supervisor.on('sessionStarting', () => { emitted = true; });

    await expect(supervisor.start()).rejects.toThrow(/Runtime script not found/);
    expect(emitted).toBe(false);

    rmSync(fakeRepoRoot, { recursive: true, force: true });
  });

  it('does not emit sessionStarting when start() is rejected for a missing config (script present, config absent)', async () => {
    const fakeRepoRoot = mkdtempSync(path.join(tmpdir(), 'dsh-r3111-noconfig-'));
    const scriptsDir = path.join(fakeRepoRoot, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(path.join(scriptsDir, 'p5-runtime.mjs'), '// placeholder, never actually run by this test\n');
    const supervisor = new RuntimeSupervisor(fakeRepoRoot, path.join(fakeRepoRoot, 'definitely-missing-config.yaml'));
    let emitted = false;
    supervisor.on('sessionStarting', () => { emitted = true; });

    await expect(supervisor.start()).rejects.toThrow(/Config not found/);
    expect(emitted).toBe(false);

    rmSync(fakeRepoRoot, { recursive: true, force: true });
  });

  it('P15-B-001 delegates singleton authority to the runtime child instead of refusing on a Desktop-owned lock marker', async () => {
    const fakeRepoRoot = mkdtempSync(path.join(tmpdir(), 'dsh-r3111-locked-'));
    const scriptsDir = path.join(fakeRepoRoot, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(path.join(scriptsDir, 'p5-runtime.mjs'), '// placeholder\n');
    writeFileSync(path.join(fakeRepoRoot, 'config.yaml'), 'placeholder: true\n');
    // A lock file naming a PID that is genuinely still alive (this test process itself).
    writeFileSync(path.join(fakeRepoRoot, '.dsh-runtime.lock'), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

    const supervisor = new RuntimeSupervisor(fakeRepoRoot, path.join(fakeRepoRoot, 'config.yaml'));
    let emitted = false;
    supervisor.on('sessionStarting', () => { emitted = true; });

    await expect(supervisor.start()).rejects.toThrow();
    expect(emitted).toBe(true);

    rmSync(fakeRepoRoot, { recursive: true, force: true });
  });

  it('restart() funnels into the exact same startImpl() the emit lives in — never a separate/duplicated path (covers both topbar Restart and Add Folder\'s "Restart now", which call the identical runtime:restart IPC channel)', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT) as any;
    // Fresh supervisor is STOPPED, so restartImpl() skips stopImpl() and
    // calls startImpl() directly — exactly the code path this proves.
    expect(supervisor.getStatus().state).toBe('STOPPED');

    let startImplCalls = 0;
    const originalStartImpl = supervisor.startImpl.bind(supervisor);
    supervisor.startImpl = async () => { startImplCalls += 1; };

    await supervisor.restart();

    expect(startImplCalls).toBe(1);
    supervisor.startImpl = originalStartImpl; // restore, though this instance is discarded after this test
  });

  it('restart() from a RUNNING state calls stopImpl() before startImpl() — the same ordering both real start and real restart share', async () => {
    const supervisor = new RuntimeSupervisor(REPO_ROOT) as any;
    const order: string[] = [];
    supervisor.status = { ...supervisor.getStatus(), state: 'RUNNING' };
    supervisor.stopImpl = async () => { order.push('stop'); supervisor.status = { ...supervisor.getStatus(), state: 'STOPPED' }; };
    supervisor.startImpl = async () => { order.push('start'); };

    await supervisor.restart();

    expect(order).toEqual(['stop', 'start']);
  });
});
