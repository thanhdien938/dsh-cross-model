/**
 * P10-R0.2.1 — task-aware backend timeout policy (Part B-D).
 *
 * Owner-live evidence: a real Telegram SINGLE task (T2,
 * task-BEUVJHoINfc4rDmBnTgFxlTaXBzHquXz's follow-on retest against
 * dsh-p6-test-b) was killed by Claude's bridge-level blind 120_000ms
 * default (claude-code-session-bridge.mjs) before the real recovery
 * experiment could finish — see docs/p10/07_TASK_AWARE_BACKEND_TIMEOUT_POLICY_SONNET5.md.
 * 120s was tuned for short council orchestration steps, never validated
 * against a real owner SINGLE task that must read multiple repository
 * files and reason over prior council evidence before responding.
 *
 * Architecture (Part B): timeout is EXECUTION POLICY, not profile
 * identity, not observability metadata. It is resolved HERE, at
 * orchestration composition points (p5-production-composition.mjs for
 * owner SINGLE tasks, council-step-workflow-runner.mjs for council steps)
 * — never inferred deep inside a CLI bridge, and never smuggled through
 * `extraCtx` (that field is documented, in production-pm-backend-
 * registry.mjs, as observability-correlation-only).
 *
 * `resolveExecutionOptions(stage)` is the one function every orchestration
 * call site uses to build the `executionOptions` object threaded through
 * `ProductionPmBackendRegistry#resolve()` -> `createCliPmDriver()` ->
 * each backend's `run()` closure. Today only the claude-code closure
 * forwards `executionOptions.timeoutMs` to its bridge (Part E/H) — every
 * other backend's `run()` closure destructures `{ ctx }` only, so the
 * extra field is present but silently unused, leaving Codex/OpenCode/
 * Grok/Antigravity's own bridge-level defaults (180s/180s/180s/300s —
 * already all >= the old Claude 120s default) completely untouched. This
 * is deliberate (Part E/X): forcing council-stage classes onto those
 * bridges would LOWER their currently-working defaults (e.g. Antigravity
 * 300s -> 120s for a participant step), which is a regression risk this
 * wave explicitly refuses to take for a fully-passing T1.
 */

import { COUNCIL_STEP_KINDS } from './council/council-contracts.mjs';

export class PmExecutionPolicyError extends Error {
  constructor(message, code = 'PM_EXECUTION_POLICY_ERROR', extra = {}) {
    super(message);
    this.name = 'PmExecutionPolicyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Part C: the five required policy classes. Council stage identifiers are
// deliberately IDENTICAL to CouncilStepWorkflowRunner's own `spec.stepKind`
// vocabulary (council-contracts.mjs's COUNCIL_STEP_KINDS) — one shared
// vocabulary, never a second parallel enum a caller could drift out of
// sync with.
export const EXECUTION_STAGE = Object.freeze({
  OWNER_SINGLE: 'single_pm',
  // P10-R0.2.4 Part S/T: a DISTINCT execution stage — never applied to a
  // normal owner SINGLE task. Selected only when the owner's dispatch
  // explicitly used the GIT_FILE `--task-file <ref> <path>` long-task
  // syntax (owner-task-controller.mjs stamps `context.runtimeClass:'LONG'`
  // at SUBMIT_TASK time from `command.payload.task_source`, never inferred
  // from task-text length alone — Part S). Council stages are completely
  // unaffected by this owner-SINGLE stage.
  OWNER_SINGLE_LONG: 'single_pm_long',
  COUNCIL_CHAIR_PLAN: COUNCIL_STEP_KINDS.CHAIR_PLAN,
  COUNCIL_PARTICIPANT_REPORT: COUNCIL_STEP_KINDS.PARTICIPANT_REPORT,
  COUNCIL_PARTICIPANT_CRITIQUE: COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE,
  COUNCIL_CHAIR_SYNTHESIS: COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS,
  // P19-D1: debate extension stages — same identity-mapped-from-stepKind
  // convention as the four Council stages above (never a second parallel
  // enum). `executionCapable` for every one of these is always resolved
  // `false` at the call site (CouncilChairDriver's #debateWorkflow() never
  // derives isImplementationParticipant for a debate step — see
  // council-contracts.mjs's COUNCIL_STEP_KINDS docstring), so these three
  // stages only ever produce `permissionMode: 'plan'` in P19-D1.
  COUNCIL_DEBATE_BRIEF: COUNCIL_STEP_KINDS.DEBATE_BRIEF,
  COUNCIL_DEBATE_RESPONSE: COUNCIL_STEP_KINDS.DEBATE_RESPONSE,
  COUNCIL_DEBATE_SYNTHESIS: COUNCIL_STEP_KINDS.DEBATE_SYNTHESIS,
  // DSH T5: explicit workspace_requirement:READ is an orchestration-level
  // opt-in to a bounded large-evidence reasoning class. It is one shared
  // class for chair, participant, critique, synthesis, and Debate steps
  // because each can receive the same large evidence packet. Ordinary
  // Council/Debate NONE steps keep their identity-mapped stages above.
  COUNCIL_WORKSPACE_READ_LONG: 'council_workspace_read_long',
  // DSH-TIMEOUT-1 Part C (audit Finding T-2): a DISTINCT execution stage —
  // never a stepKind-identity-mapped value like the seven stages above,
  // because this is not a new council step; it is the ONE existing
  // `participant_report` step, for the ONE selected participant, when
  // CouncilChairDriver has stamped `spec.isImplementationParticipant:true`
  // (council-contracts.mjs's `implementation_participant_id` invariant —
  // zero or one such participant per council, unchanged by this wave). An
  // execution-capable turn that reads/edits files and runs build/test
  // commands has fundamentally different duration needs than the ordinary
  // read-only analysis/critique/synthesis turns every other participant
  // (and this same participant's OWN non-report steps) still gets — see
  // council-step-workflow-runner.mjs's stage-selection call site, the only
  // place this stage is ever resolved.
  //
  // DSH-TIMEOUT-1 PM-review correction (T-2 budget check): this stage's
  // TIMEOUT_POLICY_MS value below is LONG_TASK_HARD_DEADLINE_MS, the exact
  // SAME constant OWNER_SINGLE_LONG resolves — never a second, distinct
  // "implementation" number. `isImplementationParticipant:true` selects
  // `bypassPermissions` through the IDENTICAL resolveExecutionOptions()
  // mechanism the SINGLE worker/implementation step uses (P18-W4R6 reusing
  // P18-W4R3 verbatim) — same capability tier, same class of real file-
  // edit/test-run workload, so it gets the same budget class. An initial
  // TIMEOUT-1 draft of this stage instead reused OWNER_SINGLE's un-LONG
  // 300_000ms value ("the closest existing analog" at the time) — on PM
  // review this was identified as reintroducing T-1's own bug for Council
  // (an execution-capable turn silently capped at the short NORMAL tier)
  // and was corrected before this wave's commit was pushed.
  COUNCIL_IMPLEMENTATION_PARTICIPANT: 'council_implementation_participant',
});

// Part AA/T: hard bounds for any timeout this policy ever resolves — never
// 0/Infinity/unbounded (Part D/AA). P10-R0.2.4 Part T raises the ceiling
// from 600_000 (10m) to 1_800_000 (30m) — the explicit, absolute LONG
// SINGLE hard deadline. This widens what CAN be configured; it does not by
// itself change any existing stage's resolved value (Part U — see the
// TIMEOUT_POLICY_MS table below, byte-for-byte unchanged for every
// pre-existing stage).
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 1_800_000;

// P10-R0.2.4 Part T: the absolute LONG-task hard deadline. Exported so
// every caller that needs "is this the 30-minute ceiling" (materializer,
// diagnostics, tests) reads the SAME constant `resolveExecutionOptions`
// resolves from, rather than re-hardcoding 1_800_000 in a second place.
export const LONG_TASK_HARD_DEADLINE_MS = 1_800_000;

// A large evidence-backed Council reasoning turn is bounded at ten minutes.
// This is intentionally distinct from the 30-minute execution-capable task
// class: these turns reason over supplied evidence but remain read-only.
export const LONG_WORKSPACE_READ_COUNCIL_TIMEOUT_MS = 600_000;

// Part D/U: evidence-driven conservative defaults, exactly the brief's
// initial bounded policy targets. Every pre-existing entry is untouched —
// P10-R0.2.4 adds exactly one new stage (OWNER_SINGLE_LONG).
const TIMEOUT_POLICY_MS = Object.freeze({
  [EXECUTION_STAGE.OWNER_SINGLE]: 300_000,
  [EXECUTION_STAGE.OWNER_SINGLE_LONG]: LONG_TASK_HARD_DEADLINE_MS,
  [EXECUTION_STAGE.COUNCIL_CHAIR_PLAN]: 120_000,
  [EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT]: 120_000,
  [EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE]: 120_000,
  [EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS]: 180_000,
  // P19-D1: mirrors the Council stage each debate stage is shaped like —
  // brief/response are single independent-reasoning steps (like
  // chair_plan/participant_report), synthesis is the heavier chair
  // aggregation step (like chair_synthesis).
  [EXECUTION_STAGE.COUNCIL_DEBATE_BRIEF]: 120_000,
  [EXECUTION_STAGE.COUNCIL_DEBATE_RESPONSE]: 120_000,
  [EXECUTION_STAGE.COUNCIL_DEBATE_SYNTHESIS]: 180_000,
  [EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG]: LONG_WORKSPACE_READ_COUNCIL_TIMEOUT_MS,
  // DSH-TIMEOUT-1 Part C (Finding T-2), PM-review-corrected: reuses the
  // EXACT SAME LONG_TASK_HARD_DEADLINE_MS constant OWNER_SINGLE_LONG
  // resolves — never a second, arbitrary "implementation" number. An
  // execution-capable Council turn (isImplementationParticipant:true —
  // the SAME bypassPermissions capability tier as the SINGLE worker step,
  // via the identical resolveExecutionOptions() mechanism) can legitimately
  // perform the same real file-edit/test-run workload a LONG SINGLE
  // worker does; there is no architectural reason for it to get a shorter
  // budget than that workload class already gets elsewhere. This is
  // deliberately NOT gated on the council's own runtimeClass (Council
  // tasks have no runtimeClass concept — P10-R0.2.4 Part V's "LONG COUNCIL
  // execution policy is explicitly deferred" stays deferred, unrelated to
  // this): the ONE selected implementation participant's real workload
  // needs this budget regardless of how the council itself was dispatched.
  [EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT]: LONG_TASK_HARD_DEADLINE_MS,
});

// Fail closed at module load, not at first call: every configured policy
// value must itself already be a bounded positive integer. A future edit
// that widened one of these constants past MAX_TIMEOUT_MS (or made it
// non-integer/negative/Infinity) throws immediately on import, not
// silently the first time an owner task happens to hit that stage.
for (const [stage, ms] of Object.entries(TIMEOUT_POLICY_MS)) {
  if (!Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
    throw new PmExecutionPolicyError(
      `PM execution timeout policy for stage "${stage}" is out of bounds [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]: ${ms}`,
      'PM_EXECUTION_POLICY_MISCONFIGURED',
      { stage, value: ms },
    );
  }
}

/**
 * Resolve the bounded timeout (ms) for one known execution stage. Part T:
 * an unknown stage FAILS CLOSED — it throws a typed error, it never
 * returns Infinity, never silently substitutes an unrelated default.
 */
export function resolveExecutionTimeoutMs(stage) {
  const ms = TIMEOUT_POLICY_MS[stage];
  if (!Number.isInteger(ms)) {
    throw new PmExecutionPolicyError(`unknown PM execution stage: ${String(stage)}`, 'PM_EXECUTION_STAGE_UNKNOWN', { stage });
  }
  return ms;
}

/**
 * P18-W4R3 — Claude Code permission-mode policy, by runtime role.
 *
 * Empirically verified (not inferred from the mode name — see
 * docs/p18/ for the live probe evidence) against the installed CLI
 * (2.1.235): a non-interactive (`-p`) session under `acceptEdits` auto-
 * accepts file writes but still BLOCKS Bash/command execution pending an
 * approval that can never arrive non-interactively; `dontAsk` blocks
 * everything; `auto` is a classifier that can non-deterministically deny
 * an action mid-turn (observed live) — none of the three are reliable for
 * an unattended execution worker. `bypassPermissions` is the one mode
 * that deterministically allows both file writes and command execution in
 * a real, bounded, throwaway-fixture probe. `plan` (the pre-existing
 * default) stays exactly what it always was: read-only reasoning, no tool
 * execution — DSH's actual first-ever live W4 failure (three consecutive
 * plan-mode worker turns returning NOT IMPLEMENTED) is what this policy
 * exists to fix, for the WORKER role only.
 *
 * DSH's own task-branch lifecycle (verifyBoundBranch()/assertTaskBranch
 * Publishable(), task-branch-binding.mjs) remains the sole git-lifecycle
 * authority regardless of which permission mode a Claude session runs
 * under — this policy only ever changes what a session may do INSIDE its
 * own task-workspace turn (read/edit/run), never DSH's own branch/commit/
 * publish authority.
 */
export const PM_PERMISSION_MODE = Object.freeze({ PLAN: 'plan', EXECUTE: 'bypassPermissions' });

/**
 * Build the explicit `executionOptions` object every orchestration call
 * site threads through `resolveDriver(profile, { project, extraCtx,
 * executionOptions })`. `stage` rides along (not just `timeoutMs`) so
 * downstream diagnostics (BACKEND_TIMEOUT event, summary.md's Timeout
 * section) can report WHICH policy class produced a given timeout without
 * re-deriving it from `extraCtx.phase`/`taskMode` (Part N).
 *
 * `executionCapable` (P18-W4R3, default `false`) is the SAME "caller
 * intentionally opts in" discipline as everything else in this module —
 * an existing call site that never passes it gets BYTE-FOR-BYTE unchanged
 * `permissionMode: 'plan'` behavior. `stage` alone cannot distinguish a
 * SINGLE task's own PM planning/decision turn from its workflow "worker"
 * step (both use `EXECUTION_STAGE.OWNER_SINGLE[_LONG]` for timeout
 * purposes, deliberately — see this stage's own docstring above), so
 * permission-mode selection is NOT derived from `stage`/`taskMode`
 * inference here; only the caller that already knows semantically which
 * kind of turn it is dispatching (production-pm-workflow-runner.mjs's
 * worker-step adapter, and only that one call site today) explicitly
 * requests `{ executionCapable: true }`. P18-W4R6 later reused this same
 * opt-in for the one selected Council participant's participant_report.
 * P19-D5 exposes that existing selection for Debate-enabled Councils while
 * every Debate-round step remains `executionCapable: false` (PLAN).
 *
 * DSH-TIMEOUT-1 Part C (Finding T-2): for COUNCIL specifically — unlike
 * SINGLE above — `stage` and `executionCapable` are now correlated by
 * construction at the one call site that resolves them (council-step-
 * workflow-runner.mjs derives both from the SAME `spec.isImplementation
 * Participant` boolean): the selected implementation participant's
 * `participant_report` step resolves `EXECUTION_STAGE.COUNCIL_
 * IMPLEMENTATION_PARTICIPANT` (timeout) with `executionCapable:true`
 * (permission), while every other council/debate step keeps resolving its
 * own stepKind-identity-mapped stage with `executionCapable:false`. This is
 * still the same "caller explicitly opts in" discipline, not a new
 * inference performed inside this function — resolveExecutionOptions()
 * itself remains a pure `(stage, {executionCapable}) -> options` mapping.
 */
export function resolveExecutionOptions(stage, { executionCapable = false } = {}) {
  return Object.freeze({
    timeoutMs: resolveExecutionTimeoutMs(stage),
    stage,
    permissionMode: executionCapable === true ? PM_PERMISSION_MODE.EXECUTE : PM_PERMISSION_MODE.PLAN,
  });
}

// Part C: council stage identifiers are identity-mapped from stepKind
// (see EXECUTION_STAGE docstring above) — this validates the stepKind is
// one of the four known council steps and fails closed (typed error,
// never a silent Infinity/undefined) for anything else, e.g. a future
// council step kind added without updating this policy.
const KNOWN_COUNCIL_STAGES = new Set([
  EXECUTION_STAGE.COUNCIL_CHAIR_PLAN,
  EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT,
  EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE,
  EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS,
  EXECUTION_STAGE.COUNCIL_DEBATE_BRIEF,
  EXECUTION_STAGE.COUNCIL_DEBATE_RESPONSE,
  EXECUTION_STAGE.COUNCIL_DEBATE_SYNTHESIS,
]);

export function executionStageForCouncilStep(stepKind, { longWorkspaceRead = false } = {}) {
  if (!KNOWN_COUNCIL_STAGES.has(stepKind)) {
    throw new PmExecutionPolicyError(`unknown council step kind for timeout policy: ${String(stepKind)}`, 'PM_EXECUTION_STAGE_UNKNOWN', { stepKind });
  }
  return longWorkspaceRead === true ? EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG : stepKind;
}
