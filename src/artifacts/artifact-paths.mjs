/**
 * P20.1A — Artifact Workspace Foundation: deterministic identity, naming and
 * path helpers for the P20 `artifact_v1` artifact store.
 *
 * Authority: docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md
 * (PM_FROZEN, §5/§6/§7/§8/§9/§10/§18) and
 * docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §10.
 *
 * Pure functions only: no filesystem, no `Date.now()`/wall-clock, no model
 * output dependency. Every timestamp is a caller-supplied ISO string so the
 * SAME task/invocation always maps to the SAME folder name (freeze §5
 * "deterministic", §22 no-overwrite invariant). This module never generates
 * an actual model report — it only computes where one would live.
 *
 * Shares the spirit of src/runtime/repo-history-id.mjs (deterministic,
 * traversal-safe, collision-checked naming) but is a SEPARATE module: the
 * P20 folder shape (`<ts>__<slug>__<short-id>`, `YYYYMMDD_HHMMSS` UTC) and
 * the legacy repo-history shape (`<ts>__<short-id>__<slug>`, `...T...Z`)
 * are intentionally different and must not be conflated.
 */

import { createHash } from 'node:crypto';

export const ARTIFACT_SCHEMA_VERSION = 1;

export const TRANSPORT_VERSION = Object.freeze({
  LEGACY: 'legacy',
  ARTIFACT_V1: 'artifact_v1',
});

// A canonical DSH task id is `deterministicOwnerId('task', ...)` shaped:
// `task-<base64url>` (src/owner/owner-contracts.mjs). The generic config ID
// shape (src/runtime/p5-production-config.mjs) additionally allows `:` — we
// accept that for the FULL id in metadata but never let `:` reach a path
// segment (see PROJECT_ID_SEGMENT_RE / assertSafeSegment).
const CANONICAL_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// A project id is used verbatim as a directory name
// (`.runtime/dsh-artifacts/<project_id>/`). The generic config ID regex
// allows `:` and `.` — for a path segment we fail closed on `:` (drive /
// alternate-data-stream syntax on Windows).
const PROJECT_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Every generated path segment must match this AND survive assertSafeSegment
// (which additionally rejects `.`/`..`/pure-dot names, trailing dot, and
// Windows reserved device names). Bounded length: freeze §10 forbids
// "unbounded component length".
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/;
export const MAX_PATH_SEGMENT_LENGTH = 120;

// ---- P20.1R R6: composite filename budget --------------------------------
// The canonical report/executive-log filename is
//   `<YYYYMMDD_HHMMSS>__<actor-alias>__<stage>__report.md`  (or `__executive.log`)
// and that WHOLE filename must survive assertSafeSegment (<= MAX_PATH_SEGMENT_LENGTH).
// So the actor alias the allocator emits must be bounded such that even the
// LONGEST stage + LONGEST suffix still fits. Derived, never a magic number.
const FILENAME_TIMESTAMP_LENGTH = 'YYYYMMDD_HHMMSS'.length;           // 15
const FILENAME_JOINERS = '__'.length * 3;                             // 6  (ts__alias__stage__suffix)
const FILENAME_SUFFIX_LENGTH = Math.max('report.md'.length, 'executive.log'.length); // 13
export const FILENAME_FIXED_OVERHEAD = FILENAME_TIMESTAMP_LENGTH + FILENAME_JOINERS + FILENAME_SUFFIX_LENGTH; // 34

// Windows reserved device names (case-insensitive), with or without an
// extension — `NUL`, `NUL.txt`, `com1`, `lpt9` … all refused.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const DEFAULT_SLUG_MAX = 48;
const SHORT_ID_LEN = 8;
const SUFFIX_HASH_LEN = 6;

export class ArtifactPathError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactPathError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Second, independent guard on every path segment the store ever creates.
 * Every value passed here is already generated deterministically by this
 * module — this exists to make an accidental future regression fail loudly
 * rather than write outside the intended tree (freeze §10, integrity gate
 * §10 "reject absolute/model/user supplied path segments").
 */
export function assertSafeSegment(segment, label = 'path segment') {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new ArtifactPathError(`${label} must be a non-empty string`, 'ARTIFACT_PATH_SEGMENT_EMPTY', { label });
  }
  if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
    throw new ArtifactPathError(`${label} exceeds ${MAX_PATH_SEGMENT_LENGTH} chars: ${JSON.stringify(segment)}`, 'ARTIFACT_PATH_SEGMENT_TOO_LONG', { label });
  }
  if (segment === '.' || segment === '..' || /^\.+$/.test(segment)) {
    throw new ArtifactPathError(`${label} is a dot segment: ${JSON.stringify(segment)}`, 'ARTIFACT_PATH_SEGMENT_DOT', { label });
  }
  if (!SAFE_SEGMENT_RE.test(segment)) {
    throw new ArtifactPathError(`${label} contains an unsafe character: ${JSON.stringify(segment)}`, 'ARTIFACT_PATH_SEGMENT_UNSAFE', { label });
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw new ArtifactPathError(`${label} has a trailing dot/space: ${JSON.stringify(segment)}`, 'ARTIFACT_PATH_SEGMENT_TRAILING', { label });
  }
  if (WINDOWS_RESERVED_RE.test(segment)) {
    throw new ArtifactPathError(`${label} is a Windows reserved device name: ${JSON.stringify(segment)}`, 'ARTIFACT_PATH_SEGMENT_RESERVED', { label });
  }
  return segment;
}

/** True when `segment` would be accepted by assertSafeSegment (no throw). */
export function isSafeSegment(segment) {
  try { assertSafeSegment(segment); return true; } catch { return false; }
}

/** Validate a project id that is about to be used as a directory name. */
export function assertProjectIdSegment(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_SEGMENT_RE.test(projectId)) {
    throw new ArtifactPathError(
      `project id is not usable as a filesystem segment (letters/digits/._- only): ${JSON.stringify(projectId)}`,
      'ARTIFACT_PROJECT_ID_UNSAFE',
      { projectId },
    );
  }
  return assertSafeSegment(projectId, 'project id');
}

/** Lowercase hex sha256 of a string or Buffer. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * UTC compact timestamp `YYYYMMDD_HHMMSS` from an ISO-8601 string
 * (freeze §5/§8: the human-readable filename timestamp is UTC; the full
 * ISO timestamp is retained separately in metadata). No wall-clock
 * fallback — an invalid input is the caller's bug, never silently
 * `Date.now()` (that would break idempotency across retries).
 */
export function utcCompactTimestamp(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    throw new ArtifactPathError(`utcCompactTimestamp requires a valid ISO timestamp, got: ${JSON.stringify(isoString)}`, 'ARTIFACT_TIMESTAMP_INVALID', { isoString });
  }
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Bounded, filesystem-safe task slug (freeze §5: create-time metadata,
 * hyphen-joined lowercase, MUST NOT be renamed from a later model title).
 * Deterministic string transform of already-durable owner task text.
 */
export function taskSlug(text, maxLen = DEFAULT_SLUG_MAX) {
  const firstLine = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let slug = firstLine.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (!slug) return 'task';
  if (slug.length > maxLen) {
    const cut = slug.slice(0, maxLen);
    const lastBoundary = cut.lastIndexOf('-');
    slug = (lastBoundary > 8 ? cut.slice(0, lastBoundary) : cut).replace(/-+$/g, '');
  }
  return slug || 'task';
}

/**
 * `task-XXXXXXXX` — a short, human-facing task identity derived
 * deterministically from the canonical full task id (freeze §5 example
 * `…__task-LBGXGEhV`). The FULL task id always stays in
 * `task-manifest.json`; this short form is folder decoration only and is
 * never authority (freeze §5, §10 "Collision checks MUST use full
 * immutable identity, not only short IDs or timestamps").
 */
export function shortTaskId(taskId) {
  if (typeof taskId !== 'string' || !CANONICAL_TASK_ID_RE.test(taskId)) {
    throw new ArtifactPathError(`taskId is not a valid canonical DSH task id: ${JSON.stringify(taskId)}`, 'ARTIFACT_TASK_ID_INVALID', { taskId });
  }
  const stripped = taskId.startsWith('task-') ? taskId.slice(5) : taskId;
  const alnum = stripped.replace(/[^A-Za-z0-9]/g, '');
  const body = alnum ? alnum.slice(0, SHORT_ID_LEN) : sha256Hex(taskId).slice(0, SHORT_ID_LEN);
  return `task-${body}`;
}

/**
 * Canonical immutable task folder name (freeze §5):
 *   `YYYYMMDD_HHMMSS__<task-slug>__<short-task-id>`
 * `createdAt` is the UTC task creation time as ISO-8601.
 */
export function taskFolderName({ taskId, createdAt, taskSlug: slugText }) {
  const ts = utcCompactTimestamp(createdAt);
  const slug = taskSlug(slugText);
  const short = shortTaskId(taskId);
  assertSafeSegment(ts, 'task timestamp');
  assertSafeSegment(slug, 'task slug');
  assertSafeSegment(short, 'short task id');
  const name = `${ts}__${slug}__${short}`;
  return assertSafeSegment(name, 'task folder name');
}

/**
 * Filesystem-safe bounded representation of an app-owned `invocation_id`
 * (freeze §7: "MUST be derived from application-owned invocation_id, using
 * a filesystem-safe bounded representation with collision detection against
 * the full ID"). The full id is always persisted in `invocation.json`; the
 * store compares the full id, never this key, for identity.
 */
export function invocationKey(invocationId) {
  if (typeof invocationId !== 'string' || invocationId.length === 0) {
    throw new ArtifactPathError('invocationId must be a non-empty string', 'ARTIFACT_INVOCATION_ID_EMPTY');
  }
  if (isSafeSegment(invocationId) && !WINDOWS_RESERVED_RE.test(invocationId)) {
    return invocationId;
  }
  return `inv-${sha256Hex(invocationId).slice(0, 16)}`;
}

const ATTEMPT_DIR_RE = /^attempt-(\d+)$/;

/** `attempt-00`, `attempt-01`, … `attempt-100` (freeze §7 monotonic ordinal). */
export function attemptDirName(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new ArtifactPathError(`attempt ordinal must be a non-negative integer, got: ${JSON.stringify(ordinal)}`, 'ARTIFACT_ATTEMPT_ORDINAL_INVALID', { ordinal });
  }
  return `attempt-${String(ordinal).padStart(2, '0')}`;
}

/** Parse an `attempt-NN` directory name back to its integer ordinal, or null. */
export function parseAttemptDirName(name) {
  const m = ATTEMPT_DIR_RE.exec(String(name ?? ''));
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Report / executive-log filenames for one attempt (freeze §8). Both share
 * the invocation-start UTC timestamp prefix.
 */
export function reportFileName({ startedAt, actorAlias, stage }) {
  const ts = utcCompactTimestamp(startedAt);
  assertActorAlias(actorAlias);
  if (!STAGE_VALUES.has(stage)) throw new ArtifactPathError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'ARTIFACT_STAGE_UNKNOWN', { stage });
  return assertSafeSegment(`${ts}__${actorAlias}__${stage}__report.md`, 'report filename');
}

export function executiveLogFileName({ startedAt, actorAlias, stage }) {
  const ts = utcCompactTimestamp(startedAt);
  assertActorAlias(actorAlias);
  if (!STAGE_VALUES.has(stage)) throw new ArtifactPathError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'ARTIFACT_STAGE_UNKNOWN', { stage });
  return assertSafeSegment(`${ts}__${actorAlias}__${stage}__executive.log`, 'executive log filename');
}

// ---- Canonical stage hierarchy (freeze §6) --------------------------------

export const ARTIFACT_ROLE = Object.freeze({ SINGLE: 'single', CHAIR: 'chair', MEMBER: 'member' });

export const ARTIFACT_STAGE = Object.freeze({
  SINGLE: 'single',
  CHAIR_PLAN: 'chair-plan',
  CHAIR_COUNCIL_SYNTHESIS: 'chair-council-synthesis',
  PARTICIPANT_REPORT: 'participant-report',
  PARTICIPANT_CRITIQUE: 'participant-critique',
  DEBATE_CHAIR_BRIEF: 'debate-chair-brief',
  DEBATE_CHAIR_SYNTHESIS: 'debate-chair-synthesis',
  DEBATE_MEMBER_RESPONSE: 'debate-member-response',
});

const STAGE_VALUES = new Set(Object.values(ARTIFACT_STAGE));

// ---- P20.1R R3: the single frozen role/stage matrix ---------------------
// ONE table. Path generation, InvocationRecord validation, and
// ArtifactMetadata validation all consult this — never divergent local
// logic. `role` is the exact required role for the stage; `alias` marks a
// stage whose directory is under `<actor-alias>/`; `debate` marks a stage
// that REQUIRES a round and whose siblings (non-debate) MUST NOT carry one.
export const ROLE_STAGE_MATRIX = Object.freeze({
  [ARTIFACT_STAGE.SINGLE]:                  Object.freeze({ role: ARTIFACT_ROLE.SINGLE,  alias: true,  debate: false }),
  [ARTIFACT_STAGE.CHAIR_PLAN]:              Object.freeze({ role: ARTIFACT_ROLE.CHAIR,   alias: false, debate: false }),
  [ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS]: Object.freeze({ role: ARTIFACT_ROLE.CHAIR,   alias: false, debate: false }),
  [ARTIFACT_STAGE.PARTICIPANT_REPORT]:      Object.freeze({ role: ARTIFACT_ROLE.MEMBER,  alias: true,  debate: false }),
  [ARTIFACT_STAGE.PARTICIPANT_CRITIQUE]:    Object.freeze({ role: ARTIFACT_ROLE.MEMBER,  alias: true,  debate: false }),
  [ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF]:      Object.freeze({ role: ARTIFACT_ROLE.CHAIR,   alias: false, debate: true }),
  [ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS]:  Object.freeze({ role: ARTIFACT_ROLE.CHAIR,   alias: false, debate: true }),
  [ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE]:  Object.freeze({ role: ARTIFACT_ROLE.MEMBER,  alias: true,  debate: true }),
});

/** The one role a stage is allowed to run under, or throw for an unknown stage. */
export function expectedRoleForStage(stage) {
  const row = ROLE_STAGE_MATRIX[stage];
  if (!row) throw new ArtifactPathError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'ARTIFACT_STAGE_UNKNOWN', { stage });
  return row.role;
}

/** True when `stage` is a Debate stage (round required). */
export function stageRequiresRound(stage) {
  const row = ROLE_STAGE_MATRIX[stage];
  if (!row) throw new ArtifactPathError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'ARTIFACT_STAGE_UNKNOWN', { stage });
  return row.debate;
}

/**
 * Enforce the frozen role/stage(/round) matrix (R3). Throws
 * `ARTIFACT_ROLE_STAGE_MISMATCH` for a wrong role, `ARTIFACT_STAGE_NEEDS_ROUND`
 * for a Debate stage with no round, `ARTIFACT_STAGE_UNEXPECTED_ROUND` for a
 * non-Debate stage that was handed a round. Round range is validated too.
 *
 * @returns {{ role: string, stage: string, round: number|null, requiresAlias: boolean }}
 */
export function assertRoleStage({ role, stage, round = null }) {
  const row = ROLE_STAGE_MATRIX[stage];
  if (!row) throw new ArtifactPathError(`unknown artifact stage: ${JSON.stringify(stage)}`, 'ARTIFACT_STAGE_UNKNOWN', { stage });
  if (role !== row.role) {
    throw new ArtifactPathError(
      `stage ${JSON.stringify(stage)} requires role ${JSON.stringify(row.role)}, got ${JSON.stringify(role)}`,
      'ARTIFACT_ROLE_STAGE_MISMATCH',
      { role, stage, expectedRole: row.role },
    );
  }
  const r = assertRound(round);
  if (row.debate && r === null) {
    throw new ArtifactPathError(`Debate stage ${JSON.stringify(stage)} requires a round`, 'ARTIFACT_STAGE_NEEDS_ROUND', { stage });
  }
  if (!row.debate && r !== null) {
    throw new ArtifactPathError(`non-Debate stage ${JSON.stringify(stage)} must not carry a round (got ${r})`, 'ARTIFACT_STAGE_UNEXPECTED_ROUND', { stage, round: r });
  }
  return { role, stage, round: r, requiresAlias: row.alias };
}

// R6: longest canonical stage, and the resulting actor-alias budget so
// every alias the allocator emits fits the longest report/log filename.
export const MAX_STAGE_LENGTH = Math.max(...Object.values(ARTIFACT_STAGE).map((s) => s.length)); // 23 (chair-council-synthesis)
export const MAX_ACTOR_ALIAS_LENGTH = MAX_PATH_SEGMENT_LENGTH - FILENAME_FIXED_OVERHEAD - MAX_STAGE_LENGTH; // 120-34-23 = 63

/** Validate an actor alias: a safe segment AND within the composite-filename budget (R6). */
export function assertActorAlias(alias, label = 'actor alias') {
  assertSafeSegment(alias, label);
  if (alias.length > MAX_ACTOR_ALIAS_LENGTH) {
    throw new ArtifactPathError(
      `${label} exceeds the composite-filename budget of ${MAX_ACTOR_ALIAS_LENGTH} chars: ${JSON.stringify(alias)}`,
      'ARTIFACT_ACTOR_ALIAS_TOO_LONG',
      { label, max: MAX_ACTOR_ALIAS_LENGTH },
    );
  }
  return alias;
}

function assertRound(round) {
  if (round === null || round === undefined) return null;
  if (!Number.isInteger(round) || round < 1 || round > 99) {
    throw new ArtifactPathError(`debate round must be an integer 1..99, got: ${JSON.stringify(round)}`, 'ARTIFACT_ROUND_INVALID', { round });
  }
  return round;
}

/** `round-01` … `round-99`. */
export function debateRoundDirName(round) {
  const r = assertRound(round);
  if (r === null) throw new ArtifactPathError('debateRoundDirName requires a round', 'ARTIFACT_ROUND_REQUIRED');
  return `round-${String(r).padStart(2, '0')}`;
}

/**
 * Store-relative POSIX path (always `/`-joined — freeze §18: metadata
 * stores the canonical store-relative path with `/` separators) of the
 * stage directory that holds a stage's invocation directories, relative to
 * the task root.
 *
 * Returns an array of already-safe segments so the caller (artifact-store)
 * can `join()` them onto a trusted absolute root with native `path`.
 */
export function stageDirSegments({ role, stage, actorAlias = null, round = null }) {
  // R3: one matrix check up front — role, stage, round consistency.
  const { round: r, requiresAlias } = assertRoleStage({ role, stage, round });
  const alias = actorAlias === null ? null : assertActorAlias(actorAlias);
  if (requiresAlias && !alias) {
    throw new ArtifactPathError(`stage ${JSON.stringify(stage)} requires an actorAlias`, 'ARTIFACT_STAGE_NEEDS_ALIAS', { stage });
  }

  switch (stage) {
    case ARTIFACT_STAGE.SINGLE:
      return ['single', alias];
    case ARTIFACT_STAGE.CHAIR_PLAN:
      return ['chair', 'plan'];
    case ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS:
      return ['chair', 'council-synthesis'];
    case ARTIFACT_STAGE.PARTICIPANT_REPORT:
      return ['members', alias, 'participant-report'];
    case ARTIFACT_STAGE.PARTICIPANT_CRITIQUE:
      return ['members', alias, 'participant-critique'];
    case ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF:
      return ['debate', debateRoundDirName(r), 'chair', 'brief'];
    case ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS:
      return ['debate', debateRoundDirName(r), 'chair', 'synthesis'];
    case ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE:
      return ['debate', debateRoundDirName(r), 'members', alias, 'response'];
    default:
      /* c8 ignore next */
      throw new ArtifactPathError(`unhandled stage: ${stage}`, 'ARTIFACT_STAGE_UNHANDLED', { stage });
  }
}

/** Join already-safe segments into a store-relative POSIX path string. */
export function toStoreRelativePosix(segments) {
  const list = Array.isArray(segments) ? segments : [segments];
  for (const s of list) assertSafeSegment(s, 'store-relative segment');
  return list.join('/');
}

// ---- Actor alias (freeze §9 / §16) --------------------------------------

/**
 * Deterministic default alias derivation from a full profile id. Pure
 * string transform (freeze §9: "lowercase filesystem-safe form", "never
 * invented by the LLM"):
 *   - lowercase, NFKD;
 *   - strip a leading roster/env prefix `liveN-`;
 *   - collapse an immediately-repeated leading token
 *     (`opencode-opencode-go-…` -> `opencode-…`);
 *   - map every run of non `[a-z0-9]` to a single `-`, trim/collapse `-`.
 *
 * A registry MAY override any profile's alias with an explicit preferred
 * value (freeze §9 "derived from profile registry/configuration",
 * "Preferred existing examples remain valid") — see
 * buildActorAliasRegistry().
 */
/**
 * Deterministically shorten `base` to fit `MAX_ACTOR_ALIAS_LENGTH` while
 * keeping distinct sources distinct: keep a prefix and append a stable
 * `-<hash6>` derived from the FULL profile id (R6 — "same result every
 * run", never a plain truncation that could collide).
 */
function boundAlias(base, profileId) {
  if (base.length <= MAX_ACTOR_ALIAS_LENGTH) return base;
  const keep = MAX_ACTOR_ALIAS_LENGTH - (SUFFIX_HASH_LEN + 1); // room for `-<hash6>`
  const prefix = base.slice(0, Math.max(1, keep)).replace(/-+$/g, '');
  return `${prefix}-${sha256Hex(profileId).slice(0, SUFFIX_HASH_LEN)}`;
}

export function deriveActorAlias(profileId) {
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    throw new ArtifactPathError('profileId must be a non-empty string', 'ARTIFACT_PROFILE_ID_EMPTY');
  }
  let base = profileId.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  base = base.replace(/^live[0-9]+-/, '');
  const parts = base.split('-');
  if (parts.length >= 2 && parts[0] === parts[1]) parts.splice(1, 1);
  base = parts.join('-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (!base) base = `profile-${sha256Hex(profileId).slice(0, SUFFIX_HASH_LEN)}`;
  // R6: bound to the composite-filename budget, not the generic segment max.
  base = boundAlias(base, profileId);
  // A derived alias must still be a legal segment; if a pathological input
  // produced e.g. a reserved name, disambiguate deterministically.
  if (!isSafeSegment(base)) base = `profile-${sha256Hex(profileId).slice(0, SUFFIX_HASH_LEN)}`;
  return assertActorAlias(base, 'derived actor alias');
}

/**
 * The five "preferred" alias mappings named verbatim in freeze §9. They are
 * NOT hardcoded into deriveActorAlias() — the freeze locates them in
 * "profile registry/configuration" — but are exported here so a caller can
 * pass them straight through as `overrides` to buildActorAliasRegistry()
 * until config wiring lands in a later phase.
 */
export const PREFERRED_ACTOR_ALIASES = Object.freeze({
  'live1-claude-sonnet-low': 'claude-sonnet-low',
  'live1-codex-gpt-5-6-luna-low': 'codex-luna-low',
  'live1-opencode-opencode-go-glm-5-3-flash': 'opencode-glm-5-3-flash',
  'live1-opencode-opencode-go-deepseek-v4-flash': 'opencode-deepseek-v4-flash',
  'live1-antigravity-gemini-3-8-flash-high': 'antigravity-gemini-3-8-flash-high',
});

/**
 * Build a frozen, deterministic, enumeration-order-independent
 * profileId -> alias registry (freeze §9 "uniqueness is checked globally
 * within the active profile registry; collision resolution is
 * deterministic and independent of enumeration order"; §16 "Do not make
 * alias uniqueness depend on roster enumeration order").
 *
 * Inputs are sorted before assignment so the same set of profile ids
 * always yields the same map regardless of the array order passed in. On a
 * collision (two full ids -> same preferred alias) the LATER-sorting id
 * gets a stable `-<hash6>` suffix derived from its own full id; if that is
 * still taken, allocation fails deterministically (freeze §9 "MUST fail
 * rather than overwrite an existing conflicting identity").
 *
 * @param {string[]} profileIds
 * @param {{ overrides?: Record<string,string> }} [opts]
 * @returns {Map<string,string>}
 */
export function buildActorAliasRegistry(profileIds, { overrides = {} } = {}) {
  if (!Array.isArray(profileIds)) {
    throw new ArtifactPathError('profileIds must be an array', 'ARTIFACT_ALIAS_INPUT_INVALID');
  }
  const unique = [...new Set(profileIds.map((p) => {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new ArtifactPathError('every profile id must be a non-empty string', 'ARTIFACT_PROFILE_ID_EMPTY');
    }
    return p;
  }))].sort();

  const byProfile = new Map();
  const claimed = new Map(); // alias -> profileId

  const claim = (profileId, alias, code) => {
    assertActorAlias(alias);
    const owner = claimed.get(alias);
    if (owner !== undefined && owner !== profileId) {
      throw new ArtifactPathError(`actor alias collision on ${JSON.stringify(alias)} between ${owner} and ${profileId}`, code, { alias, existing: owner, incoming: profileId });
    }
    claimed.set(alias, profileId);
    byProfile.set(profileId, alias);
  };

  for (const profileId of unique) {
    if (Object.prototype.hasOwnProperty.call(overrides, profileId)) {
      const preferred = overrides[profileId];
      if (typeof preferred !== 'string') {
        throw new ArtifactPathError(`override alias for ${profileId} must be a string`, 'ARTIFACT_ALIAS_OVERRIDE_INVALID', { profileId });
      }
      claim(profileId, assertActorAlias(preferred.toLowerCase(), 'override actor alias'), 'ARTIFACT_ALIAS_OVERRIDE_COLLISION');
    }
  }

  for (const profileId of unique) {
    if (byProfile.has(profileId)) continue;
    const base = deriveActorAlias(profileId);
    if (!claimed.has(base)) { claim(profileId, base, 'ARTIFACT_ALIAS_COLLISION'); continue; }
    if (claimed.get(base) === profileId) continue;
    // R6: the collision suffix must still fit the composite-filename budget.
    const room = MAX_ACTOR_ALIAS_LENGTH - (SUFFIX_HASH_LEN + 1);
    const trimmed = base.length > room ? base.slice(0, room).replace(/-+$/g, '') : base;
    const suffixed = `${trimmed}-${sha256Hex(profileId).slice(0, SUFFIX_HASH_LEN)}`;
    claim(profileId, assertActorAlias(suffixed, 'suffixed actor alias'), 'ARTIFACT_ALIAS_COLLISION');
  }

  return new Map([...byProfile.entries()].sort());
}

/** Look up one profile's alias in a registry, or fail. */
export function actorAliasFor(registry, profileId) {
  if (!(registry instanceof Map)) {
    throw new ArtifactPathError('registry must be a Map from buildActorAliasRegistry()', 'ARTIFACT_ALIAS_REGISTRY_INVALID');
  }
  const alias = registry.get(profileId);
  if (alias === undefined) {
    throw new ArtifactPathError(`no actor alias registered for profile ${JSON.stringify(profileId)}`, 'ARTIFACT_ALIAS_UNREGISTERED', { profileId });
  }
  return alias;
}
