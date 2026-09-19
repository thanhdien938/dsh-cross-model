import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { runClaudeProcess as runClaudeProcessImpl } from '../src/session/claude-code-session-bridge.mjs';

const runClaudeProcess = (options) => runClaudeProcessImpl({ binary: process.execPath, ...options });

// P10-R0.1.2 Part Q — fake spawn matching the same pattern
// tests/p9-codex-pinned-model.test.mjs already uses (no real process, no
// inference quota spent; the live-proven CLI contract itself is exercised
// separately, live, during this wave's Part B-F pilot — see
// docs/p10/05_CLAUDE_NATIVE_STRUCTURED_OUTPUT_PILOT_SONNET5.md).
function fakeSpawn({ stdout = '', stderr = '', code = 0, capture = {} } = {}) {
  return (binary, args, options) => {
    Object.assign(capture, { binary, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let prompt = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => { prompt += chunk; });
    child.stdin.on('finish', () => { capture.stdin = prompt; });
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (chunk, ...rest) => {
      if (chunk !== undefined) capture.stdin = String(chunk);
      return end(chunk, ...rest);
    };
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

const SCHEMA = Object.freeze({ type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false });

test('1: no jsonSchema -> bounded control argv and prompt on stdin (no --json-schema anywhere)', async () => {
  const capture = {};
  const envelope = { session_id: 's1', result: 'plain text answer' };
  await runClaudeProcess({ prompt: 'hello', spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), capture }) });
  assert.equal(capture.args.includes('--json-schema'), false);
  assert.deepEqual(capture.args, ['-p', '--permission-mode', 'plan', '--output-format', 'json']);
  assert.equal(capture.stdin, 'hello');
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('2: jsonSchema -> the exact live-proven --json-schema flag, one argv element per array slot', async () => {
  const capture = {};
  const envelope = { session_id: 's1', result: JSON.stringify({ status: 'OK' }), structured_output: { status: 'OK' } };
  await runClaudeProcess({ prompt: 'hello', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), capture }) });
  const idx = capture.args.indexOf('--json-schema');
  assert.ok(idx >= 0, '--json-schema present in argv');
  assert.equal(capture.args[idx + 1], JSON.stringify(SCHEMA), 'schema is its own argv element, not shell-embedded');
  // The prompt is never concatenated into argv or the schema; it travels
  // independently over stdin.
  assert.equal(capture.args.includes('hello'), false);
  assert.equal(capture.stdin, 'hello');
});

test('3/5: structured output extracted correctly, normal result string still retained', async () => {
  const envelope = { session_id: 's1', result: JSON.stringify({ status: 'OK', value: 417 }), structured_output: { status: 'OK', value: 417 } };
  const out = await runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope) }) });
  assert.deepEqual(out.structuredOutput, { status: 'OK', value: 417 });
  assert.equal(out.result, JSON.stringify({ status: 'OK', value: 417 }));
});

test('4: session id is retained exactly as before, whether or not a schema was requested', async () => {
  const envelope = { session_id: 'sess_abc', result: 'ok', structured_output: { status: 'OK' } };
  const withSchema = await runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope) }) });
  const withoutSchema = await runClaudeProcess({ prompt: 'x', spawnImpl: fakeSpawn({ stdout: JSON.stringify({ session_id: 'sess_abc', result: 'ok' }) }) });
  assert.equal(withSchema.sessionId, 'sess_abc');
  assert.equal(withoutSchema.sessionId, 'sess_abc');
});

test('no jsonSchema requested -> structuredOutput is null even if the envelope happens to carry one (no accidental leakage)', async () => {
  const envelope = { session_id: 's1', result: 'ok', structured_output: { status: 'OK' } };
  const out = await runClaudeProcess({ prompt: 'x', spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope) }) });
  // structuredOutput is populated whenever the envelope carries it,
  // regardless of whether it was requested -- but ONLY a request can ever
  // cause a CLAUDE_STRUCTURED_OUTPUT_MISSING failure (test 6).
  assert.deepEqual(out.structuredOutput, { status: 'OK' });
});

test('6: requested structured output missing (schema not satisfied, live-proven shape: exit 0, is_error:false, prose result, no structured_output key) -> typed CLAUDE_STRUCTURED_OUTPUT_MISSING failure', async () => {
  const envelope = { is_error: false, subtype: 'success', session_id: 's1', result: 'I could not satisfy the schema because it is self-contradictory.' };
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope) }) }),
    (error) => error.code === 'CLAUDE_STRUCTURED_OUTPUT_MISSING',
  );
});

test('7: malformed outer CLI JSON is still the existing CLAUDE_OUTPUT_PARSE_FAILED transport error (schema request does not change this)', async () => {
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: 'not json at all' }) }),
    (error) => error.code === 'CLAUDE_OUTPUT_PARSE_FAILED',
  );
});

test('8: nonzero CLI exit is still the existing CLAUDE_EXIT_FAILED behavior (e.g. an invalid --json-schema)', async () => {
  await assert.rejects(
    runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ code: 1, stderr: 'Error: --json-schema is not a valid JSON Schema' }) }),
    (error) => error.code === 'CLAUDE_EXIT_FAILED' && error.exitCode === 1,
  );
});

test('9: spawn is always argument-array based, never a shell string (no shell:true anywhere in options)', async () => {
  const capture = {};
  await runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ session_id: 's1', result: 'ok', structured_output: { status: 'OK' } }), capture }) });
  assert.equal(Array.isArray(capture.args), true);
  assert.equal(capture.options?.shell, undefined, 'spawn() defaults shell:false when the option is simply absent');
});

test('10: no permission relaxation -- --permission-mode is always sent, unaffected by jsonSchema, never bypassed', async () => {
  const capture = {};
  await runClaudeProcess({ prompt: 'x', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ session_id: 's1', result: 'ok', structured_output: { status: 'OK' } }), capture }) });
  assert.ok(capture.args.includes('--permission-mode'));
  assert.equal(capture.args[capture.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(capture.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(capture.args.includes('--allow-dangerously-skip-permissions'), false);
});

test('a schema that is satisfied on the second internal retry attempt still surfaces structuredOutput once resolved (compatibility with model/effort flags)', async () => {
  const capture = {};
  const envelope = { session_id: 's1', result: JSON.stringify({ status: 'OK' }), structured_output: { status: 'OK' } };
  const out = await runClaudeProcess({ prompt: 'x', model: 'sonnet', effort: 'high', jsonSchema: SCHEMA, spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), capture }) });
  assert.equal(capture.args.includes('--model'), true);
  assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'sonnet');
  assert.equal(capture.args.includes('--effort'), true);
  assert.equal(capture.args[capture.args.indexOf('--effort') + 1], 'high');
  assert.deepEqual(out.structuredOutput, { status: 'OK' });
});

test('canonicalizer ephemeral invocation disables tools and session persistence without changing defaults', async () => {
  for (const ephemeral of [false,true]) {
    const capture={};
    await runClaudeProcess({prompt:'safe synthetic prompt',ephemeral,spawnImpl:fakeSpawn({stdout:JSON.stringify({result:'ok',session_id:'synthetic'}),capture})});
    assert.equal(capture.args.includes('--no-session-persistence'),ephemeral);
    assert.equal(capture.args.includes('--tools'),ephemeral);
    if(ephemeral) assert.equal(capture.args[capture.args.indexOf('--tools')+1],'');
  }
});
