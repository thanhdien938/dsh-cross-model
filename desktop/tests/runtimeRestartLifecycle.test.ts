import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RuntimeSupervisor, RuntimeStartupError } from '../electron/main/services/runtimeSupervisor';

// P7-R0.4 Part R: real-child-process tests for RuntimeSupervisor's startup/
// readiness/restart lifecycle (finding P7-M05 — a real owner Restart click
// produced "Failed to restart runtime: Runtime readiness timeout" even
// though a direct CLI readiness check moments later showed the runtime was
// genuinely healthy).
//
// Rather than mocking RuntimeSupervisor's internals, every test here spawns
// a REAL child process — tests/fixtures/runtime-lifecycle/scripts/
// p5-runtime.mjs, a small controllable stand-in for the real
// scripts/p5-runtime.mjs that RuntimeSupervisor always spawns via
// `node <repoRoot>/scripts/p5-runtime.mjs all --config ... --control-pipe
// ...` — so these tests exercise real spawn(), real exit codes, real named
// pipes, and real timing, without depending on Postgres/SQLite/CLI PM
// backends. Behavior is selected per test via DSH_TEST_FIXTURE_MODE, which
// RuntimeSupervisor's real (unmodified) spawn() env forwarding
// (`{...process.env, DSH_RUNTIME_CONTROL_AUTH: ...}`) carries through
// automatically.
//
// readinessMaxAttempts/readinessDelayMs are shrunk via the P7-R0.4
// testability-only constructor seam so the genuine-timeout tests run in
// milliseconds instead of the real 30s production timeout — production
// code never passes these and keeps the real 30/1000 defaults.

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'runtime-lifecycle');
let configPath: string;
let supervisors: RuntimeSupervisor[] = [];

function makeSupervisor(maxAttempts = 5, delayMs = 20): RuntimeSupervisor {
  const s = new RuntimeSupervisor(FIXTURE_ROOT, configPath, maxAttempts, delayMs);
  supervisors.push(s);
  return s;
}

beforeEach(() => {
  configPath = path.join(FIXTURE_ROOT, 'fake-config.yaml');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, 'fixture: true\n', 'utf8');
  const lockFile = path.join(FIXTURE_ROOT, '.dsh-runtime.lock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  delete process.env.DSH_TEST_FIXTURE_MODE;
  supervisors = [];
});

afterEach(async () => {
  // Best-effort: force-stop anything still alive so no fixture child leaks
  // across tests.
  for (const s of supervisors) {
    try {
      await s.forceStop();
    } catch {
      /* already stopped */
    }
  }
  delete process.env.DSH_TEST_FIXTURE_MODE;
  const lockFile = path.join(FIXTURE_ROOT, '.dsh-runtime.lock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
});

describe('RuntimeSupervisor startup/readiness/restart lifecycle', () => {
  it('1. a child that exits immediately fails fast with RUNTIME_EXITED_BEFORE_READY, never waiting out the full timeout', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'exit-immediately-pm-unavailable';
    const supervisor = makeSupervisor(30, 1000); // even with production-scale timeout, this must not wait it out
    const startedAt = Date.now();
    await expect(supervisor.start()).rejects.toThrow(RuntimeStartupError);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('2. p5.runtime.failed code PM_BACKEND_UNAVAILABLE is captured and propagated on the typed error', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'exit-immediately-pm-unavailable';
    const supervisor = makeSupervisor();
    try {
      await supervisor.start();
      expect.unreachable('start() should have rejected');
    } catch (error: any) {
      expect(error).toBeInstanceOf(RuntimeStartupError);
      expect(error.code).toBe('RUNTIME_EXITED_BEFORE_READY');
      expect(error.runtimeErrorCode).toBe('PM_BACKEND_UNAVAILABLE');
      expect(error.message).toContain('PM_BACKEND_UNAVAILABLE');
    }
  });

  it('3. p5.runtime.failed code DATABASE_OPEN_FAILED is captured and propagated on the typed error', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'exit-immediately-database-open-failed';
    const supervisor = makeSupervisor();
    try {
      await supervisor.start();
      expect.unreachable('start() should have rejected');
    } catch (error: any) {
      expect(error).toBeInstanceOf(RuntimeStartupError);
      expect(error.code).toBe('RUNTIME_EXITED_BEFORE_READY');
      expect(error.runtimeErrorCode).toBe('DATABASE_OPEN_FAILED');
    }
  });

  it('4. a child that stays alive but never opens the control pipe times out as RUNTIME_READINESS_TIMEOUT with pipeReachable:false', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'alive-no-pipe';
    const supervisor = makeSupervisor(5, 20);
    try {
      await supervisor.start();
      expect.unreachable('start() should have rejected');
    } catch (error: any) {
      expect(error).toBeInstanceOf(RuntimeStartupError);
      expect(error.code).toBe('RUNTIME_READINESS_TIMEOUT');
      expect(error.pipeReachable).toBe(false);
      expect(error.message).toContain('did not become reachable');
    }
  });

  it('5. a child whose pipe IS reachable but keeps reporting ready:false times out as RUNTIME_READINESS_TIMEOUT with pipeReachable:true and a specific reason (not the generic "pipe unreachable" message)', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'alive-pipe-never-ready';
    const supervisor = makeSupervisor(5, 20);
    try {
      await supervisor.start();
      expect.unreachable('start() should have rejected');
    } catch (error: any) {
      expect(error).toBeInstanceOf(RuntimeStartupError);
      expect(error.code).toBe('RUNTIME_READINESS_TIMEOUT');
      expect(error.pipeReachable).toBe(true);
      expect(error.readinessReason).toContain('test-fixture-pm');
      expect(error.readinessReason).toContain('PM_BACKEND_UNAVAILABLE');
      expect(error.message).not.toContain('did not become reachable');
      expect(error.message).toContain('never reported ready');
    }
  });

  it('6. a child that becomes ready on the first poll reaches RUNNING, and status only flips to RUNNING after readiness — never before', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    const states: string[] = [];
    supervisor.on('statusChanged', (status: any) => states.push(status.state));
    await supervisor.start();
    expect(supervisor.getStatus().state).toBe('RUNNING');
    // STARTING must have been observed before RUNNING; RUNNING must never
    // have been emitted before readiness (there is exactly one RUNNING
    // transition, immediately following the last STARTING-era state).
    const runningIndex = states.indexOf('RUNNING');
    expect(runningIndex).toBeGreaterThan(-1);
    expect(states.slice(0, runningIndex).every((s) => s === 'STARTING')).toBe(true);
  });

  it('7. restart() only spawns the new child after the old one has genuinely exited (no overlap)', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    await supervisor.start();
    const oldPid = supervisor.getStatus().pid;
    expect(oldPid).toBeTruthy();

    await supervisor.restart();
    const newPid = supervisor.getStatus().pid;
    expect(supervisor.getStatus().state).toBe('RUNNING');
    expect(newPid).toBeTruthy();
    expect(newPid).not.toBe(oldPid);

    // The old PID must no longer be alive (Windows: signal 0 probe throws
    // ESRCH-equivalent for a dead process; on a still-alive PID it would
    // not throw).
    let oldStillAlive = true;
    try {
      process.kill(oldPid as number, 0);
    } catch {
      oldStillAlive = false;
    }
    expect(oldStillAlive).toBe(false);
  });

  it('8. a rejected duplicate start() (already RUNNING/STARTING) never fires a second sessionStarting and never fakes RUNNING out of thin air', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    let sessionStartingCount = 0;
    supervisor.on('sessionStarting', () => { sessionStartingCount += 1; });
    await supervisor.start();
    expect(sessionStartingCount).toBe(1);
    expect(supervisor.getStatus().state).toBe('RUNNING');

    // A second start() while already RUNNING must reject (the existing
    // already-running/starting guard at the top of startImpl()) — not
    // silently no-op into a fake success, and not fire a second
    // sessionStarting (which would wrongly clear session-scoped logs for a
    // spawn that never actually happened).
    await expect(supervisor.start()).rejects.toThrow();
    expect(sessionStartingCount).toBe(1);
    expect(supervisor.getStatus().state).toBe('RUNNING');
  });

  it('9. two concurrent restart() calls never race — the lifecycle queue serializes them, and the final state is coherent RUNNING with one live child', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    await supervisor.start();

    const [a, b] = await Promise.allSettled([supervisor.restart(), supervisor.restart()]);
    // At least one must succeed; whichever rejects must do so with a real
    // Error (already-running/starting guard), never a hung promise or a
    // corrupted double-spawn.
    const outcomes = [a, b];
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    expect(supervisor.getStatus().state).toBe('RUNNING');
    expect(supervisor.getStatus().pid).toBeTruthy();
  });

  it('10. structured ##DSH_RUNTIME_LIFECYCLE## log lines are emitted for spawn and ready, reusing the existing log event stream (no second logging subsystem)', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    const logs: string[] = [];
    supervisor.on('log', (line: string) => logs.push(line));
    await supervisor.start();
    const lifecycleLogs = logs.filter((l) => l.includes('##DSH_RUNTIME_LIFECYCLE##'));
    expect(lifecycleLogs.some((l) => l.includes('"stage":"runtime_spawn"'))).toBe(true);
    expect(lifecycleLogs.some((l) => l.includes('"stage":"runtime_ready"'))).toBe(true);
  });
});
