// P13-R1.3: process-level fatal-exit observability -- two owner-live
// incidents (P13-R1-LIVE, P13-R1.2) both ended ROOT_CAUSE_NOT_PERSISTED.
// See docs/p13/08_P13_R13_FATAL_EXIT_CAPTURE_AND_RECOVERY_STABILITY_OPUS5.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeFatalError, buildFatalRecord, appendFatalRecordSync, installFatalExitCapture } from '../src/runtime/fatal-exit-log.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/p13-r13-fatal-exit-fixture.mjs', import.meta.url));

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runFixture(mode, logPath) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [fixturePath, mode, logPath], { stdio: 'pipe' });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('exit', (code, signal) => resolvePromise({ code, signal, stdout }));
  });
}

// ---- pure sanitization -----------------------------------------------------

test('sanitizeFatalError redacts a secret-bearing message wholesale but preserves name/code, and preserves stack frame structure line-by-line', () => {
  const error = Object.assign(new Error('DSN failed: postgresql://dbuser:hunter2pass@dbhost:5432/production'), { code: 'ECONNREFUSED' });
  error.stack = `Error: DSN failed: postgresql://dbuser:hunter2pass@dbhost:5432/production\n    at Object.<anonymous> (E:\\repo\\src\\thing.mjs:42:11)\n    at Module._compile (node:internal/modules/cjs/loader:1105:14)`;
  const sanitized = sanitizeFatalError(error);
  assert.equal(sanitized.name, 'Error');
  assert.equal(sanitized.code, 'ECONNREFUSED');
  assert.equal(sanitized.message, '[REDACTED]');
  assert.doesNotMatch(sanitized.stack, /hunter2pass/);
  assert.match(sanitized.stack, /thing\.mjs:42:11/, 'file:line frames without secrets must survive redaction');
  assert.match(sanitized.stack, /\[REDACTED\]/);
});

test('sanitizeFatalError handles a non-Error thrown value without throwing', () => {
  assert.deepEqual(sanitizeFatalError('a plain string throw'), { name: 'NonErrorThrown', code: null, message: 'a plain string throw', stack: null });
  assert.deepEqual(sanitizeFatalError(42), { name: 'NonErrorThrown', code: null, message: '42', stack: null });
  const circular = {}; circular.self = circular;
  assert.equal(sanitizeFatalError(circular).name, 'NonErrorThrown'); // must not throw on JSON.stringify of a circular object
});

test('sanitizeFatalError leaves a clean error message untouched', () => {
  const error = new Error('workflow requires reconciliation: wf-abc123');
  const sanitized = sanitizeFatalError(error);
  assert.equal(sanitized.message, 'workflow requires reconciliation: wf-abc123');
});

test('buildFatalRecord produces a bounded, JSON-serializable, secret-safe record with an ISO timestamp', () => {
  const record = buildFatalRecord({ stage: 'TEST_STAGE', error: new Error('boom'), pid: 1234, extra: { role: 'worker', dsn: 'postgresql://u:p@h/db' } });
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(record.stage, 'TEST_STAGE');
  assert.equal(record.pid, 1234);
  assert.equal(record.extra.role, 'worker');
  assert.equal(record.extra.dsn, '[REDACTED]', 'a key literally named dsn must be redacted regardless of its value');
  assert.doesNotThrow(() => JSON.stringify(record));
});

test('buildFatalRecord requires a stage', () => {
  assert.throws(() => buildFatalRecord({ error: new Error('x') }), TypeError);
});

// ---- durable append ---------------------------------------------------------

test('appendFatalRecordSync appends NDJSON lines and never throws even when the path is unwritable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p13-r13-fatal-'));
  const logPath = join(dir, 'fatal-runtime.jsonl');
  try {
    assert.equal(appendFatalRecordSync(logPath, { a: 1 }), true);
    assert.equal(appendFatalRecordSync(logPath, { a: 2 }), true);
    const lines = readLines(logPath);
    assert.deepEqual(lines, [{ a: 1 }, { a: 2 }]);
    // An unwritable directory (as a file path) must degrade to `false`,
    // never throw -- a logging failure must never mask the real fatal exit.
    assert.equal(appendFatalRecordSync(join(dir, 'does', 'not', 'exist', 'fatal.jsonl'), { a: 3 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- recordFatal() never terminates the calling process --------------------

test('installFatalExitCapture().recordFatal() persists evidence without ever calling process.exit itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p13-r13-fatal-'));
  const logPath = join(dir, 'fatal-runtime.jsonl');
  const capture = installFatalExitCapture({ logPath, pid: 999 });
  try {
    capture.recordFatal('SHUTDOWN_COMPOSITION_CLOSE', new Error('close failed'), { role: 'all' });
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stage, 'SHUTDOWN_COMPOSITION_CLOSE');
    assert.equal(lines[0].pid, 999);
    assert.equal(lines[0].extra.role, 'all');
  } finally {
    capture.uninstall();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- real process-level capture (subprocess -- the only safe way to test
// an actual uncaughtException/unhandledRejection fatal exit) --------------

test('a real uncaughtException in a child process is captured to the fatal log, redacted, and the process exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p13-r13-fatal-proc-'));
  const logPath = join(dir, 'fatal-runtime.jsonl');
  try {
    const { code, signal } = await runFixture('uncaught', logPath);
    assert.equal(code, 1);
    assert.equal(signal, null);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stage, 'UNCAUGHT_EXCEPTION');
    assert.equal(lines[0].name, 'Error');
    assert.equal(lines[0].code, 'FIXTURE_UNCAUGHT');
    assert.equal(lines[0].message, '[REDACTED]', 'the secret-bearing message must never reach the durable log verbatim');
    const raw = readFileSync(logPath, 'utf8');
    assert.doesNotMatch(raw, /SECRET123456789/);
    assert.doesNotMatch(raw, /hunter2pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real unhandledRejection in a child process is captured to the fatal log, redacted, and the process exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p13-r13-fatal-proc-'));
  const logPath = join(dir, 'fatal-runtime.jsonl');
  try {
    const { code, signal } = await runFixture('rejection', logPath);
    assert.equal(code, 1);
    assert.equal(signal, null);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stage, 'UNHANDLED_REJECTION');
    assert.equal(lines[0].code, 'FIXTURE_REJECTION');
    const raw = readFileSync(logPath, 'utf8');
    assert.doesNotMatch(raw, /abcdefgh123456789012/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a healthy child process that never faults writes no fatal record at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p13-r13-fatal-proc-'));
  const logPath = join(dir, 'fatal-runtime.jsonl');
  try {
    const { code, stdout } = await runFixture('clean', logPath);
    assert.equal(code, 0);
    assert.match(stdout, /clean-exit/);
    assert.deepEqual(readLines(logPath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
