import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { runBoundedProbe } from '../src/pm/pm-connection-probe.mjs';

// P6.5 Part A/L: reproduces the exact failure class the manual owner
// finding described (a short, ~2-3s UI stall that clears the instant the
// operation finishes — the signature of a *synchronous* blocking call,
// not sustained CPU load) and proves the fix. Uses deterministic fake
// processes/delays, never a real CLI, so this is fast and non-flaky in
// CI. "Heartbeat gap" is the same mental model as a renderer frame stall:
// a 10ms setInterval ticking on the same event loop as the operation
// under test — if a gap between ticks exceeds the operation's own
// duration, something on that loop blocked synchronously.

function heartbeat(intervalMs = 10) {
  const gaps = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, intervalMs);
  return { gaps, stop: () => clearInterval(timer) };
}

// Simulates the *old* spawnSync-based probe: a real synchronous, CPU-
// spinning wait — this is what a blocking child_process call looks like
// to the event loop (it cannot service any timer/IPC/microtask until the
// call returns), independent of whether the real wait is disk I/O,
// network, or CPU underneath.
function busySleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* deliberately blocking */ }
}

test('reproduction: a synchronous blocking call stalls the heartbeat for its own duration (the bug class this pass fixes)', async () => {
  const hb = heartbeat(10);
  await new Promise((resolve) => setTimeout(resolve, 30)); // let the heartbeat get going
  busySleep(200); // stands in for a real spawnSync `--version`/auth probe
  await new Promise((resolve) => setTimeout(resolve, 30));
  hb.stop();
  const maxGap = Math.max(...hb.gaps);
  assert.ok(maxGap > 150, `expected the synchronous call to stall the heartbeat by roughly its own duration, got max gap=${maxGap}ms`);
});

// Fake async child process: resolves via a real (non-blocking) setTimeout,
// exactly like node:child_process.spawn() talking to a real OS process —
// the event loop is free to do other work (including ticking the
// heartbeat) for the entire duration.
function fakeSlowSpawn(delayMs, { stdout = 'ok\n', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    setTimeout(() => {
      child.stdout.end(stdout);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code));
    }, delayMs);
    return child;
  };
}

test('fix: runBoundedProbe (async spawn) never stalls the heartbeat, even for a 300ms probe', async () => {
  const hb = heartbeat(10);
  const eld = monitorEventLoopDelay({ resolution: 5 });
  eld.enable();

  const result = await runBoundedProbe({ executable: 'fake', args: ['--slow'], timeoutMs: 5000, spawnImpl: fakeSlowSpawn(300) });

  eld.disable();
  hb.stop();

  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'ok');
  assert.ok(hb.gaps.length > 15, `expected the heartbeat to keep ticking throughout the 300ms probe, got only ${hb.gaps.length} ticks`);
  const maxGap = Math.max(...hb.gaps);
  // Part L's target: main event-loop max stall < 100ms for a normal
  // external-process probe (generous bound — this is a fake, in-process
  // timer-driven "child", not real process-spawn/OS-scheduling jitter,
  // which a real CLI probe would add a small amount of on top).
  assert.ok(maxGap < 100, `expected no meaningful heartbeat stall, got max gap=${maxGap}ms`);
  // Informational only (not asserted strictly, to avoid CI flakiness on
  // shared/slow runners) — real perf_hooks evidence for the docs' before/
  // after table.
  console.log(`[P6.5] monitorEventLoopDelay during a 300ms async probe: max=${Math.round(eld.max / 1e6)}ms mean=${Math.round(eld.mean / 1e6)}ms`);
});

test('fix: multiple concurrent async probes still never stall the heartbeat (Refresh All shape)', async () => {
  const hb = heartbeat(10);
  const probes = ['claude-code', 'opencode', 'codex', 'grok'].map((product, i) =>
    runBoundedProbe({ executable: product, args: ['probe'], timeoutMs: 5000, spawnImpl: fakeSlowSpawn(150 + i * 30) }),
  );
  const results = await Promise.all(probes);
  hb.stop();
  assert.ok(results.every((r) => r.ok));
  const maxGap = Math.max(...hb.gaps);
  assert.ok(maxGap < 100, `expected no heartbeat stall across 4 concurrent probes, got max gap=${maxGap}ms`);
});

test('fix: a timed-out probe still never stalls the heartbeat while waiting to be killed', async () => {
  const hb = heartbeat(10);
  const neverClosingSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    return child; // never emits close/error
  };
  const result = await runBoundedProbe({ executable: 'x', args: ['--hang'], timeoutMs: 150, spawnImpl: neverClosingSpawn });
  hb.stop();
  assert.equal(result.timedOut, true);
  const maxGap = Math.max(...hb.gaps);
  assert.ok(maxGap < 100, `expected no heartbeat stall while waiting out the timeout, got max gap=${maxGap}ms`);
});
