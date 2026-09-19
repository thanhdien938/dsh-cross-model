import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runOpenCodeProcess, extractOpenCodeAssistantText } from '../src/session/opencode-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { withReapedOwnedSpawnLifecycle, awaitOwnedSpawnReaping } from '../src/runtime/backend-execution-observer.mjs';

const digest = s => createHash('sha256').update(s).digest('hex');
test('OpenCode stdin failure is typed and settles once', async () => {
  await assert.rejects(runOpenCodeProcess({ binary: 'fixture.exe', prompt: 'p', spawnImpl: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => child.stdin.emit('error', new Error('synthetic pipe failure')));
    return child;
  } }), { code: 'OPENCODE_STDIN_FAILED' });
});
for (const size of [32, 16000, 260000]) test(`OpenCode ${size}: full UTF-8 prompt through real pipe with bounded argv`, async () => {
  const prompt = `start\r\n"quoted" & $() ไทย 😀\n${'x'.repeat(size)}\nend`;
  let captured;
  const result = await runOpenCodeProcess({ binary: 'fixture.exe', prompt, sessionId: 'ses_test', extraArgs: ['--model', 'provider/model', '--variant', 'medium'], spawnImpl: (binary, args, options) => {
    captured = { binary, args, options };
    return spawn(process.execPath, ['-e', `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:JSON.stringify({chars:s.length,bytes:Buffer.byteLength(s),hash:require('node:crypto').createHash('sha256').update(s).digest('hex')})}})));`], { ...options, shell: false });
  } });
  assert.deepEqual(captured.args, ['run', '--session', 'ses_test', '--format', 'json', '--dir', process.cwd(), '--model', 'provider/model', '--variant', 'medium']);
  assert.deepEqual(captured.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(captured.args.includes(prompt), false);
  assert.deepEqual(JSON.parse(extractOpenCodeAssistantText(result)), { chars: prompt.length, bytes: Buffer.byteLength(prompt), hash: digest(prompt) });
});

test('Council initial and semantic repair use the same OpenCode stdin bridge and unchanged parser', async () => {
  const profile = { id: 'fixture', product: 'opencode', transport: 'stdio', session_kind: 'STATELESS', model: 'provider/model', reasoning: 'medium' };
  const project = { id: 'fixture', repo_path: process.cwd() };
  const captures = [];
  const registry = new ProductionPmBackendRegistry({ probe: () => true, observer: {}, openCodeBinary: 'fixture.exe', openCodeRunner: input => runOpenCodeProcess({ ...input, spawnImpl: (_binary, args) => {
    const capture = { args, stdin: '', rendered: input.prompt }; captures.push(capture);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', b => capture.stdin += b);
    child.stdin.on('finish', () => {
      const data = { type: 'council_report', analysis: captures.length === 1 ? '' : 'analysis', recommendation: 'pass', risks: [], uncertainties: [] };
      child.stdout.end(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify({ type: 'finish', output: 'ok', data }) } }));
      child.emit('close', 0);
    });
    return child;
  } }) });
  const runner = new CouncilStepWorkflowRunner({ project, profileRegistry: { get: () => profile }, resolveDriver: (p, options) => registry.resolve(p, options) });
  const prompt = 'T5 fixture\n' + 'x'.repeat(260000);
  const h = (await runner.run({ id: 'fixture', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: profile.id, prompt })).finalResult.handoff;
  assert.equal(h.ok, true); assert.equal(h.semantic_repair_used, true); assert.equal(captures.length, 2);
  assert.ok(captures[0].stdin.includes(prompt));
  for (const c of captures) { assert.equal(c.stdin, c.rendered); assert.ok(c.args.join(' ').length < 1000); assert.equal(c.args.includes(c.stdin), false); }
});

test('OpenCode timeout still reaps the owned child', async () => {
  let child, closed;
  await assert.rejects(runOpenCodeProcess({ binary: 'fixture.exe', prompt: 'p', timeoutMs: 50, spawnImpl: (_b, _a, o) => { child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { ...o, shell: false }); closed = once(child, 'close'); return child; } }), { code: 'OPENCODE_TIMEOUT' });
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('OpenCode owner cancellation still uses production owned-spawn lifecycle', async () => {
  const controller = new AbortController(); let child;
  const spawnImpl = withReapedOwnedSpawnLifecycle((_b, _a, o) => child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { ...o, shell: false }), controller.signal);
  const pending = runOpenCodeProcess({ binary: 'fixture.exe', prompt: 'p', timeoutMs: 5000, spawnImpl });
  const rejection = assert.rejects(pending);
  controller.abort(); await rejection; await awaitOwnedSpawnReaping(controller.signal);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
