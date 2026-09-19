import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

const profile = { id: 'live1-claude-sonnet-low', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS', model: 'sonnet', reasoning: 'low' };
const project = { id: 'live1-local', repo_path: 'C:/repo' };
const decision = { type: 'finish', output: 'PASS: audit completed with 12 findings.' };

// PM24 CLAUDE EXIT REGRESSION: an earlier version of this fix auto-requested
// Claude Code's native `--json-schema` transport for every claude-code SINGLE
// PM decision, using a schema built as a top-level `oneOf` of the four
// decision variants (finish/workflow/peer_exchange/await_owner — see
// pm-decision-schema.mjs). Live reproduction against the owner's installed
// CLI (2.1.261) proved that transport is fundamentally incompatible: Claude
// Code's `--json-schema` is implemented as an Anthropic Messages API tool
// `input_schema`, and that API rejects `oneOf`/`allOf`/`anyOf` at the
// schema's top level outright — `API Error: 400 tools.N.custom.input_schema:
// input_schema does not support oneOf, allOf, or anyOf at the top level` —
// exit 1 before any real generation, ~1.2KB stdout, no `structured_output`
// key. This is the exact live evidence shape (`STDOUT_EVENT around 1186
// bytes`, `PROCESS_EXIT code=1`, `CLAUDE_EXIT_FAILED`, ~2.6s) that motivated
// this remediation. There is no schema-only fix — a union of variants with
// per-variant `required` fields cannot be flattened into one Anthropic tool
// schema without oneOf/anyOf — so a generic SINGLE PM decision is never
// auto-given a native schema; only an explicitly caller-supplied one (the
// council chair_plan step, a single flat object shape) is ever honored.
test('PM24 remediation: a generic SINGLE PM decision is never auto-given a native structured-output schema', async () => {
  let options;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (value) => { options = value; return { result: JSON.stringify(decision) }; },
  });
  const driver = registry.resolve(profile, { project, extraCtx: { taskMode: 'SINGLE' } });
  const parsed = await driver.decide({
    request: { id: 'pm24', objective: 'read-only audit' }, turn: 1, history: [], capabilities: ['finish'],
  });
  assert.deepEqual(parsed, decision);
  assert.equal(options.jsonSchema, undefined);
});

test('PM24 remediation: an explicitly caller-supplied schema (e.g. council chair_plan) is still honored unchanged', async () => {
  let options;
  const schema = { type: 'object', properties: { type: { type: 'string', enum: ['finish'] } }, required: ['type'] };
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (value) => { options = value; return { result: JSON.stringify(decision), structuredOutput: decision }; },
  });
  const driver = registry.resolve(profile, { project, extraCtx: { taskMode: 'SINGLE' } });
  const parsed = await driver.decide({
    request: { id: 'pm24', objective: 'read-only audit' }, turn: 1, history: [], capabilities: ['finish'],
    structuredOutput: { schema, kind: 'chair_plan', version: 1 },
  });
  assert.deepEqual(parsed, decision);
  assert.deepEqual(options.jsonSchema, schema);
});

// The malformed free-form fixture from durable evidence (a 10,145-byte
// brace-delimited result with a trailing unmatched brace) is not valid JSON
// and, with native structured output never auto-requested, must fail closed
// through the real parser rather than being silently bypassed.
test('a malformed free-form result with a trailing unmatched brace fails closed', async () => {
  const malformedFreeForm = `${JSON.stringify(decision)}${' '.repeat(10_145 - JSON.stringify(decision).length - 1)}}`;
  assert.equal(Buffer.byteLength(malformedFreeForm), 10_145);
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async () => ({ result: malformedFreeForm, structuredOutput: decision }),
  });
  const driver = registry.resolve(profile, { project, extraCtx: { taskMode: 'SINGLE' } });
  await assert.rejects(
    driver.decide({ request: { id: 'pm24', objective: 'read-only audit' }, turn: 1, history: [], capabilities: ['finish'] }),
    (error) => error.code === 'PM_DECISION_PARSE_FAILED' && error.parseSubreason === 'PM_DECISION_JSON_INVALID',
  );
});
