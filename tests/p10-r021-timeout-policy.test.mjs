import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_STAGE,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PmExecutionPolicyError,
  resolveExecutionTimeoutMs,
  resolveExecutionOptions,
  executionStageForCouncilStep,
} from '../src/pm/pm-execution-timeout-policy.mjs';
import { COUNCIL_STEP_KINDS } from '../src/pm/council/council-contracts.mjs';

// ---- Part T: timeout resolution for the five required policy classes ----

test('OWNER_SINGLE resolves to 300000ms (Part D target)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE), 300_000);
});

test('COUNCIL_CHAIR_PLAN resolves to 120000ms (Part D target, T1 regression-safe)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_CHAIR_PLAN), 120_000);
});

test('COUNCIL_PARTICIPANT_REPORT resolves to 120000ms (Part D target)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT), 120_000);
});

test('COUNCIL_PARTICIPANT_CRITIQUE resolves to 120000ms (Part D target)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE), 120_000);
});

test('COUNCIL_CHAIR_SYNTHESIS resolves to 180000ms (Part D target)', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS), 180_000);
});

test('every resolved value is a bounded positive integer, never Infinity/0/negative/NaN', () => {
  for (const stage of Object.values(EXECUTION_STAGE)) {
    const ms = resolveExecutionTimeoutMs(stage);
    assert.equal(Number.isInteger(ms), true);
    assert.ok(ms >= MIN_TIMEOUT_MS, `${stage}: ${ms} below MIN_TIMEOUT_MS`);
    assert.ok(ms <= MAX_TIMEOUT_MS, `${stage}: ${ms} above MAX_TIMEOUT_MS`);
    assert.notEqual(ms, Infinity);
  }
});

// P10-R0.2.4 Part T: the ceiling was raised from 600000ms to 1800000ms
// (30 minutes) to admit the new LONG SINGLE hard deadline — see
// tests/p10-r024-timeout-policy-long.test.mjs for the full LONG-stage
// coverage.
test('MAX_TIMEOUT_MS matches the P10-R0.2.4 Part T hard ceiling (1800000ms)', () => {
  assert.equal(MAX_TIMEOUT_MS, 1_800_000);
});

// ---- fail-closed behavior for an unknown stage (Part T) ----

test('unknown execution stage fails closed with a typed error, never Infinity/undefined', () => {
  assert.throws(() => resolveExecutionTimeoutMs('some_future_stage'), (error) => error instanceof PmExecutionPolicyError && error.code === 'PM_EXECUTION_STAGE_UNKNOWN');
  assert.throws(() => resolveExecutionTimeoutMs(undefined), PmExecutionPolicyError);
  assert.throws(() => resolveExecutionTimeoutMs(null), PmExecutionPolicyError);
});

test('resolveExecutionOptions returns a frozen {timeoutMs,stage,permissionMode} triple, permissionMode:"plan" by default (P18-W4R3)', () => {
  const options = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE);
  assert.deepEqual(options, { timeoutMs: 300_000, stage: 'single_pm', permissionMode: 'plan' });
  assert.equal(Object.isFrozen(options), true);
});

// ---- Part C: council stepKind -> stage identity mapping ----

test('every real council stepKind maps 1:1 onto a known execution stage', () => {
  assert.equal(executionStageForCouncilStep(COUNCIL_STEP_KINDS.CHAIR_PLAN), EXECUTION_STAGE.COUNCIL_CHAIR_PLAN);
  assert.equal(executionStageForCouncilStep(COUNCIL_STEP_KINDS.PARTICIPANT_REPORT), EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT);
  assert.equal(executionStageForCouncilStep(COUNCIL_STEP_KINDS.PARTICIPANT_CRITIQUE), EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE);
  assert.equal(executionStageForCouncilStep(COUNCIL_STEP_KINDS.CHAIR_SYNTHESIS), EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS);
});

test('a bogus council stepKind fails closed', () => {
  assert.throws(() => executionStageForCouncilStep('made_up_step'), PmExecutionPolicyError);
});

// ---- Part G: council regression protection — no step accidentally 300s ----

test('no council stage resolves to the OWNER_SINGLE 300000ms class', () => {
  for (const stage of [EXECUTION_STAGE.COUNCIL_CHAIR_PLAN, EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT, EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE, EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS]) {
    assert.notEqual(resolveExecutionTimeoutMs(stage), 300_000);
  }
});

test('OWNER_SINGLE is strictly longer than every ordinary Council/Debate READ-ONLY analysis class', () => {
  // P10-R0.2.4: OWNER_SINGLE_LONG is a DELIBERATELY longer, explicit-opt-in
  // LONG-runtime class (30m) — excluded here on purpose; this test only
  // protects the pre-existing NORMAL-runtime ordering.
  //
  // DSH-TIMEOUT-1 Part C (Finding T-2), PM-review-corrected: COUNCIL_
  // IMPLEMENTATION_PARTICIPANT is also excluded, deliberately — it is a
  // LONG-implementation-class stage (the SAME LONG_TASK_HARD_DEADLINE_MS
  // budget as OWNER_SINGLE_LONG, not merely OWNER_SINGLE's own un-LONG
  // value, and not a read-only reasoning turn) — see the dedicated
  // equality test below. DSH T5 adds one other explicit opt-in class:
  // COUNCIL_WORKSPACE_READ_LONG (600s), selected only by an owner-authored
  // workspace_requirement:READ Council. It is excluded for the same reason:
  // this invariant protects ordinary NONE Council/Debate stage ordering.
  // Every ordinary read-only/analysis stage must remain strictly shorter
  // than OWNER_SINGLE.
  const ownerSingle = resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE);
  for (const stage of Object.values(EXECUTION_STAGE)) {
    if (stage === EXECUTION_STAGE.OWNER_SINGLE || stage === EXECUTION_STAGE.OWNER_SINGLE_LONG || stage === EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT || stage === EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG) continue;
    assert.ok(ownerSingle > resolveExecutionTimeoutMs(stage), `OWNER_SINGLE (${ownerSingle}) should exceed ${stage}`);
  }
});

// DSH-TIMEOUT-1 Part C (Finding T-2), PM-review-corrected: the selected
// Council implementation participant must receive the SAME LONG
// implementation-class budget a LONG SINGLE task's own worker/
// implementation step gets (LONG_TASK_HARD_DEADLINE_MS) — never the
// ordinary read-only participant_report budget it used to blindly
// inherit, and never OWNER_SINGLE's shorter un-LONG value either (an
// initial TIMEOUT-1 draft used that value; PM review identified it as
// reintroducing T-1's own bug for Council and it was corrected before
// this wave's commit was pushed — see pm-execution-timeout-policy.mjs's
// own docstring for the full trace).
test('COUNCIL_IMPLEMENTATION_PARTICIPANT resolves to the SAME 1800000ms LONG implementation budget as OWNER_SINGLE_LONG — never OWNER_SINGLE\'s shorter value, never the 120000ms read-only participant_report budget', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT), 1_800_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT), resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE_LONG));
  assert.notEqual(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT), resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE));
  assert.notEqual(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT), resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT));
});
