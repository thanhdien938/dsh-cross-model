import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';

// P10-R0.2.2 Part T — the strict await_owner contract matrix.
// normalizePmDecision() itself is UNCHANGED by this wave (Part I): these
// tests prove the pre-existing validator's exact accept/reject boundary,
// which resolveAwaitOwnerContract() (production-pm-backend-registry.mjs)
// reuses verbatim rather than reimplementing.

function base(overrides = {}) {
  return { type: 'await_owner', kind: 'QUESTION', title: 'Need input', prompt: 'Choose one', allowedResponses: ['RETRY'], ...overrides };
}

// ---- VALID allowedResponses ------------------------------------------------

test('VALID: ["RETRY"] is accepted', () => {
  const v = normalizePmDecision(base({ allowedResponses: ['RETRY'] }));
  assert.deepEqual(v.allowedResponses, ['RETRY']);
});

test('VALID: ["RETRY","CANCEL"] is accepted', () => {
  const v = normalizePmDecision(base({ allowedResponses: ['RETRY', 'CANCEL'] }));
  assert.deepEqual(v.allowedResponses, ['RETRY', 'CANCEL']);
});

test('VALID: ["APPROVE","REJECT"] is accepted', () => {
  const v = normalizePmDecision(base({ allowedResponses: ['APPROVE', 'REJECT'] }));
  assert.deepEqual(v.allowedResponses, ['APPROVE', 'REJECT']);
});

test('VALID: a single-letter token and a token with digits/underscore are both accepted', () => {
  assert.deepEqual(normalizePmDecision(base({ allowedResponses: ['A'] })).allowedResponses, ['A']);
  assert.deepEqual(normalizePmDecision(base({ allowedResponses: ['RETRY_2', 'PLAN_B'] })).allowedResponses, ['RETRY_2', 'PLAN_B']);
});

// ---- INVALID allowedResponses ----------------------------------------------

test('INVALID: [] (empty array) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: [] })), /allowedResponses is invalid/);
});

test('INVALID: ["Retry"] (mixed case) is rejected — never silently uppercased', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['Retry'] })), /allowedResponses is invalid/);
});

test('INVALID: ["retry"] (lowercase) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['retry'] })), /allowedResponses is invalid/);
});

test('INVALID: ["RETRY NOW"] (space) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['RETRY NOW'] })), /allowedResponses is invalid/);
});

test('INVALID: ["RETRY-NOW"] (hyphen) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['RETRY-NOW'] })), /allowedResponses is invalid/);
});

test('INVALID: [""] (empty string token) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: [''] })), /allowedResponses is invalid/);
});

test('INVALID: [123] (non-string token) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: [123] })), /allowedResponses is invalid/);
});

test('duplicate tokens are de-duplicated by the existing contract (not an error), matching the current normalizePmDecision Set-based dedup', () => {
  const v = normalizePmDecision(base({ allowedResponses: ['RETRY', 'RETRY'] }));
  assert.deepEqual(v.allowedResponses, ['RETRY']);
});

test('a token starting with a digit is rejected (must start with A-Z)', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['1RETRY'] })), /allowedResponses is invalid/);
});

test('a token longer than 64 chars is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ allowedResponses: ['A'.repeat(65)] })), /allowedResponses is invalid/);
});

test('a 64-char token (A + 63 more) is accepted (exact boundary)', () => {
  const token = `A${'B'.repeat(63)}`;
  assert.deepEqual(normalizePmDecision(base({ allowedResponses: [token] })).allowedResponses, [token]);
});

// ---- kind ------------------------------------------------------------------

test('kind QUESTION is accepted', () => {
  assert.equal(normalizePmDecision(base({ kind: 'QUESTION' })).kind, 'QUESTION');
});

test('kind APPROVAL is accepted', () => {
  assert.equal(normalizePmDecision(base({ kind: 'APPROVAL' })).kind, 'APPROVAL');
});

test('kind is case-normalized to uppercase before the enum check (existing behavior)', () => {
  assert.equal(normalizePmDecision(base({ kind: 'question' })).kind, 'QUESTION');
});

test('an invalid kind (e.g. CONFIRM) is rejected', () => {
  assert.throws(() => normalizePmDecision(base({ kind: 'CONFIRM' })), /kind must be QUESTION or APPROVAL/);
});

// ---- title / prompt / allowedResponses presence ----------------------------

test('missing title is rejected', () => {
  const d = base(); delete d.title;
  assert.throws(() => normalizePmDecision(d), /title must be a non-empty string/);
});

test('missing prompt is rejected', () => {
  const d = base(); delete d.prompt;
  assert.throws(() => normalizePmDecision(d), /prompt must be a non-empty string/);
});

test('missing allowedResponses (undefined -> defaults to empty set) is rejected', () => {
  const d = base(); delete d.allowedResponses;
  assert.throws(() => normalizePmDecision(d), /allowedResponses is invalid/);
});

test('whitespace-only title/prompt are rejected (non-empty means non-whitespace)', () => {
  assert.throws(() => normalizePmDecision(base({ title: '   ' })));
  assert.throws(() => normalizePmDecision(base({ prompt: '   ' })));
});

// ---- localOnly / extraneous fields ------------------------------------------

test('localOnly defaults to false and is coerced strictly to boolean', () => {
  assert.equal(normalizePmDecision(base()).localOnly, false);
  assert.equal(normalizePmDecision(base({ localOnly: true })).localOnly, true);
  assert.equal(normalizePmDecision(base({ localOnly: 'true' })).localOnly, false);
});

test('unknown/forged extra fields are discarded, never carried into the normalized decision', () => {
  const v = normalizePmDecision(base({ dsh_facts: { forged: true }, extra_field: 'x' }));
  assert.equal('dsh_facts' in v, false);
  assert.equal('extra_field' in v, false);
});
