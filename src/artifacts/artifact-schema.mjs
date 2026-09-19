/**
 * P20.1B — versioned transport/orchestration metadata for the P20
 * `artifact_v1` store.
 *
 * Authority:
 *   docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md §13–§16
 *   docs/architecture/P20_COUNCIL_ARTIFACT_HANDOFF_ARCHITECTURE_V2.md §3
 *   docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §3/§18
 *
 * These structures are transport/orchestration metadata ONLY. They MUST
 * NOT carry model-semantic fields (verdict, findings, recommendation
 * ranking, agreement score, Chair judgment, …) — freeze §13. Attempt
 * `artifact.json` additionally MUST NOT carry `authoritative_attempt`
 * (freeze §7.1 / §13: "attempt metadata describes evidence; parent
 * application metadata selects authority").
 *
 * Pure: builders return plain objects, validators return
 * `{ ok, errors: string[] }`. No filesystem, no clock — the caller
 * (artifact-store) supplies every timestamp.
 */

import {
  ARTIFACT_SCHEMA_VERSION,
  TRANSPORT_VERSION,
  ROLE_STAGE_MATRIX,
  expectedRoleForStage,
  stageRequiresRound,
  ARTIFACT_STAGE,
} from './artifact-paths.mjs';
import { validateDebateContinuationControl } from './debate-continuation-control.mjs';

export { ARTIFACT_SCHEMA_VERSION, TRANSPORT_VERSION };

/**
 * P20.1R R3 — the ONE role/stage(/round) consistency check, shared by
 * validateInvocationRecord and validateArtifactMetadata (never duplicated
 * divergent logic). Consumes `ROLE_STAGE_MATRIX` from artifact-paths.
 * Returns error strings (empty when consistent).
 */
export function roleStageErrors(obj) {
  const errors = [];
  const { stage, role, round } = obj ?? {};
  if (!Object.prototype.hasOwnProperty.call(ROLE_STAGE_MATRIX, stage)) {
    errors.push(`stage: must be one of ${Object.keys(ROLE_STAGE_MATRIX).join(', ')}`);
    return errors; // can't check role/round without a known stage
  }
  const expectedRole = expectedRoleForStage(stage);
  if (role !== expectedRole) errors.push(`role: stage "${stage}" requires role "${expectedRole}", got ${JSON.stringify(role)}`);
  const needsRound = stageRequiresRound(stage);
  const hasRound = round !== null && round !== undefined;
  if (needsRound && !(Number.isInteger(round) && round >= 1 && round <= 99)) {
    errors.push(`round: Debate stage "${stage}" requires an integer round 1..99`);
  }
  if (!needsRound && hasRound) errors.push(`round: non-Debate stage "${stage}" must not carry a round`);
  return errors;
}

export class ArtifactSchemaError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactSchemaError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Persisted invocation lifecycle (integrity gate §3). */
export const INVOCATION_LIFECYCLE = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  RUNNING: 'RUNNING',
  DELIVERED: 'DELIVERED',
  SEALED: 'SEALED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
const LIFECYCLE_VALUES = new Set(Object.values(INVOCATION_LIFECYCLE));

/** Provider/process terminal facts (integrity gate §14). */
export const TERMINAL_STATE = Object.freeze({
  SUCCESS: 'SUCCESS',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROCESS_ERROR: 'PROCESS_ERROR',
  TRUNCATED_OR_INCOMPLETE: 'TRUNCATED_OR_INCOMPLETE',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
});
const TERMINAL_VALUES = new Set(Object.values(TERMINAL_STATE));

/** Producer delivery mechanism (freeze §11.1 / architecture V2 §7). */
export const DELIVERY_MECHANISM = Object.freeze({
  DIRECT_WRITE: 'DIRECT_WRITE',
  VERBATIM_MATERIALIZATION: 'VERBATIM_MATERIALIZATION',
});
const DELIVERY_VALUES = new Set(Object.values(DELIVERY_MECHANISM));

/** Consumer input transport (freeze §17 / architecture V2 §8). */
export const INPUT_TRANSPORT = Object.freeze({
  NATIVE_ASSIGNED_READ: 'NATIVE_ASSIGNED_READ',
  VERBATIM_CONTENT: 'VERBATIM_CONTENT',
  UNSUPPORTED: 'UNSUPPORTED',
});
const INPUT_TRANSPORT_VALUES = new Set(Object.values(INPUT_TRANSPORT));

export const TASK_STATE = Object.freeze({
  OPEN: 'OPEN',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
const TASK_STATE_VALUES = new Set(Object.values(TASK_STATE));

const TRANSPORT_VALUES = new Set(Object.values(TRANSPORT_VERSION));

/**
 * Model-semantic keys that MUST NOT appear anywhere in P20 transport
 * metadata (freeze §13, integrity gate §26 content/control boundary).
 * `authoritative_attempt` is additionally forbidden in `artifact.json`
 * specifically (checked separately).
 */
export const FORBIDDEN_SEMANTIC_KEYS = Object.freeze([
  'verdict',
  'decision',
  'decisions',
  'findings',
  'recommendation',
  'recommendation_ranking',
  'recommendations',
  'agreement_score',
  'agreement',
  'chair_judgment',
  'judgment',
  'semantic_status',
  'ranking',
  'risks',
  'analysis',
  'synthesis',
  'conclusion',
]);
const FORBIDDEN_SET = new Set(FORBIDDEN_SEMANTIC_KEYS);

/**
 * Deep scan: reject any object key (at any depth) that is a forbidden
 * model-semantic field. Arrays are traversed; primitive values are not.
 */
export function findForbiddenSemanticKeys(value, path = '$') {
  const hits = [];
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_SET.has(key.toLowerCase())) hits.push(`${at}.${key}`);
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return hits;
}

// ---- small field validators --------------------------------------------

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isIsoTimestamp = (v) => isNonEmptyString(v) && !Number.isNaN(new Date(v).getTime());
const isSha256Hex = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosixRelPath = (v) => isNonEmptyString(v) && !v.startsWith('/') && !/^[A-Za-z]:/.test(v) && !v.split('/').includes('..') && !v.includes('\\') && !v.includes('\0');

function required(errors, obj, key, predicate, message) {
  if (!predicate(obj[key])) errors.push(`${key}: ${message}`);
}
function optional(errors, obj, key, predicate, message) {
  if (obj[key] === null || obj[key] === undefined) return;
  if (!predicate(obj[key])) errors.push(`${key}: ${message}`);
}

// ---- TaskManifest (freeze §15) ----------------------------------------

/**
 * P20.3R2 R11 — the ONE shared structural contract for a sealed stage entry
 * on a task manifest. Used by BOTH `validateTaskManifest()` and
 * `TaskWorkspace.commitStageSeal()` (no divergent logic). Generic over the
 * stage KEY — P20.4 may add deterministic Council-specific keys; this
 * validator never hard-codes SINGLE. It encodes NO report semantics.
 *
 * @param {object} entry
 * @param {{ storeId?: string, projectId?: string, taskId?: string }} [manifestIdentity]
 *   the enclosing manifest identity; when a field is provided the entry's
 *   `sealed_ref` must match it.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStageSealEntry(entry, manifestIdentity = {}) {
  const errors = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, errors: ['stage seal entry must be an object'] };
  }
  required(errors, entry, 'invocation_id', isNonEmptyString, 'required non-empty string');
  required(errors, entry, 'invocation_relpath', isPosixRelPath, 'safe store-relative POSIX path');
  required(errors, entry, 'attempt_ordinal', isNonNegInt, 'non-negative integer');
  required(errors, entry, 'integrity_state', (v) => v === 'ARTIFACT_PASS', 'must be ARTIFACT_PASS');

  const rv = validateArtifactReference(entry.sealed_ref, { requireSealed: true });
  if (!rv.ok) {
    errors.push(`sealed_ref: ${rv.errors.join('; ')}`);
  } else {
    const ref = entry.sealed_ref;
    if (entry.invocation_id !== ref.invocation_id) {
      errors.push(`invocation_id ${JSON.stringify(entry.invocation_id)} must equal sealed_ref.invocation_id ${JSON.stringify(ref.invocation_id)}`);
    }
    if (entry.attempt_ordinal !== ref.attempt_ordinal) {
      errors.push(`attempt_ordinal ${JSON.stringify(entry.attempt_ordinal)} must equal sealed_ref.attempt_ordinal ${JSON.stringify(ref.attempt_ordinal)}`);
    }
    const { storeId, projectId, taskId } = manifestIdentity ?? {};
    if (storeId !== undefined && ref.store_id !== storeId) {
      errors.push(`sealed_ref.store_id ${JSON.stringify(ref.store_id)} != enclosing manifest store_id ${JSON.stringify(storeId)}`);
    }
    if (projectId !== undefined && ref.project_id !== projectId) {
      errors.push(`sealed_ref.project_id ${JSON.stringify(ref.project_id)} != enclosing manifest project_id ${JSON.stringify(projectId)}`);
    }
    if (taskId !== undefined && ref.task_id !== taskId) {
      errors.push(`sealed_ref.task_id ${JSON.stringify(ref.task_id)} != enclosing manifest task_id ${JSON.stringify(taskId)}`);
    }
  }
  const forbidden = findForbiddenSemanticKeys(entry);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * P20.6 §7/§18 — the deterministic CANONICAL identity of one concrete sealed
 * ArtifactReference, used for duplicate detection and immutable-binding
 * comparison. It is derived from the stable identity + seal facts only, never
 * from object key insertion order. Two references with the same canonical
 * identity ARE the same concrete sealed artifact.
 */
export function canonicalArtifactRefIdentity(ref) {
  if (ref === null || typeof ref !== 'object') return null;
  return [
    ref.store_id, ref.project_id, ref.task_id, ref.invocation_id,
    ref.attempt_ordinal, ref.artifact_relpath, ref.sha256, ref.bytes, ref.sealed_at,
  ].map((v) => (v === undefined ? null : v)).map((v) => JSON.stringify(v)).join(' ');
}

/**
 * P20.6 §18 — the ONE pure/deterministic structural contract for a task
 * manifest's `previous_task_refs`. NO filesystem / hash verification here
 * (that is the resolver/consumer authority boundary in artifact-context.mjs);
 * this only rejects a malformed stored dependency graph so it can never be
 * silently consumed.
 *
 *   - array of sealed ArtifactReference V1 objects
 *   - every ref's store_id/project_id equals the enclosing manifest identity
 *   - no ref whose task_id is the manifest's own task_id (self-reference)
 *   - no duplicate concrete refs (by canonical identity)
 *   - no forbidden model-semantic fields
 *
 * A legacy manifest's default empty array is valid.
 *
 * @param {unknown} refs
 * @param {{ storeId?: string, projectId?: string, taskId?: string }} [manifestIdentity]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePreviousTaskRefs(refs, manifestIdentity = {}) {
  const errors = [];
  if (!Array.isArray(refs)) return { ok: false, errors: ['previous_task_refs must be an array'] };
  const { storeId, projectId, taskId } = manifestIdentity ?? {};
  const seen = new Map();
  refs.forEach((ref, i) => {
    const rv = validateArtifactReference(ref, { requireSealed: true });
    if (!rv.ok) {
      errors.push(`previous_task_refs[${i}]: ${rv.errors.join('; ')}`);
      return;
    }
    if (storeId !== undefined && ref.store_id !== storeId) {
      errors.push(`previous_task_refs[${i}]: store_id ${JSON.stringify(ref.store_id)} != enclosing manifest store_id ${JSON.stringify(storeId)}`);
    }
    if (projectId !== undefined && ref.project_id !== projectId) {
      errors.push(`previous_task_refs[${i}]: project_id ${JSON.stringify(ref.project_id)} != enclosing manifest project_id ${JSON.stringify(projectId)}`);
    }
    if (taskId !== undefined && ref.task_id === taskId) {
      errors.push(`previous_task_refs[${i}]: self-reference to the manifest's own task_id ${JSON.stringify(taskId)} is forbidden`);
    }
    const key = canonicalArtifactRefIdentity(ref);
    if (seen.has(key)) {
      errors.push(`previous_task_refs[${i}]: duplicate concrete sealed ref (same canonical identity as previous_task_refs[${seen.get(key)}])`);
    } else {
      seen.set(key, i);
    }
  });
  const forbidden = findForbiddenSemanticKeys(refs);
  if (forbidden.length) errors.push(`previous_task_refs forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} input
 * Future fields (freeze §15/§20) MAY be left null/absent; they are still
 * declared here so downstream phases have a stable shape.
 */
// P20.4R R4 — the versioned app-owned Council control block persisted on an
// artifact_v1 Council task manifest. This is APPLICATION CONTROL, never
// report semantics. One shared structural validator; `validateTaskManifest`
// runs it when the optional `council_control` field is present, and
// `TaskWorkspace.bindCouncilControl()` uses it + deep-equality so a task_id
// can never be reopened under a different roster/order/rounds/chair.
export const COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION = 'p20.4-council-control-1';

export function validateCouncilArtifactControl(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['council_control must be an object'] };
  }
  required(errors, obj, 'schema_version', (v) => v === COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION, `must equal ${JSON.stringify(COUNCIL_ARTIFACT_CONTROL_SCHEMA_VERSION)}`);
  required(errors, obj, 'chair_profile_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'participant_profile_ids', (v) => Array.isArray(v) && v.length >= 1 && v.every(isNonEmptyString), 'ordered non-empty array of profile ids');
  if (Array.isArray(obj.participant_profile_ids) && new Set(obj.participant_profile_ids).size !== obj.participant_profile_ids.length) {
    errors.push('participant_profile_ids must be unique');
  }
  required(errors, obj, 'rounds', (v) => v === 1 || v === 2, 'must be 1 or 2');
  required(errors, obj, 'strategy', isNonEmptyString, 'required non-empty string');
  optional(errors, obj, 'implementation_participant_id', isNonEmptyString, 'string when present');
  if (isNonEmptyString(obj.implementation_participant_id) && Array.isArray(obj.participant_profile_ids)
    && !obj.participant_profile_ids.includes(obj.implementation_participant_id)) {
    errors.push('implementation_participant_id must be one of participant_profile_ids');
  }
  required(errors, obj, 'workspace_requirement', (v) => v === 'NONE' || v === 'READ', 'must be NONE or READ');
  if (obj.workspace_evidence_paths !== null && obj.workspace_evidence_paths !== undefined) {
    if (!Array.isArray(obj.workspace_evidence_paths) || !obj.workspace_evidence_paths.every(isNonEmptyString)) {
      errors.push('workspace_evidence_paths must be null or an array of non-empty strings');
    }
  }
  if (obj.debate === null || typeof obj.debate !== 'object' || Array.isArray(obj.debate)) {
    errors.push('debate must be an object');
  } else {
    if (typeof obj.debate.enabled !== 'boolean') errors.push('debate.enabled must be a boolean');
    if (!(obj.debate.max_rounds === 1 || obj.debate.max_rounds === 2)) errors.push('debate.max_rounds must be 1 or 2');
  }
  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

export function buildTaskManifest(input) {
  const {
    storeId, projectId, taskId, taskSlug, createdAt, mode,
    sourceRevision = null, workspaceId = null,
    chairProfileId = null, participantProfileIds = [],
    admittedCapabilitySnapshot = null,
    previousTaskRefs = [],
    councilControl = null,
  } = input ?? {};
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    transport_version: TRANSPORT_VERSION.ARTIFACT_V1,
    store_id: storeId,
    project_id: projectId,
    task_id: taskId,
    task_slug: taskSlug,
    created_at: createdAt,
    mode: mode ?? null,
    source_revision: sourceRevision,
    workspace_id: workspaceId,
    chair_profile_id: chairProfileId,
    participant_profile_ids: [...participantProfileIds],
    admitted_capability_snapshot: admittedCapabilitySnapshot,
    council_control: councilControl,
    stages: {},
    previous_task_refs: [...previousTaskRefs],
    task_state: TASK_STATE.OPEN,
    artifact_gate_state: null,
    final_ref: null,
  };
}

export function validateTaskManifest(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return { ok: false, errors: ['manifest must be an object'] };
  required(errors, obj, 'schema_version', (v) => v === ARTIFACT_SCHEMA_VERSION, `must equal ${ARTIFACT_SCHEMA_VERSION}`);
  required(errors, obj, 'transport_version', (v) => v === TRANSPORT_VERSION.ARTIFACT_V1, `must be "${TRANSPORT_VERSION.ARTIFACT_V1}"`);
  required(errors, obj, 'store_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'project_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'task_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'task_slug', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'created_at', isIsoTimestamp, 'required ISO-8601 timestamp');
  required(errors, obj, 'task_state', (v) => TASK_STATE_VALUES.has(v), `must be one of ${[...TASK_STATE_VALUES].join(', ')}`);
  required(errors, obj, 'participant_profile_ids', (v) => Array.isArray(v) && v.every(isNonEmptyString), 'array of profile ids');
  required(errors, obj, 'previous_task_refs', (v) => Array.isArray(v), 'array');
  required(errors, obj, 'stages', (v) => v !== null && typeof v === 'object' && !Array.isArray(v), 'object');
  // P20.3R2 R11: every sealed stage entry must satisfy the shared structural
  // contract, bound to THIS manifest's identity. Generic over the stage key.
  if (obj.stages !== null && typeof obj.stages === 'object' && !Array.isArray(obj.stages)) {
    for (const [key, entry] of Object.entries(obj.stages)) {
      const sv = validateStageSealEntry(entry, { storeId: obj.store_id, projectId: obj.project_id, taskId: obj.task_id });
      if (!sv.ok) errors.push(`stages.${key}: ${sv.errors.join('; ')}`);
    }
  }
  optional(errors, obj, 'mode', isNonEmptyString, 'string when present');
  optional(errors, obj, 'source_revision', isNonEmptyString, 'string when present');
  optional(errors, obj, 'workspace_id', isNonEmptyString, 'string when present');
  optional(errors, obj, 'chair_profile_id', isNonEmptyString, 'string when present');
  // P20.4R R4: the persisted Council control block.
  const councilControlPresent = obj.council_control !== null && obj.council_control !== undefined;
  if (councilControlPresent) {
    const cv = validateCouncilArtifactControl(obj.council_control);
    if (!cv.ok) errors.push(`council_control: ${cv.errors.join('; ')}`);
    else {
      // P20.4R3 R16 — a STORED/validated task manifest that has council_control
      // must carry the FULL top-level Council identity, PRESENT and equal (not
      // merely "non-conflicting"). The pre-bind skeleton window — where a
      // legitimately-absent field is back-filled by the first bind — is BEFORE
      // this manifest is persisted as bound; once council_control is here, the
      // projection must be complete.
      if (obj.mode !== 'council') {
        errors.push(`mode: an artifact Council task with council_control must have mode 'council', got ${JSON.stringify(obj.mode)}`);
      }
      if (typeof obj.chair_profile_id !== 'string' || !obj.chair_profile_id) {
        errors.push('chair_profile_id must be present when council_control is bound');
      } else if (obj.chair_profile_id !== obj.council_control.chair_profile_id) {
        errors.push(`chair_profile_id ${JSON.stringify(obj.chair_profile_id)} != council_control.chair_profile_id ${JSON.stringify(obj.council_control.chair_profile_id)}`);
      }
      if (!Array.isArray(obj.participant_profile_ids) || obj.participant_profile_ids.length === 0) {
        errors.push('participant_profile_ids must be present and non-empty when council_control is bound');
      } else if (JSON.stringify(obj.participant_profile_ids) !== JSON.stringify(obj.council_control.participant_profile_ids)) {
        errors.push('participant_profile_ids must deep-equal council_control.participant_profile_ids in exact owner order');
      }
    }
  } else if (obj.mode === 'council' && isNonEmptyString(obj.chair_profile_id)) {
    // P20.4R3 R15 — a manifest that identifies as a bound Council (mode
    // 'council' AND a real top-level chair identity) but has LOST its
    // council_control block, while artifact progress visible in the manifest
    // exists, is an authority error — it must never be silently re-bindable as
    // a "first bind" under changed rounds / strategy / implementation
    // participant / workspace requirement / debate settings. A pristine
    // pre-bind skeleton (chair_profile_id still null) and non-council (SINGLE)
    // tasks are unaffected here; TaskWorkspace.bindCouncilControl()
    // additionally refuses to (re-)bind whenever progress — manifest OR an
    // on-disk invocation directory — exists without a persisted control.
    const manifestProgress = [];
    if (obj.stages && typeof obj.stages === 'object' && !Array.isArray(obj.stages) && Object.keys(obj.stages).length > 0) {
      manifestProgress.push(`${Object.keys(obj.stages).length} stage seal entr${Object.keys(obj.stages).length === 1 ? 'y' : 'ies'}`);
    }
    if (obj.final_ref !== null && obj.final_ref !== undefined) manifestProgress.push('final_ref');
    if (obj.task_state !== undefined && obj.task_state !== TASK_STATE.OPEN) manifestProgress.push(`task_state=${JSON.stringify(obj.task_state)}`);
    if (obj.artifact_gate_state !== null && obj.artifact_gate_state !== undefined) manifestProgress.push(`artifact_gate_state=${JSON.stringify(obj.artifact_gate_state)}`);
    if (manifestProgress.length > 0) {
      errors.push(`council_control is required once artifact Council progress exists (found: ${manifestProgress.join(', ')})`);
    }
  }
  optional(errors, obj, 'final_ref', (v) => validateArtifactReference(v, { requireSealed: true }).ok, 'sealed ArtifactReference when present');
  // P20.6 §18 — the tightened structural contract for the stored dependency
  // graph: sealed structure + same store/project identity + no self-reference
  // + no duplicate concrete refs + no semantic fields. Pure/deterministic.
  if (obj.previous_task_refs !== undefined) {
    const pv = validatePreviousTaskRefs(obj.previous_task_refs, { storeId: obj.store_id, projectId: obj.project_id, taskId: obj.task_id });
    if (!pv.ok) errors.push(...pv.errors);
  }
  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

// ---- InvocationRecord / invocation.json (freeze §14) ------------------

export function buildInvocationRecord(input) {
  const {
    invocationId, invocationKey, storeId, projectId, taskId,
    role, stage, round = null, profileId, actorAlias,
    stageRelpath, createdAt, repairOf = null,
  } = input ?? {};
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    transport_version: TRANSPORT_VERSION.ARTIFACT_V1,
    invocation_id: invocationId,
    invocation_key: invocationKey,
    store_id: storeId,
    project_id: projectId,
    task_id: taskId,
    role,
    stage,
    round,
    profile_id: profileId,
    actor_alias: actorAlias,
    stage_relpath: stageRelpath,
    lifecycle: INVOCATION_LIFECYCLE.ASSIGNED,
    attempts: [],
    latest_attempt_ordinal: null,
    authoritative_attempt: null,
    repair_of: repairOf,
    integrity_state: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function validateInvocationRecord(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return { ok: false, errors: ['invocation record must be an object'] };
  required(errors, obj, 'schema_version', (v) => v === ARTIFACT_SCHEMA_VERSION, `must equal ${ARTIFACT_SCHEMA_VERSION}`);
  required(errors, obj, 'transport_version', (v) => v === TRANSPORT_VERSION.ARTIFACT_V1, `must be "${TRANSPORT_VERSION.ARTIFACT_V1}"`);
  required(errors, obj, 'invocation_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'invocation_key', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'store_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'project_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'task_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'role', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'stage', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'profile_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'actor_alias', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'stage_relpath', isPosixRelPath, 'store-relative POSIX path');
  required(errors, obj, 'lifecycle', (v) => LIFECYCLE_VALUES.has(v), `one of ${[...LIFECYCLE_VALUES].join(', ')}`);
  required(errors, obj, 'attempts', (v) => Array.isArray(v) && v.every(isNonNegInt), 'array of non-negative attempt ordinals');
  // R3: enforce the frozen role/stage(/round) matrix, not a generic string.
  errors.push(...roleStageErrors(obj));
  optional(errors, obj, 'latest_attempt_ordinal', isNonNegInt, 'non-negative integer when present');
  optional(errors, obj, 'repair_of', isNonNegInt, 'non-negative integer when present');
  required(errors, obj, 'created_at', isIsoTimestamp, 'required ISO-8601 timestamp');
  // authoritative_attempt is allowed here (parent authority), but only a
  // non-negative ordinal or null, and only meaningful once SEALED — P20.1
  // never sets it (freeze §19: "Do not implement P20.3 sealing behavior
  // prematurely").
  optional(errors, obj, 'authoritative_attempt', isNonNegInt, 'non-negative integer when present');

  // ---- P20.8 PRE-R3 R3-1: optional app-owned execution-ownership claim ----
  // The ONE atomic admission record for "which attempt currently owns the
  // right to call the backend for this invocation" (artifact-store.mjs
  // `InvocationWorkspace.claimRunning()`). Only ever present while
  // lifecycle is RUNNING; cleared (never left dangling) the moment the
  // invocation leaves RUNNING (DELIVERED / FAILED / CANCELLED).
  if (obj.active_execution_claim !== undefined && obj.active_execution_claim !== null) {
    const c = obj.active_execution_claim;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      errors.push('active_execution_claim: must be an object when present');
    } else {
      if (!isNonNegInt(c.attempt_ordinal)) errors.push('active_execution_claim.attempt_ordinal: non-negative integer required');
      if (!isNonEmptyString(c.execution_id)) errors.push('active_execution_claim.execution_id: non-empty string required');
      if (!isIsoTimestamp(c.claimed_at)) errors.push('active_execution_claim.claimed_at: ISO-8601 timestamp required');
    }
    if (obj.lifecycle !== INVOCATION_LIFECYCLE.RUNNING) {
      errors.push(`active_execution_claim: only permitted while lifecycle is RUNNING (lifecycle=${obj.lifecycle})`);
    }
  }

  // ---- P20.5 §20: optional app-owned debate_continuation machine control ----
  // ONLY on a debate-chair-synthesis invocation, validated structurally and
  // bound to THIS invocation's identity. `artifact.json` never carries it;
  // report.md is never inspected. A manual tamper fails on this fresh-read.
  if (obj.debate_continuation !== undefined && obj.debate_continuation !== null) {
    if (obj.stage !== ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS) {
      errors.push('debate_continuation is only permitted on a debate-chair-synthesis invocation');
    }
    const dv = validateDebateContinuationControl(obj.debate_continuation);
    if (!dv.ok) {
      errors.push(...dv.errors.map((e) => `debate_continuation: ${e}`));
    } else {
      const c = obj.debate_continuation;
      for (const [f, cv, iv] of [
        ['store_id', c.store_id, obj.store_id],
        ['project_id', c.project_id, obj.project_id],
        ['task_id', c.task_id, obj.task_id],
        ['invocation_id', c.invocation_id, obj.invocation_id],
        ['round', c.round, obj.round ?? null],
        ['profile_id', c.profile_id, obj.profile_id],
        ['actor_alias', c.actor_alias, obj.actor_alias],
      ]) {
        if (cv !== iv) errors.push(`debate_continuation.${f} ${JSON.stringify(cv)} != invocation ${JSON.stringify(iv)}`);
      }
      if (Array.isArray(obj.attempts) && !obj.attempts.includes(c.attempt_ordinal)) {
        errors.push(`debate_continuation.attempt_ordinal ${JSON.stringify(c.attempt_ordinal)} is not a recorded attempt of this invocation`);
      }
      if (obj.lifecycle === INVOCATION_LIFECYCLE.SEALED && c.attempt_ordinal !== obj.authoritative_attempt) {
        errors.push('debate_continuation.attempt_ordinal must equal authoritative_attempt once the invocation is SEALED');
      }
    }
  }

  // ---- P20.3R R7: SEALED-state self-consistency (one shared validator) ----
  const attemptsArr = Array.isArray(obj.attempts) ? obj.attempts : [];
  // Deterministic attempt-history invariants.
  if (new Set(attemptsArr).size !== attemptsArr.length) errors.push('attempts: must be unique');
  if (attemptsArr.some((v, i) => i > 0 && v <= attemptsArr[i - 1])) errors.push('attempts: must be sorted strictly ascending');
  const maxAttempt = attemptsArr.length ? attemptsArr[attemptsArr.length - 1] : null;
  if (obj.latest_attempt_ordinal !== (attemptsArr.length ? maxAttempt : null)) {
    errors.push('latest_attempt_ordinal: must equal max(attempts), or null when there are none');
  }

  if (obj.lifecycle === INVOCATION_LIFECYCLE.SEALED) {
    if (!isNonNegInt(obj.authoritative_attempt)) {
      errors.push('SEALED: authoritative_attempt must be a non-negative integer');
    } else if (!attemptsArr.includes(obj.authoritative_attempt)) {
      errors.push('SEALED: authoritative_attempt must appear in attempts[]');
    }
    if (obj.seal === null || typeof obj.seal !== 'object' || Array.isArray(obj.seal)) {
      errors.push('SEALED: a seal object is required');
    } else {
      if (obj.seal.authoritative_attempt !== obj.authoritative_attempt) errors.push('SEALED: seal.authoritative_attempt must equal authoritative_attempt');
      if (!isIsoTimestamp(obj.seal.sealed_at)) errors.push('SEALED: seal.sealed_at must be a valid ISO-8601 timestamp');
      if (!isNonEmptyString(obj.seal.seal_version)) errors.push('SEALED: seal.seal_version must be a non-empty string');
      if (obj.seal.integrity_state !== 'ARTIFACT_PASS') errors.push('SEALED: seal.integrity_state must be ARTIFACT_PASS');
    }
    if (obj.integrity_state !== 'ARTIFACT_PASS') errors.push('SEALED: parent integrity_state must be ARTIFACT_PASS');
  } else {
    if (isNonNegInt(obj.authoritative_attempt)) errors.push(`authoritative_attempt: only permitted once lifecycle is SEALED (lifecycle=${obj.lifecycle})`);
    if (obj.seal !== undefined && obj.seal !== null) errors.push(`seal: must be null/absent when lifecycle is not SEALED (lifecycle=${obj.lifecycle})`);
  }

  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

// ---- Attempt ArtifactMetadata / artifact.json (freeze §13) -----------

export function buildArtifactMetadata(input) {
  const {
    storeId, projectId, taskId, invocationId, executionId,
    attemptOrdinal, role, stage, round = null, profileId, actorAlias,
    deliveryMechanism, inputTransport = null, contentAuthor = 'LLM',
    startedAt = null, finishedAt = null, terminalState = null,
    reportRelpath, executiveLogRelpath,
    reportBytes = null, reportSha256 = null,
    repairOf = null,
  } = input ?? {};
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    transport_version: TRANSPORT_VERSION.ARTIFACT_V1,
    store_id: storeId,
    project_id: projectId,
    task_id: taskId,
    invocation_id: invocationId,
    execution_id: executionId,
    attempt_ordinal: attemptOrdinal,
    role,
    stage,
    round,
    profile_id: profileId,
    actor_alias: actorAlias,
    content_author: contentAuthor,
    delivery_mechanism: deliveryMechanism,
    input_transport: inputTransport,
    started_at: startedAt,
    finished_at: finishedAt,
    terminal_state: terminalState,
    report_relpath: reportRelpath,
    executive_log_relpath: executiveLogRelpath,
    report_bytes: reportBytes,
    report_sha256: reportSha256,
    repair_of: repairOf,
  };
}

export function validateArtifactMetadata(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return { ok: false, errors: ['artifact metadata must be an object'] };

  // Mandatory authority rule (freeze §13 / §7.1): an attempt MUST NOT
  // select itself as authoritative.
  if (Object.prototype.hasOwnProperty.call(obj, 'authoritative_attempt')) {
    errors.push('authoritative_attempt: MUST NOT appear in artifact.json (parent metadata selects authority)');
  }

  required(errors, obj, 'schema_version', (v) => v === ARTIFACT_SCHEMA_VERSION, `must equal ${ARTIFACT_SCHEMA_VERSION}`);
  required(errors, obj, 'transport_version', (v) => v === TRANSPORT_VERSION.ARTIFACT_V1, `must be "${TRANSPORT_VERSION.ARTIFACT_V1}"`);
  required(errors, obj, 'store_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'project_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'task_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'invocation_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'execution_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'attempt_ordinal', isNonNegInt, 'non-negative integer');
  required(errors, obj, 'role', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'stage', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'profile_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'actor_alias', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'content_author', (v) => v === 'LLM', 'must be "LLM"');
  required(errors, obj, 'delivery_mechanism', (v) => DELIVERY_VALUES.has(v), `one of ${[...DELIVERY_VALUES].join(', ')}`);
  required(errors, obj, 'report_relpath', isPosixRelPath, 'store-relative POSIX path');
  required(errors, obj, 'executive_log_relpath', isPosixRelPath, 'store-relative POSIX path');
  // R3: enforce the frozen role/stage(/round) matrix, not a generic string.
  errors.push(...roleStageErrors(obj));
  optional(errors, obj, 'input_transport', (v) => INPUT_TRANSPORT_VALUES.has(v), `one of ${[...INPUT_TRANSPORT_VALUES].join(', ')}`);
  optional(errors, obj, 'started_at', isIsoTimestamp, 'ISO-8601 timestamp when present');
  optional(errors, obj, 'finished_at', isIsoTimestamp, 'ISO-8601 timestamp when present');
  optional(errors, obj, 'terminal_state', (v) => TERMINAL_VALUES.has(v), `one of ${[...TERMINAL_VALUES].join(', ')} when present`);
  optional(errors, obj, 'report_bytes', isNonNegInt, 'non-negative integer when present');
  optional(errors, obj, 'report_sha256', isSha256Hex, 'lowercase hex sha256 when present');
  optional(errors, obj, 'repair_of', isNonNegInt, 'non-negative integer when present');

  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

// ---- ArtifactReference V1 (freeze §16) ------------------------------

/**
 * @param {object} input
 * @param {{ sealed?: boolean }} [opts] when `sealed` is false the sha256 /
 *   bytes / sealed_at fields are left null — an internal, not-yet-sealed
 *   reference (freeze §16 "P20.1 may support incomplete/unsealed internal
 *   references separately"). A sealed reference is only created once P20.3
 *   integrity logic exists.
 */
export function buildArtifactReference(input, { sealed = false } = {}) {
  const {
    storeId, projectId, taskId, invocationId, attemptOrdinal,
    artifactRelpath, sha256 = null, bytes = null, sealedAt = null,
  } = input ?? {};
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    store_id: storeId,
    project_id: projectId,
    task_id: taskId,
    invocation_id: invocationId,
    attempt_ordinal: attemptOrdinal,
    artifact_relpath: artifactRelpath,
    sha256: sealed ? sha256 : null,
    bytes: sealed ? bytes : null,
    sealed_at: sealed ? sealedAt : null,
  };
}

export function validateArtifactReference(obj, { requireSealed = false } = {}) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return { ok: false, errors: ['ArtifactReference must be an object'], sealed: false };
  required(errors, obj, 'schema_version', (v) => v === ARTIFACT_SCHEMA_VERSION, `must equal ${ARTIFACT_SCHEMA_VERSION}`);
  required(errors, obj, 'store_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'project_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'task_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'invocation_id', isNonEmptyString, 'required non-empty string');
  required(errors, obj, 'attempt_ordinal', isNonNegInt, 'non-negative integer');
  required(errors, obj, 'artifact_relpath', isPosixRelPath, 'store-relative POSIX path');

  const sealed = isSha256Hex(obj.sha256) && isNonNegInt(obj.bytes) && isIsoTimestamp(obj.sealed_at);
  if (requireSealed && !sealed) {
    if (!isSha256Hex(obj.sha256)) errors.push('sha256: sealed reference requires lowercase hex sha256');
    if (!isNonNegInt(obj.bytes)) errors.push('bytes: sealed reference requires a non-negative integer');
    if (!isIsoTimestamp(obj.sealed_at)) errors.push('sealed_at: sealed reference requires an ISO-8601 timestamp');
  } else if (!requireSealed) {
    optional(errors, obj, 'sha256', isSha256Hex, 'lowercase hex sha256 when present');
    optional(errors, obj, 'bytes', isNonNegInt, 'non-negative integer when present');
    optional(errors, obj, 'sealed_at', isIsoTimestamp, 'ISO-8601 timestamp when present');
  }
  const forbidden = findForbiddenSemanticKeys(obj);
  if (forbidden.length) errors.push(`forbidden semantic keys: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors, sealed };
}

/** Throw-style helper for callers that want an assertion. */
export function assertNoForbiddenSemanticKeys(value, label = 'metadata') {
  const hits = findForbiddenSemanticKeys(value);
  if (hits.length) {
    throw new ArtifactSchemaError(`${label} contains forbidden model-semantic keys: ${hits.join(', ')}`, 'ARTIFACT_SEMANTIC_KEY_FORBIDDEN', { hits });
  }
  return value;
}
