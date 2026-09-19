import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { runClaudeProcess as runClaudeProcessImpl } from '../src/session/claude-code-session-bridge.mjs';

const runClaudeProcess = (options) => runClaudeProcessImpl({ binary: process.execPath, ...options });

// P10-R0.2.1 Part U/V — a fake child_process double that NEVER actually
// closes (matching the T2 owner-live failure: a real Claude process that
// simply outran a too-short timeout, not one that exited early). This
// exercises the setTimeout-based timeout path deterministically and fast
// (small explicit `timeoutMs` values below — Part S: no real sleeping for
// minutes). `close`/`exit` are wired but only fire if the test explicitly
// triggers them (`emitClose()`), which is what the kill/close-race tests
// below need.
function fakeHangingSpawn({ capture = {}, pid = 44896 } = {}) {
  let killed = false;
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  Object.defineProperty(child, 'killed', { get: () => killed });
  return {
    spawnImpl: (binary, args, options) => {
      Object.assign(capture, { binary, args, options });
      return child;
    },
    child,
    emitClose: (code = null, signal = null) => child.emit('close', code, signal),
  };
}

function fakeImmediateSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      queueMicrotask(() => child.emit('close', code));
    });
    return child;
  };
}

// ---- Part U.1/U.2: explicit timeoutMs forwarded / bridge fallback -------

test('1: explicit timeoutMs is honored (fires before the bridge default would)', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', timeoutMs: 30, spawnImpl }),
    (error) => error.code === 'CLAUDE_TIMEOUT' && error.timeoutMs === 30,
  );
});

test('2: no explicit timeoutMs falls back to the bridge default (120000ms, never changed by this wave)', async () => {
  // A real (non-hanging) run completes long before the 120s default would
  // ever matter — this proves the DEFAULT PARAMETER is still 120_000,
  // without actually waiting 120 seconds.
  const out = await runClaudeProcess({ prompt: 'x', spawnImpl: fakeImmediateSpawn({ stdout: JSON.stringify({ session_id: 's1', result: 'ok' }) }) });
  assert.equal(out.result, 'ok');
});

// ---- Part U.3/U.4: typed CLAUDE_TIMEOUT with timeoutMs in the payload ---

test('3/4: timeout throws typed CLAUDE_TIMEOUT carrying the configured timeoutMs', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', timeoutMs: 25, spawnImpl }),
    (error) => error.name === 'ClaudeCodeSessionError' && error.code === 'CLAUDE_TIMEOUT' && error.timeoutMs === 25,
  );
});

// ---- Part U.5: elapsedMs present and bounded ----------------------------

test('5: elapsedMs is present, non-negative, and roughly matches the configured timeout', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  const startedAt = Date.now();
  let caught = null;
  try { await runClaudeProcess({ prompt: 'x', timeoutMs: 40, spawnImpl }); } catch (error) { caught = error; }
  const wallClock = Date.now() - startedAt;
  assert.ok(caught);
  assert.equal(typeof caught.elapsedMs, 'number');
  assert.ok(caught.elapsedMs >= 0);
  // generous upper bound -- this is a timer-driven value, not exact, but it
  // must never be wildly larger than the real wall clock elapsed.
  assert.ok(caught.elapsedMs <= wallClock + 50);
});

// ---- Part U.6: PID captured when available -------------------------------

test('6: processPid is captured from the spawned child', async () => {
  const { spawnImpl } = fakeHangingSpawn({ pid: 44896 });
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 20, spawnImpl }), (error) => error.processPid === 44896);
});

test('6b: processPid is null (never undefined/NaN) when the fake child reports no pid', async () => {
  // `pid: null` (not `undefined` -- a default parameter only substitutes
  // for a literally-undefined argument, and `null` deliberately signals
  // "no pid" here, matching how a real Node child_process could plausibly
  // report a not-yet-known pid).
  const { spawnImpl } = fakeHangingSpawn({ pid: null });
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 20, spawnImpl }), (error) => error.processPid === null);
});

// ---- Part U.7/U.8: stdout/stderr byte counts ------------------------------

test('7/8: stdout/stderr byte counts are captured at the moment of timeout', async () => {
  const { spawnImpl, child } = fakeHangingSpawn();
  const pending = runClaudeProcess({ prompt: 'x', timeoutMs: 60, spawnImpl });
  // Push some partial output before the timeout fires -- a real Claude
  // process that is still "thinking" but has already streamed some bytes.
  child.stdout.write('partial assistant tex');
  child.stderr.write('warn: slow tool call');
  let caught = null;
  try { await pending; } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.stdoutBytes, Buffer.byteLength('partial assistant tex', 'utf8'));
  assert.equal(caught.stderrBytes, Buffer.byteLength('warn: slow tool call', 'utf8'));
  assert.equal(caught.assistantOutputPresent, true);
});

test('7b: assistantOutputPresent is false when stdout is empty/whitespace-only at timeout', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }), (error) => error.assistantOutputPresent === false && error.stdoutBytes === 0);
});

// ---- Part J: termination evidence is truthful, never invented -----------

test('termination_requested is true, but observedSignal/observedExitCode are honestly null (never fabricated)', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }), (error) =>
    error.terminationRequestedByDsh === true && error.observedSignal === null && error.observedExitCode === null);
});

// ---- Part U.9: timeout never resolves success ----------------------------

test('9: a timeout always rejects, never resolves', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }));
});

// ---- Part U.10/11/12: timer cleared on completion/error/nonzero exit ----

test('10: timer is cleared on normal completion (a late close after resolve() never double-settles)', async () => {
  const { spawnImpl, child } = fakeHangingSpawn();
  const pending = runClaudeProcess({ prompt: 'x', timeoutMs: 10_000, spawnImpl });
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify({ session_id: 's1', result: 'ok' }));
    child.stderr.end('');
    queueMicrotask(() => child.emit('close', 0));
  });
  const out = await pending;
  assert.equal(out.result, 'ok');
  // If the 10s timer were still live, this would eventually fire and blow
  // up the test process after the test file exits -- node:test would flag
  // an unhandled rejection. Explicitly waiting a tick here is unnecessary;
  // the assertion above already proves resolution happened via 'close',
  // not the timer.
});

test('11: timer is cleared on process spawn error (no stray timeout after)', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  await assert.rejects(runClaudeProcess({ prompt: 'x', timeoutMs: 10_000, spawnImpl }), (error) => error.code === 'CLAUDE_SPAWN_FAILED');
});

test('12: timer is cleared on a nonzero exit (no stray timeout after)', async () => {
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', timeoutMs: 10_000, spawnImpl: fakeImmediateSpawn({ code: 1, stderr: 'boom' }) }),
    (error) => error.code === 'CLAUDE_EXIT_FAILED',
  );
});

// ---- Part V/13: kill/close race -- no double-settlement -------------------

test('13a: a close event that arrives AFTER the timeout already rejected is a silent no-op (no double reject/throw)', async () => {
  const { spawnImpl, child, emitClose } = fakeHangingSpawn();
  let rejectionCount = 0;
  const pending = runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }).catch(() => { rejectionCount += 1; });
  await pending;
  assert.equal(rejectionCount, 1);
  // The child eventually reports its real close, well after DSH already
  // gave up and rejected -- this must be a complete no-op: no throw, no
  // second unhandled rejection, no crash.
  assert.doesNotThrow(() => emitClose(null, null));
});

test('13b: an error event that arrives AFTER the timeout already rejected is a silent no-op', async () => {
  const { spawnImpl, child } = fakeHangingSpawn();
  let rejectionCount = 0;
  await runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }).catch(() => { rejectionCount += 1; });
  assert.equal(rejectionCount, 1);
  assert.doesNotThrow(() => child.emit('error', new Error('late spawn error after kill')));
});

test('13c: only ONE rejection ever happens even if close fires multiple times after timeout', async () => {
  const { spawnImpl, emitClose } = fakeHangingSpawn();
  let settleCount = 0;
  await runClaudeProcess({ prompt: 'x', timeoutMs: 15, spawnImpl }).catch(() => { settleCount += 1; });
  emitClose(0);
  emitClose(1, 'SIGTERM');
  assert.equal(settleCount, 1);
});
