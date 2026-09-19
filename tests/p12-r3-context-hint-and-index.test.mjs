import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CONTEXT_HINT_TEXT, buildContextHint, appendContextHint } from '../src/pm/task-context-hint.mjs';
import { findTaskHistoryEntry, buildTaskIndex } from '../src/runtime/task-context-index.mjs';

// P12-R3 — the context-discovery hint (static, bounded) and the durable
// task.json index/lookup (read-only filesystem scan, no DB, no schema).

test('buildContextHint returns the exact, fixed, bounded hint text', () => {
  assert.equal(buildContextHint(), CONTEXT_HINT_TEXT);
  assert.ok(CONTEXT_HINT_TEXT.length < 200, 'the hint must stay a short pointer, never a listing');
  assert.doesNotMatch(CONTEXT_HINT_TEXT, /must read|required to read/i, 'never a mandatory-read instruction (P12-R0 §9)');
});

test('appendContextHint leaves the body byte-for-byte unchanged when not requested', () => {
  assert.equal(appendContextHint('do the thing', false), 'do the thing');
  assert.equal(appendContextHint('do the thing', undefined), 'do the thing');
});

test('appendContextHint appends the hint with a clear, visually distinct separator when requested', () => {
  const result = appendContextHint('do the thing', true);
  assert.equal(result, 'do the thing\n\n---\nDurable project/task context may be available under docs/history/. Read only what is relevant to this task.');
});

function withTmpProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p12-r3-index-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function writeTaskJson(root, mode, folder, data) {
  const dir = join(root, 'docs', 'history', mode, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.json'), JSON.stringify(data));
}

test('findTaskHistoryEntry returns null for a project with no durable history at all', () => withTmpProject((root) => {
  assert.equal(findTaskHistoryEntry(root, 'task-x'), null);
}));

test('findTaskHistoryEntry finds a task across both single/ and council/ trees', () => withTmpProject((root) => {
  writeTaskJson(root, 'single', 'folder-a', { task_id: 'task-a', mode: 'SINGLE' });
  writeTaskJson(root, 'council', 'folder-b', { task_id: 'task-b', mode: 'COUNCIL' });
  assert.deepEqual(findTaskHistoryEntry(root, 'task-a'), { task_id: 'task-a', mode: 'SINGLE' });
  assert.deepEqual(findTaskHistoryEntry(root, 'task-b'), { task_id: 'task-b', mode: 'COUNCIL' });
  assert.equal(findTaskHistoryEntry(root, 'task-nonexistent'), null);
}));

test('findTaskHistoryEntry never throws on a corrupt task.json — treated as absent', () => withTmpProject((root) => {
  const dir = join(root, 'docs', 'history', 'single', 'folder-corrupt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.json'), '{not valid json');
  assert.equal(findTaskHistoryEntry(root, 'anything'), null);
}));

test('buildTaskIndex returns every durable task, most-recent-first, bounded', () => withTmpProject((root) => {
  writeTaskJson(root, 'single', 'a', { task_id: 'task-1', completed_at: '2026-01-01T00:00:00.000Z' });
  writeTaskJson(root, 'single', 'b', { task_id: 'task-2', completed_at: '2026-01-03T00:00:00.000Z' });
  writeTaskJson(root, 'council', 'c', { task_id: 'task-3', completed_at: '2026-01-02T00:00:00.000Z' });
  const index = buildTaskIndex(root);
  assert.deepEqual(index.map((e) => e.task_id), ['task-2', 'task-3', 'task-1']);
}));

test('buildTaskIndex respects a bounded limit — never dumps unbounded history (P12-R3-F)', () => withTmpProject((root) => {
  for (let i = 0; i < 150; i += 1) {
    writeTaskJson(root, 'single', `t${i}`, { task_id: `task-${i}`, completed_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` });
  }
  const index = buildTaskIndex(root, { limit: 10 });
  assert.equal(index.length, 10);
}));

test('buildTaskIndex on an empty project returns an empty array, never throws', () => withTmpProject((root) => {
  assert.deepEqual(buildTaskIndex(root), []);
}));
