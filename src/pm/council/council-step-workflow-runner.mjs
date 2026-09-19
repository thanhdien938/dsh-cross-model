import { canonicalizationDiagnostic } from '../output-canonicalization/gateway.mjs';
import { rawOutputEvidence } from '../production-pm-backend-registry.mjs';
/**
 * P7 — CouncilStepWorkflowRunner.
 *
 * Implements the exact `workflowRunner` contract DurablePmRuntime already
 * requires (`run(spec)` / `result(id)` — src/pm/durable-pm-runtime.mjs) so a
 * council rides the SAME durable turn machine, claim/fence worker, and
 * restart recovery as any single-PM WORKFLOW decision — no new coordination
 * code, no new schema (see council-contracts.mjs's file header).
 *
 * Every council step (chair_plan / participant_report / participant_critique
 * / chair_synthesis) is executed as exactly ONE single-shot PM decide() call
 * against the real per-profile production driver (Part U: read-only,
 * analysis-only — a council step NEVER loops and NEVER accepts a
 * WORKFLOW/PEER_EXCHANGE/AWAIT_OWNER decision from a participant or chair;
 * only `finish` is honored).
 *
 * Failure handling (Part H/I): a step that fails for ANY reason (backend
 * unavailable, non-finish decision, empty output, thrown error, invalid
 * council-step schema) is reported as a workflow outcome with
 * `status: 'completed'` and `finalResult.handoff.ok === false` — NEVER as a
 * failed workflow outcome. This is deliberate: a single participant failing
 * must not fail the whole PM run (DurablePmRuntime fails the entire run on
 * a non-completed workflow outcome). Whether the council as a whole can
 * still proceed is a decision owned entirely by CouncilChairDriver, which
 * reads `handoff.ok`.
 *
 * P7-R0.2 (M02): a real live chair_plan reproduction (Claude Code 2.1.235,
 * real dsh-p6-test-b) found the production parser correctly, and strictly,
 * rejecting a real backend response that was a complete, correct decision
 * object immediately followed by exactly one stray extra `}` — a genuine
 * model-sampling artifact on this specific 3-level-nested shape, not a
 * parser bug (docs/p7/05_P7_REAL_MODEL_CONTRACT_FINDINGS.md). Prompt/
 * response-constraint hardening (production-pm-backend-registry.mjs's
 * renderRequest()/constrain()) measurably reduces but does not eliminate
 * this — it is inherent sampling noise on a non-deterministic model, not
 * something a stricter prompt alone can guarantee away. The parser itself
 * is NOT weakened (M09/Part F forbidden fixes are unchanged: no heuristic
 * extraction, no brace-balancing, no silent repair). Instead, retry budget
 * is widened from exactly one attempt to AT MOST ONE retry (two attempts
 * total), and ONLY for `PM_DECISION_PARSE_FAILED` specifically — the one
 * failure class this live evidence attributes to transient sampling noise
 * on an otherwise well-specified contract, never for
 * `PM_DECISION_EMPTY_OUTPUT` (a real compliance failure, not noise — M09
 * must still fail closed on the first attempt) or a genuinely unavailable
 * backend (retrying that cannot help and would just look like it is
 * papering over a real problem). This retry is fully internal to one
 * step's execution, before any durable commit — a step is still, from
 * DurablePmRuntime's perspective, ONE call producing ONE outcome; no new
 * durable state, no change to council topology, no parallelism.
 *
 * P10-R0.1 (Part A-G): a real live chair_plan run
 * (docs/p10/02_COUNCIL_PARTICIPANT_ID_CONTRACT.md) had the chair backend
 * return `live1-opencode-pm_note` as a `participant_instructions` key
 * instead of the owner-selected `live1-opencode-pm`. Root cause: the
 * CHAIR's own JSON generation mangled an opaque identifier — never a parser
 * bug (`validateStepData` below already, correctly, rejected it with
 * `COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION`). The strict
 * validator is UNCHANGED and stays fail-closed (no fuzzy/prefix/suffix
 * matching, ever). What's new is a SECOND, SEPARATE, bounded repair layer
 * (`#attemptChairPlan`) that sits above the per-call parse-retry loop
 * below: exactly ONE repair re-prompt, ONLY for a chair_plan step, ONLY
 * when the schema failure is specifically about the participant-instruction
 * KEYS (missing/unknown/empty — never `critique_focus`/`synthesis_focus`,
 * which are content quality, not an identifier-contract violation). A
 * second invalid result after the repair fails closed with a typed error —
 * no unbounded loop, no silent success downgrade, participants are never
 * spawned before a plan validates.
 *
 * P10-R0.1.1 (Part A-H): a real owner T1 retest
 * (task-D5PT4CbNpjeUamnegQDN6kvM34w3NMdo) failed one layer EARLIER than the
 * R0.1 bug — both real chair_plan Claude invocations failed at
 * `parseDecision()` itself (`PM_DECISION_PARSE_FAILED`), so
 * `validateStepData` below was never even reached, and the R0.1
 * participant-id repair path never ran. The strict parser
 * (production-pm-backend-registry.mjs's `parseDecision()`) is UNCHANGED —
 * still no heuristic salvage. What changed here is diagnostic depth: the
 * SAME sanitized structural facts `parseDecision()`'s failure path already
 * computed (bytes/first-char/last-char/fullJson/jsonFence — previously sent
 * ONLY to the separate BackendExecutionObserver stdout-sentinel channel)
 * now travel with the thrown error (`error.diagnostics`/
 * `error.parseSubreason`) and are recorded per REAL backend attempt — see
 * `#decideOnce()` below, which also now strengthens the existing bounded
 * (MAX_PARSE_ATTEMPTS=2, unchanged bound) generic parse-retry with a
 * `buildParseRepairPrompt()` re-prompt naming the actual failure category,
 * instead of blindly re-asking with the byte-identical prompt.
 */

import { antigravityParticipantSchemaRequest } from './participant-json-schema.mjs';
import { createPmRequest } from '../pm-contracts.mjs';
import { CouncilValidationError } from './council-contracts.mjs';
// P20.4R R1/R2 — the artifact_v1 report-stage executor + recovery primitives.
// These are report-CONTENT-plane only; none of them touch parseDecision /
// canonicalizer / validateStepData / semantic repair.
import { runCouncilArtifactStage, runDebateArtifactStage, councilStageInvocationId } from './council-artifact-orchestrator.mjs';
import { councilStageKey } from './council-artifact-stage-keys.mjs';
import { debateStageKey, debateStageInvocationId, DEBATE_ARTIFACT_STAGES } from './debate-artifact-keys.mjs';
import { buildArtifactStepFailure, COUNCIL_STEP_EXECUTION_STATE, validateCouncilArtifactStepBinding, isDebateArtifactStepKind } from './council-artifact-step-outcome.mjs';
import { expectedCouncilArtifactStepIdentity, expectedArtifactStepIdentity, councilArtifactStageForStepKind, debateArtifactStageForStepKind } from './council-artifact-step-identity.mjs';
import { validateDebateContinuationControlBinding } from '../../artifacts/debate-continuation-control.mjs';
import { reconstructSealedStageRef, resolveAndVerifySealedReference, sealDeliveredStageFromDisk } from '../../artifacts/artifact-recovery.mjs';
import { deriveActorAlias, actorAliasFor, ARTIFACT_ROLE } from '../../artifacts/artifact-paths.mjs';
import { buildArtifactStepSuccess } from './council-artifact-step-outcome.mjs';
import { buildChairPlanRepairPrompt, buildParseRepairPrompt, buildParticipantSemanticRepairPrompt } from './council-prompts.mjs';
import { validateEvidence } from './workspace-evidence-contract.mjs';
import { buildChairPlanJsonSchema, CHAIR_PLAN_SCHEMA_KIND, CHAIR_PLAN_SCHEMA_VERSION } from './council-chair-plan-schema.mjs';
import { resolveExecutionOptions, executionStageForCouncilStep, EXECUTION_STAGE } from '../pm-execution-timeout-policy.mjs';
import { nowUtc } from '../../bus/envelopes.mjs';

// P15-REM-R2-A/B (P15-C-001, docs/p15-rem/03_*.md): the typed reason code a
// council step is reported with when its durable step record survives a
// process restart in the ambiguous "STARTED but never durably completed"
// state. This is NEVER a real backend/validation failure — it means the
// process that was executing this exact step (chair_plan / participant_report
// / participant_critique / chair_synthesis) died before recording an outcome,
// and no NEW process can know whether the underlying provider call actually
// finished. Every council step is read-only/analysis-only (file header
// above), so there is no external side effect to protect against replaying —
// but DSH still never blindly reruns an ambiguous provider call (mission
// invariant). Reported through the EXACT SAME `status:'completed'`/
// `handoff.ok:false` shape a genuine step failure already uses (Part H/I
// below) so 100% of existing failure-handling machinery (participant
// continuation policy, chair-plan-ends-council policy, summary.md/council.json
// rendering) applies unchanged — no new PM-level recovery state was needed.
export const COUNCIL_STEP_RECONCILE_REASON = 'COUNCIL_STEP_RECONCILE_REQUIRED:NO_DURABLE_OUTCOME_AFTER_RESTART';

const REASON_MAX = 240;
// One retry, only for a transport/parser-layer parse failure — see the
// file-level P7-R0.2 docstring above for why this bound and this one
// failure class specifically.
const MAX_PARSE_ATTEMPTS = 2;
// P10-R0.1 Part E: at most one repair re-prompt for a chair_plan whose
// participant-instruction KEYS were invalid — a wholly separate, outer
// bound from MAX_PARSE_ATTEMPTS above (which governs transport/parse noise
// within a single decide() call, not this semantic repair).
const MAX_CHAIR_PLAN_ATTEMPTS = 2;
// The three chair_plan schema-error classes that are about the
// participant-instruction KEY CONTRACT specifically (Part D/E/F) — never
// WRONG_DATA_TYPE, MISSING_CRITIQUE_FOCUS, or MISSING_SYNTHESIS_FOCUS,
// which are content-quality failures a repair prompt must not paper over.
const PARTICIPANT_KEY_ISSUE_CODES = new Set([
  'MISSING_PARTICIPANT_INSTRUCTION',
  'UNKNOWN_PARTICIPANT_INSTRUCTION',
  'EMPTY_PARTICIPANT_INSTRUCTION',
]);

// DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING (Implementation B): exactly ONE
// bounded semantic repair re-prompt for the read-only Council/Debate
// PARTICIPANT semantic steps — see the live failure trail
// (MISSING_ANALYSIS -> NO_VALID_EVIDENCE_ENTRIES -> WRONG_DATA_TYPE:missing,
// all with healthy transport/parseDecision) and the buildParticipantSemanticRepairPrompt()
// docstring in council-prompts.mjs for the full safety contract. Eligibility
// is structural, never inferred from content: parsed-finish decisions only
// (`validated.reason` starts with the typed `COUNCIL_` prefix — transport
// errors, timeouts, parse failures, NON_FINISH_DECISION, and EMPTY_OUTPUT
// all start with something else and are therefore structurally excluded),
// read-only participant steps only (chair/debate-chair kinds are absent from
// the set; the implementation participant's mutation-capable step is
// explicitly excluded via `isImplementationParticipant !== true`). The
// repair reuses #decideOnce (same profile/model; its own pre-existing
// MAX_PARSE_ATTEMPTS transport-retry bound is unchanged machinery shared
// with every attempt), re-runs the EXACT same #validateDecideResult, and a
// still-invalid repair leaves the participant FAILED — no third attempt,
// no validator weakening, no fabrication. The Antigravity CLI's advertised
// `--json-schema` flag is deliberately NOT enabled here (documented but
// never DSH-live-validated — a separate future lane, see the capsule note
// in production-pm-backend-registry.mjs).
const PARTICIPANT_SEMANTIC_REPAIR_STEP_KINDS = new Set(['participant_report', 'participant_critique', 'debate_response']);

function isParticipantKeyIssue(reason) {
  if (typeof reason !== 'string') return false;
  const [, code] = reason.split(':');
  return PARTICIPANT_KEY_ISSUE_CODES.has(code);
}

/** Extract the comma-separated id list from a `...:CODE:id1,id2` reason string, if present. */
function reasonIds(reason) {
  if (typeof reason !== 'string') return [];
  const parts = reason.split(':');
  if (parts.length < 3) return [];
  return parts[2].split(',').map((s) => s.trim()).filter(Boolean);
}

function sanitizeReason(error) {
  const raw = error?.code ?? error?.message ?? 'COUNCIL_STEP_FAILED';
  return String(raw).slice(0, REASON_MAX);
}

// P10-R0.1.2 Part P: bounded `structured_output` evidence attached to a
// chair_plan outcome's handoff — the exact shape council.json surfaces.
// Also summarizes explicitly enabled Antigravity participant schemas;
// never persists the schema or prompt.
function structuredOutputSummary(spec, profile, attempts) {
  const native = antigravityParticipantSchemaRequest(spec, profile);
  if (native) return { requested: true, provider: native.provider, mode: native.mode, schema_kind: native.kind, applied: attempts.some(a => a.structured_output_applied === true) };
  if (spec.stepKind !== 'chair_plan' || profile.product !== 'claude-code') return null;
  const last = attempts[attempts.length - 1] ?? null;
  return Object.freeze({ requested: true, provider: profile.product, schema_kind: CHAIR_PLAN_SCHEMA_KIND, present: last?.structured_output_present === true });
}

// Part G/H: semantic validation of a compliant `finish` decision's `data`
// payload, per council step kind. This runs AFTER the production parser
// has already accepted the decision as valid JSON with a non-empty
// `output` (M09) — it catches the case Part H calls out explicitly:
// `{"type":"finish","output":"ok"}` with no (or the wrong) structured
// council data must never count as a successful step. Distinguishing this
// from a transport/parser failure (Part N) is the reason its `reason` codes
// are named `COUNCIL_..._INVALID`, never `PM_DECISION_PARSE_FAILED`/
// `NON_FINISH_DECISION`/etc.
function isNonEmptyString(value) { return typeof value === 'string' && value.trim() !== ''; }
function isStringArray(value) { return Array.isArray(value); }

// DSH-ANTIGRAVITY-COUNCIL-PARTICIPANT-CONTRACT (T5 live evidence
// task-y2dkRWx6CIrY4mNulAVSk476ZxTlf52D, 2026-09-07): the real Antigravity
// participant_report reached parseDecision() successfully (a `finish`
// decision, non-empty `output`, PARSER_RESULT OK) and its `data.type` was
// exactly `council_report`, yet validateStepData() rejected it with
// COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS — and the durable
// record carried NO structural facts about the rejected `data` payload at
// all (only the validator reason string), making it impossible to
// distinguish after the fact whether `analysis` was absent, empty, renamed,
// mis-nested, or a non-string type. This is the same sanitized-diagnostics
// philosophy as parseDiagnostics() (production-pm-backend-registry.mjs):
// bounded, CONTENT-FREE shape facts only — key names, JSON types, string/
// array lengths, nested key names — never a field VALUE. This never widens
// what validateStepData() accepts (fail-closed discipline unchanged); it
// only records what its failure path already knew.
const DATA_SHAPE_KEY_LIMIT = 32;
const DATA_SHAPE_NESTED_KEY_LIMIT = 16;
export function dataShapeSummary(data, { outputLength = null } = {}) {
  const summary = { output_length: outputLength, data_present: false, data_value_type: null, data_type: null, key_count: 0, keys: [], keys_truncated: false, fields: {} };
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    summary.data_value_type = data === undefined ? 'undefined' : data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    return summary;
  }
  const keys = Object.keys(data);
  summary.data_present = true;
  summary.data_type = typeof data.type === 'string' ? data.type : null;
  summary.key_count = keys.length;
  summary.keys_truncated = keys.length > DATA_SHAPE_KEY_LIMIT;
  summary.keys = keys.slice(0, DATA_SHAPE_KEY_LIMIT);
  const fields = {};
  for (const k of summary.keys) {
    const v = data[k];
    const entry = { type: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v };
    if (typeof v === 'string') entry.length = v.length;
    else if (Array.isArray(v)) {
      entry.length = v.length;
      entry.element_types = [...new Set(v.slice(0, 8).map((x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x)))];
    } else if (v && typeof v === 'object') {
      const nestedKeys = Object.keys(v);
      entry.key_count = nestedKeys.length;
      entry.keys = nestedKeys.slice(0, DATA_SHAPE_NESTED_KEY_LIMIT);
    }
    fields[k] = entry;
  }
  summary.fields = fields;
  return summary;
}

// Council/Debate WORKSPACE_READ remediation (docs/evidence/
// DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §15): a `participant_
// report`/`debate_response` step whose council declared
// `workspace_requirement:'READ'` must additionally carry a valid `evidence`
// array (workspace-evidence-contract.mjs) — a plain, otherwise-well-formed
// report with ZERO repository evidence is now a validation FAILURE
// (`...MISSING_EVIDENCE`/`...NO_VALID_EVIDENCE_ENTRIES`/`...TOO_MANY_
// EVIDENCE_ENTRIES`), which reuses council-chair-driver.mjs's existing
// failed-participant/degraded-disclosure machinery unchanged — no new
// "insufficient evidence" override needed there (Part 16: "chair cannot
// turn missing participant evidence into substantive PASS" falls out of
// this for free, since a report with no valid evidence never becomes a
// `successfulReports` entry in the first place).
//
// A no-op for `workspace_requirement:'NONE'` (every pre-existing council) —
// `data.evidence` is never even inspected, so a legacy report/response with
// no `evidence` field at all (every one of them) validates exactly as
// before this wave.
function checkWorkspaceEvidence(spec, data, { repoPath }) {
  if (spec.workspaceRequirement !== 'READ') return { error: null, diagnostics: null };
  // Gap B: when the council supplied an explicit workspace_evidence_paths
  // manifest, this step's own spec carries it (council-chair-driver.mjs's
  // #workflow()/#debateWorkflow()) — restrict acceptable evidence to
  // EXACTLY that owner-authored set. Absent (every pre-Gap-B/manifest-less
  // READ council), `allowedPaths` stays null and any real, in-root,
  // non-denied, hash-verified path is accepted, unchanged.
  const allowedPaths = Array.isArray(spec.workspaceEvidencePaths) && spec.workspaceEvidencePaths.length
    ? new Set(spec.workspaceEvidencePaths)
    : null;
  // Final stabilization patch (§17/§18): bind evidence-hash validation to
  // the SAME authoritative packet snapshot this step's own prompt embedded
  // (council-chair-driver.mjs threads it through as `workspaceEvidenceHashes`)
  // rather than re-reading the live filesystem — "evidence validation must
  // match what model saw". `null` (no snapshot supplied — every pre-
  // stabilization caller/test) preserves the original live-disk-read
  // fallback inside validateEvidence() byte-for-byte.
  const authoritativeHashes = spec.workspaceEvidenceHashes && typeof spec.workspaceEvidenceHashes === 'object'
    ? spec.workspaceEvidenceHashes
    : null;
  const result = validateEvidence(data.evidence, { repoPath, allowedPaths, authoritativeHashes });
  // DSH-COUNCIL-EVIDENCE-DROP-DIAGNOSTICS: the bounded, content-free drop
  // histogram validateEvidence() now always returns (counts + typed reason
  // identifiers only — never a path/hash/claim value). Returned on BOTH
  // branches; only the FAILURE branch persists it (see #validateDecideResult).
  if (!result.ok) {
    const kindPrefix = spec.stepKind === 'debate_response' ? 'COUNCIL_DEBATE_RESPONSE_INVALID' : 'COUNCIL_PARTICIPANT_REPORT_INVALID';
    return { error: `${kindPrefix}:${result.reason}`, diagnostics: result.diagnostics };
  }
  return { error: null, diagnostics: result.diagnostics, sanitizedFields: { evidence: result.entries } };
}

function validateStepData(spec, data, { repoPath = null } = {}) {
  const { stepKind } = spec;
  if (stepKind === 'chair_plan') {
    if (data?.type !== 'council_plan') return { error: `COUNCIL_CHAIR_PLAN_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    const instructions = data.participant_instructions;
    if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) return { error: 'COUNCIL_CHAIR_PLAN_INVALID:MISSING_PARTICIPANT_INSTRUCTIONS' };
    const expected = Array.isArray(spec.participantProfileIds) ? spec.participantProfileIds : [];
    const actualKeys = Object.keys(instructions);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actualKeys);
    const missing = expected.filter((id) => !actualSet.has(id));
    const extra = actualKeys.filter((id) => !expectedSet.has(id));
    if (missing.length) return { error: `COUNCIL_CHAIR_PLAN_INVALID:MISSING_PARTICIPANT_INSTRUCTION:${missing.join(',')}` };
    if (extra.length) return { error: `COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION:${extra.join(',')}` };
    for (const id of expected) {
      if (!isNonEmptyString(instructions[id])) return { error: `COUNCIL_CHAIR_PLAN_INVALID:EMPTY_PARTICIPANT_INSTRUCTION:${id}` };
    }
    if (!isNonEmptyString(data.critique_focus)) return { error: 'COUNCIL_CHAIR_PLAN_INVALID:MISSING_CRITIQUE_FOCUS' };
    if (!isNonEmptyString(data.synthesis_focus)) return { error: 'COUNCIL_CHAIR_PLAN_INVALID:MISSING_SYNTHESIS_FOCUS' };
    return { error: null };
  }
  if (stepKind === 'participant_report') {
    if (data?.type !== 'council_report') return { error: `COUNCIL_PARTICIPANT_REPORT_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    if (!isNonEmptyString(data.analysis)) return { error: 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS' };
    if (!isNonEmptyString(data.recommendation)) return { error: 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_RECOMMENDATION' };
    if (!isStringArray(data.risks)) return { error: 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_RISKS' };
    if (!isStringArray(data.uncertainties)) return { error: 'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_UNCERTAINTIES' };
    return checkWorkspaceEvidence(spec, data, { repoPath });
  }
  if (stepKind === 'participant_critique') {
    if (data?.type !== 'council_critique') return { error: `COUNCIL_PARTICIPANT_CRITIQUE_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    if (!isStringArray(data.criticisms)) return { error: 'COUNCIL_PARTICIPANT_CRITIQUE_INVALID:MISSING_CRITICISMS' };
    if (!isStringArray(data.agreements)) return { error: 'COUNCIL_PARTICIPANT_CRITIQUE_INVALID:MISSING_AGREEMENTS' };
    if (!isNonEmptyString(data.revised_recommendation)) return { error: 'COUNCIL_PARTICIPANT_CRITIQUE_INVALID:MISSING_REVISED_RECOMMENDATION' };
    if (!isStringArray(data.remaining_disagreements)) return { error: 'COUNCIL_PARTICIPANT_CRITIQUE_INVALID:MISSING_REMAINING_DISAGREEMENTS' };
    return { error: null };
  }
  if (stepKind === 'chair_synthesis') {
    if (data?.type !== 'council_synthesis') return { error: `COUNCIL_CHAIR_SYNTHESIS_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    return { error: null };
  }
  // P19-D1 — debate extension step kinds (docs/p19/00_...md §6). Same
  // discipline as every branch above: this runs AFTER the generic
  // `finish`/non-empty-`output` check (#validateDecideResult below), so it
  // only ever needs to check the STRUCTURED `data` shape.
  if (stepKind === 'debate_brief') {
    if (data?.type !== 'debate_brief') return { error: `COUNCIL_DEBATE_BRIEF_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    if (!isNonEmptyString(data.brief)) return { error: 'COUNCIL_DEBATE_BRIEF_INVALID:MISSING_BRIEF' };
    return { error: null };
  }
  if (stepKind === 'debate_response') {
    if (data?.type !== 'debate_response') return { error: `COUNCIL_DEBATE_RESPONSE_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    if (!isNonEmptyString(data.response)) return { error: 'COUNCIL_DEBATE_RESPONSE_INVALID:MISSING_RESPONSE' };
    return checkWorkspaceEvidence(spec, data, { repoPath });
  }
  if (stepKind === 'debate_synthesis') {
    if (data?.type !== 'debate_synthesis') return { error: `COUNCIL_DEBATE_SYNTHESIS_INVALID:WRONG_DATA_TYPE:${String(data?.type ?? 'missing')}` };
    // Typed continuation contract (docs/p19/00_...md §6) — engine-enforced
    // round-2 override happens in CouncilChairDriver, never here; this
    // validator only checks the SHAPE the model returned is well-formed.
    if (typeof data.continue_debate !== 'boolean') return { error: 'COUNCIL_DEBATE_SYNTHESIS_INVALID:MISSING_CONTINUE_DEBATE' };
    if (!isNonEmptyString(data.reason)) return { error: 'COUNCIL_DEBATE_SYNTHESIS_INVALID:MISSING_REASON' };
    if (!isStringArray(data.unresolved_questions)) return { error: 'COUNCIL_DEBATE_SYNTHESIS_INVALID:MISSING_UNRESOLVED_QUESTIONS' };
    if (data.unresolved_questions.some((q) => typeof q !== 'string' || !q.trim())) return { error: 'COUNCIL_DEBATE_SYNTHESIS_INVALID:EMPTY_UNRESOLVED_QUESTION' };
    return { error: null };
  }
  return { error: null };
}

// P10-R0.1 Part K: map a council stepKind to its start/success/failure
// event-type triple for the task diagnostic log. participant_report is the
// only kind whose failure event differs from its success event
// (PARTICIPANT_FAILED vs PARTICIPANT_RESULT) — every other kind reports
// both outcomes through the same "_RESULT" event with `ok: true/false`.
const STEP_EVENTS = Object.freeze({
  chair_plan: { start: 'COUNCIL_PLAN_START', ok: 'COUNCIL_PLAN_RESULT', fail: 'COUNCIL_PLAN_RESULT' },
  participant_report: { start: 'PARTICIPANT_START', ok: 'PARTICIPANT_RESULT', fail: 'PARTICIPANT_FAILED' },
  participant_critique: { start: 'CRITIQUE_START', ok: 'CRITIQUE_RESULT', fail: 'CRITIQUE_RESULT' },
  chair_synthesis: { start: 'CHAIR_SYNTHESIS_START', ok: 'CHAIR_SYNTHESIS_RESULT', fail: 'CHAIR_SYNTHESIS_RESULT' },
  // P19-D1: same start/success/failure-triple convention as every kind
  // above — debate_response mirrors participant_report's distinct
  // success/failure event pair (it is the one debate kind with a per-
  // participant outcome), the other two mirror chair_plan/chair_synthesis.
  debate_brief: { start: 'DEBATE_BRIEF_START', ok: 'DEBATE_BRIEF_RESULT', fail: 'DEBATE_BRIEF_RESULT' },
  debate_response: { start: 'DEBATE_RESPONSE_START', ok: 'DEBATE_RESPONSE_RESULT', fail: 'DEBATE_RESPONSE_FAILED' },
  debate_synthesis: { start: 'DEBATE_SYNTHESIS_START', ok: 'DEBATE_SYNTHESIS_RESULT', fail: 'DEBATE_SYNTHESIS_RESULT' },
});

// P10-R0.1.1 Part G: one event-name PREFIX per stepKind, shared by the
// per-REAL-BACKEND-ATTEMPT events `#decideOnce()` emits below
// (`<prefix>_ATTEMPT_START` / `<prefix>_BACKEND_RESULT` / `<prefix>_RETRY`,
// zero-indexed `attempt` — attempt 0 is the first real call, attempt 1 is
// the bounded MAX_PARSE_ATTEMPTS parse-retry, exactly matching the two real
// Claude invocations Backend Execution showed for
// task-D5PT4CbNpjeUamnegQDN6kvM34w3NMdo). Named to match the brief's literal
// `COUNCIL_PLAN_*` vocabulary for chair_plan and generalized symmetrically
// for the other three step kinds — the SAME MAX_PARSE_ATTEMPTS retry loop
// already applied to all four before this change.
const ATTEMPT_EVENT_PREFIX = Object.freeze({
  chair_plan: 'COUNCIL_PLAN',
  participant_report: 'PARTICIPANT',
  participant_critique: 'CRITIQUE',
  chair_synthesis: 'CHAIR_SYNTHESIS',
  // P19-D1: same per-real-attempt event-prefix convention as above.
  debate_brief: 'DEBATE_BRIEF',
  debate_response: 'DEBATE_RESPONSE',
  debate_synthesis: 'DEBATE_SYNTHESIS',
});

export class CouncilStepWorkflowRunner {
  #resolveDriver;
  #profileRegistry;
  #project;
  #extraCtx;
  #taskLog;
  #results = new Map();
  #stepState;
  #clock;
  #rawEvidenceCapture;
  // P20.4R R1/R2: optional artifact_v1 deps. When absent, every legacy code
  // path below is byte-for-byte unchanged. When present, a spec stamped
  // `transport_version: 'artifact_v1'` is routed to the P20 report-stage
  // executor BEFORE any of the legacy `#attempt()`/`#decideOnce()` machinery,
  // and its outcome is persisted through the SAME DurableWorkflowState.
  #artifact = null;

  /**
   * @param {object} deps
   * @param {(profile: object, context: object) => { name: string, decide: Function }} deps.resolveDriver
   * @param {{ get(id: string): object }} [deps.profileRegistry] - resolves a
   *   bare `{id}` when omitted (unit-test convenience only).
   * @param {{ id?: string, repo_path: string }} deps.project - EVERY
   *   participant/chair invocation uses this same project's repo_path
   *   (Part T: no cross-project cwd).
   * @param {(spec: object) => object} [deps.extraCtx] - optional observability
   *   correlation fields (councilId/phase/round/role — Part W) merged into
   *   the resolved driver's execution context, when the resolver supports it.
   * @param {{ event(type: string, fields: object): void }} [deps.taskLog] -
   *   P10-R0.1 Part H/K: optional task-scoped diagnostic log sink
   *   (src/runtime/task-diagnostic-log.mjs). `TaskDiagnosticLog.event()`
   *   never throws by its own design, but every call here still goes
   *   through `#log()` (Part P, P10-R0.1.1) — a defensive wrapper — so
   *   even a non-conforming/custom `taskLog` can never affect a real step
   *   outcome.
   * @param {{ createWorkflow(run): object, getWorkflow(id): object|undefined, updateWorkflowStatus(id, patch): object, updateStepStatus(workflowId, stepId, patch): object }} [deps.stepState] -
   *   P15-REM-R2-A (P15-C-001, docs/p15-rem/03_*.md): an OPTIONAL durable
   *   workflow-state store (the SAME `DurableWorkflowState`/`WorkflowRepository`
   *   contract SINGLE's `createProductionPmWorkflowRunner()` already uses —
   *   src/workflow/durable-workflow-state.mjs — reused verbatim, no third
   *   persistence model, no schema change). Every real production
   *   composition supplies this; every existing unit test omitting it keeps
   *   the exact pre-R2 in-memory-only `#results` Map behavior byte for byte
   *   (docs/p7/03's "no cross-restart durability" note now applies only to
   *   this fallback path).
   */
  constructor({ resolveDriver, profileRegistry = null, project, extraCtx = () => ({}), taskLog = null, stepState = null, clock = nowUtc, rawEvidenceCapture = null, artifactCouncil = null }) {
    if (typeof resolveDriver !== 'function') throw new TypeError('CouncilStepWorkflowRunner requires resolveDriver()');
    if (!project || typeof project.repo_path !== 'string' || !project.repo_path) {
      throw new TypeError('CouncilStepWorkflowRunner requires a project with repo_path');
    }
    if (stepState !== null) {
      const missing = ['createWorkflow', 'getWorkflow', 'updateWorkflowStatus', 'updateStepStatus'].filter((name) => typeof stepState[name] !== 'function');
      if (missing.length) throw new TypeError(`CouncilStepWorkflowRunner stepState is missing required members: ${missing.join(', ')}`);
    }
    this.#resolveDriver = resolveDriver;
    this.#profileRegistry = profileRegistry;
    this.#project = project;
    this.#extraCtx = extraCtx;
    this.#taskLog = taskLog && typeof taskLog.event === 'function' ? taskLog : null;
    this.#stepState = stepState;
    this.#clock = clock;
    // DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): optional, OFF by
    // default (t5-raw-evidence-capture.mjs's factory returns `{enabled:
    // false}` unless DSH_T5_RAW_EVIDENCE_CAPTURE is explicitly set) —
    // exactly the same non-conforming-value-safe pattern `taskLog` above
    // already uses, so every existing caller that omits this is byte-for-
    // byte unaffected.
    this.#rawEvidenceCapture = rawEvidenceCapture && typeof rawEvidenceCapture.record === 'function' ? rawEvidenceCapture : null;
    if (artifactCouncil) {
      const need = ['store', 'taskId', 'resolveReportBackend'];
      const missing = need.filter((k) => artifactCouncil[k] === undefined || artifactCouncil[k] === null);
      if (missing.length) throw new TypeError(`CouncilStepWorkflowRunner artifactCouncil is missing: ${missing.join(', ')}`);
      this.#artifact = {
        store: artifactCouncil.store,
        taskId: artifactCouncil.taskId,
        resolveReportBackend: artifactCouncil.resolveReportBackend,
        capabilityPolicy: artifactCouncil.capabilityPolicy ?? undefined,
        consumerInputTransport: artifactCouncil.consumerInputTransport ?? 'VERBATIM_CONTENT',
        aliasRegistry: artifactCouncil.aliasRegistry ?? null,
        // TEST-ONLY, DI-only R10 A/C/G fault-injection seam. No behaviour when omitted.
        __afterDeliverHook: typeof artifactCouncil.__afterDeliverHook === 'function' ? artifactCouncil.__afterDeliverHook : null,
        // TEST-ONLY, DI-only P20.5 §40 crash seam: fires AFTER the Debate
        // synthesis report seals and BEFORE its typed control is persisted.
        __beforeSynthesisControlPersistHook: typeof artifactCouncil.__beforeSynthesisControlPersistHook === 'function' ? artifactCouncil.__beforeSynthesisControlPersistHook : null,
        maxReportBytes: artifactCouncil.maxReportBytes ?? undefined,
        // P24.3C-R1 — optional durable per-invocation task-workspace evidence
        // ({isolation_version, workspace_path, repository_common_dir}); `null`
        // for every pre-existing caller, byte-for-byte unchanged.
        workspaceEvidence: artifactCouncil.workspaceEvidence ?? null,
      };
    }
  }

  /**
   * Reconstruct an already-run step's outcome. Without a durable `stepState`
   * this is an in-process-only replay (docs/p7/03's original note, still true
   * for that fallback path). With one, this is what makes P15-C-001's fix
   * real: a FRESH runner instance (a genuine process restart) can still
   * answer this correctly by reading the durable row, and — critically — a
   * step that was durably marked STARTED but never durably completed is
   * resolved HERE (not in `run()`, which a restarted `DurablePmRuntime` never
   * calls again once `result()` already reports a terminal-shaped outcome —
   * see `classifyPmTurnRecovery()`, src/pm/durable-pm-runtime.mjs) as a
   * typed, terminal, NEVER-replayed reconciliation failure.
   */
  result(id) {
    if (this.#results.has(id)) return this.#results.get(id);
    if (!this.#stepState) return null;
    let existing;
    try { existing = this.#stepState.getWorkflow(id); } catch { return null; }
    if (!existing) return null;
    // P20.4R R2: an artifact_v1 durable step is resolved through the
    // deterministic ARTIFACT stage authority BEFORE the generic legacy
    // reconciliation. This is a prepend-guard — a legacy step's `context`
    // never carries `transport_version`, so the legacy branches below are
    // reached exactly as before.
    if (existing.steps?.[0]?.context?.transport_version === 'artifact_v1') {
      if (existing.status === 'completed' || existing.status === 'failed') return this.#reconstructArtifactOutcome(id, existing);
      if (existing.status === 'running') return this.#artifactCrashHandshake(id, existing);
      return null;
    }
    if (existing.status === 'completed' || existing.status === 'failed') return this.#reconstructOutcome(id, existing);
    if (existing.status === 'running') return this.#reconcileAmbiguousStep(id, existing);
    // 'created' (durably recorded but the provider call itself never even
    // started) or 'cancelled' — genuinely not yet resolved; DurablePmRuntime
    // will call run() to (re)attempt it.
    return null;
  }

  /** Part P: a diagnostic-log failure must NEVER affect a real step outcome, even from a non-conforming custom taskLog. */
  #log(type, fields) {
    try { this.#taskLog?.event(type, fields); } catch { /* never let logging affect the real step */ }
  }

  /**
   * DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): a raw-evidence write
   * failure must NEVER affect a real step outcome, same B4 convention as
   * `#log()` above. No-op whenever `rawEvidenceCapture` was not supplied or
   * capture is disabled (t5-raw-evidence-capture.mjs's own `enabled` gate
   * already short-circuits before any I/O — this call is then a cheap,
   * synchronous no-op).
   */
  #recordRawEvidence(fields) {
    try { this.#rawEvidenceCapture?.record(fields); } catch { /* never let evidence capture affect the real step */ }
  }

  /**
   * DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): one bounded evidence
   * bundle per model generation (attempt), for both `ok:true` and `ok:false`
   * outcomes, covering every field the task brief lists that is genuinely
   * available at this call site. `raw`/`error` carry `rawOutputEvidence()`
   * (production-pm-backend-registry.mjs's WeakMap-backed accessor — `null`
   * unless DSH_T5_RAW_EVIDENCE_CAPTURE is on, in which case this is a no-op
   * anyway since `#rawEvidenceCapture` itself is only non-null when enabled).
   * `semantic_validation_result`/the step's ultimate propagated error are
   * NOT included here — those are STEP-level verdicts resolved after every
   * attempt in this loop finishes, already fully retained (unaffected by
   * this change) in the durable turn handoff `pm_turns.outcome` this same
   * `task_id`/`stage`/`profile_id` can be cross-referenced against.
   */
  #rawEvidenceRecord({ spec, profile, attempt, structuredOutputRequest, nativeFacts, ok, raw = null, error = null, diag = null }) {
    const evidenceCtx = this.#extraCtx(spec) ?? {};
    const evidence = ok ? rawOutputEvidence(raw) : rawOutputEvidence(error);
    const canonicalization = ok ? canonicalizationDiagnostic(raw) : canonicalizationDiagnostic(error);
    return {
      council_run_id: evidenceCtx.pmRunId ?? evidenceCtx.councilId ?? null,
      stage: spec.stepKind,
      round: spec.round ?? null,
      profile_id: profile.id ?? spec.profileId ?? null,
      backend: profile.product ?? null,
      model: profile.model ?? null,
      attempt_ordinal: attempt,
      structured_output_requested: Boolean(structuredOutputRequest),
      structured_output_schema_kind: structuredOutputRequest?.kind ?? null,
      ...nativeFacts,
      output_bytes: evidence?.bytes ?? diag?.bytes ?? null,
      output_sha256: evidence?.sha256 ?? null,
      // The complete visible assistant output (or, for a native-schema
      // backend, the serialized structured_output — see production-pm-
      // backend-registry.mjs's rawEvidence comment for why one field covers
      // both). `null` whenever capture is disabled — never a placeholder,
      // never invented.
      extracted_visible_assistant_output: evidence?.text ?? null,
      parsed_decision: ok ? raw : null,
      parser_error_code: ok ? null : (error?.code ?? null),
      parser_subreason: ok ? null : (error?.parseSubreason ?? null),
      decision_candidate_count: ok ? 1 : (error?.sourceCandidateCount ?? null),
      decision_distinct_substantive_candidate_count: ok ? 1 : (error?.sourceDistinctSubstantiveCount ?? null),
      canonicalizer_called: Boolean(canonicalization),
      canonicalizer_profile: canonicalization?.canonicalizer_profile ?? null,
      canonicalizer_eligibility_state: canonicalization?.state ?? null,
      canonicalizer_result_status: canonicalization?.result ?? null,
      // Only populated when gateway.mjs's own captureRawWrapperText config
      // is ALSO on (same DSH_T5_RAW_EVIDENCE_CAPTURE flag) -- see
      // output-canonicalization/gateway.mjs's `wrapper_text` diagnostic field.
      canonicalizer_wrapper_text: canonicalization?.wrapper_text ?? null,
      canonicalizer_candidates: canonicalization?.candidates ?? null,
      canonicalized_parser_result: canonicalization?.canonicalized_parser_state ?? null,
      pm_contract_result: canonicalization?.pm_contract_state ?? null,
      attempt_ok: ok,
    };
  }

  /** Deterministic, stable id for a council step spec's single durable workflow_steps row. */
  #stepRowId(specId) { return `${specId}-step0`; }

  /** Durably record STARTED — see file-level docstring: written BEFORE the provider call, so an ambiguous mid-call crash is always detectable on restart. */
  #persistCreated(spec) {
    this.#stepState.createWorkflow({
      id: spec.id, sender: 'council', status: 'created', startedAt: null, completedAt: null, error: null,
      steps: [{
        id: this.#stepRowId(spec.id), workflowId: spec.id, index: 0, recipient: spec.profileId ?? null, status: 'created',
        taskId: null, runId: null, resultId: null, contextFromPrevious: false, dispatchedContext: null, error: null,
        body: spec.stepKind ?? null,
        context: { stepKind: spec.stepKind ?? null, round: spec.round ?? null, participantProfileIds: spec.participantProfileIds ?? null },
        expectedOutput: null,
      }],
    });
  }

  /** Reconstruct the minimal spec shape `#outcome()` needs from a durable row — never from transient process state (Part identity requirement). */
  #specFromWorkflow(existing) {
    const step = existing.steps?.[0] ?? {};
    const ctx = step.context ?? {};
    return { id: existing.id, stepKind: ctx.stepKind ?? null, round: ctx.round ?? null, profileId: step.recipient ?? null, participantProfileIds: ctx.participantProfileIds ?? null };
  }

  /** Rebuild the exact outcome shape for an already-terminal (completed/failed) durable step — never re-executes. */
  #reconstructOutcome(id, existing) {
    const step = existing.steps?.[0] ?? null;
    if (existing.status === 'completed' && step?.dispatchedContext && typeof step.dispatchedContext === 'object') {
      const finalResult = step.dispatchedContext;
      const outcome = Object.freeze({ status: 'completed', workflowId: id, finalStepId: id, finalTaskId: id, finalRunId: id, finalResult: Object.freeze({ ...finalResult }), error: null });
      this.#results.set(id, outcome);
      return outcome;
    }
    // 'failed' — always a reconciliation record (this runner never persists
    // a genuine step failure under workflow status 'failed'; a validated
    // step failure is still reported as `status:'completed'`/`handoff.ok:
    // false`, Part H/I — see the success path in run() below).
    const spec = this.#specFromWorkflow(existing);
    const outcome = this.#outcome(spec, { ok: false, reason: step?.error?.code ?? COUNCIL_STEP_RECONCILE_REASON, reconciled: true });
    this.#results.set(id, outcome);
    return outcome;
  }

  /**
   * REM-R2-B — the unknown-external-outcome policy, applied exactly once,
   * durably, and idempotently: RECONCILE_AND_FAIL. A durable row stuck at
   * 'running' means the process executing this step died between marking it
   * STARTED and recording ANY outcome — this NEVER reruns the provider call
   * (council steps have no external side effect to protect either way, but
   * the policy is the same regardless: no captured result exists to be
   * faithful to, so none is fabricated). The write here IS the
   * reconciliation act; a second call for the same id takes the
   * already-'failed' branch in `#reconstructOutcome()` above instead of
   * repeating it.
   */
  #reconcileAmbiguousStep(id, existing) {
    const step = existing.steps?.[0] ?? null;
    const error = { name: 'CouncilStepReconciled', code: 'COUNCIL_STEP_RECONCILE_REQUIRED', message: 'council step had no durable outcome after an unplanned restart; treated as failed, never replayed' };
    this.#log('COUNCIL_STEP_RECONCILED', { workflow_id: id, reason: COUNCIL_STEP_RECONCILE_REASON });
    try { if (step) this.#stepState.updateStepStatus(id, step.id, { status: 'failed', error }); } catch { /* races a concurrent reconciliation of the same row — re-read below regardless */ }
    try { this.#stepState.updateWorkflowStatus(id, { status: 'failed', completedAt: String(this.#clock()), error }); } catch { /* already terminal — re-read below */ }
    const refreshed = this.#stepState.getWorkflow(id) ?? existing;
    return this.#reconstructOutcome(id, refreshed);
  }

  async run(spec) {
    if (!spec || spec.kind !== 'council_step') {
      throw new CouncilValidationError(`CouncilStepWorkflowRunner refuses a non-council spec: ${spec?.kind ?? 'unknown'}`, 'COUNCIL_STEP_KIND_REFUSED');
    }
    // P20.4R R1 — prepend-guard: an artifact_v1 Council step runs through the
    // P20 report-stage executor, persisting its outcome through the SAME
    // DurableWorkflowState the legacy path uses, and returns the SAME
    // workflow-runner contract DurablePmRuntime consumes. It NEVER reaches
    // #attempt()/#decideOnce()/parseDecision()/validateStepData()/canonicalizer.
    if (spec.transport_version === 'artifact_v1') {
      if (!this.#artifact) {
        // Fail closed — never silently fall through to the legacy semantic
        // path for an artifact_v1 step.
        return this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_DEPS_MISSING', 'artifact_v1 council step but the runner has no artifactCouncil dependencies'));
      }
      return this.#runArtifactStepDurable(spec);
    }
    if (!this.#stepState) {
      const outcome = await this.#attempt(spec);
      this.#results.set(spec.id, outcome);
      return outcome;
    }
    let existing;
    try { existing = this.#stepState.getWorkflow(spec.id); } catch { existing = null; }
    // Invariant #9 (REM-R2-I): a completed OR failed durable step is NEVER
    // re-executed, regardless of why run() was called again.
    if (existing && (existing.status === 'completed' || existing.status === 'failed')) return this.#reconstructOutcome(spec.id, existing);
    // Defensive: DurablePmRuntime's own recovery classification (Part
    // identity above) means `run()` is not normally re-entered for a
    // 'running' row — `result()` resolves it first — but stay safe if it
    // ever is.
    if (existing && existing.status === 'running') return this.#reconcileAmbiguousStep(spec.id, existing);
    if (!existing) this.#persistCreated(spec);
    this.#stepState.updateWorkflowStatus(spec.id, { status: 'running', startedAt: String(this.#clock()) });
    this.#stepState.updateStepStatus(spec.id, this.#stepRowId(spec.id), { status: 'running' });
    const outcome = await this.#attempt(spec); // never throws — Part H/I contract, unchanged
    this.#stepState.updateStepStatus(spec.id, this.#stepRowId(spec.id), { status: 'completed', dispatchedContext: outcome.finalResult });
    this.#stepState.updateWorkflowStatus(spec.id, { status: 'completed', completedAt: String(this.#clock()) });
    this.#results.set(spec.id, outcome);
    return outcome;
  }

  // ===================================================================
  // P20.4R R1/R2 — artifact_v1 durable step branch (prepend-guarded).
  // ===================================================================

  #resolveAlias(profileId) {
    if (this.#artifact.aliasRegistry) {
      try { return actorAliasFor(this.#artifact.aliasRegistry, profileId); } catch { /* fall through */ }
    }
    return deriveActorAlias(profileId);
  }

  #artifactStageIds(spec) {
    const artifactStage = spec.artifactStage;
    // P20.5 — round-scoped Debate stages use the deterministic Debate helper.
    if (DEBATE_ARTIFACT_STAGES.includes(artifactStage)) {
      const round = spec.round;
      const isResponse = artifactStage === 'debate-member-response';
      const actorAlias = this.#resolveAlias(spec.profileId);
      const stageKey = debateStageKey({ artifactStage, round, actorAlias: isResponse ? actorAlias : null });
      const invocationId = debateStageInvocationId({ taskId: this.#artifact.taskId, round, artifactStage, actorAlias: isResponse ? actorAlias : null });
      return { artifactStage, isDebate: true, isPerParticipant: isResponse, actorAlias, stageKey, invocationId, round };
    }
    const isPerParticipant = artifactStage === 'participant-report' || artifactStage === 'participant-critique';
    const actorAlias = isPerParticipant
      ? (this.#artifact.aliasRegistry ? actorAliasFor(this.#artifact.aliasRegistry, spec.profileId) : deriveActorAlias(spec.profileId))
      : (this.#artifact.aliasRegistry && this.#artifact.aliasRegistry.get(spec.profileId) ? this.#artifact.aliasRegistry.get(spec.profileId) : deriveActorAlias(spec.profileId));
    const stageKey = councilStageKey({ artifactStage, actorAlias: isPerParticipant ? actorAlias : null });
    const invocationId = councilStageInvocationId({ taskId: this.#artifact.taskId, artifactStage, actorAlias: isPerParticipant ? actorAlias : null });
    return { artifactStage, isDebate: false, isPerParticipant, actorAlias, stageKey, invocationId, round: null };
  }

  /** Build the frozen `{ finalResult.handoff }` outcome from an artifact_v1 step outcome. */
  #artifactOutcome(spec, artifactPayload) {
    const ap = artifactPayload;
    return Object.freeze({
      status: 'completed',
      workflowId: spec.id, finalStepId: spec.id, finalTaskId: spec.id, finalRunId: spec.id,
      finalResult: Object.freeze({
        id: spec.id, taskId: spec.id, runId: spec.id, agent: spec.profileId ?? null,
        status: ap.ok ? 'completed' : 'failed',
        output: '', // the report body NEVER travels in the durable handoff
        handoff: Object.freeze({ stepKind: spec.stepKind, round: spec.round ?? null, participantProfileId: spec.profileId ?? null, ...ap }),
        artifacts: [],
      }),
      error: null,
    });
  }

  #artifactFailurePayload(spec, failureCode, reason, executionState = COUNCIL_STEP_EXECUTION_STATE.EXECUTION_FAILED) {
    return buildArtifactStepFailure({
      stepKind: spec.stepKind, artifactStage: spec.artifactStage ?? null, stageKey: spec.stageKey ?? null,
      round: isDebateArtifactStepKind(spec.stepKind) ? (spec.round ?? null) : null,
      profileId: spec.profileId, actorAlias: spec.actorAlias ?? spec.profileId, failureCode, reason, executionState,
    });
  }

  #openArtifactTask() {
    const task = this.#artifact.store.openTaskById(this.#artifact.taskId);
    if (!task) throw new CouncilValidationError(`artifact Council task ${JSON.stringify(this.#artifact.taskId)} does not exist`, 'COUNCIL_ARTIFACT_TASK_MISSING');
    return task;
  }

  async #executeArtifactStage(spec, task) {
    const ids = this.#artifactStageIds(spec);
    const { artifactStage, actorAlias } = ids;
    const backendResolved = this.#artifact.resolveReportBackend(spec.profileId);
    if (!backendResolved || typeof backendResolved.runReport !== 'function' || typeof backendResolved.backend !== 'string') {
      return this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_BAD_BACKEND', `resolveReportBackend(${JSON.stringify(spec.profileId)}) must return { backend, runReport }`);
    }
    if (ids.isDebate) {
      // §12 — every Debate stage is reasoning-only; never implementation-capable.
      return runDebateArtifactStage({
        store: this.#artifact.store, task, taskId: this.#artifact.taskId,
        round: ids.round, maxRounds: spec.maxRounds, artifactStage, profileId: spec.profileId, actorAlias, backend: backendResolved.backend,
        reportBackend: backendResolved,
        capabilityPolicy: this.#artifact.capabilityPolicy,
        consumerInputTransport: this.#artifact.consumerInputTransport,
        instructions: spec.instructions ?? '',
        inputReferences: Array.isArray(spec.inputRefs) ? spec.inputRefs : [],
        extraEvidence: Array.isArray(spec.extraEvidence) ? spec.extraEvidence : [],
        maxReportBytes: this.#artifact.maxReportBytes,
        clock: () => String(this.#clock()),
        workspaceEvidence: this.#artifact.workspaceEvidence ?? null,
        __afterDeliverHook: this.#artifact.__afterDeliverHook,
        __beforeSynthesisControlPersistHook: this.#artifact.__beforeSynthesisControlPersistHook,
      });
    }
    const executionCapable = spec.isImplementationParticipant === true && spec.stepKind === 'participant_report';
    const outcome = await runCouncilArtifactStage({
      store: this.#artifact.store, task, taskId: this.#artifact.taskId,
      artifactStage, profileId: spec.profileId, actorAlias, backend: backendResolved.backend,
      reportBackend: backendResolved,
      capabilityPolicy: this.#artifact.capabilityPolicy,
      consumerInputTransport: this.#artifact.consumerInputTransport,
      instructions: spec.instructions ?? '',
      inputReferences: Array.isArray(spec.inputRefs) ? spec.inputRefs : [],
      extraEvidence: Array.isArray(spec.extraEvidence) ? spec.extraEvidence : [],
      maxReportBytes: this.#artifact.maxReportBytes,
      executionCapable,
      clock: () => String(this.#clock()),
      workspaceEvidence: this.#artifact.workspaceEvidence ?? null,
      __afterDeliverHook: this.#artifact.__afterDeliverHook,
    });
    return outcome;
  }

  async #runArtifactStepDurable(spec) {
    // No durable stepState — offline unit convenience (still one executor).
    if (!this.#stepState) {
      let payload;
      try { payload = await this.#executeArtifactStage(spec, this.#openArtifactTask()); }
      catch (error) { payload = this.#artifactFailurePayload(spec, error?.code ?? 'COUNCIL_ARTIFACT_STAGE_ERROR', error.message); }
      const outcome = this.#artifactOutcome(spec, payload);
      this.#results.set(spec.id, outcome);
      return outcome;
    }
    let existing;
    try { existing = this.#stepState.getWorkflow(spec.id); } catch { existing = null; }
    if (existing && (existing.status === 'completed' || existing.status === 'failed')) return this.#reconstructArtifactOutcome(spec.id, existing);
    if (existing && existing.status === 'running') return this.#artifactCrashHandshake(spec.id, existing);
    if (!existing) this.#persistArtifactCreated(spec);
    this.#stepState.updateWorkflowStatus(spec.id, { status: 'running', startedAt: String(this.#clock()) });
    this.#stepState.updateStepStatus(spec.id, this.#stepRowId(spec.id), { status: 'running' });

    let payload;
    try {
      payload = await this.#executeArtifactStage(spec, this.#openArtifactTask());
    } catch (error) {
      // TEST-ONLY R10 A/C/G seam: leave the workflow row `running` with NO
      // outcome (a genuine mid-crash shape) by propagating without writing
      // completion marks. No effect in production (the seam is DI-only).
      if (error?.__p20TestStopBeforeSeal) throw error;
      payload = this.#artifactFailurePayload(spec, error?.code ?? 'COUNCIL_ARTIFACT_STAGE_ERROR', error.message);
    }
    const outcome = this.#artifactOutcome(spec, payload);
    this.#stepState.updateStepStatus(spec.id, this.#stepRowId(spec.id), { status: 'completed', dispatchedContext: outcome.finalResult });
    this.#stepState.updateWorkflowStatus(spec.id, { status: 'completed', completedAt: String(this.#clock()) });
    this.#results.set(spec.id, outcome);
    return outcome;
  }

  #persistArtifactCreated(spec) {
    const { artifactStage, stageKey, invocationId } = this.#artifactStageIds(spec);
    this.#stepState.createWorkflow({
      id: spec.id, sender: 'council', status: 'created', startedAt: null, completedAt: null, error: null,
      steps: [{
        id: this.#stepRowId(spec.id), workflowId: spec.id, index: 0, recipient: spec.profileId ?? null, status: 'created',
        taskId: null, runId: null, resultId: null, contextFromPrevious: false, dispatchedContext: null, error: null,
        body: spec.stepKind ?? null,
        context: {
          stepKind: spec.stepKind ?? null, round: spec.round ?? null, participantProfileIds: spec.participantProfileIds ?? null,
          transport_version: 'artifact_v1', artifact_stage: artifactStage, stage_key: stageKey, invocation_id: invocationId,
        },
        expectedOutput: null,
      }],
    });
  }

  /** R2 (workflow row COMPLETED) — full-verify the sealed_ref before reusing a durable successful artifact outcome. */
  /**
   * P20.4R2 R9 — the deterministic EXPECTED step identity for a durable
   * artifact workflow row, RE-DERIVED from the row's `context.stepKind` +
   * `recipient` + the alias registry + the canonical stage/role/stage-key
   * helpers (never from a stored `stage_key`/`artifact_stage` string on its
   * own). The persisted `context.artifact_stage`/`stage_key` are then checked
   * to match — a mutated row context is a binding mismatch.
   */
  #expectedArtifactStepIdentity(existing) {
    const step = existing.steps?.[0] ?? {};
    const ctx = step.context ?? {};
    const stepKind = ctx.stepKind ?? null;
    const round = Number.isInteger(ctx.round) ? ctx.round : null;
    const profileId = step.recipient ?? null;
    const isDebate = isDebateArtifactStepKind(stepKind);
    const artifactStage = isDebate ? debateArtifactStageForStepKind(stepKind) : councilArtifactStageForStepKind(stepKind);
    let actorAlias = null;
    if (profileId) {
      actorAlias = (this.#artifact.aliasRegistry && this.#artifact.aliasRegistry.get(profileId))
        ? this.#artifact.aliasRegistry.get(profileId)
        : deriveActorAlias(profileId);
    }
    // P20.4R3 R13 / P20.5 — the ONE shared expected-step-identity helper (no
    // local stage/role map). `null` when the step kind / identity / round is
    // unrecognised. Debate step kinds require the row context's round.
    const ident = expectedArtifactStepIdentity({ stepKind, round, profileId, actorAlias });
    return {
      stepKind,
      round: ident?.round ?? (isDebate ? round : null),
      artifactStage: ident?.artifactStage ?? artifactStage ?? null,
      stageKey: ident?.stageKey ?? null,
      profileId,
      actorAlias,
      role: ident?.role ?? (artifactStage === 'chair-plan' || artifactStage === 'chair-council-synthesis' || artifactStage === 'debate-chair-brief' || artifactStage === 'debate-chair-synthesis' ? ARTIFACT_ROLE.CHAIR : ARTIFACT_ROLE.MEMBER),
      // the values the runner persisted at STARTED time — must match the re-derivation
      persistedStageKey: ctx.stage_key ?? null,
      persistedArtifactStage: ctx.artifact_stage ?? null,
    };
  }

  /**
   * P20.5 §27 — verify a durable Debate synthesis handoff's `typed_control`
   * against the SAME sealed execution that produced its report: the handoff
   * value, the persisted invocation.json `debate_continuation`, and the
   * resolved sealed invocation/attempt metadata must all agree and bind to the
   * expected round/profile/alias/stage. Returns an error string on mismatch,
   * or `null` when fully bound.
   */
  #bindDebateSynthesisControl(handoff, expected, verified) {
    const hc = handoff.typed_control ?? null;
    if (!hc || typeof hc !== 'object') return 'successful Debate synthesis handoff has no typed_control';
    let persisted = null;
    try {
      const task = this.#openArtifactTask();
      const inv = task.openInvocationById(verified.invocationRecord.invocation_id);
      persisted = inv.freshDebateContinuationControl();
    } catch (error) {
      return `could not load the persisted debate_continuation control: ${error?.code ?? error.message}`;
    }
    if (!persisted) return 'the Debate synthesis invocation has no persisted debate_continuation control';
    if (JSON.stringify(persisted) !== JSON.stringify(hc)) return 'handoff.typed_control does not equal the persisted debate_continuation control';
    const v = validateDebateContinuationControlBinding({
      control: hc,
      expected: {
        storeId: verified.invocationRecord.store_id, projectId: verified.invocationRecord.project_id,
        taskId: verified.invocationRecord.task_id, invocationId: verified.invocationRecord.invocation_id,
        round: expected.round, profileId: expected.profileId, actorAlias: expected.actorAlias, role: expected.role,
      },
      sealedInvocationRecord: verified.invocationRecord,
      sealedAttemptMetadata: verified.attemptMetadata,
    });
    return v.ok ? null : v.errors.join('; ');
  }

  #reconstructArtifactOutcome(id, existing) {
    const step = existing.steps?.[0] ?? null;
    const handoff = step?.dispatchedContext?.handoff ?? null;
    const expected = this.#expectedArtifactStepIdentity(existing);
    const spec = this.#specFromArtifactWorkflow(existing);

    // R9: a mutated durable row context (persisted stage key / stage) is a
    // fail-closed binding mismatch — never a silent successful outcome.
    if (expected.persistedStageKey !== null && expected.persistedStageKey !== expected.stageKey) {
      const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_ROW_CONTEXT_MISMATCH', `durable row context.stage_key ${JSON.stringify(expected.persistedStageKey)} != re-derived ${JSON.stringify(expected.stageKey)}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
      this.#results.set(id, outcome);
      return outcome;
    }
    if (expected.persistedArtifactStage !== null && expected.persistedArtifactStage !== expected.artifactStage) {
      const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_ROW_CONTEXT_MISMATCH', `durable row context.artifact_stage ${JSON.stringify(expected.persistedArtifactStage)} != re-derived ${JSON.stringify(expected.artifactStage)}`, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
      this.#results.set(id, outcome);
      return outcome;
    }

    if (existing.status === 'completed' && handoff && handoff.ok === true) {
      // full-verify the sealed_ref, then bind the WHOLE handoff (+ resolved
      // invocation/attempt metadata) against the expected step identity.
      let verified = null;
      try {
        if (!handoff.sealed_ref) throw new CouncilValidationError('successful handoff has no sealed_ref', 'COUNCIL_ARTIFACT_STEP_NO_SEALED_REF');
        verified = resolveAndVerifySealedReference({ store: this.#artifact.store, reference: handoff.sealed_ref });
      } catch (error) {
        const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_REF_REVERIFY_FAILED', error.message));
        this.#results.set(id, outcome);
        return outcome;
      }
      const bind = validateCouncilArtifactStepBinding({
        handoff, expected,
        sealedInvocationRecord: verified.invocationRecord,
        sealedAttemptMetadata: verified.attemptMetadata,
      });
      if (!bind.ok) {
        const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH', bind.errors.join('; '), COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
        this.#results.set(id, outcome);
        return outcome;
      }
      // P20.5 §27 — a successful durable Debate SYNTHESIS handoff MUST carry a
      // typed continuation control that binds to the SAME sealed execution as
      // its report; else fail closed (never a silent success, never inferred).
      if (spec.stepKind === 'debate_synthesis') {
        const dcErr = this.#bindDebateSynthesisControl(handoff, expected, verified);
        if (dcErr) {
          const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'DEBATE_ARTIFACT_SYNTHESIS_CONTROL_BINDING_MISMATCH', dcErr, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
          this.#results.set(id, outcome);
          return outcome;
        }
      }
      const outcome = Object.freeze({ status: 'completed', workflowId: id, finalStepId: id, finalTaskId: id, finalRunId: id, finalResult: Object.freeze({ ...step.dispatchedContext }), error: null });
      this.#results.set(id, outcome);
      return outcome;
    }
    if (existing.status === 'completed' && handoff && handoff.ok === false) {
      // a durable failure/skip outcome — still structurally + identity bound.
      const bind = validateCouncilArtifactStepBinding({ handoff, expected });
      if (!bind.ok) {
        const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_BINDING_MISMATCH', bind.errors.join('; '), COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
        this.#results.set(id, outcome);
        return outcome;
      }
      const outcome = Object.freeze({ status: 'completed', workflowId: id, finalStepId: id, finalTaskId: id, finalRunId: id, finalResult: Object.freeze({ ...step.dispatchedContext }), error: null });
      this.#results.set(id, outcome);
      return outcome;
    }
    if (existing.status === 'completed') {
      // P20.4R2 R14 — every row reaching #reconstructArtifactOutcome is an
      // artifact_v1 row (the call sites guard on
      // context.transport_version === 'artifact_v1'). A `completed` artifact
      // row MUST carry exactly one handoff that passed the ok===true /
      // ok===false structural + binding policy above. A row whose
      // dispatchedContext exists but whose handoff is missing / null /
      // malformed / has a non-boolean `ok` is NEVER returned as an
      // unvalidated success and NEVER falls through to legacy reconstruction —
      // it becomes a typed, idempotent RECONCILED_NO_REPLAY failure.
      const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STEP_HANDOFF_INVALID', 'completed artifact workflow row has no valid artifact_v1 handoff (missing / null / malformed / non-boolean ok)', COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
      this.#results.set(id, outcome);
      return outcome;
    }
    // 'failed' — a durable reconciliation record.
    const outcome = this.#artifactOutcome(spec, this.#artifactFailurePayload(spec, step?.error?.code ?? COUNCIL_STEP_RECONCILE_REASON, 'reconciled artifact step', COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
    this.#results.set(id, outcome);
    return outcome;
  }

  #specFromArtifactWorkflow(existing) {
    const step = existing.steps?.[0] ?? {};
    const ctx = step.context ?? {};
    const ident = this.#expectedArtifactStepIdentity(existing);
    return {
      id: existing.id, kind: 'council_step', transport_version: 'artifact_v1',
      stepKind: ctx.stepKind ?? null, round: ctx.round ?? null, profileId: step.recipient ?? null,
      participantProfileIds: ctx.participantProfileIds ?? null,
      artifactStage: ident.artifactStage, stageKey: ident.stageKey,
      actorAlias: ident.actorAlias ?? (step.recipient ?? null),
    };
  }

  /**
   * R2 — the durable workflow-state / artifact-state crash handshake. A
   * RUNNING durable artifact step is resolved through the deterministic
   * artifact stage authority BEFORE the generic RECONCILED_NO_REPLAY:
   *   SEALED    -> reconstruct + full-verify -> RECOVERED_FROM_SEAL (0 replay)
   *   DELIVERED -> gate + seal from the persisted attempt (0 replay)
   *   FAILED/CANCELLED -> durably failed (0 replay)
   *   ASSIGNED/RUNNING/none -> existing RECONCILED_NO_REPLAY (0 replay)
   */
  #artifactCrashHandshake(id, existing) {
    const spec = this.#specFromArtifactWorkflow(existing);
    const reconciled = () => this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, COUNCIL_STEP_RECONCILE_REASON, 'artifact council step had no durable outcome after an unplanned restart; treated as failed, never replayed', COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
    let task;
    try { task = this.#openArtifactTask(); }
    catch { return reconciled(); }

    const isDebate = isDebateArtifactStepKind(spec.stepKind);
    const { stageKey, invocationId, round } = this.#artifactStageIds(spec);
    let inv = null;
    try { inv = task.openInvocationById(invocationId); }
    catch (error) {
      if (error?.code === 'ARTIFACT_INVOCATION_RECORD_MISSING' || error?.code === 'ARTIFACT_INVOCATION_ID_MISSING') {
        // the provider stage never durably started — genuinely ambiguous, never replayed
        return reconciled();
      }
      return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, `${error?.code ?? 'ARTIFACT_INVOCATION_OPEN_ERROR'}`, error.message, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
    }
    if (!inv) return reconciled();

    let rec;
    try { rec = inv.freshRecord(); }
    catch (error) { return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, `${error?.code ?? 'ARTIFACT_INVOCATION_RECORD_CORRUPT'}`, error.message, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY)); }

    // P20.5 §21/§39-M — a durable (DELIVERED/SEALED) Debate SYNTHESIS MUST
    // have a durable, valid typed continuation control; otherwise fail closed
    // with ZERO replay (continuation is NEVER inferred from report.md).
    const isSynth = spec.artifactStage === 'debate-chair-synthesis';
    let dbgTypedControl = null;
    if (isDebate && isSynth && (rec.lifecycle === 'SEALED' || rec.lifecycle === 'DELIVERED')) {
      try { dbgTypedControl = inv.freshDebateContinuationControl(); }
      catch (error) {
        return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, error?.code ?? 'DEBATE_ARTIFACT_SYNTHESIS_CONTROL_CORRUPT', error.message, COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
      }
      if (!dbgTypedControl) {
        return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, 'DEBATE_ARTIFACT_SYNTHESIS_CONTROL_MISSING', 'durable Debate synthesis report has no typed continuation control after restart', COUNCIL_STEP_EXECUTION_STATE.RECONCILED_NO_REPLAY));
      }
    }
    const artifactRole = spec.artifactStage === 'chair-plan' || spec.artifactStage === 'chair-council-synthesis' || spec.artifactStage === 'debate-chair-brief' || spec.artifactStage === 'debate-chair-synthesis'
      ? ARTIFACT_ROLE.CHAIR : ARTIFACT_ROLE.MEMBER;
    const successPayload = (sealedRef, state) => {
      const p = buildArtifactStepSuccess({
        stepKind: spec.stepKind, artifactStage: spec.artifactStage, stageKey,
        round: isDebate ? round : undefined,
        profileId: spec.profileId, actorAlias: spec.actorAlias, sealedRef, executionState: state,
      });
      return isDebate && isSynth ? Object.freeze({ ...p, typed_control: dbgTypedControl }) : p;
    };

    if (rec.lifecycle === 'SEALED') {
      try {
        const sealedRef = reconstructSealedStageRef({ store: this.#artifact.store, task, invocation: inv, stageKey });
        return this.#durablyCompleteArtifact(id, spec, successPayload(sealedRef, COUNCIL_STEP_EXECUTION_STATE.RECOVERED_FROM_SEAL));
      } catch (error) {
        return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, 'COUNCIL_ARTIFACT_STAGE_RECOVERY_FAILED', error.message));
      }
    }
    if (rec.lifecycle === 'DELIVERED') {
      // R2/R3: gate + seal SYNCHRONOUSLY from the persisted attempt — the
      // real execution_id comes from that attempt's artifact.json, never
      // invocation.json. ZERO provider call, NO bounded repair.
      try {
        const ordinal = Number.isInteger(rec.latest_attempt_ordinal)
          ? rec.latest_attempt_ordinal
          : (Array.isArray(rec.attempts) && rec.attempts.length ? rec.attempts[rec.attempts.length - 1] : 0);
        const meta = inv.freshAttemptMetadata(ordinal);
        if (typeof meta.execution_id !== 'string' || !meta.execution_id) {
          throw new CouncilValidationError(`attempt-${ordinal} artifact.json has no execution_id`, 'COUNCIL_ARTIFACT_STAGE_NO_EXECUTION_ID');
        }
        const done = sealDeliveredStageFromDisk({
          store: this.#artifact.store, task, invocation: inv, attemptOrdinal: ordinal, stageKey,
          expected: {
            storeId: this.#artifact.store.storeId, projectId: this.#artifact.store.projectId, taskId: this.#artifact.taskId,
            invocationId, role: artifactRole, stage: spec.artifactStage, round: isDebate ? round : null,
            profileId: spec.profileId, actorAlias: spec.actorAlias, executionId: meta.execution_id, backend: meta.backend ?? this.#artifact.resolveReportBackend(spec.profileId)?.backend,
          },
          maxReportBytes: this.#artifact.maxReportBytes,
          now: () => String(this.#clock()),
        });
        return this.#durablyCompleteArtifact(id, spec, successPayload(done.sealedReference, COUNCIL_STEP_EXECUTION_STATE.SEALED));
      } catch (error) {
        return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, error?.code ?? 'COUNCIL_ARTIFACT_STAGE_COMPLETE_FROM_DISK_FAILED', error.message));
      }
    }
    if (rec.lifecycle === 'FAILED' || rec.lifecycle === 'CANCELLED') {
      return this.#durablyCompleteArtifact(id, spec, this.#artifactFailurePayload(spec, `COUNCIL_ARTIFACT_STAGE_${rec.lifecycle}`, rec.integrity_state ?? rec.lifecycle));
    }
    return reconciled();
  }

  #durablyCompleteArtifact(id, spec, payload) {
    const outcome = this.#artifactOutcome(spec, payload);
    try {
      this.#stepState.updateStepStatus(id, this.#stepRowId(id), { status: 'completed', dispatchedContext: outcome.finalResult });
      this.#stepState.updateWorkflowStatus(id, { status: 'completed', completedAt: String(this.#clock()) });
    } catch { /* races a concurrent completion of the same row — the outcome is still authoritative */ }
    this.#results.set(id, outcome);
    return outcome;
  }

  /**
   * One parse-retry-bounded decide() call against a given prompt text
   * (Part E: the participant-id repair layer in #attempt() reuses this
   * unchanged, as its own separate outer call).
   *
   * P10-R0.1.1 Part G/H: the driver is re-resolved for EACH real inner
   * attempt (0-indexed, matching the owner's Backend Execution evidence —
   * "Attempt 0"/"Attempt 1"), passing `attempt` through extraCtx, so a
   * BackendExecutionObserver-level PID/PROCESS_SPAWN fact (production-pm-
   * backend-registry.mjs) can be correlated back to the exact attempt that
   * produced it (Part L) — re-resolving is cheap (it builds a closure
   * object; it never spawns a process itself) and changes no observable
   * decide()-call-count behavior for any existing caller.
   */
  async #decideOnce(spec, profile, promptText) {
    const prefix = ATTEMPT_EVENT_PREFIX[spec.stepKind] ?? null;
    let raw; let lastParseError = null; let currentPrompt = promptText;
    // Preserve the Claude chair pilot; explicitly enable Antigravity only
    // for non-implementation participant semantic steps. Rebuilt identically
    // for the initial invocation and the single semantic repair.
    const structuredOutputRequest = spec.stepKind === 'chair_plan' && profile.product === 'claude-code'
      ? Object.freeze({ schema: buildChairPlanJsonSchema(spec.participantProfileIds ?? []), kind: CHAIR_PLAN_SCHEMA_KIND, version: CHAIR_PLAN_SCHEMA_VERSION })
      : antigravityParticipantSchemaRequest(spec, profile);
    // P10-R0.1.1 Part K: a small, bounded, sanitized per-attempt summary
    // travels with the return value (never just to the task log) so the
    // caller can attach it to this step's own `handoff` — that's how
    // `council.json`'s `chair_plan.attempts` and summary.md's "Chair Plan
    // Attempts" section (Part I/K) get real per-attempt evidence without
    // this sink needing to read events.jsonl back.
    const nativeFacts = structuredOutputRequest?.provider === 'antigravity' ? { structured_output_requested: true, structured_output_provider: 'antigravity', structured_output_mode: 'native_json_schema' } : {};
    const attempts = [];
    for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt += 1) {
      let driver;
      try {
        // P10-R0.2.1 Part C/G: `resolveExecutionOptions(spec.stepKind, ...)` is
        // the orchestration-level timeout-policy decision for this step kind
        // (pm-execution-timeout-policy.mjs) — computed fresh per attempt,
        // exactly like `driver` itself just below (both are cheap, pure,
        // and re-derived rather than cached, per the existing per-attempt
        // re-resolution rationale in this method's own docstring). A
        // genuinely unknown `spec.stepKind` throws here (fails closed —
        // never Infinity/undefined), caught by this SAME try/catch exactly
        // like a driver-resolution failure.
        //
        // P18-W4R6: `executionCapable` reads ONLY `spec.isImplementationParticipant`
        // — the ONE typed signal CouncilChairDriver derives from the
        // council's own owner-authored `implementation_participant_id`
        // (council-contracts.mjs). Every existing council, and every step
        // other than the designated participant's own `participant_report`,
        // never sets this — `executionCapable` is then `false` exactly as
        // before this wave (byte-for-byte unchanged default).
        //
        // DSH-TIMEOUT-1 Part C (audit Finding T-2): the SAME boolean also
        // selects the TIMEOUT stage now, not just the permission mode — the
        // designated implementation participant's `participant_report` gets
        // `COUNCIL_IMPLEMENTATION_PARTICIPANT`'s implementation-class budget
        // instead of blindly inheriting `participant_report`'s ordinary
        // read-only analysis budget. Every other step (every non-selected
        // participant, and this same participant's own non-report steps)
        // keeps resolving `spec.stepKind` directly — byte-for-byte
        // unchanged from before this wave.
        const executionCapable = spec.isImplementationParticipant === true;
        // DSH T5: workspaceRequirement is normalized from the owner-authored
        // Council contract and persisted on every step by CouncilChairDriver.
        // It selects the bounded large-read reasoning class here, at the
        // orchestration policy boundary — never from prompt length inside a
        // provider bridge. The implementation participant retains its existing
        // execution-capable 30-minute class, which takes precedence.
        const executionStage = executionCapable
          ? EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT
          : executionStageForCouncilStep(spec.stepKind, { longWorkspaceRead: spec.workspaceRequirement === 'READ' });
        driver = this.#resolveDriver(profile, { project: this.#project, extraCtx: { ...this.#extraCtx(spec), attempt }, executionOptions: resolveExecutionOptions(executionStage, { executionCapable }) });
      } catch (error) {
        lastParseError = error; // driver resolution itself failed -- not retryable
        attempts.push({ attempt, ok: false, error_code: sanitizeReason(error) });
        break;
      }
      const request = createPmRequest({ objective: currentPrompt, context: { council: true, stepKind: spec.stepKind, profileId: spec.profileId, participantProfileIds: spec.participantProfileIds ?? [] } });
      if (prefix) this.#log(`${prefix}_ATTEMPT_START`, { attempt, profile_id: profile.id ?? spec.profileId, product: profile.product ?? null, model: profile.model ?? null, reasoning: profile.reasoning ?? null, structured_output_requested: Boolean(structuredOutputRequest), schema_kind: structuredOutputRequest?.kind ?? null, schema_version: structuredOutputRequest?.version ?? null, ...nativeFacts });
      try {
        // P10-R0.1.2 Part G/K: `structuredOutput` is an explicit sibling
        // field on the decide() call, never folded into `request`/`extraCtx`
        // (see production-pm-backend-registry.mjs's createCliPmDriver()
        // docstring for why).
        raw = await driver.decide({ request, turn: 0, history: [], capabilities: ['finish'], signal: spec.signal, structuredOutput: structuredOutputRequest });
        lastParseError = null;
        // PARSER-0 (Goal I): decide() returning is the real execution path's
        // proof that the backend executed, extraction produced output, and
        // parseDecision() was attempted and PASSED. Purely additive fields —
        // PM contract/step-semantic verdicts stay with the existing
        // validation layers below and are never claimed here.
        attempts.push({ attempt, ok: true, ...(canonicalizationDiagnostic(raw)?{canonicalization:canonicalizationDiagnostic(raw)}:{}), execution_state: 'SUCCESS', parser_attempted: true, parser_state: 'PASS', assistant_output_present: true, ...nativeFacts, ...(nativeFacts.structured_output_requested ? { structured_output_applied: true } : {}), structured_output_present: structuredOutputRequest ? true : null });
        if (prefix) this.#log(`${prefix}_BACKEND_RESULT`, { attempt, ok: true, assistant_output_present: true, structured_output_present: structuredOutputRequest ? true : null });
        this.#log('PARSER_RESULT', { stage: spec.stepKind, attempt, parser_outcome: 'OK', parser_attempted: true, assistant_output_present: true, structured_output_requested: Boolean(structuredOutputRequest) });
        this.#recordRawEvidence(this.#rawEvidenceRecord({ spec, profile, attempt, structuredOutputRequest, nativeFacts, ok: true, raw }));
        break;
      } catch (error) {
        lastParseError = error;
        // Part H: bounded, sanitized structural evidence only — the SAME
        // facts parseDecision()'s own failure path already computes
        // (production-pm-backend-registry.mjs), never the raw assistant
        // text and never chain-of-thought.
        const diag = error?.diagnostics ?? null;
        // Part O: a missing/unsatisfied native schema is its OWN failure
        // layer (CLAUDE_STRUCTURED_OUTPUT_MISSING — production-pm-backend-
        // registry.mjs / claude-code-session-bridge.mjs), never collapsed
        // into PM_DECISION_PARSE_FAILED — it is thrown before
        // parseDecision() even runs, so `error.diagnostics` is genuinely
        // absent for it (not a missing-evidence bug).
        // P19-D5.1R: attempt evidence is part of the durable handoff, so
        // "not applicable" must be represented by JSON `null`, matching the
        // successful non-structured-output path above. `false` remains
        // reserved for the distinct case where native structured output was
        // requested but missing; `undefined` would make the whole failure
        // handoff non-JSON-faithful and mask the original backend error.
        const structuredOutputPresent = error?.code === 'CLAUDE_STRUCTURED_OUTPUT_MISSING' ? false : null;
        // PARSER-0 (Goals C/I/J): the driver attaches its own versioned
        // layered diagnostic at the REAL boundary (createCliPmDriver), so
        // this ledger copies the truth instead of re-deriving it: a backend
        // execution error (HTTP 402/403, timeout, terminal ERROR) with no
        // assistant output is execution_state=ERROR / parser_attempted=false
        // / parser_state=NOT_ATTEMPTED — never an extractor defect or a
        // model JSON parse failure. Fields are present only when the real
        // path supplied them; stub drivers without a diagnostic keep the
        // prior attempt-record shape (JSON nulls where not applicable).
        const layered = error?.layeredDiagnostic ?? null;
        attempts.push({ attempt, ok: false, ...(canonicalizationDiagnostic(error)?{canonicalization:canonicalizationDiagnostic(error)}:{}), ...nativeFacts, ...(nativeFacts.structured_output_requested ? { structured_output_applied: null } : {}), error_code: error?.code ?? null, parse_subreason: error?.parseSubreason ?? null, output_bytes: diag?.bytes ?? null, structured_output_present: structuredOutputPresent, ...(layered ? { execution_state: layered.execution_state, parser_attempted: layered.parser_attempted, parser_state: layered.parser_state, assistant_output_present: layered.assistant_output_present } : {}) });
        if (prefix) this.#log(`${prefix}_BACKEND_RESULT`, { attempt, ok: false, error_code: error?.code ?? null, output_bytes: diag?.bytes ?? null, assistant_output_present: diag ? diag.bytes > 0 : null, structured_output_present: structuredOutputPresent });
        this.#log('PARSER_RESULT', {
          stage: spec.stepKind, attempt, parser_outcome: sanitizeReason(error),
          parser_attempted: layered ? layered.parser_attempted : null,
          assistant_output_present: layered ? layered.assistant_output_present : null,
          parse_subreason: error?.parseSubreason ?? null, output_bytes: diag?.bytes ?? null,
          first_non_whitespace_char: diag?.firstChar ?? null, last_non_whitespace_char: diag?.lastChar ?? null,
          looks_like_json_object: diag?.fullJson ?? null, contains_markdown_fence: diag?.jsonFence ?? null,
          structured_output_requested: Boolean(structuredOutputRequest), structured_output_present: structuredOutputPresent,
        });
        this.#recordRawEvidence(this.#rawEvidenceRecord({ spec, profile, attempt, structuredOutputRequest, nativeFacts, ok: false, error, diag }));
        // Only PARSE_FAILED is treated as transient sampling noise worth one
        // retry (see the file-level P7-R0.2 docstring) — every other error
        // (PM_DECISION_EMPTY_OUTPUT, backend unavailable,
        // CLAUDE_STRUCTURED_OUTPUT_MISSING, etc.) fails on the first
        // attempt, unchanged. P10-R0.1.2 Part M: a native schema-
        // enforcement failure is DELIBERATELY not retried here — it fails
        // closed after one attempt, never stacking a CLI schema retry on
        // top of the generic parse retry on top of the participant-ID
        // repair (Part M: "Maximum remains bounded... Do not stack").
        if (error?.code !== 'PM_DECISION_PARSE_FAILED' || attempt === MAX_PARSE_ATTEMPTS - 1) break;
        if (prefix) this.#log(`${prefix}_RETRY`, { retry_kind: 'PARSE_RETRY', from_attempt: attempt, to_attempt: attempt + 1, reason: sanitizeReason(error), parse_subreason: error?.parseSubreason ?? null });
        // P10-R0.1.1 Part F: the retry now names the actual failure
        // category instead of blindly re-sending the byte-identical
        // prompt — never echoes the previous (malformed) output back.
        currentPrompt = buildParseRepairPrompt({ originalPrompt: promptText, parseSubreason: error?.parseSubreason ?? null });
      }
    }
    return { raw, error: lastParseError, attempts };
  }

  async #attempt(spec) {
    const { profileId, stepKind } = spec;
    const events = STEP_EVENTS[stepKind] ?? { start: null, ok: null, fail: null };
    let profile;
    if (this.#profileRegistry) {
      try { profile = this.#profileRegistry.get(profileId); }
      catch (cause) { return this.#outcome(spec, { ok: false, reason: `PM_PROFILE_UNAVAILABLE:${sanitizeReason(cause)}` }); }
    } else {
      profile = { id: profileId };
    }

    if (events.start) this.#log(events.start, { profile_id: profileId, round: spec.round, participant_profile_id: stepKind === 'chair_plan' || stepKind === 'chair_synthesis' ? null : profileId });

    const first = await this.#decideOnce(spec, profile, spec.prompt);
    const validated = this.#validateDecideResult(spec, first);

    // P10-R0.1 Part E: the bounded repair layer — chair_plan ONLY, and ONLY
    // for a participant-instruction-KEY schema failure (never a transport
    // failure, which #decideOnce already retried its own way, and never a
    // content-quality failure like a missing critique/synthesis focus).
    if (stepKind === 'chair_plan' && !validated.ok && isParticipantKeyIssue(validated.reason)) {
      this.#log('COUNCIL_PLAN_INVALID', {
        error_code: 'COUNCIL_CHAIR_PLAN_INVALID', reason: validated.reason,
        invalid_profile_ids: reasonIds(validated.reason), allowed_profile_ids: spec.participantProfileIds ?? [],
      });
      this.#log('COUNCIL_PLAN_RETRY', { retry_kind: 'PARTICIPANT_ID_REPAIR', attempt: MAX_CHAIR_PLAN_ATTEMPTS, reason: validated.reason });
      const repairPrompt = buildChairPlanRepairPrompt({ originalPrompt: spec.prompt, participantProfileIds: spec.participantProfileIds ?? [], invalidReason: validated.reason });
      const second = await this.#decideOnce(spec, profile, repairPrompt);
      const revalidated = this.#validateDecideResult(spec, second);
      const allAttempts = [...first.attempts, ...second.attempts];
      const structuredOutput = structuredOutputSummary(spec, profile, allAttempts);
      if (revalidated.ok) {
        this.#log('COUNCIL_PLAN_RESULT', { ok: true, repaired: true });
        return this.#outcome(spec, { ...revalidated.payload, repaired: true, attempts: allAttempts, participant_id_repair_used: true, structured_output: structuredOutput });
      }
      // Part E: "If second attempt invalid: fail with typed council-plan
      // error." — fails closed, no third attempt, no fuzzy repair.
      this.#log('COUNCIL_PLAN_INVALID', {
        error_code: 'COUNCIL_CHAIR_PLAN_INVALID', reason: revalidated.reason,
        invalid_profile_ids: reasonIds(revalidated.reason), allowed_profile_ids: spec.participantProfileIds ?? [], after_repair: true,
        data_diagnostics: revalidated.data_shape ?? null,
      });
      this.#log('COUNCIL_PLAN_RESULT', { ok: false, reason: revalidated.reason, repaired: true });
      return this.#outcome(spec, { ok: false, reason: revalidated.reason, data_diagnostics: revalidated.data_shape ?? null, repaired: true, attempts: allAttempts, participant_id_repair_used: true, structured_output: structuredOutput });
    }

    // DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING (Implementation B): ONE
    // bounded semantic repair for a read-only PARTICIPANT step whose decision
    // parsed cleanly but failed typed COUNCIL_*_INVALID semantic validation —
    // see PARTICIPANT_SEMANTIC_REPAIR_STEP_KINDS above for the full
    // eligibility/safety contract. Exactly one repair re-prompt (bounded by
    // construction: this branch runs once per #attempt and never loops);
    // the EXACT same #validateDecideResult re-validates the repaired result,
    // and a still-invalid repair fails the participant with the repaired
    // reason while the original failure stays durably observable
    // (`original_failure`). `prior_data` (the model's own normalized data)
    // is used ONLY inside the repair prompt and never persisted.
    if (!validated.ok && PARTICIPANT_SEMANTIC_REPAIR_STEP_KINDS.has(stepKind) && spec.isImplementationParticipant !== true && typeof validated.reason === 'string' && validated.reason.startsWith('COUNCIL_')) {
      const prefix = ATTEMPT_EVENT_PREFIX[stepKind] ?? null;
      const originalFailure = { reason: validated.reason, data_diagnostics: validated.data_shape ?? null, evidence_diagnostics: validated.evidence_diagnostics ?? null };
      if (prefix) this.#log(`${prefix}_SEMANTIC_REPAIR`, { retry_kind: 'SEMANTIC_REPAIR', original_reason: validated.reason, data_diagnostics: originalFailure.data_diagnostics, evidence_diagnostics: originalFailure.evidence_diagnostics });
      const repairPrompt = buildParticipantSemanticRepairPrompt({ stepKind, reason: validated.reason, dataDiagnostics: validated.data_shape ?? null, evidenceDiagnostics: validated.evidence_diagnostics ?? null, priorData: validated.prior_data ?? null });
      const second = await this.#decideOnce(spec, profile, repairPrompt);
      const revalidated = this.#validateDecideResult(spec, second);
      const allAttempts = [...first.attempts, ...second.attempts];
      const structuredOutput = structuredOutputSummary(spec, profile, allAttempts);
      const repairedFailure = { reason: revalidated.reason ?? null, data_diagnostics: revalidated.data_shape ?? null, evidence_diagnostics: revalidated.evidence_diagnostics ?? null };
      if (prefix) this.#log(`${prefix}_SEMANTIC_REPAIR_RESULT`, { ok: revalidated.ok, reason: revalidated.ok ? undefined : revalidated.reason, profile_id: profileId });
      if (revalidated.ok) {
        if (events.ok) this.#log(events.ok, { ok: true, profile_id: profileId, semantic_repair_used: true, original_reason: originalFailure.reason });
        return this.#outcome(spec, { ...revalidated.payload, attempts: allAttempts, semantic_repair_used: true, original_failure: originalFailure, structured_output: structuredOutput });
      }
      if (events.ok) this.#log(events.fail, { ok: false, reason: revalidated.reason, profile_id: profileId, semantic_repair_used: true, original_reason: originalFailure.reason, data_diagnostics: repairedFailure.data_diagnostics, evidence_diagnostics: repairedFailure.evidence_diagnostics });
      return this.#outcome(spec, {
        ok: false, reason: revalidated.reason, semantic_repair_used: true, original_failure: originalFailure, repaired_failure: repairedFailure,
        data_diagnostics: repairedFailure.data_diagnostics, evidence_diagnostics: repairedFailure.evidence_diagnostics,
        attempts: allAttempts, participant_id_repair_used: false, structured_output: structuredOutput,
      });
    }

    const structuredOutput = structuredOutputSummary(spec, profile, first.attempts);
    if (events.ok) this.#log(validated.ok ? events.ok : events.fail, { ok: validated.ok, reason: validated.ok ? undefined : validated.reason, profile_id: profileId, ...(validated.ok ? {} : { data_diagnostics: validated.data_shape ?? null, evidence_diagnostics: validated.evidence_diagnostics ?? null }) });
    return this.#outcome(spec, validated.ok
      ? { ...validated.payload, attempts: first.attempts, participant_id_repair_used: false, structured_output: structuredOutput }
      : { ok: false, reason: validated.reason, data_diagnostics: validated.data_shape ?? null, evidence_diagnostics: validated.evidence_diagnostics ?? null, attempts: first.attempts, participant_id_repair_used: false, structured_output: structuredOutput });
  }

  /** Shared decide()-result -> {ok, reason|payload} validation, used by both the first attempt and the repair attempt.
   * DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING: failure returns additionally carry `prior_data` — the
   * model's OWN normalized data object, used ONLY to build the one bounded semantic repair prompt
   * (buildParticipantSemanticRepairPrompt) and NEVER spread into any outcome/handoff/diagnostic surface. */
  #validateDecideResult(spec, { raw, error }) {
    if (error) return { ok: false, reason: sanitizeReason(error) };
    if (raw?.type !== 'finish') return { ok: false, reason: `NON_FINISH_DECISION:${raw?.type ?? 'unknown'}`, data_shape: dataShapeSummary(raw?.data), prior_data: raw?.data ?? null };
    if (typeof raw.output !== 'string' || raw.output.trim() === '') return { ok: false, reason: 'EMPTY_OUTPUT', data_shape: dataShapeSummary(raw?.data, { outputLength: typeof raw.output === 'string' ? raw.output.length : null }), prior_data: raw?.data ?? null };
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {};
    const validation = validateStepData(spec, data, { repoPath: this.#project.repo_path });
    const canonicalization = canonicalizationDiagnostic(raw);
    if (canonicalization) canonicalization.semantic_state = validation.error ? 'FAIL' : 'PASS';
    // DSH-COUNCIL-EVIDENCE-DROP-DIAGNOSTICS: `evidence_diagnostics` (present
    // only for a workspace_requirement:'READ' participant_report/debate_
    // response whose data.evidence failed validation) travels with the SAME
    // failure payload as data_diagnostics — the durable handoff, the
    // PARTICIPANT_FAILED-class task-log event, and the chair_plan repair
    // failure path. Bounded counts + typed reason identifiers only; never a
    // path name, hash, claim, or any other evidence content.
    if (validation.error) return { ok: false, reason: validation.error, data_shape: dataShapeSummary(data, { outputLength: raw.output.length }), evidence_diagnostics: validation.diagnostics ?? null, prior_data: data };
    // Council/Debate WORKSPACE_READ remediation: `sanitizedFields` (present
    // only for a workspace_requirement:'READ' participant_report/
    // debate_response) REPLACES the raw, unverified `data.evidence` with
    // the hash-checked, redacted entries validateEvidence() produced —
    // never the raw model-authored array — so a persisted/durable outcome
    // never carries an unverified path/hash or an un-redacted secret-shaped
    // claim string (Part 19 test #30).
    return { ok: true, payload: { ok: true, output: raw.output, ...data, ...(validation.sanitizedFields ?? {}) } };
  }

  #outcome(spec, payload) {
    return Object.freeze({
      status: 'completed',
      workflowId: spec.id,
      finalStepId: spec.id,
      finalTaskId: spec.id,
      finalRunId: spec.id,
      finalResult: Object.freeze({
        id: spec.id,
        taskId: spec.id,
        runId: spec.id,
        agent: spec.profileId ?? null,
        status: payload.ok ? 'completed' : 'failed',
        output: payload.output ?? '',
        handoff: Object.freeze({ stepKind: spec.stepKind, round: spec.round, participantProfileId: spec.profileId ?? null, ...payload }),
        artifacts: [],
      }),
      error: null,
    });
  }
}
