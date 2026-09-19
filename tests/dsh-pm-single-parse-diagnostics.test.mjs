import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';
import { createTaskDiagnosticLogFactory, taskLogDir, forwardBackendEventToTaskLog } from '../src/runtime/task-diagnostic-log.mjs';

const profile = { id: 'live1-claude-pm', product: 'claude-code', model: 'sonnet' };
const project = { id: 'p', repo_path: 'C:/repo' };
const input = { request: { id: 'req-1', objective: 'do the thing' }, turn: 0, history: [] };

function driverFor(output, observer) {
  return createCliPmDriver({ profile, project, observer, run: async () => output });
}

test('SINGLE parse failure durably records bounded structural diagnostics for the live malformed class', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-single-parse-'));
  try {
    const factory = createTaskDiagnosticLogFactory({ runtimeRoot: root });
    const events = [];
    const taskId = 'task-live';
    const observer = createBackendExecutionObserver({ emit: (event) => {
      events.push(event);
      forwardBackendEventToTaskLog({ ...event, taskId, pmRunId: 'run-1', taskMode: 'SINGLE' }, factory);
    } });
    const malformed = '{"type":"finish","output":"ok"}}';
    await assert.rejects(driverFor(malformed, observer).decide(input), (error) => {
      assert.equal(error.code, 'PM_DECISION_PARSE_FAILED');
      assert.equal(error.diagnostics.outputByteLength, Buffer.byteLength(malformed));
      assert.equal(error.diagnostics.firstCharClass, 'OPEN_BRACE');
      assert.equal(error.diagnostics.lastCharClass, 'CLOSE_BRACE');
      assert.equal(error.parseSubreason, 'PM_DECISION_JSON_INVALID');
      return true;
    });
    const lines = readFileSync(join(taskLogDir(root, taskId), 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const parser = lines.find((event) => event.event_type === 'PARSER_RESULT');
    assert.deepEqual(parser, {
      ...parser,
      output_bytes: Buffer.byteLength(malformed), first_char: '{', last_char: '}',
      first_char_class: 'OPEN_BRACE', last_char_class: 'CLOSE_BRACE',
      full_json_candidate: false, json_fence_candidate: false,
      prefix_class: 'NONE', suffix_class: 'UNKNOWN',
      parse_subreason: 'PM_DECISION_JSON_INVALID',
    });
    assert.equal(JSON.stringify(lines).includes(malformed), false);
    assert.equal(JSON.stringify(lines).includes('do the thing'), false);
    assert.equal(events.some((event) => event.eventKind === 'PARSER'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('valid bare JSON and one fenced JSON decision remain accepted', async () => {
  const observer = createBackendExecutionObserver({ emit: () => {} });
  const bare = await driverFor('{"type":"finish","output":"ok"}', observer).decide(input);
  assert.equal(bare.output, 'ok');
  const fenced = await driverFor('```json\n{"type":"finish","output":"ok"}\n```', observer).decide(input);
  assert.equal(fenced.output, 'ok');
});

async function rejectedDiagnostics(output) {
  const observer = createBackendExecutionObserver({ emit: () => {} });
  let rejected;
  await assert.rejects(driverFor(output, observer).decide(input), (error) => {
    rejected = error;
    return error.code === 'PM_DECISION_PARSE_FAILED';
  });
  return rejected.diagnostics;
}

test('one valid decision with leading prose is deterministically extracted', async () => {
  const decision = await driverFor('Here is the answer:\n{"type":"finish","output":"ok"}').decide(input);
  assert.equal(decision.output, 'ok');
});

test('one valid decision with trailing or leading-and-trailing prose is deterministically extracted', async () => {
  assert.equal((await driverFor('{"type":"finish","output":"ok"}\nThanks').decide(input)).output, 'ok');
  assert.equal((await driverFor('Result follows:\n{"type":"finish","output":"ok"}\nThanks').decide(input)).output, 'ok');
});

test('an extra closing brace remains malformed JSON, not trailing content', async () => {
  const diagnostics = await rejectedDiagnostics('{"type":"finish","output":"ok"}}');
  assert.equal(diagnostics.suffixClass, 'UNKNOWN');
  assert.equal(diagnostics.parseSubreason, 'PM_DECISION_JSON_INVALID');
});

test('invalid fenced JSON is identified as a fence-related parse failure', async () => {
  const diagnostics = await rejectedDiagnostics('```json\n{"type":"finish",}\n```');
  assert.equal(diagnostics.prefixClass, 'FENCE');
  assert.equal(diagnostics.jsonFence, true);
  assert.equal(diagnostics.parseSubreason, 'PM_DECISION_FENCE_INVALID');
});

test('pure malformed JSON with no surrounding prose is classified as JSON invalid', async () => {
  const diagnostics = await rejectedDiagnostics('{"type":"finish","output":');
  assert.equal(diagnostics.prefixClass, 'NONE');
  assert.equal(diagnostics.suffixClass, 'UNKNOWN');
  assert.equal(diagnostics.parseSubreason, 'PM_DECISION_JSON_INVALID');
});

test('empty output has bounded empty prefix and suffix classifications', async () => {
  const diagnostics = await rejectedDiagnostics('   ');
  assert.equal(diagnostics.prefixClass, 'EMPTY');
  assert.equal(diagnostics.suffixClass, 'EMPTY');
  assert.equal(diagnostics.parseSubreason, 'PM_DECISION_EMPTY_TEXT');
});

test('valid JSON with a wrong outer shape remains rejected by the canonical normalization pipeline', async () => {
  const parsed = await driverFor('[]').decide(input);
  assert.deepEqual(parsed, []);
  assert.throws(() => normalizePmDecision(parsed));
});

test('two competing valid decision objects fail closed as ambiguous', async () => {
  await assert.rejects(
    driverFor('{"type":"finish","output":"first"}\n{"type":"finish","output":"second"}').decide(input),
    (error) => error.code === 'PM_DECISION_PARSE_FAILED' && error.parseSubreason === 'PM_DECISION_AMBIGUOUS_DECISIONS',
  );
});

test('prose with no valid decision fails closed with no-decision diagnostics', async () => {
  await assert.rejects(
    driverFor('The audit completed successfully.').decide(input),
    (error) => error.code === 'PM_DECISION_PARSE_FAILED' && error.parseSubreason === 'PM_DECISION_NO_DECISION_FOUND',
  );
});
