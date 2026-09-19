import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createBackendExecutionObserver,
  sanitizeExecutionLogText,
  boundExecutionLogLine,
  withSpawnObservation,
  EXEC_LOG_SENTINEL,
} from '../src/runtime/backend-execution-observer.mjs';

// B8: secret canaries are generated at test time, never a real committed
// secret, so this file never carries a leaked credential itself.
function canary() { return randomBytes(24).toString('hex'); }

test('sanitizeExecutionLogText redacts a bearer token canary', () => {
  const secret = canary();
  const line = `calling API with Authorization: Bearer ${secret}`;
  const out = sanitizeExecutionLogText(line);
  assert.equal(out.includes(secret), false);
  assert.match(out, /\[REDACTED\]/);
});

test('sanitizeExecutionLogText redacts a PostgreSQL DSN credential canary', () => {
  const secret = canary();
  const line = `connecting to postgresql://postgres:${secret}@127.0.0.1:5432/dsh`;
  const out = sanitizeExecutionLogText(line);
  assert.equal(out.includes(secret), false);
  assert.match(out, /postgresql:\/\/\[REDACTED\]@/);
});

test('sanitizeExecutionLogText redacts key=value secret-shaped fields', () => {
  const secret = canary();
  for (const key of ['api_key', 'token', 'secret', 'password', 'access_key']) {
    const out = sanitizeExecutionLogText(`${key}=${secret}`);
    assert.equal(out.includes(secret), false, `expected ${key} to be redacted`);
  }
});

test('sanitizeExecutionLogText redacts a Telegram-bot-token-shaped canary', () => {
  const secret = `${randomBytes(4).readUInt32BE(0) % 900000000 + 100000000}:${randomBytes(24).toString('hex')}`;
  const out = sanitizeExecutionLogText(`token ${secret} configured`);
  assert.equal(out.includes(secret), false);
  assert.match(out, /REDACTED_TELEGRAM_TOKEN/);
});

test('sanitizeExecutionLogText leaves ordinary diagnostic text untouched', () => {
  const line = 'PROCESS_EXIT code=0 duration=1820ms';
  assert.equal(sanitizeExecutionLogText(line), line);
});

test('boundExecutionLogLine caps an individual oversized line', () => {
  const huge = 'x'.repeat(50_000);
  const bounded = boundExecutionLogLine(huge);
  assert.ok(bounded.length <= 4100);
  assert.match(bounded, /\u2026\[truncated\]$/);
});

test('createBackendExecutionObserver emits a START event with identity fields', () => {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  observer.start({ backendProduct: 'claude-code', profileId: 'live1-claude-pm', projectId: 'dsh-p6-test-b', cwd: 'C:/repo-b', model: null });
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'START');
  assert.equal(events[0].backendProduct, 'claude-code');
  assert.equal(events[0].projectId, 'dsh-p6-test-b');
  assert.equal(events[0].cwd, 'C:/repo-b');
  assert.ok(events[0].timestamp);
});

test('createBackendExecutionObserver captures exit code and parser outcome', () => {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  const ctx = { backendProduct: 'claude-code', profileId: 'p', projectId: 'proj' };
  observer.exit(ctx, { exitCode: 0 });
  observer.parser(ctx, { outcome: 'PM_DECISION_EMPTY_OUTPUT', bytes: 0 });
  observer.terminal(ctx, { status: 'FAILED', durationMs: 18200 });
  assert.equal(events[0].phase, 'PROCESS_EXIT');
  assert.equal(events[0].exitCode, 0);
  assert.equal(events[1].parserOutcome, 'PM_DECISION_EMPTY_OUTPUT');
  assert.equal(events[2].status, 'FAILED');
  assert.equal(events[2].durationMs, 18200);
});

test('a throwing emit sink never propagates — observer failure must not fail the task', () => {
  const observer = createBackendExecutionObserver({ emit: () => { throw new Error('sink exploded'); } });
  assert.doesNotThrow(() => observer.start({ backendProduct: 'grok', profileId: 'p', projectId: 'proj' }));
  assert.doesNotThrow(() => observer.terminal({ backendProduct: 'grok' }, { status: 'FAILED' }));
});

test('an observer message is sanitized and bounded before it reaches the sink', () => {
  const secret = canary();
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  observer.stderrChunk({ backendProduct: 'codex', profileId: 'p', projectId: 'proj' }, { text: `Bearer ${secret} rejected` });
  assert.equal(events[0].message.includes(secret), false);
});

test('withSpawnObservation reports spawn/stdout/stderr/exit without altering the child process contract', async () => {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  const ctx = { backendProduct: 'codex', profileId: 'p', projectId: 'proj' };

  // Minimal fake ChildProcess-shaped object.
  const listeners = { stdout: {}, stderr: {}, proc: {} };
  const fakeChild = {
    pid: 4242,
    stdout: { on: (event, cb) => { listeners.stdout[event] = cb; } },
    stderr: { on: (event, cb) => { listeners.stderr[event] = cb; } },
    once: (event, cb) => { listeners.proc[event] = cb; },
  };
  const baseSpawn = () => fakeChild;
  const wrapped = withSpawnObservation(baseSpawn, observer, ctx);
  const child = wrapped('claude', ['-p'], {});

  assert.equal(child, fakeChild, 'withSpawnObservation must return the real child process untouched');
  assert.equal(events[0].phase, 'PROCESS_SPAWN');
  assert.equal(events[0].pid, 4242);

  listeners.stdout.data(Buffer.from('hello'));
  listeners.stderr.data(Buffer.from('warn'));
  listeners.proc.exit(0, null);

  const kinds = events.map((e) => e.phase);
  assert.deepEqual(kinds, ['PROCESS_SPAWN', 'STDOUT_EVENT', 'STDERR', 'PROCESS_EXIT']);
  assert.equal(events[3].exitCode, 0);
});

test('withSpawnObservation with no observer returns the original spawn implementation unchanged', () => {
  const baseSpawn = () => ({ pid: 1 });
  assert.equal(withSpawnObservation(baseSpawn, null, {}), baseSpawn);
});

test('withSpawnObservation never breaks the real spawn even if the observer throws', () => {
  const throwingObserver = { spawn() { throw new Error('boom'); }, stdoutChunk() {}, stderrChunk() {}, exit() {} };
  const fakeChild = { pid: 1, stdout: { on() {} }, stderr: { on() {} }, once() {} };
  const wrapped = withSpawnObservation(() => fakeChild, throwingObserver, {});
  assert.doesNotThrow(() => wrapped());
});

test('the default emit sink writes one sentinel-prefixed NDJSON line per event to stdout', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const observer = createBackendExecutionObserver();
    observer.start({ backendProduct: 'opencode', profileId: 'p', projectId: 'proj' });
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(EXEC_LOG_SENTINEL));
  const parsed = JSON.parse(lines[0].slice(EXEC_LOG_SENTINEL.length).trim());
  assert.equal(parsed.backendProduct, 'opencode');
});
