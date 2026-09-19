import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runCodexCliProcess, summarizeCodexCliRun, extractCodexAssistantText,
  probeCodexWindowsSandboxHelper, classifyCodexSandboxExecution, CodexCliError,
} from '../src/session/codex-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

// P10-R0.2.2 Part S — matches the existing fakeSpawn pattern
// (tests/production-codex-grok-backends.test.mjs).
function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, capture = {} } = {}) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      queueMicrotask(() => child.emit('close', code));
    });
    return child;
  };
}

// Real, live-captured shape (docs/p10/08_CODEX_WINDOWS_SANDBOX_AND_AWAIT_
// OWNER_HARDENING_SONNET5.md) — a command_execution item that failed with
// Codex's own orchestrator_helper_launch_failed marker text.
function sandboxFailureJsonl(finalMessage) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: "I'll inspect the current directory." } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'Get-ChildItem', aggregated_output: 'execution error: Io(Custom { kind: Other, error: "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\\\\proj, error=program not found" })', exit_code: -1, status: 'failed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: finalMessage } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n');
}

function normalCommandJsonl(finalMessage) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 't2' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Inspecting.' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'Get-ChildItem', aggregated_output: 'progress.md\nREADME.md\n', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: finalMessage } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n');
}

function noToolJsonl(finalMessage) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 't3' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: finalMessage } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n');
}

// ---- Part S.1/S.2: helper readiness success / missing --------------------

test('1: helper readiness success — a real sibling codex-resources/codex-windows-sandbox-setup.exe reports READY/FOUND', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'codex-resources'));
  writeFileSync(join(dir, 'codex-resources', 'codex-windows-sandbox-setup.exe'), 'stub');
  const binary = join(dir, 'bin', 'codex.exe');
  writeFileSync(binary, 'stub');
  const readiness = probeCodexWindowsSandboxHelper(binary);
  assert.equal(readiness.sandboxReadiness, 'READY');
  assert.equal(readiness.helperResolution, 'FOUND');
  assert.equal(readiness.helperPath, join(dir, 'codex-resources', 'codex-windows-sandbox-setup.exe'));
});

test('2: helper missing — no sibling codex-resources dir reports DEGRADED/MISSING (the live-reproduced hardlink-shim case)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const binary = join(dir, 'bin', 'codex.exe');
  writeFileSync(binary, 'stub');
  const readiness = probeCodexWindowsSandboxHelper(binary);
  assert.equal(readiness.sandboxReadiness, 'DEGRADED');
  assert.equal(readiness.helperResolution, 'MISSING');
  assert.equal(readiness.helperPath, null);
});

test('readiness never spawns a process — purely filesystem structural (Part F: no heavy probing)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // No binary file even created here -- if this function spawned anything,
  // it would throw/hang; it must return a typed result instead.
  const readiness = probeCodexWindowsSandboxHelper(join(dir, 'bin', 'codex.exe'));
  assert.equal(readiness.sandboxReadiness, 'DEGRADED');
});

test('unknown/unresolvable binary input degrades safely, never throws', () => {
  assert.deepEqual(probeCodexWindowsSandboxHelper(null), { sandboxReadiness: 'UNAVAILABLE', helperResolution: 'UNKNOWN', helperPath: null });
  assert.deepEqual(probeCodexWindowsSandboxHelper(''), { sandboxReadiness: 'UNAVAILABLE', helperResolution: 'UNKNOWN', helperPath: null });
});

// ---- Part S.3/S.4: helper execution failure / process exit 0 with -------
// ---- sandbox failure event -----------------------------------------------

test('3/4: a command_execution failing with the live sandbox-helper marker classifies as FAILED, even though the CLI process itself exited 0', () => {
  const summary = summarizeCodexCliRun({ stdout: sandboxFailureJsonl("I couldn't list the directory because the sandbox helper failed."), code: 0 });
  const classification = classifyCodexSandboxExecution(summary);
  assert.equal(classification.helperExecution, 'FAILED');
  assert.equal(classification.sandboxFailureCode, 'CODEX_SANDBOX_UNAVAILABLE');
});

// ---- Part S.5: process nonzero failure (regression, unaffected) ---------

test('5: a real nonzero-exit Codex process failure is unaffected by sandbox classification (existing CODEX_RUN_FAILED behavior)', async () => {
  await assert.rejects(
    runCodexCliProcess({ binary: 'codex-safe', prompt: 'p', spawnImpl: fakeSpawn({ stderr: 'boom', code: 7 }) }),
    (e) => e instanceof CodexCliError && e.code === 'CODEX_RUN_FAILED' && e.exitCode === 7,
  );
});

// ---- Part S.6: normal repository-read success ----------------------------

test('6: a normal successful command_execution (no sandbox marker) classifies as OK', () => {
  const summary = summarizeCodexCliRun({ stdout: normalCommandJsonl('Here are the files: progress.md, README.md'), code: 0 });
  const classification = classifyCodexSandboxExecution(summary);
  assert.equal(classification.helperExecution, 'OK');
  assert.equal(classification.sandboxFailureCode, null);
});

test('a turn with no command_execution at all (model never attempted a tool call) classifies as NOT_ATTEMPTED', () => {
  const summary = summarizeCodexCliRun({ stdout: noToolJsonl('No repository access was needed for this answer.'), code: 0 });
  const classification = classifyCodexSandboxExecution(summary);
  assert.equal(classification.helperExecution, 'NOT_ATTEMPTED');
  assert.equal(classification.sandboxFailureCode, null);
});

// ---- Part S.7/H: sandbox failure does NOT become PM success/failure by ---
// ---- itself -- the real parser/normalizer alone governs the outcome -----

test('7/H: a sandbox-failure-tainted Codex run whose final assistant text is still a VALID finish decision still completes normally', async () => {
  const emitted = [];
  const observer = { start(){}, parser(){}, terminal(){}, stdoutSummary(){}, sandbox(ctx, extra){ emitted.push(extra); } };
  const registry = new ProductionPmBackendRegistry({codexBinary:'codex-safe',
    probe: () => true, observer,
    codexRunner: async () => summarizeCodexCliRun({ stdout: sandboxFailureJsonl(JSON.stringify({ type: 'finish', output: 'Could not read the repo (sandbox helper failed), but the task did not require it.' })), code: 0 }),
  });
  const profile = { id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  const decision = await registry.resolve(profile, { project: { repo_path: 'C:/proj' } }).decide({ turn: 0, request: {}, history: [] });
  assert.equal(decision.type, 'finish');
  assert.equal(decision.output, 'Could not read the repo (sandbox helper failed), but the task did not require it.');
  // The sandbox diagnostic event still fired, reporting the real failure --
  // it is additive evidence, never a silent override of the real decision.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].state, 'FAILED');
  assert.equal(emitted[0].failureCode, 'CODEX_SANDBOX_UNAVAILABLE');
});

test('7/H: a sandbox-failure-tainted Codex run whose final assistant text is NOT valid JSON still fails at the normal parser boundary (PM_DECISION_PARSE_FAILED), not silently swallowed', async () => {
  const registry = new ProductionPmBackendRegistry({codexBinary:'codex-safe',
    probe: () => true,
    codexRunner: async () => summarizeCodexCliRun({ stdout: sandboxFailureJsonl('I could not complete this because the sandbox helper failed to launch.'), code: 0 }),
  });
  const profile = { id: 'c', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  await assert.rejects(
    registry.resolve(profile, { project: { repo_path: 'C:/proj' } }).decide({ turn: 0, request: {}, history: [] }),
    (e) => e.code === 'PM_DECISION_PARSE_FAILED',
  );
});

// ---- Part S.8/S.9/S.10: no unsafe flags, canonical cwd, no shell:true ----

test('8: no unsafe/bypass flags are ever added to Codex argv', () => {
  const capture = {};
  return runCodexCliProcess({ binary: 'codex-safe', prompt: 'p', cwd: 'C:/proj', spawnImpl: fakeSpawn({ stdout: normalCommandJsonl('ok'), capture }) }).then(() => {
    assert.deepEqual(capture.args.slice(0, 6), ['exec', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '--color']);
    for (const forbidden of ['--dangerously-bypass', '--no-sandbox', '--unsafe', '--yolo', '--full-auto', '--danger-full-access']) {
      assert.equal(capture.args.includes(forbidden), false, `must never include ${forbidden}`);
    }
  });
});

test('9: cwd stays exactly the canonical project repo root passed in', async () => {
  const capture = {};
  await runCodexCliProcess({ binary: 'codex-safe', prompt: 'p', cwd: 'C:/canonical/project/root', spawnImpl: fakeSpawn({ stdout: normalCommandJsonl('ok'), capture }) });
  assert.equal(capture.options.cwd, 'C:/canonical/project/root');
});

test('10: spawn is never shell:true (no shell:true regression)', async () => {
  const capture = {};
  await runCodexCliProcess({ binary: 'codex-safe', prompt: 'p', spawnImpl: fakeSpawn({ stdout: normalCommandJsonl('ok'), capture }) });
  assert.equal(capture.options.shell, false);
});

// ---- extractCodexAssistantText regression (unaffected by classification) --

test('extractCodexAssistantText still finds the final agent_message even when an earlier command_execution failed on sandbox', () => {
  const summary = summarizeCodexCliRun({ stdout: sandboxFailureJsonl('final answer text') });
  assert.equal(extractCodexAssistantText(summary), 'final answer text');
});
