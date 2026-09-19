/**
 * P12-R3 — read-only discovery over the durable per-task `task.json` files
 * (under each project's `docs/history/{single,council}/<task>/` folder)
 * P12-R2's materializer already writes (repo-history-materializer.mjs).
 * No new persistence layer, no database, no schema: this is a plain
 * filesystem scan of files DSH already owns and already writes atomically.
 *
 * Two uses:
 *  - `findTaskHistoryEntry()` — the ONE lookup R3's "required context" seam
 *    needs (does a referenced prior task's durable record actually exist?).
 *  - `buildTaskIndex()` — a bounded, sorted listing for anything (a future
 *    Desktop/Telegram surface, a diagnostic script) that wants to browse a
 *    project's task history without parsing Markdown.
 *
 * Never throws on a missing/unreadable `docs/history/` tree — an absent or
 * corrupt entry is silently skipped (Part-style: discovery is best-effort,
 * never a hard dependency for anything that calls it).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODE_DIRS = Object.freeze(['single', 'council']);

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function listTaskJsonFiles(projectRoot) {
  const files = [];
  if (typeof projectRoot !== 'string' || !projectRoot) return files;
  for (const modeDir of MODE_DIRS) {
    const root = join(projectRoot, 'docs', 'history', modeDir);
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.isDirectory()) continue;
      const candidate = join(root, entry.name, 'task.json');
      if (existsSync(candidate)) files.push(candidate);
    }
  }
  return files;
}

/** Returns the parsed task.json for `taskId` under this project's durable history, or `null` if it does not (yet) exist. Never throws. */
export function findTaskHistoryEntry(projectRoot, taskId) {
  if (typeof taskId !== 'string' || !taskId) return null;
  for (const file of listTaskJsonFiles(projectRoot)) {
    const data = safeReadJson(file);
    if (data && data.task_id === taskId) return data;
  }
  return null;
}

/**
 * A bounded, most-recent-first listing of every durable task.json this
 * project has. `limit` defaults to a small, sane bound — this is a
 * discovery aid, never a mechanism for bulk-loading history into a model
 * prompt (P12-R0 §9/R3-F: no full-history auto-injection anywhere).
 */
export function buildTaskIndex(projectRoot, { limit = 200 } = {}) {
  const bounded = Math.min(1000, Math.max(1, Number.isInteger(limit) ? limit : 200));
  const entries = [];
  for (const file of listTaskJsonFiles(projectRoot)) {
    const data = safeReadJson(file);
    if (data) entries.push(data);
  }
  entries.sort((a, b) => String(b?.completed_at ?? '').localeCompare(String(a?.completed_at ?? '')));
  return entries.slice(0, bounded);
}
