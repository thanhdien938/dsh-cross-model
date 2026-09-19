import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskDiagnosticLog, TASK_LOG_EVENT_TYPES, taskLogDir, createTaskDiagnosticLogFactory } from '../src/runtime/task-diagnostic-log.mjs';

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p10-tasklog-'));
  return dir;
}

function readEvents(dir) {
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('12: a task folder is created on first event', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_abc123' });
    log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, { project_id: 'p1' });
    assert.ok(existsSync(taskLogDir(root, 'task_abc123')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('13/14: summary.md and events.jsonl are created independently', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_1' });
    log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {});
    log.finalizeSummary('# DSH Task Diagnostic Summary\n\nTask ID: task_1\n');
    const dir = taskLogDir(root, 'task_1');
    assert.ok(existsSync(join(dir, 'events.jsonl')));
    assert.ok(existsSync(join(dir, 'summary.md')));
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /DSH Task Diagnostic Summary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('15: council.json is written only when explicitly requested (council tasks only)', () => {
  const root = tmpRoot();
  try {
    const single = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_single', taskMode: 'SINGLE' });
    single.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {});
    assert.equal(existsSync(join(taskLogDir(root, 'task_single'), 'council.json')), false);

    const council = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_council', taskMode: 'COUNCIL' });
    council.writeCouncilJson({ council_id: 'c1', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['a', 'b'] });
    assert.ok(existsSync(join(taskLogDir(root, 'task_council'), 'council.json')));
    const parsed = JSON.parse(readFileSync(join(taskLogDir(root, 'task_council'), 'council.json'), 'utf8'));
    assert.equal(parsed.council_id, 'c1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('16/17/18: events are chronological NDJSON and carry task_id/project_id', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_order', projectId: 'proj_x', pmRunId: 'pmrun_1' });
    log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, { n: 1 });
    log.event(TASK_LOG_EVENT_TYPES.PM_RUN_CREATED, { n: 2 });
    log.event(TASK_LOG_EVENT_TYPES.TASK_COMPLETED, { n: 3 });
    const events = readEvents(taskLogDir(root, 'task_order'));
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
    for (const e of events) {
      assert.equal(e.task_id, 'task_order');
      assert.equal(e.project_id, 'proj_x');
      assert.equal(e.pm_run_id, 'pmrun_1');
      assert.equal(typeof e.timestamp, 'string');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('19: profile/model metadata is present when supplied on an event', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_meta' });
    log.event(TASK_LOG_EVENT_TYPES.PARTICIPANT_START, { profile_id: 'live1-opencode-pm', product: 'opencode', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high' });
    const [event] = readEvents(taskLogDir(root, 'task_meta'));
    assert.equal(event.profile_id, 'live1-opencode-pm');
    assert.equal(event.product, 'opencode');
    assert.equal(event.model, 'opencode-go/deepseek-v4-flash');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('20: PID is recorded when known', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_pid' });
    log.event(TASK_LOG_EVENT_TYPES.BACKEND_PROCESS_SPAWN, { process_pid: 4242 });
    const [event] = readEvents(taskLogDir(root, 'task_pid'));
    assert.equal(event.process_pid, 4242);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('21/22: native session id is omitted/null when unknown, and reuse is never invented', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_native' });
    log.event(TASK_LOG_EVENT_TYPES.PARTICIPANT_RESULT, { native_session_id: null, native_conversation_id: null });
    const [event] = readEvents(taskLogDir(root, 'task_native'));
    assert.equal(event.native_session_id, null);
    assert.equal(event.native_conversation_id, null);
    assert.equal('native_session_reuse' in event, false, 'reuse is never fabricated by the log module itself');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('23/24: a failure task and a success task each get a finalized summary', () => {
  const root = tmpRoot();
  try {
    const failed = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_fail' });
    failed.event(TASK_LOG_EVENT_TYPES.TASK_FAILED, { error_code: 'COUNCIL_CHAIR_PLAN_FAILED' });
    failed.finalizeSummary('# Summary\n\nTerminal Result: FAILED\n');
    assert.match(readFileSync(join(taskLogDir(root, 'task_fail'), 'summary.md'), 'utf8'), /FAILED/);

    const ok = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_ok' });
    ok.event(TASK_LOG_EVENT_TYPES.TASK_COMPLETED, {});
    ok.finalizeSummary('# Summary\n\nTerminal Result: COMPLETED\n');
    assert.match(readFileSync(join(taskLogDir(root, 'task_ok'), 'summary.md'), 'utf8'), /COMPLETED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('25: a retry is represented as its own event', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_retry' });
    log.event(TASK_LOG_EVENT_TYPES.COUNCIL_PLAN_RETRY, { attempt: 2, reason: 'UNKNOWN_PARTICIPANT_INSTRUCTION' });
    const [event] = readEvents(taskLogDir(root, 'task_retry'));
    assert.equal(event.event_type, 'COUNCIL_PLAN_RETRY');
    assert.equal(event.attempt, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('26: secrets are redacted from event fields (reuses the durable audit sanitizer)', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_secret' });
    log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {
      telegram_bot_token: '123456789:AAFakeTelegramTokenValueXXXXXXXXXXXXX',
      api_key: 'sk-superSecretApiKeyValue1234567890',
      note: 'Bearer sk-abcdefghijklmno-should-be-redacted-too',
    });
    const raw = readFileSync(join(taskLogDir(root, 'task_secret'), 'events.jsonl'), 'utf8');
    assert.equal(raw.includes('AAFakeTelegramTokenValueXXXXXXXXXXXXX'), false);
    assert.equal(raw.includes('superSecretApiKeyValue1234567890'), false);
    const [event] = readEvents(taskLogDir(root, 'task_secret'));
    assert.equal(event.telegram_bot_token, '[REDACTED]');
    assert.equal(event.api_key, '[REDACTED]');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('27/28: bounded output — exceeding the events.jsonl byte bound emits LOG_TRUNCATED and stops further writes', () => {
  const root = tmpRoot();
  try {
    const log = new TaskDiagnosticLog({ runtimeRoot: root, taskId: 'task_bound' });
    // Note: sanitizeAuditData already clips any single string field to 500
    // chars (Part N/O layering), so each line here is small — loop by
    // return value until the byte bound is actually hit, rather than
    // assuming a fixed per-line size.
    let wroteTruncation = false;
    for (let i = 0; i < 20000 && !wroteTruncation; i += 1) {
      const ok = log.event(TASK_LOG_EVENT_TYPES.PARSER_RESULT, { blob: 'x'.repeat(600), i });
      if (!ok) wroteTruncation = true;
    }
    assert.ok(wroteTruncation, 'writes stop returning true once the bound is exceeded');
    const events = readEvents(taskLogDir(root, 'task_bound'));
    assert.ok(events.some((e) => e.event_type === TASK_LOG_EVENT_TYPES.LOG_TRUNCATED), 'a LOG_TRUNCATED event is present — never a silent stop');
    // Further events after truncation are not appended (bounded for real).
    const before = events.length;
    log.event(TASK_LOG_EVENT_TYPES.TASK_COMPLETED, {});
    const after = readEvents(taskLogDir(root, 'task_bound'));
    assert.equal(after.length, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('29: a write failure (invalid runtimeRoot) is non-fatal — event() returns false and never throws', () => {
  // NUL is illegal in a Windows/POSIX path component, guaranteeing the
  // underlying fs call fails without depending on platform permission bits.
  const log = new TaskDiagnosticLog({ runtimeRoot: `C:/${'\0'}illegal`, taskId: 'task_badpath' });
  let warned = null;
  const withWarning = new TaskDiagnosticLog({ runtimeRoot: `C:/${'\0'}illegal`, taskId: 'task_badpath', onWarning: (w) => { warned = w; } });
  assert.doesNotThrow(() => log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {}));
  assert.equal(log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {}), false);
  withWarning.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {});
  assert.ok(warned, 'a warning sink is offered a chance to observe the failure');
});

test('30: task logs land under the already-.gitignore\'d .runtime/ root convention', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const gitignore = rf(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^\.runtime\/$/m, '.runtime/ (the task log root\'s parent) is git-ignored wholesale');
});

test('factory: createTaskDiagnosticLogFactory binds runtimeRoot once and produces per-task logs', () => {
  const root = tmpRoot();
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const log = factory({ taskId: 'task_factory', projectId: 'p1', taskMode: 'COUNCIL' });
    log.event(TASK_LOG_EVENT_TYPES.TASK_ACCEPTED, {});
    const [event] = readEvents(taskLogDir(root, 'task_factory'));
    assert.equal(event.project_id, 'p1');
    assert.equal(event.task_mode, 'COUNCIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('taskLogDir rejects path-traversal-shaped task ids', () => {
  assert.throws(() => new TaskDiagnosticLog({ runtimeRoot: '/tmp/x', taskId: '../../etc/passwd' }), TypeError);
  assert.throws(() => new TaskDiagnosticLog({ runtimeRoot: '/tmp/x', taskId: '' }), TypeError);
});
