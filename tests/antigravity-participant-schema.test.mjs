import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { buildParticipantJsonSchema, antigravityParticipantSchemaRequest } from '../src/pm/council/participant-json-schema.mjs';
import { runAntigravityCliProcess } from '../src/session/antigravity-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { serializeDurable } from '../src/persistence/repositories/json-durable.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const profile = { id: 'synthetic-agy', product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' };
const project = { id: 'synthetic', repo_path: process.cwd() };
const path = 'synthetic.mjs', hash = 'a'.repeat(64);
const report = { type: 'council_report', analysis: 'analysis', recommendation: 'pass', risks: [], uncertainties: [], evidence: [{ path, sha256: hash, claim: 'synthetic claim' }] };
const spec = { id: 'synthetic', kind: 'council_step', stepKind: 'participant_report', round: 1, profileId: profile.id, prompt: 'x'.repeat(250000), workspaceRequirement: 'READ', workspaceEvidencePaths: [path], workspaceEvidenceHashes: { [path]: hash } };
function spawnFixture(capture, data, { code = 0, error = false } = {}) {
  return (_binary, args) => {
    const i = args.indexOf('--json-schema');
    capture.args = args; capture.path = i < 0 ? null : args[i + 1];
    capture.schema = capture.path ? JSON.parse(readFileSync(capture.path, 'utf8')) : null;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', b => { capture.stdin = (capture.stdin ?? '') + b; });
    queueMicrotask(() => {
      if (error) { child.emit('error', new Error('synthetic spawn failure')); return; }
      child.stdout.end(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify({ type: 'finish', output: 'ok', data }), ...(capture.schema ? { structured_output: { type: 'finish', output: 'ok', data } } : {}) } }));
      child.emit('close', code);
    });
    return child;
  };
}

test('schema mirrors report, critique, debate and workspace evidence contracts', () => {
  const s = buildParticipantJsonSchema('participant_report', spec);
  assert.deepEqual(s.required, ['type', 'output', 'data']);
  const d = s.properties.data;
  assert.equal(d.properties.type.const, 'council_report');
  for (const k of ['analysis', 'recommendation']) { assert.ok(d.required.includes(k)); assert.equal(d.properties[k].minLength, 1); assert.equal(d.properties[k].pattern, '\\S'); }
  const e = d.properties.evidence.items;
  assert.deepEqual(e.required, ['path', 'sha256', 'claim']);
  assert.equal(e.properties.claim.minLength, 1);
  assert.equal(e.properties.claim.maxLength, 2000);
  assert.equal(e.properties.path.maxLength, 400);
  assert.ok(new RegExp(e.properties.sha256.pattern).test('A'.repeat(64)));
  assert.ok(!new RegExp(e.properties.sha256.pattern).test('g'.repeat(64)));
  assert.deepEqual(e.properties.line_start, { type: ['integer', 'null'] });
  assert.equal(d.properties.evidence.maxItems, 20);
  assert.deepEqual(buildParticipantJsonSchema('debate_response', {}).properties.data.required, ['type', 'response']);
  assert.deepEqual(buildParticipantJsonSchema('participant_critique').properties.data.required, ['type', 'criticisms', 'agreements', 'revised_recommendation', 'remaining_disagreements']);
  for (const kind of ['participant_report', 'participant_critique', 'debate_response']) {
    assert.ok(antigravityParticipantSchemaRequest({ ...spec, stepKind: kind }, profile));
    assert.ok(Buffer.byteLength(JSON.stringify(buildParticipantJsonSchema(kind, spec))) < 4096);
  }
  for (const product of ['codex', 'api', 'claude-code']) assert.equal(antigravityParticipantSchemaRequest(spec, { product }), null);
  for (const override of [{ stepKind: 'single' }, { stepKind: 'chair_plan' }, { isImplementationParticipant: true }]) assert.equal(antigravityParticipantSchemaRequest({ ...spec, ...override }, profile), null);
});

for (const failure of [false, true]) test(`real registry/bridge/parser/validator: native schema repair failure=${failure}`, async () => {
  const captures = [];
  const registry = new ProductionPmBackendRegistry({ probe: () => true, observer: {}, antigravityBinary: 'fake-agy', antigravityRunner: args => {
    const capture = {}; captures.push(capture);
    assert.ok(args.structuredOutputSchema);
    // Schema-shaped evidence can still be semantically wrong: native output
    // is not permission to bypass frozen packet hashes.
    const data = captures.length === 1 || failure ? { ...report, evidence: [{ ...report.evidence[0], sha256: 'b'.repeat(64) }] } : report;
    return runAntigravityCliProcess({ ...args, spawnImpl: spawnFixture(capture, data) });
  } });
  const runner = new CouncilStepWorkflowRunner({ project, profileRegistry: { get: () => profile }, resolveDriver: (p, options) => registry.resolve(p, options) });
  const h = (await runner.run(spec)).finalResult.handoff;
  assert.equal(h.ok, !failure); assert.equal(captures.length, 2); assert.equal(h.semantic_repair_used, true);
  assert.equal(h.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:NO_VALID_EVIDENCE_ENTRIES');
  assert.equal(h.original_failure.evidence_diagnostics.drop_reasons.EVIDENCE_HASH_MISMATCH, 1);
  assert.ok(h.attempts.every(a => a.structured_output_requested && a.structured_output_applied && a.structured_output_provider === 'antigravity'));
  assert.equal(h.structured_output.mode, 'native_json_schema');
  assert.doesNotThrow(() => serializeDurable({ handoff: h }));
  assert.deepEqual(captures[0].schema, captures[1].schema);
  for (const c of captures) { assert.equal(existsSync(c.path), false); assert.ok(c.args.join(' ').length < 2048); assert.ok(!c.args.join(' ').includes(spec.prompt)); assert.ok(JSON.parse(c.stdin).message.content.endsWith('Every required field sits directly on "data" — never renamed, omitted, nested, stringified, or moved into "output".')); }
  if (failure) { assert.equal(h.repaired_failure.evidence_diagnostics.entries_valid, 0); assert.equal(h.data_diagnostics, h.repaired_failure.data_diagnostics); }
});

test('deterministic missing-discriminator equivalent is constrained at the bridge, then accepted', async () => {
  let calls = 0; const capture = {};
  const registry = new ProductionPmBackendRegistry({ probe: () => true, observer: {}, antigravityRunner: args => {
    calls++; assert.ok(args.structuredOutputSchema.properties.data.required.includes('type'));
    return runAntigravityCliProcess({ ...args, spawnImpl: spawnFixture(capture, args.structuredOutputSchema ? report : { unrelated_canary_keys: true }) });
  } });
  const runner = new CouncilStepWorkflowRunner({ project, profileRegistry: { get: () => profile }, resolveDriver: (p, options) => registry.resolve(p, options) });
  const h = (await runner.run(spec)).finalResult.handoff;
  assert.equal(h.ok, true); assert.equal(calls, 1); assert.equal(h.semantic_repair_used, undefined);
});

for (const error of [false, true]) test(`schema failure cleans file; no silent retry: spawnError=${error}`, async () => {
  const capture = {}; let calls = 0;
  const registry = new ProductionPmBackendRegistry({ probe: () => true, observer: {}, antigravityRunner: args => {
    calls++; return runAntigravityCliProcess({ ...args, spawnImpl: spawnFixture(capture, report, { code: 2, error }) });
  } });
  const runner = new CouncilStepWorkflowRunner({ project, profileRegistry: { get: () => profile }, resolveDriver: (p, options) => registry.resolve(p, options) });
  const h = (await runner.run(spec)).finalResult.handoff;
  assert.equal(h.ok, false); assert.equal(calls, 1); assert.equal(h.semantic_repair_used, undefined); assert.equal(existsSync(capture.path), false);
  assert.equal(h.reason, error ? 'ANTIGRAVITY_SPAWN_FAILED' : 'ANTIGRAVITY_SCHEMA_INVOCATION_FAILED');
});

test('schema size limit fails before spawn; ordinary SINGLE has no schema option', async () => {
  await assert.rejects(runAntigravityCliProcess({ prompt: 'x', structuredOutputSchema: { description: 'x'.repeat(16385) }, spawnImpl: () => assert.fail('must not spawn') }), { code: 'ANTIGRAVITY_SCHEMA_INVALID' });
  const capture = {};
  await runAntigravityCliProcess({ prompt: 'single', spawnImpl: spawnFixture(capture, report) });
  assert.equal(capture.path, null); assert.equal(capture.args.includes('--json-schema'), false);
});

for (const stepKind of ['participant_report', 'participant_critique', 'debate_response']) test(`${stepKind} decide request receives native schema`, async () => {
  let request;
  const data = stepKind === 'participant_report' ? report : stepKind === 'debate_response' ? { type: 'debate_response', response: 'response', evidence: report.evidence } : { type: 'council_critique', criticisms: [], agreements: [], revised_recommendation: 'pass', remaining_disagreements: [] };
  const runner = new CouncilStepWorkflowRunner({ project, profileRegistry: { get: () => profile }, resolveDriver: () => ({ decide: async input => { request = input; return { type: 'finish', output: 'ok', data }; } }) });
  assert.equal((await runner.run({ ...spec, stepKind })).finalResult.handoff.ok, true);
  assert.equal(request.structuredOutput.provider, 'antigravity');
  assert.equal(request.structuredOutput.kind, stepKind);
});

test('ordinary SINGLE registry request does not forward a schema', async () => {
  const capture = {};
  const registry = new ProductionPmBackendRegistry({ probe: () => true, observer: {}, antigravityRunner: args => {
    assert.equal(args.structuredOutputSchema, undefined);
    return runAntigravityCliProcess({ ...args, spawnImpl: spawnFixture(capture, report) });
  } });
  await registry.resolve(profile, { project }).decide({ turn: 0, request: { objective: 'single' }, history: [] });
  assert.equal(capture.path, null);
});

test('schema file survives stdin and Windows argv with spaces until real child close; UTF-8 has no BOM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh schema path with spaces '));
  const old = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  let schemaPath;
  try {
    process.env.TEMP = root; process.env.TMP = root; process.env.TMPDIR = root;
    const schema = buildParticipantJsonSchema('participant_report', spec);
    const result = await runAntigravityCliProcess({ binary: 'fixture.exe', prompt: 'synthetic', model: 'gemini-3.8-flash-high', structuredOutputSchema: schema, spawnImpl: (_binary, args, options) => {
      assert.equal(args.filter(a => a === '--json-schema').length, 1);
      schemaPath = args[args.indexOf('--json-schema') + 1];
      assert.ok(isAbsolute(schemaPath)); assert.ok(schemaPath.includes(' '));
      assert.equal(options.shell, false);
      assert.deepEqual(args.slice(0, 6), ['--input-format', 'stream-json', '--mode', 'plan', '--output-format', 'stream-json']);
      return spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{const b=require('node:fs').readFileSync(process.argv[1]);const schema=JSON.parse(b.toString('utf8'));process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:JSON.stringify({schema,bom:b[0]===239&&b[1]===187&&b[2]===191})}}));},30));`, schemaPath], options);
    } });
    const read = JSON.parse(result.result.response);
    assert.deepEqual(read.schema, schema); assert.equal(read.bom, false); assert.equal(existsSync(schemaPath), false);
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
});
