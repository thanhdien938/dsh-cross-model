import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';

import { PRODUCTION_REPORT_BACKEND_TIMEOUT_MS } from '../src/pm/report-execution-timeout-policy.mjs';
import { CLAUDE_CODE_DEFAULT_TIMEOUT_MS } from '../src/session/claude-code-session-bridge.mjs';
import { CODEX_CLI_DEFAULT_TIMEOUT_MS } from '../src/session/codex-cli-session-bridge.mjs';
import { OPENCODE_DEFAULT_TIMEOUT_MS } from '../src/session/opencode-cli-session-bridge.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { createClaudeReportBackend, createCodexReportBackend, createOpenCodeReportBackend } from '../src/pm/report-backends/cli-report-backends.mjs';
import { reportDeliveryEligible } from '../src/pm/report-backend-result.mjs';
import { createCliReportBackendResolver } from '../src/runtime/p20-report-route-resolution.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';

function timedChild({ exitDelayMs = 0, stubborn = false, output = 'progress' } = {}) {
  const child = new EventEmitter();
  child.pid = 2345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    if (!stubborn) setTimeout(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }, exitDelayMs);
    return true;
  };
  queueMicrotask(() => child.stdout.write(output));
  return child;
}

const request = (profileId, executionId) => ({
  profileId, executionId, taskId: 'task-p23-3', stage: 'participant-report', role: 'member',
  invocation: { invocationId: `inv-${executionId}` }, store: { projectId: 'p' },
});

test('production report timeout policy uses the P23.5 resilience ceilings', () => {
  assert.deepEqual(
    { codex: PRODUCTION_REPORT_BACKEND_TIMEOUT_MS.codex, opencode: PRODUCTION_REPORT_BACKEND_TIMEOUT_MS.opencode, claude: PRODUCTION_REPORT_BACKEND_TIMEOUT_MS['claude-code'] },
    { codex: 540_000, opencode: 540_000, claude: 360_000 },
  );
});

test('P23.5 leaves generic bridge defaults unchanged and independent', () => {
  assert.equal(CODEX_CLI_DEFAULT_TIMEOUT_MS, 180_000);
  assert.equal(OPENCODE_DEFAULT_TIMEOUT_MS, 180_000);
  assert.equal(CLAUDE_CODE_DEFAULT_TIMEOUT_MS, 120_000);
});

test('production entry point supplies the explicit policy to composition', () => {
  const source = readFileSync(new URL('../scripts/p5-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /reportBackendTimeoutMsByProduct:\s*PRODUCTION_REPORT_BACKEND_TIMEOUT_MS/);
});

test('resolver forwards explicit DI policy values to Codex, OpenCode, and Claude', async () => {
  const profiles = [
    { id: 'c', role_kind: 'PM', product: 'codex', model: 'gpt-5', session_kind: 'STATELESS', transport: 'stdio' },
    { id: 'o', role_kind: 'PM', product: 'opencode', model: 'x/y', session_kind: 'STATELESS', transport: 'stdio' },
    { id: 'a', role_kind: 'PM', product: 'claude-code', model: 'sonnet', session_kind: 'STATELESS', transport: 'stdio' },
  ];
  const policy = { ...PRODUCTION_REPORT_BACKEND_TIMEOUT_MS, codex: 70, opencode: 90, 'claude-code': 110 };
  const resolver = createCliReportBackendResolver({
    profileRegistry: new PmProfileRegistry(profiles), project: { id: 'p', repo_path: '.' }, timeoutMsByProduct: policy,
    spawnImpl: () => timedChild(), observer: createBackendExecutionObserver({ emit: () => {} }),
  });
  for (const [id, expected] of [['c', 70], ['o', 90], ['a', 110]]) {
    const result = await resolver(id).runReport({ prompt: 'x', request: request(id, `exec-${id}`) });
    assert.equal(result.terminal_state, 'TIMEOUT');
    assert.equal(result.safe_diagnostics.timeout_ms, expected);
  }
});

test('Codex and OpenCode timeout results retain bounded stream summary metadata and remain ineligible', async () => {
  for (const [name, create] of [['codex', createCodexReportBackend], ['opencode', createOpenCodeReportBackend]]) {
    const child = timedChild();
    const result = await create({ cwd: '.', timeoutMs: 80, spawnImpl: () => child, processSettlementOptions: { gracefulAfterMs: 50, reapAfterMs: 100 } })
      .runReport({ prompt: 'x', request: request(name, `exec-${name}`) });
    assert.equal(result.terminal_state, 'TIMEOUT');
    assert.equal(reportDeliveryEligible(result).eligible, false);
    assert.equal(result.safe_diagnostics.stdout_chunk_count, 1);
    assert.equal(result.safe_diagnostics.stdout_total_bytes, Buffer.byteLength('progress'));
    assert.ok(result.safe_diagnostics.stdout_first_event_at);
    assert.ok(result.safe_diagnostics.stdout_last_event_at);
    assert.equal(result.safe_diagnostics.stderr_chunk_count, 0);
    assert.equal(result.safe_diagnostics.stderr_last_event_at, null);
  }
});

test('Claude zero-output summary remains proven zero and preserves its prior safe diagnostics', async () => {
  const child = timedChild({ output: '' });
  const result = await createClaudeReportBackend({ cwd: '.', timeoutMs: 80, spawnImpl: () => child, processSettlementOptions: { gracefulAfterMs: 50, reapAfterMs: 100 } })
    .runReport({ prompt: 'x', request: request('claude', 'exec-claude') });
  assert.equal(result.terminal_state, 'TIMEOUT');
  assert.equal(result.safe_diagnostics.stdout_chunk_count, 0);
  assert.equal(result.safe_diagnostics.stdout_total_bytes, 0);
  assert.equal(result.safe_diagnostics.stdout_last_event_at, null);
  assert.equal(result.safe_diagnostics.stdout_bytes, 0);
  assert.equal(result.safe_diagnostics.stdout_captured, true);
});

test('delayed timeout exit is observed before the next sequential participant spawns', async () => {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (event) => events.push(event) });
  const firstChild = timedChild({ exitDelayMs: 25 });
  const first = createCodexReportBackend({ cwd: '.', timeoutMs: 80, spawnImpl: () => firstChild, observer, processSettlementOptions: { gracefulAfterMs: 50, reapAfterMs: 50 } });
  await first.runReport({ prompt: 'x', request: request('codex', 'exec-first') });
  const secondChild = timedChild();
  const second = createOpenCodeReportBackend({ cwd: '.', timeoutMs: 80, spawnImpl: () => secondChild, observer, processSettlementOptions: { gracefulAfterMs: 50, reapAfterMs: 100 } });
  await second.runReport({ prompt: 'x', request: request('opencode', 'exec-second') });
  const firstExit = events.findIndex((e) => e.runId === 'exec-first' && e.eventKind === 'PROCESS_EXIT');
  const secondSpawn = events.findIndex((e) => e.runId === 'exec-second' && e.eventKind === 'PROCESS_SPAWN');
  assert.ok(firstExit >= 0 && secondSpawn > firstExit, JSON.stringify(events.map((e) => [e.runId, e.eventKind])));
  assert.ok(Date.parse(events[firstExit].timestamp) <= Date.parse(events[secondSpawn].timestamp));
});

test('normal success remains prompt and byte compatible', async () => {
  const child = timedChild({ output: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n' });
  queueMicrotask(() => setTimeout(() => { child.emit('exit', 0, null); child.emit('close', 0, null); }, 1));
  const result = await createCodexReportBackend({ cwd: '.', spawnImpl: () => child }).runReport({ prompt: 'x', request: request('codex', 'exec-success') });
  assert.equal(result.terminal_state, 'SUCCESS');
  assert.equal(result.accepted_visible_text, 'ok');
});

test('stubborn process cleanup remains bounded', async () => {
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 50);
  const child = timedChild({ stubborn: true });
  const result = await createCodexReportBackend({ cwd: '.', timeoutMs: 80, spawnImpl: () => child, processSettlementOptions: { gracefulAfterMs: 50, reapAfterMs: 100, taskkillSpawn: () => { const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 0)); return killer; } } })
    .runReport({ prompt: 'x', request: request('codex', 'exec-stubborn') });
  clearInterval(keepAlive);
  assert.equal(result.terminal_state, 'TIMEOUT');
  assert.ok(Date.now() - started < 500, 'bounded reaper must not deadlock');
});
