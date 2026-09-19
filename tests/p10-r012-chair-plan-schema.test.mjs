import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChairPlanJsonSchema, CHAIR_PLAN_SCHEMA_KIND, CHAIR_PLAN_SCHEMA_VERSION } from '../src/pm/council/council-chair-plan-schema.mjs';

const PARTICIPANTS = ['live1-codex-gpt-5-6-sol-pm', 'live1-antigravity-gemini-high', 'live1-opencode-pm'];

// Schema shape (buildChairPlanJsonSchema): the outer object's `data` field
// lives at `schema.properties.data`, per plain JSON Schema convention --
// `schema.data` does not exist.
function dataSchema(schema) { return schema.properties.data; }
function participantInstructionsSchema(schema) { return dataSchema(schema).properties.participant_instructions; }

test('1: the three selected participant IDs become required, exact properties', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const pi = participantInstructionsSchema(schema);
  assert.deepEqual(Object.keys(pi.properties), PARTICIPANTS);
  assert.deepEqual(pi.required, PARTICIPANTS);
});

test('2: an additional participant key is rejected (additionalProperties:false on participant_instructions)', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const pi = participantInstructionsSchema(schema);
  assert.equal(pi.additionalProperties, false);
  // Structural proof this actually rejects a `_note`-suffixed extra key:
  // additionalProperties:false + a closed `properties` map means ANY key
  // not in `properties` (e.g. a mangled or invented one) is schema-invalid
  // by definition -- this is exactly the live-proven Claude CLI enforcement
  // mechanism (Part D/F pilot), not simulated locally.
  assert.equal('live1-opencode-pm_note' in pi.properties, false);
});

test('3: a missing participant is rejected (required lists every id, none optional)', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const pi = participantInstructionsSchema(schema);
  for (const id of PARTICIPANTS) assert.ok(pi.required.includes(id), `${id} must be required`);
  assert.equal(pi.required.length, PARTICIPANTS.length);
});

test('4: a `_note`-suffixed id is never a valid key (schema is closed to exactly the owner-selected ids)', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const pi = participantInstructionsSchema(schema);
  const mangled = `${PARTICIPANTS[2]}_note`;
  assert.equal(mangled in pi.properties, false);
  assert.equal(pi.additionalProperties, false, 'closed schema rejects the mangled key structurally, not by name-matching');
});

test('5: an empty instruction value is rejected (minLength:1 on every participant_instructions value)', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const pi = participantInstructionsSchema(schema);
  for (const id of PARTICIPANTS) {
    assert.equal(pi.properties[id].type, 'string');
    assert.equal(pi.properties[id].minLength, 1);
  }
});

test('6: critique_focus is required and non-empty', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const data = dataSchema(schema);
  assert.ok(data.required.includes('critique_focus'));
  assert.equal(data.properties.critique_focus.type, 'string');
  assert.equal(data.properties.critique_focus.minLength, 1);
});

test('7: synthesis_focus is required and non-empty', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const data = dataSchema(schema);
  assert.ok(data.required.includes('synthesis_focus'));
  assert.equal(data.properties.synthesis_focus.type, 'string');
  assert.equal(data.properties.synthesis_focus.minLength, 1);
});

test('8: top-level decision type is constrained to exactly "finish"', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  assert.deepEqual(schema.properties.type.enum, ['finish']);
  assert.ok(schema.required.includes('type'));
  assert.equal(schema.additionalProperties, false);
});

test('9: data.type is constrained to exactly "council_plan"', () => {
  const schema = buildChairPlanJsonSchema(PARTICIPANTS);
  const data = dataSchema(schema);
  assert.deepEqual(data.properties.type.enum, ['council_plan']);
  assert.ok(data.required.includes('type'));
  assert.equal(data.additionalProperties, false);
});

test('the schema is dynamically derived -- a different participant set produces a structurally different schema, no caching/leakage across calls', () => {
  const a = buildChairPlanJsonSchema(['p1', 'p2']);
  const b = buildChairPlanJsonSchema(['q1', 'q2', 'q3']);
  assert.deepEqual(Object.keys(participantInstructionsSchema(a).properties), ['p1', 'p2']);
  assert.deepEqual(Object.keys(participantInstructionsSchema(b).properties), ['q1', 'q2', 'q3']);
});

test('an empty participant list still produces a well-formed (if trivial) schema, never throws', () => {
  const schema = buildChairPlanJsonSchema([]);
  const pi = participantInstructionsSchema(schema);
  assert.deepEqual(pi.required, []);
  assert.deepEqual(pi.properties, {});
});

test('schema kind/version constants are stable, bounded identifiers', () => {
  assert.equal(CHAIR_PLAN_SCHEMA_KIND, 'council_chair_plan');
  assert.equal(typeof CHAIR_PLAN_SCHEMA_VERSION, 'number');
});

// ---- 10: production code contains no hardcoded owner profile IDs ---------

// Scoped to the ONE new production file whose entire purpose is chair_plan
// schema generation (Part E's actual requirement: "the schema MUST be
// dynamically derived from the authoritative owner-selected participant
// IDs... Do not hardcode T1 profile IDs in production source"). A
// repo-wide scan also flags pre-existing R0.1/P9 doc-comments that cite a
// real id as a *documentation example* (council-prompts.mjs,
// council-step-workflow-runner.mjs, pm-profile-identity.mjs) -- those are
// unrelated history, not this wave's schema-building logic, and rewriting
// them is out of this wave's scope.
test('10: council-chair-plan-schema.mjs hardcodes no live1-* owner profile id anywhere, including comments', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pm', 'council', 'council-chair-plan-schema.mjs');
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /live1-[a-z0-9-]+/i);
});

test('10c: buildChairPlanJsonSchema takes participantProfileIds as its ONLY input -- it is a pure function of its argument, not a closure over any fixed id list', () => {
  assert.equal(buildChairPlanJsonSchema.length, 1);
});

test('10b: this test file itself (and other test/fixture files) MAY use live1-* ids -- the restriction is production source only', () => {
  const thisFile = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.match(thisFile, /live1-codex-gpt-5-6-sol-pm/, 'sanity check: the restriction really is scoped to src/, not a false-negative test');
});
