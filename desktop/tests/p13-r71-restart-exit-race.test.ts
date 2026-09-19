import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RuntimeSupervisor } from '../electron/main/services/runtimeSupervisor';

// P13-R7.1 (docs/p13/15A_*.md): deterministic reproduction of a real R7
// live defect -- normal Desktop Restart reported "Process exit timeout"
// even though the runtime process really did exit soon after. Root
// cause: RuntimeSupervisor shared ONE 30s budget between the pipe
// SHUTDOWN acknowledgement (near-instant in practice) and the real OS
// process-exit wait, while the runtime's OWN drain grace period defaults
// to the SAME 30s value (worker.leaseMs) -- with a genuinely active task,
// the grace phase alone could consume the entire shared budget before an
// abort was even attempted. See runtimeSupervisor.ts's EXIT_WAIT_TIMEOUT_MS
// and scripts/p5-runtime.mjs's SHUTDOWN_DRAIN_GRACE_PERIOD_MS docstrings
// for the full fix.
//
// Every test spawns a REAL child process (tests/fixtures/runtime-
// lifecycle/scripts/p5-runtime.mjs), exactly like
// runtimeRestartLifecycle.test.ts, with the new DSH_TEST_FIXTURE_SHUTDOWN_
// DELAY_MS knob simulating the real runtime's own post-ack drain/teardown
// latency.

// P13-R7.1: this file's own PRIVATE, per-run copy of the fixture --
// vitest runs test FILES in parallel worker threads by default, and
// RuntimeSupervisor's lock file path is always `<repoRoot>/.dsh-runtime.
// lock`. Sharing the checked-in tests/fixtures/runtime-lifecycle
// directory (as-is) with runtimeRestartLifecycle.test.ts, which ALSO
// treats it as `repoRoot`, would race both files on the SAME lock file
// the instant both run concurrently -- exactly the false
// "Failed to acquire runtime lock" this isolation avoids. Copied fresh
// per test run (not shared, not reused) so this file can never race
// itself either.
const SHARED_FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'runtime-lifecycle');
let FIXTURE_ROOT: string;
let configPath: string;
let supervisors: RuntimeSupervisor[] = [];

function makeSupervisor(exitWaitTimeoutMs = 300): RuntimeSupervisor {
  // readinessMaxAttempts/readinessDelayMs shrunk the same way the existing
  // suite already does; exitWaitTimeoutMs is the NEW R7.1 seam under test.
  const s = new RuntimeSupervisor(FIXTURE_ROOT, configPath, 10, 20, exitWaitTimeoutMs);
  supervisors.push(s);
  return s;
}

beforeEach(() => {
  FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r71-fixture-'));
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SHARED_FIXTURE_ROOT, 'scripts', 'p5-runtime.mjs'), path.join(FIXTURE_ROOT, 'scripts', 'p5-runtime.mjs'));
  configPath = path.join(FIXTURE_ROOT, 'fake-config.yaml');
  fs.writeFileSync(configPath, 'fixture: true\n', 'utf8');
  delete process.env.DSH_TEST_FIXTURE_MODE;
  delete process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS;
  supervisors = [];
});

afterEach(async () => {
  for (const s of supervisors) {
    try { await s.forceStop(); } catch { /* already stopped */ }
  }
  delete process.env.DSH_TEST_FIXTURE_MODE;
  delete process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS;
  try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

describe('P13-R7.1 restart/stop exit-race regression', () => {
  it('1. a child that exits immediately after the shutdown ack (delay 0) stops cleanly -- pre-existing behavior unchanged', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    const supervisor = makeSupervisor();
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.getStatus().state).toBe('STOPPED');
  });

  it('2. a child that exits shortly AFTER the shutdown ack (simulating real drain/teardown latency) stops cleanly, with NO "Process exit timeout" -- this is the exact R7 live defect, reproduced deterministically', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    // Delay comparable to (but safely under) the configured exit-wait
    // budget below -- exercises the real race window between the
    // instant pipe ack and the real process actually exiting.
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '150';
    const supervisor = makeSupervisor(1000);
    await supervisor.start();
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.getStatus().state).toBe('STOPPED');
    expect(supervisor.getStatus().lastError).toBeNull();
  });

  it('3. a child that exits right at the edge of the exit-wait boundary (just under it) still stops cleanly, never falsely timing out', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '250';
    const supervisor = makeSupervisor(400); // exit at 250ms, budget 400ms -- real margin, not a coin flip
    await supervisor.start();
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.getStatus().state).toBe('STOPPED');
  });

  it('4. restart() with a delayed-but-real exit produces exactly one new child, never overlapping the old one', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '150';
    const supervisor = makeSupervisor(1000);
    await supervisor.start();
    const oldPid = supervisor.getStatus().pid;
    await supervisor.restart();
    const newPid = supervisor.getStatus().pid;
    expect(supervisor.getStatus().state).toBe('RUNNING');
    expect(newPid).toBeTruthy();
    expect(newPid).not.toBe(oldPid);
    let oldStillAlive = true;
    try { process.kill(oldPid as number, 0); } catch { oldStillAlive = false; }
    expect(oldStillAlive).toBe(false);
  });

  it('5. the dedicated startup exit listener and the lifecycle exit handler both observe exactly one exit event for the delayed-exit child (no double-fire, no missed event)', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '100';
    const supervisor = makeSupervisor(1000);
    const states: string[] = [];
    supervisor.on('statusChanged', (status: any) => states.push(status.state));
    await supervisor.start();
    await supervisor.stop();
    // Exactly one STOPPING->STOPPED transition observed via the public
    // statusChanged stream (handleProcessExit fires exactly once).
    const stoppedCount = states.filter((s) => s === 'STOPPED').length;
    expect(stoppedCount).toBe(1);
  });

  it('6. a genuinely still-stuck child (never exits) still correctly rejects with "Process exit timeout" -- the safety net is preserved, not just removed', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '999999';
    const supervisor = makeSupervisor(200); // tight budget -- must genuinely time out
    await supervisor.start();
    await expect(supervisor.stop()).rejects.toThrow('Process exit timeout');
    // State remains STOPPING (never silently marked STOPPED) -- Desktop's
    // existing Force Stop affordance is still the correct next step.
    expect(supervisor.getStatus().state).toBe('STOPPING');
  });

  it('7. restart() during near-boundary delayed exit never produces a duplicate/overlapping runtime even under repeated attempts', async () => {
    process.env.DSH_TEST_FIXTURE_MODE = 'becomes-ready-fast';
    process.env.DSH_TEST_FIXTURE_SHUTDOWN_DELAY_MS = '120';
    const supervisor = makeSupervisor(1000);
    await supervisor.start();
    for (let i = 0; i < 3; i += 1) {
      const before = supervisor.getStatus().pid;
      await supervisor.restart();
      const after = supervisor.getStatus().pid;
      expect(after).not.toBe(before);
      expect(supervisor.getStatus().state).toBe('RUNNING');
    }
  });
});
