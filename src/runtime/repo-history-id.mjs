/**
 * P10-R0.2 Part B/C — deterministic, filesystem-safe, collision-resistant
 * naming for the repository context materializer
 * (repo-history-materializer.mjs). Pure functions only: no filesystem, no
 * clock (every timestamp input is caller-supplied — Part U/V idempotency
 * requires the SAME task to always produce the SAME folder name), no model
 * output dependency (Part B: "no dependency on model output for folder
 * naming").
 */

import { createHash } from 'node:crypto';

const TASK_ID_PREFIX = 'task-';
const SHORT_ID_LEN = 8;
const DEFAULT_SLUG_MAX = 48;
const SUFFIX_HASH_LEN = 6;

// Part S/AK item 33: a canonical DSH `task_id` is always
// `deterministicOwnerId('task', commandId)` shaped — never raw owner text.
// Anything outside this shape (e.g. a `../../etc/passwd`-style value) is
// REJECTED outright rather than silently sanitized away — Part S: "The
// owner task text must never directly determine a raw filesystem path."
const CANONICAL_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A path/filename-unsafe or traversal-shaped segment is refused outright (Part S defense-in-depth — every name here is generated deterministically, this is a second, independent guard). */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,160}$/;

export function assertSafeSegment(segment, label = 'segment') {
  if (typeof segment !== 'string' || segment === '.' || segment === '..' || !SAFE_SEGMENT_RE.test(segment)) {
    throw new TypeError(`${label} is not a safe filesystem segment: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** Part B: "short task id derived deterministically from canonical task_id". */
export function shortTaskId(taskId) {
  if (typeof taskId !== 'string' || !CANONICAL_TASK_ID_RE.test(taskId)) {
    throw new TypeError(`taskId is not a valid canonical DSH task id: ${JSON.stringify(taskId)}`);
  }
  const stripped = taskId.startsWith(TASK_ID_PREFIX) ? taskId.slice(TASK_ID_PREFIX.length) : taskId;
  const safe = stripped.replace(/[^A-Za-z0-9]/g, '');
  if (!safe) return createHash('sha256').update(taskId).digest('hex').slice(0, SHORT_ID_LEN);
  return safe.slice(0, SHORT_ID_LEN);
}

/** Part B: UTC compact timestamp from an ISO-8601 string, e.g. `20260824T105320Z`. No fallback to wall-clock time — a missing/invalid input is the caller's problem to resolve with a real timestamp field, never `Date.now()` (that would break idempotency across retries). */
export function utcCompactTimestamp(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) throw new TypeError(`utcCompactTimestamp requires a valid ISO timestamp, got: ${JSON.stringify(isoString)}`);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Part B: bounded, sanitized slug from a title/first-meaningful-line of text. Deterministic string transform only — never touches model output beyond the plain owner-supplied task text already durably stored. */
export function slugify(text, maxLen = DEFAULT_SLUG_MAX) {
  const firstLine = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let slug = firstLine.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) return 'task';
  if (slug.length > maxLen) {
    const cut = slug.slice(0, maxLen);
    const lastBoundary = cut.lastIndexOf('_');
    slug = lastBoundary > 8 ? cut.slice(0, lastBoundary) : cut;
  }
  return slug || 'task';
}

/** Part B: `<UTC timestamp>__<short-task-id>__<slug>` — the canonical task-folder identity. */
export function taskFolderName({ taskId, createdAt, titleText }) {
  const name = `${utcCompactTimestamp(createdAt)}__${shortTaskId(taskId)}__${slugify(titleText)}`;
  return assertSafeSegment(name, 'task folder name');
}

function slugSegment(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

/** Model identifiers sometimes carry a vendor/provider path prefix (e.g. `opencode-go/deepseek-v4-flash`) — the readable folder projection uses only the last segment; the FULL model string is still recorded verbatim inside the member's own files (Part C: "folder name is never authority"). */
function modelSlug(model) {
  const raw = String(model ?? '');
  const last = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return slugSegment(last) || 'model';
}

/**
 * Part C: `<product>__<model-slug>` readable execution-identity projection
 * for a council member folder. `existingNames` is a `Set<string>` of names
 * already claimed within the same council task (mutated in place) so a
 * second colliding participant deterministically gets a profile_id-derived
 * suffix appended — never a bare counter (Part C: "deterministic suffix
 * from profile_id").
 */
export function memberFolderName({ product, model, profileId }, existingNames = new Set()) {
  const base = `${slugSegment(product) || 'product'}__${modelSlug(model)}`;
  let candidate = base;
  if (existingNames.has(candidate)) {
    const suffix = createHash('sha256').update(String(profileId ?? '')).digest('hex').slice(0, SUFFIX_HASH_LEN);
    candidate = `${base}__${suffix}`;
  }
  assertSafeSegment(candidate, 'member folder name');
  existingNames.add(candidate);
  return candidate;
}
