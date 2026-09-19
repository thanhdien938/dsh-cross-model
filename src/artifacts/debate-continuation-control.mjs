/**
 * P20.5 §6/§18/§19 — the versioned, app-validated MACHINE control that decides
 * whether a Debate loop continues. D3 is LOCKED: this is a SEPARATE control
 * plane from `report.md`. `report.md` is NEVER scanned/parsed/regexed/
 * JSON-decoded to obtain continuation (§6). This record carries ONLY machine
 * facts required for orchestration — no report semantics (§8/§18: no `reason`,
 * `unresolved_questions`, `analysis`, `recommendation`, `summary`, `findings`).
 *
 * It is captured from the SAME provider execution that authored the Debate
 * Chair synthesis report (§7/§21 — no silent extra model/control call) and is
 * only valid if it binds to that exact task / round / invocation / attempt /
 * execution (§19). A valid Boolean with the wrong identity must NOT control the
 * loop.
 *
 * Persisted in an APP-OWNED control-plane location (`invocation.json`'s
 * `debate_continuation` block — §20), never in `artifact.json`, never in
 * report bytes.
 *
 * Pure: no filesystem, no clock, no model output.
 */

import { ARTIFACT_STAGE } from './artifact-paths.mjs';

// This module is imported by artifact-schema.mjs (invocation.json validation),
// so it MUST NOT import back from it. The `ALLOWED_KEYS` whitelist below is a
// strictly stronger guard than a forbidden-key blacklist anyway — any key not
// on the whitelist is rejected.

export const DEBATE_CONTINUATION_SCHEMA_VERSION = 'p20.5-debate-continuation-1';
export const DEBATE_CONTINUATION_CONTROL_KIND = 'debate_continuation';
export const DEBATE_CONTINUATION_TRANSPORT_VERSION = 'artifact_v1';

// The ONLY keys a bound debate_continuation control record may carry.
const ALLOWED_KEYS = Object.freeze(new Set([
  'schema_version', 'transport_version', 'control_kind',
  'store_id', 'project_id', 'task_id',
  'invocation_id', 'attempt_ordinal', 'execution_id',
  'round', 'profile_id', 'actor_alias', 'stage', 'role',
  'continue_debate',
]));

// Report-semantic keys that must NEVER appear on a typed control record.
const FORBIDDEN_CONTROL_KEYS = Object.freeze([
  'reason', 'unresolved_questions', 'analysis', 'recommendation', 'recommendations',
  'summary', 'findings', 'claims', 'arguments', 'confidence', 'remaining_disagreements',
  'brief', 'response', 'synthesis', 'report',
]);

export class DebateContinuationControlError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'DebateContinuationControlError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Build a debate_continuation control record from an app-owned expected
 * identity + a raw boolean captured from the provider execution. Throws on any
 * non-boolean continuation or missing identity — a control is never inferred.
 *
 * @param {object} input
 * @param {object} input.expected  { storeId, projectId, taskId, invocationId,
 *   attemptOrdinal, executionId, round, profileId, actorAlias, role }
 * @param {boolean} input.continueDebate  the raw typed boolean from the same execution
 * @returns {object} frozen control record
 */
export function buildDebateContinuationControl({ expected, continueDebate }) {
  if (!expected || typeof expected !== 'object') {
    throw new DebateContinuationControlError('expected identity is required', 'DEBATE_CONTROL_NO_IDENTITY');
  }
  if (typeof continueDebate !== 'boolean') {
    throw new DebateContinuationControlError(`continue_debate must be a boolean, got ${JSON.stringify(continueDebate)}`, 'DEBATE_CONTROL_NOT_BOOLEAN');
  }
  const req = ['storeId', 'projectId', 'taskId', 'invocationId', 'executionId', 'profileId', 'actorAlias'];
  for (const k of req) {
    if (typeof expected[k] !== 'string' || !expected[k]) {
      throw new DebateContinuationControlError(`expected.${k} is required`, 'DEBATE_CONTROL_BAD_IDENTITY', { field: k });
    }
  }
  if (!Number.isInteger(expected.attemptOrdinal) || expected.attemptOrdinal < 0) {
    throw new DebateContinuationControlError('expected.attemptOrdinal must be a non-negative integer', 'DEBATE_CONTROL_BAD_IDENTITY', { field: 'attemptOrdinal' });
  }
  if (!Number.isInteger(expected.round) || expected.round < 1 || expected.round > 99) {
    throw new DebateContinuationControlError('expected.round must be an integer 1..99', 'DEBATE_CONTROL_BAD_IDENTITY', { field: 'round' });
  }
  const record = {
    schema_version: DEBATE_CONTINUATION_SCHEMA_VERSION,
    transport_version: DEBATE_CONTINUATION_TRANSPORT_VERSION,
    control_kind: DEBATE_CONTINUATION_CONTROL_KIND,
    store_id: expected.storeId,
    project_id: expected.projectId,
    task_id: expected.taskId,
    invocation_id: expected.invocationId,
    attempt_ordinal: expected.attemptOrdinal,
    execution_id: expected.executionId,
    round: expected.round,
    profile_id: expected.profileId,
    actor_alias: expected.actorAlias,
    stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS,
    role: expected.role ?? 'chair',
    continue_debate: continueDebate,
  };
  const shape = validateDebateContinuationControl(record);
  if (!shape.ok) {
    throw new DebateContinuationControlError(`built debate_continuation control failed validation: ${shape.errors.join('; ')}`, 'DEBATE_CONTROL_INVALID', { errors: shape.errors });
  }
  return Object.freeze(record);
}

/**
 * §21/§24 — capture the typed continuation from the SAME report execution that
 * authored the sealed Debate synthesis. Reads ONLY the separate
 * `result.debate_typed_control.continue_debate` machine channel — NEVER the
 * visible report bytes. Fails closed if the channel is absent/malformed or the
 * result does not belong to this execution.
 *
 * @param {object} input
 * @param {object} input.result   a ReportBackendResult from the synthesis execution
 * @param {object} input.expected same shape as buildDebateContinuationControl's `expected`
 * @returns {object} a frozen, validated debate_continuation control record
 */
export function captureDebateContinuationFromResult({ result, expected }) {
  if (!result || typeof result !== 'object') {
    throw new DebateContinuationControlError('a report result is required to capture typed control', 'DEBATE_CONTROL_NO_RESULT');
  }
  if (typeof result.execution_id === 'string' && expected && typeof expected.executionId === 'string'
    && result.execution_id !== expected.executionId) {
    throw new DebateContinuationControlError(
      `typed-control result execution_id ${JSON.stringify(result.execution_id)} does not match the synthesis execution ${JSON.stringify(expected.executionId)}`,
      'DEBATE_CONTROL_EXECUTION_MISMATCH',
    );
  }
  const tc = result.debate_typed_control;
  if (tc === null || tc === undefined || typeof tc !== 'object' || typeof tc.continue_debate !== 'boolean') {
    throw new DebateContinuationControlError(
      'the Debate synthesis execution did not surface a separate typed continue_debate control (report bytes are never inspected)',
      'DEBATE_CONTROL_NOT_CAPTURED',
    );
  }
  return buildDebateContinuationControl({ expected, continueDebate: tc.continue_debate });
}

/** Structural validation of a debate_continuation control record. `{ ok, errors }`. */
export function validateDebateContinuationControl(rec) {
  const errors = [];
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, errors: ['control record must be an object'] };
  }
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(k)) errors.push(`unknown control key ${JSON.stringify(k)}`);
  }
  if (rec.schema_version !== DEBATE_CONTINUATION_SCHEMA_VERSION) errors.push(`schema_version must be ${JSON.stringify(DEBATE_CONTINUATION_SCHEMA_VERSION)}`);
  if (rec.transport_version !== DEBATE_CONTINUATION_TRANSPORT_VERSION) errors.push(`transport_version must be ${JSON.stringify(DEBATE_CONTINUATION_TRANSPORT_VERSION)}`);
  if (rec.control_kind !== DEBATE_CONTINUATION_CONTROL_KIND) errors.push(`control_kind must be ${JSON.stringify(DEBATE_CONTINUATION_CONTROL_KIND)}`);
  for (const k of ['store_id', 'project_id', 'task_id', 'invocation_id', 'execution_id', 'profile_id', 'actor_alias']) {
    if (typeof rec[k] !== 'string' || !rec[k]) errors.push(`${k} must be a non-empty string`);
  }
  if (!Number.isInteger(rec.attempt_ordinal) || rec.attempt_ordinal < 0) errors.push('attempt_ordinal must be a non-negative integer');
  if (!Number.isInteger(rec.round) || rec.round < 1 || rec.round > 99) errors.push('round must be an integer 1..99');
  if (rec.stage !== ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS) errors.push(`stage must be ${JSON.stringify(ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS)}`);
  if (typeof rec.continue_debate !== 'boolean') errors.push('continue_debate must be a boolean');
  for (const k of FORBIDDEN_CONTROL_KEYS) {
    if (k in rec) errors.push(`forbidden report-semantic key on a typed control: ${k}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * §19 — bind a persisted / history-carried debate_continuation control to the
 * SAME durable authority that authored the sealed Debate synthesis. Every
 * identity field must agree with the app-owned `expected` identity AND the
 * resolved sealed invocation record / authoritative attempt metadata.
 *
 * @param {object} input
 * @param {object} input.control  the control record under test
 * @param {object} input.expected { storeId, projectId, taskId, invocationId,
 *   round, profileId, actorAlias, role }
 * @param {object} [input.sealedInvocationRecord]  from resolveAndVerifySealedReference
 * @param {object} [input.sealedAttemptMetadata]   the authoritative sealed attempt's artifact.json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDebateContinuationControlBinding({ control, expected, sealedInvocationRecord = null, sealedAttemptMetadata = null } = {}) {
  const errors = [];
  const shape = validateDebateContinuationControl(control);
  if (!shape.ok) return { ok: false, errors: shape.errors.map((e) => `control shape: ${e}`) };
  if (!expected || typeof expected !== 'object') return { ok: false, errors: ['expected identity is required'] };

  const pairs = [
    ['store_id', control.store_id, expected.storeId],
    ['project_id', control.project_id, expected.projectId],
    ['task_id', control.task_id, expected.taskId],
    ['invocation_id', control.invocation_id, expected.invocationId],
    ['round', control.round, expected.round],
    ['profile_id', control.profile_id, expected.profileId],
    ['actor_alias', control.actor_alias, expected.actorAlias],
  ];
  for (const [f, have, want] of pairs) {
    if (want !== undefined && have !== want) errors.push(`control.${f} ${JSON.stringify(have)} != expected ${JSON.stringify(want)}`);
  }
  if (expected.role !== undefined && control.role !== expected.role) errors.push(`control.role ${JSON.stringify(control.role)} != expected ${JSON.stringify(expected.role)}`);

  if (sealedInvocationRecord) {
    for (const [f, ck, ik] of [
      ['store_id', 'store_id', 'store_id'],
      ['project_id', 'project_id', 'project_id'],
      ['task_id', 'task_id', 'task_id'],
      ['invocation_id', 'invocation_id', 'invocation_id'],
      ['round', 'round', 'round'],
      ['profile_id', 'profile_id', 'profile_id'],
      ['actor_alias', 'actor_alias', 'actor_alias'],
      ['stage', 'stage', 'stage'],
    ]) {
      const cv = control[ck];
      const iv = sealedInvocationRecord[ik] ?? (ik === 'round' ? null : undefined);
      if (iv !== undefined && cv !== iv) errors.push(`control.${f} ${JSON.stringify(cv)} != resolved invocation.${ik} ${JSON.stringify(iv)}`);
    }
    // The control must bind to the invocation's AUTHORITATIVE sealed attempt.
    if (Number.isInteger(sealedInvocationRecord.authoritative_attempt)
      && control.attempt_ordinal !== sealedInvocationRecord.authoritative_attempt) {
      errors.push(`control.attempt_ordinal ${JSON.stringify(control.attempt_ordinal)} != invocation.authoritative_attempt ${JSON.stringify(sealedInvocationRecord.authoritative_attempt)}`);
    }
  }
  if (sealedAttemptMetadata) {
    for (const [f, ck, ak] of [
      ['store_id', 'store_id', 'store_id'],
      ['project_id', 'project_id', 'project_id'],
      ['task_id', 'task_id', 'task_id'],
      ['invocation_id', 'invocation_id', 'invocation_id'],
      ['attempt_ordinal', 'attempt_ordinal', 'attempt_ordinal'],
      ['execution_id', 'execution_id', 'execution_id'],
      ['round', 'round', 'round'],
      ['profile_id', 'profile_id', 'profile_id'],
      ['actor_alias', 'actor_alias', 'actor_alias'],
      ['stage', 'stage', 'stage'],
    ]) {
      const cv = control[ck];
      const av = sealedAttemptMetadata[ak] ?? (ak === 'round' ? null : undefined);
      if (av !== undefined && cv !== av) errors.push(`control.${f} ${JSON.stringify(cv)} != authoritative attempt.${ak} ${JSON.stringify(av)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Throw-style wrapper — code `DEBATE_CONTINUATION_CONTROL_BINDING_MISMATCH`. */
export function assertDebateContinuationControlBinding(input) {
  const v = validateDebateContinuationControlBinding(input);
  if (!v.ok) {
    throw new DebateContinuationControlError(
      `debate_continuation control does not bind to the sealed Debate synthesis execution: ${v.errors.join('; ')}`,
      'DEBATE_CONTINUATION_CONTROL_BINDING_MISMATCH',
      { errors: v.errors },
    );
  }
  return input.control;
}

/**
 * §29 — the engine rule. `effective_continue` is `true` ONLY when the bound
 * typed control says continue AND a round remains under
 * `min(council_control.debate.max_rounds, DEBATE_MAX_ROUNDS)`. At the hard cap
 * `effective_continue` is `false` regardless of the typed model control.
 * Report prose is never inspected.
 *
 * @returns {{ effectiveContinue: boolean, modelControlContinue: boolean,
 *             roundsRemaining: boolean, engineForcedStop: boolean }}
 */
// ---- P20.8R7 — strict same-execution Claude DIRECT_WRITE control envelope ----
//
// The smallest real, deterministically-parseable machine-control channel for
// a Claude DIRECT_WRITE Debate chair-synthesis call (report-invocation.mjs's
// trusted prompt asks Claude to write the complete synthesis to its assigned
// report.md, then return ONLY this envelope as its final visible response —
// see report-prompt.mjs). This is NOT a general semantic parser: it accepts
// exactly one fixed-prefix, fixed-shape, boolean-only payload and fails
// closed on anything else (missing, malformed JSON, wrong/extra keys,
// non-boolean value, or more/less than exactly one occurrence of the
// prefix). `report.md` bytes are never passed to this function — only the
// SEPARATE final-assistant-text channel the CLI bridge already returns
// alongside (never instead of) the file the model wrote.
export const DEBATE_CONTROL_ENVELOPE_PREFIX = 'DSH_DEBATE_CONTROL_V1:';

/**
 * Parse the strict `DSH_DEBATE_CONTROL_V1:{"continue_debate":<bool>}`
 * envelope out of a provider's final-assistant-text response. Throws
 * `DebateContinuationControlError` (fail closed) unless the ENTIRE
 * (trimmed) text is exactly one such envelope.
 *
 * @param {string} text  the provider's final visible response for this turn
 *   (never report.md bytes)
 * @returns {boolean} the parsed `continue_debate` value
 */
export function parseStrictDebateControlEnvelope(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DebateContinuationControlError('typed-control response is missing', 'DEBATE_CONTROL_ENVELOPE_MISSING');
  }
  const trimmed = text.trim();
  const occurrences = trimmed.split(DEBATE_CONTROL_ENVELOPE_PREFIX).length - 1;
  if (occurrences !== 1) {
    throw new DebateContinuationControlError(
      `typed-control response must contain exactly one ${DEBATE_CONTROL_ENVELOPE_PREFIX} envelope, found ${occurrences}`,
      'DEBATE_CONTROL_ENVELOPE_MULTIPLE_OR_MISSING',
      { occurrences },
    );
  }
  if (!trimmed.startsWith(DEBATE_CONTROL_ENVELOPE_PREFIX)) {
    throw new DebateContinuationControlError(
      'the typed-control envelope must be the ENTIRE final response, with no leading text before it',
      'DEBATE_CONTROL_ENVELOPE_NOT_BOUNDED',
    );
  }
  const jsonPart = trimmed.slice(DEBATE_CONTROL_ENVELOPE_PREFIX.length).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonPart);
  } catch (error) {
    throw new DebateContinuationControlError(`typed-control envelope payload is not valid JSON: ${error.message}`, 'DEBATE_CONTROL_ENVELOPE_INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DebateContinuationControlError('typed-control envelope payload must be a JSON object', 'DEBATE_CONTROL_ENVELOPE_INVALID_SHAPE');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'continue_debate') {
    throw new DebateContinuationControlError(`typed-control envelope must carry exactly one key "continue_debate", got ${JSON.stringify(keys)}`, 'DEBATE_CONTROL_ENVELOPE_INVALID_SHAPE');
  }
  if (typeof parsed.continue_debate !== 'boolean') {
    throw new DebateContinuationControlError('typed-control envelope continue_debate must be a boolean', 'DEBATE_CONTROL_ENVELOPE_NOT_BOOLEAN');
  }
  return parsed.continue_debate;
}

export function evaluateEffectiveContinuation({ control, round, maxRounds, hardCap }) {
  const modelControlContinue = control?.continue_debate === true;
  const ceiling = Math.min(
    Number.isInteger(maxRounds) ? maxRounds : hardCap,
    Number.isInteger(hardCap) ? hardCap : maxRounds,
  );
  const roundsRemaining = Number.isInteger(round) && round < ceiling;
  const effectiveContinue = modelControlContinue && roundsRemaining;
  return {
    effectiveContinue,
    modelControlContinue,
    roundsRemaining,
    engineForcedStop: modelControlContinue && !roundsRemaining,
  };
}
