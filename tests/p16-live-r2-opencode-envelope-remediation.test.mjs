// P16-LIVE-004: OpenCode owner-live task terminalized `failed` with
// `INVALID_ENVELOPE: pm.decision.type must be a non-empty string` after the
// P16-LIVE-001 fix made opencode.cmd spawn successfully. Real reproduction
// (direct opencode.exe/opencode.cmd invocation, no mocks) proved the
// validator was never wrong: node's `shell:true` on win32 hands cmd.exe a
// single naive `[file, ...args].join(' ')` string with zero per-argument
// escaping, and cmd.exe's own parser is line-oriented -- it cannot carry a
// raw newline through one `/C "..."` invocation, and strips/garbles
// embedded double quotes. The DSH PM contract's rendered prompt is always
// multi-line (Task/Request context/History sections), so opencode.cmd
// never received the real task at all; it correctly reported having no
// instructions, and the model's plain-prose reply just happened to parse
// as JSON without a `type` field. See
// docs/p16-live/07_OPENCODE_PM_DECISION_REMEDIATION.md for the full
// before/after capture (including the exact live command run once through
// the real Desktop-equivalent production registry).
//
// Fix boundary: src/session/provider-child-policy.mjs
// (resolveWindowsCmdShimTarget, wired into the KNOWN_INSTALL candidate
// loop) resolves an npm-generated .cmd shim straight through to the real
// .exe it forwards to, so OpenCode execution spawns with shell:false like
// every other provider and never touches cmd.exe's parser. Combined with
// `--dir` in src/session/opencode-cli-session-bridge.mjs (OpenCode does
// not reliably resolve its own project root from the spawned process's OS
// cwd alone -- also proven by direct reproduction).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

import {
  PROVIDER_EXECUTABLE_RESOLUTION_SOURCE,
  resolveProviderExecutableSync,
  resolveWindowsCmdShimTarget,
  providerExecutableNeedsShell,
} from '../src/session/provider-child-policy.mjs';
import { runOpenCodeProcess, extractOpenCodeAssistantText } from '../src/session/opencode-cli-session-bridge.mjs';
import { runClaudeProcess } from '../src/session/claude-code-session-bridge.mjs';
import { runCodexCliProcess } from '../src/session/codex-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';

const isWin32 = process.platform === 'win32';
const rawRoot = mkdtempSync(join(tmpdir(), 'p16-live-r2-'));
const root = realpathSync.native ? realpathSync.native(rawRoot) : realpathSync(rawRoot);
test.after(() => rmSync(root, { recursive: true, force: true }));

function fakeChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  return child;
}

// --- Phase G #1: exact real captured shim shape unwraps to its real target ---

test('resolveWindowsCmdShimTarget unwraps the exact real npm-shim shape captured from the owner-live opencode.cmd', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'exact-shape');
  mkdirSync(dir, { recursive: true });
  const targetName = 'node-copy.exe';
  copyFileSync(process.execPath, join(dir, targetName));
  const shim = join(dir, 'opencode.cmd');
  // Byte-for-byte the real installed opencode.cmd shape (verified by
  // reading it directly), with only the target filename swapped.
  writeFileSync(shim, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    `"%dp0%\\${targetName}"   %*`,
    '',
  ].join('\r\n'));

  const resolved = resolveWindowsCmdShimTarget(shim, [dir]);
  assert.equal(resolved, join(dir, targetName));
});

test('resolveWindowsCmdShimTarget refuses a target outside the trusted root (never widens trust)', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const trustedDir = join(root, 'trusted-root');
  const outsideDir = join(root, 'outside-root');
  mkdirSync(trustedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  copyFileSync(process.execPath, join(outsideDir, 'escaped.exe'));
  const shim = join(trustedDir, 'escape.cmd');
  writeFileSync(shim, `"%dp0%\\..\\outside-root\\escaped.exe"   %*\r\n`);
  assert.equal(resolveWindowsCmdShimTarget(shim, [trustedDir]), null);
});

test('resolveWindowsCmdShimTarget refuses an ambiguous shim with more than one forwarding line', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'ambiguous');
  mkdirSync(dir, { recursive: true });
  copyFileSync(process.execPath, join(dir, 'a.exe'));
  copyFileSync(process.execPath, join(dir, 'b.exe'));
  const shim = join(dir, 'branch.cmd');
  writeFileSync(shim, [
    '@IF EXIST "%dp0%\\a.exe" (',
    '  "%dp0%\\a.exe"   %*',
    ') ELSE (',
    '  "%dp0%\\b.exe"   %*',
    ')',
    '',
  ].join('\r\n'));
  assert.equal(resolveWindowsCmdShimTarget(shim, [dir]), null);
});

test('resolveWindowsCmdShimTarget refuses a target that is not a real .exe', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'not-exe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'script.js'), 'console.log("hi")');
  const shim = join(dir, 'wrapper.cmd');
  writeFileSync(shim, `"%dp0%\\script.js"   %*\r\n`);
  assert.equal(resolveWindowsCmdShimTarget(shim, [dir]), null);
});

test('resolveWindowsCmdShimTarget is a no-op for a non-.cmd/.bat path (Claude/Codex/Grok resolution unaffected)', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  assert.equal(resolveWindowsCmdShimTarget(process.execPath, [dirname(process.execPath)]), null);
});

test('resolveWindowsCmdShimTarget refuses when the referenced target file does not exist', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'missing-target');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'dangling.cmd');
  writeFileSync(shim, `"%dp0%\\ghost.exe"   %*\r\n`);
  assert.equal(resolveWindowsCmdShimTarget(shim, [dir]), null);
});

// --- end-to-end resolution: the shared boundary prefers the unwrapped target ---

test('resolveProviderExecutableSync prefers the unwrapped real .exe over the .cmd shim, and it needs no shell', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'resolve-prefers-exe');
  mkdirSync(dir, { recursive: true });
  copyFileSync(process.execPath, join(dir, 'opencode-real.exe'));
  const shim = join(dir, 'opencode.cmd');
  writeFileSync(shim, `"%dp0%\\opencode-real.exe"   %*\r\n`);

  const resolution = resolveProviderExecutableSync({
    provider: 'opencode',
    executableName: 'opencode',
    knownCandidates: [shim],
  });
  assert.equal(resolution.available, true);
  assert.equal(resolution.path, join(dir, 'opencode-real.exe'));
  assert.equal(resolution.source, PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.KNOWN_INSTALL);
  assert.equal(providerExecutableNeedsShell(resolution.path), false);
});

test('resolveProviderExecutableSync still falls back to the .cmd shim (shell:true path stays intact) when it cannot be unwrapped', (t) => {
  if (!isWin32) { t.skip('Windows .cmd shim mechanism'); return; }
  const dir = join(root, 'resolve-fallback');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'weird.cmd');
  writeFileSync(shim, '@echo off\r\necho weird 1.0.0\r\n');
  const resolution = resolveProviderExecutableSync({
    provider: 'opencode',
    executableName: 'weird',
    knownCandidates: [shim],
  });
  assert.equal(resolution.available, true);
  assert.equal(resolution.path, shim);
  assert.equal(providerExecutableNeedsShell(resolution.path), true);
});

// --- Phase G #9/#8: OpenCode's own live spawn no longer regresses; the
// shell:true/.cmd fix from P16-LIVE-001 remains intact for whatever binary
// IS actually handed to runOpenCodeProcess ---

test('live OpenCode execution still uses the Windows command-wrapper rule for an explicit .cmd binary (P16-LIVE-001 non-regression)', async () => {
  let options;
  const pending = runOpenCodeProcess({
    binary: 'C:\\trusted\\opencode.cmd',
    cwd: 'C:\\trusted\\workspace',
    prompt: 'proof',
    timeoutMs: 1000,
    spawnImpl: (_binary, _args, spawnOptions) => {
      options = spawnOptions;
      const child = fakeChild();
      setImmediate(() => child.emit('error', Object.assign(new Error('fixture stop'), { code: 'FIXTURE_STOP' })));
      return child;
    },
  });
  await assert.rejects(pending);
  assert.equal(options.shell, isWin32);
});

test('runOpenCodeProcess preserves --dir and model ordering with the message absent from argv', async () => {
  let capturedArgs;
  const pending = runOpenCodeProcess({
    binary: 'opencode',
    cwd: 'C:\\owner\\workspace',
    prompt: 'the actual task text',
    extraArgs: ['--model', 'opencode-go/deepseek-v4-flash'],
    timeoutMs: 1000,
    spawnImpl: (_binary, args) => {
      capturedArgs = args;
      const child = fakeChild();
      setImmediate(() => child.emit('error', Object.assign(new Error('fixture stop'), { code: 'FIXTURE_STOP' })));
      return child;
    },
  });
  await assert.rejects(pending);
  assert.deepEqual(capturedArgs, ['run', '--format', 'json', '--dir', 'C:\\owner\\workspace', '--model', 'opencode-go/deepseek-v4-flash']);
  assert.equal(capturedArgs.includes('the actual task text'), false);
});

// --- Phase G #1 (mechanism proof, real OS, no network): the actual
// corruption mechanism this fix avoids, demonstrated generically against a
// real always-present executable (node.exe), not guessed from one captured
// string ---

test('a multi-line, quote-heavy argument survives a real Windows spawn via shell:false but is corrupted via naive shell:true (the exact P16-LIVE-004 mechanism)', async (t) => {
  if (!isWin32) { t.skip('Windows shell argument corruption is win32-specific'); return; }
  // The DSH PM contract always renders a multi-line prompt (Task/Request
  // context/History sections) containing embedded double quotes (the JSON
  // decision-shape examples) -- this fixture reproduces that shape exactly.
  const argument = 'Task:\nRead the file and reply with exactly this JSON: {"type":"finish","output":"marker"}\nHistory: []';

  function roundTrip(shell) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument], { shell, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });
  }

  const viaShellFalse = await roundTrip(false);
  assert.equal(viaShellFalse, argument, 'shell:false must round-trip the argument byte-for-byte -- this is the path the fix now uses for OpenCode');

  const viaShellTrueNaive = await roundTrip(true);
  assert.notEqual(viaShellTrueNaive, argument, 'a naive shell:true join corrupts the same argument -- this is the exact defect mechanism the fix avoids by never invoking cmd.exe for OpenCode execution');
});

// --- Phase G #2-#5: pin the exact captured symptom and its valid counterpart ---

test('the exact captured owner-live corrupted OpenCode reply still fails typed, never as a false success (pins P16-LIVE-004\'s captured symptom)', async () => {
  // This is the literal shape a real corrupted-prompt OpenCode run produced
  // during root-cause reproduction: syntactically valid JSON with no PM
  // decision `type` at all, because the model never received the real
  // task. parseDecision() has no reason to reject this (only a "finish"
  // type with a missing/blank output is special-cased there) -- it is
  // normalizePmDecision(), one layer up (the same real boundary
  // durable-pm-runtime.mjs calls), that correctly rejects it. That
  // rejection was never the defect, and this pins it as a permanent
  // regression against the exact captured shape.
  const step_start = { type: 'step_start', part: { type: 'step-start' }, sessionID: 's' };
  const step_finish = { type: 'step_finish', part: { type: 'step-finish' }, sessionID: 's' };
  const corrupted = { events: [step_start, { type: 'text', part: { type: 'text', text: '{"status":"ok","note":"Awaiting task instructions"}' } }, step_finish] };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, openCodeBinary: 'opencode', openCodeRunner: async () => corrupted });
  const driver = registry.resolve({ id: 'pm', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/repo' } });
  const decision = await driver.decide({ turn: 0, request: { objective: 'x' }, history: [] });
  assert.deepEqual(decision, { status: 'ok', note: 'Awaiting task instructions' });
  assert.throws(
    () => normalizePmDecision(decision),
    (error) => error.code === 'INVALID_ENVELOPE' && /pm\.decision\.type must be a non-empty string/.test(error.message),
  );
});

test('a genuine, intact OpenCode finish reply (post-fix real shape) still decides correctly', async () => {
  const step_start = { type: 'step_start', part: { type: 'step-start' }, sessionID: 's' };
  const step_finish = { type: 'step_finish', part: { type: 'step-finish' }, sessionID: 's' };
  const intact = { events: [step_start, { type: 'text', part: { type: 'text', text: '{"type":"finish","output":"DSH_OPENCODE_PM_ENVELOPE_OK"}' } }, step_finish] };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, openCodeBinary: 'opencode', openCodeRunner: async () => intact });
  const driver = registry.resolve({ id: 'pm', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/repo' } });
  const decision = await driver.decide({ turn: 0, request: { objective: 'x' }, history: [] });
  assert.deepEqual(decision, { type: 'finish', output: 'DSH_OPENCODE_PM_ENVELOPE_OK' });
});

test('genuinely malformed OpenCode output (not valid JSON at all) still fails typed, distinctly from the envelope defect', async () => {
  const step_start = { type: 'step_start', part: { type: 'step-start' }, sessionID: 's' };
  const malformed = { events: [step_start, { type: 'text', part: { type: 'text', text: 'not json at all, just prose' } }] };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, openCodeBinary: 'opencode', openCodeRunner: async () => malformed });
  const driver = registry.resolve({ id: 'pm', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/repo' } });
  await assert.rejects(() => driver.decide({ turn: 0, request: { objective: 'x' }, history: [] }), (error) => error.code === 'PM_DECISION_PARSE_FAILED');
});

test('an empty decision.type still fails typed', async () => {
  const step_start = { type: 'step_start', part: { type: 'step-start' }, sessionID: 's' };
  const emptyType = { events: [step_start, { type: 'text', part: { type: 'text', text: '{"type":"","output":"x"}' } }] };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, openCodeBinary: 'opencode', openCodeRunner: async () => emptyType });
  const driver = registry.resolve({ id: 'pm', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/repo' } });
  const decision = await driver.decide({ turn: 0, request: { objective: 'x' }, history: [] });
  assert.throws(
    () => normalizePmDecision(decision),
    (error) => error.code === 'INVALID_ENVELOPE' && /pm\.decision\.type must be a non-empty string/.test(error.message),
  );
});

// --- Phase G #5: provider error is never converted to success ---

test('an OpenCode process error is never converted to a false-success decision', async () => {
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    openCodeBinary: 'opencode',
    openCodeRunner: async () => { const e = new Error('OpenCode exited 1: boom'); e.code = 'OPENCODE_RUN_FAILED'; throw e; },
  });
  const driver = registry.resolve({ id: 'pm', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/repo' } });
  await assert.rejects(() => driver.decide({ turn: 0, request: { objective: 'x' }, history: [] }), (error) => error.code === 'OPENCODE_RUN_FAILED');
});

// --- Phase G #6/#7: Claude/Codex paths unchanged ---

test('Claude and Codex bridges are untouched by this fix (different modules, never import provider-child-policy\'s new shim resolver)', async () => {
  let claudeOptions;
  await runClaudeProcess({
    binary: 'claude',
    prompt: 'x',
    timeoutMs: 1000,
    spawnImpl: (_b, _a, opts) => { claudeOptions = opts; const c = fakeChild(); setImmediate(() => c.emit('error', Object.assign(new Error('stop'), { code: 'FIXTURE_STOP' }))); return c; },
  }).catch(() => null);
  assert.ok(!claudeOptions.shell);

  let codexOptions;
  await runCodexCliProcess({
    binary: 'codex',
    prompt: 'x',
    timeoutMs: 1000,
    spawnImpl: (_b, _a, opts) => { codexOptions = opts; const c = fakeChild(); setImmediate(() => c.emit('error', Object.assign(new Error('stop'), { code: 'FIXTURE_STOP' }))); return c; },
  }).catch(() => null);
  assert.equal(codexOptions.shell, false);
});
