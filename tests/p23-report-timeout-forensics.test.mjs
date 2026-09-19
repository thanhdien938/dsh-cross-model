/**
 * P23.1 — report timeout forensics / observability hardening regressions.
 *
 * Authority: reports/P23_REPORT_TIMEOUT_FORENSICS_OBSERVABILITY_20260914.md,
 * the Claude Sonnet 120s-timeout forensic audit for
 * task-vufXVTFJcMGkMWMeoc9JB_URsfSCIGR4.
 *
 * Scope is OBSERVABILITY ONLY (see the module docstrings this exercises):
 * these tests never assert a changed timeout value, never assert TIMEOUT
 * becomes SUCCESS, and never assert reportDeliveryEligible() is weakened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { createClaudeReportBackend } from '../src/pm/report-backends/cli-report-backends.mjs';
import { reportDeliveryEligible, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import {
  captureExecutionForensics, boundedRedactedPreview, withoutForensicPreview,
  FORENSIC_PREVIEW_MAX_BYTES, sha256HexOrNull,
} from '../src/pm/report-backends/report-execution-forensics.mjs';
import { EXECUTION_DIAGNOSTICS_FILENAME, executionDiagnosticsRelpath } from '../src/artifacts/execution-diagnostics-artifact.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { TaskDiagnosticLog, forwardBackendEventToTaskLog } from '../src/runtime/task-diagnostic-log.mjs';
import { runSingleReport } from '../src/pm/single-report-operation.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

// ---- shared fake-spawn helpers (mirrors tests/p10-r021-claude-timeout-bridge.test.mjs) ----

function fakeHangingSpawn({ pid = 44896 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { process.nextTick(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); };
  return { spawnImpl: () => child, child };
}

const SINGLE_ARGS = (store, over = {}) => ({
  store,
  taskId: 'task-P23FORENSICS',
  taskSlug: 'p23.1 forensics',
  createdAt: '2026-09-14T09:00:00Z',
  invocationId: 'inv-p23-1',
  executionId: 'exec-p23-1',
  profileId: 'live1-fake',
  backend: 'fake',
  actorAlias: 'fake',
  instructions: 'go',
  ...over,
});

// ==================================================
// TEST A — Claude timeout diagnostics retained
// ==================================================

test('A1: captureExecutionForensics() preserves byte counts, hashes, assistant-output flag, exit code and signal', () => {
  const error = {
    code: 'CLAUDE_TIMEOUT',
    stdout: 'partial assistant text',
    stderr: 'warn: slow tool call',
    stdoutBytes: 23,
    stderrBytes: 21,
    assistantOutputPresent: true,
    exitCode: null,
    signal: 'SIGTERM',
    timeoutMs: 120_000,
    elapsedMs: 120_017,
    terminationRequestedByDsh: true,
  };
  const { compact, preview } = captureExecutionForensics(error);
  assert.equal(compact.stdout_bytes, Buffer.byteLength('partial assistant text', 'utf8'));
  assert.equal(compact.stderr_bytes, Buffer.byteLength('warn: slow tool call', 'utf8'));
  assert.equal(compact.stdout_sha256, sha256HexOrNull('partial assistant text'));
  assert.equal(compact.stderr_sha256, sha256HexOrNull('warn: slow tool call'));
  assert.equal(compact.assistant_output_present, true);
  assert.equal(compact.exit_code, null);
  assert.equal(compact.signal, 'SIGTERM');
  assert.equal(compact.timeout_ms, 120_000);
  assert.equal(compact.elapsed_ms, 120_017);
  assert.equal(compact.termination_requested, true);
  assert.equal(compact.stdout_captured, true);
  assert.equal(compact.stderr_captured, true);
  assert.equal(preview.stdout_preview, 'partial assistant text');
  assert.equal(preview.stderr_preview, 'warn: slow tool call');
});

test('A2: a real Claude report-backend TIMEOUT keeps terminal_state=TIMEOUT, ineligible, with bounded safeDiagnostics', async () => {
  const { spawnImpl, child } = fakeHangingSpawn();
  const backend = createClaudeReportBackend({ cwd: '/x', timeoutMs: 300, spawnImpl });
  const request = { profileId: 'live1-claude-sonnet-medium', executionId: 'exec-a2', stage: 'participant-report', invocation: { invocationId: 'inv-a2' }, store: { projectId: 'p' } };
  const pending = backend.runReport({ prompt: 'x', request });
  child.stdout.write('partial assistant tex');
  child.stderr.write('warn: slow tool call');
  const result = await pending; // report-plane runReport() never throws — always resolves to a ReportBackendResult
  assert.equal(result.terminal_state, TERMINAL_STATE.TIMEOUT);
  assert.equal(result.timed_out, true);
  assert.equal(reportDeliveryEligible(result).eligible, false);
  assert.equal(reportDeliveryEligible(result).code, 'REPORT_EXECUTION_TIMEOUT');
  const d = result.safe_diagnostics;
  assert.equal(d.error_code, 'CLAUDE_TIMEOUT');
  assert.equal(d.stdout_bytes, Buffer.byteLength('partial assistant tex', 'utf8'));
  assert.equal(d.stderr_bytes, Buffer.byteLength('warn: slow tool call', 'utf8'));
  assert.ok(/^[0-9a-f]{64}$/.test(d.stdout_sha256));
  assert.ok(/^[0-9a-f]{64}$/.test(d.stderr_sha256));
  assert.equal(d.assistant_output_present, true);
  // Honest, never fabricated: the bridge's own timeout path never learns a
  // real OS signal at reject-time (see claude-code-session-bridge.mjs's
  // `observedSignal: null` discipline) — captureExecutionForensics() must
  // not invent one.
  assert.equal(d.signal, null);
  assert.equal(d.termination_requested, true);
  assert.equal(d.preview.stdout_preview, 'partial assistant tex');
  assert.equal(d.preview.stderr_preview, 'warn: slow tool call');
});

test('A3: signal IS preserved through a real (non-timeout) CLAUDE_EXIT_FAILED close event', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.end('boom');
      child.stdout.end('');
      queueMicrotask(() => child.emit('close', 1, 'SIGTERM'));
    });
    return child;
  };
  const backend = createClaudeReportBackend({ cwd: '/x', timeoutMs: 10_000, spawnImpl });
  const request = { profileId: 'p', executionId: 'exec-a3', stage: 'participant-report', invocation: { invocationId: 'inv-a3' }, store: { projectId: 'p' } };
  const result = await backend.runReport({ prompt: 'x', request });
  assert.equal(result.terminal_state, TERMINAL_STATE.PROVIDER_ERROR);
  assert.equal(result.safe_diagnostics.signal, 'SIGTERM');
  assert.equal(result.safe_diagnostics.exit_code, 1);
  assert.equal(result.process_exit_code, 1);
  assert.equal(reportDeliveryEligible(result).eligible, false);
});

// ==================================================
// TEST B — zero-output timeout vs missing-field timeout
// ==================================================

test('B1: zero-output timeout records 0 bytes explicitly, captured=true, assistant_output_present=false', async () => {
  const { spawnImpl } = fakeHangingSpawn();
  const backend = createClaudeReportBackend({ cwd: '/x', timeoutMs: 150, spawnImpl });
  const request = { profileId: 'p', executionId: 'exec-b1', stage: 'participant-report', invocation: { invocationId: 'inv-b1' }, store: { projectId: 'p' } };
  const result = await backend.runReport({ prompt: 'x', request });
  assert.equal(result.terminal_state, TERMINAL_STATE.TIMEOUT);
  assert.equal(result.safe_diagnostics.stdout_bytes, 0);
  assert.equal(result.safe_diagnostics.stderr_bytes, 0);
  assert.equal(result.safe_diagnostics.stdout_captured, true);
  assert.equal(result.safe_diagnostics.assistant_output_present, false);
  assert.equal(result.safe_diagnostics.preview.stdout_preview, null);
});

test('B2: a backend error shape that never captures stdout/stderr at all records "missing", distinct from "0 bytes"', () => {
  const { compact } = captureExecutionForensics({ code: 'OPENCODE_TIMEOUT' }); // matches today's real OpenCode/Codex/Antigravity/Grok timeout error shape
  assert.equal(compact.stdout_captured, false);
  assert.equal(compact.stderr_captured, false);
  assert.equal(compact.stdout_bytes, null);
  assert.equal(compact.stderr_bytes, null);
  assert.equal(compact.stdout_sha256, null);
  assert.equal(compact.assistant_output_present, null);
});

// ==================================================
// TEST C — executive log + diagnostics artifact on timeout (no delivery)
// ==================================================

test('C: executive.log AND execution-diagnostics.json exist on TIMEOUT; report.md does not; recordDelivery is never reached', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const safeDiagnostics = {
      error_code: 'CLAUDE_TIMEOUT', timeout_ms: 120_000, elapsed_ms: 120_017,
      stdout_captured: true, stderr_captured: true, stdout_bytes: 21, stderr_bytes: 20,
      stdout_sha256: sha256HexOrNull('partial assistant tex'), stderr_sha256: sha256HexOrNull('warn: slow'),
      assistant_output_present: true, exit_code: null, signal: null, termination_requested: true,
      stdout_chunk_count: 2, stdout_total_bytes: 21,
      stdout_first_event_at: '2026-09-14T09:00:01.000Z', stdout_last_event_at: '2026-09-14T09:00:02.000Z',
      stderr_chunk_count: 1, stderr_total_bytes: 20,
      stderr_first_event_at: '2026-09-14T09:00:01.500Z', stderr_last_event_at: '2026-09-14T09:00:01.500Z',
      preview: { stdout_preview: 'partial assistant tex', stderr_preview: 'warn: slow' },
    };
    await assert.rejects(
      runSingleReport(SINGLE_ARGS(store, {
        reportBackend: fakeReportBackend({ text: 'looks-done-but-timed-out', terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true, safeDiagnostics }),
      })),
      (e) => e.code === 'REPORT_EXECUTION_TIMEOUT',
    );
    const invDir = join(store.tasksRoot, readdirSync(store.tasksRoot).find((n) => !n.startsWith('.')), 'single', 'fake', 'inv-p23-1');
    const attemptDir = join(invDir, 'attempt-00');
    const files = readdirSync(attemptDir);
    assert.equal(files.some((n) => n.endsWith('report.md')), false, 'report.md must never be materialized from an ineligible result');
    assert.equal(files.some((n) => n.endsWith('executive.log')), true, 'executive.log must exist for a TIMEOUT attempt');
    assert.equal(files.includes(EXECUTION_DIAGNOSTICS_FILENAME), true, 'execution-diagnostics.json must exist for a TIMEOUT attempt');

    const execLog = JSON.parse(readFileSync(join(attemptDir, files.find((n) => n.endsWith('executive.log'))), 'utf8'));
    assert.equal(execLog.terminal_state, 'TIMEOUT');
    assert.equal(execLog.error_code, 'CLAUDE_TIMEOUT');
    assert.equal(execLog.report_bytes, null);
    assert.equal(execLog.delivery_mechanism, null);
    assert.ok(!('preview' in (execLog.safe_diagnostics ?? {})), 'preview text must never reach executive.log');
    assert.equal(execLog.safe_diagnostics.stdout_bytes, 21);
    assert.ok(typeof execLog.diagnostics_artifact_relpath === 'string');

    const diag = JSON.parse(readFileSync(join(attemptDir, EXECUTION_DIAGNOSTICS_FILENAME), 'utf8'));
    assert.equal(diag.kind, 'P23ExecutionDiagnosticsArtifact');
    assert.equal(diag.terminal_state, 'TIMEOUT');
    assert.equal(diag.stdout_chunk_count, 2);
    assert.equal(diag.stdout_total_bytes, 21);
    assert.equal(diag.stdout_last_event_at, '2026-09-14T09:00:02.000Z');
    assert.equal(diag.bounded_stdout_preview, 'partial assistant tex');
    assert.equal(diag.bounded_stderr_preview, 'warn: slow');
    assert.match(diag.note, /NON-AUTHORITATIVE/);

    const inv = JSON.parse(readFileSync(join(invDir, 'invocation.json'), 'utf8'));
    assert.notEqual(inv.lifecycle, 'DELIVERED');
  });
});

// ==================================================
// TEST D — success behavior unchanged
// ==================================================

test('D: a successful report keeps byte-exact report.md, an executive.log, delivery success, and NO diagnostics artifact', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const out = await runSingleReport(SINGLE_ARGS(store, { reportBackend: fakeReportBackend({ text: '# report\n\nfindings...\n' }) }));
    assert.equal(readFileSync(out.delivery.reportPath, 'utf8'), '# report\n\nfindings...\n');
    assert.ok(existsSync(out.executiveLog.path));
    const inv = JSON.parse(readFileSync(out.invocation.recordPath, 'utf8'));
    assert.equal(inv.lifecycle, 'DELIVERED');
    assert.equal(existsSync(join(dirname(out.executiveLog.path), EXECUTION_DIAGNOSTICS_FILENAME)), false, 'a SUCCESS attempt must never get a diagnostics artifact');
  });
});

// ==================================================
// TEST E — persisted terminal event
// ==================================================

test('E: observer.terminal(...) is forwarded into a durable BACKEND_TERMINAL task-diagnostic event', async () => {
  await withTempRoot(async (dir) => {
    const events = [];
    const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
    observer.terminal({ backendProduct: 'claude-code', profileId: 'live1-claude-sonnet-medium', taskId: 'task-e1', runId: 'exec-e1', invocationId: 'inv-e1', stage: 'participant-report' }, { status: 'FAILED', durationMs: 120_017, error: 'CLAUDE_TIMEOUT', terminalState: 'TIMEOUT' });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventKind, 'TERMINAL');
    assert.equal(events[0].terminalState, 'TIMEOUT');
    assert.equal(events[0].errorCode, 'CLAUDE_TIMEOUT');

    const factory = ({ taskId, projectId, pmRunId, taskMode }) => new TaskDiagnosticLog({ runtimeRoot: dir, taskId, projectId, pmRunId, taskMode });
    const forwarded = forwardBackendEventToTaskLog(events[0], factory);
    assert.equal(forwarded, true);
    const lines = readFileSync(join(dir, 'task-e1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const term = lines.find((l) => l.event_type === 'BACKEND_TERMINAL');
    assert.ok(term, 'a durable BACKEND_TERMINAL event must exist');
    assert.equal(term.execution_id, 'exec-e1');
    assert.equal(term.invocation_id, 'inv-e1');
    assert.equal(term.terminal_state, 'TIMEOUT');
    assert.equal(term.error_code, 'CLAUDE_TIMEOUT');
    assert.equal(term.duration_ms, 120_017);
  });
});

// ==================================================
// TEST F — process exit signal persisted
// ==================================================

test('F: a signaled process exit (code=null, signal=SIGTERM) survives into the durable BACKEND_PROCESS_EXIT event', async () => {
  await withTempRoot(async (dir) => {
    const events = [];
    const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
    observer.exit({ backendProduct: 'claude-code', profileId: 'live1-claude-sonnet-medium', taskId: 'task-f1' }, { exitCode: null, signal: 'SIGTERM' });
    assert.equal(events[0].exitCode, null);
    assert.equal(events[0].signal, 'SIGTERM');

    const factory = ({ taskId, projectId, pmRunId, taskMode }) => new TaskDiagnosticLog({ runtimeRoot: dir, taskId, projectId, pmRunId, taskMode });
    forwardBackendEventToTaskLog(events[0], factory);
    const lines = readFileSync(join(dir, 'task-f1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const exit = lines.find((l) => l.event_type === 'BACKEND_PROCESS_EXIT');
    assert.equal(exit.exit_code, null);
    assert.equal(exit.signal, 'SIGTERM');
  });
});

// ==================================================
// TEST G — bounds
// ==================================================

test('G: oversized stdout/stderr are capped in preview but byte count + hash reflect the FULL observed size', () => {
  const bigStdout = `HEAD-MARKER-${'x'.repeat(40_000)}-TAIL-MARKER`;
  const { compact, preview } = captureExecutionForensics({ code: 'CLAUDE_TIMEOUT', stdout: bigStdout, stderr: '' });
  assert.equal(compact.stdout_bytes, Buffer.byteLength(bigStdout, 'utf8'));
  assert.equal(compact.stdout_sha256, sha256HexOrNull(bigStdout));
  assert.ok(Buffer.byteLength(preview.stdout_preview, 'utf8') <= FORENSIC_PREVIEW_MAX_BYTES + 300, 'preview must stay bounded even for a huge input');
  assert.match(preview.stdout_preview, /HEAD-MARKER-/);
  assert.match(preview.stdout_preview, /-TAIL-MARKER$/);
  assert.match(preview.stdout_preview, /TRUNCATED/);
  // stderr was captured (present) but empty — 0 bytes, not "missing".
  assert.equal(compact.stderr_bytes, 0);
  assert.equal(compact.stderr_captured, true);
});

test('G2: withoutForensicPreview() strips only the preview sub-key, keeping every compact field', () => {
  const full = { error_code: 'CLAUDE_TIMEOUT', stdout_bytes: 10, preview: { stdout_preview: 'x'.repeat(9000) } };
  const stripped = withoutForensicPreview(full);
  assert.equal(stripped.error_code, 'CLAUDE_TIMEOUT');
  assert.equal(stripped.stdout_bytes, 10);
  assert.equal('preview' in stripped, false);
  assert.equal(withoutForensicPreview(null), null);
});

// ==================================================
// TEST H — no regression for a non-Claude report backend's failure path
// ==================================================

test('H: a generic non-Claude backend TIMEOUT still gets the shared executive-log + diagnostics-artifact evidence, unchanged report semantics', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    await assert.rejects(
      runSingleReport(SINGLE_ARGS(store, { reportBackend: fakeReportBackend({ text: 'x', terminalState: TERMINAL_STATE.TIMEOUT, timedOut: true }) })),
      (e) => e.code === 'REPORT_EXECUTION_TIMEOUT',
    );
    const invDir = join(store.tasksRoot, readdirSync(store.tasksRoot).find((n) => !n.startsWith('.')), 'single', 'fake', 'inv-p23-1');
    const attemptDir = join(invDir, 'attempt-00');
    const files = readdirSync(attemptDir);
    assert.equal(files.some((n) => n.endsWith('report.md')), false);
    assert.equal(files.some((n) => n.endsWith('executive.log')), true);
    assert.equal(files.includes(EXECUTION_DIAGNOSTICS_FILENAME), true);
  });
});

test('executionDiagnosticsRelpath() derives the sibling filename from an assigned report relpath', () => {
  assert.equal(
    executionDiagnosticsRelpath('tasks/x/members/claude-sonnet-medium/participant-report/inv-1/attempt-00/20260914_143604__claude-sonnet-medium__participant-report__report.md'),
    'tasks/x/members/claude-sonnet-medium/participant-report/inv-1/attempt-00/execution-diagnostics.json',
  );
  assert.equal(executionDiagnosticsRelpath(null), null);
});
