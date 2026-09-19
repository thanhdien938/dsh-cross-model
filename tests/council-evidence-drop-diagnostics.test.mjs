import test from 'node:test';
import assert from 'node:assert/strict';

// DSH-COUNCIL-EVIDENCE-DROP-DIAGNOSTICS — regressions for the bounded,
// content-free per-entry drop histogram added to the WORKSPACE_READ evidence
// validation failure path (live evidence task-66YXX7_3b202TqwQap1PcVpk3-D27GHd:
// 8 object entries, ZERO valid, terminal reason NO_VALID_EVIDENCE_ENTRIES, and
// no durable record of WHY each entry was dropped). These tests pin:
// fail-closed validator semantics byte-for-byte, exact histogram increments
// per drop class, content safety (no path/hash/claim values), bounded output,
// unchanged bb9f42d data_diagnostics behavior, and full persistence through
// the runner's durable handoff + PARTICIPANT_FAILED task-log event.

import { validateEvidence, MAX_EVIDENCE_ENTRIES } from '../src/pm/council/workspace-evidence-contract.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';

const PROJECT = { id: 'live1-local', repo_path: 'C:/repo' };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PATH_A = 'src/pm/council/council-step-workflow-runner.mjs';
const PATH_B = 'README.md';
const SECRET_PATH = 'src/owner/telegram-owner-client.mjs';
const SECRET_HASH = 'c'.repeat(64);

function validEntry(path, sha256, claim = 'supports a claim') {
  return { path, sha256, line_start: 1, line_end: 2, claim };
}

// ---- 1: all-valid evidence — PASS, no drop entries -------------------------

test('all-valid evidence: validation PASSES, diagnostics count entries with an empty drop histogram', () => {
  const result = validateEvidence(
    [validEntry(PATH_A, HASH_A), validEntry(PATH_B, HASH_B)],
    { allowedPaths: new Set([PATH_A, PATH_B]), authoritativeHashes: { [PATH_A]: HASH_A, [PATH_B]: HASH_B } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.diagnostics, { entries_seen: 2, entries_valid: 2, entries_dropped: 0, drop_reasons: {}, drop_reasons_truncated: false });
});

test('MISSING_EVIDENCE (no array / empty): terminal reason unchanged, zero entries seen', () => {
  for (const evidence of [undefined, [], 'not an array']) {
    const result = validateEvidence(evidence, { authoritativeHashes: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MISSING_EVIDENCE');
    assert.deepEqual(result.diagnostics, { entries_seen: 0, entries_valid: 0, entries_dropped: 0, drop_reasons: {}, drop_reasons_truncated: false });
  }
});

// ---- 2: PATH_NOT_IN_PACKET -------------------------------------------------

test('path absent from the frozen packet: rejected with PATH_NOT_IN_PACKET histogram key', () => {
  // SECRET_PATH is admitted by the manifest but absent from the authoritative
  // hash snapshot — "not in the packet the model saw".
  const result = validateEvidence(
    [validEntry(SECRET_PATH, SECRET_HASH)],
    { allowedPaths: new Set([PATH_A, SECRET_PATH]), authoritativeHashes: { [PATH_A]: HASH_A } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  assert.deepEqual(result.diagnostics, { entries_seen: 1, entries_valid: 0, entries_dropped: 1, drop_reasons: { PATH_NOT_IN_PACKET: 1 }, drop_reasons_truncated: false });
});

// ---- 3: hash mismatch ------------------------------------------------------

test('hash mismatch against the authoritative packet: rejected with EVIDENCE_HASH_MISMATCH histogram key', () => {
  const result = validateEvidence(
    [validEntry(PATH_A, HASH_B)],
    { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [PATH_A]: HASH_A } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  assert.deepEqual(result.diagnostics.drop_reasons, { EVIDENCE_HASH_MISMATCH: 1 });
  assert.equal(result.diagnostics.entries_dropped, 1);
});

// ---- 4: invalid sha256 / entry shape --------------------------------------

test('invalid sha256 and malformed entry shapes: rejected with the EXISTING shapeError base codes (index suffix stripped)', () => {
  const result = validateEvidence(
    [
      validEntry(PATH_A, 'not-hex'), // EVIDENCE_ENTRY_INVALID_SHA256 (fails the 64-hex shape check)
      validEntry(PATH_B, HASH_B, '   '), // EVIDENCE_ENTRY_MISSING_CLAIM
      'not an object', // EVIDENCE_ENTRY_NOT_OBJECT
      validEntry(SECRET_PATH, SECRET_HASH), // shape-valid, manifest-admitted, but absent from the hash snapshot
    ],
    { allowedPaths: new Set([PATH_A, PATH_B, SECRET_PATH]), authoritativeHashes: { [PATH_A]: HASH_A, [PATH_B]: HASH_B } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  assert.deepEqual(result.diagnostics.drop_reasons, { EVIDENCE_ENTRY_INVALID_SHA256: 1, EVIDENCE_ENTRY_MISSING_CLAIM: 1, EVIDENCE_ENTRY_NOT_OBJECT: 1, PATH_NOT_IN_PACKET: 1 });
  assert.equal(result.diagnostics.entries_dropped, 4);
});

// ---- 5: outside-manifest / unsafe path ------------------------------------

test('path outside the owner-authored manifest: rejected with EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST', () => {
  const result = validateEvidence(
    [validEntry(SECRET_PATH, SECRET_HASH), validEntry('../escape.mjs', HASH_A), validEntry('/abs/path.mjs', HASH_A)],
    { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [SECRET_PATH]: SECRET_HASH } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  // ../escape.mjs and /abs/path.mjs fail the unsafe-path SHAPE check first;
  // SECRET_PATH is shape-valid but outside the manifest.
  assert.deepEqual(result.diagnostics.drop_reasons, { EVIDENCE_ENTRY_PATH_UNSAFE: 2, EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST: 1 });
});

// ---- 6: mixed valid + invalid — validator semantics unchanged -------------

test('mixed valid + invalid: valid entries preserved verbatim (sanitized), invalid entries counted, verdict unchanged', () => {
  const result = validateEvidence(
    [validEntry(PATH_A, HASH_A), validEntry(PATH_B, 'bad-hash'), validEntry(PATH_B, HASH_B)],
    { allowedPaths: new Set([PATH_A, PATH_B]), authoritativeHashes: { [PATH_A]: HASH_A, [PATH_B]: HASH_B } },
  );
  assert.equal(result.ok, true, 'one valid entry still validates the report (existing semantics)');
  assert.equal(result.reason, null);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].path, PATH_A);
  assert.equal(result.entries[0].hash_verified, 'MATCH');
  // 'bad-hash' fails the 64-hex SHAPE check before any hash comparison.
  assert.deepEqual(result.diagnostics.drop_reasons, { EVIDENCE_ENTRY_INVALID_SHA256: 1 });
  assert.deepEqual({ seen: result.diagnostics.entries_seen, valid: result.diagnostics.entries_valid, dropped: result.diagnostics.entries_dropped }, { seen: 3, valid: 2, dropped: 1 });
});

// ---- 7: all-8-invalid — exact terminal reason, counts-only diagnostics ----

test('all entries invalid (the live failure shape): NO_VALID_EVIDENCE_ENTRIES terminal reason is EXACT and diagnostics carry only counts/reason identifiers', () => {
  const evidence = Array.from({ length: 8 }, (_, i) => validEntry(`src/unknown-${i}.mjs`, 'f'.repeat(64)));
  const result = validateEvidence(evidence, { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [PATH_A]: HASH_A } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  assert.deepEqual(result.diagnostics, { entries_seen: 8, entries_valid: 0, entries_dropped: 8, drop_reasons: { EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST: 8 }, drop_reasons_truncated: false });
});

// ---- 8: content safety -----------------------------------------------------

test('content safety: diagnostics contain NO path names, hashes, claims, or entry values on failure', () => {
  const secretClaim = 'SECRET-CLAIM-CONTENT-do-not-leak-98765';
  const result = validateEvidence(
    [validEntry(SECRET_PATH, SECRET_HASH, secretClaim), validEntry('../SECRET-FILE.mjs', HASH_A)],
    { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [PATH_A]: HASH_A } },
  );
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result.diagnostics);
  assert.equal(serialized.includes(SECRET_PATH), false, 'path names never appear');
  assert.equal(serialized.includes(SECRET_HASH), false, 'hash values never appear');
  assert.equal(serialized.includes(secretClaim), false, 'claim text never appears');
  assert.equal(serialized.includes('SECRET-FILE'), false, 'unsafe-path names never appear');
  // ...and the successful path's persisted `entries` remain the only place real metadata lives.
});

// ---- 9: bounded output -----------------------------------------------------

test('bounded output: more distinct drop classes than the cap cannot create unbounded diagnostics', () => {
  const evidence = Array.from({ length: MAX_EVIDENCE_ENTRIES + 5 }, (_, i) => validEntry(`src/x-${i}.mjs`, HASH_A));
  const result = validateEvidence(evidence, { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [PATH_A]: HASH_A } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, `TOO_MANY_EVIDENCE_ENTRIES:${MAX_EVIDENCE_ENTRIES + 5}`);
  assert.equal(result.diagnostics.entries_seen, MAX_EVIDENCE_ENTRIES + 5);
  assert.deepEqual(result.diagnostics.drop_reasons, {}, 'early abort evaluates no entries individually');
  assert.equal(Object.keys(result.diagnostics).length, 5, 'fixed-shape diagnostics object');
});

test('bounded output: a pathological variety of malformed entries still yields a bounded histogram', () => {
  // 20 entries each failing a DIFFERENT shape rule variant is impossible
  // (shape codes are a fixed enum), but mixed malformed entries must stay
  // within the fixed key cap; every entry gets a code from the finite set.
  const evidence = Array.from({ length: MAX_EVIDENCE_ENTRIES }, (_, i) => (i % 2 === 0 ? validEntry(`src/x-${i}.mjs`, HASH_A) : { nonsense: i }));
  const result = validateEvidence(evidence, { allowedPaths: new Set([PATH_A]), authoritativeHashes: { [PATH_A]: HASH_A } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VALID_EVIDENCE_ENTRIES');
  const keyCount = Object.keys(result.diagnostics.drop_reasons).length;
  assert.ok(keyCount <= 24, `histogram keys bounded (got ${keyCount})`);
  assert.equal(result.diagnostics.entries_dropped, MAX_EVIDENCE_ENTRIES);
  assert.equal(result.diagnostics.entries_valid, 0);
});

// ---- 10: end-to-end through the runner — bb9f42d data_diagnostics intact ---

const READ_SPEC_BASE = {
  kind: 'council_step', stepKind: 'participant_report', round: 1,
  profileId: 'live1-antigravity-gemini-3-8-flash-high', prompt: 'x',
  workspaceRequirement: 'READ',
  workspaceEvidencePaths: [PATH_A, PATH_B],
  workspaceEvidenceHashes: { [PATH_A]: HASH_A, [PATH_B]: HASH_B },
};

function runnerFor(response, { taskLog = null } = {}) {
  return new CouncilStepWorkflowRunner({
    resolveDriver: () => ({ name: 'fake', async decide() { return response; } }),
    profileRegistry: { get: (id) => ({ id, product: 'antigravity', transport: 'stdio', session_kind: 'STATELESS' }) },
    project: PROJECT,
    ...(taskLog ? { taskLog } : {}),
  });
}

function reportData(evidence) {
  return { type: 'council_report', analysis: 'structured analysis', recommendation: 'pass', risks: [], uncertainties: [], evidence };
}

test('runner end-to-end: all-invalid evidence persists evidence_diagnostics alongside intact data_diagnostics in the durable handoff AND the PARTICIPANT_FAILED event', async () => {
  const events = [];
  const runner = runnerFor(
    { type: 'finish', output: 'one-line summary', data: reportData(Array.from({ length: 8 }, (_, i) => validEntry(`src/unknown-${i}.mjs`, 'e'.repeat(64)))) },
    { taskLog: { event: (type, fields) => events.push({ type, fields }) } },
  );
  const outcome = await runner.run({ id: 'ev-e2e-fail', ...READ_SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, false);
  assert.equal(outcome.finalResult.handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:NO_VALID_EVIDENCE_ENTRIES');
  // NEW: evidence_diagnostics persisted in the durable handoff
  assert.deepEqual(outcome.finalResult.handoff.evidence_diagnostics, { entries_seen: 8, entries_valid: 0, entries_dropped: 8, drop_reasons: { EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST: 8 }, drop_reasons_truncated: false });
  // UNCHANGED: bb9f42d data_diagnostics behavior intact
  assert.equal(outcome.finalResult.handoff.data_diagnostics.data_type, 'council_report');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.type, 'string');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.analysis.length, 'structured analysis'.length);
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.evidence.type, 'array');
  assert.equal(outcome.finalResult.handoff.data_diagnostics.fields.evidence.length, 8);
  // Same diagnostics on the PARTICIPANT_FAILED task-log event
  const failed = events.find((e) => e.type === 'PARTICIPANT_FAILED');
  assert.ok(failed, 'PARTICIPANT_FAILED emitted');
  assert.deepEqual(failed.fields.evidence_diagnostics, outcome.finalResult.handoff.evidence_diagnostics);
  assert.deepEqual(failed.fields.data_diagnostics.data_type, 'council_report');
  const serialized = JSON.stringify(outcome.finalResult.handoff);
  assert.equal(serialized.includes('src/unknown-'), false, 'no dropped entry path names persist anywhere in the failure handoff');
  assert.equal(serialized.includes('eeeeeeee'), false, 'no dropped entry hash values persist anywhere in the failure handoff');
});

test('runner end-to-end: fully valid evidence PASSES and persists no failure diagnostics in the handoff', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: reportData([validEntry(PATH_A, HASH_A), validEntry(PATH_B, HASH_B)]) });
  const outcome = await runner.run({ id: 'ev-e2e-pass', ...READ_SPEC_BASE });
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.analysis, 'structured analysis');
  assert.equal(outcome.finalResult.handoff.evidence_diagnostics, undefined, 'success handoff carries no failure diagnostics');
  assert.deepEqual(outcome.finalResult.handoff.evidence, [
    { path: PATH_A, sha256: HASH_A, line_start: 1, line_end: 2, claim: 'supports a claim', hash_verified: 'MATCH' },
    { path: PATH_B, sha256: HASH_B, line_start: 1, line_end: 2, claim: 'supports a claim', hash_verified: 'MATCH' },
  ], 'sanitized validated entries replace the raw model array, unchanged');
});

test('runner end-to-end: workspace_requirement NONE never inspects evidence (legacy behavior byte-for-byte)', async () => {
  const runner = runnerFor({ type: 'finish', output: 'one-line summary', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } });
  const outcome = await runner.run({ id: 'ev-e2e-none', ...READ_SPEC_BASE, workspaceRequirement: 'NONE', workspaceEvidencePaths: undefined, workspaceEvidenceHashes: undefined });
  assert.equal(outcome.finalResult.handoff.ok, true);
  assert.equal(outcome.finalResult.handoff.evidence_diagnostics, undefined);
});
