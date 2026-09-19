/**
 * P20.3 §21–§26 — durable failure/cancellation reconciliation, crash/restart
 * recovery, the Task Final Artifact Gate, and the consumer revalidation
 * primitive.
 *
 * Authority: docs/architecture/P20_ARTIFACT_INTEGRITY_GATE.md §23–§26,
 * docs/P20/P20_3_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §21–§26, §32.
 *
 * Everything here operates on FRESH DISK state via store/workspace methods
 * (`freshRecord`, `freshManifest`, `commitSeal`, `settle`, `commitFinalRef`,
 * `openTaskById`) — never a cached in-memory snapshot (§5). Unknown provider
 * outcome is NEVER auto-replayed. A sealed authoritative attempt is reused
 * after restart, not re-executed.
 */

import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INTEGRITY_STATE, hashReportDescriptor, REPORT_SIZE_POLICY, createInvocationArtifactGate } from './artifact-integrity.mjs';
import { buildArtifactReference, validateArtifactReference, validateStageSealEntry, canonicalArtifactRefIdentity } from './artifact-schema.mjs';
import { assertContainedRegularFile } from './artifact-path-identity.mjs';
import { finalizeReportExecutiveLog } from './report-executive-log.mjs';
import { ARTIFACT_ROLE, ARTIFACT_STAGE } from './artifact-paths.mjs';
import { validateDebateContinuationControlBinding, evaluateEffectiveContinuation } from './debate-continuation-control.mjs';
import { parseDebateStageKey } from '../pm/council/debate-artifact-keys.mjs';
import { DEBATE_MAX_ROUNDS } from '../pm/council/council-contracts.mjs';

export class ArtifactRecoveryError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ArtifactRecoveryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Terminal execution states that reconcile to a DURABLE non-success
// lifecycle (§21). UNKNOWN_OUTCOME is handled separately (no replay).
const FAIL_MAP = {
  TIMEOUT: { lifecycle: 'FAILED', integrity: 'EXECUTION_FAILED' },
  PROVIDER_ERROR: { lifecycle: 'FAILED', integrity: 'EXECUTION_FAILED' },
  PROCESS_ERROR: { lifecycle: 'FAILED', integrity: 'EXECUTION_FAILED' },
  TRUNCATED_OR_INCOMPLETE: { lifecycle: 'FAILED', integrity: 'EXECUTION_FAILED' },
  CANCELLED: { lifecycle: 'CANCELLED', integrity: 'TASK_CANCELLED' },
};

/**
 * §21 — settle a RUNNING/DELIVERED invocation to a durable FAILED/CANCELLED
 * given KNOWN terminal evidence. Never seals, never selects authority,
 * never infers success from file existence. Idempotent.
 *
 * `terminalState` is one of TERMINAL_STATE. `UNKNOWN_OUTCOME` => a durable
 * FAILED state tagged UNKNOWN_PROVIDER_OUTCOME with an explicit no-replay
 * marker; the owner/upper policy decides any later action.
 */
export function reconcileFailedInvocation({ invocation, terminalState, reason = null }) {
  if (!invocation || typeof invocation.settle !== 'function') {
    throw new ArtifactRecoveryError('a P20.1 InvocationWorkspace is required', 'ARTIFACT_RECOVERY_BAD_INPUT');
  }
  if (terminalState === 'SUCCESS') {
    throw new ArtifactRecoveryError('reconcileFailedInvocation is not for SUCCESS — run the Invocation Artifact Gate + seal', 'ARTIFACT_RECOVERY_BAD_INPUT');
  }
  if (terminalState === 'UNKNOWN_OUTCOME') {
    return {
      ...invocation.settle({ terminalLifecycle: 'FAILED', integrityState: INTEGRITY_STATE.UNKNOWN_PROVIDER_OUTCOME, reason: reason ?? 'unknown provider outcome — NOT auto-replayed' }),
      replay: false,
    };
  }
  const m = FAIL_MAP[terminalState];
  if (!m) throw new ArtifactRecoveryError(`unrecognised non-success terminalState ${JSON.stringify(terminalState)}`, 'ARTIFACT_RECOVERY_BAD_INPUT');
  return invocation.settle({ terminalLifecycle: m.lifecycle, integrityState: m.integrity, reason });
}

/**
 * §16 — the full seal commit ordering, given a PASSED Invocation Artifact
 * Gate result. Steps: finalize artifact.json operational fields ->
 * (executive.log finalization is done by the caller with
 * finalizeReportExecutiveLog, which must succeed first) -> commit the
 * invocation seal (DELIVERED -> SEALED + authoritative_attempt) -> build a
 * sealed ArtifactReference -> record the stage seal on the task manifest.
 *
 * Returns the sealed ArtifactReference (validates with requireSealed:true).
 */
export function commitInvocationSeal({ store, task, invocation, attemptOrdinal, gateResult, stageKey, executiveLogFinalized = false, sealVersion = 'p20.3-1', now = () => new Date().toISOString() }) {
  if (!gateResult || gateResult.state !== INTEGRITY_STATE.ARTIFACT_PASS) {
    throw new ArtifactRecoveryError('commitInvocationSeal requires a PASSED Invocation Artifact Gate result', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  }
  if (executiveLogFinalized !== true) {
    // R7: the seal order requires executive.log finalization FIRST. The
    // caller (single-report-completion) proves it by passing this flag
    // after finalizeReportExecutiveLog() succeeds.
    throw new ArtifactRecoveryError('commitInvocationSeal: executive.log must be finalized before the invocation seal', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  }
  const sealedAt = now();

  // 5. finalize artifact.json operational fields (never authoritative_attempt).
  //    `executive_log_finalized: true` is the order marker commitSeal checks.
  invocation.finalizeAttempt(attemptOrdinal, {
    integrity_state: INTEGRITY_STATE.ARTIFACT_PASS,
    report_bytes: gateResult.bytes,
    report_sha256: gateResult.sha256,
    finished_at: gateResult.attemptMetadata.finished_at ?? sealedAt,
    terminal_state: gateResult.attemptMetadata.terminal_state ?? 'SUCCESS',
    size_policy_version: gateResult.sizePolicy.version,
    max_report_bytes: gateResult.sizePolicy.max_report_bytes,
    finalized_at: sealedAt,
    executive_log_finalized: true,
  });

  // 6/7. commit the invocation seal + authoritative_attempt (store method,
  // locked, fresh-read, DELIVERED -> SEALED only; re-verifies the attempt
  // is a finalized ARTIFACT_PASS/SUCCESS with the executive-log marker).
  const sealedRec = invocation.commitSeal({ ordinal: attemptOrdinal, sealVersion, sealedAt });

  // The sealed ArtifactReference — concrete identity + hash + bytes + sealed_at.
  const reference = buildArtifactReference({
    storeId: store.storeId,
    projectId: store.projectId,
    taskId: sealedRec.task_id,
    invocationId: sealedRec.invocation_id,
    attemptOrdinal,
    artifactRelpath: gateResult.attemptMetadata.report_relpath,
    sha256: gateResult.sha256,
    bytes: gateResult.bytes,
    sealedAt: sealedRec.seal?.sealed_at ?? sealedAt,
  }, { sealed: true });
  const rv = validateArtifactReference(reference, { requireSealed: true });
  if (!rv.ok) throw new ArtifactRecoveryError(`internal: built sealed ArtifactReference invalid: ${rv.errors.join('; ')}`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED, { errors: rv.errors });

  // 8. record the stage seal on the task manifest (store method, locked).
  if (task && typeof task.commitStageSeal === 'function' && stageKey) {
    task.commitStageSeal({
      stageKey,
      entry: {
        invocation_id: sealedRec.invocation_id,
        invocation_relpath: sealedRec.stage_relpath,
        attempt_ordinal: attemptOrdinal,
        integrity_state: INTEGRITY_STATE.ARTIFACT_PASS,
        sealed_ref: reference,
      },
    });
  }
  return { reference, sealedRecord: sealedRec };
}

// P20.3R R4/R5/R6 recorded-fact validators — never used to INVENT authority,
// only to reject a sealed record whose recorded facts are missing/malformed.
const IS_HEX_SHA256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const IS_ISO = (v) => typeof v === 'string' && v.length > 0 && !Number.isNaN(new Date(v).getTime());
const IS_NNI = (v) => Number.isInteger(v) && v >= 0;

/**
 * P20.3R R4/R5 — the ONE full sealed-reference authority + containment
 * verifier. Resolves the referenced task and invocation from DURABLE
 * metadata (never a caller-supplied object), binds the complete identity
 * chain, re-runs the platform-aware containment / regular-file /
 * reparse-escape policy, full-file descriptor-hashes the report, and
 * compares bytes + SHA256 to the sealed authority.
 *
 * @returns {{ verified: true, path, bytes, sha256, buffer, manifest, invocationRecord, attemptMetadata }}
 */
export function resolveAndVerifySealedReference({ store, reference, maxReportBytes = REPORT_SIZE_POLICY.maxReportBytes }) {
  const F = (msg, extra = {}) => { throw new ArtifactRecoveryError(msg, 'ARTIFACT_CONSUMER_VERIFY_FAILED', extra); };

  // 1. shape
  const rv = validateArtifactReference(reference, { requireSealed: true });
  if (!rv.ok) F(`not a valid sealed ArtifactReference: ${rv.errors.join('; ')}`, { errors: rv.errors });
  // 2. store / project
  if (reference.store_id !== store.storeId || reference.project_id !== store.projectId) F('ArtifactReference belongs to a different store/project');

  // 3. resolve + fresh-read the referenced TASK authority
  const task = store.openTaskById(reference.task_id);
  if (!task) F(`no task ${JSON.stringify(reference.task_id)} in this store`);
  const manifest = task.freshManifest();
  if (manifest.store_id !== reference.store_id || manifest.project_id !== reference.project_id || manifest.task_id !== reference.task_id) {
    F('task manifest identity does not match the ArtifactReference');
  }

  // 4. resolve + fresh-read the referenced INVOCATION authority (durable, by full id)
  let invocation;
  try { invocation = task.openInvocationById(reference.invocation_id); }
  catch (error) { F(`cannot resolve invocation ${JSON.stringify(reference.invocation_id)}: ${error.message}`, { cause: error.code }); }
  const rec = invocation.freshRecord();
  // 5. identity exact match
  if (rec.invocation_id !== reference.invocation_id || rec.task_id !== reference.task_id || rec.store_id !== reference.store_id || rec.project_id !== reference.project_id) {
    F('invocation.json identity does not match the ArtifactReference');
  }
  // 6/7. SEALED + authoritative attempt == reference.attempt_ordinal
  if (rec.lifecycle !== 'SEALED') F(`referenced invocation is not SEALED (lifecycle=${rec.lifecycle})`, { lifecycle: rec.lifecycle });
  if (rec.authoritative_attempt !== reference.attempt_ordinal) F(`reference.attempt_ordinal ${reference.attempt_ordinal} is not the authoritative attempt (${rec.authoritative_attempt})`);
  if (!rec.seal || rec.seal.authoritative_attempt !== rec.authoritative_attempt || rec.seal.integrity_state !== 'ARTIFACT_PASS' || !IS_ISO(rec.seal.sealed_at)) {
    F('invocation seal record is missing or inconsistent');
  }
  // R10: reference.sealed_at must be the SAME recorded authority fact as the
  // invocation seal record — not merely "a valid timestamp". No recompute,
  // no normalization.
  if (reference.sealed_at !== rec.seal.sealed_at) {
    F(`reference.sealed_at ${JSON.stringify(reference.sealed_at)} != recorded seal.sealed_at ${JSON.stringify(rec.seal.sealed_at)}`);
  }
  if (rec.integrity_state !== 'ARTIFACT_PASS') F('invocation integrity_state is not ARTIFACT_PASS');

  // 8. fresh-read the authoritative attempt artifact.json
  const meta = invocation.freshAttemptMetadata(reference.attempt_ordinal);
  // 9. attempt identity
  if (meta.store_id !== reference.store_id || meta.project_id !== reference.project_id || meta.task_id !== reference.task_id || meta.invocation_id !== reference.invocation_id || meta.attempt_ordinal !== reference.attempt_ordinal) {
    F('attempt artifact.json identity does not match the ArtifactReference');
  }
  // 9b. P20.8 PRE-R3 R3-2 — bind EVERY invariant physical/logical topology
  // field the resolved invocation record and the authoritative attempt
  // metadata BOTH carry. This is the ONE shared generic verifier; it must
  // not rely on a downstream specialized caller (e.g. Council/Debate's
  // `assertFinalTopologyBoundToInvocation`) to catch a schema-valid
  // artifact.json whose operational identity (role/stage/round/profile_id/
  // actor_alias) was rewritten while its report ref/hash still verify and
  // its parent invocation.json is untouched.
  {
    const topologyMismatches = [];
    for (const f of ['role', 'stage', 'profile_id', 'actor_alias']) {
      if (meta[f] !== rec[f]) topologyMismatches.push(`${f}: attempt=${JSON.stringify(meta[f])} invocation=${JSON.stringify(rec[f])}`);
    }
    if ((meta.round ?? null) !== (rec.round ?? null)) {
      topologyMismatches.push(`round: attempt=${JSON.stringify(meta.round ?? null)} invocation=${JSON.stringify(rec.round ?? null)}`);
    }
    if (topologyMismatches.length) {
      F(`authoritative attempt operational identity does not match its resolved invocation: ${topologyMismatches.join('; ')}`, { topologyMismatch: true, mismatches: topologyMismatches });
    }
  }
  // 10/11/12. relpath / sha256 / bytes recorded == reference
  if (meta.report_relpath !== reference.artifact_relpath) F(`artifact.json report_relpath ${JSON.stringify(meta.report_relpath)} != reference.artifact_relpath ${JSON.stringify(reference.artifact_relpath)}`);
  if (!IS_HEX_SHA256(meta.report_sha256) || meta.report_sha256 !== reference.sha256) F('artifact.json report_sha256 missing or != reference.sha256');
  if (!IS_NNI(meta.report_bytes) || meta.report_bytes !== reference.bytes) F('artifact.json report_bytes missing or != reference.bytes');
  // 13. integrity_state / terminal_state
  if (meta.integrity_state !== 'ARTIFACT_PASS') F('authoritative attempt integrity_state is not ARTIFACT_PASS');
  if (meta.terminal_state !== 'SUCCESS') F('authoritative attempt terminal_state is not SUCCESS');
  // R10: the authoritative attempt must still carry the finalized-seal
  // prerequisites that commitSeal() now requires — a corrupt/legacy-looking
  // SEALED parent record cannot bypass the current seal contract merely
  // because its report hash happens to match.
  if (typeof meta.finalized_at !== 'string' || !meta.finalized_at || !IS_ISO(meta.finalized_at)) {
    F('authoritative attempt has no valid finalized_at marker');
  }
  if (meta.executive_log_finalized !== true) {
    F('authoritative attempt executive_log_finalized is not true (executive.log was not finalized before seal)');
  }

  // 14. real containment / regular-file / reparse-escape (shared R8 primitive)
  const attemptDir = join(invocation.path, `attempt-${String(reference.attempt_ordinal).padStart(2, '0')}`);
  const reportAbs = assertContainedRegularFile({
    storeRoot: store.root,
    attemptDir,
    reportPath: resolve(store.root, ...String(reference.artifact_relpath).split('/')),
    lstatSync,
    existsSync,
    fail: (_family, message) => F(message),
  });

  // 15/16. full-file descriptor hash + compare to sealed authority
  let hashed;
  try { hashed = hashReportDescriptor(reportAbs, { maxReportBytes }); }
  catch (error) { F(`consumer hash failed: ${error.message}`, { cause: error.code }); }
  if (hashed.sha256 !== reference.sha256 || hashed.bytes !== reference.bytes) {
    F(`bytes/hash drift: on-disk ${hashed.bytes}b/${hashed.sha256} != sealed ${reference.bytes}b/${reference.sha256}`);
  }

  // 17. return the SAME verified buffer
  return { verified: true, path: reportAbs, bytes: hashed.bytes, sha256: hashed.sha256, buffer: hashed.buffer, manifest, invocationRecord: rec, attemptMetadata: meta };
}

/**
 * §26 — reusable consumer preflight. Thin wrapper over the full R4 verifier.
 * A caller-supplied `invocation`/`task` object is NOT accepted as a
 * substitute for reference resolution — everything is resolved from the
 * reference against fresh disk authority.
 *
 * @returns {{ verified: true, path: string, bytes: number, sha256: string, buffer: Buffer }}
 */
export function verifySealedArtifactReference({ store, reference, maxReportBytes = REPORT_SIZE_POLICY.maxReportBytes }) {
  const { verified, path, bytes, sha256, buffer } = resolveAndVerifySealedReference({ store, reference, maxReportBytes });
  return { verified, path, bytes, sha256, buffer };
}

const DEBATE_FINAL_STAGE_RE = /^debate::round-(\d{2})::chair-synthesis$/;

/**
 * P20.6R R2 — is `stageKey` a legal FINAL stage for this task's mode/control?
 * Operational-topology only; no report content is parsed.
 *   SINGLE                    → 'single'
 *   Council without Debate     → 'chair-council-synthesis'
 *   Council with Debate        → the highest-round 'debate::round-NN::chair-synthesis'
 */
function isLegalFinalStageKey(manifest, stageKey, allStageKeys) {
  const mode = manifest.mode;
  if (mode === 'single') return stageKey === 'single';
  if (mode === 'council') {
    const debateEnabled = manifest.council_control && manifest.council_control.debate
      && manifest.council_control.debate.enabled === true;
    if (!debateEnabled) return stageKey === 'chair-council-synthesis';
    const m = DEBATE_FINAL_STAGE_RE.exec(stageKey);
    if (!m) return false;
    const rounds = allStageKeys
      .map((k) => DEBATE_FINAL_STAGE_RE.exec(k))
      .filter(Boolean)
      .map((x) => Number(x[1]));
    return rounds.length > 0 && Number(m[1]) === Math.max(...rounds);
  }
  return false;
}

/**
 * P20.6R2 R5 (extended by P20.6R3 R7) — compute the legal final topology
 * `{ role, stage, round, profileId, maxRounds? }` the matched stage KEY
 * claims for this task's mode/control. Throws via `BIND` for an illegal key
 * or an unsupported mode. Pure — no filesystem, no report content.
 */
function computeLegalFinalTopology({ manifest, stageKey, BIND }) {
  if (manifest.mode === 'single') {
    return { role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, round: null, profileId: undefined };
  }
  if (manifest.mode === 'council') {
    const debateEnabled = manifest.council_control && manifest.council_control.debate && manifest.council_control.debate.enabled === true;
    if (!debateEnabled) {
      return { role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS, round: null, profileId: manifest.council_control?.chair_profile_id };
    }
    // Council + Debate — the manifest stage KEY names the round.
    const parsed = parseDebateStageKey(stageKey);
    if (!parsed || parsed.artifactStage !== ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS || parsed.actorAlias !== null) {
      BIND(`manifest stage key ${JSON.stringify(stageKey)} is not a legal Debate final key`);
    }
    const round = parsed.round;
    const maxRounds = manifest.council_control?.debate?.max_rounds;
    if (!Number.isInteger(maxRounds) || round < 1 || round > maxRounds) {
      BIND(`Debate final round ${round} is outside the persisted max_rounds ${JSON.stringify(maxRounds)}`);
    }
    return { role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round, profileId: manifest.council_control?.chair_profile_id, maxRounds };
  }
  BIND(`unsupported task mode ${JSON.stringify(manifest.mode)} for final authority topology binding`);
  return null;
}

/** Fail closed unless `{role,stage,round,profile_id}` is exactly the legal final topology. */
function assertMatchesLegalFinalTopology(label, subject, expected, BIND) {
  const round = subject.round ?? null;
  const expectedRound = expected.round ?? null;
  if (subject.role !== expected.role || subject.stage !== expected.stage || round !== expectedRound
    || (expected.profileId !== undefined && subject.profile_id !== expected.profileId)) {
    BIND(`${label} is not a legal final for this task (role=${JSON.stringify(subject.role)}, stage=${JSON.stringify(subject.stage)}, round=${JSON.stringify(round)}, profile_id=${JSON.stringify(subject.profile_id)})`);
  }
}

/**
 * P20.6R2 R5 / P20.6R3 R7-R8 — bind the LEGAL final stage key to BOTH the
 * fresh sealed `invocationRecord` AND the authoritative `attemptMetadata`
 * (`artifact.json`) `resolveAndVerifySealedReference()` actually resolved.
 *
 * A syntactically legal key string is not enough (R5): the resolved
 * invocation's own canonical role/stage/round/profile_id must be exactly
 * what that key means. Nor is the invocation record alone enough (R7): the
 * AUTHORITATIVE attempt's own operational identity (role/stage/round/
 * profile_id/actor_alias/execution chain) must agree EXACTLY with the
 * invocation it is sealed under, and independently satisfy the same legal
 * topology — closing a post-hoc `artifact.json` drift that keeps the report
 * ref/hash valid while changing its operational meaning.
 *
 * For a Debate final, the bound `debate_continuation` typed control is
 * validated with the ONE accepted P20.5 same-execution binding primitive
 * (`validateDebateContinuationControlBinding`) against BOTH the resolved
 * invocation and the authoritative attempt — including `control.execution_id
 * === attemptMetadata.execution_id` — BEFORE its terminal Boolean is
 * evaluated (R8). No report content is ever read; no extra model call.
 */
function assertFinalTopologyBoundToInvocation({ manifest, stageKey, invocationRecord: rec, attemptMetadata: am, BIND }) {
  const expected = computeLegalFinalTopology({ manifest, stageKey, BIND });

  assertMatchesLegalFinalTopology('the sealed final invocation', rec, expected, BIND);

  // R7 — the AUTHORITATIVE attempt's operational identity must agree EXACTLY
  // with the invocation it is sealed under (a corrupted artifact.json could
  // otherwise retain a valid report ref/hash while drifting its meaning).
  for (const f of ['store_id', 'project_id', 'task_id', 'invocation_id']) {
    if (am[f] !== rec[f]) BIND(`authoritative attempt.${f} ${JSON.stringify(am[f])} != resolved invocation.${f} ${JSON.stringify(rec[f])}`);
  }
  if (am.attempt_ordinal !== rec.authoritative_attempt) {
    BIND(`authoritative attempt.attempt_ordinal ${JSON.stringify(am.attempt_ordinal)} != invocation.authoritative_attempt ${JSON.stringify(rec.authoritative_attempt)}`);
  }
  for (const f of ['role', 'stage', 'profile_id', 'actor_alias']) {
    if (am[f] !== rec[f]) BIND(`authoritative attempt.${f} ${JSON.stringify(am[f])} != resolved invocation.${f} ${JSON.stringify(rec[f])}`);
  }
  if ((am.round ?? null) !== (rec.round ?? null)) {
    BIND(`authoritative attempt.round ${JSON.stringify(am.round ?? null)} != resolved invocation.round ${JSON.stringify(rec.round ?? null)}`);
  }
  // ...and independently satisfy the SAME legal final topology as the invocation.
  assertMatchesLegalFinalTopology('the authoritative attempt', am, expected, BIND);

  if (manifest.mode === 'council' && manifest.council_control?.debate?.enabled === true) {
    // R8 — Debate terminal legality. Bind FIRST via the accepted P20.5
    // same-execution primitive (never a weaker local re-check); only a
    // control that binds may then have its terminal Boolean evaluated.
    const control = rec.debate_continuation ?? null;
    if (!control) BIND(`Debate final synthesis round ${expected.round} has no bound typed continuation control`);
    const bindingExpected = {
      storeId: manifest.store_id,
      projectId: manifest.project_id,
      taskId: manifest.task_id,
      invocationId: rec.invocation_id,
      round: expected.round,
      profileId: manifest.council_control?.chair_profile_id,
      actorAlias: rec.actor_alias,
      role: 'chair',
    };
    const bv = validateDebateContinuationControlBinding({ control, expected: bindingExpected, sealedInvocationRecord: rec, sealedAttemptMetadata: am });
    if (!bv.ok) BIND(`Debate final synthesis typed continuation control does not bind to the sealed same-execution authority: ${bv.errors.join('; ')}`);

    const evalRes = evaluateEffectiveContinuation({ control, round: expected.round, maxRounds: expected.maxRounds, hardCap: DEBATE_MAX_ROUNDS });
    if (evalRes.effectiveContinue === true) {
      BIND(`Debate round ${expected.round} is not a legal terminal final — its bound typed continuation control legitimately warrants a further round (max_rounds=${expected.maxRounds})`);
    }
  }
}

/**
 * P20.6R R2 — the ONE shared app-owned source-task FINAL authority verifier.
 *
 * `TASK_FINAL { task_id }` / `LATEST_FINAL` MUST identify the *final authority
 * of the named source task*, not merely any independently valid sealed
 * artifact in the same store/project. Fresh-reads the source task manifest
 * and proves, without parsing any report body:
 *
 *   - manifest store/project/task identity == requested { store, taskId }
 *   - manifest.task_state === COMPLETED && artifact_gate_state === TASK_ARTIFACT_PASS
 *   - manifest.final_ref is a valid sealed ArtifactReference
 *   - final_ref.store_id/project_id/task_id === manifest identity  (no cross-task)
 *   - final_ref === exactly ONE committed manifest stage entry's sealed_ref
 *   - that stage entry is structurally sound (validateStageSealEntry)
 *   - that stage is a LEGAL final stage for the task mode/control
 *   - full resolveAndVerifySealedReference(final_ref) passes on disk
 *
 * @returns {{ manifest, finalRef, stageKey }}
 * @throws {ArtifactRecoveryError}
 *   ARTIFACT_CONTEXT_TASK_NOT_FOUND | ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE |
 *   ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED | ARTIFACT_CONSUMER_VERIFY_FAILED
 */
export function resolveAndVerifyTaskFinalArtifact({ store, taskId, maxReportBytes = REPORT_SIZE_POLICY.maxReportBytes }) {
  const BIND = (msg, extra = {}) => { throw new ArtifactRecoveryError(msg, 'ARTIFACT_CONTEXT_SOURCE_FINAL_BINDING_FAILED', { taskId, ...extra }); };
  if (!store || typeof store.openTaskById !== 'function') BIND('an ArtifactStore is required');
  if (typeof taskId !== 'string' || !taskId) {
    throw new ArtifactRecoveryError('a source task_id is required', 'ARTIFACT_CONTEXT_TASK_NOT_FOUND', { taskId });
  }

  let task;
  try { task = store.openTaskById(taskId); }
  catch (error) { throw new ArtifactRecoveryError(`opening source task ${JSON.stringify(taskId)} failed: ${error.message}`, 'ARTIFACT_CONTEXT_TASK_NOT_FOUND', { taskId, cause: error.code ?? null }); }
  if (!task) throw new ArtifactRecoveryError(`no task ${JSON.stringify(taskId)} in this artifact store`, 'ARTIFACT_CONTEXT_TASK_NOT_FOUND', { taskId });

  // P20.6R2 R6 — a task that EXISTS but whose manifest fails to read/validate
  // (e.g. a structurally malformed `final_ref`) is a known corrupt source, not
  // a genuine "not found". Report it in the SOURCE-FINAL-BINDING-FAILED family
  // so LATEST_FINAL candidate discovery never misreports it as absent and
  // silently prefers an older task instead.
  let manifest;
  try { manifest = task.freshManifest(); }
  catch (error) { BIND(`source task manifest unreadable/invalid: ${error.message}`, { cause: error.code ?? null }); }

  if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) BIND('source task manifest store/project identity mismatch');
  if (manifest.task_id !== taskId) BIND(`source task manifest task_id ${JSON.stringify(manifest.task_id)} != requested ${JSON.stringify(taskId)}`);
  if (typeof task.taskId === 'string' && task.taskId !== taskId) BIND(`source TaskWorkspace.taskId ${JSON.stringify(task.taskId)} != requested ${JSON.stringify(taskId)}`);

  if (manifest.task_state !== 'COMPLETED' || manifest.artifact_gate_state !== 'TASK_ARTIFACT_PASS'
    || manifest.final_ref === null || manifest.final_ref === undefined) {
    throw new ArtifactRecoveryError(
      `source task ${JSON.stringify(taskId)} is not a completed, gate-passed task with a final_ref `
      + `(task_state=${JSON.stringify(manifest.task_state)}, artifact_gate_state=${JSON.stringify(manifest.artifact_gate_state)}, final_ref=${manifest.final_ref ? 'present' : 'null'})`,
      'ARTIFACT_CONTEXT_SOURCE_NOT_COMPLETE', { taskId },
    );
  }

  const finalRef = manifest.final_ref;
  const rv = validateArtifactReference(finalRef, { requireSealed: true });
  if (!rv.ok) BIND(`manifest.final_ref is not a valid sealed ArtifactReference: ${rv.errors.join('; ')}`);
  if (finalRef.store_id !== manifest.store_id || finalRef.project_id !== manifest.project_id || finalRef.task_id !== manifest.task_id) {
    BIND(`manifest.final_ref identity (${finalRef.store_id}/${finalRef.project_id}/${finalRef.task_id}) does not belong to source task ${JSON.stringify(taskId)}`);
  }

  const stages = manifest.stages && typeof manifest.stages === 'object' && !Array.isArray(manifest.stages) ? manifest.stages : {};
  const finalKey = canonicalArtifactRefIdentity(finalRef);
  const matches = Object.entries(stages).filter(([, e]) => e && e.sealed_ref && canonicalArtifactRefIdentity(e.sealed_ref) === finalKey);
  if (matches.length !== 1) {
    BIND(`manifest.final_ref does not correspond to exactly one committed sealed stage of source task ${JSON.stringify(taskId)} (matched ${matches.length})`);
  }
  const [stageKey, entry] = matches[0];
  const sv = validateStageSealEntry(entry, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
  if (!sv.ok) BIND(`the final stage entry ${JSON.stringify(stageKey)} is structurally invalid: ${sv.errors.join('; ')}`);
  if (!isLegalFinalStageKey(manifest, stageKey, Object.keys(stages))) {
    BIND(`stage ${JSON.stringify(stageKey)} is not a legal FINAL stage for a ${JSON.stringify(manifest.mode)} task — final_ref points at the wrong topology`);
  }

  // The SAME full authority verifier every downstream consumer uses. A
  // generic topology-binding refusal (R3-2 above) is re-surfaced in THIS
  // function's own SOURCE_FINAL_BINDING_FAILED family — it is the same kind
  // of "this source task's claimed final authority does not actually bind
  // together" fact the specialized R7/R8 checks below report; every other
  // resolveAndVerifySealedReference failure (hash/containment/etc.)
  // propagates unchanged, exactly as documented above.
  let verified;
  try {
    verified = resolveAndVerifySealedReference({ store, reference: finalRef, maxReportBytes });
  } catch (error) {
    if (error && error.topologyMismatch === true) {
      BIND(`final_ref's authoritative attempt operational identity does not match its resolved invocation: ${error.message}`);
    }
    throw error;
  }

  // P20.6R2 R5 — a syntactically legal final key is not enough: bind it to
  // the FRESH sealed invocation's own canonical role/stage/round/profile_id
  // (and, for Debate, terminal typed-control legality).
  assertFinalTopologyBoundToInvocation({ manifest, stageKey, invocationRecord: verified.invocationRecord, attemptMetadata: verified.attemptMetadata, BIND });

  return { manifest, finalRef, stageKey };
}

/**
 * §23/§25 / R5 — the SINGLE Task Final Artifact Gate. Fresh-reads the
 * manifest, binds its identity, validates the stage entry, verifies the
 * stage `invocation_id` equals `sealed_ref.invocation_id`, then invokes the
 * SAME full sealed-reference authority/containment verifier (no weaker
 * hash-only path), and only then commits `final_ref` + COMPLETED.
 * Idempotent — a reopened task resolves the SAME final ref.
 *
 * For P20.3 the exercised topology is SINGLE only. Council/Debate branches
 * are NOT migrated here.
 */
export function runTaskFinalArtifactGate({ store, task, stageKey = 'single', maxReportBytes = REPORT_SIZE_POLICY.maxReportBytes }) {
  const manifest = task.freshManifest();
  if (manifest.transport_version !== 'artifact_v1') {
    throw new ArtifactRecoveryError('task transport_version is not artifact_v1', INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
  }
  if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) {
    throw new ArtifactRecoveryError('task manifest store/project identity mismatch', INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }
  const stage = manifest.stages?.[stageKey];
  if (!stage || !stage.sealed_ref) {
    throw new ArtifactRecoveryError(`stage ${JSON.stringify(stageKey)} has no sealed reference on the task manifest`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  }
  const ref = stage.sealed_ref;
  const rv = validateArtifactReference(ref, { requireSealed: true });
  if (!rv.ok) throw new ArtifactRecoveryError(`stage sealed_ref invalid: ${rv.errors.join('; ')}`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, { errors: rv.errors });
  if (ref.task_id !== manifest.task_id) throw new ArtifactRecoveryError('stage sealed_ref.task_id does not belong to this task', INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  if (stage.invocation_id !== ref.invocation_id) throw new ArtifactRecoveryError(`stage entry invocation_id ${JSON.stringify(stage.invocation_id)} != sealed_ref.invocation_id ${JSON.stringify(ref.invocation_id)}`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);

  // The SAME full authority verifier every downstream consumer uses.
  resolveAndVerifySealedReference({ store, reference: ref, maxReportBytes });

  // R12: name the stage the final ref must correspond to — the store method
  // enforces final_ref === manifest.stages[stageKey].sealed_ref.
  const finalManifest = task.commitFinalRef({ finalRef: ref, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: stageKey });
  return { finalRef: ref, manifest: finalManifest };
}

/**
 * §22/§32 / R6 / R9 / R13 — restart resume from disk. NEVER invents new
 * authority.
 *
 *   - R9: the task manifest is bound to `store` first; the invocation to
 *     resume is derived from DURABLE task/stage state (or an explicit
 *     `invocationId`) and resolved through `task.openInvocationById(...)` —
 *     the caller-supplied `invocation` is only an optional hint that MUST
 *     agree. A sealed invocation belonging to Task B can never finalize
 *     Task A.
 *   - R13: when `manifest.final_ref` already exists, ALREADY_COMPLETE is
 *     returned only after BOTH the full sealed-artifact authority check AND
 *     the task-level topology consistency check
 *     (`task_state`/`artifact_gate_state`/`stages[stageKey]` structurally
 *     valid and `sealed_ref === final_ref`).
 *   - R6: for a SEALED invocation without a finalized manifest, the recovery
 *     rebuilds the ArtifactReference from the RECORDED sealed facts
 *     (`meta.report_sha256`, `meta.report_bytes`, `rec.seal.sealed_at`) —
 *     never `new Date()`, never a freshly recomputed authority hash. Both
 *     the recorded hash AND the recorded byte count MUST match the file on
 *     disk. Missing recorded facts fail closed.
 *   - An existing stage sealed_ref must equal the reconstruction; a
 *     conflict fails closed.
 *   - An unsealed invocation is left for the owner/caller. Unknown provider
 *     outcome is never replayed.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @param {import('./artifact-store.mjs').TaskWorkspace} input.task
 * @param {string} [input.invocationId]  explicit invocation identity to resume
 * @param {import('./artifact-store.mjs').InvocationWorkspace} [input.invocation]  optional HINT only
 * @param {string} [input.stageKey]  default 'single'
 * @returns {{ action: 'NONE'|'FINALIZED_FROM_SEAL'|'ALREADY_COMPLETE', finalRef: object|null }}
 */
export function resumeSingleTaskFromDisk({ store, task, invocationId = null, invocation = null, stageKey = 'single' }) {
  const manifest = task.freshManifest();

  // R9: bind the task manifest to THIS store/project before any authority work.
  if (manifest.store_id !== store.storeId || manifest.project_id !== store.projectId) {
    throw new ArtifactRecoveryError(`task manifest store/project identity ${manifest.store_id}/${manifest.project_id} does not match store ${store.storeId}/${store.projectId}`, INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }

  if (manifest.final_ref) {
    // R13: task-level topology consistency — a valid sealed artifact from the
    // same task is NOT sufficient if the manifest's final topology is
    // internally inconsistent.
    if (manifest.task_state !== 'COMPLETED') {
      throw new ArtifactRecoveryError(`final_ref present but task_state is ${JSON.stringify(manifest.task_state)}, not COMPLETED`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
    }
    if (manifest.artifact_gate_state !== 'TASK_ARTIFACT_PASS') {
      throw new ArtifactRecoveryError(`final_ref present but artifact_gate_state is ${JSON.stringify(manifest.artifact_gate_state)}, not TASK_ARTIFACT_PASS`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID);
    }
    const stage = manifest.stages?.[stageKey];
    if (!stage) {
      throw new ArtifactRecoveryError(`final_ref present but stage ${JSON.stringify(stageKey)} entry is missing`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
    }
    const sv = validateStageSealEntry(stage, { storeId: manifest.store_id, projectId: manifest.project_id, taskId: manifest.task_id });
    if (!sv.ok) {
      throw new ArtifactRecoveryError(`final_ref present but stage ${JSON.stringify(stageKey)} entry is structurally invalid: ${sv.errors.join('; ')}`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, { errors: sv.errors });
    }
    if (JSON.stringify(stage.sealed_ref) !== JSON.stringify(manifest.final_ref)) {
      throw new ArtifactRecoveryError(`stage ${JSON.stringify(stageKey)} sealed_ref does not equal manifest.final_ref`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
    }
    // R6: full sealed-artifact authority (self-resolves task+invocation).
    resolveAndVerifySealedReference({ store, reference: manifest.final_ref });
    return { action: 'ALREADY_COMPLETE', finalRef: manifest.final_ref };
  }

  // ---- SEALED invocation without final_ref: reconstruct from recorded facts.
  // R9: derive the intended invocation identity from durable task/stage state
  // (or the explicit id); the caller-supplied `invocation` is a hint only.
  const stageEntry = manifest.stages?.[stageKey];
  const expectedInvocationId = invocationId
    ?? stageEntry?.invocation_id
    ?? (invocation && typeof invocation.invocationId === 'string' ? invocation.invocationId : null);
  if (!expectedInvocationId) {
    return { action: 'NONE', finalRef: null, reason: 'no durable stage/invocation identity to resume' };
  }
  if (invocation && invocation.invocationId !== expectedInvocationId) {
    throw new ArtifactRecoveryError(`caller-supplied invocation ${JSON.stringify(invocation.invocationId)} does not match the task's expected stage invocation ${JSON.stringify(expectedInvocationId)}`, INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }

  // R9: resolve the invocation from DURABLE task authority — never the caller
  // object. `openInvocationById` is task-scoped, so a Task B invocation id is
  // simply not found under Task A.
  let inv;
  try { inv = task.openInvocationById(expectedInvocationId); }
  catch (error) {
    throw new ArtifactRecoveryError(`cannot resolve invocation ${JSON.stringify(expectedInvocationId)} from task ${manifest.task_id}: ${error.message}`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID, { cause: error.code });
  }
  const rec = inv.freshRecord();

  // R9: the resolved invocation MUST be bound to this store/project/task and
  // be the expected identity before ANY authority reconstruction.
  if (rec.store_id !== store.storeId || rec.project_id !== store.projectId) {
    throw new ArtifactRecoveryError('resolved invocation store/project identity does not match the store', INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }
  if (rec.task_id !== manifest.task_id) {
    throw new ArtifactRecoveryError(`resolved invocation belongs to task ${JSON.stringify(rec.task_id)}, not ${JSON.stringify(manifest.task_id)}`, INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }
  if (rec.invocation_id !== expectedInvocationId) {
    throw new ArtifactRecoveryError('resolved invocation_id does not match the expected stage identity', INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }

  if (rec.lifecycle !== 'SEALED') {
    return { action: 'NONE', finalRef: null, lifecycle: rec.lifecycle };
  }

  // R6: reconstruct the stage sealed_ref from RECORDED authority facts, then
  // commit final_ref for the SINGLE topology.
  const reference = reconstructSealedStageRef({ store, task, invocation: inv, stageKey });
  task.commitFinalRef({ finalRef: reference, taskState: 'COMPLETED', gateState: 'TASK_ARTIFACT_PASS', expectedStageKey: stageKey });
  return { action: 'FINALIZED_FROM_SEAL', finalRef: reference };
}

/**
 * P20.4R R2/R3 — SYNCHRONOUSLY seal a DELIVERED-but-unsealed report stage
 * from the persisted attempt, after a crash between `recordDelivery` and the
 * Invocation Artifact Gate / seal. NO provider call, NO bounded repair (a
 * repair would be a replay). The gate is run once against the persisted
 * attempt (its real `execution_id` bound from `expected`); on any gate
 * failure this throws (fail closed) rather than repairing.
 *
 * Used from the durable workflow-state / artifact-state crash handshake
 * (CouncilStepWorkflowRunner.#artifactCrashHandshake), which must resolve a
 * RUNNING durable row synchronously.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @param {import('./artifact-store.mjs').TaskWorkspace} input.task
 * @param {import('./artifact-store.mjs').InvocationWorkspace} input.invocation
 * @param {number} input.attemptOrdinal
 * @param {string} input.stageKey
 * @param {object} input.expected  full app-owned identity incl. the REAL execution_id
 * @param {number} [input.maxReportBytes]
 * @param {() => string} [input.now]
 * @returns {{ sealedReference: object, sealedRecord: object }}
 */
export function sealDeliveredStageFromDisk({ store, task, invocation, attemptOrdinal, stageKey, expected, maxReportBytes, now = () => new Date().toISOString() }) {
  const gate = createInvocationArtifactGate(maxReportBytes ? { maxReportBytes } : {});
  const gateResult = gate({ store, invocation, attemptOrdinal, expected });
  finalizeReportExecutiveLog({
    logPath: gateResult.executiveLogPath,
    finalization: {
      integrity_state: INTEGRITY_STATE.ARTIFACT_PASS,
      final_report_bytes: gateResult.bytes,
      final_report_sha256: gateResult.sha256,
      repair_state: 'NONE',
      seal_version: 'p20.3-1',
      size_policy_version: gateResult.sizePolicy.version,
      max_report_bytes: gateResult.sizePolicy.max_report_bytes,
    },
  });
  const { reference, sealedRecord } = commitInvocationSeal({
    store, task, invocation, attemptOrdinal, gateResult, stageKey, executiveLogFinalized: true, now,
  });
  return { sealedReference: reference, sealedRecord };
}

/**
 * P20.4 §27 — the generic P20 stage-resume primitive, extracted from the
 * proven SINGLE recovery logic (R6). Given a SEALED authoritative invocation
 * that survived a crash before its stage/final metadata was committed,
 * reconstruct the stage's sealed `ArtifactReference` from RECORDED facts
 * only (`meta.report_sha256`, `meta.report_bytes`, `rec.seal.sealed_at` —
 * never `new Date()`, never a recomputed authority hash), re-verify
 * containment + BOTH recorded hash AND recorded bytes against the file on
 * disk, and ensure the task-manifest stage entry exists (idempotent; a
 * conflicting existing entry fails closed). NEVER invokes a provider.
 *
 * @param {object} input
 * @param {import('./artifact-store.mjs').ArtifactStore} input.store
 * @param {import('./artifact-store.mjs').TaskWorkspace} input.task
 * @param {import('./artifact-store.mjs').InvocationWorkspace} input.invocation  a SEALED invocation workspace
 * @param {string} input.stageKey  the manifest stage key for this stage
 * @returns {object} the reconstructed sealed ArtifactReference
 */
export function reconstructSealedStageRef({ store, task, invocation, stageKey }) {
  const rec = invocation.freshRecord();
  if (rec.store_id !== store.storeId || rec.project_id !== store.projectId) {
    throw new ArtifactRecoveryError('invocation store/project identity does not match the store', INTEGRITY_STATE.ARTIFACT_STORE_MISMATCH);
  }
  if (rec.lifecycle !== 'SEALED') {
    throw new ArtifactRecoveryError(`reconstructSealedStageRef requires a SEALED invocation (lifecycle=${rec.lifecycle})`, INTEGRITY_STATE.ARTIFACT_SEAL_FAILED, { lifecycle: rec.lifecycle });
  }
  const ordinal = rec.authoritative_attempt;
  if (!IS_NNI(ordinal)) throw new ArtifactRecoveryError('SEALED invocation has no valid authoritative_attempt', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (!rec.seal || rec.seal.authoritative_attempt !== ordinal || !IS_ISO(rec.seal.sealed_at) || !rec.seal.seal_version || rec.seal.integrity_state !== 'ARTIFACT_PASS') {
    throw new ArtifactRecoveryError('SEALED invocation seal record is missing or inconsistent', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  }
  if (rec.integrity_state !== 'ARTIFACT_PASS') throw new ArtifactRecoveryError('SEALED invocation integrity_state is not ARTIFACT_PASS', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);

  let meta;
  try { meta = invocation.freshAttemptMetadata(ordinal); }
  catch (error) { throw new ArtifactRecoveryError(`sealed attempt metadata unreadable during resume: ${error.message}`, INTEGRITY_STATE.ARTIFACT_METADATA_INVALID); }
  if (meta.terminal_state !== 'SUCCESS') throw new ArtifactRecoveryError('sealed authoritative attempt terminal_state is not SUCCESS', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (meta.integrity_state !== 'ARTIFACT_PASS') throw new ArtifactRecoveryError('sealed authoritative attempt integrity_state is not ARTIFACT_PASS', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (!IS_HEX_SHA256(meta.report_sha256)) throw new ArtifactRecoveryError('sealed attempt has no recorded report_sha256; refusing to invent authority', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (!IS_NNI(meta.report_bytes)) throw new ArtifactRecoveryError('sealed attempt has no recorded report_bytes; refusing to invent authority', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (typeof meta.report_relpath !== 'string' || !meta.report_relpath) throw new ArtifactRecoveryError('sealed attempt has no recorded report_relpath', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (typeof meta.finalized_at !== 'string' || !meta.finalized_at) throw new ArtifactRecoveryError('sealed attempt has no finalization marker', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  if (meta.executive_log_finalized !== true) throw new ArtifactRecoveryError('sealed attempt executive_log_finalized is not true', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);

  const attemptDir = join(invocation.path, `attempt-${String(ordinal).padStart(2, '0')}`);
  const reportAbs = assertContainedRegularFile({
    storeRoot: store.root, attemptDir,
    reportPath: resolve(store.root, ...String(meta.report_relpath).split('/')),
    lstatSync, existsSync,
    fail: (_f, message) => { throw new ArtifactRecoveryError(message, INTEGRITY_STATE.REPORT_OUTSIDE_WORKSPACE); },
  });
  const hashed = hashReportDescriptor(reportAbs, { maxReportBytes: REPORT_SIZE_POLICY.maxReportBytes });
  if (hashed.sha256 !== meta.report_sha256 || hashed.bytes !== meta.report_bytes) {
    throw new ArtifactRecoveryError(`sealed report drifted during resume: on-disk ${hashed.bytes}b/${hashed.sha256} != recorded ${meta.report_bytes}b/${meta.report_sha256}`, INTEGRITY_STATE.REPORT_HASH_FAILED);
  }

  const reference = buildArtifactReference({
    storeId: store.storeId, projectId: store.projectId, taskId: rec.task_id, invocationId: rec.invocation_id,
    attemptOrdinal: ordinal, artifactRelpath: meta.report_relpath,
    sha256: meta.report_sha256, bytes: meta.report_bytes, sealedAt: rec.seal.sealed_at,
  }, { sealed: true });

  const manifest = task.freshManifest();
  const existingStage = manifest.stages?.[stageKey]?.sealed_ref;
  if (existingStage && JSON.stringify(existingStage) !== JSON.stringify(reference)) {
    throw new ArtifactRecoveryError('existing stage sealed_ref conflicts with the reconstructed authoritative reference', INTEGRITY_STATE.ARTIFACT_SEAL_FAILED);
  }
  if (!existingStage) {
    task.commitStageSeal({ stageKey, entry: { invocation_id: rec.invocation_id, invocation_relpath: rec.stage_relpath, attempt_ordinal: ordinal, integrity_state: INTEGRITY_STATE.ARTIFACT_PASS, sealed_ref: reference } });
  }
  return reference;
}
