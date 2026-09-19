// P12-R5B — terminalization remediation. Root cause: a real owner-live
// Council participant_report against Codex left `createCliPmDriver`'s
// `run(...)` await pending indefinitely — BACKEND_LIVENESS_STATE observed
// the child process EXITED, but nothing downstream ever settled the
// decide() promise, so the PM turn stayed ACTION_STARTED forever, the
// runtime could not gracefully shut down (its own AbortSignal was never
// read at this boundary), and a forced restart left the durable state
// requiring ACTION_RECONCILE_REQUIRED. See
// docs/p12/06B_P12_R5B_TERMINALIZATION_AND_RECONCILIATION_REMEDIATION_SONNET5.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import {
  createCliPmDriver, watchdogTimeoutMs, raceWithWatchdog, HANG_SAFETY_CEILING_MS,
} from '../src/pm/production-pm-backend-registry.mjs';
import { EXECUTION_STAGE, resolveExecutionOptions } from '../src/pm/pm-execution-timeout-policy.mjs';

function neverSettles() { return new Promise(() => {}); }

// ---- watchdogTimeoutMs (pure) -----------------------------------------

test('watchdogTimeoutMs: the safety ceiling wins when the stage policy is shorter (every existing council/SINGLE stage today)', () => {
  const opts = resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT); // 120_000
  assert.equal(watchdogTimeoutMs(opts), HANG_SAFETY_CEILING_MS);
});

test('watchdogTimeoutMs: the stage policy wins when it exceeds the safety ceiling (OWNER_SINGLE_LONG, 30 minutes)', () => {
  const opts = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE_LONG); // 1_800_000
  assert.equal(watchdogTimeoutMs(opts), 1_800_000);
});

test('watchdogTimeoutMs: absent/malformed executionOptions still falls back to the safety ceiling, never 0/Infinity', () => {
  assert.equal(watchdogTimeoutMs(undefined), HANG_SAFETY_CEILING_MS);
  assert.equal(watchdogTimeoutMs({}), HANG_SAFETY_CEILING_MS);
  assert.equal(watchdogTimeoutMs({ timeoutMs: 'not-a-number' }), HANG_SAFETY_CEILING_MS);
});

// ---- raceWithWatchdog (the generic guard, in isolation) ----------------

test('raceWithWatchdog: a promise that settles well within the bound resolves normally, untouched', async () => {
  const result = await raceWithWatchdog(Promise.resolve('ok'), { timeoutMs: 50 });
  assert.equal(result, 'ok');
});

test('raceWithWatchdog: a promise that never settles is rejected by the timer, not left pending forever', async () => {
  await assert.rejects(
    raceWithWatchdog(neverSettles(), { timeoutMs: 20 }),
    (error) => error.code === 'PM_ORCHESTRATION_WATCHDOG_TIMEOUT' && error.timeoutMs === 20,
  );
});

test('raceWithWatchdog: an already-aborted signal settles immediately, never waiting for the timer', async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await assert.rejects(
    raceWithWatchdog(neverSettles(), { timeoutMs: 10_000, signal: controller.signal }),
    (error) => error.code === 'PM_BACKEND_ABORTED',
  );
  assert.ok(Date.now() - start < 1000, 'must not wait anywhere near the 10s timeout when already aborted');
});

test('raceWithWatchdog: a signal that aborts mid-flight settles immediately too — this is the "shutdown must not wait forever" fix', async () => {
  const controller = new AbortController();
  const promise = raceWithWatchdog(neverSettles(), { timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(promise, (error) => error.code === 'PM_BACKEND_ABORTED');
});

test('raceWithWatchdog: exactly-once settlement — a duplicate late resolution/rejection of the underlying promise after the watchdog already fired is silently ignored, never a second settle/crash', async () => {
  let resolveLate;
  const late = new Promise((resolve) => { resolveLate = resolve; });
  const raced = raceWithWatchdog(late, { timeoutMs: 20 });
  await assert.rejects(raced, (error) => error.code === 'PM_ORCHESTRATION_WATCHDOG_TIMEOUT');
  // The underlying promise settles AFTER the watchdog already fired —
  // must not throw, must not produce an unhandled rejection, must not
  // change the already-delivered outcome.
  resolveLate('late-value');
  await new Promise((resolve) => setImmediate(resolve));
});

test('raceWithWatchdog: cleans up its timer on early settlement (no leaked handle keeping the process alive)', async () => {
  await raceWithWatchdog(Promise.resolve('fast'), { timeoutMs: 100_000 });
  // If the timer were not cleared, this test file would hang the runner
  // for 100s — completing promptly is itself the proof.
});

// ---- End-to-end through createCliPmDriver.decide() ---------------------

test('1. backend resolves with a valid finish decision -> decide() succeeds normally (baseline, unaffected by the watchdog)', async () => {
  const driver = createCliPmDriver({
    profile: { id: 'live1-codex-pm', product: 'codex' },
    project: { id: 'p', repo_path: '/tmp/p' },
    run: async () => JSON.stringify({ type: 'finish', output: 'done' }),
    executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT),
  });
  const decision = await driver.decide({ turn: 0, request: { id: 'r1', objective: 'x' }, history: [] });
  assert.equal(decision.type, 'finish');
});

test('2. backend run() never settles (the exact live TEST 4 symptom) -> decide() rejects with a typed watchdog error instead of hanging forever', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const driver = createCliPmDriver({
      profile: { id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex' },
      project: { id: 'dsh-p6-test-b', repo_path: '/tmp/p' },
      run: neverSettles,
      executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT),
    });
    const decidePromise = assert.rejects(
      driver.decide({ turn: 0, request: { id: 'r2', objective: 'x' }, history: [] }),
      (error) => error.code === 'PM_ORCHESTRATION_WATCHDOG_TIMEOUT',
    );
    mock.timers.tick(HANG_SAFETY_CEILING_MS);
    await decidePromise;
  } finally {
    mock.timers.reset();
  }
});

test('3. a real owner shutdown/cancel (AbortSignal) during an in-flight backend call settles decide() immediately — this is the "runtime STOPPING stalled" fix', async () => {
  const controller = new AbortController();
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: { id: 'dsh-p6-test-b', repo_path: '/tmp/p' },
    run: neverSettles,
    executionOptions: resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE),
  });
  const decidePromise = driver.decide({ turn: 0, request: { id: 'r3', objective: 'x' }, history: [], signal: controller.signal });
  const start = Date.now();
  controller.abort();
  await assert.rejects(decidePromise, (error) => error.code === 'PM_BACKEND_ABORTED');
  assert.ok(Date.now() - start < 1000, 'must settle promptly on abort, never wait out the watchdog');
});

test('4. nonzero-exit-shaped bridge failure still rejects with the bridge\'s own typed error, unaffected by the watchdog', async () => {
  const driver = createCliPmDriver({
    profile: { id: 'live1-codex-pm', product: 'codex' },
    project: { id: 'p', repo_path: '/tmp/p' },
    run: async () => { throw Object.assign(new Error('Codex process failed (1)'), { code: 'CODEX_RUN_FAILED' }); },
    executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT),
  });
  await assert.rejects(
    driver.decide({ turn: 0, request: { id: 'r4', objective: 'x' }, history: [] }),
    (error) => error.code === 'CODEX_RUN_FAILED',
  );
});

test('5. a genuine backend timeout (bridge\'s own internal timer) still rejects with the bridge\'s own typed *_TIMEOUT code, not the generic watchdog code', async () => {
  const driver = createCliPmDriver({
    profile: { id: 'live1-codex-pm', product: 'codex' },
    project: { id: 'p', repo_path: '/tmp/p' },
    run: async () => { throw Object.assign(new Error('Codex process timed out'), { code: 'CODEX_TIMEOUT', timeoutMs: 180_000 }); },
    executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT),
  });
  await assert.rejects(
    driver.decide({ turn: 0, request: { id: 'r5', objective: 'x' }, history: [] }),
    (error) => error.code === 'CODEX_TIMEOUT',
  );
});

test('6. parser failure after a real run() resolution still rejects with the parse error, unaffected by the watchdog (never masked as a watchdog timeout)', async () => {
  const driver = createCliPmDriver({
    profile: { id: 'live1-codex-pm', product: 'codex' },
    project: { id: 'p', repo_path: '/tmp/p' },
    run: async () => 'not json at all',
    executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT),
  });
  await assert.rejects(
    driver.decide({ turn: 0, request: { id: 'r6', objective: 'x' }, history: [] }),
    (error) => error.code === 'PM_DECISION_PARSE_FAILED',
  );
});

test('7. a healthy call that legitimately takes longer than the stage policy but well within the safety ceiling still succeeds (no regression for slow-but-working backends)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const driver = createCliPmDriver({
      profile: { id: 'live1-antigravity-gemini-high', product: 'antigravity' },
      project: { id: 'p', repo_path: '/tmp/p' },
      run: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ type: 'finish', output: 'slow but real' })), 300_000)),
      executionOptions: resolveExecutionOptions(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT), // policy=120s, but antigravity's own real bridge default is 300s
    });
    const decidePromise = driver.decide({ turn: 0, request: { id: 'r7', objective: 'x' }, history: [] });
    mock.timers.tick(300_000);
    const decision = await decidePromise;
    assert.equal(decision.output, 'slow but real');
  } finally {
    mock.timers.reset();
  }
});
