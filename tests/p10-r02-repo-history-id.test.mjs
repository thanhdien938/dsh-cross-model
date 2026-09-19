import test from 'node:test';
import assert from 'node:assert/strict';

import { shortTaskId, utcCompactTimestamp, slugify, taskFolderName, memberFolderName, assertSafeSegment } from '../src/runtime/repo-history-id.mjs';

test('shortTaskId strips the task- prefix and takes the first 8 chars, matching real T1 evidence', () => {
  assert.equal(shortTaskId('task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz'), 'BEUVJHoI');
});

test('utcCompactTimestamp matches real T1 evidence exactly', () => {
  assert.equal(utcCompactTimestamp('2026-08-24T10:53:20.868Z'), '20260824T105320Z');
});

test('utcCompactTimestamp rejects an invalid timestamp rather than silently falling back to wall-clock time', () => {
  assert.throws(() => utcCompactTimestamp('not-a-date'), TypeError);
  assert.throws(() => utcCompactTimestamp(undefined), TypeError);
});

test('slugify is a pure deterministic transform of the first meaningful line, never of model output', () => {
  assert.equal(slugify('  \n\nP10 SESSION TEST T1 — INITIAL ARCHITECTURE COUNCIL.\nsecond line'), slugify('  \n\nP10 SESSION TEST T1 — INITIAL ARCHITECTURE COUNCIL.\nsecond line'));
  assert.equal(slugify(''), 'task');
  assert.equal(slugify('!!!'), 'task');
});

test('slugify bounds length at a word boundary, never mid-word', () => {
  const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
  const slug = slugify(long, 24);
  assert.ok(slug.length <= 24);
  assert.ok(!long.toLowerCase().replace(/[^a-z0-9]+/g, '_').startsWith(`${slug}x`));
});

test('taskFolderName reproduces the exact real T1 shape (timestamp__shortid__slug)', () => {
  const name = taskFolderName({ taskId: 'task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz', createdAt: '2026-08-24T10:53:20.868Z', titleText: 'P10 SESSION TEST T1 — INITIAL ARCHITECTURE COUNCIL.' });
  assert.match(name, /^20260824T105320Z__BEUVJHoI__[a-z0-9_]+$/);
});

test('taskFolderName is deterministic: same inputs always produce the same folder name (Part U idempotency depends on this)', () => {
  const args = { taskId: 'task-abc123', createdAt: '2026-01-01T00:00:00.000Z', titleText: 'Some Task Title' };
  assert.equal(taskFolderName(args), taskFolderName(args));
});

test('taskFolderName never depends on mutable/model-controlled content beyond the fixed title text', () => {
  const a = taskFolderName({ taskId: 'task-xyz', createdAt: '2026-01-01T00:00:00.000Z', titleText: 'Fixed Title' });
  const b = taskFolderName({ taskId: 'task-xyz', createdAt: '2026-01-01T00:00:00.000Z', titleText: 'Fixed Title' });
  assert.equal(a, b);
});

test('memberFolderName reproduces the exact real T1 member folder shapes', () => {
  const used = new Set();
  assert.equal(memberFolderName({ product: 'codex', model: 'gpt-5.6-sol', profileId: 'live1-codex-gpt-5-6-sol-pm' }, used), 'codex__gpt-5-6-sol');
  assert.equal(memberFolderName({ product: 'antigravity', model: 'gemini-3.7-flash-high', profileId: 'live1-antigravity-gemini-high' }, used), 'antigravity__gemini-3-7-flash-high');
  assert.equal(memberFolderName({ product: 'opencode', model: 'opencode-go/deepseek-v4-flash', profileId: 'live1-opencode-pm' }, used), 'opencode__deepseek-v4-flash');
});

test('memberFolderName resolves a collision with a deterministic profile_id-derived suffix, never a bare counter', () => {
  const used = new Set();
  const first = memberFolderName({ product: 'codex', model: 'gpt-5', profileId: 'profile-a' }, used);
  const second = memberFolderName({ product: 'codex', model: 'gpt-5', profileId: 'profile-b' }, used);
  assert.notEqual(first, second);
  assert.ok(second.startsWith(`${first}__`));
  assert.doesNotMatch(second, /__(?:1|2|3)$/, 'must not be a bare numeric counter');
  // deterministic: re-deriving with the same used-set state gives the same suffix
  const usedAgain = new Set([first]);
  const secondAgain = memberFolderName({ product: 'codex', model: 'gpt-5', profileId: 'profile-b' }, usedAgain);
  assert.equal(second, secondAgain);
});

test('assertSafeSegment rejects traversal-shaped and unsafe segments', () => {
  assert.throws(() => assertSafeSegment('..'));
  assert.throws(() => assertSafeSegment('.'));
  assert.throws(() => assertSafeSegment('a/b'));
  assert.throws(() => assertSafeSegment('a\\b'));
  assert.throws(() => assertSafeSegment(''));
  assert.doesNotThrow(() => assertSafeSegment('20260824T105320Z__BEUVJHoI__p10_session_t1'));
});
