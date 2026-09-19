/**
 * P7 — durable CouncilSpec contract.
 *
 * A council run is ONE durable PmRun (PmRepository / DurablePmRuntime,
 * SQLite schema UNCHANGED) whose pm_request.context.council carries this
 * normalized CouncilSpec, and whose pm_turns are council steps (one WORKFLOW
 * turn per chair-plan / participant-report / participant-critique /
 * chair-synthesis step — see council-step-workflow-runner.mjs and
 * council-chair-driver.mjs). There is deliberately no new SQLite table: the
 * existing pm_requests/pm_runs/pm_turns turn-durability machine already
 * gives council exactly the restart-safety, idempotency, and claim/fence
 * authority Part J/K/T require, for free. See
 * docs/p7/01_P7_COUNCIL_ARCHITECTURE.md for the full reuse/extend/replace
 * audit this design is based on.
 */

export const COUNCIL_STRATEGY = 'independent_then_critique_then_synthesis';
export const COUNCIL_MIN_ROUNDS = 1;
export const COUNCIL_MAX_ROUNDS = 2;
export const COUNCIL_DEFAULT_ROUNDS = 2;
// Bounds context budget (Part V) and matches the four-backend product
// catalogue (ProductionPmBackendRegistry.SUPPORTED) — a council can never
// legitimately need more distinct participants than there are backends.
export const COUNCIL_MAX_PARTICIPANTS = 4;

// P19-D1 — Debate extension bounds (docs/p19/00_P19_DEBATE_EXTENSION_PLAN.md
// §§7-8). DEBATE = COUNCIL + bounded iterative challenge/synthesis, never a
// second engine. `max_rounds` is owner-configurable between 1 and 2, but the
// engine (council-chair-driver.mjs's #debateDecide()) additionally forces a
// stop at round 2 regardless of the chair's own `continue_debate` value —
// this constant is that hard, non-owner-overridable ceiling.
export const DEBATE_MIN_ROUNDS = 1;
export const DEBATE_MAX_ROUNDS = 2;
export const DEBATE_DEFAULT_MAX_ROUNDS = 2;

export const COUNCIL_STEP_KINDS = Object.freeze({
  CHAIR_PLAN: 'chair_plan',
  PARTICIPANT_REPORT: 'participant_report',
  PARTICIPANT_CRITIQUE: 'participant_critique',
  CHAIR_SYNTHESIS: 'chair_synthesis',
  // P19-D1: debate extension step kinds. These are only ever emitted by
  // CouncilChairDriver's #debateDecide() branch, reached only when the
  // council's own normalized `debate.enabled === true` (never for a
  // pre-P19 council, which normalizes `debate` to `{enabled:false,...}`
  // by default — see normalizeCouncilSpec() below). Every debate step is
  // reasoning-only by construction: CouncilChairDriver never derives
  // `isImplementationParticipant` for any of these three kinds (see that
  // file's #debateWorkflow()) — W4R6's execution-capable mechanism is
  // deliberately NOT reused by Debate-round steps. P19-D5 reuses W4R6 on
  // the selected participant's Council report turn; these steps stay plan.
  DEBATE_BRIEF: 'debate_brief',
  DEBATE_RESPONSE: 'debate_response',
  DEBATE_SYNTHESIS: 'debate_synthesis',
});

export const DEGRADED_DISCLOSURE_SENTENCE = 'Council degraded: only one participant completed.';

// Council/Debate WORKSPACE_READ remediation (docs/evidence/
// DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §12): an explicit,
// typed, owner-authored task requirement — never inferred from
// natural-language task text. `NONE` (default) reproduces every pre-
// existing council/debate byte-for-byte; `READ` requires every chair/
// participant step to satisfy src/pm/council/workspace-capability.mjs's
// capability contract (native or DSH-supplied evidence packet) and
// requires cited repository evidence in participant_report/debate_response
// steps (src/pm/council/workspace-evidence-contract.mjs). See
// council-workspace-admission.mjs for the admission-time gate.
export const WORKSPACE_REQUIREMENT = Object.freeze({ NONE: 'NONE', READ: 'READ' });

// Owner-review remediation (Gap B — "explicit, owner-authored evidence
// manifest", docs/evidence/DSH_COUNCIL_WORKSPACE_READ_IMPLEMENTATION_
// 20260906.md): bounds for the optional `workspace_evidence_paths` field
// below. Deliberately generous enough for a real repository-audit manifest
// (the T5-shaped example lists 13 paths) while still a hard, finite cap —
// never unbounded, matching this file's existing COUNCIL_MAX_PARTICIPANTS
// discipline.
export const MAX_WORKSPACE_EVIDENCE_PATHS = 40;
export const MAX_WORKSPACE_EVIDENCE_PATH_CHARS = 400;

export class CouncilValidationError extends Error {
  constructor(message, code, extra = {}) { super(message); this.name = 'CouncilValidationError'; this.code = code; Object.assign(this, extra); }
}

function boundedProfileId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new CouncilValidationError(`${label} is invalid`, 'COUNCIL_INVALID_PROFILE_ID', { label });
  }
  return value;
}

// Owner-review remediation Gap B: pure SHAPE validation only (no
// filesystem — this module never learns `project.repo_path`). Root
// confinement, symlink-escape, and deny-list checks happen later, against
// the real project, in council-workspace-admission.mjs and workspace-
// evidence-packet.mjs — both via workspace-safe-reader.mjs's single
// isWorkspacePathAllowed() authority (never a second, diverging check).
function boundedWorkspaceEvidencePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CouncilValidationError('workspace_evidence_paths entries must be non-empty strings', 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH', { value });
  }
  if (value.length > MAX_WORKSPACE_EVIDENCE_PATH_CHARS) {
    throw new CouncilValidationError(`workspace_evidence_paths entry exceeds ${MAX_WORKSPACE_EVIDENCE_PATH_CHARS} chars`, 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH', { value });
  }
  if (value.includes('..') || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    throw new CouncilValidationError(`workspace_evidence_paths entry must be a repo-relative path with no ".." or drive/absolute prefix: ${value}`, 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATH', { value });
  }
  return value;
}

// Owner-review remediation Gap B: normalize the optional `workspace_
// evidence_paths` array. Absent/null -> `null` (the exact pre-patch
// behavior — a READ council with no manifest still uses the generic
// anchor-file/directory-listing evidence packet, byte-for-byte unchanged).
// Meaningful ONLY alongside `workspace_requirement:'READ'` — supplying it
// under `NONE` fails closed rather than being silently accepted-and-ignored
// (Part 7: "optional; meaningful only when workspace_requirement==READ").
function normalizeWorkspaceEvidencePaths(raw, { workspaceRequirement }) {
  if (raw === undefined || raw === null) return null;
  if (workspaceRequirement !== WORKSPACE_REQUIREMENT.READ) {
    throw new CouncilValidationError('workspace_evidence_paths requires workspace_requirement:READ', 'COUNCIL_WORKSPACE_EVIDENCE_PATHS_REQUIRE_READ');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CouncilValidationError('workspace_evidence_paths must be a non-empty array when present', 'COUNCIL_INVALID_WORKSPACE_EVIDENCE_PATHS');
  }
  if (raw.length > MAX_WORKSPACE_EVIDENCE_PATHS) {
    throw new CouncilValidationError(`too many workspace_evidence_paths (max ${MAX_WORKSPACE_EVIDENCE_PATHS})`, 'COUNCIL_TOO_MANY_WORKSPACE_EVIDENCE_PATHS');
  }
  const paths = raw.map((v) => boundedWorkspaceEvidencePath(v));
  // Same fail-closed-on-duplicate discipline this file already applies to
  // participant_profile_ids (COUNCIL_DUPLICATE_PARTICIPANT) — a duplicate
  // is never silently deduped.
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) throw new CouncilValidationError(`duplicate workspace_evidence_paths entry: ${p}`, 'COUNCIL_DUPLICATE_WORKSPACE_EVIDENCE_PATH', { path: p });
    seen.add(p);
  }
  return Object.freeze(paths);
}

/**
 * Normalize + validate a raw council request against the OWNER-SELECTED
 * authority boundary (Part R/T): chair and every participant must already be
 * a registered PM profile id. `knownProfileIds` is a `Set<string>` of every
 * registered PM profile id; omit only for pure-shape unit tests.
 *
 * P18-W4R6: `implementation_participant_id` (optional, null by default) is
 * the ONE typed, owner-selected authority boundary for execution capability
 * (docs/p18/ W4R6 audit — no council stepKind was ever, by itself,
 * "implementation"; W4R3 left the opt-in mechanism ready for exactly this).
 * When present it MUST already be a member of `participant_profile_ids` —
 * fails closed (never silently ignored, never falls back to "nobody" or
 * "everybody") on anything else: a malformed value, or a well-formed id that
 * is not one of THIS council's own owner-selected participants. Absent
 * (null), every participant/chair step stays read-only `plan` — byte-for-
 * byte unchanged from every pre-W4R6 council. This is derived from the
 * council's own durable, owner-authored spec — never from prompt text, never
 * inferred from a stepKind alone (Part: "execution capability must be
 * derived from the typed workflow role/stage, not prompt prose").
 */
export function normalizeCouncilSpec(raw, { knownProfileIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CouncilValidationError('council spec must be a plain object', 'COUNCIL_INVALID_SPEC');
  }
  const chairProfileId = boundedProfileId(raw.chair_profile_id, 'chair_profile_id');
  if (!Array.isArray(raw.participant_profile_ids) || raw.participant_profile_ids.length === 0) {
    throw new CouncilValidationError('council requires at least one participant', 'COUNCIL_ZERO_PARTICIPANTS');
  }
  const participantProfileIds = raw.participant_profile_ids.map((v) => boundedProfileId(v, 'participant_profile_id'));
  const seen = new Set();
  for (const id of participantProfileIds) {
    if (seen.has(id)) throw new CouncilValidationError(`duplicate participant: ${id}`, 'COUNCIL_DUPLICATE_PARTICIPANT', { profileId: id });
    seen.add(id);
  }
  if (participantProfileIds.length > COUNCIL_MAX_PARTICIPANTS) {
    throw new CouncilValidationError(`too many participants (max ${COUNCIL_MAX_PARTICIPANTS})`, 'COUNCIL_TOO_MANY_PARTICIPANTS');
  }
  const rounds = raw.rounds ?? COUNCIL_DEFAULT_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < COUNCIL_MIN_ROUNDS || rounds > COUNCIL_MAX_ROUNDS) {
    throw new CouncilValidationError('rounds must be 1 or 2', 'COUNCIL_INVALID_ROUNDS');
  }
  const strategy = raw.strategy ?? COUNCIL_STRATEGY;
  if (strategy !== COUNCIL_STRATEGY) {
    throw new CouncilValidationError(`unsupported council strategy: ${strategy}`, 'COUNCIL_UNSUPPORTED_STRATEGY', { strategy });
  }
  // Chair does NOT have to (and need not) also be a participant (Part A/product
  // vision) — no uniqueness constraint is enforced between chair and
  // participants; a chair listed among its own participants is accepted
  // (it simply also produces an independent round-1 report as itself).
  if (knownProfileIds) {
    if (!knownProfileIds.has(chairProfileId)) throw new CouncilValidationError(`unknown chair profile: ${chairProfileId}`, 'COUNCIL_UNKNOWN_CHAIR', { profileId: chairProfileId });
    for (const id of participantProfileIds) {
      if (!knownProfileIds.has(id)) throw new CouncilValidationError(`unknown participant profile: ${id}`, 'COUNCIL_UNKNOWN_PARTICIPANT', { profileId: id });
    }
  }
  let implementationParticipantId = null;
  if (raw.implementation_participant_id != null) {
    // Same bounded-shape discipline as chair/participant ids — a malformed
    // value fails closed here rather than being silently coerced/ignored.
    const candidate = boundedProfileId(raw.implementation_participant_id, 'implementation_participant_id');
    if (!seen.has(candidate)) {
      throw new CouncilValidationError(`implementation_participant_id must be one of this council's own participants: ${candidate}`, 'COUNCIL_UNKNOWN_IMPLEMENTATION_PARTICIPANT', { profileId: candidate });
    }
    implementationParticipantId = candidate;
  }
  const debate = normalizeDebateSpec(raw.debate);
  const workspaceRequirement = normalizeWorkspaceRequirement(raw.workspace_requirement);
  const workspaceEvidencePaths = normalizeWorkspaceEvidencePaths(raw.workspace_evidence_paths, { workspaceRequirement });
  return Object.freeze({
    kind: 'COUNCIL',
    chair_profile_id: chairProfileId,
    participant_profile_ids: Object.freeze(participantProfileIds),
    rounds,
    strategy,
    implementation_participant_id: implementationParticipantId,
    debate,
    workspace_requirement: workspaceRequirement,
    workspace_evidence_paths: workspaceEvidencePaths,
  });
}

// Council/Debate WORKSPACE_READ remediation Part 12: absent/null ->
// `NONE`, the exact byte-for-byte default every pre-existing council
// already gets. Anything other than the two typed enum values fails
// closed — never silently coerced to `NONE` (which would mask an owner
// typo as "no requirement" instead of rejecting the dispatch).
function normalizeWorkspaceRequirement(raw) {
  if (raw === undefined || raw === null) return WORKSPACE_REQUIREMENT.NONE;
  if (raw === WORKSPACE_REQUIREMENT.NONE || raw === WORKSPACE_REQUIREMENT.READ) return raw;
  throw new CouncilValidationError(`workspace_requirement must be NONE or READ: ${String(raw)}`, 'COUNCIL_INVALID_WORKSPACE_REQUIREMENT', { value: raw });
}

// P19-D1 (docs/p19/00_...md §8): normalize the optional `debate` block.
// Absent/null -> the exact frozen default every pre-P19 council already
// gets implicitly, so `normalizeCouncilSpec()`'s output for a debate-less
// request carries the SAME pre-existing fields plus this one new,
// closed-by-default field — no existing caller's behavior changes.
// Strict-field semantics (matching this file's existing "no additions"
// discipline for chair_plan's participant_instructions, Part G): an
// unknown key fails closed rather than being silently ignored.
const DEBATE_ALLOWED_KEYS = new Set(['enabled', 'max_rounds']);

function normalizeDebateSpec(raw) {
  if (raw === undefined || raw === null) {
    return Object.freeze({ enabled: false, max_rounds: DEBATE_DEFAULT_MAX_ROUNDS });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CouncilValidationError('debate must be a plain object', 'COUNCIL_INVALID_DEBATE_SPEC');
  }
  const extraKeys = Object.keys(raw).filter((k) => !DEBATE_ALLOWED_KEYS.has(k));
  if (extraKeys.length) {
    throw new CouncilValidationError(`debate has unknown field(s): ${extraKeys.join(',')}`, 'COUNCIL_INVALID_DEBATE_FIELDS', { fields: extraKeys });
  }
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== 'boolean') {
    throw new CouncilValidationError('debate.enabled must be a boolean', 'COUNCIL_INVALID_DEBATE_ENABLED');
  }
  const maxRounds = raw.max_rounds === undefined ? DEBATE_DEFAULT_MAX_ROUNDS : raw.max_rounds;
  if (!Number.isInteger(maxRounds) || maxRounds < DEBATE_MIN_ROUNDS || maxRounds > DEBATE_MAX_ROUNDS) {
    throw new CouncilValidationError('debate.max_rounds must be 1 or 2', 'COUNCIL_INVALID_DEBATE_ROUNDS');
  }
  return Object.freeze({ enabled, max_rounds: maxRounds });
}

/** A bounded, finite turn budget for the council's PmRun (Part I: no infinite loop). */
export function councilMaxTurns(spec) {
  const p = spec.participant_profile_ids.length;
  // chair_plan(1) + round1(p) + round2(<=p, only when rounds>=2) + synthesis(1) + finish(1)
  let turns = 1 + p + (spec.rounds >= 2 ? p : 0) + 1 + 1;
  // P19-D1: each debate round adds brief(1) + responses(<=p) + synthesis(1).
  // Still a hard, finite cap (Part I) — `max_rounds` is itself bounded to
  // DEBATE_MAX_ROUNDS by normalizeCouncilSpec()/normalizeDebateSpec()
  // above, so this can never grow unbounded regardless of caller input.
  if (spec.debate?.enabled) {
    const maxDebateRounds = Math.min(spec.debate.max_rounds ?? DEBATE_DEFAULT_MAX_ROUNDS, DEBATE_MAX_ROUNDS);
    turns += maxDebateRounds * (1 + p + 1);
  }
  return Math.min(32, turns);
}

/** Deterministic, readable step id — also parseable back via parseCouncilStepId(). */
export function councilStepId({ stepKind, round, participantProfileId = null }) {
  const suffix = participantProfileId ? `:${participantProfileId}` : '';
  return `council:${stepKind}:${round}${suffix}`;
}

export function parseCouncilStepId(id) {
  if (typeof id !== 'string') return null;
  const m = id.match(/^council:([a-z_]+):(\d+)(?::(.+))?$/);
  if (!m) return null;
  return { stepKind: m[1], round: Number(m[2]), participantProfileId: m[3] ?? null };
}

// --- Context budget (Part V): bound individual report/critique/synthesis
// text deterministically rather than allowing unbounded report explosion.
// Truncation always carries an explicit marker — a participant's content is
// shortened, never silently dropped.
export const REPORT_CHAR_BUDGET = 6000;
export const CRITIQUE_CONTEXT_CHAR_BUDGET = 6000;
export const SYNTHESIS_CHAR_BUDGET = 24000;
// P19-D1 — same discipline, new debate-round budgets (docs/p19/00_...md
// §10): bound the canonical synthesis/brief/response context every debate
// step carries, never a raw unbounded transcript dump.
export const DEBATE_BRIEF_CHAR_BUDGET = 6000;
export const DEBATE_RESPONSE_CONTEXT_CHAR_BUDGET = 6000;
export const DEBATE_SYNTHESIS_CHAR_BUDGET = 24000;

export function truncateForBudget(text, budget, label) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= budget) return value;
  return `${value.slice(0, Math.max(0, budget))}\n[TRUNCATED — ${label} exceeded ${budget}-char budget]`;
}
