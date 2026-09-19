// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: Part B coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawEvidenceCaptureConfig, createRawEvidenceCaptureFactory, RAW_EVIDENCE_ENABLE_FLAG, RAW_EVIDENCE_TASK_SCOPE_FLAG } from '../src/runtime/t5-raw-evidence-capture.mjs';
import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'dsh-t5-raw-evidence-')); }

// 1. capture OFF by default.
test('1: capture OFF by default (no env var set)', () => {
  const config = rawEvidenceCaptureConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.scopedTaskId, null);
});
test('1b: explicit off values also disabled', () => {
  for (const value of ['0', 'false', 'off', '']) assert.equal(rawEvidenceCaptureConfig({ [RAW_EVIDENCE_ENABLE_FLAG]: value }).enabled, false);
});
test('1c: no runtimeRoot -> always a no-op regardless of the flag', () => {
  const factory = createRawEvidenceCaptureFactory({ runtimeRoot: null, config: { enabled: true, scopedTaskId: null } });
  const writer = factory('task-x');
  assert.equal(writer.enabled, false);
  assert.doesNotThrow(() => writer.record({ stage: 'participant_report', profile_id: 'p' }));
});

// Direct factory tests (2,3,4,5,6,9,10,11 at the module level).
test('factory: enabled writer creates one JSON artifact per generation, scoped to the task dir', () => {
  const root = tmpRoot();
  try {
    const factory = createRawEvidenceCaptureFactory({ runtimeRoot: root, config: { enabled: true, scopedTaskId: null } });
    const writer = factory('task-abc');
    assert.equal(writer.enabled, true);
    writer.record({
      stage: 'participant_report', profile_id: 'live1-antigravity-gemini-3-8-flash-high', attempt_ordinal: 0,
      extracted_visible_assistant_output: '{"type":"finish","output":"summary","data":{}}',
      structured_output_requested: true,
      parser_error_code: 'PM_DECISION_PARSE_FAILED', parser_subreason: 'PM_DECISION_AMBIGUOUS_DECISIONS',
      canonicalizer_result_status: 'MULTIPLE_DECISIONS', canonicalizer_candidates: [{ ordinal: 0, source_hash: 'a'.repeat(64) }, { ordinal: 1, source_hash: 'b'.repeat(64) }],
      decision_candidate_count: 2,
    });
    const dir = join(root, 'task-abc', 'raw-evidence');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^participant_report__live1-antigravity-gemini-3-8-flash-high__attempt-0\.json$/);
    const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(written.task_id, 'task-abc'); // 11: scoped to task
    assert.equal(written.structured_output_requested, true); // 3
    assert.match(written.extracted_visible_assistant_output, /"output":"summary"/); // 2
    assert.equal(written.parser_subreason, 'PM_DECISION_AMBIGUOUS_DECISIONS'); // 4
    assert.equal(written.canonicalizer_result_status, 'MULTIPLE_DECISIONS'); // 5
    assert.equal(written.decision_candidate_count, 2); // 6
    assert.deepEqual(written.canonicalizer_candidates.map((c) => c.source_hash), ['a'.repeat(64), 'b'.repeat(64)]); // 6
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 9/10: secret-like and hidden-reasoning fields are excluded, at any depth.
test('9+10: secret-like and hidden-reasoning keys are stripped', () => {
  const root = tmpRoot();
  try {
    const writer = createRawEvidenceCaptureFactory({ runtimeRoot: root, config: { enabled: true, scopedTaskId: null } })('task-secret');
    writer.record({
      stage: 'chair_plan', profile_id: 'p', attempt_ordinal: 0,
      api_key: 'sk-should-never-be-written',
      token: 'should-never-be-written',
      authorization: 'Bearer should-never-be-written',
      chain_of_thought: 'private reasoning should never be written',
      thinking: 'also private',
      nested: { secret: 'nested-secret-should-be-stripped', safe_field: 'kept' },
      extracted_visible_assistant_output: 'Authorization: Bearer some-token-shaped-value-1234567890abcdefghijklmno',
    });
    const dir = join(root, 'task-secret', 'raw-evidence');
    const raw = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
    for (const forbidden of ['sk-should-never-be-written', '"token"', '"authorization"', '"chain_of_thought"', '"thinking"', 'nested-secret-should-be-stripped']) {
      assert.doesNotMatch(raw, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `must not contain: ${forbidden}`);
    }
    const written = JSON.parse(raw);
    assert.equal(written.nested.safe_field, 'kept');
    assert.match(written.extracted_visible_assistant_output, /\[REDACTED\]/, 'inline bearer-token-shaped substrings inside a kept string field are still redacted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('11b: scopedTaskId narrows capture to exactly one task id', () => {
  const root = tmpRoot();
  try {
    const factory = createRawEvidenceCaptureFactory({ runtimeRoot: root, config: { enabled: true, scopedTaskId: 'task-only-this-one' } });
    const scoped = factory('task-only-this-one');
    const other = factory('task-different');
    assert.equal(scoped.enabled, true);
    assert.equal(other.enabled, false);
    other.record({ stage: 'x', profile_id: 'y' });
    assert.equal(existsSync(join(root, 'task-different')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Integration: real CouncilStepWorkflowRunner + real createCliPmDriver +
// real writer, with the actual production env flag set for the duration of
// this test only (restored in `finally`) — proves the end-to-end wiring
// (registry.mjs's rawOutputEvidence -> council-step-workflow-runner.mjs's
// #recordRawEvidence -> the writer) actually produces the required fields
// for BOTH a successful and a failed real generation (7, 8).
const project = { id: 'test', repo_path: process.cwd() };
const profile = { id: 'source', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };

async function withCaptureEnabled(fn) {
  const prior = process.env.DSH_T5_RAW_EVIDENCE_CAPTURE;
  process.env.DSH_T5_RAW_EVIDENCE_CAPTURE = '1';
  try { await fn(); } finally { if (prior === undefined) delete process.env.DSH_T5_RAW_EVIDENCE_CAPTURE; else process.env.DSH_T5_RAW_EVIDENCE_CAPTURE = prior; }
}

test('7: successful generation is captured end-to-end', async () => {
  const root = tmpRoot();
  try {
    await withCaptureEnabled(async () => {
      const rawEvidenceCapture = createRawEvidenceCaptureFactory({ runtimeRoot: root })('task-e2e-success');
      const decision = { type: 'finish', output: 'ok', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      const runner = new CouncilStepWorkflowRunner({
        project, resolveDriver: () => createCliPmDriver({ profile, project, run: async () => JSON.stringify(decision) }),
        extraCtx: () => ({ taskId: 'task-e2e-success', pmRunId: 'pmrun-1' }), rawEvidenceCapture,
      });
      const result = await runner.run({ id: 'step', kind: 'council_step', stepKind: 'participant_report', profileId: profile.id, prompt: 'test', round: 1 });
      assert.equal(result.finalResult.handoff.ok, true);
    });
    const dir = join(root, 'task-e2e-success', 'raw-evidence');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(written.attempt_ok, true);
    assert.match(written.extracted_visible_assistant_output, /"analysis":"a"/);
    assert.equal(written.output_bytes > 0, true);
    assert.equal(typeof written.output_sha256, 'string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('8: failed generation is captured end-to-end (AMBIGUOUS_DECISIONS + MULTIPLE_DECISIONS canonicalizer path)', async () => {
  const root = tmpRoot();
  try {
    await withCaptureEnabled(async () => {
      const rawEvidenceCapture = createRawEvidenceCaptureFactory({ runtimeRoot: root })('task-e2e-fail');
      const d1 = { type: 'finish', output: 's1', data: { type: 'council_report', analysis: 'a1', recommendation: 'r1', risks: [], uncertainties: [] } };
      const d2 = { type: 'finish', output: 's2', data: { type: 'council_report', analysis: 'a2', recommendation: 'r2', risks: [], uncertainties: [] } };
      const raw = `${JSON.stringify(d1)}\n${JSON.stringify(d2)}`;
      const runner = new CouncilStepWorkflowRunner({
        project,
        resolveDriver: () => createCliPmDriver({ profile, project, run: async () => raw, canonicalize: async () => JSON.stringify({ normalization_status: 'MULTIPLE_DECISIONS', canonical_candidates: [d1, d2] }) }),
        extraCtx: () => ({ taskId: 'task-e2e-fail', pmRunId: 'pmrun-2' }), rawEvidenceCapture,
      });
      const result = await runner.run({ id: 'step', kind: 'council_step', stepKind: 'participant_report', profileId: profile.id, prompt: 'test', round: 1 });
      assert.equal(result.finalResult.handoff.ok, false);
    });
    const dir = join(root, 'task-e2e-fail', 'raw-evidence');
    // PM_DECISION_PARSE_FAILED gets one automatic retry (file-level P7-R0.2
    // policy) -- the SAME raw text is returned both times by this scripted
    // `run()`, so this produces attempt-0 and attempt-1 artifacts, both
    // ending in the identical AMBIGUOUS_DECISIONS/MULTIPLE_DECISIONS shape.
    // Assert on the LAST one (the final attempt actually recorded in the
    // step's handoff), not a hardcoded count.
    const files = readdirSync(dir).sort();
    assert.equal(files.length >= 1, true);
    const written = JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8'));
    assert.equal(written.attempt_ok, false);
    assert.equal(written.parser_error_code, 'PM_DECISION_PARSE_FAILED');
    assert.equal(written.parser_subreason, 'PM_DECISION_AMBIGUOUS_DECISIONS');
    assert.equal(written.canonicalizer_result_status, 'MULTIPLE_DECISIONS');
    assert.equal(written.decision_candidate_count, 2);
    assert.equal(written.decision_distinct_substantive_candidate_count, 2);
    assert.equal(Array.isArray(written.canonicalizer_candidates), true);
    assert.equal(written.canonicalizer_candidates.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture stays OFF end-to-end when the env flag is unset, even with a real writer wired in', async () => {
  const root = tmpRoot();
  try {
    // No withCaptureEnabled() here -- process.env.DSH_T5_RAW_EVIDENCE_CAPTURE
    // is whatever the ambient test environment has it as (unset in CI).
    const priorFlag = process.env.DSH_T5_RAW_EVIDENCE_CAPTURE;
    delete process.env.DSH_T5_RAW_EVIDENCE_CAPTURE;
    try {
      const rawEvidenceCapture = createRawEvidenceCaptureFactory({ runtimeRoot: root })('task-default-off');
      assert.equal(rawEvidenceCapture.enabled, false);
      const decision = { type: 'finish', output: 'ok' };
      const runner = new CouncilStepWorkflowRunner({
        project, resolveDriver: () => createCliPmDriver({ profile, project, run: async () => JSON.stringify(decision) }),
        extraCtx: () => ({ taskId: 'task-default-off', pmRunId: 'pmrun-3' }), rawEvidenceCapture,
      });
      await runner.run({ id: 'step', kind: 'council_step', stepKind: 'participant_report', profileId: profile.id, prompt: 'test', round: 1 });
    } finally { if (priorFlag !== undefined) process.env.DSH_T5_RAW_EVIDENCE_CAPTURE = priorFlag; }
    assert.equal(existsSync(join(root, 'task-default-off')), false); // 12 (proxy): nothing written at all when disabled
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RAW_EVIDENCE_TASK_SCOPE_FLAG is read from env correctly', () => {
  const config = rawEvidenceCaptureConfig({ [RAW_EVIDENCE_ENABLE_FLAG]: '1', [RAW_EVIDENCE_TASK_SCOPE_FLAG]: 'task-only-me' });
  assert.equal(config.enabled, true);
  assert.equal(config.scopedTaskId, 'task-only-me');
});
