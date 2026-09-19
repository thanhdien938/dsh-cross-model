import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParticipantJsonSchema } from '../src/pm/council/participant-json-schema.mjs';
import { validateEvidence } from '../src/pm/council/workspace-evidence-contract.mjs';

// Deliberately audited subset, not JavaScript RegExp compilation (which accepts
// the lookarounds rejected by agy's Go regexp compiler). Any new pattern needs
// a compatibility review before being admitted here.
const portablePatterns = new Set(['\\S', '^[0-9a-fA-F]{64}$']);
// Regression from the actual 1.1.27 canary model-request rejection, not a
// claim to emulate agy's complete schema compiler or Gemini's server.
function checkArrayItems(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'array') {
    assert.ok(schema.items && typeof schema.items === 'object', 'array items missing');
    assert.ok(schema.items.type, 'array item type missing');
  }
  for (const value of Object.values(schema)) checkArrayItems(value);
}
test('native model-tool precheck catches the exact missing-items failure', () => {
  assert.throws(() => checkArrayItems({ type: 'object', properties: { uncertainties: { type: 'array' } } }), /array items missing/);
});
function checkPatterns(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'pattern') assert.ok(portablePatterns.has(child), `unreviewed native regex: ${child}`);
    if (key === 'patternProperties') for (const pattern of Object.keys(child)) assert.ok(portablePatterns.has(pattern));
    checkPatterns(child);
  }
}
for (const step of ['participant_report', 'participant_critique', 'debate_response']) {
  for (const workspaceRequirement of ['NONE', 'READ']) test(`${step}/${workspaceRequirement}: every native pattern is in the Go-compatible subset`, () => {
    const schema = buildParticipantJsonSchema(step, { workspaceRequirement });
    checkPatterns(schema);
    checkArrayItems(schema);
    const evidence = schema.properties.data.properties.evidence;
    if (!evidence) return;
    const entry = evidence.items;
    assert.deepEqual(entry.required, ['path', 'sha256', 'claim']);
    assert.deepEqual(entry.properties.path, { type: 'string', minLength: 1, maxLength: 400 });
    assert.equal(entry.properties.claim.minLength, 1);
    assert.equal(entry.properties.claim.maxLength, 2000);
    const hash = new RegExp(entry.properties.sha256.pattern);
    for (const value of ['a'.repeat(64), 'F'.repeat(64)]) assert.ok(hash.test(value));
    for (const value of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) assert.ok(!hash.test(value));
  });
}
test('precheck rejects the production lookahead and other unaudited regex features', () => {
  for (const pattern of ['^(?!/)(?![A-Za-z]:)(?!.*\\.\\.)(?=.*\\S)', '(?=x)', '(?<=x)', '(?<!x)', '(x)\\1', '\\k<name>', '(?>x)', 'x++', '(?i)x']) {
    assert.throws(() => checkPatterns({ properties: { value: { pattern } } }), /unreviewed native regex/);
  }
});

const admitted = 'synthetic.mjs';
const hash = 'a'.repeat(64);
for (const [path, reason] of [['../synthetic.mjs', 'EVIDENCE_ENTRY_PATH_UNSAFE'], ['/synthetic.mjs', 'EVIDENCE_ENTRY_PATH_UNSAFE'], ['C:/synthetic.mjs', 'EVIDENCE_ENTRY_PATH_UNSAFE'], ['outside.mjs', 'EVIDENCE_ENTRY_PATH_OUTSIDE_MANIFEST']]) {
  test(`DSH still rejects ${reason}: ${path}`, () => {
    const result = validateEvidence([{ path, sha256: hash, claim: 'synthetic' }], { allowedPaths: new Set([admitted]), authoritativeHashes: { [admitted]: hash } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.drop_reasons[reason], 1);
  });
}
for (const [hashes, reason] of [[{}, 'PATH_NOT_IN_PACKET'], [{ [admitted]: 'b'.repeat(64) }, 'EVIDENCE_HASH_MISMATCH']]) test(`DSH still rejects ${reason}`, () => {
  const result = validateEvidence([{ path: admitted, sha256: hash, claim: 'synthetic' }], { allowedPaths: new Set([admitted]), authoritativeHashes: hashes });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.drop_reasons[reason], 1);
});
